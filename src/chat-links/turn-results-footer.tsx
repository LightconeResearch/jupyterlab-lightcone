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
import { AstraKindMark } from '../astra-kind';
import { outputKindLabel } from '../output-kind';
import { CommandIDs } from '../commands';
import { useProject } from '../project-data-hooks';
import type { ILoadedProjectData } from '../project-data';
import type { IProjectRoot } from '../project-root';
import { displayPath, serverRelativePath } from './chat-paths';
import type { IResultsCommit } from '../versions/versions-api';
import { listVersionsCached } from '../versions/version-cache';
import {
  previewForVersion,
  type IVersionTarget
} from '../versions/version-content';
import type { ResultsHistoryCache } from './results-cache';
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
  /** Absolute filesystem paths naming the server root; empty when unknown. */
  serverRoots: readonly string[];
  /** The results histories footers read, shared and owned by the plugin. */
  results: ResultsHistoryCache;
  /** The project of the chat at `chatPath`, as resolved by the server. */
  resolveProject(chatPath: string): Promise<IProjectRoot | undefined>;
  openFile(path: string, panel: IChatPanel | undefined): Promise<void>;
}

/**
 * How long, in milliseconds, a reply's end time must hold still before the
 * footer reads the project's results history again: the agent restamps its
 * message with every streamed chunk, and each listing walks the history on
 * the server.
 */
export const TURN_SETTLE_DELAY = 2000;

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

/**
 * `value` once it has held still for `delay` milliseconds. A value that
 * appears or disappears passes at once, so a footer lists runs as soon as it
 * mounts; changes to a defined value wait until they stop.
 */
function useSettled(
  value: number | undefined,
  delay: number
): number | undefined {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) {
      return;
    }
    if (value === undefined || settled === undefined) {
      setSettled(value);
      return;
    }
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, settled, delay]);
  return settled;
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
    void host.resolveProject(chatPath).then(
      found => {
        if (active) {
          setProject(found ?? null);
        }
      },
      error => {
        if (active) {
          console.warn(`Could not find the project of ${chatPath}.`, error);
          setProject(null);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [host, chatPath]);
  return chatPath === undefined ? undefined : project;
}

/**
 * The commits that touched the project's results, fetched after the turn
 * ended so its commits are in. `notBefore` is the turn's end, server time in
 * seconds since the epoch.
 */
function useResultsCommits(
  host: ITurnResultsHost,
  entrypoint: string | undefined,
  notBefore: number | undefined
): IResultsCommit[] | undefined {
  const [commits, setCommits] = useState<IResultsCommit[] | undefined>(
    undefined
  );
  useEffect(() => {
    if (entrypoint === undefined || notBefore === undefined) {
      return;
    }
    let active = true;
    void host.results.get(entrypoint, notBefore).then(
      listing => {
        if (active) {
          setCommits(listing);
        }
      },
      error => {
        if (active) {
          console.warn(
            'Could not read the results history for a reply.',
            error
          );
          setCommits([]);
        }
      }
    );
    return () => {
      active = false;
    };
  }, [host, entrypoint, notBefore]);
  return commits;
}

/** The root-analysis output the results history names; never guess a nested match. */
function findOutput(
  data: ILoadedProjectData,
  outputId: string
): ResolvedOutput | undefined {
  const direct = data.index.recordByPath.get(`outputs.${outputId}`);
  if (direct?.kind === 'output') {
    return direct;
  }
  return undefined;
}

interface IOutputTileProps {
  trans: TranslationBundle;
  item: IMaterializedOutput;
  output: ResolvedOutput | undefined;
  project: Omit<IVersionTarget, 'outputId'>;
  onOpen: (pinned: boolean) => void;
  disabled: boolean;
}

function Thumbnail({
  preview,
  output,
  trans
}: {
  preview: ArtifactPreviewData | undefined;
  output: ResolvedOutput | undefined;
  trans: TranslationBundle;
}): React.ReactElement {
  const kind = outputKindLabel(output?.type, trans);
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
  project,
  onOpen,
  disabled
}: IOutputTileProps): React.ReactElement {
  const [preview, setPreview] = useState<ArtifactPreviewData | undefined>();
  const target = useMemo<IVersionTarget>(
    () => ({ ...project, outputId: item.output }),
    [project, item.output]
  );
  useEffect(() => {
    if (!output) {
      setPreview(undefined);
      return;
    }
    const controller = new AbortController();
    setPreview(undefined);
    void listVersionsCached(
      target.settings,
      target.entrypoint,
      target.universe,
      target.outputId
    )
      .then(listing => {
        const version = listing.versions.find(
          candidate => candidate.commit === item.commit.commit
        );
        return version
          ? previewForVersion(target, output, version, controller.signal)
          : { kind: 'unavailable' as const };
      })
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
  }, [target, output, item.commit.commit]);
  const title = output ? recordTitle(output) : item.output;
  return (
    <li className="jp-jupyterlab-lightcone-TurnResults-item">
      <button
        type="button"
        className="jp-jupyterlab-lightcone-TurnResults-tile"
        disabled={disabled}
        title={trans.__(
          '%1 · %2 · %3. Click to open; middle-click to open pinned.',
          title,
          item.universe,
          item.commit.short
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
          <Thumbnail preview={preview} output={output} trans={trans} />
        </span>
        <span className="jp-jupyterlab-lightcone-TurnResults-label">
          <AstraKindMark kind="output" />
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
  const root = useProject(contents, { entrypoint });
  // The engine calls unconfigured results "default", but the SDK's explicit
  // universe option only accepts authored universe files. Resolve that boundary
  // from public project metadata; an authored default.yaml must stay explicit.
  const universeId = root.data
    ? universe === 'default' && root.data.document.universe.source === 'none'
      ? null
      : universe
    : undefined;
  const state = useProject(contents, { entrypoint, universeId });
  const data =
    state.data?.document.universe.universeId === universe
      ? state.data
      : undefined;
  const project = useMemo(
    () => ({
      settings: host.app.serviceManager.serverSettings,
      entrypoint,
      universe
    }),
    [host.app.serviceManager.serverSettings, entrypoint, universe]
  );
  const open = (item: IMaterializedOutput, pinned: boolean) => {
    const output = data ? findOutput(data, item.output) : undefined;
    void host.app.commands
      .execute(CommandIDs.openElement, {
        entrypoint,
        target: output?.canonicalPath ?? `outputs.${item.output}`,
        universeId,
        versionCommit: item.commit.commit,
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
          project={project}
          disabled={!root.data}
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
        const relative = serverRelativePath(file, host.serverRoots);
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
 * results history changed while the agent replied and the files it edited.
 */
export function createTurnResultsFooter(
  host: ITurnResultsHost
): React.FC<MessageFooterSectionProps> {
  function TurnResultsFooter({
    model,
    message
  }: MessageFooterSectionProps): React.ReactElement | null {
    // The message list is mutated in place; revisions track its changes.
    // Whether this message ends a turn depends on the list alone. Only a
    // turn-end footer follows individual message changes: the agent restamps
    // its message's time with every chunk it streams, which moves the end of
    // the turn, and the files edited arrive as tool-call metadata on messages
    // already listed. A turn that ends on a tool call keeps that message's
    // creation time as its end, since tool-call updates leave the time alone.
    const listRevision = useSignalRevision(model.messagesUpdated);
    const endsTurn = useMemo(
      () => turnEndingAt(model.messages, message.id) !== undefined,
      [model, message.id, listRevision]
    );
    const changeRevision = useSignalRevision(
      endsTurn ? model.messageChanged : undefined
    );
    const turn = useMemo<ITurnWindow | undefined>(
      () => (endsTurn ? turnEndingAt(model.messages, message.id) : undefined),
      [model, message.id, endsTurn, listRevision, changeRevision]
    );
    // Fetch once the reply has stopped moving, not for every chunk.
    const settledEnd = useSettled(turn?.end, TURN_SETTLE_DELAY);
    const project = useChatProject(host, turn ? model.name : undefined);
    const commits = useResultsCommits(host, project?.entrypoint, settledEnd);
    const outputs = useMemo(
      () => (turn && commits ? materializedDuring(commits, turn) : []),
      [turn, commits]
    );
    const files = useMemo(
      () => (turn ? filesEditedIn(model.messages, turn) : []),
      [model, turn]
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
                'Results updated during this reply · %1',
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
