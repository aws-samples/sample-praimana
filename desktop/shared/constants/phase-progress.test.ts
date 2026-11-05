import { describe, it, expect } from "vitest";
import {
  MIN_FIRST_PHASE_WORDS,
  countWords,
  firstPhaseWordsRemaining,
  isPhaseNotesUnlocked,
} from "./phase-progress";

/**
 * ── THE FIRST PHASE GATES THE REST ─────────────────────────────────────────────────────────
 *
 * "make sure users will be able to move to build demo only when idea has notes like mininmum 100 words".
 *
 * The two tests that matter most are the DEADLOCK one (the first phase must never lock itself) and the
 * EMPTY PIPELINE one (a failed read must not lock everything). Both are ways this gate could stop a team
 * recording their work, which is a worse outcome than the gate not applying.
 */

const IDEATION = { order: 1, content: "" };
const BUILD = { order: 2, content: "" };
const DEMO = { order: 3, content: "" };

/** n words of filler, so the intent of each case is the COUNT and not the prose. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("countWords", () => {
  it("counts whitespace-separated runs", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords(words(100))).toBe(100);
  });

  it("treats blank, whitespace-only, null and undefined as zero", () => {
    for (const empty of ["", "   ", "\n\t ", null, undefined]) {
      expect(countWords(empty)).toBe(0);
    }
  });

  it("does not miscount newlines, tabs or runs of spaces as words", () => {
    // A team writes bullets, so multi-newline content is the normal case rather than the odd one.
    expect(countWords("- one\n- two\n\n- three")).toBe(6);
    expect(countWords("one    two\t\tthree")).toBe(3);
  });
});

describe("isPhaseNotesUnlocked", () => {
  it("⚠ ALWAYS unlocks the first phase — otherwise the gate is a deadlock", () => {
    // The single most important line in the module. The first phase is the one a team must write to
    // satisfy the gate, so locking it would leave them with nothing they are allowed to do.
    const phases = [IDEATION, BUILD, DEMO];
    expect(isPhaseNotesUnlocked(IDEATION, phases)).toBe(true);
  });

  it("locks the later phases while the first is under the floor", () => {
    const phases = [{ order: 1, content: words(MIN_FIRST_PHASE_WORDS - 1) }, BUILD, DEMO];
    expect(isPhaseNotesUnlocked(BUILD, phases)).toBe(false);
    expect(isPhaseNotesUnlocked(DEMO, phases)).toBe(false);
  });

  it("unlocks them the moment the floor is met, and stays open above it", () => {
    for (const n of [MIN_FIRST_PHASE_WORDS, MIN_FIRST_PHASE_WORDS + 1, 500]) {
      const phases = [{ order: 1, content: words(n) }, BUILD, DEMO];
      expect(isPhaseNotesUnlocked(BUILD, phases), `${n} words`).toBe(true);
      expect(isPhaseNotesUnlocked(DEMO, phases), `${n} words`).toBe(true);
    }
  });

  it("is EXACTLY at the boundary — one short is locked, exactly enough is open", () => {
    /**
     * Spelled out because an off-by-one here is invisible in use and infuriating: a team stares at a
     * counter reading the target next to a phase that is still locked.
     *
     * ⚠ DERIVED FROM THE CONSTANT, NOT HARDCODED. This test used to assert 99 and 100 literally, and the
     * threshold has already moved once (100 → 50). A boundary pinned to a figure has to be edited every
     * time the product changes its mind, which is how a test stops describing the rule and starts
     * describing its own history. The VALUE is pinned once, in the test below.
     */
    const short = [{ order: 1, content: words(MIN_FIRST_PHASE_WORDS - 1) }, BUILD];
    const exact = [{ order: 1, content: words(MIN_FIRST_PHASE_WORDS) }, BUILD];
    expect(isPhaseNotesUnlocked(BUILD, short)).toBe(false);
    expect(isPhaseNotesUnlocked(BUILD, exact)).toBe(true);
  });

  it("⚠ the threshold is 50 — pinned HERE and nowhere else", () => {
    /**
     * The one place the actual number is asserted, deliberately. Everything else in this suite and both
     * front-ends read `MIN_FIRST_PHASE_WORDS`, so changing the product rule is a one-line edit plus this
     * one expectation — and it cannot be changed SILENTLY, which is the point of pinning it at all.
     *
     * History: started at 100, then reduced to 50.
     */
    expect(MIN_FIRST_PHASE_WORDS).toBe(50);
  });

  it("⚠ unlocks EVERYTHING when the pipeline could not be read", () => {
    // `[]` means the load failed, not that the team failed a requirement. Locking on a network blip
    // would make this gate the reason a team cannot record their work.
    expect(isPhaseNotesUnlocked(BUILD, [])).toBe(true);
  });

  it("gates on `order`, not on array position or name", () => {
    // The array arrives from an API whose ordering is not part of any contract.
    const scrambled = [DEMO, BUILD, { order: 1, content: words(5) }];
    expect(isPhaseNotesUnlocked(BUILD, scrambled)).toBe(false);
    // And the lowest order is the one that gates, even when it is not 1.
    const startsAtTwo = [{ order: 2, content: words(120) }, { order: 5, content: "" }];
    expect(isPhaseNotesUnlocked(startsAtTwo[0], startsAtTwo)).toBe(true);
    expect(isPhaseNotesUnlocked(startsAtTwo[1], startsAtTwo)).toBe(true);
  });
});

describe("firstPhaseWordsRemaining", () => {
  it("counts down and floors at zero", () => {
    expect(firstPhaseWordsRemaining([{ order: 1, content: "" }])).toBe(MIN_FIRST_PHASE_WORDS);
    expect(firstPhaseWordsRemaining([{ order: 1, content: words(40) }])).toBe(
      MIN_FIRST_PHASE_WORDS - 40
    );
    expect(firstPhaseWordsRemaining([{ order: 1, content: words(1000) }])).toBe(0);
  });
});
