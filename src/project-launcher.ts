import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { ILauncher } from '@jupyterlab/launcher';
import { CommandIDs } from './commands';
import type { ICurrentProject } from './current-project';
import { HomeCommandIDs } from './home/home-commands';
import { launcherCategory } from './home/home-model';

/**
 * Keep launcher cards aligned with the current project.
 *
 * Outside a project the stock launcher shows one **New Lightcone project**
 * card; opening an existing project stays in the command palette. Inside a
 * project the launcher tab shows Home instead of cards, so the three project
 * cards are only visible when a tab shows the full launcher.
 */
export function configureProjectLauncher(
  app: JupyterFrontEnd,
  launcher: ILauncher,
  current: ICurrentProject
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
    const commands = project
      ? [CommandIDs.discuss, CommandIDs.openInventory, CommandIDs.openMySTRA]
      : app.commands.hasCommand(HomeCommandIDs.newProject)
        ? [HomeCommandIDs.newProject]
        : [CommandIDs.createProject];
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
        category: launcherCategory(project ? project.path : null),
        // Native launchers inject their own cwd; never pin a shared card to a root.
        args: {},
        categoryRank: -10,
        rank
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
