import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  MainAreaWidget,
  WidgetTracker,
  showErrorMessage
} from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';
import { type IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
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
import { findModel, findProjectRoot, type IProjectRoot } from './project-root';
import { ProjectSetup } from './project-setup';
import { HomeCommandIDs } from './home/home-commands';

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

/** Where a command looks for its project: a known spec, or a folder to search from. */
export type ProjectTarget = { entrypoint: string } | { directory: string };

/**
 * Resolve the project a command acts on. Where there is none, offer setup in
 * that folder instead and return undefined, so no caller creates stray files.
 */
export async function requireProject(
  app: JupyterFrontEnd,
  target: ProjectTarget
): Promise<IProjectRoot | undefined> {
  const contents = app.serviceManager.contents;
  let path: string;
  if ('entrypoint' in target) {
    path = projectDirectory(target.entrypoint);
    if (await findModel(contents, target.entrypoint)) {
      return { path, entrypoint: target.entrypoint };
    }
  } else {
    path = contents.normalize(target.directory);
    const root = await findProjectRoot(contents, path);
    if (root) return root;
  }
  await app.commands.execute(CommandIDs.createProject, { path });
  return undefined;
}

/** The first key binding of a command, formatted for a hint such as "Ctrl K". */
export function shortcutLabel(
  commands: CommandRegistry,
  command: string
): string | undefined {
  const binding = commands.keyBindings.find(item => item.command === command);
  if (!binding) {
    return undefined;
  }
  return binding.keys
    .map(keystroke => CommandRegistry.formatKeystroke(keystroke))
    .join(', ');
}

/** The folder name Create proposes, numbered when it is taken. */
const NEW_PROJECT_NAME = 'my-project';

/**
 * The folder Create proposes from `cwd`: a `my-project` folder that does not
 * exist yet (`my-project-2`, `my-project-3`, … when it does), so the default
 * never opens a project that is already there. Inside a project it goes
 * beside that project, since setup refuses a folder inside another project.
 * When the lookup fails it falls back to `cwd/my-project`.
 */
export async function newProjectFolder(
  contents: Contents.IManager,
  cwd: string
): Promise<string> {
  const fallback = contents.resolvePath(cwd, NEW_PROJECT_NAME);
  try {
    const owner = await findProjectRoot(contents, cwd);
    const parent = owner ? projectDirectory(owner.path) : cwd;
    for (let number = 1; number <= 100; number++) {
      const candidate = contents.resolvePath(
        parent,
        number === 1 ? NEW_PROJECT_NAME : `${NEW_PROJECT_NAME}-${number}`
      );
      if (!(await findModel(contents, candidate))) return candidate;
    }
  } catch (error) {
    console.warn('Could not choose a free folder for a new project.', error);
  }
  return fallback;
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

  const browserPath = () => browser?.tracker.currentWidget?.model.path ?? '';
  const cwdOf = (args: ReadonlyPartialJSONObject) =>
    typeof args.cwd === 'string' ? args.cwd : browserPath();

  const projectTarget = (args: ReadonlyPartialJSONObject): ProjectTarget => {
    if (typeof args.path === 'string') {
      return { entrypoint: contents.normalize(args.path) };
    }
    if (typeof args.cwd === 'string') {
      return { directory: args.cwd };
    }
    const current = app.shell.currentWidget;
    if (current instanceof InventoryDocument) {
      return { entrypoint: current.context.path };
    }
    const context = current ? documents.contextForWidget(current) : undefined;
    if (context) {
      return { directory: projectDirectory(context.path) };
    }
    const selected = [
      ...(browser?.tracker.currentWidget?.selectedItems() ?? [])
    ].filter(item => item.name === 'astra.yaml');
    return selected.length === 1
      ? { entrypoint: selected[0].path }
      : { directory: browserPath() };
  };

  const openFolder = async (path: string): Promise<unknown> => {
    const drive = contents.driveName(path);
    const fileBrowser = browser?.tracker.find(
      widget => contents.driveName(widget.model.path) === drive
    );
    if (browser && !fileBrowser)
      throw new Error('No file browser is available for this drive.');
    await fileBrowser?.model.cd(`/${contents.localPath(path)}`);
    // Home tabs follow the file browser, so one may already show the project:
    // Open Home brings it forward instead of stacking a second tab.
    if (app.commands.hasCommand(HomeCommandIDs.openHome)) {
      return app.commands.execute(HomeCommandIDs.openHome, { cwd: path });
    }
    return app.commands.execute(HomeCommandIDs.create, {
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
          cwdOf(args),
          options.translator
        );
        if (path === undefined) return;
        const root = await requireProject(app, { directory: path });
        if (root) return await openFolder(root.path);
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
      translator: options.translator,
      browse: () =>
        browseProjectFolder(documents, browserPath(), options.translator),
      findProject: folder => findProjectRoot(contents, folder),
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
    execute: async args =>
      showSetup(
        typeof args.path === 'string'
          ? args.path
          : await newProjectFolder(contents, cwdOf(args)),
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
        const directory = cwdOf(args);
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
          openReference: {
            type: 'object',
            description: 'ASTRA record or paper reference'
          }
        }
      }
    },
    execute: async args => {
      try {
        // Resolve first: a document context would create the missing file.
        const root = await requireProject(app, projectTarget(args));
        if (!root) return undefined;
        const widget = documents.openOrReveal(
          root.entrypoint,
          INVENTORY_FACTORY
        );
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
