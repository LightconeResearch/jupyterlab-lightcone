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
 */

/** The message metadata key holding a turn's ACP tool calls. */
export const TOOL_CALLS_KEY = 'tool_calls';

/** One ACP tool call recorded in a message's metadata. */
export interface IToolCall {
  status: string | null;
  permissionStatus: string | null;
  /** The paths of the file diffs the call made, in order. */
  diffPaths: string[];
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
