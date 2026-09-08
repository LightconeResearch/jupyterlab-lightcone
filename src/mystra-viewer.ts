import { IFrame } from '@jupyterlab/apputils';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator, type ITranslator } from '@jupyterlab/translation';
import { PanelLayout, Widget } from '@lumino/widgets';
import { IMySTRASession, readMySTRA, startMySTRA, stopMySTRA } from './api';
import { astraIcon } from './icons';

/** The selected ASTRA theme, isolated from the workbench's CSS and React tree. */
export class MySTRAViewer extends Widget {
  constructor(
    session: IMySTRASession,
    private settings: ServerConnection.ISettings,
    translator: ITranslator = nullTranslator
  ) {
    super();
    const trans = translator.load('jupyterlab_lightcone');
    this.session = session;
    this.id = `lightcone-mystra-${session.id}`;
    this.title.label = `MySTRA — ${session.path.split('/').slice(-2, -1)[0] || 'Project'}`;
    this.title.caption = session.path;
    this.title.icon = astraIcon;
    this.title.closable = true;
    this.addClass('jp-jupyterlab-lightcone-MySTRA');
    const layout = new PanelLayout();
    this.layout = layout;
    const controls = new Widget();
    controls.addClass('jp-jupyterlab-lightcone-MySTRAControls');
    this.status.setAttribute('role', 'status');
    this.restart.textContent = trans.__('Restart');
    this.restart.onclick = () => {
      this.status.textContent = trans.__('Restarting MySTRA…');
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
    this.display(session);
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

  private display(session: IMySTRASession): void {
    this.session = session;
    this.status.textContent = session.message;
    this.logs.textContent = session.logs.join('\n');
    if (session.state === 'ready' && this.frame.url !== session.url) {
      this.frame.url = session.url;
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.isDisposed || this.restart.disabled) return;
    this.timer = setTimeout(
      () => {
        void this.poll();
      },
      this.session.state === 'starting' ? 1000 : 15000
    );
  }

  private async poll(): Promise<void> {
    const generation = this.generation;
    try {
      const session = await readMySTRA(this.settings, this.session.id);
      if (!this.isDisposed && generation === this.generation)
        this.display(session);
    } catch (error) {
      if (!this.isDisposed && generation === this.generation)
        this.status.textContent = String(error);
    } finally {
      this.schedule();
    }
  }

  private async restartSession(): Promise<void> {
    this.generation++;
    this.restart.disabled = true;
    clearTimeout(this.timer);
    try {
      await stopMySTRA(this.settings, this.session.id).catch(error => {
        // An expired session is already stopped; a new one can be started.
        if (!String(error).includes('(404)')) throw error;
      });
      const session = await startMySTRA(this.settings, this.path);
      if (!this.isDisposed) this.display(session);
    } catch (error) {
      if (!this.isDisposed) this.status.textContent = String(error);
    } finally {
      this.restart.disabled = false;
      this.schedule();
    }
  }

  private generation = 0;
  private session: IMySTRASession;
  private frame: IFrame;
  private status = document.createElement('span');
  private logs = document.createElement('pre');
  private restart = document.createElement('button');
  private timer: ReturnType<typeof setTimeout> | undefined;
}
