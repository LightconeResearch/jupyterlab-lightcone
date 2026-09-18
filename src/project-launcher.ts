import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { FileBrowser, IFileBrowserFactory } from '@jupyterlab/filebrowser';
import type { ILauncher } from '@jupyterlab/launcher';
import { findProjectRoot, type IProjectRoot } from './project-root';
import { CommandIDs } from './commands';

/** Keep launcher actions aligned with its file browser's current directory. */
export function configureProjectLauncher(
  app: JupyterFrontEnd,
  launcher: ILauncher,
  factory: IFileBrowserFactory
): void {
  let browser: FileBrowser | null = null;
  let entries: { dispose(): void }[] = [];
  let previous = '';
  let generation = 0;
  let disposed = false;
  let scheduled = false;
  let lastDirectory: string | undefined;
  // undefined until a lookup settles; null when the folder is outside a project.
  let project: IProjectRoot | null | undefined;
  const clear = () => {
    entries.forEach(entry => entry.dispose());
    entries = [];
    previous = '';
    project = undefined;
  };
  // Registry changes only redraw the cached context; they never query Contents.
  const render = () => {
    if (project === undefined || disposed) return;
    const commands = project
      ? [CommandIDs.discuss, CommandIDs.openInventory, CommandIDs.openMySTRA]
      : [CommandIDs.createProject, CommandIDs.openExistingProject];
    const available = commands.filter(command =>
      app.commands.hasCommand(command)
    );
    const key = `${project?.path ?? 'none'}|${available.join('|')}`;
    if (key === previous) return;
    previous = key;
    entries.forEach(entry => entry.dispose());
    entries = available.map((command, rank) =>
      launcher.add({
        command,
        category: project
          ? `Lightcone Lab · ${project.path || '/'}`
          : 'Lightcone Lab',
        // Native launchers inject their own cwd; never pin a shared card to a root.
        args: {},
        categoryRank: -10,
        rank
      })
    );
  };
  const refresh = async () => {
    const request = ++generation;
    const directory = browser?.model.path ?? '';
    if (directory !== lastDirectory) {
      clear();
      lastDirectory = directory;
    }
    try {
      const result = await findProjectRoot(
        app.serviceManager.contents,
        directory
      );
      if (disposed || request !== generation) return;
      project = result ?? null;
      render();
    } catch (error) {
      if (disposed || request !== generation) return;
      console.warn('Could not determine the current Lightcone project.', error);
      clear();
    }
  };
  // One navigation emits `refreshed` several times in a tick; look up once.
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) void refresh();
    });
  };
  // Every path change is followed by `refreshed`, which also covers polling.
  const bind = () => {
    browser?.model.refreshed.disconnect(schedule);
    browser = factory.tracker.currentWidget;
    browser?.model.refreshed.connect(schedule);
    schedule();
  };
  factory.tracker.currentChanged.connect(bind);
  app.commands.commandChanged.connect(render);
  app.shell.disposed.connect(() => {
    disposed = true;
    factory.tracker.currentChanged.disconnect(bind);
    app.commands.commandChanged.disconnect(render);
    browser?.model.refreshed.disconnect(schedule);
    entries.forEach(entry => entry.dispose());
  });
  bind();
}
