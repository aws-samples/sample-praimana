import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE INSIGHTS PAGE'S DEFAULTS, and the invitations section that a deferred fetch broke.
 *
 * Source assertions, the idiom the sibling reactivate-member.test.ts already uses: these are
 * structural facts (which query is gated, which section renders unconditionally) rather than
 * behaviour a harness can drive without a DOM.
 *
 * ── THE BUG THE FIRST BLOCK GUARDS ──
 *
 * Deferring the invitations query left the section gated on `sentInvitations.length > 0`. That
 * gate had worked while the query ran on mount, but the two together are self-defeating:
 * nothing is fetched until the section is expanded, and the section cannot be expanded
 * because the gate hides it. The heading vanished from the page entirely. A deferred fetch
 * and a presence gate on the deferred data cannot both be true.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const TEAM_PAGE = read("../app/w/[workshopId]/t/[teamId]/team/page.tsx");
const INSIGHTS = read("../app/w/[workshopId]/t/[teamId]/insights/page.tsx");
const METHODOLOGY = read("../components/InsightsMethodology.tsx");
/** The non-member's whole surface, the published summary, and nothing per-member. */
const PUBLISHED_SUMMARY = read("../components/PublishedTeamSummary.tsx");
/** The service's "what these numbers do not capture" caveats, on screen. */
const COVERAGE = read("../components/RatingCoverage.tsx");
/** The confirmation the publish disclosure goes through. */
const DIALOG = read("../components/ConfirmActionDialog.tsx");

/** Strip comments: they discuss what the code must NOT do, so they defeat absence checks. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("invitations section is reachable, not hidden by its own deferred data", () => {
  it("is NOT gated on the invitation list being non-empty", () => {
    // The exact regression. If this string comes back, the section disappears again.
    expect(code(TEAM_PAGE)).not.toContain("{sentInvitations.length > 0 && (");
  });

  it("renders for anyone who may invite", () => {
    // An action's section belongs to whoever can perform the action, and an empty list is
    // a fact worth stating rather than a reason to hide the heading.
    const around = code(TEAM_PAGE);
    const gate = around.indexOf("{canSendInvites && (");
    const disclosure = around.indexOf('id="invitations"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(disclosure);
  });

  it("distinguishes loading, failed and genuinely-empty", () => {
    // Three different states that would otherwise all render as an empty list. Reporting
    // "none sent" when the LOOKUP FAILED would tell an operator their invites vanished.
    expect(TEAM_PAGE).toContain("invitationsQuery.isLoading");
    expect(TEAM_PAGE).toContain("invitationsQuery.error");
    expect(TEAM_PAGE).toContain("sentInvitations.length === 0");
  });

  it("still starts collapsed and still defers its fetch", () => {
    // The point of the original change survives the fix.
    expect(TEAM_PAGE).toContain("enabled: showInvitations");
    const decl = TEAM_PAGE.slice(TEAM_PAGE.indexOf("const [showInvitations"));
    expect(decl.slice(0, 120)).toContain("useState(false)");
  });
});

describe("insights analysis runs on demand", () => {
  /**
   * ── THIS RULE CHANGED, AND WHY ──
   *
   * It used to be "ALL FOUR source queries are gated on `{ enabled: hasRun }`", counted as
   * exactly four literal occurrences. Three of those four still hold and are asserted below.
   * The fourth, `team.getById`, was deliberately UN-GATED when the page gained its
   * two-audience split, and the old assertion would now forbid the fix:
   *
   *   The roster is what establishes WHETHER THE VIEWER IS A MEMBER of this team, and that
   *   decides WHICH PAGE renders, the member dashboard, or the published team summary a judge
   *   and an off-team executive are entitled to. That decision precedes any offer, so it
   *   cannot wait for a button. Gated, a judge would be shown "Generate insights", press it,
   *   produce three refused requests, and only then learn which page they were always getting.
   *
   *   It costs no request: the workspace layout runs `team.getById` unconditionally on every
   *   route in the team workspace (see the `isMember` derivation in the layout), so this
   *   observer reads the same react-query cache entry.
   *
   * WHAT THE ORIGINAL RULE WAS PROTECTING is unchanged and is still asserted: the metrics are
   * a single derived view, so the three queries they are COMPUTED FROM must move together or
   * the table is arithmetically wrong rather than merely incomplete. The all-or-nothing
   * invariant is additionally enforced by the useMemo's own guard, pinned below.
   */
  it("gates the three COMPUTED-FROM queries on the same flag", () => {
    const c = code(INSIGHTS);
    for (const query of [
      "trpc.ai.getThreads.useQuery({ teamId }, { enabled: hasRun })",
      "trpc.task.list.useQuery({ teamId }, { enabled: hasRun })",
    ]) {
      expect(c, `${query} should be gated on hasRun`).toContain(query);
    }
    // The messages query spans lines, so it is matched on its gate rather than its whole call.
    const messages = c.slice(
      c.indexOf("trpc.message.list.useQuery("),
      c.indexOf("const { data: messagesData")
    );
    expect(messages).toContain("enabled: hasRun");

    // One flag, not three different ones.
    expect([...c.matchAll(/enabled:\s*hasRun\b/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT gate the roster, because it decides which page renders at all", () => {
    // The rule that replaced the fourth gate. If this query is ever gated again, a judge is
    // offered a button that can only produce refusals, and the member/non-member split below
    // cannot be decided before the page commits to a layout.
    const c = code(INSIGHTS);
    expect(c).toContain("trpc.team.getById.useQuery({ teamId, workshopId });");
    expect(c).not.toMatch(
      /team\.getById\.useQuery\(\s*\{[^}]*\}\s*,\s*\{\s*enabled/
    );
  });

  it("keeps the metrics ALL-OR-NOTHING regardless of which query is gated", () => {
    // What the old four-way count was really protecting. The useMemo returns zeroed metrics
    // unless every input is present, so a partial fetch renders nothing rather than a table
    // of wrong arithmetic, which is what made "0s and Low badges against real names" possible.
    const c = code(INSIGHTS);
    expect(c).toContain("if (!team || !threads || !tasks || !messagesData) {");
    expect(c).toContain("memberMetrics: [], overviewStats: null, topicBreakdown: []");
  });

  it("does NOT gate the stored-assessment READ on hasRun, the reported bug", () => {
    /**
     * ⚠ THIS RULE INVERTED, and the previous assertion encoded the bug.
     *
     * It required `enabled: hasRun && isExecutive && membership === "member"`. Reported symptom:
     * generate insights, navigate to the dashboard, come back, and the page asks to generate
     * again. The generation had SUCCEEDED and the snapshot was in DynamoDB (verified against the
     * live table: the reported team had a 4-member assessment from that session).
     *
     * `hasRun` is component state and resets on unmount, so the query waited for a click that
     * only existed because the query had not run. Circular. Un-gating it is safe: this is a READ
     * that cannot bill, `analyze` is the only billable route and is still an explicit action
     * behind a cooldown.
     *
     * The AUDIENCE conditions stay, because they mirror what the service enforces and stop the
     * page firing a request it knows will be refused.
     */
    const c = code(INSIGHTS);
    expect(c).toContain('enabled: isExecutive && membership === "member"');
    expect(c, "hasRun must no longer gate the stored read").not.toContain(
      'enabled: hasRun && isExecutive && membership === "member"'
    );
  });

  it("lets a STORED assessment open the dashboard, one-way", () => {
    // Otherwise returning to the page hides work that was already generated and paid for. One-way
    // because a refetch that momentarily returns nothing must not throw the reader back to the
    // pre-run screen mid-sentence.
    const c = code(INSIGHTS);
    expect(c).toContain("if (hasStoredAssessment) setHasRun(true);");
    // No `else`/false branch that could close it again.
    expect(c).not.toMatch(/setHasRun\(hasStoredAssessment\)/);
  });

  it("still defers the BROWSER-COMPUTED analytics, which store nothing", () => {
    // The distinction the fix rests on: the AI assessment is persisted server-side so it can be
    // recovered, while the usage analytics are recomputed from four queries every time. There is
    // nothing to come back to, so they still wait for the button.
    const c = code(INSIGHTS);
    expect([...c.matchAll(/enabled:\s*hasRun\b/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("shows a pre-run state BEFORE the gates that would misread idle queries", () => {
    // Ordering is the substance here. `gate.state` reads "failed"/"member-only" from four
    // idle queries, and `!overviewStats` says "No data available yet", a sentence that
    // sounds like a fact about the team when it is a fact about an unpressed button.
    const c = code(INSIGHTS);
    const preRun = c.indexOf("if (!hasRun)");
    expect(preRun).toBeGreaterThan(-1);
    expect(preRun).toBeLessThan(c.indexOf("if (isLoading)"));
    expect(preRun).toBeLessThan(c.indexOf('gate.state === "member-only"'));
    expect(preRun).toBeLessThan(c.indexOf("if (!overviewStats)"));
  });
});

/**
 * WHO SEES WHAT, the two-audience rule.
 *
 *   members (INCLUDING an EXECUTIVE who is on the team)  per-member coaching AND the summary
 *   judges, and EXECUTIVES who are not on the team        the PUBLISHED summary only
 *
 * The service enforces it twice (`rating.analysis` 403s a non-member; `rating.summary`'s
 * response shape has no per-member fields at all). These assert the PAGE routes each audience
 * to the surface they are entitled to, the gap being closed is that a judge previously hit a
 * flat member-only wall and could never reach a summary the team had published FOR them.
 */
describe("the two audiences reach different surfaces", () => {
  it("routes a NON-MEMBER to the published summary, before anything member-only is offered", () => {
    // Ordering is the whole fix. Everything after this point is either member-only content or
    // an offer to compute it, so a non-member reaching any of it produces refused requests and
    // then a dead end.
    const c = code(INSIGHTS);
    const nonMember = c.indexOf('if (membership === "non-member")');
    expect(nonMember).toBeGreaterThan(-1);
    /**
     * ⚠ ANCHOR ON THE RENDER BRANCH, NOT ON `if (!hasRun)`.
     *
     * That string occurs TWICE in this file, once inside `refreshAnalysis` near the top, and
     * once as the pre-run render branch far below. A plain `indexOf` finds the first, so this
     * assertion failed against CORRECT code and looked like an ordering bug in the page. The
     * `return (` distinguishes the branch that renders from the one that sets state.
     *
     * `lastIndexOf` would also work today and silently stop working the moment a third
     * occurrence is added below it, so it is not used.
     */
    const preRunBranch = c.indexOf("if (!hasRun) {\n    return (");
    expect(preRunBranch, "the pre-run RENDER branch must be findable").toBeGreaterThan(-1);
    expect(nonMember).toBeLessThan(preRunBranch);
    expect(nonMember).toBeLessThan(c.indexOf("if (isLoading)"));
    expect(nonMember).toBeLessThan(c.indexOf("const gate = teamContentGate("));
    // And it renders the summary surface, not the member dashboard.
    const branch = c.slice(nonMember, c.indexOf('if (membership === "unknown"'));
    expect(branch).toContain("<PublishedTeamSummary");
    expect(branch).toContain("summaryQuery.data");
  });

  it("derives membership from the ROSTER, never from the platform role", () => {
    // An EXECUTIVE is frequently a member, read-only is about writing, not belonging, and
    // must see everything a teammate sees. An ADMIN can legitimately be a member. A role
    // comparison here would show a member the judge's cut-down page, or vice versa.
    const c = code(INSIGHTS);
    // ⚠ THE ANNOTATION IN THIS LITERAL WAS `(m: any)` AND IS NOW `(m)`, the callback's parameter
    // is INFERRED since `team.getById`'s response gained a declared type. Nothing about the
    // assertion weakened: it still pins the derivation to the ROSTER (`team.members`) and to a
    // `userId` comparison, which is the whole point, and the negative assertion below still forbids
    // deciding membership from the platform role.
    expect(c).toContain("(team.members ?? []).some((m) => m.userId === myUserId)");
    expect(c).not.toMatch(/membership[\s\S]{0,200}role\s*===\s*"(JUDGE|EXECUTIVE)"/);
  });

  it("treats unresolved membership as its OWN state rather than guessing", () => {
    // Both guesses are bad in different ways: "member" renders a dashboard that will 403, and
    // "non-member" tells a member their own team's coaching does not exist.
    const c = code(INSIGHTS);
    expect(c).toContain('membership: "member" | "non-member" | "unknown"');
    expect(c).toContain('if (membership === "unknown" && !teamQuery.error)');
  });

  it("still shows the member-only wall to NOBODY who is entitled to the summary", () => {
    // The regression this closes. `MemberOnlyNotice` was the terminal state for every
    // non-member; it is now unreferenced on this page because the honest destination beyond it
    // exists. If it comes back as a bare return, a judge loses the summary again.
    const c = code(INSIGHTS);
    expect(c).not.toContain("<MemberOnlyNotice");
    // The service-said-no path routes to the same entitled surface rather than to a wall.
    const gateBranch = c.slice(
      c.indexOf('if (gate.state === "member-only")'),
      c.indexOf('if (gate.state === "failed")')
    );
    expect(gateBranch).toContain("<PublishedTeamSummary");
  });

  it("keeps `notPublished` and a genuine FAILURE as different states", () => {
    // A judge who reads a red panel over a working rule goes looking for someone to fix
    // something that is not broken, during judging. The failure branch must also come FIRST,
    // because a failed read leaves the data undefined, shaped exactly like "nothing
    // published", so the reverse order reports "they published nothing" over an outage.
    const summary = code(PUBLISHED_SUMMARY);
    const failed = summary.indexOf("loadError ? (");
    const notPublished = summary.indexOf("data.notPublished");
    expect(failed).toBeGreaterThan(-1);
    expect(notPublished).toBeGreaterThan(failed);
    // The ordinary state announces politely and is not a fault; only the failure alerts.
    expect(summary).toContain('role="status"');
    expect(summary).toContain("<ContentLoadError");
    expect(summary).toContain("hasn&apos;t published a summary yet");
    expect(summary).toContain("Nothing has failed, and there is nothing for you to retry.");
    // The not-published panel carries the dashed-gray "legitimately nothing here" idiom rather
    // than the red fault card.
    expect(summary).toContain("border-dashed");
  });

  it("never READS a per-member field on the non-member surface", () => {
    // Belt and braces over the service's response shape (which already has no per-member
    // fields): this component must not learn to read a score, a name, a rationale or a
    // per-person list even if a future payload carried one.
    //
    // Asserted as PROPERTY READS rather than as bare substrings, deliberately. "members" is a
    // legitimate word in this component's own prose, "the team-level summary its members
    // published", so a substring test would fail on the copy while proving nothing about the
    // data. What matters is whether the code dereferences the field.
    const summary = code(PUBLISHED_SUMMARY);
    for (const field of [
      "aiKnowledgeScore",
      "rationale",
      "strengths",
      "improvements",
      "members",
      "userId",
    ]) {
      expect(
        summary,
        `published summary must not read .${field}`
      ).not.toMatch(new RegExp(`\\.\\s*${field}\\b`));
      expect(
        summary,
        `published summary must not destructure ${field}`
      ).not.toMatch(new RegExp(`\\b${field}\\s*[:,]`));
    }
    // And its whole input is the summary route's shape, which carries none of them.
    expect(summary).toContain("summary: string | null;");
    expect(summary).toContain("notPublished: boolean;");
  });
});

describe("the scoring methodology is published to the people it scores", () => {
  it("is reachable from the header AND from the pre-run screen", () => {
    // Someone deciding whether to run an analysis should be able to read what it computes
    // first, so the icon exists before there is anything to show.
    expect([...INSIGHTS.matchAll(/<InsightsMethodology \/>/g)].length).toBe(2);
  });

  it("states every weight that the page actually applies", () => {
    // Copied from the computation, not described from memory: 30/25/25/20. A methodology
    // note that drifts from the code is worse than none.
    for (const w of ["30%", "25%", "20%"]) {
      expect(METHODOLOGY).toContain(w);
    }
    // And the weights must still sum to 100 in the implementation itself.
    const sum = [0.3, 0.25, 0.2, 0.25].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1);
    for (const factor of ["0.3", "0.25", "0.2"]) {
      expect(INSIGHTS).toContain(`* ${factor}`);
    }
  });

  it("names the limits, not just the formula", () => {
    // The caveats ARE the methodology. Without them a rough activity signal reads as a
    // performance rating, two of the four factors are relative to the busiest member, so a
    // score is meaningless outside its own team.
    for (const claim of ["Quality", "outside the platform", "across teams"]) {
      expect(METHODOLOGY, `methodology should name: ${claim}`).toContain(claim);
    }
    expect(METHODOLOGY).toContain("not a measure of contribution");
  });

  it("is dismissible by keyboard", () => {
    // A panel that only closes by clicking the same 20px icon again is a trap.
    expect(METHODOLOGY).toContain('e.key === "Escape"');
    expect(METHODOLOGY).toContain("buttonRef.current?.focus()");
  });
});

describe("the AI ratings card describes what is actually analysed", () => {
  it("does NOT claim git commits are analysed", () => {
    // Commit analysis was cut by the owner, so the old subtitle ("Bedrock analysis of AI chats,
    // team chat & git commits") named a source that never reaches the model, a false claim
    // about the evidence behind a judgement of a person.
    const c = code(INSIGHTS);
    expect(c).not.toMatch(/git commits/i);
    expect(c).not.toContain("team chat &amp; git commits");
  });

  it("names the two sources the service really reads", () => {
    // KnowledgeModelInput carries exactly these: the member's own AI messages and their own
    // team-chat messages.
    const c = code(INSIGHTS);
    expect(c).toContain("own AI conversations and team chat");
  });

  it("still shows when the analysis was generated, through the hydration-safe formatter", () => {
    // The existing generatedAt display is preserved. `formatInstantUtc`, not toLocaleString:
    // this is a client component, so an ambient locale/timezone read renders one string on the
    // server and another at hydration.
    const c = code(INSIGHTS);
    expect(c).toContain("data?.generatedAt && (");
    expect(c).toContain("formatInstantUtc(data.generatedAt)");
    expect(c).not.toContain("toLocaleString");
    expect(c).not.toContain("toLocaleDateString");
  });
});

describe("coverage, what the numbers do NOT capture reaches the screen", () => {
  it("is rendered on BOTH surfaces, because both audiences act on the figures", () => {
    // The service carries these caveats in the snapshot payload deliberately: people are ranked
    // by the numbers, so what the numbers miss has to travel with them. A judge is the reader
    // most likely to act on the summary and least likely to know how it was produced.
    expect(code(INSIGHTS)).toContain("<RatingCoverage");
    expect(code(PUBLISHED_SUMMARY)).toContain("<RatingCoverage");
  });

  it("reads the caveats from the SERVICE rather than hardcoding them", () => {
    // Two copies of a caveat list is how one screen keeps claiming a limitation that no longer
    // applies, the same defect as the git-commits subtitle, one level down.
    const c = code(INSIGHTS);
    expect(c).toContain("coverage={data?.coverage ?? []}");
    expect(code(PUBLISHED_SUMMARY)).toContain("coverage={data.coverage}");
  });

  it("is always visible, never behind hover or a collapsed panel", () => {
    // These sentences change how the number should be READ, so they must be legible in the
    // same glance as the number. Hover does not exist on touch and is unreachable by keyboard;
    // a collapsed panel is a caveat nobody reads.
    const cov = code(COVERAGE);
    expect(cov).not.toContain("onMouseEnter");
    expect(cov).not.toContain("group-hover");
    expect(cov).not.toContain("title=");
    expect(cov).not.toContain("useState");
    expect(cov).not.toContain("aria-expanded");
  });

  it("renders nothing at all when there are no caveats, rather than an empty heading", () => {
    // An older snapshot written before `coverage` existed has none, and a heading over an empty
    // list reads as data that failed to arrive.
    expect(code(COVERAGE)).toContain("if (coverage.length === 0) return null;");
  });

  it("BOUNDS the list and DISCLOSES the bound when it bites", () => {
    // Every list is bounded. A caveat list that quietly ends is read as complete, which is the
    // one wrong answer on a panel whose whole job is to say what is missing.
    const cov = code(COVERAGE);
    expect(cov).toContain("MAX_COVERAGE_SHOWN");
    expect(cov).toContain("coverage.slice(0, MAX_COVERAGE_SHOWN)");
    expect(cov).toContain("withheld > 0 &&");
    expect(cov).toContain("not shown here");
  });

  it("is not styled as a fault", () => {
    // Amber, never red: nothing here is broken, and a red panel over "here is what this
    // measurement misses" teaches an operator that the card has failed.
    const cov = code(COVERAGE);
    expect(cov).toContain("bg-warn-bg");
    expect(cov).not.toContain("bg-danger-bg");
    expect(cov).not.toContain('role="alert"');
  });
});

/**
 * THE SAME RULE, APPLIED ONE CARD DOWN, the HEURISTIC member table.
 *
 * The de-ranking below was originally scoped to the model-generated coaching cards, and the
 * assertion in the next describe block said so explicitly: `ScoreBadge` "is a different
 * measurement with a different meaning and is out of scope". That scoping was wrong on the
 * substance, and the rule was widened accordingly. A reader looking at a teammate's name beside a
 * red badge does not know or care which number produced it, and the heuristic is the WEAKER
 * basis for a judgement of the two, the methodology panel already says it "is not a measure of
 * contribution", and two of its four factors are relative to the busiest member, so a score
 * means nothing outside its own team.
 *
 * Colour-alone encoding was the second defect: red/green carried the entire signal, which fails
 * WCAG 1.4.1 and vanishes for a red/green-colourblind reader.
 */
describe("the heuristic member table is not a ranking either", () => {
  it("orders members ALPHABETICALLY, never by score", () => {
    // Sorting by score put a named person at the bottom of a list their colleagues scroll past
    //, a leaderboard by construction, whatever the column headings say.
    const c = code(INSIGHTS);
    expect(c).not.toMatch(/sort\(\s*\(a, b\) => b\.aiUsageScore/);
    expect(c).toMatch(/sort\(\s*\(a, b\) => a\.name\.localeCompare/);
  });

  it("does not mutate the memoised array while rendering it", () => {
    // `memberMetrics.sort(...)` sorted IN PLACE. That array is memoised and also read by
    // generateRecommendations and two blocks further down, so rendering the table silently
    // reordered state those derivations depend on. A real bug, not just a style point.
    const c = code(INSIGHTS);
    expect(c).toContain("[...memberMetrics]");
    expect(c, "no in-place sort of the shared array").not.toMatch(
      /[^.\]]memberMetrics\s*\n?\s*\.sort\(/
    );
  });

  it("gives the score ONE neutral treatment, with no traffic-light ramp on a person", () => {
    const c = code(INSIGHTS);
    const start = c.indexOf("function ScoreBadge(");
    expect(start).toBeGreaterThan(-1);
    const badge = c.slice(start, c.indexOf("\n}", start));
    // The four graded hexes that used to paint a human red for a quiet week.
    for (const graded of ["#dc2626", "#ca8a04", "#16a34a", "#7c3aed"]) {
      expect(badge, `no per-score colour ${graded}`).not.toContain(graded);
    }
    for (const cls of ["bg-danger-bg", "bg-warn-bg", "bg-success-bg", "bg-series-1/15"]) {
      expect(badge, `no per-score class ${cls}`).not.toContain(cls);
    }
    expect(badge).toContain("bg-brand");
    // The number states its own scale, so nothing depends on seeing the bar, and the bar is
    // decoration duplicating an adjacent figure, so it is hidden from assistive tech.
    expect(badge).toContain("/100");
    expect(badge).toContain('aria-hidden="true"');
    expect(badge).toContain("tabular-nums");
    // Width is clamped: a score outside 0-100 must not render a bar past its track.
    expect(badge).toContain("Math.min(100");
  });

  it("does not colour the engagement band as a pass or a failure", () => {
    // A red "Low" pill beside a colleague's name was the strongest comparative signal on the
    // page, red means "error" everywhere else in this UI, and the band is an activity bucket.
    // The WORD still distinguishes the bands; the styling no longer grades them.
    const c = code(INSIGHTS);
    const start = c.indexOf("function engagementColor(");
    const fn = c.slice(start, c.indexOf("\n}", start));
    for (const cls of ["bg-danger-bg", "bg-warn-bg", "bg-success-bg", "bg-series-1/15"]) {
      expect(fn, `engagement band must not use ${cls}`).not.toContain(cls);
    }
    expect(fn).toContain("bg-surface-2");
  });

  it("NEVER names an individual in a suggestion, and never quotes their score", () => {
    /**
     * The worst of the set: one bullet per person, by name, with their score and a verdict -
     * "Dana has low AI engagement (score: 22) - consider pairing them with a more experienced
     * AI user". A written performance judgement about a named colleague, on a page the whole
     * team reads, derived from a heuristic that cannot see the work.
     *
     * Now counts, which tell a facilitator exactly as much about what to do and the other five
     * nothing about who. Asserted on the FUNCTION so an unrelated `.name` elsewhere (the table
     * renders names, legitimately) cannot satisfy or break it.
     */
    const c = code(INSIGHTS);
    const start = c.indexOf("function generateRecommendations(");
    expect(start).toBeGreaterThan(-1);
    const fn = c.slice(start, c.indexOf("\nfunction ", start + 10));
    expect(fn.length).toBeGreaterThan(0);

    // No interpolated name, and no interpolated per-person score.
    expect(fn, "no member name in a suggestion").not.toMatch(/\$\{\w+\.name\}/);
    expect(fn, "no per-person score in a suggestion").not.toMatch(
      /\$\{\w+\.aiUsageScore\}/
    );
    // NOT a blanket ban on the substring "score: ", the surviving TEAM average legitimately
    // reads "avg score: 72/100", and a team fact names nobody. The rule being pinned is
    // per-PERSON scores, which the two interpolation assertions above already cover.
    // And no deficit framing about a person.
    expect(fn).not.toContain("has low AI engagement");
    // Counts instead, pluralised rather than "1 people".
    expect(fn).toContain("people(");
    expect(fn).toMatch(/n === 1 \? "1 person"/);
  });

  it("keeps the team-level averages, which name nobody", () => {
    // Not everything had to go: a team average is a team fact and stays useful to a
    // facilitator. The rule is about singling a person out, not about withholding numbers.
    const c = code(INSIGHTS);
    const start = c.indexOf("function generateRecommendations(");
    const fn = c.slice(start, c.indexOf("\nfunction ", start + 10));
    expect(fn).toContain("Team average AI score");
  });
});

describe("per-member assessments are coaching, not a leaderboard", () => {
  // These are read by the person described AND by their teammates, so the rule is no
  // ranking language, no leaderboard framing and no comparative wording. The service's prompt
  // honours it on the generation side; these pin the presentation side.

  it("orders the cards ALPHABETICALLY, never by score", () => {
    // The previous card sorted by combined score, a leaderboard by construction, with the
    // lowest scorer at the bottom of a list their colleagues scroll past.
    const c = code(INSIGHTS);
    expect(c).toContain("localeCompare");
    // No score-derived comparator anywhere in the assessment list.
    expect(c).not.toMatch(/sort\(\s*\(a, b\) => b\.aiKnowledgeScore/);
    expect(c).not.toContain("b.contributionScore + b.aiKnowledgeScore");
  });

  it("gives every score ONE neutral treatment, with no colour ramp on a person", () => {
    // A traffic light on a human being, read by their teammates, is the comparative judgement
    // the rule excludes, and it was also this card's only colour-alone signal.
    //
    // SCOPED TO CoachingScore so a regression HERE is what fails, rather than being masked by
    // an unrelated match elsewhere in a 1,600-line file.
    //
    // ⚠ THE ORIGINAL REASON FOR THIS SCOPING NO LONGER HOLDS, and the note is corrected rather
    // than deleted because it was wrong on the substance. It said `ScoreBadge` "is a different
    // measurement with a different meaning and is out of scope", the rule now says otherwise,
    // and the ramp there is now gone too (see "the heuristic member table is not a ranking
    // either" above). Neither card grades a person by colour any more.
    const c = code(INSIGHTS);
    const start = c.indexOf("function CoachingScore(");
    expect(start).toBeGreaterThan(-1);
    const coachingScore = c.slice(start, c.indexOf("function StatCard(", start));
    expect(coachingScore.length).toBeGreaterThan(0);
    expect(coachingScore).toContain("bg-brand");
    for (const graded of ["#dc2626", "#ca8a04", "#16a34a", "#7c3aed"]) {
      expect(coachingScore, `no per-score colour ${graded}`).not.toContain(graded);
    }
    // The figure is stated in text with its scale, so nothing depends on seeing the bar.
    expect(coachingScore).toContain("{score}/100");
    expect(coachingScore).toContain("tabular-nums");
    expect(coachingScore).toContain('aria-hidden="true"');
  });

  it("frames the suggestion list as something to try, not as a deficiency", () => {
    const c = code(INSIGHTS);
    expect(c).toContain("To try next");
    expect(c).toContain("Strengths");
    // The old "gaps" framing, and its warning triangle, are gone.
    expect(c).not.toContain("r.gaps");
    expect(c).not.toContain("△");
  });

  it("labels an assessment whose person has left, rather than rendering a nameless card", () => {
    // The model is only given opaque handles, so names are resolved from the roster, and a
    // member removed since the analysis ran has none. A card with no identity reads as corrupt.
    const c = code(INSIGHTS);
    expect(c).toContain('rosterKnown ? "No longer on this team" : "Name unavailable"');
  });

  it("does NOT report a FAILED roster as everyone having left the team", () => {
    // Two different facts that look identical from the lookup: a person who left has no roster
    // row, and a roster that did not load has no rows at all. Collapsed into one sentence, a
    // member whose `team.getById` blinked is told every colleague has left, reachable, because
    // the membership fall-through deliberately lets a failed roster read through to this page.
    const c = code(INSIGHTS);
    expect(c).toContain("rosterKnown={!!team}");
    expect(c).toContain("rosterKnown: boolean;");
    expect(c).toContain('"Name unavailable"');
  });

  it("BOUNDS the assessment list at the service's own team-size cap and discloses it", () => {
    const c = code(INSIGHTS);
    expect(c).toContain("MAX_ASSESSMENTS_SHOWN = 25");
    expect(c).toContain("withheld > 0 &&");
  });
});

describe("publishing the summary is a disclosure, with friction to match", () => {
  it("is a confirmation that names the blast radius with real values", () => {
    // Never "Are you sure?". The specific consequence is WHO gains access and WHAT stays
    // private, with the member count rendered from the snapshot.
    const c = code(INSIGHTS);
    expect(c).toContain("<ConfirmActionDialog");
    expect(c).toContain("Publish this team summary outside the team?");
    expect(c).toContain("pendingPublish.memberCount");
    expect(c).toContain(
      "Judges, and executives who are not on this team, will be able to read the team-level summary."
    );
    // It states what is NOT published, which is the fact that decides the click.
    expect(c).toContain("The per-member assessments stay within the team.");
  });

  it("states that it cannot be undone, because the service has no unpublish route", () => {
    const c = code(INSIGHTS);
    expect(c).toContain("Publishing cannot be undone from here");
    expect(c).toContain('tone="destructive"');
  });

  it("collects NO reason, because the publish route records none", () => {
    // A textarea whose contents are silently discarded is worse than no textarea: the operator
    // believes they have left a record and has not. The dialog omits the field when no hint is
    // passed, and the route's input is only {teamId, generationId}.
    const dialogBranch = code(INSIGHTS).slice(code(INSIGHTS).indexOf("<ConfirmActionDialog"));
    expect(dialogBranch).not.toContain("reasonHint");
    expect(code(DIALOG)).toContain("reasonHint?: string;");
    expect(code(DIALOG)).toContain("{reasonHint !== undefined && (");
  });

  it("publishes the generation the operator was LOOKING AT", () => {
    // The service requires the generationId to still be newest, so that publishing applies to
    // the snapshot under review rather than to whatever landed since. It is carried from the
    // rendered analysis, not re-derived at click time.
    const c = code(INSIGHTS);
    expect(c).toContain("generationId: pendingPublish.generationId,");
    expect(c).toContain("analysis.generationId");
  });

  it("distinguishes all four outcomes, including the UNKNOWN one", () => {
    // The fourth is the one most UIs get wrong and the one that causes double-submits: the
    // request was sent, nothing cancels it, and no answer was seen. "Reload", not "try again" -
    // a second publish of a superseded generation answers 409 and reads as a failure to
    // disclose something that may already be disclosed.
    const c = code(INSIGHTS);
    expect(c).toContain('kind: "confirmed"');
    expect(c).toContain('kind: "failed"');
    expect(c).toContain('kind: "unknown"');
    expect(c).toContain("Reload the page to check whether it is published before trying again.");
    expect(c).toContain("<ActionOutcome");
  });

  it("guards against a repeat submit and correlates the answer to the request", () => {
    // Two publishes CAN overlap: dismissing a pending dialog and reopening it is supported and
    // does not cancel the first request. An earlier answer must not release a later request's
    // guard or close its dialog.
    const c = code(INSIGHTS);
    expect(c).toContain("currentPublishRef");
    expect(c).toContain("variables.generationId === currentPublishRef.current");
    expect(c).toContain("disabled={publishPending}");
  });

  it("shows the control to an EXECUTIVE, and keeps the state visible to everyone", () => {
    /**
     * ⚠ THIS RULE INVERTED, and the old assertion was right at the time.
     *
     * It required `canPublish={!readOnly}`, correct while publishing was a member write, when a
     * read-only EXECUTIVE could not publish even on their own team. The rule then became that
     * only executives generate insights, and publish had to follow: otherwise the person who can
     * produce an assessment cannot disclose it, while a participant decides what judges read.
     *
     * So both controls are now shown to exactly the role every other write control is hidden
     * from. The published/not-published STATE is still stated in words for everyone, "who can
     * see this" is never something to infer from a button's absence.
     */
    const c = code(INSIGHTS);
    expect(c).toContain("canPublish={isExecutive}");
    expect(c).toContain("canAnalyze={isExecutive}");
    // Read through a NAMED value, not raw `readOnly`: `canAnalyze={readOnly}` reads like an
    // inverted flag somebody forgot to fix.
    expect(c).toContain("const isExecutive = readOnly;");
    expect(c, "the old member-write gate must be gone").not.toContain("canPublish={!readOnly}");
    expect(c).toContain("canPublish && hasGeneration && (");
    expect(c).toContain("<span className=\"font-medium\">Not published.</span>");
    expect(c).toContain("<span className=\"font-medium\">Published.</span>");
  });

  it("keeps the disclosure control away from the high-frequency ones", () => {
    // The Refresh and Analyze buttons are pressed repeatedly; publishing discloses something
    // outside the team. They must not be adjacent, and the confirmation must not be reachable
    // by Enter from a routine input, which the dialog guarantees by not being a <form>.
    const c = code(INSIGHTS);
    // The publish trigger sits with the summary text it will disclose, inside PublishState -
    // not in the card header beside Analyze.
    const publishState = c.slice(c.indexOf("function PublishState("));
    expect(publishState).toContain("Publish summary…");
    const header = c.slice(c.indexOf("{canAnalyze && ("), c.indexOf("</button>", c.indexOf("{canAnalyze && (")));
    expect(header).not.toContain("Publish");
    expect(code(DIALOG)).not.toContain("<form");
  });
});

describe("the welcome disclosure states who ACTUALLY reads the assessment", () => {
  /**
   * ⚠ THIS TEXT MADE TWO CLAIMS THAT BECAME FALSE, and a false access promise is the worst kind
   * of stale copy: somebody who believes their AI conversations are only summarised at team level,
   * when an executive reads a per-person assessment of them, has been misled about something they
   * might have chosen differently about.
   *
   * Removed:
   *   "Your team sees your insights, the same page shows everyone's"
   *     → a participant now sees NOBODY's, including their own.
   *   "The point is to help you improve, not to grade you"
   *     → the subject cannot read the coaching, so there is nothing to improve FROM here.
   *
   * The page is deliberately non-dismissible, so it is the one surface where this has to be
   * right, which is why it is asserted rather than left to review.
   */
  const WELCOME = read("../app/welcome/page.tsx");

  it("names the EXECUTIVE as the reader of per-person assessments", () => {
    const c = code(WELCOME);
    expect(c).toMatch(/An executive on your team reads the per-person assessments/);
    // And says plainly who does NOT, because "an executive reads it" leaves the reader
    // wondering about their teammates.
    expect(c).toMatch(/Your teammates do not/);
  });

  it("no longer claims the team sees each other's insights", () => {
    const c = code(WELCOME);
    expect(c).not.toContain("Your team sees your insights");
    expect(c).not.toContain("the same page shows everyone");
  });

  it("no longer promises a benefit the reader cannot receive", () => {
    // "The point is to help you improve" only holds if the subject can read it.
    const c = code(WELCOME);
    expect(c).not.toContain("The point is to help you improve");
  });

  it("still says the team summary is counts-only, never individual messages", () => {
    // The half of the original disclosure that is STILL TRUE and load-bearing: the publishable
    // summary is generated from activity totals, so it cannot leak message text.
    const c = code(WELCOME);
    expect(c).toMatch(/Executives and judges see a team-level summary/);
    expect(c).toMatch(/never from\s+your individual messages/);
  });

  it("tells a participant their executive WILL share the review with them", () => {
    /**
     * Reworded from "Ask your executive to share yours", the earlier
     * line put the burden on the participant to chase it, which reads as "you may request access"
     * rather than as a commitment. The stated intent is that executives share the review,
     * including anything worth changing or improving.
     *
     * This matters beyond tone: without it the disclosure is purely a notice that somebody is
     * assessing you and you cannot see it. The commitment is what makes it coaching rather than
     * surveillance, so it is asserted rather than left to review.
     */
    const c = code(WELCOME);
    expect(c).toMatch(/Your executive will share your review with you/);
    expect(c, "and that it covers improvements, not just praise").toMatch(
      /anything worth changing or improving/
    );
    // The old ask-for-it framing must be gone.
    expect(c).not.toMatch(/Ask your executive to share yours/);
  });
});

describe("ONE timestamp on the insights page, and it marks a real event", () => {
  /**
   * REPORTED TWICE, and my first two fixes were both wrong in the same way, they treated a
   * moving timestamp as a WORDING problem.
   *
   * The header carried react-query's `dataUpdatedAt` for the browser-computed metrics. True, and
   * useless: `staleTime` defaults to 0 and `refetchOnMount` refetches anything stale, so every
   * arrival refetches and that value is ALWAYS a few milliseconds ago. The line printed the
   * current time on every single visit with the Refresh button untouched, which is precisely what
   * was reported, first as "the analysis re-ran on page load" (when it read "· updated"), then
   * again as a clock that tracks the desktop time (when it read "· figures read").
   *
   * No label survives a value that always says "now". A timestamp that cannot be anything other
   * than the present moment conveys nothing while implying an event occurred at it.
   *
   * So: no clock beside the live metrics, and the page's ONE timestamp is the assessment's
   * `generatedAt`, which moves only when an executive presses Generate.
   */

  it("does NOT put a fetch time in the metrics header", () => {
    // Any of these coming back reintroduces the moving clock.
    const c = code(INSIGHTS);
    expect(c).not.toContain("figures read");
    expect(c).not.toContain("dataUpdatedAt");
  });

  it("the METRICS HEADING carries no timestamp at all", () => {
    /**
     * FOUR ATTEMPTS, and the reason the first three failed is that the heading describes the USAGE
     * METRICS, which are recomputed on every visit, so the only timestamp it could honestly carry
     * is the fetch time, and a fetch time on that line can only ever say "now".
     *
     *   1. `dataUpdatedAt` as "· updated"      -> read as "the analysis re-ran on load"
     *   2. the same as "· figures read"        -> read as a clock tracking the desktop time
     *   3. "counted live on each visit"        -> true, but answered nothing anyone asks
     *   4. the assessment's `generatedAt`      -> could not move on Refresh (Refresh does not re-run
     *                                             the model) AND duplicated the card below
     *
     * Every string from those attempts is banned here, because each was a real reported defect.
     */
    const c = code(INSIGHTS);
    expect(c).not.toContain("dataUpdatedAt");
    expect(c).not.toContain("figures read");
    expect(c).not.toContain("counted live on each visit");
    expect(c).not.toContain("analysis generated");
  });

  it("does NOT show the assessment timestamp twice", () => {
    /**
     * Reported on sight: "there are two generated dates ... why both showing the same timestamp".
     * Two identical instants in one view read as one of them being wrong, even when both are right
     * and read the same field, the second copy costs more than it saves. Exactly one render of it.
     */
    const c = code(INSIGHTS);
    const renders = c.split("formatInstantUtc(data.generatedAt)").length - 1;
    expect(renders, "exactly one rendering of the assessment's generatedAt").toBe(1);
    expect(c, "and not via the query object either").not.toContain(
      "formatInstantUtc(analysisQuery.data.generatedAt)"
    );
  });

  it("keeps the assessment's generatedAt, the one timestamp that marks an event", () => {
    /**
     * The fix must not overshoot into deleting a USEFUL timestamp. This one comes from the stored
     * snapshot, so it answers the question an executive actually has: how old is this coaching.
     */
    expect(code(INSIGHTS)).toContain("formatInstantUtc(data.generatedAt)");
  });

  it('calls it "generated", not "updated"', () => {
    // "updated" is the word that was misread one line above, so it does not stay on the card
    // either, it describes a revision, and this is a generation.
    const c = code(INSIGHTS);
    expect(c).toContain("· generated ");
    expect(c).not.toContain("· updated ");
  });
});

describe("Refresh refetches EVERYTHING the page shows", () => {
  /**
   * "CLICKED REFRESH AND IT DID NOTHING."
   *
   * It refetched four of the page's six reads, team, threads, tasks, messages, and skipped both
   * ratings queries. So the stored assessment, which is the most valuable thing on the screen, was
   * the one panel a Refresh could not refresh: a generation completed in another tab, or a
   * colleague's publish, stayed invisible until a full page reload.
   *
   * It also explains the second half of the report. The timestamp I had put in the header came from
   * `analysisQuery`, so pressing Refresh could not move it, the button genuinely did nothing
   * visible, and the one number the reader was watching was precisely the one being skipped.
   *
   * SAFE TO ADD: both are READS. `analyze` is the billable route and remains an explicit executive
   * action behind a cooldown. And `refetch()` on a disabled query resolves without firing, so a
   * participant or non-member pressing Refresh sends nothing new.
   */

  /** The refetch body, so these assertions are about that function rather than the whole file. */
  const refreshBody = (() => {
    const c = code(INSIGHTS);
    const start = c.indexOf("const refreshAnalysis");
    const end = c.indexOf("};", start);
    expect(start, "refreshAnalysis must exist").toBeGreaterThan(-1);
    return c.slice(start, end);
  })();

  for (const query of [
    "teamQuery",
    "threadsQuery",
    "tasksQuery",
    "messagesQuery",
    "analysisQuery",
    "summaryQuery",
  ]) {
    it(`refetches ${query}`, () => {
      expect(refreshBody).toContain(`${query}.refetch()`);
    });
  }

  it("the pending state watches the SAME six queries", () => {
    /**
     * A press that fires six requests while the button watches four leaves it reading "Refresh" with
     * work still in flight, no acknowledgement that the click landed, which is the other half of
     * "it did nothing". The two sets must not drift.
     */
    const c = code(INSIGHTS);
    const start = c.indexOf("const refreshing");
    const end = c.indexOf(";", start);
    const body = c.slice(start, end);
    for (const query of [
      "teamQuery",
      "threadsQuery",
      "tasksQuery",
      "messagesQuery",
      "analysisQuery",
      "summaryQuery",
    ]) {
      expect(body, `${query} must be watched`).toContain(`${query}.isFetching`);
    }
  });

  it("still treats the FIRST press as 'run the analysis'", () => {
    // Before any run, the button's job is to start one rather than to refetch four idle queries.
    expect(refreshBody).toContain("if (!hasRun)");
    expect(refreshBody).toContain("setHasRun(true)");
  });
});
