import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { PathExt } from '@jupyterlab/coreutils';
import { IStatusBar } from '@jupyterlab/statusbar';
import {
  ITranslator,
  nullTranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { Widget } from '@lumino/widgets';
import { CommandIDs } from './commands';
import { ICurrentProject } from './current-project';

/** Name the current project, which new chats and their agents use. */
export class ProjectStatus extends Widget {
  constructor(
    current: ICurrentProject,
    open: (entrypoint: string) => void,
    trans: TranslationBundle
  ) {
    super();
    this._current = current;
    this._trans = trans;
    this.addClass('jp-jupyterlab-lightcone-ProjectStatus');
    this.addClass('jp-mod-highlighted');
    this.node.setAttribute('role', 'button');
    this.node.tabIndex = 0;
    const logo = document.createElement('span');
    logo.className = 'jp-jupyterlab-lightcone-ProjectStatus-logo';
    logo.setAttribute('aria-hidden', 'true');
    this._label.className = 'jp-StatusBar-TextItem';
    this.node.append(logo, this._label);
    const activate = () => {
      const project = this._current.project;
      if (project) open(project.entrypoint);
    };
    this.node.addEventListener('click', activate);
    this.node.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate();
    });
    current.changed.connect(this._update, this);
    this._update();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._current.changed.disconnect(this._update, this);
    super.dispose();
  }

  private _update(): void {
    const project = this._current.project;
    if (!project) return;
    const path = project.path || '/';
    this._label.textContent = this._trans.__(
      'Lightcone · %1',
      project.path ? PathExt.basename(project.path) : path
    );
    this.node.title = this._trans.__(
      'Current ASTRA project: %1\nNew chats and their agents use this project. Click to open its inventory.',
      path
    );
  }

  private _current: ICurrentProject;
  private _trans: TranslationBundle;
  private _label = document.createElement('span');
}

/** Keep the current project in view while it decides where new agents work. */
export const projectStatusPlugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab_lightcone:project-status',
  description: 'Show the current ASTRA project in the status bar.',
  autoStart: true,
  requires: [ICurrentProject],
  optional: [IStatusBar, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    current: ICurrentProject,
    statusBar: IStatusBar | null,
    translator: ITranslator | null
  ) => {
    // A front end without a status bar simply shows nothing.
    if (!statusBar) return;
    const trans = (translator ?? nullTranslator).load('jupyterlab_lightcone');
    const item = new ProjectStatus(
      current,
      entrypoint => {
        void app.commands.execute(CommandIDs.openInventory, {
          path: entrypoint
        });
      },
      trans
    );
    statusBar.registerStatusItem('jupyterlab_lightcone:project-status', {
      item,
      align: 'left',
      rank: 0,
      isActive: () => !!current.project,
      activeStateChanged: current.changed
    });
  }
};
