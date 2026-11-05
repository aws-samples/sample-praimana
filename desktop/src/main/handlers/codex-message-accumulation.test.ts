// ── ⚠ THE "DOUBLE MESSAGES" REPORT ───────────────────────────────────────────────────────
//
// The stored row that produced the report was recovered from the desktop database and it is the fixture for
// these tests. It showed FOUR messages concatenated with nothing between them:
//
//   1. "You approved session-wide repair … before I move to Q2."
//   2. "The audit accepted Q1 after the approved repair. …"      ← ran straight on from 1: "…Q2.The audit…"
//   3. "Select `Other` if none of these fit.\n\n**Q2** — Who is the customer…"
//   4. byte-identical to 3
//
// So there were two faults, and each has its own case below: no separator between whole messages, and a
// repeated whole message. `splitCodexLines` was RULED OUT as the cause of the repeat — it pops the trailing
// partial, so a line is never both returned and retained — which is why the dedupe lives here rather than
// there, and why it is expressed as "the same message arrived twice" rather than "the parser double-fed".

import { describe, it, expect } from "vitest";
import { appendCodexMessage, codexMessageAddition } from "./codex-events";

/** The two messages that ran together in the report, verbatim. */
const FIRST =
  "You approved session-wide repair for the missing human-turn markers. I’m applying that repair for " +
  "your Q1 reply, recording the answer, and writing it back into the stage file before I move to Q2.";
const SECOND =
  "The audit accepted Q1 after the approved repair. I’m updating the question file now, then I’ll log " +
  "and ask Q2.";
/** The block that appeared twice. Long, multi-line, and identical both times. */
const QUESTION =
  "Select `Other` if none of these fit.\n\n**Q2** — Who is the customer, and what pain are they " +
  "experiencing?\n\n1. **Internal team members** — ambiguity before implementation\n2. **External end " +
  "users** — user-facing\n\nReply with a number, or just tell me.";

describe("⚠ separate messages are separated", () => {
  it("does not butt one message against the next", () => {
    const out = appendCodexMessage(FIRST, SECOND);

    /**
     * ⚠ THE EXACT STRING FROM THE REPORT. Asserting "contains a newline somewhere" would pass for a
     * separator inserted in the wrong place; this pins the specific run-on the participant saw.
     */
    expect(out).not.toContain("move to Q2.The audit accepted");
    expect(out).toContain("move to Q2.\n\nThe audit accepted");
  });

  it("separates with a BLANK line, because the transcript renders markdown", () => {
    const out = appendCodexMessage("First.", "Second.");

    // A single "\n" is not a paragraph break in markdown — it would render as one run-on line anyway.
    expect(out).toBe("First.\n\nSecond.");
  });

  it("does not stack blank lines when a message already ends in one", () => {
    expect(appendCodexMessage("First.\n\n", "Second.")).toBe("First.\n\nSecond.");
  });

  it("keeps a message's own internal newlines intact", () => {
    const out = appendCodexMessage("Intro.", QUESTION);

    expect(out).toContain("fit.\n\n**Q2** —");
    expect(out.endsWith("Reply with a number, or just tell me.")).toBe(true);
  });

  it("leaves the first message alone and ignores empty ones", () => {
    expect(appendCodexMessage("", FIRST)).toBe(FIRST);
    expect(appendCodexMessage(FIRST, "")).toBe(FIRST);
  });
});

describe("⚠ a whole message repeated is dropped", () => {
  it("does not append a block identical to the one just added", () => {
    const once = appendCodexMessage("Working on it.", QUESTION);
    const twice = appendCodexMessage(once, QUESTION);

    expect(twice).toBe(once);
    /** The count is the actual complaint: the participant saw the question twice, not "some duplication". */
    expect(twice.split("**Q2**").length - 1, "the question appears once").toBe(1);
  });

  it("reproduces the reported turn end to end and yields ONE question", () => {
    // Exactly the four messages that were stored, in order, through the real accumulator.
    let out = "";
    for (const msg of [FIRST, SECOND, QUESTION, QUESTION]) out = appendCodexMessage(out, msg);

    expect(out.split("Who is the customer").length - 1, "asked once").toBe(1);
    expect(out).not.toContain("move to Q2.The audit");
    // And nothing was lost: all three distinct messages survive.
    expect(out).toContain("You approved session-wide repair");
    expect(out).toContain("The audit accepted Q1");
    expect(out).toContain("Reply with a number");
  });

  it("catches the repeat even when it is exactly the whole accumulation", () => {
    expect(appendCodexMessage(QUESTION, QUESTION)).toBe(QUESTION);
  });
});

describe("⚠ the dedupe is deliberately narrow", () => {
  /**
   * ⚠ A SHORT ECHO SURVIVES, and this is the guard on the whole idea. Suppressing "Done." because it was
   * said a moment ago would silently DELETE content to prevent a cosmetic repeat — the wrong trade. Only a
   * block long enough to be a message rather than an acknowledgement is treated as a duplicate emission.
   */
  it("keeps a short message that legitimately repeats", () => {
    const out = appendCodexMessage("Done.", "Done.");

    expect(out).toBe("Done.\n\nDone.");
  });

  /** Only the LAST message is compared, so a block from earlier in the turn can legitimately recur. */
  it("keeps a repeat that is not the most recent message", () => {
    let out = appendCodexMessage("", QUESTION);
    out = appendCodexMessage(out, "Thanks — noted. Here it is again for reference.");
    out = appendCodexMessage(out, QUESTION);

    expect(out.split("Who is the customer").length - 1, "not adjacent, so kept").toBe(2);
  });

  /** A near-miss is a different message, not a duplicate: one character apart must still append. */
  it("does not treat a nearly-identical block as a repeat", () => {
    const altered = QUESTION.replace("**Q2**", "**Q3**");
    const out = appendCodexMessage(QUESTION, altered);

    expect(out).toContain("**Q2**");
    expect(out).toContain("**Q3**");
  });
});

// ── ⚠ THE LIVE TRANSCRIPT AND THE SAVED ONE MUST AGREE ───────────────────────────────────
//
// ⚠ THE FIRST FIX ONLY REACHED THE DATABASE. `appendCodexMessage` returned the combined text, so the blank
// line went into `fullOutput` — while the stream handler sent `effect.text` straight to the renderer, which
// appended it raw. The transcript on screen therefore still ran the sentences together and only came out right
// after a reload, from the saved copy. Two sources of truth for the same turn.
//
// `codexMessageAddition` returns what the message ADDS, so the renderer and the database are handed the same
// bytes — and a duplicate, whose addition is empty, is never streamed either.
describe("⚠ the addition is what gets streamed", () => {
  it("carries the separator, so the renderer receives it too", () => {
    const addition = codexMessageAddition("First sentence.", "Second sentence.");

    expect(addition, "the separator travels WITH the text").toBe("\n\nSecond sentence.");
  });

  it("is the text alone for the first message of a turn", () => {
    expect(codexMessageAddition("", "Opening.")).toBe("Opening.");
  });

  /** An empty addition is the signal not to stream at all — the repeat never reaches the screen. */
  it("is empty for a duplicate", () => {
    expect(codexMessageAddition(QUESTION, QUESTION)).toBe("");
    expect(codexMessageAddition("Working.\n\n" + QUESTION, QUESTION)).toBe("");
  });

  /**
   * ⚠ CONCATENATING THE ADDITIONS MUST EQUAL THE ACCUMULATED STRING. This is the property that makes the two
   * copies identical: the renderer only ever sees additions, so if their sum differed from what was saved, the
   * screen and the database would disagree — which is the bug being fixed.
   */
  it("sums to exactly what the saved turn contains", () => {
    const messages = [FIRST, SECOND, QUESTION, QUESTION, "A short tail."];

    let streamed = "";
    let saved = "";
    for (const m of messages) {
      streamed += codexMessageAddition(saved, m);
      saved = appendCodexMessage(saved, m);
    }

    expect(streamed).toBe(saved);
  });

  /**
   * ⚠ AND THE SEPARATOR CANNOT RETROACTIVELY TRIM. The earlier version stripped trailing whitespace from the
   * accumulation before joining — impossible once the accumulation has already been sent, so a message that
   * ends in a newline gets a SHORTER separator instead of the previous text being edited.
   */
  it("never needs to edit text it has already streamed", () => {
    expect(codexMessageAddition("Ends in a newline.\n", "Next."), "one newline is enough").toBe("\nNext.");
    expect(codexMessageAddition("Already blank-lined.\n\n", "Next."), "no separator needed").toBe("Next.");

    // Either way the result still reads as two paragraphs.
    expect(appendCodexMessage("Ends in a newline.\n", "Next.")).toBe("Ends in a newline.\n\nNext.");
    expect(appendCodexMessage("Already blank-lined.\n\n", "Next.")).toBe("Already blank-lined.\n\nNext.");
  });
});
