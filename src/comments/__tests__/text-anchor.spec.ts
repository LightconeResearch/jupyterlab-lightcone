import { Text } from '@codemirror/state';
import { emptyAnchor } from '../comment-model';
import {
  findQuote,
  locateAnchor,
  normalizeForSearch,
  stringDocument,
  textAnchorFromRange
} from '../text-anchor';

const source = [
  '# Title',
  '',
  'The analysis specification records the magnitude offset.',
  'It is profiled, not fixed.'
].join('\n');

describe('documents', () => {
  it('numbers lines from one in a plain string', () => {
    const doc = stringDocument(source);
    expect(doc.length).toBe(source.length);
    expect(doc.lineAt(0)).toEqual({ number: 1, from: 0 });
    expect(doc.lineAt(8)).toEqual({ number: 2, from: 8 });
    expect(doc.lineAt(9)).toEqual({ number: 3, from: 9 });
    expect(doc.lineAt(source.length)).toEqual({
      number: 4,
      from: source.lastIndexOf('\n') + 1
    });
    expect(doc.sliceString(2, 7)).toBe('Title');
  });

  it('agrees with CodeMirror text', () => {
    const cm = Text.of(source.split('\n'));
    const plain = stringDocument(source);
    for (const pos of [0, 7, 8, 9, 30, source.length]) {
      expect(plain.lineAt(pos)).toEqual({
        number: cm.lineAt(pos).number,
        from: cm.lineAt(pos).from
      });
    }
  });
});

describe('selection anchors', () => {
  it('records 1-based lines and columns, the quote and its prefix', () => {
    const from = source.indexOf('magnitude');
    const to = source.indexOf('fixed') + 'fixed'.length;
    const anchor = textAnchorFromRange(Text.of(source.split('\n')), from, to);
    expect(anchor).toMatchObject({
      type: 'text',
      startLine: 3,
      startCol: 'The analysis specification records the '.length + 1,
      endLine: 4,
      endCol: 'It is profiled, not fixed'.length + 1,
      quote: 'magnitude offset.\nIt is profiled, not fixed',
      x: null,
      page: null
    });
    expect(anchor.prefix).toBe(
      '# Title\n\nThe analysis specification records the '
    );
  });

  it('caps the quote and prefix and accepts reversed ranges', () => {
    const long = 'a'.repeat(500) + ' quote ' + 'b'.repeat(500);
    const start = long.indexOf('quote');
    const anchor = textAnchorFromRange(
      stringDocument(long),
      long.length,
      start
    );
    expect(anchor.quote).toHaveLength(300);
    expect(anchor.quote?.startsWith('quote ')).toBe(true);
    expect(anchor.prefix).toBe(`${'a'.repeat(99)} `);
    expect(textAnchorFromRange(stringDocument('abc'), 0, 2).prefix).toBeNull();
    expect(textAnchorFromRange(stringDocument('abc'), 0, 2, 'pdf').type).toBe(
      'pdf'
    );
  });
});

describe('quote search', () => {
  it('collapses whitespace while keeping raw offsets', () => {
    const { text, map } = normalizeForSearch('a  b\n\tc');
    expect(text).toBe('a b c');
    expect(map).toEqual([0, 1, 3, 4, 6]);
  });

  it('finds a quote across wrapped whitespace', () => {
    const raw = 'The  analysis\n  specification records';
    expect(findQuote(raw, 'analysis specification', null)).toEqual({
      from: 5,
      to: raw.indexOf('specification') + 'specification'.length
    });
  });

  it('prefers the occurrence after the stored prefix', () => {
    const raw = 'alpha value beta value gamma value';
    expect(findQuote(raw, 'value', 'beta ')).toEqual({ from: 17, to: 22 });
    expect(findQuote(raw, 'value', 'gamma ')).toEqual({ from: 29, to: 34 });
    expect(findQuote(raw, 'value', null)).toEqual({ from: 6, to: 11 });
    expect(findQuote(raw, 'value', 'nothing like it')).toEqual({
      from: 6,
      to: 11
    });
  });

  it('gives up on missing or empty quotes', () => {
    expect(findQuote('some text', 'absent', null)).toBeNull();
    expect(findQuote('some text', '   ', null)).toBeNull();
  });
});

describe('locating anchors', () => {
  const anchor = {
    ...emptyAnchor('text'),
    startLine: 3,
    startCol: 5,
    endLine: 3,
    endCol: 13,
    quote: 'analysis',
    prefix: 'The '
  };

  it('uses the recorded position while the quote is still there', () => {
    const doc = stringDocument(source);
    expect(locateAnchor(doc, anchor)).toEqual({
      from: source.indexOf('analysis'),
      to: source.indexOf('analysis') + 'analysis'.length
    });
  });

  it('falls back to searching when the text moved', () => {
    const moved = `intro line\n${source}`;
    expect(locateAnchor(stringDocument(moved), anchor)).toEqual({
      from: moved.indexOf('analysis'),
      to: moved.indexOf('analysis') + 'analysis'.length
    });
    expect(locateAnchor(stringDocument('nothing here'), anchor)).toBeNull();
    expect(
      locateAnchor(stringDocument(source), { ...anchor, quote: null })
    ).toBeNull();
    expect(
      locateAnchor(stringDocument(source), { ...anchor, startLine: 99 })
    ).toEqual({
      from: source.indexOf('analysis'),
      to: source.indexOf('analysis') + 'analysis'.length
    });
  });
});
