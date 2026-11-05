import { errorMessage, isForbidden, isUnauthorized } from "@/lib/trpc/errors";

/**
 * WHY A TEAM-CONTENT PAGE IS NOT SHOWING ITS CONTENT, one answer, derived from the
 * queries that page actually depends on.
 *
 * The four team-content surfaces are member-only: the board, the chat, the AI
 * threads, the code and the insights answer 403 to a facilitator, judge or admin who is
 * not on the team. Six pages have to tell that story identically, and the failure mode of
 * six hand-rolled versions is not that they look different, it is that one of them ends
 * up rendering a rule as an outage, or an outage as an empty team.
 *
 * A PURE FUNCTION, not a hook, so the caller keeps its own query calls at the top of its
 * component (hook order stays obvious) and this can be reasoned about and unit-tested on
 * its own.
 *
 * WHAT THIS IS NOT: access control. The server's 403 is the boundary; this only decides
 * which sentence the operator reads. Nothing here infers entitlement from a role, and
 * nothing here may: an ADMIN can legitimately be a member of a team, an EXECUTIVE
 * frequently is (read-only is about writing, not about belonging), and a PARTICIPANT can
 * be looking at a team they are not on. Membership is a server-side fact and the only
 * honest source for it is the server's answer.
 */

/** The subset of a tRPC query result this needs. Satisfied by any `useQuery` result. */
export interface GatedQuery {
  error: unknown;
  refetch: () => unknown;
}

export type TeamContentGate =
  /** Every gating query answered. Render the page. */
  | { state: "allowed" }
  /** At least one query was refused by rule. The caller is not on this team. */
  | { state: "member-only" }
  /**
   * At least one query failed for a reason that is not a rule. `detail` is the service's
   * own message when it gave one; `retry` refetches every query that failed.
   */
  | { state: "failed"; detail?: string; retry: () => void }
  /**
   * The SESSION EXPIRED. Distinct from `failed` because the user can do nothing about it and
   * "Try again" cannot fix it, the token is gone, and every retry produces another 401.
   *
   * Reported live: after an idle period, `/w/:id/t/:id/phases` rendered "Couldn't load this
   * team's phases … Backend error: 401" with a Try again button. Three things wrong with that
   * screen, it blamed the data ("the data is missing"), it offered an action that cannot
   * succeed, and it asked the user to report a bug that is just an expired login.
   */
  | { state: "expired" };

/**
 * Reduce a page's gating queries to one state.
 *
 * ── WHY "member-only" OUTRANKS "failed" ──
 * A page can hold both at once, and the code page does so today: `docs.list` has always
 * been member-only while `git.getCommits` was not, so a non-member could see a 403 and a
 * 500 from the same screen. When the caller is not entitled to the surface at all, the
 * rule is the only fact that changes what they do next, the outage is on a service whose
 * data they may not read, so reporting it would send an operator to escalate something
 * they cannot verify and did not ask about. The rule wins, and the fault is not mentioned.
 *
 * ── WHY A MISSING CODE COUNTS AS A FAULT ──
 * `isForbidden` reads the structured code, so a dropped connection, an aborted fetch or a
 * non-tRPC throw lands in `failed`. That is the correct direction: a refusal we never
 * received is not a refusal, and rendering "visible to team members" over a network
 * failure would tell an operator a rule applies to them when the truth is that nobody
 * knows. The two states are asymmetric on purpose, one is a rule and needs no action,
 * the other must be retried, so the ambiguous case has to be the one that says
 * "something is broken".
 */
export function teamContentGate(queries: GatedQuery[]): TeamContentGate {
  /**
   * ── EXPIRED OUTRANKS EVERYTHING, AND IT HAS TO ──
   *
   * Checked FIRST, before `member-only` and before `failed`. Once the token is gone the server
   * cannot evaluate any rule, so a 401 tells us nothing about membership: treating it as
   * `member-only` would tell somebody they are not on their own team, and treating it as
   * `failed` is what produced the reported "Backend error: 401 / Try again" screen.
   *
   * ⚠ THE GLOBAL HANDLER ALONE WAS NOT ENOUGH, which is why this state exists. `Providers`
   * already calls `signOut()` from React Query's `retry` callback, and that does fire, but
   * `signOut` is an async network round trip while React renders the error state on the same
   * tick. So the user reliably sees the wrong screen for the duration of that request, and if
   * the sign-out call itself fails they stay on it. The gate has to name the state so the page
   * can render the truth immediately, rather than depending on a redirect winning a race.
   */
  if (queries.some((q) => isUnauthorized(q.error))) {
    return { state: "expired" };
  }

  if (queries.some((q) => isForbidden(q.error))) {
    return { state: "member-only" };
  }

  const failed = queries.filter((q) => q.error);

  /**
   * ── ⚠ WHY A LOAD FAILURE IS WORTH A CONSOLE LINE ────────────────────────────────────────
   *
   * REPORTED TWICE: "Couldn't load this team's AI conversations … Backend error: 401". For that screen to
   * appear, the error reached here with NEITHER `data.code` NOR `data.httpStatus`, the predicate reads both -
   * so something between the procedure and the component dropped `data`, and the gate then correctly refused
   * to guess.
   *
   * ⚠ A MESSAGE-BASED FALLBACK WAS TRIED AND REVERTED. `lib/backend.ts` builds that string as
   * `data.error || "Backend error: <status>"`, so it only appears when the service sent no error body; the day
   * one is added the matcher stops working silently, which is exactly what the rule in this file's tests
   * predicts. Guessing from prose is not the fix.
   *
   * So this logs the SHAPE instead, enough to name the layer that lost the field, and nothing that could
   * identify a person. It fires only on a failure that is already being shown to the user, so it cannot become
   * noise on a healthy page.
   */
  if (failed.length > 0 && typeof console !== "undefined") {
    for (const q of failed) {
      const err = q.error as { name?: string; message?: string; data?: unknown } | undefined;
      console.warn("[team-content-gate] unclassified load failure", {
        name: err?.name,
        message: err?.message,
        /* The point of the line: was `data` absent, or present-but-empty? */
        dataPresent: err?.data !== undefined && err?.data !== null,
        dataKeys: err?.data && typeof err.data === "object" ? Object.keys(err.data) : [],
      });
    }
  }

  if (failed.length === 0) {
    return { state: "allowed" };
  }

  return {
    state: "failed",
    // The FIRST failure's message, not a join of all of them. Where several queries fail
    // together the cause is almost always one thing (the gateway, the token, the
    // network), so concatenating them produces three phrasings of one fact and buries the
    // one an operator would quote.
    detail: errorMessage(failed[0].error),
    // Every failed query, not just the first: retrying one of three leaves the page in a
    // state that is neither loaded nor legibly broken.
    retry: () => failed.forEach((q) => q.refetch()),
  };
}
