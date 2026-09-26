/** A Git object name accepted by the historical-content routes. */
export const COMMIT_PATTERN = /^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/i;

import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { apiUrl, requestAPI } from '../request';

/** Where git-annex keeps a version's bytes. */
export interface IAnnexedBytes {
  /** The git-annex key of the bytes. */
  key: string;
  /** Whether this repository holds the bytes. */
  here: boolean;
  /** The other repositories git-annex knows to hold a copy, by description. */
  remotes: string[];
}

/**
 * Whether git-annex can be asked in the project's repository: `uninitialized`
 * is a clone of an annexed repository nobody ran `git annex init` in, `none`
 * a repository without an annex.
 */
export type AnnexState = 'initialized' | 'uninitialized' | 'none';

/** One committed version of an output. */
export interface IOutputVersion {
  /** Project-relative file at this revision, including its historical format. */
  file?: string;
  commit: string;
  /** The first seven characters of the commit. */
  short: string;
  /** Commit time, ISO 8601. */
  time: string;
  /** First line of the commit message. */
  subject: string;
  /** Size of the bytes, from git or from the annex key; null when unknown. */
  size: number | null;
  /** Whether the bytes can be served: held by git, or by git-annex here. */
  present: boolean;
  /** Where git-annex keeps the bytes; null when git holds them, or nothing can be asked. */
  annex: IAnnexedBytes | null;
  /** The manifest sidecar at that commit, when valid. */
  manifest: Record<string, unknown> | null;
}

/** Why a version's bytes cannot be shown, for a banner. */
export function absentReason(version: IOutputVersion): string {
  const held = version.annex;
  if (held && !held.here) {
    const copies = held.remotes.length
      ? ` ${held.remotes.join(', ')} ${held.remotes.length === 1 ? 'has' : 'have'} a copy (git annex get).`
      : '';
    return `The bytes of this version are in git-annex but not in this repository.${copies}`;
  }
  return 'The bytes of this version are not in this repository.';
}

/** An output a commit under `results/` changed. */
export interface ICommittedOutput {
  universe: string;
  output: string;
}

/** A commit that touched the project's results, and the outputs it changed. */
export interface IResultsCommit {
  commit: string;
  short: string;
  /** Commit time, ISO 8601. */
  time: string;
  subject: string;
  outputs: ICommittedOutput[];
}

/** The history of one output. */
export interface IVersionListing {
  /** Project-relative path of the output file. */
  file: string;
  /** Whether git-annex could be asked about the versions' bytes. */
  annex: AnnexState;
  /** Newest first. */
  versions: IOutputVersion[];
}

function isAnnexedBytes(value: unknown): value is IAnnexedBytes {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.here === 'boolean' &&
    Array.isArray(value.remotes) &&
    value.remotes.every(remote => typeof remote === 'string')
  );
}

function isAnnexState(value: unknown): value is AnnexState {
  return (
    value === 'initialized' || value === 'uninitialized' || value === 'none'
  );
}

/** Narrow a server payload to an output version. */
export function isOutputVersion(value: unknown): value is IOutputVersion {
  return (
    isRecord(value) &&
    typeof value.commit === 'string' &&
    (value.file === undefined || typeof value.file === 'string') &&
    typeof value.short === 'string' &&
    typeof value.time === 'string' &&
    typeof value.subject === 'string' &&
    (value.size === null || typeof value.size === 'number') &&
    typeof value.present === 'boolean' &&
    (value.annex === null || isAnnexedBytes(value.annex)) &&
    (value.manifest === null || isRecord(value.manifest))
  );
}

function isCommittedOutput(value: unknown): value is ICommittedOutput {
  return (
    isRecord(value) &&
    typeof value.universe === 'string' &&
    typeof value.output === 'string'
  );
}

/** Narrow a server payload to a results commit. */
export function isResultsCommit(value: unknown): value is IResultsCommit {
  return (
    isRecord(value) &&
    typeof value.commit === 'string' &&
    typeof value.short === 'string' &&
    typeof value.time === 'string' &&
    typeof value.subject === 'string' &&
    Array.isArray(value.outputs) &&
    value.outputs.every(isCommittedOutput)
  );
}

/** Bounds of a results history request; times are seconds since the epoch. */
export interface IResultsWindow {
  since?: number;
  until?: number;
  limit?: number;
}

/**
 * The commits that touched the project's results, newest first, with the
 * outputs each one changed; bounded to the window when one is given.
 */
export async function listResultsCommits(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  window: IResultsWindow = {}
): Promise<IResultsCommit[]> {
  const params = new URLSearchParams({ path: entrypoint });
  for (const [name, value] of Object.entries(window)) {
    if (value !== undefined) {
      params.set(name, String(Math.floor(value)));
    }
  }
  try {
    const data = await requestAPI(`api/versions/results?${params}`, settings);
    if (
      !isRecord(data) ||
      !Array.isArray(data.commits) ||
      !data.commits.every(isResultsCommit)
    ) {
      throw new Error('The server returned an invalid results history.');
    }
    return data.commits;
  } catch (error) {
    throw new RequestError('Results history', error);
  }
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
      !isAnnexState(data.annex) ||
      !Array.isArray(data.versions) ||
      !data.versions.every(isOutputVersion)
    ) {
      throw new Error('The server returned an invalid version listing.');
    }
    return { file: data.file, annex: data.annex, versions: data.versions };
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

/** A project file as a recorded revision held it. */
export interface IRevisionSource {
  /** Project-relative path. */
  file: string;
  /** The full commit name the revision resolved to. */
  commit: string;
  /** Whether the file existed at that revision. */
  exists: boolean;
  /** The file's text; null when it is absent, binary, annexed or too large. */
  text: string | null;
  binary: boolean;
  annexed: boolean;
  truncated: boolean;
}

/**
 * One distinct name/version pin in `uv.lock`; local packages may have no
 * version. A universal lock can list several versions of the same package.
 */
export interface ILockedPackage {
  name: string;
  version: string | null;
}

/** The packages locked at a revision and those locked now. */
export interface ILockedPackages {
  commit: string;
  /** Null when the revision has no readable `uv.lock`. */
  packages: ILockedPackage[] | null;
  /** Null when the working tree has no readable `uv.lock`. */
  current: ILockedPackage[] | null;
}

/** Narrow a server payload to a file at a revision. */
export function isRevisionSource(value: unknown): value is IRevisionSource {
  return (
    isRecord(value) &&
    typeof value.file === 'string' &&
    typeof value.commit === 'string' &&
    typeof value.exists === 'boolean' &&
    (value.text === null || typeof value.text === 'string') &&
    typeof value.binary === 'boolean' &&
    typeof value.annexed === 'boolean' &&
    typeof value.truncated === 'boolean'
  );
}

function isLockedPackageList(value: unknown): value is ILockedPackage[] {
  return (
    Array.isArray(value) &&
    value.every(
      item =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        (item.version === null || typeof item.version === 'string')
    )
  );
}

/** Narrow a server payload to the locked packages of a revision. */
export function isLockedPackages(value: unknown): value is ILockedPackages {
  return (
    isRecord(value) &&
    typeof value.commit === 'string' &&
    (value.packages === null || isLockedPackageList(value.packages)) &&
    (value.current === null || isLockedPackageList(value.current))
  );
}

/** Read a project file (a recipe's script) as a commit held it. */
export async function fetchRevisionSource(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  commit: string,
  file: string
): Promise<IRevisionSource> {
  try {
    const params = new URLSearchParams({ path: entrypoint, commit, file });
    const data = await requestAPI(`api/versions/source?${params}`, settings);
    if (!isRevisionSource(data)) {
      throw new Error('The server returned an invalid recorded file.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Recorded code', error);
  }
}

/** Read the packages `uv.lock` pinned at a commit, beside today's. */
export async function fetchLockedPackages(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  commit: string
): Promise<ILockedPackages> {
  try {
    const params = new URLSearchParams({ path: entrypoint, commit });
    const data = await requestAPI(`api/versions/packages?${params}`, settings);
    if (!isLockedPackages(data)) {
      throw new Error('The server returned an invalid package list.');
    }
    return data;
  } catch (error) {
    throw new RequestError('Recorded environment', error);
  }
}
