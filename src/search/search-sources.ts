import { chatIcon } from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import type { TranslationBundle } from '@jupyterlab/translation';
import { fileIcon } from '@jupyterlab/ui-components';
import type { IDisposable } from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import type { ILoadedProjectData } from '../project-data';
import {
  acquireProjectDataService,
  type IProjectDataLease,
  type IProjectDataState,
  type ProjectDataService
} from '../project-data-service';
import type { IProjectRoot } from '../project-root';
import type { ISessionService } from '../sessions/session-service';
import { MIN_SESSION_QUERY, searchSessions } from '../sessions/sessions-api';
import { walkProjectFiles, type IProjectFile } from './project-files';
import {
  commandCandidates,
  fileCandidates,
  messageCandidates,
  recordCandidates,
  sessionCandidates,
  type ISearchCandidate
} from './search-candidates';

/** How long a project's file listing is reused between openings. */
export const FILE_LISTING_TTL = 30000;

interface IFileListing {
  at: number;
  files: IProjectFile[];
}

interface IHeldRecords {
  entrypoint: string;
  lease: IProjectDataLease;
  /** The data the last candidates were built from. */
  data: ILoadedProjectData | undefined;
}

/** Fresh record candidates for the project whose data service is held. */
export interface IRecordsUpdate {
  entrypoint: string;
  candidates: ISearchCandidate[];
}

/**
 * Loads each candidate group from the workbench: the session service, the
 * shared project data service, a bounded Contents walk and the command
 * registry. Only the file walk is cached, since it costs one request per
 * folder. The data service of the project being searched is held until
 * `keepRecordsFor` lets it go (the modal closes or the project changes), so
 * paper titles that arrive after the first answer are announced through
 * `recordsChanged` instead of being lost with the service.
 */
export class SearchSources implements IDisposable {
  constructor(
    private readonly app: JupyterFrontEnd,
    private readonly sessions: ISessionService | null,
    private readonly excludedCommands: readonly string[],
    private readonly trans: TranslationBundle
  ) {}

  /** Emitted when the held project's records or paper metadata change. */
  get recordsChanged(): ISignal<this, IRecordsUpdate> {
    return this._recordsChanged;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Whether the sessions group can be offered at all. */
  get hasSessions(): boolean {
    return this.sessions !== null;
  }

  listCommands(): Promise<ISearchCandidate[]> {
    return commandCandidates(this.app.commands, this.trans, {
      exclude: this.excludedCommands
    });
  }

  async listSessions(project: IProjectRoot): Promise<ISearchCandidate[]> {
    const sessions = this.sessions;
    if (!sessions) {
      return [];
    }
    const listed = await sessions.list(project.entrypoint);
    return sessionCandidates(listed, this.trans, {
      icon: chatIcon,
      activity: path => sessions.activity(path)
    });
  }

  /**
   * Messages of the project's sessions containing `query`; nothing without
   * the sessions service, which is what opens a hit, or for a short query.
   */
  async searchMessages(
    project: IProjectRoot,
    query: string
  ): Promise<ISearchCandidate[]> {
    if (!this.sessions || query.trim().length < MIN_SESSION_QUERY) {
      return [];
    }
    const matches = await searchSessions(
      this.app.serviceManager.serverSettings,
      project.entrypoint,
      query.trim()
    );
    return messageCandidates(matches, this.trans, chatIcon);
  }

  async listRecords(project: IProjectRoot): Promise<ISearchCandidate[]> {
    const held = this._hold(project.entrypoint);
    const data = await held.lease.service.get();
    if (this._records === held) {
      held.data = data;
    }
    return recordCandidates(data, project.entrypoint, this.trans);
  }

  async listFiles(project: IProjectRoot): Promise<ISearchCandidate[]> {
    const files = await this._files(project);
    const registry = this.app.docRegistry;
    return fileCandidates(
      files,
      this.trans,
      path => registry.getFileTypesForPath(path)[0]?.icon ?? fileIcon
    );
  }

  /** Release the held project data unless it belongs to `entrypoint`. */
  keepRecordsFor(entrypoint: string | null): void {
    if (this._records && this._records.entrypoint !== entrypoint) {
      const { lease } = this._records;
      lease.service.changed.disconnect(this._onRecords, this);
      lease.release();
      this._records = undefined;
    }
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this.keepRecordsFor(null);
    Signal.clearData(this);
  }

  private _hold(entrypoint: string): IHeldRecords {
    this.keepRecordsFor(entrypoint);
    if (!this._records) {
      const lease = acquireProjectDataService(
        this.app.serviceManager.contents,
        entrypoint
      );
      lease.service.changed.connect(this._onRecords, this);
      this._records = { entrypoint, lease, data: undefined };
    }
    return this._records;
  }

  private _onRecords(
    _service: ProjectDataService,
    state: IProjectDataState
  ): void {
    const held = this._records;
    if (!held || !state.data || state.data === held.data) {
      return;
    }
    held.data = state.data;
    this._recordsChanged.emit({
      entrypoint: held.entrypoint,
      candidates: recordCandidates(state.data, held.entrypoint, this.trans)
    });
  }

  private _files(project: IProjectRoot): Promise<IProjectFile[]> {
    const key = project.path;
    const cached = this._listings.get(key);
    if (cached && Date.now() - cached.at < FILE_LISTING_TTL) {
      return Promise.resolve(cached.files);
    }
    let pending = this._pending.get(key);
    if (!pending) {
      pending = walkProjectFiles(this.app.serviceManager.contents, project.path)
        .then(files => {
          this._listings.set(key, { at: Date.now(), files });
          return files;
        })
        .finally(() => {
          this._pending.delete(key);
        });
      this._pending.set(key, pending);
    }
    return pending;
  }

  private _isDisposed = false;
  private _records: IHeldRecords | undefined;
  private readonly _recordsChanged = new Signal<this, IRecordsUpdate>(this);
  private readonly _listings = new Map<string, IFileListing>();
  private readonly _pending = new Map<string, Promise<IProjectFile[]>>();
}
