import type { SurfaceKind } from '@astra-spec/ui/model';
import { isRecord } from '../api';
import { referenceKind } from '../element-reference';
import type { IComment, ICommentAnchor, ICommentTarget } from './comments-api';

/** The longest comment the server accepts. */
export const COMMENT_TEXT_LIMIT = 1000;
/** Characters of the text limit left before the counter appears. */
export const COMMENT_COUNTER_THRESHOLD = 100;
/** The metadata key under which comment IDs ride with a chat message. */
export const METADATA_KEY = 'lightcone';
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/** The glyph of a 1-based label: ①…⑩, then (11) and so on. */
export function labelGlyph(label: number): string {
  return Number.isInteger(label) && label >= 1 && label <= CIRCLED.length
    ? CIRCLED[label - 1]
    : `(${label})`;
}

/** A version whose parts are all unknown. */
export const NULL_VERSION: ICommentTarget['version'] = {
  commit: null,
  key: null,
  hash: null,
  label: null
};

/** Keep a percentage inside the image, with one decimal. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** A point anchor from percentages across and down an image. */
export function pointAnchor(x: number, y: number): ICommentAnchor {
  return { type: 'point', x: clampPercent(x), y: clampPercent(y) };
}

/** Shorten text to `limit` characters with an ellipsis. */
export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/** The record path, or the file name, a comment points at. */
export function targetName(target: ICommentTarget): string {
  if (target.kind === 'record' && target.record) {
    return target.record;
  }
  const local = target.path.slice(target.path.indexOf(':') + 1);
  return local.split('/').filter(Boolean).pop() ?? target.path;
}

/**
 * The ASTRA kind of the record a comment is on, for its kind mark; undefined
 * for comments on image files.
 */
export function targetKind(target: ICommentTarget): SurfaceKind | undefined {
  if (target.kind !== 'record' || !target.record) {
    return undefined;
  }
  return referenceKind(target.record);
}

/** Where inside its target a comment sits, in words. */
export function anchorSummary(anchor: ICommentAnchor): string {
  return `point at ${anchor.x}% across, ${anchor.y}% down`;
}

/** The first line of the comment, shortened for a chip. */
export function chipText(comment: Pick<IComment, 'text'>, limit = 40): string {
  const line = comment.text.split('\n').find(part => part.trim()) ?? '';
  return truncate(line, limit);
}

/** The full text and its target, for a chip's tooltip. */
export function chipTooltip(
  comment: Pick<IComment, 'text' | 'target'>
): string {
  return `${comment.text.trim()} · ${targetName(comment.target)}`;
}

/**
 * Whether two targets name the same thing, ignoring versions. A null
 * universe on either side matches any universe, so a comment made on the
 * project's default universe follows the record into a pinned view.
 */
export function sameTarget(a: ICommentTarget, b: ICommentTarget): boolean {
  return (
    a.kind === b.kind &&
    a.path === b.path &&
    a.record === b.record &&
    (a.universe === null || b.universe === null || a.universe === b.universe)
  );
}

/** The comment IDs a message carries, if any. */
export function commentIdsFromMetadata(metadata: unknown): string[] {
  if (!isRecord(metadata)) {
    return [];
  }
  const block = metadata[METADATA_KEY];
  if (!isRecord(block) || !Array.isArray(block.comments)) {
    return [];
  }
  return block.comments.filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
}

/** The `lightcone` metadata block with `comments` replaced. */
export function withCommentIds(
  metadata: unknown,
  ids: readonly string[]
): Record<string, unknown> {
  const existing =
    isRecord(metadata) && isRecord(metadata[METADATA_KEY])
      ? metadata[METADATA_KEY]
      : {};
  return { ...existing, comments: [...ids] };
}

/**
 * The record a record tab shows, as a comment target without a version.
 * The tab's identity is `[entrypoint, canonical target, universe]`, as stored by the record tab.
 */
export function elementTarget(element: {
  identity: string;
}): ICommentTarget | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(element.identity);
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !parsed[1]
  ) {
    return null;
  }
  const [path, target, universe] = parsed;
  return {
    kind: 'record',
    path,
    record: target,
    universe: typeof universe === 'string' ? universe : null,
    version: NULL_VERSION
  };
}
