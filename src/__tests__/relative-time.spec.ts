import { relativeTime } from '../relative-time';

const HOUR = 3_600_000;
/** A time `ms` before now. */
const ago = (ms: number) => new Date(Date.now() - ms);

describe('relativeTime', () => {
  it('formats a time as a distance from now in the page language', () => {
    expect(relativeTime(ago(2 * HOUR).toISOString())).toBe('2 hours ago');
    expect(relativeTime(ago(2 * HOUR), 'narrow')).toBe('2h ago');
    expect(relativeTime(ago(24 * HOUR))).toBe('yesterday');
    expect(relativeTime(ago(0))).toBe('now');
  });

  it('leaves out a time that cannot be read', () => {
    expect(relativeTime('not a date')).toBe('');
    expect(relativeTime(new Date(NaN), 'narrow')).toBe('');
  });
});
