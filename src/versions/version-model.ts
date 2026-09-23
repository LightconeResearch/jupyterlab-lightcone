import type { ResolvedOutput } from '@astra-spec/sdk';
import type { OutputRun } from '@astra-spec/ui/model';
import type { ISessionInfo } from '../sessions/sessions-api';
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

function numericLeaves(
  value: unknown,
  prefix: string,
  depth: number,
  into: Map<string, number>
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    into.set(prefix || 'value', value);
    return;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) into.set(prefix || 'value', parsed);
    return;
  }
  if (depth >= 3 || value === null || typeof value !== 'object') return;
  const entries = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value);
  for (const [key, item] of entries)
    numericLeaves(item, prefix ? `${prefix}.${key}` : key, depth + 1, into);
}

/**
 * Numeric differences between two JSON metric documents, leaf by leaf, in
 * the order the newer document lists them followed by leaves only the older
 * one has. Nested objects and arrays are flattened to dotted keys, three
 * levels deep.
 */
export function metricDeltas(older: unknown, newer: unknown): IMetricDelta[] {
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  numericLeaves(older, '', 0, before);
  numericLeaves(newer, '', 0, after);
  const keys = [...after.keys(), ...before.keys()].filter(
    (key, index, all) => all.indexOf(key) === index
  );
  return keys.map(key => {
    const a = before.get(key);
    const b = after.get(key);
    return {
      key,
      older: a,
      newer: b,
      delta: a !== undefined && b !== undefined ? b - a : undefined
    };
  });
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

/** Sessions modified up to this long before a run count as possibly active. */
export const SESSION_WINDOW_BEFORE_MS = 5 * 60 * 1000;
/** Sessions modified up to this long after a run count as possibly active. */
export const SESSION_WINDOW_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Sessions that may have been active during a run, judged only by their last
 * modification time: a session last written between five minutes before the
 * run and twelve hours after it. Closest first. This is a heuristic: the
 * server records no link between a run and the conversation that caused it.
 */
export function sessionsActiveAround(
  sessions: readonly ISessionInfo[],
  time: string
): ISessionInfo[] {
  const run = Date.parse(time);
  if (Number.isNaN(run)) return [];
  return sessions
    .map(session => ({ session, at: Date.parse(session.modified) }))
    .filter(
      ({ at }) =>
        !Number.isNaN(at) &&
        at >= run - SESSION_WINDOW_BEFORE_MS &&
        at <= run + SESSION_WINDOW_AFTER_MS
    )
    .sort((a, b) => Math.abs(a.at - run) - Math.abs(b.at - run))
    .map(({ session }) => session);
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
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
  subject?: string;
  time?: string;
  started?: string;
  command?: string;
  exit?: number;
  gitRevision?: string;
  gitRemote?: string;
  engineVersion?: string;
  environmentVersion?: string;
  uvVersion?: string;
  image?: string;
  sandbox?: string;
  definitionVersion?: string;
  dataVersion?: string;
  inputVersions: Record<string, string>;
  decisions: Record<string, string>;
  /** Paths the DataLad record lists. */
  inputs: string[];
  outputs: string[];
}

/**
 * Combine a committed version (its DataLad record and manifest) with the
 * current run record into one view. A version wins where both know a fact;
 * the record fills in when no version is available. Undefined when neither
 * recorded anything.
 */
export function runView(
  run: OutputRun | null | undefined,
  version: IOutputVersion | undefined
): IRunView | undefined {
  if (!version && !run) return undefined;
  const manifest = version?.manifest;
  const image = manifest?.image;
  const imageTag =
    image && typeof image === 'object' && !Array.isArray(image)
      ? manifestString(image as Record<string, unknown>, 'tag')
      : undefined;
  return {
    source: version ? 'version' : 'record',
    commit: version?.commit,
    short: version?.short,
    subject: version?.subject,
    time:
      manifestString(manifest, 'finished_at') ??
      version?.time ??
      run?.finishedAt,
    started: manifestString(manifest, 'started_at'),
    command:
      version?.run?.cmd ?? manifestString(manifest, 'recipe') ?? run?.recipe,
    exit: version?.run?.exit,
    gitRevision: manifestString(manifest, 'git_sha') ?? run?.gitRevision,
    gitRemote: manifestString(manifest, 'git_remote'),
    engineVersion: manifestString(manifest, 'lc_version') ?? run?.cliVersion,
    environmentVersion:
      manifestString(manifest, 'env_version') ?? run?.environment,
    uvVersion: manifestString(manifest, 'uv_version'),
    image: imageTag,
    sandbox: sandboxLine(manifest),
    definitionVersion: manifestString(manifest, 'definition_version'),
    dataVersion: manifestString(manifest, 'data_version'),
    inputVersions: manifest
      ? manifestStringMap(manifest, 'input_versions')
      : { ...(run?.inputVersions ?? {}) },
    decisions: manifestStringMap(manifest, 'decisions'),
    inputs: version?.run?.inputs ?? [],
    outputs: version?.run?.outputs ?? []
  };
}

/** "landlock: enforced · network: none" from a manifest's hermeticity block. */
export function sandboxLine(
  manifest: Record<string, unknown> | null | undefined
): string | undefined {
  const value = manifest?.hermeticity;
  if (typeof value === 'string') return value || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const parts = Object.entries(value)
    .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
    .map(([key, item]) => `${key}: ${String(item)}`);
  return parts.length ? parts.join(' · ') : undefined;
}
