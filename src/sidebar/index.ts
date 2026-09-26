import {
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, IThemeManager } from '@jupyterlab/apputils';
import { IStateDB } from '@jupyterlab/statedb';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { projectFolders } from '../api';
import { ICommentService } from '../comments/comment-service';
import { ICurrentProject } from '../current-project';
import { ISessionService } from '../sessions/session-service';
import { PALETTE_CATEGORY } from '../workbench-ids';
import { SidebarCommandIDs } from './sidebar-commands';
import { SidebarModel } from './sidebar-model';
import { RecentProjects } from './project-switcher';
import { LightconeSidebar } from './sidebar-panel';

export { SidebarCommandIDs, WorkbenchCommandIDs } from './sidebar-commands';
export { SidebarModel, type ISidebarState } from './sidebar-model';
export { LightconeSidebar } from './sidebar-panel';
export {
  ProjectSwitcher,
  RecentProjects,
  rememberProject
} from './project-switcher';

/**
 * The Lightcone sidebar: the navigation spine of the workbench. It shows the
 * current project, starts sessions and search, lists sessions, results and
 * analyses, and links to the files, the report and the runs.
 */
export const sidebarPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:sidebar',
  description:
    'Navigate the current Lightcone project: sessions, results, analysis and links.',
  autoStart: true,
  requires: [ICurrentProject, IThemeManager],
  optional: [
    ISessionService,
    ILayoutRestorer,
    ITranslator,
    ICommentService,
    ICommandPalette,
    IStateDB
  ],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    themes: IThemeManager,
    sessions: ISessionService | null,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    comments: ICommentService | null,
    palette: ICommandPalette | null,
    state: IStateDB | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const model = new SidebarModel({
      contents: app.serviceManager.contents,
      shell: app.shell,
      current,
      sessions,
      comments
    });
    const recent = new RecentProjects(state);
    const remember = () => {
      if (current.project) {
        void recent.record(current.project);
      }
    };
    current.changed.connect(remember);
    remember();
    const panel = new LightconeSidebar({
      commands: app.commands,
      model,
      themes,
      translator,
      projects: {
        recent,
        siblings: folder =>
          projectFolders(app.serviceManager.serverSettings, folder)
      }
    });
    app.shell.add(panel, 'left', { rank: 250, type: 'Lightcone' });
    restorer?.add(panel, 'lightcone-sidebar');
    app.commands.addCommand(SidebarCommandIDs.showSidebar, {
      label: trans.__('Show Lightcone Sidebar'),
      caption: trans.__('Reveal the Lightcone project sidebar'),
      describedBy: { args: { type: 'object', properties: {} } },
      execute: () => {
        app.shell.activateById(panel.id);
      }
    });
    palette?.addItem({
      command: SidebarCommandIDs.showSidebar,
      category: PALETTE_CATEGORY
    });
    app.shell.disposed.connect(() => {
      current.changed.disconnect(remember);
      panel.dispose();
      model.dispose();
    });
  }
};
