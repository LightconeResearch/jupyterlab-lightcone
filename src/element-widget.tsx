import React, { useEffect, useState } from 'react';
import {
  showErrorMessage,
  ReactWidget,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import {
  PaperDetail,
  DecisionDetail,
  OutputDetail,
  FindingDetail,
  InputDetail,
  InsightDetail
} from '@astra-spec/ui/components';
import {
  recordTitle,
  decisionInsights,
  outputRelations,
  findingEvidence,
  informedDecisions
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
import type { CommandRegistry } from '@lumino/commands';

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

function Detail({
  reference,
  contents,
  commands
}: {
  reference: IElementReference;
  contents: Contents.IManager;
  commands: CommandRegistry;
}): React.ReactElement {
  const state = useProject(contents, reference);
  return (
    <div className="jp-jupyterlab-lightcone-element">
      {state.error && (
        <p role="status">
          Showing last valid data, if available: {state.error}
        </p>
      )}
      {state.data ? (
        <DetailBody
          reference={reference}
          contents={contents}
          commands={commands}
          data={state.data}
          fetchPaper={state.fetchPaper}
        />
      ) : (
        <p>{state.error ?? 'Loading ASTRA element…'}</p>
      )}
    </div>
  );
}

function DetailBody({
  reference,
  contents,
  commands,
  data,
  fetchPaper
}: {
  reference: IElementReference;
  contents: Contents.IManager;
  commands: CommandRegistry;
  data: NonNullable<IProjectDataState['data']>;
  fetchPaper: (doi: string) => void;
}): React.ReactElement {
  const renderers = useProjectRenderers(
    contents,
    reference.entrypoint,
    data,
    fetchPaper
  );
  let resolved: ReturnType<typeof resolveReference> | undefined;
  try {
    resolved = resolveReference(data, reference);
  } catch {
    /* Keep removed elements visible as unavailable tabs. */
  }
  const open = (next: ResolvedRecord) => {
    void commands
      .execute(CommandIDs.openElement, {
        ...reference,
        doi: undefined,
        target: next.canonicalPath
      })
      .catch(reason =>
        showErrorMessage('Could not open ASTRA element', reason)
      );
  };
  if (resolved?.paper)
    return (
      <>
        <h1>{resolved.paper.title}</h1>
        <PaperDetail
          record={resolved.paper}
          metadata={data.papers[resolved.paper.doi]}
          loadPdfJs={renderers.loadPdfJs}
          onFetchPaper={fetchPaper}
          onOpenInsight={open}
          onOpenDecision={open}
        />
      </>
    );
  const record = resolved?.record;
  if (!record)
    return (
      <p role="status">
        This ASTRA element is no longer available:{' '}
        {reference.doi ?? reference.target}
      </p>
    );
  let body: React.ReactNode;
  switch (record.kind) {
    case 'output':
      body = (
        <OutputDetail
          record={record}
          relations={outputRelations(data.index, record)}
          renderArtifact={renderers.renderArtifact}
          onOpenRecord={open}
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
    case 'prior_insight':
      body = (
        <InsightDetail
          record={record}
          decisions={informedDecisions(data.document, record)}
          onOpenDecision={open}
          onOpenSource={() => {
            const doi =
              record?.kind === 'prior_insight'
                ? record.evidence.find(e => e.doi)?.doi
                : undefined;
            if (doi)
              void commands
                .execute(CommandIDs.openElement, {
                  ...reference,
                  target: '',
                  doi
                })
                .catch(reason =>
                  showErrorMessage('Could not open cited paper', reason)
                );
          }}
        />
      );
      break;
  }
  return (
    <>
      <header>
        <h1>{recordTitle(record)}</h1>
        <code>{reference.target}</code>
        <div>
          <button
            onClick={() => {
              void commands
                .execute(CommandIDs.discuss, { ...reference })
                .catch(reason =>
                  showErrorMessage('Could not open ASTRA discussion', reason)
                );
            }}
            disabled={!commands.hasCommand(CommandIDs.discuss)}
          >
            Add to chat
          </button>
          {record.kind === 'output' && (
            <button
              onClick={() => {
                if (record?.kind === 'output')
                  void Promise.resolve(
                    renderers.onOpenArtifact?.(record)
                  ).catch(reason =>
                    showErrorMessage('Could not open artifact', reason)
                  );
              }}
            >
              Open full artifact
            </button>
          )}
        </div>
      </header>
      {body}
    </>
  );
}

/** Native view of an ASTRA record; owns only its React lifecycle and theme binding. */
export class ElementWidget extends ReactWidget {
  constructor(
    public reference: IElementReference,
    private contents: Contents.IManager,
    themes: IThemeManager,
    private commands: CommandRegistry,
    readonly identity: string
  ) {
    super();
    this.addClass('jp-jupyterlab-lightcone-ElementWidget');
    this.addClass('astra-ui');
    this.addClass('lightcone-brand');
    this._theme = new LightconeThemeBinding(themes, this.node);
  }
  /** Retain child navigation while reusing the owning record's tab. */
  display(reference: IElementReference): void {
    this.reference = reference;
    this.update();
  }

  render(): React.ReactElement {
    return (
      <Detail
        reference={this.reference}
        contents={this.contents}
        commands={this.commands}
      />
    );
  }
  dispose(): void {
    this._theme.dispose();
    super.dispose();
  }
  private _theme: LightconeThemeBinding;
}
