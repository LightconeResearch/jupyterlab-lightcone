import type { ResolvedOutput } from '@astra-spec/sdk';
import type { OutputRun } from '@astra-spec/ui/model';
import { isRecord } from '../api';
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

const RELATIVE_UNITS: readonly [number, string][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.348, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year']
];

/** "2 days ago", "in 3 hours", "just now"; the ISO text itself when unparseable. */
export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  let amount = (now - time) / 1000;
  const past = amount >= 0;
  amount = Math.abs(amount);
  if (amount < 45) return 'just now';
  for (const [size, unit] of RELATIVE_UNITS) {
    if (amount < size) {
      const count = Math.max(1, Math.round(amount));
      const label = `${count} ${unit}${count === 1 ? '' : 's'}`;
      return past ? `${label} ago` : `in ${label}`;
    }
    amount /= size;
  }
  return iso;
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

/** One numeric leaf of a JSON metric, before and after. */
export interface IMetricDelta {
  /** Dotted path of the leaf; `value` for a bare number. */
  key: string;
  older: number | undefined;
  newer: number | undefined;
  /** newer − older, when both sides are numbers. */
  delta: number | undefined;
}

/** The leaf-by-leaf comparison of two JSON metric documents. */
export interface IMetricComparison {
  deltas: IMetricDelta[];
  /** A document held more numeric leaves than were compared. */
  truncated: boolean;
}

/**
 * At most this many numeric leaves are read from each document: a metric
 * holds a handful, and a 2 MB array must not stall the page.
 */
export const METRIC_LEAF_LIMIT = 500;

/** Collects numeric leaves up to a limit. */
class LeafCollector {
  constructor(readonly limit: number) {}

  readonly leaves = new Map<string, number>();
  truncated = false;

  /** Add one leaf; false once the limit is reached. */
  add(key: string, value: number): boolean {
    if (this.leaves.size >= this.limit) {
      this.truncated = true;
      return false;
    }
    this.leaves.set(key, value);
    return true;
  }
}

function numericLeaves(
  value: unknown,
  prefix: string,
  depth: number,
  into: LeafCollector
): void {
  if (into.truncated) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.add(prefix || 'value', value);
    return;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) into.add(prefix || 'value', parsed);
    return;
  }
  if (depth >= 3) return;
  const child = (key: string) => (prefix ? `${prefix}.${key}` : key);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && !into.truncated; index += 1)
      numericLeaves(value[index], child(String(index)), depth + 1, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (into.truncated) return;
    numericLeaves(value[key], child(key), depth + 1, into);
  }
}

/**
 * Numeric differences between two JSON metric documents, leaf by leaf, in
 * the order the newer document lists them followed by leaves only the older
 * one has. Nested objects and arrays are flattened to dotted keys, three
 * levels deep. Each document contributes at most `limit` leaves.
 */
export function metricDeltas(
  older: unknown,
  newer: unknown,
  limit = METRIC_LEAF_LIMIT
): IMetricComparison {
  const before = new LeafCollector(limit);
  const after = new LeafCollector(limit);
  numericLeaves(older, '', 0, before);
  numericLeaves(newer, '', 0, after);
  const keys = new Set([...after.leaves.keys(), ...before.leaves.keys()]);
  const deltas = Array.from(keys, key => {
    const a = before.leaves.get(key);
    const b = after.leaves.get(key);
    return {
      key,
      older: a,
      newer: b,
      delta: a !== undefined && b !== undefined ? b - a : undefined
    };
  });
  return { deltas, truncated: before.truncated || after.truncated };
}

/** Format a metric value for a delta table. */
export function formatNumber(value: number | undefined): string {
  if (value === undefined) return '—';
  if (Number.isInteger(value)) return value.toLocaleString();
  const magnitude = Math.abs(value);
  return magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)
    ? value.toExponential(3)
    : value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

/** Shape of a delimited table: header and row count. */
export interface ITableShape {
  headers: string[];
  rows: number;
  /** The text was cut short, so `rows` is a lower bound. */
  truncated: boolean;
}

/** Split one delimited line into trimmed cells, honoring double quotes. */
function splitDelimited(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quoted) {
      if (character !== '"') cell += character;
      else if (line.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

/** Header and row count of delimited text; blank lines are not rows. */
export function tableShape(
  text: string,
  delimiter: string,
  truncated = false
): ITableShape {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  const [header = '', ...rows] = lines;
  // A cut-off sample ends inside a record, which is not a complete row.
  const complete = truncated && !/\r?\n$/.test(text) ? rows.slice(0, -1) : rows;
  return {
    headers: header ? splitDelimited(header, delimiter) : [],
    rows: complete.length,
    truncated
  };
}

/**
 * Header and row count of a JSON table: an array of row objects, whose
 * columns are their keys in order of first appearance. Undefined for any
 * other document.
 */
export function tableShapeFromRows(value: unknown): ITableShape | undefined {
  if (!Array.isArray(value) || !value.every(isRecord)) return undefined;
  const headers = new Set<string>();
  for (const row of value) for (const key of Object.keys(row)) headers.add(key);
  return { headers: [...headers], rows: value.length, truncated: false };
}

/** How two table versions differ in shape. */
export interface ITableShapeDiff {
  older: ITableShape;
  newer: ITableShape;
  addedColumns: string[];
  removedColumns: string[];
  /** Same columns in another order. */
  reordered: boolean;
  rowDelta: number;
}

export function tableShapeDiff(
  older: ITableShape,
  newer: ITableShape
): ITableShapeDiff {
  const before = new Set(older.headers);
  const after = new Set(newer.headers);
  const addedColumns = newer.headers.filter(header => !before.has(header));
  const removedColumns = older.headers.filter(header => !after.has(header));
  const reordered =
    !addedColumns.length &&
    !removedColumns.length &&
    older.headers.join('\u0000') !== newer.headers.join('\u0000');
  return {
    older,
    newer,
    addedColumns,
    removedColumns,
    reordered,
    rowDelta: newer.rows - older.rows
  };
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
  /** What ran: the DataLad record's command, which starts the engine's worker. */
  command?: string;
  /**
   * The output's recipe as the run expanded it, which names its script; not
   * recorded by a version committed without a manifest.
   */
  recipe?: string;
  exit?: number;
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
  /** Paths the DataLad record lists as read. */
  inputs: string[];
}

/**
 * Describe one materialization: a committed version from its own DataLad
 * record and manifest, or, when no version is described, the current run
 * record (the sidecar). A version never borrows the sidecar's facts: the
 * sidecar describes the latest run, so a version committed without a valid
 * manifest shows only what its commit recorded. Undefined when neither
 * exists.
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
    command:
      version?.run?.cmd ??
      manifestString(manifest, 'recipe') ??
      sidecar?.recipe,
    exit: version?.run?.exit,
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
    decisions: manifestStringMap(manifest, 'decisions'),
    inputs: version?.run?.inputs ?? []
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
