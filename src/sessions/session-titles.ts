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

/**
 * The file name of a chat without its directory, drive prefix or extension.
 *
 * Only a path's first segment can carry a drive (`drive:plan.chat`), so a
 * colon in the name of a chat inside a folder (`p/chats/q: fit.chat`) is part
 * of its name.
 */
export function sessionStem(path: string): string {
  const segments = path.split('/');
  let name = segments[segments.length - 1];
  if (segments.length === 1 && name.includes(':')) {
    name = name.slice(name.indexOf(':') + 1);
  }
  return name.endsWith(SESSION_FILE_EXTENSION)
    ? name.slice(0, -SESSION_FILE_EXTENSION.length)
    : name;
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
 * The line boundaries of Python's `str.splitlines`, which the server uses to
 * find a message's first line, apart from the ASCII file, group and record
 * separators that typed text never contains.
 */
const LINE_BREAK = /\r\n|[\n\r\v\f\x85\u2028\u2029]/;

/**
 * The title a message gives its session: its first non-empty line; a line
 * longer than 80 characters keeps its first 79, trimmed, followed by `…`.
 * This is `session_title` in `jupyterlab_lightcone/sessions.py`, so a toast
 * names a session exactly as the listings do. Lengths count code points, as
 * Python does.
 */
export function titleFromMessage(message: string): string {
  const line =
    message
      .split(LINE_BREAK)
      .map(candidate => candidate.trim())
      .find(candidate => candidate.length > 0) ?? '';
  const characters = Array.from(line);
  return characters.length > MAX_TITLE_LENGTH
    ? `${characters
        .slice(0, MAX_TITLE_LENGTH - 1)
        .join('')
        .trimEnd()}…`
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
