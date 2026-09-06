interface IMatchOrigin {
  itemIndex: number;
  rawStart: number;
  rawEnd: number;
}

interface IQuoteMatch {
  origin: IMatchOrigin[];
  start: number;
  length: number;
  complete: boolean;
}

function normalizeChar(character: string): string {
  if (character === '\u00ad' || '-‐‑‒–—―'.includes(character)) return '';
  if ('‘’‚‛'.includes(character)) return "'";
  if ('“”„‟'.includes(character)) return '"';
  return character.toLowerCase();
}

function normalizeQuote(value: string): {
  aggressive: string;
  withSpaces: string;
} {
  let aggressive = '';
  let withSpaces = '';
  for (const character of value.normalize('NFKC')) {
    if (/\s/.test(character)) {
      if (withSpaces && !withSpaces.endsWith(' ')) withSpaces += ' ';
      continue;
    }
    const normalized = normalizeChar(character);
    if (!normalized) continue;
    aggressive += normalized;
    withSpaces += normalized;
  }
  return { aggressive, withSpaces: withSpaces.trim() };
}

/** Match a quoted passage across PDF text runs and typographic variants. */
export function findQuoteMatch(
  strings: string[],
  quote: string
): IQuoteMatch | undefined {
  let flat = '';
  const origin: IMatchOrigin[] = [];

  strings.forEach((raw, itemIndex) => {
    let rawIndex = 0;
    while (rawIndex < raw.length) {
      const codePoint = raw.codePointAt(rawIndex);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const rawStart = rawIndex;
      rawIndex += character.length;
      if (/\s/.test(character)) continue;
      for (const part of character.normalize('NFKC')) {
        const normalized = normalizeChar(part);
        if (!normalized) continue;
        flat += normalized;
        for (let index = 0; index < normalized.length; index += 1) {
          origin.push({ itemIndex, rawStart, rawEnd: rawIndex });
        }
      }
    }
  });

  const { aggressive, withSpaces } = normalizeQuote(quote);
  if (!aggressive) return undefined;
  const probes = [aggressive];
  const words = withSpaces.split(' ');
  while (words.length > 1) {
    words.pop();
    const probe = words.join('').trim();
    if (probe.length < 16) break;
    probes.push(probe);
  }

  for (const probe of probes) {
    const start = flat.indexOf(probe);
    if (start !== -1)
      return {
        origin,
        start,
        length: probe.length,
        complete: probe === aggressive
      };
  }
  return undefined;
}

/** Mark matched character ranges in a rendered PDF.js text layer. */
export function highlightMatch(
  strings: string[],
  textDivs: HTMLElement[],
  quote: string
): HTMLElement | undefined {
  const match = findQuoteMatch(strings, quote);
  if (!match) return undefined;
  const ranges = new Map<number, { rawStart: number; rawEnd: number }>();

  for (
    let index = match.start;
    index < match.start + match.length;
    index += 1
  ) {
    const item = match.origin[index];
    if (!item) continue;
    const range = ranges.get(item.itemIndex);
    if (!range) {
      ranges.set(item.itemIndex, {
        rawStart: item.rawStart,
        rawEnd: item.rawEnd
      });
    } else {
      range.rawStart = Math.min(range.rawStart, item.rawStart);
      range.rawEnd = Math.max(range.rawEnd, item.rawEnd);
    }
  }

  let firstMark: HTMLElement | undefined;
  for (const [itemIndex, range] of [...ranges.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    const textDiv = textDivs[itemIndex];
    const raw = strings[itemIndex] ?? '';
    if (!textDiv) continue;
    textDiv.replaceChildren();
    if (range.rawStart > 0)
      textDiv.append(document.createTextNode(raw.slice(0, range.rawStart)));
    const mark = document.createElement('mark');
    mark.className = 'jp-jupyterlab-lightcone-pdf-match';
    mark.textContent = raw.slice(range.rawStart, range.rawEnd);
    textDiv.append(mark);
    if (range.rawEnd < raw.length)
      textDiv.append(document.createTextNode(raw.slice(range.rawEnd)));
    firstMark ??= mark;
  }
  return firstMark;
}
