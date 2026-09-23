import type { Contents } from '@jupyterlab/services';
import { findModel } from '../project-root';
import type { ISessionInfo } from './sessions-api';

/** File extension of a Jupyter Chat document. */
export const SESSION_FILE_EXTENSION = '.chat';

/** Name used for a session whose title yields no usable slug. */
export const UNTITLED_SLUG = 'untitled';

const MAX_SLUG_LENGTH = 48;
const MAX_TITLE_LENGTH = 80;
const MAX_NAME_ATTEMPTS = 1000;

/** The file name of a chat without its directory, drive prefix or extension. */
export function sessionStem(path: string): string {
  const name = path.split('/').pop() ?? '';
  const local = name.includes(':')
    ? name.slice(name.lastIndexOf(':') + 1)
    : name;
  return local.endsWith(SESSION_FILE_EXTENSION)
    ? local.slice(0, -SESSION_FILE_EXTENSION.length)
    : local;
}

/**
 * Derive a chat file name from a title: lowercase, runs of anything but
 * `a-z0-9` become `-`, trimmed, at most 48 characters; `untitled` when empty.
 */
export function slugForTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  return cut || UNTITLED_SLUG;
}

/**
 * The title a message gives its session: its first non-empty line, at most
 * 80 characters. This mirrors the rule the server applies to stored chats.
 */
export function titleFromMessage(message: string): string {
  const line =
    message
      .split(/\r?\n/)
      .map(candidate => candidate.trim())
      .find(candidate => candidate.length > 0) ?? '';
  return line.length > MAX_TITLE_LENGTH
    ? line.slice(0, MAX_TITLE_LENGTH).trimEnd()
    : line;
}

/**
 * The display title of a session: the server's title, else the file stem
 * with `-` and `_` shown as spaces.
 */
export function titleForSession(
  info: Pick<ISessionInfo, 'path' | 'title'>
): string {
  const title = info.title.trim();
  if (title) {
    return title;
  }
  const stem = sessionStem(info.path);
  if (stem === UNTITLED_SLUG) {
    return stem;
  }
  return stem.replace(/[-_]+/g, ' ').trim() || UNTITLED_SLUG;
}

/**
 * Pick the first of `slug`, `slug-2`, `slug-3`… whose chat file does not
 * exist yet in `directory`.
 */
export async function uniqueSessionName(
  contents: Contents.IManager,
  directory: string,
  slug: string
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? slug : `${slug}-${attempt}`;
    const path = contents.resolvePath(
      directory,
      `${name}${SESSION_FILE_EXTENSION}`
    );
    if (!(await findModel(contents, path))) {
      return name;
    }
  }
  throw new Error(`Too many sessions are named ${slug}.`);
}
