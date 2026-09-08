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
import { contextualArguments } from './chat-context';
import { UUID, type ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { ElementTabs } from './element-tabs';
import { canonicalRecordPath, parseAstraPath } from './vendor/mystra-path';

/** Expose validated record views and JSON descriptions to UI and agent callers. */
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
    const destination = tabs.destination(
      reference,
      typeof args.sourceWidgetId === 'string' ? args.sourceWidgetId : undefined
    );
    let widget = tabs.existing(key);
    // Restored tabs keep their own stable IDs, even when more than one was a preview.
    const reused = !!widget;
    if (!widget && !restoring) widget = tabs.preview(reference, destination);
    if (!widget) {
      const id =
        restoring &&
        typeof args.widgetId === 'string' &&
        /^lightcone-element-[a-zA-Z0-9-]+$/.test(args.widgetId)
          ? args.widgetId
          : `lightcone-element-${UUID.uuid4()}`;
      widget = new MainAreaWidget({
        content: new ElementWidget(
          reference,
          app.serviceManager.contents,
          themes,
          app.commands,
          key,
          id,
          args.pinned === true
        )
      });
      widget.id = id;
      widget.content.display(reference, key, label);
      tabs.add(widget, destination, restoring);
      await tracker.add(widget);
      widget.disposed.connect(() => tabs.sync());
    } else {
      widget.content.display(reference, key, label);
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
    CommandIDs.readElement,
    CommandIDs.restoreElement
  ]) {
    app.commands.addCommand(command, {
      label:
        command === CommandIDs.openElement
          ? 'Open ASTRA element'
          : command === CommandIDs.restoreElement
            ? 'Restore ASTRA tab'
            : 'Read ASTRA element',
      describedBy: {
        args: {
          type: 'object',
          required: ['entrypoint', 'target'],
          properties: {
            entrypoint: { type: 'string' },
            target: { type: 'string' },
            doi: { type: 'string' },
            universeId: { type: ['string', 'null'] }
          }
        }
      },
      execute: args => {
        const execute = async () => {
          const reference = parseElementReference(contextualArguments(args));
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
            if (command === CommandIDs.readElement) {
              const serialized = JSON.stringify(
                resolved.record ?? resolved.paper ?? resolved.analysis
              );
              return {
                ...pinned,
                kind:
                  resolved.record?.kind ??
                  (resolved.paper ? 'paper' : 'analysis'),
                label: resolved.record
                  ? recordTitle(resolved.record)
                  : (resolved.paper?.title ?? resolved.analysis.name),
                reference: reference.doi
                  ? `https://doi.org/${reference.doi}`
                  : `{astra}\`${reference.target}\``,
                detail: serialized.slice(0, 16000),
                truncated: serialized.length > 16000,
                materialized:
                  resolved.record?.kind === 'output'
                    ? !!resolved.record.artifact
                    : undefined,
                artifacts: data.bindings.filter(
                  binding =>
                    resolved.record &&
                    binding.outputPath === resolved.record.canonicalPath
                )
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
        return command === CommandIDs.readElement
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
        label: widget.title.label
      }),
      name: widget => widget.id
    });
}
