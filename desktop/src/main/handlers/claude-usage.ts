// ── ⚠ WHAT A CLAUDE TURN COST, IN THE SAME UNITS AS CODEX ────────────────────────────────
//
// Codex has reported counts since migration 13; Claude reported none, so every Claude conversation showed a
// blank where Codex showed `12.4k ctx · 3.1k out`. The display was never the problem — `MessageTokens` and
// the header total in `AssistantChatView` are provider-agnostic and were already in place. Nothing was being MEASURED.
//
// ⚠ PURE, AND SEPARATE FROM THE HANDLER, for the reason recorded in `codex-events.ts`: the parsing is where
// the judgement lives, so it has to be testable without spawning an assistant. `claude-code.ts` keeps the
// side effects.
//
// ── ⚠ THE COUNTERS ARE DISJOINT, WHERE CODEX'S ARE NESTED. THIS IS THE WHOLE FILE. ──
//
// Measured against the real CLI rather than assumed — `claude -p --output-format json` on a trivial prompt
// with a large system prompt returned:
//
//     input_tokens: 2      cache_read_input_tokens: 13366      cache_creation_input_tokens: 33396
//
// Two tokens of "input" for a prompt of roughly 46,764. Anthropic reports the cached portions as SEPARATE
// counters, not as a subset of `input_tokens`. Codex reports the opposite shape: its `cached_input_tokens` is
// "the part of the prompt served from cache" — nested INSIDE `input_tokens`.
//
// `chat_messages.input_tokens` already means "the whole prompt sent for this turn", because that is what
// Codex writes and what every reader assumes:
//
//   • `MessageTokens` labels it `ctx` and its tooltip says "this turn's whole prompt, including the
//     conversation so far"
//   • `token-insights.ts` computes `cacheRate = cached / input` and clamps above 100% as "a CLI bug"
//   • `computeTokenInsights` sums across every thread REGARDLESS OF PROVIDER
//
// So writing Claude's raw `input_tokens` into that column would not be a smaller number — it would be a
// DIFFERENT QUANTITY sharing a column with Codex's. The panel would have reported 2 tokens of context for a
// 47k prompt, and a cache rate of 668,300% clamped to a confident "100% served from cache".
//
// Hence: the cached portions are ADDED BACK to produce the prompt that was actually sent. `cached ⊂ input`
// then holds for both providers, which is the invariant the aggregates were written against.

/** The five counts, in the shape `saveMessage`/`syncCliTurn` already accept for Codex. */
export interface TurnTokens {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
}

/**
 * Present, finite and non-negative, or absent.
 *
 * ⚠ ABSENT RATHER THAN 0, the same rule `codex-events.ts` follows. "This turn cost nothing" and "nobody
 * counted this turn" are different facts, and the portal's coverage line exists to tell them apart — a zero
 * would understate a real conversation while looking authoritative.
 */
function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function sumDefined(...vs: (number | undefined)[]): number | undefined {
  const present = vs.filter((v): v is number => v !== undefined);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) : undefined;
}

/**
 * Read one turn's usage off the SDK's `result` frame.
 *
 * ⚠ ONE FRAME IS ONE TURN, and that is only true because `claude-code.ts` calls `query({ prompt: <string> })`
 * — a fresh query per turn. The SDK documents `usage` and `total_cost_usd` as CUMULATIVE across turns in
 * streaming-input sessions (an async-iterable prompt), where reading each result would double-count. If that
 * call ever becomes a long-lived streaming session, this function is wrong and the tests below will not
 * notice — the shape of the frame does not change, only its meaning.
 *
 * ⚠ `modelUsage` IS PREFERRED OVER `usage` FOR THE FOUR CORE COUNTS, on the SDK's own instruction: "MAIN
 * AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls... Prefer modelUsage for
 * token/cost accounting." A turn that delegates to a subagent spends real tokens that `usage` omits
 * entirely, and silently under-reporting a whole subagent is worse than any rounding.
 *
 * ⚠ AND IT IS KEYED BY MODEL, so the values are summed across keys: one turn can legitimately use several
 * models (a cheap one for a subagent, the main one for the reply). Reading the first key was a bug I had to
 * write a mutation for.
 *
 * ⚠ REASONING STILL COMES FROM `usage`, because `modelUsage` carries no thinking breakdown at all. That
 * makes it main-loop-only where the other four are not — it stays a subset of `output_tokens`, so nothing
 * breaks, but a subagent's thinking is not counted. Recorded here rather than silently mixed.
 *
 * @returns the counts, or undefined when the frame reported nothing usable — in which case the row's columns
 *          stay NULL and the coverage figure says so.
 */
export function claudeTurnTokens(frame: unknown): TurnTokens | undefined {
  if (!frame || typeof frame !== "object") return undefined;
  const f = frame as Record<string, any>;
  if (f.type !== "result") return undefined;

  /* ── the four core counts, summed across every model the turn used ── */
  const models =
    f.modelUsage && typeof f.modelUsage === "object" ? Object.values(f.modelUsage) : [];

  let input: number | undefined;
  let output: number | undefined;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;

  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const u = m as Record<string, any>;
    input = sumDefined(input, count(u.inputTokens));
    output = sumDefined(output, count(u.outputTokens));
    cacheRead = sumDefined(cacheRead, count(u.cacheReadInputTokens));
    cacheWrite = sumDefined(cacheWrite, count(u.cacheCreationInputTokens));
  }

  /**
   * ⚠ THE FALLBACK IS `usage`, NOT NOTHING. An older CLI, or a crash-shaped result, can carry `usage`
   * without `modelUsage` — and a turn whose tokens are merely harder to reach must not be recorded as
   * uncounted. Field names differ between the two (snake_case here, camelCase above), which is itself worth
   * spelling out: they are different types, not two spellings of one.
   */
  const u = f.usage && typeof f.usage === "object" ? (f.usage as Record<string, any>) : undefined;
  if (input === undefined && output === undefined && u) {
    input = count(u.input_tokens);
    output = count(u.output_tokens);
    cacheRead = count(u.cache_read_input_tokens);
    cacheWrite = count(u.cache_creation_input_tokens);
  }

  /* See the header: the cached portions are part of the prompt that was SENT, so they are added back. */
  const promptSent = sumDefined(input, cacheRead, cacheWrite);

  /* Main-loop only — see the note above. `thinking_tokens` is documented as always <= output_tokens. */
  const reasoning = count(u?.output_tokens_details?.thinking_tokens);

  const tokens: TurnTokens = {
    ...(promptSent !== undefined ? { inputTokens: promptSent } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };

  return Object.keys(tokens).length > 0 ? tokens : undefined;
}
