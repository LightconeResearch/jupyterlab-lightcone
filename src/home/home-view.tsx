import type { ResolvedOutput } from '@astra-spec/sdk';
import {
  analysisTitle,
  collectInventoryPapers,
  type SurfaceKind
} from '@astra-spec/ui/model';
import {
  ReactWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import type { IStateDB } from '@jupyterlab/statedb';
import { editIcon } from '@jupyterlab/ui-components';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import type { Message } from '@lumino/messaging';
import { Poll } from '@lumino/polling';
import { Signal, type ISignal } from '@lumino/signaling';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  fetchProjectAgents,
  isRecord,
  RequestError,
  type IProjectAgents
} from '../api';
import {
  JupyterArtifactAccess,
  type IDocumentOpener
} from '../artifact-access';
import { JupyterArtifactPreview } from '../artifact-preview';
import { CommandIDs } from '../commands';
import { AstraKindMark } from '../astra-kind';
import { astraIcon, lightconeIcon, mystIcon } from '../icons';
import {
  outputMaterializationStatus,
  useMaterializationStatus
} from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import {
  acquireProjectDataService,
  type IProjectDataState
} from '../project-data-service';
import type { IProjectRoot } from '../project-root';
import type { ISessionService } from '../sessions/session-service';
import type { ISessionInfo } from '../sessions/sessions-api';
import { listOutputs, outputKindLabel } from '../sidebar/results-summary';
import { SidebarCommandIDs } from '../sidebar/sidebar-commands';
import { LightconeThemeBinding } from '../theme-adapter';
import { PipelineCommandIDs } from '../versions/pipeline-commands';
import { PipelineGlyph } from '../versions/pipeline-glyph';
import { listResultsCommits } from '../versions/versions-api';
import { CREATE_CHAT_COMMAND } from '../workbench-ids';
import {
  HOME_RESULT_LIMIT,
  HOME_SESSION_LIMIT,
  countRecords,
  orderPlates,
  platePreview,
  sessionActivity,
  sessionSubtitle,
  summarizeFreshness
} from './home-model';
import { knownPersona, type PersonaDirectory } from './personas';
import { AgentPicker } from './agent-picker';
import { DescriptionMarkdown } from './description-markdown';

const CLASS = 'jp-jupyterlab-lightcone-Home';
/** How often Home re-checks the report's presence while visible. */
const REFRESH_INTERVAL = 15000;
const DRAFT_SAVE_DELAY = 300;
const REPORT_FILES = ['myst.yml', 'myst.yaml'];

const TransContext = createContext<TranslationBundle>(
  nullTranslator.load('jupyterlab_lightcone')
);

export interface IHomeViewOptions {
  contents: Contents.IManager;
  commands: CommandRegistry;
  /** Opens an artifact file in a tab, for the plates' previews. */
  documents: IDocumentOpener;
  rendermime: IRenderMimeRegistry;
  themes: IThemeManager;
  /**
   * The desk (composer and sessions) needs the sessions service and Jupyter
   * Chat's `jupyterlab-chat:create` command; Home omits it otherwise.
   */
  sessions: ISessionService | null;
  personas: PersonaDirectory | null;
  /** Keeps an unsent composer draft across reloads. */
  state: IStateDB | null;
  translator?: ITranslator;
  /** Open the Tools menu below the given button. */
  onOpenTools: (anchor: HTMLElement) => void;
}

/** The project front page rendered inside a launcher tab. */
export class HomeView extends ReactWidget {
  constructor(options: IHomeViewOptions) {
    super();
    this._options = options;
    this.addClass(`${CLASS}View`);
    this._theme = new LightconeThemeBinding(options.themes, this.node);
    this._trans = (options.translator ?? nullTranslator).load(
      'jupyterlab_lightcone'
    );
    this._isVisible = () => this.isVisible;
  }

  /** Show this project; null clears the view. */
  setProject(project: IProjectRoot | null): void {
    this._project = project;
    this.update();
  }

  /** Adopt the sessions service once it is available; the desk appears with it. */
  setSessions(
    sessions: ISessionService | null,
    personas: PersonaDirectory | null
  ): void {
    if (
      sessions === this._options.sessions &&
      personas === this._options.personas
    ) {
      return;
    }
    this._options = { ...this._options, sessions, personas };
    this.update();
  }

  render(): React.ReactElement | null {
    if (!this._project) {
      return null;
    }
    return (
      <TransContext.Provider value={this._trans}>
        <HomeRoot
          key={this._project.entrypoint}
          project={this._project}
          isVisible={this._isVisible}
          shown={this._shown}
          options={this._options}
        />
      </TransContext.Provider>
    );
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._theme.dispose();
    super.dispose();
  }

  /**
   * Tell the page it is on screen again. Its polls stand by while the tab is
   * hidden, so what changed meanwhile is read now rather than a poll later.
   */
  protected onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    this._shown.emit();
  }

  private _options: IHomeViewOptions;
  private _project: IProjectRoot | null = null;
  private _theme: LightconeThemeBinding;
  private _trans: TranslationBundle;
  private _isVisible: () => boolean;
  private _shown = new Signal<this, void>(this);
}

interface IHomeRootProps {
  project: IProjectRoot;
  isVisible: () => boolean;
  /** Emitted each time the page becomes visible. */
  shown: ISignal<HomeView, void>;
  options: IHomeViewOptions;
}

/**
 * Home's polls stand by while its tab is hidden, and like JupyterLab's own
 * polls while the browser tab is hidden too.
 */
function homeStandby(isVisible: () => boolean): boolean | Poll.Standby {
  return !isVisible() || 'when-hidden';
}

/** Whether a command is registered, following commands added or removed later. */
function useHasCommand(commands: CommandRegistry, id: string): boolean {
  const [registered, setRegistered] = useState(() => commands.hasCommand(id));
  useEffect(() => {
    const update = (
      _sender: CommandRegistry,
      change: CommandRegistry.ICommandChangedArgs
    ) => {
      if (change.type !== 'changed') {
        setRegistered(commands.hasCommand(id));
      }
    };
    setRegistered(commands.hasCommand(id));
    commands.commandChanged.connect(update);
    return () => {
      commands.commandChanged.disconnect(update);
    };
  }, [commands, id]);
  return registered;
}

/**
 * Run a project command from a button, once at a time: `running` stays true
 * while the command's dialog is open.
 */
function useCommandRun(
  commands: CommandRegistry,
  id: string,
  entrypoint: string,
  failure: string
): [running: boolean, run: () => void] {
  const [running, setRunning] = useState(false);
  const run = () => {
    if (running) {
      return;
    }
    setRunning(true);
    void commands
      .execute(id, { path: entrypoint })
      .catch(reason => {
        void showErrorMessage(
          failure,
          reason instanceof Error ? reason : String(reason)
        );
      })
      .finally(() => setRunning(false));
  };
  return [running, run];
}

function HomeRoot({
  project,
  isVisible,
  shown,
  options
}: IHomeRootProps): React.ReactElement {
  const trans = useContext(TransContext);
  const { contents, commands, documents, sessions } = options;
  const state = useProjectData(contents, project.entrypoint);
  const data = state.data;
  const canRename = useHasCommand(commands, CommandIDs.renameProject);
  const canEditDescription = useHasCommand(
    commands,
    CommandIDs.editProjectDescription
  );
  const [renaming, rename] = useCommandRun(
    commands,
    CommandIDs.renameProject,
    project.entrypoint,
    trans.__('Could not rename project')
  );
  const [editingDescription, editDescription] = useCommandRun(
    commands,
    CommandIDs.editProjectDescription,
    project.entrypoint,
    trans.__('Could not save description')
  );
  const description = data?.document.analysis.description ?? '';
  const describe = description
    ? trans.__('Edit description')
    : trans.__('Add description');
  // The report opens through the MySTRA viewer stopgap; without its command
  // there is nothing to offer and no reason to look for a MyST configuration.
  const reportCommand = useHasCommand(commands, CommandIDs.openMySTRA);
  const reportAvailable = useReportAvailable(
    contents,
    project.path,
    isVisible,
    shown,
    reportCommand
  );
  // Sessions are chats: without Jupyter Chat's create command none can start
  // or open, and Home leaves out its desk.
  const chatAvailable = useHasCommand(commands, CREATE_CHAT_COMMAND);
  const openInventory = useCallback(() => {
    void commands
      .execute(CommandIDs.openInventory, { path: project.entrypoint })
      .catch(reason => {
        void showErrorMessage(
          trans.__('Could not open the inventory'),
          reason instanceof Error ? reason : String(reason)
        );
      });
  }, [commands, project.entrypoint, trans]);
  const openReport = useCallback(() => {
    void commands
      .execute(CommandIDs.openMySTRA, { cwd: project.path })
      .catch(reason => {
        void showErrorMessage(
          trans.__('Could not open the report'),
          reason instanceof Error ? reason : String(reason)
        );
      });
  }, [commands, project.path, trans]);
  return (
    <div className={`${CLASS}-page`}>
      <header className={`${CLASS}-header`}>
        <lightconeIcon.react tag="span" className={`${CLASS}-mark`} />
        <span className={`${CLASS}-brand`}>{trans.__('Lightcone Lab')}</span>
        <span className={`${CLASS}-path`} title={project.entrypoint}>
          {project.path || '/'}
        </span>
        <button
          type="button"
          className={`${CLASS}-tools`}
          aria-haspopup="menu"
          onClick={event => options.onOpenTools(event.currentTarget)}
        >
          {trans.__('Tools')} <span aria-hidden="true">▾</span>
        </button>
      </header>
      <div className={`${CLASS}-columns`}>
        <section
          className={`${CLASS}-research`}
          aria-label={trans.__('Project')}
        >
          <p className={`${CLASS}-eyebrow`}>{trans.__('Project')}</p>
          {data ? (
            <>
              <h1 className={`${CLASS}-title`}>
                {analysisTitle(data.document.analysis)}
                {canRename ? (
                  <button
                    type="button"
                    className={`${CLASS}-inlineEdit ${CLASS}-rename`}
                    title={trans.__('Rename project')}
                    aria-label={trans.__('Rename project')}
                    disabled={renaming}
                    onClick={rename}
                  >
                    <editIcon.react tag="span" />
                  </button>
                ) : null}
              </h1>
              <ProjectBadges data={data} />
              {description || canEditDescription ? (
                <div className={`${CLASS}-description`}>
                  {description ? (
                    <DescriptionMarkdown
                      source={description}
                      rendermime={options.rendermime}
                      contents={options.contents}
                      path={project.entrypoint}
                    />
                  ) : null}
                  {canEditDescription ? (
                    <button
                      type="button"
                      className={`${CLASS}-inlineEdit ${CLASS}-editDescription`}
                      title={describe}
                      aria-label={describe}
                      disabled={editingDescription}
                      onClick={editDescription}
                    >
                      <editIcon.react tag="span" />
                      {description ? null : describe}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className={`${CLASS}-message`} role="status">
              {state.error ?? trans.__('Loading project…')}
            </p>
          )}
          {state.error && data ? (
            <p className={`${CLASS}-warning`} role="status">
              {trans.__('Showing the last valid project data: %1', state.error)}
            </p>
          ) : null}
          <div className={`${CLASS}-actions`}>
            {reportAvailable ? (
              <button
                type="button"
                className={`${CLASS}-report`}
                onClick={openReport}
              >
                <mystIcon.react tag="span" className={`${CLASS}-actionIcon`} />
                {trans.__('Open report')}
              </button>
            ) : null}
            <button
              type="button"
              className={`${CLASS}-astra`}
              onClick={openInventory}
            >
              <astraIcon.react tag="span" className={`${CLASS}-actionIcon`} />
              {trans.__('Open ASTRA')}
            </button>
          </div>
          {data ? (
            <ResultsSection
              contents={contents}
              commands={commands}
              documents={documents}
              entrypoint={project.entrypoint}
              data={data}
              onOpenInventory={openInventory}
            />
          ) : null}
        </section>
        {sessions && chatAvailable ? (
          <Desk
            sessions={sessions}
            personas={options.personas}
            contents={contents}
            themes={options.themes}
            state={options.state}
            commands={commands}
            entrypoint={project.entrypoint}
            isVisible={isVisible}
            shown={shown}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The project's resolved data at its default universe, shared with every
 * other view of the same entrypoint through the project data service.
 */
function useProjectData(
  contents: Contents.IManager,
  entrypoint: string
): IProjectDataState {
  const [state, setState] = useState<IProjectDataState>({
    data: undefined,
    error: undefined
  });
  useEffect(() => {
    const lease = acquireProjectDataService(contents, entrypoint);
    let active = true;
    const update = () => {
      if (active) {
        setState(lease.service.state);
      }
    };
    lease.service.changed.connect(update);
    update();
    void lease.service.get().then(update, update);
    return () => {
      active = false;
      lease.service.changed.disconnect(update);
      lease.release();
    };
  }, [contents, entrypoint]);
  return state;
}

/** Whether a folder listing holds a MyST configuration file. */
function listsReport(folder: Contents.IModel): boolean {
  const children: unknown = folder.content;
  return (
    Array.isArray(children) &&
    children.some(
      child =>
        isRecord(child) &&
        child.type === 'file' &&
        typeof child.name === 'string' &&
        REPORT_FILES.includes(child.name)
    )
  );
}

/**
 * Whether the project has a MyST configuration. Agents, `lc` and Git write it
 * without going through the Contents manager, so besides Contents events the
 * check runs whenever the page is shown and on a slow poll while it is
 * visible. Each run lists the project folder once: asking for each candidate
 * file would answer 404 on every tick in the many projects without a report,
 * and the server logs every 404 as a warning. Nothing is checked while
 * `enabled` is false (the command opening the report is not registered).
 */
function useReportAvailable(
  contents: Contents.IManager,
  projectPath: string,
  isVisible: () => boolean,
  shown: ISignal<HomeView, void>,
  enabled: boolean
): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setAvailable(false);
      return;
    }
    let active = true;
    const candidates = REPORT_FILES.map(name =>
      contents.resolvePath(projectPath, name)
    );
    const poll = new Poll({
      name: `jupyterlab_lightcone:home:report:${projectPath}`,
      frequency: { interval: REFRESH_INTERVAL, backoff: false },
      standby: () => homeStandby(isVisible),
      factory: async () => {
        try {
          const folder = await contents.get(projectPath, { content: true });
          if (active) {
            setAvailable(listsReport(folder));
          }
        } catch (error) {
          if (active) {
            console.warn('Could not check for a MyST report.', error);
            setAvailable(false);
          }
        }
      }
    });
    const refresh = () => void poll.refresh();
    const changed = (
      _sender: Contents.IManager,
      change: Contents.IChangedArgs
    ) => {
      const touched = [change.oldValue?.path, change.newValue?.path].some(
        path => path !== undefined && candidates.includes(path)
      );
      if (touched) {
        refresh();
      }
    };
    contents.fileChanged.connect(changed);
    shown.connect(refresh);
    return () => {
      active = false;
      contents.fileChanged.disconnect(changed);
      shown.disconnect(refresh);
      poll.dispose();
    };
  }, [contents, projectPath, isVisible, shown, enabled]);
  return available;
}

/** The newest commit that touched the results, for the freshness line. */
function useLatestRun(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData
): string | undefined {
  const [time, setTime] = useState<string>();
  useEffect(() => {
    let active = true;
    // The history comes from the project's Git repository, which only local files have.
    if (contents.driveName(entrypoint)) {
      setTime(undefined);
      return;
    }
    listResultsCommits(contents.serverSettings, entrypoint, { limit: 1 })
      .then(commits => {
        if (active) {
          setTime(commits[0]?.time);
        }
      })
      .catch(error => {
        if (!active) {
          return;
        }
        setTime(undefined);
        if (!(error instanceof RequestError && error.status === 404)) {
          console.warn('Could not read the results history.', error);
        }
      });
    return () => {
      active = false;
    };
  }, [contents, entrypoint, data]);
  return time;
}

interface IResultsSectionProps {
  contents: Contents.IManager;
  commands: CommandRegistry;
  documents: IDocumentOpener;
  entrypoint: string;
  data: ILoadedProjectData;
  onOpenInventory: () => void;
}

function ResultsSection({
  contents,
  commands,
  documents,
  entrypoint,
  data,
  onOpenInventory
}: IResultsSectionProps): React.ReactElement {
  const trans = useContext(TransContext);
  const materialization = useMaterializationStatus(
    contents,
    entrypoint,
    data.document
  );
  const latestRun = useLatestRun(contents, entrypoint, data);
  const outputs = useMemo(() => orderPlates(listOutputs(data)), [data]);
  const access = useMemo(
    () =>
      new JupyterArtifactAccess(contents, entrypoint, data.bindings, documents),
    [contents, entrypoint, data.bindings, documents]
  );
  const freshness = summarizeFreshness(
    outputs.map(output => ({
      id: output.id,
      status: outputMaterializationStatus(
        materialization.statuses,
        data,
        output
      )
    })),
    trans,
    latestRun
  );
  const pipelineAvailable = useHasCommand(
    commands,
    PipelineCommandIDs.openPipeline
  );
  const openPipeline = () => {
    void commands
      .execute(PipelineCommandIDs.openPipeline, { entrypoint })
      .catch(reason => {
        void showErrorMessage(
          trans.__('Could not open the pipeline'),
          reason instanceof Error ? reason : String(reason)
        );
      });
  };
  const open = (output: ResolvedOutput) => {
    void commands
      .execute(CommandIDs.openElement, {
        entrypoint,
        target: output.canonicalPath
      })
      .catch(reason => {
        void showErrorMessage(
          trans.__('Could not open the result'),
          reason instanceof Error ? reason : String(reason)
        );
      });
  };
  return (
    <section className={`${CLASS}-section`} aria-label={trans.__('Results')}>
      <div className={`${CLASS}-kicker`}>
        <span className={`${CLASS}-kickerLabel`}>{trans.__('Results')}</span>
        <span
          className={`${CLASS}-freshness`}
          data-state={freshness.state}
          title={materialization.error}
        >
          {freshness.state !== 'empty' ? (
            <span className={`${CLASS}-freshnessDot`} aria-hidden="true" />
          ) : null}
          {freshness.text}
        </span>
        {outputs.length && pipelineAvailable ? (
          // The graph behind the freshness line: what each result is made
          // from, and which results are current.
          <button
            type="button"
            className={`${CLASS}-link ${CLASS}-pipeline`}
            title={trans.__(
              'How the results are made from the inputs, and which are current'
            )}
            onClick={openPipeline}
          >
            <PipelineGlyph />
            {trans.__('Pipeline')}
          </button>
        ) : null}
        {outputs.length ? (
          <button
            type="button"
            className={`${CLASS}-link`}
            aria-label={trans.__('See all results')}
            onClick={onOpenInventory}
          >
            {trans.__('See all')}
          </button>
        ) : null}
      </div>
      {outputs.length ? (
        <div className={`${CLASS}-plates`}>
          {outputs.slice(0, HOME_RESULT_LIMIT).map(output => (
            <button
              type="button"
              key={output.canonicalPath}
              className={`${CLASS}-plate`}
              title={output.description ?? output.label ?? output.id}
              onClick={() => open(output)}
            >
              {/* The preview component comes from ASTRA UI, but its tokens
                  map to the Lab theme (home.css): Home forces no palette. */}
              <span className={`${CLASS}-platePreview astra-ui astra-isolate`}>
                <JupyterArtifactPreview
                  access={access}
                  compact={true}
                  output={output}
                  adapt={platePreview}
                />
              </span>
              <span className={`${CLASS}-plateCaption`}>
                <AstraKindMark kind="output" />
                <span className={`${CLASS}-plateName`}>
                  {output.label ?? output.id}
                </span>
                <span className={`${CLASS}-plateKind`} data-type={output.type}>
                  {outputKindLabel(output.type, trans)}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface IProjectBadgesProps {
  data: ILoadedProjectData;
}

/**
 * What the ASTRA analysis holds, as a line of badges under the title. Each
 * badge carries the kind mark the inventory draws for that record kind.
 * Results are the project's results, the plates Home shows; decisions,
 * inputs, findings and papers count the whole analysis tree.
 */
function ProjectBadges({ data }: IProjectBadgesProps): React.ReactElement {
  const trans = useContext(TransContext);
  const counts = useMemo(() => countRecords(data.document.analysis), [data]);
  // The same results as the plates below, so the badge counts what they show.
  const results = useMemo(() => listOutputs(data).length, [data]);
  const papers = useMemo(
    () =>
      collectInventoryPapers(
        data.document,
        data.index,
        data.document.analysis,
        data.papers
      ).length,
    [data]
  );
  const badges: { kind: SurfaceKind; count: number; label: string }[] = [
    {
      kind: 'output',
      count: results,
      label: trans._n('result', 'results', results)
    },
    {
      kind: 'decision',
      count: counts.decisions,
      label: trans._n('decision', 'decisions', counts.decisions)
    },
    {
      kind: 'input',
      count: counts.inputs,
      label: trans._n('input', 'inputs', counts.inputs)
    },
    {
      kind: 'finding',
      count: counts.findings,
      label: trans._n('finding', 'findings', counts.findings)
    },
    {
      kind: 'paper',
      count: papers,
      label: trans._n('paper', 'papers', papers)
    }
  ];
  return (
    <ul
      className={`${CLASS}-badges`}
      aria-label={trans.__('Contents of the ASTRA analysis')}
    >
      {badges.map(badge => (
        <li
          key={badge.kind}
          className={`${CLASS}-badge`}
          data-kind={badge.kind}
        >
          <AstraKindMark kind={badge.kind} />
          <strong>{badge.count}</strong> {badge.label}
        </li>
      ))}
    </ul>
  );
}

interface IDeskProps {
  themes: IThemeManager;
  contents: Contents.IManager;
  sessions: ISessionService;
  personas: PersonaDirectory | null;
  state: IStateDB | null;
  commands: CommandRegistry;
  entrypoint: string;
  isVisible: () => boolean;
  shown: ISignal<HomeView, void>;
}

function Desk({
  themes,
  contents,
  sessions,
  personas,
  state,
  commands,
  entrypoint,
  isVisible,
  shown
}: IDeskProps): React.ReactElement {
  const trans = useContext(TransContext);
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <aside className={`${CLASS}-desk`} aria-label={trans.__('Desk')}>
      <Composer
        themes={themes}
        contents={contents}
        sessions={sessions}
        personas={personas}
        state={state}
        entrypoint={entrypoint}
        onStarted={() => setRefreshKey(key => key + 1)}
      />
      <SessionsList
        sessions={sessions}
        commands={commands}
        entrypoint={entrypoint}
        isVisible={isVisible}
        shown={shown}
        refreshKey={refreshKey}
      />
    </aside>
  );
}

/** Load authoritative project choices, refreshing when live persona lists change. */
function useProjectAgents(
  contents: Contents.IManager,
  entrypoint: string,
  personas: PersonaDirectory | null
) {
  const [agents, setAgents] = useState<IProjectAgents>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let request = 0;
    setAgents(undefined);
    setError(undefined);
    const update = () => {
      const current = ++request;
      void fetchProjectAgents(contents.serverSettings, entrypoint)
        .then(value => {
          if (active && current === request) {
            setAgents(value);
            setError(undefined);
          }
        })
        .catch(reason => {
          if (active && current === request) {
            setAgents(undefined);
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        });
    };
    update();
    personas?.changed.connect(update);
    return () => {
      active = false;
      personas?.changed.disconnect(update);
    };
  }, [contents, entrypoint, personas, revision]);
  return { agents, error, retry: () => setRevision(value => value + 1) };
}

interface IComposerDraft {
  text: string;
  persona: string;
}

/** The composer's unsent text, restored from and saved to the state database. */
function useDraft(
  state: IStateDB | null,
  entrypoint: string
): [IComposerDraft, (draft: IComposerDraft) => void] {
  const key = `jupyterlab_lightcone:home:draft:${entrypoint}`;
  const [draft, setDraftState] = useState<IComposerDraft>({
    text: '',
    persona: ''
  });
  const loaded = useRef(!state);
  const timer = useRef<number>();
  useEffect(() => {
    if (!state) {
      return;
    }
    let active = true;
    state
      .fetch(key)
      .then(value => {
        if (!active) {
          return;
        }
        if (isRecord(value) && typeof value.text === 'string') {
          setDraftState({
            text: value.text,
            persona: typeof value.persona === 'string' ? value.persona : ''
          });
        }
      })
      .catch(error => {
        console.warn('Could not restore the Home composer draft.', error);
      })
      .finally(() => {
        loaded.current = true;
      });
    return () => {
      active = false;
      window.clearTimeout(timer.current);
    };
  }, [state, key]);
  const setDraft = useCallback(
    (next: IComposerDraft) => {
      setDraftState(next);
      if (!state || !loaded.current) {
        return;
      }
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const write = next.text.trim()
          ? state.save(key, { text: next.text, persona: next.persona })
          : state.remove(key);
        void write.catch(error => {
          console.warn('Could not save the Home composer draft.', error);
        });
      }, DRAFT_SAVE_DELAY);
    },
    [state, key]
  );
  return [draft, setDraft];
}

interface IComposerProps {
  themes: IThemeManager;
  contents: Contents.IManager;
  sessions: ISessionService;
  personas: PersonaDirectory | null;
  state: IStateDB | null;
  entrypoint: string;
  onStarted: () => void;
}

function Composer({
  themes,
  contents,
  sessions,
  personas,
  state,
  entrypoint,
  onStarted
}: IComposerProps): React.ReactElement {
  const trans = useContext(TransContext);
  const listing = useProjectAgents(contents, entrypoint, personas);
  const options = listing.agents?.personas ?? [];
  const [draft, setDraft] = useDraft(state, entrypoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const message = draft.text.trim();
  // A restored choice counts only while the directory advertises it, so the
  // picker and the message address the same agent.
  // The server's default is already one of the listed agents, or null.
  const persona =
    knownPersona(options, draft.persona) || (listing.agents?.default ?? '');
  const start = async () => {
    if (!message || !persona || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await sessions.createAndOpen(entrypoint, {
        firstMessage: message,
        ...(persona ? { persona } : {})
      });
      setDraft({ text: '', persona: draft.persona });
      onStarted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={`${CLASS}-composer`}
      aria-label={trans.__('New session')}
      onSubmit={event => {
        event.preventDefault();
        void start();
      }}
    >
      <p className={`${CLASS}-eyebrow`}>{trans.__('New session')}</p>
      <div className={`${CLASS}-composerInput`}>
        <textarea
          className={`${CLASS}-textarea`}
          placeholder={trans.__(
            'Ask about this project, or describe the next step…'
          )}
          value={draft.text}
          rows={3}
          disabled={busy}
          onChange={event => setDraft({ ...draft, text: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void start();
            }
          }}
        />
        <div className={`${CLASS}-composerRow`}>
          <AgentPicker
            options={options}
            selected={persona}
            placeholder={
              listing.error
                ? trans.__('Agents unavailable')
                : !listing.agents
                  ? trans.__('Loading agents…')
                  : !options.length
                    ? trans.__('No agents available')
                    : trans.__('Choose an agent')
            }
            disabled={busy || !options.length}
            themes={themes}
            trans={trans}
            onSelect={id => setDraft({ ...draft, persona: id })}
          />
          <button
            type="submit"
            className={`${CLASS}-start`}
            disabled={!message || !persona || busy}
          >
            {busy ? trans.__('Starting…') : trans.__('Start')}
          </button>
        </div>
      </div>
      {listing.error ? (
        <p className={`${CLASS}-composerError`} role="alert">
          {trans.__('Could not load agents.')}{' '}
          <button type="button" onClick={listing.retry}>
            {trans.__('Retry')}
          </button>
        </p>
      ) : null}
      {error ? (
        <p className={`${CLASS}-composerError`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

interface ISessionListState {
  sessions: ISessionInfo[];
  error?: string;
}

/**
 * The project's sessions as the session service lists them. The service
 * polls the listings it has been asked for and announces changes, so Home
 * reads the list when it binds, when the service reports a change while the
 * page is showing, and whenever Home is shown again: a change that arrives
 * while the tab or the browser page is hidden (a session started from Home
 * itself opens over it) is read once the page shows, and asking again keeps
 * the listing among those the service polls. Only the newest answer counts.
 */
function useSessions(
  service: ISessionService,
  entrypoint: string,
  isVisible: () => boolean,
  shown: ISignal<HomeView, void>,
  refreshKey: number
): ISessionListState {
  const [result, setResult] = useState<ISessionListState>({ sessions: [] });
  // Live activity is read at render time; re-render when the service reports a change.
  const [, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    let generation = 0;
    let stale = false;
    const showing = () => isVisible() && document.visibilityState !== 'hidden';
    const list = async () => {
      const request = ++generation;
      stale = false;
      try {
        const sessions = await service.list(entrypoint);
        if (active && request === generation) {
          setResult({ sessions });
        }
      } catch (error) {
        if (active && request === generation) {
          setResult(previous => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      }
    };
    const changed = (_sender: ISessionService, changedEntrypoint: string) => {
      setTick(tick => tick + 1);
      if (changedEntrypoint !== entrypoint) {
        return;
      }
      if (showing()) {
        void list();
      } else {
        stale = true;
      }
    };
    const reshown = () => {
      void list();
    };
    const revealed = () => {
      if (stale && showing()) {
        void list();
      }
    };
    service.changed.connect(changed);
    shown.connect(reshown);
    document.addEventListener('visibilitychange', revealed);
    void list();
    return () => {
      active = false;
      service.changed.disconnect(changed);
      shown.disconnect(reshown);
      document.removeEventListener('visibilitychange', revealed);
    };
  }, [service, entrypoint, isVisible, shown, refreshKey]);
  return result;
}

interface ISessionsListProps {
  sessions: ISessionService;
  commands: CommandRegistry;
  entrypoint: string;
  isVisible: () => boolean;
  shown: ISignal<HomeView, void>;
  refreshKey: number;
}

function SessionsList({
  sessions,
  commands,
  entrypoint,
  isVisible,
  shown,
  refreshKey
}: ISessionsListProps): React.ReactElement | null {
  const trans = useContext(TransContext);
  const listing = useSessions(
    sessions,
    entrypoint,
    isVisible,
    shown,
    refreshKey
  );
  // The sidebar lists every session; its command is how Home reaches it.
  const sidebarAvailable = useHasCommand(
    commands,
    SidebarCommandIDs.showSidebar
  );
  if (!listing.sessions.length) {
    return null;
  }
  const showSidebar = () => {
    void commands.execute(SidebarCommandIDs.showSidebar).catch(reason => {
      void showErrorMessage(
        trans.__('Could not show the Lightcone sidebar'),
        reason instanceof Error ? reason : String(reason)
      );
    });
  };
  const open = (path: string) => {
    void sessions.openSession(path).catch(reason => {
      void showErrorMessage(
        trans.__('Could not open the session'),
        reason instanceof Error ? reason : String(reason)
      );
    });
  };
  return (
    <section className={`${CLASS}-sessions`} aria-label={trans.__('Sessions')}>
      <div className={`${CLASS}-kicker`}>
        <span className={`${CLASS}-kickerLabel`}>{trans.__('Sessions')}</span>
        {listing.error ? (
          <span className={`${CLASS}-kickerNote`} title={listing.error}>
            {trans.__('List may be out of date')}
          </span>
        ) : null}
        {sidebarAvailable ? (
          <button
            type="button"
            className={`${CLASS}-link`}
            onClick={showSidebar}
          >
            {trans.__('All %1 →', listing.sessions.length)}
          </button>
        ) : null}
      </div>
      <ul className={`${CLASS}-sessionList`}>
        {listing.sessions.slice(0, HOME_SESSION_LIMIT).map(info => {
          const activity = sessionActivity(info, sessions.activity(info.path));
          return (
            <li key={info.path}>
              <button
                type="button"
                className={`${CLASS}-session`}
                title={info.path}
                onClick={() => open(info.path)}
              >
                <span
                  className={`${CLASS}-sessionDot`}
                  data-activity={activity}
                  aria-hidden="true"
                />
                <span className={`${CLASS}-sessionTitle`}>{info.title}</span>
                <small className={`${CLASS}-sessionMeta`}>
                  {sessionSubtitle(info, activity, trans)}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
