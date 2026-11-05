import { describe, it, expect } from "vitest";
import {
  FEEDBACK_BOUNDS,
  FEEDBACK_FIELD_LABELS,
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_BOUNDS,
  FEEDBACK_PROMPTS,
  FEEDBACK_SUBJECT_BOUNDS,
  FEEDBACK_TITLES,
  GIVE_FEEDBACK_LABEL,
  MAX_FEEDBACK_MESSAGE,
  REPORT_BUG_LABEL,
  checkFeedbackField,
  checkFeedbackReport,
  feedbackWordHint,
} from "./support";

/**
 * ── THE SHARED VOCABULARY FOR REPORTING ────────────────────────────────────────────────────
 *
 * ⚠ THIS FILE REPLACED A SUITE THAT TESTED `mailto:` COMPOSITION — escaping, prefilled bodies, and the rule
 * that no token or team content could appear in one. That whole mechanism was withdrawn, so those tests
 * went with the code they described rather than being kept as a
 * record of a feature that no longer exists.
 *
 * The disclosure rule they protected did not disappear with them: a report's context is now assembled and
 * bounded SERVER-SIDE, and `services/identity/src/feedback.test.ts` asserts that the reporter's
 * identity comes from the verified token and that every context field is capped. That is a stronger place
 * for it — a client can no longer be the thing that gets it wrong.
 */

describe("the two kinds", () => {
  it("are BUG and FEEDBACK, and nothing else", () => {
    // The service validates against exactly these two and refuses anything else with KIND_INVALID, so a
    // third value here would be a form offering an option the API rejects.
    expect(FEEDBACK_KINDS).toEqual(["BUG", "FEEDBACK"]);
  });

  it("⚠ ask DIFFERENT questions — the reason this is not one 'contact us'", () => {
    // A single channel collapses "this is broken" and "this would be better if…" into one inbox where the
    // second is always read as the first.
    expect(FEEDBACK_PROMPTS.BUG).not.toBe(FEEDBACK_PROMPTS.FEEDBACK);
    expect(FEEDBACK_PROMPTS.BUG).toMatch(/expected/i);
    expect(FEEDBACK_PROMPTS.FEEDBACK).toMatch(/useful/i);
  });

  it("has a prompt and a title for every kind — no kind can render a blank form", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(FEEDBACK_PROMPTS[kind]?.trim().length, kind).toBeGreaterThan(20);
      expect(FEEDBACK_TITLES[kind]?.trim().length, kind).toBeGreaterThan(0);
    }
  });

  it("titles reuse the menu labels, so the entry and the form agree", () => {
    expect(FEEDBACK_TITLES.BUG).toBe(REPORT_BUG_LABEL);
    expect(FEEDBACK_TITLES.FEEDBACK).toBe(GIVE_FEEDBACK_LABEL);
  });
});

describe("the message bound", () => {
  it("is generous but finite", () => {
    /**
     * ⚠ PINNED BECAUSE IT IS SHARED. The form's `maxLength`, the BFF's zod check and the service's refusal
     * all read this one number; if it drifted, a reporter would be told to shorten something the service
     * would have accepted, or accept something it refuses — after the writing.
     */
    expect(MAX_FEEDBACK_MESSAGE).toBe(8_000);
  });
});

/**
 * ── ⚠ THE WORD BOUNDS: ONE VALIDATOR, FOUR CALLERS ──────────────────────────────────────────
 *
 * The bounds: subject 5–15 words, description 20–200, one rule for both kinds.
 *
 * `checkFeedbackField` is called by the portal's dialog, the portal's BFF, the desktop's form and the
 * identity route. The value of that is not the saved code — it is that a report the FORM accepted cannot be
 * refused by the API, which is the failure mode this replaced: a client that counts words its own way
 * eventually disagrees by one word, and the reporter is the one who discovers it after writing.
 */
describe("the word bounds", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  it("are the specified bounds", () => {
    // Pinned deliberately. The tests below derive their boundaries from these, so THIS is the one place a
    // revision has to be made — and a revision made anywhere else fails here.
    expect(FEEDBACK_SUBJECT_BOUNDS).toMatchObject({ minWords: 5, maxWords: 15 });
    expect(FEEDBACK_MESSAGE_BOUNDS).toMatchObject({ minWords: 20, maxWords: 200 });
  });

  it("⚠ apply to BOTH kinds — a reporter never has to learn which channel has which limit", () => {
    // The alternative considered and rejected: a ceiling that changed with the kind. Two sets of numbers is
    // two things to explain in a form, and the form does not know which one a reader remembers.
    expect(FEEDBACK_BOUNDS.subject).toBe(FEEDBACK_SUBJECT_BOUNDS);
    expect(FEEDBACK_BOUNDS.message).toBe(FEEDBACK_MESSAGE_BOUNDS);
  });

  for (const field of ["subject", "message"] as const) {
    const { minWords, maxWords } = FEEDBACK_BOUNDS[field];

    it(`${field}: the boundaries are INCLUSIVE at both ends`, () => {
      expect(checkFeedbackField(field, words(minWords)), `${minWords} words`).toBeNull();
      expect(checkFeedbackField(field, words(maxWords)), `${maxWords} words`).toBeNull();
    });

    it(`${field}: one word either side is refused, with a distinguishable code`, () => {
      expect(checkFeedbackField(field, words(minWords - 1))?.code).toBe(
        `${field.toUpperCase()}_TOO_SHORT`
      );
      expect(checkFeedbackField(field, words(maxWords + 1))?.code).toBe(
        `${field.toUpperCase()}_TOO_LONG`
      );
    });

    it(`${field}: empty is REQUIRED, not TOO_SHORT`, () => {
      // Two different sentences for two different situations: "please write something" is not "please write
      // more", and a reporter who has typed nothing has not failed a length rule.
      for (const empty of ["", "   ", "\n\t", null, undefined]) {
        expect(checkFeedbackField(field, empty)?.code, JSON.stringify(empty)).toBe(
          `${field.toUpperCase()}_REQUIRED`
        );
      }
    });

    it(`${field}: a single huge token is refused on CHARACTERS, not reported as one word`, () => {
      /**
       * ⚠ THE ORDER OF THE CHECKS IS THE BEHAVIOUR. By word count this input is ONE word — too SHORT. The
       * character cap has to be consulted first or a megabyte-long paste is answered with "needs at least 20
       * words", and the storage bound that exists to stop a 400KB item never fires.
       */
      const huge = "x".repeat(FEEDBACK_BOUNDS[field].maxChars + 1);
      expect(checkFeedbackField(field, huge)?.code).toBe(`${field.toUpperCase()}_TOO_LONG`);
    });

    it(`${field}: the message a person reads names the field and the number`, () => {
      const short = checkFeedbackField(field, words(minWords - 1))!;
      expect(short.message).toContain(FEEDBACK_FIELD_LABELS[field]);
      expect(short.message).toContain(String(minWords));
      // And how far along they are — "at least 20 words" without "you have 7" leaves them guessing.
      expect(short.message).toContain(String(minWords - 1));
    });
  }

  it("⚠ reports the SUBJECT's problem first when both are wrong", () => {
    // It is the field above. Naming the lower one while the one above it is also wrong makes a form feel
    // like it is refusing at random, and the reporter fixes the wrong thing first.
    const problem = checkFeedbackReport({ subject: "two words", message: "also short" });
    expect(problem?.code).toBe("SUBJECT_TOO_SHORT");
  });

  it("passes a report that satisfies both", () => {
    expect(
      checkFeedbackReport({
        subject: words(FEEDBACK_SUBJECT_BOUNDS.minWords),
        message: words(FEEDBACK_MESSAGE_BOUNDS.minWords),
      })
    ).toBeNull();
  });

  describe("the live counter", () => {
    it("counts UP TO the floor while short — progress, not failure", () => {
      // A field being half-written is the normal condition of a field being written. "7 / 20 words" shows
      // how much more is wanted; a bare "7 words" next to a disabled button explains nothing.
      expect(feedbackWordHint("message", words(7))).toBe("7 / 20 words");
    });

    it("drops the target once inside the bounds", () => {
      expect(feedbackWordHint("message", words(25))).toBe("25 words");
    });

    it("names the ceiling once over it", () => {
      expect(feedbackWordHint("message", words(201))).toBe("201 words — 200 maximum");
    });

    it("reads 0 for an empty field rather than blank", () => {
      expect(feedbackWordHint("subject", "")).toBe("0 / 5 words");
    });
  });
});

describe("nothing here composes a URL any more", () => {
  it("⚠ exports no mailto builder — the whole mechanism is gone", async () => {
    /**
     * The regression this guards is a partial migration: a form added while a mailto link survives
     * somewhere, so reports arrive by two routes and only one is in the inbox. Asserted on the module's
     * exports rather than on a grep, because an unused export is exactly what a half-finished removal
     * leaves behind.
     */
    const mod = (await import("./support")) as Record<string, unknown>;
    for (const gone of ["bugReportMailto", "feedbackMailto", "mailEscape"]) {
      expect(mod[gone], gone).toBeUndefined();
    }
    expect(Object.values(mod).some((v) => typeof v === "string" && v.startsWith("mailto:"))).toBe(
      false
    );
  });
});
