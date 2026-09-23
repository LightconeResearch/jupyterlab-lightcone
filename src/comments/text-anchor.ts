import type { ICommentAnchor } from './comments-api';
import { emptyAnchor, PREFIX_LIMIT, QUOTE_LIMIT } from './comment-model';

/**
 * The part of a document a text anchor needs; CodeMirror's `Text` satisfies
 * it directly.
 */
export interface ITextDocument {
  readonly length: number;
  lineAt(pos: number): { number: number; from: number };
  sliceString(from: number, to: number): string;
}

/** A span of raw character offsets, end exclusive. */
export interface ITextSpan {
  from: number;
  to: number;
}

/**
 * The anchor of a selection: 1-based lines and columns, the selected text
 * capped at the quote limit and the text just before it.
 */
export function textAnchorFromRange(
  doc: ITextDocument,
  from: number,
  to: number,
  type: 'text' | 'pdf' = 'text'
): ICommentAnchor {
  const start = Math.max(0, Math.min(from, to));
  const end = Math.min(doc.length, Math.max(from, to));
  const startLine = doc.lineAt(start);
  const endLine = doc.lineAt(end);
  const quote = doc.sliceString(start, Math.min(end, start + QUOTE_LIMIT));
  const prefix = doc.sliceString(Math.max(0, start - PREFIX_LIMIT), start);
  return {
    ...emptyAnchor(type),
    startLine: startLine.number,
    startCol: start - startLine.from + 1,
    endLine: endLine.number,
    endCol: end - endLine.from + 1,
    quote,
    prefix: prefix.length ? prefix : null
  };
}

/** Text with whitespace runs collapsed, and the raw index of each character. */
export interface INormalizedText {
  text: string;
  map: number[];
}

/**
 * Collapse whitespace runs to single spaces so rendered text and stored
 * quotes compare regardless of wrapping and indentation.
 */
export function normalizeForSearch(raw: string): INormalizedText {
  let text = '';
  const map: number[] = [];
  let inSpace = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (/\s/.test(char)) {
      if (!inSpace) {
        text += ' ';
        map.push(index);
        inSpace = true;
      }
      continue;
    }
    inSpace = false;
    text += char;
    map.push(index);
  }
  return { text, map };
}

function suffixOverlap(before: string, prefix: string): number {
  let count = 0;
  while (
    count < before.length &&
    count < prefix.length &&
    before[before.length - 1 - count] === prefix[prefix.length - 1 - count]
  ) {
    count++;
  }
  return count;
}

/**
 * Find a quote in text, preferring the occurrence whose preceding text
 * matches the stored prefix best. Returns raw offsets, or null.
 */
export function findQuote(
  raw: string,
  quote: string,
  prefix: string | null
): ITextSpan | null {
  return findQuoteIn(normalizeForSearch(raw), quote, prefix);
}

/**
 * `findQuote` over text normalized once by the caller, so that several
 * quotes can be looked up in one long text without normalizing it again.
 */
export function findQuoteIn(
  normalized: INormalizedText,
  quote: string,
  prefix: string | null
): ITextSpan | null {
  const needle = normalizeForSearch(quote).text.trim();
  if (!needle) {
    return null;
  }
  const { text, map } = normalized;
  const occurrences: number[] = [];
  let index = text.indexOf(needle);
  while (index >= 0 && occurrences.length < 200) {
    occurrences.push(index);
    index = text.indexOf(needle, index + 1);
  }
  if (!occurrences.length) {
    return null;
  }
  let best = occurrences[0];
  if (occurrences.length > 1 && prefix) {
    const wanted = normalizeForSearch(prefix).text.trimEnd();
    let score = -1;
    for (const candidate of occurrences) {
      const overlap = suffixOverlap(text.slice(0, candidate).trimEnd(), wanted);
      if (overlap > score) {
        score = overlap;
        best = candidate;
      }
    }
  }
  const last = best + needle.length - 1;
  return { from: map[best], to: map[last] + 1 };
}

/** Texts longer than this are not searched for quotes. */
export const SEARCH_LIMIT = 2_000_000;

/**
 * Where a text anchor sits in a document now: its recorded position when the
 * quote is still there, else the best occurrence of the quote.
 */
export function locateAnchor(
  doc: ITextDocument,
  anchor: ICommentAnchor
): ITextSpan | null {
  if (!anchor.quote) {
    return null;
  }
  if (anchor.startLine !== null && anchor.startCol !== null) {
    const lineCount = doc.lineAt(doc.length).number;
    if (anchor.startLine >= 1 && anchor.startLine <= lineCount) {
      const line = lineStart(doc, anchor.startLine);
      const from = line + anchor.startCol - 1;
      const to = from + anchor.quote.length;
      if (to <= doc.length && doc.sliceString(from, to) === anchor.quote) {
        return { from, to };
      }
    }
  }
  if (doc.length > SEARCH_LIMIT) {
    return null;
  }
  return findQuote(doc.sliceString(0, doc.length), anchor.quote, anchor.prefix);
}

function lineStart(doc: ITextDocument, number: number): number {
  // Binary search on positions: lineAt is monotonic in its argument.
  let low = 0;
  let high = doc.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (doc.lineAt(middle).number < number) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return doc.lineAt(low).from;
}
