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
