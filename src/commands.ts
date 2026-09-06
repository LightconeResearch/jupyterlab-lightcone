import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  InputDialog,
  MainAreaWidget,
  showErrorMessage,
  WidgetTracker,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { listIcon, fileIcon, refreshIcon } from '@jupyterlab/ui-components';
import { INVENTORY_FACTORY, InventoryDocument } from './document-widget';
import { parseInventoryOpenReference } from './open-reference';
import { projectDirectory } from './project-data';
import { PaperPanel } from './paper-panel';

export namespace CommandIDs {
  export const openInventory = 'jupyterlab_lightcone:open-inventory';
  export const openPaper = 'jupyterlab_lightcone:open-paper';
  export const refresh = 'jupyterlab_lightcone:refresh';
}

interface ICommandOptions {
  app: JupyterFrontEnd;
  documents: IDocumentManager;
  themes: IThemeManager;
  browser: IFileBrowserFactory | null;
  papers: WidgetTracker<MainAreaWidget<PaperPanel>>;
  publicationUrl: () => string;
  translator?: ITranslator;
}

/** Register the same document-opening path for the launcher and command palette. */
export function registerCommands(options: ICommandOptions): void {
  const { app, documents, themes, browser, papers } = options;
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
    if (
      current instanceof MainAreaWidget &&
      current.content instanceof PaperPanel
    ) {
      return current.content.entrypoint;
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
    caption: trans.__('Open the project inventory in lightcone lab'),
    icon: listIcon,
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
        await contents.get(path, { content: false });
        const widget = documents.openOrReveal(path, INVENTORY_FACTORY);
        if (!(widget instanceof InventoryDocument)) {
          throw new Error(
            trans.__('The lightcone lab document viewer is unavailable.')
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

  app.commands.addCommand(CommandIDs.openPaper, {
    label: trans.__('MyST Paper'),
    caption: trans.__('Open a publication linked to this ASTRA project'),
    icon: fileIcon,
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
          url: { type: 'string', description: 'MyST publication URL' }
        }
      }
    },
    execute: async args => {
      try {
        const path = projectPath(args);
        let url =
          typeof args.url === 'string' ? args.url : options.publicationUrl();
        if (!url) {
          const result = await InputDialog.getText({
            title: trans.__('Open MyST publication'),
            label: trans.__('Publication URL (reachable from this browser)'),
            placeholder: 'https://…'
          });
          if (!result.button.accept || !result.value) {
            return undefined;
          }
          url = result.value;
        }
        const resolvedUrl = new URL(url, window.location.href).href;
        let widget = papers.find(
          item =>
            item.content.entrypoint === path && item.content.url === resolvedUrl
        );
        if (!widget) {
          const content = new PaperPanel(contents, themes, {
            url: resolvedUrl
          });
          content.display(path);
          widget = new MainAreaWidget({ content });
          widget.id = `jupyterlab-lightcone-paper-${papers.size + 1}-${Date.now()}`;
          widget.title.label = trans.__(
            'MyST Paper · %1',
            projectDirectory(path) || trans.__('root')
          );
          widget.title.caption = `${path} — ${resolvedUrl}`;
          widget.title.icon = fileIcon;
          widget.title.closable = true;
          app.shell.add(widget, 'main');
          await papers.add(widget);
        }
        app.shell.activateById(widget.id);
        return widget;
      } catch (error) {
        await showErrorMessage(
          trans.__('Could not open the MyST publication'),
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
