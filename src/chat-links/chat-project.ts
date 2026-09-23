import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { findProjectRoot, type IProjectRoot } from '../project-root';

/** How long a chat's project lookup is reused before the folders are read again. */
const PROJECT_CACHE_TTL = 60_000;

/** Finds the project a chat belongs to. */
export interface IChatProjectResolver {
  /**
   * The project owning the chat stored at `chatPath`, else the workbench's
   * current project (chats stored outside every project join it), else
   * undefined.
   */
  resolve(chatPath: string): Promise<IProjectRoot | undefined>;
}

/**
 * Resolve chats to projects by walking up from the chat file, remembering
 * each answer for a minute so footers and link handlers do not repeat the
 * lookups on every render.
 */
export function createChatProjectResolver(
  contents: Contents.IManager,
  fallback: () => IProjectRoot | null | undefined
): IChatProjectResolver {
  const cache = new Map<
    string,
    { at: number; project: Promise<IProjectRoot | undefined> }
  >();
  return {
    resolve: chatPath => {
      const now = Date.now();
      const cached = cache.get(chatPath);
      if (cached && now - cached.at < PROJECT_CACHE_TTL) {
        return cached.project;
      }
      const project = findProjectRoot(contents, PathExt.dirname(chatPath))
        .then(found => found ?? fallback() ?? undefined)
        .catch(error => {
          console.warn(
            `Could not determine the Lightcone project of ${chatPath}.`,
            error
          );
          cache.delete(chatPath);
          return fallback() ?? undefined;
        });
      cache.set(chatPath, { at: now, project });
      return project;
    }
  };
}
