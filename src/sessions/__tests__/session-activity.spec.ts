import {
  activityTransition,
  currentTurn,
  deriveSessionState,
  hasPendingPermission,
  isPersonaUser,
  listActivity,
  personaDisplayName,
  readPersonaStateEvent,
  type ISessionMessage
} from '../session-activity';

const human = { username: 'francois' };
const agent = { username: 'jupyter-ai-personas::pkg::Persona' };

function message(
  sender: { username: string; bot?: boolean },
  metadata?: unknown
): ISessionMessage {
  return { sender, metadata };
}

describe('isPersonaUser', () => {
  it('recognizes persona IDs and bots', () => {
    expect(isPersonaUser(agent)).toBe(true);
    expect(isPersonaUser({ username: 'x', bot: true })).toBe(true);
    expect(isPersonaUser(human)).toBe(false);
    // The id scheme is `jupyter-ai-personas::<package>::<class>`.
    expect(isPersonaUser({ username: 'jupyter-ai-personas' })).toBe(false);
  });
});

describe('personaDisplayName', () => {
  it('takes the last segment of a persona id', () => {
    expect(personaDisplayName(agent.username)).toBe('Persona');
    expect(personaDisplayName('plain')).toBe('plain');
  });
});

describe('currentTurn and hasPendingPermission', () => {
  it('only looks at messages after the last human message', () => {
    const stale = message(agent, {
      tool_calls: [{ permission_status: 'pending' }]
    });
    const messages = [stale, message(human), message(agent, {})];
    expect(currentTurn(messages)).toHaveLength(1);
    expect(hasPendingPermission(messages)).toBe(false);
    expect(hasPendingPermission([message(human), stale])).toBe(true);
    expect(hasPendingPermission([])).toBe(false);
  });
});

describe('deriveSessionState', () => {
  it('ranks attention above working above idle', () => {
    const pending = message(agent, {
      tool_calls: [{ status: 'in_progress', permission_status: 'pending' }]
    });
    expect(
      deriveSessionState({
        messages: [message(human), pending],
        writers: [{ user: agent }],
        processing: true
      })
    ).toBe('attention');
    expect(
      deriveSessionState({
        messages: [message(human)],
        writers: [{ user: agent }],
        processing: false
      })
    ).toBe('working');
    expect(
      deriveSessionState({ messages: [], writers: [], processing: true })
    ).toBe('working');
    expect(
      deriveSessionState({
        messages: [
          message(human),
          message(agent, { tool_calls: [{ status: 'in_progress' }] })
        ],
        writers: [],
        processing: false
      })
    ).toBe('working');
    expect(
      deriveSessionState({
        messages: [message(human), message(agent)],
        writers: [{ user: human }],
        processing: false
      })
    ).toBe('idle');
  });
});

describe('activityTransition', () => {
  it('reports finishing and attention once', () => {
    expect(activityTransition('working', 'idle')).toBe('finished');
    expect(activityTransition('attention', 'idle')).toBe('finished');
    expect(activityTransition('idle', 'attention')).toBe('attention');
    expect(activityTransition(undefined, 'attention')).toBe('attention');
    expect(activityTransition('attention', 'attention')).toBeNull();
    expect(activityTransition('idle', 'working')).toBeNull();
    expect(activityTransition(undefined, 'idle')).toBeNull();
    expect(activityTransition('attention', 'working')).toBeNull();
  });
});

describe('listActivity', () => {
  it('collapses attention into working', () => {
    expect(listActivity('attention')).toBe('working');
    expect(listActivity('working')).toBe('working');
    expect(listActivity('idle')).toBe('idle');
  });
});

describe('readPersonaStateEvent', () => {
  it('accepts only persona state events with a chat and persona', () => {
    const schema =
      'https://schema.jupyter.org/jupyter_ai_persona_manager/persona_state/v1';
    expect(
      readPersonaStateEvent({
        schema_id: schema,
        version: '1',
        chat_id: 'c',
        persona_id: 'p',
        processing: true
      })
    ).toEqual({ chatId: 'c', personaId: 'p', processing: true });
    expect(
      readPersonaStateEvent({
        schema_id: schema,
        version: '1',
        chat_id: 'c',
        persona_id: 'p',
        usage: {}
      })
    ).toEqual({ chatId: 'c', personaId: 'p', processing: undefined });
    expect(
      readPersonaStateEvent({
        schema_id: 'other',
        chat_id: 'c',
        persona_id: 'p'
      })
    ).toBeUndefined();
    expect(readPersonaStateEvent({ schema_id: schema })).toBeUndefined();
  });
});
