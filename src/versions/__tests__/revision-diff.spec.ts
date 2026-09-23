import {
  DIFF_CELL_LIMIT,
  diffHunks,
  lineDiff,
  packageChanges
} from '../revision-diff';

describe('lineDiff', () => {
  it('keeps common lines and marks removals and additions', () => {
    const lines = lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')!;
    expect(lines.map(line => `${line.kind[0]} ${line.text}`)).toEqual([
      's a',
      'r b',
      'a B',
      's c',
      'a d'
    ]);
    expect(lines[0]).toEqual({
      kind: 'same',
      text: 'a',
      oldLine: 1,
      newLine: 1
    });
    expect(lines[2]).toEqual({ kind: 'added', text: 'B', newLine: 2 });
    expect(lines[3]).toEqual({
      kind: 'same',
      text: 'c',
      oldLine: 3,
      newLine: 3
    });
    expect(lines[4]).toEqual({ kind: 'added', text: 'd', newLine: 4 });
  });

  it('treats identical texts, CRLF endings and empty texts plainly', () => {
    expect(lineDiff('x\r\ny\r\n', 'x\ny')!.every(l => l.kind === 'same')).toBe(
      true
    );
    expect(lineDiff('', '')).toEqual([]);
    expect(lineDiff('', 'new\n')).toEqual([
      { kind: 'added', text: 'new', newLine: 1 }
    ]);
    expect(lineDiff('old', '')).toEqual([
      { kind: 'removed', text: 'old', oldLine: 1 }
    ]);
  });

  it('refuses to align a middle section beyond the limit', () => {
    const size = Math.ceil(Math.sqrt(DIFF_CELL_LIMIT)) + 1;
    const before = Array.from({ length: size }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: size }, (_, i) => `b${i}`).join('\n');
    expect(lineDiff(before, after)).toBeNull();
    // A small edit inside a long text stays cheap.
    const long = Array.from({ length: size * 2 }, (_, i) => `l${i}`);
    const edited = [...long];
    edited[size] = 'changed';
    expect(lineDiff(long.join('\n'), edited.join('\n'))).not.toBeNull();
  });
});

describe('diffHunks', () => {
  it('keeps context around changes and collapses the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = 'changed';
    const hunks = diffHunks(lineDiff(before.join('\n'), after.join('\n'))!, 2);
    expect(hunks[0]).toEqual({ kind: 'gap', count: 8 });
    expect(hunks.filter(line => line.kind !== 'gap')).toHaveLength(6);
    expect(hunks[hunks.length - 1]).toEqual({ kind: 'gap', count: 7 });
    expect(diffHunks(lineDiff('same', 'same')!)).toEqual([]);
  });
});

describe('packageChanges', () => {
  it('names added, removed and changed packages', () => {
    expect(
      packageChanges(
        [
          { name: 'numpy', version: '2.1.0' },
          { name: 'scipy', version: '1.0' },
          { name: 'proj', version: null }
        ],
        [
          { name: 'numpy', version: '2.2.0' },
          { name: 'astropy', version: '6.0' },
          { name: 'proj', version: null }
        ]
      )
    ).toEqual({
      added: [{ name: 'astropy', version: '6.0' }],
      removed: [{ name: 'scipy', version: '1.0' }],
      changed: [{ name: 'numpy', from: '2.1.0', to: '2.2.0' }]
    });
  });
});
