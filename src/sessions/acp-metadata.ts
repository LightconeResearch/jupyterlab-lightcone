import { isRecord } from '../api';

/**
 * The metadata `jupyter-ai-acp-client` writes into chats, read in one place.
 *
 * The ACP client publishes no schema or types for this metadata; the keys are
 * dict literals in its Python sources, cited here so a rename is found:
 *
 * - `tool_calls` on a message: `tool_call_manager.py` (`msg.metadata =
 *   {"tool_calls": all_tcs}`), each call a `ToolCallState` of
 *   `tool_call_renderer.py` with `status`, `permission_status` and `diffs`,
 *   whose entries are `ToolCallDiff(path, new_text, old_text)`.
 * - `acp_config_options` and `acp_modes` on the chat: `base_acp_persona.py`
 *   persists a persona's config choices as `acp_config_options[persona][option
 *   id]`, and the mode of an agent without a mode config option as
 *   `acp_modes[persona]`. The mode option is the one whose category or id is
 *   `mode`; the client publishes it as a general persona setting with the
 *   stable pseudo-id `MODE_CONTROL_ID` (`__mode__`).
 */

/** The message metadata key holding a turn's ACP tool calls. */
export const TOOL_CALLS_KEY = 'tool_calls';

/** The chat metadata key holding each persona's ACP config choices. */
export const ACP_CONFIG_OPTIONS_KEY = 'acp_config_options';

/** The chat metadata key holding the mode of agents without a mode option. */
export const ACP_MODES_KEY = 'acp_modes';

/** The config option id the ACP client persists an agent's mode under. */
export const MODE_OPTION_ID = 'mode';

/**
 * The id of the persona setting through which the ACP client publishes an
 * agent's mode in `persona_state` events (`MODE_CONTROL_ID`).
 */
export const MODE_SETTING_ID = '__mode__';

/** One ACP tool call recorded in a message's metadata. */
export interface IToolCall {
  status: string | null;
  permissionStatus: string | null;
  /** The paths of the file diffs the call made, in order. */
  diffPaths: string[];
}

/** One agent's persisted ACP mode, by persona id. */
export interface IAgentModeRecord {
  persona: string;
  /** The ACP mode id, such as `agent-full-access` or `acceptEdits`. */
  mode: string;
}

function diffPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const diff of value) {
    if (isRecord(diff) && typeof diff.path === 'string' && diff.path) {
      paths.push(diff.path);
    }
  }
  return paths;
}

/** Read the tool calls the ACP client stores in a message's metadata. */
export function readToolCalls(metadata: unknown): IToolCall[] {
  if (!isRecord(metadata) || !Array.isArray(metadata[TOOL_CALLS_KEY])) {
    return [];
  }
  const calls: IToolCall[] = [];
  for (const call of metadata[TOOL_CALLS_KEY]) {
    if (!isRecord(call)) {
      continue;
    }
    calls.push({
      status: typeof call.status === 'string' ? call.status : null,
      permissionStatus:
        typeof call.permission_status === 'string'
          ? call.permission_status
          : null,
      diffPaths: diffPaths(call.diffs)
    });
  }
  return calls;
}

/**
 * The modes the ACP client persisted in a chat's metadata, one per persona:
 * the persona's `mode` config choice, else the mode recorded for an agent
 * without a mode config option.
 */
export function readAgentModes(chatMetadata: unknown): IAgentModeRecord[] {
  if (!isRecord(chatMetadata)) {
    return [];
  }
  const modes = new Map<string, string>();
  const fallback = chatMetadata[ACP_MODES_KEY];
  if (isRecord(fallback)) {
    for (const [persona, mode] of Object.entries(fallback)) {
      if (typeof mode === 'string' && mode) {
        modes.set(persona, mode);
      }
    }
  }
  const options = chatMetadata[ACP_CONFIG_OPTIONS_KEY];
  if (isRecord(options)) {
    for (const [persona, choices] of Object.entries(options)) {
      const mode = isRecord(choices) ? choices[MODE_OPTION_ID] : undefined;
      if (typeof mode === 'string' && mode) {
        modes.set(persona, mode);
      }
    }
  }
  return [...modes].map(([persona, mode]) => ({ persona, mode }));
}
