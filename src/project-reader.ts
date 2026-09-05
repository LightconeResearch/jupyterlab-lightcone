import {
  assertProjectPath,
  ProjectPathError,
  type ProjectDirectoryEntry,
  type ProjectReader
} from '@astra-spec/sdk';
import { ServerConnection, type Contents } from '@jupyterlab/services';

/** Only the Contents operations needed by the read-only SDK adapter. */
export type ProjectContents = Pick<
  Contents.IManager,
  'get' | 'driveName' | 'localPath' | 'resolvePath'
>;

/** Validate before resolving: Contents normalization would otherwise hide escapes. */
function validatePath(path: string): void {
  try {
    assertProjectPath(path);
    if (
      path.includes(':') ||
      Array.from(path).some(
        character =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    ) {
      throw new Error(`Invalid project-relative path: ${path}`);
    }
  } catch (error) {
    throw new ProjectPathError(
      error instanceof Error ? error.message : 'Invalid project-relative path.'
    );
  }
}

/** Adapt a configured Contents drive without interpreting ASTRA artifact layouts. */
export function createJupyterProjectReader(
  contents: ProjectContents,
  projectRoot: string
): ProjectReader {
  const drive = contents.driveName(projectRoot);
  validatePath(contents.localPath(projectRoot));
  const rooted = (path: string): string => {
    validatePath(path);
    const resolved = contents.resolvePath(projectRoot, path);
    if (contents.driveName(resolved) !== drive) {
      throw new ProjectPathError(
        `Project path changes Contents drive: ${path}`
      );
    }
    return resolved;
  };
  const read = async (
    path: string,
    options: Contents.IFetchOptions
  ): Promise<Contents.IModel> => {
    const fullPath = rooted(path);
    try {
      return await contents.get(fullPath, options);
    } catch (error) {
      if (error instanceof ServerConnection.ResponseError) {
        const status = error.response.status;
        const detail =
          status === 404
            ? 'File not found'
            : status === 401 || status === 403
              ? 'Permission denied'
              : 'Contents request failed';
        // Preserve the status for stat(), without exposing server HTML bodies.
        throw new ServerConnection.ResponseError(
          error.response,
          `${detail} (HTTP ${status}): ${fullPath}`
        );
      }
      throw new Error(
        `Could not read ${fullPath}: ${error instanceof Error ? error.message : 'Contents request failed'}`
      );
    }
  };

  return {
    async readText(path) {
      const model = await read(path, {
        content: true,
        type: 'file',
        format: 'text'
      });
      if (
        !model ||
        model.type !== 'file' ||
        model.format !== 'text' ||
        typeof model.content !== 'string'
      ) {
        throw new Error(`Jupyter returned malformed text content for ${path}.`);
      }
      return model.content;
    },
    async stat(path) {
      let model: Contents.IModel;
      try {
        model = await read(path, { content: false });
      } catch (error) {
        if (
          error instanceof ServerConnection.ResponseError &&
          error.response.status === 404
        ) {
          return undefined;
        }
        throw error;
      }
      if (model?.type === 'directory') {
        return { type: 'directory' };
      }
      const modifiedAtMs = Date.parse(model?.last_modified);
      const size = model?.size;
      if (
        !model ||
        !['file', 'notebook'].includes(model.type) ||
        typeof size !== 'number' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(modifiedAtMs) ||
        modifiedAtMs < 0
      ) {
        throw new Error(
          `Jupyter returned malformed file metadata for ${path}.`
        );
      }
      return { type: 'file', size, modifiedAtMs };
    },
    async readDirectory(path) {
      const model = await read(path, { content: true, type: 'directory' });
      if (
        !model ||
        model.type !== 'directory' ||
        !Array.isArray(model.content)
      ) {
        throw new Error(
          `Jupyter returned malformed directory content for ${path}.`
        );
      }
      const names = new Set<string>();
      return model.content.map((value: unknown): ProjectDirectoryEntry => {
        if (
          !value ||
          typeof value !== 'object' ||
          !('name' in value) ||
          typeof value.name !== 'string' ||
          !value.name ||
          value.name.includes('/') ||
          !('type' in value) ||
          !['file', 'notebook', 'directory'].includes(String(value.type)) ||
          names.has(value.name)
        ) {
          throw new Error(
            `Jupyter returned a malformed directory entry for ${path}.`
          );
        }
        validatePath(value.name);
        names.add(value.name);
        return {
          name: value.name,
          type: value.type === 'directory' ? 'directory' : 'file'
        };
      });
    }
  };
}
