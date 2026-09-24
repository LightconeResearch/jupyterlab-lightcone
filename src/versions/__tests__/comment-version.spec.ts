import { ContentsManager } from '@jupyterlab/services';
import { recordVersion } from '../../comments/comment-hosts';
import { listVersions, type IOutputVersion } from '../versions-api';

jest.mock('../../project-renderers', () => ({
  useProjectRenderers: jest.fn()
}));
jest.mock('../../project-data-service', () => ({
  acquireProjectDataService: () => ({
    service: {
      get: async () => ({
        document: { universe: { universeId: 'baseline' } },
        index: {
          recordByPath: new Map([
            ['outputs.fit', { kind: 'output', id: 'fit' }],
            ['decisions.model', { kind: 'decision', id: 'model' }]
          ])
        }
      })
    },
    release: () => undefined
  })
}));
jest.mock('../versions-api', () => ({
  ...jest.requireActual<typeof import('../versions-api')>('../versions-api'),
  listVersions: jest.fn()
}));

function version(commit: string): IOutputVersion {
  return {
    commit,
    short: commit.slice(0, 7),
    time: '2026-09-20T10:00:00Z',
    subject: '',
    size: 1,
    present: true,
    annex: {
      key: `SHA256E-s1--${commit.slice(0, 4)}.png`,
      here: true,
      remotes: []
    },
    manifest: null
  };
}

test('a comment is pinned to the version the record tab shows', async () => {
  jest.mocked(listVersions).mockResolvedValue({
    file: 'results/baseline/fit.png',
    annex: 'initialized',
    versions: [version('c'.repeat(40)), version('b'.repeat(40))]
  });
  const contents = new ContentsManager();
  const pin = (shown?: string) =>
    recordVersion(
      contents,
      contents.serverSettings,
      'project/astra.yaml',
      'outputs.fit',
      null,
      shown
    );
  try {
    await expect(pin('b'.repeat(7))).resolves.toEqual({
      commit: 'b'.repeat(40),
      key: 'SHA256E-s1--bbbb.png',
      hash: null,
      label: 'bbbbbbb'
    });
    // Following the newest version, or a version no longer listed, pins the newest.
    await expect(pin()).resolves.toMatchObject({ commit: 'c'.repeat(40) });
    await expect(pin('a'.repeat(7))).resolves.toMatchObject({
      commit: 'c'.repeat(40)
    });
  } finally {
    contents.dispose();
  }
});
