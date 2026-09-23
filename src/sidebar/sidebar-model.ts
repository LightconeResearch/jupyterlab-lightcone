import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { Signal, type ISignal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import { RequestError } from '../api';
import type { ICommentService } from '../comments/comment-service';
import type { ICurrentProject } from '../current-project';
import {
  parseMaterializationStatuses,
  type MaterializationStatuses
} from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import {
  acquireProjectDataService,
  type IProjectDataLease,
  type IProjectDataState,
  type ProjectDataService
} from '../project-data-service';
import { findModel, type IProjectRoot } from '../project-root';
import { requestAPI } from '../request';
import type {
  ISessionService,
  SessionState
} from '../sessions/session-service';
import type { ISessionInfo } from '../sessions/sessions-api';
import {
  describeWidget,
  recordNavigation,
  sessionMarker,
  type ICurrentView
} from './sidebar-helpers';

const REPORT_FILES = ['myst.yml', 'myst.yaml'];

/** Everything the sidebar renders, as one immutable snapshot. */
export interface ISidebarState {
  /** The current project; null outside every project, undefined while unknown. */
  project: IProjectRoot | null | undefined;
  /** The last valid project data, when it has loaded. */
  data: ILoadedProjectData | undefined;
  /** Why the project could not be read, when it could not. */
  error: string | undefined;
  /** `lc status` per output, when the server reported it. */
  statuses: MaterializationStatuses | undefined;
  statusError: string | undefined;
  /** The project's sessions, newest first. */
  sessions: readonly ISessionInfo[];
  /** Whether the sessions have been listed at least once for this project. */
  sessionsLoaded: boolean;
  sessionsError: string | undefined;
  /** Number of pending comments in the project. */
  pendingComments: number;
  /** Whether the project has a MyST configuration to open as a report. */
  reportAvailable: boolean;
  /** The Lightcone view the current main-area widget shows. */
  view: ICurrentView;
}

/** The part of the application shell the sidebar follows. */
export interface ISidebarShell {
  readonly currentWidget: Widget | null;
  readonly currentChanged?: ISignal<unknown, unknown>;
}

/** What the model observes; narrowed for tests. */
export interface ISidebarModelOptions {
  contents: Contents.IManager;
  shell: ISidebarShell;
  current: ICurrentProject;
  sessions: ISessionService | null;
  comments: ICommentService | null;
}

async function fetchStatuses(
  contents: Contents.IManager,
  entrypoint: string
): Promise<MaterializationStatuses> {
  if (contents.driveName(entrypoint)) {
    throw new Error('Materialization status requires local files.');
  }
  const query = new URLSearchParams({ path: entrypoint });
  const payload = await requestAPI(
    `api/materialization?${query}`,
    contents.serverSettings
  );
  return parseMaterializationStatuses(payload);
}

/**
 * Follow the current project and gather what the sidebar shows: project data,
 * materialization status, sessions, pending comments and the current view.
 * Polling runs only while the sidebar is visible.
 */
export class SidebarModel implements IDisposable {
  constructor(options: ISidebarModelOptions) {
    this._contents = options.contents;
    this._shell = options.shell;
    this._current = options.current;
    this._sessions = options.sessions;
    this._comments = options.comments;
    this._statusPoll = new Poll({
      name: 'jupyterlab_lightcone:sidebar:status',
      auto: false,
      frequency: { interval: 15000, max: 60000, backoff: true },
      standby: () => !this._visible || !this._entrypoint,
      factory: () => this._updateStatuses()
    });
    this._sessionsPoll = new Poll({
      name: 'jupyterlab_lightcone:sidebar:sessions',
      auto: false,
      frequency: { interval: 15000, max: 60000, backoff: true },
      standby: () => !this._visible || !this._entrypoint || !this._sessions,
      factory: () => this._updateSessions()
    });
    this._current.changed.connect(this._bind, this);
    this._contents.fileChanged.connect(this._onFileChanged, this);
    this._sessions?.changed.connect(this._onSessionsChanged, this);
    this._comments?.changed.connect(this._onCommentsChanged, this);
    this._shell.currentChanged?.connect(this._onCurrentChanged, this);
    this._follow(this._shell.currentWidget);
    this._view = describeWidget(this._shell.currentWidget);
    this._bind();
  }

  /** The current snapshot. */
  get state(): ISidebarState {
    return {
      project: this._current.project,
      data: this._data,
      error: this._error,
      statuses: this._statuses,
      statusError: this._statusError,
      sessions: this._sessionList,
      sessionsLoaded: this._sessionsLoaded,
      sessionsError: this._sessionsError,
      pendingComments: this._pendingComments,
      reportAvailable: this._reportAvailable,
      view: this._view
    };
  }

  /** Emitted once per tick after anything in `state` changed. */
  get changed(): ISignal<this, ISidebarState> {
    return this._changed;
  }

  /** The session service, when Jupyter AI sessions are available. */
  get sessionService(): ISessionService | null {
    return this._sessions;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Whether the sidebar is on screen; polling pauses while it is not. */
  get visible(): boolean {
    return this._visible;
  }

  set visible(value: boolean) {
    if (value === this._visible) {
      return;
    }
    this._visible = value;
    if (value) {
      void this.refresh();
    }
  }

  /** The marker to show for a session: its live state, else the server's. */
  activity(session: ISessionInfo): SessionState {
    return sessionMarker(
      this._sessions?.activity(session.path),
      session.activity
    );
  }

  /** Fetch everything again for the current project. */
  async refresh(): Promise<void> {
    if (this._isDisposed || !this._entrypoint) {
      return;
    }
    const entrypoint = this._entrypoint;
    await Promise.all([
      this._lease?.service.refresh().catch(() => undefined),
      this._statusPoll.refresh(),
      this._sessionsPoll.refresh(),
      this._refreshComments(entrypoint),
      this._checkReport(entrypoint)
    ]);
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._current.changed.disconnect(this._bind, this);
    this._contents.fileChanged.disconnect(this._onFileChanged, this);
    this._sessions?.changed.disconnect(this._onSessionsChanged, this);
    this._comments?.changed.disconnect(this._onCommentsChanged, this);
    this._shell.currentChanged?.disconnect(this._onCurrentChanged, this);
    this._follow(null);
    this._release();
    this._statusPoll.dispose();
    this._sessionsPoll.dispose();
    Signal.clearData(this);
  }

  private _bind(): void {
    const project = this._current.project;
    const entrypoint = project?.entrypoint;
    if (entrypoint === this._entrypoint) {
      this._schedule();
      return;
    }
    this._release();
    this._generation += 1;
    this._entrypoint = entrypoint;
    this._data = undefined;
    this._error = undefined;
    this._statuses = undefined;
    this._statusError = undefined;
    this._sessionList = [];
    this._sessionsLoaded = false;
    this._sessionsError = undefined;
    this._pendingComments = 0;
    this._reportAvailable = false;
    if (entrypoint) {
      this._lease = acquireProjectDataService(this._contents, entrypoint);
      this._lease.service.changed.connect(this._onData, this);
      this._onData(this._lease.service, this._lease.service.state);
      void this._lease.service.get().catch(() => undefined);
      void this._statusPoll.refresh();
      void this._sessionsPoll.refresh();
      void this._refreshComments(entrypoint);
      void this._checkReport(entrypoint);
    }
    this._schedule();
  }

  private _release(): void {
    if (this._lease) {
      this._lease.service.changed.disconnect(this._onData, this);
      this._lease.release();
      this._lease = undefined;
    }
  }

  private _onData(sender: ProjectDataService, state: IProjectDataState): void {
    if (sender !== this._lease?.service) {
      return;
    }
    if (state.data !== this._data || state.error !== this._error) {
      this._data = state.data;
      this._error = state.error;
      this._schedule();
    }
  }

  private async _updateStatuses(): Promise<void> {
    const entrypoint = this._entrypoint;
    if (!entrypoint) {
      return;
    }
    const generation = this._generation;
    try {
      const statuses = await fetchStatuses(this._contents, entrypoint);
      if (generation !== this._generation || this._isDisposed) {
        return;
      }
      this._statuses = statuses;
      this._statusError = undefined;
      this._schedule();
    } catch (error) {
      if (generation !== this._generation || this._isDisposed) {
        return;
      }
      this._statuses = undefined;
      this._statusError = new RequestError(
        'Materialization status',
        error
      ).message;
      this._schedule();
      throw error;
    }
  }

  private async _updateSessions(): Promise<void> {
    const entrypoint = this._entrypoint;
    const service = this._sessions;
    if (!entrypoint || !service) {
      return;
    }
    const generation = this._generation;
    try {
      const sessions = await service.list(entrypoint);
      if (generation !== this._generation || this._isDisposed) {
        return;
      }
      this._sessionList = sessions;
      this._sessionsLoaded = true;
      this._sessionsError = undefined;
      this._schedule();
    } catch (error) {
      if (generation !== this._generation || this._isDisposed) {
        return;
      }
      this._sessionsLoaded = true;
      this._sessionsError =
        error instanceof Error ? error.message : String(error);
      this._schedule();
      throw error;
    }
  }

  private async _refreshComments(entrypoint: string): Promise<void> {
    const service = this._comments;
    if (!service) {
      return;
    }
    const generation = this._generation;
    try {
      await service.refresh(entrypoint);
    } catch (error) {
      console.warn('Could not refresh Lightcone comments.', error);
    }
    if (generation !== this._generation || this._isDisposed) {
      return;
    }
    this._setPendingComments(service.pending(entrypoint).length);
  }

  private _setPendingComments(count: number): void {
    if (count !== this._pendingComments) {
      this._pendingComments = count;
      this._schedule();
    }
  }

  private async _checkReport(entrypoint: string): Promise<void> {
    const generation = this._generation;
    const directory = PathExt.dirname(entrypoint);
    let available = false;
    try {
      for (const name of REPORT_FILES) {
        const model = await findModel(
          this._contents,
          this._contents.resolvePath(directory, name)
        );
        if (model?.type === 'file') {
          available = true;
          break;
        }
      }
    } catch (error) {
      console.warn('Could not look for the project report.', error);
    }
    if (generation !== this._generation || this._isDisposed) {
      return;
    }
    if (available !== this._reportAvailable) {
      this._reportAvailable = available;
      this._schedule();
    }
  }

  private _onFileChanged(
    _sender: Contents.IManager,
    change: Contents.IChangedArgs
  ): void {
    const entrypoint = this._entrypoint;
    if (!entrypoint) {
      return;
    }
    const root = this._contents.localPath(PathExt.dirname(entrypoint));
    const drive = this._contents.driveName(entrypoint);
    const paths = [change.oldValue?.path, change.newValue?.path].filter(
      (path): path is string =>
        path !== undefined && this._contents.driveName(path) === drive
    );
    const inside = paths.filter(path => {
      const local = this._contents.localPath(path);
      return !root || local === root || local.startsWith(`${root}/`);
    });
    if (!inside.length) {
      return;
    }
    void this._statusPoll.refresh();
    if (inside.some(path => path.endsWith('.chat') || change.type !== 'save')) {
      void this._sessionsPoll.refresh();
    }
    if (inside.some(path => REPORT_FILES.includes(PathExt.basename(path)))) {
      void this._checkReport(entrypoint);
    }
  }

  private _onSessionsChanged(
    _sender: ISessionService,
    entrypoint: string
  ): void {
    if (this._entrypoint && entrypoint === this._entrypoint) {
      void this._sessionsPoll.refresh();
      // Live activity changes affect markers even when the list did not.
      this._schedule();
    }
  }

  private _onCommentsChanged(
    sender: ICommentService,
    entrypoint: string
  ): void {
    if (this._entrypoint && entrypoint === this._entrypoint) {
      this._setPendingComments(sender.pending(entrypoint).length);
    }
  }

  private _onCurrentChanged(): void {
    this._follow(this._shell.currentWidget);
    this._refreshView();
  }

  /**
   * Watch the current record tab: a link followed inside it shows another
   * record without changing which widget is current.
   */
  private _follow(widget: Widget | null): void {
    const navigation = recordNavigation(widget);
    if (navigation === this._navigation) {
      return;
    }
    this._navigation?.disconnect(this._refreshView, this);
    this._navigation = navigation;
    navigation?.connect(this._refreshView, this);
  }

  private _refreshView(): void {
    const view = describeWidget(this._shell.currentWidget);
    const previous = this._view;
    if (
      view.session !== previous.session ||
      view.inventory !== previous.inventory ||
      view.record?.entrypoint !== previous.record?.entrypoint ||
      view.record?.target !== previous.record?.target ||
      view.record?.doi !== previous.record?.doi
    ) {
      this._view = view;
      this._schedule();
    }
  }

  // Several sources settle in one tick; publish one snapshot for all of them.
  private _schedule(): void {
    if (this._scheduled || this._isDisposed) {
      return;
    }
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      if (!this._isDisposed) {
        this._changed.emit(this.state);
      }
    });
  }

  private readonly _contents: Contents.IManager;
  private readonly _shell: ISidebarShell;
  private readonly _current: ICurrentProject;
  private readonly _sessions: ISessionService | null;
  private readonly _comments: ICommentService | null;
  private readonly _statusPoll: Poll;
  private readonly _sessionsPoll: Poll;
  private readonly _changed = new Signal<this, ISidebarState>(this);
  private _lease: IProjectDataLease | undefined;
  private _entrypoint: string | undefined;
  private _data: ILoadedProjectData | undefined;
  private _error: string | undefined;
  private _statuses: MaterializationStatuses | undefined;
  private _statusError: string | undefined;
  private _sessionList: readonly ISessionInfo[] = [];
  private _sessionsLoaded = false;
  private _sessionsError: string | undefined;
  private _pendingComments = 0;
  private _reportAvailable = false;
  private _view: ICurrentView = {};
  private _navigation: ISignal<unknown, unknown> | undefined;
  private _visible = false;
  private _generation = 0;
  private _scheduled = false;
  private _isDisposed = false;
}
