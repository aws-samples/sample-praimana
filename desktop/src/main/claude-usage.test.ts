// ── ⚠ CLAUDE'S TOKENS, IN CODEX'S UNITS ──────────────────────────────────────────────────
//
// ⚠ THE FIXTURE IS A REAL PAYLOAD, not one I invented. `claude -p --output-format json` was run against the
// installed CLI and these are its actual numbers. It matters because the ONE thing this module exists to
// handle — that `input_tokens` excludes the cached portions — is exactly the thing a hand-written fixture
// would have got wrong, since it only looks wrong once you see 2 tokens of "input" beside 46,762 of cache.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTurnTokens } from "./handlers/claude-usage";

/**
 * Verbatim from the probe: a trivial prompt ("Reply with the single word: ok") against a large cached system
 * prompt. Trimmed to the fields this module reads.
 */
const REAL_RESULT = {
  type: "result",
  subtype: "success",
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 33396,
    cache_read_input_tokens: 13366,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 0 },
    service_tier: "standard",
  },
  modelUsage: {
    "global.anthropic.claude-opus-5[1m]": {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 13366,
      cacheCreationInputTokens: 33396,
      webSearchRequests: 0,
      costUSD: 0.2155,
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      canonicalModel: "claude-opus-5",
      provider: "bedrock",
    },
  },
};

describe("⚠ the prompt that was SENT, not the uncached remainder", () => {
  /**
   * ⚠ THE CENTRAL CASE. `chat_messages.input_tokens` means "this turn's whole prompt" — that is what Codex
   * writes, what `MessageTokens` labels `ctx`, and what `token-insights.ts` divides the cache figure BY.
   * Anthropic reports the cached portions separately, so storing its raw `input_tokens` would put a
   * different quantity in a shared column: 2 tokens of context for a 47k prompt, and a cache rate of
   * 13366/2 = 668,300% clamped to a confident "100% served from cache".
   */
  it("adds the cached portions back into the input count", () => {
    const t = claudeTurnTokens(REAL_RESULT)!;
    expect(t.inputTokens, "2 + 13366 + 33396").toBe(46764);
  });

  /**
   * ⚠ AND THE INVARIANT THE AGGREGATES WERE WRITTEN AGAINST. `computeTokenInsights` sums across every thread
   * regardless of provider and computes `cached / input`; that is only meaningful while cached is a SUBSET of
   * input, which is Codex's shape and now Claude's too.
   */
  it("leaves the cache figure a subset of the input, as codex's is", () => {
    const t = claudeTurnTokens(REAL_RESULT)!;
    expect(t.cachedInputTokens!).toBeLessThanOrEqual(t.inputTokens!);
    expect(t.cacheWriteInputTokens!).toBeLessThanOrEqual(t.inputTokens!);
    /* A believable rate rather than a clamped absurdity. */
    const rate = Math.round((t.cachedInputTokens! / t.inputTokens!) * 100);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThanOrEqual(100);
  });

  it("carries the remaining counts through unchanged", () => {
    const t = claudeTurnTokens(REAL_RESULT)!;
    expect(t.outputTokens).toBe(4);
    expect(t.cachedInputTokens).toBe(13366);
    expect(t.cacheWriteInputTokens).toBe(33396);
    expect(t.reasoningOutputTokens, "thinking_tokens, a real 0 here").toBe(0);
  });
});

describe("⚠ every model the turn used, not the first one", () => {
  /**
   * ⚠ `modelUsage` IS KEYED BY MODEL and one turn can use several — a cheap model for a Task subagent, the
   * main one for the reply. Reading a single key silently drops the rest, and the SDK prefers this field over
   * `usage` precisely BECAUSE `usage` is main-loop-only.
   */
  it("sums across model keys", () => {
    const t = claudeTurnTokens({
      type: "result",
      modelUsage: {
        "claude-opus-5": {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 0,
        },
        "claude-haiku-4-5": {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 200,
        },
      },
    })!;
    expect(t.outputTokens, "10 + 5").toBe(15);
    expect(t.cachedInputTokens, "1000 + 500").toBe(1500);
    expect(t.cacheWriteInputTokens, "0 + 200").toBe(200);
    expect(t.inputTokens, "(100+50) + 1500 + 200").toBe(1850);
  });
});

describe("⚠ an absent count stays absent", () => {
  /**
   * ⚠ NEVER 0 FOR "NOT REPORTED". The columns exist so the portal can say "measured over 14 of 22 replies";
   * a zero would understate a real conversation while reading as a measurement. Same rule as
   * `codex-events.ts`.
   */
  it("returns undefined when the frame reports nothing usable", () => {
    for (const frame of [
      undefined,
      null,
      "result",
      {},
      { type: "result" },
      { type: "result", modelUsage: {}, usage: {} },
      { type: "result", usage: { input_tokens: "many" } },
    ]) {
      expect(claudeTurnTokens(frame), JSON.stringify(frame) ?? "undefined").toBeUndefined();
    }
  });

  /**
   * Only the `result` frame carries a TURN TOTAL — every other frame's usage is per-model-call, and a turn
   * makes several.
   *
   * ⚠ THE FIXTURE HAS TO CARRY USAGE, or this case proves nothing. My first version passed an assistant frame
   * whose counts sat at `message.usage`, which this function never reads anyway — so deleting the type guard
   * outright left the test green. Mutation testing caught that; reading the test did not.
   */
  it("ignores frames that are not the result, even when they carry usage", () => {
    expect(
      claudeTurnTokens({ type: "stream_event", usage: { input_tokens: 9, output_tokens: 9 } }),
      "a per-call frame is not a turn total"
    ).toBeUndefined();
    expect(
      claudeTurnTokens({ type: "assistant", modelUsage: { m: { inputTokens: 9, outputTokens: 9 } } })
    ).toBeUndefined();
    /* And the shape it would really arrive in — counts nested under `message`, which this never reads. */
    expect(
      claudeTurnTokens({ type: "assistant", message: { usage: { input_tokens: 9, output_tokens: 9 } } })
    ).toBeUndefined();
  });

  /** A negative or non-finite count is a bug upstream, not a measurement. */
  it("rejects impossible counts rather than storing them", () => {
    const t = claudeTurnTokens({
      type: "result",
      modelUsage: { m: { inputTokens: -5, outputTokens: 7, cacheReadInputTokens: NaN } },
    })!;
    expect(t.outputTokens).toBe(7);
    expect(t.inputTokens, "the only valid input-side figure was none").toBeUndefined();
    expect(t.cachedInputTokens).toBeUndefined();
  });
});

describe("⚠ the fallback path, for a frame without modelUsage", () => {
  /**
   * An older CLI or a crash-shaped result can carry `usage` alone. A turn whose tokens are merely harder to
   * reach must not be recorded as uncounted — and the field names differ between the two objects, which is a
   * genuine trap rather than a spelling detail.
   */
  it("falls back to usage, applying the same normalisation", () => {
    const t = claudeTurnTokens({
      type: "result",
      usage: {
        input_tokens: 7,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 3,
        output_tokens: 11,
      },
    })!;
    expect(t.inputTokens, "7 + 90 + 3").toBe(100);
    expect(t.outputTokens).toBe(11);
    expect(t.cachedInputTokens).toBe(90);
  });

  /** With both present, `modelUsage` wins — it includes subagents, which `usage` excludes. */
  it("prefers modelUsage when both are present", () => {
    const t = claudeTurnTokens({
      type: "result",
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { m: { inputTokens: 500, outputTokens: 60 } },
    })!;
    expect(t.outputTokens, "the subagent-inclusive figure").toBe(60);
    expect(t.inputTokens).toBe(500);
  });
});

// ── ⚠ AND THE HANDLER MUST ACTUALLY USE IT ───────────────────────────────────────────────
//
// ⚠ A CORRECT PARSER NOBODY CALLS IS THE BUG I SHIPPED EARLIER IN THIS SAME AREA: the Codex
// duplicate-message fix was right in `codex-events.ts` and the handler still streamed the raw text, because
// every test asserted the pure function and none asserted the CALL SITE. So the four points of contact are
// pinned here: read from the result frame, stored on the row, sent to the portal, and the columns to hold it.
describe("⚠ the claude path stores and syncs what it read", () => {
  const handler = readFileSync(join(__dirname, "handlers", "claude-code.ts"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );

  it("reads the turn's usage off the result frame", () => {
    const at = handler.indexOf('m.type === "result"');
    expect(at, "the result branch must exist").toBeGreaterThan(-1);
    expect(
      handler.slice(at, at + 400),
      "the counts are read where the turn's totals arrive"
    ).toContain("claudeTurnTokens(m)");
  });

  /** ⚠ NAMED COLUMNS, because an INSERT that omits them is exactly the state this change found. */
  it("writes all five token columns", () => {
    for (const col of [
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "reasoning_output_tokens",
    ]) {
      expect(handler, `the INSERT must name ${col}`).toContain(col);
    }
  });

  /**
   * ⚠ PASSED, NOT MERELY IN SCOPE. The value sat in scope at this call site for the whole life of the bug —
   * the live status-line counter was already tracking output tokens a few lines above and being discarded.
   */
  it("passes them to the row writer", () => {
    expect(handler).toMatch(/saveAssistantMessage\(sessionId, finalContent, turnTokens\)/);
  });

  /** The portal reads the server's copy, so the sync is the half that makes the insights page work. */
  it("sends them to the portal on the same field codex uses", () => {
    expect(handler).toMatch(/\.\.\.\(turnTokens \? \{ tokens: turnTokens \} : \{\}\)/);
  });

  /**
   * ⚠ THE LIVE COUNTER IS NOT THE RECORD, and must stay separate. `tokensBanked` is output-only and
   * approximate, for the status line on a long agentic turn; storing it instead would trade a correct figure
   * for a smoother progress bar.
   */
  it("keeps the live status counter out of the stored row", () => {
    expect(handler).not.toMatch(/saveAssistantMessage\([^)]*tokensBanked/);
  });
});
