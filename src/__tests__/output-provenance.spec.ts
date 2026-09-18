import type { ResolvedOutput } from '@astra-spec/sdk';
import { ServerConnection } from '@jupyterlab/services';
import { fetchRunRecord, parseRunRecord } from '../api';

const settings = ServerConnection.makeSettings();

beforeEach(() => {
  jest.restoreAllMocks();
});

const record = {
  schema_version: 1,
  finished_at: '2026-09-15T10:00:00Z',
  git_sha: 'abc123',
  recipe: 'python original.py',
  env_version: 'sha256:env',
  lc_version: '0.5',
  input_versions: { catalog: 'sha256:input' }
};

it('maps the recorded recipe and versions without substituting current definitions', () => {
  expect(parseRunRecord({ record })).toEqual({
    finishedAt: record.finished_at,
    gitRevision: record.git_sha,
    recipe: record.recipe,
    environment: record.env_version,
    cliVersion: record.lc_version,
    inputVersions: record.input_versions
  });
});

it('distinguishes no recorded run from an unsupported response', () => {
  expect(parseRunRecord({ record: null })).toBeNull();
  for (const payload of [
    null,
    {},
    { record: {} },
    { record: { ...record, schema_version: 2 } },
    { record: { ...record, input_versions: { catalog: {} } } }
  ]) {
    expect(() => parseRunRecord(payload)).toThrow('Unsupported run record');
  }
});

it('shares one read per output snapshot and status, and never reuses an older one', async () => {
  const request = jest
    .spyOn(ServerConnection, 'makeRequest')
    .mockImplementation(
      async () => new Response(JSON.stringify({ record: null }))
    );
  const output = { id: 'plot' } as unknown as ResolvedOutput;
  const read = (target: ResolvedOutput, detail: string) =>
    fetchRunRecord(settings, 'astra.yaml', 'default', target, {
      state: 'stale',
      detail
    });
  const reads = [
    read(output, 'never run'),
    read(output, 'never run'),
    // A status change or a refreshed output may follow a new run.
    read(output, 'recipe changed'),
    read({ ...output }, 'never run')
  ];
  expect(reads[1]).toBe(reads[0]);
  expect(await Promise.all(reads)).toEqual([null, null, null, null]);
  expect(request).toHaveBeenCalledTimes(3);
  expect(new URL(request.mock.calls[0][0]).searchParams.get('output')).toBe(
    'plot'
  );
  await read(output, 'never run');
  expect(request).toHaveBeenCalledTimes(4);
});

it('reports a failed read with its status instead of as a missing record', async () => {
  jest.spyOn(ServerConnection, 'makeRequest').mockResolvedValue(
    new Response(JSON.stringify({ message: 'Malformed run record' }), {
      status: 502
    })
  );
  await expect(
    fetchRunRecord(settings, 'astra.yaml', 'default', {
      id: 'plot'
    } as unknown as ResolvedOutput)
  ).rejects.toThrow('Provenance request failed (502)');
});
