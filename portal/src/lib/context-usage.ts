// ── ⚠ IS THERE A CONTEXT READING TO SHOW, AND WHAT IS IT? ─────────────────────────────────
//
// REPORTED: "can u check for kiro why percentage number is missing", the portal rendered the words
// `Context` and `% full` with NOTHING BETWEEN THEM.
//
// ⚠ THE BUG WAS A GUARD THAT TESTED THE WRONG ABSENCE. `ThreadTiming` had:
//
//     {t.ai.contextUsagePercent !== null && (… {t.ai.contextUsagePercent}% full …)}
//
// `undefined !== null` is TRUE, so the segment rendered and then printed nothing, because React renders
// `undefined` as empty. And `undefined` is the NORMAL case, not an exotic one: any ai-service that predates
// this field simply omits it from the timing response, so every request to a backend that has not been
// redeployed produces exactly that. The type made it invisible, `contextUsagePercent: number | null`
// declared the field as always present, which is a lie about the wire, so the compiler had nothing to say.
//
// ⚠ WHY THIS IS A FUNCTION AND NOT A TIGHTER `&&`. The rule it enforces is the same one the timing strip is
// built on, an absent measurement must render as ABSENT, never as a blank or a zero, and that rule is worth
// testing rather than asserting. The portal's tests are pure-logic only (no jsdom; React is e2e scope), so a
// decision left inside JSX is a decision no test can reach. This one now has the cases below pinned.
//
// ⚠ AND `0` IS A REAL READING, which is why the test is `typeof … === "number"` and never truthiness. A fresh
// conversation genuinely reports 0% full; `value && …` or `!value` would discard it and the strip would go
// silent on the one thread where the figure is least ambiguous.

/**
 * Coerce a timing rollup's `contextUsagePercent` into something drawable.
 *
 * @param raw The value as it arrived over the wire, which may be a number, `null` (the service measured
 *            nothing), `undefined` (the service is too old to send the field at all), or, since this is
 *            untrusted JSON, anything whatsoever.
 * @returns the percentage to draw, or `null` when there is nothing honest to draw.
 */
export function contextUsageReading(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  /**
   * ⚠ OUT OF RANGE IS ABSENT, NOT CLAMPED, the same decision the sync route makes on the way in, and for the
   * same reason: a clamped 100% would tell a participant their conversation is full on evidence already known
   * to be wrong, and they would compact a chat that did not need it. The service bounds this too; the check is
   * repeated here because this function also reads rows written by earlier versions of that route.
   */
  if (raw < 0 || raw > 100) return null;
  /** Rounded for display. A legacy row may hold the agent's raw 10.665900230407715. */
  return Math.round(raw);
}

/**
 * Above this, the reading is drawn in amber rather than plain ink.
 *
 * ⚠ THE SAME NUMBER THE DESKTOP USES in `KiroChatView`'s header, deliberately shared as a named constant
 * rather than repeated as a literal, two surfaces disagreeing about when a conversation is "nearly full"
 * would be a worse defect than either threshold being slightly wrong.
 */
export const CONTEXT_ALARM_THRESHOLD = 85;
