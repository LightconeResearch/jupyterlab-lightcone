import { ServerConnection } from '@jupyterlab/services';
import { RequestError, isRecord } from '../api';
import { requestAPI } from '../request';

/** Status of an owner-scoped, managed MySTRA project. */
export interface IMySTRASession {
  id: string;
  path: string;
  state: 'starting' | 'ready' | 'failed';
  message: string;
  /** Increases when the server restarts MyST, for example to rebuild. */
  launch: number;
  url: string;
  logs: string[];
}

/** Validate the server's viewer contract before assigning an iframe URL. */
function mySTRASession(value: unknown): IMySTRASession {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.id) ||
    typeof value.path !== 'string' ||
    (value.state !== 'starting' &&
      value.state !== 'ready' &&
      value.state !== 'failed') ||
    typeof value.message !== 'string' ||
    typeof value.launch !== 'number' ||
    !Number.isInteger(value.launch) ||
    typeof value.url !== 'string' ||
    !value.url.startsWith('/') ||
    value.url.startsWith('//') ||
    !value.url.endsWith(`/mystra/${value.id}/site/`) ||
    !Array.isArray(value.logs) ||
    !value.logs.every(item => typeof item === 'string')
  ) {
    throw new Error('The server returned an invalid MySTRA viewer session.');
  }
  return {
    id: value.id,
    path: value.path,
    state: value.state,
    message: value.message,
    launch: value.launch,
    url: value.url,
    logs: value.logs
  };
}

/** Format viewer service failures, keeping the HTTP status for callers. */
function mySTRAError(error: unknown): Error {
  return error instanceof RequestError
    ? error
    : new RequestError('MySTRA', error);
}

/** Start or reuse the CLI for the nearest local MyST project. */
export async function startMySTRA(
  settings: ServerConnection.ISettings,
  path: string
): Promise<IMySTRASession> {
  try {
    return mySTRASession(
      await requestAPI('mystra/sessions', settings, {
        method: 'POST',
        body: JSON.stringify({ path }),
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch (error) {
    throw mySTRAError(error);
  }
}

/** Read status and renew the viewer's lease. */
export async function readMySTRA(
  settings: ServerConnection.ISettings,
  id: string
): Promise<IMySTRASession> {
  try {
    return mySTRASession(
      await requestAPI(`mystra/sessions/${encodeURIComponent(id)}`, settings)
    );
  } catch (error) {
    throw mySTRAError(error);
  }
}

/** Explicitly stop a project's process group; expired sessions are already stopped. */
export async function stopMySTRA(
  settings: ServerConnection.ISettings,
  id: string
): Promise<void> {
  try {
    await requestAPI(`mystra/sessions/${encodeURIComponent(id)}`, settings, {
      method: 'DELETE'
    });
  } catch (error) {
    throw mySTRAError(error);
  }
}
