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
