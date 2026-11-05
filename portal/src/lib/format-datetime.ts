/**
 * Human-readable instants for lists an administrator reads, and the one invitation
 * label that depends on the clock.
 *
 * Its own module, and pure, for two reasons: every function here is unit-testable
 * without a DOM, and none of them may read an ambient clock or an ambient locale, see
 * the hydration note on formatInstantUtc below.
 */

/**
 * Month abbreviations, spelled out rather than obtained from Intl.
 *
 * NOT a localisation shortcut, a deliberate refusal to use Intl here. See
 * formatInstantUtc: the whole point of this module is that the same input produces the
 * same STRING in Node and in the browser, and Intl's output is a function of the
 * runtime's ICU build (month abbreviations, separators, and even which space character
 * sits before an hour have all changed between ICU versions). A three-letter English
 * month is the price of a value that cannot differ between the server render and the
 * hydration render.
 */
const MONTHS_UTC = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * An ISO-8601 instant as `01 Aug 2026 20:47 UTC`, or `""` when there is nothing to say.
 *
 * WHY UTC AND A HAND-ROLLED FORMAT, RATHER THAN toLocaleString(). Every screen that
 * renders this is a client component, so React evaluates it TWICE, once on the server
 * during prerender and once in the browser at hydration, and the two runtimes disagree
 * about both the timezone (the server is UTC, the operator is not) and the exact glyphs
 * Intl emits. React reports that disagreement as a hydration mismatch: a console error
 * and a re-render of the subtree. This is the same trap SiteFooter.tsx documents on
 * BRAND_YEAR, and the same discipline applied to a harder case, a fixed timezone AND a
 * fixed month table, so the string is a pure function of its input and nothing else.
 *
 * THE COST, STATED PLAINLY: the operator reads UTC, not their own wall clock. That is
 * why the zone is PRINTED rather than implied. A time with no zone on it is the actual
 * hazard here, "sent 20:47" is unreadable to someone in another region and unanswerable
 * to someone deciding whether a 24-hour invite link has lapsed. Callers should also put
 * the raw ISO value on the element (`dateTime` / `title`) so full precision stays
 * recoverable.
 *
 * FIXED WIDTH ON PURPOSE. The day is zero-padded and the hour and minute are
 * two-digit, so every rendered value is exactly the same number of characters and a
 * column of rows does not shift horizontally as the values differ.
 *
 * DEGRADES TO "" RATHER THAN "Invalid Date". `sentAt` is `""` for rows the tRPC mapper
 * defaulted and absent entirely on rows written before the field existed, and an
 * unparseable value is possible from any store. All three are "we do not know when",
 * which callers should render as nothing at all, printing "Invalid Date" next to a
 * real invitation makes a data gap look like a bug in the invitation.
 */
export function formatInstantUtc(iso: string | null | undefined): string {
  if (!iso) return "";

  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";

  const at = new Date(ms);

  // getUTC* rather than the local-time getters: these are the only Date accessors with
  // no dependency on the host timezone, which is what makes the output identical on the
  // server and in the browser.
  const day = String(at.getUTCDate()).padStart(2, "0");
  const month = MONTHS_UTC[at.getUTCMonth()];
  const year = at.getUTCFullYear();
  const hour = String(at.getUTCHours()).padStart(2, "0");
  const minute = String(at.getUTCMinutes()).padStart(2, "0");

  return `${day} ${month} ${year} ${hour}:${minute} UTC`;
}

/** The shape invitationStatusLabel needs, a subset of a listed invitation row. */
export interface InvitationTiming {
  status: string;
  expiresAt?: string;
}

/**
 * "Pending" / "Expired, send another" / "Accepted" for an invitation row.
 *
 * Moved here from app/admin/page.tsx unchanged in behaviour, so it can be tested
 * without rendering the screen, and so the clock it depends on is an ARGUMENT rather
 * than an ambient read. `now` is passed in for the same reason formatInstantUtc fixes
 * its timezone: a `Date.now()` buried in a component renders one answer on the server
 * and a different one in the browser, and "Pending" prerendered over an invitation that
 * has since lapsed is the version of this bug that misleads rather than merely warning.
 *
 * A row stays PENDING in the table after its link lapses, expiry is enforced at
 * sign-up (the Cognito pre-signup trigger refuses a lapsed invitation), not by a
 * sweep that rewrites status. So a list showing the raw status would tell a
 * facilitator someone is still able to register when they aren't, and the fix
 * ("send another") is invisible. Rows minted before expiry existed have no
 * expiresAt and never lapse, reported as Pending, which is the truth for them.
 *
 * An UNPARSEABLE expiresAt reports Pending rather than Expired: NaN comparisons are
 * false either way, and the safe direction for a garbled field is to leave the row
 * actionable (its Revoke control stays available) instead of telling an administrator a
 * live invitation is dead.
 */
export function invitationStatusLabel(
  inv: InvitationTiming,
  now: number
): string {
  if (inv.status === "Accepted") return "Accepted";
  if (!inv.expiresAt) return "Pending";
  return Date.parse(inv.expiresAt) < now ? "Expired, send another" : "Pending";
}
