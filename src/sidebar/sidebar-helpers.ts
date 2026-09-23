import type {
  AnalysisIndex,
  ResolvedAnalysisNode,
  ResolvedOutput
} from '@astra-spec/sdk';
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

/** Every output of the project in document order: the root analysis first. */
export function listOutputs(index: AnalysisIndex): ResolvedOutput[] {
  return [...index.recordByPath.values()].filter(
    (record): record is ResolvedOutput => record.kind === 'output'
  );
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

/** "Decisions 5 · Inputs 7 · Findings 2 · Papers 3", omitting empty kinds. */
export function analysisCountsLabel(row: IAnalysisRow): string {
  const parts: string[] = [];
  if (row.decisions) {
    parts.push(`Decisions ${row.decisions}`);
  }
  if (row.inputs) {
    parts.push(`Inputs ${row.inputs}`);
  }
  if (row.findings) {
    parts.push(`Findings ${row.findings}`);
  }
  if (row.papers) {
    parts.push(`Papers ${row.papers}`);
  }
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
}

const INVENTORY_CLASS = 'jp-jupyterlab-lightcone-Document';

function documentPath(widget: Widget): string | undefined {
  const candidate: unknown = widget;
  return isRecord(candidate) &&
    isRecord(candidate.context) &&
    typeof candidate.context.path === 'string'
    ? candidate.context.path
    : undefined;
}

/**
 * Describe the current widget structurally, so the sidebar can highlight a
 * session, a record tab or the inventory without importing their classes.
 */
export function describeWidget(widget: Widget | null): ICurrentView {
  if (!widget) {
    return {};
  }
  const path = documentPath(widget);
  if (path !== undefined) {
    if (path.endsWith('.chat')) {
      return { session: path };
    }
    if (widget.hasClass(INVENTORY_CLASS)) {
      return { inventory: path };
    }
  }
  if (widget.title.dataset['lightcone-element'] !== undefined) {
    const candidate: unknown = widget;
    if (
      isRecord(candidate) &&
      isRecord(candidate.content) &&
      isRecord(candidate.content.reference) &&
      typeof candidate.content.reference.entrypoint === 'string' &&
      typeof candidate.content.reference.target === 'string'
    ) {
      const { entrypoint, target, doi } = candidate.content.reference;
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

function isSignal(value: unknown): value is ISignal<unknown, unknown> {
  return (
    isRecord(value) &&
    typeof value.connect === 'function' &&
    typeof value.disconnect === 'function'
  );
}

/**
 * The signal a record tab emits after showing another record in place, which
 * keeps the widget current. Undefined for every other widget.
 */
export function recordNavigation(
  widget: Widget | null
): ISignal<unknown, unknown> | undefined {
  if (!widget || widget.title.dataset['lightcone-element'] === undefined) {
    return undefined;
  }
  const candidate: unknown = widget;
  if (!isRecord(candidate) || !isRecord(candidate.content)) {
    return undefined;
  }
  const signal = candidate.content.historyChanged;
  return isSignal(signal) ? signal : undefined;
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
