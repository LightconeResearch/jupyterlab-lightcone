import type { SurfaceKind } from '@astra-spec/ui/model';
import { referenceKind, type IElementReference } from '../element-reference';

/** Commands that move a record tab through the references it has shown. */
export namespace ElementHistoryCommandIDs {
  export const back = 'jupyterlab_lightcone:element-back';
  export const forward = 'jupyterlab_lightcone:element-forward';
  export const openInNewTab = 'jupyterlab_lightcone:element-open-new-tab';
}

/** Oldest entries are dropped beyond this many references. */
export const HISTORY_LIMIT = 50;

/** One reference a record tab has shown. */
export interface IHistoryEntry {
  reference: IElementReference;
  /** Stable identity of the record: entrypoint, target and universe. */
  identity: string;
  label: string;
  /** How far the tab was scrolled when it left this entry. */
  scrollTop?: number;
}

/** The references a tab has shown, with the one it shows now. */
export interface IElementHistory {
  readonly entries: readonly IHistoryEntry[];
  /** Index of the current entry; -1 while the tab has shown nothing. */
  readonly index: number;
}

export const EMPTY_HISTORY: IElementHistory = { entries: [], index: -1 };

/** The entry the tab shows now. */
export function currentEntry(
  history: IElementHistory
): IHistoryEntry | undefined {
  return history.entries[history.index];
}

/**
 * Show a reference: it becomes the newest entry and any forward entries are
 * dropped, as in a browser. Showing the record already current only refreshes
 * its label and reference, so a reopen never duplicates the entry.
 */
export function pushHistory(
  history: IElementHistory,
  entry: IHistoryEntry
): IElementHistory {
  const current = currentEntry(history);
  if (current && current.identity === entry.identity) {
    const entries = history.entries.slice();
    entries[history.index] = {
      ...current,
      reference: entry.reference,
      label: entry.label
    };
    return { entries, index: history.index };
  }
  const entries = [...history.entries.slice(0, history.index + 1), entry];
  const overflow = Math.max(0, entries.length - HISTORY_LIMIT);
  const kept = entries.slice(overflow);
  return { entries: kept, index: kept.length - 1 };
}

/**
 * Keep where the current entry is scrolled, so that coming back to it
 * resumes there instead of at the top.
 */
export function rememberScroll(
  history: IElementHistory,
  scrollTop: number
): IElementHistory {
  const current = currentEntry(history);
  if (!current || current.scrollTop === scrollTop) return history;
  const entries = history.entries.slice();
  entries[history.index] = { ...current, scrollTop };
  return { entries, index: history.index };
}

export function canGoBack(history: IElementHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: IElementHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/** Move by `delta` entries; undefined when that leaves the history. */
export function stepHistory(
  history: IElementHistory,
  delta: number
): IElementHistory | undefined {
  return goToHistory(history, history.index + delta);
}

/** Jump to an entry by index; undefined when it does not exist or is current. */
export function goToHistory(
  history: IElementHistory,
  index: number
): IElementHistory | undefined {
  if (
    !Number.isInteger(index) ||
    index === history.index ||
    index < 0 ||
    index >= history.entries.length
  )
    return undefined;
  return { entries: history.entries, index };
}

/** The short identifier a breadcrumb shows for an entry. */
export function entryIdentifier(entry: IHistoryEntry): string {
  if (entry.reference.doi) return `doi:${entry.reference.doi}`;
  return entry.reference.target || 'analysis';
}

/** One crumb of the trail leading to the current entry. */
export interface IHistoryCrumb {
  index: number;
  identifier: string;
  label: string;
  /** What the entry shows, for its kind mark; undefined for an unknown path. */
  kind: SurfaceKind | undefined;
  current: boolean;
}

/**
 * The trail of references leading to the current one, oldest first, limited
 * to the last `limit` entries; `elided` counts the older ones left out.
 */
export function historyTrail(
  history: IElementHistory,
  limit = 4
): { crumbs: IHistoryCrumb[]; elided: number } {
  if (history.index < 0) return { crumbs: [], elided: 0 };
  const start = Math.max(0, history.index - limit + 1);
  const crumbs = history.entries
    .slice(start, history.index + 1)
    .map((entry, offset) => ({
      index: start + offset,
      identifier: entryIdentifier(entry),
      label: entry.label,
      kind: referenceKind(entry.reference.target, entry.reference.doi),
      current: start + offset === history.index
    }));
  return { crumbs, elided: start };
}

/** The caption a tab shows for its trail, e.g. "outputs.a › decisions.b". */
export function historyCaption(history: IElementHistory, limit = 4): string {
  const { crumbs, elided } = historyTrail(history, limit);
  const parts = crumbs.map(crumb => crumb.identifier);
  if (elided > 0) parts.unshift('…');
  return parts.join(' › ');
}
