import type { ResolvedOutput } from '@astra-spec/sdk';
import type { OutputRun } from '@astra-spec/ui/model';
import {
  delimiterFor,
  formatBytes,
  formatNumber,
  isImageFormat,
  METRIC_LEAF_LIMIT,
  metricDeltas,
  outputFormat,
  relativeTime,
  runView,
  sandboxLine,
  stepVersion,
  tableShape,
  tableShapeDiff,
  tableShapeFromRows,
  versionPosition
} from '../version-model';
import type { IOutputVersion } from '../versions-api';

function version(
  commit: string,
  time: string,
  extra: Partial<IOutputVersion> = {}
): IOutputVersion {
  return {
    commit,
    short: commit.slice(0, 7),
    time,
    subject: `[DATALAD RUNCMD] fit [baseline]`,
    key: null,
    size: null,
    present: true,
    run: null,
    manifest: null,
    ...extra
  };
}

const versions = [
  version('c'.repeat(40), '2026-09-20T10:00:00Z'),
  version('b'.repeat(40), '2026-09-18T10:00:00Z'),
  version('a'.repeat(40), '2026-09-15T10:00:00Z')
];

describe('version stepper', () => {
  it('positions a commit in a newest-first history and steps through it', () => {
    expect(versionPosition(versions, undefined)).toEqual({
      index: 0,
      ordinal: 3,
      total: 3
    });
    expect(versionPosition(versions, 'a'.repeat(7))).toEqual({
      index: 2,
      ordinal: 1,
      total: 3
    });
    expect(versionPosition(versions, 'z'.repeat(7))).toBeUndefined();
    expect(versionPosition([], undefined)).toBeUndefined();
    expect(stepVersion(versions, undefined, -1)).toBe('b'.repeat(40));
    expect(stepVersion(versions, undefined, +1)).toBeUndefined();
    expect(stepVersion(versions, 'b'.repeat(40), +1)).toBe('c'.repeat(40));
    expect(stepVersion(versions, 'a'.repeat(40), -1)).toBeUndefined();
    expect(stepVersion(versions, 'a'.repeat(40), 2)).toBe('c'.repeat(40));
    expect(stepVersion(versions, 'z'.repeat(40), -1)).toBeUndefined();
    expect(stepVersion(versions, undefined, 0)).toBeUndefined();
  });

  it('formats relative times and sizes', () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    expect(relativeTime('2026-09-22T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-09-22T11:55:00Z', now)).toBe('5 minutes ago');
    expect(relativeTime('2026-09-22T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime('2026-09-20T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime('2026-08-22T12:00:00Z', now)).toBe('1 month ago');
    expect(relativeTime('2026-09-22T13:00:00Z', now)).toBe('in 1 hour');
    expect(relativeTime('not a date', now)).toBe('not a date');
    expect(formatBytes(null)).toBe('unknown size');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(208_410)).toBe('208 kB');
    expect(formatBytes(1_234_567)).toBe('1.2 MB');
  });

  it('classifies artifact formats', () => {
    const output = (format?: string) =>
      ({ format }) as unknown as Pick<ResolvedOutput, 'format'>;
    expect(outputFormat(output('.PNG'))).toBe('png');
    expect(outputFormat(output(undefined))).toBe('');
    expect(isImageFormat('svg')).toBe(true);
    expect(isImageFormat('csv')).toBe(false);
    expect(delimiterFor('tsv')).toBe('\t');
    expect(delimiterFor('json')).toBeUndefined();
  });
});

describe('metric deltas', () => {
  it('compares numeric leaves of scalars and nested documents', () => {
    expect(metricDeltas(1, 1.5)).toEqual({
      deltas: [{ key: 'value', older: 1, newer: 1.5, delta: 0.5 }],
      truncated: false
    });
    expect(
      metricDeltas(
        { value: 0.3, uncertainty: 0.05, unit: 'mag', nested: { a: 1 } },
        { value: 0.31, uncertainty: 0.05, nested: { a: 2, b: 3 }, list: [4] }
      ).deltas
    ).toEqual([
      { key: 'value', older: 0.3, newer: 0.31, delta: expect.closeTo(0.01) },
      { key: 'uncertainty', older: 0.05, newer: 0.05, delta: 0 },
      { key: 'nested.a', older: 1, newer: 2, delta: 1 },
      { key: 'nested.b', older: undefined, newer: 3, delta: undefined },
      { key: 'list.0', older: undefined, newer: 4, delta: undefined }
    ]);
    expect(metricDeltas({ value: '12.5' }, { value: 'text' }).deltas).toEqual([
      { key: 'value', older: 12.5, newer: undefined, delta: undefined }
    ]);
    expect(metricDeltas(null, 'abc')).toEqual({ deltas: [], truncated: false });
  });

  it('reads a bounded number of leaves from a large document, promptly', () => {
    // A JSON artifact near the 2 MB preview limit holds ~100k numbers.
    const older = Array.from({ length: 100_000 }, (_, index) => index);
    const newer = { rows: older.map(value => ({ x: value + 1 })) };
    const started = Date.now();
    const result = metricDeltas(older, newer);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.truncated).toBe(true);
    expect(result.deltas).toHaveLength(2 * METRIC_LEAF_LIMIT);
    expect(result.deltas[0]).toEqual({
      key: 'rows.0.x',
      older: undefined,
      newer: 1,
      delta: undefined
    });
    const small = metricDeltas([1, 2, 3], [1, 2, 4], 2);
    expect(small.truncated).toBe(true);
    expect(small.deltas.map(delta => delta.key)).toEqual(['0', '1']);
  });

  it('formats numbers for reading', () => {
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(42)).toBe('42');
    expect(formatNumber(0.123456789)).toBe('0.123457');
    expect(formatNumber(1.5e-7)).toBe('1.500e-7');
  });
});

describe('table shapes', () => {
  it('counts rows and columns, honoring quotes and cut-off samples', () => {
    const csv = 'name,"value, raw",note\na,1,x\nb,2,"y, z"\n';
    expect(tableShape(csv, ',')).toEqual({
      headers: ['name', 'value, raw', 'note'],
      rows: 2,
      truncated: false
    });
    // A sample cut in the middle of a record loses that record.
    expect(tableShape('a,b\n1,2\n3,', ',', true).rows).toBe(1);
    expect(tableShape('', ',')).toEqual({
      headers: [],
      rows: 0,
      truncated: false
    });
  });

  it('reads the shape of a JSON array of rows', () => {
    expect(
      tableShapeFromRows([
        { z: 1, redshift: 0.1 },
        { z: 2, mu: 35.2 }
      ])
    ).toEqual({ headers: ['z', 'redshift', 'mu'], rows: 2, truncated: false });
    expect(tableShapeFromRows([])).toEqual({
      headers: [],
      rows: 0,
      truncated: false
    });
    expect(tableShapeFromRows({ value: 1 })).toBeUndefined();
    expect(tableShapeFromRows([1, 2])).toBeUndefined();
  });

  it('reports added, removed and reordered columns and the row delta', () => {
    const older = tableShape('a,b,c\n1,2,3\n', ',');
    const newer = tableShape('a,c,d\n1,3,4\n5,6,7\n', ',');
    const diff = tableShapeDiff(older, newer);
    expect(diff.addedColumns).toEqual(['d']);
    expect(diff.removedColumns).toEqual(['b']);
    expect(diff.reordered).toBe(false);
    expect(diff.rowDelta).toBe(1);
    expect(
      tableShapeDiff(older, tableShape('c,b,a\n1,2,3\n', ',')).reordered
    ).toBe(true);
  });
});

describe('run view', () => {
  const record: OutputRun = {
    finishedAt: '2026-09-15T10:00:00Z',
    gitRevision: 'abc123',
    recipe: 'python fit.py',
    environment: 'sha256:env',
    cliVersion: '0.5',
    inputVersions: { catalog: 'sha256:input' }
  };

  it('prefers a committed version and its manifest over the current sidecar', () => {
    const committed = version('c'.repeat(40), '2026-09-20T10:00:00Z', {
      run: {
        cmd: 'uv run fit.py',
        exit: 0,
        inputs: ['data/x.csv'],
        outputs: ['results/baseline/fit.json']
      },
      manifest: {
        finished_at: '2026-09-20T09:59:00Z',
        started_at: '2026-09-20T09:58:00Z',
        git_sha: 'def456',
        lc_version: '0.6',
        env_version: 'sha256:newenv',
        recipe: 'python fit.py --robust',
        uv_version: '0.8.1',
        image: { tag: 'ghcr.io/x:1' },
        hermeticity: { backend: 'landlock', network: false },
        input_versions: { catalog: 'sha256:input2', other: 7 },
        decisions: { method: 'robust' }
      }
    });
    const view = runView(record, committed)!;
    expect(view).toMatchObject({
      source: 'version',
      short: 'ccccccc',
      time: '2026-09-20T09:59:00Z',
      started: '2026-09-20T09:58:00Z',
      command: 'uv run fit.py',
      recipe: 'python fit.py --robust',
      exit: 0,
      gitRevision: 'def456',
      engineVersion: '0.6',
      environmentVersion: 'sha256:newenv',
      uvVersion: '0.8.1',
      image: 'ghcr.io/x:1',
      sandbox: 'backend: landlock · network: false',
      inputVersions: { catalog: 'sha256:input2' },
      decisions: { method: 'robust' },
      inputs: ['data/x.csv']
    });
  });

  it('falls back to the sidecar, and to nothing when neither exists', () => {
    expect(runView(record, undefined)).toMatchObject({
      source: 'record',
      time: record.finishedAt,
      command: record.recipe,
      recipe: record.recipe,
      gitRevision: 'abc123',
      engineVersion: '0.5',
      environmentVersion: 'sha256:env',
      inputVersions: { catalog: 'sha256:input' },
      exit: undefined
    });
    expect(runView(null, undefined)).toBeUndefined();
    expect(sandboxLine({ hermeticity: 'seatbelt' })).toBe('seatbelt');
    expect(sandboxLine({})).toBeUndefined();
  });

  it('never attributes the current sidecar to a version without a manifest', () => {
    const older = version('a'.repeat(40), '2026-09-01T10:00:00Z', {
      run: {
        cmd: 'python fit_v1.py',
        exit: 0,
        inputs: ['data/x.csv'],
        outputs: []
      }
    });
    const view = runView(record, older)!;
    expect(view).toMatchObject({
      source: 'version',
      short: 'aaaaaaa',
      time: '2026-09-01T10:00:00Z',
      command: 'python fit_v1.py',
      exit: 0,
      inputVersions: {},
      inputs: ['data/x.csv']
    });
    expect(view.gitRevision).toBeUndefined();
    expect(view.recipe).toBeUndefined();
    expect(view.engineVersion).toBeUndefined();
    expect(view.environmentVersion).toBeUndefined();
    const bare = runView(
      record,
      version('b'.repeat(40), '2026-09-02T10:00:00Z')
    )!;
    expect(bare.command).toBeUndefined();
    expect(bare.time).toBe('2026-09-02T10:00:00Z');
  });
});
