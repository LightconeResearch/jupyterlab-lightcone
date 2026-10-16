import { PageConfig } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';

/**
 * The page option Lightcone's server extension publishes when its routes are
 * installed: `pip install 'jupyterlab-lightcone[engine]'`
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
 * The page option Lightcone's server extension publishes when Jupyter AI and
 * Jupyter Chat are installed: `pip install 'jupyterlab-lightcone[full]'`
 * (`application.AGENTS_OPTION`).
 */
export const AGENTS_OPTION = 'lightconeAgents';

/**
 * Whether agents run in Jupyter AI chats on this server.
 *
 * Without the `full` install the chat plugins are left out (`src/index.ts`)
 * and Home has no desk. The engine features of `hasLightconeServer()` do not
 * depend on it.
 */
export function hasChatAgents(
  option: string = PageConfig.getOption(AGENTS_OPTION)
): boolean {
  return hasLightconeServer() && option === 'true';
}

/**
 * Whether the server routes can read the project holding `path`: they run
 * `lc status` and read run records and git history from its local folder, so
 * they need both the `engine` install and a project on the local drive.
 */
export function serverReadsProject(
  contents: Contents.IManager,
  path: string
): boolean {
  return hasLightconeServer() && !contents.driveName(path);
}
