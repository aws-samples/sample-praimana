import { describe, it, expect } from "vitest";
import { parseCodexLine, splitCodexLines, isBenignError } from "./codex-events.js";

/**
 * CODEX'S JSONL EVENT STREAM.
 *
 * ── THE CAUSE ──
 *
 * `codex exec` was spawned without `--json`, so it printed a human transcript and the desktop forwarded raw
 * stdout as one late blob. The flag was there all along.
 *
 * ⚠ AND THE SHAPE IS NOTHING LIKE CLAUDE'S, which is what made this more than a one-flag fix — the existing
 * JSON parser understands `{type:"assistant",message:{content:[…]}}` and would have silently ignored every
 * Codex event.
 *
 * ── ⚠ EVERY FIXTURE BELOW IS A REAL LINE, NOT AN INVENTED ONE ──
 *
 * Captured by running the CLI (0.146.1.322) against a scratch directory. That matters more than usual here:
 * `codex exec --help` documents the FLAG but not the SCHEMA, so a hand-written fixture would only have proved
 * the parser matches my guess. Two things the probe taught that I would not have guessed:
 *
 *   1. A plain "say hello" turn emits an `error` ITEM for a benign condition (a skills-budget warning) and
 *      then completes normally — so mapping every error item to a turn failure would report a working turn as
 *      broken.
 *   2. `agent_message` carries a WHOLE message, not token deltas. There is no finer granularity to render.
 */

/** Verbatim from the probe. */
const REAL = {
  threadStarted:
    '{"type":"thread.started","thread_id":"019ff11f-61fc-77d1-b1da-85cf2f51d7f5"}',
  turnStarted: '{"type":"turn.started"}',
  benignError:
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest."}}',
  message:
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello from Codex"}}',
  turnCompleted:
    '{"type":"turn.completed","usage":{"input_tokens":13027,"cached_input_tokens":6714,"cache_write_input_tokens":0,"output_tokens":61,"reasoning_output_tokens":51}}',
};

describe("the reply reaches the transcript", () => {
  it("⚠ extracts text from an agent_message — the whole point of the fix", () => {
    expect(parseCodexLine(REAL.message)).toEqual({ kind: "text", text: "Hello from Codex" });
  });

  it("streams each message as it arrives, so a multi-message turn is progressive", () => {
    /**
     * Codex has no token deltas, so per-message IS the granularity. Two messages must produce two text
     * effects rather than being buffered into one — which is the difference between a streaming turn and the
     * late blob that was reported.
     */
    const first = parseCodexLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"First. "}}'
    );
    const second = parseCodexLine(
      '{"type":"item.completed","item":{"type":"agent_message","text":"Second."}}'
    );
    expect([first, second]).toEqual([
      { kind: "text", text: "First. " },
      { kind: "text", text: "Second." },
    ]);
  });

  it("treats an EMPTY message as nothing rather than as content", () => {
    /**
     * `""` would append nothing while still being "content" to a naive caller — and `fullOutput` is what
     * decides between saving a turn and showing "(No response received)". Returning `ignore` keeps those two
     * questions answerable.
     */
    expect(
      parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":""}}')
    ).toEqual({ kind: "ignore" });
  });
});

describe("⚠ A BENIGN ERROR ITEM IS NOT A FAILED TURN", () => {
  it("recognises the skills-budget warning the real CLI emits on a normal turn", () => {
    /**
     * THE ASSERTION THAT STOPS THE WORST REGRESSION HERE. The probe's very first run — a plain "say hello" —
     * emitted this, and the turn then completed with a perfectly good reply. Treating it as a failure would
     * have made every Codex turn report an error.
     */
    const effect = parseCodexLine(REAL.benignError);
    expect(effect.kind).toBe("notice");
    expect(isBenignError((effect as { message: string }).message)).toBe(true);
  });

  it("still surfaces an UNRECOGNISED error as a notice, not silence", () => {
    // A real failure must reach the debug log and the raw stream even though it is not a turn-level error —
    // Codex's own `turn.completed` is the authority on whether a turn worked.
    const effect = parseCodexLine(
      '{"type":"item.completed","item":{"type":"error","message":"sandbox denied write to /etc"}}'
    );
    expect(effect).toEqual({ kind: "notice", message: "sandbox denied write to /etc" });
    expect(isBenignError("sandbox denied write to /etc")).toBe(false);
  });

  it("matches the benign message on a FRAGMENT, since it embeds a changing percentage", () => {
    // "the 2% skills context budget" — that number will change, and an exact-string match would then start
    // reporting the warning as a real error.
    expect(isBenignError("Skill descriptions were shortened to fit the 9% skills context budget.")).toBe(
      true
    );
  });
});

describe("the token counts", () => {
  /**
   * ⚠ BOTH COUNTS NOW, because they leave the machine. Output alone fed the composer's `↓ …k tokens`;
   * `inputTokens` was added so the PORTAL can report what a thread cost — input and output
   * tokens on the portal. Codex reports both in the same event, so nothing is estimated.
   */
  /**
   * ⚠ THE WHOLE BREAKDOWN, because the cache figure is what a savings statistic rests on. The
   * requirement: store the full input/output token breakdown for each message, so token optimisation can
   * be shown as statistics such as a 50% token saving. `cached_input_tokens` is measured by the CLI, so
   * `cached / input` is a
   * statement; without it the same claim could only be an estimate against a hypothetical prompt.
   *
   * The fixture is the real event, and note what it contains: 6,714 of 13,027 prompt tokens came from cache on
   * that turn — 52%.
   */
  it("reads the whole breakdown from turn.completed", () => {
    expect(parseCodexLine(REAL.turnCompleted)).toEqual({
      kind: "usage",
      inputTokens: 13027,
      cachedInputTokens: 6714,
      /* 0 on this turn, and a real zero is a MEASUREMENT — the cache was read, not written. */
      cacheWriteInputTokens: 0,
      outputTokens: 61,
      reasoningOutputTokens: 51,
    });
  });

  /** Each part is independent: a CLI that stops reporting one must not cost us the others. */
  it("keeps what was reported when parts of the breakdown are missing", () => {
    expect(
      parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}')
    ).toEqual({ kind: "usage", inputTokens: 100, outputTokens: 5 });

    expect(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5}}'
      )
    ).toEqual({ kind: "usage", inputTokens: 100, cachedInputTokens: 40, outputTokens: 5 });
  });

  /** An unusable cache figure is dropped, not zeroed — 0% saved and "not measured" mean opposite things. */
  it("omits an unusable cache figure", () => {
    for (const bad of ['"40"', "null", "-1"]) {
      const effect = parseCodexLine(
        `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":${bad},"output_tokens":5}}`
      );
      expect(effect, bad).not.toHaveProperty("cachedInputTokens");
    }
  });

  /**
   * ⚠ AN ABSENT INPUT COUNT STAYS ABSENT, never 0. The portal reports coverage over exactly this
   * difference, and a fabricated zero would be counted as a measurement — the one thing the service's
   * "no invented metrics" rule forbids.
   */
  it("omits an input count that was not reported", () => {
    const effect = parseCodexLine('{"type":"turn.completed","usage":{"output_tokens":7}}');

    expect(effect).toEqual({ kind: "usage", outputTokens: 7 });
    expect(effect, "no key at all, not a zero").not.toHaveProperty("inputTokens");
  });

  it("omits an unusable input count while keeping the output", () => {
    for (const bad of ['"13027"', "null", "-1"]) {
      const effect = parseCodexLine(
        `{"type":"turn.completed","usage":{"input_tokens":${bad},"output_tokens":7}}`
      );
      expect(effect, bad).toEqual({ kind: "usage", outputTokens: 7 });
    }
  });

  /** A real zero is a measurement and must survive — the distinction the omission above depends on. */
  it("keeps a genuine zero", () => {
    expect(
      parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}')
    ).toEqual({ kind: "usage", inputTokens: 0, outputTokens: 0 });
  });

  it("ignores a turn.completed with no usage", () => {
    expect(parseCodexLine('{"type":"turn.completed"}')).toEqual({ kind: "ignore" });
  });

  it("ignores a non-numeric or negative count rather than rendering it", () => {
    // This crosses a process boundary and lands in a `↓ …k tokens` string; `NaN` or a negative would print.
    for (const bad of ['"61"', "null", "-5"]) {
      expect(
        parseCodexLine(`{"type":"turn.completed","usage":{"output_tokens":${bad}}}`)
      ).toEqual({ kind: "ignore" });
    }
  });
});

describe("events with nothing to render", () => {
  /**
   * ⚠ `thread.started` IS NO LONGER IGNORED, AND THAT WAS THE BUG. Its `thread_id` was being discarded, so
   * the only way to continue a conversation was `codex exec resume --last` — the most recent thread in the
   * DIRECTORY rather than the one belonging to the open chat, and nothing at all after a restart, so a Codex
   * chat lost its earlier context across a restart.
   */
  it("surfaces the thread id from thread.started", () => {
    expect(
      parseCodexLine('{"type":"thread.started","thread_id":"019ff11f-61fc-77d1-b1da-85cf2f51d7f5"}')
    ).toEqual({ kind: "thread", threadId: "019ff11f-61fc-77d1-b1da-85cf2f51d7f5" });
  });

  /**
   * A missing or empty id falls back to `ignore` rather than reporting an empty thread: storing "" would
   * make the next turn resume nothing and fail exactly like the bug this fixes, but silently.
   */
  it.each([
    '{"type":"thread.started"}',
    '{"type":"thread.started","thread_id":""}',
    '{"type":"thread.started","thread_id":123}',
  ])("ignores a thread.started with no usable id: %s", (line) => {
    expect(parseCodexLine(line)).toEqual({ kind: "ignore" });
  });

  it("still ignores turn.started, which carries nothing to render", () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual({ kind: "ignore" });
  });

  it("⚠ IGNORES an unknown event type rather than printing it as prose", () => {
    /**
     * Forward compatibility, and it is the difference between a quiet upgrade and a corrupted transcript. The
     * CLI will add event kinds — `item.started`, `reasoning`, whatever comes next — and a parser that fell
     * through to "show it as text" would dump raw JSON into the participant's chat the day that happens.
     */
    expect(parseCodexLine('{"type":"item.started","item":{"type":"agent_message"}}')).toEqual({
      kind: "ignore",
    });
    expect(parseCodexLine('{"type":"something.brand.new","payload":{"a":1}}')).toEqual({
      kind: "ignore",
    });
  });

  it("ignores an item kind it does not render", () => {
    // Reasoning, tool calls, file changes — recognised structure, no transcript contribution.
    expect(
      parseCodexLine('{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}')
    ).toEqual({ kind: "ignore" });
  });
});

describe("a line that is not an event at all", () => {
  it("reports it as unparsed so the caller can still show it", () => {
    /**
     * A login prompt or a sandbox refusal on stdout is more likely to be something the participant MUST read
     * than noise, and the alternative is a silent turn. So it is surfaced rather than swallowed — but flagged,
     * so the caller knows it was not structured output.
     */
    expect(parseCodexLine("Reading additional input from stdin...")).toEqual({
      kind: "unparsed",
      line: "Reading additional input from stdin...",
    });
  });

  it("treats valid JSON that is not an event as unparsed", () => {
    // A bare array or a string is syntactically fine and semantically meaningless here.
    expect(parseCodexLine("[1,2,3]").kind).toBe("unparsed");
    expect(parseCodexLine('"hello"').kind).toBe("unparsed");
    expect(parseCodexLine("null").kind).toBe("unparsed");
  });

  it("treats an object with no `type` as unparsed", () => {
    expect(parseCodexLine('{"item":{"type":"agent_message","text":"x"}}').kind).toBe("unparsed");
  });
});

describe("⚠ SPLITTING A CHUNKED STREAM", () => {
  it("holds back a trailing PARTIAL line", () => {
    /**
     * THE BUG THIS PREVENTS. A chunk boundary can fall inside a JSON object, so parsing everything a chunk
     * contains would drop whichever event straddled the split — silently, since a half-object simply fails to
     * parse. The caller keeps `rest` and prepends it next time.
     */
    const { lines, rest } = splitCodexLines(
      `${REAL.turnStarted}\n{"type":"item.completed","item":{"type":"agent_mess`
    );
    expect(lines).toEqual([REAL.turnStarted]);
    expect(rest).toBe('{"type":"item.completed","item":{"type":"agent_mess');
  });

  it("reassembles across two chunks", () => {
    // The end-to-end property: a message split down the middle must still parse once both halves arrive.
    const first = splitCodexLines('{"type":"item.completed","item":{"type":"agent_mes');
    expect(first.lines).toEqual([]);

    const second = splitCodexLines(`${first.rest}sage","text":"Hello"}}\n`);
    expect(second.lines).toHaveLength(1);
    expect(parseCodexLine(second.lines[0])).toEqual({ kind: "text", text: "Hello" });
  });

  it("⚠ strips CR, which matters for UNPARSED lines rather than for parsing", () => {
    /**
     * ⚠ THE REASON I ORIGINALLY GAVE FOR THIS WAS WRONG, and a surviving mutation proved it: splitting on
     * `\n` alone parses every event perfectly, because a trailing CR is whitespace to the JSON grammar. No
     * assertion about `parseCodexLine` could ever have required the `\r?`.
     *
     * Where it genuinely matters is a line that is NOT an event: those are forwarded to the renderer as text,
     * so a retained CR ends up in the participant's transcript. This asserts that — the property that is
     * actually true — instead of the one I assumed.
     */
    const { lines } = splitCodexLines("Reading additional input from stdin...\r\nmore\r\n");
    expect(lines).toEqual(["Reading additional input from stdin...", "more"]);
    for (const line of lines) expect(line).not.toContain("\r");

    // And events still parse either way, which is the part that was never at risk.
    const events = splitCodexLines(`${REAL.message}\r\n${REAL.turnCompleted}\r\n`);
    expect(events.lines.map((l) => parseCodexLine(l).kind)).toEqual(["text", "usage"]);
  });

  it("drops blank lines", () => {
    const { lines } = splitCodexLines(`${REAL.turnStarted}\n\n   \n${REAL.message}\n`);
    expect(lines).toHaveLength(2);
  });

  it("returns an empty rest when the chunk ends on a newline", () => {
    // Otherwise the next chunk would be prefixed with a stale empty string, which is harmless but makes the
    // buffer's contents a lie.
    expect(splitCodexLines(`${REAL.turnStarted}\n`).rest).toBe("");
  });
});

describe("the whole probe transcript, in order", () => {
  it("⚠ produces exactly the reply and the token count", () => {
    /**
     * END TO END against the real session, which is the test that would have caught the original bug: feed the
     * five lines the CLI actually emitted and assert what the transcript gets. Before the fix this sequence
     * produced no `text` at all, because none of these event types existed in the parser.
     */
    const stream = [
      REAL.threadStarted,
      REAL.turnStarted,
      REAL.benignError,
      REAL.message,
      REAL.turnCompleted,
    ];

    const effects = stream.map(parseCodexLine);
    const text = effects
      .filter((e): e is { kind: "text"; text: string } => e.kind === "text")
      .map((e) => e.text)
      .join("");
    const usage = effects.find((e) => e.kind === "usage");

    expect(text, "the reply, and nothing else").toBe("Hello from Codex");
    /* Both counts, as the real event carries them — they now leave the machine for the portal. */
    expect(usage).toEqual({
      kind: "usage",
      inputTokens: 13027,
      cachedInputTokens: 6714,
      cacheWriteInputTokens: 0,
      outputTokens: 61,
      reasoningOutputTokens: 51,
    });
    expect(
      effects.filter((e) => e.kind === "unparsed"),
      "no real event should fall through as prose"
    ).toEqual([]);
  });
});

// ── ⚠ THE READ/WRITE PAIR IS THE WHOLE POINT ─────────────────────────────────────────────
//
// `cachedInputTokens` alone cannot answer "is this fixable?". A first turn writes the cache and reads nothing —
// full price, unavoidable. A conversation that keeps WRITING and never READS is throwing its cache away, which
// a participant can fix by staying in one thread. Both show a low read figure; only the write figure separates
// them, which is why it is captured and reported alongside rather than netted into one number.
describe("⚠ cache reads and writes are reported separately", () => {
  const usage = (u: string) => parseCodexLine(`{"type":"turn.completed","usage":{${u}}}`);

  it("distinguishes a first turn from a discarded cache", () => {
    const first = usage('"input_tokens":8000,"cached_input_tokens":0,"cache_write_input_tokens":8000,"output_tokens":50');
    const discarding = usage('"input_tokens":8000,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":50');

    expect(first).toMatchObject({ cachedInputTokens: 0, cacheWriteInputTokens: 8000 });
    expect(discarding).toMatchObject({ cachedInputTokens: 0, cacheWriteInputTokens: 0 });
    /* Identical on the read figure — which is exactly why the write figure had to be captured. */
    expect(first).toMatchObject({ cachedInputTokens: 0 });
    expect(discarding).toMatchObject({ cachedInputTokens: 0 });
  });

  it("omits an unusable write figure rather than zeroing it", () => {
    for (const bad of ['"8000"', "null", "-1"]) {
      const e = usage(`"input_tokens":8000,"cache_write_input_tokens":${bad},"output_tokens":5`);
      expect(e, bad).not.toHaveProperty("cacheWriteInputTokens");
    }
  });
});

// ── ⚠ THE FOUR NOTICES A REAL RUN PRODUCED, CAPTURED VERBATIM ──────────────────────────────────
//
// A plain turn emitted FOUR `error` items before the answer, none of them a failure — the turn
// completed normally with `agent_message: "OK"`. Every one reached the transcript, so the participant saw
// four warnings wrapped around one word.
//
// ⚠ THE FILTER HAD GONE STALE, which is the actual defect. BENIGN_ERROR_FRAGMENTS matched
// "Skill descriptions were shortened"; Codex now says "All skill descriptions were removed". Upstream
// reworded its own message and the substring stopped matching — the same brittleness as pinning
// another project's CSS string. These strings are pasted from the real run, not paraphrased, so a
// future rewording fails HERE rather than in front of a participant.
describe("⚠ benign Codex notices from a real run", () => {
  const CAPTURED = [
    "Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n  session-flags: `commit_attribution` is ignored.\n  user (/Users/x/.codex/config.toml): `commit_attribution` is ignored.",
    "Model metadata for `openai.gpt-5.4` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
    "Exceeded skills context budget. All skill descriptions were removed and 35 additional skills were not included in the model-visible skills list.",
  ];

  for (const message of CAPTURED) {
    it(`treats as benign: ${message.slice(0, 52)}…`, () => {
      expect(isBenignError(message)).toBe(true);
    });
  }

  it("still covers the ORIGINAL wording, so an older Codex is not regressed", () => {
    expect(isBenignError("Skill descriptions were shortened to fit the 2% skills context budget")).toBe(true);
    expect(isBenignError("Disable unused skills to free budget")).toBe(true);
  });

  /**
   * ⚠ THE ASSERTION THAT KEEPS THIS LIST HONEST. Widening it until everything is benign would hide
   * the failures it exists to distinguish from — a turn that really broke must still read as broken.
   */
  it("does NOT swallow a real failure", () => {
    for (const real of [
      "unexpected status 404 Not Found: The model does not exist, url: https://bedrock-mantle…",
      "Reconnecting... 1/5 (unexpected status 500)",
      "authentication failed",
      "rate limit exceeded",
      "",
    ]) {
      expect(isBenignError(real), `${real} must not be treated as benign`).toBe(false);
    }
  });

  it("the answer itself is still rendered as text, not swallowed with the notices", () => {
    const effect = parseCodexLine(
      '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"OK"}}'
    );
    expect(effect).toEqual({ kind: "text", text: "OK" });
  });
});
