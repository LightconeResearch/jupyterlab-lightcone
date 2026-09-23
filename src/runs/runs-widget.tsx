import { recordTitle } from '@astra-spec/ui/model';
import { ReactWidget, showErrorMessage } from '@jupyterlab/apputils';
import { PathExt } from '@jupyterlab/coreutils';
import type { Contents, ServerConnection } from '@jupyterlab/services';
import {
  nullTranslator,
  type ITranslator,
  type TranslationBundle
} from '@jupyterlab/translation';
import { runIcon } from '@jupyterlab/ui-components';
import type { CommandRegistry } from '@lumino/commands';
import React, {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState
} from 'react';
import { CommandIDs } from '../commands';
import { useMaterializationStatus } from '../materialization-status';
import type { ILoadedProjectData } from '../project-data';
import { acquireProjectDataService } from '../project-data-service';
import { startMaterialization } from './materialize';
import {
  fetchServerUsage,
  type IJob,
  type IRunRecord,
  type IServerUsage,
  type IVenue,
  type JobState
} from './runs-api';
import { RunsCommandIDs } from './runs-commands';
import {
  formatElapsed,
  formatRelativeTime,
  formatTimestamp,
  groupRunsByDay,
  groupRunsByInvocation,
  isFinished,
  jobTitle,
  lastEndKey,
  outputTargetPath,
  parseTargets,
  refusalText,
  staleTargets,
  startErrorMessage,
  summarizeReport,
  usageText,
  venueText,
  type IReportSummary
} from './runs-model';
import type { IProjectRuns, RunsService } from './runs-service';

const CLASS = 'jp-jupyterlab-lightcone-Runs';

const DOMAIN = 'jupyterlab_lightcone';

const TransContext = createContext<TranslationBundle>(
  nullTranslator.load(DOMAIN)
);

function useTrans(): TranslationBundle {
  return useContext(TransContext);
}

/** Follow one project's runs in the service. */
function useProjectRuns(
  service: RunsService,
  entrypoint: string
): IProjectRuns {
  const [state, setState] = useState<IProjectRuns>(() =>
    service.runs(entrypoint)
  );
  useEffect(() => {
    let active = true;
    const update = (_sender: RunsService, changed: string) => {
      if (active && changed === entrypoint) {
        setState(service.runs(entrypoint));
      }
    };
    service.changed.connect(update);
    setState(service.runs(entrypoint));
    void service.refresh(entrypoint).catch(() => undefined);
    return () => {
      active = false;
      service.changed.disconnect(update);
    };
  }, [service, entrypoint]);
  return state;
}

/** The project's SDK data, for output titles and its universe setup. */
function useProjectData(
  contents: Contents.IManager,
  entrypoint: string
): ILoadedProjectData | undefined {
  const [data, setData] = useState<ILoadedProjectData>();
  useEffect(() => {
    const lease = acquireProjectDataService(contents, entrypoint);
    let active = true;
    const update = () => {
      if (active) {
        setData(lease.service.state.data);
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
  return data;
}

/** Elapsed times tick every second while a job runs. */
const RUNNING_TICK = 1000;

/** Relative times and day labels keep aging while nothing runs. */
const IDLE_TICK = 60_000;

/** A clock for relative times: every second while running, every minute otherwise. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(
      () => setNow(Date.now()),
      active ? RUNNING_TICK : IDLE_TICK
    );
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

type Start = (targets: string[], refresh: boolean) => Promise<unknown>;

/** Start jobs from one control, keeping why its last start failed. */
function useStarter(onStart: Start): {
  starting: boolean;
  error: string;
  setError: (error: string) => void;
  /** Resolves whether the job started; a refusal becomes `error`. */
  start: (targets: string[], refresh: boolean) => Promise<boolean>;
} {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const start = async (
    targets: string[],
    refresh: boolean
  ): Promise<boolean> => {
    setError('');
    setStarting(true);
    try {
      await onStart(targets, refresh);
      return true;
    } catch (reason) {
      setError(startErrorMessage(reason));
      return false;
    } finally {
      setStarting(false);
    }
  };
  return { starting, error, setError, start };
}

/** `<universe>/<output>` as the engine spells it. */
function splitKey(key: string): { universe: string; output: string } {
  const slash = key.lastIndexOf('/');
  return slash < 0
    ? { universe: '', output: key }
    : { universe: key.slice(0, slash), output: key.slice(slash + 1) };
}

function stateLabel(state: JobState, trans: TranslationBundle): string {
  switch (state) {
    case 'running':
      return trans.__('Running');
    case 'succeeded':
      return trans.__('Succeeded');
    case 'failed':
      return trans.__('Failed');
    case 'cancelled':
      return trans.__('Stopped');
  }
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function MaterializeForm({
  blocked,
  onStart
}: {
  /** A job is running; the server accepts one per project. */
  blocked: boolean;
  onStart: Start;
}): React.ReactElement {
  const trans = useTrans();
  const id = useId();
  const [text, setText] = useState('');
  const [refresh, setRefresh] = useState(false);
  const { starting, error, setError, start } = useStarter(onStart);
  const submit = async () => {
    const parsed = parseTargets(text);
    if (parsed.invalid.length > 0) {
      setError(trans.__('Not an output name: %1', parsed.invalid.join(', ')));
      return;
    }
    if (await start(parsed.targets, refresh)) {
      setText('');
    }
  };
  const disabled = blocked || starting;
  return (
    <form
      className={`${CLASS}-form`}
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-targets`}>{trans.__('Outputs')}</label>
      <div className={`${CLASS}-formRow`}>
        <input
          id={`${id}-targets`}
          className="jp-mod-styled"
          value={text}
          onChange={event => setText(event.target.value)}
          disabled={disabled}
          placeholder={trans.__(
            'Everything, or names such as hubble_diagram or baseline/hubble_diagram'
          )}
          spellCheck={false}
        />
        <button
          type="submit"
          className="jp-mod-styled jp-mod-accept"
          disabled={disabled}
        >
          {starting ? trans.__('Starting…') : trans.__('Materialize')}
        </button>
      </div>
      <label className={`${CLASS}-check`}>
        <input
          type="checkbox"
          checked={refresh}
          onChange={event => setRefresh(event.target.checked)}
          disabled={disabled}
        />
        {trans.__('Also remake outputs made under an earlier environment')}
      </label>
      {blocked ? (
        <p className={`${CLASS}-hint`}>
          {trans.__(
            'A materialization is running. Wait for it to finish, or stop it.'
          )}
        </p>
      ) : null}
      {error ? (
        <p className={`${CLASS}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function StatusActions({
  contents,
  entrypoint,
  data,
  blocked,
  onStart
}: {
  contents: Contents.IManager;
  entrypoint: string;
  data: ILoadedProjectData;
  blocked: boolean;
  onStart: Start;
}): React.ReactElement | null {
  const trans = useTrans();
  const status = useMaterializationStatus(contents, entrypoint, data.document);
  const { starting, error, start } = useStarter(onStart);
  if (status.error) {
    return (
      <p className={`${CLASS}-hint`}>
        {trans.__('Status is unavailable: %1', status.error)}
      </p>
    );
  }
  if (!status.statuses) {
    return null;
  }
  const { stale, behind } = staleTargets(status.statuses);
  if (stale.length === 0 && behind.length === 0) {
    return (
      <p className={`${CLASS}-hint`}>{trans.__('Every output is current.')}</p>
    );
  }
  const disabled = blocked || starting;
  return (
    <>
      <div className={`${CLASS}-quick`}>
        {stale.length > 0 ? (
          <button
            type="button"
            className="jp-mod-styled"
            disabled={disabled}
            title={stale.join('\n')}
            onClick={() => {
              void start(stale, false);
            }}
          >
            {trans.__('Rematerialize stale (%1)', stale.length)}
          </button>
        ) : null}
        {behind.length > 0 ? (
          <button
            type="button"
            className="jp-mod-styled"
            disabled={disabled}
            title={behind.join('\n')}
            onClick={() => {
              void start(behind, true);
            }}
          >
            {trans.__('Refresh behind (%1)', behind.length)}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={`${CLASS}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function OutputChips({
  label,
  keys,
  tone,
  outputLabel,
  openKey
}: {
  label: string;
  keys: string[];
  tone: 'made' | 'failed' | 'blocked';
  outputLabel: (key: string) => string;
  openKey: (key: string) => void;
}): React.ReactElement {
  const trans = useTrans();
  return (
    <div className={`${CLASS}-chips`}>
      <span>{label}</span>
      {keys.map(key => (
        <button
          key={key}
          type="button"
          className={`${CLASS}-chip`}
          data-tone={tone}
          title={trans.__('Open %1', key)}
          onClick={() => openKey(key)}
        >
          {outputLabel(key)}
        </button>
      ))}
    </div>
  );
}

function ReportSummary({
  summary,
  outputLabel,
  openKey
}: {
  summary: IReportSummary;
  outputLabel: (key: string) => string;
  openKey: (key: string) => void;
}): React.ReactElement {
  const trans = useTrans();
  const line = summary.ok
    ? summary.upToDate
      ? trans.__('Everything was already current.')
      : trans.__(
          'Made %1 · current %2 · behind %3',
          summary.made.length,
          summary.current.length,
          summary.behind.length
        )
    : trans.__(
        'Failed %1 · blocked %2 · made %3',
        summary.failed.length,
        summary.blocked.length,
        summary.made.length
      );
  return (
    <div className={`${CLASS}-report`}>
      <p className={`${CLASS}-reportLine`}>{line}</p>
      {summary.made.length > 0 ? (
        <OutputChips
          label={trans.__('Made')}
          keys={summary.made}
          tone="made"
          outputLabel={outputLabel}
          openKey={openKey}
        />
      ) : null}
      {summary.failed.length > 0 ? (
        <OutputChips
          label={trans.__('Failed')}
          keys={summary.failed}
          tone="failed"
          outputLabel={outputLabel}
          openKey={openKey}
        />
      ) : null}
      {summary.blocked.length > 0 ? (
        <OutputChips
          label={trans.__('Blocked')}
          keys={summary.blocked}
          tone="blocked"
          outputLabel={outputLabel}
          openKey={openKey}
        />
      ) : null}
      {summary.behind.length > 0 ? (
        <ul className={`${CLASS}-reasons`}>
          {summary.behind.map(reason => (
            <li key={reason.key}>
              <button
                type="button"
                className={`${CLASS}-link`}
                onClick={() => openKey(reason.key)}
              >
                {outputLabel(reason.key)}
              </button>{' '}
              <span>{trans.__('is behind: %1', reason.why)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.warnings.length > 0 ? (
        <pre className={`${CLASS}-notes`}>{summary.warnings.join('\n')}</pre>
      ) : null}
      {summary.notes.length > 0 ? (
        <pre className={`${CLASS}-notes`}>{summary.notes.join('\n')}</pre>
      ) : null}
    </div>
  );
}

function JobCard({
  job,
  now,
  outputLabel,
  openKey,
  onStop
}: {
  job: IJob;
  now: number;
  outputLabel: (key: string) => string;
  openKey: (key: string) => void;
  onStop: () => void;
}): React.ReactElement {
  const trans = useTrans();
  const finished = isFinished(job);
  const refusal = refusalText(job);
  const summary = summarizeReport(job.report);
  const output = useRef<HTMLPreElement>(null);
  const lineCount = job.lines.length;
  useEffect(() => {
    const node = output.current;
    if (node && !finished) {
      node.scrollTop = node.scrollHeight;
    }
  }, [lineCount, finished]);
  const lines =
    lineCount > 0 && refusal === null ? (
      <pre className={`${CLASS}-lines`} ref={output}>
        {job.lines.join('\n')}
      </pre>
    ) : null;
  const since = formatRelativeTime(job.started, now);
  const elapsed = formatElapsed(job, now);
  const timing =
    job.exit === null
      ? trans.__('started %1 · %2', since, elapsed)
      : trans.__('started %1 · %2 · exit %3', since, elapsed, job.exit);
  return (
    <article className={`${CLASS}-job`} data-state={job.state}>
      <div className={`${CLASS}-jobHeader`}>
        <span className={`${CLASS}-state`} data-state={job.state}>
          {stateLabel(job.state, trans)}
        </span>
        <strong>{jobTitle(job)}</strong>
        <span
          className={`${CLASS}-jobMeta`}
          title={formatTimestamp(job.started)}
        >
          {timing}
        </span>
        {finished ? null : (
          <button
            type="button"
            className="jp-mod-styled jp-mod-warn"
            onClick={onStop}
          >
            {trans.__('Stop')}
          </button>
        )}
      </div>
      {refusal !== null ? (
        <div className={`${CLASS}-refusal`} role="alert">
          <span>{trans.__('The engine refused to run')}</span>
          <pre>{refusal}</pre>
        </div>
      ) : null}
      {summary ? (
        <ReportSummary
          summary={summary}
          outputLabel={outputLabel}
          openKey={openKey}
        />
      ) : null}
      {finished && lines ? (
        <details className={`${CLASS}-details`}>
          <summary>
            {trans._n(
              'Engine output (%1 line)',
              'Engine output (%1 lines)',
              lineCount
            )}
          </summary>
          {lines}
        </details>
      ) : (
        lines
      )}
    </article>
  );
}

function History({
  runs,
  now,
  outputLabel,
  openOutput
}: {
  runs: readonly IRunRecord[];
  now: number;
  outputLabel: (key: string) => string;
  openOutput: (universe: string, output: string, commit?: string) => void;
}): React.ReactElement {
  const trans = useTrans();
  if (runs.length === 0) {
    return (
      <p className={`${CLASS}-empty`}>
        {trans.__(
          'No materialization is recorded in this project’s history yet.'
        )}
      </p>
    );
  }
  const item = (run: IRunRecord) => (
    <li key={run.commit}>
      <button
        type="button"
        className={`${CLASS}-run`}
        title={trans.__('Open %1', outputTargetPath(run.output))}
        onClick={() => openOutput(run.universe, run.output, run.commit)}
      >
        <span className={`${CLASS}-runOutput`}>
          {outputLabel(`${run.universe}/${run.output}`)}
        </span>
        <span className={`${CLASS}-runMeta`}>
          <time dateTime={run.time} title={formatTimestamp(run.time)}>
            {formatRelativeTime(run.time, now)}
          </time>
          <span className={`${CLASS}-exit`} data-ok={run.exit === 0}>
            {run.exit === null
              ? trans.__('exit unknown')
              : trans.__('exit %1', run.exit)}
          </span>
          <code>{run.short}</code>
        </span>
        <code className={`${CLASS}-cmd`} title={run.cmd}>
          {run.cmd}
        </code>
      </button>
    </li>
  );
  return (
    <>
      {groupRunsByDay(runs, now).map(group => (
        <div key={group.day} className={`${CLASS}-day`}>
          <h3>{group.label}</h3>
          <ul className={`${CLASS}-history`}>
            {groupRunsByInvocation(group.runs).map(invocation =>
              invocation.invocation !== null && invocation.runs.length > 1 ? (
                <li
                  key={`${invocation.invocation}:${invocation.runs[0].commit}`}
                  className={`${CLASS}-invocation`}
                >
                  <span
                    className={`${CLASS}-invocationHead`}
                    title={invocation.invocation}
                  >
                    {trans.__(
                      'One lc materialize · %1 outputs · from %2',
                      invocation.runs.length,
                      invocation.invocation.slice(0, 7)
                    )}
                  </span>
                  <ul className={`${CLASS}-history`}>
                    {invocation.runs.map(item)}
                  </ul>
                </li>
              ) : (
                invocation.runs.map(item)
              )
            )}
          </ul>
        </div>
      ))}
    </>
  );
}

/** How often the server's CPU and memory are read while Runs is open, in ms. */
const USAGE_INTERVAL = 10_000;

/**
 * The server's CPU and memory from jupyter-resource-usage, read while the
 * view is mounted; undefined without that extension, which is then not asked
 * again.
 */
function useServerUsage(
  settings: ServerConnection.ISettings
): IServerUsage | undefined {
  const [usage, setUsage] = useState<IServerUsage>();
  useEffect(() => {
    let active = true;
    let timer = 0;
    const read = async () => {
      const answer = await fetchServerUsage(settings);
      if (!active) return;
      setUsage(answer ?? undefined);
      if (answer) {
        timer = window.setTimeout(() => void read(), USAGE_INTERVAL);
      }
    };
    void read();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [settings]);
  return usage;
}

/**
 * Where runs execute and what the server is using: the SLURM allocation the
 * engine spans, and jupyter-resource-usage's figures when it is installed.
 * Materializations an agent starts in its own shell are not watched here;
 * they appear in the history once they commit.
 */
function Compute({
  venue,
  settings
}: {
  venue: IVenue | undefined;
  settings: ServerConnection.ISettings;
}): React.ReactElement | null {
  const usage = useServerUsage(settings);
  const where = venueText(venue);
  if (!where && !usage) return null;
  return (
    <p className={`${CLASS}-compute`} role="status">
      {where ? <span>{where}</span> : null}
      {usage ? <span>{usageText(usage)}</span> : null}
    </p>
  );
}

interface IRunsViewProps {
  entrypoint: string;
  service: RunsService;
  contents: Contents.IManager;
  commands: CommandRegistry;
  onProjectName: (name: string | undefined) => void;
}

function RunsView({
  entrypoint,
  service,
  contents,
  commands,
  onProjectName
}: IRunsViewProps): React.ReactElement {
  const trans = useTrans();
  const runs = useProjectRuns(service, entrypoint);
  const data = useProjectData(contents, entrypoint);
  const name = data?.document.analysis.name;
  useEffect(() => {
    onProjectName(name);
  }, [name, onProjectName]);
  const running = runs.jobs.some(job => !isFinished(job));
  const now = useNow(running);
  // A universe is named only when the project declares universes; a project
  // without them has no universe files to pin a record tab to.
  const universes =
    data !== undefined && data.document.universe.source !== 'none';
  const outputLabel = (key: string): string => {
    const { universe, output } = splitKey(key);
    const record = data?.index.recordByPath.get(outputTargetPath(output));
    const title = record ? recordTitle(record) : output;
    return universes && universe ? `${title} · ${universe}` : title;
  };
  /** Open an output's record; a run opens it at the version that run made. */
  const openOutput = (
    universe: string,
    output: string,
    commit?: string
  ): void => {
    void commands
      .execute(CommandIDs.openElement, {
        entrypoint,
        target: outputTargetPath(output),
        ...(universes && universe ? { universeId: universe } : {}),
        ...(commit ? { versionCommit: commit } : {})
      })
      .catch(reason =>
        showErrorMessage(
          trans.__('Could not open the output'),
          errorText(reason)
        )
      );
  };
  const openKey = (key: string): void => {
    const { universe, output } = splitKey(key);
    openOutput(universe, output);
  };
  const start: Start = (targets, refresh) =>
    startMaterialization({
      service,
      entrypoint,
      targets,
      refresh,
      openRuns: () => {
        void commands.execute(RunsCommandIDs.openRuns, { entrypoint });
      }
    });
  const stop = (job: IJob): void => {
    void service
      .cancel(entrypoint, job.id)
      .catch(reason =>
        showErrorMessage(
          trans.__('Could not stop the materialization'),
          errorText(reason)
        )
      );
  };
  return (
    <div className={`${CLASS}-main`}>
      <header className={`${CLASS}-header`}>
        <span className={`${CLASS}-eyebrow`}>{trans.__('Lightcone runs')}</span>
        <h1>{name ?? trans.__('Runs')}</h1>
        <p className={`${CLASS}-path`} title={entrypoint}>
          {entrypoint}
        </p>
        <nav className={`${CLASS}-nav`}>
          <button
            type="button"
            className={`${CLASS}-link`}
            onClick={() => {
              void commands
                .execute(CommandIDs.openInventory, { path: entrypoint })
                .catch(() => undefined);
            }}
          >
            {trans.__('Open inventory →')}
          </button>
        </nav>
      </header>
      {runs.error ? (
        <p className={`${CLASS}-error`} role="alert">
          {trans.__('Could not read the run history: %1', runs.error)}
        </p>
      ) : null}
      <Compute venue={runs.venue} settings={contents.serverSettings} />
      <section className={`${CLASS}-section`}>
        <h2>{trans.__('Materialize')}</h2>
        <MaterializeForm blocked={running} onStart={start} />
        {data ? (
          <StatusActions
            // Remount after each job ends so the status is re-read at once.
            key={`${entrypoint}:${lastEndKey(runs.jobs)}`}
            contents={contents}
            entrypoint={entrypoint}
            data={data}
            blocked={running}
            onStart={start}
          />
        ) : null}
      </section>
      <section className={`${CLASS}-section`}>
        <h2>{trans.__('Jobs')}</h2>
        {runs.jobs.length === 0 ? (
          <p className={`${CLASS}-empty`}>
            {runs.loaded || runs.error
              ? trans.__(
                  'No materialization has been started from this server yet.'
                )
              : trans.__('Loading…')}
          </p>
        ) : (
          runs.jobs.map(job => (
            <JobCard
              key={job.id}
              job={job}
              now={now}
              outputLabel={outputLabel}
              openKey={openKey}
              onStop={() => stop(job)}
            />
          ))
        )}
      </section>
      <section className={`${CLASS}-section`}>
        <h2>{trans.__('History')}</h2>
        {runs.loaded || runs.runs.length > 0 ? (
          <History
            runs={runs.runs}
            now={now}
            outputLabel={outputLabel}
            openOutput={openOutput}
          />
        ) : (
          <p className={`${CLASS}-empty`}>
            {runs.error
              ? trans.__('History is unavailable.')
              : trans.__('Loading…')}
          </p>
        )}
      </section>
    </div>
  );
}

/** The Runs view of one project: live jobs, a materialize form and the history. */
export class RunsWidget extends ReactWidget {
  constructor(
    entrypoint: string,
    service: RunsService,
    contents: Contents.IManager,
    commands: CommandRegistry,
    translator?: ITranslator
  ) {
    super();
    this.entrypoint = PathExt.normalize(entrypoint);
    this._service = service;
    this._contents = contents;
    this._commands = commands;
    this._trans = (translator ?? nullTranslator).load(DOMAIN);
    this.addClass(CLASS);
    this.title.label = this._trans.__('Runs');
    this.title.caption = this._trans.__('Lightcone runs · %1', this.entrypoint);
    this.title.icon = runIcon;
    this.title.closable = true;
    this._onProjectName = (name: string | undefined) => {
      this.title.label = name
        ? this._trans.__('Runs · %1', name)
        : this._trans.__('Runs');
    };
  }

  /** Contents path of the project's `astra.yaml`, normalized. */
  readonly entrypoint: string;

  render(): React.ReactElement {
    return (
      <TransContext.Provider value={this._trans}>
        <RunsView
          entrypoint={this.entrypoint}
          service={this._service}
          contents={this._contents}
          commands={this._commands}
          onProjectName={this._onProjectName}
        />
      </TransContext.Provider>
    );
  }

  private readonly _service: RunsService;
  private readonly _contents: Contents.IManager;
  private readonly _commands: CommandRegistry;
  private readonly _trans: TranslationBundle;
  private readonly _onProjectName: (name: string | undefined) => void;
}
