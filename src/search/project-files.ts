import type { Contents } from '@jupyterlab/services';
import { isRecord } from '../api';

/** A file found by the bounded project walk. */
export interface IProjectFile {
  /** Contents path, including any drive prefix. */
  path: string;
  name: string;
  /** Project-relative folder; empty at the project root. */
  directory: string;
}

export interface IProjectWalkOptions {
  /** Stop once this many files are collected (500 by default). */
  limit?: number;
  /** Deepest file depth listed (4 by default). */
  maxDepth?: number;
  /**
   * Folders listed at most, one Contents request each (200 by default); the
   * project root is always listed.
   */
  maxListings?: number;
}

const PROJECT_WALK_LIMIT = 500;
const PROJECT_WALK_DEPTH = 4;
const PROJECT_WALK_LISTINGS = 200;

/** Tool folders that never hold anything a researcher searches for. */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.venv',
  '_build',
  'node_modules',
  '.git',
  '__pycache__'
]);

/**
 * The engine keeps hidden manifests beside each result:
 * `results/<universe>/.<id>.manifest.json`. This is the browser's one copy of
 * the engine's results layout (the server's is `jupyterlab_lightcone/results.py`).
 */
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
        isRecord(item) &&
        typeof item.name === 'string' &&
        typeof item.type === 'string'
    )
  );
}

/**
 * List a project's files breadth first through the Contents API, shallow
 * files first, stopping at `limit` files, `maxDepth` levels or `maxListings`
 * folder requests, whichever comes first. A folder that cannot be listed is
 * skipped, never fatal.
 */
export async function walkProjectFiles(
  contents: Contents.IManager,
  root: string,
  options: IProjectWalkOptions = {}
): Promise<IProjectFile[]> {
  const limit = options.limit ?? PROJECT_WALK_LIMIT;
  const maxDepth = options.maxDepth ?? PROJECT_WALK_DEPTH;
  const maxListings = options.maxListings ?? PROJECT_WALK_LISTINGS;
  const files: IProjectFile[] = [];
  const queue: IQueuedDirectory[] = [{ path: root, directory: '', depth: 0 }];
  // Folders listed plus folders queued never exceed `maxListings`, so a tree
  // of many near-empty folders costs a bounded number of requests.
  let listed = 0;
  for (
    let current = queue.shift();
    current && files.length < limit;
    current = queue.shift()
  ) {
    listed += 1;
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
        if (depth < maxDepth && listed + queue.length < maxListings) {
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
      files.push({ path, name: entry.name, directory: current.directory });
    }
  }
  return files;
}
