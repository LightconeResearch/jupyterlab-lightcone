import { Token } from '@lumino/coreutils';
import type { ISignal } from '@lumino/signaling';
import type { ISessionInfo } from './sessions-api';

/** Activity as the workbench sees it, including open chats waiting for the user. */
export type SessionState = 'working' | 'idle' | 'attention';

/** Options for starting a project session. */
export interface ISessionStartOptions {
  /** Title used to name the chat file; derived from `firstMessage` when absent. */
  title?: string;
  /** A message to send as soon as the session is open. */
  firstMessage?: string;
  /** Persona ID to address the first message to; the chat default otherwise. */
  persona?: string;
  /**
   * Text left in the composer for the user to finish, unsent; ignored when
   * `firstMessage` is sent instead.
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
  /** Live activity of a session, when the workbench knows it. */
  activity(path: string): SessionState | undefined;
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
