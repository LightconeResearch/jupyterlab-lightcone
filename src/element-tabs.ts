import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, WidgetTracker } from '@jupyterlab/apputils';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { TabBar, Widget } from '@lumino/widgets';
import type { IElementReference } from './element-reference';
import { ElementWidget } from './element-widget';
import { CommandIDs } from './commands';

export type ElementTab = MainAreaWidget<ElementWidget>;

/** Stable resolution context; tab pinning is independent of universe selection. */
export function elementContextKey(reference: IElementReference): string {
  return JSON.stringify([reference.entrypoint, reference.universeId]);
}

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
    });
    this._menu = app.contextMenu.addItem({
      command: CommandIDs.pinElement,
      args: { contextMenu: true },
      selector: '.lm-TabBar-tab[data-lightcone-element]',
      rank: 5
    });
    app.shell.currentChanged?.connect(this.notifyPin, this);
  }

  /** Find the exact record before considering any replaceable tab. */
  existing(identity: string): ElementTab | undefined {
    return this.tracker.find(tab => tab.content.identity === identity);
  }

  /** Use the originating result group, never the currently focused arbitrary document. */
  destination(
    reference: IElementReference,
    sourceId?: string
  ): ElementTab | undefined {
    const context = elementContextKey(reference);
    const source = sourceId
      ? this.tracker.find(tab => tab.id === sourceId)
      : undefined;
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
  }

  /** Remember the preview's result area without changing it when an old pinned tab is focused. */
  remember(tab: ElementTab): void {
    this._destinations.set(elementContextKey(tab.content.reference), tab);
  }

  /** Save an explicit user pin and update the native title and toolbar together. */
  pin(tab: ElementTab): void {
    if (tab.isDisposed || tab.content.isPinned) return;
    tab.content.pin();
    this.save(tab);
    this.notifyPin();
  }

  save(tab: ElementTab): void {
    void this.tracker.save(tab).catch(error => {
      console.warn('Could not save the ASTRA tab layout.', error);
    });
  }

  /** Track actual tab bars through the public shell API, including after user docking. */
  sync(): void {
    if (!this.shell || this._isDisposed) return;
    const live = new Set<TabBar<Widget>>();
    this.tracker.forEach(tab => {
      const bar = this.shell!.getMainAreaTabBar(tab);
      if (!bar) return;
      const previous = this._groups.get(tab);
      if (this._observeMoves && previous && previous !== bar) this.pin(tab);
      this._groups.set(tab, bar);
      live.add(bar);
      if (this._bars.has(bar)) return;
      const doubleClick = (event: MouseEvent) => {
        if (
          bar.titlesEditable ||
          event.button !== 0 ||
          !(event.target instanceof Element)
        )
          return;
        if (!event.target.closest('.lm-TabBar-tabLabel')) return;
        const node = event.target.closest('.lm-TabBar-tab');
        if (!node) return;
        const index = Array.from(bar.contentNode.children).indexOf(node);
        const owner = bar.titles[index]?.owner;
        const tab = this.tracker.find(item => item === owner);
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
  }

  dispose(): void {
    this._isDisposed = true;
    this.shell?.layoutModified.disconnect(this.sync, this);
    this.app.shell.currentChanged?.disconnect(this.notifyPin, this);
    for (const cleanup of this._bars.values()) cleanup();
    this._bars.clear();
    this._groups.clear();
    this._destinations.clear();
    this._menu.dispose();
  }

  private target(args: ReadonlyPartialJSONObject): ElementTab | undefined {
    const id = args.contextMenu
      ? this.app
          .contextMenuHitTest(node =>
            node.hasAttribute('data-lightcone-element')
          )
          ?.getAttribute('data-lightcone-element')
      : args.widgetId;
    return typeof id === 'string'
      ? this.tracker.find(tab => tab.id === id)
      : this.tracker.find(tab => tab === this.app.shell.currentWidget);
  }

  private notifyPin(): void {
    this.app.commands.notifyCommandChanged(CommandIDs.pinElement);
  }
  private _observeMoves = false;
  private _isDisposed = false;
  private _destinations = new Map<string, ElementTab>();
  private _groups = new Map<ElementTab, TabBar<Widget>>();
  private _bars = new Map<TabBar<Widget>, () => void>();
  private _menu: { dispose(): void };
}
