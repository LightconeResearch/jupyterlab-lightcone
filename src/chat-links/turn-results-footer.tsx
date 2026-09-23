import type { ResolvedOutput } from '@astra-spec/sdk';
import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import { recordTitle } from '@astra-spec/ui/model';
import type {
  IChatModel,
  IChatPanel,
  IChatTracker,
  MessageFooterSectionProps
} from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { showErrorMessage } from '@jupyterlab/apputils';
import type { TranslationBundle } from '@jupyterlab/translation';
import type { ISignal } from '@lumino/signaling';
import React, { useEffect, useMemo, useState } from 'react';
import { JupyterArtifactAccess } from '../artifact-access';
import { CommandIDs } from '../commands';
import { useProject } from '../element-widget';
import type { ILoadedProjectData } from '../project-data';
import type { IProjectRoot } from '../project-root';
import type { IRunRecord } from '../runs/runs-api';
import { displayPath, serverRelativePath } from './chat-paths';
import { cachedRuns } from './runs-cache';
import {
  filesEditedIn,
  materializedDuring,
  turnEndingAt,
  type IMaterializedOutput,
  type ITurnWindow
} from './turn-results';

/** What the footer needs from the workbench. */
export interface ITurnResultsHost {
  app: JupyterFrontEnd;
  tracker: IChatTracker | null;
  trans: TranslationBundle;
  /** Absolute filesystem path of the server root, '' when unknown. */
  serverRoot: string;
  resolveProject(chatPath: string): Promise<IProjectRoot | undefined>;
  openFile(path: string, panel: IChatPanel | undefined): Promise<void>;
}

const KIND_LABELS: Record<ResolvedOutput['type'], string> = {
  figure: 'Figure',
  table: 'Table',
  metric: 'Metric',
  data: 'Data',
  report: 'Report'
};

/** A counter that advances whenever `signal` emits; constant without a signal. */
function useSignalRevision(
  signal: ISignal<IChatModel, unknown> | undefined
): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!signal) {
      return;
    }
    const bump = () => setRevision(value => value + 1);
    signal.connect(bump);
    return () => {
      signal.disconnect(bump);
    };
  }, [signal]);
  return revision;
}

/** The project a chat belongs to; undefined while unknown, null when none. */
function useChatProject(
  host: ITurnResultsHost,
  chatPath: string | undefined
): IProjectRoot | null | undefined {
  const [project, setProject] = useState<IProjectRoot | null | undefined>(
    undefined
  );
  useEffect(() => {
    if (chatPath === undefined) {
      return;
    }
    let active = true;
    void host.resolveProject(chatPath).then(found => {
      if (active) {
        setProject(found ?? null);
      }
    });
    return () => {
      active = false;
    };
  }, [host, chatPath]);
  return chatPath === undefined ? undefined : project;
}

/** The project's runs, fetched after the turn ended so its commits are in. */
function useRuns(
  host: ITurnResultsHost,
  entrypoint: string | undefined,
  notBefore: number | undefined
): IRunRecord[] | undefined {
  const [runs, setRuns] = useState<IRunRecord[] | undefined>(undefined);
  useEffect(() => {
    if (entrypoint === undefined || notBefore === undefined) {
      return;
    }
    let active = true;
    void cachedRuns(
      host.app.serviceManager.serverSettings,
      entrypoint,
      notBefore
    ).then(
      listing => {
        if (active) {
          setRuns(listing.runs);
        }
      },
      error => {
        if (active) {
          console.warn('Could not list the project runs for a reply.', error);
          setRuns([]);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [host, entrypoint, notBefore]);
  return runs;
}

/** The output record the engine wrote, whichever analysis declares it. */
function findOutput(
  data: ILoadedProjectData,
  outputId: string
): ResolvedOutput | undefined {
  const direct = data.index.recordByPath.get(`outputs.${outputId}`);
  if (direct?.kind === 'output') {
    return direct;
  }
  for (const record of data.index.recordByPath.values()) {
    if (record.kind === 'output' && record.id === outputId) {
      return record;
    }
  }
  return undefined;
}

interface IOutputTileProps {
  trans: TranslationBundle;
  item: IMaterializedOutput;
  output: ResolvedOutput | undefined;
  access: JupyterArtifactAccess | undefined;
  onOpen: (pinned: boolean) => void;
}

function Thumbnail({
  preview,
  output
}: {
  preview: ArtifactPreviewData | undefined;
  output: ResolvedOutput | undefined;
}): React.ReactElement {
  const kind = output ? KIND_LABELS[output.type] : 'Output';
  if (preview?.kind === 'image') {
    return <img src={preview.url} alt="" />;
  }
  if (preview?.kind === 'metric') {
    return (
      <span className="jp-jupyterlab-lightcone-TurnResults-metric">
        {String(preview.value)}
        {preview.unit ? ` ${preview.unit}` : ''}
      </span>
    );
  }
  return (
    <span className="jp-jupyterlab-lightcone-TurnResults-kind">{kind}</span>
  );
}

function OutputTile({
  trans,
  item,
  output,
  access,
  onOpen
}: IOutputTileProps): React.ReactElement {
  const [preview, setPreview] = useState<ArtifactPreviewData | undefined>();
  useEffect(() => {
    if (!access || !output) {
      setPreview(undefined);
      return;
    }
    const controller = new AbortController();
    void access
      .getPreview(output, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setPreview(value);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setPreview({ kind: 'unavailable' });
        }
      });
    return () => controller.abort();
  }, [access, output]);
  const title = output ? recordTitle(output) : item.output;
  return (
    <li className="jp-jupyterlab-lightcone-TurnResults-item">
      <button
        type="button"
        className="jp-jupyterlab-lightcone-TurnResults-tile"
        title={trans.__(
          '%1 · %2 · %3. Click to open; middle-click to open pinned.',
          title,
          item.universe,
          item.run.short
        )}
        onClick={() => onOpen(false)}
        onAuxClick={event => {
          if (event.button === 1) {
            event.preventDefault();
            onOpen(true);
          }
        }}
      >
        <span className="jp-jupyterlab-lightcone-TurnResults-thumb">
          <Thumbnail preview={preview} output={output} />
        </span>
        <span className="jp-jupyterlab-lightcone-TurnResults-label">
          {title}
        </span>
      </button>
    </li>
  );
}

interface IUniverseTilesProps {
  host: ITurnResultsHost;
  entrypoint: string;
  universe: string;
  items: IMaterializedOutput[];
}

/** Tiles for one universe, previewed from that universe's own artifacts. */
function UniverseTiles({
  host,
  entrypoint,
  universe,
  items
}: IUniverseTilesProps): React.ReactElement {
  const contents = host.app.serviceManager.contents;
  const state = useProject(contents, { entrypoint, universeId: universe });
  const data = state.data;
  const access = useMemo(
    () =>
      data
        ? new JupyterArtifactAccess(
            contents,
            entrypoint,
            data.bindings,
            host.app.commands
          )
        : undefined,
    [contents, entrypoint, data, host.app.commands]
  );
  const open = (item: IMaterializedOutput, pinned: boolean) => {
    const output = data ? findOutput(data, item.output) : undefined;
    void host.app.commands
      .execute(CommandIDs.openElement, {
        entrypoint,
        target: output?.canonicalPath ?? `outputs.${item.output}`,
        universeId: universe,
        pinned
      })
      .catch(reason =>
        showErrorMessage(host.trans.__('Could not open the result'), reason)
      );
  };
  return (
    <>
      {items.map(item => (
        <OutputTile
          key={`${item.universe}/${item.output}`}
          trans={host.trans}
          item={item}
          output={data ? findOutput(data, item.output) : undefined}
          access={access}
          onOpen={pinned => open(item, pinned)}
        />
      ))}
    </>
  );
}

function groupByUniverse(
  items: IMaterializedOutput[]
): [string, IMaterializedOutput[]][] {
  const groups = new Map<string, IMaterializedOutput[]>();
  for (const item of items) {
    const group = groups.get(item.universe);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.universe, [item]);
    }
  }
  return [...groups.entries()];
}

interface IEditedFilesProps {
  host: ITurnResultsHost;
  files: string[];
  project: IProjectRoot;
  panel: IChatPanel | undefined;
}

function EditedFiles({
  host,
  files,
  project,
  panel
}: IEditedFilesProps): React.ReactElement {
  return (
    <ul className="jp-jupyterlab-lightcone-TurnResults-files">
      {files.map(file => {
        const relative = serverRelativePath(file, host.serverRoot);
        const label =
          relative === undefined
            ? file
            : displayPath(relative, project.path) || '/';
        return (
          <li key={file}>
            {relative === undefined ? (
              <span title={file}>{label}</span>
            ) : (
              <button
                type="button"
                className="jp-jupyterlab-lightcone-TurnResults-file"
                title={file}
                onClick={() => {
                  void host.openFile(relative, panel).catch(reason => {
                    void showErrorMessage(
                      host.trans.__('Could not open the file'),
                      reason
                    );
                  });
                }}
              >
                {label}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The footer section: for the last agent message of a turn, the outputs the
 * engine materialized while the agent replied and the files it edited.
 */
export function createTurnResultsFooter(
  host: ITurnResultsHost
): React.FC<MessageFooterSectionProps> {
  function TurnResultsFooter({
    model,
    message
  }: MessageFooterSectionProps): React.ReactElement | null {
    // The message list is mutated in place; revisions track its changes.
    // Whether this message ends a turn depends on the list alone, while the
    // files edited arrive as tool-call metadata on messages already listed,
    // so only a turn-end footer follows individual message changes.
    const listRevision = useSignalRevision(model.messagesUpdated);
    const turn = useMemo<ITurnWindow | undefined>(
      () => turnEndingAt(model.messages, message.id),
      [model, message.id, listRevision]
    );
    const changeRevision = useSignalRevision(
      turn ? model.messageChanged : undefined
    );
    const project = useChatProject(host, turn ? model.name : undefined);
    const runs = useRuns(host, project?.entrypoint, turn?.end);
    const outputs = useMemo(
      () => (turn && runs ? materializedDuring(runs, turn) : []),
      [turn, runs]
    );
    const files = useMemo(
      () => (turn ? filesEditedIn(model.messages, turn) : []),
      [model, turn, changeRevision]
    );
    if (!turn || !project || (!outputs.length && !files.length)) {
      return null;
    }
    const panel = host.tracker?.find(candidate => candidate.model === model);
    return (
      <div className="jp-jupyterlab-lightcone-TurnResults">
        {outputs.length > 0 && (
          <section className="jp-jupyterlab-lightcone-TurnResults-section">
            <h4 className="jp-jupyterlab-lightcone-TurnResults-title">
              {host.trans.__(
                'Materialized during this reply · %1',
                outputs.length
              )}
            </h4>
            <ul className="jp-jupyterlab-lightcone-TurnResults-tiles">
              {groupByUniverse(outputs).map(([universe, items]) => (
                <UniverseTiles
                  key={universe}
                  host={host}
                  entrypoint={project.entrypoint}
                  universe={universe}
                  items={items}
                />
              ))}
            </ul>
          </section>
        )}
        {files.length > 0 && (
          <section className="jp-jupyterlab-lightcone-TurnResults-section">
            <h4 className="jp-jupyterlab-lightcone-TurnResults-title">
              {host.trans.__('Files edited · %1', files.length)}
            </h4>
            <EditedFiles
              host={host}
              files={files}
              project={project}
              panel={panel}
            />
          </section>
        )}
      </div>
    );
  }
  return TurnResultsFooter;
}
