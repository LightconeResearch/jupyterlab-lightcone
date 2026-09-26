/**
 * TEMPORARY: the managed MySTRA Viewer, a stopgap to remove when possible.
 *
 * MyST offers no supported way to embed a running `myst start` site in
 * JupyterLab, so the `jupyterlab_lightcone.mystra` server extension runs the
 * MyST CLI and proxies it, for ASTRA themes implementing `mystra-viewer.v1`.
 * Everything the viewer needs lives in this directory and that package;
 * nothing else in Lightcone imports them. Removing the viewer means deleting
 * both and their single registrations: this plugin in `src/index.ts`, the
 * stylesheet import in `style/index.css`, and the server extension point in
 * `jupyterlab_lightcone/__init__.py`.
 */
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  ICommandPalette,
  WidgetTracker,
  showErrorMessage
} from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ILauncher } from '@jupyterlab/launcher';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ICurrentProject } from '../current-project';
import { projectDirectory } from '../project-data';
import { configureProjectLauncher } from '../project-launcher';
import { findProjectRoot } from '../project-root';
import { startMySTRA } from './api';
import { MySTRAViewer, mystIcon } from './viewer';

export namespace MySTRACommandIDs {
  export const open = 'jupyterlab_lightcone:open-mystra';
  export const restart = 'jupyterlab_lightcone:restart-mystra';
}

const CATEGORY = 'Lightcone Lab';

/** Open the active project's ASTRA publication theme in a JupyterLab tab. */
export const mystraPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:mystra',
  description:
    'Temporary MySTRA Viewer: the running MyST site of an ASTRA project',
  autoStart: true,
  optional: [
    IDocumentManager,
    IFileBrowserFactory,
    ICommandPalette,
    ILauncher,
    ICurrentProject,
    ITranslator
  ],
  activate: (
    app: JupyterFrontEnd,
    documents: IDocumentManager | null,
    browser: IFileBrowserFactory | null,
    palette: ICommandPalette | null,
    launcher: ILauncher | null,
    current: ICurrentProject | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const contents = app.serviceManager.contents;
    const viewers = new WidgetTracker<MySTRAViewer>({
      namespace: 'lightcone-mystra'
    });

    /** The explicit path, else the selection, viewer, document or folder in focus. */
    const targetPath = (args: {
      path?: unknown;
      cwd?: unknown;
      fromContextMenu?: unknown;
    }): string => {
      if (typeof args.path === 'string') return args.path;
      if (typeof args.cwd === 'string') return args.cwd;
      const fileBrowser = browser?.tracker.currentWidget;
      const selected = fileBrowser ? [...fileBrowser.selectedItems()] : [];
      if (args.fromContextMenu === true && selected[0]) return selected[0].path;
      const focused = app.shell.currentWidget;
      if (focused instanceof MySTRAViewer) return focused.path;
      const context = focused
        ? documents?.contextForWidget(focused)
        : undefined;
      return (
        context?.path ?? selected[0]?.path ?? fileBrowser?.model.path ?? ''
      );
    };

    app.commands.addCommand(MySTRACommandIDs.open, {
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
          const path = targetPath(args);
          const model = await contents.get(path, { content: false });
          // Prefer the ASTRA project's own myst.yml over a nested one.
          const root = await findProjectRoot(
            contents,
            model.type === 'directory' ? path : projectDirectory(path)
          );
          const session = await startMySTRA(
            contents.serverSettings,
            root?.path ?? path
          );
          let viewer = viewers.find(
            candidate => candidate.path === session.path
          );
          if (viewer) {
            // The server may have minted a new session after the old one expired.
            viewer.adopt(session);
          } else {
            viewer = new MySTRAViewer(
              session,
              contents.serverSettings,
              translator ?? undefined
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

    app.commands.addCommand(MySTRACommandIDs.restart, {
      label: trans.__('Restart MySTRA Viewer'),
      describedBy: { args: { type: 'object', properties: {} } },
      isEnabled: () => app.shell.currentWidget instanceof MySTRAViewer,
      execute: () => {
        const viewer = app.shell.currentWidget;
        if (viewer instanceof MySTRAViewer) return viewer.restartSession();
      }
    });

    palette?.addItem({ command: MySTRACommandIDs.open, category: CATEGORY });
    palette?.addItem({ command: MySTRACommandIDs.restart, category: CATEGORY });
    app.contextMenu.addItem({
      command: MySTRACommandIDs.open,
      selector: '.jp-DirListing-item',
      args: { fromContextMenu: true },
      rank: 20
    });
    if (launcher && current) {
      // After the core plugin's Lightcone Agent and ASTRA Inventory cards.
      configureProjectLauncher(app, launcher, current, {
        project: [MySTRACommandIDs.open],
        outside: [],
        rank: 2
      });
    }
  }
};
