import { describe, it, expect } from "vitest";
import type { DocClient } from "@praimana/service-shared";
import { DynamoTeamAiRatingRepository } from "./repository.dynamo.js";
import { GENERATION_LEASE_MS } from "./domain.js";

/**
 * THE RATINGS TABLE'S ACTUAL DYNAMODB COMMANDS — and this file exists because a mutation survived.
 *
 * ⚠ HOW THE GAP WAS FOUND, because it is the more useful half of the story. Deleting the lower bound
 * from `latest()`'s KeyConditionExpression broke nothing: all 251 tests still passed. The route tests
 * inject a `FakeRatings` that overrides `latest()` wholesale, so the real query was never executed by
 * any test — the lease could have been returned as though it were an analysis and the suite would
 * have stayed green.
 *
 * That is the same class of blindness this repository has been burned by before (an illegal
 * `NOT begins_with` and a rejected `temperature` both passed green suites), arriving from a different
 * direction: not "the fake accepts what the service rejects" but "the fake replaces the code under
 * test entirely".
 *
 * So these assertions are on the COMMAND INPUT, which is the only place the key range is observable
 * without a live table. What they still cannot prove is atomicity — that a conditional write actually
 * excludes a concurrent writer is a DynamoDB property and needs the real service.
 */

/** A fake DocClient that records every command input and returns a scripted reply. */
function fakeDb(reply: unknown = {}, throwOnSend?: Error) {
  const sent: any[] = [];
  const db = {
    async send(cmd: { input: unknown; constructor: { name: string } }) {
      sent.push({ input: cmd.input, command: cmd.constructor.name });
      if (throwOnSend) throw throwOnSend;
      return reply;
    },
  };
  return { db: db as unknown as DocClient, sent };
}

/** The reserved sort value the lease occupies, duplicated here on purpose — see the test below. */
const CLAIM_SORT_KEY = "!claim";

describe("latest() must never return the generation LEASE", () => {
  it("bounds the key range explicitly, rather than trusting ASCII ordering", async () => {
    /**
     * THE MUTATION THAT SURVIVED. The lease shares the partition with the snapshots, keyed on the
     * reserved sort value "!claim". `!` (0x21) sorts below every ULID (0x30-0x37 today), so a
     * descending `Limit: 1` query passes over it WHENEVER A SNAPSHOT EXISTS — which is why the bug
     * would have been invisible in dev and fired on a team's very first analysis.
     *
     * The explicit `>= "0"` is what makes the invariant independent of which character the ULID
     * alphabet happens to start with. Asserted on the command input because that is where it lives.
     */
    const { db, sent } = fakeDb({ Items: [] });

    await new DynamoTeamAiRatingRepository(db).latest("team-1");

    expect(sent).toHaveLength(1);
    expect(sent[0].input.KeyConditionExpression).toBe(
      "teamId = :teamId AND generationId >= :minGenerationId"
    );
    expect(sent[0].input.ExpressionAttributeValues[":minGenerationId"]).toBe("0");
    // Descending + Limit 1 is what makes "newest" a single row read.
    expect(sent[0].input.ScanIndexForward).toBe(false);
    expect(sent[0].input.Limit).toBe(1);
  });

  it("the bound actually EXCLUDES the claim key, not just some keys", async () => {
    // A bound of "" or "!" would satisfy the assertion above's shape while still including the
    // lease. This pins the ordering relationship that matters.
    const { db, sent } = fakeDb({ Items: [] });

    await new DynamoTeamAiRatingRepository(db).latest("team-1");
    const floor: string = sent[0].input.ExpressionAttributeValues[":minGenerationId"];

    expect(floor > CLAIM_SORT_KEY, `${floor} must sort ABOVE ${CLAIM_SORT_KEY}`).toBe(true);
    // …and below every ULID, or real snapshots would be excluded too.
    expect(floor < "01ARZ3NDEKTSV4RRFFQ69G5FAV").toBe(true);
  });

  it("returns null on an empty team", async () => {
    const { db } = fakeDb({ Items: [] });
    expect(await new DynamoTeamAiRatingRepository(db).latest("team-1")).toBeNull();
  });
});

describe("claimGeneration — the conditional write", () => {
  it("writes the lease with a condition that admits a LAPSED holder", async () => {
    /**
     * Both disjuncts matter. `attribute_not_exists` is the first-ever claim; `expiresAt < :now` is
     * the killed-Lambda case — and it must be enforced HERE rather than left to DynamoDB's TTL,
     * which is asynchronous and documented as taking up to 48 hours. A lease whose only release was
     * TTL would wedge this route for a day and a half.
     */
    const { db, sent } = fakeDb();
    const now = 1_700_000_000_000;

    const ok = await new DynamoTeamAiRatingRepository(db).claimGeneration("team-1", "exec", now);

    expect(ok).toBe(true);
    expect(sent[0].input.ConditionExpression).toBe(
      "attribute_not_exists(generationId) OR expiresAt < :now"
    );
    expect(sent[0].input.Item.teamId).toBe("team-1");
    expect(sent[0].input.Item.generationId).toBe(CLAIM_SORT_KEY);
    expect(sent[0].input.Item.claimedById).toBe("exec");
  });

  it("stores expiresAt in SECONDS, and compares in the same unit", async () => {
    /**
     * DynamoDB TTL requires epoch SECONDS; a millisecond value would be a date ~55,000 years out and
     * the row would never expire. The condition compares against seconds too — a unit mismatch here
     * would either expire every lease instantly or never.
     */
    const { db, sent } = fakeDb();
    const now = 1_700_000_000_000;

    await new DynamoTeamAiRatingRepository(db).claimGeneration("team-1", "exec", now);

    expect(sent[0].input.Item.expiresAt).toBe(
      Math.floor((now + GENERATION_LEASE_MS) / 1000)
    );
    expect(sent[0].input.ExpressionAttributeValues[":now"]).toBe(Math.floor(now / 1000));
    // Sanity: a plausible epoch-seconds value, not milliseconds.
    expect(sent[0].input.Item.expiresAt).toBeLessThan(2_000_000_000);
  });

  it("the lease outlives the longest legal generation", async () => {
    // 45s is RATING_TOTAL_TIMEOUT_MS, the point at which the route aborts itself. A lease shorter
    // than that would let a second request in while the first was still calling Bedrock — exactly
    // the duplicate spend the lease exists to prevent.
    expect(GENERATION_LEASE_MS).toBeGreaterThan(45_000);
    // …but nowhere near the 10-minute cooldown: a failed generation must not block the retry.
    expect(GENERATION_LEASE_MS).toBeLessThan(10 * 60 * 1000);
  });

  it("a FAILED CONDITION is the answer 'busy', not an error", async () => {
    const err = Object.assign(new Error("nope"), {
      name: "ConditionalCheckFailedException",
    });
    const { db } = fakeDb({}, err);

    const ok = await new DynamoTeamAiRatingRepository(db).claimGeneration("t", "e", Date.now());

    expect(ok).toBe(false);
  });

  it("⚠ RETHROWS any OTHER failure — a broken table must not read as 'busy'", async () => {
    /**
     * The direction that matters. A throttle, a timeout or an AccessDenied silently mapped to
     * `false` would make every generation answer "already in progress" — disabling the feature and
     * blaming a colleague who is not there. The same reasoning the team repository applies to its
     * cancellation reasons.
     */
    const err = Object.assign(new Error("slow down"), {
      name: "ProvisionedThroughputExceededException",
    });
    const { db } = fakeDb({}, err);

    await expect(
      new DynamoTeamAiRatingRepository(db).claimGeneration("t", "e", Date.now())
    ).rejects.toThrow(/slow down/);
  });
});

describe("releaseGeneration", () => {
  it("deletes exactly the lease row, never a snapshot", async () => {
    // A release that got the sort key wrong would delete a real generation — the worst possible
    // outcome of a cleanup path.
    const { db, sent } = fakeDb();

    await new DynamoTeamAiRatingRepository(db).releaseGeneration("team-1");

    expect(sent[0].command).toBe("DeleteCommand");
    expect(sent[0].input.Key).toEqual({ teamId: "team-1", generationId: CLAIM_SORT_KEY });
  });

  it("SWALLOWS a failure — it runs after work that may have succeeded", async () => {
    /**
     * Release runs in a `finally` after a generation that may well have completed and been stored.
     * Throwing would convert a successful analysis into a 500 for the executive who triggered it,
     * and the failure is self-healing: the lease expires within the minute either way.
     */
    const { db } = fakeDb({}, new Error("delete failed"));

    await expect(
      new DynamoTeamAiRatingRepository(db).releaseGeneration("team-1")
    ).resolves.toBeUndefined();
  });
});
