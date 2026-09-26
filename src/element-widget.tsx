import type { IDocumentOpener } from './artifact-access';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import {
  showErrorMessage,
  ReactWidget,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { CommandRegistry } from '@lumino/commands';
import type { Message } from '@lumino/messaging';
import { Signal, type ISignal } from '@lumino/signaling';
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
import type { ResolvedOutput, ResolvedRecord } from '@astra-spec/sdk';
import type { IProjectDataState } from './project-data-service';
import { useProject } from './project-data-hooks';
import { resolveReference, type IElementReference } from './element-reference';
import { useProjectRenderers } from './project-renderers';
import type { ILoadedProjectData } from './project-data';
import {
  outputMaterializationStatus,
  useMaterializationStatus
} from './materialization-status';
import { JupyterOutputProvenance } from './output-provenance';
import {
  useOutputVersioning,
  VersionBar,
  VersionedArtifact,
  VersionRail
} from './versions/versioned-output';
import { AstraKindMark } from './astra-kind';
import { LightconeThemeBinding } from './theme-adapter';
import { CommandIDs } from './commands';
import { astraIcon } from './icons';
import { ELEMENT_TAB_DATASET_KEY } from './workbench-ids';
import {
  canGoBack,
  canGoForward,
  currentEntry,
  ElementHistoryCommandIDs,
  EMPTY_HISTORY,
  goToHistory,
  historyCaption,
  historyTrail,
  pushHistory,
  rememberScroll,
  selectEntryVersion,
  stepHistory,
  type IElementHistory
} from './versions/element-history';
import { Chevron } from './versions/chevron';
import { renderKeepingFocus } from './versions/focus-restore';
import { restoreScrollOffset } from './versions/scroll-restore';
/**
 * The controls ASTRA UI renders to open another record. A middle click on
 * one of them opens that record beside this tab instead of navigating it.
 */
const RECORD_TRIGGERS = [
  '.astra-relation-list__trigger',
  '.astra-insight-trigger',
  '.astra-paper-insight__open',
  '.astra-paper-decisions__open',
  '.astra-insight-detail__open-source',
  '[data-slot="output-card"]',
  '[data-slot="output-entry"]',
  '[data-slot="record-list"] .astra-record-list__body > button'
].join(', ');

interface IDetailProps {
  documents: IDocumentOpener;
  widget: ElementWidget;
  contents: Contents.IManager;
  commands: CommandRegistry;
}

function Detail({
  widget,
  contents,
  commands,
  documents
}: IDetailProps): React.ReactElement {
  const state = useProject(contents, widget.reference);
  // A modifier or middle click on a record link asks for a new tab; the
  // flag lives only for the duration of that click's dispatch.
  const newTab = useRef(false);
  return (
    <main
      className="jp-jupyterlab-lightcone-element"
      onClickCapture={event => {
        if (event.ctrlKey || event.metaKey) newTab.current = true;
      }}
      onClick={() => {
        newTab.current = false;
      }}
      onAuxClickCapture={event => {
        if (event.button !== 1 || !(event.target instanceof Element)) return;
        const trigger = event.target.closest<HTMLElement>(RECORD_TRIGGERS);
        if (!trigger || !event.currentTarget.contains(trigger)) return;
        event.preventDefault();
        newTab.current = true;
        try {
          trigger.click();
        } finally {
          newTab.current = false;
        }
      }}
    >
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
          documents={documents}
          data={state.data}
          fetchPaper={state.fetchPaper}
          wantsNewTab={() => newTab.current}
        />
      ) : (
        <p className="jp-jupyterlab-lightcone-element-message" role="status">
          {state.error ?? 'Loading ASTRA element…'}
        </p>
      )}
    </main>
  );
}

/** Back, Forward and the trail of references this tab has shown. */
function HistoryControls({
  widget
}: {
  widget: ElementWidget;
}): React.ReactElement {
  const { crumbs, elided } = historyTrail(widget.history);
  return (
    <div
      className="jp-jupyterlab-lightcone-element-nav"
      role="group"
      aria-label="Tab history"
    >
      <Button
        size="small"
        variant="quiet"
        aria-label="Back"
        title="Back (Alt+←)"
        disabled={!widget.canGoBack}
        onClick={() => widget.back()}
      >
        <Chevron direction="back" />
      </Button>
      <Button
        size="small"
        variant="quiet"
        aria-label="Forward"
        title="Forward (Alt+→)"
        disabled={!widget.canGoForward}
        onClick={() => widget.forward()}
      >
        <Chevron direction="forward" />
      </Button>
      {crumbs.length > 1 && (
        <nav
          className="jp-jupyterlab-lightcone-element-trail"
          aria-label="Records shown in this tab"
        >
          {elided > 0 && <span aria-hidden="true">…</span>}
          {crumbs.map(crumb => (
            <React.Fragment key={crumb.index}>
              {(crumb.index > crumbs[0].index || elided > 0) && (
                <span aria-hidden="true">›</span>
              )}
              {crumb.current ? (
                <span aria-current="page" title={crumb.label}>
                  {crumb.kind && <AstraKindMark kind={crumb.kind} />}
                  {crumb.identifier}
                </span>
              ) : (
                <button
                  type="button"
                  title={crumb.label}
                  onClick={() => widget.go(crumb.index)}
                >
                  {crumb.kind && <AstraKindMark kind={crumb.kind} />}
                  {crumb.identifier}
                </button>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}
    </div>
  );
}

interface IOutputRecordDetailProps {
  documents: IDocumentOpener;
  widget: ElementWidget;
  contents: Contents.IManager;
  data: ILoadedProjectData;
  record: ResolvedOutput;
  renderers: ReturnType<typeof useProjectRenderers>;
  open: (next: ResolvedRecord) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

/** An output with its materialization status, version history and provenance. */
function OutputRecordDetail({
  documents,
  widget,
  contents,
  data,
  record,
  renderers,
  open,
  expanded,
  onExpandedChange
}: IOutputRecordDetailProps): React.ReactElement {
  const entrypoint = widget.reference.entrypoint;
  const materialization = useMaterializationStatus(
    contents,
    entrypoint,
    data.document
  );
  const status = outputMaterializationStatus(
    materialization.statuses,
    data,
    record
  );
  // The tab owns the selected version: an open naming a version, the
  // stepper and the history all move the same selection.
  const selectVersion = useCallback(
    (commit: string | undefined) => widget.selectVersion(commit),
    [widget]
  );
  const versioning = useOutputVersioning(
    contents,
    entrypoint,
    data,
    record,
    status,
    widget.selectedVersion,
    selectVersion
  );
  const universe = data.document.universe.universeId;
  return (
    <div className="jp-jupyterlab-lightcone-VersionedOutput">
      <VersionBar versioning={versioning} output={record} />
      <OutputDetail
        record={record}
        relations={outputRelations(data.index, record)}
        renderArtifact={(output, options) => (
          <VersionedArtifact
            versioning={versioning}
            output={output}
            compact={options.compact}
            current={renderers.renderArtifact?.(output, options) ?? null}
          />
        )}
        renderCodeLink={renderers.renderCodeLink}
        renderProvenance={output => (
          <>
            <VersionRail versioning={versioning} output={output} />
            {versioning.selected && !versioning.shown ? null : (
              <JupyterOutputProvenance
                key={`${entrypoint}:${universe}:${output.canonicalPath}`}
                contents={contents}
                entrypoint={entrypoint}
                universe={universe}
                index={data.index}
                output={output}
                status={status}
                version={versioning.shown}
                documents={documents}
                onOpenRecord={open}
              />
            )}
          </>
        )}
        onOpenRecord={open}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      />
    </div>
  );
}

function DetailBody({
  documents,
  widget,
  contents,
  commands,
  data,
  fetchPaper,
  wantsNewTab
}: IDetailProps & {
  data: NonNullable<IProjectDataState['data']>;
  fetchPaper: (doi: string) => void;
  wantsNewTab: () => boolean;
}): React.ReactElement {
  const reference = widget.reference;
  const renderers = useProjectRenderers(
    contents,
    reference.entrypoint,
    data,
    fetchPaper,
    documents
  );
  const [expanded, setExpanded] = useState(false);
  // The body remounts for every record shown; one the tab comes back to
  // resumes where it was scrolled when the tab left it.
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = content.current;
    return element ? widget.mountContent(element) : undefined;
  }, [widget]);
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
    if (label) widget.setLabel(label);
  }, [widget, label]);
  const open = (next: ResolvedRecord) => {
    void commands
      .execute(CommandIDs.openElement, {
        ...reference,
        doi: undefined,
        focusInsightPath: undefined,
        target: next.canonicalPath,
        sourceWidgetId: widget.tabId,
        newTab: wantsNewTab()
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
          <OutputRecordDetail
            widget={widget}
            contents={contents}
            documents={documents}
            data={data}
            record={record}
            renderers={renderers}
            open={open}
            expanded={expanded}
            onExpandedChange={setExpanded}
          />
        );
        actions = (
          <>
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
          </>
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
                        sourceWidgetId: widget.tabId,
                        newTab: wantsNewTab()
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
  const run = (command: string, subject: string) => {
    void commands
      .execute(command, { widgetId: widget.tabId })
      .catch(reason => showErrorMessage(subject, reason));
  };
  return (
    <>
      <div className="jp-jupyterlab-lightcone-element-toolbar">
        <HistoryControls widget={widget} />
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
        <div className="jp-jupyterlab-lightcone-element-actions">
          <Button
            size="small"
            variant="quiet"
            title="Open this record in a new tab beside this one"
            onClick={() =>
              run(
                ElementHistoryCommandIDs.openInNewTab,
                'Could not open a new ASTRA tab'
              )
            }
          >
            Open in new tab
          </Button>
          <Button
            size="small"
            aria-pressed={widget.isPinned}
            onClick={() =>
              run(
                widget.isPinned
                  ? CommandIDs.unpinElement
                  : CommandIDs.pinElement,
                'Could not change ASTRA tab pin state'
              )
            }
          >
            <span
              className="jp-jupyterlab-lightcone-pin-icon"
              aria-hidden="true"
            />
            {widget.isPinned ? 'Unpin tab' : 'Pin tab'}
          </Button>
        </div>
      </div>
      <div
        ref={content}
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

/** What `display` may say beyond the reference itself. */
export interface IDisplayOptions {
  /**
   * Show this committed version of the output, replacing the version the tab
   * showed for it; without one, a tab already showing the record keeps its
   * selection.
   */
  versionCommit?: string;
}

/**
 * Native ASTRA view with replaceable content, an explicit user-owned pin and
 * a history of the references it has shown. It uses native JupyterLab tabs and public layout APIs.
 */
export class ElementWidget extends ReactWidget {
  constructor(
    public reference: IElementReference,
    private contents: Contents.IManager,
    themes: IThemeManager,
    private commands: CommandRegistry,
    private documents: IDocumentOpener,
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

  readonly lightconeView = true as const;

  /** The Contents path of the project's `astra.yaml` this tab shows. */
  get entrypoint(): string {
    return this.reference.entrypoint;
  }

  get isPinned(): boolean {
    return this._isPinned;
  }

  /** The references this tab has shown, and which one it shows now. */
  get history(): IElementHistory {
    return this._history;
  }

  /**
   * Emitted after the tab's current entry changes: the tab moved to another
   * reference, or the output it shows moved to another committed version.
   */
  get historyChanged(): ISignal<this, void> {
    return this._historyChanged;
  }

  get canGoBack(): boolean {
    return canGoBack(this._history);
  }

  get canGoForward(): boolean {
    return canGoForward(this._history);
  }

  /**
   * The committed output version this tab shows (a full or abbreviated
   * commit); undefined while it follows the newest version.
   */
  get selectedVersion(): string | undefined {
    return currentEntry(this._history)?.versionCommit;
  }

  /**
   * Show another committed version of the current output; undefined returns
   * to the newest. The choice belongs to the current history entry, so Back,
   * Forward, "Open in new tab" and a restored layout keep it.
   */
  selectVersion(commit: string | undefined): void {
    const next = selectEntryVersion(this._history, commit);
    if (next === this._history) return;
    this._history = next;
    this.update();
    this._historyChanged.emit();
  }

  /** Update retention without changing the displayed record or its live data. */
  setPinned(pinned: boolean): void {
    this._isPinned = pinned;
    this._syncPin();
    this.update();
  }

  /**
   * Show a reference, pushing it onto this tab's history. A pinned tab
   * navigates too: the pin protects it from being reused by opens made
   * elsewhere, not from links followed inside it.
   */
  display(
    reference: IElementReference,
    identity: string,
    label: string,
    options: IDisplayOptions = {}
  ): void {
    this._history = pushHistory(this._leave(), {
      reference,
      identity,
      label,
      ...(options.versionCommit ? { versionCommit: options.versionCommit } : {})
    });
    this._show();
  }

  /**
   * Adopt a freshly rendered body's scroller: scroll it to where this entry
   * was left, following the body as it grows, and read its offset back when
   * the tab moves on. Returns a function that stops following it.
   */
  mountContent(element: HTMLElement): () => void {
    this._scroller = element;
    const stop = restoreScrollOffset(
      element,
      currentEntry(this._history)?.scrollTop ?? 0
    );
    return () => {
      stop();
      if (this._scroller === element) this._scroller = undefined;
    };
  }

  /** Rename the current entry once the record's title is known. */
  setLabel(label: string): void {
    const entry = currentEntry(this._history);
    if (!entry || entry.label === label) return;
    const entries = this._history.entries.slice();
    entries[this._history.index] = { ...entry, label };
    this._history = { entries, index: this._history.index };
    this.title.label = label;
    this._syncCaption();
  }

  back(): boolean {
    return this._navigate(history => stepHistory(history, -1));
  }

  forward(): boolean {
    return this._navigate(history => stepHistory(history, +1));
  }

  /** Jump to an entry of the trail. */
  go(index: number): boolean {
    return this._navigate(history => goToHistory(history, index));
  }

  render(): React.ReactElement {
    return (
      <Detail
        widget={this}
        contents={this.contents}
        commands={this.commands}
        documents={this.documents}
      />
    );
  }

  dispose(): void {
    if (this.isDisposed) return;
    this._theme.dispose();
    // Widget.dispose emits `disposed` before it clears this widget's signals.
    super.dispose();
  }

  /**
   * Showing another record replaces the body that held focus (the followed
   * link, or the Back button); keep focus in the tab so that Alt+←/→ still
   * reach it.
   */
  protected onUpdateRequest(msg: Message): void {
    renderKeepingFocus(this.node, () => {
      super.onUpdateRequest(msg);
      return this.renderPromise;
    });
  }

  private _navigate(
    move: (history: IElementHistory) => IElementHistory | undefined
  ): boolean {
    const next = move(this._leave());
    if (!next) return false;
    this._history = next;
    this._show();
    return true;
  }

  /** The history with the current entry's scroll offset, as the tab leaves it. */
  private _leave(): IElementHistory {
    return rememberScroll(this._history, this._scroller?.scrollTop ?? 0);
  }

  private _show(): void {
    const entry = currentEntry(this._history);
    if (!entry) return;
    this.reference = entry.reference;
    this.identity = entry.identity;
    this.title.label = entry.label;
    this._syncCaption();
    this.update();
    this._historyChanged.emit();
    this.commands.notifyCommandChanged(ElementHistoryCommandIDs.back);
    this.commands.notifyCommandChanged(ElementHistoryCommandIDs.forward);
  }

  private _syncCaption(): void {
    const reference = this.reference;
    const where = `${reference.entrypoint} · ${reference.universeId ?? 'defaults'}`;
    const trail = historyCaption(this._history);
    this.title.caption =
      this._history.entries.length > 1
        ? `${trail}\n${where}`
        : `${where} · ${trail}`;
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
  private _history: IElementHistory = EMPTY_HISTORY;
  private readonly _historyChanged = new Signal<this, void>(this);
  private _theme: LightconeThemeBinding;
  /** The mounted body's scroller, while a body is mounted. */
  private _scroller: HTMLElement | undefined;
}
