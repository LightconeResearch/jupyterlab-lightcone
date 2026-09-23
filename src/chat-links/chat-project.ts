import { PathExt } from '@jupyterlab/coreutils';
import type { Contents } from '@jupyterlab/services';
import { findProjectRoot, type IProjectRoot } from '../project-root';

/** How long the project storing a chat file is reused before the folders are read again. */
const PROJECT_CACHE_TTL = 60_000;

/**
 * The chat metadata entry where the server records the project a chat stored
 * outside every project joined when it was first opened (`CHAT_PROJECT` in
 * `projects.py`).
 */
export const CHAT_PROJECT_METADATA = 'lightcone_project';

/** Finds the project a chat belongs to. */
export interface IChatProjectResolver {
  /**
   * The project a chat belongs to, by the rule the server applies to the
   * agent's working directory (`chat_project` in `projects.py`): the project
   * storing the chat file at `chatPath`, else the project `recorded` in the
   * chat, else the workbench's current project, else undefined.
   */
  resolve(
    chatPath: string,
    recorded?: string
  ): Promise<IProjectRoot | undefined>;
}

/** Jupyter Chat's shared chat document, down to its chat-level metadata map. */
interface ISharedChatDocument {
  ydoc: { getMap(name: string): { get(key: string): unknown } };
}

function isSharedChatDocument(value: unknown): value is ISharedChatDocument {
  if (typeof value !== 'object' || value === null || !('ydoc' in value)) {
    return false;
  }
  const document = value.ydoc;
  return (
    typeof document === 'object' &&
    document !== null &&
    'getMap' in document &&
    typeof document.getMap === 'function'
  );
}

/**
 * The project entrypoint the server recorded in a chat document, read from
 * the chat model's shared document; undefined for other models.
 *
 * `YChat` keeps chat-level metadata in its document's `metadata` map; the
 * map is read directly because `YChat.getSource()` would copy every message.
 */
export function recordedChatProject(model: unknown): string | undefined {
  if (
    typeof model !== 'object' ||
    model === null ||
    !('sharedModel' in model) ||
    !isSharedChatDocument(model.sharedModel)
  ) {
    return undefined;
  }
  const value = model.sharedModel.ydoc
    .getMap('metadata')
    .get(CHAT_PROJECT_METADATA);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The project a recorded entrypoint names, validated as the server validates
 * it (`spec_project`): a relative path on the local drive, without parent
 * segments, to an `astra.yaml`.
 */
export function recordedProjectRoot(
  entrypoint: string | undefined
): IProjectRoot | undefined {
  if (
    !entrypoint ||
    entrypoint.startsWith('/') ||
    /[\\:\0]/.test(entrypoint) ||
    entrypoint.split('/').includes('..') ||
    PathExt.basename(entrypoint) !== 'astra.yaml'
  ) {
    return undefined;
  }
  return { path: PathExt.dirname(entrypoint), entrypoint };
}

/**
 * Resolve chats to projects. The project storing a chat file is remembered
 * for a minute so footers and link handlers do not repeat the folder walk on
 * every render; the recorded and current projects are read on every call,
 * because either may change at any time.
 */
export function createChatProjectResolver(
  contents: Contents.IManager,
  fallback: () => IProjectRoot | null | undefined
): IChatProjectResolver {
  const owners = new Map<
    string,
    { at: number; project: Promise<IProjectRoot | undefined> }
  >();
  const owner = (chatPath: string): Promise<IProjectRoot | undefined> => {
    const now = Date.now();
    const cached = owners.get(chatPath);
    if (cached && now - cached.at < PROJECT_CACHE_TTL) {
      return cached.project;
    }
    const project = findProjectRoot(contents, PathExt.dirname(chatPath));
    const entry = { at: now, project };
    owners.set(chatPath, entry);
    project.catch(() => {
      if (owners.get(chatPath) === entry) {
        owners.delete(chatPath);
      }
    });
    return project;
  };
  return {
    resolve: async (chatPath, recorded) => {
      try {
        const found = await owner(chatPath);
        if (found) {
          return found;
        }
      } catch (error) {
        console.warn(
          `Could not determine the Lightcone project of ${chatPath}.`,
          error
        );
      }
      return recordedProjectRoot(recorded) ?? fallback() ?? undefined;
    }
  };
}
