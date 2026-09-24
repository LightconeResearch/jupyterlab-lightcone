import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ResolvedOutput } from '@astra-spec/sdk';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { ContentsManager, ServerConnection } from '@jupyterlab/services';
import { parseAstraCard, type IAstraCard } from '../../astra-mime-data';
import { cardVersionState, VersionedCard } from '../../astra-mime';
import type { ILoadedProjectData } from '../../project-data';
import { listVersionsCached } from '../version-cache';
import type { IOutputVersion } from '../versions-api';

jest.mock('../../element-widget', () => ({ useProject: jest.fn() }));
jest.mock('../../project-renderers', () => ({
  useProjectRenderers: jest.fn()
}));
jest.mock('../version-cache', () => ({ listVersionsCached: jest.fn() }));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const card = {
  version: 1,
  entrypoint: 'project/astra.yaml',
  target: 'outputs.figure',
  universeId: null
};

test('accepts an optional output version and normalizes its commit', () => {
  expect(parseAstraCard(card).outputVersion).toBeUndefined();
  expect(
    parseAstraCard({ ...card, outputVersion: { commit: 'A889877' } })
      .outputVersion
  ).toEqual({ commit: 'a889877' });
  expect(
    parseAstraCard({
      ...card,
      outputVersion: {
        commit: 'a'.repeat(40),
        key: 'SHA256E-s1--x.png',
        extra: 1
      }
    }).outputVersion
  ).toEqual({ commit: 'a'.repeat(40), key: 'SHA256E-s1--x.png' });
});

test.each([
  { commit: 'abc' },
  { commit: 'g'.repeat(7) },
  { commit: 'a'.repeat(41) },
  { key: 'x' },
  { commit: 'a'.repeat(7), key: '' },
  { commit: 'a'.repeat(7), key: 'has space' },
  { commit: 'a'.repeat(7), key: 'a/b' },
  'a889877',
  null
])('rejects a malformed output version: %j', outputVersion => {
  expect(() => parseAstraCard({ ...card, outputVersion })).toThrow();
});

function version(commit: string): IOutputVersion {
  return {
    commit,
    short: commit.slice(0, 7),
    time: '2026-09-20T10:00:00Z',
    subject: '',
    size: null,
    present: true,
    manifest: null
  };
}

test('tells a card whether its version is the latest', () => {
  const history = [version('c'.repeat(40)), version('b'.repeat(40))];
  expect(cardVersionState({ commit: 'c'.repeat(7) }, undefined)).toBe(
    'unknown'
  );
  expect(cardVersionState({ commit: 'c'.repeat(7) }, history)).toBe('latest');
  expect(cardVersionState({ commit: 'b'.repeat(40) }, history)).toBe(
    'superseded'
  );
  expect(cardVersionState({ commit: 'a'.repeat(7) }, history)).toBe('missing');
  expect(cardVersionState({ commit: 'a'.repeat(7) }, [])).toBe('missing');
});

describe('a version-pinned card', () => {
  const list = jest.mocked(listVersionsCached);
  const history = [version('c'.repeat(40)), version('b'.repeat(40))];
  const output = (canonicalPath = 'outputs.figure') =>
    ({
      kind: 'output',
      id: 'figure',
      canonicalPath,
      label: 'Figure',
      type: 'figure',
      format: 'png'
    }) as unknown as ResolvedOutput;
  const data = {
    document: { universe: { universeId: 'baseline', source: 'default' } },
    bindings: [],
    index: {
      analysisByRecordPath: new Map([
        ['outputs.figure', { canonicalPath: '$' }],
        ['checks.outputs.figure', { canonicalPath: 'checks' }]
      ])
    },
    papers: {}
  } as unknown as ILoadedProjectData;
  let contents: ContentsManager;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    list.mockReset();
    contents = new ContentsManager({
      serverSettings: ServerConnection.makeSettings({
        baseUrl: 'http://localhost:8888/lab/'
      })
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    contents.dispose();
  });

  async function show(commit: string, record = output()): Promise<void> {
    const app = {
      serviceManager: { contents }
    } as unknown as JupyterFrontEnd;
    const reference: IAstraCard = {
      version: 1,
      entrypoint: 'project/astra.yaml',
      target: record.canonicalPath,
      universeId: null,
      outputVersion: { commit }
    };
    await act(async () => {
      root.render(
        <VersionedCard
          app={app}
          reference={reference}
          version={{ commit }}
          data={data}
          output={record}
          renderArtifact={item => <p>current {item.id}</p>}
          renderPreview={render => (
            <div>{render(record, { compact: true })}</div>
          )}
          onOpen={jest.fn()}
        />
      );
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  test('shows the bytes of the version it was made from while newer ones exist', async () => {
    list.mockResolvedValue({
      file: 'results/baseline/figure.png',
      versions: history
    });
    await show('b'.repeat(7));
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(new URL(image!.src).searchParams.get('commit')).toBe('b'.repeat(40));
    expect(container.textContent).not.toContain('current figure');
    expect(container.querySelector('button')?.textContent).toBe(
      'Version bbbbbbb · newer available'
    );
  });

  test('shows the current artifact when its version is the newest or unknown', async () => {
    list.mockResolvedValue({
      file: 'results/baseline/figure.png',
      versions: history
    });
    await show('c'.repeat(40));
    expect(container.textContent).toContain('current figure');
    expect(container.textContent).toContain('latest');
    await show('a'.repeat(7));
    expect(container.textContent).toContain('current figure');
    expect(container.textContent).toContain('not in the current history');
    // A card whose history cannot be read, mounted afresh.
    act(() => root.unmount());
    root = createRoot(container);
    list.mockRejectedValue(new Error('offline'));
    await show('d'.repeat(7));
    expect(container.textContent).toContain('current figure');
    expect(container.querySelector('button')?.textContent).toBe(
      'Version ddddddd'
    );
  });

  test('outputs of nested analyses have no history to show', async () => {
    await show('b'.repeat(7), output('checks.outputs.figure'));
    expect(list).not.toHaveBeenCalled();
    expect(container.textContent).toContain('current figure');
  });
});
