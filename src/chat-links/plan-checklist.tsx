import type { MessagePreambleProps } from '@jupyter/chat';
import React from 'react';
import { isRecord } from '../api';

/** The message metadata key under which an agent's plan is expected. */
export const PLAN_METADATA_KEY = 'plan';

/** One step of an agent's plan, as the Agent Client Protocol describes it. */
export interface IPlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low' | null;
}

const STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed'
]);
const PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

function isStatus(value: unknown): value is IPlanEntry['status'] {
  return typeof value === 'string' && STATUSES.has(value);
}

function isPriority(
  value: unknown
): value is NonNullable<IPlanEntry['priority']> {
  return typeof value === 'string' && PRIORITIES.has(value);
}

/**
 * The plan a message carries: ACP's `AgentPlanUpdate` entries (`content`,
 * `status`, `priority`), stored under `plan` either as the list itself or as
 * `{ entries }`. Null when the message has none; malformed steps are skipped.
 * `jupyter-ai-acp-client` 0.3.0 drops plans, so nothing records them yet.
 */
export function readPlan(metadata: unknown): IPlanEntry[] | null {
  if (!isRecord(metadata)) return null;
  const value = metadata[PLAN_METADATA_KEY];
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.entries)
      ? value.entries
      : null;
  if (!entries) return null;
  const plan: IPlanEntry[] = [];
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.content !== 'string' ||
      !entry.content.trim() ||
      !isStatus(entry.status)
    )
      continue;
    plan.push({
      content: entry.content.trim(),
      status: entry.status,
      priority: isPriority(entry.priority) ? entry.priority : null
    });
  }
  return plan.length ? plan : null;
}

/** "Plan · 3 of 5". */
export function planSummary(plan: readonly IPlanEntry[]): string {
  const done = plan.filter(entry => entry.status === 'completed').length;
  return `Plan · ${done} of ${plan.length}`;
}

const MARKS: Readonly<Record<IPlanEntry['status'], string>> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○'
};

const STATUS_WORDS: Readonly<Record<IPlanEntry['status'], string>> = {
  completed: 'done',
  in_progress: 'in progress',
  pending: 'to do'
};

/**
 * An agent's plan above its message, as a compact checklist that ticks off
 * as the agent updates it. Open while any step remains, folded once done.
 */
export function PlanChecklist({
  message
}: MessagePreambleProps): JSX.Element | null {
  const plan = readPlan(message.metadata);
  if (!plan) return null;
  const finished = plan.every(entry => entry.status === 'completed');
  return (
    <details
      className="jp-jupyterlab-lightcone-Plan"
      open={!finished || undefined}
    >
      <summary>{planSummary(plan)}</summary>
      <ol>
        {plan.map((entry, index) => (
          <li
            key={index}
            data-status={entry.status}
            data-priority={entry.priority ?? undefined}
          >
            <span
              className="jp-jupyterlab-lightcone-Plan-mark"
              role="img"
              aria-label={STATUS_WORDS[entry.status]}
            >
              {MARKS[entry.status]}
            </span>
            <span>{entry.content}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
