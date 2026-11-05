import { describe, it, expect } from "vitest";
import {
  appendText,
  appendToolUse,
  applyToolResult,
  pruneRetainedTurns,
  formatTokens,
  formatElapsed,
  formatStatusSuffix,
  MAX_TOOL_BLOCKS_PER_TURN,
  MAX_RETAINED_TURNS,
  type TranscriptBlock,
} from "./transcript.js";

/**
 * THE TRANSCRIPT'S BLOCK ALGEBRA.
 *
 * ── WHY THESE FUNCTIONS EXIST SEPARATELY FROM AssistantChatView ──
 *
 * This package sets `environment: "node"` with no jsdom, so nothing here can be tested through a React
 * render. Extracting the parts that can be WRONG — result correlation, the memory caps, the two
 * formatters — is what makes them testable at all. AssistantChatView keeps only the wiring.
 *
 * ── THE FAILURE THIS FILE IS REALLY ABOUT ──
 *
 * `applyToolResult` matching by id rather than by position. Claude issues tool calls in PARALLEL, so two
 * `Read`s dispatched together produce results whose arrival order is NOT the dispatch order. Fill-the-first-
 * gap would routinely show one file's contents under the other file's name — a wrong transcript that looks
 * entirely plausible, which is the worst kind.
 */

const toolUse = (id: string | null, tool = "Bash") => ({
  toolUseId: id,
  tool,
  description: `run ${tool}`,
  input: `${tool.toLowerCase()} thing`,
});

const result = (id: string | null, output: string, over: Partial<{ truncated: boolean; isError: boolean }> = {}) => ({
  toolUseId: id,
  output,
  truncated: false,
  isError: false,
  ...over,
});

/** The tool blocks of a list, for asserting on outputs without indexing past notes. */
const tools = (blocks: TranscriptBlock[]) =>
  blocks.filter((b): b is Extract<TranscriptBlock, { kind: "tool" }> => b.kind === "tool");

describe("appendText — streamed tokens", () => {
  it("MERGES into the trailing text block rather than pushing a new one", () => {
    /**
     * THE ONE THAT MATTERS FOR PERFORMANCE. Tokens arrive a few characters at a time; pushing would build
     * an array of thousands of one-word blocks per turn and hand React thousands of siblings to
     * reconcile. Three appends must produce ONE block.
     */
    let blocks: TranscriptBlock[] = [];
    blocks = appendText(blocks, "Hel");
    blocks = appendText(blocks, "lo ");
    blocks = appendText(blocks, "world");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "text", text: "Hello world" });
  });

  it("starts a NEW block after a tool call, so the order survives", () => {
    // prose → tool → prose is the interleaving the whole layout exists to show. Merging across the tool
    // call would put the second paragraph inside the first and lose where the call happened.
    let blocks: TranscriptBlock[] = appendText([], "First, I will look.");
    blocks = appendToolUse(blocks, toolUse("t1"));
    blocks = appendText(blocks, "That worked.");

    expect(blocks.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    expect(blocks[0]).toEqual({ kind: "text", text: "First, I will look." });
    expect(blocks[2]).toEqual({ kind: "text", text: "That worked." });
  });

  it("returns the SAME array for an empty string", () => {
    // Reference identity, not just equality: these run inside setState updaters, and a new array for a
    // no-op delta would re-render the transcript for nothing.
    const blocks: TranscriptBlock[] = [{ kind: "text", text: "hi" }];

    expect(appendText(blocks, "")).toBe(blocks);
  });

  it("does not mutate the array it was given", () => {
    /**
     * ⚠ THE INPUT IS DELIBERATELY NON-EMPTY AND ALREADY HAS A TEXT TAIL, which is the case that would
     * actually mutate: the merge path has to rebuild the tail rather than push into it. An empty-input
     * version of this test would pass against a mutating implementation.
     */
    const original: TranscriptBlock[] = [{ kind: "text", text: "before" }];
    const snapshot = structuredClone(original);

    appendText(original, " after");

    expect(original).toEqual(snapshot);
  });
});

describe("applyToolResult — ⚠ correlation by id, not by position", () => {
  it("attaches a result to ITS OWN call when results arrive OUT OF ORDER", () => {
    /**
     * THE CENTRAL TEST. Two calls dispatched, the SECOND completes first. Fill-the-first-gap would put
     * b's output under a's name — and both rows would look perfectly normal.
     */
    let blocks: TranscriptBlock[] = [];
    blocks = appendToolUse(blocks, toolUse("call-a", "Read"));
    blocks = appendToolUse(blocks, toolUse("call-b", "Grep"));

    blocks = applyToolResult(blocks, result("call-b", "B OUTPUT"));

    const [a, b] = tools(blocks);
    expect(a.tool, "the first call must still be unfinished").toBe("Read");
    expect(a.output).toBeNull();
    expect(b.tool).toBe("Grep");
    expect(b.output).toBe("B OUTPUT");
  });

  it("then attaches the first call's result to the first call", () => {
    let blocks: TranscriptBlock[] = [];
    blocks = appendToolUse(blocks, toolUse("call-a", "Read"));
    blocks = appendToolUse(blocks, toolUse("call-b", "Grep"));
    blocks = applyToolResult(blocks, result("call-b", "B OUTPUT"));
    blocks = applyToolResult(blocks, result("call-a", "A OUTPUT"));

    expect(tools(blocks).map((t) => t.output)).toEqual(["A OUTPUT", "B OUTPUT"]);
  });

  it("carries `truncated` and `isError` through", () => {
    // Both drive visible copy — the "(output truncated)" disclosure and the red dot — so a dropped flag
    // is a transcript that lies about what happened.
    let blocks = appendToolUse([], toolUse("t1"));
    blocks = applyToolResult(blocks, result("t1", "boom", { truncated: true, isError: true }));

    const [only] = tools(blocks);
    expect(only.truncated).toBe(true);
    expect(only.isError).toBe(true);
  });

  it("keeps an EMPTY output distinct from no output at all", () => {
    /**
     * A successful `mv` or a grep that matched nothing returns "". That must land as a COMPLETED row with
     * an empty string, not stay `null` — `null` renders as "running…" for ever, so a `if (output)` guard
     * in the implementation would leave finished rows spinning.
     */
    let blocks = appendToolUse([], toolUse("t1"));
    blocks = applyToolResult(blocks, result("t1", ""));

    expect(tools(blocks)[0].output).toBe("");
  });

  it("returns the SAME array when the id matches nothing", () => {
    /**
     * Legitimately reachable: a result can arrive for a call the per-turn cap dropped. Appending it alone
     * would render output with no command above it; a new array reference would re-render the transcript
     * to display nothing new.
     */
    const blocks = appendToolUse([], toolUse("t1"));

    expect(applyToolResult(blocks, result("other", "x"))).toBe(blocks);
  });

  it("does not overwrite a call that ALREADY has its result", () => {
    // At-least-once delivery is the house assumption, so a duplicated frame must be idempotent rather
    // than replacing a good output with a repeat.
    let blocks = appendToolUse([], toolUse("t1"));
    blocks = applyToolResult(blocks, result("t1", "FIRST"));
    blocks = applyToolResult(blocks, result("t1", "SECOND"));

    expect(tools(blocks)[0].output).toBe("FIRST");
  });

  it("falls back to the LAST unfilled call when the id is absent", () => {
    /**
     * With no id there is nothing to correlate on, so the most recently dispatched call is the likeliest
     * owner. Asserting it is the LAST and not the first is the point — both are "a fallback", and only
     * one of them is the one implemented.
     */
    let blocks: TranscriptBlock[] = [];
    blocks = appendToolUse(blocks, toolUse(null, "Read"));
    blocks = appendToolUse(blocks, toolUse(null, "Grep"));
    blocks = applyToolResult(blocks, result(null, "OUT"));

    const [first, second] = tools(blocks);
    expect(first.output).toBeNull();
    expect(second.output).toBe("OUT");
  });

  it("⚠ an ID-BEARING result does NOT fall back to positional matching", () => {
    /**
     * THE SUBTLE ONE. If the fallback were reachable for a result that HAS an id, a mismatched id would
     * silently attach to whatever call happened to be open — reintroducing exactly the wrong-output-under-
     * the-wrong-name bug the id matching exists to prevent, but only in the mismatch case where nobody
     * would look.
     */
    const blocks = appendToolUse([], toolUse("t1"));

    expect(applyToolResult(blocks, result("MISMATCH", "x"))).toBe(blocks);
    expect(tools(blocks)[0].output).toBeNull();
  });

  it("does not mutate the array it was given", () => {
    const original = appendToolUse([], toolUse("t1"));
    const snapshot = structuredClone(original);

    applyToolResult(original, result("t1", "OUT"));

    expect(original).toEqual(snapshot);
  });
});

describe("the per-turn tool cap — a memory bound that REPORTS itself", () => {
  it(`records ${MAX_TOOL_BLOCKS_PER_TURN} tool calls`, () => {
    let blocks: TranscriptBlock[] = [];
    for (let i = 0; i < MAX_TOOL_BLOCKS_PER_TURN; i += 1) {
      blocks = appendToolUse(blocks, toolUse(`t${i}`));
    }

    expect(tools(blocks)).toHaveLength(MAX_TOOL_BLOCKS_PER_TURN);
    expect(blocks.some((b) => b.kind === "note"), "nothing dropped yet").toBe(false);
  });

  it("⚠ COUNTS the overflow instead of silently dropping it", () => {
    /**
     * THE ASSERTION THAT JUSTIFIES THE CAP. A transcript that quietly stopped listing tool calls is
     * indistinguishable from an assistant that stopped making them — which is the very "is it stuck?"
     * confusion this whole layout was built to answer. The note is how the UI can say which happened.
     */
    let blocks: TranscriptBlock[] = [];
    for (let i = 0; i < MAX_TOOL_BLOCKS_PER_TURN + 5; i += 1) {
      blocks = appendToolUse(blocks, toolUse(`t${i}`));
    }

    expect(tools(blocks)).toHaveLength(MAX_TOOL_BLOCKS_PER_TURN);
    const notes = blocks.filter((b) => b.kind === "note");
    expect(notes, "ONE accumulating note, not one per dropped call").toHaveLength(1);
    expect(notes[0]).toEqual({ kind: "note", hidden: 5 });
  });

  it("bounds the total block count, which is the actual point", () => {
    // 200 calls must not produce 200 rows of retained output. Tool blocks + one note, and nothing else.
    let blocks: TranscriptBlock[] = [];
    for (let i = 0; i < 200; i += 1) blocks = appendToolUse(blocks, toolUse(`t${i}`));

    expect(blocks).toHaveLength(MAX_TOOL_BLOCKS_PER_TURN + 1);
  });
});

describe("pruneRetainedTurns — the finished-turn ceiling", () => {
  const turns = (n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`msg-${i}`, i]));

  it("returns the SAME object when under the ceiling", () => {
    const under = turns(MAX_RETAINED_TURNS);

    expect(pruneRetainedTurns(under)).toBe(under);
  });

  it("keeps the NEWEST turns and drops the oldest", () => {
    /**
     * Direction matters and is easy to invert. Insertion order is turn order, so the excess comes off the
     * FRONT — dropping the newest would delete the turn the participant is looking at.
     */
    const over = turns(MAX_RETAINED_TURNS + 3);
    const pruned = pruneRetainedTurns(over);

    expect(Object.keys(pruned)).toHaveLength(MAX_RETAINED_TURNS);
    expect(pruned["msg-0"], "oldest dropped").toBeUndefined();
    expect(pruned["msg-2"]).toBeUndefined();
    expect(pruned[`msg-${MAX_RETAINED_TURNS + 2}`], "newest kept").toBeDefined();
  });

  it("does not mutate the object it was given", () => {
    const over = turns(MAX_RETAINED_TURNS + 1);

    pruneRetainedTurns(over);

    expect(Object.keys(over)).toHaveLength(MAX_RETAINED_TURNS + 1);
  });
});

describe("formatTokens — the extension's own formatter, ported", () => {
  it("prints a bare integer below 1000", () => {
    // The extension's `e<1000 ? String(e) : …`. "847 tokens", not "0.8k tokens".
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("prints one decimal and a k above 1000", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(38_900)).toBe("38.9k");
  });

  it("keeps the decimal at a round thousand, so the width does not jump", () => {
    // `2k` and `2.1k` differ in width; a string that resizes as the count rises drags the clock beside it
    // sideways once a second.
    expect(formatTokens(2000)).toBe("2.0k");
  });

  it("⚠ does not print 1000.0k at the megabyte boundary", () => {
    /**
     * THE OFF-BY-ROUNDING ONE. `999_999/1000` is 999.999, which `toFixed(1)` renders as "1000.0" — MORE
     * digits than the "1.0M" it should have become. A flat `n < 1e6` threshold has this bug and looks
     * correct.
     */
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(999_940)).toBe("999.9k");
  });

  it("prints M above a million", () => {
    // Reachable here in a way it is not in the extension: a fifteen-minute agentic turn passes a million
    // output tokens, and `1234.5k` is worse to read than `1.2M`.
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("survives a NaN or negative crossing the IPC boundary", () => {
    // `usage.output_tokens` should always be a non-negative integer, but "should" is not a check — and
    // NaN would render as the literal text "NaN tokens" on screen.
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("formatElapsed", () => {
  it("prints bare seconds below a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(9_400)).toBe("9s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("prints the reference status-line shape at minutes", () => {
    // "15m 28s" — from the reference status-line format.
    expect(formatElapsed(928_000)).toBe("15m 28s");
  });

  it("ZERO-PADS the seconds so the digits sit in fixed columns", () => {
    // `2m 5s` → `2m 05s`: unpadded, the text shifts sideways every time the seconds cross ten.
    expect(formatElapsed(125_000)).toBe("2m 05s");
  });

  it("keeps SECONDS once past an hour", () => {
    /**
     * The judgement call, asserted so it cannot be "tidied" away. `1h 05m` is shorter, but this string
     * exists to answer "is this stuck" — and a number that only moves once a minute answers that wrongly
     * for the other fifty-nine seconds.
     */
    expect(formatElapsed(3_928_000)).toBe("1h 05m 28s");
  });

  it("floors rather than rounds, so the clock never runs ahead", () => {
    // At 1.9s elapsed the honest answer is 1s. Rounding to 2s would show a number the turn has not
    // reached yet.
    expect(formatElapsed(1_900)).toBe("1s");
  });

  it("treats a negative elapsed as zero", () => {
    // Only reachable via a clock adjustment mid-turn, and "-3s" is a worse thing to show than "0s".
    expect(formatElapsed(-1000)).toBe("0s");
  });
});

describe("formatStatusSuffix — the reference status line, verbatim", () => {
  it("reproduces `(15m 28s · ↓ 38.9k tokens)` exactly", () => {
    /**
     * CHARACTER FOR CHARACTER, including the `↓` before the count, the `·` separator and the spaces
     * around it. This is quoted UI copy, so a "tidier" `-` or an ASCII arrow is a regression.
     */
    expect(formatStatusSuffix(928_000, 38_900)).toBe("(15m 28s · ↓ 38.9k tokens)");
  });

  it("⚠ OMITS the token clause until there are tokens", () => {
    /**
     * `↓ 0 tokens` beside a rising clock reads as a STALLED turn — the precise misreading this line exists
     * to prevent. For the first seconds of every turn it is also simply true that none have arrived.
     */
    expect(formatStatusSuffix(4_000, 0)).toBe("(4s)");
  });

  it("shows the clause as soon as ONE token lands", () => {
    // The boundary in the other direction: the clause must appear at 1, not wait for a thousand.
    expect(formatStatusSuffix(4_000, 1)).toBe("(4s · ↓ 1 tokens)");
  });

  it("omits the clause for a negative count rather than printing it", () => {
    // Defensive, same reason as formatTokens' guard: the value crossed an IPC boundary.
    expect(formatStatusSuffix(4_000, -3)).toBe("(4s)");
  });
});
