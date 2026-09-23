import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { Notification } from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import {
  ContentsManager,
  ServerConnection,
  type Contents,
  type Event
} from '@jupyterlab/services';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { fileModel } from '../../__tests__/project-fixtures';
import {
  SessionManager,
  isRecordTab,
  isSessionWidget,
  personaMetadata,
  selectedPersona
} from '../session-manager';
import { listSessions, prepareSessions } from '../sessions-api';

jest.mock('../../pdf-runtime', () => ({}));
jest.mock('../sessions-api', () => ({
  listSessions: jest.fn(),
  prepareSessions: jest.fn()
}));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const agent = { username: 'jupyter-ai-personas::pkg::Persona' };
const human = { username: 'francois' };
const PERSONA_STATE =
  'https://schema.jupyter.org/jupyter_ai_persona_manager/persona_state/v1';

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
    readonly id = `id-${name}`
  ) {}
  input = new FakeInput();
  messages: IFakeMessage[] = [];
  writers: { user: { username: string } }[] = [];
  ready = Promise.resolve(this.id);
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

function host() {
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
  commands.addCommand('docmanager:open', {
    execute: args => {
      opened.push(args);
      const panel = new FakePanel(new FakeModel(args.path as string));
      panels.push(panel as unknown as IChatPanel);
      mainWidgets.push(panel);
      widgetAdded.emit(panel as unknown as IChatPanel);
      return panel;
    }
  });
  const manager = new SessionManager({
    commands,
    shell: shell as unknown as JupyterFrontEnd.IShell,
    contents,
    tracker,
    chatCommands: chatCommands as never,
    labShell: labShell as unknown as ILabShell,
    events: events as unknown as Event.IManager,
    translator: undefined
  });
  const addPanel = (name: string, area: 'main' | 'sidebar' = 'main') => {
    const panel = new FakePanel(new FakeModel(name), area);
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
    files,
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
  jest.mocked(prepareSessions).mockReset();
  jest.mocked(listSessions).mockReset();
  jest.mocked(prepareSessions).mockResolvedValue({ directory: 'p/chats' });
  jest.mocked(listSessions).mockResolvedValue({
    directory: 'p/chats',
    sessions: [
      {
        path: 'p/chats/plan.chat',
        title: 'Plan',
        modified: '2026-09-23T10:00:00Z',
        messages: 2,
        lastAgent: null,
        activity: 'idle'
      }
    ]
  });
  for (const notification of [...Notification.manager.notifications]) {
    Notification.manager.dismiss(notification.id);
  }
});

describe('type guards', () => {
  it('recognizes main-area chat panels and record tabs', () => {
    const main = new FakePanel(new FakeModel('a.chat'));
    const side = new FakePanel(new FakeModel('b.chat'), 'sidebar');
    const plain = new Widget();
    expect(isSessionWidget(main)).toBe(true);
    expect(isSessionWidget(side)).toBe(false);
    expect(isSessionWidget(plain)).toBe(false);
    expect(isSessionWidget(null)).toBe(false);
    plain.title.dataset = { 'lightcone-element': 'x' };
    expect(isRecordTab(plain)).toBe(true);
    expect(isRecordTab(main)).toBe(false);
  });

  it('reads and writes persona metadata like the composer', () => {
    expect(selectedPersona({ to_persona: 'p' })).toBe('p');
    expect(selectedPersona({ to_persona: null })).toBeNull();
    expect(selectedPersona({})).toBeNull();
    expect(personaMetadata('p')).toEqual({
      to_persona: 'p',
      model: { id: null, settings: {} },
      settings: {}
    });
  });
});

describe('SessionManager.createAndOpen', () => {
  it('names the chat from the first message, opens it beside the current work and sends', async () => {
    const h = host();
    try {
      const home = new Widget();
      home.id = 'home';
      h.shell.currentWidget = home;
      const pending = h.manager.createAndOpen('p/astra.yaml', {
        firstMessage: 'Plot the Hubble diagram\nwith error bars',
        persona: 'jupyter-ai-personas::pkg::Persona'
      });
      await flush();
      expect(h.created).toEqual([
        { path: 'p/chats', name: 'plot-the-hubble-diagram' }
      ]);
      expect(h.opened).toEqual([
        {
          path: 'p/chats/plot-the-hubble-diagram.chat',
          factory: 'Chat',
          options: { mode: 'tab-after', activate: true, ref: 'home' }
        }
      ]);
      const panel = h.panels[0] as unknown as FakePanel;
      // The persona picker stamps its default once its toolbar mounts.
      panel.model.input.updateMetadata({ to_persona: null });
      expect(await pending).toBe('p/chats/plot-the-hubble-diagram.chat');
      expect(panel.model.input.metadata).toEqual(
        personaMetadata('jupyter-ai-personas::pkg::Persona')
      );
      expect(h.chatCommands.onSubmit).toHaveBeenCalledWith(panel.model.input);
      expect(panel.model.input.send).toHaveBeenCalledWith(
        'Plot the Hubble diagram\nwith error bars'
      );
      expect(panel.model.input.focus).toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it('keeps the composer selection, avoids name collisions and skips sending without a message', async () => {
    const h = host();
    try {
      const pending = h.manager.createAndOpen('p/astra.yaml', {
        title: 'Plan',
        firstMessage: 'Continue the plan'
      });
      await flush();
      expect(h.created).toEqual([{ path: 'p/chats', name: 'plan-2' }]);
      const panel = h.panels[0] as unknown as FakePanel;
      panel.model.input.updateMetadata({ to_persona: 'default-persona' });
      await pending;
      expect(panel.model.input.metadata).toEqual({
        to_persona: 'default-persona'
      });
      expect(panel.model.input.send).toHaveBeenCalledWith('Continue the plan');
      expect(h.opened[0]).toMatchObject({
        options: { mode: 'tab-after', activate: true }
      });

      await h.manager.createAndOpen('p/astra.yaml');
      expect(h.created[1]).toEqual({ path: 'p/chats', name: 'untitled' });
      const empty = h.panels[1] as unknown as FakePanel;
      expect(empty.model.input.send).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it('leaves an unaddressed message in the composer with a warning', async () => {
    const h = host();
    jest.useFakeTimers();
    try {
      const pending = h.manager.createAndOpen('p/astra.yaml', {
        firstMessage: 'Hello'
      });
      await jest.advanceTimersByTimeAsync(10);
      const panel = h.panels[0] as unknown as FakePanel;
      panel.model.input.updateMetadata({ to_persona: null });
      await jest.advanceTimersByTimeAsync(6000);
      await pending;
      expect(panel.model.input.send).not.toHaveBeenCalled();
      expect(panel.model.input.value).toBe('Hello');
      expect(panel.model.input.focus).toHaveBeenCalled();
      expect(Notification.manager.notifications.map(item => item.type)).toEqual(
        ['warning']
      );
    } finally {
      jest.useRealTimers();
      h.dispose();
    }
  });

  it('falls back to the advertised default persona', async () => {
    const h = host();
    PageConfig.setOption('jupyter_ai_default_persona', 'advertised');
    jest.useFakeTimers();
    try {
      const pending = h.manager.createAndOpen('p/astra.yaml', {
        firstMessage: 'Hello'
      });
      await jest.advanceTimersByTimeAsync(10);
      const panel = h.panels[0] as unknown as FakePanel;
      // A metadata change without `to_persona`: the composer has not chosen.
      panel.model.input.metadataChanged.emit({});
      await jest.advanceTimersByTimeAsync(6000);
      await pending;
      expect(panel.model.input.metadata).toEqual(personaMetadata('advertised'));
      expect(panel.model.input.send).toHaveBeenCalledWith('Hello');
    } finally {
      jest.useRealTimers();
      PageConfig.setOption('jupyter_ai_default_persona', '');
      h.dispose();
    }
  });

  it('refuses without Jupyter Chat', async () => {
    const h = host();
    try {
      h.commands.addCommand('x', { execute: () => undefined });
      const bare = new SessionManager({
        commands: new CommandRegistry(),
        shell: h.shell as unknown as JupyterFrontEnd.IShell,
        contents: h.contents,
        tracker: null,
        chatCommands: null,
        labShell: null,
        events: null
      });
      await expect(bare.createAndOpen('p/astra.yaml')).rejects.toThrow(
        /Jupyter Chat is not available/
      );
      bare.dispose();
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

      const record = new Widget();
      record.id = 'record';
      record.title.dataset = { 'lightcone-element': record.id };
      h.shell.currentWidget = record;
      await h.manager.openSession('p/chats/other.chat');
      expect(h.opened[0]).toMatchObject({ options: { ref: session.id } });
    } finally {
      h.dispose();
    }
  });
});

describe('SessionManager activity', () => {
  it('merges live activity into listings, notifies when done and announces the project', async () => {
    const h = host();
    try {
      const changes: string[] = [];
      h.manager.changed.connect((_, entrypoint) => changes.push(entrypoint));
      const session = h.addPanel('p/chats/plan.chat');
      await flush();
      expect(h.manager.activity('p/chats/plan.chat')).toBe('idle');
      expect(changes).toEqual(['p/astra.yaml']);

      session.model.writers = [{ user: agent }];
      session.model.writersChanged.emit(undefined);
      expect(h.manager.activity('p/chats/plan.chat')).toBe('working');
      expect((await h.manager.list('p/astra.yaml'))[0].activity).toBe(
        'working'
      );

      session.model.writers = [];
      session.model.writersChanged.emit(undefined);
      await flush();
      expect(h.manager.activity('p/chats/plan.chat')).toBe('idle');
      const finished = Notification.manager.notifications;
      expect(finished.map(item => [item.type, item.message])).toEqual([
        ['info', 'Plan finished']
      ]);
      // The action reopens the session.
      finished[0].options.actions?.[0].callback(new MouseEvent('click'));
      await flush();
      expect(h.shell.activateById).toHaveBeenCalledWith(session.id);

      // A persona reporting processing on the event stream also counts.
      h.events.stream.emit({
        schema_id: PERSONA_STATE,
        version: '1',
        chat_id: session.model.id,
        persona_id: 'p',
        processing: true
      });
      expect(h.manager.activity('p/chats/plan.chat')).toBe('working');
      h.events.stream.emit({
        schema_id: PERSONA_STATE,
        version: '1',
        chat_id: session.model.id,
        persona_id: 'p',
        processing: false
      });
      expect(h.manager.activity('p/chats/plan.chat')).toBe('idle');
    } finally {
      h.dispose();
    }
  });

  it('asks for attention on a pending permission unless the user is watching', async () => {
    const h = host();
    try {
      const session = h.addPanel('p/chats/plan.chat');
      session.model.messages = [
        { id: '1', body: 'Fit the model', sender: human, time: 1 },
        {
          id: '2',
          body: '',
          sender: agent,
          time: 2,
          metadata: { tool_calls: [{ permission_status: 'pending' }] }
        }
      ];
      h.shell.currentWidget = session;
      session.model.messagesUpdated.emit();
      expect(h.manager.activity('p/chats/plan.chat')).toBe('attention');
      // While the session is the current widget, the card itself is enough.
      const watching = document.hasFocus();
      expect(Notification.manager.notifications.length).toBe(watching ? 0 : 1);

      h.shell.currentWidget = null;
      session.model.messages = [
        ...session.model.messages,
        { id: '3', body: 'ok', sender: human, time: 3 },
        {
          id: '4',
          body: '',
          sender: agent,
          time: 4,
          metadata: { tool_calls: [{ permission_status: 'pending' }] }
        }
      ];
      session.model.messagesUpdated.emit();
      // Attention persists: no second notification for the same state.
      session.model.messages = [
        ...session.model.messages.slice(0, 3),
        { id: '5', body: 'done', sender: agent, time: 5 }
      ];
      session.model.messagesUpdated.emit();
      session.model.messages = [
        ...session.model.messages,
        { id: '6', body: 'more', sender: human, time: 6 },
        {
          id: '7',
          body: '',
          sender: agent,
          time: 7,
          metadata: { tool_calls: [{ permission_status: 'pending' }] }
        }
      ];
      session.model.messagesUpdated.emit();
      const types = Notification.manager.notifications.map(item => [
        item.type,
        item.message
      ]);
      expect(types).toContainEqual([
        'warning',
        'Fit the model needs your input'
      ]);
      expect(types).toContainEqual(['info', 'Fit the model finished']);
    } finally {
      h.dispose();
    }
  });

  it('drops live state when a session closes and follows renames', async () => {
    const h = host();
    try {
      const session = h.addPanel('p/chats/plan.chat');
      h.emitFileChange({
        type: 'rename',
        oldValue: fileModel('', { path: 'p/chats/plan.chat' }),
        newValue: fileModel('', { path: 'p/chats/hubble.chat' })
      });
      expect(h.manager.activity('p/chats/plan.chat')).toBeUndefined();
      expect(h.manager.activity('p/chats/hubble.chat')).toBe('idle');
      session.dispose();
      expect(h.manager.activity('p/chats/hubble.chat')).toBeUndefined();
    } finally {
      h.dispose();
    }
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
