import React, { useId, useState } from 'react';
import type { ResolvedRecord } from '@astra-spec/sdk';
import { OutputStatusIndicator } from '@astra-spec/ui/components';
import { recordTitle, type OutputStatus } from '@astra-spec/ui/model';
import type { ICodeReference } from '../code-access';
import type { ISessionInfo } from '../sessions/sessions-api';
import { relativeTime, type IRunView } from './version-model';

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

function CodeTab({
  run,
  code,
  onOpenCode
}: Pick<
  IProvenanceTabsProps,
  'run' | 'code' | 'onOpenCode'
>): React.ReactElement {
  return (
    <div className="jp-jupyterlab-lightcone-Provenance-code">
      {run?.command && (
        <pre>
          <code>{run.command}</code>
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
        <p>No script could be located from the recorded command.</p>
      )}
      <p className="jp-jupyterlab-lightcone-Provenance-note">
        The file opens as it is now. The server does not serve scripts at the
        recorded commit
        {run?.gitRevision ? ` (${shortHash(run.gitRevision)})` : ''}; use{' '}
        <code>git show</code> to read that revision.
      </p>
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

function EnvironmentTab({
  run
}: Pick<IProvenanceTabsProps, 'run'>): React.ReactElement {
  if (!run) return <p>No environment was recorded.</p>;
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
                <code>{id}</code> = <code>{option}</code>
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
  const [conversationShown, setConversationShown] = useState(false);
  const baseId = useId();
  const show = (id: ProvenanceTabId) => {
    setActive(id);
    if (id === 'conversation' && !conversationShown) {
      setConversationShown(true);
      props.onShowConversation?.();
    }
  };
  let panel: React.ReactNode;
  switch (active) {
    case 'code':
      panel = (
        <CodeTab
          run={props.run}
          code={props.code}
          onOpenCode={props.onOpenCode}
        />
      );
      break;
    case 'inputs':
      panel = <InputsTab run={props.run} inputs={props.inputs} />;
      break;
    case 'environment':
      panel = <EnvironmentTab run={props.run} />;
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
