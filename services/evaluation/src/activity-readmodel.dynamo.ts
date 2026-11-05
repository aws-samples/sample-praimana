import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { MemberActivity, ActivityReadModel } from "./domain.js";

/**
 * Activity read-model for the Evaluation service — the local projection that
 * REPLACES the monolith rating aggregator's cross-table reads.
 *
 * NOTE: In the monolith, computing a member's contribution meant scanning ~8
 * foreign tables (teamMembers, users, tasks, messages, aiThreads, aiMessages,
 * gitCommits, gitFiles). In the decomposed world that is forbidden. Instead this
 * table (`praimana-evaluation-activity-readmodel`) is fed by domain events
 * — see applyActivityEvent() in routes.ts, invoked from handler.ts's EventBridge
 * branch — and the rating endpoint aggregates
 * over THIS local projection only. Keyed by (teamId, userId).
 */
/** Reserved `userId` prefix for dedup claims. Cannot collide with a Cognito sub. */
const DEDUP_PREFIX = "dedup#";
/** 7 days — well past EventBridge's 24h retry window, short enough not to accumulate. */
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;

export class DynamoActivityReadModel implements ActivityReadModel {
  private readonly table =
    process.env.TABLE_EVALUATION_ACTIVITY_READMODEL ||
    "praimana-evaluation-activity-readmodel";

  constructor(private readonly db: DocClient) {}

  async get(teamId: string, userId: string): Promise<MemberActivity | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { teamId, userId } })
    );
    return (res.Item as MemberActivity) ?? null;
  }

  async listByTeam(teamId: string): Promise<MemberActivity[]> {
    /**
     * DEDUP CLAIMS ARE EXCLUDED, and this is not cosmetic.
     *
     * The claims live in this same partition at `userId = "dedup#<eventId>"` (see
     * `increment`). The ratings route maps over EVERY row this returns
     * (`routes.ts:405-407`), so an unfiltered Query would surface each claim as a phantom
     * member with no counters — inflating the team's member count and feeding fabricated
     * zero-activity people into a model-written assessment.
     *
     * WHY A FILTER ON A NON-KEY ATTRIBUTE, and not the two more obvious forms:
     *   - `NOT begins_with(userId, ...)` in the KEY CONDITION → "Invalid operator used in
     *     KeyConditionExpression". Key conditions permit only =, <, <=, >, >=, BETWEEN and
     *     begins_with; NOT is not among them.
     *   - the same NOT in a FILTER → "Filter Expression can only contain non-primary key
     *     attributes: Primary key attribute: userId".
     * Both were verified against the live table rather than reasoned about, because a unit
     * test with a fake client passes an expression the service rejects — which is exactly
     * what happened here before this comment existed.
     *
     * So the claim carries a `dedupClaim` marker and this filters on its absence. The cost
     * is honest: a FilterExpression runs AFTER the read, so claims still consume read
     * capacity. That is acceptable — they expire on a 7-day TTL and a team's partition holds
     * tens of rows, not millions — and it is the only legal shape.
     */
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "teamId = :teamId",
        FilterExpression: "attribute_not_exists(dedupClaim)",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as MemberActivity[]) ?? [];
  }

  async upsert(activity: MemberActivity): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: activity }));
  }

  async increment(
    teamId: string,
    userId: string,
    counter: keyof Omit<MemberActivity, "teamId" | "userId" | "updatedAt">,
    by = 1,
    eventId?: string
  ): Promise<void> {
    /**
     * CLAIM THE EVENT FIRST, then increment.
     *
     * EventBridge is at-least-once, so this method can be called twice for one real
     * occurrence. The counter bump below is a blind `+ :by` and cannot detect that, so a
     * redelivered `task.status-changed` used to raise `tasksCompleted` twice for one
     * completed task — permanently, with no reconciliation pass and no way to tell the
     * inflated value from a busy member afterwards.
     *
     * The claim is a conditional Put on a RESERVED sort key in this same table:
     * `userId = "dedup#<eventId>"`. Same partition as the counters it guards, so the claim
     * and the bump hit one partition and no second table is needed. The `dedup#` prefix
     * cannot collide with a real userId (Cognito subs are UUIDs) and `list`/`get` read
     * explicit keys, so these rows are never mistaken for members — asserted in the tests.
     *
     * ORDER MATTERS, and this order is the safe one. Claim-then-increment can lose a bump
     * if the process dies between the two (under-count by one). Increment-then-claim can
     * DOUBLE a bump on a retry, which is the defect being fixed. Under-counting once on a
     * crash is recoverable and rare; silently over-counting on every redelivery is neither.
     */
    if (eventId) {
      try {
        await this.db.send(
          new PutCommand({
            TableName: this.table,
            Item: {
              teamId,
              userId: `${DEDUP_PREFIX}${eventId}`,
              claimedAt: new Date().toISOString(),
              // A NON-KEY marker, because DynamoDB refuses to filter on a key attribute
              // ("Filter Expression can only contain non-primary key attributes") and
              // refuses NOT in a KeyConditionExpression ("Invalid operator"). Both were
              // verified against the live API, not assumed — a unit test with a fake client
              // happily passes an expression the service rejects. This attribute is what
              // listByTeam filters on.
              dedupClaim: true,
              // TTL so the claims do not accumulate for the life of the workshop. Well past
              // any EventBridge retry window (24h), so a late redelivery still finds it.
              expiresAt: Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS,
            },
            ConditionExpression:
              "attribute_not_exists(teamId) AND attribute_not_exists(userId)",
          })
        );
      } catch (err) {
        // Already claimed ⇒ this delivery is a duplicate. Return WITHOUT incrementing.
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") return;
        // Any other failure is a real fault: rethrow so the consumer throws and
        // EventBridge retries, rather than silently skipping the projection update.
        throw err;
      }
    }

    // Atomic counter bump; if_not_exists seeds new rows at 0 so the first event
    // for a member creates the projection row (upsert semantics).
    await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { teamId, userId },
        UpdateExpression:
          "SET #c = if_not_exists(#c, :zero) + :by, updatedAt = :now",
        ExpressionAttributeNames: { "#c": counter },
        ExpressionAttributeValues: {
          ":by": by,
          ":zero": 0,
          ":now": new Date().toISOString(),
        },
      })
    );
  }
}
