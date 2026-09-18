import { ServerConnection, type Contents } from '@jupyterlab/services';
import { projectDirectory } from './project-data';

export interface IProjectRoot {
  path: string;
  entrypoint: string;
}

/** Fetch a model without its content; a missing path is undefined, not an error. */
export async function findModel(
  contents: Contents.IManager,
  path: string
): Promise<Contents.IModel | undefined> {
  try {
    return await contents.get(path, { content: false });
  } catch (error) {
    if (
      error instanceof ServerConnection.ResponseError &&
      error.response.status === 404
    ) {
      return undefined;
    }
    throw error;
  }
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
    const spec = await findModel(contents, entrypoint);
    if (spec) {
      if (spec.type !== 'file') throw new Error(`${entrypoint} is not a file.`);
      return { path, entrypoint };
    }
    const parent = projectDirectory(path);
    if (parent === path) return undefined;
    path = parent;
  }
}
