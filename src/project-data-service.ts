import { normalizeDoi } from '@astra-spec/sdk';
import type { InventoryPaperMetadata } from '@astra-spec/ui/model';
import type { Contents } from '@jupyterlab/services';
import { Poll } from '@lumino/polling';
import {
  DisposableDelegate,
  type IDisposable,
  type IObservableDisposable
} from '@lumino/disposable';
import { Signal, type ISignal } from '@lumino/signaling';
import { fetchPaper } from './api';
import {
  assembleLoadedProject,
  loadProjectPapers,
  projectDirectory,
  projectErrorMessage,
  resolveProject,
  type ILoadedProjectData
} from './project-data';

const PAPER_CHECK_INTERVAL = 30000;

export interface IProjectDataState {
  data: ILoadedProjectData | undefined;
  error: string | undefined;
  /** Paper cache failures do not prevent viewing a valid project. */
  paperError?: string;
}

/** One polling data source shared by all panels viewing an entrypoint. */
export class ProjectDataService implements IObservableDisposable {
  constructor(
    readonly contents: Contents.IManager,
    readonly entrypoint: string,
    readonly universeId?: string | null
  ) {
    this._poll = new Poll<void, unknown>({
      factory: () => {
        // Refresh commands may arrive during an existing poll request.
        this._pendingUpdate ??= this._update().finally(() => {
          this._pendingUpdate = undefined;
        });
        return this._pendingUpdate;
      },
      frequency: { interval: 2000, max: 30000, backoff: true },
      name: `jupyterlab_lightcone:project:${entrypoint}`,
      standby: 'when-hidden'
    });
    contents.fileChanged.connect(this._onContentsChanged, this);
  }

  get changed(): ISignal<this, IProjectDataState> {
    return this._changed;
  }

  /** Valid project resolutions only; paper-cache updates are excluded. */
  get projectChanged(): ISignal<this, ILoadedProjectData> {
    return this._projectChanged;
  }

  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  get isDisposed(): boolean {
    return this._poll.isDisposed;
  }

  get state(): IProjectDataState {
    return {
      data: this._data,
      error: this._error,
      paperError: this._paperError
    };
  }

  /** Return available data, retaining the last valid document after errors. */
  async get(): Promise<ILoadedProjectData> {
    if (!this._data) {
      await this.refresh();
    }
    if (this._data && !this.isDisposed) {
      return this._data;
    }
    throw new Error(this._error ?? 'The project is no longer available.');
  }

  /** Fetch a paper once and share its progress and result across panels. */
  async fetchPaper(doi: string): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    const key = normalizeDoi(doi);
    let pending = this._paperFetches.get(key);
    if (!pending) {
      pending = this._fetchPaper(key).finally(() => {
        this._paperFetches.delete(key);
      });
      this._paperFetches.set(key, pending);
    }
    await pending;
  }

  /** Refresh the project and schedule a paper cache check. */
  async refresh(): Promise<IProjectDataState> {
    this._paperCheckedAt = 0;
    await this._poll.refresh();
    await this._poll.tick;
    return this.state;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.contents.fileChanged.disconnect(this._onContentsChanged, this);
    this._poll.dispose();
    this._disposed.emit();
    Signal.clearData(this);
  }

  private _onContentsChanged(
    _sender: Contents.IManager,
    change: Contents.IChangedArgs
  ): void {
    const root = this.contents.localPath(projectDirectory(this.entrypoint));
    const drive = this.contents.driveName(this.entrypoint);
    const affectsProject = [change.oldValue?.path, change.newValue?.path].some(
      path => {
        if (path === undefined || this.contents.driveName(path) !== drive) {
          return false;
        }
        const local = this.contents.localPath(path);
        return !root || local === root || local.startsWith(`${root}/`);
      }
    );
    if (affectsProject) {
      void this.refresh().catch(error => {
        if (!this.isDisposed) {
          console.error('Could not refresh the Lightcone Lab project.', error);
        }
      });
    }
  }

  private async _update(): Promise<void> {
    try {
      const resolution = await resolveProject(
        this.contents,
        this.entrypoint,
        this.universeId ?? undefined
      );
      if (this.isDisposed) {
        return;
      }
      if (
        this.universeId === null &&
        resolution.bundle.document.universe.source !== 'none'
      ) {
        throw new Error(
          'Universe files were added. Start a new discussion to choose a universe.'
        );
      }
      const changed = resolution.snapshot !== this._projectSnapshot;
      if (!this._data || changed) {
        this._data = assembleLoadedProject(
          resolution.bundle,
          this._data?.papers ?? {}
        );
        this._projectSnapshot = resolution.snapshot;
        this._projectChanged.emit(this._data);
      }
      const recovered = this._error !== undefined;
      this._error = undefined;
      if (changed || recovered) {
        this._changed.emit(this.state);
      }
      this._checkPapers(this._data);
    } catch (error) {
      if (!this.isDisposed) {
        const message = projectErrorMessage(error);
        if (message !== this._error) {
          this._error = message;
          this._changed.emit(this.state);
        }
      }
      throw error;
    }
  }

  private _checkPapers(data: ILoadedProjectData): void {
    if (
      this.isDisposed ||
      this._paperPending ||
      (this._paperDocument === data.document &&
        Date.now() - this._paperCheckedAt < PAPER_CHECK_INTERVAL)
    ) {
      return;
    }
    this._paperDocument = data.document;
    this._paperCheckedAt = Date.now();
    const version = this._paperVersion;
    this._paperPending = loadProjectPapers(this.contents, data.document)
      .then(papers => {
        if (
          this.isDisposed ||
          this._data?.document !== data.document ||
          this._paperVersion !== version
        ) {
          return;
        }
        // Preserve host-owned progress while a download overlaps a cache check.
        for (const [key, current] of Object.entries(this._data.papers)) {
          if (
            current.status === 'fetching' ||
            (current.status === 'error' && !papers[key]?.pdfUrl)
          ) {
            papers[key] = {
              ...current,
              ...papers[key],
              status: current.status,
              error: current.error
            };
          }
        }
        const changed =
          JSON.stringify(papers) !== JSON.stringify(this._data.papers);
        const recovered = this._paperError !== undefined;
        if (changed) {
          this._data = { ...this._data, papers };
        }
        this._paperError = undefined;
        if (changed || recovered) {
          this._changed.emit(this.state);
        }
      })
      .catch(error => {
        if (this.isDisposed || this._data?.document !== data.document) {
          return;
        }
        const message = `Paper cache: ${projectErrorMessage(error)}`;
        if (message !== this._paperError) {
          this._paperError = message;
          this._changed.emit(this.state);
        }
      })
      .finally(() => {
        this._paperPending = undefined;
      });
  }

  private async _fetchPaper(key: string): Promise<void> {
    const fetching: InventoryPaperMetadata = {
      ...this._data?.papers[key],
      status: 'fetching'
    };
    delete fetching.error;
    this._setPaperMetadata(key, fetching);
    try {
      const metadata = await fetchPaper(key, this.contents.serverSettings);
      this._paperVersion += 1;
      this._paperCheckedAt = 0;
      this._setPaperMetadata(key, { ...metadata, status: 'idle' });
    } catch (error) {
      this._setPaperMetadata(key, {
        ...this._data?.papers[key],
        status: 'error',
        error: projectErrorMessage(error)
      });
    }
  }

  private _setPaperMetadata(
    key: string,
    metadata: InventoryPaperMetadata
  ): void {
    if (!this._data || this.isDisposed) {
      return;
    }
    this._data = {
      ...this._data,
      papers: { ...this._data.papers, [key]: metadata }
    };
    this._changed.emit(this.state);
  }

  private _data: ILoadedProjectData | undefined;
  private _error: string | undefined;
  private _paperError: string | undefined;
  private _projectSnapshot = '';
  private _pendingUpdate: Promise<void> | undefined;
  private _paperPending: Promise<void> | undefined;
  private _paperDocument: ILoadedProjectData['document'] | undefined;
  private _paperCheckedAt = 0;
  private _paperVersion = 0;
  private readonly _paperFetches = new Map<string, Promise<void>>();
  private readonly _changed = new Signal<this, IProjectDataState>(this);
  private readonly _projectChanged = new Signal<this, ILoadedProjectData>(this);
  private readonly _disposed = new Signal<this, void>(this);
  private readonly _poll: Poll<void, unknown>;
}

interface IServiceRecord {
  references: number;
  service: ProjectDataService;
}

export interface IProjectDataLease {
  service: ProjectDataService;
  release(): void;
}

const services = new WeakMap<Contents.IManager, Map<string, IServiceRecord>>();
const observers = new WeakMap<
  Contents.IManager,
  Set<(service: ProjectDataService) => void>
>();

/**
 * Watch every shared service for a contents manager, including those already
 * live. Each service announces its own updates and disposal, so observers need
 * no registry bookkeeping of their own.
 */
export function observeProjectDataServices(
  contents: Contents.IManager,
  onService: (service: ProjectDataService) => void
): IDisposable {
  let watching = observers.get(contents);
  if (!watching) {
    watching = new Set();
    observers.set(contents, watching);
  }
  const registered = watching;
  registered.add(onService);
  for (const record of services.get(contents)?.values() ?? []) {
    onService(record.service);
  }
  return new DisposableDelegate(() => {
    registered.delete(onService);
  });
}

/** Acquire a shared service until this panel releases its lease. */
export function acquireProjectDataService(
  contents: Contents.IManager,
  entrypoint = 'astra.yaml',
  universeId?: string | null
): IProjectDataLease {
  const path = contents.normalize(entrypoint);
  let registry = services.get(contents);
  if (!registry) {
    registry = new Map<string, IServiceRecord>();
    services.set(contents, registry);
  }
  const key = JSON.stringify([
    path,
    universeId === undefined ? { auto: true } : universeId
  ]);
  let record = registry.get(key);
  if (!record) {
    record = {
      references: 0,
      // eslint-disable-next-line jupyter/require-disposable-ownership -- The registry disposes the service when its final lease is released.
      service: new ProjectDataService(contents, path, universeId)
    };
    registry.set(key, record);
    for (const observe of observers.get(contents) ?? []) {
      observe(record.service);
    }
  }
  const acquired = record;
  const byEntrypoint = registry;
  acquired.references += 1;
  let released = false;
  return {
    service: acquired.service,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      acquired.references -= 1;
      if (acquired.references === 0) {
        acquired.service.dispose();
        byEntrypoint.delete(key);
        if (!byEntrypoint.size) {
          services.delete(contents);
        }
      }
    }
  };
}
