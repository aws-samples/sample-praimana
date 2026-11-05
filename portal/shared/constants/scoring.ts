// ── THE JUDGING SCALE, AND THE RULE THAT A SCORE MUST SATISFY ─────────────────────────────
//
// ⚠ WHY THE VALIDATOR LIVES BESIDE THE CONSTANTS RATHER THAN IN THE ROUTE. The scoring form and
// the scoring route must refuse the SAME inputs. `constants/chat-limits.ts` records what happens
// otherwise — "a client that truncates at one value ends up talking to a server that refuses at
// another" — and `constants/message-time.ts` records the cost when one rule is written four times.
// So the numbers and the predicate are one export, consumed by both sides.
//
// ⚠ AND AS THERE, THE SERVER-SIDE CHECK IS THE REAL ONE. A `min`/`max` on a number input is a
// courtesy; the desktop, curl, or any other client can simply not honour it. These exist so the
// courtesy and the rule are the same rule, not so the client can be trusted.

/**
 * The scale is 1–10 inclusive. ⚠ IT STARTS AT 1, NOT 0 — see `scoreFieldErrors`: `0` is a refusal,
 * because the defect this replaces turned every unusable value INTO a zero, and a stored 0 is
 * indistinguishable from "a judge thought this was worthless".
 */
export const SCORE_MIN = 1;
export const SCORE_MAX = 10;

/**
 * The criteria, in the order a form should present them. Equal weight — there is no weighting
 * vector, deliberately: a weighted total is a product decision nobody has made, and inventing one
 * here would silently rank teams by it.
 *
 * ── ⚠ `aiUsage` WAS DROPPED, AND IT CHANGES WHAT A SCORE MEANS ─────────────────────────────
 *
 * It had become a criterion with nothing to judge from: "How you used your AI
 * assistant" had already been removed from the submission form, so for a few days a fifth of every
 * judge's score was awarded against a narrative the team could no longer write. Judges were falling
 * back to the AI Chats tab and the token panel — evidence, but not the team's account of it.
 *
 * ⚠ `MAX_SCORE_PER_JUDGE` IS NOW 40, NOT 50, and it is derived rather than written down — so every
 * "out of" on every screen moves with this list and none of them can disagree with it.
 *
 * ⚠ WHAT HAPPENS TO SCORES ALREADY CAST, STATED PLAINLY BECAUSE IT IS NOT NOTHING. A stored row
 * still carries its `aiUsage` number; nothing was deleted. But totals and means are DERIVED over
 * this list, so an existing score now reads as the sum of four criteria out of 40 — lower than the
 * number the judge saw when they submitted it. That is the only internally consistent answer without
 * a migration: the alternative is a row whose total exceeds its own maximum.
 *
 * ⚠ A PUBLISHED RANKING IS UNAFFECTED, because the places are a STORED artefact rather than
 * recomputed on read. But an UNPUBLISHED preview will move, and a reopen-then-republish will produce
 * a different ranking from the one the same scores produced before. Anyone republishing after this
 * change should expect that and not read it as a defect.
 *
 * The `aiUsage` column is left in place on the store and in the `Score` type. Dropping stored
 * numbers to tidy a list is not recoverable; ignoring them is.
 */
export const SCORE_CRITERIA = [
  "innovation",
  "execution",
  "impact",
  "presentation",
] as const;

export type ScoreCriterion = (typeof SCORE_CRITERIA)[number];

/** `SCORE_MAX * SCORE_CRITERIA.length` = 40 since `aiUsage` was dropped. Derived, never written down twice. */
export const MAX_SCORE_PER_JUDGE = SCORE_MAX * SCORE_CRITERIA.length;

/**
 * A judge's free-text comment, capped at the same 4,000 as a team chat message.
 *
 * Matched to `MAX_TEAM_MESSAGE_CHARS` rather than chosen independently: both are a person writing
 * prose into a box, and two different four-thousand-ish limits in one product is the kind of
 * difference nobody can justify when asked. ⚠ Unlike chat, this one is enforced in the SERVICE (see
 * the scores route), because the service is the only writer.
 */
export const MAX_SCORE_COMMENT_CHARS = 4000;

/**
 * Which criteria a candidate score body gets WRONG — empty when every one is usable.
 *
 * ⚠ RETURNS THE OFFENDERS RATHER THAN A BOOLEAN, because a refusal must NAME the field. A caller
 * told only "invalid" has to guess which of
 * five numbers it was.
 *
 * ⚠ NO COERCION, WHICH IS THE ENTIRE POINT. The defect this replaces was
 * `Number(body.innovation) || 0`:
 *
 *   - `Number("abc") || 0` → **0**, so a typo was stored as a real score
 *   - `|| 0` also turned a legitimate `0` into `0`, hiding that the scale starts at 1
 *   - nothing bounded the top, so `999` was stored verbatim
 *
 * A numeric STRING (`"7"`) is refused too, not parsed. It would be easy to accept, and that is the
 * argument against it: coercion is how the original bug arrived. JSON carries numbers as numbers, so
 * a string here means a client is building its body wrongly, and saying so is more useful than
 * quietly repairing it.
 *
 * Non-integers are refused: the scale is a set of ten choices, and `7.5` means a form
 * offered something the scale does not have.
 */
export function scoreFieldErrors(body: Record<string, unknown>): ScoreCriterion[] {
  return SCORE_CRITERIA.filter((criterion) => {
    const value = body[criterion];
    return (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < SCORE_MIN ||
      value > SCORE_MAX
    );
  });
}

/**
 * The mean of one judge's five criteria.
 *
 * Unrounded on purpose: the final value rounds ONCE, after averaging across judges, and rounding
 * twice would move a team's place. The caller does the rounding, at that one point.
 */
export function judgeMean(score: Record<ScoreCriterion, number>): number {
  const total = SCORE_CRITERIA.reduce((sum, criterion) => sum + score[criterion], 0);
  return total / SCORE_CRITERIA.length;
}

/**
 * Round half-up to 2dp — the value teams are RANKED on.
 *
 * ⚠ NOT `toFixed`, AND NOT BARE `Math.round(x * 100) / 100`. Both inherit binary
 * floating-point's surprises at exactly the .005 boundary this must decide: `1.005` is stored as
 * 1.00499999999999989…, so `Math.round(1.005 * 100)` is 100 (i.e. 1.00), not the 101 that "half-up"
 * promises. Ranking is done on this number, so a team can lose a place to it.
 *
 * `Number.EPSILON`-scaled nudge before rounding puts the boundary case on the intended side while
 * leaving every non-boundary value alone.
 */
export function roundHalfUp2dp(value: number): number {
  return Math.round((value + Number.EPSILON * Math.abs(value)) * 100) / 100;
}
