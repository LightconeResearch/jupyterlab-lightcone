import { PageConfig } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';

/**
 * The page option Lightcone's server extension publishes when its routes are
 * installed: `pip install 'jupyterlab-lightcone[full]'`
 * (`application.SERVER_OPTION`).
 */
export const SERVER_OPTION = 'lightconeServer';

/**
 * Whether Lightcone's server routes are on this Jupyter server.
 *
 * Without them the workbench runs in the browser alone, on the Contents API:
 * the plugins built on agents are left out (`src/index.ts`), and nothing asks
 * for materialization status, run records, version history or the paper cache.
 */
export function hasLightconeServer(
  option: string = PageConfig.getOption(SERVER_OPTION)
): boolean {
  return option === 'true';
}

/**
 * Whether the server routes can read the project holding `path`: they run
 * `lc status` and read run records and git history from its local folder, so
 * they need both the `full` install and a project on the local drive.
 */
export function serverReadsProject(
  contents: Contents.IManager,
  path: string
): boolean {
  return hasLightconeServer() && !contents.driveName(path);
}
