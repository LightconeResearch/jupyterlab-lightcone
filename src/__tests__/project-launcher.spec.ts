import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { IFileBrowserFactory } from '@jupyterlab/filebrowser';
import type { ILauncher } from '@jupyterlab/launcher';
import { ContentsManager, ServerConnection } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from '../commands';
import { CurrentProject } from '../current-project';
import { configureProjectLauncher } from '../project-launcher';
import { fileModel } from './project-fixtures';

jest.mock('../pdf-runtime', () => ({}));
const VIEWER = 'test:project-viewer';
const VIEWER_OPTIONS = 'test:project-viewer-options';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function host() {
  const commands = new CommandRegistry();
  for (const command of [
    CommandIDs.createProject,
    CommandIDs.openExistingProject,
    CommandIDs.openInventory,
    VIEWER,
    VIEWER_OPTIONS
  ]) {
    commands.addCommand(command, { execute: () => undefined });
  }
  const contents = new ContentsManager();
  const specs = new Set(['project/astra.yaml']);
  const get = jest.spyOn(contents, 'get').mockImplementation(async path => {
    if (!specs.has(path))
      throw new ServerConnection.ResponseError(
        new Response('', { status: 404 })
      );
    return fileModel('', { path });
  });
  const model = {
    path: 'project',
    // Simulate a sidebar filter that excludes the spec entirely.
    items: () => [{ name: 'index.md', type: 'file' }].values(),
    refreshed: new Signal<object, void>({})
  };
  const tracker = {
    currentWidget: { model },
    currentChanged: new Signal<object, void>({})
  };
  const shell = new Widget();
  const current = new CurrentProject(
    contents,
    tracker as unknown as IFileBrowserFactory['tracker']
  );
  const visible = new Map<string, ILauncher.IItemOptions>();
  const launcher = {
    add: (item: ILauncher.IItemOptions) => {
      visible.set(item.command, item);
      return { dispose: () => visible.delete(item.command) };
    }
  };
  const app = {
    commands,
    shell,
    serviceManager: { contents }
  } as unknown as JupyterFrontEnd;
  configureProjectLauncher(app, launcher as unknown as ILauncher, current, {
    project: [CommandIDs.discuss, CommandIDs.openInventory],
    outside: [CommandIDs.createProject, CommandIDs.openExistingProject]
  });
  // A second plugin contributing project cards after the core ones.
  configureProjectLauncher(app, launcher as unknown as ILauncher, current, {
    project: [VIEWER, VIEWER_OPTIONS],
    rank: 100
  });
  // The launcher's own order: by rank, unranked items last.
  const shown = () =>
    [...visible.values()]
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
      .map(item => item.command);
  return {
    commands,
    model,
    visible,
    shown,
    specs,
    get,
    dispose: () => {
      shell.dispose();
      current.dispose();
      contents.dispose();
    }
  };
}

it('ignores filters, retains project root in subfolders, and updates late chat registration', async () => {
  const h = host();
  try {
    await flush();
    expect(h.shown()).toEqual([
      CommandIDs.openInventory,
      VIEWER,
      VIEWER_OPTIONS
    ]);
    h.model.path = 'project/data';
    h.model.refreshed.emit();
    await flush();
    expect(h.visible.get(CommandIDs.openInventory)?.args).toEqual({});
    expect(h.visible.get(VIEWER)?.args).toEqual({});
    expect(h.visible.get(CommandIDs.openInventory)?.category).toBe(
      'Lightcone Lab · project'
    );
    h.get.mockClear();
    h.commands.notifyCommandChanged();
    h.commands.addCommand(CommandIDs.discuss, { execute: () => undefined });
    await flush();
    expect(h.visible.get(CommandIDs.discuss)?.args).toEqual({});
    expect(h.shown()).toEqual([
      CommandIDs.discuss,
      CommandIDs.openInventory,
      VIEWER,
      VIEWER_OPTIONS
    ]);
    expect(h.get).not.toHaveBeenCalled();
    h.specs.clear();
    h.model.refreshed.emit();
    await flush();
    expect(h.shown()).toEqual([
      CommandIDs.createProject,
      CommandIDs.openExistingProject
    ]);
  } finally {
    h.dispose();
  }
  expect(h.visible.size).toBe(0);
});

it('ignores outdated project lookups after navigation', async () => {
  const h = host();
  try {
    await flush();
    const pending = new PromiseDelegate<ReturnType<typeof fileModel>>();
    h.get.mockImplementationOnce(() => pending.promise);
    h.model.refreshed.emit();
    // Let the first lookup start before navigating away from it.
    await Promise.resolve();
    h.model.path = 'elsewhere';
    h.model.refreshed.emit();
    await flush();
    pending.resolve(fileModel('', { path: 'project/astra.yaml' }));
    await flush();
    expect(h.shown()).toEqual([
      CommandIDs.createProject,
      CommandIDs.openExistingProject
    ]);
  } finally {
    h.dispose();
  }
});
