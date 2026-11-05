/**
 * ── THE TRANSCRIPT MODEL ──
 *
 * The chat used to be a string: tokens arrived on `cli:output` and were concatenated into one blob of
 * markdown per turn. That is all the old bubble layout could show, and it is why an agentic turn looked
 * like nothing was happening — every tool call the assistant made was invisible, so a fifteen-minute
 * turn rendered as a spinner and a silence.
 *
 * The VS Code extension renders a turn as an ORDERED SEQUENCE of blocks instead: some prose, a tool
 * call with its input and output, more prose, another tool call. That order is information — it is the
 * difference between "stuck" and "on its fourth command" — so the transcript is modelled as a list
 * rather than a string.
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ──
 *
 * This package's vitest runs `environment: "node"` with no jsdom, so nothing here can be tested through
 * a React render. Keeping the block algebra as pure functions over plain arrays is what makes the parts
 * that can actually be WRONG — result correlation, the per-turn cap, token formatting — testable at all.
 * AssistantChatView keeps only the wiring.
 *
 * Every function returns a NEW array when it changes something and the SAME array when it does not.
 * That identity is load-bearing: these run inside `setState` updaters on a hot stream, and returning an
 * unchanged reference is what stops a `tool_result` for an already-forgotten call from re-rendering the
 * whole transcript.
 */

/** One rendered row of a turn. */
export type TranscriptBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      /** Correlates this call with the `cli:tool-result` that lands later. Null if the SDK omitted it. */
      toolUseId: string | null;
      /** e.g. "Bash", "Read", "Edit" — the tool's own name, shown in bold. */
      tool: string;
      /** The assistant's one-line reason for the call. Null when it did not supply one. */
      description: string | null;
      /** The single most representative argument — the `IN` line. */
      input: string;
      /** The `OUT` line. Null until the result arrives, which is how "still running" is drawn. */
      output: string | null;
      /** The main process clipped the output at its own ceiling. */
      truncated: boolean;
      isError: boolean;
    }
  /** A stand-in for tool calls dropped by the per-turn cap. See MAX_TOOL_BLOCKS_PER_TURN. */
  | { kind: "note"; hidden: number };

/**
 * How many tool rows a single turn may render.
 *
 * ⚠ THIS IS A MEMORY BOUND, NOT A STYLE CHOICE. A long agentic turn can make dozens of tool calls, each
 * arriving with up to 2,000 characters of output, and these blocks live in renderer state for as long as
 * the session is on screen — on a workshop laptop that is not restarted for a day. 40 rows caps one turn
 * at roughly 80KB of retained output, and the overflow is REPORTED rather than silently dropped, because
 * a transcript that quietly stops listing tool calls is indistinguishable from an assistant that stopped
 * making them.
 */
export const MAX_TOOL_BLOCKS_PER_TURN = 40;

/**
 * How many completed turns keep their block detail.
 *
 * A finished turn's prose is in SQLite; its tool rows are not (the messages table stores content only).
 * So the blocks are retained in memory to keep the finished transcript looking like the live one, and
 * that retention needs a ceiling for the same reason the per-turn cap does. Beyond this the oldest turn
 * falls back to rendering its persisted markdown — the pre-existing behaviour, and not a blank row.
 */
export const MAX_RETAINED_TURNS = 20;

/**
 * Append streamed text.
 *
 * MERGED INTO THE TRAILING TEXT BLOCK rather than pushed. Tokens arrive a few characters at a time, so
 * pushing would build an array of thousands of one-word blocks per turn and hand React thousands of
 * siblings to reconcile. One growing string per prose run is the same rendered output for a constant
 * number of nodes.
 */
export function appendText(blocks: TranscriptBlock[], text: string): TranscriptBlock[] {
  if (!text) return blocks;
  const last = blocks[blocks.length - 1];
  if (last?.kind === "text") {
    const next = blocks.slice(0, -1);
    next.push({ kind: "text", text: last.text + text });
    return next;
  }
  return [...blocks, { kind: "text", text }];
}

/** The `cli:tool-use` payload, named so the wiring cannot transpose two strings unnoticed. */
export interface ToolUseEvent {
  toolUseId: string | null;
  tool: string;
  description: string | null;
  input: string;
}

/**
 * Record a tool call, or count it against the cap.
 *
 * The note block ACCUMULATES rather than repeating: the 41st call through the 60th produce one row
 * reading "20 further tool calls", not twenty rows.
 */
export function appendToolUse(
  blocks: TranscriptBlock[],
  event: ToolUseEvent
): TranscriptBlock[] {
  const shown = blocks.reduce((n, b) => (b.kind === "tool" ? n + 1 : n), 0);
  if (shown >= MAX_TOOL_BLOCKS_PER_TURN) {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "note") {
      const next = blocks.slice(0, -1);
      next.push({ kind: "note", hidden: last.hidden + 1 });
      return next;
    }
    return [...blocks, { kind: "note", hidden: 1 }];
  }
  return [
    ...blocks,
    {
      kind: "tool",
      toolUseId: event.toolUseId,
      tool: event.tool,
      description: event.description,
      input: event.input,
      output: null,
      truncated: false,
      isError: false,
    },
  ];
}

/** The `cli:tool-result` payload. */
export interface ToolResultEvent {
  toolUseId: string | null;
  output: string;
  truncated: boolean;
  isError: boolean;
}

/**
 * Attach a result to the call it belongs to.
 *
 * ── WHY MATCHING BY ID MATTERS ──
 *
 * Claude issues tool calls in PARALLEL. Two `Read`s dispatched together produce two results whose
 * arrival order is not the dispatch order, so "fill the first row still waiting" would routinely show
 * one file's contents under the other file's name. `tool_use_id` is the protocol's own correlation key
 * and it is what this uses.
 *
 * The positional fallback exists only for the case where the id is genuinely absent, and it is
 * deliberately the LAST unfilled row rather than the first: with no id there is nothing to correlate on,
 * and the most recently dispatched call is the likeliest owner of the next result.
 *
 * An unmatchable result returns the array UNCHANGED — no invented row. That happens legitimately: a
 * result can land for a call the per-turn cap dropped, and appending it on its own would show output
 * with no command above it.
 */
export function applyToolResult(
  blocks: TranscriptBlock[],
  event: ToolResultEvent
): TranscriptBlock[] {
  let index = -1;
  if (event.toolUseId !== null) {
    index = blocks.findIndex(
      (b) => b.kind === "tool" && b.toolUseId === event.toolUseId && b.output === null
    );
  }
  if (index === -1 && event.toolUseId === null) {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const b = blocks[i];
      if (b.kind === "tool" && b.output === null) {
        index = i;
        break;
      }
    }
  }
  if (index === -1) return blocks;

  const target = blocks[index];
  if (target.kind !== "tool") return blocks;

  const next = blocks.slice();
  next[index] = {
    ...target,
    output: event.output,
    truncated: event.truncated,
    isError: event.isError,
  };
  return next;
}

/**
 * Drop the oldest retained turns once the map exceeds MAX_RETAINED_TURNS.
 *
 * Insertion order IS the turn order — these are added on completion, one per turn — so
 * `Object.keys` gives oldest-first for the string keys used here, and the excess is taken off the front.
 * Returns the SAME object when nothing needs pruning so a completion under the ceiling costs no
 * re-render of anything that reads it.
 */
export function pruneRetainedTurns<T>(
  retained: Record<string, T>,
  max = MAX_RETAINED_TURNS
): Record<string, T> {
  const keys = Object.keys(retained);
  if (keys.length <= max) return retained;
  const next: Record<string, T> = {};
  for (const key of keys.slice(keys.length - max)) next[key] = retained[key];
  return next;
}

/**
 * `38.9k`, as the status line shows it.
 *
 * ── THIS IS THE EXTENSION'S OWN FORMATTER, PORTED ──
 *
 * From `webview/index.js`, minified as `Xbe`:
 *
 *   `${e<1000 ? String(e) : `${(e/1000).toFixed(1)}k`} tokens`
 *
 * So: a bare integer below 1000, one decimal above it, and `k` for ever — the extension has NO megabyte
 * branch. One is added here rather than copied, because it is reachable in this product in a way it is
 * not there: a workshop turn that runs an agentic loop for fifteen minutes can pass a million output
 * tokens, and `1234.5k` is a worse thing to read than `1.2M`.
 *
 * The `999.95` hinge rather than a flat `1e6` is not decoration: `999_999 / 1000` rounds to `1000.0`, so
 * a naive threshold prints "1000.0k" — a number with more digits than the "1.0M" it should have become.
 *
 * The negative and non-finite guards exist because this reads a value that crossed an IPC boundary. It
 * arrives from `usage.output_tokens` and should always be a non-negative integer, but "should" is not a
 * check, and `NaN` would render as literal "NaN tokens" on screen.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  const thousands = n / 1000;
  if (thousands < 999.95) return `${thousands.toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * `9s` … `15m 28s` … `1h 05m 28s`.
 *
 * Zero-padded below the leading unit so the digits sit in fixed columns and do not shuffle as they tick.
 *
 * SECONDS SURVIVE INTO THE HOURS, which is the one judgement call here. `1h 05m` would be shorter, but
 * this string exists to answer "is this stuck" — and a number that only moves once a minute answers that
 * question wrongly for the other fifty-nine seconds.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${seconds}s`;
}

/**
 * The parenthetical of the status line: `(15m 28s · ↓ 38.9k tokens)`.
 *
 * THE TOKEN HALF IS OMITTED UNTIL THERE ARE TOKENS. `↓ 0 tokens` next to a rising clock reads as a
 * stalled turn — the precise misreading this line exists to prevent — and for the first few seconds of
 * every turn it is also simply true that none have arrived yet.
 */
export function formatStatusSuffix(elapsedMs: number, outputTokens: number): string {
  const elapsed = formatElapsed(elapsedMs);
  if (!outputTokens || outputTokens <= 0) return `(${elapsed})`;
  return `(${elapsed} · ↓ ${formatTokens(outputTokens)} tokens)`;
}
