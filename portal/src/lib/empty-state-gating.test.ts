import { describe, it, expect } from "vitest";

/**
 * "NO EXPERIENCES CREATED YET" FLASHED ON EVERY LOGIN, and this is the class of bug behind it.
 *
 * ── THE MECHANISM ──
 *
 * Four screens fetch with `enabled: !!session`, and NextAuth resolves the session one round trip
 * AFTER first paint. While it is unresolved the query is DISABLED, and a disabled query reports
 * `isLoading === false`, because react-query is telling the truth: nothing is in flight. So:
 *
 *   1. first paint: sessionStatus "loading", query disabled, isLoading false, data undefined
 *   2. the loading guard does not fire
 *   3. `!data?.length` is true
 *   4. the EMPTY STATE renders, "No experiences created yet"
 *   5. session arrives, query runs, real list replaces it
 *
 * Steps 3–4 are the bug: an affirmative claim about the account, shown to everyone, every login.
 * For a brand-new user it is indistinguishable from the truth, and on /welcome the same defect
 * told someone who had just registered from an invitation "No team invitation found yet", on the
 * one screen whose whole job is handing them that code.
 *
 * ── WHY A PURE FUNCTION ──
 *
 * The defect is not in either library; it is in the CONDITION each page computes from them. That
 * condition is what these tests model, in the same style as auth-refresh-loop.test.ts, the bug
 * lived in a two-state reading of a three-state world, so the fix has to be pinned as a decision
 * rather than as a rendered pixel.
 */

type SessionStatus = "loading" | "authenticated" | "unauthenticated";

/** What a page shows for a list-shaped screen. */
type View = "spinner" | "empty-state" | "content";

/**
 * The decision every affected page now makes, mirroring the guard in workshops/page.tsx.
 *
 * `isLoading` is react-query's, `sessionStatus` is NextAuth's, `rows` is the fetched data.
 */
function viewFor(opts: {
  sessionStatus: SessionStatus;
  isLoading: boolean;
  rows: unknown[] | undefined;
}): View {
  if (opts.isLoading || opts.sessionStatus === "loading") return "spinner";
  return opts.rows?.length ? "content" : "empty-state";
}

describe("the reported flash: an unresolved session must not read as 'empty'", () => {
  it("shows a SPINNER on the first paint after login", () => {
    /**
     * THE EXACT REPORTED STATE. Note `isLoading: false`, that is not a mistake in the test, it
     * is the whole defect: the query is disabled, so react-query correctly says it is not
     * loading, and a guard that trusted only this flag fell straight through to the empty state.
     */
    expect(
      viewFor({ sessionStatus: "loading", isLoading: false, rows: undefined })
    ).toBe("spinner");
  });

  it("shows a spinner once the query is genuinely in flight", () => {
    expect(
      viewFor({ sessionStatus: "authenticated", isLoading: true, rows: undefined })
    ).toBe("spinner");
  });

  it("shows the EMPTY STATE only after the server actually answered 'nothing'", () => {
    // The one condition under which the claim is true.
    expect(
      viewFor({ sessionStatus: "authenticated", isLoading: false, rows: [] })
    ).toBe("empty-state");
  });

  it("shows content when there is content", () => {
    expect(
      viewFor({ sessionStatus: "authenticated", isLoading: false, rows: [{ id: "w1" }] })
    ).toBe("content");
  });
});

describe("the spinner must not become permanent, the opposite failure", () => {
  it("a SIGNED-OUT visitor reaches the empty state, not an endless spinner", () => {
    /**
     * ⚠ WHY THE GUARD READS `status`, NOT `session === undefined`.
     *
     * `session` is undefined for a signed-out visitor too, so gating on the data would hold them
     * on a spinner for ever, trading a one-second false claim for a permanently stuck page, which
     * is a worse bug than the one being fixed. "loading" is the only status that means "still
     * asking"; middleware bounces the unauthenticated case, and until it does the empty state is
     * the honest thing to render.
     */
    expect(
      viewFor({ sessionStatus: "unauthenticated", isLoading: false, rows: undefined })
    ).toBe("empty-state");
  });

  it("never returns a spinner once both the session and the query have settled", () => {
    for (const rows of [[], [{ id: "a" }]]) {
      for (const status of ["authenticated", "unauthenticated"] as const) {
        expect(viewFor({ sessionStatus: status, isLoading: false, rows })).not.toBe(
          "spinner"
        );
      }
    }
  });
});

/**
 * THE SAME DEFECT ON THE INSIGHTS PAGE, with a different cost.
 *
 * There the pre-run screen ("No analysis run yet" + a Generate button) was rendered while the
 * stored-assessment query was still in flight, because the flag that opens the dashboard is set
 * in an EFFECT, and an effect runs after a paint. An executive returning to a team they had
 * already analysed saw an invitation to generate it again, for a second or two, with a button
 * that costs a model call.
 *
 * The fix waits for the query to SETTLE, but only when it can actually run: a participant or a
 * non-member never fetches it, and holding them on a spinner for ever would be the stuck-page
 * failure above.
 */
function insightsView(opts: {
  hasRun: boolean;
  isExecutive: boolean;
  isMember: boolean;
  analysisPending: boolean;
}): "dashboard" | "looking-for-analysis" | "offer-to-generate" {
  if (opts.hasRun) return "dashboard";
  const mayExist = opts.isExecutive && opts.isMember;
  if (mayExist && opts.analysisPending) return "looking-for-analysis";
  return "offer-to-generate";
}

describe("insights: do not offer to generate what may already exist", () => {
  it("WAITS instead of offering the button while the stored analysis is still loading", () => {
    expect(
      insightsView({
        hasRun: false,
        isExecutive: true,
        isMember: true,
        analysisPending: true,
      })
    ).toBe("looking-for-analysis");
  });

  it("offers to generate once the query settled with nothing stored", () => {
    expect(
      insightsView({
        hasRun: false,
        isExecutive: true,
        isMember: true,
        analysisPending: false,
      })
    ).toBe("offer-to-generate");
  });

  it("does NOT hold a participant on a spinner, they never fetch it", () => {
    /**
     * `analysisPending` is TRUE for a disabled query, so a naive `if (pending) wait` would hang
     * this page for every teammate who is not an executive. The audience conditions are repeated
     * in the guard for exactly this reason.
     */
    expect(
      insightsView({
        hasRun: false,
        isExecutive: false,
        isMember: true,
        analysisPending: true,
      })
    ).toBe("offer-to-generate");
  });

  it("does NOT hold an off-team executive on a spinner either", () => {
    // Refused as NOT_A_TEAM_MEMBER, so the query is disabled and pending for ever.
    expect(
      insightsView({
        hasRun: false,
        isExecutive: true,
        isMember: false,
        analysisPending: true,
      })
    ).toBe("offer-to-generate");
  });

  it("a run already under way outranks everything", () => {
    expect(
      insightsView({
        hasRun: true,
        isExecutive: true,
        isMember: true,
        analysisPending: true,
      })
    ).toBe("dashboard");
  });
});
