// ── ⚠ A TOTAL THAT CANNOT OVERSTATE ITSELF ───────────────────────────────────────────────
//
// The counts come from the CLI's own `turn.completed`, so nothing here is estimated. What these tests protect
// is the one way this could still lie: treating "never counted" as zero. The columns have existed since the
// baseline and were never written to, so almost every existing row has no counts — a total that silently
// counted those as 0 would understate a real conversation while looking authoritative.

import { describe, it, expect } from "vitest";
import { cacheSavings, describeTotals, formatTokens, hasTokens, totalTokens } from "./token-display";

const reply = (input: number | null, output: number | null) => ({
  role: "assistant",
  input_tokens: input,
  output_tokens: output,
});
const userTurn = () => ({ role: "user", input_tokens: null, output_tokens: null });

describe("⚠ never counted is not zero", () => {
  it("sums only the replies that were counted, and says how many", () => {
    const t = totalTokens([userTurn(), reply(1000, 50), userTurn(), reply(1200, 70)]);

    expect(t.input).toBe(2200);
    expect(t.output).toBe(120);
    expect(t.counted).toBe(2);
    expect(t.assistantTurns).toBe(2);
    expect(t.partial, "everything accounted for").toBe(false);
  });

  /** THE assertion this module exists for. */
  it("flags a partial total instead of implying the uncounted turns were free", () => {
    const t = totalTokens([userTurn(), reply(900, 40), userTurn(), reply(null, null)]);

    expect(t.input, "only what was counted").toBe(900);
    expect(t.counted).toBe(1);
    expect(t.assistantTurns).toBe(2);
    expect(t.partial).toBe(true);
  });

  it("says so in words, since a number alone cannot", () => {
    const partial = describeTotals(totalTokens([userTurn(), reply(900, 40), reply(null, null)]));
    const whole = describeTotals(totalTokens([reply(900, 40)]));

    expect(partial).toContain("1 of 2");
    expect(partial).toContain("minimum");
    expect(whole, "a complete total must not claim to be a floor").not.toContain("minimum");
  });

  /**
   * ⚠ USER ROWS ARE NOT TURNS. Counting them in `assistantTurns` would halve the coverage of every
   * conversation and report "(min)" on a fully-counted one.
   */
  it("ignores user messages entirely", () => {
    const t = totalTokens([userTurn(), userTurn(), reply(500, 25)]);

    expect(t.assistantTurns).toBe(1);
    expect(t.partial).toBe(false);
  });

  it("is empty for a conversation with no replies at all", () => {
    const t = totalTokens([userTurn()]);

    expect(t).toEqual({
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      cacheCounted: 0,
      counted: 0,
      assistantTurns: 0,
      partial: false,
    });
  });

  /** One count present and the other absent still counts as measured — half a fact is not no fact. */
  it("accepts a reply that reported only one of the two", () => {
    const t = totalTokens([reply(null, 25)]);

    expect(t.counted).toBe(1);
    expect(t.input).toBe(0);
    expect(t.output).toBe(25);
    expect(t.partial, "it WAS counted").toBe(false);
  });

  /** A real zero is a measurement and must survive — the distinction everything above depends on. */
  it("keeps a genuine zero", () => {
    const t = totalTokens([reply(0, 0)]);

    expect(t.counted).toBe(1);
    expect(t.partial).toBe(false);
  });

  it("refuses a nonsensical value rather than adding it", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const t = totalTokens([reply(bad, 10)]);
      expect(t.input, String(bad)).toBe(0);
      expect(t.output).toBe(10);
    }
  });
});

describe("hasTokens", () => {
  it("is false for a row nobody counted", () => {
    expect(hasTokens({ input_tokens: null, output_tokens: null })).toBe(false);
    expect(hasTokens({})).toBe(false);
  });

  it("is true when either count is present, including zero", () => {
    expect(hasTokens({ output_tokens: 0 })).toBe(true);
    expect(hasTokens({ input_tokens: 12 })).toBe(true);
  });
});

describe("formatTokens", () => {
  it("abbreviates without losing the magnitude", () => {
    expect(formatTokens(931)).toBe("931");
    expect(formatTokens(13027)).toBe("13k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  it("never prints NaN or a negative", () => {
    expect(formatTokens(Number.NaN)).toBe("—");
    expect(formatTokens(-1)).toBe("—");
  });
});

describe("⚠ the wording does not claim the input was typed", () => {
  /**
   * `inputTokens` is each turn's WHOLE prompt, so it grows with the conversation and summing re-counts the
   * earlier turns. Calling it "input" invites reading it as what the participant wrote.
   */
  it("describes the context as re-counted, not as authored", () => {
    const text = describeTotals(totalTokens([reply(1000, 50)]));

    expect(text).toContain("context");
    expect(text).toContain("re-counts");
    expect(text).toContain("generated");
  });
});

// ── ⚠ A SAVINGS FIGURE THAT CANNOT FLATTER ITSELF ────────────────────────────────────────
//
// The number is `cached / input` — the share of the prompt Codex served from cache rather than re-sending —
// which is MEASURED. These tests exist because the two easy ways to get this wrong both produce a confident
// percentage: comparing against a hypothetical "worse prompt", and reporting 0% when nobody measured.

describe("⚠ cache savings", () => {
  const withCache = (input: number, cached: number) => ({
    role: "assistant",
    input_tokens: input,
    output_tokens: 10,
    cached_input_tokens: cached,
  });

  it("reports the measured share of the prompt served from cache", () => {
    const s = cacheSavings(totalTokens([withCache(1000, 500)]));

    expect(s).toEqual({ percent: 50, covered: 1 });
  });

  it("totals across turns rather than averaging percentages", () => {
    /* 3000 of 4000 cached — averaging the two turns' percentages would give 62.5%, which is not the saving. */
    const s = cacheSavings(totalTokens([withCache(1000, 250), withCache(3000, 2750)]));

    expect(s!.percent).toBe(75);
    expect(s!.covered).toBe(2);
  });

  /**
   * ⚠ NULL, NOT 0%. "Nothing was cached" and "nobody measured caching" look identical as a percentage and
   * mean opposite things — the first is a problem to fix, the second is an absence of data. Every turn before
   * migration 13 is the second.
   */
  it("returns nothing when no turn reported a cache figure", () => {
    const t = totalTokens([{ role: "assistant", input_tokens: 1000, output_tokens: 10 }]);

    expect(cacheSavings(t)).toBeNull();
  });

  it("reports a genuine zero saving", () => {
    expect(cacheSavings(totalTokens([withCache(1000, 0)]))).toEqual({ percent: 0, covered: 1 });
  });

  it("says how many turns it covers, so a partial figure is not read as the whole", () => {
    const s = cacheSavings(
      totalTokens([withCache(1000, 500), { role: "assistant", input_tokens: 9000, output_tokens: 10 }])
    );

    expect(s!.covered, "one of two replies").toBe(1);
  });

  /** A cache figure larger than the prompt would be a CLI bug, not a 120% saving. */
  it("never exceeds 100%", () => {
    expect(cacheSavings(totalTokens([withCache(100, 500)]))!.percent).toBe(100);
  });

  it("returns nothing when there was no prompt to save on", () => {
    expect(cacheSavings(totalTokens([withCache(0, 0)]))).toBeNull();
  });
});

describe("reasoning share", () => {
  /** The other lever a participant can move: a narrower question spends less on thinking. */
  it("totals the reply tokens spent reasoning", () => {
    const t = totalTokens([
      { role: "assistant", input_tokens: 10, output_tokens: 100, reasoning_output_tokens: 60 },
      { role: "assistant", input_tokens: 10, output_tokens: 50, reasoning_output_tokens: 20 },
    ]);

    expect(t.reasoning).toBe(80);
    expect(t.output).toBe(150);
  });
});
