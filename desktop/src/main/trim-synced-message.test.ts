// ── ⚠ AN OVER-LONG REPLY MUST SYNC SHORTENED RATHER THAN NOT SYNC AT ALL ──────────────────────
//
// The AI service answers 400 "message too long" above MAX_SYNC_CONTENT (100,000) and does so on
// purpose — "rejected rather than truncated", because a server silently altering a transcript is
// worse than refusing it. The effect on the desktop was that a long agentic turn reached DynamoDB
// NOT AT ALL: local transcript intact, platform record absent, so facilitator dashboards
// under-counted precisely the longest pieces of work.
//
// The guarantee these assertions defend is narrow and absolute: whatever goes in, what comes out is
// within the ceiling. A trimmer that is usually under the limit leaves the original bug reachable on
// the inputs it did not anticipate.
import { describe, it, expect } from "vitest";
import {
  trimForSync,
  MAX_SYNCED_MESSAGE_CHARS,
  TRIM_HEAD_LINES,
  TRIM_TAIL_LINES,
} from "./trim-synced-message";

/** n lines, each padded so the total comfortably exceeds the ceiling. */
const lines = (n: number, text = "x") =>
  Array.from({ length: n }, (_, i) => `${text}${i}`.padEnd(30, "-")).join("\n");

describe("⚠ trimForSync", () => {
  it("leaves a normal reply completely untouched", () => {
    const short = "A normal answer.\nWith a couple of lines.";
    const r = trimForSync(short);
    expect(r.trimmed).toBe(false);
    expect(r.content).toBe(short);
    expect(r.removedChars).toBe(0);
  });

  it("leaves a reply exactly at the ceiling untouched", () => {
    const exact = "y".repeat(MAX_SYNCED_MESSAGE_CHARS);
    const r = trimForSync(exact);
    expect(r.trimmed).toBe(false);
    expect(r.content).toBe(exact);
  });

  it("keeps the first AND last lines, not just the beginning", () => {
    const body = lines(5000, "line");
    const r = trimForSync(body);

    expect(r.trimmed).toBe(true);
    // The opening survives...
    expect(r.content.startsWith("line0")).toBe(true);
    expect(r.content).toContain("line1");
    // ...and so does the conclusion, which is the part a reader usually wants.
    expect(r.content.trimEnd().endsWith("-")).toBe(true);
    expect(r.content).toContain("line4999");
  });

  it("says what was removed and where the full text still is", () => {
    const r = trimForSync(lines(5000, "line"));
    expect(r.content).toContain("trimmed for sync");
    expect(r.content).toContain("lines");
    // The marker must name the local transcript, or a reader cannot tell this from data loss.
    expect(r.content).toContain("local transcript");
    expect(r.removedLines).toBeGreaterThan(0);
    expect(r.removedChars).toBeGreaterThan(0);
  });

  /**
   * ⚠ THE CASE A LINE-BASED TRIM GETS WRONG. Minified output, a base64 blob or one-line JSON is a
   * SINGLE line of hundreds of thousands of characters. Keeping "the first 40 and last 60 lines" keeps
   * all of it, so the result would still exceed the limit and the sync would fail exactly as before —
   * while this function reported success.
   */
  it("trims a single enormous line, where line counting cannot help", () => {
    const oneLine = "z".repeat(MAX_SYNCED_MESSAGE_CHARS * 3);
    const r = trimForSync(oneLine);

    expect(r.trimmed).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(MAX_SYNCED_MESSAGE_CHARS);
    expect(r.content).toContain("trimmed for sync");
  });

  it("holds the ceiling even when the KEPT lines are individually huge", () => {
    // 100 lines of 5,000 chars each: within the line budget, far over the character budget.
    const fatLines = Array.from({ length: TRIM_HEAD_LINES + TRIM_TAIL_LINES + 20 }, () =>
      "q".repeat(5000)
    ).join("\n");
    const r = trimForSync(fatLines);

    expect(r.trimmed).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(MAX_SYNCED_MESSAGE_CHARS);
  });

  /** The invariant, asserted over a spread of shapes rather than one convenient example. */
  it("NEVER returns anything over the ceiling, for any shape of input", () => {
    const cases = [
      "",
      "short",
      lines(200_000, "l"),
      "w".repeat(MAX_SYNCED_MESSAGE_CHARS + 1),
      "w".repeat(MAX_SYNCED_MESSAGE_CHARS * 10),
      lines(5, "a".repeat(40_000)),
      ("mixed\n" + "m".repeat(80_000) + "\ntail").repeat(3),
      "\n".repeat(300_000),
    ];
    for (const input of cases) {
      const r = trimForSync(input);
      expect(
        r.content.length,
        `input of ${input.length} chars produced ${r.content.length}`
      ).toBeLessThanOrEqual(MAX_SYNCED_MESSAGE_CHARS);
    }
  });

  it("stays below the SERVER's limit with margin, not merely at it", () => {
    // services/ai/src/routes.ts rejects above 100,000. Equal limits on two independently
    // maintained numbers is the boundary failure the collaboration route's header describes.
    expect(MAX_SYNCED_MESSAGE_CHARS).toBeLessThan(100_000);
    expect(100_000 - MAX_SYNCED_MESSAGE_CHARS).toBeGreaterThanOrEqual(5_000);
  });

  it("tolerates a non-string without throwing on the sync path", () => {
    for (const junk of [null, undefined, 42, {}] as unknown[]) {
      expect(() => trimForSync(junk as string)).not.toThrow();
      expect(trimForSync(junk as string).trimmed).toBe(false);
    }
  });

  it("reports a removedChars figure consistent with what it dropped", () => {
    const body = lines(5000, "line");
    const r = trimForSync(body);
    expect(r.removedChars).toBeLessThan(body.length);
    // The kept text plus what it says it removed should account for roughly the original.
    expect(r.removedChars).toBeGreaterThan(body.length - r.content.length - 2000);
  });
});

// ── ⚠ THE MARKER MUST SURVIVE WHOLE, NOT JUST THE LENGTH LIMIT ─────────────────────────────────
//
// `sliceEnds` ends with a hard `slice(0, limit)` as a last resort. That guarantees the ceiling, but it
// also MASKS a budget miscalculation: an earlier version reserved a guessed 200 characters for a
// ~350-character marker, produced 90,135 against a 90,000 ceiling, and the hard cut silently absorbed
// it. Re-introducing that bug passed every length assertion.
//
// What the hard cut destroys is the tail of the notice — the sentence saying the full response is in
// the local transcript. A reader then sees a chopped message with no explanation, which is
// indistinguishable from data loss and is exactly what the marker exists to prevent. Asserting the
// marker is INTACT is what detects a budget that does not actually fit.
describe("⚠ the trim notice is never itself truncated", () => {
  const FULL_NOTICE = "local transcript";

  it("keeps the whole notice on the single-enormous-line path", () => {
    const r = trimForSync("z".repeat(MAX_SYNCED_MESSAGE_CHARS * 3));
    expect(r.content).toContain("trimmed for sync");
    expect(r.content, "the explanatory sentence must survive the cut").toContain(FULL_NOTICE);
    expect(r.content.length).toBeLessThanOrEqual(MAX_SYNCED_MESSAGE_CHARS);
  });

  it("keeps the whole notice when the kept lines are individually huge", () => {
    const fat = Array.from({ length: TRIM_HEAD_LINES + TRIM_TAIL_LINES + 20 }, () =>
      "q".repeat(5000)
    ).join("\n");
    const r = trimForSync(fat);
    expect(r.content).toContain(FULL_NOTICE);
    expect(r.content.length).toBeLessThanOrEqual(MAX_SYNCED_MESSAGE_CHARS);
  });

  it("keeps the whole notice across every oversized shape", () => {
    for (const input of [
      "w".repeat(MAX_SYNCED_MESSAGE_CHARS + 1),
      "w".repeat(MAX_SYNCED_MESSAGE_CHARS * 10),
      lines(5, "a".repeat(40_000)),
      "\n".repeat(300_000),
    ]) {
      const r = trimForSync(input);
      if (!r.trimmed) continue;
      expect(r.content, `notice lost for a ${input.length}-char input`).toContain(FULL_NOTICE);
    }
  });
});
