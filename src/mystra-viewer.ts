import { IFrame } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import { PanelLayout, Widget } from '@lumino/widgets';
import {
  IMySTRASession,
  RequestError,
  readMySTRA,
  startMySTRA,
  stopMySTRA
} from './api';
import { mystIcon } from './icons';

/** The selected ASTRA theme, isolated from the workbench's CSS and React tree. */
export class MySTRAViewer extends Widget {
  constructor(
    session: IMySTRASession,
    private settings: ServerConnection.ISettings,
    translator: ITranslator = nullTranslator
  ) {
    super();
    const trans = (this.trans = translator.load('jupyterlab_lightcone'));
    this.session = session;
    this.id = `lightcone-mystra-${session.id}`;
    this.title.label = `MySTRA — ${session.path.split('/').slice(-2, -1)[0] || 'Project'}`;
    this.title.caption = session.path;
    this.title.icon = mystIcon;
    this.title.closable = true;
    this.addClass('jp-jupyterlab-lightcone-MySTRA');
    const layout = new PanelLayout();
    this.layout = layout;
    const controls = this.controls;
    controls.addClass('jp-jupyterlab-lightcone-MySTRAControls');
    this.status.setAttribute('role', 'status');
    this.restart.textContent = trans.__('Restart');
    this.restart.onclick = () => {
      void this.restartSession();
    };
    controls.node.append(this.status, this.restart);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = trans.__('MySTRA build log');
    details.append(summary, this.logs);
    controls.node.append(details);
    this.frame = new IFrame({
      sandbox: [
        'allow-scripts',
        'allow-same-origin',
        'allow-downloads',
        'allow-popups'
      ]
    });
    this.frame.node.setAttribute('aria-label', trans.__('MySTRA viewer'));
    layout.addWidget(controls);
    layout.addWidget(this.frame);
    this.adopt(session);
    this.schedule();
  }

  /** Canonical contents path used when reopening or restarting the project. */
  get path(): string {
    return this.session.path;
  }

  /** Closing a tab releases its heartbeat; other browsers retain their leases. */
  dispose(): void {
    if (this.isDisposed) return;
    clearTimeout(this.timer);
    this.restart.onclick = null;
    super.dispose();
  }

  /**
   * Adopt a session for this project, for example one freshly started after
   * the previous one expired, and resume polling it.
   */
  adopt(session: IMySTRASession): void {
    const replaced = session.id !== this.session.id;
    // Polls still in flight for the previous session must not overwrite this one.
    if (replaced) this.generation++;
    this.session = session;
    this.expired = false;
    this.status.textContent = session.message;
    this.logs.textContent = session.logs.join('\n');
    if (session.state === 'ready') this.controls.hide();
    else this.controls.show();
    if (session.state === 'ready' && this.frame.url !== session.url) {
      this.frame.url = session.url;
    }
    if (replaced) this.schedule();
  }

  /** Restart the project from an error panel or a native JupyterLab command. */
  async restartSession(): Promise<void> {
    if (this.isDisposed || this.restart.disabled) return;
    this.status.textContent = this.trans.__('Restarting MySTRA…');
    this.controls.show();
    this.generation++;
    this.restart.disabled = true;
    clearTimeout(this.timer);
    try {
      // Stopping is idempotent on the server, so an expired session is fine.
      await stopMySTRA(this.settings, this.session.id);
      const session = await startMySTRA(this.settings, this.path);
      if (!this.isDisposed) this.adopt(session);
    } catch (error) {
      if (!this.isDisposed) this.status.textContent = String(error);
    } finally {
      this.restart.disabled = false;
      this.schedule();
    }
  }

  /** Arm the next heartbeat: fast while starting, slow once ready, never once expired. */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.isDisposed || this.restart.disabled || this.expired) return;
    this.timer = setTimeout(
      () => {
        void this.poll();
      },
      this.session.state === 'starting' ? 1000 : 15000
    );
  }

  /** Refresh status and renew the lease; a vanished session stops the heartbeat. */
  private async poll(): Promise<void> {
    const generation = this.generation;
    try {
      const session = await readMySTRA(this.settings, this.session.id);
      if (!this.isDisposed && generation === this.generation)
        this.adopt(session);
    } catch (error) {
      if (this.isDisposed || generation !== this.generation) return;
      this.controls.show();
      if (error instanceof RequestError && error.status === 404) {
        this.expired = true;
        this.status.textContent = this.trans.__(
          'This MySTRA session has expired. Restart the viewer to continue.'
        );
      } else {
        this.status.textContent = String(error);
      }
    } finally {
      this.schedule();
    }
  }

  private trans: ReturnType<ITranslator['load']>;
  private controls = new Widget();
  private generation = 0;
  private expired = false;
  private session: IMySTRASession;
  private frame: IFrame;
  private status = document.createElement('span');
  private logs = document.createElement('pre');
  private restart = document.createElement('button');
  private timer: ReturnType<typeof setTimeout> | undefined;
}
