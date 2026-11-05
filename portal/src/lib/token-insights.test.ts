// ── ⚠ USAGE STATS THAT CANNOT FLATTER, AND NEVER GRADE ───────────────────────────────────
//
// Usage stats, and whether efficiency can be improved.
//
// Three things could turn this from a measurement into a claim, and each has cases below: treating an
// unmeasured turn as zero, calling a trend from too little data, and smuggling in a threshold so the panel
// starts marking people. The last one is the reason there is a test asserting the ABSENCE of a word.

import { describe, it, expect } from "vitest";
import { computeTokenInsights, type ThreadTokens } from "./token-insights";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const thread = (over: Partial<ThreadTokens> = {}): ThreadTokens => ({
  threadId: "t",
  at: "2026-08-01T00:00:00.000Z",
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: 500,
  cacheWriteInputTokens: 100,
  cacheCounted: 2,
  tokenCount: 2,
  assistantCount: 2,
  ...over,
});

describe("⚠ nothing measured means nothing shown", () => {
  it("is empty for no threads and for threads with no counts", () => {
    expect(computeTokenInsights([]).empty).toBe(true);
    expect(computeTokenInsights([thread({ tokenCount: 0 })]).empty).toBe(true);
  });

  /**
   * ⚠ THE HEADLINE HONESTY RULE. Only Codex reports usage, so a team using Claude has no counts at all, and a
   * panel reading "0 tokens · 0% cached" in front of an executive would be a confident lie about a team that
   * worked all day.
   */
  it("does not report zeros for a team nobody measured", () => {
    const i = computeTokenInsights([thread({ tokenCount: 0, cacheCounted: 0 })]);

    expect(i.empty, "the panel renders nothing at all").toBe(true);
    expect(i.cacheRate).toBeNull();
  });
});

describe("⚠ totals and coverage", () => {
  it("sums only the counted threads, and reports replies separately", () => {
    const i = computeTokenInsights([
      thread({ threadId: "a", inputTokens: 1000, outputTokens: 100, tokenCount: 2, assistantCount: 2 }),
      thread({ threadId: "b", inputTokens: 3000, outputTokens: 200, tokenCount: 3, assistantCount: 5 }),
    ]);

    expect(i.inputTokens).toBe(4000);
    expect(i.outputTokens).toBe(300);
    expect(i.counted, "replies WITH counts").toBe(5);
    expect(i.replies, "replies in total, counted or not").toBe(7);
  });

  /** An uncounted thread still counts as a conversation, "you started 9" is true either way. */
  it("counts every thread even when it reported nothing", () => {
    const i = computeTokenInsights([thread(), thread({ threadId: "x", tokenCount: 0, cacheCounted: 0 })]);

    expect(i.threads).toBe(2);
  });

  it("totals the cache rather than averaging per-thread percentages", () => {
    /* 3000 of 4000 = 75%. Averaging the two threads (25% and ~92%) would give ~58%, which is not the saving. */
    const i = computeTokenInsights([
      thread({ threadId: "a", inputTokens: 1000, cachedInputTokens: 250 }),
      thread({ threadId: "b", inputTokens: 3000, cachedInputTokens: 2750 }),
    ]);

    expect(i.cacheRate).toBe(75);
  });

  /** `null`, not 0, "nothing cached" and "nobody measured caching" mean opposite things. */
  it("reports no cache rate when no thread measured caching", () => {
    expect(computeTokenInsights([thread({ cacheCounted: 0, cachedInputTokens: 0 })]).cacheRate).toBeNull();
  });

  it("never exceeds 100%", () => {
    expect(computeTokenInsights([thread({ inputTokens: 100, cachedInputTokens: 900 })]).cacheRate).toBe(100);
  });
});

describe("⚠ the trend is the team's own, and is refused when it would be noise", () => {
  const at = (d: number) => `2026-08-${String(d).padStart(2, "0")}T00:00:00.000Z`;

  it("compares the older half against the newer half", () => {
    const i = computeTokenInsights([
      thread({ threadId: "1", at: at(1), inputTokens: 1000, cachedInputTokens: 200 }),
      thread({ threadId: "2", at: at(2), inputTokens: 1000, cachedInputTokens: 200 }),
      thread({ threadId: "3", at: at(3), inputTokens: 1000, cachedInputTokens: 800 }),
      thread({ threadId: "4", at: at(4), inputTokens: 1000, cachedInputTokens: 800 }),
    ]);

    expect(i.trend).toEqual({ older: 20, newer: 80, delta: 60 });
  });

  /**
   * ⚠ REFUSED BELOW FOUR THREADS. A "trend" from one conversation each side is noise wearing a conclusion's
   * clothes, and this panel's whole claim to legitimacy is that it states only what it measured.
   */
  it("claims no trend from too few conversations", () => {
    const two = computeTokenInsights([
      thread({ threadId: "1", at: at(1) }),
      thread({ threadId: "2", at: at(2) }),
    ]);
    expect(two.trend).toBeNull();
  });

  /** A thread with tokens but no cache split would drag a CACHE trend for a reason that is not about caching. */
  it("excludes threads that never measured caching from the trend", () => {
    const i = computeTokenInsights([
      thread({ threadId: "1", at: at(1), cacheCounted: 0, cachedInputTokens: 0 }),
      thread({ threadId: "2", at: at(2), cacheCounted: 0, cachedInputTokens: 0 }),
      thread({ threadId: "3", at: at(3) }),
      thread({ threadId: "4", at: at(4) }),
    ]);

    expect(i.trend, "only two threads qualify, so no trend").toBeNull();
  });

  it("orders oldest-first regardless of the input order", () => {
    const rising = [
      thread({ threadId: "4", at: at(4), inputTokens: 1000, cachedInputTokens: 900 }),
      thread({ threadId: "1", at: at(1), inputTokens: 1000, cachedInputTokens: 100 }),
      thread({ threadId: "3", at: at(3), inputTokens: 1000, cachedInputTokens: 900 }),
      thread({ threadId: "2", at: at(2), inputTokens: 1000, cachedInputTokens: 100 }),
    ];

    expect(computeTokenInsights(rising).trend?.delta, "improvement, not decline").toBeGreaterThan(0);
  });
});

describe("⚠ signals are facts with actions, never grades", () => {
  /**
   * ⚠ THE COLD-CACHE SIGNAL EXISTS ONLY BECAUSE READS AND WRITES ARE STORED SEPARATELY (Decision 2). Writing
   * more than is read means the cache is being discarded; a bare "low cache" number cannot tell that from a
   * legitimate first turn.
   */
  it("names a discarded cache when writes exceed reads", () => {
    const i = computeTokenInsights([
      thread({ cachedInputTokens: 100, cacheWriteInputTokens: 5000 }),
    ]);
    const cold = i.signals.find((s) => s.id === "cold-cache");

    expect(cold, "the signal must fire").toBeTruthy();
    expect(cold!.action, "and it must say what to do").toContain("one conversation");
  });

  /**
   * ⚠ THE DISCRIMINATING CASE, and a mutation is why it exists. Replacing the read/write comparison with a
   * plain "caching is below half" passed both of the cases below, their numbers happened to agree with it.
   * Here they disagree: caching IS low, but nothing is being written either, so the cache is not being
   * discarded, the prompt simply changes between turns, which is not a fault and has no action.
   */
  it("does not cry cold cache merely because caching is low", () => {
    const i = computeTokenInsights([
      thread({ inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 100 }),
    ]);

    expect(i.signals.find((s) => s.id === "cold-cache"), "writes do not exceed reads").toBeUndefined();
  });

  it("does not name it when the cache is being reused", () => {
    const i = computeTokenInsights([thread({ cachedInputTokens: 5000, cacheWriteInputTokens: 100 })]);

    expect(i.signals.find((s) => s.id === "cold-cache")).toBeUndefined();
  });

  /** "You had 1 conversation" implies nothing, so it is not said. */
  it("mentions the conversation count only when there is more than one", () => {
    expect(computeTokenInsights([thread()]).signals.find((s) => s.id === "thread-count")).toBeUndefined();
    expect(
      computeTokenInsights([thread(), thread({ threadId: "b" })]).signals.find((s) => s.id === "thread-count")
    ).toBeTruthy();
  });

  /** Context per reply is offered as CONTEXT, a long useful conversation earns a big number. */
  it("attaches no action to the context figure", () => {
    const s = computeTokenInsights([thread()]).signals.find((x) => x.id === "context-per-reply");

    expect(s).toBeTruthy();
    expect(s!.action, "not a fault, so nothing to fix").toBeNull();
  });
});

describe("⚠ no thresholds, and no vocabulary of judgement", () => {
  const src = readFileSync(fileURLToPath(new URL("./token-insights.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /**
   * ⚠ ASSERTING THE ABSENCE OF A WORD, which is unusual and deliberate. Thresholds were rejected because
   * the number would be invented, on a page beside a model-written assessment of named people. A future
   * "efficiency score" would be a small, reasonable-looking change, this is the tripwire that makes it a
   * conscious one.
   */
  it("grades nobody", () => {
    for (const word of ["poor", "good", "excellent", "bad", "inefficient", "score", "grade", "rating"]) {
      expect(src.toLowerCase(), `"${word}" is a judgement, not a measurement`).not.toContain(word);
    }
  });

  /** And no magic comparison against a target the code invented. */
  it("compares against no benchmark", () => {
    expect(src, "a threshold on the cache rate").not.toMatch(/cacheRate\s*[<>]=?\s*\d/);
    expect(src, "a target constant").not.toMatch(/TARGET|BENCHMARK|GOOD_|THRESHOLD/);
  });
});

// ── ⚠ PER PERSON, AND WHAT IT CAN HONESTLY CLAIM ─────────────────────────────────────────
//
// Individual token usage per user, on the insights page.
//
// The counts live on the ASSISTANT messages, which carry no user id, so the only attribution the data supports
// is to whoever STARTED the thread. These cases pin that limit, and pin the ordering, because a per-person token
// table sitting beside a model-written assessment of the same names is one sort away from being a leaderboard.
describe("⚠ per-person usage", () => {
  const owned = (ownerId: string | null, over: Partial<ThreadTokens> = {}) =>
    thread({ ownerId, ...over });

  it("groups a person's conversations together", () => {
    const i = computeTokenInsights([
      owned("u1", { threadId: "a", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 }),
      owned("u1", { threadId: "b", inputTokens: 3000, outputTokens: 200, cachedInputTokens: 2500 }),
      owned("u2", { threadId: "c", inputTokens: 500, outputTokens: 50, cachedInputTokens: 0 }),
    ]);

    const u1 = i.perPerson.find((p) => p.userId === "u1")!;
    expect(u1.inputTokens).toBe(4000);
    expect(u1.outputTokens).toBe(300);
    expect(u1.threads).toBe(2);
    expect(u1.cacheRate, "3000 of 4000").toBe(75);
    expect(i.perPerson).toHaveLength(2);
  });

  /**
   * ⚠ NOT ORDERED BY CONSUMPTION. Sorting people by tokens is a leaderboard, that shape was rejected for
   * teams, and per person it is worse. The order must carry no verdict.
   */
  it("is not sorted by amount", () => {
    const i = computeTokenInsights([
      owned("zeta", { threadId: "a", inputTokens: 90_000 }),
      owned("alpha", { threadId: "b", inputTokens: 100 }),
    ]);

    expect(i.perPerson.map((p) => p.userId), "stable id order, not descending usage").toEqual([
      "alpha",
      "zeta",
    ]);
  });

  /**
   * ⚠ AN UNOWNED THREAD IS SKIPPED, NOT ATTRIBUTED. Bucketing it under "Unknown" would invent a participant on
   * a page that names real people.
   */
  it("drops a thread with no owner rather than inventing one", () => {
    const i = computeTokenInsights([owned(null, { threadId: "a" }), owned("u1", { threadId: "b" })]);

    expect(i.perPerson.map((p) => p.userId)).toEqual(["u1"]);
  });

  /** A person whose threads reported no cache split gets `null`, which the table renders as "-", not 0%. */
  it("reports no cache rate rather than zero for an unmeasured person", () => {
    const i = computeTokenInsights([
      owned("u1", { cacheCounted: 0, cachedInputTokens: 0, inputTokens: 0, tokenCount: 2 }),
    ]);

    expect(i.perPerson[0].cacheRate).toBeNull();
  });

  /** Uncounted threads contribute nothing to anyone, same rule as the totals. */
  it("ignores a thread nobody measured", () => {
    const i = computeTokenInsights([
      owned("u1", { threadId: "a" }),
      owned("u1", { threadId: "b", tokenCount: 0, cacheCounted: 0 }),
    ]);

    expect(i.perPerson[0].threads, "only the counted one").toBe(1);
  });

  it("is empty when no thread has an owner", () => {
    expect(computeTokenInsights([owned(null)]).perPerson).toEqual([]);
  });
});

describe("⚠ the panel does not claim personal spend", () => {
  const panel = readFileSync(
    fileURLToPath(new URL("../components/TokenUsagePanel.tsx", import.meta.url)),
    "utf8"
  );

  /**
   * ⚠ THE WORDING IS THE GUARD. "Tokens used by" would assert something the data cannot support, a teammate's
   * turns in somebody else's thread are invisible here. The heading has to describe the attribution, not imply
   * consumption.
   */
  it("says what the attribution actually is", () => {
    expect(panel).toContain("By conversations they started");
    expect(panel, "and spells out the limit for the reader").toMatch(
      /Turns contributed to someone else&apos;s\s*\n?\s*conversation are not counted here/
    );
  });

  it("does not present it as personal consumption", () => {
    const table = panel.slice(panel.indexOf("By conversations they started"));
    for (const phrase of ["Tokens used by", "tokens used by", "Usage by", "consumed"]) {
      expect(table, `"${phrase}" overstates the attribution`).not.toContain(phrase);
    }
  });
});
