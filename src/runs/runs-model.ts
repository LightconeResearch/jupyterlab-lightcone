import { isRecord, RequestError } from '../api';
import type { MaterializationStatuses } from '../materialization-status';
import type { IJob, IJobEvent, JobState } from './runs-api';

/** The server keeps this many lines per job; the client keeps the same. */
export const JOB_LINE_LIMIT = 200;

/** The server lists this many jobs per project; the client keeps the same. */
export const JOB_LIST_LIMIT = 20;

/** Terminal states sort after `running`, so a stale update never revives a job. */
const STATE_RANK: Record<JobState, number> = {
  running: 0,
  succeeded: 1,
  failed: 1,
  cancelled: 1
};

/** Whether a job reached a terminal state. */
export function isFinished(job: Pick<IJob, 'state'>): boolean {
  return job.state !== 'running';
}

/** `just now`, `5 min ago`, `yesterday`, `3 days ago`. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.round(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/** `everything`, `a, b, c`, or `a, b, c and 2 more`. */
export function describeTargets(targets: readonly string[]): string {
  if (targets.length === 0) {
    return 'everything';
  }
  if (targets.length <= 3) {
    return targets.join(', ');
  }
  return `${targets.slice(0, 3).join(', ')} and ${targets.length - 3} more`;
}

/** Fold one event bus emission into the job it concerns. */
export function applyJobEvent(
  job: IJob,
  event: IJobEvent,
  now = Date.now()
): IJob {
  const lines =
    event.line === null
      ? job.lines
      : [...job.lines, event.line].slice(-JOB_LINE_LIMIT);
  const state =
    STATE_RANK[event.state] >= STATE_RANK[job.state] ? event.state : job.state;
  // The event carries no times; a placeholder keeps the elapsed time from
  // ticking until the next `getRun` brings the recorded one.
  const finished =
    job.finished ??
    (isFinished({ state }) ? new Date(now).toISOString() : null);
  return { ...job, state, lines, finished };
}

/** Combine two snapshots of one job so no update moves it backwards. */
export function mergeJob(existing: IJob, incoming: IJob): IJob {
  const newer =
    STATE_RANK[incoming.state] >= STATE_RANK[existing.state]
      ? incoming
      : existing;
  const older = newer === incoming ? existing : incoming;
  return {
    ...newer,
    lines: newer.lines.length >= older.lines.length ? newer.lines : older.lines,
    exit: newer.exit ?? older.exit,
    report: newer.report ?? older.report,
    finished: newer.finished ?? older.finished
  };
}

/** Insert or update a job, newest first, within the server's list cap. */
export function upsertJob(jobs: readonly IJob[], job: IJob): IJob[] {
  const existing = jobs.find(item => item.id === job.id);
  const merged = existing ? mergeJob(existing, job) : job;
  return [merged, ...jobs.filter(item => item.id !== job.id)]
    .sort((a, b) => Date.parse(b.started) - Date.parse(a.started))
    .slice(0, JOB_LIST_LIMIT);
}

export interface IReportReason {
  /** `<universe>/<output>`. */
  key: string;
  why: string;
}

/** The engine's `MaterializeReport`, validated. */
export interface IReportSummary {
  ok: boolean;
  upToDate: boolean;
  made: string[];
  current: string[];
  behind: IReportReason[];
  failed: string[];
  blocked: string[];
  planned: IReportReason[];
  warnings: string[];
  notes: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function reasons(value: unknown): IReportReason[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, why]) =>
    typeof why === 'string' ? [{ key, why }] : []
  );
}

/** Read the engine's report; null when the job produced none or it is not one. */
export function summarizeReport(report: IJob['report']): IReportSummary | null {
  if (report === null || typeof report.ok !== 'boolean') {
    return null;
  }
  return {
    ok: report.ok,
    upToDate: report.up_to_date === true,
    made: strings(report.made),
    current: strings(report.current),
    behind: reasons(report.behind),
    failed: strings(report.failed),
    blocked: strings(report.blocked),
    planned: reasons(report.planned),
    warnings: strings(report.warnings),
    notes: strings(report.notes)
  };
}

/**
 * The engine's own words when it refused to run: a dirty tree, a login node,
 * a missing committer. Such a job fails before printing any report.
 */
export function refusalText(job: IJob): string | null {
  if (job.state !== 'failed' || job.report !== null) {
    return null;
  }
  const text = job.lines.join('\n').trim();
  if (text) {
    return text;
  }
  return job.exit === null
    ? 'The engine stopped without a report.'
    : `The engine exited with code ${job.exit} without a report.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One line describing how a job ended, for the notification that follows it. */
export function jobOutcome(job: IJob): string {
  const summary = summarizeReport(job.report);
  switch (job.state) {
    case 'running':
      return 'Materializing…';
    case 'cancelled':
      return 'Materialization stopped.';
    case 'succeeded':
      if (summary && summary.made.length > 0) {
        return `Materialized ${plural(summary.made.length, 'output')}: ${summary.made.join(', ')}`;
      }
      return summary?.upToDate
        ? 'Everything is already current.'
        : 'Materialization finished.';
    case 'failed': {
      const refusal = refusalText(job);
      if (refusal !== null) {
        return refusal.split('\n').find(line => line.trim()) ?? refusal;
      }
      if (summary && summary.failed.length > 0) {
        return `${plural(summary.failed.length, 'output')} failed: ${summary.failed.join(', ')}`;
      }
      if (summary && summary.blocked.length > 0) {
        return `${plural(summary.blocked.length, 'output')} blocked.`;
      }
      return job.exit === null
        ? 'Materialization failed.'
        : `Materialization failed with exit code ${job.exit}.`;
    }
  }
}

/** Outputs the status report marks as stale or behind, as engine targets. */
export function staleTargets(statuses: MaterializationStatuses | undefined): {
  stale: string[];
  behind: string[];
} {
  const stale: string[] = [];
  const behind: string[] = [];
  for (const [key, status] of Object.entries(statuses ?? {})) {
    if (status.state === 'stale') {
      stale.push(key);
    } else if (status.state === 'behind') {
      behind.push(key);
    }
  }
  return { stale: stale.sort(), behind: behind.sort() };
}

/** The one materialization Home and the sidebar offer for out-of-date results. */
export interface IRematerializeAction {
  /** Stale outputs are remade; behind ones only need `--refresh`. */
  kind: 'stale' | 'behind';
  targets: string[];
  refresh: boolean;
  /** "Rematerialize stale (2)" or "Refresh behind (1)". */
  label: string;
}

/**
 * What to offer for a status report: remaking the stale outputs first, since
 * their results no longer match their definition; else refreshing the ones
 * behind; nothing when every output is current or the status is unknown.
 */
export function rematerializeAction(
  statuses: MaterializationStatuses | undefined
): IRematerializeAction | null {
  const { stale, behind } = staleTargets(statuses);
  if (stale.length) {
    return {
      kind: 'stale',
      targets: stale,
      refresh: false,
      label: `Rematerialize stale (${stale.length})`
    };
  }
  if (behind.length) {
    return {
      kind: 'behind',
      targets: behind,
      refresh: true,
      label: `Refresh behind (${behind.length})`
    };
  }
  return null;
}

/** The `astra.yaml` of a project directory, as job events name projects. */
export function entrypointForProject(project: string): string {
  if (!project || project.endsWith(':')) {
    return `${project}astra.yaml`;
  }
  return `${project}/astra.yaml`;
}

/** Why a job could not start, in the user's terms. */
export function startErrorMessage(error: unknown): string {
  if (error instanceof RequestError && error.status === 409) {
    return 'A materialization is already running for this project. Wait for it to finish or stop it first.';
  }
  return error instanceof Error ? error.message : String(error);
}
