import type { ResolvedRecord } from '@astra-spec/sdk';
import type { Contents } from '@jupyterlab/services';
import { ServerConnection } from '@jupyterlab/services';
import type { ILoadedProjectData } from '../../project-data';
import { latestCardVersion } from '../card-version';
import { forgetVersions, listVersionsCached } from '../version-cache';
import type { IOutputVersion } from '../versions-api';

jest.mock('../version-cache', () => ({
  listVersionsCached: jest.fn(),
  forgetVersions: jest.fn()
}));

const listed = listVersionsCached as jest.MockedFunction<
  typeof listVersionsCached
>;

function version(commit: string, key: string | null): IOutputVersion {
  return {
    commit,
    short: commit.slice(0, 7),
    time: '2026-09-20T10:00:00Z',
    subject: '',
    key,
    size: null,
    present: true,
    run: null,
    manifest: null
  };
}

const settings = ServerConnection.makeSettings();

function contents(drive = ''): Contents.IManager {
  return {
    serverSettings: settings,
    driveName: () => drive
  } as unknown as Contents.IManager;
}

const output = {
  kind: 'output',
  id: 'figure',
  canonicalPath: 'outputs.figure'
} as unknown as ResolvedRecord;

function data(analysisPath = '$'): ILoadedProjectData {
  return {
    document: { universe: { universeId: 'baseline' } },
    index: {
      analysisByRecordPath: new Map([
        ['outputs.figure', { canonicalPath: analysisPath }]
      ])
    }
  } as unknown as ILoadedProjectData;
}

beforeEach(() => {
  listed.mockReset();
  (forgetVersions as jest.Mock).mockReset();
});

test('pins the newest committed version of a root output, freshly listed', async () => {
  listed.mockResolvedValue({
    file: 'results/baseline/figure.png',
    versions: [
      version('c'.repeat(40), 'SHA256E-s1--c.png'),
      version('b'.repeat(40), null)
    ]
  });
  await expect(
    latestCardVersion(contents(), 'p/astra.yaml', data(), output)
  ).resolves.toEqual({ commit: 'c'.repeat(40), key: 'SHA256E-s1--c.png' });
  expect(forgetVersions).toHaveBeenCalledWith(
    settings,
    'p/astra.yaml',
    'baseline',
    'figure'
  );
  listed.mockResolvedValue({
    file: 'results/baseline/figure.png',
    versions: [version('d'.repeat(40), null)]
  });
  await expect(
    latestCardVersion(contents(), 'p/astra.yaml', data(), output)
  ).resolves.toEqual({ commit: 'd'.repeat(40) });
});

test('pins nothing for other records, other drives, sub-analyses or no history', async () => {
  const decision = { kind: 'decision' } as unknown as ResolvedRecord;
  await expect(
    latestCardVersion(contents(), 'p/astra.yaml', data(), decision)
  ).resolves.toBeUndefined();
  await expect(
    latestCardVersion(contents('Drive'), 'Drive:p/astra.yaml', data(), output)
  ).resolves.toBeUndefined();
  await expect(
    latestCardVersion(contents(), 'p/astra.yaml', data('$.sub'), output)
  ).resolves.toBeUndefined();
  expect(listed).not.toHaveBeenCalled();
  listed.mockResolvedValue({ file: 'x', versions: [] });
  await expect(
    latestCardVersion(contents(), 'p/astra.yaml', data(), output)
  ).resolves.toBeUndefined();
  listed.mockRejectedValue(new Error('404'));
  await expect(
    latestCardVersion(contents(), 'p/astra.yaml', data(), output)
  ).resolves.toBeUndefined();
});
