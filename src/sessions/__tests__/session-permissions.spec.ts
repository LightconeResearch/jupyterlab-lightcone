import type { IChatTracker } from '@jupyter/chat';
import { MainAreaWidget } from '@jupyterlab/apputils';
import { Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';
import {
  addSessionPermissions,
  agentModes,
  BOUNDARY_NOTE,
  modesText,
  modeWords,
  PERMISSIONS_TOOLBAR_ITEM,
  SessionPermissions
} from '../session-permissions';

jest.mock('../../pdf-runtime', () => ({}));

const CODEX = 'jupyter-ai-personas::jupyter_ai_acp_client::CodexAcpPersona';
const CLAUDE = 'jupyter-ai-personas::jupyter_ai_acp_client::ClaudeAcpPersona';

class FakeShared {
  source: Record<string, unknown> = { metadata: {}, users: {} };
  readonly changed = new Signal<this, unknown>(this);
  getSource(): unknown {
    return this.source;
  }
  set(metadata: Record<string, unknown>): void {
    this.source = { ...this.source, metadata };
    this.changed.emit({});
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
    expect(agentModes(null)).toEqual([]);
    expect(agentModes({ metadata: { acp_config_options: 'x' } })).toEqual([]);
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
    const item = new SessionPermissions(shared);
    expect(item.isHidden).toBe(true);
    expect(item.node.title).toBe(BOUNDARY_NOTE);
    shared.set({
      acp_config_options: { [CODEX]: { mode: 'agent-full-access' } }
    });
    expect(item.isHidden).toBe(false);
    expect(item.node.textContent).toContain(
      'CodexAcpPersona: agent full access'
    );
    expect(item.node.textContent).toContain('sandbox: lc runs only');
    item.dispose();
    shared.set({});
  });
});

describe('addSessionPermissions', () => {
  it('adds the item to main-area sessions only, once each', () => {
    const shared = new FakeShared();
    const session = new MainAreaWidget({ content: new Widget() });
    Object.assign(session, {
      area: 'main',
      model: {
        name: 'p/chats/a.chat',
        input: {},
        messages: [],
        ready: Promise.resolve(),
        sharedModel: shared
      }
    });
    const side = new MainAreaWidget({ content: new Widget() });
    Object.assign(side, {
      area: 'sidebar',
      model: {
        name: 'p/chats/b.chat',
        input: {},
        messages: [],
        ready: Promise.resolve(),
        sharedModel: shared
      }
    });
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
});
