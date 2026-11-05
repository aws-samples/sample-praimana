/**
 * ── PARSING CODEX'S JSONL EVENT STREAM ──
 *
 * THE CAUSE: `codex exec` was spawned WITHOUT `--json`, so it printed a human-formatted transcript and the
 * desktop forwarded raw stdout chunks — ANSI escapes, progress redraws and all — as one late blob. The flag
 * exists (`codex exec --help`), we simply never passed it.
 *
 * ⚠ AND CODEX'S SHAPE IS NOTHING LIKE CLAUDE'S, which is the part that made this more than a one-flag fix.
 * The existing JSON branch understands `{type:"assistant",message:{content:[…]}}` and `{type:"result"}`;
 * Codex emits none of those field names. Captured from the real CLI (0.146.1.322) rather than inferred:
 *
 *     {"type":"thread.started","thread_id":"019ff11f-61fc-77d1-b1da-85cf2f51d7f5"}
 *     {"type":"turn.started"}
 *     {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were …"}}
 *     {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello from Codex"}}
 *     {"type":"turn.completed","usage":{"input_tokens":13027,…,"output_tokens":61}}
 *
 * ── WHY THIS IS A SEPARATE, PURE MODULE ──
 *
 * It lived inside the spawn handler's closure, where it could not be tested: reaching it needs a real child
 * process, an Electron `event.sender`, and a live `codex` binary. The decisions that can actually be WRONG —
 * which events produce text, which errors are benign, how a split line is reassembled — are pure functions of
 * a string, so they belong where a test can call them.
 */

/** What the caller should do with one parsed line. */
export type CodexEffect =
  /** Append this to the transcript and stream it to the renderer. */
  | { kind: "text"; text: string }
  /**
   * Token counts for the turn, from Codex's own `turn.completed`.
   *
   * ⚠ `inputTokens` IS THE WHOLE PROMPT, not what the participant typed — a short reply on a long thread
   * reported 13,027 in the probe, because the context goes with it. Reported faithfully and labelled as
   * context where it is shown, rather than renamed into something it is not.
   */
  | {
      kind: "usage";
      inputTokens?: number;
      outputTokens: number;
      /**
       * ── ⚠ THE CACHE FIGURES ARE THE OPTIMISATION STORY ──────────────────────────────────
       *
       * `cachedInputTokens` is the part of the prompt Codex served from cache rather than re-reading, so
       * `cached / input` IS the saving — a real measured figure rather than a comparison against a
       * hypothetical. Without it "50% savings" could only ever be an estimate.
       *
       * `reasoningOutputTokens` is the share of the reply spent thinking rather than answering, which is the
       * other lever a participant can actually move (by asking a narrower question).
       */
      cachedInputTokens?: number;
      /**
       * Prompt tokens WRITTEN to the cache — a miss being populated for next time.
       *
       * ⚠ THIS IS WHAT DISTINGUISHES "NORMAL" FROM "FIXABLE", which is why it is captured at all. A first
       * turn caches nothing and writes a lot: full price, unavoidable, not a problem. A conversation that
       * keeps WRITING and never READS is one whose cache is being thrown away — a new thread per question, or
       * gaps long enough for it to expire. Without this figure both look identical: low `cachedInputTokens`.
       */
      cacheWriteInputTokens?: number;
      reasoningOutputTokens?: number;
    }
  /** A diagnostic worth logging but NOT worth showing as a turn failure. See `isBenignError`. */
  | { kind: "notice"; message: string }
  /**
   * The thread this turn belongs to, from `thread.started`.
   *
   * ⚠ THIS WAS BEING THROWN AWAY, AND IT IS THE ANSWER TO "why did my chat lose its context?".
   * `thread.started` was classified as `ignore` — recognised, nothing to render — so the id went in the bin.
   * Without it the only way to continue a conversation is `codex exec resume --last`, which resumes the most
   * recent thread IN THE DIRECTORY rather than the one belonging to the chat you have open. Stored per chat
   * session it becomes `resume <id>`: the right thread, across restarts and across several chats in one
   * project.
   */
  | { kind: "thread"; threadId: string }
  /**
   * ⚠ THE TURN FAILED, AND THIS IS WHAT WAS MISSING WHEN A TURN "JUST STOPPED".
   *
   * Codex reports a failed turn in two places and BOTH fell through to `ignore`, so the only trace a
   * participant got was the spinner disappearing:
   *
   *   {"type":"error","message":"Reconnecting... 1/5 (unexpected status 404 Not Found: The model … does
   *     not exist, url: https://bedrock-mantle…)"}
   *   {"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: …"}}
   *
   * (Captured from a real failing run, not inferred.) `turn.failed` is the one surfaced as a failure: it is
   * TERMINAL and authoritative, whereas the top-level `error` events are mostly the five retries on the way
   * there and carry the same text. Surfacing every one of them would put six identical warnings in the
   * transcript for a single fault.
   */
  | { kind: "failure"; message: string }
  /** A recognised event with nothing to render (turn.started, item.started, …). */
  | { kind: "ignore" }
  /** Not an event at all — a stray log line. The caller decides whether to show it. */
  | { kind: "unparsed"; line: string };

/**
 * Codex `item.completed` errors that are INFORMATIONAL, not failures.
 *
 * ⚠ THIS LIST EXISTS BECAUSE OF WHAT THE FIRST PROBE DID. A plain "say hello" turn emitted an `error` item —
 * "Skill descriptions were shortened to fit the 2% skills context budget" — and then completed perfectly. A
 * parser that mapped every `error` item to a turn failure would therefore have reported a working turn as
 * broken, which is a worse bug than the one being fixed.
 *
 * Matched on a substring rather than an exact string: the message embeds a percentage that will change.
 */
/**
 * ⚠ MATCH THE SHORTEST STABLE FRAGMENT, NOT THE SENTENCE. The two entries this list began with were
 * taken from the message Codex emitted at the time; Codex has since reworded it from "Skill
 * descriptions were SHORTENED to fit the 2% skills context budget" to "Exceeded skills context
 * budget. All skill descriptions were REMOVED and 35 additional skills were not included" — so the
 * original fragment stopped matching and a warning that used to be filtered started appearing in
 * participants' transcripts as though the turn had gone wrong.
 *
 * That is the same failure as the brittle vscode-parity assertion: pinning someone else's exact
 * prose. "skills context budget" is the part that carries the meaning and is least likely to be
 * rewritten; the surrounding sentence is not.
 */
const BENIGN_ERROR_FRAGMENTS = [
  /* Kept so a Codex that reverts to the older wording is still covered. */
  "Skill descriptions were shortened",
  "Disable unused skills",

  /* The current wording of the same condition, and the budget phrase both forms share. */
  "skills context budget",
  "skill descriptions were removed",

  /**
   * The participant's own ~/.codex/config.toml naming a key this Codex build no longer reads — a
   * deprecation notice about THEIR machine. Nothing the app or the workshop can act on, and the turn
   * completes normally.
   */
  "unrecognized configuration settings",

  /**
   * A model id with no bundled metadata, e.g. a Bedrock-backed build pointed at `openai.gpt-5.4`.
   * Codex says so and then runs with fallback metadata. Worth a log line, not a transcript entry:
   * a real model failure arrives as `turn.failed`, which is surfaced regardless.
   */
  "Model metadata for",
];

export function isBenignError(message: string): boolean {
  return BENIGN_ERROR_FRAGMENTS.some((f) => message.includes(f));
}

/**
 * Interpret ONE line of Codex JSONL.
 *
 * Unknown `type` values return `ignore` rather than `unparsed`: the CLI will add event kinds, and a future
 * `item.started` should be silently skipped, not printed as prose into the participant's transcript.
 */
export function parseCodexLine(line: string): CodexEffect {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { kind: "unparsed", line };
  }
  if (!obj || typeof obj !== "object") return { kind: "unparsed", line };

  const event = obj as Record<string, any>;
  if (typeof event.type !== "string") return { kind: "unparsed", line };

  /**
   * ⚠ SURFACED, NOT IGNORED — see the `thread` effect. The shape is the one a real probe of CLI 0.146.1.322
   * emitted: `{"type":"thread.started","thread_id":"019ff11f-…"}`.
   *
   * A missing or non-string id falls through to `ignore` rather than returning an empty thread: storing "" as
   * a thread id would make the next turn resume nothing and look exactly like the bug this fixes.
   */
  if (event.type === "thread.started" && typeof event.thread_id === "string" && event.thread_id) {
    return { kind: "thread", threadId: event.thread_id };
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, any>;

    if (item.type === "agent_message" && typeof item.text === "string") {
      /**
       * THE REPLY. Codex delivers a whole message per event rather than token deltas, so this is as granular
       * as its stream gets — a turn producing several messages still arrives progressively, which is the
       * difference the report was about.
       *
       * An EMPTY string returns `ignore`, not `text`: emitting "" would append nothing while still counting as
       * content, and `fullOutput` is what decides between a saved turn and "(No response received)".
       */
      return item.text ? { kind: "text", text: item.text } : { kind: "ignore" };
    }

    if (item.type === "error" && typeof item.message === "string") {
      return { kind: "notice", message: item.message };
    }

    // Any other item kind — reasoning, tool calls, file changes. Recognised, not rendered.
    return { kind: "ignore" };
  }

  /**
   * ⚠ TERMINAL FAILURE. Read from `error.message` — a nested object, unlike the top-level `error` event's
   * flat `message`, which is why one handler cannot serve both.
   */
  if (event.type === "turn.failed") {
    const message =
      event.error && typeof event.error === "object" && typeof event.error.message === "string"
        ? event.error.message
        : "";
    // A failure with no message still IS a failure: silence is the bug being fixed.
    return { kind: "failure", message: message || "The turn failed and Codex gave no reason." };
  }

  /**
   * A top-level error: the retries on the way to `turn.failed`, and the final restatement of it. Reported as
   * a NOTICE so it reaches the log and the raw stream without repeating itself in the transcript — the
   * `failure` above is what the participant is shown.
   *
   * ⚠ IT IS STILL CARRIED RATHER THAN DROPPED, because it is the fallback when a run dies WITHOUT a
   * `turn.failed`: the close handler uses the last one to explain an empty turn instead of showing nothing.
   */
  if (event.type === "error" && typeof event.message === "string" && event.message) {
    return { kind: "notice", message: event.message };
  }

  if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
    const usage = event.usage as Record<string, any>;
    const out = usage.output_tokens;
    if (typeof out !== "number" || out < 0) return { kind: "ignore" };

    /**
     * ⚠ INPUT IS OPTIONAL AND OUTPUT IS NOT, which mirrors what the CLI guarantees: a turn always reports
     * what it produced, and `input_tokens` is absent from some events. An absent input must stay absent
     * rather than becoming 0 — a real zero and "not reported" are different facts, and the portal's coverage
     * figure depends on telling them apart.
     */
    const count = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

    const input = count(usage.input_tokens);
    const cached = count(usage.cached_input_tokens);
    const cacheWrite = count(usage.cache_write_input_tokens);
    const reasoning = count(usage.reasoning_output_tokens);

    return {
      kind: "usage",
      outputTokens: out,
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
      ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
    };
  }

  return { kind: "ignore" };
}

/**
 * ── ⚠ CODEX SENDS WHOLE MESSAGES, SO THEY CANNOT BE GLUED TOGETHER ────────────────────────
 *
 * TWO faults produced that, and this function fixes both:
 *
 *   1. ⚠ NO SEPARATOR. The caller accumulated with `fullOutput += effect.text`, which is correct for
 *      Claude — whose stream is token DELTAS — and wrong for Codex, which delivers a COMPLETE message per
 *      `item.completed` event. This module's own comment says so. One real turn produced four messages,
 *      and concatenating them butted a full stop against the next capital letter.
 *
 *   2. ⚠ A REPEATED MESSAGE. In that same turn the final two messages were BYTE-IDENTICAL — the whole Q2
 *      block, twice. It is not our splitter: `splitCodexLines` pops the trailing partial, so no line is
 *      ever returned and retained. Codex emitted it twice.
 *
 * ⚠ WHY DEDUPING IS SAFE HERE AND WOULD NOT BE FOR CLAUDE. These are WHOLE messages, so an exact repeat is
 * a duplicate emission rather than content — a model does not usefully restate an identical multi-line
 * block immediately. Deltas are the opposite: "the" legitimately arrives many times in a row, and dropping
 * repeats would corrupt the text. So this lives on the Codex path only.
 *
 * ⚠ AND IT IS DELIBERATELY NARROW: only the message that arrived LAST, only when EXACTLY equal, and only
 * when long enough to be a block rather than an acknowledgement. A short legitimate echo ("Done.", "OK")
 * survives, because suppressing those would silently lose content to save a cosmetic repeat.
 */
const MIN_DEDUPE_LENGTH = 40;

/**
 * What this message ADDS to the turn so far — the separator included, or "" when it is a duplicate.
 *
 * ⚠ THE ADDITION AND NOT THE WHOLE STRING, AND THAT IS A FIX RATHER THAN A REFACTOR. The first version
 * returned the combined text, so only the SAVED turn gained the blank line: the stream handler sent
 * `effect.text` straight to the renderer, which appended it raw. The live transcript therefore still read
 * "…move to Q3.I've confirmed Q2 is still the pending answer" — reported, from a turn that was still
 * streaming — and only came out right after a reload, from the saved copy.
 *
 * Returning the addition means the renderer and the database are given the SAME bytes, so a duplicate is
 * also never streamed. `appendCodexMessage` below is now just `existing + addition`.
 */
export function codexMessageAddition(existing: string, text: string): string {
  if (!text) return "";
  if (!existing) return text;

  // The repeat observed in the wild: the new message is exactly what the accumulation already ends with.
  if (text.length >= MIN_DEDUPE_LENGTH && (existing === text || existing.endsWith(text))) {
    return "";
  }

  /**
   * A blank line, not a space: these are separate messages and the transcript renders markdown, where a
   * single newline does not break a paragraph.
   *
   * ⚠ THE SEPARATOR CANNOT TRIM THE ACCUMULATION ANY MORE, because the accumulation has already been sent to
   * the renderer and cannot be edited retroactively. So instead of stripping trailing whitespace from
   * `existing`, the separator is only as long as it needs to be — which keeps the two copies identical.
   */
  const alreadyBlankLine = /\n\s*\n$/.test(existing);
  if (alreadyBlankLine) return text;
  return existing.endsWith("\n") ? `\n${text}` : `\n\n${text}`;
}

/** The turn so far with `text` appended. Kept as the single description of the rule. */
export function appendCodexMessage(existing: string, text: string): string {
  return existing + codexMessageAddition(existing, text);
}

/**
 * Split a stdout chunk into complete lines, returning the trailing partial for the next chunk.
 *
 * ⚠ THE WHOLE REASON THIS IS NOT `chunk.split("\n")`. A chunk boundary can fall anywhere, including inside a
 * JSON object — so parsing every piece immediately would silently drop whichever event straddled the split.
 * The caller holds `rest` and prepends it next time.
 *
 * `\r?\n` because the same handler serves Windows.
 *
 * ⚠ MY FIRST REASON FOR THIS WAS WRONG, and a surviving mutation is what exposed it. I wrote that a trailing
 * CR would make `JSON.parse` throw — it does not: CR is whitespace to the JSON grammar, so splitting on `\n`
 * alone parses every event just fine, and no test could legitimately require the `\r?`.
 *
 * Where it DOES matter is the `unparsed` path. A stray log line is forwarded to the renderer AS TEXT, so a
 * retained CR lands in the participant's transcript — invisible in a diff, and a carriage return inside a
 * chat message moves the cursor to the start of the line in anything that honours it. That is the property
 * the test asserts, rather than the one I assumed.
 */
export function splitCodexLines(buffered: string): { lines: string[]; rest: string } {
  const parts = buffered.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
}
