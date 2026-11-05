// ── ⚠ TOKEN USAGE, AND WHETHER IT COULD BE BETTER ────────────────────────────────────────
//
// Usage stats, and whether efficiency can be improved.
//
// ── ⚠ THERE ARE NO THRESHOLDS IN THIS FILE, AND THAT IS THE DESIGN ──
//
// "Whether efficiency can be improved" needs a yardstick, and nobody has established one for this workload.
// Three candidates were considered and two rejected:
//
//   absolute threshold ("under 50% is bad"), REJECTED. The number would be invented, on a page that sits
//                                             beside a model-written assessment of a named person.
//   cross-team comparison, REJECTED. A league table by another name.
//   the team's OWN trend, ACCEPTED. Needs no benchmark and is unarguably true.
//
// So everything below is either a MEASURED TOTAL, the team's own trend, or a FACT WITH AN OBVIOUS ACTION.
// Nothing here grades anybody. If a future change adds a "score", reconsider the reasoning above first:
// the grading candidates were weighed and rejected deliberately, not overlooked.
//
// ── ⚠ AND NOTHING IS INFERRED FROM AN ABSENT COUNT ──
//
// Only Codex reports token usage; Claude's spawn path and Kiro report none, and every turn from before the
// feature has none either. A total that treated those as zero would understate a real team while looking
// authoritative, so coverage travels with every figure and the panel says so.

/** The token half of one thread's timing rollup, as the ai service returns it. */
export interface ThreadTokens {
  threadId: string;
  /** Who STARTED the thread. See the note in `ai.tokenUsage` on what this can and cannot claim. */
  ownerId?: string | null;
  /** For ordering the trend. Any ISO string the thread carries. */
  at?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  /** Assistant replies that reported a cache split. */
  cacheCounted: number;
  /** Assistant replies that reported any token count. */
  tokenCount: number;
  /** Assistant replies in the thread, counted or not. */
  assistantCount: number;
}

/** A statement of fact with an implied action. Never a grade. */
export interface UsageSignal {
  /** Stable key for React and for tests. */
  id: string;
  /** What is true. */
  fact: string;
  /** What to do about it, or null when the fact is simply context. */
  action: string | null;
}

/** One person's usage, in the conversations they started. */
export interface PerPersonUsage {
  userId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Threads they started that reported counts. */
  threads: number;
  /** Replies with counts, so a row can say what it is based on. */
  counted: number;
  cacheRate: number | null;
}

export interface TokenInsights {
  /** True when no thread reported a single count, the panel renders nothing at all. */
  empty: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  /** Replies with counts, and replies in total, the honesty pair. */
  counted: number;
  replies: number;
  /** Threads that contributed at least one counted reply. */
  threads: number;
  /**
   * Share of prompt tokens served from cache, 0..100, or `null` when nothing reported a cache split.
   *
   * ⚠ `null` RATHER THAN 0. "Nothing was cached" and "nobody measured caching" look identical as a
   * percentage and mean opposite things, the first is fixable, the second is an absence of data.
   */
  cacheRate: number | null;
  /**
   * The team's own trend: cache rate over the OLDER half of their threads versus the NEWER half.
   *
   * `null` unless there are enough counted threads on both sides for the comparison to mean anything -
   * a "trend" computed from one thread each side is noise wearing a conclusion's clothes.
   */
  trend: { older: number; newer: number; delta: number } | null;
  signals: UsageSignal[];
  /**
   * Per-person usage, ordered BY NAME-INDEPENDENT USER ID rather than by consumption.
   *
   * ⚠ ORDERING BY TOKENS WOULD BE A RANKING, and ordering teams that way was rejected for the same reason -
   * per person it is worse, because this page sits beside a model-written assessment of the same named people.
   * A stable, usage-independent order keeps it a breakdown rather than a leaderboard. The caller sorts by name
   * for display; nothing here sorts by amount.
   */
  perPerson: PerPersonUsage[];
}

const EMPTY: TokenInsights = {
  perPerson: [],
  empty: true,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  counted: 0,
  replies: 0,
  threads: 0,
  cacheRate: null,
  trend: null,
  signals: [],
};

/** Minimum counted threads per side before a trend is claimed. Two each is the least that is not noise. */
const MIN_THREADS_PER_SIDE = 2;

function rate(cached: number, input: number): number | null {
  if (input <= 0) return null;
  /* Clamped: a cache figure above the prompt would be a CLI bug, not a >100% saving. */
  return Math.min(100, Math.round((cached / input) * 100));
}

/**
 * Aggregate a team's threads, and say what is worth acting on.
 *
 * @param threads One entry per thread. Threads with no counted replies are ignored for the figures but
 *                still counted as threads, because "you started 9 conversations" is true either way.
 */
export function computeTokenInsights(threads: ThreadTokens[]): TokenInsights {
  const counted = threads.filter((t) => t.tokenCount > 0);
  if (counted.length === 0) return EMPTY;

  const sum = (pick: (t: ThreadTokens) => number) => counted.reduce((a, t) => a + pick(t), 0);

  const inputTokens = sum((t) => t.inputTokens);
  const cachedInputTokens = sum((t) => t.cachedInputTokens);
  const cacheWriteInputTokens = sum((t) => t.cacheWriteInputTokens);
  const countedReplies = sum((t) => t.tokenCount);
  const replies = threads.reduce((a, t) => a + t.assistantCount, 0);

  /**
   * ⚠ ORDERED OLDEST-FIRST FOR THE TREND, and only threads that reported a cache split take part: a thread
   * with tokens but no cache figure would drag a cache trend toward zero for a reason that is not about
   * caching at all.
   */
  const forTrend = counted
    .filter((t) => t.cacheCounted > 0 && t.inputTokens > 0)
    .slice()
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));

  let trend: TokenInsights["trend"] = null;
  if (forTrend.length >= MIN_THREADS_PER_SIDE * 2) {
    const half = Math.floor(forTrend.length / 2);
    const side = (xs: ThreadTokens[]) => {
      const i = xs.reduce((a, t) => a + t.inputTokens, 0);
      const c = xs.reduce((a, t) => a + t.cachedInputTokens, 0);
      return rate(c, i) ?? 0;
    };
    const older = side(forTrend.slice(0, half));
    const newer = side(forTrend.slice(half));
    trend = { older, newer, delta: newer - older };
  }

  const cacheRate = counted.some((t) => t.cacheCounted > 0) ? rate(cachedInputTokens, inputTokens) : null;

  return {
    empty: false,
    inputTokens,
    outputTokens: sum((t) => t.outputTokens),
    cachedInputTokens,
    cacheWriteInputTokens,
    counted: countedReplies,
    replies,
    threads: threads.length,
    cacheRate,
    trend,
    perPerson: perPerson(counted),
    signals: buildSignals({
      counted,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      countedReplies,
      threadCount: threads.length,
    }),
  };
}

/**
 * The facts worth surfacing, each with the action it implies.
 *
 * ⚠ EVERY ONE IS A COUNT OR A RATIO OF TWO MEASURED NUMBERS. None is a comparison against a target, and none
 * uses a word like "poor" or "good", the participant draws the conclusion, which is the difference between
 * coaching and marking.
 */
function buildSignals(d: {
  counted: ThreadTokens[];
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  countedReplies: number;
  threadCount: number;
}): UsageSignal[] {
  const signals: UsageSignal[] = [];

  /**
   * ⚠ THE COLD-CACHE SIGNAL, AND THE READ/WRITE PAIR IS WHY IT CAN EXIST. Writing to the cache while never
   * reading from it means the cache is being thrown away, a new thread per question, or gaps long enough for
   * it to expire. A first turn does the same thing legitimately, which is why the ratio matters and a bare
   * "low cache" number could not tell the two apart.
   */
  if (d.cacheWriteInputTokens > 0 && d.cachedInputTokens < d.cacheWriteInputTokens) {
    signals.push({
      id: "cold-cache",
      fact:
        `More of the prompt was written to cache (${d.cacheWriteInputTokens.toLocaleString()}) than was ` +
        `read back from it (${d.cachedInputTokens.toLocaleString()}).`,
      action: "Staying in one conversation lets later turns reuse what earlier ones paid for.",
    });
  }

  /**
   * Threads are where the cache resets, so the count is the fact and the action follows from it. Stated only
   * when there is more than one, because "you had 1 conversation" implies nothing.
   */
  if (d.threadCount > 1) {
    signals.push({
      id: "thread-count",
      fact: `${d.threadCount} conversations; each one starts with a cold cache.`,
      action: "Follow-up questions in the same conversation cost less than a new one.",
    });
  }

  /**
   * Average prompt size per reply. A big number is not a fault, a long useful conversation earns it, so
   * this is offered as context with no action attached.
   */
  if (d.countedReplies > 0) {
    const perReply = Math.round(d.inputTokens / d.countedReplies);
    signals.push({
      id: "context-per-reply",
      fact: `Each reply sent about ${perReply.toLocaleString()} tokens of context.`,
      action: null,
    });
  }

  return signals;
}

/**
 * Group usage by the person who started each conversation.
 *
 * ⚠ THIS IS NOT "TOKENS THEY SPENT", and the distinction is not pedantry. The counts live on the ASSISTANT
 * messages, which carry no user id, so the only attribution the data supports is to the thread's OWNER. A
 * participant who contributed turns to a colleague's thread contributes nothing to their own row. Anything
 * presenting this as personal consumption would be asserting something the data cannot support, next to an
 * assessment of the same person.
 *
 * ⚠ AND IT IS DELIBERATELY NOT SORTED BY AMOUNT. Sorting by tokens turns a breakdown into a ranking; see the
 * note on `perPerson` in the interface.
 */
function perPerson(counted: ThreadTokens[]): PerPersonUsage[] {
  const byUser = new Map<string, PerPersonUsage>();

  for (const t of counted) {
    /* No owner means no row, attributing an unowned thread to "Unknown" would invent a participant. */
    if (!t.ownerId) continue;

    const row =
      byUser.get(t.ownerId) ??
      {
        userId: t.ownerId,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        threads: 0,
        counted: 0,
        cacheRate: null,
      };

    row.inputTokens += t.inputTokens;
    row.outputTokens += t.outputTokens;
    row.cachedInputTokens += t.cachedInputTokens;
    row.threads += 1;
    row.counted += t.tokenCount;
    byUser.set(t.ownerId, row);
  }

  for (const row of byUser.values()) {
    row.cacheRate = rate(row.cachedInputTokens, row.inputTokens);
  }

  /* Stable order by id, NOT by usage. See the interface note. */
  return [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}
