import type { OutputRun } from '@astra-spec/ui/model';
import { runView, sandboxLine } from '../version-model';
import type { ResolvedOutput } from '@astra-spec/sdk';
import {
  versionPosition,
  stepVersion,
  formatBytes,
  outputFormat,
  isImageFormat,
  delimiterFor
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
    subject: 'materialize fit',
    size: null,
    present: true,
    annex: null,
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

  it('formats sizes', () => {
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
      recipe: 'python fit.py --robust',
      gitRevision: 'def456',
      engineVersion: '0.6',
      environmentVersion: 'sha256:newenv',
      uvVersion: '0.8.1',
      image: 'ghcr.io/x:1',
      sandbox: 'backend: landlock · network: false',
      inputVersions: { catalog: 'sha256:input2' },
      decisions: { method: 'robust' }
    });
  });

  it('falls back to the sidecar, and to nothing when neither exists', () => {
    expect(runView(record, undefined)).toMatchObject({
      source: 'record',
      time: record.finishedAt,
      recipe: record.recipe,
      gitRevision: 'abc123',
      engineVersion: '0.5',
      environmentVersion: 'sha256:env',
      inputVersions: { catalog: 'sha256:input' }
    });
    expect(runView(null, undefined)).toBeUndefined();
    expect(sandboxLine({ hermeticity: 'seatbelt' })).toBe('seatbelt');
    expect(sandboxLine({})).toBeUndefined();
  });

  it('never attributes the current sidecar to a version without a manifest', () => {
    const older = version('a'.repeat(40), '2026-09-01T10:00:00Z');
    const view = runView(record, older)!;
    expect(view).toMatchObject({
      source: 'version',
      short: 'aaaaaaa',
      time: '2026-09-01T10:00:00Z',
      inputVersions: {}
    });
    expect(view.gitRevision).toBeUndefined();
    expect(view.recipe).toBeUndefined();
    expect(view.engineVersion).toBeUndefined();
    expect(view.environmentVersion).toBeUndefined();
    const bare = runView(
      record,
      version('b'.repeat(40), '2026-09-02T10:00:00Z')
    )!;
    expect(bare.recipe).toBeUndefined();
    expect(bare.time).toBe('2026-09-02T10:00:00Z');
  });
});
