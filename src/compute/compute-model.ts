import type { ServerConnection } from '@jupyterlab/services';
import type { IStateDB } from '@jupyterlab/statedb';
import type { IDisposable } from '@lumino/disposable';
import { Poll } from '@lumino/polling';
import { type ISignal, Signal } from '@lumino/signaling';
import {
  fetchCompute,
  type IClusterPreset,
  type IComputeListing,
  type IEndedCluster,
  startCluster,
  stopCluster
} from './compute-api';
import { offeredPresets } from './compute-presets';

/** How often the listing refreshes while the Compute section is shown. */
export const REFRESH_INTERVAL = 10000;

/** The state database key of the preset used last. */
export const LAST_PRESET_KEY = 'jupyterlab_lightcone:compute-last-preset';

export interface IComputeModelOptions {
  serverSettings: ServerConnection.ISettings;
  /** Remembers the preset used last across reloads, when present. */
  state?: IStateDB | null;
  /** Told once about each cluster that ended on its own while it was listed. */
  onEnded?: (cluster: IEndedCluster) => void;
}

/**
 * Where runs can go for the current project, refreshed while the Compute
 * section is visible, plus starting and stopping clusters. Clusters belong
 * to the user, not to a project: the project only decides which target is
 * active.
 */
export class ComputeModel implements IDisposable {
  constructor(options: IComputeModelOptions) {
    this._settings = options.serverSettings;
    this._state = options.state ?? null;
    this._onEnded = options.onEnded;
    this._poll = new Poll({
      auto: false,
      factory: () => this._load(),
      frequency: {
        interval: REFRESH_INTERVAL,
        backoff: true,
        max: 6 * REFRESH_INTERVAL
      },
      name: 'jupyterlab_lightcone:compute',
      standby: 'when-hidden'
    });
    void this._restoreLastPreset();
  }

  /** Emitted whenever the listing, an error, the presets or a pending action changes. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get listing(): IComputeListing | null {
    return this._listing;
  }

  /** Why the last refresh failed, or null. */
  get error(): string | null {
    return this._error;
  }

  /** Whether a start or stop is in flight. */
  get pending(): boolean {
    return this._pending;
  }

  get isDisposed(): boolean {
    return this._poll.isDisposed;
  }

  /** The presets from the Compute settings. */
  get presets(): readonly IClusterPreset[] {
    return this._presets;
  }

  set presets(presets: readonly IClusterPreset[]) {
    this._presets = presets;
    this._changed.emit();
  }

  /** The presets this server can start, the one used last first. */
  get offered(): IClusterPreset[] {
    return offeredPresets(
      this._presets,
      this._listing?.backends ?? [],
      this._lastPreset
    );
  }

  /** The current project's entrypoint; it decides which target is active. */
  get project(): string | null {
    return this._project;
  }

  set project(entrypoint: string | null) {
    if (entrypoint === this._project) {
      return;
    }
    this._project = entrypoint;
    void this.refresh();
  }

  /** Refresh on a schedule only while the section can be seen. */
  set visible(visible: boolean) {
    if (visible) {
      void this._poll.start();
    } else {
      void this._poll.stop();
    }
  }

  /** Read the listing now; failures stay in `error`. */
  async refresh(): Promise<void> {
    try {
      await this._load();
    } catch {
      // Already reported through `error`.
    }
  }

  /** Start a cluster from a preset and remember it as the last one used. */
  async start(preset: IClusterPreset): Promise<void> {
    await this._act(() => startCluster(this._settings, preset, this._project));
    this._lastPreset = preset.label;
    try {
      await this._state?.save(LAST_PRESET_KEY, preset.label);
    } catch (error) {
      console.warn('Could not remember the Lightcone cluster preset.', error);
    }
  }

  /** Ask a cluster's backend to end it. */
  async stop(id: string): Promise<void> {
    await this._act(() => stopCluster(this._settings, id));
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._poll.dispose();
    Signal.clearData(this);
  }

  private async _act(action: () => Promise<unknown>): Promise<void> {
    this._pending = true;
    this._changed.emit();
    try {
      await action();
    } finally {
      this._pending = false;
      await this.refresh();
    }
  }

  private async _load(): Promise<void> {
    const project = this._project;
    try {
      const listing = await fetchCompute(this._settings, project);
      if (project !== this._project || this.isDisposed) {
        return;
      }
      this._report(listing);
      this._listing = listing;
      this._error = null;
    } catch (error) {
      this._error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (!this.isDisposed) {
        this._changed.emit();
      }
    }
  }

  /** Report clusters listed before and ended since; each is listed alive only once. */
  private _report(listing: IComputeListing): void {
    for (const ended of listing.ended) {
      if (this._watched.has(ended.id)) {
        this._onEnded?.(ended);
      }
    }
    this._watched = new Set(
      listing.targets
        .filter(target => target.kind === 'cluster')
        .map(target => target.id)
    );
  }

  private async _restoreLastPreset(): Promise<void> {
    try {
      const saved = await this._state?.fetch(LAST_PRESET_KEY);
      if (typeof saved === 'string' && this._lastPreset === null) {
        this._lastPreset = saved;
        this._changed.emit();
      }
    } catch {
      // Only the ordering of the presets is lost.
    }
  }

  private readonly _settings: ServerConnection.ISettings;
  private readonly _state: IStateDB | null;
  private readonly _onEnded: ((cluster: IEndedCluster) => void) | undefined;
  private readonly _poll: Poll;
  private readonly _changed = new Signal<this, void>(this);
  private _listing: IComputeListing | null = null;
  private _error: string | null = null;
  private _pending = false;
  private _presets: readonly IClusterPreset[] = [];
  private _lastPreset: string | null = null;
  private _project: string | null = null;
  private _watched = new Set<string>();
}
