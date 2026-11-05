import type { AiMessage } from "./domain.js";

/**
 * Per-thread timing rollup: how long the AI spent generating vs. how long the
 * user spent reading and composing.
 *
 * ─── MEASURED vs. INFERRED — the whole point of this module ───────────────────
 * These two halves are NOT the same kind of number, and the shape below refuses
 * to let a caller pretend otherwise:
 *
 *   AI time   is MEASURED. It is the sum of `latencyMs` values recorded around
 *             the actual model invoke (model.bedrock.ts). If the model took
 *             4.2s, we know it took 4.2s.
 *
 *   USER time is INFERRED. Nothing observes a person typing. We only see the
 *             timestamp of the message that preceded theirs and the timestamp of
 *             their own, so "user time" is really "elapsed wall-clock during
 *             which the ball was in the user's court". That includes reading the
 *             answer, thinking, being interrupted, and going to lunch. It is an
 *             upper bound on composing, never a measurement of it — hence the
 *             `inferred` naming and the separate idle bucket below.
 *
 * Consumers rendering a headline number must say which is which. The field names
 * (`measuredMs` / `inferredMs`) and the `basis` discriminators exist so that a
 * UI cannot accidentally sum them into one authoritative-looking figure.
 *
 * ─── WHY THE ASSISTANT TIMESTAMP MAKES THE GAP CLEAN ─────────────────────────
 * The assistant message's `createdAt` is stamped when the model FINISHED (the
 * route persists it after `complete()` resolves). So the gap from an assistant
 * message to the next user message contains no generation time — the two halves
 * partition the session rather than overlapping. This is exactly the separation
 * `createdAt` alone could not give us: without `latencyMs` you cannot tell a 30s
 * gap that was "the model was working" from one that was "nobody was looking".
 *
 * ─── WHY THIS IS COMPUTED ON READ, NOT STORED ON AiThread ────────────────────
 * On-read, every time. The messages route already performs exactly one
 * thread-partitioned Query and therefore already holds the full message list; the
 * rollup is a single linear pass over data in hand, with zero extra IO. Storing
 * it on `AiThread` would buy nothing at these sizes (a conversation is tens of
 * messages, not millions) and would cost real correctness: a second write on
 * every message, a denormalized aggregate that silently drifts if any write
 * fails, and a stale value for the messages that legacy/synced paths insert
 * without going through the model route at all. A derived figure that can be
 * recomputed exactly from the source of truth should be derived, not cached, until
 * a profile says otherwise.
 */

/**
 * A user gap longer than this is classified as IDLE rather than composing.
 *
 * WHY: a chat left open overnight produces a 14-hour assistant→user gap. Folding
 * that into "time the user spent composing" would swamp every real number in the
 * session and make the mean meaningless. Idle time is not discarded — it is
 * counted in its own bucket so the total is still reconcilable and the caller can
 * see that a trim happened.
 *
 * 15 minutes is a judgement call, not a measurement, which is why it is a named
 * constant and an overridable option rather than a magic number inline.
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60 * 1000;

export interface RollupOptions {
  idleThresholdMs?: number;
}

/** AI-side totals. Every field here derives from a recorded measurement. */
export interface AiTimeRollup {
  basis: "measured";
  /** Sum of `latencyMs` over assistant messages that HAVE one. */
  measuredMs: number;
  /** Assistant messages carrying a `latencyMs`. */
  measuredCount: number;
  /**
   * Assistant messages with NO `latencyMs` — pre-instrumentation rows and
   * transcripts synced from a desktop session we never timed. Their generation
   * time is unknown and is NOT counted as zero.
   */
  unmeasuredCount: number;
  /**
   * Fraction of assistant messages we have timing for, 0..1. `1` means
   * `measuredMs` is the thread's true total AI time; anything less means it is a
   * LOWER BOUND over `measuredCount` messages only.
   */
  coverage: number;
  /**
   * True only when every assistant message in the thread is measured. When false
   * a caller must not present `measuredMs` as the session's AI total.
   */
  complete: boolean;
  /**
   * Mean over MEASURED messages only, or `null` when there is nothing to average.
   * `null` rather than `0`: a thread with no timing has an unknown mean, and a
   * zero here would drag down any average computed across threads.
   */
  meanMs: number | null;
  /**
   * Mean time-to-first-token over the messages that recorded one (streamed
   * responses only), or `null`. Kept apart from `meanMs` because
   * time-to-first-token and time-to-completion answer different questions.
   */
  firstTokenMeanMs: number | null;
  firstTokenSampleCount: number;
  /**
   * ── TOKENS, WHERE THE CLI REPORTED THEM ────────────────────────────────────────────────
   *
   * ⚠ COUNTED THE SAME WAY THE TIME IS, and with the same refusal to guess: summed over assistant
   * messages that HAVE a count, with a coverage fraction saying how many that was. A thread where two of
   * five turns reported tokens shows the two, and says so — it does not scale them up to five or treat the
   * other three as zero.
   *
   * ⚠ `inputTokens` IS THE WHOLE PROMPT PER TURN, context included, so summing it across a thread
   * double-counts the conversation as it grows: turn three re-sends turns one and two. It is still the
   * honest total of what was SENT, which is what a cost question asks, but it is not "how much the
   * participant wrote" and must not be labelled as such.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * Prompt tokens served from cache — the MEASURED saving, and the only honest basis for the "% saved" a
   * participant is shown. `cacheCounted` says how many replies reported it, because most rows never will.
   */
  cachedInputTokens: number;
  /**
   * Prompt tokens written to the cache. Reported ALONGSIDE the read figure rather than netted against it: the
   * question "is this fixable?" is answered by the RATIO of the two, and a single combined number destroys it.
   */
  cacheWriteInputTokens: number;
  cacheCounted: number;
  /** Assistant messages carrying at least one count. */
  tokenCount: number;
  /** Fraction of assistant messages with token counts, 0..1. */
  tokenCoverage: number;
  /**
   * ── ⚠ HOW FULL THE CONTEXT WINDOW IS, AND WHY IT IS THE LAST READING RATHER THAN A TOTAL ──
   *
   * THE SYMPTOM: the portal showed no context-usage percentage for Kiro chats.
   *
   * `null` when no reply in the thread reported one — every Claude and Codex thread, and every Kiro thread
   * from before the desktop carried the figure. Absent is NOT 0: a conversation nobody measured and one with
   * an empty window are different facts, and this sits on a page executives read.
   *
   * ⚠ EVERY OTHER FIGURE ON THIS TYPE IS A SUM. THIS ONE MUST NOT BE, and it is the single most likely thing
   * for a later change to get wrong. Context fullness is a reading of a STATE at one instant, not a quantity
   * a turn contributes:
   *
   *   • summed  — two turns at 40% would report "80% full", which describes nothing. Four such turns would
   *               report 160%.
   *   • averaged — a long conversation that grew 5% → 90% would report ~48%, understating a chat that is
   *               nearly full and about to be compacted. The mean of a monotonically rising series is a fact
   *               about arithmetic, not about the conversation.
   *   • maximum  — defensible but wrong after a COMPACT, which is the one event that makes the number drop.
   *               A compacted thread would keep reporting its pre-compact peak forever.
   *
   * The LAST reading is the only aggregate that answers the question a participant actually has — "is this
   * chat close to needing a compact?" — and it survives compaction correctly, because Kiro reports the new,
   * lower figure on the next turn.
   */
  contextUsagePercent: number | null;
}

/** User-side totals. Every field here is an estimate derived from timestamps. */
export interface UserTimeRollup {
  basis: "inferred";
  /**
   * Sum of gaps ending at a user message, excluding idle gaps. An UPPER BOUND on
   * time spent composing — it also contains reading and thinking.
   */
  inferredMs: number;
  /** Gaps that contributed to `inferredMs`. */
  inferredGapCount: number;
  /** Gaps over the idle threshold, held out of `inferredMs`. */
  idleMs: number;
  idleGapCount: number;
  /**
   * Gaps we refused to infer anything from: either endpoint was a bulk-`synced`
   * message (fabricated millisecond spacing), or the timestamps ran backwards.
   */
  unusableGapCount: number;
  /** Mean over counted gaps only, or `null` when there are none. */
  meanMs: number | null;
}

export interface ThreadTimingRollup {
  threadId: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  /** Wall-clock from the first to the last message, or `null` for <2 messages. */
  spanMs: number | null;
  ai: AiTimeRollup;
  user: UserTimeRollup;
  /**
   * True when the thread carries no usable timing signal at all — no measured AI
   * latency and no inferable user gap. Callers should render "no timing data"
   * rather than a row of zeros, which would read as an instantaneous session.
   */
  empty: boolean;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function mean(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

/**
 * Roll a thread's messages up into user-time vs. AI-time totals.
 *
 * Pure and synchronous: it takes the messages the caller already loaded and
 * returns a value. No IO, no clock, no Bedrock — which is what makes the
 * mixed-legacy and no-timing cases straightforward to test.
 *
 * `messages` need not be sorted; they are ordered by `createdAt` defensively
 * (DynamoDB returns them sorted by the range key, but this function is also
 * called with hand-built lists).
 */
export function rollUpThreadTiming(
  threadId: string,
  messages: AiMessage[],
  opts: RollupOptions = {}
): ThreadTimingRollup {
  const idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;

  const ordered = [...messages].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  );

  let userMessageCount = 0;
  let assistantMessageCount = 0;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let cacheCounted = 0;
  let tokenCount = 0;
  /**
   * ⚠ ASSIGNED, NEVER ACCUMULATED — the one figure in this loop that is not a running total.
   *
   * `ordered` is oldest-first, so plain assignment on every reporting reply leaves the LAST reading standing,
   * which is the state of the conversation now. `+=` here would produce "160% full" on a four-turn chat; see
   * the note on `contextUsagePercent` in `AiTimeRollup` for why max and mean are wrong too.
   */
  let contextUsagePercent: number | null = null;
  let measuredMs = 0;
  let measuredCount = 0;
  let unmeasuredCount = 0;
  let firstTokenTotalMs = 0;
  let firstTokenSampleCount = 0;

  let inferredMs = 0;
  let inferredGapCount = 0;
  let idleMs = 0;
  let idleGapCount = 0;
  let unusableGapCount = 0;

  for (let i = 0; i < ordered.length; i++) {
    const msg = ordered[i];

    if (msg.role === "assistant") {
      assistantMessageCount++;
      // The explicit `undefined` check is the backward-compatibility contract:
      // a legacy row has no field, and treating that as 0 would understate AI
      // time while inflating coverage. `latencyMs: 0` from a real (absurdly
      // fast) call is still honoured.
      /**
       * ⚠ COUNTED INDEPENDENTLY OF THE LATENCY. A turn can report tokens without a latency or the reverse,
       * so folding this inside the latency branch would silently drop the counts for any turn that lacked
       * a duration — and the coverage figure would then describe timing while claiming to describe tokens.
       */
      const hasIn = isFiniteNonNegative(msg.inputTokens);
      const hasOut = isFiniteNonNegative(msg.outputTokens);
      if (hasIn) inputTokens += msg.inputTokens as number;
      if (hasOut) outputTokens += msg.outputTokens as number;
      if (hasIn || hasOut) tokenCount += 1;
      /**
       * ⚠ COUNTED SEPARATELY from the token count. A turn can report tokens without a cache split — every row
       * from before the breakdown shipped does — and sharing the counter would let the savings figure claim
       * coverage it does not have.
       */
      if (isFiniteNonNegative(msg.cachedInputTokens)) {
        cachedInputTokens += msg.cachedInputTokens as number;
        cacheCounted += 1;
      }
      if (isFiniteNonNegative(msg.cacheWriteInputTokens)) {
        cacheWriteInputTokens += msg.cacheWriteInputTokens as number;
      }

      /**
       * ⚠ LAST WINS, AND THE RANGE IS CHECKED HERE TOO. The sync route bounds it on the way in, but this
       * function also serves rows written by other paths and by earlier versions of that route — a rollup
       * that trusted its input would be the place a bad value became a rendered "140% full".
       *
       * A reply that reports nothing leaves the previous reading standing rather than clearing it: coverage
       * is per-assistant here, and a mid-thread Claude turn in a shared conversation must not erase what
       * Kiro measured.
       */
      const ctx = msg.contextUsagePercent;
      if (isFiniteNonNegative(ctx) && (ctx as number) <= 100) {
        contextUsagePercent = Math.round(ctx as number);
      }

      if (isFiniteNonNegative(msg.latencyMs)) {
        measuredMs += msg.latencyMs;
        measuredCount++;
      } else {
        unmeasuredCount++;
      }
      if (isFiniteNonNegative(msg.firstTokenMs)) {
        firstTokenTotalMs += msg.firstTokenMs;
        firstTokenSampleCount++;
      }
      continue;
    }

    userMessageCount++;

    // ── Inferred user time: the gap that ENDS at this user message ──
    // The first message in a thread has no predecessor, so there is no gap to
    // attribute — thread creation to first message is not something we observe.
    const prev = i > 0 ? ordered[i - 1] : undefined;
    if (!prev) continue;

    // Bulk-synced messages were written with fabricated `base + i` millisecond
    // spacing by the share/sync path, so their gaps describe a for-loop, not a
    // human. Refuse to infer across either endpoint.
    if (prev.synced || msg.synced) {
      unusableGapCount++;
      continue;
    }

    const gapMs = Date.parse(msg.createdAt) - Date.parse(prev.createdAt);
    if (!Number.isFinite(gapMs) || gapMs < 0) {
      // Unparseable or backwards timestamps (clock skew, hand-edited rows).
      unusableGapCount++;
      continue;
    }

    if (gapMs > idleThresholdMs) {
      idleMs += gapMs;
      idleGapCount++;
    } else {
      inferredMs += gapMs;
      inferredGapCount++;
    }
  }

  // NOTE on which gaps count as user time: any gap ending at a user message
  // does, whether the message before it was the assistant's or the user's own.
  // That is a superset of the strict "previous assistant → next user" rule, and
  // deliberately so — when someone sends two messages in a row ("...and also
  // this"), the pause between them is still them typing. The gaps we exclude are
  // those ending at an ASSISTANT message, because that interval is generation
  // time and is already accounted for, measured, on the AI side.

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const spanMs =
    ordered.length >= 2
      ? Math.max(0, Date.parse(last.createdAt) - Date.parse(first.createdAt))
      : null;

  const ai: AiTimeRollup = {
    basis: "measured",
    measuredMs,
    measuredCount,
    unmeasuredCount,
    coverage:
      assistantMessageCount > 0 ? measuredCount / assistantMessageCount : 0,
    complete: assistantMessageCount > 0 && unmeasuredCount === 0,
    meanMs: mean(measuredMs, measuredCount),
    firstTokenMeanMs: mean(firstTokenTotalMs, firstTokenSampleCount),
    firstTokenSampleCount,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheCounted,
    tokenCount,
    tokenCoverage: assistantMessageCount > 0 ? tokenCount / assistantMessageCount : 0,
    contextUsagePercent,
  };

  const user: UserTimeRollup = {
    basis: "inferred",
    inferredMs,
    inferredGapCount,
    idleMs,
    idleGapCount,
    unusableGapCount,
    meanMs: mean(inferredMs, inferredGapCount),
  };

  return {
    threadId,
    messageCount: ordered.length,
    userMessageCount,
    assistantMessageCount,
    spanMs,
    ai,
    user,
    empty: measuredCount === 0 && inferredGapCount === 0 && idleGapCount === 0,
  };
}
