import type { IChatPanel, IChatTracker } from '@jupyter/chat';
import type {
  PersonaManagerSessionState,
  PersonaSessionRegistry
} from '@jupyter-ai/persona-manager';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { nullTranslator } from '@jupyterlab/translation';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import { MODE_SETTING_ID } from '../acp-metadata';
import {
  addSessionPermissions,
  agentModes,
  boundaryNote,
  modesText,
  modeWords,
  PERMISSIONS_TOOLBAR_ITEM,
  publishedModes,
  SessionPermissions
} from '../session-permissions';

jest.mock('../../pdf-runtime', () => ({}));

const CODEX = 'jupyter-ai-personas::jupyter_ai_acp_client::CodexAcpPersona';
const CLAUDE = 'jupyter-ai-personas::jupyter_ai_acp_client::ClaudeAcpPersona';
const NOTE = boundaryNote(nullTranslator.load('jupyterlab_lightcone'));

/** The chat document, emitting `changed` as `YChat` does. */
class FakeShared {
  source: Record<string, unknown> = { metadata: {}, users: {} };
  readonly changed = new Signal<this, unknown>(this);
  readonly getSource = jest.fn((): unknown => this.source);
  set(metadata: Record<string, unknown>): void {
    this.source = { ...this.source, metadata };
    this.changed.emit({ metadataChanges: [] });
  }
}

/** A chat's persona state, as the persona manager publishes it. */
class FakeState {
  readonly changed = new Signal<this, void>(this);
  isDisposed = false;
  personas: { id: string; name: string }[] = [];
  settings = new Map<string, { id: string; current: string | null }[]>();
  getPersona(id: string) {
    const settings = this.settings.get(id);
    return settings
      ? {
          settings: settings.map(setting => ({
            ...setting,
            options: [
              { id: 'agent-full-access', name: 'Full access' },
              { id: 'plan', name: null }
            ]
          }))
        }
      : undefined;
  }
  publish(persona: string, name: string, mode: string | null): void {
    if (!this.personas.some(item => item.id === persona)) {
      this.personas.push({ id: persona, name });
    }
    this.settings.set(persona, [{ id: MODE_SETTING_ID, current: mode }]);
    this.changed.emit();
  }
}

describe('agent permission modes', () => {
  it('reads each agent’s mode from the chat metadata, named by its user', () => {
    expect(
      agentModes({
        metadata: {
          acp_config_options: {
            [CODEX]: { mode: 'agent-full-access' },
            [CLAUDE]: { mode: 'acceptEdits' },
            broken: { mode: 3 },
            empty: {}
          }
        },
        users: { [CODEX]: { display_name: 'Codex' } }
      })
    ).toEqual([
      { persona: CLAUDE, name: 'ClaudeAcpPersona', mode: 'acceptEdits' },
      { persona: CODEX, name: 'Codex', mode: 'agent-full-access' }
    ]);
    // An agent without a mode config option records its mode apart.
    expect(
      agentModes({ metadata: { acp_modes: { [CLAUDE]: 'plan' } } })
    ).toEqual([{ persona: CLAUDE, name: 'ClaudeAcpPersona', mode: 'plan' }]);
    expect(agentModes(null)).toEqual([]);
    expect(agentModes({ metadata: { acp_config_options: 'x' } })).toEqual([]);
  });

  it('reads the modes the persona manager published, by their option names', () => {
    const state = new FakeState();
    state.publish(CODEX, 'Codex', 'agent-full-access');
    state.publish(CLAUDE, 'Claude', 'plan');
    state.publish('jupyter-ai-personas::acp::Quiet', 'Quiet', null);
    state.personas.push({ id: 'jupyter-ai-personas::acp::Mute', name: '' });
    expect(
      publishedModes(state as unknown as PersonaManagerSessionState)
    ).toEqual([
      { persona: CLAUDE, name: 'Claude', mode: 'plan' },
      { persona: CODEX, name: 'Codex', mode: 'Full access' }
    ]);
  });

  it('says a mode in words', () => {
    expect(modeWords('agent-full-access')).toBe('agent full access');
    expect(modeWords('bypassPermissions')).toBe('bypass permissions');
    expect(
      modesText([
        { persona: 'a', name: 'Codex', mode: 'read-only' },
        { persona: 'b', name: 'Claude', mode: 'plan' }
      ])
    ).toBe('Codex: read only · Claude: plan');
  });
});

describe('SessionPermissions', () => {
  it('shows the mode and the boundary, and hides without a mode', () => {
    const shared = new FakeShared();
    const item = new SessionPermissions({ shared });
    expect(item.isHidden).toBe(true);
    expect(item.node.title).toBe(NOTE);
    shared.set({
      acp_config_options: { [CODEX]: { mode: 'agent-full-access' } }
    });
    expect(item.isHidden).toBe(false);
    expect(item.node.textContent).toContain(
      'CodexAcpPersona: agent full access'
    );
    expect(item.node.textContent).toContain('sandbox: lc runs only');
    expect(item.node.getAttribute('aria-label')).toBe(
      `Agent permissions: CodexAcpPersona: agent full access. ${NOTE}`
    );
    item.dispose();
    shared.set({});
  });

  it('reads the document again only when its metadata changed', () => {
    const shared = new FakeShared();
    const item = new SessionPermissions({ shared });
    const reads = shared.getSource.mock.calls.length;
    shared.changed.emit({ messageChanges: [] });
    shared.changed.emit(undefined);
    expect(shared.getSource).toHaveBeenCalledTimes(reads);
    shared.changed.emit({ metadataChanges: [] });
    expect(shared.getSource).toHaveBeenCalledTimes(reads + 1);
    item.dispose();
  });

  it('prefers the modes the persona manager publishes, following their changes', () => {
    const shared = new FakeShared();
    shared.set({ acp_config_options: { [CODEX]: { mode: 'stale' } } });
    let state = new FakeState();
    const item = new SessionPermissions({
      shared,
      personas: () => state as unknown as PersonaManagerSessionState
    });
    // Nothing published yet: the document's record shows.
    expect(item.node.textContent).toContain('CodexAcpPersona: stale');
    state.publish(CODEX, 'Codex', 'agent-full-access');
    expect(item.node.textContent).toContain('Codex: full access');
    // The registry replaced the chat's state: the next refresh follows it.
    const replaced = new FakeState();
    state.isDisposed = true;
    state = replaced;
    item.refresh();
    replaced.publish(CLAUDE, 'Claude', 'plan');
    expect(item.node.textContent).toContain('Claude: plan');
    expect(item.node.textContent).not.toContain('Codex');
    item.dispose();
  });
});

describe('addSessionPermissions', () => {
  function fakeSession(area: 'main' | 'sidebar', shared: FakeShared) {
    const panel = new MainAreaWidget({ content: new Widget() });
    Object.assign(panel, {
      area,
      model: {
        name: `p/chats/${area}.chat`,
        input: {},
        messages: [],
        ready: Promise.resolve(`id-${area}`),
        sharedModel: shared
      }
    });
    return panel;
  }

  it('adds the item to main-area sessions only, once each', () => {
    const shared = new FakeShared();
    const session = fakeSession('main', shared);
    const side = fakeSession('sidebar', shared);
    const widgetAdded = new Signal<IChatTracker, Widget>({} as IChatTracker);
    const open = [session];
    const tracker = {
      forEach: (callback: (widget: Widget) => void) => open.forEach(callback),
      widgetAdded
    } as unknown as IChatTracker;
    const attached = addSessionPermissions(tracker);
    const names = (widget: MainAreaWidget) =>
      Array.from(widget.toolbar.names());
    expect(names(session)).toContain(PERMISSIONS_TOOLBAR_ITEM);
    widgetAdded.emit(session);
    expect(
      names(session).filter(name => name === PERMISSIONS_TOOLBAR_ITEM)
    ).toHaveLength(1);
    widgetAdded.emit(side);
    expect(names(side)).not.toContain(PERMISSIONS_TOOLBAR_ITEM);
    attached.dispose();
    session.dispose();
    side.dispose();
  });

  it('reads the chat’s persona state once the chat is ready', async () => {
    const shared = new FakeShared();
    const session = fakeSession('main', shared);
    const state = new FakeState();
    state.publish(CODEX, 'Codex', 'plan');
    const registry = {
      get: jest.fn(() => state)
    } as unknown as PersonaSessionRegistry;
    const tracker = {
      forEach: (callback: (widget: IChatPanel) => void) =>
        [session as unknown as IChatPanel].forEach(callback),
      widgetAdded: new Signal<IChatTracker, IChatPanel>({} as IChatTracker)
    } as unknown as IChatTracker;
    const attached = addSessionPermissions(tracker, { registry });
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.get).toHaveBeenCalledWith('id-main');
    const item = Array.from(session.toolbar.children()).find(
      widget => widget instanceof SessionPermissions
    );
    expect(item?.node.textContent).toContain('Codex: plan');
    attached.dispose();
    session.dispose();
  });
});
