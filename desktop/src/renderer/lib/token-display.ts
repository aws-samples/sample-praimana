// ── ⚠ WHAT A CONVERSATION COST, WITHOUT OVERSTATING IT ───────────────────────────────────
//
// The counts come from the CLI's own `turn.completed` and are now stored per message (migration 13), so both
// halves of that are answerable. This module is the arithmetic and the wording, kept pure so the honesty rules
// below are testable rather than asserted in a comment.
//
// ── ⚠ THE TWO RULES THAT MATTER ──
//
//   1. NULL IS NOT ZERO. Every row written before migration 13 has no counts, and so does every turn from an
//      assistant that does not report them (Claude's spawn path, Kiro). A total that treated those as zero
//      would understate a conversation while looking authoritative — so a partial total says how many turns it
//      covers, exactly as the portal's "(min)" does.
//
//   2. "CONTEXT" IS NOT "WHAT I TYPED". `inputTokens` is the WHOLE prompt for a turn, so it grows as the
//      conversation does and summing it across turns re-counts the earlier ones. That is the honest total of
//      what was SENT — which is what a cost question asks — and it is emphatically not a measure of the
//      participant's writing. The label says "context" for that reason.

/** One message's stored counts, as they arrive from SQLite via `SELECT *`. */
export interface MessageTokens {
  /** `null`/absent means the turn was never counted. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /**
   * The part of the prompt served from cache instead of re-read (migration 13).
   *
   * ⚠ THIS IS THE ONLY HONEST BASIS FOR A "SAVINGS" FIGURE. It is measured by the CLI, not compared against a
   * hypothetical — `cached / input` is the share of the prompt that cost nothing to re-send. Anything
   * described as savings without a number like this behind it is a guess presented as a fact.
   */
  cached_input_tokens?: number | null;
  /** The share of the reply spent thinking rather than answering. */
  reasoning_output_tokens?: number | null;
}

export interface TokenTotals {
  /** Prompt tokens served from cache — the measured saving. */
  cached: number;
  /** Reply tokens spent reasoning rather than answering. */
  reasoning: number;
  cacheCounted: number;
  /** Sum of each turn's full prompt. See rule 2. */
  input: number;
  output: number;
  /** Assistant messages carrying at least one count. */
  counted: number;
  /** Assistant messages in the conversation, counted or not. */
  assistantTurns: number;
  /** True when some assistant turns have no counts, so the totals are a floor. */
  partial: boolean;
}

const EMPTY: TokenTotals = {
  cached: 0,
  reasoning: 0,
  cacheCounted: 0,
  input: 0,
  output: 0,
  counted: 0,
  assistantTurns: 0,
  partial: false,
};

/** A number the UI may add up: present, finite and not negative. */
function usable(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Whether this message has anything to show at all. */
export function hasTokens(msg: MessageTokens): boolean {
  return usable(msg.input_tokens) || usable(msg.output_tokens);
}

/**
 * Total a conversation.
 *
 * @param messages Every message in the session — user rows are ignored, since only an assistant turn carries
 *                 counts, and including them in `assistantTurns` would make coverage look worse than it is.
 */
export function totalTokens(
  messages: Array<MessageTokens & { role?: string }>
): TokenTotals {
  let input = 0;
  let output = 0;
  let cached = 0;
  let reasoning = 0;
  let cacheCounted = 0;
  let counted = 0;
  let assistantTurns = 0;

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    assistantTurns += 1;
    if (usable(msg.input_tokens)) input += msg.input_tokens;
    if (usable(msg.output_tokens)) output += msg.output_tokens;
    if (usable(msg.reasoning_output_tokens)) reasoning += msg.reasoning_output_tokens;
    /**
     * ⚠ THE CACHE FIGURE IS COUNTED SEPARATELY, because a turn can report tokens without reporting a cache
     * split — every row from before migration 13 does. Folding it into `counted` would let the savings
     * percentage claim coverage it does not have.
     */
    if (usable(msg.cached_input_tokens)) {
      cached += msg.cached_input_tokens;
      cacheCounted += 1;
    }
    if (hasTokens(msg)) counted += 1;
  }

  if (assistantTurns === 0) return EMPTY;
  return {
    input,
    output,
    cached,
    reasoning,
    cacheCounted,
    counted,
    assistantTurns,
    partial: counted < assistantTurns,
  };
}

/**
 * Compact count: `931`, `13.0k`, `1.2M`.
 *
 * ⚠ ABBREVIATED BECAUSE IT SITS IN A 10px ROW beside a message, where the exact figure is noise. The precise
 * numbers go in the `title`, so nothing is hidden — only shortened.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * The tooltip for a conversation's total.
 *
 * States the coverage in words whenever it is partial. A reader who sees "12.4k context" has no way of knowing
 * it covers two of six turns unless the sentence says so.
 */
export function describeTotals(t: TokenTotals): string {
  const base =
    `${t.input.toLocaleString()} tokens of context sent (each turn includes the conversation so far, ` +
    `so this re-counts earlier turns) and ${t.output.toLocaleString()} generated`;

  if (!t.partial) return `${base}, over all ${t.assistantTurns} replies.`;
  return (
    `${base}, over ${t.counted} of ${t.assistantTurns} replies — the rest were never counted, ` +
    `so this is a minimum.`
  );
}

/**
 * ── ⚠ WHAT THE CACHE ACTUALLY SAVED ──────────────────────────────────────────────────────
 *
 * `cached / input` — the share of the prompt that was served from cache rather than re-sent. MEASURED by the
 * CLI, which is what makes it a statement rather than a sales figure.
 *
 * ⚠ WHAT THIS DELIBERATELY DOES NOT DO. It does not compare against "what you would have spent with a worse
 * prompt", because nothing measured that: a saving against a hypothetical is a number somebody chose. If a
 * before-and-after claim is wanted, it has to come from two real conversations.
 *
 * ⚠ AND IT RETURNS null RATHER THAN 0 WHEN NOTHING REPORTED A CACHE SPLIT. "0% saved" and "nobody measured"
 * look identical as a percentage and mean opposite things — the first is a problem to fix, the second is an
 * absence of data. Every turn before migration 13 is the second.
 */
export function cacheSavings(t: TokenTotals): { percent: number; covered: number } | null {
  if (t.cacheCounted === 0 || t.input <= 0) return null;
  /* Clamped at 100: a cache figure exceeding the prompt would be a CLI bug, not a 120% saving. */
  const percent = Math.min(100, Math.round((t.cached / t.input) * 100));
  return { percent, covered: t.cacheCounted };
}
