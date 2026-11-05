import { describe, it, expect } from "vitest";
import { join } from "path";
import { sourceWithoutComments } from "./source-under-test";

/**
 * ── THE BUILD PHASE MUST NOT CLAIM TO BE EMPTY ─────────────────────────────────────────────
 *
 * REPORTED: "build still shows empty even when the files are uploaded".
 *
 * It did. The badge is derived from `phase.content`, the phase's NOTES, while a team's FILES live in
 * the docs store and are fetched by a separate request that fires only when the row is expanded. So
 * uploading a document never touched `content`, and Build read "• empty" however many files it held.
 *
 * ⚠ WORST ON BUILD SPECIFICALLY, because Build is the one phase whose DELIVERABLE IS THE FILES: the
 * badge contradicted the document panel rendered directly beneath it. Saying nothing is strictly better
 * than saying something false.
 *
 * ── WHY SOURCE ASSERTIONS ──
 *
 * This package's vitest is `environment: "node"` with no jsdom, so a render test is not available (see
 * vitest.config.ts). The convention here and in the desktop's `phases-view.test.ts` is to assert the
 * rules that would silently regress against the source. This one qualifies: re-adding an unconditional
 * "• empty" is a one-character change that reintroduces a bug a user reported, and nothing else would
 * catch it.
 */

const SRC = join(
  __dirname,
  "..",
  "app",
  "w",
  "[workshopId]",
  "t",
  "[teamId]",
  "phases",
  "page.tsx"
);
/**
 * ⚠ COMMENTS STRIPPED, AND THE FIRST DRAFT OF THIS FILE PROVES WHY. The `not.toContain("• files")`
 * assertion below FAILED on a correct page, because the comment recording that the label had been
 * removed contains the label's own text. A source assertion that prose can satisfy, or break, is not
 * an assertion about the code. See `source-under-test.ts`.
 */
const src = sourceWithoutComments(SRC);

describe("the phases page's collapsed-row badges", () => {
  it("⚠ HAS NO '• empty' LABEL AT ALL, for any phase", () => {
    /**
     * The first fix suppressed this on Build alone, the row where it was demonstrably false. The
     * follow-up request was "totally avoid the labels empty", and the broader answer is the better one:
     * NO phase's emptiness is knowable from `content`. A team can have chat, tasks, commits and
     * documents against a phase whose notes field nobody typed into, so "empty" was wrong there too.
     * Build was simply where it was most obviously wrong.
     */
    /**
     * ⚠ ASSERTED ON THE LABEL, NOT THE WORD. The first draft was `not.toContain("empty")` and it FAILED
     * on a correct page, because `PhaseNoteBody`'s legitimate `emptyNote` prop contains the substring.
     * A test that cannot distinguish a rendered label from an identifier is not testing the label.
     */
    expect(src).not.toContain("• empty");
  });

  it("no longer renders the '• files' hint", () => {
    /**
     * Removed at the same request. It existed because the Code tab was deleted and a collapsed row gave
     * no clue the documents were inside, but it sat beside "• empty" and the pair read as a direct
     * contradiction on the one row where the files actually are.
     */
    expect(src).not.toContain("• files");
  });

  it("has no NOTES badge either, the third and final pass", () => {
    /**
     * "remove has notes stuff". Each earlier fix was right and too small: the problem was the badge
     * itself, using `content` (did somebody type in the notes box) to summarise a whole phase.
     */
    expect(src).not.toContain("has notes");
  });

  it("KEEPS the progression signals, which come from a different source than `content`", () => {
    /**
     * `currentPhaseOrder` on the workshop, not the notes field. Removing the content badge must not take
     * these with it.
     *
     * ⚠ THE "Completed" PILL IS GONE BY REQUEST ("pleae remove completed on phases"), the ✓ marker says
     * it in a SHAPE rather than a colour, so the word was a second telling. "Current" stays because it
     * has no marker of its own: without it, the live phase and an upcoming one differ only by hue.
     */
    expect(src).toContain(">Current<");
    expect(src).toContain('isCompleted ? "✓"');
  });

  it("still attaches the file panel to exactly the build phase", () => {
    // `buildPhaseId` is no longer used for the badge, so this is what it is still FOR. If the last
    // reference were removed with the label, the documents would become unreachable, there is no Code
    // tab any more.
    expect(src).toMatch(/phase\.id === buildPhaseId[\s\S]{0,400}<PhaseArtifacts/);
  });
});
