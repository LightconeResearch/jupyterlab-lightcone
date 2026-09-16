import { ServerConnection, type Contents } from '@jupyterlab/services';
import { projectDirectory } from './project-data';

export interface IProjectRoot {
  path: string;
  entrypoint: string;
}

/** Resolve the nearest ASTRA project without consulting filtered UI listings.
 * Stops at the current Contents drive root; only missing files permit ascent.
 */
export async function findProjectRoot(
  contents: Contents.IManager,
  directory: string
): Promise<IProjectRoot | undefined> {
  let path = contents.normalize(directory);
  for (;;) {
    const entrypoint = contents.resolvePath(path, 'astra.yaml');
    try {
      const spec = await contents.get(entrypoint, { content: false });
      if (spec.type !== 'file') throw new Error(`${entrypoint} is not a file.`);
      return { path, entrypoint };
    } catch (error) {
      if (
        !(error instanceof ServerConnection.ResponseError) ||
        error.response.status !== 404
      ) {
        throw error;
      }
    }
    const parent = projectDirectory(path);
    if (parent === path) return undefined;
    path = parent;
  }
}

/** Use the enclosing project, or the selected directory for setup guidance. */
export async function projectEntrypoint(
  contents: Contents.IManager,
  directory: string
): Promise<string> {
  return (
    (await findProjectRoot(contents, directory))?.entrypoint ??
    contents.resolvePath(directory, 'astra.yaml')
  );
}
