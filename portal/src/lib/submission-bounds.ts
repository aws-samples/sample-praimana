import { countWords } from "@praimana/shared";

/**
 * ── THE WRITE-UP A TEAM MUST PRODUCE BEFORE A SUBMISSION CAN GO TO JUDGES ────────────────────
 *
 * Four narrative fields, title, summary, problem, solution, with a floor and a ceiling each.
 *
 * ── ⚠ WHY THESE ARE ENFORCED AT RELEASE AND NOT AT SAVE, AND NOT IN THE ZOD SCHEMA ──
 *
 * `submission.patch` is a PARTIAL patch and the submit form saves drafts incrementally: a team pastes
 * a demo link on Monday and writes the summary on Thursday. Requiring these in the patch schema would
 * refuse that Monday save for four fields nobody was editing, and it would also refuse the
 * Demo-phase auto-seed, which writes `demoUrl` alone. Blocking SAVE has the same defect in a friendlier
 * costume: a half-written summary becomes unparkable.
 *
 * So "mandatory" means *cannot be RELEASED without*, exactly as `demoUrl` has always been mandatory -
 * via release precondition P4, never via the schema. The checklist then names what is missing while
 * the team can still fix it, instead of a 400 arriving after the fact.
 *
 * ⚠ THE SERVICE IS STILL THE BOUNDARY. `the evaluation service` re-checks the release ladder against
 * the store at the moment of release; this module is what lets the UI say WHICH precondition is failing
 * BEFORE the button is pressed. Same division of labour, and the same drift risk, as
 * `release-readiness.ts`, read its header.
 *
 * ── WORDS, NOT CHARACTERS ──
 *
 * A character floor is satisfied by `"aaaa…"`. A word floor asks for the thing the floor is actually
 * for: a paragraph a judge can read. `maxChars` sits alongside as the anti-abuse ceiling, well above
 * each word cap, so a single megabyte-long token is refused as TOO LONG rather than counted as one word
 * and reported as too short, the ordering `support.ts` arrived at for the same reason.
 *
 * `countWords` is the SHARED counter (`shared/constants/phase-progress.ts`), whitespace-separated runs,
 * deliberately over-counting markdown and URLs slightly, because the failure to avoid is telling a team
 * that has genuinely written a page that they have not written enough.
 */

export interface SubmissionFieldBounds {
  readonly minWords: number;
  readonly maxWords: number;
  /** Anti-abuse ceiling, deliberately far above `maxWords`. Never the thing a real team hits. */
  readonly maxChars: number;
}

/** The four fields a team must write. `aiUsageSummary` is NOT here, see the note in the submit page. */
export type SubmissionWriteUpField =
  | "title"
  | "summary"
  | "problemStatement"
  | "solution";

/**
 * ⚠ THESE NUMBERS ARE A PRODUCT DECISION, NOT A DERIVED ONE, and they are recorded as such so nobody
 * goes looking for the analysis behind them. They mirror the feedback form's shape, subject 5–15
 * words, message 20–200 (`shared/constants/support.ts`), which teams already meet in practice. A title
 * floor of 3 rather than 5 because "Fleet Routing Optimiser" is a legitimate title and is three words.
 *
 * If they move, this is the ONLY place to change: the required markers, the live counters, the release
 * blockers and the tests all read from here rather than repeating a figure.
 */
export const SUBMISSION_BOUNDS: Record<
  SubmissionWriteUpField,
  SubmissionFieldBounds
> = {
  title: { minWords: 3, maxWords: 15, maxChars: 200 },
  summary: { minWords: 20, maxWords: 150, maxChars: 1_200 },
  problemStatement: { minWords: 20, maxWords: 200, maxChars: 1_600 },
  solution: { minWords: 20, maxWords: 200, maxChars: 1_600 },
};

/** What each field is called where a team can see it. Used in the blocker sentences. */
export const SUBMISSION_FIELD_LABELS: Record<SubmissionWriteUpField, string> = {
  title: "Title",
  summary: "Summary",
  problemStatement: "Problem",
  solution: "Solution",
};

/** The fields in the order the form presents them, so the checklist matches the page. */
export const SUBMISSION_WRITE_UP_FIELDS: readonly SubmissionWriteUpField[] = [
  "title",
  "summary",
  "problemStatement",
  "solution",
];

/**
 * What is wrong with this field, as a sentence a team can act on, or `null` when it is fine.
 *
 * ⚠ THE ORDER OF THE THREE CHECKS IS DELIBERATE, and it is the order `support.ts` settled on:
 *
 *   1. EMPTY first, because "you haven't written this" is a different message from "write more", and
 *      reporting "0 / 20 words" for an untouched field reads as a counter rather than as a requirement.
 *   2. `maxChars` BEFORE the word bounds, so a single enormous token is refused as too long instead of
 *      being counted as one word and reported as too short, which would be actively misleading.
 *   3. The word floor and ceiling last.
 *
 * Each message names the number, because a blocker that says "Summary is too short" sends the reader
 * back to the form to guess.
 */
export function checkSubmissionField(
  field: SubmissionWriteUpField,
  value: string | null | undefined
): string | null {
  const { minWords, maxWords, maxChars } = SUBMISSION_BOUNDS[field];
  const label = SUBMISSION_FIELD_LABELS[field];
  const trimmed = (value ?? "").trim();

  if (!trimmed) return `${label} is required (at least ${minWords} words).`;
  if (trimmed.length > maxChars) {
    return `${label} is too long, ${maxChars} characters maximum.`;
  }

  const words = countWords(trimmed);
  if (words < minWords) {
    const short = minWords - words;
    return `${label} needs ${short} more word${short === 1 ? "" : "s"} (at least ${minWords}).`;
  }
  if (words > maxWords) {
    return `${label} is ${words} words, ${maxWords} maximum.`;
  }
  return null;
}

/** Every write-up problem, in form order. Empty means the write-up is ready to release. */
export function submissionWriteUpBlockers(
  values: Partial<Record<SubmissionWriteUpField, string | null | undefined>>
): string[] {
  return SUBMISSION_WRITE_UP_FIELDS.map((field) =>
    checkSubmissionField(field, values[field])
  ).filter((problem): problem is string => problem !== null);
}

/**
 * Live counter text under a field, "7 / 20 words" while short, "24 words" once inside the bounds.
 *
 * ⚠ IT COUNTS *UP TO* THE FLOOR, which is the whole point of showing it. A ceiling is discoverable by
 * typing until it stops you; a FLOOR is not, so a team that cannot see progress towards it experiences
 * the requirement only as a refusal. Same argument as `feedbackWordHint`.
 */
export function submissionWordHint(
  field: SubmissionWriteUpField,
  value: string | null | undefined
): string {
  const { minWords, maxWords } = SUBMISSION_BOUNDS[field];
  const words = countWords(value);
  if (words < minWords) return `${words} / ${minWords} words`;
  if (words > maxWords) return `${words} words, ${maxWords} maximum`;
  return `${words} words`;
}
