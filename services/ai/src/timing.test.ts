import { describe, it, expect } from "vitest";
import { rollUpThreadTiming, DEFAULT_IDLE_THRESHOLD_MS } from "./timing.js";
import type { AiMessage } from "./domain.js";

/**
 * These tests pin the ONE property that makes this metric trustworthy: absent
 * timing is reported as absent, never as zero. A `0` folded into the AI total
 * would understate generation time and drag down every average computed over it,
 * and the resulting dashboard would be confidently wrong — which is worse than
 * showing nothing.
 *
 * The mixed old/new-message case matters most in practice: the aiMessages table
 * already holds rows written before `latencyMs` existed, so a partially
 * instrumented thread is the NORMAL state right after this ships, not an edge case.
 */

const T0 = Date.parse("2026-07-31T10:00:00.000Z");

/** Build a message `offsetMs` after the thread's start. */
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

describe("rollUpThreadTiming — fully instrumented thread", () => {
  // user@0 → assistant@5s (took 4s) → user@20s → assistant@25s (took 3s)
  const messages = [
    msg("user", 0),
    msg("assistant", 5_000, { latencyMs: 4_000 }),
    msg("user", 20_000),
    msg("assistant", 25_000, { latencyMs: 3_000 }),
  ];

  it("sums measured AI latency and reports full coverage", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.ai.measuredMs).toBe(7_000);
    expect(r.ai.measuredCount).toBe(2);
    expect(r.ai.unmeasuredCount).toBe(0);
    expect(r.ai.coverage).toBe(1);
    expect(r.ai.complete).toBe(true);
    expect(r.ai.meanMs).toBe(3_500);
  });

  it("infers user time as the gap ending at each user message", () => {
    const r = rollUpThreadTiming("t1", messages);
    // Only one inferable gap: assistant@5s → user@20s = 15s. The first message
    // has no predecessor, so thread-start → first message is not attributed.
    expect(r.user.inferredMs).toBe(15_000);
    expect(r.user.inferredGapCount).toBe(1);
    expect(r.user.meanMs).toBe(15_000);
  });

  it("does not overlap the two halves — the AI's own 4s is not in user time", () => {
    const r = rollUpThreadTiming("t1", messages);
    // The assistant timestamp marks generation END, so the 15s gap after it is
    // entirely the user's. AI time and user time partition rather than double-count.
    expect(r.user.inferredMs + r.ai.measuredMs).toBeLessThanOrEqual(r.spanMs!);
  });

  it("labels each half with its basis so a caller cannot conflate them", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.ai.basis).toBe("measured");
    expect(r.user.basis).toBe("inferred");
    expect(r.empty).toBe(false);
  });

  it("counts messages and the session span", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.messageCount).toBe(4);
    expect(r.userMessageCount).toBe(2);
    expect(r.assistantMessageCount).toBe(2);
    expect(r.spanMs).toBe(25_000);
  });
});

describe("rollUpThreadTiming — MIXED legacy and instrumented messages", () => {
  // The realistic post-deploy state: the first exchange predates `latencyMs`.
  const messages = [
    msg("user", 0),
    msg("assistant", 5_000), // legacy: no latencyMs
    msg("user", 20_000),
    msg("assistant", 25_000, { latencyMs: 3_000 }), // instrumented
  ];

  it("counts the legacy message as UNMEASURED, not as 0ms", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.ai.measuredMs).toBe(3_000); // 3000 + nothing, NOT 3000 + 0
    expect(r.ai.measuredCount).toBe(1);
    expect(r.ai.unmeasuredCount).toBe(1);
  });

  it("reports partial coverage and refuses to call the total complete", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.ai.coverage).toBe(0.5);
    expect(r.ai.complete).toBe(false);
  });

  it("averages over measured messages only, so a legacy row cannot halve the mean", () => {
    const r = rollUpThreadTiming("t1", messages);
    // 3000 / 1, not 3000 / 2. Dividing by the untimed message would report the
    // model as twice as fast as it was.
    expect(r.ai.meanMs).toBe(3_000);
  });

  it("still infers user time normally — user gaps need no instrumentation", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.user.inferredMs).toBe(15_000);
    expect(r.user.inferredGapCount).toBe(1);
  });
});

describe("rollUpThreadTiming — NO timing data at all (pre-instrumentation thread)", () => {
  const messages = [
    msg("user", 0),
    msg("assistant", 5_000),
    msg("user", 20_000),
    msg("assistant", 25_000),
  ];

  it("reports zero coverage with an UNKNOWN (null) mean, never 0ms", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.ai.measuredMs).toBe(0);
    expect(r.ai.measuredCount).toBe(0);
    expect(r.ai.unmeasuredCount).toBe(2);
    expect(r.ai.coverage).toBe(0);
    expect(r.ai.complete).toBe(false);
    // null, not 0: "we don't know" must not average in as "instant".
    expect(r.ai.meanMs).toBeNull();
  });

  it("is not flagged empty, because user gaps are still inferable", () => {
    const r = rollUpThreadTiming("t1", messages);
    expect(r.user.inferredMs).toBe(15_000);
    expect(r.empty).toBe(false);
  });
});

describe("rollUpThreadTiming — degenerate threads", () => {
  it("flags a completely empty thread rather than reporting an instant session", () => {
    const r = rollUpThreadTiming("t1", []);
    expect(r.empty).toBe(true);
    expect(r.spanMs).toBeNull();
    expect(r.ai.meanMs).toBeNull();
    expect(r.user.meanMs).toBeNull();
    expect(r.ai.coverage).toBe(0);
    expect(r.ai.complete).toBe(false); // no assistant messages != complete
  });

  it("attributes nothing to a lone user message", () => {
    const r = rollUpThreadTiming("t1", [msg("user", 0)]);
    expect(r.empty).toBe(true);
    expect(r.user.inferredGapCount).toBe(0);
    expect(r.spanMs).toBeNull();
  });

  it("honours a genuine 0ms measurement (absent != zero, but zero is real)", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { latencyMs: 0 }),
    ]);
    expect(r.ai.measuredCount).toBe(1);
    expect(r.ai.unmeasuredCount).toBe(0);
    expect(r.ai.coverage).toBe(1);
    expect(r.ai.meanMs).toBe(0);
  });
});

describe("rollUpThreadTiming — idle time is bucketed, not folded into composing", () => {
  it("holds an overnight gap out of inferred user time", () => {
    const overnight = 10 * 60 * 60 * 1000;
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 5_000, { latencyMs: 4_000 }),
      msg("user", 5_000 + overnight),
    ]);
    expect(r.user.inferredMs).toBe(0);
    expect(r.user.inferredGapCount).toBe(0);
    expect(r.user.idleMs).toBe(overnight);
    expect(r.user.idleGapCount).toBe(1);
    // Nothing to average over, so the mean is unknown rather than zero.
    expect(r.user.meanMs).toBeNull();
  });

  it("counts a gap just under the threshold as composing", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { latencyMs: 900 }),
      msg("user", 1_000 + DEFAULT_IDLE_THRESHOLD_MS - 1),
    ]);
    expect(r.user.inferredGapCount).toBe(1);
    expect(r.user.idleGapCount).toBe(0);
  });

  it("respects an overridden threshold", () => {
    const r = rollUpThreadTiming(
      "t1",
      [msg("user", 0), msg("assistant", 1_000), msg("user", 31_000)],
      { idleThresholdMs: 10_000 }
    );
    expect(r.user.idleMs).toBe(30_000);
    expect(r.user.inferredMs).toBe(0);
  });
});

describe("rollUpThreadTiming — consecutive user messages", () => {
  it("counts the pause between two user messages as composing time", () => {
    // "...and also this" — the ball never left the user's court, so the pause is
    // still them typing. Deliberately a superset of a strict assistant→user rule.
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("user", 8_000),
      msg("assistant", 10_000, { latencyMs: 2_000 }),
    ]);
    expect(r.user.inferredMs).toBe(8_000);
    expect(r.user.inferredGapCount).toBe(1);
  });

  it("never attributes a gap ending at an assistant message to the user", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 30_000, { latencyMs: 29_000 }),
    ]);
    // That 30s was the model working; it is measured on the AI side only.
    expect(r.user.inferredMs).toBe(0);
    expect(r.ai.measuredMs).toBe(29_000);
  });
});

describe("rollUpThreadTiming — untrustworthy timestamps", () => {
  it("refuses to infer across bulk-synced transcript messages", () => {
    // The share/sync path stamps `base + i` ms, so these gaps describe a
    // for-loop, not a person. Counting them would report ~1ms compose times.
    const r = rollUpThreadTiming("t1", [
      msg("user", 0, { synced: true }),
      msg("assistant", 1, { synced: true }),
      msg("user", 2, { synced: true }),
    ]);
    expect(r.user.inferredMs).toBe(0);
    expect(r.user.inferredGapCount).toBe(0);
    // One gap only: the trailing user@2 message. user@0 has no predecessor, and
    // the gap ending at assistant@1 is never user time in the first place.
    expect(r.user.unusableGapCount).toBe(1);
    expect(r.empty).toBe(true);
  });

  it("counts a live message following a synced one as unusable, not negative", () => {
    const r = rollUpThreadTiming("t1", [
      msg("assistant", 0, { synced: true }),
      msg("user", 9_000),
    ]);
    expect(r.user.unusableGapCount).toBe(1);
    expect(r.user.inferredGapCount).toBe(0);
  });

  it("discards backwards gaps from clock skew instead of subtracting them", () => {
    const messages = [
      msg("assistant", 10_000, { latencyMs: 1_000 }),
      { ...msg("user", 0), createdAt: new Date(T0 + 5_000).toISOString() },
    ];
    // Passed out of order on purpose: the rollup sorts by createdAt, so this
    // becomes user@5s then assistant@10s — a gap ending at the ASSISTANT, which
    // is never user time.
    const r = rollUpThreadTiming("t1", messages);
    expect(r.user.inferredMs).toBe(0);
    expect(r.ai.measuredMs).toBe(1_000);
  });

  it("ignores an unparseable timestamp rather than producing NaN", () => {
    const r = rollUpThreadTiming("t1", [
      msg("assistant", 0, { latencyMs: 500 }),
      { ...msg("user", 1_000), createdAt: "not-a-date" },
    ]);
    expect(Number.isFinite(r.user.inferredMs)).toBe(true);
    expect(r.user.unusableGapCount).toBe(1);
  });

  it("treats a negative stored latency as unmeasured", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 1_000, { latencyMs: -5 }),
    ]);
    expect(r.ai.measuredCount).toBe(0);
    expect(r.ai.unmeasuredCount).toBe(1);
    expect(r.ai.meanMs).toBeNull();
  });
});

describe("rollUpThreadTiming — streaming: first-token vs. completion", () => {
  it("keeps time-to-first-token in its own average", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 5_000, { latencyMs: 4_000, firstTokenMs: 300 }),
      msg("user", 20_000),
      msg("assistant", 26_000, { latencyMs: 6_000, firstTokenMs: 500 }),
    ]);
    // Completion time is the headline "AI time"...
    expect(r.ai.measuredMs).toBe(10_000);
    expect(r.ai.meanMs).toBe(5_000);
    // ...and responsiveness is a separate, much smaller number.
    expect(r.ai.firstTokenMeanMs).toBe(400);
    expect(r.ai.firstTokenSampleCount).toBe(2);
  });

  it("reports an unknown first-token mean when nothing streamed", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 5_000, { latencyMs: 4_000 }),
    ]);
    // Non-streamed invokes record no first-token time; null keeps them out of
    // any cross-thread responsiveness average instead of claiming 0ms.
    expect(r.ai.firstTokenMeanMs).toBeNull();
    expect(r.ai.firstTokenSampleCount).toBe(0);
    // Completion time is unaffected.
    expect(r.ai.measuredMs).toBe(4_000);
  });

  it("averages first-token time only over messages that have it", () => {
    const r = rollUpThreadTiming("t1", [
      msg("user", 0),
      msg("assistant", 5_000, { latencyMs: 4_000, firstTokenMs: 300 }),
      msg("user", 20_000),
      msg("assistant", 26_000, { latencyMs: 6_000 }), // non-streamed
    ]);
    expect(r.ai.firstTokenMeanMs).toBe(300);
    expect(r.ai.firstTokenSampleCount).toBe(1);
  });
});

describe("rollUpThreadTiming — ordering", () => {
  it("produces the same rollup regardless of input order", () => {
    const messages = [
      msg("user", 0),
      msg("assistant", 5_000, { latencyMs: 4_000 }),
      msg("user", 20_000),
      msg("assistant", 25_000, { latencyMs: 3_000 }),
    ];
    const forward = rollUpThreadTiming("t1", messages);
    const shuffled = rollUpThreadTiming("t1", [...messages].reverse());
    expect(shuffled).toEqual(forward);
  });

  it("does not mutate the caller's array", () => {
    const messages = [msg("assistant", 5_000), msg("user", 0)];
    const snapshot = messages.map((m) => m.id);
    rollUpThreadTiming("t1", messages);
    expect(messages.map((m) => m.id)).toEqual(snapshot);
  });
});

// ── ⚠ TOKENS ARE COUNTED, NEVER ESTIMATED ────────────────────────────────────────────────
//
// THE REQUIREMENT: the portal shows the input and output tokens beside each AI message.
//
// ⚠ THE REASON THIS IS ALLOWED AT ALL is that the counts are REPORTED, not guessed. `routes.ts` says no
// token counts are sent for a CLI turn because "a CLI turn has no trustworthy latency or token counts" —
// written when nothing measured them. Codex's own `turn.completed` states them, so the objection (do not
// invent numbers that feed a rating) is untouched, and these stay out of the activity event entirely.
//
// Everything below is about not overstating them: a partial thread reports what it has and says so.
describe("⚠ token totals", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

  it("sums the counts the CLI reported", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), latencyMs: 1000, inputTokens: 1000, outputTokens: 50 },
      { role: "user", content: "q2", createdAt: at(2) },
      { role: "assistant", content: "a2", createdAt: at(3), latencyMs: 1000, inputTokens: 1200, outputTokens: 70 },
    ] as never);

    expect(t.ai.inputTokens).toBe(2200);
    expect(t.ai.outputTokens).toBe(120);
    expect(t.ai.tokenCount).toBe(2);
    expect(t.ai.tokenCoverage).toBe(1);
  });

  /**
   * ⚠ A TURN WITHOUT COUNTS IS NOT A ZERO. Every turn synced before this shipped has none, and treating
   * those as zero would let the portal print a confident total that understates the thread — the same lie
   * `unmeasuredCount` exists to prevent for time.
   */
  it("reports coverage rather than counting an absent turn as zero", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), inputTokens: 900, outputTokens: 40 },
      { role: "user", content: "q2", createdAt: at(2) },
      { role: "assistant", content: "a2", createdAt: at(3) },
    ] as never);

    expect(t.ai.inputTokens, "only what was reported").toBe(900);
    expect(t.ai.tokenCount).toBe(1);
    expect(t.ai.tokenCoverage).toBe(0.5);
  });

  /**
   * ⚠ COUNTED INDEPENDENTLY OF THE LATENCY. A turn can report tokens without a duration, and folding the
   * token sum inside the latency branch would silently drop those — while `tokenCoverage` went on
   * describing timing under a token name.
   */
  it("counts tokens on a turn that has no latency", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), inputTokens: 500, outputTokens: 25 },
    ] as never);

    expect(t.ai.measuredCount, "no timing").toBe(0);
    expect(t.ai.tokenCount, "but tokens were reported").toBe(1);
    expect(t.ai.outputTokens).toBe(25);
  });

  /** One count present and the other absent must not disqualify the turn. */
  it("accepts a turn that reported only one of the two", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), outputTokens: 25 },
    ] as never);

    expect(t.ai.tokenCount).toBe(1);
    expect(t.ai.inputTokens).toBe(0);
    expect(t.ai.outputTokens).toBe(25);
  });

  it("is zero and uncovered for a thread with no counts at all", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), latencyMs: 500 },
    ] as never);

    expect(t.ai.inputTokens).toBe(0);
    expect(t.ai.outputTokens).toBe(0);
    expect(t.ai.tokenCount).toBe(0);
    expect(t.ai.tokenCoverage).toBe(0);
  });
});

// ── ⚠ THE SAVINGS FIGURE MUST BE MEASURED, NOT CHOSEN ────────────────────────────────────
//
// THE REQUIREMENT: statistics showing token savings, e.g. from improved prompts or from educating participants.
//
// `cachedInputTokens / inputTokens` is the share of the prompt served from cache rather than re-sent — a number
// the CLI states. These tests guard the two ways it could become a claim instead: sharing the token counter (so
// it claims coverage it lacks), and reporting a total when nothing measured caching.
describe("⚠ cache totals", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();

  it("sums the cached prompt tokens and how many replies reported them", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), inputTokens: 1000, cachedInputTokens: 400 },
      { role: "user", content: "q2", createdAt: at(2) },
      { role: "assistant", content: "a2", createdAt: at(3), inputTokens: 3000, cachedInputTokens: 2600 },
    ] as never);

    expect(t.ai.cachedInputTokens).toBe(3000);
    expect(t.ai.inputTokens).toBe(4000);
    expect(t.ai.cacheCounted).toBe(2);
    /* 3000/4000 = 75%. Averaging the two turns (40% and ~87%) would give 63%, which is not the saving. */
  });

  /**
   * ⚠ THE CACHE COUNTER IS NOT THE TOKEN COUNTER. A turn can report tokens without a cache split — every row
   * written before the breakdown shipped does — and sharing the counter would let the portal claim the savings
   * figure covered replies it knows nothing about.
   */
  it("counts cache coverage separately from token coverage", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), inputTokens: 1000, outputTokens: 50 },
      { role: "user", content: "q2", createdAt: at(2) },
      { role: "assistant", content: "a2", createdAt: at(3), inputTokens: 500, cachedInputTokens: 250 },
    ] as never);

    expect(t.ai.tokenCount, "both replies reported tokens").toBe(2);
    expect(t.ai.cacheCounted, "only one reported a cache split").toBe(1);
  });

  it("is zero and uncovered when no reply reported caching", () => {
    const t = rollUpThreadTiming("t1", [
      { role: "user", content: "q", createdAt: at(0) },
      { role: "assistant", content: "a", createdAt: at(1), inputTokens: 1000, outputTokens: 50 },
    ] as never);

    expect(t.ai.cachedInputTokens).toBe(0);
    expect(t.ai.cacheCounted, "so the portal renders nothing rather than 0% saved").toBe(0);
  });
});
