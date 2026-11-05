// ── ⚠ CONTEXT FULLNESS IS A STATE, AND THESE TESTS EXIST TO STOP IT BEING SUMMED ─────────
//
// THE SYMPTOM: the portal showed no context-usage percentage for Kiro chats. The figure now travels
// desktop → sync → rollup → portal, and the rollup is where it is most likely to be broken later.
//
// Every other number `rollUpThreadTiming` produces is a running total, so `contextUsagePercent` sits in a
// loop where `+=` is the surrounding idiom and the correct operator is `=`. A reviewer skimming the diff
// would not notice the difference; these tests would.
//
// The three wrong aggregates each fail a different case below, deliberately:
//
//   sum     — four 40% turns would report 160%
//   mean    — a chat that grew 5% → 90% would report ~48%, understating one that is nearly full
//   maximum — a COMPACTED chat would keep reporting its pre-compact peak forever
//
// The compaction case is the one that decides between "last" and "max", and it is not hypothetical: a
// compact is the only event that makes this number fall, and it is exactly when a participant most needs
// the figure to be right.

import { describe, it, expect } from "vitest";
import { rollUpThreadTiming } from "./timing.js";
import type { AiMessage } from "./domain.js";

const T0 = Date.parse("2026-08-15T09:00:00.000Z");

function msg(
  role: "user" | "assistant",
  offsetMs: number,
  extra: Partial<AiMessage> = {}
): AiMessage {
  return {
    threadId: "t1",
    id: `m-${role}-${offsetMs}`,
    role,
    content: "x",
    createdAt: new Date(T0 + offsetMs).toISOString(),
    ...extra,
  };
}

describe("⚠ the thread's context reading is the LAST one, never an aggregate", () => {
  it("reports the newest reading rather than a sum", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { contextUsagePercent: 40 }),
      msg("user", 2_000),
      msg("assistant", 3_000, { contextUsagePercent: 40 }),
      msg("user", 4_000),
      msg("assistant", 5_000, { contextUsagePercent: 40 }),
      msg("user", 6_000),
      msg("assistant", 7_000, { contextUsagePercent: 40 }),
    ]);

    /* Summing would give 160 — a number that describes nothing and renders as an impossible percentage. */
    expect(r.ai.contextUsagePercent).toBe(40);
  });

  it("reports the newest reading rather than a mean of the conversation", () => {
    // A conversation filling up: this is the normal shape, since context only grows within a turn window.
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { contextUsagePercent: 5 }),
      msg("user", 2_000),
      msg("assistant", 3_000, { contextUsagePercent: 30 }),
      msg("user", 4_000),
      msg("assistant", 5_000, { contextUsagePercent: 65 }),
      msg("user", 6_000),
      msg("assistant", 7_000, { contextUsagePercent: 90 }),
    ]);

    /**
     * The mean is 47.5 → 48. That would present a chat one turn from needing a compact as half empty, which
     * is the failure mode with real consequences: the participant keeps going and loses the thread.
     */
    expect(r.ai.contextUsagePercent).toBe(90);
    expect(r.ai.contextUsagePercent).not.toBe(48);
  });

  /**
   * ⚠ THE CASE THAT RULES OUT `Math.max`. Compaction is the one thing that makes this figure DROP, and it
   * is the moment the reading matters most — a thread that has just been compacted is usable again, and a
   * rollup reporting its old peak would tell the participant the opposite.
   */
  it("follows the reading DOWN after a compaction rather than keeping the peak", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { contextUsagePercent: 92 }),
      // /compact happens here — Kiro reports the new, much lower fullness on the next turn.
      msg("user", 2_000),
      msg("assistant", 3_000, { contextUsagePercent: 18 }),
    ]);

    expect(r.ai.contextUsagePercent, "the peak must not survive a compact").toBe(18);
  });

  it("is null — not 0 — when nothing reported it", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { latencyMs: 900, inputTokens: 1_200 }),
    ]);

    /**
     * ⚠ THE WHOLE POINT OF `null`. "Nobody measured how full this was" and "this conversation is empty" are
     * opposite facts that look identical as 0%, and only one of them is true of a Claude or Codex thread.
     * The portal renders nothing at all for null.
     */
    expect(r.ai.contextUsagePercent).toBeNull();
  });

  it("keeps the last REPORTED reading when a later reply reports none", () => {
    // A shared thread where a Kiro turn is followed by a Claude turn, which publishes no reading.
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { contextUsagePercent: 71 }),
      msg("user", 2_000),
      msg("assistant", 3_000, { latencyMs: 500 }),
    ]);

    /* Clearing on a non-reporting reply would erase a real measurement because a different CLI answered. */
    expect(r.ai.contextUsagePercent).toBe(71);
  });

  /**
   * ⚠ THE ROLLUP DOES NOT TRUST ITS INPUT EITHER. The sync route bounds the value, but this function also
   * reads rows written by earlier versions of that route, so a bad value must die here rather than become a
   * rendered "140% full".
   */
  it.each([
    ["above 100", 140],
    ["negative", -5],
    ["not finite", Number.NaN],
  ])("ignores an out-of-range reading (%s)", (_label, bad) => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { contextUsagePercent: 55 }),
      msg("user", 2_000),
      msg("assistant", 3_000, { contextUsagePercent: bad as number }),
    ]);

    /* The good earlier reading stands; the bad later one is not adopted and does not clear it. */
    expect(r.ai.contextUsagePercent).toBe(55);
  });

  it("rounds a fractional reading, as the desktop does", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      // The real probe returned 10.665900230407715 — sixteen significant figures for a progress bar.
      msg("assistant", 1_000, { contextUsagePercent: 10.665900230407715 }),
    ]);

    expect(r.ai.contextUsagePercent).toBe(11);
  });

  /** A reading on a USER row is not a measurement of anything; the route refuses it, and so does this. */
  it("ignores a reading attached to a user message", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0, { contextUsagePercent: 80 }),
      msg("assistant", 1_000, { latencyMs: 100 }),
    ]);

    expect(r.ai.contextUsagePercent).toBeNull();
  });
});
