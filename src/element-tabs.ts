import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, WidgetTracker } from '@jupyterlab/apputils';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { TabBar, Widget } from '@lumino/widgets';
import type { IElementReference } from './element-reference';
import { ElementWidget } from './element-widget';
import { CommandIDs } from './commands';
import { ElementHistoryCommandIDs } from './versions/element-history';
import { ELEMENT_TAB_DATASET_KEY } from './workbench-ids';

export type ElementTab = MainAreaWidget<ElementWidget>;

/** Stable resolution context; tab pinning is independent of universe selection. */
export function elementContextKey(reference: IElementReference): string {
  return JSON.stringify([reference.entrypoint, reference.universeId]);
}

/** The tab data attribute Lumino renders from `ElementWidget`'s title dataset. */
const TAB_ATTRIBUTE = `data-${ELEMENT_TAB_DATASET_KEY}`;
const TAB_SELECTOR = `.lm-TabBar-tab[${TAB_ATTRIBUTE}]`;
const WIDGET_SELECTOR = '.jp-jupyterlab-lightcone-ElementWidget';

/** Native tab placement, preview eligibility, and user-owned retention. */
export class ElementTabs {
  constructor(
    private app: JupyterFrontEnd,
    private shell: ILabShell | null,
    readonly tracker: WidgetTracker<ElementTab>
  ) {
    shell?.layoutModified.connect(this.sync, this);
    void app.restored.then(() => {
      if (this._isDisposed) return;
      this.sync();
      this._observeMoves = true;
    });
    this._commands.push(
      app.commands.addCommand(CommandIDs.pinElement, {
        label: 'Pin ASTRA tab',
        isEnabled: args => {
          const tab = this.target(args);
          return !!tab && !tab.content.isPinned;
        },
        execute: args => {
          const tab = this.target(args);
          if (tab) this.pin(tab);
        }
      })
    );
    this._commands.push(
      app.commands.addCommand(CommandIDs.unpinElement, {
        label: 'Unpin ASTRA tab',
        isEnabled: args => !!this.target(args)?.content.isPinned,
        execute: args => {
          const tab = this.target(args);
          if (tab) this.unpin(tab);
        }
      })
    );
    this._commands.push(
      app.commands.addCommand(ElementHistoryCommandIDs.back, {
        label: 'Back in ASTRA tab',
        caption: 'Show the record this tab showed before',
        isEnabled: args => !!this.target(args)?.content.canGoBack,
        execute: args => {
          this.target(args)?.content.back();
        }
      })
    );
    this._commands.push(
      app.commands.addCommand(ElementHistoryCommandIDs.forward, {
        label: 'Forward in ASTRA tab',
        caption: 'Return to the record this tab went back from',
        isEnabled: args => !!this.target(args)?.content.canGoForward,
        execute: args => {
          this.target(args)?.content.forward();
        }
      })
    );
    this._commands.push(
      app.commands.addCommand(ElementHistoryCommandIDs.openInNewTab, {
        label: 'Open ASTRA record in new tab',
        caption: 'Open the record this tab shows in a new tab beside it',
        isEnabled: args => !!this.target(args),
        execute: args => {
          const tab = this.target(args);
          if (!tab) return undefined;
          const { reference } = tab.content;
          return app.commands.execute(CommandIDs.openElement, {
            ...reference,
            sourceWidgetId: tab.id,
            newTab: true
          });
        }
      })
    );
    this._commands.push(
      app.commands.addKeyBinding({
        command: ElementHistoryCommandIDs.back,
        keys: ['Alt ArrowLeft'],
        selector: WIDGET_SELECTOR
      }),
      app.commands.addKeyBinding({
        command: ElementHistoryCommandIDs.forward,
        keys: ['Alt ArrowRight'],
        selector: WIDGET_SELECTOR
      })
    );
    this._menus = [
      { command: CommandIDs.pinElement, rank: 5 },
      { command: CommandIDs.unpinElement, rank: 5 },
      { command: ElementHistoryCommandIDs.back, rank: 6 },
      { command: ElementHistoryCommandIDs.forward, rank: 7 },
      { command: ElementHistoryCommandIDs.openInNewTab, rank: 8 }
    ].map(({ command, rank }) =>
      app.contextMenu.addItem({
        command,
        args: { contextMenu: true },
        selector: TAB_SELECTOR,
        rank
      })
    );
    app.shell.currentChanged?.connect(this.notifyCommands, this);
  }

  /** Find the exact record before considering any replaceable tab. */
  existing(identity: string): ElementTab | undefined {
    return this.tracker.find(tab => tab.content.identity === identity);
  }

  /** The tracked tab with this widget id. */
  find(id: string): ElementTab | undefined {
    return this.tracker.find(tab => tab.id === id);
  }

  /**
   * The tab a link was followed from, when it can show the reference: the
   * same project and universe. Such a link navigates that tab in place.
   */
  navigable(
    sourceId: string,
    reference: IElementReference
  ): ElementTab | undefined {
    const source = this.find(sourceId);
    return source &&
      elementContextKey(source.content.reference) ===
        elementContextKey(reference)
      ? source
      : undefined;
  }

  /** Use the originating result group, never the currently focused arbitrary document. */
  destination(
    reference: IElementReference,
    sourceId?: string
  ): ElementTab | undefined {
    const context = elementContextKey(reference);
    const source = sourceId ? this.find(sourceId) : undefined;
    if (source && elementContextKey(source.content.reference) === context)
      return source;
    const remembered = this._destinations.get(context);
    if (remembered && !remembered.isDisposed) return remembered;
    return this.tracker.find(
      tab => elementContextKey(tab.content.reference) === context
    );
  }

  /** A retained view is never eligible, including while an open is waiting for data. */
  preview(
    reference: IElementReference,
    destination?: ElementTab
  ): ElementTab | undefined {
    const context = elementContextKey(reference);
    const group = destination
      ? this.shell?.getMainAreaTabBar(destination)
      : null;
    return this.tracker.find(
      tab =>
        !tab.content.isPinned &&
        elementContextKey(tab.content.reference) === context &&
        (!group || this.shell?.getMainAreaTabBar(tab) === group)
    );
  }

  /** Add one native tab; split only the first result beside a sufficiently wide source. */
  add(tab: ElementTab, destination?: ElementTab, restoring = false): void {
    const source = destination ?? this.app.shell.currentWidget;
    const split =
      !restoring && !destination && !!source && source.node.clientWidth >= 1000;
    this.app.shell.add(tab, 'main', {
      mode: split ? 'split-right' : 'tab-after',
      ...(source ? { ref: source.id } : {}),
      activate: !restoring
    });
    // The view a result group was opened from, e.g. a session, gets focus
    // back when the group's last result closes.
    const opener = destination
      ? this._openers.get(destination)
      : source && !this.tracker.has(source)
        ? source
        : undefined;
    if (opener) this._openers.set(tab, opener);
    tab.disposed.connect(() => this._returnFocus(tab));
  }

  /** Remember the preview's result area without changing it when an old pinned tab is focused. */
  remember(tab: ElementTab): void {
    this._destinations.set(elementContextKey(tab.content.reference), tab);
  }

  /** Save an explicit user pin and update the native title and toolbar together. */
  pin(tab: ElementTab): void {
    if (tab.isDisposed || tab.content.isPinned) return;
    tab.content.setPinned(true);
    this.save(tab);
    this.notifyCommands();
  }

  /** Make this the group's preview, retaining any displaced preview as a pin. */
  unpin(tab: ElementTab): void {
    if (tab.isDisposed || !tab.content.isPinned) return;
    this.sync();
    const context = elementContextKey(tab.content.reference);
    const group = this.shell?.getMainAreaTabBar(tab);
    this.tracker.forEach(other => {
      if (
        other !== tab &&
        !other.content.isPinned &&
        elementContextKey(other.content.reference) === context &&
        (!group || this.shell?.getMainAreaTabBar(other) === group)
      )
        this.pin(other);
    });
    tab.content.setPinned(false);
    this.remember(tab);
    this.save(tab);
    this.notifyCommands();
  }

  save(tab: ElementTab): void {
    void this.tracker.save(tab).catch(error => {
      console.warn('Could not save the ASTRA tab layout.', error);
    });
  }

  /** Track actual tab bars through the public shell API, including after user docking. */
  sync(): void {
    const shell = this.shell;
    if (!shell || this._isDisposed) return;
    const live = new Set<TabBar<Widget>>();
    this.tracker.forEach(tab => {
      const bar = shell.getMainAreaTabBar(tab);
      if (!bar) return;
      const previous = this._groups.get(tab);
      if (this._observeMoves && previous && previous !== bar) this.pin(tab);
      this._groups.set(tab, bar);
      live.add(bar);
      if (this._bars.has(bar)) return;
      // A double click on a record tab's label pins it. Lumino renders the
      // title dataset onto the tab, so the tab names its widget itself.
      const doubleClick = (event: MouseEvent) => {
        if (
          bar.titlesEditable ||
          event.button !== 0 ||
          !(event.target instanceof Element)
        )
          return;
        if (!event.target.closest('.lm-TabBar-tabLabel')) return;
        const id = event.target
          .closest(TAB_SELECTOR)
          ?.getAttribute(TAB_ATTRIBUTE);
        const tab = id ? this.find(id) : undefined;
        if (tab) this.pin(tab);
      };
      const moved = (
        _sender: TabBar<Widget>,
        args: TabBar.ITabMovedArgs<Widget>
      ) => {
        const tab = this.tracker.find(item => item === args.title.owner);
        if (this._observeMoves && tab) this.pin(tab);
      };
      bar.node.addEventListener('dblclick', doubleClick);
      bar.tabMoved.connect(moved);
      this._bars.set(bar, () => {
        bar.node.removeEventListener('dblclick', doubleClick);
        bar.tabMoved.disconnect(moved);
      });
    });
    for (const [bar, cleanup] of this._bars) {
      if (!live.has(bar)) {
        cleanup();
        this._bars.delete(bar);
      }
    }
    for (const tab of this._groups.keys())
      if (tab.isDisposed) this._groups.delete(tab);
    for (const [context, tab] of this._destinations)
      if (tab.isDisposed) this._destinations.delete(context);
    for (const [tab, opener] of this._openers)
      if (tab.isDisposed || opener.isDisposed) this._openers.delete(tab);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.shell?.layoutModified.disconnect(this.sync, this);
    this.app.shell.currentChanged?.disconnect(this.notifyCommands, this);
    for (const cleanup of this._bars.values()) cleanup();
    this._bars.clear();
    this._groups.clear();
    this._destinations.clear();
    this._openers.clear();
    for (const menu of this._menus) menu.dispose();
    for (const command of this._commands) command.dispose();
  }

  private target(args: ReadonlyPartialJSONObject): ElementTab | undefined {
    const id = args.contextMenu
      ? this.app
          .contextMenuHitTest(node => node.hasAttribute(TAB_ATTRIBUTE))
          ?.getAttribute(TAB_ATTRIBUTE)
      : args.widgetId;
    return typeof id === 'string'
      ? this.find(id)
      : this.tracker.find(tab => tab === this.app.shell.currentWidget);
  }

  /**
   * After a result closes, put focus back where it belongs: the tab Lumino
   * made current, or the view the group was opened from when none is left.
   */
  private _returnFocus(closed: ElementTab): void {
    const opener = this._openers.get(closed);
    this._openers.delete(closed);
    if (this._isDisposed) return;
    const shell = this.app.shell;
    const current = shell.currentWidget;
    if (current && current !== closed && !current.isDisposed) {
      shell.activateById(current.id);
      return;
    }
    if (opener && !opener.isDisposed && opener.isAttached)
      shell.activateById(opener.id);
  }

  private notifyCommands(): void {
    for (const command of [
      CommandIDs.pinElement,
      CommandIDs.unpinElement,
      ElementHistoryCommandIDs.back,
      ElementHistoryCommandIDs.forward,
      ElementHistoryCommandIDs.openInNewTab
    ])
      this.app.commands.notifyCommandChanged(command);
  }
  private _observeMoves = false;
  private _isDisposed = false;
  private _destinations = new Map<string, ElementTab>();
  private _groups = new Map<ElementTab, TabBar<Widget>>();
  private _bars = new Map<TabBar<Widget>, () => void>();
  private _openers = new Map<ElementTab, Widget>();
  private _menus: { dispose(): void }[];
  private _commands: { dispose(): void }[] = [];
}
