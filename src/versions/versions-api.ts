import { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { apiUrl, requestAPI } from '../request';

/** The DataLad run record the engine writes into a materialization commit. */
export interface IRunCommand {
  cmd: string;
  exit: number;
  inputs: string[];
  outputs: string[];
}

/** One committed version of an output. */
export interface IOutputVersion {
  commit: string;
  /** The first seven characters of the commit. */
  short: string;
  /** Commit time, ISO 8601. */
  time: string;
  /** First line of the commit message. */
  subject: string;
  /** git-annex key of the bytes, when the file is annexed. */
  key: string | null;
  size: number | null;
  /** Whether the bytes are available on this server. */
  present: boolean;
  run: IRunCommand | null;
  /** The manifest sidecar at that commit, when valid. */
  manifest: Record<string, unknown> | null;
}

/** The history of one output. */
export interface IVersionListing {
  /** Project-relative path of the output file. */
  file: string;
  /** Newest first. */
  versions: IOutputVersion[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isRunCommand(value: unknown): value is IRunCommand {
  return (
    isRecord(value) &&
    typeof value.cmd === 'string' &&
    typeof value.exit === 'number' &&
    isStringArray(value.inputs) &&
    isStringArray(value.outputs)
  );
}

/** Narrow a server payload to an output version. */
export function isOutputVersion(value: unknown): value is IOutputVersion {
  return (
    isRecord(value) &&
    typeof value.commit === 'string' &&
    typeof value.short === 'string' &&
    typeof value.time === 'string' &&
    typeof value.subject === 'string' &&
    (value.key === null || typeof value.key === 'string') &&
    (value.size === null || typeof value.size === 'number') &&
    typeof value.present === 'boolean' &&
    (value.run === null || isRunCommand(value.run)) &&
    (value.manifest === null || isRecord(value.manifest))
  );
}

function query(
  entrypoint: string,
  universe: string,
  output: string,
  extra: Record<string, string> = {}
): string {
  return new URLSearchParams({
    path: entrypoint,
    universe,
    output,
    ...extra
  }).toString();
}

/** List the committed versions of an output, newest first. */
export async function listVersions(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: string
): Promise<IVersionListing> {
  try {
    const data = await requestAPI(
      `api/versions?${query(entrypoint, universe, output)}`,
      settings
    );
    if (
      !isRecord(data) ||
      typeof data.file !== 'string' ||
      !Array.isArray(data.versions) ||
      !data.versions.every(isOutputVersion)
    ) {
      throw new Error('The server returned an invalid version listing.');
    }
    return { file: data.file, versions: data.versions };
  } catch (error) {
    throw new RequestError('Versions', error);
  }
}

/** The authenticated URL of an output's bytes at a commit; it never changes. */
export function versionContentUrl(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: string,
  commit: string
): string {
  return `${apiUrl('api/versions/content', settings)}?${query(entrypoint, universe, output, { commit })}`;
}

/** Fetch the bytes of an output at a commit. */
export async function fetchVersionContent(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  universe: string,
  output: string,
  commit: string
): Promise<Blob> {
  const url = versionContentUrl(settings, entrypoint, universe, output, commit);
  const response = await ServerConnection.makeRequest(url, {}, settings);
  if (!response.ok) {
    throw new RequestError(
      'Versions',
      await ServerConnection.ResponseError.create(response)
    );
  }
  return response.blob();
}
