import { ReactWidget, type IThemeManager } from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { DetailEntry } from '@astra-spec/ui/components';
import { Inventory } from '@astra-spec/ui/views';
import React from 'react';
import { useProjectRenderers } from './project-renderers';
import {
  detailEntryForOpenReference,
  publicationReference,
  publicationUrl,
  type InventoryOpenReference
} from './open-reference';
import type { ILoadedProjectData } from './project-data';
import type { IProjectDataState } from './project-data-service';
import { ProjectSubscription } from './project-subscription';
import { LightconeThemeBinding } from './theme-adapter';

/** The local MyST development server used when no deployed URL is supplied. */
export const DEFAULT_PAPER_URL = 'http://localhost:3111';

function PaperDialogs({
  contents,
  entrypoint,
  data,
  detail,
  onDetailChange,
  onFetchPaper
}: {
  contents: Contents.IManager;
  entrypoint: string;
  data: ILoadedProjectData;
  detail: DetailEntry[];
  onDetailChange: (detail: DetailEntry[]) => void;
  onFetchPaper: (doi: string) => void;
}) {
  const renderers = useProjectRenderers(
    contents,
    entrypoint,
    data,
    onFetchPaper
  );
  return (
    <Inventory
      className="jp-jupyterlab-lightcone-PaperPanel-dialogs"
      sections={[]}
      showOutline={false}
      {...renderers}
      detail={detail}
      onDetailChange={onDetailChange}
    />
  );
}

export interface IPaperPanelOptions {
  url?: string;
}

/**
 * Embed the MyST publication and render ASTRA record dialogs in JupyterLab.
 * The publication's stable `astra:open-reference` message is translated to
 * the resolved-analysis detail contract owned by @astra-spec/ui.
 */
export class PaperPanel extends ReactWidget {
  constructor(
    private readonly contents: Contents.IManager,
    themeManager: IThemeManager,
    options: IPaperPanelOptions = {}
  ) {
    super();
    this.addClass('jp-jupyterlab-lightcone-PaperPanel');
    this.addClass('astra-ui');
    this.addClass('lightcone-brand');
    this._url = publicationUrl(
      options.url ?? DEFAULT_PAPER_URL,
      window.location.href
    );
    this._themeBinding = new LightconeThemeBinding(themeManager, this.node);
    this._subscription = new ProjectSubscription(contents, state =>
      this._onProjectDataChanged(state)
    );
    this._onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== this._url.origin) return;
      const frameWindow = this._frame.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const reference = publicationReference(event.data);
      if (reference) this._openReference(reference);
    };
    window.addEventListener('message', this._onMessage);
  }

  get url(): string {
    return this._url.href;
  }

  get entrypoint(): string {
    return this._entrypoint;
  }

  /** Navigate an existing publication panel without retaining old dialogs. */
  setUrl(value: string): void {
    const url = publicationUrl(value, window.location.href);
    if (url.href === this.url) {
      return;
    }
    this._url = url;
    this._detail = [];
    this._pendingReference = undefined;
    this._referenceError = undefined;
    this.update();
  }

  /** Bind the panel's dialogs to the project at this entrypoint. */
  display(entrypoint = 'astra.yaml'): void {
    if (entrypoint !== this._entrypoint) {
      this._data = undefined;
      this._detail = [];
      this._pendingReference = undefined;
      this._referenceError = undefined;
      this._dataError = undefined;
      this._paperError = undefined;
    }
    this._entrypoint = entrypoint;
    void this._subscription.bind(entrypoint);
  }

  dispose(): void {
    if (this.isDisposed) return;
    window.removeEventListener('message', this._onMessage);
    this._subscription.dispose();
    this._themeBinding.dispose();
    super.dispose();
  }

  protected render(): React.ReactElement {
    const data = this._data;
    const notice =
      this._referenceError ??
      (this._dataError
        ? `${data ? 'Showing the last valid ASTRA project' : 'ASTRA references are unavailable'}: ${this._dataError}`
        : this._pendingReference && !data
          ? 'Loading the ASTRA project…'
          : this._paperError);
    return (
      <div className="jp-jupyterlab-lightcone-PaperPanel-stage">
        <div className="jp-jupyterlab-lightcone-PaperPanel-toolbar">
          <span>MyST Paper</span>
          <a href={this.url} target="_blank" rel="noopener noreferrer">
            Open publication ↗
          </a>
          <span>
            If the preview is blank, check that the publication server is
            running.
          </span>
        </div>
        <iframe
          key={this.url}
          ref={this._frame}
          className="jp-jupyterlab-lightcone-PaperPanel-frame"
          src={this.url}
          title="MyST publication"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
        {data ? (
          <PaperDialogs
            contents={this.contents}
            entrypoint={this._entrypoint}
            data={data}
            detail={this._detail}
            onDetailChange={detail => {
              this._detail = detail;
              this.update();
            }}
            onFetchPaper={doi => {
              void this._subscription.fetchPaper(doi);
            }}
          />
        ) : null}
        {notice ? (
          <div
            className="jp-jupyterlab-lightcone-PaperPanel-notice"
            role="status"
          >
            {notice}
          </div>
        ) : null}
      </div>
    );
  }

  private _openReference(reference: InventoryOpenReference): void {
    this._pendingReference = reference;
    this._referenceError = undefined;
    if (this._data) this._applyPendingReference();
    this.update();
  }

  private _applyPendingReference(): void {
    if (!this._data || !this._pendingReference) return;
    const entry = detailEntryForOpenReference(
      this._data.index,
      this._pendingReference
    );
    this._pendingReference = undefined;
    if (entry) {
      this._detail = [entry];
      this._referenceError = undefined;
    } else {
      this._detail = [];
      this._referenceError = 'The referenced ASTRA record was not found.';
    }
  }

  private _onProjectDataChanged(state: IProjectDataState): void {
    this._data = state.data;
    this._dataError = state.error;
    this._paperError = state.paperError;
    this._applyPendingReference();
    this.update();
  }

  private _url: URL;
  private readonly _frame = React.createRef<HTMLIFrameElement>();
  private readonly _onMessage: (event: MessageEvent<unknown>) => void;
  private readonly _themeBinding: LightconeThemeBinding;
  private _data: ILoadedProjectData | undefined;
  private _dataError: string | undefined;
  private _paperError: string | undefined;
  private _detail: DetailEntry[] = [];
  private _entrypoint = 'astra.yaml';
  private _pendingReference: InventoryOpenReference | undefined;
  private _referenceError: string | undefined;
  private readonly _subscription: ProjectSubscription;
}
