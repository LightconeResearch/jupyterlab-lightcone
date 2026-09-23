import { PathExt } from '@jupyterlab/coreutils';
import type { Event, ServerConnection } from '@jupyterlab/services';
import { PromiseDelegate } from '@lumino/coreutils';
import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { Signal, type ISignal } from '@lumino/signaling';
import {
  cancelRun,
  getRun,
  isJobEvent,
  JOB_EVENT_SCHEMA,
  listRuns,
  startRun,
  type IJob,
  type IRunRecord
} from './runs-api';
import {
  applyJobEvent,
  entrypointForProject,
  isFinished,
  mergeJob,
  upsertJob
} from './runs-model';

/** Events are not replayed, so running jobs are re-read at this interval. */
const POLL_INTERVAL = 5000;

/** What the service knows about one project's runs. */
export interface IProjectRuns {
  readonly entrypoint: string;
  /** Materialization commits, newest first. */
  readonly runs: readonly IRunRecord[];
  /** This server's jobs for the project, newest first. */
  readonly jobs: readonly IJob[];
  /** Whether a listing was ever read. */
  readonly loaded: boolean;
  /** Whether a listing is being read. */
  readonly loading: boolean;
  /** The last listing failure; the previous runs stay visible. */
  readonly error: string | undefined;
}

export interface IRunningJob {
  entrypoint: string;
  job: IJob;
}

/**
 * Run histories and live jobs of every project seen in this session, kept
 * current through the server's event bus and a poll while jobs run.
 */
export class RunsService implements IDisposable {
  constructor(settings: ServerConnection.ISettings, events: Event.IManager) {
    this._settings = settings;
    this._events = events;
    this._poll = new Poll({
      auto: false,
      factory: () => this._pollRunningJobs(),
      frequency: {
        interval: POLL_INTERVAL,
        backoff: false,
        max: POLL_INTERVAL
      },
      name: 'jupyterlab_lightcone:runs',
      standby: 'when-hidden'
    });
    events.stream.connect(this._onEvent, this);
  }

  /** Emitted with the entrypoint whose runs or jobs changed. */
  get changed(): ISignal<this, string> {
    return this._changed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** The current snapshot for a project; empty until `refresh` ran. */
  runs(entrypoint: string): IProjectRuns {
    return this._entry(PathExt.normalize(entrypoint));
  }

  /** Every running job of every project the service knows. */
  runningJobs(): IRunningJob[] {
    const running: IRunningJob[] = [];
    for (const entry of this._entries.values()) {
      for (const job of entry.jobs) {
        if (!isFinished(job)) {
          running.push({ entrypoint: entry.entrypoint, job });
        }
      }
    }
    return running;
  }

  /** Re-read a project's history and jobs; concurrent calls share one read. */
  refresh(entrypoint: string): Promise<IProjectRuns> {
    const key = PathExt.normalize(entrypoint);
    let pending = this._refreshing.get(key);
    if (!pending) {
      pending = this._refresh(key).finally(() => {
        this._refreshing.delete(key);
      });
      this._refreshing.set(key, pending);
    }
    return pending;
  }

  /** Re-read every project seen so far. */
  async refreshAll(): Promise<void> {
    await Promise.all(
      [...this._entries.keys()].map(entrypoint =>
        this.refresh(entrypoint).catch(() => undefined)
      )
    );
  }

  /** Start `lc materialize`; rejects when the server refuses (409 while one runs). */
  async start(
    entrypoint: string,
    options: { targets?: string[]; refresh?: boolean } = {}
  ): Promise<IJob> {
    const key = PathExt.normalize(entrypoint);
    const job = await startRun(this._settings, key, options);
    if (!this._isDisposed) {
      this._upsert(key, job);
    }
    return job;
  }

  /** Ask the server to terminate a job; its state arrives through events. */
  async cancel(entrypoint: string, id: string): Promise<void> {
    const key = PathExt.normalize(entrypoint);
    await cancelRun(this._settings, key, id);
    if (this._isDisposed) {
      return;
    }
    try {
      this._upsert(key, await getRun(this._settings, key, id));
    } catch (error) {
      console.warn('Could not read the stopped Lightcone job.', error);
    }
  }

  /** Stop every running job the service knows. */
  cancelAll(): void {
    for (const { entrypoint, job } of this.runningJobs()) {
      void this.cancel(entrypoint, job.id).catch(error => {
        console.warn('Could not stop a Lightcone job.', error);
      });
    }
  }

  /** Resolve with the job once it reaches a terminal state. */
  whenFinished(entrypoint: string, id: string): Promise<IJob> {
    const key = PathExt.normalize(entrypoint);
    const job = this._entry(key).jobs.find(item => item.id === id);
    if (job && isFinished(job)) {
      return Promise.resolve(job);
    }
    let waiter = this._waiters.get(id);
    if (!waiter) {
      waiter = new PromiseDelegate<IJob>();
      this._waiters.set(id, waiter);
    }
    return waiter.promise;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._events.stream.disconnect(this._onEvent, this);
    this._poll.dispose();
    for (const waiter of this._waiters.values()) {
      waiter.reject(new Error('The Lightcone runs service was disposed.'));
    }
    this._waiters.clear();
    Signal.clearData(this);
  }

  private _entry(entrypoint: string): IProjectRuns {
    let entry = this._entries.get(entrypoint);
    if (!entry) {
      entry = {
        entrypoint,
        runs: [],
        jobs: [],
        loaded: false,
        loading: false,
        error: undefined
      };
      this._entries.set(entrypoint, entry);
    }
    return entry;
  }

  private _set(entrypoint: string, update: Partial<IProjectRuns>): void {
    this._entries.set(entrypoint, { ...this._entry(entrypoint), ...update });
    this._settle(entrypoint);
    this._changed.emit(entrypoint);
    this._syncPolling();
  }

  private _upsert(entrypoint: string, job: IJob): void {
    this._set(entrypoint, {
      jobs: upsertJob(this._entry(entrypoint).jobs, job)
    });
  }

  /** Resolve waiters for jobs that just finished. */
  private _settle(entrypoint: string): void {
    for (const job of this._entry(entrypoint).jobs) {
      const waiter = this._waiters.get(job.id);
      if (waiter && isFinished(job)) {
        this._waiters.delete(job.id);
        waiter.resolve(job);
      }
    }
  }

  private _syncPolling(): void {
    if (this._isDisposed) {
      return;
    }
    if (this.runningJobs().length > 0) {
      void this._poll.start();
    } else {
      void this._poll.stop();
    }
  }

  private async _refresh(entrypoint: string): Promise<IProjectRuns> {
    this._set(entrypoint, { loading: true });
    try {
      const listing = await listRuns(this._settings, entrypoint);
      if (this._isDisposed) {
        return this._entry(entrypoint);
      }
      // Events may already have moved a job past what the listing shows.
      const local = this._entry(entrypoint).jobs;
      const jobs = listing.jobs.map(job => {
        const known = local.find(item => item.id === job.id);
        return known ? mergeJob(known, job) : job;
      });
      this._set(entrypoint, {
        runs: listing.runs,
        jobs,
        loaded: true,
        loading: false,
        error: undefined
      });
    } catch (error) {
      if (!this._isDisposed) {
        this._set(entrypoint, {
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      throw error;
    }
    return this._entry(entrypoint);
  }

  private _onEvent(_sender: Event.IManager, emission: Event.Emission): void {
    if (
      this._isDisposed ||
      emission.schema_id !== JOB_EVENT_SCHEMA ||
      !isJobEvent(emission)
    ) {
      return;
    }
    const entrypoint = entrypointForProject(emission.project);
    const entry = this._entry(entrypoint);
    const job = entry.jobs.find(item => item.id === emission.id);
    if (!job) {
      // Started elsewhere, or its start response has not arrived yet.
      void this._fetchJob(entrypoint, emission.id);
      return;
    }
    this._upsert(entrypoint, applyJobEvent(job, emission));
    if (isFinished(emission)) {
      // The finished job has its exit code and report, and the history gained commits.
      void this._fetchJob(entrypoint, emission.id, true);
    }
  }

  /** Read one job, sharing an in-flight read, then optionally the listing. */
  private _fetchJob(
    entrypoint: string,
    id: string,
    withListing = false
  ): Promise<void> {
    let pending = this._fetching.get(id);
    if (!pending) {
      pending = getRun(this._settings, entrypoint, id)
        .then(job => {
          if (!this._isDisposed) {
            this._upsert(entrypoint, job);
          }
        })
        .catch(error => {
          console.warn('Could not read a Lightcone job.', error);
        })
        .finally(() => {
          this._fetching.delete(id);
        });
      this._fetching.set(id, pending);
    }
    if (!withListing) {
      return pending;
    }
    return pending.then(() =>
      this.refresh(entrypoint).then(
        () => undefined,
        () => undefined
      )
    );
  }

  private async _pollRunningJobs(): Promise<void> {
    const running = this.runningJobs();
    if (running.length === 0) {
      void this._poll.stop();
      return;
    }
    await Promise.all(
      running.map(async ({ entrypoint, job }) => {
        try {
          const latest = await getRun(this._settings, entrypoint, job.id);
          if (this._isDisposed) {
            return;
          }
          this._upsert(entrypoint, latest);
          if (isFinished(latest)) {
            await this.refresh(entrypoint).catch(() => undefined);
          }
        } catch (error) {
          console.warn('Could not poll a Lightcone job.', error);
        }
      })
    );
  }

  private readonly _settings: ServerConnection.ISettings;
  private readonly _events: Event.IManager;
  private readonly _poll: Poll;
  private readonly _entries = new Map<string, IProjectRuns>();
  private readonly _refreshing = new Map<string, Promise<IProjectRuns>>();
  private readonly _fetching = new Map<string, Promise<void>>();
  private readonly _waiters = new Map<string, PromiseDelegate<IJob>>();
  private readonly _changed = new Signal<this, string>(this);
  private _isDisposed = false;
}
