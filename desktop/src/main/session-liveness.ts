import { readSetting } from "./database";

/**
 * ── ⚠ IS THERE A SESSION WORTH SPENDING A REQUEST ON? ─────────────────────────────────────────
 *
 * ⚠ PRESENCE IS NOT USABILITY, and every existing guard tested presence. App.tsx gates its access probe on
 * `team_joined === "true"`, the views on `connected === "true"`, `teamContext()` on `server_url` + `team_id`,
 * and `sweepUnsyncedTurns` on `auth_token` being non-empty. A session whose refresh has failed still has ALL
 * of those: they are cleared by an explicit sign-out, not by a 401. So the token sat in the settings table
 * looking perfectly good while every poller — chat every five seconds, the board, the phases, the startup
 * sweep — spent a real request to be told 401 again, each one raising an alert.
 *
 * ⚠ SO THE FACT LIVES HERE, IN ITS OWN MODULE, BECAUSE OF AN IMPORT CYCLE. handlers/ai.ts owns the refresh
 * and learns the answer; `sync-sweep.ts` needs it; and ai.ts already imports `scheduleSweep` FROM
 * sync-sweep. Putting the flag in either of them would make them import each other, so it goes in a leaf
 * that both can read.
 *
 * ⚠ IT IS NOT A CACHE OF THE LAST HTTP STATUS. A 403 or a 404 describes the TEAM and must still be
 * discovered by asking — team-access-state.ts is that channel. This is only about the credential.
 */
let refreshFailed = false;

/** The refresh could not save this session: stop spending requests on it. */
export function markSessionDead(): void {
  refreshFailed = true;
}

/**
 * A session was adopted, or torn down.
 *
 * ⚠ CALLED ON TEARDOWN TOO, NOT ONLY ON SIGN-IN. A latch that only reopened on a successful sign-in would
 * leave a signed-out app permanently marked dead, which is correct for the pollers and wrong for the next
 * sign-in attempt's own diagnostics.
 */
export function markSessionAlive(): void {
  refreshFailed = false;
}

/**
 * True when a refresh has FAILED for the session currently stored.
 *
 * ⚠ NARROWER THAN `!isSessionUsable()`, AND THE DIFFERENCE IS USER-VISIBLE. "No token at all" and "a token
 * that no longer works" are different states with different remedies, and team-data.ts reports them as
 * different reasons: `no-session` shows a banner naming the profile ("You are not signed in to this
 * profile"), while `signed-out` shows none because `auth:expired` already owns that message.
 *
 * Collapsing the two — the first version of this guard used `!isSessionUsable()` — silently withdrew that
 * banner and reintroduced the blank-screen bug it was added for. So the short-circuit asks this, and the
 * absent-token case falls through to be classified properly.
 */
export function refreshHasFailed(): boolean {
  return refreshFailed;
}

/**
 * True when a stored session exists and nothing has proved it dead yet.
 *
 * Fails toward "usable" on purpose: this is a cost optimisation and a noise control, not an authorization
 * check. `fetchAuthed` remains the thing that actually establishes whether a token works.
 */
export function isSessionUsable(): boolean {
  if (refreshFailed) return false;
  return !!readSetting("auth_token");
}
