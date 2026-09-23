import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { requestAPI } from '../request';

/** Whether a command-line tool is available to the server. */
export interface ITool {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** An agent adapter the server can start; each fact is reported on its own. */
export interface IAgentSetup {
  id: string;
  name: string;
  /** Whether the Python side (Jupyter AI's ACP client) is installed. */
  installed: boolean;
  executable: { name: string; found: boolean; path: string | null };
  /** Whether Jupyter AI loaded the persona; null until it loads personas. */
  discovered: boolean | null;
  /** Whether credentials were found; null when the server cannot tell. */
  authenticated: boolean | null;
}

/** The project's Python environment, as uv and the engine see it. */
export interface IEnvironmentSetup {
  lock: boolean;
  venv: boolean;
  /** Where recipes run: `.venv` on the host, or an image. */
  mode: 'direct' | 'containerized' | null;
  /** Whether `uv.lock` agrees with `pyproject.toml`; null when unknown. */
  lockCurrent: boolean | null;
  /** Whether `.venv` satisfies the lock (direct mode only); null when unknown. */
  venvCurrent: boolean | null;
}

/** The notebook kernel that runs in the project's environment. */
export interface IKernelSetup {
  /** The kernel spec name, `lightcone-<folder>`. */
  name: string;
  /** The interpreter it runs; null when the host cannot run it. */
  python: string | null;
  /** Whether that interpreter has ipykernel; null when unknown. */
  ipykernel: boolean | null;
  registered: boolean;
}

/** The container runtime and the project's image, as the engine sees them. */
export interface IContainerSetup {
  runtime: string | null;
  image: 'direct' | 'absent' | 'unfetched' | 'present' | null;
}

/** Where runs execute: a SLURM allocation's node count, when inside one. */
export interface IVenue {
  slurm: boolean;
  nodes: number | null;
}

/** git-annex's view of the project's storage. */
export interface IStorageSetup {
  annex: boolean;
  remotes: string[];
  /** Annexed result files, and how many lack their content here. */
  content: { files: number; absent: number } | null;
}

/** A Lightcone or ASTRA skill installed for an agent harness. */
export interface ISkillSetup {
  harness: 'claude' | 'codex';
  name: string;
  version: string | null;
  path: string;
  found: boolean;
}

/** Everything the Customize page shows. */
export interface ISetupReport {
  jupyterAi: boolean;
  agents: IAgentSetup[];
  skills: ISkillSetup[];
  tools: { uv: ITool; git: ITool; 'git-annex': ITool; myst: ITool };
  sandbox: { backend: string | null; available: boolean };
  venue: IVenue;
  environment: IEnvironmentSetup | null;
  kernel: IKernelSetup | null;
  container: IContainerSetup | null;
  instructions: { path: string; exists: boolean } | null;
  storage: IStorageSetup | null;
}

function isBooleanOrNull(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isEnvironment(value: unknown): value is IEnvironmentSetup {
  return (
    isRecord(value) &&
    typeof value.lock === 'boolean' &&
    typeof value.venv === 'boolean' &&
    (value.mode === null ||
      value.mode === 'direct' ||
      value.mode === 'containerized') &&
    isBooleanOrNull(value.lockCurrent) &&
    isBooleanOrNull(value.venvCurrent)
  );
}

/** Narrow a server payload to the project kernel's state. */
export function isKernelSetup(value: unknown): value is IKernelSetup {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    isStringOrNull(value.python) &&
    isBooleanOrNull(value.ipykernel) &&
    typeof value.registered === 'boolean'
  );
}

const IMAGE_STATES: ReadonlySet<unknown> = new Set([
  null,
  'direct',
  'absent',
  'unfetched',
  'present'
]);

function isContainer(value: unknown): value is IContainerSetup {
  return (
    isRecord(value) &&
    isStringOrNull(value.runtime) &&
    IMAGE_STATES.has(value.image)
  );
}

function isVenue(value: unknown): value is IVenue {
  return (
    isRecord(value) &&
    typeof value.slurm === 'boolean' &&
    (value.nodes === null || typeof value.nodes === 'number')
  );
}

function isStorage(value: unknown): value is IStorageSetup {
  return (
    isRecord(value) &&
    typeof value.annex === 'boolean' &&
    Array.isArray(value.remotes) &&
    value.remotes.every(remote => typeof remote === 'string') &&
    (value.content === null ||
      (isRecord(value.content) &&
        typeof value.content.files === 'number' &&
        typeof value.content.absent === 'number'))
  );
}

function isTool(value: unknown): value is ITool {
  return (
    isRecord(value) &&
    typeof value.found === 'boolean' &&
    (value.path === null || typeof value.path === 'string') &&
    (value.version === null || typeof value.version === 'string')
  );
}

function isAgent(value: unknown): value is IAgentSetup {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.installed === 'boolean' &&
    isRecord(value.executable) &&
    typeof value.executable.name === 'string' &&
    typeof value.executable.found === 'boolean' &&
    (value.executable.path === null ||
      typeof value.executable.path === 'string') &&
    isBooleanOrNull(value.discovered) &&
    isBooleanOrNull(value.authenticated)
  );
}

function isSkill(value: unknown): value is ISkillSetup {
  return (
    isRecord(value) &&
    (value.harness === 'claude' || value.harness === 'codex') &&
    typeof value.name === 'string' &&
    (value.version === null || typeof value.version === 'string') &&
    typeof value.path === 'string' &&
    typeof value.found === 'boolean'
  );
}

/** Narrow a server payload to a setup report. */
export function isSetupReport(value: unknown): value is ISetupReport {
  if (!isRecord(value)) return false;
  const tools = value.tools;
  return (
    typeof value.jupyterAi === 'boolean' &&
    Array.isArray(value.agents) &&
    value.agents.every(isAgent) &&
    Array.isArray(value.skills) &&
    value.skills.every(isSkill) &&
    isRecord(tools) &&
    isTool(tools.uv) &&
    isTool(tools.git) &&
    isTool(tools['git-annex']) &&
    isTool(tools.myst) &&
    isRecord(value.sandbox) &&
    (value.sandbox.backend === null ||
      typeof value.sandbox.backend === 'string') &&
    typeof value.sandbox.available === 'boolean' &&
    isVenue(value.venue) &&
    (value.environment === null || isEnvironment(value.environment)) &&
    (value.kernel === null || isKernelSetup(value.kernel)) &&
    (value.container === null || isContainer(value.container)) &&
    (value.instructions === null ||
      (isRecord(value.instructions) &&
        typeof value.instructions.path === 'string' &&
        typeof value.instructions.exists === 'boolean')) &&
    (value.storage === null || isStorage(value.storage))
  );
}

/** What is installed, discovered and configured, for the Customize page. */
export async function fetchSetup(
  settings: ServerConnection.ISettings,
  entrypoint?: string
): Promise<ISetupReport> {
  try {
    const params = entrypoint
      ? `?${new URLSearchParams({ path: entrypoint })}`
      : '';
    const data = await requestAPI(`api/setup${params}`, settings);
    if (!isSetupReport(data)) {
      throw new Error('The server returned an invalid setup report.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Setup', error);
  }
}

/**
 * Register the project's `.venv` as a notebook kernel. The server refuses
 * (409) when the host cannot run it or it lacks ipykernel, and says why.
 */
export async function registerKernel(
  settings: ServerConnection.ISettings,
  entrypoint: string
): Promise<IKernelSetup> {
  try {
    const data = await requestAPI('api/setup/kernel', settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entrypoint })
    });
    if (!isKernelSetup(data)) {
      throw new Error('The server returned an invalid kernel.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Kernel registration', error);
  }
}
