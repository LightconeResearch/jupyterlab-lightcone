import type { IChatModel, IChatPanel, IChatTracker } from '@jupyter/chat';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import type { Contents } from '@jupyterlab/services';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import type { IChatProjectResolver } from '../../chat-links/chat-project';
import {
  AgentContinuity,
  lastAddressedPersona,
  whenListed
} from '../agent-continuity';
import { selectPersona } from '../persona-registry';
import { selectedPersona } from '../persona-metadata';
import { fetchProjectAgent } from '../sessions-api';

jest.mock('@jupyter/chat', () => {
  const { Token } = jest.requireActual('@lumino/coreutils');
  return { IChatTracker: new Token('@jupyter/chat:IChatTracker') };
});
jest.mock('../sessions-api', () => ({
  ...jest.requireActual('../sessions-api'),
  fetchProjectAgent: jest.fn()
}));

const CLAUDE = 'jupyter-ai-personas::acp::Claude';
const CODEX = 'jupyter-ai-personas::acp::Codex';
const PERSONAS = [
  { id: CLAUDE, name: 'Claude', avatar_url: '', yjs_client_id: 0 },
  { id: CODEX, name: 'Codex', avatar_url: '', yjs_client_id: 0 }
];

/** A chat's persona list, as persona-manager keeps it. */
class FakeState {
  readonly changed = new Signal<this, void>(this);
  personas: typeof PERSONAS = [];
  isDisposed = false;
  readonly updates: string[][] = [];
  /** Whether a persona list arrived, as `PersonaManagerSessionState.ready`. */
  get ready(): boolean {
    return this.updates.length > 0;
  }
  updatePersonas(list: typeof PERSONAS): void {
    this.personas = list;
    this.updates.push(list.map(option => option.id));
    this.changed.emit();
  }
}

/** Hands out one state per chat, and a new one after a discard. */
class FakeRegistry {
  states = new Map<string, FakeState>();
  get(chatId: string): FakeState {
    let state = this.states.get(chatId);
    if (!state) {
      state = new FakeState();
      this.states.set(chatId, state);
    }
    return state;
  }
  discard(chatId: string): void {
    const state = this.states.get(chatId);
    if (state) {
      state.isDisposed = true;
      Signal.clearData(state);
    }
    this.states.delete(chatId);
  }
}

function message(sender: string, toPersona?: string | null) {
  return {
    id: `m-${Math.random()}`,
    body: 'hello',
    time: 0,
    sender: { username: sender },
    metadata: toPersona === undefined ? {} : { to_persona: toPersona }
  };
}

/** A chat view, as the chat tracker yields it. */
function chatPanel(
  options: {
    id?: string;
    messages?: ReturnType<typeof message>[];
    selected?: string | null;
    signalMetadata?: boolean;
  } = {}
): IChatPanel {
  const panel = new Widget() as Widget & { model: IChatModel; area: string };
  let metadata: Record<string, unknown> = { to_persona: options.selected };
  const id = options.id ?? 'chat-1';
  const metadataChanged = new Signal<object, void>({});
  panel.area = 'main';
  panel.model = {
    id,
    name: `project/chats/${id}.chat`,
    isDisposed: false,
    ready: Promise.resolve(id),
    messages: options.messages ?? [],
    input: {
      getMetadata: () => metadata,
      metadataChanged: options.signalMetadata ? metadataChanged : undefined,
      updateMetadata: (patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch };
        metadataChanged.emit();
      }
    }
  } as unknown as IChatModel;
  return panel as unknown as IChatPanel;
}

function host(panels: IChatPanel[] = [], restored = false) {
  const registry = new FakeRegistry();
  const widgetAdded = new Signal<unknown, IChatPanel>({});
  const tracker = {
    widgetAdded,
    forEach: (visit: (widget: IChatPanel) => void) => {
      if (restored) panels.forEach(visit);
    },
    find: (test: (widget: IChatPanel) => boolean) => panels.find(test)
  } as unknown as IChatTracker;
  const contents = {
    localPath: (path: string) => path,
    serverSettings: {}
  } as unknown as Contents.IManager;
  const projects: IChatProjectResolver = {
    resolve: async () => ({
      path: 'project',
      entrypoint: 'project/astra.yaml'
    })
  };
  const continuity = new AgentContinuity({
    tracker,
    registry: registry as unknown as PersonaSessionRegistry,
    contents,
    projects
  });
  return { registry, continuity, panels };
}

beforeEach(() => {
  jest.useRealTimers();
  jest.mocked(fetchProjectAgent).mockReset();
  jest.mocked(fetchProjectAgent).mockResolvedValue(null);
});

describe('lastAddressedPersona', () => {
  it('reads the newest message a person addressed, not a persona’s reply', () => {
    expect(
      lastAddressedPersona([
        message('researcher', CODEX),
        message('researcher', CLAUDE),
        message('jupyter-ai-personas::acp::Codex', CODEX),
        message('researcher', null)
      ] as unknown as IChatModel['messages'])
    ).toBe(CLAUDE);
    expect(lastAddressedPersona([])).toBeUndefined();
  });
});

describe('selectPersona', () => {
  it('lists the persona alone, then everyone again', () => {
    const state = new FakeState();
    state.personas = PERSONAS;
    selectPersona(state as unknown as PersonaManagerSessionState, CODEX);
    expect(state.updates).toEqual([[CODEX], [CLAUDE, CODEX]]);
  });

  it('leaves a list without the persona alone', () => {
    const state = new FakeState();
    state.personas = PERSONAS;
    selectPersona(
      state as unknown as PersonaManagerSessionState,
      'jupyter-ai-personas::gone::Persona'
    );
    expect(state.updates).toEqual([]);
  });
});

describe('whenListed', () => {
  it('waits for the persona list, following a state the registry replaced', async () => {
    jest.useFakeTimers();
    const registry = new FakeRegistry();
    const first = registry.get('chat-1');
    const listed = whenListed(
      registry as unknown as PersonaSessionRegistry,
      'chat-1',
      CODEX,
      () => false
    );
    // A view of the chat closed: the registry discards the state it had.
    registry.discard('chat-1');
    registry.get('chat-1').updatePersonas(PERSONAS);
    await jest.advanceTimersByTimeAsync(100);
    await expect(listed).resolves.toBe(registry.get('chat-1'));
    expect(first.isDisposed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives up once the list arrives without the persona', async () => {
    const registry = new FakeRegistry();
    const listed = whenListed(
      registry as unknown as PersonaSessionRegistry,
      'chat-1',
      CODEX,
      () => false
    );
    registry.get('chat-1').updatePersonas([PERSONAS[0]]);
    await expect(listed).resolves.toBeUndefined();
    // A list that already arrived answers at once.
    await expect(
      whenListed(
        registry as unknown as PersonaSessionRegistry,
        'chat-1',
        CODEX,
        () => false
      )
    ).resolves.toBeUndefined();
  });

  it('gives up after the timeout, or when cancelled', async () => {
    const registry = new FakeRegistry();
    await expect(
      whenListed(
        registry as unknown as PersonaSessionRegistry,
        'chat-1',
        CODEX,
        () => false,
        10
      )
    ).resolves.toBeUndefined();
    let cancelled = false;
    const listed = whenListed(
      registry as unknown as PersonaSessionRegistry,
      'chat-1',
      CODEX,
      () => cancelled
    );
    cancelled = true;
    registry.get('chat-1').updatePersonas([PERSONAS[0]]);
    await expect(listed).resolves.toBeUndefined();
  });
});

describe('AgentContinuity', () => {
  it('preselects chats restored before the optional registry finishes loading', async () => {
    jest.useFakeTimers();
    const panel = chatPanel({ messages: [message('researcher', CODEX)] });
    const h = host([panel], true);
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.registry.get('chat-1').updates).toEqual([
      [CLAUDE, CODEX],
      [CODEX],
      [CLAUDE, CODEX]
    ]);
    h.continuity.dispose();
    panel.dispose();
  });

  it('opens a chat with the agent its messages last named', async () => {
    const panel = chatPanel({
      messages: [message('researcher', CODEX)],
      selected: null
    });
    const h = host([panel]);
    const done = h.continuity.preselect(panel);
    await Promise.resolve();
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    await done;
    expect(h.registry.get('chat-1').updates).toEqual([
      [CLAUDE, CODEX],
      [CODEX],
      [CLAUDE, CODEX]
    ]);
    // The chat's own agent wins; the project is not asked.
    expect(fetchProjectAgent).not.toHaveBeenCalled();
  });

  it('retries when a moved view stamps metadata before its toolbar subscribes', async () => {
    jest.useFakeTimers();
    const panel = chatPanel({
      messages: [message('researcher', CODEX)],
      selected: CLAUDE,
      signalMetadata: true
    });
    const h = host([panel]);
    const state = h.registry.get('chat-1');
    state.updatePersonas(PERSONAS);
    const done = h.continuity.preselect(panel);
    await jest.advanceTimersByTimeAsync(0);
    // The toolbar missed the first transient list while mounting. Once it
    // subscribes, its ordinary sole-persona rule acknowledges the retry.
    expect(selectedPersona(panel.model.input.getMetadata())).toBe(CLAUDE);
    state.changed.connect(() => {
      if (state.personas.length === 1) {
        panel.model.input.updateMetadata({ to_persona: state.personas[0].id });
      }
    });
    await jest.advanceTimersByTimeAsync(50);
    await done;
    expect(selectedPersona(panel.model.input.getMetadata())).toBe(CODEX);
    const attempts = state.updates.length;
    await jest.advanceTimersByTimeAsync(5000);
    expect(state.updates).toHaveLength(attempts);
    h.continuity.dispose();
    panel.dispose();
  });

  it('opens a chat without messages with the project’s agent', async () => {
    jest.mocked(fetchProjectAgent).mockResolvedValue(CLAUDE);
    const panel = chatPanel({ selected: 'jupyter-ai-personas::gone::P' });
    const h = host([panel]);
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    await h.continuity.preselect(panel);
    expect(fetchProjectAgent).toHaveBeenCalledWith({}, 'project/astra.yaml');
    expect(h.registry.get('chat-1').updates.slice(1)).toEqual([
      [CLAUDE],
      [CLAUDE, CODEX]
    ]);
  });

  it('leaves a chat alone when its picker already shows the agent, or nothing is known', async () => {
    const shown = chatPanel({
      messages: [message('researcher', CODEX)],
      selected: CODEX
    });
    let h = host([shown]);
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    await h.continuity.preselect(shown);
    expect(h.registry.get('chat-1').updates).toHaveLength(1);

    const unknown = chatPanel({ selected: null });
    h = host([unknown]);
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    await h.continuity.preselect(unknown);
    expect(h.registry.get('chat-1').updates).toHaveLength(1);
  });

  it('leaves a chat open in another view alone, so that view keeps its choice', async () => {
    const panel = chatPanel({
      messages: [message('researcher', CODEX)],
      selected: null
    });
    const other = chatPanel({ selected: CLAUDE });
    const h = host([panel, other]);
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    await h.continuity.preselect(panel);
    expect(h.registry.get('chat-1').updates).toHaveLength(1);
  });

  it('preselects every chat view the tracker adds, until disposed', async () => {
    const panel = chatPanel({
      messages: [message('researcher', CODEX)],
      selected: null
    });
    const h = host([panel]);
    h.registry.get('chat-1').updatePersonas(PERSONAS);
    const tracker = (
      h.continuity as unknown as {
        _options: { tracker: { widgetAdded: Signal<unknown, IChatPanel> } };
      }
    )._options.tracker;
    tracker.widgetAdded.emit(panel);
    for (let tries = 0; tries < 100; tries++) {
      if (h.registry.get('chat-1').updates.length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(h.registry.get('chat-1').updates).toHaveLength(3);
    h.continuity.dispose();
    tracker.widgetAdded.emit(panel);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.registry.get('chat-1').updates).toHaveLength(3);
  });
});
