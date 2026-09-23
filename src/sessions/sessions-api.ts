import type { ServerConnection } from '@jupyterlab/services';
import { isRecord, RequestError } from '../api';
import { requestAPI } from '../request';

/** Activity of a session as the server reports it. */
export type SessionActivity = 'working' | 'idle';

/** One conversation stored as a `.chat` file inside a project. */
export interface ISessionInfo {
  /** Contents path of the `.chat` file. */
  path: string;
  /** Title derived from the first user message, or the file name. */
  title: string;
  /** Last modification time, ISO 8601. */
  modified: string;
  /** Number of messages in the file. */
  messages: number;
  /** Display name of the last agent that replied, when known. */
  lastAgent: string | null;
  /** Whether an agent is processing a message in this session. */
  activity: SessionActivity;
}

/** The server's listing of a project's sessions. */
export interface ISessionListing {
  /** Contents path of the project's `chats` directory. */
  directory: string;
  sessions: ISessionInfo[];
}

function isSessionInfo(value: unknown): value is ISessionInfo {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.title === 'string' &&
    typeof value.modified === 'string' &&
    typeof value.messages === 'number' &&
    (value.lastAgent === null || typeof value.lastAgent === 'string') &&
    (value.activity === 'working' || value.activity === 'idle')
  );
}

/** List the sessions of the project owning `entrypoint`, newest first. */
export async function listSessions(
  settings: ServerConnection.ISettings,
  entrypoint: string
): Promise<ISessionListing> {
  try {
    const data = await requestAPI(
      `api/chat-sessions?${new URLSearchParams({ path: entrypoint })}`,
      settings
    );
    if (
      !isRecord(data) ||
      typeof data.directory !== 'string' ||
      !Array.isArray(data.sessions) ||
      !data.sessions.every(isSessionInfo)
    ) {
      throw new Error('The server returned an invalid session listing.');
    }
    return { directory: data.directory, sessions: data.sessions };
  } catch (error) {
    throw new RequestError('Sessions', error);
  }
}

/**
 * Make sure the project can hold sessions: create its `chats` directory and
 * keep chat files out of the project's Git status.
 */
export async function prepareSessions(
  settings: ServerConnection.ISettings,
  entrypoint: string
): Promise<{ directory: string }> {
  try {
    const data = await requestAPI('api/chat-sessions', settings, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: entrypoint })
    });
    if (!isRecord(data) || typeof data.directory !== 'string') {
      throw new Error('The server returned an invalid session directory.');
    }
    return { directory: data.directory };
  } catch (error) {
    throw new RequestError('Sessions', error);
  }
}
