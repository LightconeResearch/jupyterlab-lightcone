import { JupyterFrontEnd } from '@jupyterlab/application';
import {
  InputDialog,
  MainAreaWidget,
  showErrorMessage
} from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { Contents } from '@jupyterlab/services';
import { type IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { refreshIcon } from '@jupyterlab/ui-components';
import { astraIcon, createProjectIcon, openProjectIcon } from './icons';
import { INVENTORY_FACTORY, InventoryDocument } from './document-widget';
import { parseInventoryOpenReference } from './open-reference';
import { projectDirectory, type ILoadedProjectData } from './project-data';
import { acquireProjectDataService } from './project-data-service';
import { renameProject, updateProjectDescription } from './project-metadata';
import { editDescription } from './project-description';
import { browseProjectFolder } from './project-browser';
import { findModel, findProjectRoot, type IProjectRoot } from './project-root';
import { ProjectSetup } from './project-setup';
import { HomeCommandIDs } from './home/home-commands';

export namespace CommandIDs {
  /** Create a session in the current project and open it in the main area. */
  export const newSession = 'jupyterlab_lightcone:new-session';
  /** Open, or activate, the session stored at a chat path. */
  export const openSession = 'jupyterlab_lightcone:open-session';
  export const openExistingProject =
    'jupyterlab_lightcone:open-existing-project';
  export const finishProjectSetup = 'jupyterlab_lightcone:finish-project-setup';
  export const createProject = 'jupyterlab_lightcone:create-project';
  export const renameProject = 'jupyterlab_lightcone:rename-project';
  export const editProjectDescription =
    'jupyterlab_lightcone:edit-project-description';
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

  /** The `path` or `cwd` a project command reads through `projectTarget`. */
  const projectTargetArgs = {
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
        }
      }
    }
  };

  /**
   * Ask for a new value of one project metadata field, starting from the
   * project's current data, then save it (`renameProject` or
   * `updateProjectDescription`) and refresh that data.
   */
  const editProjectMetadata = async (
    args: ReadonlyPartialJSONObject,
    failure: string,
    ask: (data: ILoadedProjectData) => Promise<string | null>,
    save: typeof renameProject
  ): Promise<void> => {
    try {
      const root = await requireProject(app, projectTarget(args));
      if (!root) return;
      const lease = acquireProjectDataService(contents, root.entrypoint);
      try {
        const value = await ask(await lease.service.get());
        if (value === null) return;
        await save(contents, documents, root.entrypoint, value);
        await lease.service.refresh();
      } finally {
        lease.release();
      }
    } catch (error) {
      await showErrorMessage(
        failure,
        error instanceof Error ? error : String(error)
      );
    }
  };

  app.commands.addCommand(CommandIDs.renameProject, {
    label: trans.__('Rename project'),
    describedBy: projectTargetArgs,
    execute: args =>
      editProjectMetadata(
        args,
        trans.__('Could not rename project'),
        async data => {
          const result = await InputDialog.getText({
            title: trans.__('Rename project'),
            label: trans.__('Project name'),
            text: data.document.analysis.name ?? '',
            required: true,
            okLabel: trans.__('Rename')
          });
          return result.button.accept ? result.value : null;
        },
        renameProject
      )
  });

  app.commands.addCommand(CommandIDs.editProjectDescription, {
    label: trans.__('Edit description'),
    describedBy: projectTargetArgs,
    execute: args =>
      editProjectMetadata(
        args,
        trans.__('Could not save description'),
        data =>
          editDescription(data.document.analysis.description ?? '', trans),
        updateProjectDescription
      )
  });

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
