import { JupyterFrontEnd } from '@jupyterlab/application';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { refreshIcon } from '@jupyterlab/ui-components';
import { astraIcon } from './icons';
import { INVENTORY_FACTORY, InventoryDocument } from './document-widget';
import { parseInventoryOpenReference } from './open-reference';
import { projectDirectory } from './project-data';

export namespace CommandIDs {
  export const openInventory = 'jupyterlab_lightcone:open-inventory';
  export const refresh = 'jupyterlab_lightcone:refresh';
}

interface ICommandOptions {
  app: JupyterFrontEnd;
  documents: IDocumentManager;
  browser: IFileBrowserFactory | null;
  translator?: ITranslator;
}

/** Register the same document-opening path for the launcher and command palette. */
export function registerCommands(options: ICommandOptions): void {
  const { app, documents, browser } = options;
  const contents = app.serviceManager.contents;
  const trans = (options.translator ?? nullTranslator).load(
    'jupyterlab_lightcone'
  );

  const projectPath = (args: ReadonlyPartialJSONObject): string => {
    if (typeof args.path === 'string') {
      return contents.normalize(args.path);
    }
    if (typeof args.cwd === 'string') {
      return contents.resolvePath(args.cwd, 'astra.yaml');
    }
    const current = app.shell.currentWidget;
    if (current instanceof InventoryDocument) {
      return current.context.path;
    }
    const context = current ? documents.contextForWidget(current) : undefined;
    if (context) {
      return contents.resolvePath(projectDirectory(context.path), 'astra.yaml');
    }
    const fileBrowser = browser?.tracker.currentWidget;
    if (fileBrowser) {
      const selected = [...fileBrowser.selectedItems()].filter(
        item => item.name === 'astra.yaml'
      );
      if (selected.length === 1) {
        return selected[0].path;
      }
      return contents.resolvePath(fileBrowser.model.path, 'astra.yaml');
    }
    return 'astra.yaml';
  };

  app.commands.addCommand(CommandIDs.openInventory, {
    label: trans.__('ASTRA Inventory'),
    caption: trans.__('Open the project inventory in Lightcone Lab'),
    icon: astraIcon,
    describedBy: {
      args: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Project astra.yaml contents path'
          },
          cwd: {
            type: 'string',
            description: 'Project directory contents path'
          },
          analysisPath: { type: 'string' },
          scope: { type: 'string' },
          openReference: {
            type: 'object',
            description: 'ASTRA record or paper reference'
          }
        }
      }
    },
    execute: async args => {
      try {
        const path = projectPath(args);
        // Check existence before creating a document context (which may create new files).
        try {
          await contents.get(path, { content: false });
        } catch (error) {
          if (
            error instanceof ServerConnection.ResponseError &&
            error.response.status === 404
          ) {
            await showErrorMessage(
              trans.__('No ASTRA project found'),
              trans.__(
                'No ASTRA project file was found at "%1". Open a folder containing astra.yaml in the file browser, then choose ASTRA Inventory.',
                path
              )
            );
            return undefined;
          }
          throw error;
        }
        const widget = documents.openOrReveal(path, INVENTORY_FACTORY);
        if (!(widget instanceof InventoryDocument)) {
          throw new Error(
            trans.__('The Lightcone Lab document viewer is unavailable.')
          );
        }
        await widget.context.ready;
        if (!widget.isDisposed) {
          const openReference = parseInventoryOpenReference(args.openReference);
          await widget.content.display(
            {
              ...(typeof args.analysisPath === 'string'
                ? { analysisPath: args.analysisPath }
                : {}),
              ...(typeof args.scope === 'string' ? { scope: args.scope } : {}),
              ...(openReference ? { openReference } : {})
            },
            widget.context.path
          );
          app.shell.activateById(widget.id);
        }
        return widget;
      } catch (error) {
        await showErrorMessage(
          trans.__('Could not open the ASTRA inventory'),
          error instanceof Error ? error : String(error)
        );
        return undefined;
      }
    }
  });

  app.commands.addCommand(CommandIDs.refresh, {
    label: trans.__('Refresh ASTRA Inventory'),
    icon: refreshIcon,
    describedBy: { args: { type: 'object', properties: {} } },
    isEnabled: () => app.shell.currentWidget instanceof InventoryDocument,
    execute: () => {
      const widget = app.shell.currentWidget;
      if (widget instanceof InventoryDocument) {
        return widget.content.refresh();
      }
    }
  });
  app.shell.currentChanged?.connect(() =>
    app.commands.notifyCommandChanged(CommandIDs.refresh)
  );
}
