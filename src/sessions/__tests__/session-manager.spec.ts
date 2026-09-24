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
import { PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { fileModel } from '../../__tests__/project-fixtures';
import {
  SessionManager,
  isComposerStamp,
  isRecordTab,
  isUntitledSession,
  isSessionWidget,
  messagesTitle,
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

  it('reads and writes persona metadata like the composer', () => {
    expect(selectedPersona({ to_persona: 'p' })).toBe('p');
    expect(selectedPersona({ to_persona: null })).toBeNull();
    expect(selectedPersona({})).toBeNull();
    expect(isComposerStamp({ to_persona: null })).toBe(true);
    expect(isComposerStamp({ lightcone: { comments: [] } })).toBe(false);
    expect(isComposerStamp(null)).toBe(false);
    expect(personaMetadata('p')).toEqual({
      to_persona: 'p',
      model: { id: null, settings: {} },
      settings: {}
    });
  });
});

describe('SessionManager.createAndOpen', () => {
  it('names the chat from the first message, opens it in the current group and sends', async () => {
    const h = host();
    jest.useFakeTimers();
    try {
      const home = new Widget();
      home.id = 'home';
      h.shell.currentWidget = home;
      const pending = h.manager.createAndOpen('p/astra.yaml', {
        firstMessage: 'Plot the Hubble diagram\nwith error bars',
        persona: 'jupyter-ai-personas::pkg::Persona'
      });
      await jest.advanceTimersByTimeAsync(10);
      expect(h.created).toEqual([
        { path: 'p/chats', name: 'plot-the-hubble-diagram' }
      ]);
      expect(h.opened).toEqual([
        {
          path: 'p/chats/plot-the-hubble-diagram.chat',
          factory: 'Chat',
          options: { mode: 'tab-after', ref: 'home', activate: true }
        }
      ]);
      const panel = h.panels[0] as unknown as FakePanel;
      expect(panel.model.input.send).not.toHaveBeenCalled();
      // The persona picker stamps "No one" once its toolbar mounts; with an
      // explicit persona that stamp is all the wait needs.
      panel.model.input.updateMetadata({ to_persona: null });
      await jest.advanceTimersByTimeAsync(10);
      expect(panel.model.input.send).toHaveBeenCalledWith(
        'Plot the Hubble diagram\nwith error bars'
      );
      expect(await pending).toBe('p/chats/plot-the-hubble-diagram.chat');
      expect(panel.model.input.metadata).toEqual(
        personaMetadata('jupyter-ai-personas::pkg::Persona')
      );
      expect(h.chatCommands.onSubmit).toHaveBeenCalledWith(panel.model.input);
      expect(panel.model.input.focus).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
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
      // An empty main area opens the session plainly.
      expect(h.opened[0]).toMatchObject({ options: { activate: true } });
      expect(h.opened[0]).not.toHaveProperty('options.mode');

      // The next session joins the open session's tab group.
      await h.manager.createAndOpen('p/astra.yaml');
      expect(h.created[1]).toEqual({ path: 'p/chats', name: 'untitled' });
      expect(h.opened[1]).toMatchObject({
        options: { mode: 'tab-after', ref: panel.id, activate: true }
      });
      const empty = h.panels[1] as unknown as FakePanel;
      expect(empty.model.input.send).not.toHaveBeenCalled();
    } finally {
      h.dispose();
    }
  });

  it('waits past a "No one" stamp for the picker to choose a sole persona', async () => {
    const h = host();
    jest.useFakeTimers();
    try {
      const pending = h.manager.createAndOpen('p/astra.yaml', {
        firstMessage: 'Hello'
      });
      await jest.advanceTimersByTimeAsync(10);
      const panel = h.panels[0] as unknown as FakePanel;
      panel.model.input.updateMetadata({ to_persona: null });
      await jest.advanceTimersByTimeAsync(300);
      expect(panel.model.input.send).not.toHaveBeenCalled();
      // The persona list arrives and the picker selects the only persona.
      panel.model.input.updateMetadata(personaMetadata('sole'));
      await jest.advanceTimersByTimeAsync(10);
      await pending;
      expect(panel.model.input.metadata).toEqual(personaMetadata('sole'));
      expect(panel.model.input.send).toHaveBeenCalledWith('Hello');
      expect(Notification.manager.notifications).toHaveLength(0);
    } finally {
      jest.useRealTimers();
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

  it('reports a chat file that was not created, and a session that did not open', async () => {
    const h = host();
    const commands = new CommandRegistry();
    const opened: unknown[] = [];
    commands.addCommand('jupyterlab-chat:create', { execute: () => null });
    commands.addCommand('docmanager:open', {
      execute: args => {
        opened.push(args);
        return undefined;
      }
    });
    const manager = new SessionManager({
      commands,
      shell: h.shell as unknown as JupyterFrontEnd.IShell,
      contents: h.contents,
      tracker: h.tracker,
      chatCommands: null,
      labShell: null,
      events: null
    });
    try {
      await expect(manager.createAndOpen('p/astra.yaml')).rejects.toThrow(
        'The session file could not be created.'
      );
      expect(opened).toEqual([]);
      await expect(manager.openSession('p/chats/plan.chat')).rejects.toThrow(
        'The session did not open. Check that Jupyter AI is enabled.'
      );
      expect(opened).toHaveLength(1);
    } finally {
      manager.dispose();
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
  it('renames an untitled session once, when its first message arrives while open', async () => {
    const h = host();
    const rename = jest
      .spyOn(h.contents, 'rename')
      .mockImplementation(async (from, to) => fileModel('', { path: to }));
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
    const hasFocus = jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      expect(document.visibilityState).toBe('visible');
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
      // While the user looks at the session, the permission card is enough.
      expect(Notification.manager.notifications).toHaveLength(0);

      // The same tab in a window without focus is not being watched.
      hasFocus.mockReturnValue(false);
      session.model.messages = [
        ...session.model.messages.slice(0, 1),
        { id: '2', body: 'done', sender: agent, time: 2 }
      ];
      session.model.messagesUpdated.emit();
      expect(
        Notification.manager.notifications.map(item => [
          item.type,
          item.message
        ])
      ).toEqual([['info', 'Fit the model finished']]);
      for (const notification of [...Notification.manager.notifications]) {
        Notification.manager.dismiss(notification.id);
      }

      hasFocus.mockReturnValue(true);
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
      session.model.messageChanged.emit(undefined);
      expect(Notification.manager.notifications).toHaveLength(1);
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
      // Newest first.
      const types = Notification.manager.notifications.map(item => [
        item.type,
        item.message
      ]);
      expect(types).toEqual([
        ['warning', 'Fit the model needs your input'],
        ['info', 'Fit the model finished'],
        ['warning', 'Fit the model needs your input']
      ]);
    } finally {
      hasFocus.mockRestore();
      h.dispose();
    }
  });

  it('keeps following a chat moved from the side panel to the main area', async () => {
    const h = host();
    try {
      const path = 'p/chats/plan.chat';
      const processing = (value: boolean) =>
        h.events.stream.emit({
          schema_id: PERSONA_STATE,
          version: '1',
          chat_id: `id-${path}`,
          persona_id: 'p',
          processing: value
        });
      const side = h.addPanel(path, 'sidebar');
      await flush();
      processing(true);
      expect(h.manager.activity(path)).toBe('working');

      // Jupyter Chat opens the main-area document, then closes the side panel.
      const main = h.addPanel(path);
      await flush();
      side.dispose();
      await flush();
      expect(h.manager.activity(path)).toBe('working');
      expect(Notification.manager.notifications).toHaveLength(0);

      // The main-area session now carries the chat's activity.
      main.model.writers = [{ user: agent }];
      main.model.writersChanged.emit(undefined);
      processing(false);
      expect(h.manager.activity(path)).toBe('working');
      main.model.writers = [];
      main.model.writersChanged.emit(undefined);
      expect(h.manager.activity(path)).toBe('idle');
      expect(
        Notification.manager.notifications.map(item => item.message)
      ).toEqual(['plan finished']);

      // Moving back: the side panel opened after the document closes is
      // followed on its own.
      main.dispose();
      expect(h.manager.activity(path)).toBeUndefined();
      h.addPanel(path, 'sidebar');
      expect(h.manager.activity(path)).toBe('idle');
    } finally {
      h.dispose();
    }
  });

  it('keeps the inherited activity until the main-area panel has loaded the chat', async () => {
    const h = host();
    try {
      const path = 'p/chats/plan.chat';
      const side = h.addPanel(path, 'sidebar');
      await flush();
      side.model.writers = [{ user: agent }];
      side.model.writersChanged.emit(undefined);
      expect(h.manager.activity(path)).toBe('working');

      // The main-area document is still loading: its empty model says nothing
      // about the agent, so the handover must not read as a finished session.
      const ready = new PromiseDelegate<string>();
      const main = h.addPanel(path, 'main', ready.promise);
      side.dispose();
      await flush();
      expect(h.manager.activity(path)).toBe('working');
      expect(Notification.manager.notifications).toHaveLength(0);

      main.model.writers = [{ user: agent }];
      ready.resolve(`id-${path}`);
      await flush();
      expect(h.manager.activity(path)).toBe('working');
      expect(Notification.manager.notifications).toHaveLength(0);
    } finally {
      h.dispose();
    }
  });

  it('follows the main-area session while the side panel of its chat stays open', async () => {
    const h = host();
    try {
      const path = 'p/chats/plan.chat';
      const side = h.addPanel(path, 'sidebar');
      const main = h.addPanel(path);
      await flush();
      // The side panel no longer drives the chat's activity...
      side.model.writers = [{ user: agent }];
      side.model.writersChanged.emit(undefined);
      expect(h.manager.activity(path)).toBe('idle');
      // ...the session does.
      main.model.writers = [{ user: agent }];
      main.model.writersChanged.emit(undefined);
      expect(h.manager.activity(path)).toBe('working');
    } finally {
      h.dispose();
    }
  });

  it('adopts another open panel of the chat when the followed one closes', async () => {
    const h = host();
    try {
      const path = 'p/chats/plan.chat';
      const main = h.addPanel(path);
      // A second view in the side panel does not take over the session.
      const side = h.addPanel(path, 'sidebar');
      await flush();
      side.model.writers = [{ user: agent }];
      side.model.writersChanged.emit(undefined);
      expect(h.manager.activity(path)).toBe('idle');

      main.dispose();
      h.panels.splice(h.panels.indexOf(main as unknown as IChatPanel), 1);
      await flush();
      expect(h.manager.activity(path)).toBe('working');
    } finally {
      h.dispose();
    }
  });

  it('applies persona activity reported before the chat is ready', async () => {
    const h = host();
    try {
      const ready = new PromiseDelegate<string>();
      h.addPanel('p/chats/plan.chat', 'main', ready.promise);
      await flush();
      // The persona manager re-emits its state when the client connects,
      // which can arrive before the chat's connection frame.
      h.events.stream.emit({
        schema_id: PERSONA_STATE,
        version: '1',
        chat_id: 'chat-1',
        persona_id: 'p',
        processing: true
      });
      expect(h.manager.activity('p/chats/plan.chat')).toBe('idle');
      ready.resolve('chat-1');
      await flush();
      expect(h.manager.activity('p/chats/plan.chat')).toBe('working');
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
