import type { IRunRecord } from '../runs/runs-api';
import { isPersonaUser } from '../sessions/session-activity';

/** The part of a chat message that turn detection reads. */
export interface ITurnMessage {
  id: string;
  /** Seconds since the epoch. */
  time: number;
  sender: { username: string; bot?: boolean };
  deleted?: boolean;
  metadata?: unknown;
}

/** One reply: the user message that started it and the agent messages answering it. */
export interface ITurnWindow {
  userMessageId: string;
  /** Time of the user message, seconds since the epoch. */
  start: number;
  /** Time of the turn's last agent message, seconds since the epoch. */
  end: number;
  agentMessageIds: string[];
}

/** An output the engine materialized inside a turn window. */
export interface IMaterializedOutput {
  universe: string;
  output: string;
  run: IRunRecord;
}

/**
 * Whether a message was written by an agent persona rather than a person, by
 * the rule sessions use for their activity.
 */
export function isAgentMessage(message: Pick<ITurnMessage, 'sender'>): boolean {
  return isPersonaUser(message.sender);
}

function ordered(messages: readonly ITurnMessage[]): ITurnMessage[] {
  return messages
    .filter(message => !message.deleted)
    .sort((a, b) => a.time - b.time);
}

/**
 * The turn whose last agent message is `messageId`: the agent message that
 * precedes the next user message, or ends the chat. Undefined for user
 * messages, for agent messages followed by more agent messages, and for
 * agent messages that no user message preceded.
 */
export function turnEndingAt(
  messages: readonly ITurnMessage[],
  messageId: string
): ITurnWindow | undefined {
  const sequence = ordered(messages);
  const index = sequence.findIndex(message => message.id === messageId);
  if (index < 0 || !isAgentMessage(sequence[index])) {
    return undefined;
  }
  const next = sequence[index + 1];
  if (next && isAgentMessage(next)) {
    return undefined;
  }
  const agentMessageIds: string[] = [];
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const message = sequence[cursor];
    if (!isAgentMessage(message)) {
      return {
        userMessageId: message.id,
        start: message.time,
        end: sequence[index].time,
        agentMessageIds: agentMessageIds.reverse()
      };
    }
    agentMessageIds.push(message.id);
  }
  return undefined;
}

/** Commit time in seconds, or undefined when the record's time cannot be read. */
function runSeconds(run: IRunRecord): number | undefined {
  const millis = Date.parse(run.time);
  return Number.isNaN(millis) ? undefined : millis / 1000;
}

/**
 * The outputs whose materialization commits fall inside the window, newest
 * commit per output and universe, oldest first. Commit times have whole-second
 * precision, so the window is widened to whole seconds on both sides. A
 * failed run made nothing, so it is left out.
 */
export function materializedDuring(
  runs: readonly IRunRecord[],
  window: Pick<ITurnWindow, 'start' | 'end'>
): IMaterializedOutput[] {
  const start = Math.floor(window.start);
  const end = Math.ceil(window.end);
  const newest = new Map<string, { at: number; item: IMaterializedOutput }>();
  for (const run of runs) {
    const at = runSeconds(run);
    if (at === undefined || at < start || at > end) {
      continue;
    }
    if (run.exit !== null && run.exit !== 0) {
      continue;
    }
    const key = `${run.universe}\u0000${run.output}`;
    const known = newest.get(key);
    if (!known || known.at < at) {
      newest.set(key, {
        at,
        item: { universe: run.universe, output: run.output, run }
      });
    }
  }
  return [...newest.values()]
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The paths of every file diff recorded in a message's ACP tool calls. */
export function toolCallDiffPaths(metadata: unknown): string[] {
  if (!isRecord(metadata) || !Array.isArray(metadata.tool_calls)) {
    return [];
  }
  const paths: string[] = [];
  for (const call of metadata.tool_calls) {
    if (!isRecord(call) || !Array.isArray(call.diffs)) {
      continue;
    }
    for (const diff of call.diffs) {
      if (isRecord(diff) && typeof diff.path === 'string' && diff.path) {
        paths.push(diff.path);
      }
    }
  }
  return paths;
}

/** The files the agent edited during a turn, in first-edit order without repeats. */
export function filesEditedIn(
  messages: readonly ITurnMessage[],
  window: Pick<ITurnWindow, 'agentMessageIds'>
): string[] {
  const byId = new Map(messages.map(message => [message.id, message]));
  const seen = new Set<string>();
  const files: string[] = [];
  for (const id of window.agentMessageIds) {
    for (const path of toolCallDiffPaths(byId.get(id)?.metadata)) {
      if (!seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
  }
  return files;
}
