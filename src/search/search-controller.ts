import type { JupyterFrontEnd } from '@jupyterlab/application';
import { ModalCommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { IDisposable } from '@lumino/disposable';
import { CommandIDs } from '../commands';
import type { ICurrentProject } from '../current-project';
import type { IProjectRoot } from '../project-root';
import type { ISessionService } from '../sessions/session-service';
import type { ISearchCandidate } from './search-candidates';
import {
  SEARCH_CLASS,
  SearchPalette,
  type SearchGroup
} from './search-palette';
import { SearchSources, type IRecordsUpdate } from './search-sources';

/**
 * The search modal and what it shows: which project the palette is scoped
 * to, which opening a late answer belongs to, and where a chosen hit opens.
 */
export class SearchController implements IDisposable {
  constructor(options: SearchController.IOptions) {
    this._app = options.app;
    this._current = options.current;
    this._sessions = options.sessions;
    this._trans = options.trans;
    this._sources = new SearchSources(
      options.app,
      options.sessions,
      options.excludedCommands
    );
    this.palette = new SearchPalette({ placeholder: this._trans.__('Search') });
    this.modal = new ModalCommandPalette({
      commandPalette: this.palette,
      // As the stock palette does: whichever widget is current once the modal
      // closes takes focus, so an opened result keeps it and Escape returns it.
      // A closed modal no longer follows the project's data either.
      restore: () => {
        this._sources.keepRecordsFor(null);
        this._app.shell.currentWidget?.activate();
      }
    });
    this.modal.addClass(`${SEARCH_CLASS}-Modal`);
    this.modal.attach();
    this.palette.inputNode.addEventListener('input', this._onQuery);
    this.palette.selected.connect(this._onSelected, this);
    this._current.changed.connect(this._onProjectChanged, this);
    this._sources.recordsChanged.connect(this._onRecordsChanged, this);
  }

  /** The palette listing the candidates. */
  readonly palette: SearchPalette;

  /** The modal hosting the palette, attached to the document body. */
  readonly modal: ModalCommandPalette;

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Show the modal and load every group; resolves once all have answered. */
  open(): Promise<void> {
    this.modal.activate();
    return this._populate();
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    window.clearTimeout(this._queryTimer);
    this.palette.inputNode.removeEventListener('input', this._onQuery);
    this._current.changed.disconnect(this._onProjectChanged, this);
    this._sources.dispose();
    this.modal.dispose();
  }

  /**
   * Scope the palette to the current project and (re)load its groups. While
   * the project lookup is pending or has failed (`undefined`), the palette
   * keeps the groups it has and only the commands are refreshed.
   */
  private _populate(): Promise<void> {
    const opened = ++this._generation;
    const project = this._current.project;
    this._settled = project !== undefined;
    if (project !== undefined) {
      const scope = project?.entrypoint ?? null;
      if (scope !== this._scope) {
        this.palette.clear();
        this._scope = scope;
      }
      this._sources.keepRecordsFor(scope);
    }
    this.palette.placeholder = this._placeholder(project);
    const loads = [
      this._load('commands', opened, this._sources.listCommands())
    ];
    if (project) {
      if (this._sources.hasSessions) {
        loads.push(
          this._load('sessions', opened, this._sources.listSessions(project))
        );
      }
      loads.push(
        this._load('records', opened, this._sources.listRecords(project))
      );
      loads.push(this._load('files', opened, this._sources.listFiles(project)));
      loads.push(this._searchMessages());
    }
    return Promise.all(loads).then(() => undefined);
  }

  /** Search session text once typing pauses; titles are matched as typed. */
  private readonly _onQuery = (): void => {
    window.clearTimeout(this._queryTimer);
    this._queryTimer = window.setTimeout(() => {
      void this._searchMessages();
    }, SearchController.MESSAGE_SEARCH_DELAY);
  };

  /**
   * Replace the text hits with those of the current query. An answer that
   * arrives after the query, the project or the opening changed is dropped.
   */
  private async _searchMessages(): Promise<void> {
    const project = this._current.project;
    const query = this.palette.query;
    const opened = this._generation;
    const searched = ++this._querySearch;
    if (!project || !this._sources.hasSessions) {
      this.palette.setCandidates('messages', []);
      return;
    }
    try {
      const hits = await this._sources.searchMessages(project, query);
      if (
        searched === this._querySearch &&
        opened === this._generation &&
        !this.modal.isHidden
      ) {
        this.palette.setCandidates('messages', hits);
      }
    } catch (error) {
      if (searched === this._querySearch && !this.modal.isHidden) {
        this.palette.setCandidates('messages', []);
        console.warn('Lightcone search could not search session text.', error);
      }
    }
  }

  private _placeholder(project: IProjectRoot | null | undefined): string {
    if (project === undefined) {
      return this._trans.__('Search');
    }
    if (project === null) {
      return this._trans.__(
        'Search Lightcone commands (no project in this folder)'
      );
    }
    return this._trans.__(
      'Search %1: sessions, results, files, commands',
      PathExt.basename(project.path) || this._trans.__('project')
    );
  }

  private async _load(
    group: SearchGroup,
    opened: number,
    candidates: Promise<ISearchCandidate[]>
  ): Promise<void> {
    try {
      const loaded = await candidates;
      // A later opening or a closed modal owns the palette now.
      if (opened === this._generation && !this.modal.isHidden) {
        this.palette.setCandidates(group, loaded);
      }
    } catch (error) {
      // A later opening or closing the modal drops the project data a load
      // was waiting on; only a failure of the current opening is worth a note.
      if (opened === this._generation && !this.modal.isHidden) {
        console.warn(`Lightcone search could not list ${group}.`, error);
      }
    }
  }

  /**
   * A settled project lookup repopulates an open modal when it moves the scope
   * or when the modal opened before the lookup settled (and so still shows the
   * groups of an earlier opening); one that confirms the loaded scope only
   * restores its placeholder.
   */
  private _onProjectChanged(): void {
    const project = this._current.project;
    if (project === undefined) {
      return;
    }
    const scope = project?.entrypoint ?? null;
    this._sources.keepRecordsFor(scope);
    if (this.modal.isHidden) {
      return;
    }
    if (scope !== this._scope || !this._settled) {
      void this._populate();
    } else {
      this.palette.placeholder = this._placeholder(project);
    }
  }

  /** Records that change while the modal is open, such as paper titles arriving. */
  private _onRecordsChanged(
    _sources: SearchSources,
    update: IRecordsUpdate
  ): void {
    if (!this.modal.isHidden && update.entrypoint === this._scope) {
      this.palette.setCandidates('records', update.candidates);
    }
  }

  private _onSelected(
    _palette: SearchPalette,
    candidate: ISearchCandidate
  ): void {
    void this._open(candidate).catch(error => {
      void showErrorMessage(
        this._trans.__('Could not open %1', candidate.label),
        error instanceof Error ? error : String(error)
      );
    });
  }

  /**
   * Where a chosen hit opens: sessions in the main area through the session
   * service, records and papers through `open-element` (so they follow the
   * preview and pin rules and split beside a session), files in their default
   * viewer, and commands as themselves.
   */
  private async _open(candidate: ISearchCandidate): Promise<void> {
    const { action } = candidate;
    const commands = this._app.commands;
    switch (action.type) {
      case 'session':
        if (!this._sessions) {
          throw new Error('Sessions are not available in this JupyterLab.');
        }
        await this._sessions.openSession(action.path);
        return;
      case 'record':
        await commands.execute(CommandIDs.openElement, {
          entrypoint: action.entrypoint,
          target: action.target
        });
        return;
      case 'paper':
        await commands.execute(CommandIDs.openElement, {
          entrypoint: action.entrypoint,
          target: '',
          doi: action.doi
        });
        return;
      case 'file':
        await commands.execute('docmanager:open', { path: action.path });
        return;
      case 'command':
        await commands.execute(action.id);
        return;
    }
  }

  private readonly _app: JupyterFrontEnd;
  private readonly _current: ICurrentProject;
  private readonly _sessions: ISessionService | null;
  private readonly _trans: TranslationBundle;
  private readonly _sources: SearchSources;
  private _generation = 0;
  /** The entrypoint whose groups the palette holds; null outside a project. */
  private _scope: string | null = null;
  /** Whether the latest opening was scoped by a settled project lookup. */
  private _settled = false;
  private _queryTimer = 0;
  /** Counts text searches, so only the latest one's answer lands. */
  private _querySearch = 0;
  private _isDisposed = false;
}

export namespace SearchController {
  /** How long typing must pause before session text is searched, in ms. */
  export const MESSAGE_SEARCH_DELAY = 250;

  export interface IOptions {
    app: JupyterFrontEnd;
    current: ICurrentProject;
    sessions: ISessionService | null;
    trans: TranslationBundle;
    /** Command IDs never offered, such as the command opening the search. */
    excludedCommands: readonly string[];
  }
}
