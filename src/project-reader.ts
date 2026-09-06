import {
  assertProjectPath,
  ProjectPathError,
  type ProjectDirectoryEntry,
  type ProjectEntry,
  type ProjectReader
} from '@astra-spec/sdk';
import type { Contents } from '@jupyterlab/services';

/** A parent listing can establish absence without making a failing HTTP request. */
class MissingDirectoryError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof MissingDirectoryError ||
    (isRecord(error) &&
      (error.status === 404 ||
        (isRecord(error.response) && error.response.status === 404)))
  );
}

function entryMetadata(path: string, value: unknown): ProjectEntry {
  if (isRecord(value)) {
    if (value.type === 'directory') {
      return { type: 'directory' };
    }
    const modifiedAtMs =
      typeof value.last_modified === 'string'
        ? Date.parse(value.last_modified)
        : NaN;
    if (
      (value.type === 'file' || value.type === 'notebook') &&
      typeof value.size === 'number' &&
      Number.isSafeInteger(value.size) &&
      value.size >= 0 &&
      Number.isSafeInteger(modifiedAtMs) &&
      modifiedAtMs >= 0
    ) {
      return { type: 'file', size: value.size, modifiedAtMs };
    }
  }
  throw new Error(`Jupyter returned malformed file metadata for ${path}.`);
}

function directoryEntry(path: string, value: unknown): ProjectDirectoryEntry {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name === '.' ||
    value.name === '..' ||
    /[/\\\0]/.test(value.name) ||
    !['file', 'notebook', 'directory'].includes(String(value.type))
  ) {
    throw new Error(
      `Jupyter returned a malformed directory entry for ${path}.`
    );
  }
  return {
    name: value.name,
    type: value.type === 'directory' ? 'directory' : 'file'
  };
}

/**
 * Read one SDK project through Jupyter's configured contents manager.
 * Directory metadata is shared only within this reader (one resolution), so
 * adjacent artifact stats need one request while the next refresh sees changes.
 */
export function createJupyterProjectReader(
  contents: Contents.IManager,
  projectRoot: string
): ProjectReader {
  const validatePath = (path: string): void => {
    try {
      assertProjectPath(path);
      if (path.includes('\0')) {
        throw new Error('Project paths cannot contain null characters.');
      }
    } catch (error) {
      throw new ProjectPathError(
        error instanceof Error ? error.message : `Invalid project path: ${path}`
      );
    }
  };
  validatePath(contents.localPath(projectRoot));
  const root = contents.normalize(projectRoot);
  const rooted = (path: string): string => {
    validatePath(path);
    const resolved = contents.resolvePath(root, path);
    if (contents.driveName(resolved) !== contents.driveName(root)) {
      throw new ProjectPathError(
        `Project path changes contents drive: ${path}`
      );
    }
    return resolved;
  };
  const directories = new Map<string, Promise<ReadonlyMap<string, unknown>>>();
  const readDirectory = (
    path: string
  ): Promise<ReadonlyMap<string, unknown>> => {
    const resolved = rooted(path);
    let pending = directories.get(path);
    if (!pending) {
      pending = (async (): Promise<ReadonlyMap<string, unknown>> => {
        if (path) {
          const slash = path.lastIndexOf('/');
          try {
            const parent = await readDirectory(
              path.slice(0, Math.max(0, slash))
            );
            if (!parent.has(path.slice(slash + 1))) {
              throw new MissingDirectoryError(
                `No project directory exists at "${path}".`
              );
            }
          } catch (error) {
            if (isNotFound(error) || error instanceof ProjectPathError) {
              throw error;
            }
            // A custom drive may allow a child listing without access to its parent.
          }
        }
        const model = await contents.get(resolved, {
          content: true,
          type: 'directory'
        });
        const values: unknown = model.content;
        if (model.type !== 'directory' || !Array.isArray(values)) {
          throw new Error(`Jupyter could not read ${path} as a directory.`);
        }
        const entries = new Map<string, unknown>();
        for (const value of values) {
          const entry = directoryEntry(path, value);
          if (entries.has(entry.name)) {
            throw new Error(`Jupyter returned duplicate entries for ${path}.`);
          }
          entries.set(entry.name, value);
        }
        return entries;
      })();
      directories.set(path, pending);
    }
    return pending;
  };
  const statDirect = async (
    path: string
  ): Promise<ProjectEntry | undefined> => {
    try {
      return entryMetadata(
        path,
        await contents.get(rooted(path), { content: false })
      );
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  };

  return {
    async readText(path): Promise<string> {
      const model = await contents.get(rooted(path), {
        content: true,
        type: 'file',
        format: 'text'
      });
      if (
        model.type !== 'file' ||
        model.format !== 'text' ||
        typeof model.content !== 'string'
      ) {
        throw new Error(`Jupyter could not read ${path} as a text file.`);
      }
      return model.content;
    },
    async stat(path): Promise<ProjectEntry | undefined> {
      rooted(path);
      if (path) {
        const slash = path.lastIndexOf('/');
        try {
          const entries = await readDirectory(
            path.slice(0, Math.max(0, slash))
          );
          const entry = entries.get(path.slice(slash + 1));
          return entry === undefined ? undefined : entryMetadata(path, entry);
        } catch (error) {
          if (error instanceof ProjectPathError) {
            throw error;
          }
          if (isNotFound(error)) {
            return undefined;
          }
          // Listings are an optimization: custom drives may omit metadata or
          // allow reading a file without permission to list its parent.
        }
      }
      return statDirect(path);
    },
    async readDirectory(path): Promise<ProjectDirectoryEntry[]> {
      return Array.from((await readDirectory(path)).values(), value =>
        directoryEntry(path, value)
      );
    }
  };
}
