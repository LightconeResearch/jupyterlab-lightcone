import type { ResolvedRecord } from '@astra-spec/sdk';
import { collectInventoryPapers, recordTitle } from '@astra-spec/ui/model';
import type { CommandRegistry } from '@lumino/commands';
import { sessionActivity, sessionSubtitle } from '../home/home-model';
import type { ILoadedProjectData } from '../project-data';
import type { SessionState } from '../sessions/session-service';
import type { ISessionInfo, ISessionMatch } from '../sessions/sessions-api';
import type { IProjectFile } from './project-files';

/** An icon as the command registry hands it out (a `LabIcon` in practice). */
export type SearchIcon = ReturnType<CommandRegistry['icon']>;

/**
 * Kinds of search hit: the ASTRA surfaces plus sessions (by title), messages
 * (session text), files and commands.
 */
export type SearchKind =
  ResolvedRecord['kind'] | 'paper' | 'session' | 'message' | 'file' | 'command';

/** The kinds drawn with an ASTRA glyph instead of an icon. */
export type SearchSurfaceKind = Exclude<
  SearchKind,
  'session' | 'message' | 'file' | 'command'
>;

/** What Enter does for a hit; `SearchController` dispatches on `type`. */
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
  message: 'In sessions',
  output: 'Results',
  decision: 'Decisions',
  input: 'Inputs',
  finding: 'Findings',
  prior_insight: 'Findings',
  paper: 'Papers',
  file: 'Files',
  command: 'Commands'
};

/**
 * Where each kind's section sits, in display order: sessions (titles,
 * then their text), the ASTRA records, files, then commands.
 */
export const SEARCH_SECTION_ORDER: Readonly<Record<SearchKind, number>> = {
  session: 1,
  message: 2,
  output: 3,
  decision: 4,
  input: 5,
  finding: 6,
  prior_insight: 6,
  paper: 7,
  file: 8,
  command: 9
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

export interface ISessionCandidateOptions {
  now?: number;
  /** Newest sessions kept (`SESSION_LIMIT` by default). */
  limit?: number;
  icon?: SearchIcon;
  /** The workbench's live activity of a session, which wins over the server's. */
  activity?: (path: string) => SessionState | undefined;
}

/**
 * Sessions newest first, as the server lists them, cut to `limit`. The caption
 * is the subtitle Home shows for the same session: agent, activity, age.
 */
export function sessionCandidates(
  sessions: readonly ISessionInfo[],
  options: ISessionCandidateOptions = {}
): ISearchCandidate[] {
  const now = new Date(options.now ?? Date.now());
  return sessions
    .slice(0, options.limit ?? SESSION_LIMIT)
    .map((session, index) => ({
      id: `session:${session.path}`,
      kind: 'session',
      category: SEARCH_CATEGORIES.session,
      label: session.title,
      caption: sessionSubtitle(
        session,
        sessionActivity(session, options.activity?.(session.path)),
        now
      ),
      rank: index,
      action: { type: 'session', path: session.path },
      ...(options.icon ? { icon: options.icon } : {})
    }));
}

/**
 * Messages of the project's sessions containing the query, newest first. The
 * label is the text around the match, which the palette matches again; the
 * caption names the session and who wrote the message.
 */
export function messageCandidates(
  matches: readonly ISessionMatch[],
  icon?: SearchIcon
): ISearchCandidate[] {
  return matches.map((match, index) => ({
    id: `message:${match.path}:${match.message ?? index}`,
    kind: 'message',
    category: SEARCH_CATEGORIES.message,
    label: match.snippet,
    caption: match.author ? `${match.title} · ${match.author}` : match.title,
    rank: index,
    action: { type: 'session', path: match.path },
    ...(icon ? { icon } : {})
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
 * Lightcone's user-facing commands (IDs under `LIGHTCONE_COMMAND_PREFIX`):
 * those with a label that can run without arguments (commands that describe
 * required arguments are internal), sorted by label. Enablement stays live, and
 * the palette hides a command while it is disabled, so commands bound to
 * another kind of tab only show up where they apply.
 */
export async function commandCandidates(
  commands: CommandRegistry,
  options: ICommandCandidateOptions = {}
): Promise<ISearchCandidate[]> {
  const excluded = new Set(options.exclude ?? []);
  const ids = commands
    .listCommands()
    .filter(id => id.startsWith(LIGHTCONE_COMMAND_PREFIX) && !excluded.has(id));
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
