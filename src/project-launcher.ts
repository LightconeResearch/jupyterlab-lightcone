import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { ILauncher } from '@jupyterlab/launcher';
import type { ICurrentProject } from './current-project';

/** The launcher cards one plugin offers, in order; unregistered commands are skipped. */
export interface IProjectLauncherCommands {
  /** Offered inside an ASTRA project, in its launcher category. */
  project: readonly string[];
  /** Offered outside any project. */
  outside?: readonly string[];
  /** Rank of the first card; cards of one call keep their order. */
  rank?: number;
}

/** Keep a plugin's launcher actions aligned with the current project. */
export function configureProjectLauncher(
  app: JupyterFrontEnd,
  launcher: ILauncher,
  current: ICurrentProject,
  options: IProjectLauncherCommands
): void {
  let entries: { dispose(): void }[] = [];
  let previous = '';
  let disposed = false;
  const clear = () => {
    entries.forEach(entry => entry.dispose());
    entries = [];
    previous = '';
  };
  // Registry changes only redraw the current project; they never query Contents.
  const render = () => {
    if (disposed) return;
    const project = current.project;
    // Unknown until a lookup settles; a failed lookup offers no actions either.
    if (project === undefined) {
      clear();
      return;
    }
    const commands = project ? options.project : (options.outside ?? []);
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
        rank: (options.rank ?? 0) + rank
      })
    );
  };
  current.changed.connect(render);
  app.commands.commandChanged.connect(render);
  app.shell.disposed.connect(() => {
    disposed = true;
    current.changed.disconnect(render);
    app.commands.commandChanged.disconnect(render);
    entries.forEach(entry => entry.dispose());
  });
  render();
}
