/**
 * ── ⚠ "HOW LONG AGO", FOR A HEADER WITH ROOM FOR FOUR CHARACTERS ────────────────────────────────
 *
 * ⚠ IT ANSWERS THE QUESTION BEING ASKED, which is not "what time is it on this file" but "is what I am
 * looking at current". `14:32:07` requires the reader to know what time it is now and do the subtraction;
 * `2m ago` does not. The absolute time is in the caller's tooltip for the cases where it matters.
 *
 * ⚠ NO `Intl.RelativeTimeFormat`. It renders "2 minutes ago" — three times the width in a bar that already
 * truncates the filename, and this app pins its test locale (`LC_ALL=en_GB`) precisely because formatted
 * output that varies by environment is how a snapshot starts failing on somebody else's machine.
 *
 * ⚠ AND "just now" HAS A FLOOR OF TEN SECONDS rather than being second-by-second. A header that counts
 * upward every second draws the eye away from the file, and one second of precision answers nothing here.
 */
export function relativeTime(atMs: number, nowMs: number = Date.now()): string {
  const secondsAgo = Math.floor((nowMs - atMs) / 1000);

  /**
   * ⚠ A FUTURE STAMP IS NOT AN ERROR, and it happens: a clock stepped backwards by NTP, or a file copied
   * with its original timestamp from a machine minutes ahead. "just now" is the honest reading — the file is
   * not older than this session — where a negative number would look like a bug in the app.
   */
  if (secondsAgo < 10) return "just now";
  if (secondsAgo < 60) return `${secondsAgo}s ago`;

  const minutesAgo = Math.floor(secondsAgo / 60);
  if (minutesAgo < 60) return `${minutesAgo}m ago`;

  const hoursAgo = Math.floor(minutesAgo / 60);
  if (hoursAgo < 24) return `${hoursAgo}h ago`;

  const daysAgo = Math.floor(hoursAgo / 24);
  /** Past a week the age stops being the useful fact and the date does — the caller's tooltip has it. */
  return daysAgo < 7 ? `${daysAgo}d ago` : "over a week ago";
}
