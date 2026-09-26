import { COMMIT_PATTERN } from './versions/versions-api';
import type {
  ILabShell,
  JupyterFrontEnd,
  ILayoutRestorer
} from '@jupyterlab/application';
import {
  MainAreaWidget,
  WidgetTracker,
  type IThemeManager
} from '@jupyterlab/apputils';
import { analysisTitle, recordTitle } from '@astra-spec/ui/model';
import { UUID, type ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { CommandIDs } from './commands';
import { ElementWidget } from './element-widget';
import {
  parseElementReference,
  resolveReference,
  type IElementReference,
  type IResolvedElement
} from './element-reference';
import type { ILoadedProjectData } from './project-data';
import { acquireProjectDataService } from './project-data-service';
import { ElementTabs } from './element-tabs';
import { canonicalRecordPath, parseAstraPath } from './vendor/mystra-path';
import { ELEMENT_TAB_ID_PREFIX, isElementTabId } from './workbench-ids';

/** A reference pinned to the universe its project resolved. */
export type PinnedReference = IElementReference & { universeId: string | null };

/** A record shown in a tab, as `openElement` and `restoreElement` report it. */
export interface IElementTabResult extends IElementReference {
  view: 'element';
  /** Whether an open tab was navigated or reused rather than created. */
  reused: boolean;
  widgetId: string;
  pinned: boolean;
}

/** An analysis scope shown in the inventory, as `openElement` reports it. */
export interface IInventoryScopeResult extends IElementReference {
  view: 'inventory';
}

export type ElementOpenResult = IElementTabResult | IInventoryScopeResult;

/** What a chat preview card is made from, as `resolvePreview` reports it. */
export interface IPreviewCard extends PinnedReference {
  label: string;
}

/** What a tab shows beyond the reference itself, and whether it is kept. */
interface IShowOptions {
  /** Show this committed output version first. */
  versionCommit?: string;
  /** Keep the tab rather than letting the next open replace it. */
  pinned: boolean;
}

/** How a tab is chosen for a reference. */
type Placement =
  | {
      kind: 'open';
      /** The record tab a link was followed from; it is navigated in place. */
      sourceWidgetId?: string;
      /** Open beside the source tab instead of navigating it. */
      newTab: boolean;
    }
  | {
      kind: 'restore';
      /** The id the tab had when the layout was saved. */
      widgetId?: string;
    };

/** A project's data with a reference resolved against it. */
interface IResolvedProject {
  data: ILoadedProjectData;
  resolved: IResolvedElement;
  pinned: PinnedReference;
}

function parseShowOptions(args: ReadonlyPartialJSONObject): IShowOptions {
  const versionCommit =
    typeof args.versionCommit === 'string' &&
    COMMIT_PATTERN.test(args.versionCommit)
      ? args.versionCommit
      : undefined;
  return {
    pinned: args.pinned === true,
    ...(versionCommit ? { versionCommit } : {})
  };
}

function parseOpenPlacement(args: ReadonlyPartialJSONObject): Placement {
  return {
    kind: 'open',
    ...(typeof args.sourceWidgetId === 'string'
      ? { sourceWidgetId: args.sourceWidgetId }
      : {}),
    newTab: args.newTab === true
  };
}

function parseRestorePlacement(args: ReadonlyPartialJSONObject): Placement {
  return {
    kind: 'restore',
    ...(typeof args.widgetId === 'string' && isElementTabId(args.widgetId)
      ? { widgetId: args.widgetId }
      : {})
  };
}

const REFERENCE_PROPERTIES = {
  entrypoint: { type: 'string' },
  target: { type: 'string' },
  doi: { type: 'string' },
  universeId: { type: ['string', 'null'] }
};

const SHOW_PROPERTIES = {
  pinned: { type: 'boolean' },
  versionCommit: {
    type: 'string',
    description: 'Show this committed output version first'
  }
};

/** Expose record views and validate references before publishing chat previews. */
export function registerElementCommands(
  app: JupyterFrontEnd,
  themes: IThemeManager,
  restorer: ILayoutRestorer | null,
  shell: ILabShell | null
): void {
  const tracker = new WidgetTracker<MainAreaWidget<ElementWidget>>({
    namespace: 'lightcone-elements'
  });
  const tabs = new ElementTabs(app, shell, tracker);
  app.shell.disposed.connect(() => {
    tabs.dispose();
    tracker.dispose();
  });
  let opening: Promise<unknown> = Promise.resolve();
  // Serialize opens in request order. Pins remain synchronous while resolution awaits I/O.
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = opening.then(operation);
    opening = result.catch(() => undefined);
    return result;
  };

  /**
   * Load the project a reference names and resolve the reference in it,
   * holding the project lease while `use` runs.
   */
  const withResolved = async <T>(
    reference: IElementReference,
    use: (project: IResolvedProject) => Promise<T>
  ): Promise<T> => {
    const lease = acquireProjectDataService(
      app.serviceManager.contents,
      reference.entrypoint,
      reference.universeId
    );
    try {
      const data = await lease.service.get();
      if (lease.service.state.error) throw new Error(lease.service.state.error);
      const resolved = resolveReference(data, reference);
      const pinned = {
        ...reference,
        universeId:
          data.document.universe.source === 'none'
            ? null
            : data.document.universe.universeId
      };
      return await use({ data, resolved, pinned });
    } finally {
      lease.release();
    }
  };

  /** The title of the record or paper a reference resolved to. */
  const resolvedLabel = (resolved: IResolvedElement): string => {
    if (resolved.record) return recordTitle(resolved.record);
    if (resolved.paper) return resolved.paper.title;
    throw new Error(`${resolved.target} names neither a record nor a paper.`);
  };

  /** Show a reference in a tab; a restore needs no currently readable project. */
  const showElement = async (
    reference: IElementReference,
    target: string,
    label: string,
    placement: Placement,
    options: IShowOptions
  ): Promise<IElementTabResult> => {
    // Docking notifications are deferred; observe a just-moved tab before reuse.
    tabs.sync();
    const key = JSON.stringify([
      reference.entrypoint,
      target,
      reference.universeId
    ]);
    const restoring = placement.kind === 'restore';
    const sourceId =
      placement.kind === 'open' ? placement.sourceWidgetId : undefined;
    const newTab = placement.kind === 'open' && placement.newTab;
    const restoredId =
      placement.kind === 'restore' ? placement.widgetId : undefined;
    const destination = tabs.destination(reference, sourceId);
    // A link followed inside a record navigates that tab and extends its
    // history, pinned or not; every other open looks for the record first,
    // then for the group's preview.
    let widget =
      sourceId && !newTab ? tabs.navigable(sourceId, reference) : undefined;
    // Restored tabs keep their own stable IDs, even when more than one was a
    // preview or showed the same record ("Open in new tab").
    if (!widget && restoredId) widget = tabs.find(restoredId);
    if (!widget && !newTab && !restoring) widget = tabs.existing(key);
    const reused = !!widget;
    if (!widget && !restoring && !newTab)
      widget = tabs.preview(reference, destination);
    const display = { versionCommit: options.versionCommit };
    if (!widget) {
      const id = restoredId ?? `${ELEMENT_TAB_ID_PREFIX}${UUID.uuid4()}`;
      widget = new MainAreaWidget({
        content: new ElementWidget(
          reference,
          app.serviceManager.contents,
          themes,
          app.commands,
          key,
          id,
          // A tab asked for explicitly is kept: a group has one preview, and
          // the next result opened elsewhere must not replace this one.
          options.pinned || newTab
        )
      });
      widget.id = id;
      widget.content.display(reference, key, label, display);
      tabs.add(widget, destination, restoring);
      await tracker.add(widget);
      const tab = widget;
      // Back, Forward and the stepper change what the tab shows without an
      // open; save each change so that a reload restores that record.
      tab.content.historyChanged.connect(() => tabs.save(tab));
      widget.disposed.connect(() => tabs.sync());
    } else {
      widget.content.display(reference, key, label, display);
      if (options.pinned) tabs.pin(widget);
    }
    if (!reused) tabs.remember(widget);
    await tracker.save(widget);
    tabs.sync();
    if (!restoring) app.shell.activateById(widget.id);
    return {
      ...reference,
      target,
      view: 'element',
      reused,
      widgetId: widget.id,
      pinned: widget.content.isPinned
    };
  };

  /** Show an analysis scope in the inventory, which follows the project's own universe. */
  const showInventory = async ({
    data,
    resolved,
    pinned
  }: IResolvedProject): Promise<IInventoryScopeResult> => {
    const inventoryLease = acquireProjectDataService(
      app.serviceManager.contents,
      pinned.entrypoint
    );
    try {
      const inventory = await inventoryLease.service.get();
      if (
        inventory.document.universe.universeId !==
          data.document.universe.universeId ||
        inventory.document.universe.source !== data.document.universe.source
      )
        throw new Error(
          'The inventory uses the automatically selected universe. Open individual records to inspect this pinned universe.'
        );
    } finally {
      inventoryLease.release();
    }
    await app.commands.execute(CommandIDs.openInventory, {
      path: pinned.entrypoint,
      analysisPath: resolved.analysis.canonicalPath
    });
    return { ...pinned, view: 'inventory' };
  };

  app.commands.addCommand(CommandIDs.openElement, {
    label: 'Open ASTRA element',
    describedBy: {
      args: {
        type: 'object',
        required: ['entrypoint', 'target'],
        properties: {
          ...REFERENCE_PROPERTIES,
          ...SHOW_PROPERTIES,
          sourceWidgetId: {
            type: 'string',
            description: 'The record tab a link was followed from'
          },
          newTab: {
            type: 'boolean',
            description: 'Open beside the source tab instead of navigating it'
          }
        }
      }
    },
    execute: (args): Promise<ElementOpenResult> =>
      enqueue(() => {
        const reference = parseElementReference(args);
        const placement = parseOpenPlacement(args);
        const options = parseShowOptions(args);
        return withResolved<ElementOpenResult>(reference, project =>
          project.resolved.record || project.resolved.paper
            ? showElement(
                project.pinned,
                project.resolved.target,
                resolvedLabel(project.resolved),
                placement,
                options
              )
            : showInventory(project)
        );
      })
  });

  app.commands.addCommand(CommandIDs.resolvePreview, {
    label: 'Resolve ASTRA preview',
    describedBy: {
      args: {
        type: 'object',
        required: ['entrypoint', 'target'],
        properties: REFERENCE_PROPERTIES
      }
    },
    execute: (args): Promise<IPreviewCard> => {
      const reference = parseElementReference(args);
      return withResolved(reference, async ({ resolved, pinned }) => {
        return {
          ...pinned,
          label: resolved.record
            ? recordTitle(resolved.record)
            : (resolved.paper?.title ?? analysisTitle(resolved.analysis))
        };
      });
    }
  });

  app.commands.addCommand(CommandIDs.restoreElement, {
    label: 'Restore ASTRA tab',
    describedBy: {
      args: {
        type: 'object',
        required: ['entrypoint', 'target'],
        properties: {
          ...REFERENCE_PROPERTIES,
          ...SHOW_PROPERTIES,
          widgetId: {
            type: 'string',
            description: 'The id the tab had when the layout was saved'
          },
          label: {
            type: 'string',
            description: 'The tab label, shown until the record loads'
          }
        }
      }
    },
    execute: (args): Promise<IElementTabResult> =>
      enqueue(() => {
        const reference = parseElementReference(args);
        const target = reference.doi
          ? `doi:${reference.doi}`
          : canonicalRecordPath(parseAstraPath(reference.target));
        if (!target)
          throw new Error('A restored ASTRA tab needs a record or DOI.');
        return showElement(
          reference,
          target,
          typeof args.label === 'string' ? args.label : target,
          parseRestorePlacement(args),
          parseShowOptions(args)
        );
      })
  });

  if (restorer)
    void restorer.restore(tracker, {
      command: CommandIDs.restoreElement,
      args: widget => ({
        ...widget.content.reference,
        widgetId: widget.id,
        pinned: widget.content.isPinned,
        label: widget.title.label,
        ...(widget.content.selectedVersion
          ? { versionCommit: widget.content.selectedVersion }
          : {})
      }),
      name: widget => widget.id
    });
}
