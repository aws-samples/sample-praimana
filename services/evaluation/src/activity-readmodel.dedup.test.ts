import { describe, it, expect } from "vitest";
import type { DocClient } from "@praimana/service-shared";
import { DynamoActivityReadModel } from "./activity-readmodel.dynamo.js";

/**
 * COUNTER INCREMENTS ARE IDEMPOTENT UNDER AT-LEAST-ONCE DELIVERY.
 *
 * ── THE DEFECT ──
 *
 * `increment` was a blind `SET #c = if_not_exists(#c, 0) + :by`, and `handler.ts` discarded
 * EventBridge's `id`. EventBridge is at-least-once: it may deliver twice, or deliver once,
 * have the write succeed, lose the response, and retry. Either way `tasksCompleted` rose
 * twice for one completed task — permanently, with no reconciliation pass and no way
 * afterwards to tell an inflated counter from a busy member.
 *
 * ── WHY IT MATTERS MORE NOW ──
 *
 * These counters are about to become the ONLY input to a model-written statement about a
 * named person, shown to executives and judges. A published number derived from an
 * inflatable counter is not defensible, which is why closing this is a precondition of
 * publishing anything to a non-member rather than a tidy-up.
 *
 * The tests assert the COMMANDS SENT, not a simulated outcome: the ordering and the
 * condition expression are the contract, and an in-memory stand-in for DynamoDB would
 * happily "pass" with neither.
 */

interface Sent {
  TableName?: string;
  KeyConditionExpression?: string;
  Key?: Record<string, unknown>;
  FilterExpression?: string;
  Item?: Record<string, unknown>;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/** Fails the Nth send with a ConditionalCheckFailedException, as DynamoDB would. */
function fakeDb(opts: { failClaim?: boolean; failWith?: Error } = {}) {
  const sent: Sent[] = [];
  const db = {
    send: async (cmd: { input: Sent }) => {
      sent.push(cmd.input);
      // A claim is the Put that carries a ConditionExpression.
      if (cmd.input.ConditionExpression && opts.failClaim) {
        const err = new Error("The conditional request failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      if (cmd.input.ConditionExpression && opts.failWith) throw opts.failWith;
      return {};
    },
  } as unknown as DocClient;
  return { db, sent };
}

const model = (db: DocClient) => new DynamoActivityReadModel(db);

describe("increment with an event id — the duplicate is refused", () => {
  it("CLAIMS the event, then increments — in that order", async () => {
    // Order is the whole safety argument. Claim-then-increment can lose a bump if the
    // process dies between them (under-count by one, rare, recoverable).
    // Increment-then-claim DOUBLES a bump on retry, which is the defect being fixed.
    const { db, sent } = fakeDb();

    await model(db).increment("t1", "u1", "tasksCompleted", 1, "evt-1");

    expect(sent).toHaveLength(2);
    expect(sent[0].ConditionExpression, "first send should be the claim").toBeTruthy();
    expect(sent[1].UpdateExpression, "second send should be the counter bump").toContain(
      "if_not_exists"
    );
  });

  it("writes the claim under a RESERVED sort key that cannot collide with a userId", async () => {
    // `dedup#<id>` shares the partition with the counters it guards, so the claim and the
    // bump touch one partition and no second table is needed. Cognito subs are UUIDs, so
    // the prefix cannot be a real member.
    const { db, sent } = fakeDb();

    await model(db).increment("t1", "u1", "messagesSent", 1, "evt-abc");

    expect(sent[0].Item).toMatchObject({ teamId: "t1", userId: "dedup#evt-abc" });
  });

  it("guards the claim on BOTH key attributes not existing", async () => {
    // A condition on the partition key alone is not enough for a composite-key table.
    const { db, sent } = fakeDb();
    await model(db).increment("t1", "u1", "messagesSent", 1, "evt-1");
    expect(sent[0].ConditionExpression).toContain("attribute_not_exists(teamId)");
    expect(sent[0].ConditionExpression).toContain("attribute_not_exists(userId)");
  });

  it("gives the claim a TTL, so claims do not accumulate forever", async () => {
    const { db, sent } = fakeDb();
    const before = Math.floor(Date.now() / 1000);

    await model(db).increment("t1", "u1", "messagesSent", 1, "evt-1");

    const expiresAt = sent[0].Item?.expiresAt as number;
    expect(typeof expiresAt).toBe("number");
    // Well past EventBridge's 24h retry window, so a late redelivery still finds the claim.
    expect(expiresAt).toBeGreaterThan(before + 24 * 60 * 60);
  });

  it("THE FIX: a duplicate delivery does NOT increment", async () => {
    // The claim fails because the id was already recorded ⇒ return without bumping.
    const { db, sent } = fakeDb({ failClaim: true });

    await model(db).increment("t1", "u1", "tasksCompleted", 1, "evt-1");

    expect(sent).toHaveLength(1);
    expect(sent[0].ConditionExpression, "only the claim was attempted").toBeTruthy();
    expect(
      sent.some((c) => c.UpdateExpression),
      "no counter bump on a duplicate"
    ).toBe(false);
  });

  it("a duplicate resolves quietly — the consumer must NOT throw and force a retry", async () => {
    // Throwing here would make EventBridge retry an event that was already applied, and
    // eventually park a correctly-handled event on the DLQ.
    const { db } = fakeDb({ failClaim: true });
    await expect(
      model(db).increment("t1", "u1", "tasksCompleted", 1, "evt-1")
    ).resolves.toBeUndefined();
  });

  it("a NON-condition failure on the claim RETHROWS, so the projection is retried", async () => {
    // Throttling or a network fault is not a duplicate. Swallowing it would silently drop a
    // projection update, and there is no reconciliation pass to recover it.
    const boom = new Error("ProvisionedThroughputExceededException");
    boom.name = "ProvisionedThroughputExceededException";
    const { db } = fakeDb({ failWith: boom });

    await expect(
      model(db).increment("t1", "u1", "tasksCompleted", 1, "evt-1")
    ).rejects.toThrow(/ProvisionedThroughput/);
  });
});

describe("without an event id", () => {
  it("increments directly — the in-process publisher has no bus and no id", async () => {
    // Not a loophole: an in-process call delivers exactly once by construction. The
    // EventBridge path always has an id (handler.ts forwards it), and that is where
    // at-least-once lives.
    const { db, sent } = fakeDb();

    await model(db).increment("t1", "u1", "tasksCreated");

    expect(sent).toHaveLength(1);
    expect(sent[0].UpdateExpression).toContain("if_not_exists");
    expect(sent[0].ConditionExpression).toBeUndefined();
  });
});

describe("dedup rows stay out of the member projection", () => {
  it("listByTeam EXCLUDES claims, using an expression DynamoDB actually accepts", async () => {
    /**
     * The ratings route maps over every row listByTeam returns (routes.ts:405-407), so an
     * unfiltered Query would surface each claim as a PHANTOM MEMBER with no counters —
     * inflating the member count and feeding fabricated zero-activity people into a
     * model-written assessment.
     *
     * ⚠ THE SHAPE MATTERS, AND A FAKE CLIENT CANNOT TELL YOU WHY. Two more obvious forms are
     * both REJECTED by the real service, verified against the live table:
     *   - `NOT begins_with(userId, ...)` in the key condition → "Invalid operator used in
     *     KeyConditionExpression"
     *   - the same NOT in a filter → "Filter Expression can only contain non-primary key
     *     attributes: Primary key attribute: userId"
     * The first version of this code used the first form and these tests PASSED, because the
     * fake never validates the expression. Every ratings read would have 500'd in
     * production. Hence the negative assertions below: they encode what the API refuses.
     */
    const { db, sent } = fakeDb();

    await model(db).listByTeam("t1");

    // Legal: key condition on the partition key alone, filter on a NON-key attribute.
    expect(sent[0].KeyConditionExpression).toBe("teamId = :teamId");
    expect(sent[0].FilterExpression).toBe("attribute_not_exists(dedupClaim)");

    // Illegal forms, pinned so neither comes back.
    expect(sent[0].KeyConditionExpression).not.toContain("NOT ");
    expect(sent[0].KeyConditionExpression).not.toContain("begins_with");
    expect(sent[0].FilterExpression).not.toContain("userId");
  });

  it("marks each claim with the NON-KEY attribute the filter depends on", async () => {
    // If the marker is ever dropped from the claim, the filter silently stops excluding
    // anything and the phantom members return.
    const { db, sent } = fakeDb();
    await model(db).increment("t1", "u1", "messagesSent", 1, "evt-1");
    expect(sent[0].Item).toMatchObject({ dedupClaim: true });
  });

  it("get still addresses an explicit key", async () => {
    const { db, sent } = fakeDb();
    await model(db).get("t1", "u1");
    expect(sent[0].Key).toEqual({ teamId: "t1", userId: "u1" });
  });
});
