import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';
import type { ISessionInfo } from './sessions-api';

/** Options for starting a project session. */
export interface ISessionStartOptions {
  /** Title used to name the chat file; untitled when absent. */
  title?: string;
  /**
   * Text left in the composer for the user to finish, unsent.
   */
  draft?: string;
}

/** Project-scoped sessions: Jupyter AI chats stored under `<project>/chats/`. */
export interface ISessionService {
  /** The sessions of the project owning `entrypoint`, newest first. */
  list(entrypoint: string): Promise<ISessionInfo[]>;
  /** Create a session in the project, open it in the main area and resolve with its path. */
  createAndOpen(
    entrypoint: string,
    options?: ISessionStartOptions
  ): Promise<string>;
  /** Open (or activate) the session stored at `path` in the main area. */
  openSession(path: string): Promise<void>;
  /** Emitted with the entrypoint whose sessions changed. */
  readonly changed: ISignal<ISessionService, string>;
}

/**
 * The token the sessions plugin provides. It is provided only when Jupyter
 * Chat is available, so consumers take it optionally and hide their session
 * features when it resolves to null.
 */
export const ISessionService = new Token<ISessionService>(
  'jupyterlab_lightcone:ISessionService',
  'Project-scoped Jupyter AI sessions: list, create and open them.'
);
