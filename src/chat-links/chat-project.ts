import type { Contents } from '@jupyterlab/services';
import { Token } from '@lumino/coreutils';
import { projectDirectory } from '../project-data';
import type { IProjectRoot } from '../project-root';
import { fetchChatProject } from '../sessions/sessions-api';

/** How long the project a chat belongs to is reused before the server is asked again. */
const PROJECT_CACHE_TTL = 60_000;

/** Finds the project a chat belongs to. */
export interface IChatProjectResolver {
  /**
   * The project of the chat at `chatPath`, as the server roots its agent
   * (`chat_project` in `projects.py`): the project storing the chat file,
   * else the one recorded in it. A chat outside every project that recorded
   * none yet takes the workbench's current project, which the server records
   * when it first opens the chat; else undefined.
   */
  resolve(chatPath: string): Promise<IProjectRoot | undefined>;
}

/**
 * The token of the shared chat-to-project resolver, provided by the
 * chat-project plugin and used by every feature that files something under a
 * chat's project: links, comments, mentions and the agent continuity.
 */
export const IChatProjectResolver = new Token<IChatProjectResolver>(
  'jupyterlab_lightcone:IChatProjectResolver',
  'Finds the Lightcone project a chat belongs to.'
);

/**
 * Resolve chats to projects through the server, which reads the chat's saved
 * record: Jupyter Chat sends no chat metadata to a browser that opens the chat
 * after it was recorded. A found project is remembered for a minute so footers
 * and link handlers do not ask on every render; the current project is read
 * on every call, because it may change at any time.
 */
export function createChatProjectResolver(
  contents: Contents.IManager,
  fallback: () => IProjectRoot | null | undefined
): IChatProjectResolver {
  const known = new Map<
    string,
    { at: number; project: Promise<IProjectRoot | null> }
  >();
  const lookup = (chatPath: string): Promise<IProjectRoot | null> => {
    const now = Date.now();
    const cached = known.get(chatPath);
    if (cached && now - cached.at < PROJECT_CACHE_TTL) {
      return cached.project;
    }
    const project = fetchChatProject(contents.serverSettings, chatPath).then(
      entrypoint =>
        entrypoint === null
          ? null
          : { path: projectDirectory(entrypoint), entrypoint }
    );
    const entry = { at: now, project };
    known.set(chatPath, entry);
    // Neither a failure nor a chat without a project yet is remembered: the
    // server records one when it opens the chat.
    const forget = () => {
      if (known.get(chatPath) === entry) {
        known.delete(chatPath);
      }
    };
    project.then(found => found ?? forget(), forget);
    return project;
  };
  return {
    resolve: async chatPath => {
      try {
        const found = await lookup(contents.localPath(chatPath));
        if (found) {
          return found;
        }
      } catch (error) {
        console.warn(
          `Could not determine the Lightcone project of ${chatPath}.`,
          error
        );
      }
      return fallback() ?? undefined;
    }
  };
}
