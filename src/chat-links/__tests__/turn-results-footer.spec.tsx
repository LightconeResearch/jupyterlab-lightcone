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
import type { IRunRecord } from '../../runs/runs-api';
import { CHAT_PROJECT_METADATA } from '../chat-project';
import { cachedRuns } from '../runs-cache';
import {
  createTurnResultsFooter,
  TURN_SETTLE_DELAY,
  type ITurnResultsHost
} from '../turn-results-footer';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../../element-widget', () => ({
  useProject: () => ({
    data: undefined,
    error: undefined,
    fetchPaper: () => undefined
  })
}));
jest.mock('../runs-cache', () => ({
  ...jest.requireActual('../runs-cache'),
  cachedRuns: jest.fn()
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
function run(seconds: number, output = 'hubble_diagram'): IRunRecord {
  return {
    commit: `c${seconds}`,
    short: `c${seconds}`.slice(0, 7),
    time: new Date(seconds * 1000).toISOString(),
    output,
    universe: 'baseline',
    exit: 0,
    cmd: 'lc materialize',
    inputs: [],
    outputs: []
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
  constructor(
    readonly messages: IMessageContent[],
    metadata: Record<string, unknown> = {}
  ) {
    const map = new Map(Object.entries(metadata));
    this.sharedModel = { ydoc: { getMap: () => map } };
  }
  readonly name = 'project/chats/a.chat';
  readonly sharedModel: { ydoc: { getMap: () => Map<string, unknown> } };
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  jest.mocked(cachedRuns).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

function setup(
  chat: FakeChat,
  runs: IRunRecord[][] = [[run(1020)]],
  project: IProjectRoot | null = PROJECT
) {
  for (const listing of runs) {
    jest.mocked(cachedRuns).mockResolvedValueOnce({ runs: listing, jobs: [] });
  }
  jest
    .mocked(cachedRuns)
    .mockResolvedValue({ runs: runs[runs.length - 1], jobs: [] });
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
  return { render, executed, panel, resolveProject, openFile };
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

it('lists what the reply materialized and edited under its last message', async () => {
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1050, AGENT, EDITS)
  ]);
  const { render, executed, panel, openFile } = setup(chat);
  await render('a1');
  await flush();

  expect(heading()).toEqual([
    'Materialized during this reply · 1',
    'Files edited · 2'
  ]);
  const tile = container.querySelector<HTMLButtonElement>(
    '.jp-jupyterlab-lightcone-TurnResults-tile'
  )!;
  expect(tile.textContent).toContain('hubble_diagram');
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
        pinned: false
      }
    ],
    [
      CommandIDs.openElement,
      {
        entrypoint: PROJECT.entrypoint,
        target: 'outputs.hubble_diagram',
        universeId: 'baseline',
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

it('resolves the project the server recorded in the chat', async () => {
  const chat = new FakeChat(
    [message('u1', 1000, USER), message('a1', 1050, AGENT)],
    { [CHAT_PROJECT_METADATA]: 'other/astra.yaml' }
  );
  const { render, resolveProject } = setup(chat);
  await render('a1');
  await flush();
  expect(resolveProject).toHaveBeenCalledWith(
    'project/chats/a.chat',
    'other/astra.yaml'
  );
});

it('follows the end of a reply that is still streaming, listing runs once it settles', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  const chat = new FakeChat([
    message('u1', 1000, USER),
    message('a1', 1010, AGENT)
  ]);
  // The first listing predates the run; the next one has it.
  const { render } = setup(chat, [[], [run(1030)]]);
  await render('a1');
  await flush();
  expect(cachedRuns).toHaveBeenCalledTimes(1);
  expect(jest.mocked(cachedRuns).mock.calls[0][2]).toBe(1010);
  expect(container.textContent).toBe('');

  // The agent keeps streaming after the run: every chunk moves the end.
  for (const time of [1040, 1041, 1042]) {
    act(() => chat.restamp('a1', time));
    await act(async () => {
      jest.advanceTimersByTime(TURN_SETTLE_DELAY / 2);
    });
  }
  expect(cachedRuns).toHaveBeenCalledTimes(1);

  await act(async () => {
    jest.advanceTimersByTime(TURN_SETTLE_DELAY);
  });
  await flush();
  expect(cachedRuns).toHaveBeenCalledTimes(2);
  expect(jest.mocked(cachedRuns).mock.calls[1][2]).toBe(1042);
  expect(heading()).toEqual(['Materialized during this reply · 1']);
});
