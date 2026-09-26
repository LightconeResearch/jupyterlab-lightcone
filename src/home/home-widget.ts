import type { IThemeManager } from '@jupyterlab/apputils';
import { Launcher, type ILauncher } from '@jupyterlab/launcher';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { Contents } from '@jupyterlab/services';
import type { IStateDB } from '@jupyterlab/statedb';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { launcherIcon } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import { Panel, Widget } from '@lumino/widgets';
import type { IDocumentOpener } from '../artifact-access';
import type { ICurrentProject } from '../current-project';
import { lightconeIcon } from '../icons';
import { findProjectRoot, type IProjectRoot } from '../project-root';
import type { ISessionService } from '../sessions/session-service';
import { homeMode, type HomeMode } from './home-model';
import { HomeView } from './home-view';
import type { PersonaDirectory } from './personas';

const CLASS = 'jp-jupyterlab-lightcone-Home';

export interface IHomeWidgetOptions {
  model: ILauncher.IModel;
  cwd: string;
  commands: CommandRegistry;
  contents: Contents.IManager;
  /** Opens an artifact file in a tab, for the results plates. */
  documents: IDocumentOpener;
  rendermime: IRenderMimeRegistry;
  themes: IThemeManager;
  current: ICurrentProject;
  /** The stock launcher's callback: replace this tab with the launched widget. */
  callback: (widget: Widget) => void;
  /** Open the Tools menu below the given button. */
  onOpenTools: (anchor: HTMLElement) => void;
  translator?: ITranslator;
  sessions?: ISessionService | null;
  personas?: PersonaDirectory | null;
  state?: IStateDB | null;
}

/** A bar above the stock body inside a project, leading back to Home. */
class StockBar extends Widget {
  constructor(trans: TranslationBundle, onBack: () => void) {
    super();
    this.addClass(`${CLASS}-stockBar`);
    this._text = document.createElement('span');
    const back = document.createElement('button');
    back.type = 'button';
    back.className = `${CLASS}-link`;
    back.textContent = trans.__('Back to Home');
    back.addEventListener('click', onBack);
    this.node.append(this._text, back);
    this._trans = trans;
  }

  set project(project: IProjectRoot) {
    this._text.textContent = this._trans.__(
      'Showing the full launcher for %1.',
      project.path || '/'
    );
  }

  private _text: HTMLSpanElement;
  private _trans: TranslationBundle;
}

/**
 * The launcher tab's content: the stock launcher body outside Lightcone
 * projects, the project's Home inside them. The working directory follows
 * the file browser, so browsing into a project switches the tab to Home and
 * browsing out switches it back.
 */
export class HomeWidget extends Panel {
  constructor(options: IHomeWidgetOptions) {
    super();
    this.addClass(CLASS);
    this._contents = options.contents;
    this._current = options.current;
    this._cwd = options.cwd;
    this._trans = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    this._launcher = new Launcher({
      model: options.model,
      cwd: options.cwd,
      callback: options.callback,
      commands: options.commands,
      translator: options.translator
    });
    this._launcher.addClass(`${CLASS}-launcher`);
    this._stockBar = new StockBar(this._trans, () => this.showHome());
    this._view = new HomeView({
      contents: options.contents,
      commands: options.commands,
      documents: options.documents,
      rendermime: options.rendermime,
      themes: options.themes,
      sessions: options.sessions ?? null,
      personas: options.personas ?? null,
      state: options.state ?? null,
      translator: options.translator,
      onOpenTools: options.onOpenTools
    });
    this.addWidget(this._stockBar);
    this.addWidget(this._launcher);
    this.addWidget(this._view);
    this._current.changed.connect(this._resolve, this);
    this._update();
    this._resolve();
  }

  /** The directory the tab launches into; setting it re-resolves the project. */
  get cwd(): string {
    return this._cwd;
  }
  set cwd(value: string) {
    if (value === this._cwd) {
      return;
    }
    this._cwd = value;
    this._launcher.cwd = value;
    // The stock body names its folder at once: when the project lookup finds
    // the same project (or none again) it leaves the tab untouched.
    this._updateTitle();
    this._resolve();
  }

  /** The project the tab shows; null outside projects, undefined until the lookup settles. */
  get project(): IProjectRoot | null | undefined {
    return this._project;
  }

  /** Which body the tab shows. */
  get mode(): HomeMode {
    return homeMode(this._project, this._stockRequested);
  }

  /**
   * Resolves once the project lookup for the tab's current folder has
   * settled, including lookups started while it waited, so `project` and
   * `mode` then describe the folder the tab follows.
   */
  async settled(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this._resolving;
      await pending;
    } while (pending !== this._resolving && !this.isDisposed);
  }

  /** Show the stock launcher body until `showHome` is called. */
  showLauncher(): void {
    this._stockRequested = true;
    this._update();
  }

  /** Return to Home from the stock launcher body. */
  showHome(): void {
    this._stockRequested = false;
    this._update();
  }

  /** Adopt the sessions service resolved after the tab was created. */
  setSessions(
    sessions: ISessionService | null,
    personas: PersonaDirectory | null
  ): void {
    this._view.setSessions(sessions, personas);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._generation += 1;
    this._current.changed.disconnect(this._resolve, this);
    super.dispose();
  }

  /** Look the project up again; `settled` waits for the newest lookup. */
  private _resolve(): void {
    this._resolving = this._lookUp();
  }

  private async _lookUp(): Promise<void> {
    const generation = ++this._generation;
    let project: IProjectRoot | null;
    try {
      project = (await findProjectRoot(this._contents, this._cwd)) ?? null;
    } catch (error) {
      console.warn('Could not resolve the Lightcone project for Home.', error);
      project = null;
    }
    if (this.isDisposed || generation !== this._generation) {
      return;
    }
    const previous = this._project;
    if (
      previous !== undefined &&
      previous?.entrypoint === project?.entrypoint
    ) {
      return;
    }
    this._project = project;
    // A tab that asked for the stock view keeps it only within that project;
    // a request made before the first lookup settled applies to its result.
    if (
      previous !== undefined &&
      previous?.entrypoint !== project?.entrypoint
    ) {
      this._stockRequested = false;
    }
    this._update();
  }

  private _update(): void {
    const project = this._project;
    if (this.mode === 'home' && project) {
      this._view.setProject(project);
      this._launcher.hide();
      this._stockBar.hide();
      this._view.show();
    } else {
      this._view.setProject(null);
      this._view.hide();
      if (project) {
        this._stockBar.project = project;
        this._stockBar.show();
      } else {
        this._stockBar.hide();
      }
      this._launcher.show();
    }
    this._updateTitle();
  }

  /** Home names its project; the stock body names the folder it launches into. */
  private _updateTitle(): void {
    const project = this._project;
    if (this.mode === 'home' && project) {
      this.title.label = this._trans.__('Home');
      this.title.icon = lightconeIcon;
      this.title.caption = this._trans.__(
        'Lightcone Lab · %1',
        project.path || '/'
      );
      return;
    }
    this.title.label = this._trans.__('Launcher');
    this.title.icon = launcherIcon;
    this.title.caption = this._cwd || '/';
  }

  private _contents: Contents.IManager;
  private _current: ICurrentProject;
  private _cwd: string;
  private _trans: TranslationBundle;
  private _launcher: Launcher;
  private _stockBar: StockBar;
  private _view: HomeView;
  private _project: IProjectRoot | null | undefined = undefined;
  private _stockRequested = false;
  private _generation = 0;
  private _resolving: Promise<void> = Promise.resolve();
}
