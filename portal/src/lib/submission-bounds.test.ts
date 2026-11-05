import { describe, it, expect } from "vitest";
import {
  SUBMISSION_BOUNDS,
  SUBMISSION_WRITE_UP_FIELDS,
  checkSubmissionField,
  submissionWordHint,
  submissionWriteUpBlockers,
  type SubmissionWriteUpField,
} from "./submission-bounds";
import { releaseReadiness } from "./release-readiness";

/**
 * THE FOUR NARRATIVE FIELDS A TEAM MUST WRITE BEFORE RELEASE.
 *
 * ⚠ EVERY BOUNDARY BELOW IS DERIVED FROM `SUBMISSION_BOUNDS`, NEVER HARDCODED. If the numbers move,
 * these tests must still describe the rule rather than fail on arithmetic, the same reason
 * `support.ts`'s suite derives its boundaries from the constant.
 *
 * What is actually worth testing here:
 *
 *   · the ORDER of the three checks, empty, then maxChars, then words. A single enormous token must be
 *     refused as TOO LONG, not counted as one word and reported as too short, which would send a team
 *     off to write more when the problem was the opposite;
 *   · that the messages name their numbers, because "Summary is too short" makes the reader guess;
 *   · that the counter counts UP TO the floor, which is the only reason to render it;
 *   · that these are RELEASE blockers and never a save-time refusal.
 */

/** `n` words of filler, so a test can sit exactly on a boundary without a wall of prose. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const atLeastMin = (field: SubmissionWriteUpField) =>
  words(SUBMISSION_BOUNDS[field].minWords);

describe("checkSubmissionField, the order of the three checks", () => {
  it.each(SUBMISSION_WRITE_UP_FIELDS)("reports %s as required when empty", (field) => {
    const problem = checkSubmissionField(field, "");
    expect(problem).toContain("is required");
    // The floor is named, so the team knows what "required" costs before they start typing.
    expect(problem).toContain(String(SUBMISSION_BOUNDS[field].minWords));
  });

  it.each(SUBMISSION_WRITE_UP_FIELDS)("treats whitespace-only %s as empty", (field) => {
    expect(checkSubmissionField(field, "   \n\t ")).toContain("is required");
  });

  it.each(SUBMISSION_WRITE_UP_FIELDS)(
    "refuses one enormous token in %s as TOO LONG, not too short",
    (field) => {
      /**
       * ⚠ THE ORDERING CASE. `maxChars` is checked BEFORE the word count. A single token over the
       * character ceiling is one word, so a word-first implementation would report "needs 19 more
       * words", telling a team to write more when they must write less.
       */
      const giant = "a".repeat(SUBMISSION_BOUNDS[field].maxChars + 1);
      const problem = checkSubmissionField(field, giant);
      expect(problem).toContain("too long");
      expect(problem).not.toContain("more word");
    }
  );
});

describe("checkSubmissionField, the word floor and ceiling", () => {
  it.each(SUBMISSION_WRITE_UP_FIELDS)("accepts %s exactly ON the floor", (field) => {
    // Off-by-one at the floor is the difference between a team being able to release and not.
    expect(checkSubmissionField(field, atLeastMin(field))).toBeNull();
  });

  it.each(SUBMISSION_WRITE_UP_FIELDS)("refuses %s one word BELOW the floor", (field) => {
    const { minWords } = SUBMISSION_BOUNDS[field];
    const problem = checkSubmissionField(field, words(minWords - 1));
    expect(problem).toContain("needs 1 more word");
    // Singular, because "needs 1 more words" is the kind of thing a reader notices instead of the rule.
    expect(problem).not.toContain("1 more words");
  });

  it.each(SUBMISSION_WRITE_UP_FIELDS)("pluralises the shortfall for %s", (field) => {
    /**
     * ⚠ THE SHORTFALL IS CLAMPED SO THE VALUE STAYS NON-EMPTY. `title`'s floor is 3, so a flat
     * `minWords - 3` is the EMPTY STRING, which correctly reports "is required" and not a shortfall.
     * Derived per field rather than assumed, or this test would silently be asserting the empty-value
     * branch on the narrowest field while looking like it covered the plural one.
     */
    const { minWords } = SUBMISSION_BOUNDS[field];
    const shortBy = Math.min(3, minWords - 1);
    expect(checkSubmissionField(field, words(minWords - shortBy))).toContain(
      `needs ${shortBy} more words`
    );
  });

  it.each(SUBMISSION_WRITE_UP_FIELDS)("accepts %s exactly ON the ceiling", (field) => {
    expect(checkSubmissionField(field, words(SUBMISSION_BOUNDS[field].maxWords))).toBeNull();
  });

  it.each(SUBMISSION_WRITE_UP_FIELDS)("refuses %s one word ABOVE the ceiling", (field) => {
    const { maxWords } = SUBMISSION_BOUNDS[field];
    const problem = checkSubmissionField(field, words(maxWords + 1));
    expect(problem).toContain(`${maxWords} maximum`);
  });
});

describe("submissionWriteUpBlockers, the checklist", () => {
  const complete = () =>
    Object.fromEntries(
      SUBMISSION_WRITE_UP_FIELDS.map((f) => [f, atLeastMin(f)])
    ) as Record<SubmissionWriteUpField, string>;

  it("is empty when all four fields are within bounds", () => {
    expect(submissionWriteUpBlockers(complete())).toEqual([]);
  });

  it("lists every offending field, not just the first", () => {
    // A checklist that stops at the first problem makes a team fix one thing per release attempt.
    expect(submissionWriteUpBlockers({})).toHaveLength(SUBMISSION_WRITE_UP_FIELDS.length);
  });

  it("keeps form order, so the checklist reads top-to-bottom against the page", () => {
    const blockers = submissionWriteUpBlockers({});
    expect(blockers[0]).toContain("Title");
    expect(blockers[1]).toContain("Summary");
    expect(blockers[2]).toContain("Problem");
    expect(blockers[3]).toContain("Solution");
  });

  it("names only the fields that are actually wrong", () => {
    const blockers = submissionWriteUpBlockers({ ...complete(), summary: "" });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("Summary");
  });

  it("ignores aiUsageSummary entirely, it is no longer part of the write-up", () => {
    // The field was removed from the form. It must not resurface as a
    // blocker, or teams would be held to something they cannot see or fill in.
    const blockers = submissionWriteUpBlockers(complete());
    expect(blockers.join(" ")).not.toMatch(/ai/i);
  });
});

describe("submissionWordHint, the counter counts UP to the floor", () => {
  it("shows progress towards the floor while short", () => {
    // The whole reason to render it: a floor is not discoverable by typing.
    expect(submissionWordHint("summary", words(7))).toBe(
      `7 / ${SUBMISSION_BOUNDS.summary.minWords} words`
    );
  });

  it("drops the target once inside the bounds", () => {
    const { minWords } = SUBMISSION_BOUNDS.summary;
    expect(submissionWordHint("summary", words(minWords))).toBe(`${minWords} words`);
  });

  it("reports the ceiling once over it", () => {
    const { maxWords } = SUBMISSION_BOUNDS.summary;
    expect(submissionWordHint("summary", words(maxWords + 5))).toBe(
      `${maxWords + 5} words, ${maxWords} maximum`
    );
  });

  it("handles empty and absent values", () => {
    const { minWords } = SUBMISSION_BOUNDS.title;
    expect(submissionWordHint("title", "")).toBe(`0 / ${minWords} words`);
    expect(submissionWordHint("title", null)).toBe(`0 / ${minWords} words`);
    expect(submissionWordHint("title", undefined)).toBe(`0 / ${minWords} words`);
  });
});

describe("releaseReadiness, the write-up blocks RELEASE, and nothing else", () => {
  const ready = {
    artifactCount: 1,
    demoUrl: "https://demo.example.com",
    hasUnsavedEdits: false,
  };
  const completeWriteUp = Object.fromEntries(
    SUBMISSION_WRITE_UP_FIELDS.map((f) => [f, atLeastMin(f)])
  ) as Record<SubmissionWriteUpField, string>;

  it("blocks release when the write-up is incomplete", () => {
    const { blockers, writeUpOk } = releaseReadiness({ ...ready, writeUp: {} });
    expect(writeUpOk).toBe(false);
    expect(blockers.length).toBeGreaterThan(0);
  });

  it("permits release when everything is in order", () => {
    const { blockers, writeUpOk } = releaseReadiness({
      ...ready,
      writeUp: completeWriteUp,
    });
    expect(writeUpOk).toBe(true);
    expect(blockers).toEqual([]);
  });

  /**
   * ⚠ AN OMITTED `writeUp` MEANS "WE DID NOT LOOK", NOT "THE TEAM WROTE NOTHING". Reporting four
   * blockers for a caller that simply passed no write-up would be this file inventing a failure, the
   * same distinction it already draws between an absent artifact count and a zero one.
   */
  it("degrades to the previous three checks when no write-up is supplied", () => {
    const { blockers, writeUpOk } = releaseReadiness(ready);
    expect(writeUpOk).toBe(true);
    expect(blockers).toEqual([]);
  });

  it("puts 'save first' LAST, after the fields still to write", () => {
    // A team reads this list as a to-do; "save the changes on screen" is the final step, so it must not
    // appear above four things that still need writing.
    const { blockers } = releaseReadiness({
      ...ready,
      hasUnsavedEdits: true,
      writeUp: {},
    });
    expect(blockers[blockers.length - 1]).toContain("Save the changes");
  });

  it("keeps the demo-link blocker ahead of the write-up", () => {
    const { blockers } = releaseReadiness({
      ...ready,
      demoUrl: null,
      writeUp: {},
    });
    expect(blockers[0]).toContain("https://");
  });
});
