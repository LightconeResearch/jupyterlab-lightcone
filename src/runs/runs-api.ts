import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { requestAPI } from '../request';

/** A materialization recorded in the project's Git history. */
export interface IRunRecord {
  commit: string;
  short: string;
  /** Commit time, ISO 8601. */
  time: string;
  output: string;
  universe: string;
  exit: number | null;
  cmd: string;
  inputs: string[];
  outputs: string[];
}

/** State of a materialization the server started. */
export type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** A materialization started from the UI. */
export interface IJob {
  id: string;
  /** Contents path of the project directory. */
  project: string;
  targets: string[];
  refresh: boolean;
  state: JobState;
  started: string;
  finished: string | null;
  exit: number | null;
  /** The last lines the engine printed. */
  lines: string[];
  /** The engine's JSON report, once the job finished. */
  report: Record<string, unknown> | null;
}

/** Everything the Runs view shows. */
export interface IRunListing {
  runs: IRunRecord[];
  jobs: IJob[];
}

/** The schema ID of job events on the Jupyter Server event bus. */
export const JOB_EVENT_SCHEMA =
  'https://events.lightcone.dev/jupyterlab_lightcone/job/v1';

/** A job event as emitted on the event bus. */
export interface IJobEvent {
  id: string;
  project: string;
  state: JobState;
  line: string | null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isJobState(value: unknown): value is JobState {
  return (
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

/** Narrow a server payload to a run record. */
export function isRunRecord(value: unknown): value is IRunRecord {
  return (
    isRecord(value) &&
    typeof value.commit === 'string' &&
    typeof value.short === 'string' &&
    typeof value.time === 'string' &&
    typeof value.output === 'string' &&
    typeof value.universe === 'string' &&
    (value.exit === null || typeof value.exit === 'number') &&
    typeof value.cmd === 'string' &&
    isStringArray(value.inputs) &&
    isStringArray(value.outputs)
  );
}

/** Narrow a server payload to a job. */
export function isJob(value: unknown): value is IJob {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.project === 'string' &&
    isStringArray(value.targets) &&
    typeof value.refresh === 'boolean' &&
    isJobState(value.state) &&
    typeof value.started === 'string' &&
    (value.finished === null || typeof value.finished === 'string') &&
    (value.exit === null || typeof value.exit === 'number') &&
    isStringArray(value.lines) &&
    (value.report === null || isRecord(value.report))
  );
}

/** Narrow an event bus payload to a job event. */
export function isJobEvent(value: unknown): value is IJobEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.project === 'string' &&
    isJobState(value.state) &&
    (value.line === null || typeof value.line === 'string')
  );
}

function withPath(endpoint: string, entrypoint: string): string {
  return `${endpoint}?${new URLSearchParams({ path: entrypoint })}`;
}

/** The materialization history and this server's jobs for a project. */
export async function listRuns(
  settings: ServerConnection.ISettings,
  entrypoint: string
): Promise<IRunListing> {
  try {
    const data = await requestAPI(withPath('api/runs', entrypoint), settings);
    if (
      !isRecord(data) ||
      !Array.isArray(data.runs) ||
      !data.runs.every(isRunRecord) ||
      !Array.isArray(data.jobs) ||
      !data.jobs.every(isJob)
    ) {
      throw new Error('The server returned an invalid run listing.');
    }
    return { runs: data.runs, jobs: data.jobs };
  } catch (error) {
    throw new RequestError('Runs', error);
  }
}

/** Start `lc materialize` for the project. */
export async function startRun(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  options: { targets?: string[]; refresh?: boolean } = {}
): Promise<IJob> {
  try {
    const data = await requestAPI('api/runs', settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: entrypoint,
        targets: options.targets ?? [],
        refresh: options.refresh ?? false
      })
    });
    if (!isJob(data)) {
      throw new Error('The server returned an invalid job.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Runs', error);
  }
}

/** Read one job. */
export async function getRun(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  id: string
): Promise<IJob> {
  try {
    const data = await requestAPI(
      withPath(`api/runs/${encodeURIComponent(id)}`, entrypoint),
      settings
    );
    if (!isJob(data)) {
      throw new Error('The server returned an invalid job.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Runs', error);
  }
}

/** Stop a running job. */
export async function cancelRun(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  id: string
): Promise<void> {
  try {
    await requestAPI(
      withPath(`api/runs/${encodeURIComponent(id)}`, entrypoint),
      settings,
      {
        method: 'DELETE'
      }
    );
  } catch (error) {
    throw new RequestError('Runs', error);
  }
}
