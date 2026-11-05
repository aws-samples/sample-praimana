import { describe, it, expect } from "vitest";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * THE GATEWAY THROTTLE, asserted against the template.
 *
 * ⚠ WHY A TEMPLATE TEST AND NOT A UNIT TEST. Throttling is not code — it is four numbers and a route
 * key in CloudFormation, and the ways it goes silently wrong are all structural:
 *
 *   · the RouteSettings key must match a route that EXISTS, or the whole block is inert. This is the
 *     real trap: the AI service is otherwise mapped as one greedy `ANY /v1/ai/{proxy+}`, so a
 *     per-route limit needs a dedicated route added FIRST. Settings referring to a non-existent
 *     route key deploy cleanly and do nothing.
 *   · DetailedMetricsEnabled must be on, or the throttle is unobservable and nobody can prove it
 *     fired — the standing rule is that overload sheds load OBSERVABLY.
 *   · the burst must exceed the rate, or a legitimate batched Refresh (six calls at once) is refused.
 *
 * None of that is reachable from a unit test of the handler, and all of it is a one-character edit
 * away from breaking. What this CANNOT prove is that API Gateway prefers the specific path over the
 * greedy one — that needs a live probe, which the deploy notes carry (the deploy notes record the
 * inverse trap producing a production 404 on a fully-tested route).
 */

/**
 * ⚠ `infrastructureTemplateText()` RETURNS "" WHEN THE TEMPLATE IS ABSENT, NOT NULL, and the
 * difference decides whether this file loads. Module-scope helpers below derive values from
 * TEMPLATE during COLLECTION, before any `describe` runs, so a null would throw and the file would
 * FAIL rather than skip. `HAS_TEMPLATE` is what gates the assertions.
 */
const TEMPLATE = infrastructureTemplateText();
const HAS_TEMPLATE = hasInfrastructureTemplate();

/** The exact route key the RouteSettings block is keyed on. */
const ANALYZE_ROUTE_KEY = "POST /v1/ai/teams/{teamId}/ratings/analyze";
/** The path that route key refers to, as an Events mapping. */
const ANALYZE_PATH = "/v1/ai/teams/{teamId}/ratings/analyze";

describe.skipIf(!HAS_TEMPLATE)("the aggregate ceiling exists", () => {
  it("sets a stage-wide rate and burst", () => {
    // Before this the account default of 10,000 rps / 5,000 burst was in force — verified against
    // the LIVE stage, which carried only {DetailedMetricsEnabled: false} and no RouteSettings.
    expect(TEMPLATE).toContain("DefaultRouteSettings:");
    expect(TEMPLATE).toMatch(/ThrottlingRateLimit:\s*200/);
    expect(TEMPLATE).toMatch(/ThrottlingBurstLimit:\s*400/);
  });

  it("BURST EXCEEDS RATE, so a batched Refresh is not refused", () => {
    /**
     * The insights Refresh fires six backend calls at once and a cold page load 5-8. A bucket sized
     * to the steady rate would refuse a legitimate simultaneous click by a handful of people — and a
     * limit that fires during normal workshop use is worse than none.
     */
    const rate = Number(/ThrottlingRateLimit:\s*(\d+)/.exec(TEMPLATE)?.[1]);
    const burst = Number(/ThrottlingBurstLimit:\s*(\d+)/.exec(TEMPLATE)?.[1]);
    expect(rate).toBeGreaterThan(0);
    expect(burst).toBeGreaterThan(rate);
  });

  it("enables detailed metrics, or the throttle is invisible", () => {
    // Without per-route metrics there is no 4xx signal to alarm on, and an unobservable control is
    // one nobody can prove fired. It is the one setting already on the live stage, set to FALSE.
    expect(TEMPLATE).toContain("DetailedMetricsEnabled: true");
    /**
     * Checked against the CONFIG, not the whole file: a first version of this assertion banned the
     * string "DetailedMetricsEnabled: false" outright and failed on my own COMMENT, which quotes the
     * live stage's previous value. The comment is accurate and worth keeping, so the assertion is
     * what changed — narrowed to the two settings blocks by stripping comment lines first.
     */
    const config = TEMPLATE.replace(/^\s*#.*$/gm, "");
    expect(config).not.toContain("DetailedMetricsEnabled: false");
  });
});

describe.skipIf(!HAS_TEMPLATE)("the expensive route is throttled harder — and its ROUTE EXISTS", () => {
  it("has RouteSettings for the analyze route", () => {
    expect(TEMPLATE).toContain(`"${ANALYZE_ROUTE_KEY}":`);
    // 1 rps / burst 5. Legitimate load is already bounded by the 10-minute cooldown to ~0.008 rps
    // across single-digit teams; burst 5 covers five executives on five teams pressing at once.
    const block = TEMPLATE.slice(TEMPLATE.indexOf(`"${ANALYZE_ROUTE_KEY}":`));
    expect(block).toMatch(/ThrottlingRateLimit:\s*1\b/);
    expect(block).toMatch(/ThrottlingBurstLimit:\s*5\b/);
  });

  it("⚠ DEFINES THE ROUTE THE SETTINGS REFER TO — without it the block is INERT", () => {
    /**
     * THE ASSERTION THAT MATTERS MOST HERE, and the one that would fail silently in production.
     *
     * RouteSettings are keyed by route key. The AI service is mapped as one greedy route
     * (`ANY /v1/ai/{proxy+}`), and a settings block naming a route key that does not exist deploys
     * without error and throttles nothing. So the explicit mapping is a PREREQUISITE, not a tidy-up:
     * delete it and the 1 rps limit quietly evaporates while the template still reads as though it
     * were enforced.
     */
    expect(TEMPLATE, "the RatingsAnalyze event mapping").toContain("RatingsAnalyze:");
    expect(TEMPLATE).toContain(`Path: "${ANALYZE_PATH}"`);

    // And it must be a POST-only mapping — `ANY` would swallow the GET routes under the same
    // punitive limit, and `analysis` (a read) sits one path segment away.
    const mapping = TEMPLATE.slice(TEMPLATE.indexOf("RatingsAnalyze:"));
    const method = /Method:\s*(\w+)/.exec(mapping)?.[1];
    expect(method).toBe("POST");
  });

  it("keeps the greedy AI route, so every other path still resolves", () => {
    // The explicit route is an addition, not a replacement: ratings/analysis, getThreads, messages
    // and timing all still need to reach the same function.
    expect(TEMPLATE).toContain('Path: "/v1/ai/{proxy+}"');
  });

  it("the per-route limit is STRICTER than the stage limit", () => {
    // Otherwise the specific setting is decorative — the stage ceiling would bind first.
    const stageRate = Number(/ThrottlingRateLimit:\s*(\d+)/.exec(TEMPLATE)?.[1]);
    const routeBlock = TEMPLATE.slice(TEMPLATE.indexOf(`"${ANALYZE_ROUTE_KEY}":`));
    const routeRate = Number(/ThrottlingRateLimit:\s*(\d+)/.exec(routeBlock)?.[1]);
    expect(routeRate).toBeLessThan(stageRate);
  });
});

/**
 * ⚠ ABSENT SIBLING REPO ⇒ A TODO, NEVER A SILENT PASS. Every assertion above is skipped when the
 * infrastructure repo is not checked out beside this one, so this reports the gap in the run summary
 * instead of leaving a low test count to be noticed by nobody. See `sibling-repo.ts`.
 */
if (!HAS_TEMPLATE) {
  describe("the infrastructure template", () => {
    it.todo(TEMPLATE_ABSENT_TODO);
  });
}
