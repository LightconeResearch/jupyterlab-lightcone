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
  fetchMaterializationStatuses,
  type MaterializationStatuses
} from '../materialization-status';
import { projectDirectory, type ILoadedProjectData } from '../project-data';
import {
  acquireProjectDataService,
  type IProjectDataLease,
  type IProjectDataState,
  type ProjectDataService
} from '../project-data-service';
import { findModel, type IProjectRoot } from '../project-root';
import type {
  ISessionService,
  SessionState
} from '../sessions/session-service';
import type { ISessionInfo } from '../sessions/sessions-api';
import {
  describeWidget,
  renamedSessionPath,
  sessionMarker,
  viewChanges,
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
  /** Why `lc status` could not be read, when it could not. */
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

/**
 * Run one update at a time. `run` joins the update in flight, which is what a
 * periodic poll wants; `request` asks for another pass once it settles, which
 * is what a change wants, because the answer in flight may predate it (a
 * project switch, a new chat file). `Poll.refresh()` alone would drop such a
 * request while a refresh is still running.
 */
export class CoalescingRunner {
  constructor(private readonly _update: () => Promise<void>) {}

  /** Join the update in flight, or start one. */
  run(): Promise<void> {
    return this._running ?? this._start();
  }

  /** Start an update, or run it again after the one in flight. */
  request(): Promise<void> {
    if (this._running) {
      this._dirty = true;
      return this._running;
    }
    return this._start();
  }

  private _start(): Promise<void> {
    // `_loop` only settles after awaiting an update, so this is set first.
    const running = this._loop();
    this._running = running;
    return running;
  }

  // A failure is reported only when no newer request superseded it. The loop
  // stops being the run in flight in the same step it decides to stop, so a
  // request that arrives later always starts another pass.
  private async _loop(): Promise<void> {
    try {
      for (;;) {
        this._dirty = false;
        try {
          await this._invoke();
        } catch (error) {
          if (!this._dirty) {
            throw error;
          }
          continue;
        }
        if (!this._dirty) {
          return;
        }
      }
    } finally {
      this._running = undefined;
    }
  }

  // An update that throws instead of rejecting still settles asynchronously.
  private _invoke(): Promise<void> {
    try {
      return this._update();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private _running: Promise<void> | undefined;
  private _dirty = false;
}

/**
 * Follow the current project and gather what the sidebar shows: project data,
 * materialization status, sessions, pending comments and the current view.
 * Nothing is fetched or polled while the sidebar is hidden, and the polls
 * also stand by while the browser tab is hidden.
 */
export class SidebarModel implements IDisposable {
  constructor(options: ISidebarModelOptions) {
    this._contents = options.contents;
    this._shell = options.shell;
    this._current = options.current;
    this._sessions = options.sessions;
    this._comments = options.comments;
    this._statusRunner = new CoalescingRunner(() => this._updateStatuses());
    this._sessionsRunner = new CoalescingRunner(() => this._updateSessions());
    this._statusPoll = new Poll({
      name: 'jupyterlab_lightcone:sidebar:status',
      frequency: { interval: 15000, max: 60000, backoff: true },
      standby: () => !this._visible || !this._entrypoint || 'when-hidden',
      factory: () => this._statusRunner.run()
    });
    this._sessionsPoll = new Poll({
      name: 'jupyterlab_lightcone:sidebar:sessions',
      frequency: { interval: 15000, max: 60000, backoff: true },
      standby: () =>
        !this._visible || !this._entrypoint || !this._sessions || 'when-hidden',
      factory: () => this._sessionsRunner.run()
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

  /**
   * Whether the sidebar is on screen. While it is not, the model holds no
   * project-data lease and fetches nothing; it keeps what it last showed and
   * refreshes everything once shown again.
   */
  get visible(): boolean {
    return this._visible;
  }

  set visible(value: boolean) {
    if (value === this._visible) {
      return;
    }
    this._visible = value;
    if (value) {
      this._acquire();
      void this.refresh();
    } else {
      this._release();
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
      this._statusRunner.request().catch(() => undefined),
      this._sessionsRunner.request().catch(() => undefined),
      this._refreshComments(entrypoint),
      this._checkReport(entrypoint)
    ]);
  }

  /**
   * Rename a session's chat file in its folder through the Contents API; the
   * name becomes a slug the way new sessions are named. An open chat follows
   * the rename, since its document context tracks the file. Returns the new
   * path, or undefined when the name is blank or changes nothing.
   */
  async renameSession(path: string, name: string): Promise<string | undefined> {
    const target = renamedSessionPath(path, name);
    if (!target) {
      return undefined;
    }
    if (await findModel(this._contents, target)) {
      throw new Error(
        `A session named ${PathExt.basename(target)} already exists in this folder.`
      );
    }
    await this._contents.rename(path, target);
    return target;
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
    if (this._visible) {
      this._acquire();
      void this.refresh();
    }
    this._schedule();
  }

  /** Lease the project's shared data while the sidebar shows the project. */
  private _acquire(): void {
    const entrypoint = this._entrypoint;
    if (!entrypoint || this._lease || this._isDisposed) {
      return;
    }
    this._lease = acquireProjectDataService(this._contents, entrypoint);
    this._lease.service.changed.connect(this._onData, this);
    this._onData(this._lease.service, this._lease.service.state);
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
    // A lease taken again after the sidebar was hidden may start empty; keep
    // what the sidebar showed until the project resolves. A project switch
    // clears `_data` first, so this never shows another project's data.
    const data = state.data ?? this._data;
    if (data !== this._data || state.error !== this._error) {
      this._data = data;
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
      const statuses = await fetchMaterializationStatuses(
        this._contents,
        entrypoint
      );
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
    // Keeps the `drive:` prefix of a project at a drive root.
    const directory = projectDirectory(entrypoint);
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
    // Hidden, nothing is fetched; showing the sidebar refreshes everything.
    if (!entrypoint || !this._visible) {
      return;
    }
    const root = this._contents.localPath(projectDirectory(entrypoint));
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
    this._request(this._statusRunner);
    if (inside.some(path => path.endsWith('.chat') || change.type !== 'save')) {
      this._request(this._sessionsRunner);
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
      if (this._visible) {
        this._request(this._sessionsRunner);
      }
      // Live activity changes affect markers even when the list did not.
      this._schedule();
    }
  }

  // Failures are already in the state; the poll backs off on its own ticks.
  private _request(runner: CoalescingRunner): void {
    void runner.request().catch(() => undefined);
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
   * Watch the current widget for views it changes in place: a renamed
   * document, a link followed in a record tab, another analysis in the
   * inventory. None of these changes which widget is current.
   */
  private _follow(widget: Widget | null): void {
    if (widget === this._followed) {
      return;
    }
    for (const signal of this._viewSignals) {
      signal.disconnect(this._refreshView, this);
    }
    this._followed = widget;
    this._viewSignals = viewChanges(widget);
    for (const signal of this._viewSignals) {
      signal.connect(this._refreshView, this);
    }
  }

  private _refreshView(): void {
    const view = describeWidget(this._shell.currentWidget);
    const previous = this._view;
    if (
      view.session !== previous.session ||
      view.inventory !== previous.inventory ||
      view.analysisPath !== previous.analysisPath ||
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
  private readonly _statusRunner: CoalescingRunner;
  private readonly _sessionsRunner: CoalescingRunner;
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
  private _followed: Widget | null = null;
  private _viewSignals: ISignal<unknown, unknown>[] = [];
  private _visible = false;
  private _generation = 0;
  private _scheduled = false;
  private _isDisposed = false;
}
