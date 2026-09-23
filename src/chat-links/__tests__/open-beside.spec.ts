import type { IChatPanel } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import { ServerConnection } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import type { ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { TabBar, Widget } from '@lumino/widgets';
import { BesideOpener } from '../open-beside';

/** A main-area layout: which tab area holds each widget. */
function layout() {
  const bars = new Map<Widget, TabBar<Widget>>();
  const main: Widget[] = [];
  const place = (widget: Widget, bar: TabBar<Widget>) => {
    bars.set(widget, bar);
    if (!main.includes(widget)) {
      main.push(widget);
    }
  };
  const labShell = {
    getMainAreaTabBar: (widget: Widget) => bars.get(widget) ?? null
  } as unknown as ILabShell;
  return { bars, main, place, labShell };
}

/** A session: a chat panel of `width` pixels. */
function session(area: 'main' | 'sidebar' = 'main', width = 640): IChatPanel {
  const panel = Object.assign(new Widget(), {
    model: { name: 'project/chats/a.chat' },
    area
  });
  panel.id = 'session-1';
  Object.defineProperty(panel.node, 'clientWidth', { value: width });
  return panel as unknown as IChatPanel;
}

function setup(options: { documents?: boolean; type?: string } = {}) {
  const { bars, main, place, labShell } = layout();
  const executed: [string, ReadonlyPartialJSONObject][] = [];
  const commands = new CommandRegistry();
  const opened = new Widget();
  opened.id = 'file-1';
  for (const command of ['filebrowser:go-to-path', 'docmanager:open']) {
    commands.addCommand(command, {
      execute: args => {
        executed.push([command, args]);
        return command === 'docmanager:open' ? opened : undefined;
      }
    });
  }
  const get = jest.fn(async (path: string) => ({
    path,
    type: options.type ?? 'file'
  }));
  const app = {
    commands,
    serviceManager: { contents: { get } },
    shell: { widgets: () => main[Symbol.iterator]() }
  } as unknown as JupyterFrontEnd;
  const openOrReveal = jest.fn(() => opened);
  const documents =
    options.documents === false
      ? null
      : ({ openOrReveal } as unknown as IDocumentManager);
  const opener = new BesideOpener(
    app,
    documents,
    labShell,
    nullTranslator.load('jupyterlab_lightcone')
  );
  return { opener, get, openOrReveal, executed, opened, bars, place };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('BesideOpener.placement', () => {
  it('leaves files from sidebar chats and closed sessions to JupyterLab', () => {
    const { opener } = setup();
    expect(opener.placement(undefined)).toEqual({ activate: true });
    expect(opener.placement(session('sidebar'))).toEqual({ activate: true });
    const closed = session();
    closed.dispose();
    expect(opener.placement(closed)).toEqual({ activate: true });
  });

  it('splits the first file beside a session, however narrow', () => {
    const { opener } = setup();
    for (const width of [0, 640, 1600]) {
      expect(opener.placement(session('main', width))).toEqual({
        mode: 'split-right',
        ref: 'session-1',
        activate: true
      });
    }
  });

  it('adds later files after the last file the session opened', async () => {
    const { opener, opened, place } = setup();
    const panel = session();
    const own = new TabBar<Widget>();
    place(panel, own);
    await opener.open('project/src/a.py', panel);
    place(opened, new TabBar<Widget>());
    expect(opener.placement(panel)).toEqual({
      mode: 'tab-after',
      ref: 'file-1',
      activate: true
    });

    // Dragged into the session's own tab area, it would cover the session.
    place(opened, own);
    expect(opener.placement(panel)).toMatchObject({ mode: 'split-right' });

    opened.dispose();
    expect(opener.placement(panel)).toMatchObject({ mode: 'split-right' });
  });

  it('joins the record tabs beside the session', () => {
    const { opener, place } = setup();
    const panel = session();
    const own = new TabBar<Widget>();
    place(panel, own);
    const beside = new Widget();
    beside.id = 'lightcone-element-2';
    const stacked = new Widget();
    stacked.id = 'lightcone-element-1';
    place(stacked, own);
    place(beside, new TabBar<Widget>());
    expect(opener.placement(panel)).toEqual({
      mode: 'tab-after',
      ref: 'lightcone-element-2',
      activate: true
    });
  });
});

describe('BesideOpener.open', () => {
  it('opens files beside the session through the document manager', async () => {
    const { opener, openOrReveal } = setup();
    const panel = session();
    await opener.open('project/src/a.py', panel);
    expect(openOrReveal).toHaveBeenCalledWith(
      'project/src/a.py',
      undefined,
      undefined,
      { mode: 'split-right', ref: 'session-1', activate: true }
    );
  });

  it('falls back to the docmanager command', async () => {
    const { opener, executed } = setup({ documents: false });
    await opener.open('project/src/a.py', session());
    expect(executed).toEqual([
      [
        'docmanager:open',
        {
          path: 'project/src/a.py',
          options: { mode: 'split-right', ref: 'session-1', activate: true }
        }
      ]
    ]);
  });

  it('reveals folders in the file browser', async () => {
    const { opener, executed, openOrReveal } = setup({ type: 'directory' });
    await opener.open('project/results', session());
    expect(executed).toEqual([
      ['filebrowser:go-to-path', { path: 'project/results' }]
    ]);
    expect(openOrReveal).not.toHaveBeenCalled();
  });

  it('reports a missing file instead of opening it', async () => {
    const { opener, get, openOrReveal } = setup();
    const warning = jest.spyOn(Notification, 'warning');
    get.mockRejectedValueOnce(
      new ServerConnection.ResponseError(new Response('', { status: 404 }))
    );
    await opener.open('project/x.md', session());
    expect(warning).toHaveBeenCalledWith('No file at project/x.md.', {
      autoClose: 4000
    });
    expect(openOrReveal).not.toHaveBeenCalled();
  });

  it('passes other failures on', async () => {
    const { opener, get } = setup();
    get.mockRejectedValueOnce(
      new ServerConnection.ResponseError(new Response('', { status: 500 }))
    );
    await expect(opener.open('project/x.md', session())).rejects.toBeInstanceOf(
      ServerConnection.ResponseError
    );
  });
});
