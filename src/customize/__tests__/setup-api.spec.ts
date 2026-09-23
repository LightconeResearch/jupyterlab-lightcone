import { ServerConnection } from '@jupyterlab/services';
import { fetchSetup, isSetupReport } from '../setup-api';

const settings = ServerConnection.makeSettings({
  baseUrl: 'https://example.org/user/researcher/'
});

const payload = {
  jupyterAi: true,
  agents: [
    {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      executable: { name: 'claude-agent-acp', found: false, path: null }
    }
  ],
  skills: [],
  tools: {
    uv: { found: true, path: '/usr/bin/uv', version: '0.8.0' },
    git: { found: true, path: '/usr/bin/git', version: null },
    'git-annex': { found: false, path: null, version: null },
    myst: { found: false, path: null, version: null }
  },
  sandbox: { backend: null, available: false },
  environment: null,
  instructions: null,
  storage: null
};

beforeEach(() => {
  jest.restoreAllMocks();
});

it('asks for the project setup on the configured server and validates it', async () => {
  const request = jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(async () => new Response(JSON.stringify(payload)));
  await expect(fetchSetup(settings, 'project/astra.yaml')).resolves.toEqual(
    payload
  );
  const url = new URL(request.mock.calls[0][0]);
  expect(url.pathname).toBe('/user/researcher/jupyterlab_lightcone/api/setup');
  expect(url.searchParams.get('path')).toBe('project/astra.yaml');
  await fetchSetup(settings);
  expect(new URL(request.mock.calls[1][0]).search).toBe('');
});

it('rejects a malformed report instead of rendering it', async () => {
  jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockResolvedValue(
      new Response(JSON.stringify({ ...payload, tools: { uv: {} } }))
    );
  await expect(fetchSetup(settings)).rejects.toThrow('invalid setup report');
  expect(isSetupReport(payload)).toBe(true);
  expect(isSetupReport({ ...payload, storage: { annex: true } })).toBe(false);
  expect(isSetupReport({ ...payload, skills: [{ harness: 'gemini' }] })).toBe(
    false
  );
});

it('reports a failed check with its status and without server HTML', async () => {
  jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
    new Response('<!DOCTYPE html><html><body>trace</body></html>', {
      status: 500
    })
  );
  const failure = await fetchSetup(settings).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain('Setup request failed (500)');
  expect(failure.message).not.toContain('<html');
  expect(failure.message).not.toContain('trace');
});
