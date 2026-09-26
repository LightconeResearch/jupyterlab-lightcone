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
