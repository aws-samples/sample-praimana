/**
 * ── HOW A WORKSHOP'S ENUMS ARE SHOWN TO A HUMAN ─────────────────────────────────────────────
 *
 * The experiences list rendered `{workshop.status}` and `{workshop.format}` directly, so the
 * screen said `IN_PERSON` and `REGISTRATION`. Those are transport values. Printing them is a
 * small bug with two distinct costs: a facilitator reads SHOUTING_SNAKE_CASE as a system
 * identifier rather than as a state, and the width of the longest enum (`REGISTRATION`) sets
 * the column width for every row.
 *
 * ── ⚠ WHY THIS IS A MODULE AND NOT A TERNARY IN THE PAGE ──
 * The list previously chose a status colour with a three-branch ternary: ACTIVE, REGISTRATION,
 * and "everything else". The lifecycle has SIX states (see `WORKSHOP_STATUSES` in
 * `src/app/experiences/[id]/settings/page.tsx`, which is the selector a facilitator drives it
 * with), so `JUDGING`, an actively-running phase, was rendered with the same dead grey as
 * `ARCHIVED`. A `Record` keyed by the full union makes that omission a TYPE ERROR the next time
 * a status is added, which a ternary's fallback branch never can.
 *
 * Deliberately NOT in `@praimana/shared`: these are presentation strings for one portal
 * screen, and the desktop app and notify service have their own vocabularies. Shared code is
 * for the predicates both sides must agree on, not for prose.
 */

/**
 * The full lifecycle, ordered as a progression.
 *
 * ⚠ Mirrors `WORKSHOP_STATUSES` in the settings page rather than importing it, because that
 * constant is local to a client page component and importing a page into a lib module inverts
 * the dependency. If a seventh status appears, both lists change, and the `Record`s below stop
 * compiling until they do, which is the point.
 */
export const WORKSHOP_STATUSES = [
  "DRAFT",
  "REGISTRATION",
  "ACTIVE",
  "JUDGING",
  "COMPLETED",
  "ARCHIVED",
] as const;

export type WorkshopStatus = (typeof WORKSHOP_STATUSES)[number];

/**
 * Sentence case, not Title Case and not ALL CAPS.
 *
 * "Registration open" rather than a bare "Registration": the noun alone reads as a section
 * name, and the state it describes is that the workshop is ACCEPTING people.
 */
const STATUS_LABELS: Record<WorkshopStatus, string> = {
  DRAFT: "Draft",
  REGISTRATION: "Registration open",
  ACTIVE: "Active",
  JUDGING: "Judging",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

/**
 * Which semantic token paints the status dot.
 *
 * Three tones for six states, and the grouping is a judgement rather than a mapping:
 *   - `active`, the workshop is LIVE and someone is doing something in it right now
 *                 (ACTIVE, JUDGING). A facilitator scanning the list is looking for these.
 *   - `pending`, it needs an action before it can run (DRAFT, REGISTRATION).
 *   - `idle`, it is over and needs nothing (COMPLETED, ARCHIVED).
 *
 * ⚠ JUDGING IS `active`, NOT `idle`. That was the defect: judging is the busiest hour of an
 * accelerator and it was rendered in the same dead grey as an archived event from last year.
 */
export type StatusTone = "active" | "pending" | "idle";

const STATUS_TONES: Record<WorkshopStatus, StatusTone> = {
  DRAFT: "pending",
  REGISTRATION: "pending",
  ACTIVE: "active",
  JUDGING: "active",
  COMPLETED: "idle",
  ARCHIVED: "idle",
};

/** Delivery format. Same reasoning as the statuses: `IN_PERSON` is not a word. */
const FORMAT_LABELS: Record<string, string> = {
  IN_PERSON: "In person",
  VIRTUAL: "Virtual",
  HYBRID: "Hybrid",
};

/**
 * ⚠ EVERY READER BELOW TOLERATES AN UNKNOWN VALUE, and that is not defensive padding.
 *
 * These enums arrive over the wire from a service in a DIFFERENT REPOSITORY. It can ship a new
 * status before the portal knows about it, and the correct behaviour then is a readable
 * fallback, not a blank cell, and not a crash on a list screen everyone hits at login.
 *
 * `humanise` turns `SOME_NEW_STATE` into `Some new state`, which is wrong-but-legible: a
 * facilitator sees a real state they can act on and report, instead of an empty row.
 */
function humanise(raw: string): string {
  const spaced = raw.replace(/_/g, " ").trim();
  if (!spaced) return "";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function isWorkshopStatus(raw: string): raw is WorkshopStatus {
  return (WORKSHOP_STATUSES as readonly string[]).includes(raw);
}

export function statusLabel(raw: string | null | undefined): string {
  if (!raw) return "Unknown";
  return isWorkshopStatus(raw) ? STATUS_LABELS[raw] : humanise(raw);
}

/**
 * An unknown status is `pending`, not `idle`.
 *
 * If the services introduce a state this build has never heard of, the safer reading is "this
 * might need attention" over "this is finished and ignorable". Mislabelling a live workshop as
 * done is the more expensive of the two errors.
 */
export function statusTone(raw: string | null | undefined): StatusTone {
  if (!raw) return "pending";
  return isWorkshopStatus(raw) ? STATUS_TONES[raw] : "pending";
}

export function formatLabel(raw: string | null | undefined): string {
  if (!raw) return "-";
  return FORMAT_LABELS[raw] ?? humanise(raw);
}

/**
 * "6 teams", "1 team", or "- teams" when the count is absent.
 *
 * ⚠ THE ABSENT CASE IS NOT ZERO, and the distinction is inherited from the markup this
 * replaces: a stated "0 teams" beside a workshop that HAS teams reads as fact, where "-"
 * reads as "not loaded". Kept as a function so the singular is decided in one place.
 */
export function teamCountLabel(count: number | null | undefined): string {
  if (count === null || count === undefined) return "- teams";
  return `${count} team${count === 1 ? "" : "s"}`;
}

/**
 * A stable, unambiguous date: "1 Aug 2026".
 *
 * ⚠ `toLocaleDateString()` WITH NO ARGUMENTS WAS THE BUG. It renders in the BROWSER's locale,
 * so the same workshop reads "8/1/2026" for a facilitator in Seattle and "01/08/2026" for one
 * in London, the same nine characters meaning two different days, five months apart, with
 * nothing on screen to say which. This portal is used by both.
 *
 * `en-GB` with an abbreviated month is pinned deliberately: the month is a NAME, so the
 * day/month order stops mattering to the reader. The repo already forces `LC_ALL=en_GB` for
 * its test runs, so this also makes the rendered output match what the suite asserts.
 */
export function workshopDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
