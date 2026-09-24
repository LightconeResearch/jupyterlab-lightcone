import { ServerConnection } from '@jupyterlab/services';
import { listSessions } from '../sessions-api';

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
    const request = respond({
      directory: 'project/chats',
      sessions: [session]
    });
    await expect(listSessions(settings, 'project/astra.yaml')).resolves.toEqual(
      { directory: 'project/chats', sessions: [session] }
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
    respond({ directory: 'project/chats', sessions: [session, invalid] });
    await expect(listSessions(settings, 'project/astra.yaml')).rejects.toThrow(
      /Sessions request failed: The server returned an invalid session listing/
    );
  });

  it('rejects a listing without a directory or a session array', async () => {
    respond({ sessions: [] });
    await expect(listSessions(settings, 'project/astra.yaml')).rejects.toThrow(
      /invalid session listing/
    );
    respond({ directory: 'project/chats', sessions: {} });
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
