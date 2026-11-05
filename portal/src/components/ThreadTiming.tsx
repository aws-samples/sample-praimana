"use client";

import { trpc } from "@/lib/trpc/client";
import { contextUsageReading, CONTEXT_ALARM_THRESHOLD } from "@/lib/context-usage";

/**
 * Per-thread time split: how long the ASSISTANT worked, and how long the ball was in the
 * USER's court.
 *
 * ── THE ONE RULE THIS COMPONENT EXISTS TO ENFORCE ──
 *
 * The two numbers are not the same kind of number, and they are never added together.
 *
 *   AI time   is MEASURED. For server-proxied turns it is the latency recorded around the
 *             model invoke; for CLI turns it is wall-clock from process spawn to exit,
 *             measured by the desktop that ran it. If it says 4.2s, it took 4.2s.
 *
 *   User time is INFERRED. Nothing watches a person type. It is elapsed wall-clock while
 *             nobody was generating, reading, thinking, being interrupted, lunch. An
 *             upper bound on composing, never a measurement of it.
 *
 * The API deliberately labels them (`basis: "measured"` / `"inferred"`) so a UI cannot
 * launder one into the other. Summing them would produce a confident-looking total that
 * means nothing, so this renders them side by side, names the basis, and says plainly when
 * coverage is partial.
 *
 * ── AND WHY IT IS NOT A PRODUCTIVITY SCORE ──
 *
 * A high AI share can mean someone delegates well, or that they are fighting to get a
 * usable answer. A long user gap can mean careful thought, or a coffee break. This is a
 * conversation-starter for a retrospective, not a measure of a person, and the copy avoids
 * implying otherwise.
 */

interface TimingData {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  spanMs: number | null;
  empty: boolean;
  ai: {
    basis: "measured";
    measuredMs: number;
    measuredCount: number;
    unmeasuredCount: number;
    coverage: number;
    /** CLI-reported token counts. See the strip below for why input is labelled "context". */
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCounted: number;
    tokenCount: number;
    tokenCoverage: number;
    /**
     * How full the context window was at the newest reply that reported it. Kiro only.
     *
     * ⚠ OPTIONAL **AND** NULLABLE, because the wire really is both and the difference caused a bug. `null`
     * means this service measured nothing; `undefined` means the service is too old to send the field, which
     * is every backend that has not been redeployed since it was added. Declared as `number | null` it looked
     * always-present, so a `!== null` guard passed on `undefined` and rendered "Context % full" with no
     * number. See `lib/context-usage.ts`.
     */
    contextUsagePercent?: number | null;
  };
  user: {
    basis: "inferred";
    inferredMs: number;
    inferredGapCount: number;
    idleMs: number;
    idleGapCount: number;
    unusableGapCount: number;
  };
}

/**
 * Compact token count: `13.0k`, `1.2M`.
 *
 * Abbreviated because the exact figure is noise at this size and the strip is one line, the `title` on the
 * element carries the precise numbers for anyone who needs them.
 */
function humanTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact, human duration. Sub-minute keeps a decimal so "0m" never stands for 40s. */
function humanMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function ThreadTiming({ threadId }: { threadId: string }) {
  const q = trpc.ai.timing.useQuery({ threadId }, { enabled: !!threadId });
  const t = q.data as TimingData | undefined;

  // Silent while loading and on failure. This is a supplementary read on a page whose
  // primary content is the conversation, an error banner for a stats strip would put a
  // fault in front of the user for something they did not ask for and cannot act on.
  if (q.isLoading || q.error || !t) return null;

  if (t.empty) {
    return (
      <p className="text-xs text-ink-tertiary">
        No timing data for this conversation.
      </p>
    );
  }

  const aiPartial = t.ai.coverage < 1;

  /**
   * Resolved once, in a PURE function, and deliberately not re-tested inline. `undefined` (an ai-service too
   * old to send the field) and `null` (one that measured nothing) must both render as absent, and `0` must
   * still render, which is why this is not a truthiness check. See lib/context-usage.ts for the bug this
   * replaced.
   */
  const contextUsage = contextUsageReading(t.ai.contextUsagePercent);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span className="text-ink-tertiary">AI worked</span>
        <span className="font-medium text-ink-muted tabular-nums">
          {humanMs(t.ai.measuredMs)}
        </span>
        {aiPartial && (
          // Coverage below 1 means some assistant messages carry no measurement, older
          // rows, or transcripts synced before the desktop timed its turns. Their time is
          // UNKNOWN, not zero, so the figure is a lower bound and has to say so.
          <span
            className="text-warn-text"
            title={`Measured for ${t.ai.measuredCount} of ${
              t.ai.measuredCount + t.ai.unmeasuredCount
            } assistant messages, the rest were not timed, so this is a minimum.`}
          >
            (min)
          </span>
        )}
      </span>

      {/*
        ── TOKENS, WHERE THE CLI REPORTED THEM ────────────────────────────────────────────────
        Input and output tokens, shown beside AI messages.

        ⚠ SHOWN ONLY WHEN SOMETHING REPORTED THEM. Every turn before this shipped has no counts, and a
        confident "0 tokens" on a real conversation would be worse than saying nothing, the same rule the
        rest of this strip follows.

        ⚠ "CONTEXT" AND NOT "INPUT", which is a wording decision with a reason. `inputTokens` is the WHOLE
        prompt for each turn, so a short reply late in a thread reported 13,027, the conversation goes with
        it, and summing across turns re-counts the earlier ones. It is the honest total of what was SENT,
        which is what a cost question asks, and it is emphatically not "how much the participant wrote".
        Labelling it "input" invites exactly that misreading.
      */}
      {t.ai.tokenCount > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-ink-tertiary">Tokens</span>
          <span
            className="font-medium text-ink-muted tabular-nums"
            title={`${t.ai.inputTokens.toLocaleString()} sent (each turn's full prompt, so the conversation is re-counted as it grows) and ${t.ai.outputTokens.toLocaleString()} generated, as reported by the CLI for ${t.ai.tokenCount} assistant message${t.ai.tokenCount === 1 ? "" : "s"}.`}
          >
            {humanTokens(t.ai.inputTokens)} context · {humanTokens(t.ai.outputTokens)} out
          </span>
          {t.ai.tokenCoverage < 1 && (
            /* Same honesty as "(min)" above: a partial count is a lower bound and has to say so. */
            <span
              className="text-warn-text"
              title={`Reported for ${t.ai.tokenCount} of ${
                t.ai.measuredCount + t.ai.unmeasuredCount
              } assistant messages, the rest carry no counts, so this is a minimum.`}
            >
              (min)
            </span>
          )}
        </span>
      )}

      {/*
        ── ⚠ WHAT THE CACHE SAVED, MEASURED ────────────────────────────────────────────────────
        Savings stats, e.g. the share of tokens saved through better prompting or participant education.

        `cached / input` from the CLI's own numbers, the share of the prompt that did not have to be re-sent.

        ⚠ NOT A COMPARISON AGAINST A WORSE PROMPT, because nothing measured that. A saving against a
        hypothetical is a number somebody chose, and this figure is explicitly meant to teach participants
        something, so it has to be true.

        ⚠ AND ABSENT RATHER THAN "0%" WHEN NOBODY MEASURED. "Nothing was cached" and "nobody counted caching"
        look identical as a percentage and mean opposite things.
      */}
      {t.ai.cacheCounted > 0 && t.ai.inputTokens > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-ink-tertiary">Cached</span>
          <span
            className="font-medium text-success-text tabular-nums"
            title={
              `${t.ai.cachedInputTokens.toLocaleString()} of ${t.ai.inputTokens.toLocaleString()} prompt ` +
              `tokens were served from cache rather than re-sent, over ${t.ai.cacheCounted} of ` +
              `${t.ai.measuredCount + t.ai.unmeasuredCount} replies. Shorter, more focused prompts and fewer ` +
              `topic changes raise it.`
            }
          >
            {Math.min(100, Math.round((t.ai.cachedInputTokens / t.ai.inputTokens) * 100))}% saved
          </span>
        </span>
      )}

      {/*
        ── ⚠ HOW FULL THE CONVERSATION WAS, WHICH IS NOT A TOTAL ────────────────────────────────
        REPORTED: "why for kiro chats context usage percentage is missing on portal".

        It was missing for the whole chain, not for want of a place to draw it: Kiro's reading lived in the
        desktop renderer's React state and no payload carried it. This is the last link.

        ⚠ THE LAST READING, NOT A SUM OR A MEAN, and the label says "was" rather than implying a total. The
        service computes it that way (`timing.ts`), the reasoning is recorded there, because that is where a
        future change would be tempted to `+=` it.

        ⚠ ONLY KIRO PUBLISHES IT, so no reading is the normal case and renders nothing at all. A "0% context"
        on a Claude thread would be a confident claim about a window nobody measured, the same rule the tokens
        and cache segments above follow.

        ⚠ THE GUARD IS `contextUsageReading`, NOT `!== null`, AND THAT WAS A REAL BUG. REPORTED: "can u check
        for kiro why percentage number is missing", the strip showed `Context` then `% full` with nothing
        between. `undefined !== null` is true, so the old guard admitted a MISSING field and React drew the
        value as empty. `undefined` is not exotic: every ai-service that predates this field omits it. The
        decision now lives in a tested pure function, because a guard inside JSX is a guard no portal test can
        reach. See lib/context-usage.ts.

        ⚠ AMBER ABOVE 85%, matching the desktop's own header (the 85 check in KiroChatView) rather than
        inventing a second opinion about when a chat is nearly full. Below that it is plain ink: a figure worth
        recording is not the same as a figure worth alarming about.
      */}
      {contextUsage !== null && (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-ink-tertiary">Context</span>
          <span
            className={`font-medium tabular-nums ${
              contextUsage >= CONTEXT_ALARM_THRESHOLD ? "text-warn-text" : "text-ink-muted"
            }`}
            title={
              `The assistant reported its context window ${contextUsage}% full at the most ` +
              `recent reply that measured it. This is a reading at one moment, not a total across the ` +
              `conversation, it falls again when a chat is compacted. Reported by Kiro; other assistants ` +
              `do not publish it.`
            }
          >
            {contextUsage}% full
          </span>
        </span>
      )}

      <span className="inline-flex items-center gap-1.5">
        <span className="text-ink-tertiary">Team time</span>
        <span className="font-medium text-ink-muted tabular-nums">
          {humanMs(t.user.inferredMs)}
        </span>
        <span
          className="text-ink-tertiary"
          title="Elapsed time between the assistant answering and the next message: reading, thinking and typing. Inferred from timestamps, not measured, treat it as an upper bound."
        >
          (approx)
        </span>
      </span>

      {t.user.idleMs > 0 && (
        // Held out of the total rather than discarded, so the numbers still reconcile
        // against the session span. A chat left open overnight would otherwise swamp
        // every real figure.
        <span
          className="text-ink-tertiary"
          title={`${t.user.idleGapCount} gap${
            t.user.idleGapCount === 1 ? "" : "s"
          } longer than 15 minutes, counted separately rather than as composing time.`}
        >
          idle {humanMs(t.user.idleMs)}
        </span>
      )}

      {t.user.unusableGapCount > 0 && (
        <span
          className="text-ink-tertiary"
          title="Some gaps could not be interpreted: bulk-synced transcripts carry generated timestamps, so the intervals between them describe the sync, not a person."
        >
          {t.user.unusableGapCount} gap
          {t.user.unusableGapCount === 1 ? "" : "s"} not counted
        </span>
      )}
    </div>
  );
}
