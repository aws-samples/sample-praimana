/**
 * ── ⚠ WHY AN EMPTY SCREEN NEEDED A SENTENCE ───────────────────────────────────────────────
 *
 * Both guesses were wrong, and the app is what made them plausible. It was authenticated, the backend
 * was healthy, and every team-scoped read was coming back **403 Forbidden** — the stored `team_id` no
 * longer named a team this user belongs to. But the three handlers collapsed every failure into the
 * same `{ ok: false }`, and each view renders that as "nothing here yet". So the one failure that
 * needs a human decision looked identical to a slow network, and the user had to guess.
 *
 * This component is the sentence that was missing. It renders ONLY for the reasons that are permanent
 * and actionable, because a banner that also fires on a transient blip is a banner people learn to
 * ignore:
 *
 *   access-lost (403) — the service refuses this team
 *   team-gone   (404) — the team no longer exists
 *   no-session        — this profile has no signed-in session at all
 *
 * ── ⚠ AND `no-session` WAS ADDED BECAUSE THE SAME BUG HAPPENED AGAIN, ONE REASON CODE OUT ──
 *
 * Nothing was missing. The profile had been signed out — its own audit log ends `auth.signout / revoked` with
 * no sign-in after — so `teamContext()` returned null and every team-scoped read returned early. That early
 * return reported `no-team`, which renders nothing here, so phases, board, chat and docs all went blank with
 * no explanation and the cause took a database read to find. Exactly the failure described above, in a state
 * this component did not cover.
 *
 * `no-team` still renders nothing, and that is still right: it means "signed in, no team joined yet",
 * which a fresh install legitimately is. The two were one code, and the remedies are different.
 *
 * `unavailable` and `busy` deliberately render NOTHING. They self-correct on the next poll, and the
 * views keep whatever they last had, which is the better behaviour for a venue wifi drop mid-workshop.
 * `signed-out` also renders nothing: `auth:expired` is already broadcast and the app has its own
 * re-login path, so a second, competing message here would be worse than none.
 *
 * ⚠ COLOURS COME FROM THE SEMANTIC TOKENS, not from literals. This app has light and dark themes, and
 * a hardcoded hex would be correct in exactly one of them.
 *
 * ⚠ AND THE TWO REDS ARE NOT INTERCHANGEABLE. `tailwind.config.ts` records that `tool-error` is
 * 3.87:1 — legal as a graphical indicator, ILLEGAL as text — which is why `tool-error-text` (7.22:1)
 * exists beside it. So the border uses `tool-error` and every word uses `tool-error-text`. There is no
 * `tool-error-bg`; the established container pattern in this codebase is `bg-surface-raised`.
 */
export type TeamReadFailure =
  | "no-team"
  | "no-session"
  | "access-lost"
  | "team-gone"
  | "signed-out"
  | "unavailable"
  | "busy";

/** True if this reason is worth interrupting the user for. */
export function isAccessLost(reason: unknown): boolean {
  return reason === "access-lost" || reason === "team-gone" || reason === "no-session";
}

export function TeamAccessNotice({ reason }: { reason?: unknown }) {
  if (!isAccessLost(reason)) return null;

  /**
   * Different first sentences because they suggest different questions — "was I removed?", "was the team
   * rebuilt?", "am I even signed in?" — and different second sentences, because unlike the first two the
   * remedy for `no-session` is not a re-join.
   */
  const what =
    reason === "no-session"
      ? "You are not signed in to this profile."
      : reason === "team-gone"
        ? "This team no longer exists on the server."
        : "You no longer have access to this team.";

  const why =
    reason === "no-session"
      ? // ⚠ NAMES THE VIEWS, because the participant sees one blank screen and does not know the other
        // three are blank for the same reason — which is what turns "the app is broken" into one action.
        "Phases, board, team chat and documents all need a signed-in team, so they are empty rather " +
        "than out of date. Sign in again to restore them — or switch profiles, since each profile keeps " +
        "its own sign-in, team and workshop."
      : "Your sign-in is still valid and the server is reachable — it is the team that cannot be read. " +
        "Re-join with a current invite code from the portal, or ask your facilitator to confirm the team " +
        "still exists.";

  return (
    <div
      role="alert"
      className="mx-4 mb-3 flex-shrink-0 rounded-lg border border-tool-error bg-surface-raised p-3"
    >
      <p className="text-xs font-medium text-tool-error-text">{what}</p>
      <p className="mt-1 text-xs text-surface-muted">{why}</p>
    </div>
  );
}
