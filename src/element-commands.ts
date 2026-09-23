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
import { recordTitle } from '@astra-spec/ui/model';
import { CommandIDs } from './commands';
import { ElementWidget } from './element-widget';
import {
  parseElementReference,
  resolveReference,
  type IElementReference
} from './element-reference';
import { acquireProjectDataService } from './project-data-service';
import { UUID, type ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ElementTabs } from './element-tabs';
import { latestCardVersion } from './versions/card-version';
import { canonicalRecordPath, parseAstraPath } from './vendor/mystra-path';

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
  const enqueue = (operation: () => Promise<unknown>): Promise<unknown> => {
    const result = opening.then(operation);
    opening = result.catch(() => undefined);
    return result;
  };
  /** Restore identifiers without requiring a currently readable project. */
  const showElement = async (
    reference: IElementReference,
    target: string,
    label: string,
    args: ReadonlyPartialJSONObject,
    restoring = false
  ) => {
    // Docking notifications are deferred; observe a just-moved tab before reuse.
    tabs.sync();
    const key = JSON.stringify([
      reference.entrypoint,
      target,
      reference.universeId
    ]);
    const sourceId =
      typeof args.sourceWidgetId === 'string' ? args.sourceWidgetId : undefined;
    const newTab = args.newTab === true && !restoring;
    const versionCommit =
      typeof args.versionCommit === 'string' &&
      /^[0-9a-f]{7,40}$/i.test(args.versionCommit)
        ? args.versionCommit
        : undefined;
    const restoredId =
      restoring &&
      typeof args.widgetId === 'string' &&
      /^lightcone-element-[a-zA-Z0-9-]+$/.test(args.widgetId)
        ? args.widgetId
        : undefined;
    const destination = tabs.destination(reference, sourceId);
    // A link followed inside a record navigates that tab and extends its
    // history, pinned or not; every other open looks for the record first,
    // then for the group's preview.
    let widget =
      sourceId && !newTab && !restoring
        ? tabs.navigable(sourceId, reference)
        : undefined;
    // Restored tabs keep their own stable IDs, even when more than one was a
    // preview or showed the same record ("Open in new tab").
    if (!widget && restoredId) widget = tabs.find(restoredId);
    if (!widget && !newTab && !restoring) widget = tabs.existing(key);
    const reused = !!widget;
    if (!widget && !restoring && !newTab)
      widget = tabs.preview(reference, destination);
    if (!widget) {
      const id = restoredId ?? `lightcone-element-${UUID.uuid4()}`;
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
          args.pinned === true || newTab
        )
      });
      widget.id = id;
      widget.content.display(reference, key, label, { versionCommit });
      tabs.add(widget, destination, restoring);
      await tracker.add(widget);
      const tab = widget;
      // Back, Forward and the stepper change what the tab shows without an
      // open; save each change so that a reload restores that record.
      tab.content.historyChanged.connect(() => tabs.save(tab));
      widget.disposed.connect(() => tabs.sync());
    } else {
      widget.content.display(reference, key, label, { versionCommit });
      if (args.pinned === true) tabs.pin(widget);
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
  for (const command of [
    CommandIDs.openElement,
    CommandIDs.resolvePreview,
    CommandIDs.restoreElement
  ]) {
    app.commands.addCommand(command, {
      label:
        command === CommandIDs.openElement
          ? 'Open ASTRA element'
          : command === CommandIDs.restoreElement
            ? 'Restore ASTRA tab'
            : 'Resolve ASTRA preview',
      describedBy: {
        args: {
          type: 'object',
          required: ['entrypoint', 'target'],
          properties: {
            entrypoint: { type: 'string' },
            target: { type: 'string' },
            doi: { type: 'string' },
            universeId: { type: ['string', 'null'] },
            pinned: { type: 'boolean' },
            sourceWidgetId: {
              type: 'string',
              description: 'The record tab a link was followed from'
            },
            newTab: {
              type: 'boolean',
              description: 'Open beside the source tab instead of navigating it'
            },
            versionCommit: {
              type: 'string',
              description: 'Show this committed output version first'
            }
          }
        }
      },
      execute: args => {
        const execute = async () => {
          const reference = parseElementReference(args);
          if (command === CommandIDs.restoreElement) {
            const target = reference.doi
              ? `doi:${reference.doi}`
              : canonicalRecordPath(parseAstraPath(reference.target));
            if (!target)
              throw new Error('A restored ASTRA tab needs a record or DOI.');
            return showElement(
              reference,
              target,
              typeof args.label === 'string' ? args.label : target,
              args,
              true
            );
          }
          const lease = acquireProjectDataService(
            app.serviceManager.contents,
            reference.entrypoint,
            reference.universeId
          );
          try {
            const data = await lease.service.get();
            if (lease.service.state.error)
              throw new Error(lease.service.state.error);
            const resolved = resolveReference(data, reference);
            const pinned = {
              ...reference,
              universeId:
                data.document.universe.source === 'none'
                  ? null
                  : data.document.universe.universeId
            };
            if (command === CommandIDs.resolvePreview) {
              // An output's card pins the version the agent shows now, so a
              // later run does not change what an earlier turn displayed.
              const outputVersion = await latestCardVersion(
                app.serviceManager.contents,
                reference.entrypoint,
                data,
                resolved.record
              );
              return {
                ...pinned,
                label: resolved.record
                  ? recordTitle(resolved.record)
                  : (resolved.paper?.title ?? resolved.analysis.name),
                ...(outputVersion ? { outputVersion } : {})
              };
            }
            if (!resolved.record && !resolved.paper) {
              const inventoryLease = acquireProjectDataService(
                app.serviceManager.contents,
                reference.entrypoint
              );
              try {
                const inventory = await inventoryLease.service.get();
                if (
                  inventory.document.universe.universeId !==
                    data.document.universe.universeId ||
                  inventory.document.universe.source !==
                    data.document.universe.source
                )
                  throw new Error(
                    'The inventory uses the automatically selected universe. Open individual records to inspect this pinned universe.'
                  );
              } finally {
                inventoryLease.release();
              }
              await app.commands.execute(CommandIDs.openInventory, {
                path: reference.entrypoint,
                analysisPath: resolved.analysis.canonicalPath
              });
              return { ...pinned, view: 'inventory' };
            }
            return await showElement(
              pinned,
              resolved.target,
              resolved.record
                ? recordTitle(resolved.record)
                : resolved.paper!.title,
              args
            );
          } finally {
            lease.release();
          }
        };
        return command === CommandIDs.resolvePreview
          ? execute()
          : enqueue(execute);
      }
    });
  }
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
