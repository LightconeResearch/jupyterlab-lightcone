import type { ILockedPackage } from './versions-api';

/** One line of a line-by-line comparison of two texts. */
export interface IDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  /** 1-based line in the earlier text, for kept and removed lines. */
  oldLine?: number;
  /** 1-based line in the later text, for kept and added lines. */
  newLine?: number;
}

/** A run of unchanged lines left out of a diff, between the hunks it separates. */
export interface IDiffGap {
  kind: 'gap';
  count: number;
}

/**
 * The largest middle section, in compared line pairs, `lineDiff` aligns.
 * Recipe scripts are far below it; a larger change is summarized instead.
 */
export const DIFF_CELL_LIMIT = 4_000_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  // A final newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Compare two texts line by line, keeping the longest common subsequence;
 * within a change, removed lines come before the lines added in their place.
 * Common leading and trailing lines are matched first, so a local edit in a
 * long script costs little. Null when the differing middle is too large to
 * align (`DIFF_CELL_LIMIT`).
 */
export function lineDiff(before: string, after: string): IDiffLine[] | null {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const rows = endA - start;
  const columns = endB - start;
  if (rows * columns > DIFF_CELL_LIMIT) return null;
  // lengths[i][j]: common subsequence length of a[start+i..endA) and b[start+j..endB).
  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[start + i] === b[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const lines: IDiffLine[] = [];
  for (let k = 0; k < start; k++)
    lines.push({ kind: 'same', text: a[k], oldLine: k + 1, newLine: k + 1 });
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && a[start + i] === b[start + j]) {
      lines.push({
        kind: 'same',
        text: a[start + i],
        oldLine: start + i + 1,
        newLine: start + j + 1
      });
      i++;
      j++;
    } else if (
      j < columns &&
      (i === rows || lengths[i * width + j + 1] > lengths[(i + 1) * width + j])
    ) {
      lines.push({ kind: 'added', text: b[start + j], newLine: start + j + 1 });
      j++;
    } else {
      lines.push({
        kind: 'removed',
        text: a[start + i],
        oldLine: start + i + 1
      });
      i++;
    }
  }
  for (let k = 0; k < a.length - endA; k++)
    lines.push({
      kind: 'same',
      text: a[endA + k],
      oldLine: endA + k + 1,
      newLine: endB + k + 1
    });
  return lines;
}

/**
 * The changed lines with `context` unchanged lines around each change; the
 * unchanged runs between them collapse to gaps. Empty when nothing changed.
 */
export function diffHunks(
  lines: readonly IDiffLine[],
  context = 3
): (IDiffLine | IDiffGap)[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  });
  const shown: (IDiffLine | IDiffGap)[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) shown.push({ kind: 'gap', count: skipped });
      skipped = 0;
      shown.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped && shown.length) shown.push({ kind: 'gap', count: skipped });
  return shown;
}

/** How the packages locked for a run differ from those locked now. */
export interface IPackageChanges {
  added: ILockedPackage[];
  removed: ILockedPackage[];
  changed: { name: string; from: string | null; to: string | null }[];
}

/** Compare a run's locked packages with today's, by name. */
export function packageChanges(
  before: readonly ILockedPackage[],
  after: readonly ILockedPackage[]
): IPackageChanges {
  const earlier = new Map(before.map(item => [item.name, item.version]));
  const later = new Map(after.map(item => [item.name, item.version]));
  const changes: IPackageChanges = { added: [], removed: [], changed: [] };
  for (const item of after) {
    if (!earlier.has(item.name)) changes.added.push(item);
    else if (earlier.get(item.name) !== item.version)
      changes.changed.push({
        name: item.name,
        from: earlier.get(item.name) ?? null,
        to: item.version
      });
  }
  for (const item of before)
    if (!later.has(item.name)) changes.removed.push(item);
  return changes;
}
