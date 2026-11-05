/**
 * THE ACTIVITY EVENT CONTRACT — the actor field every member-activity event must carry.
 *
 * ── THE OUTAGE THAT CREATED THIS FILE ──
 *
 * Evaluation's activity projection reads `detail.userId` and skips anything without it
 * ("can't attribute — skip"). Every publisher sent a DIFFERENT name, and two sent no actor at
 * all:
 *
 *     task.created         (nothing)     -> dropped
 *     task.status-changed  (nothing)     -> dropped
 *     message.sent         senderId      -> dropped
 *     commit.pushed        authorId      -> dropped
 *     ai.thread-shared     sharedById    -> dropped
 *
 * So `praimana-evaluation-activity-readmodel` was PERMANENTLY EMPTY for every team since
 * the services were split. Proved live: 16 real chat messages on the platform, zero counter rows
 * and zero dedup claims. Downstream, `GET /teams/:id/ratings` returned `contributions: []` and
 * the AI ratings route answered 409 NO_ACTIVITY for every team, for ever.
 *
 * ── WHY NEITHER SIDE'S TESTS CAUGHT IT ──
 *
 * The consumer's tests hand-built `detail: { teamId: "t1", userId: "u1" }` — a shape NO publisher
 * emits. The publishers' tests used `toMatchObject`, which passes when a field is ABSENT. Each
 * side asserted its own assumption and the contract between them was tested by nobody. That is
 * the specific failure this module exists to prevent: the field name now lives in ONE place that
 * both sides import, and `assertActivityActor` is asserted by each publisher's own test against
 * the object it really emits.
 *
 * ── ADDITIVE, NEVER A RENAME ──
 *
 * Publishers keep their domain-meaningful names (`senderId`, `authorId`, `sharedById`,
 * `creatorId`) AND add `userId`. A rename would have been a breaking change to every existing
 * reader for no gain, and during a rolling deploy the old and new shapes coexist — an additive
 * field is readable by both.
 */

/** The one field name evaluation's activity projection attributes a counter by. */
export const ACTIVITY_ACTOR_FIELD = "userId" as const;

/**
 * Event types that feed member-activity counters.
 *
 * ⚠ MUST STAY IN STEP WITH `EvaluationActivityRule`'s `detail-type` list in
 * the infrastructure CloudFormation template AND with the `switch` in `applyActivityEvent`. Three
 * copies, and the rule is the only one that silently does nothing when it disagrees: an event
 * missing from the rule is never delivered, and no test in any service can see that.
 */
export const ACTIVITY_EVENT_TYPES = [
  "task.created",
  "task.status-changed",
  "message.sent",
  "commit.pushed",
  "ai.thread-shared",
  /**
   * ASSISTANT TURNS. Published by TWO producers with different amounts — the in-app Bedrock path
   * sends `aiTurns: 1` per invoke, the desktop CLI sync sends the number of assistant replies in
   * the batch — so the consumer must read the amount rather than assume 1.
   *
   * It was published and consumed by nothing, so AI usage was counted nowhere: `aiThreadsShared`
   * measures button presses, and somebody who used an assistant heavily without ever pressing
   * "share" scored zero.
   */
  "ai.response-generated",
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * Throw unless `detail` carries both the team and the actor the projection needs.
 *
 * FOR TESTS, not for the request path. A publisher that calls this in production would turn a
 * successful write into a 500 over a projection field — the write is the source of truth and
 * publishing is fire-and-forget by design. Its value is as an assertion each publisher's test
 * makes against the object it ACTUALLY emits, which is the check that was missing.
 *
 * Returns the detail so a test can assert on the result inline.
 */
export function assertActivityActor<T extends Record<string, unknown>>(
  detail: T,
  context = "activity event"
): T {
  const teamId = detail.teamId;
  const actor = detail[ACTIVITY_ACTOR_FIELD];
  if (typeof teamId !== "string" || !teamId) {
    throw new Error(
      `${context}: detail.teamId is required — the activity projection keys on it and skips events without it`
    );
  }
  if (typeof actor !== "string" || !actor) {
    throw new Error(
      `${context}: detail.${ACTIVITY_ACTOR_FIELD} is required — the activity projection ` +
        `attributes counters by it and SILENTLY SKIPS events without it. A domain-specific ` +
        `name (senderId/authorId/sharedById/creatorId) is not a substitute; add ${ACTIVITY_ACTOR_FIELD} alongside it.`
    );
  }
  return detail;
}
