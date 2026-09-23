import {
  ILayoutRestorer,
  type JupyterFrontEnd,
  type JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, IThemeManager } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { ICommentService } from '../comments/comment-service';
import { ICurrentProject } from '../current-project';
import { ISessionService } from '../sessions/session-service';
import { SidebarCommandIDs } from './sidebar-commands';
import { SidebarModel } from './sidebar-model';
import { LightconeSidebar } from './sidebar-panel';

export { SidebarCommandIDs, WorkbenchCommandIDs } from './sidebar-commands';
export { lightconeIcon } from './icons';
export { SidebarModel, type ISidebarState } from './sidebar-model';
export { LightconeSidebar } from './sidebar-panel';

const CATEGORY = 'Lightcone Lab';

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
    ICommandPalette
  ],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    themes: IThemeManager,
    sessions: ISessionService | null,
    restorer: ILayoutRestorer | null,
    translator: ITranslator | null,
    comments: ICommentService | null,
    palette: ICommandPalette | null
  ): void => {
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const model = new SidebarModel({
      contents: app.serviceManager.contents,
      shell: app.shell,
      current,
      sessions,
      comments
    });
    const panel = new LightconeSidebar({
      commands: app.commands,
      model,
      themes,
      translator
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
      category: CATEGORY
    });
    app.shell.disposed.connect(() => {
      panel.dispose();
      model.dispose();
    });
  }
};
