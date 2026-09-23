import type { ResolvedOutput } from '@astra-spec/sdk';
import { recordTitle, type OutputStatus } from '@astra-spec/ui/model';
import type { TranslationBundle } from '@jupyterlab/translation';
import {
  addIcon,
  caretDownIcon,
  editIcon,
  fileIcon,
  homeIcon,
  imageIcon,
  markdownIcon,
  numberingIcon,
  searchIcon,
  tableRowsIcon,
  type LabIcon
} from '@jupyterlab/ui-components';
import React from 'react';
import type { SessionState } from '../sessions/session-service';
import type { ISessionInfo } from '../sessions/sessions-api';
import { lightconeIcon } from './icons';
import {
  analysisCountsLabel,
  outputKindLabel,
  relativeTime,
  type IAnalysisRow
} from './sidebar-helpers';
import type { ISidebarState } from './sidebar-model';

const BASE = 'jp-jupyterlab-lightcone-Sidebar';

function Message({
  children,
  error = false
}: {
  children: React.ReactNode;
  error?: boolean;
}): React.ReactElement {
  return (
    <p
      className={`${BASE}-message${error ? ' jp-mod-error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </p>
  );
}

export interface ISidebarHeaderProps {
  state: ISidebarState;
  /** The project's name, or its folder when the spec has none. */
  label: string;
  trans: TranslationBundle;
  onHome: () => void;
  /** Absent when the create-project command is not registered. */
  onNewProject?: () => void;
  /** Open the project switcher below its button; absent without one. */
  onSwitch?: (anchor: HTMLElement) => void;
}

/** The project's name and path with a Home button, or a way to start one. */
export function SidebarHeader({
  state,
  label,
  trans,
  onHome,
  onNewProject,
  onSwitch
}: ISidebarHeaderProps): React.ReactElement {
  const { project } = state;
  const mark = (
    <lightconeIcon.react
      tag="span"
      className={`${BASE}-mark`}
      elementPosition="center"
    />
  );
  if (!project) {
    return (
      <div className={`${BASE}-header`}>
        {mark}
        <div className={`${BASE}-identity`}>
          <span className={`${BASE}-name`}>{trans.__('Lightcone')}</span>
          <span className={`${BASE}-path`}>
            {project === undefined
              ? trans.__('Looking for a project…')
              : trans.__('No Lightcone project in this folder')}
          </span>
        </div>
        {project === null && onNewProject ? (
          <button
            type="button"
            className={`${BASE}-button jp-Button jp-mod-styled jp-mod-accept`}
            onClick={onNewProject}
          >
            {trans.__('New project')}
          </button>
        ) : null}
      </div>
    );
  }
  const path = project.path || '/';
  return (
    <div className={`${BASE}-header`}>
      {mark}
      <div className={`${BASE}-identity`}>
        <span className={`${BASE}-name`} title={label}>
          {label}
        </span>
        <span className={`${BASE}-path`} title={path}>
          {path}
        </span>
      </div>
      {onSwitch ? (
        <button
          type="button"
          className={`${BASE}-iconButton jp-Button`}
          title={trans.__('Switch project')}
          aria-label={trans.__('Switch to another Lightcone project')}
          aria-haspopup="menu"
          onClick={event => onSwitch(event.currentTarget)}
        >
          <caretDownIcon.react tag="span" elementPosition="center" />
        </button>
      ) : null}
      <button
        type="button"
        className={`${BASE}-iconButton jp-Button`}
        title={trans.__('Home')}
        aria-label={trans.__('Open Home for this project')}
        onClick={onHome}
      >
        <homeIcon.react tag="span" elementPosition="center" />
      </button>
    </div>
  );
}

export interface ISidebarActionsProps {
  trans: TranslationBundle;
  pendingComments: number;
  /** Absent when sessions are unavailable. */
  onNewSession?: () => void;
  /** Absent when the search command is not registered. */
  onSearch?: () => void;
  searchShortcut?: string;
}

/** The verbs at the top of the sidebar: New session and Search. */
export function SidebarActions({
  trans,
  pendingComments,
  onNewSession,
  onSearch,
  searchShortcut
}: ISidebarActionsProps): React.ReactElement | null {
  if (!onNewSession && !onSearch && !pendingComments) {
    return null;
  }
  return (
    <div className={`${BASE}-actions`}>
      {onNewSession ? (
        <button
          type="button"
          className={`${BASE}-action`}
          onClick={onNewSession}
        >
          <addIcon.react tag="span" elementPosition="center" />
          <span className={`${BASE}-actionLabel`}>
            {trans.__('New session')}
          </span>
        </button>
      ) : null}
      {onSearch ? (
        <button type="button" className={`${BASE}-action`} onClick={onSearch}>
          <searchIcon.react tag="span" elementPosition="center" />
          <span className={`${BASE}-actionLabel`}>{trans.__('Search')}</span>
          {searchShortcut ? (
            <kbd className={`${BASE}-shortcut`}>{searchShortcut}</kbd>
          ) : null}
        </button>
      ) : null}
      {pendingComments > 0 ? (
        <div className={`${BASE}-comments`} role="status">
          {trans._n(
            '%1 pending comment',
            '%1 pending comments',
            pendingComments,
            pendingComments
          )}
        </div>
      ) : null}
    </div>
  );
}

export interface ISessionsListProps {
  state: ISidebarState;
  activity: (session: ISessionInfo) => SessionState;
  trans: TranslationBundle;
  /** How many sessions to show before the "All" toggle. */
  limit: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (path: string) => void;
  /** Rename the session's chat file. */
  onRename: (session: ISessionInfo) => void;
}

/**
 * The project's sessions, newest first, with working and attention markers.
 * Each row opens its session and offers a rename of its chat file.
 */
export function SessionsList({
  state,
  activity,
  trans,
  limit,
  expanded,
  onToggle,
  onOpen,
  onRename
}: ISessionsListProps): React.ReactElement {
  if (!state.sessionsLoaded) {
    return <Message>{trans.__('Loading sessions…')}</Message>;
  }
  if (state.sessionsError) {
    return <Message error>{state.sessionsError}</Message>;
  }
  if (!state.sessions.length) {
    return <Message>{trans.__('No sessions yet')}</Message>;
  }
  const visible = expanded ? state.sessions : state.sessions.slice(0, limit);
  return (
    <>
      <ul className={`${BASE}-list`}>
        {visible.map(session => {
          const marker = activity(session);
          const active = state.view.session === session.path;
          return (
            <li key={session.path} className={`${BASE}-row`}>
              <button
                type="button"
                className={`${BASE}-item${active ? ' jp-mod-active' : ''}`}
                aria-current={active ? 'true' : undefined}
                title={`${session.title}\n${session.path}`}
                onClick={() => onOpen(session.path)}
              >
                <span
                  className={`${BASE}-marker`}
                  data-state={marker}
                  role={marker === 'idle' ? undefined : 'img'}
                  aria-label={
                    marker === 'working'
                      ? trans.__('Working')
                      : marker === 'attention'
                        ? trans.__('Needs your input')
                        : undefined
                  }
                >
                  {marker === 'attention' ? '!' : ''}
                </span>
                <span className={`${BASE}-title`}>{session.title}</span>
                <span className={`${BASE}-meta`}>
                  {relativeTime(session.modified)}
                </span>
              </button>
              <button
                type="button"
                className={`${BASE}-rowAction jp-Button`}
                title={trans.__('Rename chat file')}
                aria-label={trans.__(
                  'Rename the chat file of %1',
                  session.title
                )}
                onClick={() => onRename(session)}
              >
                <editIcon.react tag="span" elementPosition="center" />
              </button>
            </li>
          );
        })}
      </ul>
      {state.sessions.length > limit ? (
        <button type="button" className={`${BASE}-more`} onClick={onToggle}>
          {expanded
            ? trans.__('Recent only')
            : trans.__('All %1', state.sessions.length)}
        </button>
      ) : null}
    </>
  );
}

function outputIcon(type: ResolvedOutput['type']): LabIcon {
  switch (type) {
    case 'figure':
      return imageIcon;
    case 'table':
      return tableRowsIcon;
    case 'metric':
      return numberingIcon;
    case 'report':
      return markdownIcon;
    default:
      return fileIcon;
  }
}

export interface IResultsListProps {
  state: ISidebarState;
  outputs: readonly ResolvedOutput[];
  statusFor: (output: ResolvedOutput) => OutputStatus | undefined;
  trans: TranslationBundle;
  onOpen: (output: ResolvedOutput) => void;
  onOpenAll: () => void;
  /** An action below the list, such as rematerializing stale results. */
  action?: React.ReactNode;
}

/** The project's outputs with their materialization state. */
export function ResultsList({
  state,
  outputs,
  statusFor,
  trans,
  onOpen,
  onOpenAll,
  action
}: IResultsListProps): React.ReactElement {
  if (!state.data) {
    return (
      <Message error={!!state.error}>
        {state.error ?? trans.__('Loading the project…')}
      </Message>
    );
  }
  if (!outputs.length) {
    return <Message>{trans.__('No results yet')}</Message>;
  }
  const entrypoint = state.project?.entrypoint;
  return (
    <>
      {state.error ? <Message error>{state.error}</Message> : null}
      {state.statusError ? (
        <p className={`${BASE}-note`} role="status" title={state.statusError}>
          {trans.__('Materialization status unavailable')}
        </p>
      ) : null}
      <ul className={`${BASE}-list`}>
        {outputs.map(output => {
          const status = statusFor(output);
          const active =
            state.view.record?.entrypoint === entrypoint &&
            state.view.record?.target === output.canonicalPath &&
            !state.view.record?.doi;
          const Icon = outputIcon(output.type).react;
          return (
            <li key={output.canonicalPath}>
              <button
                type="button"
                className={`${BASE}-item${active ? ' jp-mod-active' : ''}`}
                aria-current={active ? 'true' : undefined}
                title={`${recordTitle(output)}\n${output.canonicalPath}`}
                onClick={() => onOpen(output)}
              >
                <Icon tag="span" elementPosition="center" />
                <span className={`${BASE}-title`}>{recordTitle(output)}</span>
                <span className={`${BASE}-meta`}>
                  {outputKindLabel(output.type)}
                </span>
                <span
                  className={`${BASE}-status`}
                  data-state={status?.state ?? 'unknown'}
                  title={
                    status
                      ? `${status.state}${status.detail ? `: ${status.detail}` : ''}`
                      : (state.statusError ?? trans.__('No status reported'))
                  }
                  aria-label={status?.state}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {action}
      <button type="button" className={`${BASE}-more`} onClick={onOpenAll}>
        {trans.__('All results →')}
      </button>
    </>
  );
}

export interface IAnalysisListProps {
  state: ISidebarState;
  rows: readonly IAnalysisRow[];
  trans: TranslationBundle;
  onOpen: (canonicalPath: string) => void;
}

/**
 * The analysis tree with record counts; each row opens the inventory scoped.
 * The row the current inventory shows is marked.
 */
export function AnalysisList({
  state,
  rows,
  trans,
  onOpen
}: IAnalysisListProps): React.ReactElement {
  if (!state.data) {
    return (
      <Message error={!!state.error}>
        {state.error ?? trans.__('Loading the project…')}
      </Message>
    );
  }
  const scope =
    state.view.inventory === state.project?.entrypoint
      ? state.view.analysisPath
      : undefined;
  return (
    <ul className={`${BASE}-tree`}>
      {rows.map(row => {
        const active = row.canonicalPath === scope;
        return (
          <li key={row.canonicalPath}>
            <button
              type="button"
              className={`${BASE}-node${active ? ' jp-mod-active' : ''}`}
              aria-current={active ? 'true' : undefined}
              style={{ paddingInlineStart: `${10 + row.depth * 14}px` }}
              title={row.canonicalPath}
              onClick={() => onOpen(row.canonicalPath)}
            >
              <span className={`${BASE}-title`}>{row.title}</span>
              <span className={`${BASE}-counts`}>
                {analysisCountsLabel(row)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface ISidebarFooterProps {
  trans: TranslationBundle;
  reportAvailable: boolean;
  onFiles: () => void;
  /** Absent when the MySTRA command is not registered. */
  onReport?: () => void;
  /** Absent when the Runs command is not registered. */
  onRuns?: () => void;
}

/** Files · Report · Runs. */
export function SidebarFooter({
  trans,
  reportAvailable,
  onFiles,
  onReport,
  onRuns
}: ISidebarFooterProps): React.ReactElement {
  return (
    <nav className={`${BASE}-footer`} aria-label={trans.__('Project links')}>
      <button type="button" className={`${BASE}-link`} onClick={onFiles}>
        {trans.__('Files')}
      </button>
      {onReport ? (
        <button
          type="button"
          className={`${BASE}-link`}
          disabled={!reportAvailable}
          title={
            reportAvailable
              ? trans.__('Open the MyST report')
              : trans.__('This project has no myst.yml')
          }
          onClick={onReport}
        >
          {trans.__('Report')}
        </button>
      ) : null}
      {onRuns ? (
        <button type="button" className={`${BASE}-link`} onClick={onRuns}>
          {trans.__('Runs')}
        </button>
      ) : null}
    </nav>
  );
}
