import { PathExt, URLExt } from '@jupyterlab/coreutils';

/** Where a link found in a chat message is resolved from. */
export interface IChatPathContext {
  /**
   * Absolute filesystem paths naming the server root, as `serverRoots`
   * returns them; empty when unknown.
   */
  serverRoots: readonly string[];
  /** Contents path of the directory that relative links resolve against; '' for the server root. */
  baseDirectory: string;
}

/** The page-config options that name the server root. */
export interface IServerRootOptions {
  /** Lightcone's own option: the contents root as configured, absolute. */
  lightconeServerRoot?: string;
  /** jupyter-lsp's option: the contents root as a `file:` URI, symlinks resolved. */
  rootUri?: string;
  /** JupyterLab's option: the contents root, with the home directory shortened to `~`. */
  serverRoot?: string;
}

const FILE_SCHEME = /^file:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * An absolute path with `.` and `..` segments, repeated and trailing slashes
 * removed, so comparing prefixes compares locations.
 */
function normalizeAbsolute(path: string): string {
  return `/${PathExt.normalize(path)}`.replace(/(.)\/+$/, '$1');
}

/**
 * A server root that compares with paths built from it: normalized, or ''
 * when the root is not an absolute path (unknown, or shortened to `~`).
 */
export function normalizeServerRoot(root: string): string {
  const trimmed = root.trim();
  return trimmed.startsWith('/') ? normalizeAbsolute(trimmed) : '';
}

/**
 * Every absolute path agents may use for the server root, without repeats.
 *
 * Agents start in the contents root as configured, while `rootUri` resolves
 * symlinks, so both spellings are kept. JupyterLab's `serverRoot` shortens a
 * root under the home directory to `~/…`, which no absolute path matches; it
 * counts only when it is absolute.
 */
export function serverRoots(options: IServerRootOptions): string[] {
  const candidates = [options.lightconeServerRoot ?? ''];
  if (options.rootUri) {
    try {
      const url = new URL(options.rootUri);
      if (url.protocol === 'file:') {
        candidates.push(decode(url.pathname));
      }
    } catch {
      // Not a URL: jupyter-lsp is absent or published something else.
    }
  }
  candidates.push(options.serverRoot ?? '');
  const roots: string[] = [];
  for (const candidate of candidates) {
    const root = normalizeServerRoot(candidate);
    if (root && !roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}

/** The part of a link before any query or fragment. */
function stripQueryAndFragment(reference: string): string {
  const end = reference.search(/[?#]/);
  return end < 0 ? reference : reference.slice(0, end);
}

/** A normalized absolute filesystem path from an absolute link or a `file://` URL. */
function absolutePath(reference: string): string | undefined {
  if (FILE_SCHEME.test(reference)) {
    try {
      const url = new URL(reference);
      return normalizeAbsolute(decode(url.pathname));
    } catch {
      return undefined;
    }
  }
  if (reference.startsWith('/') && !reference.startsWith('//')) {
    return normalizeAbsolute(decode(stripQueryAndFragment(reference)));
  }
  return undefined;
}

/** `path` relative to `root`, both normalized, or undefined when outside it. */
function relativeTo(path: string, root: string): string | undefined {
  if (path === root) {
    return '';
  }
  if (root === '/') {
    return path.slice(1);
  }
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
}

/**
 * The server-relative path of an absolute link inside a server root, or
 * undefined when the link is not absolute or lies outside every root.
 *
 * Dot segments are resolved first, so `<root>/../x` is outside the root.
 * When roots nest, the innermost one wins. `''` names the root itself; other
 * results have no leading slash.
 */
export function serverRelativePath(
  reference: string,
  roots: readonly string[]
): string | undefined {
  const path = absolutePath(reference.trim());
  if (path === undefined) {
    return undefined;
  }
  let best: { root: string; relative: string } | undefined;
  for (const candidate of roots) {
    const root = normalizeServerRoot(candidate);
    const relative = root ? relativeTo(path, root) : undefined;
    if (relative !== undefined && (!best || root.length > best.root.length)) {
      best = { root, relative };
    }
  }
  return best?.relative;
}

/**
 * Whether a link names a file the server can show rather than an external
 * resource: an absolute path or `file://` URL inside a server root, or a
 * relative path. Fragments and protocol-relative URLs are not files.
 */
export function isFileLink(
  reference: string,
  roots: readonly string[]
): boolean {
  const trimmed = reference.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return false;
  }
  if (trimmed.startsWith('/') || FILE_SCHEME.test(trimmed)) {
    return serverRelativePath(trimmed, roots) !== undefined;
  }
  return !ANY_SCHEME.test(trimmed);
}

/**
 * The Contents path a chat link points at, or undefined when the link is
 * external, a fragment, or escapes the server root.
 *
 * Absolute paths and `file://` URLs must lie inside a server root; relative
 * paths resolve against `baseDirectory`, the chat's project directory.
 */
export function resolveChatLink(
  reference: string,
  context: IChatPathContext
): string | undefined {
  const trimmed = reference.trim();
  if (!isFileLink(trimmed, context.serverRoots)) {
    return undefined;
  }
  if (trimmed.startsWith('/') || FILE_SCHEME.test(trimmed)) {
    return serverRelativePath(trimmed, context.serverRoots);
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
