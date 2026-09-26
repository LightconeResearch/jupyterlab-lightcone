import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import type { IDocumentManager } from '@jupyterlab/docmanager';
import {
  ContentsManager,
  ServerConnection,
  type Contents,
  type Event
} from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { fileModel } from '../../__tests__/project-fixtures';
import {
  SessionManager,
  isRecordTab,
  isUntitledSession,
  isSessionWidget,
  messagesTitle,
  trackedSession,
  type ISessionManagerOptions
} from '../session-manager';
import { listSessions } from '../sessions-api';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../sessions-api', () => ({
  listSessions: jest.fn(),
  fetchProjectAgent: jest.fn(async () => null)
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const agent = { username: 'jupyter-ai-personas::pkg::Persona' };
const human = { username: 'francois' };

interface IFakeMessage {
  id: string;
  body: string;
  sender: { username: string };
  metadata?: unknown;
  time: number;
}

class FakeInput {
  value = '';
  metadata: Record<string, unknown> = {};
  metadataChanged = new Signal<this, Record<string, unknown>>(this);
  send = jest.fn();
  focus = jest.fn();
  getMetadata(): Record<string, unknown> {
    return this.metadata;
  }
  updateMetadata(patch: Record<string, unknown>): void {
    this.metadata = { ...this.metadata, ...patch };
    this.metadataChanged.emit(this.metadata);
  }
}

class FakeModel {
  constructor(
    public name: string,
    readonly id = `id-${name}`,
    readonly ready = Promise.resolve(id)
  ) {}
  input = new FakeInput();
  messages: IFakeMessage[] = [];
  writers: { user: { username: string } }[] = [];
  writersChanged = new Signal<this, unknown>(this);
  messagesUpdated = new Signal<this, void>(this);
  messageChanged = new Signal<this, unknown>(this);
}

class FakePanel extends Widget {
  constructor(
    readonly model: FakeModel,
    readonly area: 'main' | 'sidebar' = 'main'
  ) {
    super();
    this.id = `panel-${model.name}`;
  }
}

function host(options: Partial<ISessionManagerOptions> = {}) {
  const commands = new CommandRegistry();
  const contents = new ContentsManager();
  const files = new Set(['p/astra.yaml', 'p/chats/plan.chat']);
  jest.spyOn(contents, 'get').mockImplementation(async path => {
    if (!files.has(path)) {
      throw new ServerConnection.ResponseError(
        new Response('', { status: 404 })
      );
    }
    return fileModel('', { path });
  });
  const save = jest
    .spyOn(contents, 'save')
    .mockImplementation(async path => fileModel('', { path }));
  const panels: IChatPanel[] = [];
  const widgetAdded = new Signal<IChatTracker, IChatPanel>({} as IChatTracker);
  const tracker = {
    forEach: (fn: (panel: IChatPanel) => void) => panels.forEach(fn),
    find: (fn: (panel: IChatPanel) => boolean) => panels.find(fn),
    widgetAdded
  } as unknown as IChatTracker;
  const mainWidgets: Widget[] = [];
  const shell = {
    currentWidget: null as Widget | null,
    activateById: jest.fn(),
    widgets: (area?: string) => (area === 'main' ? mainWidgets : []).values(),
    disposed: new Signal<object, void>({})
  };
  const labShell = {
    currentChanged: new Signal<ILabShell, ILabShell.IChangedArgs>(
      {} as ILabShell
    )
  };
  const events = {
    stream: new Signal<Event.IManager, Event.Emission>({} as Event.IManager)
  };
  const chatCommands = { onSubmit: jest.fn().mockResolvedValue(undefined) };
  const created: { path: string; name: string }[] = [];
  const opened: unknown[] = [];
  commands.addCommand('jupyterlab-chat:create', {
    execute: args => {
      const path = args.path as string;
      const name = args.name as string;
      created.push({ path, name });
      return `${path}/${name}.chat`;
    }
  });
  /** The document manager opens the chat document; the tracker learns of it. */
  const documents = {
    openOrReveal: jest.fn(
      (
        path: string,
        factory?: string,
        _kernel?: unknown,
        options?: unknown
      ) => {
        opened.push({ path, factory, options });
        const panel = new FakePanel(new FakeModel(path));
        panels.push(panel as unknown as IChatPanel);
        mainWidgets.push(panel);
        widgetAdded.emit(panel as unknown as IChatPanel);
        return panel;
      }
    )
  } as unknown as IDocumentManager;
  const manager = new SessionManager({
    commands,
    shell: shell as unknown as JupyterFrontEnd.IShell,
    contents,
    documents,
    tracker,
    labShell: labShell as unknown as ILabShell,
    translator: undefined,
    ...options
  });
  const addPanel = (
    name: string,
    area: 'main' | 'sidebar' = 'main',
    ready?: Promise<string>
  ) => {
    const model = ready
      ? new FakeModel(name, `id-${name}`, ready)
      : new FakeModel(name);
    const panel = new FakePanel(model, area);
    panels.push(panel as unknown as IChatPanel);
    if (area === 'main') {
      mainWidgets.push(panel);
    }
    widgetAdded.emit(panel as unknown as IChatPanel);
    return panel;
  };
  // The manager listens to the real signal; tests emit through it directly.
  const fileChanged = contents.fileChanged as Signal<
    ContentsManager,
    Contents.IChangedArgs
  >;
  const emitFileChange = (change: Contents.IChangedArgs) =>
    fileChanged.emit(change);
  return {
    manager,
    commands,
    contents,
    save,
    documents,
    files,
    tracker,
    shell,
    labShell,
    events,
    chatCommands,
    created,
    opened,
    panels,
    mainWidgets,
    addPanel,
    emitFileChange,
    dispose: () => {
      manager.dispose();
      contents.dispose();
    }
  };
}

beforeEach(() => {
  jest.mocked(listSessions).mockReset();
  jest.mocked(listSessions).mockResolvedValue({
    directory: 'p/chats',
    sessions: [
      {
        path: 'p/chats/plan.chat',
        title: 'Plan',
        modified: '2026-09-23T10:00:00Z',
        messages: 2,
        lastAgent: null
      }
    ]
  });
});

/** A record tab, as `element-widget.tsx` marks them. */
function recordTab(id: string): Widget {
  const record = new Widget();
  record.id = id;
  record.title.dataset = { 'lightcone-element': id };
  return record;
}

describe('type guards', () => {
  it('recognizes main-area chat panels and record tabs', () => {
    const main = new FakePanel(new FakeModel('a.chat'));
    const side = new FakePanel(new FakeModel('b.chat'), 'sidebar');
    const plain = new Widget();
    expect(isSessionWidget(main)).toBe(true);
    expect(isSessionWidget(side)).toBe(false);
    expect(isSessionWidget(plain)).toBe(false);
    expect(isSessionWidget(null)).toBe(false);
    expect(isRecordTab(recordTab('x'))).toBe(true);
    expect(isRecordTab(main)).toBe(false);
  });

  it('asks the tracker which shell widget is a session', () => {
    const main = new FakePanel(new FakeModel('a.chat'));
    const side = new FakePanel(new FakeModel('b.chat'), 'sidebar');
    const tracker = {
      find: (test: (panel: IChatPanel) => boolean) =>
        ([main, side] as unknown as IChatPanel[]).find(test)
    } as unknown as IChatTracker;
    expect(trackedSession(tracker, main)).toBe(main);
    expect(trackedSession(tracker, side)).toBeUndefined();
    expect(trackedSession(tracker, new Widget())).toBeUndefined();
    expect(trackedSession(tracker, null)).toBeUndefined();
    expect(trackedSession(null, main)).toBeUndefined();
  });
});

describe('SessionManager.createAndOpen', () => {
  it('creates a named document in the project and leaves a draft unsent', async () => {
    const h = host();
    try {
      await expect(
        h.manager.createAndOpen('p/astra.yaml', {
          title: 'Plan',
          draft: 'How should we proceed?'
        })
      ).resolves.toBe('p/chats/plan-2.chat');
      expect(h.created).toEqual([{ path: 'p/chats', name: 'plan-2' }]);
      expect(h.save).toHaveBeenCalledWith('p/chats', { type: 'directory' });
      const panel = h.panels[0];
      expect(panel.model.input.value).toBe('How should we proceed?');
      expect(panel.model.input.send).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
});

describe('SessionManager.openSession', () => {
  it('activates an open session and joins the session group from a record tab', async () => {
    const h = host();
    try {
      const session = h.addPanel('p/chats/plan.chat');
      h.shell.currentWidget = session;
      h.labShell.currentChanged.emit({ oldValue: null, newValue: session });
      await h.manager.openSession('p/chats/plan.chat');
      expect(h.shell.activateById).toHaveBeenCalledWith(session.id);
      expect(session.model.input.focus).toHaveBeenCalled();
      expect(h.opened).toEqual([]);

      h.shell.currentWidget = recordTab('record');
      await h.manager.openSession('p/chats/other.chat');
      expect(h.opened[0]).toMatchObject({
        options: { mode: 'tab-after', ref: session.id }
      });
    } finally {
      h.dispose();
    }
  });

  it('opens the first session left of a result instead of among the results', async () => {
    const h = host();
    try {
      h.shell.currentWidget = recordTab('record');
      await h.manager.openSession('p/chats/plan.chat');
      expect(h.opened).toEqual([
        {
          path: 'p/chats/plan.chat',
          factory: 'Chat',
          options: { mode: 'split-left', ref: 'record', activate: true }
        }
      ]);

      // A closed session no longer anchors new ones.
      const first = h.panels[0] as unknown as FakePanel;
      first.dispose();
      h.panels.splice(0, 1);
      h.mainWidgets.splice(h.mainWidgets.indexOf(first), 1);
      await h.manager.openSession('p/chats/other.chat');
      expect(h.opened[1]).toMatchObject({
        options: { mode: 'split-left', ref: 'record' }
      });
    } finally {
      h.dispose();
    }
  });
});

describe('naming a session after its first message', () => {
  /** Rename in the fake contents and announce it, as the contents manager does. */
  const announceRenames = (h: ReturnType<typeof host>) =>
    jest.spyOn(h.contents, 'rename').mockImplementation(async (from, to) => {
      const renamed = fileModel('', { path: to });
      h.emitFileChange({
        type: 'rename',
        oldValue: fileModel('', { path: from }),
        newValue: renamed
      });
      return renamed;
    });

  it('names successive sessions that reuse the untitled path', async () => {
    const h = host();
    const rename = announceRenames(h);
    try {
      for (const body of ['First question', 'Second question']) {
        const session = h.addPanel('p/chats/untitled.chat');
        await flush();
        session.model.messages = [{ id: body, body, sender: human, time: 1 }];
        session.model.messagesUpdated.emit();
        await flush();
      }
      expect(rename.mock.calls).toEqual([
        ['p/chats/untitled.chat', 'p/chats/first-question.chat'],
        ['p/chats/untitled.chat', 'p/chats/second-question.chat']
      ]);
    } finally {
      h.dispose();
    }
  });

  it('retries a failed rename and suppresses concurrent attempts', async () => {
    const h = host();
    const attempt = new PromiseDelegate<Contents.IModel>();
    const rename = jest
      .spyOn(h.contents, 'rename')
      .mockReturnValueOnce(attempt.promise)
      .mockImplementation(async (_from, to) => fileModel('', { path: to }));
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const session = h.addPanel('p/chats/untitled.chat');
      await flush();
      session.model.messages = [
        { id: '1', body: 'Question', sender: human, time: 1 }
      ];
      session.model.messagesUpdated.emit();
      await flush();
      session.model.messagesUpdated.emit();
      await flush();
      expect(rename).toHaveBeenCalledTimes(1);
      attempt.reject(new Error('offline'));
      await flush();
      session.model.messagesUpdated.emit();
      await flush();
      expect(rename).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
      h.dispose();
    }
  });

  it('renames an untitled session once, when its first message arrives while open', async () => {
    const h = host();
    const rename = announceRenames(h);
    try {
      const fresh = h.addPanel('p/chats/untitled.chat');
      await flush();
      expect(rename).not.toHaveBeenCalled();
      fresh.model.messages = [
        {
          id: '1',
          body: 'Plot the residuals\nagainst redshift',
          sender: human,
          time: 1
        }
      ];
      fresh.model.messagesUpdated.emit();
      await flush();
      expect(rename).toHaveBeenCalledWith(
        'p/chats/untitled.chat',
        'p/chats/plot-the-residuals.chat'
      );
      fresh.model.messagesUpdated.emit();
      await flush();
      expect(rename).toHaveBeenCalledTimes(1);

      // A chat that already had messages when it opened keeps its name, and
      // so does one outside chats/ or with a name of its own.
      const old = new Promise<string>(resolve =>
        setTimeout(() => resolve('id-old'), 0)
      );
      const loaded = h.addPanel('p/chats/untitled-2.chat', 'main', old);
      loaded.model.messages = [
        { id: '1', body: 'Earlier question', sender: human, time: 1 }
      ];
      const named = h.addPanel('p/chats/plan.chat');
      const loose = h.addPanel('p/untitled.chat');
      await flush();
      await flush();
      for (const panel of [loaded, named, loose]) {
        panel.model.messages = [
          { id: '2', body: 'Another question', sender: human, time: 2 }
        ];
        panel.model.messagesUpdated.emit();
      }
      await flush();
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      h.dispose();
    }
  });

  it('recognizes untitled sessions in a chats folder only', () => {
    expect(isUntitledSession('p/chats/untitled.chat')).toBe(true);
    expect(isUntitledSession('chats/untitled-3.chat')).toBe(true);
    expect(isUntitledSession('p/untitled.chat')).toBe(false);
    expect(isUntitledSession('p/chats/untitled-notes.chat')).toBe(false);
    expect(isUntitledSession('p/chats/plan.chat')).toBe(false);
  });
});

describe('SessionManager tab titles', () => {
  it('names a session tab after its first message and leaves the label alone', async () => {
    const h = host();
    try {
      const session = h.addPanel('p/chats/fit-the-model.chat');
      session.title.label = 'fit-the-model.chat';
      session.title.dataset = { type: 'document-title' };
      await flush();
      // Nobody wrote yet: the tab shows the file name.
      expect(session.title.dataset).toEqual({ type: 'document-title' });

      session.model.messages = [
        { id: '1', body: 'hello', sender: agent, time: 1 },
        {
          id: '2',
          body: '\n  Fit the model\nwith errors',
          sender: human,
          time: 2
        }
      ];
      session.model.messagesUpdated.emit();
      expect(session.title.dataset).toEqual({
        type: 'document-title',
        'lightcone-session-title': 'Fit the model'
      });
      // The label is the file name, which a document widget would rename to.
      expect(session.title.label).toBe('fit-the-model.chat');

      session.model.messages = [];
      session.model.messagesUpdated.emit();
      expect(session.title.dataset).toEqual({ type: 'document-title' });

      // A chat in Jupyter Chat's side panel keeps its own title.
      const side = h.addPanel('p/chats/side.chat', 'sidebar');
      side.model.messages = [{ id: '3', body: 'Side', sender: human, time: 3 }];
      side.model.messagesUpdated.emit();
      expect(side.title.dataset).toEqual({});
    } finally {
      h.dispose();
    }
  });

  it('titles messages like the server, skipping personas', () => {
    expect(messagesTitle([])).toBe('');
    expect(
      messagesTitle([
        { id: '1', body: 'Echo', sender: agent, time: 1 },
        { id: '2', body: '   ', sender: human, time: 2 },
        { id: '3', body: 'Plot residuals\nplease', sender: human, time: 3 }
      ] as never)
    ).toBe('Plot residuals');
  });
});

describe('SessionManager listings', () => {
  it('reuses recent listings, refreshes on chat file changes and reports differences', async () => {
    const h = host();
    try {
      const changes: string[] = [];
      h.manager.changed.connect((_, entrypoint) => changes.push(entrypoint));
      await h.manager.list('p/astra.yaml');
      await h.manager.list('p/astra.yaml');
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(1);

      h.emitFileChange({
        type: 'new',
        oldValue: null,
        newValue: fileModel('', { path: 'p/chats/new.chat' })
      });
      expect(changes).toEqual(['p/astra.yaml']);
      h.emitFileChange({
        type: 'new',
        oldValue: null,
        newValue: fileModel('', { path: 'elsewhere/new.chat' })
      });
      expect(changes).toEqual(['p/astra.yaml']);

      jest.mocked(listSessions).mockResolvedValueOnce({
        directory: 'p/chats',
        sessions: []
      });
      expect(await h.manager.list('p/astra.yaml')).toEqual([]);
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(2);
      expect(changes).toEqual(['p/astra.yaml', 'p/astra.yaml']);
    } finally {
      h.dispose();
    }
  });
});

describe('SessionManager polling', () => {
  it('refreshes listings someone asked for and forgets the ones nobody reads', async () => {
    jest.useFakeTimers();
    const h = host();
    try {
      const changes: string[] = [];
      h.manager.changed.connect((_, entrypoint) => changes.push(entrypoint));
      await h.manager.list('p/astra.yaml');
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(1);

      jest
        .mocked(listSessions)
        .mockResolvedValue({ directory: 'p/chats', sessions: [] });
      await jest.advanceTimersByTimeAsync(15000);
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(2);
      expect(changes).toEqual(['p/astra.yaml']);

      // The poll's own refreshes do not keep a listing alive: ten minutes
      // after the last request it stops refreshing it.
      await jest.advanceTimersByTimeAsync(11 * 60 * 1000);
      const calls = jest.mocked(listSessions).mock.calls.length;
      expect(calls).toBeLessThanOrEqual(2 + (10 * 60) / 15 + 1);
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(calls);

      // Asking again fetches afresh and resumes the refreshes.
      expect(await h.manager.list('p/astra.yaml')).toEqual([]);
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(calls + 1);
      await jest.advanceTimersByTimeAsync(15000);
      expect(jest.mocked(listSessions)).toHaveBeenCalledTimes(calls + 2);
    } finally {
      h.dispose();
      jest.useRealTimers();
    }
  });
});

describe('SessionManager focus', () => {
  it('returns the cursor to a session when closing a tab hands focus back', async () => {
    const h = host();
    try {
      const session = h.addPanel('p/chats/plan.chat');
      const result = new Widget();
      result.dispose();
      h.shell.currentWidget = session;
      h.labShell.currentChanged.emit({ oldValue: result, newValue: session });
      await flush();
      expect(h.shell.activateById).toHaveBeenCalledWith(session.id);
      expect(session.model.input.focus).toHaveBeenCalled();

      // A plain focus change does not steal the cursor.
      h.shell.activateById.mockClear();
      const other = new Widget();
      h.labShell.currentChanged.emit({ oldValue: other, newValue: session });
      await flush();
      expect(h.shell.activateById).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });
});
