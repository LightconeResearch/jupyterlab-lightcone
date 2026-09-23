import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { requestAPI } from '../request';

/** Whether a command-line tool is available to the server. */
export interface ITool {
  found: boolean;
  path: string | null;
  version: string | null;
}

/** An agent adapter the server can start. */
export interface IAgentSetup {
  id: string;
  name: string;
  /** Whether the Python side (Jupyter AI's ACP client) is installed. */
  installed: boolean;
  executable: { name: string; found: boolean; path: string | null };
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
  environment: { lock: boolean; venv: boolean } | null;
  instructions: { path: string; exists: boolean } | null;
  storage: { annex: boolean; remotes: string[] } | null;
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
      typeof value.executable.path === 'string')
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
    (value.environment === null ||
      (isRecord(value.environment) &&
        typeof value.environment.lock === 'boolean' &&
        typeof value.environment.venv === 'boolean')) &&
    (value.instructions === null ||
      (isRecord(value.instructions) &&
        typeof value.instructions.path === 'string' &&
        typeof value.instructions.exists === 'boolean')) &&
    (value.storage === null ||
      (isRecord(value.storage) &&
        typeof value.storage.annex === 'boolean' &&
        Array.isArray(value.storage.remotes) &&
        value.storage.remotes.every(remote => typeof remote === 'string')))
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
