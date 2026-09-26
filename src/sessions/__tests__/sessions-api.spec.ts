import { ServerConnection } from '@jupyterlab/services';
import { fetchChatProject, listSessions } from '../sessions-api';

jest.mock('../../pdf-runtime', () => ({}));

const settings = ServerConnection.makeSettings({
  baseUrl: 'https://example.org/user/researcher/'
});

const session = {
  path: 'project/chats/hubble.chat',
  title: 'Plot the Hubble diagram',
  modified: '2026-09-23T10:00:00+00:00',
  messages: 2,
  lastAgent: null,
  activity: 'working'
};

function respond(body: unknown, status = 200) {
  return jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status })
    );
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('listSessions', () => {
  it('asks the chat-sessions route for the project and returns the listing', async () => {
    const unread = { ...session, messages: null };
    const request = respond({ sessions: [session, unread] });
    await expect(listSessions(settings, 'project/astra.yaml')).resolves.toEqual(
      { sessions: [session, unread] }
    );
    const url = new URL(request.mock.calls[0][0]);
    expect(url.pathname).toBe(
      '/user/researcher/jupyterlab_lightcone/api/chat-sessions'
    );
    expect(url.searchParams.get('path')).toBe('project/astra.yaml');
    expect(request.mock.calls[0][1].method ?? 'GET').toBe('GET');
  });

  it.each([
    ['an unknown activity', { ...session, activity: 'busy' }],
    ['a numeric agent', { ...session, lastAgent: 5 }],
    ['a missing title', { ...session, title: undefined }],
    ['a textual message count', { ...session, messages: '2' }]
  ])('rejects a session with %s', async (_label, invalid) => {
    respond({ sessions: [session, invalid] });
    await expect(listSessions(settings, 'project/astra.yaml')).rejects.toThrow(
      /Sessions request failed: The server returned an invalid session listing/
    );
  });

  it('rejects a listing without a session array', async () => {
    respond({ directory: 'project/chats' });
    await expect(listSessions(settings, 'project/astra.yaml')).rejects.toThrow(
      /invalid session listing/
    );
    respond({ sessions: {} });
    await expect(listSessions(settings, 'project/astra.yaml')).rejects.toThrow(
      /invalid session listing/
    );
  });

  it('reports the status of a failed request without server HTML', async () => {
    jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
      new Response('<!DOCTYPE html><html><body>trace</body></html>', {
        status: 404
      })
    );
    const failure = await listSessions(settings, 'gone/astra.yaml').catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/Sessions request failed \(404\)/);
    expect(String(failure)).not.toContain('trace');
  });
});

describe('fetchChatProject', () => {
  it('asks the chat-project route for a chat and returns its entrypoint', async () => {
    const request = respond({ entrypoint: 'project/astra.yaml' });
    await expect(fetchChatProject(settings, 'loose/talk.chat')).resolves.toBe(
      'project/astra.yaml'
    );
    const url = new URL(request.mock.calls[0][0]);
    expect(url.pathname).toBe(
      '/user/researcher/jupyterlab_lightcone/api/chat-project'
    );
    expect(url.searchParams.get('path')).toBe('loose/talk.chat');
    respond({ entrypoint: null });
    await expect(fetchChatProject(settings, 'loose/talk.chat')).resolves.toBe(
      null
    );
  });

  it('rejects an answer without an entrypoint', async () => {
    respond({ project: 'project/astra.yaml' });
    await expect(fetchChatProject(settings, 'loose/talk.chat')).rejects.toThrow(
      /Chat project request failed: The server returned an invalid chat project/
    );
  });
});
