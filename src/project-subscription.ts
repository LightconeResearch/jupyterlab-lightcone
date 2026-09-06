import type { Contents } from '@jupyterlab/services';
import { projectErrorMessage } from './project-data';
import {
  acquireProjectDataService,
  type IProjectDataLease,
  type ProjectDataService,
  type IProjectDataState
} from './project-data-service';

/** Own one panel's subscription and suppress delivery after rebinding/disposal. */
export class ProjectSubscription {
  constructor(
    private readonly contents: Contents.IManager,
    private readonly onChange: (state: IProjectDataState) => void
  ) {}

  get state(): IProjectDataState {
    return this._lease?.service.state ?? { data: undefined, error: undefined };
  }

  /** Bind to a project, reusing shared data when it is already available. */
  async bind(entrypoint: string): Promise<IProjectDataState | undefined> {
    if (this._disposed) {
      return undefined;
    }
    const generation = ++this._generation;
    const path = this.contents.normalize(entrypoint);
    if (this._lease?.service.entrypoint !== path) {
      this._disconnect();
      this._lease = acquireProjectDataService(this.contents, path);
      this._lease.service.changed.connect(this._onChanged, this);
      this._published = undefined;
    }
    const service = this._lease.service;
    this._publish(service.state);
    try {
      await service.get();
    } catch (error) {
      if (generation !== this._generation || this._disposed) {
        return undefined;
      }
      const state = {
        ...service.state,
        error: service.state.error ?? projectErrorMessage(error)
      };
      this._publish(state);
      return state;
    }
    if (generation !== this._generation || this._disposed) {
      return undefined;
    }
    this._publish(service.state);
    return service.state;
  }

  async refresh(): Promise<void> {
    const generation = this._generation;
    try {
      await this._lease?.service.refresh();
    } catch (error) {
      if (!this._disposed && generation === this._generation) {
        this._publish({ ...this.state, error: projectErrorMessage(error) });
      }
    }
  }

  fetchPaper(doi: string): Promise<void> {
    return this._lease?.service.fetchPaper(doi) ?? Promise.resolve();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._generation += 1;
    this._disconnect();
  }

  private _disconnect(): void {
    this._lease?.service.changed.disconnect(this._onChanged, this);
    this._lease?.release();
    this._lease = undefined;
  }

  private _onChanged(
    sender: ProjectDataService,
    state: IProjectDataState
  ): void {
    if (sender === this._lease?.service) {
      this._publish(state);
    }
  }

  private _publish(state: IProjectDataState): void {
    if (
      this._disposed ||
      (this._published &&
        this._published.data === state.data &&
        this._published.error === state.error &&
        this._published.paperError === state.paperError)
    ) {
      return;
    }
    this._published = state;
    this.onChange(state);
  }

  private _lease: IProjectDataLease | undefined;
  private _published: IProjectDataState | undefined;
  private _generation = 0;
  private _disposed = false;
}
