import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { requestAPI } from '../request';

/** The kinds of cluster a server can start. */
export type ComputeBackend = 'local' | 'slurm' | 'gateway';

/** What a place runs can go is doing now. */
export type TargetState =
  | 'ready'
  | 'check-only'
  | 'queued'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'unknown';

/** Which kind of host the Jupyter server runs on. */
export type HostVariant = 'machine' | 'server' | 'login' | 'allocation';

/** Why a target cannot run this project's recipes as it is. */
export interface IComputeProblem {
  code: string;
  message: string;
}

export interface IComputeSize {
  threads: number | null;
  nodes: number | null;
  workers: number | null;
  /** The adaptive ceiling, when the actual worker count is unavailable. */
  maxWorkers?: number;
}

/** What a running cluster's scheduler reports. */
export interface IComputeLoad {
  workers: number;
  threads: number;
  busy: number;
}

/** A place runs can go: this host, or a cluster. */
export interface IComputeTarget {
  id: string;
  kind: 'host' | 'cluster';
  backend: ComputeBackend | null;
  /** The host's kind; clusters have none. */
  variant?: HostVariant;
  /** A cluster's preset label. */
  label?: string | null;
  state: TargetState;
  /** Whether `lc materialize` in this project will run here. */
  active: boolean;
  /** Why this cluster cannot serve this project from here, or null. */
  other: string | null;
  problem: IComputeProblem | null;
  size: IComputeSize;
  load?: IComputeLoad | null;
  /** Seconds before the cluster's time limit. */
  timeLeft?: number | null;
  /** When a queued cluster is expected to start, ISO 8601. */
  startEstimate?: string | null;
  dashboard?: string | null;
  /** Facts for the cluster's menu: job, queue, account, gateway name. */
  details?: string[];
}

/** A cluster that ended on its own since the listing before. */
export interface IEndedCluster {
  id: string;
  backend: ComputeBackend;
  label: string | null;
  /** Words that follow "Your cluster …", such as "reached its time limit". */
  reason: string;
}

/** Everything the Compute section shows. */
export interface IComputeListing {
  /** Whether the installed engine can use these clusters. */
  attaches: boolean;
  lightcone: string | null;
  /** The backends this server can start clusters on. */
  backends: ComputeBackend[];
  /** This host first, then every known cluster. */
  targets: IComputeTarget[];
  ended: IEndedCluster[];
}

/**
 * A named cluster size, from the Compute settings. Which fields apply
 * depends on the backend: `threads` (local), `nodes`, `time`, `qos`,
 * `constraint`, `account` (Slurm), `workers`, `cores`, `memory` (Gateway).
 */
export interface IClusterPreset {
  label: string;
  backend: ComputeBackend;
  description?: string;
  threads?: number;
  nodes?: number;
  time?: string;
  qos?: string;
  constraint?: string;
  account?: string;
  workers?: number;
  cores?: number;
  memory?: number;
}

const BACKENDS: readonly string[] = ['local', 'slurm', 'gateway'];
const STATES: readonly string[] = [
  'ready',
  'check-only',
  'queued',
  'starting',
  'running',
  'stopping',
  'unknown'
];
const VARIANTS: readonly string[] = [
  'machine',
  'server',
  'login',
  'allocation'
];

export function isBackend(value: unknown): value is ComputeBackend {
  return typeof value === 'string' && BACKENDS.includes(value);
}

function isCount(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isOptional<T>(
  value: unknown,
  guard: (item: unknown) => item is T
): boolean {
  return value === undefined || value === null || guard(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isProblem(value: unknown): value is IComputeProblem {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function isLoad(value: unknown): value is IComputeLoad {
  return (
    isRecord(value) &&
    typeof value.workers === 'number' &&
    typeof value.threads === 'number' &&
    typeof value.busy === 'number'
  );
}

/** Narrow a server payload to a target. */
export function isComputeTarget(value: unknown): value is IComputeTarget {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'host' || value.kind === 'cluster') &&
    (value.backend === null || isBackend(value.backend)) &&
    (value.variant === undefined ||
      (typeof value.variant === 'string' &&
        VARIANTS.includes(value.variant))) &&
    typeof value.state === 'string' &&
    STATES.includes(value.state) &&
    typeof value.active === 'boolean' &&
    (value.other === null || typeof value.other === 'string') &&
    (value.problem === null || isProblem(value.problem)) &&
    isRecord(value.size) &&
    isCount(value.size.threads) &&
    isCount(value.size.nodes) &&
    isCount(value.size.workers) &&
    (value.size.maxWorkers === undefined ||
      typeof value.size.maxWorkers === 'number') &&
    isOptional(value.label, isString) &&
    isOptional(value.load, isLoad) &&
    isOptional(value.dashboard, isString) &&
    isOptional(value.startEstimate, isString) &&
    (value.timeLeft === undefined || isCount(value.timeLeft)) &&
    (value.details === undefined ||
      (Array.isArray(value.details) && value.details.every(isString)))
  );
}

function isEnded(value: unknown): value is IEndedCluster {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isBackend(value.backend) &&
    (value.label === null || typeof value.label === 'string') &&
    typeof value.reason === 'string'
  );
}

/** Narrow a server payload to a listing. */
export function isComputeListing(value: unknown): value is IComputeListing {
  return (
    isRecord(value) &&
    typeof value.attaches === 'boolean' &&
    (value.lightcone === null || typeof value.lightcone === 'string') &&
    Array.isArray(value.backends) &&
    value.backends.every(isBackend) &&
    Array.isArray(value.targets) &&
    value.targets.every(isComputeTarget) &&
    Array.isArray(value.ended) &&
    value.ended.every(isEnded)
  );
}

/** Where runs can go for a project (or for none), and which one they will. */
export async function fetchCompute(
  settings: ServerConnection.ISettings,
  entrypoint: string | null
): Promise<IComputeListing> {
  const endpoint = entrypoint
    ? `api/compute?${new URLSearchParams({ path: entrypoint })}`
    : 'api/compute';
  try {
    const data = await requestAPI(endpoint, settings);
    if (!isComputeListing(data)) {
      throw new Error('The server returned an invalid compute listing.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Compute', error);
  }
}

/** Start a cluster from a preset; resolves to the new cluster's target. */
export async function startCluster(
  settings: ServerConnection.ISettings,
  preset: IClusterPreset,
  entrypoint: string | null
): Promise<IComputeTarget> {
  try {
    const data = await requestAPI('api/compute/clusters', settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, path: entrypoint })
    });
    if (!isComputeTarget(data)) {
      throw new Error('The server returned an invalid cluster.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Cluster', error);
  }
}

/** Ask a cluster's backend to end it. */
export async function stopCluster(
  settings: ServerConnection.ISettings,
  id: string
): Promise<void> {
  try {
    await requestAPI(
      `api/compute/clusters/${encodeURIComponent(id)}`,
      settings,
      { method: 'DELETE' }
    );
  } catch (error) {
    throw new RequestError('Cluster', error);
  }
}
