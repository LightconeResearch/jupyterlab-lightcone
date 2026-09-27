import React, { useEffect, useState } from 'react';
import {
  showErrorMessage,
  ReactWidget,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import {
  PaperDetail,
  PaperDialogActions,
  DecisionDetail,
  OutputDetail,
  OutputDialogActions,
  FindingDetail,
  InputDetail,
  InsightDetail
} from '@astra-spec/ui/components';
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogHeader,
  Button
} from '@astra-spec/ui/primitives';
import {
  recordTitle,
  analysisTitle,
  decisionInsights,
  outputRelations,
  findingEvidence,
  informedDecisions,
  primaryLiteratureEvidence,
  isInsight
} from '@astra-spec/ui/model';
import type { ResolvedRecord } from '@astra-spec/sdk';
import {
  acquireProjectDataService,
  type IProjectDataState
} from './project-data-service';
import {
  resolveReference,
  type IElementReference,
  type IProjectContext
} from './element-reference';
import { useProjectRenderers } from './project-renderers';
import { LightconeThemeBinding } from './theme-adapter';
import { CommandIDs } from './commands';
import { astraIcon } from './icons';
import { ELEMENT_TAB_DATASET_KEY } from './workbench-ids';

/** Share project resolution with every tab and visible chat card. */
export function useProject(
  contents: Contents.IManager,
  context: IProjectContext
): IProjectDataState & { fetchPaper: (doi: string) => void } {
  const [state, setState] = useState<IProjectDataState>({
    data: undefined,
    error: undefined
  });
  const [fetchPaper, setFetch] = useState<(doi: string) => void>(
    () => () => undefined
  );
  useEffect(() => {
    const lease = acquireProjectDataService(
      contents,
      context.entrypoint,
      context.universeId
    );
    let active = true;
    const update = () => {
      if (active) setState(lease.service.state);
    };
    lease.service.changed.connect(update);
    setFetch(() => (doi: string) => {
      void lease.service.fetchPaper(doi);
    });
    update();
    void lease.service.get().then(update, update);
    return () => {
      active = false;
      lease.service.changed.disconnect(update);
      lease.release();
    };
  }, [contents, context.entrypoint, context.universeId]);
  return { ...state, fetchPaper };
}

interface IDetailProps {
  widget: ElementWidget;
  contents: Contents.IManager;
  commands: CommandRegistry;
}

function Detail({
  widget,
  contents,
  commands
}: IDetailProps): React.ReactElement {
  const state = useProject(contents, widget.reference);
  return (
    <main className="jp-jupyterlab-lightcone-element">
      {state.error && (
        <p className="jp-jupyterlab-lightcone-refresh-warning" role="status">
          Showing last valid data, if available: {state.error}
        </p>
      )}
      {state.paperError && (
        <p role="status">Paper metadata is unavailable: {state.paperError}</p>
      )}
      {state.data ? (
        <DetailBody
          key={widget.identity}
          widget={widget}
          contents={contents}
          commands={commands}
          data={state.data}
          fetchPaper={state.fetchPaper}
        />
      ) : (
        <p className="jp-jupyterlab-lightcone-element-message" role="status">
          {state.error ?? 'Loading ASTRA element…'}
        </p>
      )}
    </main>
  );
}

function DetailBody({
  widget,
  contents,
  commands,
  data,
  fetchPaper
}: IDetailProps & {
  data: NonNullable<IProjectDataState['data']>;
  fetchPaper: (doi: string) => void;
}): React.ReactElement {
  const reference = widget.reference;
  const renderers = useProjectRenderers(
    contents,
    reference.entrypoint,
    data,
    fetchPaper,
    commands
  );
  const [expanded, setExpanded] = useState(false);
  let resolved: ReturnType<typeof resolveReference> | undefined;
  try {
    resolved = resolveReference(data, reference);
  } catch {
    /* Keep a removed record visible as unavailable. */
  }
  const record = resolved?.record;
  const paper = resolved?.paper;
  const label = record ? recordTitle(record) : paper?.title;
  useEffect(() => {
    if (label) widget.title.label = label;
  }, [widget, label]);
  const open = (next: ResolvedRecord) => {
    void commands
      .execute(CommandIDs.openElement, {
        ...reference,
        doi: undefined,
        focusInsightPath: undefined,
        target: next.canonicalPath,
        sourceWidgetId: widget.tabId
      })
      .catch(reason =>
        showErrorMessage('Could not open ASTRA element', reason)
      );
  };
  let body: React.ReactNode;
  let actions: React.ReactNode;
  if (paper) {
    const focus = reference.focusInsightPath
      ? data.index.recordByPath.get(reference.focusInsightPath)
      : undefined;
    body = (
      <PaperDetail
        record={paper}
        metadata={data.papers[paper.doi]}
        focusInsight={isInsight(focus) ? focus : undefined}
        loadPdfJs={renderers.loadPdfJs}
        onFetchPaper={fetchPaper}
        onOpenInsight={open}
        onOpenDecision={open}
      />
    );
    actions = <PaperDialogActions record={paper} />;
  } else if (record) {
    switch (record.kind) {
      case 'output':
        body = (
          <OutputDetail
            record={record}
            relations={outputRelations(data.index, record)}
            renderArtifact={renderers.renderArtifact}
            renderCodeLink={renderers.renderCodeLink}
            onOpenRecord={open}
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
        );
        actions = (
          <OutputDialogActions
            record={record}
            onOpenArtifact={
              data.bindings.some(
                binding => binding.outputPath === record.canonicalPath
              )
                ? renderers.onOpenArtifact
                : undefined
            }
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
        );
        break;
      case 'decision':
        body = (
          <DecisionDetail
            record={record}
            insights={decisionInsights(data.index, record)}
            onOpenInsight={open}
          />
        );
        break;
      case 'finding':
        body = (
          <FindingDetail
            record={record}
            evidence={findingEvidence(data.index, record)}
            onOpenRecord={open}
          />
        );
        break;
      case 'input':
        body = <InputDetail record={record} />;
        break;
      case 'prior_insight': {
        const doi = primaryLiteratureEvidence(record)?.doi;
        body = (
          <InsightDetail
            record={record}
            decisions={informedDecisions(data.document, record)}
            onOpenDecision={open}
            onOpenSource={
              doi
                ? () => {
                    void commands
                      .execute(CommandIDs.openElement, {
                        ...reference,
                        target: '',
                        doi,
                        focusInsightPath: record.canonicalPath,
                        sourceWidgetId: widget.tabId
                      })
                      .catch(reason =>
                        showErrorMessage('Could not open cited paper', reason)
                      );
                  }
                : undefined
            }
          />
        );
        break;
      }
    }
  } else {
    body = (
      <p className="jp-jupyterlab-lightcone-element-message" role="status">
        This ASTRA element is no longer available:{' '}
        {reference.doi ?? reference.target}
      </p>
    );
  }
  const kind = record?.kind ?? (paper ? 'paper' : 'analysis');
  const kindLabel =
    record?.kind === 'output'
      ? record.type
      : kind === 'prior_insight'
        ? 'Prior insight'
        : kind;
  const reader =
    kind === 'paper' ||
    (record?.kind === 'output' && ['figure', 'table'].includes(record.type));
  return (
    <>
      <div className="jp-jupyterlab-lightcone-element-toolbar">
        <div
          className="jp-jupyterlab-lightcone-element-context"
          title={reference.entrypoint}
        >
          <span>{data.document.analysis.name}</span>
          {resolved?.analysis.canonicalPath !== '$' && resolved?.analysis && (
            <span>{analysisTitle(resolved.analysis)}</span>
          )}
          <span className="jp-jupyterlab-lightcone-element-universe">
            Universe: {reference.universeId ?? 'defaults'}
          </span>
        </div>
        <Button
          size="small"
          aria-pressed={widget.isPinned}
          onClick={() => {
            void commands
              .execute(
                widget.isPinned
                  ? CommandIDs.unpinElement
                  : CommandIDs.pinElement,
                { widgetId: widget.tabId }
              )
              .catch(reason =>
                showErrorMessage('Could not change ASTRA tab pin state', reason)
              );
          }}
        >
          <span
            className="jp-jupyterlab-lightcone-pin-icon"
            aria-hidden="true"
          />
          {widget.isPinned ? 'Unpin tab' : 'Pin tab'}
        </Button>
      </div>
      <div
        className="jp-jupyterlab-lightcone-element-content"
        data-reader={reader}
        data-kind={kind}
      >
        <Dialog
          // The native dialog's top layer escapes Lumino's strict containment.
          mode={expanded ? 'modal' : 'embedded'}
          onOpenChange={setExpanded}
          kind={kind}
          layout={reader ? 'reader' : 'single'}
        >
          <DialogContent>
            <DialogHeader
              showCloseButton={false}
              kindLabel={kindLabel}
              title={label ?? widget.title.label}
              titleAs="h1"
              identifier={reference.doi ?? reference.target}
              actions={actions}
            />
            <DialogBody>{body}</DialogBody>
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
}

/** Native ASTRA view with replaceable content and an explicit user-owned pin. */
export class ElementWidget extends ReactWidget {
  constructor(
    public reference: IElementReference,
    private contents: Contents.IManager,
    themes: IThemeManager,
    private commands: CommandRegistry,
    public identity: string,
    readonly tabId: string,
    private _isPinned = false
  ) {
    super();
    this.addClass('jp-jupyterlab-lightcone-ElementWidget');
    this.addClass('astra-ui');
    this.addClass('astra-isolate');
    this.addClass('lightcone-brand');
    this.title.icon = astraIcon;
    this.title.dataset = { [ELEMENT_TAB_DATASET_KEY]: tabId };
    this._syncPin();
    this._theme = new LightconeThemeBinding(themes, this.node);
  }

  get isPinned(): boolean {
    return this._isPinned;
  }

  /** Update retention without changing the displayed record or its live data. */
  setPinned(pinned: boolean): void {
    this._isPinned = pinned;
    this._syncPin();
    this.update();
  }

  /** Replace an unpinned preview, or navigate within the same retained owner. */
  display(reference: IElementReference, identity: string, label: string): void {
    if (this.isPinned && identity !== this.identity)
      throw new Error('Cannot replace a pinned ASTRA tab.');
    this.reference = reference;
    this.identity = identity;
    this.title.label = label;
    this.title.caption = `${reference.entrypoint} · ${reference.universeId ?? 'defaults'} · ${reference.doi ?? reference.target}`;
    this.update();
  }

  render(): React.ReactElement {
    return (
      <Detail widget={this} contents={this.contents} commands={this.commands} />
    );
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._theme.dispose();
    super.dispose();
  }

  private _syncPin(): void {
    const classes = this.title.className
      .split(' ')
      .filter(
        name =>
          name &&
          name !== 'jp-jupyterlab-lightcone-preview-tab' &&
          name !== 'jp-jupyterlab-lightcone-pinned-tab'
      );
    classes.push(
      this.isPinned
        ? 'jp-jupyterlab-lightcone-pinned-tab'
        : 'jp-jupyterlab-lightcone-preview-tab'
    );
    this.title.className = classes.join(' ');
  }
  private _theme: LightconeThemeBinding;
}
