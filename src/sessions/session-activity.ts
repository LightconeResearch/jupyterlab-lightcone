import type { PERSONA_STATE_EVENT_SCHEMA_ID } from '@jupyter-ai/persona-manager';
import { isRecord } from '../api';
import { readToolCalls } from './acp-metadata';
import type { SessionState } from './session-service';
import type { SessionActivity } from './sessions-api';

/**
 * Prefix of every Jupyter AI persona's user name: ids read
 * `jupyter-ai-personas::<package>::<class>` (`base_persona.py`). Neither
 * persona-manager package exports the scheme, so it is restated here, once.
 */
export const PERSONA_USERNAME_PREFIX = 'jupyter-ai-personas::';

/**
 * Schema of the persona manager's per-persona state events. The value is
 * restated so the reducers need no import of the federated persona-manager
 * package; its type is the package's, so a drift fails to compile.
 */
export const PERSONA_STATE_EVENT_SCHEMA: typeof PERSONA_STATE_EVENT_SCHEMA_ID =
  'https://schema.jupyter.org/jupyter_ai_persona_manager/persona_state/v1';

/** The part of a chat user the activity reducers read. */
export interface ISessionUser {
  username: string;
  bot?: boolean;
}

/** The part of a chat message the activity reducers read. */
export interface ISessionMessage {
  sender: ISessionUser;
  metadata?: unknown;
}

/** The part of a chat writer the activity reducers read. */
export interface ISessionWriter {
  user: ISessionUser;
}

/** What the reducers know about an open chat. */
export interface ISessionSnapshot {
  messages: readonly ISessionMessage[];
  writers: readonly ISessionWriter[];
  /** Whether a persona reports that it is processing a message. */
  processing: boolean;
}

/** A persona manager `persona_state` event that concerns activity. */
export interface IPersonaStateEvent {
  chatId: string;
  personaId: string;
  processing: boolean | undefined;
}

/** What a session's activity change means to the user, if anything. */
export type ActivityTransition = 'finished' | 'attention';

/** Whether a chat user is an agent rather than a person. */
export function isPersonaUser(user: ISessionUser): boolean {
  return user.bot === true || user.username.startsWith(PERSONA_USERNAME_PREFIX);
}

/** A persona's display name when the chat records none: its id's last segment. */
export function personaDisplayName(personaId: string): string {
  return personaId.split('::').pop() || personaId;
}

/** The messages of the current turn: everything after the last human message. */
export function currentTurn<T extends ISessionMessage>(
  messages: readonly T[]
): T[] {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!isPersonaUser(messages[index].sender)) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start);
}

/** Whether an agent is waiting for the user to allow a tool call. */
export function hasPendingPermission(
  messages: readonly ISessionMessage[]
): boolean {
  return currentTurn(messages).some(message =>
    readToolCalls(message.metadata).some(
      call => call.permissionStatus === 'pending'
    )
  );
}

/** Whether an agent is still running a tool in the current turn. */
export function hasToolInProgress(
  messages: readonly ISessionMessage[]
): boolean {
  return currentTurn(messages).some(message =>
    readToolCalls(message.metadata).some(call => call.status === 'in_progress')
  );
}

/** Reduce an open chat to the workbench's view of its activity. */
export function deriveSessionState(snapshot: ISessionSnapshot): SessionState {
  if (hasPendingPermission(snapshot.messages)) {
    return 'attention';
  }
  if (
    snapshot.processing ||
    snapshot.writers.some(writer => isPersonaUser(writer.user)) ||
    hasToolInProgress(snapshot.messages)
  ) {
    return 'working';
  }
  return 'idle';
}

/** What to tell the user about a change of activity, if anything. */
export function activityTransition(
  previous: SessionState | undefined,
  next: SessionState
): ActivityTransition | null {
  if (next === 'attention' && previous !== 'attention') {
    return 'attention';
  }
  if (next === 'idle' && (previous === 'working' || previous === 'attention')) {
    return 'finished';
  }
  return null;
}

/** Collapse the workbench's activity to the two states a listing reports. */
export function listActivity(state: SessionState): SessionActivity {
  return state === 'idle' ? 'idle' : 'working';
}

/** Recognize a persona state event on the server's event stream. */
export function readPersonaStateEvent(
  emission: unknown
): IPersonaStateEvent | undefined {
  if (
    !isRecord(emission) ||
    emission.schema_id !== PERSONA_STATE_EVENT_SCHEMA ||
    typeof emission.chat_id !== 'string' ||
    typeof emission.persona_id !== 'string'
  ) {
    return undefined;
  }
  return {
    chatId: emission.chat_id,
    personaId: emission.persona_id,
    processing:
      typeof emission.processing === 'boolean' ? emission.processing : undefined
  };
}
