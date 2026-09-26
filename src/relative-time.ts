import { Time } from '@jupyterlab/coreutils';

/**
 * A time as a distance from now, in the page's language: "2 hours ago",
 * "yesterday", or "2h ago" in the narrow style list rows use. An unparsable
 * time gives an empty string, which callers leave out of their lines.
 */
export function relativeTime(
  time: string | Date,
  style: Time.HumanStyle = 'long'
): string {
  const value = typeof time === 'string' ? new Date(time) : time;
  if (Number.isNaN(value.getTime())) {
    return '';
  }
  return Time.formatHuman(value, style);
}
