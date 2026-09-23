import { PathExt, URLExt } from '@jupyterlab/coreutils';

/** Where a link found in a chat message is resolved from. */
export interface IChatPathContext {
  /** Absolute filesystem path of the server root, without a trailing slash; '' when unknown. */
  serverRoot: string;
  /** Contents path of the directory that relative links resolve against; '' for the server root. */
  baseDirectory: string;
}

const FILE_SCHEME = /^file:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Drop trailing slashes so a root compares with paths built from it. */
export function normalizeServerRoot(root: string): string {
  return root.replace(/\/+$/, '');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The part of a link before any query or fragment. */
function stripQueryAndFragment(reference: string): string {
  const end = reference.search(/[?#]/);
  return end < 0 ? reference : reference.slice(0, end);
}

/** An absolute filesystem path from an absolute link or a `file://` URL. */
function absolutePath(reference: string): string | undefined {
  if (FILE_SCHEME.test(reference)) {
    try {
      const url = new URL(reference);
      return decode(url.pathname);
    } catch {
      return undefined;
    }
  }
  if (reference.startsWith('/') && !reference.startsWith('//')) {
    return decode(stripQueryAndFragment(reference));
  }
  return undefined;
}

/**
 * The server-relative path of an absolute link inside the server root, or
 * undefined when the link is not absolute or lies outside the root.
 *
 * `''` names the root itself; other results have no leading slash.
 */
export function serverRelativePath(
  reference: string,
  serverRoot: string
): string | undefined {
  const root = normalizeServerRoot(serverRoot);
  const path = absolutePath(reference.trim());
  if (path === undefined || !root) {
    return undefined;
  }
  const normalized = path.replace(/\/+$/, '') || '/';
  if (normalized === root) {
    return '';
  }
  return normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : undefined;
}

/**
 * Whether a link names a file the server can show rather than an external
 * resource: an absolute path or `file://` URL inside the server root, or a
 * relative path. Fragments and protocol-relative URLs are not files.
 */
export function isFileLink(reference: string, serverRoot: string): boolean {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return false;
  }
  if (trimmed.startsWith('/') || FILE_SCHEME.test(trimmed)) {
    return serverRelativePath(trimmed, serverRoot) !== undefined;
  }
  return !ANY_SCHEME.test(trimmed);
}

/**
 * The Contents path a chat link points at, or undefined when the link is
 * external, a fragment, or escapes the server root.
 *
 * Absolute paths and `file://` URLs must lie inside the server root; relative
 * paths resolve against `baseDirectory`, the chat's project directory.
 */
export function resolveChatLink(
  reference: string,
  context: IChatPathContext
): string | undefined {
  const trimmed = reference.trim();
  if (!isFileLink(trimmed, context.serverRoot)) {
    return undefined;
  }
  if (trimmed.startsWith('/') || FILE_SCHEME.test(trimmed)) {
    return serverRelativePath(trimmed, context.serverRoot);
  }
  const relative = decode(stripQueryAndFragment(trimmed));
  if (!relative) {
    return undefined;
  }
  const joined = PathExt.normalize(
    PathExt.join(context.baseDirectory.replace(/^\/+/, ''), relative)
  );
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) {
    return undefined;
  }
  return joined === '.' ? '' : joined;
}

/**
 * The `files/` URL that serves an image linked by path from a chat message,
 * or undefined when the source is not such a path.
 */
export function rewriteImageSource(
  source: string,
  context: IChatPathContext,
  baseUrl: string
): string | undefined {
  const path = resolveChatLink(source, context);
  if (!path) {
    return undefined;
  }
  return URLExt.join(baseUrl, 'files', URLExt.encodeParts(path));
}

/** A path shown relative to the project when inside it, else as given. */
export function displayPath(path: string, projectDirectory: string): string {
  const project = projectDirectory.replace(/^\/+|\/+$/g, '');
  if (!project) {
    return path;
  }
  return path.startsWith(`${project}/`) ? path.slice(project.length + 1) : path;
}
