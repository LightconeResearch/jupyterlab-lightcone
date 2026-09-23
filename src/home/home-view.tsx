import type { ResolvedOutput } from '@astra-spec/sdk';
import { analysisTitle, collectInventoryPapers } from '@astra-spec/ui/model';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import {
  ReactWidget,
  showErrorMessage,
  type IThemeManager
} from '@jupyterlab/apputils';
import type { Contents } from '@jupyterlab/services';
import type { IStateDB } from '@jupyterlab/statedb';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import type { CommandRegistry } from '@lumino/commands';
import { Poll } from '@lumino/polling';
import type { Widget } from '@lumino/widgets';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { isRecord, RequestError } from '../api';
import { JupyterArtifactAccess } from '../artifact-access';
import { JupyterArtifactPreview } from '../artifact-preview';
import { CommandIDs } from '../commands';
import { mystIcon } from '../icons';
import {
  outputMaterializationStatus,
  useMaterializationStatus
} from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import {
  acquireProjectDataService,
  type IProjectDataState
} from '../project-data-service';
import { findModel, type IProjectRoot } from '../project-root';
import { listRuns } from '../runs/runs-api';
import type { ISessionService } from '../sessions/session-service';
import type { ISessionInfo } from '../sessions/sessions-api';
import { LightconeThemeBinding } from '../theme-adapter';
import { lightconeIcon } from './icons';
import {
  HOME_RESULT_LIMIT,
  HOME_SESSION_LIMIT,
  countRecords,
  outputKindLabel,
  sessionActivity,
  sessionSubtitle,
  summarizeFreshness
} from './home-model';
import type { IPersonaOption, PersonaDirectory } from './personas';

const CLASS = 'jp-jupyterlab-lightcone-Home';
const SESSION_POLL_INTERVAL = 15000;
const DRAFT_SAVE_DELAY = 300;
const REPORT_FILES = ['myst.yml', 'myst.yaml'];

const TransContext = createContext<TranslationBundle>(
  nullTranslator.load('jupyterlab_lightcone')
);

/** The Lightcone sidebar (area I), when it is installed. */
export function findLightconeSidebar(
  shell: JupyterFrontEnd.IShell
): Widget | undefined {
  for (const widget of shell.widgets('left')) {
    if (
      widget.id === 'lightcone-sidebar' ||
      widget.title.caption === 'Lightcone'
    ) {
      return widget;
    }
  }
  return undefined;
}

export interface IHomeViewOptions {
  contents: Contents.IManager;
  commands: CommandRegistry;
  shell: JupyterFrontEnd.IShell;
  themes: IThemeManager;
  /** Sessions and the composer are omitted without the sessions service. */
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

  private _options: IHomeViewOptions;
  private _project: IProjectRoot | null = null;
  private _theme: LightconeThemeBinding;
  private _trans: TranslationBundle;
  private _isVisible: () => boolean;
}

interface IHomeRootProps {
  project: IProjectRoot;
  isVisible: () => boolean;
  options: IHomeViewOptions;
}

function HomeRoot({
  project,
  isVisible,
  options
}: IHomeRootProps): React.ReactElement {
  const trans = useContext(TransContext);
  const { contents, commands, shell, sessions } = options;
  const state = useProjectData(contents, project.entrypoint);
  const data = state.data;
  const reportAvailable = useReportAvailable(contents, project.path);
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
              </h1>
              {data.document.analysis.description ? (
                <p className={`${CLASS}-description`}>
                  {data.document.analysis.description}
                </p>
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
          {reportAvailable ? (
            <button
              type="button"
              className={`${CLASS}-report`}
              onClick={openReport}
            >
              <mystIcon.react tag="span" className={`${CLASS}-reportIcon`} />
              {trans.__('Open report')}
            </button>
          ) : null}
          {data ? (
            <ResultsSection
              contents={contents}
              commands={commands}
              entrypoint={project.entrypoint}
              data={data}
              onOpenInventory={openInventory}
            />
          ) : null}
          {data ? (
            <AnalysisSection data={data} onOpenInventory={openInventory} />
          ) : null}
        </section>
        {sessions ? (
          <Desk
            sessions={sessions}
            personas={options.personas}
            state={options.state}
            shell={shell}
            entrypoint={project.entrypoint}
            isVisible={isVisible}
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

/** Whether the project has a MyST configuration, rechecked when it changes. */
function useReportAvailable(
  contents: Contents.IManager,
  projectPath: string
): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    const candidates = REPORT_FILES.map(name =>
      contents.resolvePath(projectPath, name)
    );
    const check = async () => {
      try {
        const models = await Promise.all(
          candidates.map(path => findModel(contents, path))
        );
        if (active) {
          setAvailable(models.some(model => model?.type === 'file'));
        }
      } catch (error) {
        if (active) {
          console.warn('Could not check for a MyST report.', error);
          setAvailable(false);
        }
      }
    };
    void check();
    const changed = (
      _sender: Contents.IManager,
      change: Contents.IChangedArgs
    ) => {
      const touched = [change.oldValue?.path, change.newValue?.path].some(
        path => path !== undefined && candidates.includes(path)
      );
      if (touched) {
        void check();
      }
    };
    contents.fileChanged.connect(changed);
    return () => {
      active = false;
      contents.fileChanged.disconnect(changed);
    };
  }, [contents, projectPath]);
  return available;
}

/** The newest recorded materialization, for the freshness line. */
function useLatestRun(
  contents: Contents.IManager,
  entrypoint: string,
  data: ILoadedProjectData
): string | undefined {
  const [time, setTime] = useState<string>();
  useEffect(() => {
    let active = true;
    // Run records come from the project's Git history, which only local files have.
    if (contents.driveName(entrypoint)) {
      setTime(undefined);
      return;
    }
    listRuns(contents.serverSettings, entrypoint)
      .then(listing => {
        if (active) {
          setTime(listing.runs[0]?.time);
        }
      })
      .catch(error => {
        if (!active) {
          return;
        }
        setTime(undefined);
        if (!(error instanceof RequestError && error.status === 404)) {
          console.warn('Could not list Lightcone runs.', error);
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
  entrypoint: string;
  data: ILoadedProjectData;
  onOpenInventory: () => void;
}

function ResultsSection({
  contents,
  commands,
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
  const outputs = useMemo(
    () => data.document.analysis.outputs.filter(output => output.active),
    [data]
  );
  const access = useMemo(
    () =>
      new JupyterArtifactAccess(contents, entrypoint, data.bindings, commands),
    [contents, entrypoint, data.bindings, commands]
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
    latestRun
  );
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
        {outputs.length ? (
          <button
            type="button"
            className={`${CLASS}-link`}
            onClick={onOpenInventory}
          >
            {trans.__('All results →')}
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
              <span
                className={`${CLASS}-platePreview astra-ui astra-isolate lightcone-brand`}
              >
                <JupyterArtifactPreview
                  access={access}
                  compact={true}
                  output={output}
                />
              </span>
              <span className={`${CLASS}-plateCaption`}>
                <span className={`${CLASS}-plateName`}>
                  {output.label ?? output.id}
                </span>
                <span className={`${CLASS}-plateKind`} data-kind={output.type}>
                  {outputKindLabel(output.type)}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface IAnalysisSectionProps {
  data: ILoadedProjectData;
  onOpenInventory: () => void;
}

function AnalysisSection({
  data,
  onOpenInventory
}: IAnalysisSectionProps): React.ReactElement {
  const trans = useContext(TransContext);
  const counts = useMemo(() => countRecords(data.document.analysis), [data]);
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
  const entries: { kind: string; count: number; label: string }[] = [
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
    <section className={`${CLASS}-section`} aria-label={trans.__('Analysis')}>
      <div className={`${CLASS}-kicker`}>
        <span className={`${CLASS}-kickerLabel`}>{trans.__('Analysis')}</span>
        <span className={`${CLASS}-kickerNote`}>
          {trans.__('Recorded in astra.yaml')}
        </span>
        <button
          type="button"
          className={`${CLASS}-link`}
          onClick={onOpenInventory}
        >
          {trans.__('Open inventory →')}
        </button>
      </div>
      <div className={`${CLASS}-counts`}>
        {entries.map(entry => (
          <button
            type="button"
            key={entry.kind}
            className={`${CLASS}-count`}
            data-kind={entry.kind}
            onClick={onOpenInventory}
          >
            <span className={`${CLASS}-countGlyph`} aria-hidden="true" />
            <strong>{entry.count}</strong> {entry.label}
          </button>
        ))}
      </div>
    </section>
  );
}

interface IDeskProps {
  sessions: ISessionService;
  personas: PersonaDirectory | null;
  state: IStateDB | null;
  shell: JupyterFrontEnd.IShell;
  entrypoint: string;
  isVisible: () => boolean;
}

function Desk({
  sessions,
  personas,
  state,
  shell,
  entrypoint,
  isVisible
}: IDeskProps): React.ReactElement {
  const trans = useContext(TransContext);
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <aside className={`${CLASS}-desk`} aria-label={trans.__('Desk')}>
      <Composer
        sessions={sessions}
        personas={personas}
        state={state}
        entrypoint={entrypoint}
        onStarted={() => setRefreshKey(key => key + 1)}
      />
      <SessionsList
        sessions={sessions}
        shell={shell}
        entrypoint={entrypoint}
        isVisible={isVisible}
        refreshKey={refreshKey}
      />
    </aside>
  );
}

/** The personas advertised so far, re-rendering as more arrive. */
function usePersonaOptions(
  personas: PersonaDirectory | null
): readonly IPersonaOption[] {
  const [options, setOptions] = useState<readonly IPersonaOption[]>(
    personas?.personas ?? []
  );
  useEffect(() => {
    if (!personas) {
      setOptions([]);
      return;
    }
    const update = () => setOptions(personas.personas);
    update();
    personas.changed.connect(update);
    return () => {
      personas.changed.disconnect(update);
    };
  }, [personas]);
  return options;
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
  sessions: ISessionService;
  personas: PersonaDirectory | null;
  state: IStateDB | null;
  entrypoint: string;
  onStarted: () => void;
}

function Composer({
  sessions,
  personas,
  state,
  entrypoint,
  onStarted
}: IComposerProps): React.ReactElement {
  const trans = useContext(TransContext);
  const options = usePersonaOptions(personas);
  const [draft, setDraft] = useDraft(state, entrypoint);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const message = draft.text.trim();
  const start = async () => {
    if (!message || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await sessions.createAndOpen(entrypoint, {
        firstMessage: message,
        ...(draft.persona ? { persona: draft.persona } : {})
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
        {options.length ? (
          <select
            className={`${CLASS}-agent`}
            aria-label={trans.__('Agent')}
            value={draft.persona}
            disabled={busy}
            onChange={event =>
              setDraft({ ...draft, persona: event.target.value })
            }
          >
            <option value="">{trans.__('Default agent')}</option>
            {options.map(persona => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        ) : (
          <span />
        )}
        <button
          type="submit"
          className={`${CLASS}-start`}
          disabled={!message || busy}
        >
          {busy ? trans.__('Starting…') : trans.__('Start')}
        </button>
      </div>
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

/** Poll the project's sessions while Home is visible and on service changes. */
function useSessions(
  service: ISessionService,
  entrypoint: string,
  isVisible: () => boolean,
  refreshKey: number
): ISessionListState {
  const [result, setResult] = useState<ISessionListState>({ sessions: [] });
  // Live activity is read at render time; re-render when the service reports a change.
  const [, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    const poll = new Poll({
      name: `jupyterlab_lightcone:home:sessions:${entrypoint}`,
      frequency: { interval: SESSION_POLL_INTERVAL, backoff: false },
      standby: () => !isVisible(),
      factory: async () => {
        try {
          const sessions = await service.list(entrypoint);
          if (active) {
            setResult({ sessions });
          }
        } catch (error) {
          if (active) {
            setResult(previous => ({
              ...previous,
              error: error instanceof Error ? error.message : String(error)
            }));
          }
        }
      }
    });
    const changed = (_sender: ISessionService, changedEntrypoint: string) => {
      setTick(tick => tick + 1);
      if (changedEntrypoint === entrypoint) {
        void poll.refresh();
      }
    };
    service.changed.connect(changed);
    return () => {
      active = false;
      service.changed.disconnect(changed);
      poll.dispose();
    };
  }, [service, entrypoint, isVisible, refreshKey]);
  return result;
}

interface ISessionsListProps {
  sessions: ISessionService;
  shell: JupyterFrontEnd.IShell;
  entrypoint: string;
  isVisible: () => boolean;
  refreshKey: number;
}

function SessionsList({
  sessions,
  shell,
  entrypoint,
  isVisible,
  refreshKey
}: ISessionsListProps): React.ReactElement | null {
  const trans = useContext(TransContext);
  const listing = useSessions(sessions, entrypoint, isVisible, refreshKey);
  if (!listing.sessions.length) {
    return null;
  }
  const sidebar = findLightconeSidebar(shell);
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
        {sidebar ? (
          <button
            type="button"
            className={`${CLASS}-link`}
            onClick={() => shell.activateById(sidebar.id)}
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
                  {sessionSubtitle(info, activity)}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
