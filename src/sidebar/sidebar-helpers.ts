import type { ResolvedAnalysisNode, ResolvedOutput } from '@astra-spec/sdk';
import {
  analysisTitle,
  collectInventoryPapers,
  type OutputStatus
} from '@astra-spec/ui/model';
import { PathExt } from '@jupyterlab/coreutils';
import { CommandRegistry } from '@lumino/commands';
import type { ISignal } from '@lumino/signaling';
import type { Widget } from '@lumino/widgets';
import { isRecord } from '../api';
import type { ILoadedProjectData } from '../project-data';
import type { IProjectRoot } from '../project-root';
import type { SessionState } from '../sessions/session-service';
import type { SessionActivity } from '../sessions/sessions-api';
import {
  SESSION_FILE_EXTENSION,
  sessionStem,
  slugForTitle
} from '../sessions/session-titles';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * A short age for a list row: "now", "5 min", "3 h", "2 days", "1 wk", "4 mo",
 * "1 yr". An unparsable time gives an empty string.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const elapsed = Math.max(0, now - time);
  if (elapsed < 45_000) {
    return 'now';
  }
  if (elapsed < HOUR) {
    return `${Math.max(1, Math.floor(elapsed / MINUTE))} min`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)} h`;
  }
  if (elapsed < WEEK) {
    const days = Math.floor(elapsed / DAY);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (elapsed < MONTH) {
    return `${Math.floor(elapsed / WEEK)} wk`;
  }
  if (elapsed < YEAR) {
    return `${Math.floor(elapsed / MONTH)} mo`;
  }
  return `${Math.floor(elapsed / YEAR)} yr`;
}

/** The marker a session row shows; the live state wins over the server's. */
export function sessionMarker(
  live: SessionState | undefined,
  reported: SessionActivity
): SessionState {
  return live ?? reported;
}

/**
 * The project's results: the root analysis's outputs that the selected
 * universe makes, in document order. This is the set Home shows and the only
 * one `lc status` reports on; nested analyses' outputs stay in their
 * inventory scope, which the Analysis section opens.
 */
export function listOutputs(data: ILoadedProjectData): ResolvedOutput[] {
  return data.document.analysis.outputs.filter(output => output.active);
}

/** How the Results header names an output type. */
export function outputKindLabel(type: ResolvedOutput['type']): string {
  switch (type) {
    case 'figure':
      return 'Figure';
    case 'table':
      return 'Table';
    case 'metric':
      return 'Metric';
    case 'report':
      return 'Report';
    default:
      return 'Data';
  }
}

/** Counts of the Results section by materialization state. */
export interface IResultsSummary {
  total: number;
  current: number;
  behind: number;
  stale: number;
  unknown: number;
}

/** Tally outputs by their `lc status` state; unknown when there is no report. */
export function summarizeResults(
  outputs: readonly ResolvedOutput[],
  statusFor: (output: ResolvedOutput) => OutputStatus | undefined
): IResultsSummary {
  const summary: IResultsSummary = {
    total: outputs.length,
    current: 0,
    behind: 0,
    stale: 0,
    unknown: 0
  };
  for (const output of outputs) {
    const status = statusFor(output);
    if (!status) {
      summary.unknown += 1;
    } else {
      summary[status.state] += 1;
    }
  }
  return summary;
}

/** The Results header label: "4 ✓", "3 ✓ · 1 behind", or a plain count. */
export function resultsSummaryLabel(summary: IResultsSummary): string {
  if (!summary.total) {
    return '0';
  }
  if (summary.current === summary.total) {
    return `${summary.total} ✓`;
  }
  const parts: string[] = [];
  if (summary.current) {
    parts.push(`${summary.current} ✓`);
  }
  if (summary.behind) {
    parts.push(`${summary.behind} behind`);
  }
  if (summary.stale) {
    parts.push(`${summary.stale} stale`);
  }
  return parts.length ? parts.join(' · ') : `${summary.total}`;
}

/** One analysis of the project, with the counts the Analysis section shows. */
export interface IAnalysisRow {
  canonicalPath: string;
  title: string;
  /** Nesting depth; the root analysis is 0. */
  depth: number;
  outputs: number;
  decisions: number;
  inputs: number;
  findings: number;
  papers: number;
}

/** The analysis tree flattened depth first, root first. */
export function analysisRows(data: ILoadedProjectData): IAnalysisRow[] {
  const rows: IAnalysisRow[] = [];
  const visit = (node: ResolvedAnalysisNode, depth: number): void => {
    rows.push({
      canonicalPath: node.canonicalPath,
      title: analysisTitle(node),
      depth,
      outputs: node.outputs.length,
      decisions: node.decisions.length,
      inputs: node.inputs.length,
      findings: node.findings.length,
      papers: collectInventoryPapers(
        data.document,
        data.index,
        node,
        data.papers
      ).length
    });
    for (const child of node.analyses) {
      visit(child, depth + 1);
    }
  };
  visit(data.document.analysis, 0);
  return rows;
}

/** One kind's count on an analysis row, in the inventory's section order. */
export interface IAnalysisCount {
  kind: 'output' | 'decision' | 'input' | 'finding' | 'paper';
  count: number;
  /** The inventory's section name: "Outputs", "Decisions", … */
  label: string;
}

/** The row's non-empty counts, in the inventory's section order. */
export function analysisCounts(row: IAnalysisRow): IAnalysisCount[] {
  const counts: IAnalysisCount[] = [
    { kind: 'output', count: row.outputs, label: 'Outputs' },
    { kind: 'decision', count: row.decisions, label: 'Decisions' },
    { kind: 'input', count: row.inputs, label: 'Inputs' },
    { kind: 'finding', count: row.findings, label: 'Findings' },
    { kind: 'paper', count: row.papers, label: 'Papers' }
  ];
  return counts.filter(entry => entry.count > 0);
}

/**
 * "Outputs 2 · Decisions 5 · Inputs 7 · Findings 2 · Papers 3", in the
 * inventory's section order, omitting empty kinds.
 */
export function analysisCountsLabel(row: IAnalysisRow): string {
  const parts = analysisCounts(row).map(
    entry => `${entry.label} ${entry.count}`
  );
  return parts.length ? parts.join(' · ') : 'No records yet';
}

/** The project's name from its spec, else its folder name. */
export function projectLabel(
  project: IProjectRoot,
  data: ILoadedProjectData | undefined
): string {
  const name = data?.document.analysis.name.trim();
  if (name) {
    return name;
  }
  const folder = PathExt.basename(project.path);
  return folder || '/';
}

/** Which Lightcone view a main-area widget shows, when it shows one. */
export interface ICurrentView {
  /** Contents path of the chat document that is current. */
  session?: string;
  /** The record tab that is current. */
  record?: { entrypoint: string; target: string; doi?: string };
  /** The inventory document that is current, as its entrypoint. */
  inventory?: string;
  /** The analysis that inventory shows, once it has loaded. */
  analysisPath?: string;
}

const INVENTORY_CLASS = 'jp-jupyterlab-lightcone-Document';
/** The title dataset key every record tab carries (see `ElementWidget`). */
const RECORD_TAB_KEY = 'lightcone-element';

function isSignal(value: unknown): value is ISignal<unknown, unknown> {
  return (
    isRecord(value) &&
    typeof value.connect === 'function' &&
    typeof value.disconnect === 'function'
  );
}

function documentPath(widget: Widget): string | undefined {
  const candidate: unknown = widget;
  return isRecord(candidate) &&
    isRecord(candidate.context) &&
    typeof candidate.context.path === 'string'
    ? candidate.context.path
    : undefined;
}

/** The inside of a main-area widget (`MainAreaWidget.content`), if any. */
function widgetContent(widget: Widget): Record<string, unknown> | undefined {
  const candidate: unknown = widget;
  return isRecord(candidate) && isRecord(candidate.content)
    ? candidate.content
    : undefined;
}

/**
 * Describe the current widget structurally, so the sidebar can highlight a
 * session, a record tab or the inventory and its scope without importing
 * their classes: chats by their document path, record tabs by the title
 * dataset key `ElementWidget` sets, inventories by their class.
 */
export function describeWidget(widget: Widget | null): ICurrentView {
  if (!widget) {
    return {};
  }
  const path = documentPath(widget);
  if (path !== undefined) {
    if (path.endsWith(SESSION_FILE_EXTENSION)) {
      return { session: path };
    }
    if (widget.hasClass(INVENTORY_CLASS)) {
      const scope = widgetContent(widget)?.analysisPath;
      return {
        inventory: path,
        ...(typeof scope === 'string' ? { analysisPath: scope } : {})
      };
    }
  }
  if (widget.title.dataset[RECORD_TAB_KEY] !== undefined) {
    const reference = widgetContent(widget)?.reference;
    if (
      isRecord(reference) &&
      typeof reference.entrypoint === 'string' &&
      typeof reference.target === 'string'
    ) {
      const { entrypoint, target, doi } = reference;
      return {
        record: {
          entrypoint,
          target,
          ...(typeof doi === 'string' ? { doi } : {})
        }
      };
    }
  }
  return {};
}

/**
 * The signals after which a widget shows another view while it stays the
 * current widget: a document renamed under it (its context's
 * `pathChanged`), a record tab following a link (`historyChanged`) and an
 * inventory moving to another analysis (`scopeChanged`).
 */
export function viewChanges(
  widget: Widget | null
): ISignal<unknown, unknown>[] {
  if (!widget) {
    return [];
  }
  const candidate: unknown = widget;
  const signals: unknown[] = [];
  if (isRecord(candidate) && isRecord(candidate.context)) {
    signals.push(candidate.context.pathChanged);
  }
  const content = widgetContent(widget);
  if (content && widget.title.dataset[RECORD_TAB_KEY] !== undefined) {
    signals.push(content.historyChanged);
  }
  if (content && widget.hasClass(INVENTORY_CLASS)) {
    signals.push(content.scopeChanged);
  }
  return signals.filter(isSignal);
}

/**
 * Where a session's chat file moves when it is renamed to `name`: the same
 * folder (and drive), with the name made a slug the way new sessions are
 * named. Undefined when the name is blank or leaves the path unchanged, which
 * includes accepting the current name of a file that is not a slug.
 */
export function renamedSessionPath(
  path: string,
  name: string
): string | undefined {
  let stem = name.trim();
  if (stem.toLowerCase().endsWith(SESSION_FILE_EXTENSION)) {
    stem = stem.slice(0, -SESSION_FILE_EXTENSION.length).trim();
  }
  const current = sessionStem(path);
  if (!stem || stem === current) {
    return undefined;
  }
  const slug = slugForTitle(stem);
  if (slug === current) {
    return undefined;
  }
  const slash = path.lastIndexOf('/');
  // A chat at a drive root keeps its `drive:` prefix.
  const folder =
    slash < 0 ? path.slice(0, path.indexOf(':') + 1) : path.slice(0, slash + 1);
  return `${folder}${slug}${SESSION_FILE_EXTENSION}`;
}

/** The first key binding of a command, formatted for a hint such as "Ctrl K". */
export function shortcutLabel(
  commands: CommandRegistry,
  command: string
): string | undefined {
  const binding = commands.keyBindings.find(item => item.command === command);
  if (!binding) {
    return undefined;
  }
  return binding.keys
    .map(keystroke => CommandRegistry.formatKeystroke(keystroke))
    .join(', ');
}
