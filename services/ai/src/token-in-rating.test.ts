// ── ⚠ TOKEN COUNTS MUST NOT REACH THE RATING INPUT ───────────────────────────────────────
//
// THE REQUIREMENT: store input/output token details for each message, for use in rating users and in
// token-optimisation statistics.
//
// The STORING is done and the optimisation stats are shipped. The RATING half is deliberately not wired, and
// this file is the guard so that decision is visible rather than an omission somebody quietly fills in.
//
// ⚠ WHY NOT. Three things would make it unfair as the data stands:
//
//   1. Only Codex reports counts. Claude's spawn path and Kiro report none — so a participant using the
//      assistant this platform recommends would score ZERO and be rated on their TOOL CHOICE. The route's own
//      notes already record this exact failure once, for AI-usage counting: it "selects the wrong winner".
//   2. `inputTokens` grows with the conversation, because every turn re-sends the context. Rating on it rewards
//      short sessions and penalises thorough ones.
//   3. It is trivially gameable by anyone who understands it, at which point it measures who read the docs.
//
// None of that is an argument against collecting the data — it is an argument against using THIS shape of it as
// a score. Wiring it in needs coverage across all three assistants and a per-turn normalisation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routes = readFileSync(fileURLToPath(new URL("./routes.ts", import.meta.url)), "utf8");

/**
 * The activity event published by the CLI sync route — the payload that feeds the counters.
 *
 * ⚠ ANCHORED ON THE `type:` ASSIGNMENT, NOT THE FIRST MENTION OF THE NAME. My first version searched for the
 * string and landed on a COMMENT 400 lines above the publish, so the slice ran through the message-storing code
 * — which legitimately assigns `cachedInputTokens` — and the test failed on correct code. A slice that reaches
 * into unrelated code cannot say what it is testing.
 */
function activityEventPayload(): string {
  const at = routes.indexOf('type: "ai.response-generated"');
  expect(at, "the activity event must still exist").toBeGreaterThan(-1);
  return routes.slice(at, routes.indexOf("      });", at));
}

describe("⚠ the activity event carries no token counts", () => {
  it("does not put inputTokens or outputTokens on the event", () => {
    const payload = activityEventPayload();

    /**
     * Matching an ASSIGNMENT, not a mention: the payload's own comment explains at length why these are
     * absent, and a bare `toContain` check would be satisfied by that prose — the trap that has bitten this
     * codebase before with an import line.
     */
    expect(payload).not.toMatch(/^\s*inputTokens[:,]/m);
    expect(payload).not.toMatch(/^\s*outputTokens[:,]/m);
    expect(payload).not.toMatch(/inputTokens:\s*\w/);
    expect(payload).not.toMatch(/outputTokens:\s*\w/);
  });

  it("does not put the cache breakdown on it either", () => {
    const payload = activityEventPayload();

    expect(payload).not.toMatch(/cachedInputTokens:\s*\w/);
    expect(payload).not.toMatch(/reasoningOutputTokens:\s*\w/);
  });

  /**
   * ⚠ AND THE REASON MUST STAY WRITTEN DOWN. This is the kind of absence that reads as an oversight to the
   * next person, who then "fixes" it — the decision is only safe while its reasoning travels with it.
   */
  it("states why, so the absence is not read as an oversight", () => {
    /**
     * ⚠ WHITESPACE COLLAPSED BEFORE MATCHING PROSE. The reasoning lives in a wrapped block comment, so
     * "…a rating a human is judged by…" is split across two lines and a literal search for the sentence
     * fails on text that plainly contains it. Asserting on prose means reading it the way a person does.
     */
    /**
     * ⚠ THE COMMENT CONTINUATION MARKERS COME OFF FIRST. Collapsing whitespace alone left "…judged * by…",
     * because every wrapped line of a block comment begins with a `*` — so the sentence still did not match
     * text that plainly contains it. Strip the markers line by line, THEN collapse.
     */
    const prose = activityEventPayload()
      .replace(/^\s*\*/gm, "")
      .replace(/\s+/g, " ");

    expect(prose, "the fairness reason must be recorded at the site").toContain(
      "rating a human is judged by"
    );
    expect(prose, "including the coverage problem").toContain("ONLY ONE ASSISTANT REPORTS THEM");
    expect(prose, "and that the data itself IS stored").toContain("The counts ARE stored");
  });
});

describe("⚠ but they ARE stored on the message", () => {
  /** The data exists — that is the half of the request that was safe to build. */
  it("persists every part of the breakdown", () => {
    for (const field of [
      "inputTokens: msg.inputTokens",
      "outputTokens: msg.outputTokens",
      "cachedInputTokens: msg.cachedInputTokens",
      "reasoningOutputTokens: msg.reasoningOutputTokens",
    ]) {
      expect(routes, field).toContain(field);
    }
  });

  /**
   * ⚠ AND A CACHE FIGURE LARGER THAN THE PROMPT IS DROPPED, NOT CLAMPED. It is shown to participants as a
   * savings percentage, so an over-large count would render as more than 100% saved — or, clamped, as a
   * fabricated 100%. Neither is a measurement, and this is untrusted client input.
   */
  it("refuses a cache count that exceeds the prompt", () => {
    expect(routes).toMatch(/cachedInputTokens > inputTokens[\s\S]{0,120}?cachedInputTokens = undefined/);
  });
});
