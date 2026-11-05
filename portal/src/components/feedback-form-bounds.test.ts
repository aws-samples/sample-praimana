// ── ⚠ A FORM WITH A *MINIMUM* OWES THE REPORTER MORE THAN A FORM WITH ONLY A MAXIMUM ─────────
//
// Word limits on feedback and bug reports, with a subject input as well. ONE rule for both kinds:
// subject 5–15 words, description 20–200 words.
//
// A ceiling is discoverable, you type until it stops you. A FLOOR is not: nothing about an empty box says
// "this will be refused unless you write twenty words", so the default implementation of a minimum is a
// reporter writing a sentence, pressing Send, and being told it was not enough. That is friction accepted
// for a reason (one-line reports cost a triager a round trip), and the cost is only bearable if the
// form is honest UP FRONT.
//
// So these are not tests about the numbers, `shared/constants/support.test.ts` owns those, and
// derives them from the constant. These are tests that the two forms behave like forms with a floor:
//
//   · the requirement is rendered next to the field, before anything is typed;
//   · the counter counts UP TO the floor, so progress is visible instead of only failure;
//   · Send is disabled by the SHARED verdict, and says why;
//   · nothing is truncated to fit.
//
// ⚠ AND BOTH SURFACES ARE CHECKED IN ONE FILE ON PURPOSE. The portal dialog and the desktop panel are
// separate components that were built separately, and the failure to catch is one of them being fixed while
// the other keeps springing the floor on Send.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  FEEDBACK_MESSAGE_BOUNDS,
  FEEDBACK_SUBJECT_BOUNDS,
  checkFeedbackReport,
  feedbackWordHint,
} from "@praimana/shared";
import { sourceWithoutComments } from "@/lib/source-under-test";
import {
  readSiblingRepoSource,
  siblingRepoPresent,
} from "@/lib/sibling-repo-source";

/**
 * ⚠ COMMENTS STRIPPED, and that is not tidiness. Two of my own source assertions have already passed on a
 * COMMENT that quoted the thing being asserted rather than on the code, `rel="noreferrer noopener"` and
 * "• files". A file whose header explains the word floor at length would satisfy every check below while the
 * form sprang it on Send.
 */
const read = (...parts: string[]) => sourceWithoutComments(join(...parts));

const HERE = __dirname;

/**
 * ⚠ THE DESKTOP PANEL IS IN ANOTHER REPO, so it is checked WHEN REACHABLE and reported as a todo when it
 * is not, see `lib/sibling-repo-source.ts` for why that is the least bad of three bad options, and for the
 * env var that points at a checkout in a different layout.
 *
 * The point of asserting both surfaces in one file survives the split intact: the failure to catch is one of
 * the two forms being fixed while the other keeps springing the floor on Send, and that is still a single
 * agreement even though it now spans two repositories.
 */
const DESKTOP_PANEL_PRESENT = siblingRepoPresent("desktop");

const SURFACES = [
  {
    name: "the portal dialog",
    src: read(HERE, "FeedbackDialog.tsx"),
  },
  ...(DESKTOP_PANEL_PRESENT
    ? [
        {
          name: "the desktop panel",
          src: readSiblingRepoSource(
            "desktop",
            "src",
            "renderer",
            "components",
            "AccountPanel.tsx"
          ),
        },
      ]
    : []),
];

// Never a silent omission: with no desktop checkout the summary carries a todo naming what went unchecked.
describe.skipIf(DESKTOP_PANEL_PRESENT)("the desktop panel", () => {
  it.todo(
    "is checked for the same word floor when the desktop repo is checked out beside this one (or AIAP_DESKTOP_REPO is set)"
  );
});

describe.each(SURFACES)("$name", ({ src }) => {
  it("sends a SUBJECT as well as a message", () => {
    // The field exists and its value is actually submitted. A subject input whose state never reaches the
    // mutation would render, count words, and post nothing, and the inbox heading would stay empty.
    expect(src).toMatch(/setSubject\(/);
    expect(src).toMatch(/\bsubject,/);
  });

  it("⚠ decides Send from the SHARED verdict, not its own word count", () => {
    /**
     * The regression: a form that counts words its own way. It disagrees with the API by one word eventually,
     * and the reporter is the one who finds out, after writing. `checkFeedbackReport` is the same function
     * the BFF, the desktop's main process and the identity route call.
     */
    expect(src).toMatch(/checkFeedbackReport\(/);
    expect(src, "Send is gated on that verdict").toMatch(/disabled=\{[^}]*problem/);
    // And NOT on a hand-rolled emptiness check, which is what it used to be gated on.
    expect(src, "no bespoke gate alongside the shared one").not.toMatch(
      /disabled=\{[^}]*\.trim\(\) === ""/
    );
  });

  it("⚠ states the requirement BEFORE anything is typed", () => {
    // Rendered from the bounds, unconditionally, not inside an `error &&` branch that only appears after a
    // failed Send. This is the single most important line in the file.
    expect(src).toMatch(/minWords\}–\{maxWords\} words/);
  });

  it("⚠ shows a live count, via the shared hint", () => {
    expect(src).toMatch(/feedbackWordHint\(/);
    // On BOTH fields: a counter on only the description leaves the 5-word subject floor unexplained.
    expect(src.match(/<FieldHint\b/g) ?? []).toHaveLength(2);
  });

  it("⚠ names the reason Send is disabled", () => {
    // A greyed-out button with no explanation is the version of this that generates a support request about
    // the support form.
    expect(src).toMatch(/problem\.message/);
    expect(src, "and announces it, since it changes while the dialog stays open").toMatch(
      /aria-live/
    );
  });

  it("⚠ caps CHARACTERS with maxLength, never words, nothing is silently truncated", () => {
    /**
     * `maxLength` on a word ceiling would cut a reporter's sentence off mid-word at some unrelated character
     * count. The word ceiling REFUSES instead, which is why both maxLength values are the character caps.
     */
    expect(src).toMatch(/maxLength=\{MAX_FEEDBACK_SUBJECT\}/);
    expect(src).toMatch(/maxLength=\{MAX_FEEDBACK_MESSAGE\}/);
    expect(src, "no word count is used as a maxLength").not.toMatch(/maxLength=\{[^}]*Words/);
  });

  it("⚠ does not colour an unfinished field as an error", () => {
    /**
     * Half-written is the NORMAL condition of a field being written. The error colour is reserved for over
     * the ceiling, the one case where more typing makes it worse. Colouring in-progress input red trains
     * people to ignore the colour, so the genuine problem gets ignored too.
     *
     * Asserted on the condition: the error class is chosen by `_TOO_LONG`, never by "is there a problem".
     */
    expect(src).toMatch(/_TOO_LONG/);
    expect(src, "the hint's colour is not driven by the presence of any problem").not.toMatch(
      /problem \? "[^"]*text-(red|tool-error)/
    );
  });
});

describe("the shared behaviour those forms depend on", () => {
  it("counts UP TO the floor while short, and stops once inside", () => {
    // Pinned here as well as in the shared package because it is what makes a floor bearable, and it reads
    // as cosmetic, the kind of thing a later simplification deletes.
    expect(feedbackWordHint("message", "one two three")).toBe(
      `3 / ${FEEDBACK_MESSAGE_BOUNDS.minWords} words`
    );
    const enough = Array.from({ length: FEEDBACK_MESSAGE_BOUNDS.minWords }, (_, i) => `w${i}`).join(
      " "
    );
    expect(feedbackWordHint("message", enough)).toBe(`${FEEDBACK_MESSAGE_BOUNDS.minWords} words`);
  });

  it("⚠ refuses a report that a reporter would think is fine", () => {
    /**
     * ⚠ THE ACCEPTED COST, WRITTEN DOWN AS A TEST RATHER THAN LEFT AS A SURPRISE.
     *
     * "The submit button returns a 500 error" is a GOOD bug report and it is refused, because a word floor
     * cannot tell a terse good report from a useless one. If this ever reads as wrong rather than as a known
     * trade, the floor is the thing to revisit, not this test.
     */
    /**
     * ⚠ NOTE THE SUBJECT. The obvious one to write here was "Submit button is broken", four words, refused
     * by the 5-word subject floor, which is how this test first failed. It is a fair illustration of the
     * trade: the natural phrasing of a short subject is under the floor, so a reporter pads it.
     */
    const terse = {
      subject: "The Submit button is broken",
      message: "The submit button returns a 500 error.",
    };
    expect(checkFeedbackReport(terse)?.code).toBe("MESSAGE_TOO_SHORT");

    // And the subject above is fine at exactly the floor, so the two rules are independent.
    expect(
      checkFeedbackReport({
        subject: terse.subject,
        message: Array.from({ length: FEEDBACK_MESSAGE_BOUNDS.minWords }, () => "word").join(" "),
      })
    ).toBeNull();
    expect(FEEDBACK_SUBJECT_BOUNDS.minWords).toBeLessThanOrEqual(terse.subject.split(/\s+/).length);
  });
});
