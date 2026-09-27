import type { ResolvedRecord } from '@astra-spec/sdk';
import { recordTitle } from '@astra-spec/ui/model';
import type { ISessionInfo } from '../sessions/sessions-api';

/** Mentions offered per keystroke, so the menu stays readable. */
export const MENTION_LIMIT = 12;

/** The characters that start a record (`@`) or a session (`#`) mention. */
export type MentionTrigger = '@' | '#';

/** One entry of the composer's mention menu. */
export interface IMentionCandidate {
  /** What the menu lists; the trigger followed by the reference. */
  name: string;
  /** Kind and title, after the name. */
  description: string;
  /** The visible reference that replaces the typed word. */
  replaceWith: string;
  /** A record's kind, which the menu marks as the inventory does. */
  kind?: ResolvedRecord['kind'];
}

/** A record kind as the menu names it. */
const KIND_LABELS: Readonly<Record<ResolvedRecord['kind'], string>> = {
  output: 'Result',
  decision: 'Decision',
  input: 'Input',
  finding: 'Finding',
  prior_insight: 'Prior insight'
};

/** The trigger and the typed text after it, or null for any other word. */
export function parseMention(
  word: string | null | undefined
): { trigger: MentionTrigger; query: string } | null {
  if (!word) return null;
  const trigger = word[0];
  if (trigger !== '@' && trigger !== '#') return null;
  const query = word.slice(1);
  // A bare `#` starts a Markdown heading far more often than a mention.
  if (trigger === '#' && !query) return null;
  return { trigger, query: query.toLowerCase() };
}

/**
 * How well a candidate's words match the query: 0 for a prefix of its
 * identifier, 1 for a prefix of its path, 2 for a match inside its title or
 * path, and null for none. An empty query matches everything equally.
 */
export function matchRank(
  query: string,
  identifier: string,
  path: string,
  title: string
): number | null {
  if (!query) return 0;
  const id = identifier.toLowerCase();
  const location = path.toLowerCase();
  if (id.startsWith(query)) return 0;
  if (location.startsWith(query)) return 1;
  if (location.includes(query) || title.toLowerCase().includes(query)) return 2;
  return null;
}

/** An output's version as its reference names it: "version a889877". */
export function versionSuffix(commit: string | undefined): string {
  return commit ? ` (version ${commit.slice(0, 7)})` : '';
}

/**
 * Records matching a `@` query, best matches first. The reference that
 * replaces the word is the record's canonical path in code format, which the
 * agent can resolve in `astra.yaml`; an output also names the version shown
 * now when `versionOf` knows it.
 */
export function recordMentions(
  records: Iterable<ResolvedRecord>,
  query: string,
  versionOf: (record: ResolvedRecord) => string | undefined = () => undefined,
  limit = MENTION_LIMIT
): IMentionCandidate[] {
  const ranked: { rank: number; record: ResolvedRecord }[] = [];
  for (const record of records) {
    const rank = matchRank(
      query,
      record.id,
      record.canonicalPath,
      recordTitle(record)
    );
    if (rank !== null) ranked.push({ rank, record });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.record.canonicalPath.localeCompare(b.record.canonicalPath)
  );
  return ranked.slice(0, limit).map(({ record }) => ({
    name: `@${record.canonicalPath}`,
    description: `${KIND_LABELS[record.kind]} · ${recordTitle(record)}`,
    replaceWith: `\`${record.canonicalPath}\`${
      record.kind === 'output' ? versionSuffix(versionOf(record)) : ''
    }`,
    kind: record.kind
  }));
}

/** A session's chat path relative to its project folder. */
export function projectRelative(
  path: string,
  projectDirectory: string
): string {
  const prefix = projectDirectory ? `${projectDirectory}/` : '';
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Sessions matching a `#` query, newest first, each referred to by its chat
 * file relative to the project, which the agent can read.
 */
export function sessionMentions(
  sessions: readonly ISessionInfo[],
  query: string,
  projectDirectory: string,
  limit = MENTION_LIMIT
): IMentionCandidate[] {
  return sessions
    .filter(session => {
      const relative = projectRelative(session.path, projectDirectory);
      const stem = relative.replace(/^.*\//, '').replace(/\.chat$/, '');
      return matchRank(query, stem, relative, session.title) !== null;
    })
    .slice(0, limit)
    .map(session => {
      const relative = projectRelative(session.path, projectDirectory);
      const stem = relative.replace(/^.*\//, '').replace(/\.chat$/, '');
      return {
        name: `#${stem}`,
        description: `Session · ${session.title}`,
        replaceWith: `\`${relative}\``
      };
    });
}
