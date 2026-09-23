import { isRecord, RequestError } from '../api';
import type { MaterializationStatuses } from '../materialization-status';
import { projectDirectory } from '../project-data';
import type { IJob, IJobEvent, IRunRecord, JobState } from './runs-api';

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

/** Human duration: `12 s`, `3 min 4 s`, `1 h 2 min`. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours} h ${minutes} min`;
  }
  if (minutes > 0) {
    return `${minutes} min ${seconds} s`;
  }
  return `${seconds} s`;
}

/** How long a job has run, or ran. */
export function formatElapsed(
  job: Pick<IJob, 'started' | 'finished'>,
  now = Date.now()
): string {
  const started = Date.parse(job.started);
  const end = job.finished === null ? now : Date.parse(job.finished);
  if (Number.isNaN(started) || Number.isNaN(end)) {
    return '';
  }
  return formatDuration(end - started);
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

/** A full local timestamp for tooltips. */
export function formatTimestamp(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString();
}

function localDay(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `Today`, `Yesterday`, or the date, in the viewer's time zone. */
export function dayLabel(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  const day = localDay(time);
  if (day === localDay(now)) {
    return 'Today';
  }
  if (day === localDay(now - 24 * 3600 * 1000)) {
    return 'Yesterday';
  }
  return new Date(time).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

export interface IRunGroup {
  /** The local calendar day, `YYYY-MM-DD`. */
  day: string;
  label: string;
  runs: IRunRecord[];
}

/** Group a newest-first history by local day, keeping the order given. */
export function groupRunsByDay(
  runs: readonly IRunRecord[],
  now = Date.now()
): IRunGroup[] {
  const groups: IRunGroup[] = [];
  for (const run of runs) {
    const time = Date.parse(run.time);
    const day = Number.isNaN(time) ? run.time : localDay(time);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.runs.push(run);
    } else {
      groups.push({ day, label: dayLabel(run.time, now), runs: [run] });
    }
  }
  return groups;
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

/** `Materialize everything`, `Refresh hubble_diagram, cosmology_fit`. */
export function jobTitle(job: Pick<IJob, 'targets' | 'refresh'>): string {
  const verb = job.refresh ? 'Refresh' : 'Materialize';
  return `${verb} ${describeTargets(job.targets)}`;
}

/** What the engine accepts: an output id, or `<universe>/<output>`. */
const TARGET_PATTERN =
  /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/;

/** Split typed targets on spaces and commas; refuse anything the engine would misread. */
export function parseTargets(text: string): {
  targets: string[];
  invalid: string[];
} {
  const targets: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/)) {
    if (!token) {
      continue;
    }
    if (!TARGET_PATTERN.test(token)) {
      if (!invalid.includes(token)) {
        invalid.push(token);
      }
    } else if (!targets.includes(token)) {
      targets.push(token);
    }
  }
  return { targets, invalid };
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

/**
 * Identifies the last end in a newest-first job list. A project runs one job
 * at a time, so its newest finished job is the last to end. The key changes
 * whenever a job ends or its final record arrives, even once the list is at
 * its cap and the number of finished jobs no longer changes.
 */
export function lastEndKey(jobs: readonly IJob[]): string {
  const ended = jobs.find(isFinished);
  return ended ? `${ended.id}:${ended.finished ?? ''}` : '';
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

/** One line describing how a job ended, for toasts and the Running panel. */
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

/** A running job as the Running panel lists it; the section adds the icon. */
export interface IJobRunningItem {
  label(): string;
  labelTitle(): string;
  detail(): string;
  /** The project's entrypoint, kept on the item's `data-context`. */
  context: string;
  open(): void;
  shutdown(): void;
}

export interface IRunningJobActions {
  open(entrypoint: string): void;
  stop(entrypoint: string, id: string): void;
}

function projectLabel(entrypoint: string): string {
  try {
    return projectDirectory(entrypoint) || '/';
  } catch {
    return entrypoint;
  }
}

/** Running-panel items for running jobs, one per job. */
export function jobRunningItems(
  jobs: readonly { entrypoint: string; job: IJob }[],
  actions: IRunningJobActions
): IJobRunningItem[] {
  return jobs.map(({ entrypoint, job }) => ({
    label: () => jobTitle(job),
    labelTitle: () => `${jobTitle(job)} · ${projectLabel(entrypoint)}`,
    detail: () => formatElapsed(job),
    context: entrypoint,
    open: () => actions.open(entrypoint),
    shutdown: () => actions.stop(entrypoint, job.id)
  }));
}

/** The ASTRA path of a root-analysis output. */
export function outputTargetPath(outputId: string): string {
  return `outputs.${outputId}`;
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
