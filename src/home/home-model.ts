import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import type { OutputStatus } from '@astra-spec/ui/model';
import type { ILauncher } from '@jupyterlab/launcher';
import type { CommandRegistry } from '@lumino/commands';
import type { IProjectRoot } from '../project-root';
import type { SessionState } from '../sessions/session-service';
import type { ISessionInfo } from '../sessions/sessions-api';

/** What a launcher tab shows: the project's Home, or the stock launcher body. */
export type HomeMode = 'home' | 'stock';

/**
 * Home replaces the stock launcher only inside a project. A tab whose user
 * asked for the full launcher keeps the stock body until they come back.
 */
export function homeMode(
  project: IProjectRoot | null | undefined,
  stockRequested: boolean
): HomeMode {
  return project && !stockRequested ? 'home' : 'stock';
}

/**
 * Coarse relative time, as session lists and freshness lines show it. Units
 * are counted in whole elapsed periods, as the sidebar counts them, so the
 * same session reads "14 h" there and "14 h ago" here.
 */
export function formatRelativeTime(
  time: string | Date,
  now: Date = new Date()
): string {
  const ms = (typeof time === 'string' ? new Date(time) : time).getTime();
  if (Number.isNaN(ms)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - ms) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/** The launcher category of Lightcone's own cards. */
export const LAUNCHER_CATEGORY = 'Lightcone Lab';

/**
 * The category Lightcone's launcher cards use: the plain name outside a
 * project, qualified by the project's path inside one.
 */
export function launcherCategory(projectPath: string | null): string {
  return projectPath === null
    ? LAUNCHER_CATEGORY
    : `${LAUNCHER_CATEGORY} · ${projectPath || '/'}`;
}

/**
 * Whether a launcher category is one `launcherCategory` produces. Home offers
 * those cards in its own body, so the Tools menu leaves them out; other
 * extensions' categories that merely start with the same words stay.
 */
export function isLightconeCategory(category: string | undefined): boolean {
  return (
    category === LAUNCHER_CATEGORY ||
    (category?.startsWith(`${LAUNCHER_CATEGORY} · `) ?? false)
  );
}

/** Launcher items of one category, in display order. */
export interface ILauncherGroup {
  category: string;
  items: ILauncher.IItemOptions[];
}

/** Category names the stock launcher ranks first; translated by the caller. */
export interface ILauncherCategoryLabels {
  notebook: string;
  console: string;
  other: string;
}

export interface IGroupLauncherItemsOptions {
  labels?: ILauncherCategoryLabels;
  /** Leave out items Home already offers in its own way. */
  exclude?: (item: ILauncher.IItemOptions) => boolean;
}

/**
 * Group launcher items by category and order them as the stock launcher does:
 * categories by their smallest `categoryRank` (Notebook, Console and Other
 * have defaults), then items by rank and label.
 */
export function groupLauncherItems(
  items: Iterable<ILauncher.IItemOptions>,
  commands: CommandRegistry,
  cwd: string,
  options: IGroupLauncherItemsOptions = {}
): ILauncherGroup[] {
  const labels = options.labels ?? {
    notebook: 'Notebook',
    console: 'Console',
    other: 'Other'
  };
  const label = (item: ILauncher.IItemOptions) =>
    commands.label(item.command, { ...item.args, cwd });
  const groups = new Map<string, ILauncher.IItemOptions[]>();
  for (const item of items) {
    if (options.exclude?.(item)) {
      continue;
    }
    const category = item.category || labels.other;
    const group = groups.get(category) ?? [];
    group.push(item);
    groups.set(category, group);
  }
  const defaultRanks: Record<string, number> = {
    [labels.notebook]: 0,
    [labels.console]: 20,
    [labels.other]: 100
  };
  const rankOf = (category: string): number => {
    const fallback = defaultRanks[category] ?? Infinity;
    return Math.min(
      ...(groups.get(category) ?? []).map(item => item.categoryRank ?? fallback)
    );
  };
  return [...groups.keys()]
    .sort((a, b) => {
      const difference = rankOf(a) - rankOf(b);
      return difference !== 0 && !Number.isNaN(difference)
        ? difference
        : a.localeCompare(b);
    })
    .map(category => ({
      category,
      items: [...groups.get(category)!].sort((a, b) => {
        const rankA = a.rank ?? Infinity;
        const rankB = b.rank ?? Infinity;
        if (rankA !== rankB) {
          return rankA < rankB ? -1 : 1;
        }
        return label(a).localeCompare(label(b));
      })
    }));
}

/** One output's identity and execution status, as the freshness line needs them. */
export interface IFreshnessInput {
  id: string;
  status: OutputStatus | undefined;
}

/** The results kicker's freshness line and the marker beside it. */
export interface IFreshness {
  state: 'empty' | 'unknown' | 'current' | 'attention';
  text: string;
}

/**
 * Summarize materialization status: "All 4 current", naming the outputs that
 * are behind or stale otherwise, plus the time of the newest recorded run.
 */
export function summarizeFreshness(
  outputs: readonly IFreshnessInput[],
  lastMaterialized?: string,
  now: Date = new Date()
): IFreshness {
  const total = outputs.length;
  if (!total) {
    return { state: 'empty', text: 'No results yet' };
  }
  const suffix = lastMaterialized
    ? ` · last materialized ${formatRelativeTime(lastMaterialized, now)}`
    : '';
  const known = outputs.filter(output => output.status);
  if (!known.length) {
    return {
      state: 'unknown',
      text: `${total} ${total === 1 ? 'result' : 'results'}${suffix}`
    };
  }
  const stale = known
    .filter(output => output.status?.state === 'stale')
    .map(output => output.id);
  const behind = known
    .filter(output => output.status?.state === 'behind')
    .map(output => output.id);
  if (!stale.length && !behind.length) {
    return { state: 'current', text: `All ${total} current${suffix}` };
  }
  const current = total - stale.length - behind.length;
  const parts = [`${current} of ${total} current`];
  if (stale.length) {
    parts.push(`stale: ${stale.join(', ')}`);
  }
  if (behind.length) {
    parts.push(`behind: ${behind.join(', ')}`);
  }
  return { state: 'attention', text: `${parts.join(' · ')}${suffix}` };
}

/** The kind label shown under a results plate. */
export function outputKindLabel(type: string | undefined): string {
  switch (type) {
    case 'figure':
      return 'Figure';
    case 'table':
      return 'Table';
    case 'metric':
      return 'Metric';
    case 'data':
      return 'Data';
    case 'report':
      return 'Report';
    default:
      return type ? type[0].toUpperCase() + type.slice(1) : 'Output';
  }
}

/** How Home orders its plates: figures lead, then values, then data summaries. */
const PLATE_KIND_ORDER: Record<string, number> = {
  figure: 0,
  metric: 1,
  table: 2,
  data: 3,
  report: 4
};

/**
 * Order outputs for Home's results plates: figures first, then metrics,
 * tables and data, keeping the declaration order within each kind.
 */
export function orderPlates<T extends { type?: string }>(
  outputs: readonly T[]
): T[] {
  const rank = (output: T) =>
    PLATE_KIND_ORDER[output.type ?? ''] ?? Object.keys(PLATE_KIND_ORDER).length;
  return outputs
    .map((output, index) => ({ output, index }))
    .sort((a, b) => rank(a.output) - rank(b.output) || a.index - b.index)
    .map(({ output }) => output);
}

/**
 * The field column of a plate's value list, in characters: a plate holds
 * about 22, and the values matter more than the names.
 */
const PLATE_FIELD_WIDTH = 10;

/** A field name cut to the plate's field column. */
function plateField(name: string, width: number): string {
  return name.length > width
    ? `${name.slice(0, width - 1)}…`
    : name.padEnd(width);
}

/** A table cell as a short plate value: four significant digits for decimals. */
function plateValue(cell: string | number | boolean | null): string {
  if (cell === null) {
    return '—';
  }
  if (typeof cell === 'number' && !Number.isInteger(cell)) {
    return String(Number(cell.toPrecision(4)));
  }
  return String(cell);
}

/**
 * Adapt an artifact preview to a plate. A one-row table, such as a fit's
 * parameters, is unreadable as a strip of truncated columns at plate size:
 * it becomes a list of field and value lines instead. Anything else is kept.
 */
export function platePreview(
  preview: ArtifactPreviewData
): ArtifactPreviewData {
  if (
    preview.kind !== 'table' ||
    preview.rows.length !== 1 ||
    preview.headers.length < 3
  ) {
    return preview;
  }
  const [row] = preview.rows;
  const width = Math.min(
    PLATE_FIELD_WIDTH,
    Math.max(...preview.headers.map(header => header.length))
  );
  const lines = preview.headers.map(
    (header, index) =>
      `${plateField(header, width)} ${plateValue(row[index] ?? null)}`
  );
  return { kind: 'text', text: lines.join('\n'), truncated: preview.truncated };
}

/** The record lists an analysis node exposes, without depending on the SDK's exact shape. */
export interface IAnalysisRecords {
  inputs: readonly unknown[];
  decisions: readonly unknown[];
  findings: readonly unknown[];
  analyses: readonly IAnalysisRecords[];
}

export interface IRecordCounts {
  decisions: number;
  inputs: number;
  findings: number;
}

/** Count records across an analysis and every nested analysis. */
export function countRecords(root: IAnalysisRecords): IRecordCounts {
  const counts: IRecordCounts = { decisions: 0, inputs: 0, findings: 0 };
  const visit = (node: IAnalysisRecords) => {
    counts.decisions += node.decisions.length;
    counts.inputs += node.inputs.length;
    counts.findings += node.findings.length;
    node.analyses.forEach(visit);
  };
  visit(root);
  return counts;
}

/** The activity a session row shows: the workbench's live view first, the server's otherwise. */
export function sessionActivity(
  info: ISessionInfo,
  live: SessionState | undefined
): SessionState {
  return live ?? info.activity;
}

/** "Codex · working · 2 min ago": agent, activity when not idle, then age. */
export function sessionSubtitle(
  info: ISessionInfo,
  activity: SessionState,
  now: Date = new Date()
): string {
  const parts: string[] = [];
  if (info.lastAgent) {
    parts.push(info.lastAgent);
  }
  if (activity === 'working') {
    parts.push('working');
  } else if (activity === 'attention') {
    parts.push('needs your input');
  }
  const age = formatRelativeTime(info.modified, now);
  if (age) {
    parts.push(age);
  }
  return parts.join(' · ');
}

/** Sessions shown on Home before the "All" link takes over. */
export const HOME_SESSION_LIMIT = 6;

/** Results plates shown on Home before the "All results" link takes over. */
export const HOME_RESULT_LIMIT = 8;
