import type { Contents } from '@jupyterlab/services';

/** A file found by the bounded project walk. */
export interface IProjectFile {
  /** Contents path, including any drive prefix. */
  path: string;
  name: string;
  /** Project-relative folder; empty at the project root. */
  directory: string;
  /** Segments in the project-relative path; 1 for a root file. */
  depth: number;
}

export interface IProjectWalkOptions {
  /** Stop once this many files are collected (500 by default). */
  limit?: number;
  /** Deepest file depth listed (4 by default). */
  maxDepth?: number;
}

/** Default bounds of the walk, shared with the tests. */
export const PROJECT_WALK_LIMIT = 500;
export const PROJECT_WALK_DEPTH = 4;

/** Tool folders that never hold anything a researcher searches for. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.venv',
  '_build',
  'node_modules',
  '.git',
  '__pycache__'
]);

/** The engine keeps hidden manifests beside each result: `results/<universe>/.<id>.manifest.json`. */
const RESULT_UNIVERSE = /^results\/[^/]+$/;

/**
 * Whether an entry stays out of search: tool folders anywhere, and hidden
 * files inside a results universe.
 */
export function skipsProjectEntry(
  directory: string,
  name: string,
  type: string
): boolean {
  if (type === 'directory' && SKIPPED_DIRECTORIES.has(name)) {
    return true;
  }
  return name.startsWith('.') && RESULT_UNIVERSE.test(directory);
}

interface IQueuedDirectory {
  path: string;
  directory: string;
  depth: number;
}

function isModelList(content: unknown): content is Contents.IModel[] {
  return (
    Array.isArray(content) &&
    content.every(
      item =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { type?: unknown }).type === 'string'
    )
  );
}

/**
 * List a project's files breadth first through the Contents API, shallow
 * files first, stopping at `limit` files or `maxDepth` levels. A folder that
 * cannot be listed is skipped, never fatal.
 */
export async function walkProjectFiles(
  contents: Contents.IManager,
  root: string,
  options: IProjectWalkOptions = {}
): Promise<IProjectFile[]> {
  const limit = options.limit ?? PROJECT_WALK_LIMIT;
  const maxDepth = options.maxDepth ?? PROJECT_WALK_DEPTH;
  const files: IProjectFile[] = [];
  const queue: IQueuedDirectory[] = [{ path: root, directory: '', depth: 0 }];
  while (queue.length && files.length < limit) {
    const current = queue.shift()!;
    let listing: Contents.IModel;
    try {
      listing = await contents.get(current.path, {
        content: true,
        type: 'directory'
      });
    } catch (error) {
      console.warn(
        `Lightcone search skipped the folder ${current.path || '/'}.`,
        error
      );
      continue;
    }
    const entries = isModelList(listing.content) ? [...listing.content] : [];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (skipsProjectEntry(current.directory, entry.name, entry.type)) {
        continue;
      }
      const path = contents.resolvePath(current.path, entry.name);
      const depth = current.depth + 1;
      if (entry.type === 'directory') {
        if (depth < maxDepth) {
          queue.push({
            path,
            directory: current.directory
              ? `${current.directory}/${entry.name}`
              : entry.name,
            depth
          });
        }
        continue;
      }
      if (files.length >= limit) {
        break;
      }
      files.push({
        path,
        name: entry.name,
        directory: current.directory,
        depth
      });
    }
  }
  return files;
}
