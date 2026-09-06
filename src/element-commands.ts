import type { JupyterFrontEnd, ILayoutRestorer } from '@jupyterlab/application';
import {
  MainAreaWidget,
  WidgetTracker,
  type IThemeManager
} from '@jupyterlab/apputils';
import { recordTitle } from '@astra-spec/ui/model';
import { CommandIDs } from './commands';
import { ElementWidget } from './element-widget';
import { parseElementReference, resolveReference } from './element-reference';
import { acquireProjectDataService } from './project-data-service';
import { contextualArguments } from './chat-context';
import { UUID } from '@lumino/coreutils';
import { astraIcon } from './icons';

/** Expose validated record views and JSON descriptions to UI and agent callers. */
export function registerElementCommands(
  app: JupyterFrontEnd,
  themes: IThemeManager,
  restorer: ILayoutRestorer | null
): void {
  const tracker = new WidgetTracker<MainAreaWidget<ElementWidget>>({
    namespace: 'lightcone-elements'
  });
  app.shell.disposed.connect(() => tracker.dispose());
  const pending = new Map<string, Promise<unknown>>();
  for (const command of [CommandIDs.openElement, CommandIDs.readElement]) {
    app.commands.addCommand(command, {
      label:
        command === CommandIDs.openElement
          ? 'Open ASTRA element'
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
      execute: async args => {
        const reference = parseElementReference(contextualArguments(args));
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
          const key = JSON.stringify([
            pinned.entrypoint,
            resolved.target,
            pinned.universeId
          ]);
          if (pending.has(key)) return pending.get(key);
          const opening = (async () => {
            let widget = tracker.find(item => item.content.identity === key);
            const reused = !!widget;
            if (!widget) {
              widget = new MainAreaWidget({
                content: new ElementWidget(
                  pinned,
                  app.serviceManager.contents,
                  themes,
                  app.commands,
                  key
                )
              });
              widget.id = `lightcone-element-${UUID.uuid4()}`;
              widget.title.label = resolved.record
                ? recordTitle(resolved.record)
                : (resolved.paper?.title ?? reference.doi ?? reference.target);
              widget.title.caption = `${pinned.entrypoint} · ${reference.target}`;
              widget.title.icon = astraIcon;
              app.shell.add(widget, 'main', { mode: 'split-right' });
              await tracker.add(widget);
            }
            widget.content.display(pinned);
            widget.title.caption = `${pinned.entrypoint} · ${pinned.universeId ?? 'defaults'} · ${reference.doi ?? reference.target}`;
            await tracker.save(widget);
            app.shell.activateById(widget.id);
            return {
              ...pinned,
              target: resolved.target,
              view: 'element',
              reused
            };
          })();
          pending.set(key, opening);
          try {
            return await opening;
          } finally {
            pending.delete(key);
          }
        } finally {
          lease.release();
        }
      }
    });
  }
  if (restorer)
    void restorer.restore(tracker, {
      command: CommandIDs.openElement,
      args: widget => ({ ...widget.content.reference }),
      name: widget => widget.content.identity
    });
}
