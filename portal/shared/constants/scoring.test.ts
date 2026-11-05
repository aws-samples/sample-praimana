import { describe, it, expect } from "vitest";
import {
  SCORE_MIN,
  SCORE_MAX,
  SCORE_CRITERIA,
  MAX_SCORE_PER_JUDGE,
  MAX_SCORE_COMMENT_CHARS,
  scoreFieldErrors,
  judgeMean,
  roundHalfUp2dp,
} from "./scoring";
import { MAX_TEAM_MESSAGE_CHARS } from "./chat-limits";

/**
 * The scale and the predicate. Each test name states the rule it checks, so a failure here names
 * the rule it broke.
 */

/** A body where every criterion is valid — each test spoils exactly one thing. */
const valid = () => ({
  innovation: 8,
  execution: 7,
  impact: 6,
  presentation: 10,
});

describe("the scale", () => {
  it("runs 1–10, and the per-judge maximum is derived rather than written twice", () => {
    expect(SCORE_MIN).toBe(1);
    expect(SCORE_MAX).toBe(10);
    // ⚠ 40, NOT 50, SINCE `aiUsage` WAS DROPPED. Asserted as a literal AS WELL as
    // against the derivation: the derived form alone would keep passing if the list changed by
    // accident, and the maximum is a number judges and teams see on screen.
    expect(MAX_SCORE_PER_JUDGE).toBe(40);
    expect(MAX_SCORE_PER_JUDGE, "must equal SCORE_MAX × the criteria count").toBe(
      SCORE_MAX * SCORE_CRITERIA.length
    );
  });

  it("has exactly the four criteria, in its order", () => {
    /**
     * ⚠ `aiUsage` WAS DROPPED and its absence is asserted, not merely un-asserted.
     * It had become a criterion with nothing to judge from: "How you used your AI assistant" had
     * already come off the submission form, so for a few days a fifth of every judge's score was
     * awarded against a narrative the team could no longer write.
     */
    expect([...SCORE_CRITERIA]).toEqual([
      "innovation",
      "execution",
      "impact",
      "presentation",
    ]);
    expect(SCORE_CRITERIA, "aiUsage must not come back without a decision").not.toContain("aiUsage");
  });

  /**
   * ⚠ A DRIFT TEST, in the spirit of `chat-limits.drift.test.ts`. The comment cap is deliberately
   * the SAME NUMBER as a chat message rather than an independent choice, so if someone changes one
   * they are told the other exists.
   */
  it("caps a judge's comment at the same length as a team chat message", () => {
    expect(MAX_SCORE_COMMENT_CHARS).toBe(MAX_TEAM_MESSAGE_CHARS);
  });
});

describe("scoreFieldErrors — what a score must satisfy", () => {
  it("accepts a fully valid body", () => {
    expect(scoreFieldErrors(valid())).toEqual([]);
  });

  it("accepts both ends of the scale", () => {
    expect(scoreFieldErrors({ ...valid(), innovation: SCORE_MIN })).toEqual([]);
    // The top of the scale is accepted too.
    expect(scoreFieldErrors({ ...valid(), innovation: SCORE_MAX })).toEqual([]);
  });

  /** And it must NAME the field, which is why this returns a list. */
  it("999 is refused, and the offending field is named", () => {
    expect(scoreFieldErrors({ ...valid(), innovation: 999 })).toEqual(["innovation"]);
  });

  /**
   * The whole reason coercion is gone. `Number("abc") || 0` used to make this a stored 0.
   */
  it("a non-numeric string is refused, not silently turned into 0", () => {
    expect(scoreFieldErrors({ ...valid(), innovation: "abc" })).toEqual(["innovation"]);
  });

  /** The scale starts at 1, so 0 is not "the lowest score", it is a refusal. */
  it("0 is refused", () => {
    expect(scoreFieldErrors({ ...valid(), innovation: 0 })).toEqual(["innovation"]);
  });

  it("refuses a negative", () => {
    expect(scoreFieldErrors({ ...valid(), impact: -3 })).toEqual(["impact"]);
  });

  /** Ten discrete choices; 7.5 means a form offered something the scale lacks. */
  it("a non-integer is refused", () => {
    expect(scoreFieldErrors({ ...valid(), execution: 7.5 })).toEqual(["execution"]);
  });

  it("refuses a missing criterion rather than defaulting it", () => {
    const body: Record<string, unknown> = valid();
    delete body.presentation;
    expect(scoreFieldErrors(body)).toEqual(["presentation"]);
  });

  it("refuses null and undefined", () => {
    expect(scoreFieldErrors({ ...valid(), impact: null })).toEqual(["impact"]);
    expect(scoreFieldErrors({ ...valid(), impact: undefined })).toEqual(["impact"]);
  });

  it("refuses NaN and Infinity, which are numbers but not scores", () => {
    expect(scoreFieldErrors({ ...valid(), impact: NaN })).toEqual(["impact"]);
    expect(scoreFieldErrors({ ...valid(), impact: Infinity })).toEqual(["impact"]);
  });

  /**
   * ⚠ A NUMERIC STRING IS REFUSED TOO. Easy to accept, and deliberately not: coercion is how the
   * original defect arrived. JSON carries numbers as numbers.
   */
  it('refuses "7" rather than parsing it', () => {
    expect(scoreFieldErrors({ ...valid(), execution: "7" })).toEqual(["execution"]);
  });

  it("reports EVERY offender, not just the first", () => {
    expect(
      scoreFieldErrors({ innovation: 0, execution: 99, impact: 6, presentation: "x" })
    ).toEqual(["innovation", "execution", "presentation"]);
  });

  it("ignores unknown keys — extra fields are not this predicate's business", () => {
    expect(scoreFieldErrors({ ...valid(), overall: 11, comment: "fine" })).toEqual([]);
  });
});

describe("judgeMean", () => {
  it("is the mean of the four criteria", () => {
    // 8 + 7 + 6 + 11? No — the mean of 8, 7, 6, 10 is 7.75. Written out because a mean that happened
    // to be a round number was what made the five-criterion version of this test readable.
    expect(judgeMean({ innovation: 8, execution: 7, impact: 6, presentation: 10 })).toBe(7.75);
  });

  /**
   * ⚠ UNROUNDED ON PURPOSE. The final value rounds ONCE, after averaging across judges. Rounding
   * here as well would move a team's place, so this asserts the raw fraction survives.
   */
  it("does not round — the caller rounds once, later", () => {
    expect(
      judgeMean({ innovation: 1, execution: 1, impact: 1, presentation: 2 })
    ).toBeCloseTo(1.25, 10);
    expect(judgeMean({ innovation: 1, execution: 2, impact: 2, presentation: 2 })).toBe(1.75);
  });

  it("returns the maximum when every criterion is maxed", () => {
    const maxed = Object.fromEntries(SCORE_CRITERIA.map((c) => [c, SCORE_MAX])) as Record<
      (typeof SCORE_CRITERIA)[number],
      number
    >;
    expect(judgeMean(maxed)).toBe(SCORE_MAX);
  });
});

describe("roundHalfUp2dp", () => {
  it("rounds to two decimal places", () => {
    expect(roundHalfUp2dp(8.234)).toBe(8.23);
    expect(roundHalfUp2dp(8.236)).toBe(8.24);
  });

  /**
   * ⚠ THE BOUNDARY THAT BARE `Math.round(x * 100) / 100` GETS WRONG. `1.005` is held as
   * 1.00499999999999989…, so the naive form yields 1.00 — not the 1.01 "half-up" promises. Teams
   * are RANKED on this number, so the boundary decides places.
   */
  it("rounds a .005 boundary UP, where naive multiplication rounds it down", () => {
    expect(roundHalfUp2dp(1.005)).toBe(1.01);
    expect(roundHalfUp2dp(8.005)).toBe(8.01);
    // The naive form, pinned so the difference is visible rather than asserted in prose.
    expect(Math.round(1.005 * 100) / 100, "the form NOT used here").toBe(1);
  });

  it("leaves an already-2dp value alone", () => {
    expect(roundHalfUp2dp(7.5)).toBe(7.5);
    expect(roundHalfUp2dp(10)).toBe(10);
    expect(roundHalfUp2dp(0)).toBe(0);
  });

  it("is stable when applied twice", () => {
    const once = roundHalfUp2dp(8.3466);
    expect(roundHalfUp2dp(once)).toBe(once);
  });
});
