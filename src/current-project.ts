import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IFileBrowserFactory, type FileBrowser } from '@jupyterlab/filebrowser';
import type { Contents } from '@jupyterlab/services';
import { Token } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import { reportCurrentProject } from './api';
import { hasLightconeServer } from './server-features';
import { findProjectRoot, type IProjectRoot } from './project-root';

/**
 * The workbench's current ASTRA project: the one holding the file browser's
 * folder. The launcher and status bar show it, and chats stored outside every
 * project join it when they are first used.
 */
export interface ICurrentProject {
  /**
   * The project; null while the folder is outside every project, and
   * undefined until the first lookup settles or after a lookup failed.
   */
  readonly project: IProjectRoot | null | undefined;
  /** Emitted after `project` changes. */
  readonly changed: ISignal<ICurrentProject, void>;
}

export const ICurrentProject = new Token<ICurrentProject>(
  'jupyterlab_lightcone:ICurrentProject',
  'The ASTRA project holding the file browser folder, which new chats join.'
);

/** Follow the current file browser's folder up to its nearest `astra.yaml`. */
export class CurrentProject implements ICurrentProject, IDisposable {
  constructor(
    contents: Contents.IManager,
    browsers: IFileBrowserFactory['tracker'] | null
  ) {
    this._contents = contents;
    this._browsers = browsers;
    browsers?.currentChanged.connect(this._bind, this);
    this._bind();
  }

  get project(): IProjectRoot | null | undefined {
    return this._project;
  }

  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._browsers?.currentChanged.disconnect(this._bind, this);
    this._browser?.model.refreshed.disconnect(this._schedule, this);
    Signal.clearData(this);
  }

  // Every path change is followed by `refreshed`, which also covers polling,
  // so a project created or removed in the current folder is noticed too.
  private _bind(): void {
    this._browser?.model.refreshed.disconnect(this._schedule, this);
    this._browser = this._browsers?.currentWidget ?? null;
    this._browser?.model.refreshed.connect(this._schedule, this);
    this._schedule();
  }

  // One navigation emits `refreshed` several times in a tick; look up once.
  private _schedule(): void {
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      if (!this._isDisposed) void this._refresh();
    });
  }

  private async _refresh(): Promise<void> {
    if (!this._browser) return;
    const request = ++this._generation;
    let project: IProjectRoot | null | undefined;
    try {
      project =
        (await findProjectRoot(this._contents, this._browser.model.path)) ??
        null;
    } catch (error) {
      console.warn('Could not determine the current Lightcone project.', error);
      project = undefined;
    }
    // A later navigation owns the result; this lookup is outdated.
    if (this._isDisposed || request !== this._generation) return;
    const previous = this._project;
    if (
      project === previous ||
      (project && previous && project.entrypoint === previous.entrypoint)
    ) {
      return;
    }
    this._project = project;
    this._changed.emit();
  }

  private _contents: Contents.IManager;
  private _browsers: IFileBrowserFactory['tracker'] | null;
  private _browser: FileBrowser | null = null;
  private _project: IProjectRoot | null | undefined = undefined;
  private _changed = new Signal<this, void>(this);
  private _generation = 0;
  private _scheduled = false;
  private _isDisposed = false;
}

/**
 * Provide the current project and keep the server informed of it.
 *
 * Jupyter AI starts an agent session as soon as a chat opens, before any
 * message, so the server must already know the project then. A window
 * reports again when it regains focus, so the window used last decides.
 */
export const currentProjectPlugin: JupyterFrontEndPlugin<ICurrentProject> = {
  id: 'jupyterlab_lightcone:current-project',
  description:
    'Track the ASTRA project holding the file browser folder and report it to the server.',
  autoStart: true,
  provides: ICurrentProject,
  optional: [IFileBrowserFactory],
  activate: (
    app: JupyterFrontEnd,
    browsers: IFileBrowserFactory | null
  ): ICurrentProject => {
    const current = new CurrentProject(
      app.serviceManager.contents,
      browsers?.tracker ?? null
    );
    // Only agents read the report, and only the full install has them.
    if (!hasLightconeServer()) {
      app.shell.disposed.connect(() => current.dispose());
      return current;
    }
    // Reports are sent one after another, so the last change also wins on
    // the server. A failed lookup reports null: no project is safer than a
    // stale one.
    let reporting = Promise.resolve();
    const report = () => {
      const entrypoint = current.project?.entrypoint ?? null;
      reporting = reporting.then(() =>
        reportCurrentProject(
          app.serviceManager.serverSettings,
          entrypoint
        ).catch(error => {
          console.warn(
            'Could not report the current Lightcone project.',
            error
          );
        })
      );
    };
    current.changed.connect(report);
    const refocus = () => {
      if (current.project !== undefined) report();
    };
    window.addEventListener('focus', refocus);
    app.shell.disposed.connect(() => {
      window.removeEventListener('focus', refocus);
      current.dispose();
    });
    return current;
  }
};
