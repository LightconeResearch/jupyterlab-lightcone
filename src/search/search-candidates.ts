import type { ResolvedRecord } from '@astra-spec/sdk';
import { collectInventoryPapers, recordTitle } from '@astra-spec/ui/model';
import type { CommandRegistry } from '@lumino/commands';
import type { ILoadedProjectData } from '../project-data';
import type { ISessionInfo } from '../sessions/sessions-api';
import type { IProjectFile } from './project-files';

/** An icon as the command registry hands it out (a `LabIcon` in practice). */
export type SearchIcon = ReturnType<CommandRegistry['icon']>;

/** Kinds of search hit: the ASTRA surfaces plus sessions, files and commands. */
export type SearchKind =
  ResolvedRecord['kind'] | 'paper' | 'session' | 'file' | 'command';

/** The kinds drawn with an ASTRA glyph instead of an icon. */
export type SearchSurfaceKind = Exclude<
  SearchKind,
  'session' | 'file' | 'command'
>;

/** What Enter does for a hit; the plugin dispatches on `type`. */
export type SearchAction =
  | { type: 'session'; path: string }
  | { type: 'record'; entrypoint: string; target: string }
  | { type: 'paper'; entrypoint: string; doi: string }
  | { type: 'file'; path: string }
  | { type: 'command'; id: string };

/** One entry offered by the search palette. */
export interface ISearchCandidate {
  /** Unique within its group; it names the private palette command. */
  id: string;
  kind: SearchKind;
  /** Palette section; Lumino matches it together with the label. */
  category: string;
  /** The text the palette matches and highlights. */
  label: string;
  /** Shown after the label: canonical path, folder, or agent and time. */
  caption: string;
  /** Tie-breaker among equal matches, lower first. */
  rank: number;
  action: SearchAction;
  icon?: SearchIcon;
  /** Live enablement for commands that depend on the current widget. */
  isEnabled?: () => boolean;
}

/** Section names in display order; prior insights sit with findings. */
export const SEARCH_CATEGORIES: Readonly<Record<SearchKind, string>> = {
  session: 'Sessions',
  output: 'Results',
  decision: 'Decisions',
  input: 'Inputs',
  finding: 'Findings',
  prior_insight: 'Findings',
  paper: 'Papers',
  file: 'Files',
  command: 'Commands'
};

/** Every Lightcone command ID starts with this. */
export const LIGHTCONE_COMMAND_PREFIX = 'jupyterlab_lightcone:';

/** Newest sessions offered before the list is cut. */
export const SESSION_LIMIT = 50;

const SURFACE_KINDS: ReadonlySet<string> = new Set([
  'input',
  'output',
  'decision',
  'finding',
  'prior_insight',
  'paper'
]);

/** Whether a palette item's kind is an ASTRA surface. */
export function isSurfaceKind(
  kind: string | undefined
): kind is SearchSurfaceKind {
  return kind !== undefined && SURFACE_KINDS.has(kind);
}

/**
 * A short "how long ago" for session captions; dates older than a week are
 * shown as ISO dates so the palette stays sortable by eye.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  return new Date(time).toISOString().slice(0, 10);
}

/** "working · Codex · 2 h ago": activity, last agent and age, omitting unknowns. */
export function sessionCaption(
  session: ISessionInfo,
  now = Date.now()
): string {
  const parts: string[] = [];
  if (session.activity === 'working') {
    parts.push('working');
  }
  if (session.lastAgent) {
    parts.push(session.lastAgent);
  }
  const age = relativeTime(session.modified, now);
  if (age) {
    parts.push(age);
  }
  return parts.join(' · ');
}

/** Sessions newest first, as the server lists them, cut to `limit`. */
export function sessionCandidates(
  sessions: readonly ISessionInfo[],
  options: { now?: number; limit?: number; icon?: SearchIcon } = {}
): ISearchCandidate[] {
  const now = options.now ?? Date.now();
  return sessions
    .slice(0, options.limit ?? SESSION_LIMIT)
    .map((session, index) => ({
      id: `session:${session.path}`,
      kind: 'session',
      category: SEARCH_CATEGORIES.session,
      label: session.title,
      caption: sessionCaption(session, now),
      rank: index,
      action: { type: 'session', path: session.path },
      ...(options.icon ? { icon: options.icon } : {})
    }));
}

/**
 * Every record of the resolved project in document order, then the papers
 * its insights cite. Labels are record titles; captions are canonical paths.
 */
export function recordCandidates(
  data: ILoadedProjectData,
  entrypoint: string
): ISearchCandidate[] {
  const candidates: ISearchCandidate[] = [];
  for (const [path, record] of data.index.recordByPath) {
    candidates.push({
      id: `record:${path}`,
      kind: record.kind,
      category: SEARCH_CATEGORIES[record.kind],
      label: recordTitle(record),
      caption: path,
      rank: candidates.length,
      action: { type: 'record', entrypoint, target: path }
    });
  }
  const papers = collectInventoryPapers(
    data.document,
    data.index,
    data.document.analysis,
    data.papers
  );
  for (const paper of papers) {
    candidates.push({
      id: `paper:${paper.doi}`,
      kind: 'paper',
      category: SEARCH_CATEGORIES.paper,
      label: paper.title,
      caption: paper.authors ? `${paper.authors} · ${paper.doi}` : paper.doi,
      rank: candidates.length,
      action: { type: 'paper', entrypoint, doi: paper.doi }
    });
  }
  return candidates;
}

/** Project files as the bounded walk found them; the caption is the folder. */
export function fileCandidates(
  files: readonly IProjectFile[],
  iconFor?: (path: string) => SearchIcon
): ISearchCandidate[] {
  return files.map((file, index) => {
    const icon = iconFor?.(file.path);
    return {
      id: `file:${file.path}`,
      kind: 'file',
      category: SEARCH_CATEGORIES.file,
      label: file.name,
      caption: file.directory,
      rank: index,
      action: { type: 'file', path: file.path },
      ...(icon ? { icon } : {})
    };
  });
}

export interface ICommandCandidateOptions {
  /** Only commands whose ID starts with this; Lightcone's own by default. */
  prefix?: string;
  /** IDs never listed, such as the search command itself. */
  exclude?: readonly string[];
}

function requiresArguments(description: CommandRegistry.Description): boolean {
  const args = description.args;
  if (!args) {
    return false;
  }
  const required = args.required;
  return Array.isArray(required) && required.length > 0;
}

/**
 * Lightcone's user-facing commands: those with a label that can run without
 * arguments (commands that describe required arguments are internal), sorted
 * by label. Enablement stays live so context-bound commands hide themselves.
 */
export async function commandCandidates(
  commands: CommandRegistry,
  options: ICommandCandidateOptions = {}
): Promise<ISearchCandidate[]> {
  const prefix = options.prefix ?? LIGHTCONE_COMMAND_PREFIX;
  const excluded = new Set(options.exclude ?? []);
  const ids = commands
    .listCommands()
    .filter(id => id.startsWith(prefix) && !excluded.has(id));
  const described = await Promise.all(
    ids.map(async id => {
      try {
        return { id, description: await commands.describedBy(id) };
      } catch (error) {
        console.warn(`Could not describe the command ${id}.`, error);
        return undefined;
      }
    })
  );
  const candidates: ISearchCandidate[] = [];
  for (const entry of described) {
    if (!entry || requiresArguments(entry.description)) {
      continue;
    }
    const { id } = entry;
    const label = commands.label(id);
    if (!label || !commands.isVisible(id)) {
      continue;
    }
    const icon = commands.icon(id);
    candidates.push({
      id: `command:${id}`,
      kind: 'command',
      category: SEARCH_CATEGORIES.command,
      label,
      caption: commands.caption(id),
      rank: 0,
      action: { type: 'command', id },
      ...(icon ? { icon } : {}),
      isEnabled: () => commands.isEnabled(id)
    });
  }
  candidates.sort((a, b) => a.label.localeCompare(b.label));
  return candidates.map((candidate, rank) => ({ ...candidate, rank }));
}
