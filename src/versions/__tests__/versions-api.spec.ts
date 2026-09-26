import { ServerConnection } from '@jupyterlab/services';
import {
  isOutputVersion,
  absentReason,
  listVersions,
  versionContentUrl
} from '../versions-api';
import { forgetVersions, listVersionsCached } from '../version-cache';

const settings = ServerConnection.makeSettings({
  baseUrl: 'http://localhost:8888/lab/'
});

const version = {
  commit: 'a889877'.padEnd(40, '0'),
  short: 'a889877',
  time: '2026-09-20T10:00:00Z',
  subject: 'materialize hubble_diagram',
  size: 208410,
  present: true,
  annex: null,
  manifest: { schema_version: 1, output_id: 'hubble_diagram' }
};

beforeEach(() => {
  jest.restoreAllMocks();
  forgetVersions(settings, 'project/astra.yaml', 'baseline', 'hubble_diagram');
});

test('narrows a version listing and rejects malformed entries', () => {
  expect(isOutputVersion(version)).toBe(true);
  expect(
    isOutputVersion({
      ...version,
      size: null,
      manifest: null
    })
  ).toBe(true);
  expect(
    isOutputVersion({
      ...version,
      present: false,
      annex: { key: 'SHA256E-s1--a.png', here: false, remotes: ['lab-store'] }
    })
  ).toBe(true);
  expect(isOutputVersion({ ...version, annex: { key: 1 } })).toBe(false);
  for (const bad of [
    null,
    { ...version, commit: 7 },
    { ...version, present: 'yes' },
    { ...version, manifest: [] },
    { ...version, size: '1' }
  ])
    expect(isOutputVersion(bad)).toBe(false);
});

test('lists versions through the authenticated API with the output identity', async () => {
  const request = jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
    new Response(
      JSON.stringify({
        file: 'results/baseline/hubble_diagram.png',
        annex: 'initialized',
        versions: [version]
      })
    )
  );
  const listing = await listVersions(
    settings,
    'project/astra.yaml',
    'baseline',
    'hubble_diagram'
  );
  expect(listing.file).toBe('results/baseline/hubble_diagram.png');
  expect(listing.annex).toBe('initialized');
  expect(listing.versions).toEqual([version]);
  const url = new URL(request.mock.calls[0][0]);
  expect(url.pathname).toBe('/lab/jupyterlab_lightcone/api/versions');
  expect(url.searchParams.get('path')).toBe('project/astra.yaml');
  expect(url.searchParams.get('universe')).toBe('baseline');
  expect(url.searchParams.get('output')).toBe('hubble_diagram');
});

test('reports invalid payloads and server failures with their status', async () => {
  jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockResolvedValueOnce(new Response(JSON.stringify({ versions: [{}] })));
  await expect(
    listVersions(settings, 'project/astra.yaml', 'baseline', 'hubble_diagram')
  ).rejects.toThrow('invalid version listing');
  jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValueOnce(
    new Response(JSON.stringify({ message: 'Invalid output identity' }), {
      status: 400
    })
  );
  await expect(
    listVersions(settings, 'project/astra.yaml', 'baseline', 'bad.id')
  ).rejects.toThrow('Versions request failed (400)');
});

test('builds immutable content URLs', () => {
  const url = versionContentUrl(
    settings,
    'project/astra.yaml',
    'baseline',
    'hubble_diagram',
    version.commit
  );
  const parsed = new URL(url);
  expect(parsed.pathname).toBe(
    '/lab/jupyterlab_lightcone/api/versions/content'
  );
  expect(parsed.searchParams.get('commit')).toBe(version.commit);
  expect(parsed.searchParams.get('output')).toBe('hubble_diagram');
});

test('shares one listing between callers for a while and never caches a failure', async () => {
  // A Response body reads once, so every call gets its own.
  const request = jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ file: 'f', annex: 'none', versions: [version] })
        )
    );
  const first = listVersionsCached(
    settings,
    'project/astra.yaml',
    'baseline',
    'hubble_diagram'
  );
  const second = listVersionsCached(
    settings,
    'project/astra.yaml',
    'baseline',
    'hubble_diagram'
  );
  expect(second).toBe(first);
  await first;
  expect(request).toHaveBeenCalledTimes(1);
  forgetVersions(settings, 'project/astra.yaml', 'baseline', 'hubble_diagram');
  await listVersionsCached(
    settings,
    'project/astra.yaml',
    'baseline',
    'hubble_diagram'
  );
  expect(request).toHaveBeenCalledTimes(2);
  request.mockImplementationOnce(async () => new Response('', { status: 500 }));
  await expect(
    listVersionsCached(settings, 'project/astra.yaml', 'baseline', 'other')
  ).rejects.toThrow();
  await listVersionsCached(settings, 'project/astra.yaml', 'baseline', 'other');
  expect(request).toHaveBeenCalledTimes(4);
});

test('says where absent bytes are', () => {
  const held = { ...version, present: false };
  expect(absentReason(held)).toBe(
    'The bytes of this version are not in this repository.'
  );
  expect(
    absentReason({
      ...held,
      annex: { key: 'k', here: false, remotes: [] }
    })
  ).toBe(
    'The bytes of this version are in git-annex but not in this repository.'
  );
  expect(
    absentReason({
      ...held,
      annex: { key: 'k', here: false, remotes: ['lab-store', 'archive'] }
    })
  ).toContain('lab-store, archive have a copy (git annex get)');
});
