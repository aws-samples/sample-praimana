/**
 * ── ⚠ ONE DEFINITION OF "WHICH LOCAL ACCOUNT IS ACTING" ────────────────────────────────────────
 *
 * `readSetting("active_user_id") || readSetting("user_id")` was written out by hand in every query
 * that scoped a row to an account — and NOT written out at all in six others, which is three of the
 * findings in this review:
 *
 *   - `allowedRoots()` built the filesystem boundary from `SELECT path FROM projects` with no
 *     account predicate, so one local account's project folders stayed inside another's fence.
 *   - `loadTurnForRetry` and the background sweep selected turns with no account predicate, so
 *     account A's sign-in could push account B's private conversations to A's team.
 *   - `db:getMessages` / `db:deleteSession` / `db:setSessionShared` / `share:shareSession` keyed on
 *     a caller-supplied row id alone.
 *
 * Each of those is the same omission, and an inlined expression is easy to omit. So the notion lives
 * here, is imported, and is greppable: `activeUserId` names every site that scopes by account, and a
 * new query that does not call it is visible as such.
 *
 * ⚠ THE FALLBACK IS NOT REDUNDANT. `active_user_id` is written by the multi-account switcher
 * (accounts.ts); `user_id` is written by a plain sign-in. An install that has never switched accounts
 * has only the second, so dropping the fallback would scope every query to NULL and empty the app.
 *
 * ⚠ AND NULL IS A REAL STATE, not an error: signed out, or signed in before the column existed. It
 * is returned as null rather than "" so the caller has to decide what an unknown account means for
 * its query — `IS ?` (legacy rows included) or a refusal — instead of silently matching a row whose
 * `user_id` is the empty string.
 */

import { readSetting } from "./database";

/** The local account whose rows this process may touch, or null when nobody is signed in. */
export function activeUserId(): string | null {
  const value = readSetting("active_user_id") || readSetting("user_id");
  return value && value.trim() ? value : null;
}

/**
 * ── ⚠ AND ONE DEFINITION OF "WHICH EXPERIENCE IS ACTING" ────────────────────────────────────────
 *
 * This lived as a private `currentExperience()` inside handlers/db.ts, where the three READ paths that scope
 * by experience could reach it and the two SYNC paths could not. So the read side honoured `workshop_id` and
 * the push side did not, which is the whole of that finding: a participant who left workshop A with turns
 * still `pending` and joined team B had A's private transcripts filed into B's thread store on the next
 * sweep.
 *
 * It sits beside `activeUserId` for the reason that function gives: an inlined `readSetting` is easy
 * to omit, and a new query that scopes by neither is visible as such precisely because both notions
 * are named, imported and greppable.
 *
 * ⚠ NULL IS A REAL AND SURVIVABLE STATE — a user signed in but not yet on a team has no
 * `workshop_id`. What null MEANS differs by direction, and the callers decide, not this function:
 * a read falls back to user-only scoping so an unscoped user still sees their work (see
 * `db:getProjects`), while a push treats it as "no experience to publish into" and selects only
 * rows whose own provenance is equally unknown.
 */
export function activeExperience(): string | null {
  const value = readSetting("workshop_id");
  return value && value.trim() ? value : null;
}
