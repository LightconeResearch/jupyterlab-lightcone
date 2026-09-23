import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnalysisIndex, ResolvedOutput } from '@astra-spec/sdk';
import { ContentsManager } from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { resolveOutputCode } from '../../code-access';
import { JupyterOutputProvenance } from '../../output-provenance';
import { listSessions } from '../../sessions/sessions-api';
import type { IOutputVersion } from '../versions-api';

jest.mock('../../api', () => ({
  ...jest.requireActual<typeof import('../../api')>('../../api'),
  fetchRunRecord: jest.fn(async () => null)
}));
jest.mock('../../code-access', () => ({
  resolveOutputCode: jest.fn(async () => undefined)
}));
jest.mock('../../sessions/sessions-api', () => ({
  listSessions: jest.fn()
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
  key: null,
  size: null,
  present: true,
  run: { cmd: 'uv run fit.py', exit: 0, inputs: [], outputs: [] },
  manifest: null
};

let container: HTMLDivElement;
let root: Root;
let contents: ContentsManager;

beforeEach(() => {
  contents = new ContentsManager();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  jest.mocked(listSessions).mockResolvedValue({
    directory: 'project/chats',
    sessions: [
      {
        path: 'project/chats/hubble.chat',
        title: 'Hubble diagram',
        modified: '2026-09-20T10:05:00Z',
        messages: 4,
        lastAgent: null,
        activity: 'idle'
      }
    ]
  });
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

async function showConversation(commands: CommandRegistry): Promise<void> {
  await act(async () => {
    root.render(
      <JupyterOutputProvenance
        contents={contents}
        entrypoint="project/astra.yaml"
        index={index}
        universe="baseline"
        output={output}
        status={undefined}
        version={version}
        commands={commands}
      />
    );
  });
  await act(async () => button('Conversation').click());
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

test('a session found around the run opens through the sessions service', async () => {
  const commands = new CommandRegistry();
  const openSession = jest.fn();
  const openDocument = jest.fn();
  commands.addCommand('jupyterlab_lightcone:open-session', {
    execute: openSession
  });
  commands.addCommand('docmanager:open', { execute: openDocument });
  await showConversation(commands);
  await act(async () => button('Hubble diagram').click());
  expect(openSession).toHaveBeenCalledWith({
    path: 'project/chats/hubble.chat'
  });
  expect(openDocument).not.toHaveBeenCalled();
});

test('without the sessions plugin, sessions are listed but not linked', async () => {
  await showConversation(new CommandRegistry());
  expect(container.textContent).toContain('Hubble diagram');
  expect(() => button('Hubble diagram')).toThrow();
});

test('the Code tab locates the script from the recipe, not the worker command', async () => {
  const resolve = jest.mocked(resolveOutputCode);
  resolve.mockClear();
  resolve.mockResolvedValue({
    relativePath: 'src/fit.py',
    source: 'recorded run'
  });
  const recorded: IOutputVersion = {
    ...version,
    run: {
      cmd: 'uv run -- python -m lightcone.engine.worker baseline/fit',
      exit: 0,
      inputs: [],
      outputs: []
    },
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
        commands={new CommandRegistry()}
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
