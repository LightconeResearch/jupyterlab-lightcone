import type {
  IChatModel,
  IChatPanel,
  IChatTracker,
  IMessageContent
} from '@jupyter/chat';
import type { JupyterFrontEnd } from '@jupyterlab/application';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommandIDs } from '../../commands';
import type { IProjectRoot } from '../../project-root';
import type { IResultsCommit } from '../../versions/versions-api';
import { useProject } from '../../project-data-hooks';
import { listVersionsCached } from '../../versions/version-cache';
import type { ILoadedProjectData } from '../../project-data';
import { ResultsHistoryCache } from '../results-cache';
import {
  createTurnResultsFooter,
  TURN_SETTLE_DELAY,
  type ITurnResultsHost
} from '../turn-results-footer';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../versions/version-cache', () => ({
  listVersionsCached: jest.fn()
}));
jest.mock('../../project-data-hooks', () => ({
  useProject: jest.fn(() => ({
    data: undefined,
    error: undefined,
    fetchPaper: () => undefined
  }))
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = '/srv/lab';
const PROJECT: IProjectRoot = {
  path: 'project',
  entrypoint: 'project/astra.yaml'
};
const USER = { username: 'ada' };
const AGENT = { username: 'jupyter-ai-personas::lightcone::Agent', bot: true };

/** A materialization commit at `seconds` since the epoch. */
function run(seconds: number, output = 'hubble_diagram'): IResultsCommit {
  return {
    commit: `c${seconds}`,
    short: `c${seconds}`.slice(0, 7),
    time: new Date(seconds * 1000).toISOString(),
    subject: `materialize ${output} [baseline]`,
    outputs: [{ universe: 'baseline', output }]
  };
}

function message(
  id: string,
  time: number,
  sender: { username: string; bot?: boolean },
  metadata?: Record<string, unknown>
): IMessageContent {
  return {
    id,
    time,
    body: '',
    type: 'msg',
    sender,
    ...(metadata ? { metadata } : {})
  } as unknown as IMessageContent;
}

/** The part of a Jupyter Chat model the footer reads, with its signals. */
class FakeChat {
  constructor(readonly messages: IMessageContent[]) {}
  readonly name = 'project/chats/a.chat';
  readonly messagesUpdated = new Signal<this, void>(this);
  readonly messageChanged = new Signal<this, IMessageContent>(this);

  /** Restamp a message in place, as a streamed chunk does. */
  restamp(id: string, time: number): void {
    const found = this.messages.find(item => item.id === id)!;
    found.time = time;
    this.messageChanged.emit(found);
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.mocked(useProject).mockReturnValue({
    data: {
      document: {
        universe: {
          universeId: 'baseline',
          source: 'explicit',
          availableUniverseIds: ['baseline']
        }
      },
      index: { recordByPath: new Map() }
    } as unknown as ILoadedProjectData,
    error: undefined,
    fetchPaper: jest.fn()
  });
  jest.mocked(listVersionsCached).mockResolvedValue({
    file: 'results/baseline/hubble_diagram.png',
    annex: 'none',
    versions: []
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function setup(
  chat: FakeChat,
  runs: IResultsCommit[][] = [[run(1020)]],
  project: IProjectRoot | null = PROJECT
) {
  const results = new ResultsHistoryCache(ServerConnection.makeSettings());
  const get = jest.spyOn(results, 'get');
  for (const listing of runs) {
    get.mockResolvedValueOnce(listing);
  }
  get.mockResolvedValue(runs[runs.length - 1]);
  const executed: [string, ReadonlyPartialJSONObject][] = [];
  const commands = new CommandRegistry();
  commands.addCommand(CommandIDs.openElement, {
    execute: args => {
      executed.push([CommandIDs.openElement, args]);
    }
  });
  const panel = { model: chat } as unknown as IChatPanel;
  const resolveProject = jest.fn(async () => project ?? undefined);
  const openFile = jest.fn(async () => undefined);
  const host: ITurnResultsHost = {
    app: {
      commands,
      serviceManager: {
        serverSettings: ServerConnection.makeSettings(),
        contents: {}
      }
    } as unknown as JupyterFrontEnd,
    results,
    tracker: {
      find: (test: (candidate: IChatPanel) => boolean) => [panel].find(test)
    } as unknown as IChatTracker,
    trans: nullTranslator.load('jupyterlab_lightcone'),
    serverRoots: [ROOT],
    resolveProject,
    openFile
  };
  const Footer = createTurnResultsFooter(host);
  const render = async (messageId: string) => {
    const shown = chat.messages.find(item => item.id === messageId)!;
    await act(async () => {
      root.render(
        <Footer model={chat as unknown as IChatModel} message={shown} />
      );
    });
  };
  return { render, executed, panel, resolveProject, openFile, get };
}

/** Let resolved promises reach React. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) {
      await Promise.resolve();
    }
  });
}

function heading(): string[] {
  return Array.from(container.querySelectorAll('h4')).map(
    node => node.textContent ?? ''
  );
}

const EDITS = {
  tool_calls: [
    {
      diffs: [
        { path: `${ROOT}/project/src/a.py`, new_text: '' },
        { path: '/other/b.py', new_text: '' }
      ]
    }
  ]
};

it('lists results updated and files edited during the reply under its last message', async () => {
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1050, AGENT, EDITS)
  ]);
  const { render, executed, panel, openFile } = setup(chat);
  await render('a1');
  await flush();

  expect(heading()).toEqual([
    'Results updated during this reply · 1',
    'Files edited · 2'
  ]);
  const tile = container.querySelector<HTMLButtonElement>(
    '.jp-jupyterlab-lightcone-TurnResults-tile'
  )!;
  expect(tile.textContent).toContain('hubble_diagram');
  // The result is named after the inventory's output mark.
  expect(
    tile
      .querySelector(
        '.jp-jupyterlab-lightcone-TurnResults-label > .lightcone-brand.astra-ui > .astra-kind-glyph'
      )
      ?.getAttribute('data-kind')
  ).toBe('output');
  act(() => tile.click());
  act(() => {
    tile.dispatchEvent(
      new MouseEvent('auxclick', { bubbles: true, button: 1 })
    );
  });
  await flush();
  expect(executed).toEqual([
    [
      CommandIDs.openElement,
      {
        entrypoint: PROJECT.entrypoint,
        target: 'outputs.hubble_diagram',
        universeId: 'baseline',
        versionCommit: run(1020).commit,
        pinned: false
      }
    ],
    [
      CommandIDs.openElement,
      {
        entrypoint: PROJECT.entrypoint,
        target: 'outputs.hubble_diagram',
        universeId: 'baseline',
        versionCommit: run(1020).commit,
        pinned: true
      }
    ]
  ]);

  const file = container.querySelector<HTMLButtonElement>(
    '.jp-jupyterlab-lightcone-TurnResults-file'
  )!;
  expect(file.textContent).toBe('src/a.py');
  act(() => file.click());
  expect(openFile).toHaveBeenCalledWith('project/src/a.py', panel);
  // A file outside the server root is named, not opened.
  expect(
    container.querySelector('.jp-jupyterlab-lightcone-TurnResults-files span')
      ?.textContent
  ).toBe('/other/b.py');
});

it('shows nothing on messages that do not end a turn, or outside a project', async () => {
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1010, AGENT, EDITS),
    message('a2', 1050, AGENT)
  ]);
  const { render } = setup(chat);
  await render('u1');
  await flush();
  expect(container.textContent).toBe('');
  await render('a1');
  await flush();
  expect(container.textContent).toBe('');

  const unbound = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1050, AGENT, EDITS)
  ]);
  const outside = setup(unbound, [[run(1020)]], null);
  await outside.render('a1');
  await flush();
  expect(container.textContent).toBe('');
});

it('reads results from the server-resolved project without browser chat metadata', async () => {
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1050, AGENT)
  ]);
  const other = { path: 'other', entrypoint: 'other/astra.yaml' };
  const { render, resolveProject, get } = setup(chat, [[run(1020)]], other);
  await render('a1');
  await flush();
  expect(resolveProject).toHaveBeenCalledWith('project/chats/a.chat');
  expect(get).toHaveBeenCalledWith(other.entrypoint, 1050);
  expect(heading()).toEqual(['Results updated during this reply · 1']);
});

it('follows the end of a reply that is still streaming, listing runs once it settles', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1010, AGENT)
  ]);
  // The first listing predates the run; the next one has it.
  const { render, get } = setup(chat, [[], [run(1030)]]);
  await render('a1');
  await flush();
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0][1]).toBe(1010);
  expect(container.textContent).toBe('');

  // The agent keeps streaming after the run: every chunk moves the end.
  for (const time of [1040, 1041, 1042]) {
    act(() => chat.restamp('a1', time));
    await act(async () => {
      jest.advanceTimersByTime(TURN_SETTLE_DELAY / 2);
    });
  }
  expect(get).toHaveBeenCalledTimes(1);

  await act(async () => {
    jest.advanceTimersByTime(TURN_SETTLE_DELAY);
  });
  await flush();
  expect(get).toHaveBeenCalledTimes(2);
  expect(get.mock.calls[1][1]).toBe(1042);
  expect(heading()).toEqual(['Results updated during this reply · 1']);
});

it('shows the recorded result thumbnail and never substitutes newer bytes', async () => {
  const result = { ...run(1020), commit: 'a'.repeat(40), short: 'aaaaaaa' };
  const output = {
    kind: 'output',
    id: 'hubble_diagram',
    canonicalPath: 'outputs.hubble_diagram',
    label: 'Hubble diagram',
    type: 'figure',
    format: 'png'
  };
  const data = {
    document: {
      universe: {
        universeId: 'baseline',
        source: 'explicit',
        availableUniverseIds: ['baseline']
      }
    },
    index: { recordByPath: new Map([[output.canonicalPath, output]]) }
  } as unknown as ILoadedProjectData;
  jest
    .mocked(useProject)
    .mockReturnValue({ data, error: undefined, fetchPaper: jest.fn() });
  jest.mocked(listVersionsCached).mockResolvedValue({
    file: 'results/baseline/hubble_diagram.png',
    annex: 'none',
    versions: [
      {
        ...result,
        file: 'results/baseline/hubble_diagram.png',
        size: 3,
        present: true,
        annex: null,
        manifest: null
      }
    ]
  });
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1050, AGENT)
  ]);
  const { render } = setup(chat, [[result]]);
  await render('a1');
  await flush();
  const image = container.querySelector('img');
  expect(image).not.toBeNull();
  expect(new URL(image!.src).searchParams.get('commit')).toBe(result.commit);

  act(() => root.unmount());
  root = createRoot(container);
  jest.mocked(listVersionsCached).mockResolvedValue({
    file: 'results/baseline/hubble_diagram.png',
    annex: 'none',
    versions: []
  });
  await render('a1');
  await flush();
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('Hubble diagram');
});

it.each([true, false])(
  'opens the engine default with the correct SDK context (implicit: %s)',
  async implicit => {
    const result = {
      ...run(1020),
      outputs: [{ universe: 'default', output: 'figure' }]
    };
    const initial = {
      document: {
        universe: implicit
          ? { universeId: 'default', source: 'none', availableUniverseIds: [] }
          : {
              universeId: 'baseline',
              source: 'implicit',
              availableUniverseIds: ['baseline', 'default']
            }
      },
      index: { recordByPath: new Map() }
    } as unknown as ILoadedProjectData;
    jest.mocked(useProject).mockReturnValue({
      data: initial,
      error: undefined,
      fetchPaper: jest.fn()
    });
    const chat = new FakeChat([
      message('u1', 1000, USER),
      message('a1', 1050, AGENT)
    ]);
    const { render, executed } = setup(chat, [[result]]);
    await render('a1');
    await flush();
    const tile = container.querySelector<HTMLButtonElement>(
      '.jp-jupyterlab-lightcone-TurnResults-tile'
    )!;
    expect(tile.disabled).toBe(false);
    act(() => tile.click());
    await flush();
    expect(executed[0][1].universeId).toBe(implicit ? null : 'default');
    expect(executed[0][1].versionCommit).toBe(result.commit);
  }
);
