import {
  SESSION_FILE_EXTENSION,
  sessionStem,
  slugForTitle
} from '../sessions/session-titles';

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
