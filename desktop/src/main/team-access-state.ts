/**
 * ── ⚠ WHAT MAIN ALREADY KNOWS ABOUT THIS TEAM, SHARED ─────────────────────────────────────────
 *
 * Two turns pushed on every launch, both refused, and they can never succeed until the team problem is
 * fixed — so the requests are pure waste, repeated for as long as the condition lasts.
 *
 * ⚠ THE INFORMATION EXISTED AND WAS NOT SHARED. The log ordering shows it:
 *
 *     [team-data] team:checkAccess: the service refused this team (HTTP 403)   <- known here
 *     [cli-assistant] sync failed (ai-chat): thread create failed: HTTP 403    <- attempted anyway
 *
 * The startup probe had already established the answer seconds earlier. `sweepUnsyncedTurns` only sees
 * `{ retried, status }` from `retryMessageSync` — no HTTP status, no reason — so it could not tell a
 * permanent authorization failure from a network blip and had no way to ask. This module is the missing
 * channel between the two.
 *
 * ── WHY A MODULE RATHER THAN A SETTING ──
 *
 * It is a verdict about the CURRENT process's view of the server, not user data: it must not survive a
 * restart, because a team fixed overnight should be retried on the next launch rather than remembered as
 * broken. A settings row would persist exactly the state we do not want persisted.
 *
 * ⚠ KEYED BY TEAM ID, which is what makes re-joining self-healing. A verdict recorded against the old
 * team says nothing about the new one, so `teamAccessVerdict` reports `unknown` the moment `team_id`
 * changes and the sweep resumes without anything having to remember to clear a flag.
 */

export type TeamAccessVerdict = "unknown" | "readable" | "unreadable";

/** The team the verdict below is about. A different id means the verdict does not apply. */
let subjectTeamId: string | null = null;
let verdict: TeamAccessVerdict = "unknown";
/** Kept for the log line only — the caller that recorded it, so a skip can say why. */
let reason: string | null = null;

/**
 * Record that a team-scoped call succeeded.
 *
 * Clears a previous `unreadable`, so access restored mid-session resumes work without a relaunch.
 */
export function noteTeamReadable(teamId: string): void {
  if (!teamId) return;
  subjectTeamId = teamId;
  verdict = "readable";
  reason = null;
}

/**
 * Record that the service refused this team — a 403 or a 404.
 *
 * ⚠ ONLY FOR VERDICTS, NOT FOR TRANSIENT FAILURES. A timeout or a 500 must never reach here: those are
 * conditions that resolve themselves, and recording them as `unreadable` would stop the sweep from doing
 * the retrying it exists for. The callers classify first; this only stores.
 */
export function noteTeamUnreadable(teamId: string, why: string): void {
  if (!teamId) return;
  subjectTeamId = teamId;
  verdict = "unreadable";
  reason = why;
}

/** The verdict for `teamId`, or `unknown` if it is about a different team or nothing is known. */
export function teamAccessVerdict(teamId: string | null): TeamAccessVerdict {
  if (!teamId || teamId !== subjectTeamId) return "unknown";
  return verdict;
}

/** Why the last `unreadable` was recorded, for a log line. */
export function teamAccessReasonText(): string | null {
  return reason;
}

/** Test seam: the module-level verdict would otherwise leak between cases. */
export function __resetTeamAccessState(): void {
  subjectTeamId = null;
  verdict = "unknown";
  reason = null;
}
