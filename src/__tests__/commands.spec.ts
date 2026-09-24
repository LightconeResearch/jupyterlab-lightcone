import type { JupyterFrontEnd } from '@jupyterlab/application';
import { showErrorMessage, type IThemeManager } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import type { DocumentRegistry } from '@jupyterlab/docregistry';
import type { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { ContentsManager, Drive, ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { browseProjectFolder } from '../project-browser';
import { inspectProjectFolder } from '../api';
import { ProjectSetup } from '../project-setup';
import {
  CommandIDs,
  newProjectFolder,
  registerCommands,
  requireProject
} from '../commands';
import { InventoryDocument } from '../document-widget';
import { HomeCommandIDs } from '../home/home-commands';
import { fileModel } from './project-fixtures';

jest.mock('../project-browser', () => ({ browseProjectFolder: jest.fn() }));
jest.mock('../api', () => ({
  ...jest.requireActual('../api'),
  inspectProjectFolder: jest.fn()
}));
jest.mock('@jupyterlab/apputils', () => ({
  ...jest.requireActual('@jupyterlab/apputils'),
  showErrorMessage: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../open-reference', () => ({
  parseInventoryOpenReference: jest.fn().mockReturnValue(undefined)
}));
jest.mock('../document-widget', () => {
  const { Widget } =
    jest.requireActual<typeof import('@lumino/widgets')>('@lumino/widgets');
  return {
    INVENTORY_FACTORY: 'Lightcone Lab',
    InventoryDocument: class extends Widget {
      constructor(readonly context: { path: string; ready: Promise<void> }) {
        super();
      }
      content = {
        display: jest.fn().mockResolvedValue(undefined),
        refresh: jest.fn().mockResolvedValue(undefined)
      };
    }
  };
});
/** Only the command's host boundaries are mocked; Lumino commands and paths are real. */
function commandHost(browser: IFileBrowserFactory | null = null) {
  const contents = new ContentsManager();
  contents.addDrive(new Drive({ name: 'archive' }));
  const get = jest
    .spyOn(contents, 'get')
    .mockResolvedValue(fileModel('project'));
  const commands = new CommandRegistry();
  const shell = {
    currentWidget: null as Widget | null,
    activateById: jest.fn(),
    add: jest.fn()
  };
  const created: InventoryDocument[] = [];
  const themes = {} as IThemeManager;
  const openOrReveal = jest.fn((path: string) => {
    const widget = new InventoryDocument(
      { path, ready: Promise.resolve() } as DocumentRegistry.Context,
      contents,
      themes,
      commands
    );
    created.push(widget);
    return widget;
  });
  const contextForWidget = jest.fn();
  const documents = {
    openOrReveal,
    contextForWidget
  } as unknown as IDocumentManager;
  registerCommands({
    app: {
      commands,
      shell,
      serviceManager: { contents }
    } as unknown as JupyterFrontEnd,
    documents,
    browser
  });
  return {
    commands,
    contents,
    get,
    shell,
    openOrReveal,
    contextForWidget,
    themes,
    dispose: () => {
      created.forEach(widget => widget.dispose());
      contents.dispose();
    }
  };
}

describe('project opening commands', () => {
  it('opens an existing project on its Contents drive without local initialization', async () => {
    const cd = jest.fn().mockResolvedValue(undefined);
    const remote = { model: { path: 'archive:elsewhere', cd } };
    const browser = {
      tracker: { currentWidget: remote, find: () => remote }
    } as unknown as IFileBrowserFactory;
    const host = commandHost(browser);
    const launcher = new Widget();
    const createLauncher = jest.fn().mockReturnValue(launcher);
    host.commands.addCommand('launcher:create', { execute: createLauncher });
    jest.mocked(browseProjectFolder).mockResolvedValue('archive:project');
    jest.mocked(inspectProjectFolder).mockClear();
    try {
      expect(await host.commands.execute(CommandIDs.openExistingProject)).toBe(
        launcher
      );
      expect(cd).toHaveBeenCalledWith('/project');
      expect(createLauncher).toHaveBeenCalledWith({
        cwd: 'archive:project',
        activate: true
      });
      expect(inspectProjectFolder).not.toHaveBeenCalled();
      expect(host.openOrReveal).not.toHaveBeenCalled();
    } finally {
      launcher.dispose();
      host.dispose();
    }
  });

  it('brings the project’s Home forward rather than stacking a launcher', async () => {
    const cd = jest.fn().mockResolvedValue(undefined);
    const local = { model: { path: '', cd } };
    const host = commandHost({
      tracker: { currentWidget: local, find: () => local }
    } as unknown as IFileBrowserFactory);
    const home = new Widget();
    const openHome = jest.fn().mockReturnValue(home);
    const createLauncher = jest.fn();
    host.commands.addCommand(HomeCommandIDs.openHome, { execute: openHome });
    host.commands.addCommand('launcher:create', { execute: createLauncher });
    jest.mocked(browseProjectFolder).mockResolvedValue('project');
    try {
      expect(await host.commands.execute(CommandIDs.openExistingProject)).toBe(
        home
      );
      expect(cd).toHaveBeenCalledWith('/project');
      expect(openHome).toHaveBeenCalledWith({ cwd: 'project' });
      expect(createLauncher).not.toHaveBeenCalled();
    } finally {
      home.dispose();
      host.dispose();
    }
  });

  it('shows errors from finish setup and asynchronous folder navigation', async () => {
    const error = new Error('Access denied');
    const remote = {
      model: { path: 'project', cd: jest.fn().mockRejectedValue(error) }
    };
    const host = commandHost({
      tracker: { currentWidget: remote, find: () => remote }
    } as unknown as IFileBrowserFactory);
    try {
      host.get.mockRejectedValueOnce(error);
      await host.commands.execute(CommandIDs.finishProjectSetup);
      expect(showErrorMessage).toHaveBeenLastCalledWith(
        'Could not finish project setup',
        error
      );
      jest.mocked(browseProjectFolder).mockResolvedValue('project');
      await host.commands.execute(CommandIDs.openExistingProject);
      expect(showErrorMessage).toHaveBeenLastCalledWith(
        'Could not open project',
        error
      );
    } finally {
      host.dispose();
    }
  });

  it('opens a fresh setup for the folder chosen after another setup form was edited', async () => {
    const host = commandHost();
    const first = await host.commands.execute(CommandIDs.createProject, {
      path: 'A'
    });
    jest.mocked(browseProjectFolder).mockResolvedValue('B');
    jest
      .mocked(inspectProjectFolder)
      .mockResolvedValue({ path: 'B', directory: '/server/B', hasSpec: false });
    host.get.mockRejectedValue(
      new ServerConnection.ResponseError(new Response('', { status: 404 }))
    );
    try {
      await host.commands.execute(CommandIDs.openExistingProject);
      const second = host.shell.add.mock.calls[1][0];
      expect(second).not.toBe(first);
      expect((second.content as ProjectSetup).render().props.path).toBe('B');
      expect((first.content as ProjectSetup).render().props.path).toBe('A');
      expect(host.openOrReveal).not.toHaveBeenCalled();
    } finally {
      host.shell.add.mock.calls.forEach(([widget]) => widget.dispose());
      host.dispose();
    }
  });

  it('opens the enclosing inventory from a project subfolder', async () => {
    const host = commandHost();
    host.get.mockImplementation(async path => {
      if (path !== 'project/astra.yaml')
        throw new ServerConnection.ResponseError(
          new Response('', { status: 404 })
        );
      return fileModel('project');
    });
    try {
      await host.commands.execute(CommandIDs.openInventory, {
        cwd: 'project/data/raw'
      });
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'project/astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      host.dispose();
    }
  });

  it('resolves the launcher directory on its registered drive', async () => {
    const host = commandHost();
    try {
      await host.commands.execute(CommandIDs.openInventory, {
        cwd: 'archive:project'
      });
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'archive:project/astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      host.dispose();
    }
  });

  it('uses the active document directory, including a contents drive root', async () => {
    const host = commandHost();
    const editor = new Widget();
    host.shell.currentWidget = editor;
    host.contextForWidget.mockReturnValue({ path: 'archive:notes.md' });
    try {
      await host.commands.execute(CommandIDs.openInventory);
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'archive:astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      editor.dispose();
      host.dispose();
    }
  });

  it('uses the selected ASTRA file when no document supplies a project', async () => {
    const browser = {
      tracker: {
        currentWidget: {
          selectedItems: () => [
            { name: 'astra.yaml', path: 'work/astra.yaml' }
          ],
          model: { path: 'other' }
        }
      }
    } as unknown as IFileBrowserFactory;
    const host = commandHost(browser);
    try {
      await host.commands.execute(CommandIDs.openInventory);
      expect(host.openOrReveal).toHaveBeenCalledWith(
        'work/astra.yaml',
        'Lightcone Lab'
      );
    } finally {
      host.dispose();
    }
  });

  it('displays the current context path when a document is renamed while opening', async () => {
    const host = commandHost();
    const ready = new PromiseDelegate<void>();
    const opened = new PromiseDelegate<void>();
    const context = { path: 'old/astra.yaml', ready: ready.promise };
    const widget = new InventoryDocument(
      context as DocumentRegistry.Context,
      host.contents,
      host.themes,
      host.commands
    );
    host.openOrReveal.mockImplementation(() => {
      opened.resolve();
      return widget;
    });
    try {
      const pending = host.commands.execute(CommandIDs.openInventory, {
        path: context.path
      });
      await opened.promise;
      context.path = 'new/astra.yaml';
      ready.resolve();
      await pending;
      expect(widget.content.display).toHaveBeenCalledWith({}, 'new/astra.yaml');
    } finally {
      ready.resolve();
      widget.dispose();
      host.dispose();
    }
  });

  it('offers project setup without asking the document manager to create missing files', async () => {
    const host = commandHost();
    host.get.mockRejectedValue(
      new ServerConnection.ResponseError(new Response('', { status: 404 }))
    );
    try {
      expect(
        await host.commands.execute(CommandIDs.openInventory, {
          path: 'missing/astra.yaml'
        })
      ).toBeUndefined();
      expect(host.openOrReveal).not.toHaveBeenCalled();
      expect(host.shell.add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.objectContaining({ label: 'Create project' })
        }),
        'main'
      );
      host.shell.add.mock.calls[0][0].dispose();
    } finally {
      host.dispose();
    }
  });

  it('offers setup on the Contents drive where no enclosing project exists', async () => {
    const host = commandHost();
    host.get.mockRejectedValue(
      new ServerConnection.ResponseError(new Response('', { status: 404 }))
    );
    const app = {
      commands: host.commands,
      serviceManager: { contents: host.contents }
    } as unknown as JupyterFrontEnd;
    try {
      expect(
        await requireProject(app, { directory: 'archive:data' })
      ).toBeUndefined();
      expect(host.get.mock.calls.map(([path]) => path)).toEqual([
        'archive:data/astra.yaml',
        'archive:astra.yaml'
      ]);
      const setup = host.shell.add.mock.calls[0][0];
      expect(setup.content.options.path).toBe('archive:data');
      setup.dispose();
    } finally {
      host.dispose();
    }
  });

  it.each([403, 500])(
    'preserves server errors with status %s',
    async status => {
      const host = commandHost();
      const error = new ServerConnection.ResponseError(
        new Response('', { status })
      );
      host.get.mockRejectedValue(error);
      try {
        await host.commands.execute(CommandIDs.openInventory, {
          cwd: 'project'
        });
        expect(host.openOrReveal).not.toHaveBeenCalled();
        expect(showErrorMessage).toHaveBeenLastCalledWith(
          'Could not open the ASTRA inventory',
          error
        );
      } finally {
        host.dispose();
      }
    }
  );
});

describe('newProjectFolder', () => {
  /** Contents holding exactly `paths`; everything else is missing. */
  function contentsWith(paths: string[]): ContentsManager {
    const contents = new ContentsManager();
    jest.spyOn(contents, 'get').mockImplementation(async path => {
      if (!paths.includes(path)) {
        throw new ServerConnection.ResponseError(
          new Response('', { status: 404 })
        );
      }
      return fileModel(path);
    });
    return contents;
  }

  it('proposes my-project, numbered past folders that already exist', async () => {
    const contents = contentsWith(['work/my-project', 'work/my-project-2']);
    try {
      expect(await newProjectFolder(contents, 'work')).toBe(
        'work/my-project-3'
      );
      expect(await newProjectFolder(contents, 'elsewhere')).toBe(
        'elsewhere/my-project'
      );
    } finally {
      contents.dispose();
    }
  });

  it('proposes a folder beside the project the browser is inside', async () => {
    const contents = contentsWith(['work/analysis/astra.yaml']);
    try {
      expect(await newProjectFolder(contents, 'work/analysis/data')).toBe(
        'work/my-project'
      );
    } finally {
      contents.dispose();
    }
  });

  it('falls back to cwd/my-project when the folders cannot be read', async () => {
    const contents = new ContentsManager();
    jest.spyOn(contents, 'get').mockRejectedValue(new Error('offline'));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      expect(await newProjectFolder(contents, 'work')).toBe('work/my-project');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      contents.dispose();
    }
  });
});
