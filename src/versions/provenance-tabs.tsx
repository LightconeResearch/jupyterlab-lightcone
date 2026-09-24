import React, { useId, useMemo, useState } from 'react';
import type { ResolvedRecord } from '@astra-spec/sdk';
import { OutputStatusIndicator } from '@astra-spec/ui/components';
import { recordTitle, type OutputStatus } from '@astra-spec/ui/model';
import { AstraKindMark } from '../astra-kind';
import type { ICodeReference } from '../code-access';
import type { ISessionInfo } from '../sessions/sessions-api';
import {
  diffHunks,
  lineDiff,
  packageChanges,
  type IDiffGap,
  type IDiffLine
} from './revision-diff';
import { relativeTime, type IRunView } from './version-model';
import type { ILockedPackages, IRevisionSource } from './versions-api';

export type ProvenanceTabId =
  'run' | 'code' | 'inputs' | 'environment' | 'conversation';

const TABS: readonly { id: ProvenanceTabId; label: string }[] = [
  { id: 'run', label: 'Run' },
  { id: 'code', label: 'Code' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'environment', label: 'Environment' },
  { id: 'conversation', label: 'Conversation' }
];

/** One recorded input of a run, resolved to its record when it still exists. */
export interface IProvenanceInput {
  id: string;
  version: string;
  /** The input or upstream output the version belongs to. */
  record?: ResolvedRecord;
  onOpen?: () => void;
}

export interface IProvenanceSessions {
  loading: boolean;
  error?: string;
  /** Sessions possibly active around the run, closest first. */
  items: readonly ISessionInfo[];
  /** Every session of the project, for the count. */
  total: number;
}

/** The recipe's script at the run's revision, and the same file now. */
export interface IProvenanceCode {
  loading: boolean;
  error?: string;
  source?: IRevisionSource;
  /** The file's text now; null when it no longer exists or cannot be read. */
  current?: string | null;
}

/** The packages `uv.lock` pinned for the run, and those it pins now. */
export interface IProvenancePackages {
  loading: boolean;
  error?: string;
  locked?: ILockedPackages;
}

export interface IProvenanceTabsProps {
  status?: OutputStatus;
  /** The run as `runView` combined it; null when nothing was recorded. */
  run: IRunView | null | undefined;
  /** Why the run record could not be read, when it could not. */
  error?: string;
  code?: ICodeReference;
  onOpenCode?: (relativePath: string) => void;
  inputs: readonly IProvenanceInput[];
  sessions?: IProvenanceSessions;
  onOpenSession?: (path: string) => void;
  /** Called the first time the Conversation tab is shown. */
  onShowConversation?: () => void;
  /** The script at the recorded revision, once the Code tab asked for it. */
  recordedCode?: IProvenanceCode;
  /** Called the first time the Code tab is shown. */
  onShowCode?: () => void;
  /** The locked packages, once the Environment tab asked for them. */
  packages?: IProvenancePackages;
  /** Called the first time the Environment tab is shown. */
  onShowEnvironment?: () => void;
}

function Row({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement | null {
  if (children === undefined || children === null || children === '')
    return null;
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Time({ value }: { value: string }): React.ReactElement {
  return (
    <time dateTime={value} title={value}>
      {relativeTime(value)}
    </time>
  );
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

function RunTab({
  status,
  run,
  error
}: Pick<IProvenanceTabsProps, 'status' | 'run' | 'error'>): React.ReactElement {
  return (
    <dl className="jp-jupyterlab-lightcone-Provenance-facts">
      {status && (
        <Row label="Status">
          <span className="jp-jupyterlab-lightcone-Provenance-status">
            <OutputStatusIndicator status={status} />
            <span>{status.state}</span>
            {status.detail && <small>{status.detail}</small>}
          </span>
        </Row>
      )}
      {error && (
        <Row label="Record">
          <span role="status">{error}</span>
        </Row>
      )}
      {run === null && !error && (
        <Row label="Record">No run has been recorded for this output.</Row>
      )}
      {run === undefined && !error && (
        <Row label="Record">Loading the run record…</Row>
      )}
      {run && (
        <>
          {run.time && (
            <Row label="Finished">
              <Time value={run.time} />
            </Row>
          )}
          {run.started && (
            <Row label="Started">
              <Time value={run.started} />
            </Row>
          )}
          <Row label="Command">
            {run.command ? <code>{run.command}</code> : undefined}
          </Row>
          <Row label="Exit code">
            {run.exit === undefined ? undefined : (
              <span data-failed={run.exit === 0 ? undefined : ''}>
                {run.exit}
              </span>
            )}
          </Row>
          <Row label="Commit">
            {run.short ? (
              <code title={run.commit}>{run.short}</code>
            ) : undefined}
          </Row>
          <Row label="Tree at run">
            {run.gitRevision ? (
              <code title={run.gitRevision}>{shortHash(run.gitRevision)}</code>
            ) : undefined}
          </Row>
          <Row label="Engine">{run.engineVersion}</Row>
          <Row label="Environment">
            {run.environmentVersion ? (
              <code title={run.environmentVersion}>
                {shortHash(run.environmentVersion)}
              </code>
            ) : undefined}
          </Row>
          <Row label="Sandbox">{run.sandbox}</Row>
          {run.source === 'record' && (
            <Row label="Source">
              The current sidecar; commit history is unavailable here.
            </Row>
          )}
        </>
      )}
    </dl>
  );
}

/** The commit whose tree a run executed: where it started, else its own commit. */
export function recordedRevision(
  run: IRunView | null | undefined
): string | undefined {
  return run?.gitRevision ?? run?.commit;
}

function DiffView({
  lines
}: {
  lines: readonly (IDiffLine | IDiffGap)[];
}): React.ReactElement {
  return (
    <pre className="jp-jupyterlab-lightcone-Provenance-diff">
      {lines.map((line, index) =>
        line.kind === 'gap' ? (
          <span
            key={index}
            className="jp-jupyterlab-lightcone-Provenance-diffLine jp-mod-gap"
          >
            {`… ${line.count} unchanged ${line.count === 1 ? 'line' : 'lines'}\n`}
          </span>
        ) : (
          <span
            key={index}
            className={`jp-jupyterlab-lightcone-Provenance-diffLine jp-mod-${line.kind}`}
          >
            {`${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}\n`}
          </span>
        )
      )}
    </pre>
  );
}

function RecordedSource({
  code,
  revision
}: {
  code: IProvenanceCode | undefined;
  revision: string;
}): React.ReactElement {
  const [view, setView] = useState<'recorded' | 'changes'>('recorded');
  const diff = useMemo(
    () =>
      code?.source?.text !== undefined &&
      code.source.text !== null &&
      typeof code.current === 'string'
        ? lineDiff(code.source.text, code.current)
        : undefined,
    [code]
  );
  if (!code || code.loading)
    return <p>Reading the script at {revision.slice(0, 7)}…</p>;
  if (code.error)
    return (
      <p role="status">The recorded script is unavailable: {code.error}</p>
    );
  const source = code.source;
  if (!source) return <p>The recorded script is unavailable.</p>;
  const short = source.commit.slice(0, 7);
  if (!source.exists)
    return (
      <p>
        <code>{source.file}</code> did not exist at <code>{short}</code>.
      </p>
    );
  if (source.text === null)
    return (
      <p>
        <code>{source.file}</code> at <code>{short}</code> is{' '}
        {source.annexed
          ? 'an annexed data file'
          : source.binary
            ? 'not text'
            : 'too large to show'}
        .
      </p>
    );
  const hunks = diff ? diffHunks(diff) : undefined;
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-revision">
      <div
        className="jp-jupyterlab-lightcone-Provenance-views"
        role="group"
        aria-label="Recorded script"
      >
        <span className="jp-jupyterlab-lightcone-Provenance-viewsLabel">
          <code>{source.file}</code> at{' '}
          <code title={source.commit}>{short}</code>
        </span>
        <button
          type="button"
          aria-pressed={view === 'recorded'}
          onClick={() => setView('recorded')}
        >
          As run
        </button>
        <button
          type="button"
          aria-pressed={view === 'changes'}
          onClick={() => setView('changes')}
        >
          Changes since
        </button>
      </div>
      {view === 'recorded' ? (
        <pre>
          <code>{source.text}</code>
        </pre>
      ) : code.current === null ? (
        <p>The file no longer exists in the project.</p>
      ) : diff === null ? (
        <p>The file changed too much since the run to compare line by line.</p>
      ) : hunks && hunks.length ? (
        <DiffView lines={hunks} />
      ) : (
        <p>The file is unchanged since the run.</p>
      )}
    </div>
  );
}

function CodeTab({
  run,
  code,
  onOpenCode,
  recordedCode
}: Pick<
  IProvenanceTabsProps,
  'run' | 'code' | 'onOpenCode' | 'recordedCode'
>): React.ReactElement {
  const revision = recordedRevision(run);
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-code">
      {run?.recipe && (
        <pre>
          <code>{run.recipe}</code>
        </pre>
      )}
      {code ? (
        <p>
          <code>{code.relativePath}</code>{' '}
          <small>(from the {code.source})</small>{' '}
          {onOpenCode && (
            <button type="button" onClick={() => onOpenCode(code.relativePath)}>
              Open current file
            </button>
          )}
        </p>
      ) : (
        <p>No script could be located from the recipe.</p>
      )}
      {code && revision ? (
        <RecordedSource code={recordedCode} revision={revision} />
      ) : code ? (
        <p className="jp-jupyterlab-lightcone-Provenance-note">
          No revision was recorded for this run, so only the current file can be
          shown.
        </p>
      ) : null}
    </div>
  );
}

function InputsTab({
  run,
  inputs
}: Pick<IProvenanceTabsProps, 'run' | 'inputs'>): React.ReactElement {
  if (!inputs.length && !run?.inputs.length)
    return <p>No input versions were recorded for this run.</p>;
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-inputs">
      {inputs.length > 0 && (
        <ul>
          {inputs.map(input => (
            <li key={input.id}>
              {/* An upstream output keeps its own mark, as in the inventory. */}
              {input.record ? <AstraKindMark kind={input.record.kind} /> : null}
              {input.onOpen && input.record ? (
                <button type="button" onClick={input.onOpen}>
                  {recordTitle(input.record)}
                </button>
              ) : (
                <span>
                  {input.record ? recordTitle(input.record) : input.id}
                </span>
              )}
              <code title={input.version}>{shortHash(input.version)}</code>
            </li>
          ))}
        </ul>
      )}
      {run && run.inputs.length > 0 && (
        <p>
          <span>Files read:</span>{' '}
          {run.inputs.map(path => (
            <code key={path}>{path}</code>
          ))}
        </p>
      )}
    </div>
  );
}

function LockedPackages({
  packages,
  revision
}: {
  packages: IProvenancePackages | undefined;
  revision: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  if (!packages || packages.loading)
    return <p>Reading uv.lock at {revision.slice(0, 7)}…</p>;
  if (packages.error)
    return (
      <p role="status">The locked packages are unavailable: {packages.error}</p>
    );
  const locked = packages.locked;
  if (!locked?.packages)
    return (
      <p>
        No readable <code>uv.lock</code> at <code>{revision.slice(0, 7)}</code>.
      </p>
    );
  const changes = locked.current
    ? packageChanges(locked.packages, locked.current)
    : undefined;
  const changed = changes
    ? changes.added.length + changes.removed.length + changes.changed.length
    : 0;
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-packages">
      <p>
        {locked.packages.length}{' '}
        {locked.packages.length === 1 ? 'package' : 'packages'} locked in{' '}
        <code>uv.lock</code> at{' '}
        <code title={locked.commit}>{locked.commit.slice(0, 7)}</code>.{' '}
        {!changes
          ? 'The project has no readable uv.lock now.'
          : changed
            ? `${changed} ${changed === 1 ? 'change' : 'changes'} since:`
            : 'The lock is unchanged since.'}
      </p>
      {changes && changed > 0 && (
        <ul className="jp-jupyterlab-lightcone-Provenance-list">
          {changes.changed.map(item => (
            <li key={`c-${item.name}`}>
              <code>{item.name}</code> {item.from ?? 'local'} →{' '}
              {item.to ?? 'local'}
            </li>
          ))}
          {changes.added.map(item => (
            <li key={`a-${item.name}`}>
              <code>{item.name}</code> added
              {item.version ? ` (${item.version})` : ''}
            </li>
          ))}
          {changes.removed.map(item => (
            <li key={`r-${item.name}`}>
              <code>{item.name}</code> removed
              {item.version ? ` (was ${item.version})` : ''}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="jp-jupyterlab-lightcone-Provenance-packagesToggle"
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? 'Hide the package list' : 'Show every locked package'}
      </button>
      {expanded && (
        <ul className="jp-jupyterlab-lightcone-Provenance-list">
          {locked.packages.map(item => (
            <li key={item.name}>
              <code>{item.name}</code> {item.version ?? '(this project)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EnvironmentTab({
  run,
  packages
}: Pick<IProvenanceTabsProps, 'run' | 'packages'>): React.ReactElement {
  if (!run) return <p>No environment was recorded.</p>;
  const revision = recordedRevision(run);
  return (
    <>
      <EnvironmentFacts run={run} />
      {revision && <LockedPackages packages={packages} revision={revision} />}
    </>
  );
}

function EnvironmentFacts({ run }: { run: IRunView }): React.ReactElement {
  return (
    <dl className="jp-jupyterlab-lightcone-Provenance-facts">
      <Row label="Environment">
        {run.environmentVersion ? (
          <code>{run.environmentVersion}</code>
        ) : undefined}
      </Row>
      <Row label="Engine">{run.engineVersion}</Row>
      <Row label="uv">{run.uvVersion}</Row>
      <Row label="Image">{run.image}</Row>
      <Row label="Sandbox">{run.sandbox}</Row>
      <Row label="Definition">
        {run.definitionVersion ? (
          <code title={run.definitionVersion}>
            {shortHash(run.definitionVersion)}
          </code>
        ) : undefined}
      </Row>
      <Row label="Data">
        {run.dataVersion ? (
          <code title={run.dataVersion}>{shortHash(run.dataVersion)}</code>
        ) : undefined}
      </Row>
      {Object.keys(run.decisions).length > 0 && (
        <Row label="Decisions">
          <ul className="jp-jupyterlab-lightcone-Provenance-list">
            {Object.entries(run.decisions).map(([id, option]) => (
              <li key={id}>
                <AstraKindMark kind="decision" /> <code>{id}</code> ={' '}
                <code>{option}</code>
              </li>
            ))}
          </ul>
        </Row>
      )}
    </dl>
  );
}

function ConversationTab({
  run,
  sessions,
  onOpenSession
}: Pick<
  IProvenanceTabsProps,
  'run' | 'sessions' | 'onOpenSession'
>): React.ReactElement {
  if (!run?.time)
    return <p>No run time is recorded to match sessions against.</p>;
  if (!sessions || sessions.loading) return <p>Looking for sessions…</p>;
  if (sessions.error)
    return <p role="status">Sessions unavailable: {sessions.error}</p>;
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-sessions">
      <p className="jp-jupyterlab-lightcone-Provenance-note">
        Heuristic: sessions last modified around the run (five minutes before to
        twelve hours after), out of {sessions.total}. Nothing records which
        conversation caused this run.
      </p>
      {sessions.items.length ? (
        <ul>
          {sessions.items.map(session => (
            <li key={session.path}>
              {onOpenSession ? (
                <button
                  type="button"
                  onClick={() => onOpenSession(session.path)}
                >
                  {session.title}
                </button>
              ) : (
                <span>{session.title}</span>
              )}
              <small>
                <Time value={session.modified} />
                {session.lastAgent ? ` · ${session.lastAgent}` : ''}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No session was active around this run.</p>
      )}
    </div>
  );
}

/** Run, Code, Inputs, Environment and Conversation tabs for one materialization. */
export function ProvenanceTabs(
  props: IProvenanceTabsProps
): React.ReactElement {
  const [active, setActive] = useState<ProvenanceTabId>('run');
  const [shownTabs, setShownTabs] = useState<ReadonlySet<ProvenanceTabId>>(
    () => new Set<ProvenanceTabId>(['run'])
  );
  const baseId = useId();
  const show = (id: ProvenanceTabId) => {
    setActive(id);
    if (shownTabs.has(id)) return;
    setShownTabs(new Set([...shownTabs, id]));
    // Each tab that reads more than the run record does so once, when first shown.
    if (id === 'conversation') props.onShowConversation?.();
    else if (id === 'code') props.onShowCode?.();
    else if (id === 'environment') props.onShowEnvironment?.();
  };
  let panel: React.ReactNode;
  switch (active) {
    case 'code':
      panel = (
        <CodeTab
          run={props.run}
          code={props.code}
          onOpenCode={props.onOpenCode}
          recordedCode={props.recordedCode}
        />
      );
      break;
    case 'inputs':
      panel = <InputsTab run={props.run} inputs={props.inputs} />;
      break;
    case 'environment':
      panel = <EnvironmentTab run={props.run} packages={props.packages} />;
      break;
    case 'conversation':
      panel = (
        <ConversationTab
          run={props.run}
          sessions={props.sessions}
          onOpenSession={props.onOpenSession}
        />
      );
      break;
    default:
      panel = (
        <RunTab status={props.status} run={props.run} error={props.error} />
      );
  }
  return (
    <section className="jp-jupyterlab-lightcone-Provenance">
      <h4>Provenance</h4>
      <div
        className="jp-jupyterlab-lightcone-Provenance-tablist"
        role="tablist"
        aria-label="Provenance"
      >
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${baseId}-${tab.id}-tab`}
            aria-selected={active === tab.id}
            aria-controls={`${baseId}-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => show(tab.id)}
            onKeyDown={event => {
              const index = TABS.findIndex(item => item.id === tab.id);
              const next =
                event.key === 'ArrowRight'
                  ? TABS[(index + 1) % TABS.length]
                  : event.key === 'ArrowLeft'
                    ? TABS[(index + TABS.length - 1) % TABS.length]
                    : undefined;
              if (next) {
                event.preventDefault();
                show(next.id);
                (
                  event.currentTarget.parentElement?.querySelector<HTMLElement>(
                    `#${CSS.escape(`${baseId}-${next.id}-tab`)}`
                  ) ?? null
                )?.focus();
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${active}`}
        aria-labelledby={`${baseId}-${active}-tab`}
        className="jp-jupyterlab-lightcone-Provenance-panel"
      >
        {panel}
      </div>
    </section>
  );
}
