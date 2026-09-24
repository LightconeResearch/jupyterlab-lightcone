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

/** One message of a session containing the searched text. */
export interface ISessionMatch {
  /** Contents path of the `.chat` file. */
  path: string;
  /** The session's title. */
  title: string;
  /** The message's ID, when it has one. */
  message: string | null;
  /** Who wrote the message, as the chat names them. */
  author: string | null;
  /** Whether an agent wrote it. */
  agent: boolean;
  /** When it was written, ISO 8601. */
  time: string | null;
  /** The text around the match, on one line. */
  snippet: string;
}

/** The shortest query the server searches session text for. */
export const MIN_SESSION_QUERY = 2;

function isSessionMatch(value: unknown): value is ISessionMatch {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.title === 'string' &&
    (value.message === null || typeof value.message === 'string') &&
    (value.author === null || typeof value.author === 'string') &&
    typeof value.agent === 'boolean' &&
    (value.time === null || typeof value.time === 'string') &&
    typeof value.snippet === 'string'
  );
}

/** Messages of the project's sessions containing `query`, newest first. */
export async function searchSessions(
  settings: ServerConnection.ISettings,
  entrypoint: string,
  query: string
): Promise<ISessionMatch[]> {
  try {
    const data = await requestAPI(
      `api/chat-sessions/search?${new URLSearchParams({ path: entrypoint, q: query })}`,
      settings
    );
    if (
      !isRecord(data) ||
      !Array.isArray(data.matches) ||
      !data.matches.every(isSessionMatch)
    ) {
      throw new Error('The server returned invalid search results.');
    }
    return data.matches;
  } catch (error) {
    throw new RequestError('Session search', error);
  }
}

/**
 * The persona a project's messages last went to (`<project>/.lightcone/agent.json`),
 * or null when none is recorded yet.
 */
export async function fetchProjectAgent(
  settings: ServerConnection.ISettings,
  entrypoint: string
): Promise<string | null> {
  try {
    const data = await requestAPI(
      `api/project-agent?${new URLSearchParams({ path: entrypoint })}`,
      settings
    );
    if (
      !isRecord(data) ||
      (data.persona !== null && typeof data.persona !== 'string')
    ) {
      throw new Error('The server returned an invalid project agent.');
    }
    return data.persona;
  } catch (error) {
    throw new RequestError('Project agent', error);
  }
}
