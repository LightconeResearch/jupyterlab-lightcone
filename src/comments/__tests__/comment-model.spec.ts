import type { IComment, ICommentTarget } from '../comments-api';
import {
  anchorSummary,
  chipText,
  chipTooltip,
  clampPercent,
  commentIdsFromMetadata,
  commentKind,
  elementTarget,
  emptyAnchor,
  labelGlyph,
  NULL_VERSION,
  paperDoi,
  paperRecord,
  pointAnchor,
  sameTarget,
  targetKind,
  targetName,
  truncate,
  withCommentIds
} from '../comment-model';

const record: ICommentTarget = {
  kind: 'record',
  path: 'project/astra.yaml',
  record: 'outputs.hubble_diagram',
  universe: null,
  message: null,
  version: NULL_VERSION
};

function comment(overrides: Partial<IComment> = {}): IComment {
  return {
    id: 'c1',
    created: '2026-09-23T10:00:00Z',
    updated: null,
    author: 'francois',
    status: 'pending',
    sentWith: null,
    label: 1,
    text: 'The legend covers the high-redshift points.',
    target: record,
    anchor: pointAnchor(42, 31),
    ...overrides
  };
}

describe('labels', () => {
  it('uses circled digits up to ten, then parentheses', () => {
    expect(labelGlyph(1)).toBe('①');
    expect(labelGlyph(10)).toBe('⑩');
    expect(labelGlyph(11)).toBe('(11)');
    expect(labelGlyph(0)).toBe('(0)');
  });
});

describe('anchors', () => {
  it('keeps points inside the image with one decimal', () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(42.345)).toBe(42.3);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(pointAnchor(42.36, 31)).toMatchObject({
      type: 'point',
      x: 42.4,
      y: 31,
      quote: null,
      page: null
    });
  });

  it('describes where a comment sits', () => {
    expect(anchorSummary(pointAnchor(42, 31))).toBe(
      'point at 42% across, 31% down'
    );
    expect(
      anchorSummary({
        ...emptyAnchor('text'),
        startLine: 12,
        endLine: 13,
        quote: 'The analysis specification records the'
      })
    ).toBe('lines 12–13, quoting “The analysis specification records the”');
    expect(
      anchorSummary({ ...emptyAnchor('text'), startLine: 4, endLine: 4 })
    ).toBe('line 4');
    expect(
      anchorSummary({ ...emptyAnchor('pdf'), page: 3, quote: 'x'.repeat(80) })
    ).toBe(`page 3, quoting “${'x'.repeat(59)}…”`);
    expect(anchorSummary(emptyAnchor('text'))).toBe('');
  });

  it('maps anchor types to kinds', () => {
    expect(commentKind(comment())).toBe('image');
    expect(commentKind(comment({ anchor: emptyAnchor('pdf') }))).toBe('pdf');
    expect(commentKind(comment({ anchor: emptyAnchor('text') }))).toBe('text');
  });
});

describe('chips', () => {
  it('shows the first line, shortened', () => {
    expect(chipText(comment())).toBe(
      'The legend covers the high-redshift poi…'
    );
    expect(chipText(comment({ text: '\n\n  second line first  \nmore' }))).toBe(
      'second line first'
    );
    expect(truncate('  short  ', 40)).toBe('short');
  });

  it('names the target in the tooltip', () => {
    expect(chipTooltip(comment())).toBe(
      'The legend covers the high-redshift points. · outputs.hubble_diagram'
    );
    expect(
      targetName({
        ...record,
        kind: 'file',
        record: null,
        path: 'drive:a/b.md'
      })
    ).toBe('b.md');
    expect(
      targetName({ ...record, kind: 'message', record: null, message: 'm1' })
    ).toBe('session message');
  });
});

describe('targets', () => {
  it('matches targets regardless of version, with a wildcard universe', () => {
    expect(sameTarget(record, { ...record, universe: 'baseline' })).toBe(true);
    expect(
      sameTarget(
        { ...record, universe: 'alt' },
        { ...record, universe: 'baseline' }
      )
    ).toBe(false);
    expect(sameTarget(record, { ...record, record: 'outputs.other' })).toBe(
      false
    );
    expect(
      sameTarget(record, {
        ...record,
        version: { commit: 'abc', key: null, hash: null, label: 'abc' }
      })
    ).toBe(true);
  });

  it('reads a record tab identity', () => {
    expect(
      elementTarget({
        identity: JSON.stringify([
          'project/astra.yaml',
          'outputs.hubble_diagram',
          'baseline'
        ])
      })
    ).toEqual({ ...record, universe: 'baseline' });
    expect(
      elementTarget({
        identity: JSON.stringify(['project/astra.yaml', 'doi:10.1/x', null])
      })
    ).toMatchObject({ record: 'papers.10.1/x', universe: null });
    expect(elementTarget({ identity: 'not json' })).toBeNull();
    expect(elementTarget({ identity: JSON.stringify(['a', '']) })).toBeNull();
    expect(elementTarget({ identity: JSON.stringify({}) })).toBeNull();
  });

  it('round-trips paper records', () => {
    expect(paperRecord('10.1/x')).toBe('papers.10.1/x');
    expect(paperDoi('papers.10.1/x')).toBe('10.1/x');
    expect(paperDoi('outputs.a')).toBeUndefined();
    expect(paperDoi(null)).toBeUndefined();
  });
});

describe('message metadata', () => {
  it('reads comment ids only from a well-formed block', () => {
    expect(
      commentIdsFromMetadata({ lightcone: { comments: ['a', 'b', ''] } })
    ).toEqual(['a', 'b']);
    expect(commentIdsFromMetadata({ lightcone: { comments: 'a' } })).toEqual(
      []
    );
    expect(commentIdsFromMetadata({ lightcone: { comments: [1] } })).toEqual(
      []
    );
    expect(commentIdsFromMetadata(undefined)).toEqual([]);
    expect(commentIdsFromMetadata({})).toEqual([]);
  });

  it('keeps the rest of the block when stamping ids', () => {
    expect(
      withCommentIds({ lightcone: { other: 1, comments: ['x'] } }, ['a'])
    ).toEqual({ other: 1, comments: ['a'] });
    expect(withCommentIds(undefined, [])).toEqual({ comments: [] });
  });
});

describe('targetKind', () => {
  it('names the ASTRA kind of a record target, and nothing for others', () => {
    expect(targetKind(record)).toBe('output');
    expect(targetKind({ ...record, record: 'sub.decisions.model' })).toBe(
      'decision'
    );
    expect(targetKind({ ...record, record: paperRecord('10.1/x.y') })).toBe(
      'paper'
    );
    expect(
      targetKind({ ...record, kind: 'file', path: 'notes.md', record: null })
    ).toBeUndefined();
    expect(
      targetKind({ ...record, kind: 'message', record: null, message: 'm1' })
    ).toBeUndefined();
  });
});
