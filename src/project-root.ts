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

/** How many folders `projectFoldersAmong` probes at once. */
const PROBE_CONCURRENCY = 8;

/** The most folders `projectFoldersAmong` probes, so a crowded folder stays quick. */
const PROBE_LIMIT = 200;

/**
 * The folders among `folders` that hold an `astra.yaml`, in the order given,
 * found through the Contents API alone: one metadata read per folder, a few at
 * a time, for the first `PROBE_LIMIT` of them. Lightcone's server lists local
 * folders in one request (`api.projectFolders`); this serves every other case.
 * A folder that cannot be read is skipped rather than failing the listing.
 */
export async function projectFoldersAmong(
  contents: Contents.IManager,
  folders: readonly string[]
): Promise<string[]> {
  const probed = folders.slice(0, PROBE_LIMIT);
  const projects = new Set<string>();
  let next = 0;
  const probe = async (): Promise<void> => {
    while (next < probed.length) {
      const folder = probed[next++];
      const entrypoint = contents.resolvePath(folder, 'astra.yaml');
      const spec = await findModel(contents, entrypoint).catch(() => undefined);
      if (spec?.type === 'file') projects.add(folder);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, probed.length) }, probe)
  );
  return probed.filter(folder => projects.has(folder));
}
