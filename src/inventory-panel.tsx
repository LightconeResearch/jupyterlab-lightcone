import type { CommandRegistry } from '@lumino/commands';
import {
  ReactWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import { listIcon } from '@jupyterlab/ui-components';
import { analysisTitle } from '@astra-spec/ui/model';
import { SurfaceHeader } from '@astra-spec/ui/primitives';
import { Inventory } from '@astra-spec/ui/views';
import type { DetailEntry } from '@astra-spec/ui/lib';
import React, { useId } from 'react';
import { flushSync } from 'react-dom';
import { useProjectRenderers } from './project-renderers';
import type { ILoadedProjectData } from './project-data';
import type { IProjectDataState } from './project-data-service';
import { ProjectSubscription } from './project-subscription';
import {
  detailEntryForOpenReference,
  type InventoryOpenReference
} from './open-reference';
import { ProjectTopbar } from './project-topbar';
import { LightconeThemeBinding } from './theme-adapter';

type InventoryPanelState =
  | { status: 'loading' }
  | {
      status: 'ready';
      data: ILoadedProjectData;
      entrypoint: string;
      analysisPath: string;
      detail: DetailEntry[];
      staleMessage?: string;
      paperError?: string;
    }
  | { status: 'error'; message: string };

export interface IInventoryDisplayRequest {
  analysisPath?: string;
  /** Legacy view-model scope id; `root` maps to the resolved `$` path. */
  scope?: string;
  /** Open this record's detail dialog once the inventory is shown. */
  openReference?: InventoryOpenReference;
}

function requestedAnalysisPath(
  data: ILoadedProjectData,
  request: IInventoryDisplayRequest,
  currentPath = '$'
): string {
  // Retain a selection only while it exists; explicit requests still validate.
  const retainedPath = data.index.analysisByPath.has(currentPath)
    ? currentPath
    : '$';
  const requested = request.analysisPath ?? request.scope ?? retainedPath;
  const canonical =
    request.analysisPath === undefined && request.scope === 'root'
      ? '$'
      : requested;
  if (data.index.analysisByPath.has(canonical)) return canonical;
  if (request.analysisPath === undefined && request.scope) {
    const byId = [...data.index.analysisByPath.values()].find(
      analysis => analysis.id === request.scope
    );
    if (byId) return byId.canonicalPath;
  }
  throw new Error(`No ASTRA analysis exists at "${requested}".`);
}

function readyState(
  data: ILoadedProjectData,
  entrypoint: string,
  request: IInventoryDisplayRequest,
  current?: Extract<InventoryPanelState, { status: 'ready' }>
): Extract<InventoryPanelState, { status: 'ready' }> {
  const analysisPath = requestedAnalysisPath(
    data,
    request,
    current?.analysisPath
  );
  const requestedDetail = request.openReference
    ? detailEntryForOpenReference(
        data.index,
        request.openReference,
        analysisPath
      )
    : undefined;
  return {
    status: 'ready',
    data,
    entrypoint,
    analysisPath,
    detail: requestedDetail
      ? [requestedDetail]
      : current?.analysisPath === analysisPath
        ? current.detail
        : []
  };
}

function ReadyInventoryView({
  commands,
  contents,
  onDetailChange,
  onFetchPaper,
  onSelectAnalysis,
  state
}: {
  commands: CommandRegistry;
  contents: Contents.IManager;
  onDetailChange: (detail: DetailEntry[]) => void;
  onFetchPaper: (doi: string) => void;
  onSelectAnalysis: (analysisPath: string) => void;
  state: Extract<InventoryPanelState, { status: 'ready' }>;
}): React.ReactElement {
  const inventoryId = useId().replace(/:/g, '');
  const renderers = useProjectRenderers(
    contents,
    state.entrypoint,
    state.data,
    onFetchPaper,
    commands
  );
  const activeAnalysis = state.data.index.analysisByPath.get(
    state.analysisPath
  );

  return (
    <main className="jp-jupyterlab-lightcone-inventory-page">
      <ProjectTopbar projectName={state.data.document.analysis.name} />
      {state.staleMessage ? (
        <div className="jp-jupyterlab-lightcone-refresh-warning" role="status">
          Showing the last valid project data: {state.staleMessage}
        </div>
      ) : null}
      {state.paperError ? (
        <div className="jp-jupyterlab-lightcone-refresh-warning" role="status">
          Paper metadata is unavailable: {state.paperError}
        </div>
      ) : null}
      <div className="jp-jupyterlab-lightcone-inventory-main">
        <SurfaceHeader
          className="jp-jupyterlab-lightcone-inventory-header"
          eyebrow="ASTRA inventory"
          title={analysisTitle(activeAnalysis ?? state.data.document.analysis)}
          titleAs="h1"
          actions={
            <label className="jp-jupyterlab-lightcone-analysis-selector">
              <span>Analysis</span>
              <select
                value={state.analysisPath}
                onChange={event => onSelectAnalysis(event.target.value)}
              >
                {[...state.data.index.analysisByPath.values()].map(analysis => (
                  <option
                    key={analysis.canonicalPath}
                    value={analysis.canonicalPath}
                  >
                    {analysis.canonicalPath === '$'
                      ? analysisTitle(analysis)
                      : `${analysis.canonicalPath}: ${analysisTitle(analysis)}`}
                  </option>
                ))}
              </select>
            </label>
          }
        />
        <Inventory
          className="jp-jupyterlab-lightcone-inventory-content"
          {...renderers}
          onOpenArtifact={async output => {
            // Let the dialog restore focus before Jupyter activates the file tab.
            flushSync(() => onDetailChange([]));
            try {
              await renderers.onOpenArtifact?.(output);
            } catch (reason) {
              await showErrorMessage('Could not open artifact', String(reason));
            }
          }}
          idPrefix={`${inventoryId}-`}
          analysisPath={state.analysisPath}
          onSelectAnalysis={onSelectAnalysis}
          detail={state.detail}
          onDetailChange={onDetailChange}
        />
      </div>
    </main>
  );
}

function InventoryPanelView({
  commands,
  contents,
  onDetailChange,
  onFetchPaper,
  onSelectAnalysis,
  state
}: {
  commands: CommandRegistry;
  contents: Contents.IManager;
  onDetailChange: (detail: DetailEntry[]) => void;
  onFetchPaper: (doi: string) => void;
  onSelectAnalysis: (analysisPath: string) => void;
  state: InventoryPanelState;
}): React.ReactElement {
  if (state.status === 'loading') {
    return (
      <div
        className="jp-jupyterlab-lightcone-inventory-message"
        aria-live="polite"
      >
        <span>ASTRA inventory</span>
        <p>Loading the project inventory…</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div
        className="jp-jupyterlab-lightcone-inventory-message is-error"
        role="alert"
      >
        <span>Could not open ASTRA inventory</span>
        <p>{state.message}</p>
      </div>
    );
  }
  return (
    <ReadyInventoryView
      commands={commands}
      contents={contents}
      state={state}
      onDetailChange={onDetailChange}
      onSelectAnalysis={onSelectAnalysis}
      onFetchPaper={onFetchPaper}
    />
  );
}

export class AstraInventoryPanel extends ReactWidget {
  constructor(
    private readonly contents: Contents.IManager,
    themeManager: IThemeManager,
    private readonly commands: CommandRegistry
  ) {
    super();
    this.title.label = 'ASTRA Inventory';
    this.title.caption = 'ASTRA project inventory';
    this.title.icon = listIcon;
    this.title.closable = true;
    this.addClass('jp-jupyterlab-lightcone-InventoryPanel');
    this.addClass('astra-ui');
    this.addClass('astra-isolate');
    this.addClass('lightcone-brand');
    this._themeBinding = new LightconeThemeBinding(themeManager, this.node);
    this._subscription = new ProjectSubscription(contents, state =>
      this._onProjectDataChanged(state)
    );
  }

  async display(
    request: IInventoryDisplayRequest = {},
    entrypoint = 'astra.yaml'
  ): Promise<{ view: 'inventory'; analysisPath: string }> {
    this._request = request;
    if (entrypoint !== this._entrypoint) this._state = { status: 'loading' };
    this._entrypoint = entrypoint;
    const state = await this._subscription.bind(entrypoint);
    if (!state)
      return { view: 'inventory', analysisPath: request.analysisPath ?? '$' };
    this._onProjectDataChanged(state);
    if (this._state.status !== 'ready') {
      throw new Error(
        this._state.status === 'error'
          ? this._state.message
          : 'The project is still loading.'
      );
    }
    return { view: 'inventory', analysisPath: this._state.analysisPath };
  }

  refresh(): Promise<void> {
    return this._subscription.refresh();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._subscription.dispose();
    this._themeBinding.dispose();
    super.dispose();
  }

  private _onProjectDataChanged(state: IProjectDataState): void {
    if (!state.data) {
      this._setState(
        state.error
          ? { status: 'error', message: state.error }
          : { status: 'loading' }
      );
      return;
    }
    try {
      const ready = readyState(
        state.data,
        this._entrypoint,
        this._request,
        this._state.status === 'ready' ? this._state : undefined
      );
      // Consume an external open request once; polling preserves the current stack.
      this._request = {};
      this._setState({
        ...ready,
        staleMessage: state.error,
        paperError: state.paperError
      });
    } catch (error) {
      this._setState({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Project refresh failed'
      });
    }
  }

  private _setState(state: InventoryPanelState): void {
    this._state = state;
    this.update();
  }

  protected render(): React.ReactElement {
    return (
      <InventoryPanelView
        commands={this.commands}
        contents={this.contents}
        state={this._state}
        onDetailChange={detail => {
          if (this._state.status === 'ready') {
            this._setState({ ...this._state, detail });
          }
        }}
        onSelectAnalysis={analysisPath => {
          this._request = {};
          if (this._state.status === 'ready') {
            this._setState({ ...this._state, analysisPath, detail: [] });
          }
        }}
        onFetchPaper={doi => {
          void this._subscription.fetchPaper(doi);
        }}
      />
    );
  }

  private _entrypoint = 'astra.yaml';
  private _request: IInventoryDisplayRequest = {};
  private readonly _subscription: ProjectSubscription;
  private _state: InventoryPanelState = { status: 'loading' };
  private readonly _themeBinding: LightconeThemeBinding;
}
