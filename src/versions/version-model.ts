import type { OutputRun } from '@astra-spec/ui/model';
import { isRecord } from '../api';
import type { ResolvedOutput } from '@astra-spec/sdk';
import type { IOutputVersion } from './versions-api';

/** Where a commit sits in a newest-first history: "v2 of 3". */
export interface IVersionPosition {
  /** Index in the newest-first listing. */
  index: number;
  /** Human ordinal: the oldest version is 1, the newest is `total`. */
  ordinal: number;
  total: number;
}

export function versionPosition(
  versions: readonly IOutputVersion[],
  commit: string | undefined
): IVersionPosition | undefined {
  if (!versions.length) return undefined;
  const index = commit
    ? versions.findIndex(
        version =>
          version.commit === commit ||
          (commit.length >= 7 && version.commit.startsWith(commit))
      )
    : 0;
  if (index < 0) return undefined;
  return { index, ordinal: versions.length - index, total: versions.length };
}

/**
 * The commit `delta` steps away from `commit` in time: -1 is older, +1 is
 * newer. Undefined at either end of the history, or when `commit` is unknown.
 */
export function stepVersion(
  versions: readonly IOutputVersion[],
  commit: string | undefined,
  delta: number
): string | undefined {
  const position = versionPosition(versions, commit);
  if (!position || !Number.isInteger(delta) || delta === 0) return undefined;
  const index = position.index - delta;
  if (index < 0 || index >= versions.length) return undefined;
  return versions[index].commit;
}

/** "208 kB", "1.2 MB"; "unknown size" for null. */
export function formatBytes(size: number | null): string {
  if (size === null || !Number.isFinite(size) || size < 0)
    return 'unknown size';
  if (size < 1000) return `${size} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The lower-case artifact extension of an output, without its dot. */
export function outputFormat(output: Pick<ResolvedOutput, 'format'>): string {
  return (output.format ?? '').replace(/^\./, '').toLowerCase();
}

const IMAGE_FORMATS: ReadonlySet<string> = new Set([
  'avif',
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp'
]);

const DELIMITERS: ReadonlyMap<string, string> = new Map([
  ['csv', ','],
  ['tsv', '\t']
]);

export function isImageFormat(format: string): boolean {
  return IMAGE_FORMATS.has(format);
}

export function delimiterFor(format: string): string | undefined {
  return DELIMITERS.get(format);
}

/** Read a string field of a manifest, or undefined. */
export function manifestString(
  manifest: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = manifest?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read a string map of a manifest (input or decision versions). */
export function manifestStringMap(
  manifest: Record<string, unknown> | null | undefined,
  key: string
): Record<string, string> {
  const value = manifest?.[key];
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value))
    if (typeof item === 'string') result[name] = item;
  return result;
}

/** Everything the Run and Environment tabs show about one materialization. */
export interface IRunView {
  /** Where the facts come from: a committed version, or the current sidecar. */
  source: 'version' | 'record';
  commit?: string;
  short?: string;
  time?: string;
  started?: string;
  /**
   * The output's recipe as the run expanded it, which names its script; not
   * recorded by a version committed without a manifest.
   */
  recipe?: string;
  gitRevision?: string;
  engineVersion?: string;
  environmentVersion?: string;
  uvVersion?: string;
  image?: string;
  sandbox?: string;
  definitionVersion?: string;
  dataVersion?: string;
  inputVersions: Record<string, string>;
  decisions: Record<string, string>;
}

/**
 * Describe one materialization: a committed version from its manifest at
 * that commit, or, when no version is described, the current run record
 * (the sidecar). A version never borrows the sidecar's facts: the sidecar
 * describes the latest run, so a version committed without a valid manifest
 * shows only what its commit recorded. Undefined when neither exists.
 */
export function runView(
  run: OutputRun | null | undefined,
  version: IOutputVersion | undefined
): IRunView | undefined {
  if (!version && !run) return undefined;
  const manifest = version?.manifest;
  const sidecar = version ? undefined : run;
  const image = manifest?.image;
  return {
    source: version ? 'version' : 'record',
    commit: version?.commit,
    short: version?.short,
    time:
      manifestString(manifest, 'finished_at') ??
      version?.time ??
      sidecar?.finishedAt,
    started: manifestString(manifest, 'started_at'),
    recipe: manifestString(manifest, 'recipe') ?? sidecar?.recipe,
    gitRevision: manifestString(manifest, 'git_sha') ?? sidecar?.gitRevision,
    engineVersion:
      manifestString(manifest, 'lc_version') ?? sidecar?.cliVersion,
    environmentVersion:
      manifestString(manifest, 'env_version') ?? sidecar?.environment,
    uvVersion: manifestString(manifest, 'uv_version'),
    image: isRecord(image) ? manifestString(image, 'tag') : undefined,
    sandbox: sandboxLine(manifest),
    definitionVersion: manifestString(manifest, 'definition_version'),
    dataVersion: manifestString(manifest, 'data_version'),
    inputVersions: manifest
      ? manifestStringMap(manifest, 'input_versions')
      : { ...(sidecar?.inputVersions ?? {}) },
    decisions: manifestStringMap(manifest, 'decisions')
  };
}

/** "landlock: enforced · network: none" from a manifest's hermeticity block. */
export function sandboxLine(
  manifest: Record<string, unknown> | null | undefined
): string | undefined {
  const value = manifest?.hermeticity;
  if (typeof value === 'string') return value || undefined;
  if (!isRecord(value)) return undefined;
  const parts = Object.entries(value)
    .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
    .map(([key, item]) => `${key}: ${String(item)}`);
  return parts.length ? parts.join(' · ') : undefined;
}
