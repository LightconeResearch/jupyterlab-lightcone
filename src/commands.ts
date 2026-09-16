import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  MainAreaWidget,
  WidgetTracker,
  showErrorMessage
} from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import { type IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { refreshIcon } from '@jupyterlab/ui-components';
import {
  astraIcon,
  mystIcon,
  createProjectIcon,
  openProjectIcon
} from './icons';
import { INVENTORY_FACTORY, InventoryDocument } from './document-widget';
import { parseInventoryOpenReference } from './open-reference';
import { projectDirectory } from './project-data';
import { startMySTRA } from './api';
import { MySTRAViewer } from './mystra-viewer';
import { browseProjectFolder } from './project-browser';
import { findProjectRoot, projectEntrypoint } from './project-root';
import { ProjectSetup } from './project-setup';

export namespace CommandIDs {
  export const openExistingProject =
    'jupyterlab_lightcone:open-existing-project';
  export const finishProjectSetup = 'jupyterlab_lightcone:finish-project-setup';
  export const createProject = 'jupyterlab_lightcone:create-project';
  export const restartMySTRA = 'jupyterlab_lightcone:restart-mystra';
  export const openMySTRA = 'jupyterlab_lightcone:open-mystra';
  export const pinElement = 'jupyterlab_lightcone:pin-element';
  export const unpinElement = 'jupyterlab_lightcone:unpin-element';
  export const restoreElement = 'jupyterlab_lightcone:restore-element';
  export const openElement = 'jupyterlab_lightcone:open-element';
  export const resolvePreview = 'jupyterlab_lightcone:resolve-preview';
  export const discuss = 'jupyterlab_lightcone:discuss';
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

  const projectPath = async (
    args: ReadonlyPartialJSONObject
  ): Promise<string> => {
    if (typeof args.path === 'string') {
      return contents.normalize(args.path);
    }
    if (typeof args.cwd === 'string') {
      return projectEntrypoint(contents, args.cwd);
    }
    const current = app.shell.currentWidget;
    if (current instanceof InventoryDocument) {
      return current.context.path;
    }
    const context = current ? documents.contextForWidget(current) : undefined;
    if (context) {
      const directory = projectDirectory(context.path);
      return projectEntrypoint(contents, directory);
    }
    const fileBrowser = browser?.tracker.currentWidget;
    if (fileBrowser) {
      const selected = [...fileBrowser.selectedItems()].filter(
        item => item.name === 'astra.yaml'
      );
      if (selected.length === 1) {
        return selected[0].path;
      }
      return projectEntrypoint(contents, fileBrowser.model.path);
    }
    return projectEntrypoint(contents, '');
  };

  const openFolder = async (path: string): Promise<unknown> => {
    const drive = contents.driveName(path);
    const fileBrowser = browser?.tracker.find(
      widget => contents.driveName(widget.model.path) === drive
    );
    if (browser && !fileBrowser)
      throw new Error('No file browser is available for this drive.');
    await fileBrowser?.model.cd(`/${contents.localPath(path)}`);
    return app.commands.execute('launcher:create', {
      cwd: path,
      activate: true
    });
  };
  app.commands.addCommand(CommandIDs.openExistingProject, {
    label: trans.__('Open project'),
    icon: openProjectIcon,
    describedBy: {
      args: { type: 'object', properties: { cwd: { type: 'string' } } }
    },
    execute: async args => {
      try {
        const path = await browseProjectFolder(
          documents,
          typeof args.cwd === 'string'
            ? args.cwd
            : (browser?.tracker.currentWidget?.model.path ?? ''),
          options.translator
        );
        if (path === undefined) return;
        const root = await findProjectRoot(contents, path);
        if (root) return await openFolder(root.path);
        return await app.commands.execute(CommandIDs.createProject, { path });
      } catch (error) {
        await showErrorMessage(
          trans.__('Could not open project'),
          error instanceof Error ? error : String(error)
        );
      }
    }
  });
  const showSetup = (path: string, mode: 'create' | 'finish') => {
    const content = new ProjectSetup({
      path,
      mode,
      settings: contents.serverSettings,
      browse: () =>
        browseProjectFolder(
          documents,
          browser?.tracker.currentWidget?.model.path ?? '',
          options.translator
        ),
      open: async project => {
        await openFolder(project.path);
        setup.dispose();
      }
    });
    const setup = new MainAreaWidget({ content });
    setup.title.label =
      mode === 'finish'
        ? trans.__('Finish project setup')
        : trans.__('Create project');
    setup.title.icon = createProjectIcon;
    setup.title.closable = true;
    app.shell.add(setup, 'main');
    app.shell.activateById(setup.id);
    return setup;
  };
  app.commands.addCommand(CommandIDs.createProject, {
    label: trans.__('Create project'),
    icon: createProjectIcon,
    describedBy: {
      args: {
        type: 'object',
        properties: { cwd: { type: 'string' }, path: { type: 'string' } }
      }
    },
    execute: args =>
      showSetup(
        typeof args.path === 'string'
          ? args.path
          : contents.resolvePath(
              typeof args.cwd === 'string'
                ? args.cwd
                : (browser?.tracker.currentWidget?.model.path ?? ''),
              'my-project'
            ),
        'create'
      )
  });
  app.commands.addCommand(CommandIDs.finishProjectSetup, {
    label: trans.__('Finish project setup'),
    icon: createProjectIcon,
    describedBy: {
      args: { type: 'object', properties: { cwd: { type: 'string' } } }
    },
    execute: async args => {
      try {
        const directory =
          typeof args.cwd === 'string'
            ? args.cwd
            : (browser?.tracker.currentWidget?.model.path ?? '');
        const project = await findProjectRoot(contents, directory);
        return showSetup(project?.path ?? directory, 'finish');
      } catch (error) {
        await showErrorMessage(
          trans.__('Could not finish project setup'),
          error instanceof Error ? error : String(error)
        );
      }
    }
  });

  app.commands.addCommand(CommandIDs.restartMySTRA, {
    label: trans.__('Restart MySTRA Viewer'),
    describedBy: { args: { type: 'object', properties: {} } },
    isEnabled: () => app.shell.currentWidget instanceof MySTRAViewer,
    execute: () => {
      const viewer = app.shell.currentWidget;
      if (viewer instanceof MySTRAViewer) return viewer.restartSession();
    }
  });

  const viewers = new WidgetTracker<MySTRAViewer>({
    namespace: 'lightcone-mystra'
  });
  app.commands.addCommand(CommandIDs.openMySTRA, {
    label: trans.__('MySTRA Viewer'),
    caption: trans.__('Open this project with its ASTRA publication theme'),
    describedBy: {
      args: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          cwd: { type: 'string' },
          fromContextMenu: { type: 'boolean' }
        }
      }
    },
    icon: mystIcon,
    execute: async args => {
      try {
        const current = app.shell.currentWidget;
        const context = current
          ? documents.contextForWidget(current)
          : undefined;
        const fileBrowser = browser?.tracker.currentWidget;
        const selected = fileBrowser ? [...fileBrowser.selectedItems()] : [];
        const path =
          typeof args.path === 'string'
            ? args.path
            : typeof args.cwd === 'string'
              ? args.cwd
              : args.fromContextMenu === true && selected[0]
                ? selected[0].path
                : current instanceof MySTRAViewer
                  ? current.path
                  : (context?.path ??
                    selected[0]?.path ??
                    fileBrowser?.model.path ??
                    '');
        const model = await contents.get(path, { content: false });
        const root = await findProjectRoot(
          contents,
          model.type === 'directory' ? path : projectDirectory(path)
        );
        const session = await startMySTRA(
          contents.serverSettings,
          root?.path ?? path
        );
        let viewer = viewers.find(candidate => candidate.path === session.path);
        if (viewer) {
          // The server may have minted a new session after the old one expired.
          viewer.adopt(session);
        } else {
          viewer = new MySTRAViewer(
            session,
            contents.serverSettings,
            options.translator
          );
          await viewers.add(viewer);
          app.shell.add(viewer, 'main');
        }
        app.shell.activateById(viewer.id);
        return viewer;
      } catch (error) {
        await showErrorMessage(
          trans.__('Could not open MySTRA Viewer'),
          error instanceof Error ? error : String(error)
        );
        return undefined;
      }
    }
  });

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
        const path = await projectPath(args);
        // Check existence before creating a document context (which may create new files).
        try {
          await contents.get(path, { content: false });
        } catch (error) {
          if (
            error instanceof ServerConnection.ResponseError &&
            error.response.status === 404
          ) {
            await app.commands.execute(CommandIDs.createProject, {
              path: projectDirectory(path)
            });
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
