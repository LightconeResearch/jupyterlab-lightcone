import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import type { IDocumentWidget } from '@jupyterlab/docregistry';
import { ContentsManager } from '@jupyterlab/services';
import { resolveOutputCode } from '../../code-access';
import { fetchRunRecord } from '../../api';
import { fetchRevisionSource } from '../versions-api';
import {
  JupyterOutputProvenance,
  provenanceSlot
} from '../../output-provenance';
import type { IOutputVersion } from '../versions-api';
import { withLightconeServer } from '../../__tests__/server-fixtures';

jest.mock('../../api', () => ({
  ...jest.requireActual<typeof import('../../api')>('../../api'),
  fetchRunRecord: jest.fn(async () => null)
}));
jest.mock('../../code-access', () => ({
  ...jest.requireActual<typeof import('../../code-access')>(
    '../../code-access'
  ),
  resolveOutputCode: jest.fn(async () => undefined)
}));

jest.mock('../versions-api', () => ({
  ...jest.requireActual<typeof import('../versions-api')>('../versions-api'),
  fetchRevisionSource: jest.fn(async () => ({
    file: 'src/fit.py',
    commit: 'c'.repeat(40),
    exists: true,
    text: 'print("historical")',
    binary: false,
    annexed: false,
    truncated: false
  }))
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const output = {
  kind: 'output',
  id: 'fit',
  canonicalPath: 'outputs.fit',
  label: 'Fit',
  type: 'figure',
  format: 'png'
} as unknown as ResolvedOutput;

const index = {
  analysisByRecordPath: new Map([['outputs.fit', { canonicalPath: '$' }]])
} as unknown as AnalysisIndex;

const version: IOutputVersion = {
  commit: 'c'.repeat(40),
  short: 'ccccccc',
  time: '2026-09-20T10:00:00Z',
  subject: '',
  size: null,
  present: true,
  annex: null,
  manifest: null
};

let container: HTMLDivElement;
let root: Root;
let contents: ContentsManager;

beforeEach(() => {
  jest.clearAllMocks();
  contents = new ContentsManager();
  jest.spyOn(contents, 'get').mockRejectedValue(new Error('No current file'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  contents.dispose();
});

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    item => item.textContent === name
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

test('the Code tab locates the script from the recipe, not the worker command', async () => {
  const resolve = jest.mocked(resolveOutputCode);
  resolve.mockClear();
  resolve.mockResolvedValue({
    relativePath: 'src/fit.py',
    source: 'recorded run'
  });
  const recorded: IOutputVersion = {
    ...version,
    manifest: { recipe: 'python src/fit.py --output results/baseline/fit.png' }
  };
  await act(async () => {
    root.render(
      <JupyterOutputProvenance
        contents={contents}
        entrypoint="project/astra.yaml"
        index={index}
        universe="baseline"
        output={output}
        status={undefined}
        version={recorded}
      />
    );
  });
  expect(resolve).toHaveBeenLastCalledWith(
    contents,
    'project/astra.yaml',
    index,
    output,
    'python src/fit.py --output results/baseline/fit.png'
  );
  await act(async () => button('Code').click());
  const panel = container.querySelector('[role="tabpanel"]')!;
  expect(panel.textContent).toContain('python src/fit.py --output');
  expect(panel.textContent).not.toContain('lightcone.engine.worker');
  expect(panel.textContent).toContain('src/fit.py');
});

test('the Code tab opens the current script through the document manager', async () => {
  jest.mocked(resolveOutputCode).mockResolvedValue({
    relativePath: 'src/fit.py',
    source: 'recorded run'
  });
  const openOrReveal = jest.fn(
    () => ({ id: 'opened' }) as unknown as IDocumentWidget
  );
  const beforeOpenDocument = jest.fn();
  await act(async () => {
    root.render(
      <JupyterOutputProvenance
        contents={contents}
        entrypoint="project/astra.yaml"
        index={index}
        universe="baseline"
        output={output}
        status={undefined}
        version={{ ...version, manifest: { recipe: 'python src/fit.py' } }}
        documents={{ openOrReveal }}
        beforeOpenDocument={beforeOpenDocument}
      />
    );
  });
  await act(async () => button('Code').click());
  await act(async () => button('Open current file').click());
  expect(openOrReveal).toHaveBeenCalledWith('project/src/fit.py', 'Editor');
  expect(beforeOpenDocument).toHaveBeenCalledTimes(1);
  expect(beforeOpenDocument.mock.invocationCallOrder[0]).toBeLessThan(
    openOrReveal.mock.invocationCallOrder[0]
  );
});

test('a deleted current script remains readable at its recorded revision', async () => {
  jest.mocked(resolveOutputCode).mockResolvedValue(undefined);
  const recorded = { ...version, manifest: { recipe: 'python src/fit.py' } };
  await act(async () => {
    root.render(
      <JupyterOutputProvenance
        contents={contents}
        entrypoint="project/astra.yaml"
        index={index}
        universe="baseline"
        output={output}
        status={undefined}
        version={recorded}
        documents={{ openOrReveal: jest.fn() }}
      />
    );
  });
  expect(fetchRunRecord).not.toHaveBeenCalled();
  await act(async () => button('Code').click());
  expect(fetchRevisionSource).toHaveBeenCalledWith(
    contents.serverSettings,
    'project/astra.yaml',
    version.commit,
    'src/fit.py'
  );
  expect(container.textContent).toContain('print("historical")');
  expect(container.textContent).not.toContain('Open current file');
  await act(async () => button('Changes since').click());
  expect(container.textContent).toContain(
    'The file no longer exists in the project.'
  );
});

describe('the provenance section', () => {
  const render = () => null;

  test('is left out of record views without Lightcone’s server', () => {
    expect(provenanceSlot(render)).toBeUndefined();
  });

  describe('with Lightcone’s server', () => {
    withLightconeServer();

    test('is shown in record views', () => {
      expect(provenanceSlot(render)).toBe(render);
    });
  });
});

describe('the current run record', () => {
  const current = () => (
    <JupyterOutputProvenance
      contents={contents}
      entrypoint="project/astra.yaml"
      index={index}
      universe="baseline"
      output={output}
      status={undefined}
    />
  );

  describe('with Lightcone’s server', () => {
    withLightconeServer();

    test('is read from the server', async () => {
      await act(async () => root.render(current()));
      expect(fetchRunRecord).toHaveBeenCalledWith(
        contents.serverSettings,
        'project/astra.yaml',
        'baseline',
        output,
        undefined
      );
      expect(container.textContent).toContain(
        'No run has been recorded for this output.'
      );
    });
  });
});
