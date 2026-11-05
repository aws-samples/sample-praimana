import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DocClient } from "@praimana/service-shared";
import {
  DynamoAuditRepository,
  DynamoInvitationRepository,
  DynamoTeamMemberRepository,
  DynamoTeamRepository,
} from "./repository.dynamo.js";
import type { Invitation, Team } from "./domain.js";

/**
 * Tests for the repository's CONDITIONAL writes and FILTERED reads — the mechanisms that live
 * in a string DynamoDB evaluates and an in-memory fake does not.
 *
 * WHY THIS FILE EXISTS. The route-level tests use an in-memory fake, so they prove the
 * ROUTE behaves idempotently given a repository that does. They cannot prove the real
 * repository is the one that does — and the mechanism lives entirely in the
 * ConditionExpression, which is a string the fake does not evaluate. A missing
 * `#status <> :status` would type-check, lint, and pass every route test in the repo
 * while re-stamping `acceptedAt` on every sign-in for the rest of an account's life.
 *
 * FIVE THINGS ARE PINNED HERE. Items 3-4 arrived with reactivation, when member
 * removal stopped being a hard delete; item 5 with P2-2:
 *
 *   1. `accept` / `markRevoked` — the invitation flips.
 *   2. `DynamoAuditRepository.listByTeam` — the former-members index read.
 *   3. `get` / `listByTeam` / `listByUser` REFUSING A DEACTIVATED ROW. The single mechanism the
 *      whole safety argument for keeping the row rests on: forgetting to handle inactive DENIES
 *      rather than grants, because the filter is HERE and not in fourteen call sites.
 *   4. `deactivate` / `reactivate` — two more conditional flips, one of which (`reactivate`
 *      without `attribute_exists`) would turn a restoration route into a way to add an
 *      arbitrary user to an arbitrary team.
 *   5. `DynamoInvitationRepository.listByEmail` / `.listByTeam` FOLLOWING PAGINATION, and
 *      REFUSING rather than returning a truncated list. The pagination loop and the
 *      `ExclusiveStartKey`/`Limit` it sends are invisible to every route-level fake, which is
 *      why they are asserted on the COMMAND INPUT here.
 *
 * So the assertions here are on the COMMAND INPUT (the condition is present, the
 * reserved-word alias is bound) and on the ERROR CLASSIFICATION (a conditional-check
 * failure is benign and reported as `false`; anything else is rethrown). The second half
 * matters as much as the first: the previous implementation had a bare `catch {}`, which
 * made a throttle or an AccessDenied indistinguishable from a successful accept — the
 * exact way a row silently stays PENDING.
 */

/** The subset of an Update/Query command's input these tests read. */
interface UpdateInput {
  TableName?: string;
  IndexName?: string;
  Key?: { teamId?: string; email?: string; userId?: string };
  UpdateExpression?: string;
  ConditionExpression?: string;
  KeyConditionExpression?: string;
  FilterExpression?: string;
  ScanIndexForward?: boolean;
  /** Asserted where a read's result BECOMES stored state and so cannot come from a replica. */
  ConsistentRead?: boolean;
  Limit?: number;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/**
 * A fake DocClient that records the command input and then behaves as told.
 *
 * `fail` is the error to throw INSTEAD of succeeding, which is how the two branches of
 * the catch are exercised. It is thrown from `send` exactly as the SDK would.
 */
/**
 * Records what was sent, FLATTENING a TransactWriteItems to its member-item Update.
 *
 * ── WHY THE FLATTENING, AND WHY IT IS NOT A WEAKENING ──
 *
 * `deactivate`/`reactivate` became two-item transactions under the seat-ledger change: the membership
 * row's status flip and the team's `memberCount` move must commit together, or a removal could
 * free a seat that the ledger never gives back. The assertions in this file are about the
 * MEMBER item — that the flip is a SET and never a delete, that it does not touch `role` or
 * `joinedAt`, that it is guarded on the row existing and not already being INACTIVE. Every one
 * of those rules still holds; only the envelope moved.
 *
 * So `sent[0]` continues to mean "the member-item write", and `sentTransactions` exposes the
 * whole transaction for the tests that assert the LEDGER half. Rewriting sixteen call sites to
 * reach through `TransactItems[0].Update` would have obscured what each test is actually about.
 */
function fakeDb(fail?: unknown) {
  const sent: UpdateInput[] = [];
  const sentTransactions: Array<Record<string, unknown>[]> = [];
  const db = {
    async send(cmd: { input: Record<string, unknown> }) {
      const items = cmd.input.TransactItems as
        | Array<Record<string, Record<string, unknown>>>
        | undefined;
      if (items) {
        sentTransactions.push(items as unknown as Record<string, unknown>[]);
        // The member item is first in every transaction this repository builds — the
        // membership row is the subject, the ledger is the consequence.
        const first = items[0];
        const inner = first.Update ?? first.Put ?? first.Delete;
        if (inner) sent.push(inner as unknown as UpdateInput);
      } else {
        sent.push(cmd.input as unknown as UpdateInput);
      }
      if (fail) throw fail;
      return {};
    },
  };
  return { db: db as unknown as DocClient, sent, sentTransactions };
}

/** The error DynamoDB returns when a ConditionExpression does not hold. */
const conditionalCheckFailed = () =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });

/**
 * The error a TRANSACTION returns when ONE item's ConditionExpression does not hold.
 *
 * ⚠ NOT `ConditionalCheckFailedException` — a `TransactWriteItems` never sends that. It sends
 * `TransactionCanceledException` with a per-item `CancellationReasons` array, and the INDEX of
 * the failing item is the whole signal: item 0 is the membership row (benign — no row, or
 * already in the target state), item 1 is the team's seat ledger (a bookkeeping problem that
 * must NOT be reported as if the membership flip had happened).
 *
 * `reasons` is index-aligned: pass `[true]` for the member item, `[false, true]` for the team.
 */
const transactionCancelled = (reasons: boolean[]) =>
  Object.assign(new Error("Transaction cancelled, please refer to reasons"), {
    name: "TransactionCanceledException",
    CancellationReasons: reasons.map((failed) => ({
      Code: failed ? "ConditionalCheckFailed" : "None",
    })),
  });

/**
 * ── ⚠ `put` IS CONDITIONAL, AND THAT IS THE STORE HALF OF A TWO-PART FIX ────────────
 *
 * It was a bare `PutCommand`, so it REPLACED whatever sat on key (teamId, email): new tokenHash,
 * status back to PENDING, `invitedBy` reset to the caller, acceptedAt/acceptedBy destroyed. The route
 * (gate 6) now refuses that before calling this; the condition is what does not depend on a caller
 * remembering to ask, and what survives a race between two concurrent invitations for one address.
 *
 * THIS IS EXACTLY THE CLASS OF MECHANISM THIS FILE EXISTS FOR: the in-memory fake used by every route
 * test does not evaluate a ConditionExpression, so a missing one would pass all 1000+ of them.
 */
describe("DynamoInvitationRepository.put — the conditional create", () => {
  const row = (over: Partial<Invitation> = {}): Invitation => ({
    teamId: "t1",
    email: "invitee@example.com",
    status: "PENDING",
    invitedBy: "fac-1",
    sentAt: "2026-08-22T00:00:00.000Z",
    ...over,
  });

  it("refuses to overwrite an ACCEPTED row", async () => {
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).put(row());

    const [input] = sent;
    expect(input.ConditionExpression).toContain("#status <> :accepted");
    // Both bindings must be present, or DynamoDB rejects the write with a ValidationException at
    // runtime — which the condition string alone would not reveal.
    expect(input.ExpressionAttributeNames?.["#status"]).toBe("status");
    expect(input.ExpressionAttributeValues?.[":accepted"]).toBe("ACCEPTED");
  });

  it("still allows the FIRST write for an address", async () => {
    // `email` is the RANGE key, so this is the idiomatic "no such item yet". Without this clause a
    // brand-new invitation would be refused — the condition would break the feature it protects.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).put(row());

    expect(sent[0].ConditionExpression).toContain("attribute_not_exists(email)");
  });

  it("⚠ still allows a LEGACY row that carries no status attribute", async () => {
    /**
     * THE SUBTLE ONE. A comparison against an ABSENT attribute evaluates FALSE in DynamoDB, so
     * `attribute_not_exists(email) OR #status <> :accepted` alone would make every row written before
     * `status` existed permanently un-overwritable — refusing re-invitation of exactly the rows
     * `isSpentInvitation` goes out of its way to keep admittable ("ABSENT STATUS IS NOT SPENT … a
     * lockout, which is worse than the leak").
     */
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).put(row());

    expect(sent[0].ConditionExpression).toContain("attribute_not_exists(#status)");
  });

  it("⚠ does NOT block overwriting a PENDING or REVOKED row", async () => {
    /**
     * The condition names ACCEPTED and nothing else, deliberately. Re-sending a PENDING invitation is
     * ordinary, and re-inviting a REVOKED address is the DOCUMENTED way to re-admit someone — a bare
     * `attribute_not_exists(email)` would have broken both, which is why the status clause exists
     * rather than a blanket no-overwrite rule.
     */
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).put(row());

    const condition = String(sent[0].ConditionExpression);
    expect(condition).not.toContain("PENDING");
    expect(condition).not.toContain("REVOKED");
    expect(Object.values(sent[0].ExpressionAttributeValues ?? {})).toEqual(["ACCEPTED"]);
  });

  it("lower-cases the email it stores, as it always did", async () => {
    // Unchanged behaviour, pinned here because the condition now shares this method: the key it
    // guards must be the key it writes.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).put(row({ email: "MiXeD@Example.COM" }));

    expect((sent[0] as unknown as { Item: Invitation }).Item.email).toBe("mixed@example.com");
  });
});

describe("DynamoInvitationRepository.accept — the conditional flip", () => {
  it("reports TRUE when the update succeeds — this call performed the flip", async () => {
    const { db } = fakeDb();
    expect(
      await new DynamoInvitationRepository(db).accept("t1", "me@example.com", "sub-1")
    ).toBe(true);
  });

  it("guards on BOTH the row existing AND it not already being ACCEPTED", async () => {
    // THE assertion this file exists for. `attribute_exists(teamId)` alone was the old
    // condition: it stopped an accidental upsert (an UpdateCommand creates the item
    // otherwise, fabricating an ACCEPTED invitation for an address nobody invited) but
    // did nothing about a repeat call. Both halves must be present.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).accept("t1", "me@example.com", "sub-1");

    const [input] = sent;
    expect(input.ConditionExpression).toContain("attribute_exists(teamId)");
    expect(input.ConditionExpression).toContain("#status <> :status");
    // The alias and the value it compares against must both be bound, or DynamoDB
    // rejects the request with a ValidationException at runtime — which the condition
    // string alone would not reveal.
    expect(input.ExpressionAttributeNames?.["#status"]).toBe("status");
    expect(input.ExpressionAttributeValues?.[":status"]).toBe("ACCEPTED");
  });

  it("writes acceptedAt and acceptedBy in the SAME conditional update", async () => {
    // One conditional write, not a read-then-write: an "is it accepted yet" read
    // followed by an unconditional update is a race between two concurrent sign-ins,
    // and both would stamp their own timestamp.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).accept("t1", "me@example.com", "sub-1");

    const [input] = sent;
    expect(input.UpdateExpression).toContain("acceptedAt = :now");
    expect(input.UpdateExpression).toContain("acceptedBy = :userId");
    expect(input.ExpressionAttributeValues?.[":userId"]).toBe("sub-1");
    // A real ISO instant, not an empty placeholder.
    expect(String(input.ExpressionAttributeValues?.[":now"])).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
  });

  it("omits acceptedBy entirely when no actor is given", async () => {
    // Rather than writing an empty string, which would make the field LOOK present to
    // anything checking for the key rather than for content.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).accept("t1", "me@example.com");

    const [input] = sent;
    expect(input.UpdateExpression).not.toContain("acceptedBy");
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":userId");
  });

  it("lower-cases the email in the KEY, matching how rows are written", async () => {
    // The table's sort key. A mixed-case key misses the row entirely, and because the
    // miss surfaces as a ConditionalCheckFailedException it would read as the benign
    // "already accepted" — a silent no-op rather than an error.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).accept("t1", "Me@Example.COM");

    expect(sent[0].Key).toEqual({ teamId: "t1", email: "me@example.com" });
  });

  it("passes the PLATFORM sentinel through as the partition key verbatim", async () => {
    // The motivating case: a FACILITATOR's invitation lives at teamId = "PLATFORM", not a
    // real team. Nothing here may special-case or resolve it — it IS the key.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).accept(
      "PLATFORM",
      "facilitator-1@example.com",
      "sub-fac"
    );

    expect(sent[0].Key?.teamId).toBe("PLATFORM");
  });

  it("reports FALSE — not an error — when the condition does not hold", async () => {
    // "No row for that email" and "already ACCEPTED" are both benign and both arrive as
    // this one exception. Returning false is what lets a caller distinguish a first
    // acceptance from a no-op without a read-before-write.
    const { db } = fakeDb(conditionalCheckFailed());
    expect(
      await new DynamoInvitationRepository(db).accept("t1", "me@example.com", "sub-1")
    ).toBe(false);
  });

  it("RETHROWS a real store failure instead of swallowing it", async () => {
    // The regression this replaces. A bare `catch {}` treated a throttle, a timeout and
    // an AccessDenied exactly like a successful accept — so the row stayed PENDING and
    // nothing anywhere said why. Every one of these must reach the caller, which then
    // decides whether to absorb it (the join and sign-in paths) or fail (the PATCH
    // route, whose only purpose is the flip).
    for (const name of [
      "ProvisionedThroughputExceededException",
      "TimeoutError",
      "AccessDeniedException",
      "ResourceNotFoundException",
    ]) {
      const { db } = fakeDb(Object.assign(new Error(name), { name }));
      await expect(
        new DynamoInvitationRepository(db).accept("t1", "me@example.com", "sub-1")
      ).rejects.toThrow(name);
    }
  });

  it("rethrows an error with no `name` at all rather than reading it as benign", async () => {
    // Fails CLOSED on an unrecognisable failure: only an explicit
    // ConditionalCheckFailedException is treated as "nothing to do".
    const { db } = fakeDb("a bare string rejection");
    await expect(
      new DynamoInvitationRepository(db).accept("t1", "me@example.com")
    ).rejects.toBe("a bare string rejection");
  });

  it("REFUSES to move a REVOKED row back to ACCEPTED", async () => {
    // THE STORE'S HALF OF THE REMOVAL FIX, and it must live here rather than only in the
    // routes: `accept` has THREE callers (the join path, the sign-in flip, and the staff
    // reconciliation PATCH), and a rule enforced in two of them is a rule the third breaks.
    // Without this condition a REVOKED row could be flipped back to ACCEPTED — destroying
    // the record of the withdrawal AND handing back a row the join gate reads as live.
    //
    // Asserted on the CONDITION STRING because that is where the mechanism lives; the fake
    // does not evaluate it, so a missing clause would type-check, lint and pass every route
    // test in the repo.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).accept("t1", "me@example.com", "sub-1");

    const [input] = sent;
    expect(input.ConditionExpression).toContain("#status <> :revoked");
    // Bound, or DynamoDB rejects the request with a ValidationException at runtime — which
    // the condition string alone would not reveal.
    expect(input.ExpressionAttributeValues?.[":revoked"]).toBe("REVOKED");
  });
});

/**
 * DynamoInvitationRepository.markRevoked — the OTHER revoke, the one that KEEPS THE ROW.
 *
 * WHY THERE ARE TWO. `revoke()` DELETES an un-redeemed row, because for a PENDING
 * invitation the row IS the permission to register and there is no history worth keeping.
 * `markRevoked()` FLIPS a row that somebody redeemed: it is also the record of who invited
 * them and when they accepted, and the former-members view derives provenance from the
 * audit entry written beside it. Deleting would erase history to fix an access bug — which
 * is a deliberate design choice, recorded at the interface.
 *
 * Same reason this file exists at all: the mechanism is a ConditionExpression the in-memory
 * fake does not evaluate, so the route tests cannot prove it.
 */
describe("DynamoInvitationRepository.markRevoked — the conditional withdrawal", () => {
  it("reports TRUE when the update succeeds — this call performed the flip", async () => {
    const { db } = fakeDb();
    expect(
      await new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac")
    ).toBe(true);
  });

  it("SETS the terminal status and records WHO withdrew it, and WHEN", async () => {
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac");

    const [input] = sent;
    expect(input.UpdateExpression).toContain("#status = :revoked");
    expect(input.UpdateExpression).toContain("revokedAt = :now");
    expect(input.UpdateExpression).toContain("revokedBy = :actor");
    expect(input.ExpressionAttributeNames?.["#status"]).toBe("status");
    expect(input.ExpressionAttributeValues?.[":revoked"]).toBe("REVOKED");
    expect(input.ExpressionAttributeValues?.[":actor"]).toBe("fac");
    expect(String(input.ExpressionAttributeValues?.[":now"])).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
  });

  it("KEEPS THE ROW — it is an UpdateExpression, never a delete", async () => {
    // The design choice, asserted structurally: the row carries the provenance the
    // former-members view needs (who invited them, when they accepted). A `revoke`-style
    // implementation would pass a "the join is refused afterwards" test and silently destroy
    // that, so the assertion is that nothing here removes anything.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac");

    const [input] = sent;
    expect(input.UpdateExpression?.startsWith("SET ")).toBe(true);
    expect(input.UpdateExpression).not.toContain("REMOVE");
    // Nothing that would clear the provenance fields.
    expect(input.UpdateExpression).not.toContain("acceptedAt");
    expect(input.UpdateExpression).not.toContain("invitedBy");
  });

  it("guards on BOTH the row existing AND it not already being REVOKED", async () => {
    // attribute_exists  — no UPSERT. Without it, revoking a member who was never invited
    //                     FABRICATES a REVOKED invitation for their address, which the
    //                     former-members view would then read as provenance that never was.
    // #status <> :revoked — IDEMPOTENT. `revokedAt` records the FIRST withdrawal and never
    //                     moves, which matters because operators retry removals.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac");

    const [input] = sent;
    expect(input.ConditionExpression).toContain("attribute_exists(teamId)");
    expect(input.ConditionExpression).toContain("#status <> :revoked");
  });

  it("does NOT require the row to be ACCEPTED — a PENDING row is withdrawn too", async () => {
    // A member can hold a PENDING row (they joined by code before the sign-in flip landed,
    // or the flip failed and was never reconciled), and that row admits a join exactly as an
    // ACCEPTED one used to. Both terminal states are refused by the join gate, so the two
    // cases converge on the same answer.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac");

    expect(sent[0].ConditionExpression).not.toContain(":accepted");
    expect(sent[0].ConditionExpression).not.toContain("= :status");
  });

  it("lower-cases the email in the KEY, matching how rows are written", async () => {
    // The sort key. A mixed-case key misses the row, and the miss arrives as a
    // ConditionalCheckFailedException — which reads as the benign "nothing to revoke". So a
    // casing bug here would leave a live grant behind and report a clean removal.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).markRevoked("t1", "Me@Example.COM", "fac");

    expect(sent[0].Key).toEqual({ teamId: "t1", email: "me@example.com" });
  });

  it("reports FALSE — not an error — when the condition does not hold", async () => {
    // "No invitation for this member" and "already REVOKED" are both benign and both arrive
    // as this one exception. False is what makes a repeated removal idempotent without the
    // route needing a read-before-write.
    const { db } = fakeDb(conditionalCheckFailed());
    expect(
      await new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac")
    ).toBe(false);
  });

  it("RETHROWS a real store failure so the removal can report an INCOMPLETE revoke", async () => {
    // A swallowed failure here is how a removed person keeps a live way back in while the
    // operator is told the removal was clean. The route catches this and answers
    // `invitationRevokeComplete: false`, which is worth an alarm.
    for (const name of [
      "ProvisionedThroughputExceededException",
      "TimeoutError",
      "AccessDeniedException",
    ]) {
      const { db } = fakeDb(Object.assign(new Error(name), { name }));
      await expect(
        new DynamoInvitationRepository(db).markRevoked("t1", "me@example.com", "fac")
      ).rejects.toThrow(name);
    }
  });
});

/**
 * DynamoInvitationRepository.clearWorkshop — the THIRD revoke, and the narrowest.
 *
 * WHY THERE ARE NOW THREE, each destroying a different amount:
 *
 *   revoke()         DELETES an un-redeemed row.
 *   markRevoked()    FLIPS status to REVOKED, keeping the row. Withdraws the WHOLE grant.
 *   clearWorkshop()  REMOVES ONE ATTRIBUTE. Withdraws the WORKSHOP entitlement only; the row,
 *                    its `status`, its `acceptedAt` and its provenance all survive.
 *
 * WHY IT NEEDS ITS OWN SPECS HERE, over and above the route tests: the mechanism is `REMOVE
 * workshopId` plus `attribute_exists(workshopId)`, and BOTH are strings DynamoDB evaluates and
 * the in-memory fake does not. A `SET workshopId = :empty` implementation would pass every route
 * test in the repo (the entitlement route's reader happens to test truthiness) while leaving an
 * attribute present for any future reader that tests PRESENCE — and a missing
 * `attribute_exists(workshopId)` would re-stamp `workshopRevokedAt` on every double-click and let
 * two concurrent calls both write an audit entry for one withdrawal.
 */
describe("DynamoInvitationRepository.clearWorkshop — the entitlement withdrawal", () => {
  it("reports TRUE when the update succeeds — this call withdrew the entitlement", async () => {
    const { db } = fakeDb();
    expect(
      await new DynamoInvitationRepository(db).clearWorkshop(
        "PLATFORM",
        "judge@example.com",
        "admin-1"
      )
    ).toBe(true);
  });

  it("REMOVES the attribute rather than blanking it", async () => {
    // ⚠ THE ASSERTION THIS BLOCK EXISTS FOR. `Invitation.workshopId`'s contract is that ABSENT
    // means "no workshop grant" — an empty string is still an attribute, and a reader that
    // tested presence rather than truthiness would see a grant. `REMOVE` is what makes every
    // reader, including a future one, agree there is none.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).clearWorkshop(
      "PLATFORM",
      "judge@example.com",
      "admin-1"
    );

    const [input] = sent;
    expect(input.UpdateExpression).toContain("REMOVE workshopId");
    // No assignment of any kind to the field.
    expect(input.UpdateExpression).not.toContain("workshopId = ");
  });

  it("writes the breadcrumb in the SAME update as the removal", async () => {
    // ONE UpdateExpression, so `workshopRevokedBy` cannot land without the removal or vice
    // versa — and so the actor is durable BEFORE the route's audit call, which is what keeps
    // the operator recoverable from the row when the trail write fails
    // (UnauditedAccessChangeAlarm's runbook step 3).
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).clearWorkshop(
      "PLATFORM",
      "judge@example.com",
      "admin-1"
    );

    const [input] = sent;
    expect(input.UpdateExpression).toContain("workshopRevokedAt = :now");
    expect(input.UpdateExpression).toContain("workshopRevokedBy = :actor");
    expect(input.ExpressionAttributeValues?.[":actor"]).toBe("admin-1");
    expect(typeof input.ExpressionAttributeValues?.[":now"]).toBe("string");
    // Exactly ONE command — never a read-then-write, which would race two concurrent
    // withdrawals into two timestamps.
    expect(sent).toHaveLength(1);
  });

  it("TOUCHES NOTHING ELSE — status, acceptance and provenance all survive", async () => {
    // THE WHOLE DIFFERENCE FROM markRevoked, and the reason the route may work on a terminal
    // row the DELETE refuses with 409: clearing one attribute destroys no history. An
    // implementation that also flipped `status` would pass an "the entitlement is gone" test
    // while falsifying the acceptance record.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).clearWorkshop(
      "PLATFORM",
      "judge@example.com",
      "admin-1"
    );

    const expression = sent[0].UpdateExpression ?? "";
    for (const field of [
      "status",
      "acceptedAt",
      "acceptedBy",
      "invitedBy",
      "sentAt",
      "platformRole",
      "revokedAt",
      "revokedBy",
    ]) {
      expect(expression).not.toContain(field);
    }
    // No `#status` alias bound either, which is what a status write would need.
    expect(sent[0].ExpressionAttributeNames).toBeUndefined();
  });

  it("guards on BOTH the row existing AND it still carrying a workshopId", async () => {
    // attribute_exists(teamId)      — no UPSERT. Without it, withdrawing the entitlement of an
    //                                 address nobody invited FABRICATES a row carrying
    //                                 `workshopRevokedBy` and no invitation: provenance for a
    //                                 grant that never existed.
    // attribute_exists(workshopId)  — IDEMPOTENT. The second and every later call is a no-op AT
    //                                 THE STORE, so `workshopRevokedAt` records the FIRST
    //                                 withdrawal and never moves, and two concurrent calls
    //                                 resolve to exactly one winner — they cannot both report
    //                                 success and write two audit entries.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).clearWorkshop(
      "PLATFORM",
      "judge@example.com",
      "admin-1"
    );

    const [input] = sent;
    expect(input.ConditionExpression).toContain("attribute_exists(teamId)");
    expect(input.ConditionExpression).toContain("attribute_exists(workshopId)");
  });

  it("does NOT require any particular STATUS — an ACCEPTED row is the point", async () => {
    // ⚠ THE INVERSION OF THE DELETE ROUTE'S GATE 4, at the store. A `#status <> :accepted`
    // condition here would reproduce defect P1-2 one layer down: a registered judge's
    // entitlement would be un-withdrawable again, which is the defect this method exists for.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).clearWorkshop(
      "PLATFORM",
      "judge@example.com",
      "admin-1"
    );

    const condition = sent[0].ConditionExpression ?? "";
    expect(condition).not.toContain("status");
    expect(condition).not.toContain(":accepted");
    expect(condition).not.toContain(":revoked");
  });

  it("lower-cases the email in the KEY, matching how rows are written", async () => {
    // The sort key. A mixed-case key misses the row, and the miss arrives as a
    // ConditionalCheckFailedException — which reads as the benign "nothing to withdraw". So a
    // casing bug here would leave a live entitlement behind and report a clean withdrawal.
    const { db, sent } = fakeDb();
    await new DynamoInvitationRepository(db).clearWorkshop(
      "PLATFORM",
      "Judge@Example.COM",
      "admin-1"
    );

    expect(sent[0].Key).toEqual({ teamId: "PLATFORM", email: "judge@example.com" });
  });

  it("reports FALSE — not an error — when the condition does not hold", async () => {
    // "No invitation for this address on this team" and "the row carries no workshopId" are
    // both benign and both arrive as this one exception. False is what makes a retried
    // withdrawal idempotent without the route needing a read-before-write, and it is what the
    // route's audit and metric guards key on.
    const { db } = fakeDb(conditionalCheckFailed());
    expect(
      await new DynamoInvitationRepository(db).clearWorkshop(
        "PLATFORM",
        "judge@example.com",
        "admin-1"
      )
    ).toBe(false);
  });

  it("RETHROWS a real store failure, so the route answers 5xx rather than a false success", async () => {
    // A swallowed failure here would tell an operator a judge lost their workshop access while
    // the judge kept reading it. The route does not catch this — Hono answers 5xx and nothing
    // has been written, which is the fail-closed direction for a withdrawal.
    for (const name of [
      "ProvisionedThroughputExceededException",
      "TimeoutError",
      "AccessDeniedException",
    ]) {
      const { db } = fakeDb(Object.assign(new Error(name), { name }));
      await expect(
        new DynamoInvitationRepository(db).clearWorkshop(
          "PLATFORM",
          "judge@example.com",
          "admin-1"
        )
      ).rejects.toThrow(name);
    }
  });
});

/**
 * DynamoAuditRepository.listByTeam — the FORMER MEMBERS read.
 *
 * WHY THIS FILE, and not just the route tests: the whole read depends on an INDEX NAME and a
 * sort direction, neither of which the in-memory fake evaluates. A typo in `teamId-index`
 * would type-check, lint, pass every route test, and then fail at runtime with a
 * ValidationException the first time a facilitator opened the page. The absence of a
 * FilterExpression is asserted for the same reason — it is a correctness property, not a
 * style choice.
 */
describe("DynamoAuditRepository.listByTeam — the per-team trail", () => {
  /** A fake DocClient that records the input and returns the given items. */
  function fakeQuery(items: unknown[] = []) {
    const sent: UpdateInput[] = [];
    const db = {
      async send(cmd: { input: UpdateInput }) {
        sent.push(cmd.input);
        return { Items: items };
      },
    };
    return { db: db as unknown as DocClient, sent };
  }

  it("QUERIES THE teamId-index — the base table cannot answer this without a Scan", async () => {
    // The index NAME is the load-bearing string. The base table is subjectId HASH / at RANGE,
    // so "every removal from team X" would otherwise be a Scan of a table that only ever
    // grows and is never pruned (no TTL, deliberately). A per-team roster view cannot sit on
    // a Scan. Must match the GSI in the infrastructure CloudFormation template exactly.
    const { db, sent } = fakeQuery();
    await new DynamoAuditRepository(db).listByTeam("t1");

    expect(sent[0].IndexName).toBe("teamId-index");
    expect(sent[0].KeyConditionExpression).toBe("teamId = :t");
    expect(sent[0].ExpressionAttributeValues?.[":t"]).toBe("t1");
  });

  it("returns NEWEST FIRST, so the route needs no in-memory sort", async () => {
    // ScanIndexForward: false against the `<ISO>#<ulid>` range key. The route relies on this
    // for "one row per person, their MOST RECENT removal": it keeps the FIRST entry it sees
    // per subject, which is only correct if the order is newest-first.
    const { db, sent } = fakeQuery();
    await new DynamoAuditRepository(db).listByTeam("t1");

    expect(sent[0].ScanIndexForward).toBe(false);
  });

  it("does NOT filter on `action` at the store", async () => {
    // DynamoDB applies a FilterExpression AFTER the Limit, so filtering here would return
    // FEWER rows than asked for — and a short list on an audit-derived view reads as "there
    // were no more removals". The route filters what it got; this asserts the store does not.
    const { db, sent } = fakeQuery();
    await new DynamoAuditRepository(db).listByTeam("t1");

    expect(sent[0].FilterExpression).toBeUndefined();
  });

  it("CLAMPS the page size into [1, 100], sharing the bound with listBySubject", async () => {
    // An unbounded Limit is a way for one request to pull an arbitrary slab of an append-only
    // table. Both reads share the clamp so a caller cannot learn one bound from the subject
    // view and get another from the team view.
    for (const [asked, expected] of [
      [50, 50],
      [1000, 100],
      [0, 1],
      [-5, 1],
    ] as const) {
      const { db, sent } = fakeQuery();
      await new DynamoAuditRepository(db).listByTeam("t1", asked);
      expect(sent[0].Limit, `asked ${asked}`).toBe(expected);
    }
  });

  it("answers an empty array when the query returns no Items", async () => {
    // Not undefined — the route iterates it directly.
    const db = {
      async send() {
        return {};
      },
    } as unknown as DocClient;

    expect(await new DynamoAuditRepository(db).listByTeam("t1")).toEqual([]);
  });
});

/**
 * ── THE INVERTED DEFAULT — `get()` AND `listByTeam()` REFUSE A DEACTIVATED ROW ──
 *
 * THE MOST IMPORTANT BLOCK IN THIS FILE, because this is the single mechanism the whole
 * reactivation change rests on.
 *
 * Member removal used to be a HARD DELETE, chosen over a soft-delete flag on the grounds that
 * a flag "needs every reader to filter it, and missing one silently restores access". That
 * objection was correct. It is answered STRUCTURALLY, HERE, ONCE: the row now survives as
 * INACTIVE and the DEFAULT READS refuse to return it. Every authorization path on the platform
 * already treats "no row" as "not a member", so an inactive membership grants nothing at every
 * one of them WITH NO CHANGE TO ANY OF THEM — and forgetting to handle inactive DENIES rather
 * than grants.
 *
 * WHICH MEANS A "SIMPLIFICATION" HERE IS A PLATFORM-WIDE LEAK. `return (res.Item as TeamMember)
 * ?? null` would type-check, lint, and pass every route test written against a faithful fake —
 * while re-granting a removed person all six content surfaces at once. These tests are what
 * makes that mutation fail by name, at the site that would carry the bug.
 *
 * Asserted against the RAW ITEM the store returns, not through a fake that already filters, so
 * the filtering under test is the repository's own.
 */
describe("DynamoTeamMemberRepository — a deactivated row is not a membership", () => {
  /** A fake DocClient returning a fixed Item for Get and Items for Query. */
  function fakeReads(item?: unknown, items?: unknown[]) {
    const sent: UpdateInput[] = [];
    const db = {
      async send(cmd: { input: UpdateInput }) {
        sent.push(cmd.input);
        return items !== undefined ? { Items: items } : { Item: item };
      },
    };
    return { db: db as unknown as DocClient, sent };
  }

  const ACTIVE_ROW = {
    teamId: "t1",
    userId: "u1",
    role: "LEAD",
    joinedAt: "2026-08-01T00:00:00.000Z",
  };
  const INACTIVE_ROW = {
    ...ACTIVE_ROW,
    status: "INACTIVE",
    removedAt: "2026-08-04T10:00:00.000Z",
    removedBy: "fac",
    removedByRole: "FACILITATOR",
  };

  it("get() returns NULL for an INACTIVE row — indistinguishable from no row at all", async () => {
    // THE LOAD-BEARING ASSERTION OF THE WHOLE CHANGE. This is the authorization read behind
    // canRead, canReadTeamContent and therefore every content surface in five services.
    const { db } = fakeReads(INACTIVE_ROW);
    expect(await new DynamoTeamMemberRepository(db).get("t1", "u1")).toBeNull();
  });

  it("get() returns the row for an ACTIVE one — so the test above is about the STATUS", async () => {
    const { db } = fakeReads(ACTIVE_ROW);
    expect(await new DynamoTeamMemberRepository(db).get("t1", "u1")).toMatchObject({
      userId: "u1",
      role: "LEAD",
    });
  });

  it("get() returns a row whose status is ABSENT — the FORCED polarity", async () => {
    // Every membership row in the table today carries NO status attribute, so reading absence
    // as INACTIVE would revoke the whole platform's team access on deploy. That is a lockout,
    // which is worse than a leak that does not exist yet because nothing has been deactivated.
    // Same fail-open-on-absence rule as isSpentInvitation and isExpired: test for the DENY
    // value, never for equality with "ACTIVE".
    const { db } = fakeReads(ACTIVE_ROW);
    expect(await new DynamoTeamMemberRepository(db).get("t1", "u1")).not.toBeNull();
  });

  it("get() refuses whatever CASING the status was written in", async () => {
    // The constant is COPIED into the docs service's bundle, which reads this table directly
    // (no NAT route to the Team API). A casing difference between the copies must not be the
    // thing that decides whether a removed person still has access.
    for (const status of ["INACTIVE", "inactive", "Inactive", " inactive "]) {
      const { db } = fakeReads({ ...ACTIVE_ROW, status });
      expect(await new DynamoTeamMemberRepository(db).get("t1", "u1"), status).toBeNull();
    }
  });

  it("getIncludingInactive() DOES return the deactivated row — the named exception", async () => {
    // The dangerous-by-name variant, and the reason it is named that way: the reactivation
    // route and the removal route both need to know a deactivated row EXISTS, which get()
    // deliberately cannot answer. Nothing may use this as an authorization source.
    const { db } = fakeReads(INACTIVE_ROW);
    expect(
      await new DynamoTeamMemberRepository(db).getIncludingInactive("t1", "u1")
    ).toMatchObject({ status: "INACTIVE", role: "LEAD" });
  });

  it("listByTeam() OMITS inactive rows, keeping counts and rosters correct untouched", async () => {
    // Member counts are derived from this array's length, so an unfiltered list inflates every
    // count on the platform — the workshop roster's `_count.members`, the `?withMembers=1`
    // fan-out, the directory's id resolution.
    const { db } = fakeReads(undefined, [ACTIVE_ROW, { ...INACTIVE_ROW, userId: "gone" }]);
    const rows = await new DynamoTeamMemberRepository(db).listByTeam("t1");
    expect(rows.map((m) => m.userId)).toEqual(["u1"]);
  });

  it("listByTeamIncludingInactive() returns BOTH — the roster's one caller", async () => {
    const { db } = fakeReads(undefined, [ACTIVE_ROW, { ...INACTIVE_ROW, userId: "gone" }]);
    const rows = await new DynamoTeamMemberRepository(db).listByTeamIncludingInactive("t1");
    expect(rows.map((m) => m.userId)).toEqual(["u1", "gone"]);
  });

  it("listByUser() omits a team the person was REMOVED from", async () => {
    // Backs /teams/mine, the workshop entitlement union and the roster intersection — all of
    // which mean "teams this person is on". A team they were removed from is not one.
    const { db } = fakeReads(undefined, [
      { ...INACTIVE_ROW, teamId: "t1" },
      { ...ACTIVE_ROW, teamId: "t2" },
    ]);
    const rows = await new DynamoTeamMemberRepository(db).listByUser("u1");
    expect(rows.map((m) => m.teamId)).toEqual(["t2"]);
  });

  it("filters in CODE, with no FilterExpression on either list", async () => {
    // Deliberate, and a correctness property rather than a style choice: a DynamoDB
    // FilterExpression is applied AFTER the Limit, so on a paginated read it returns short
    // pages that read as "there are no more members". Writing it in code also keeps the two
    // list methods reading the SAME rows and differing only in what they return, so they
    // cannot drift into disagreeing about what a roster is.
    const { db, sent } = fakeReads(undefined, [ACTIVE_ROW]);
    await new DynamoTeamMemberRepository(db).listByTeam("t1");
    expect(sent[0].FilterExpression).toBeUndefined();
    expect(sent[0].KeyConditionExpression).toBe("teamId = :teamId");
  });
});

/**
 * DynamoTeamMemberRepository.deactivate / .reactivate — the two CONDITIONAL flips.
 *
 * The removal KEEPS the row now, so both of these are UpdateItems whose whole correctness lives
 * in a ConditionExpression — a string the in-memory fake does not evaluate. Missing conditions
 * would type-check, lint, pass every route test, and then:
 *
 *   deactivate without `attribute_exists`  ⇒ removing a never-member FABRICATES an inactive row
 *   deactivate without `#status <> :inactive` ⇒ a retried removal re-stamps `removedAt`, losing
 *                                            the evidence of when access was withdrawn
 *   reactivate without `attribute_exists`  ⇒ THE SERIOUS ONE. An UpdateCommand CREATES the item
 *                                            when the key does not match, so this route becomes
 *                                            a way to add an ARBITRARY user to an ARBITRARY
 *                                            team, bypassing every invitation gate
 *   reactivate without `#status = :inactive` ⇒ two concurrent calls both "succeed" and write two
 *                                            audit entries for one restoration
 */
describe("DynamoTeamMemberRepository.deactivate — the removal that keeps the row", () => {
  it("KEEPS THE ROW — a SET, never a delete, and nothing that clears the history", async () => {
    // The behaviour change asserted structurally. `role` and `joinedAt` are what reactivation
    // restores, so an implementation that cleared either would pass a "no access afterwards"
    // test and silently destroy the ability to restore someone as what they were.
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "fac", "FACILITATOR", "w1");

    const [input] = sent;
    expect(input.UpdateExpression?.startsWith("SET ")).toBe(true);
    expect(input.UpdateExpression).not.toContain("REMOVE");
    expect(input.UpdateExpression).not.toContain("role");
    expect(input.UpdateExpression).not.toContain("joinedAt");
  });

  it("marks it INACTIVE and records WHO removed them, their ROLE, and WHEN", async () => {
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "fac", "FACILITATOR", "w1");

    const [input] = sent;
    expect(input.UpdateExpression).toContain("#status = :inactive");
    expect(input.UpdateExpression).toContain("removedAt = :now");
    expect(input.UpdateExpression).toContain("removedBy = :actor");
    expect(input.UpdateExpression).toContain("removedByRole = :actorRole");
    // The reserved-word alias and every value must be bound, or DynamoDB rejects the request
    // with a ValidationException at runtime — which the expression string alone would not show.
    expect(input.ExpressionAttributeNames?.["#status"]).toBe("status");
    expect(input.ExpressionAttributeValues?.[":inactive"]).toBe("INACTIVE");
    expect(input.ExpressionAttributeValues?.[":actor"]).toBe("fac");
    expect(input.ExpressionAttributeValues?.[":actorRole"]).toBe("FACILITATOR");
    expect(String(input.ExpressionAttributeValues?.[":now"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("guards on BOTH the row existing AND it not already being INACTIVE", async () => {
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "fac", "FACILITATOR", "w1");

    const [input] = sent;
    expect(input.ConditionExpression).toContain("attribute_exists(teamId)");
    expect(input.ConditionExpression).toContain("#status <> :inactive");
  });

  it("reports FALSE — not an error — when the condition does not hold", async () => {
    // "No membership row" and "already INACTIVE" are both benign, and both
    // arrive as a cancelled TRANSACTION naming the MEMBER item. False is what lets the route
    // skip a second audit entry without a read-before-write, which would be a race anyway.
    const { db } = fakeDb(transactionCancelled([true]));
    expect(
      await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "fac", "FACILITATOR", "w1")
    ).toBe(false);
  });

  it("RETHROWS a real store failure rather than reporting a removal that did not happen", async () => {
    // The one outcome this whole path exists to prevent: a deactivation that silently fails
    // leaves the person with FULL ACCESS while the operator is told they were removed.
    for (const name of [
      "ProvisionedThroughputExceededException",
      "TimeoutError",
      "AccessDeniedException",
    ]) {
      const { db } = fakeDb(Object.assign(new Error(name), { name }));
      await expect(
        new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "fac", "FACILITATOR", "w1")
      ).rejects.toThrow(name);
    }
  });
});

describe("DynamoTeamMemberRepository.reactivate — the conditional restoration", () => {
  it("REFUSES TO UPSERT — attribute_exists is what stops this route fabricating a membership", async () => {
    // ⚠ THE MOST DANGEROUS MISSING CONDITION ON THIS PATH. An UpdateCommand CREATES the item
    // when the key does not match, so without `attribute_exists(teamId)` this route would add
    // an ARBITRARY user to an ARBITRARY team — a privilege-granting upsert reachable by anyone
    // who may write the team, bypassing every invitation gate including the workshop-scope and
    // role checks. Re-admitting a never-member is an invitation, not a reactivation.
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1");
    expect(sent[0].ConditionExpression).toContain("attribute_exists(teamId)");
  });

  it("requires the row to be ACTUALLY DEACTIVATED — positive equality, not `<>`", async () => {
    // The only flip in this service whose precondition is a SPECIFIC state rather than "not yet
    // terminal". It is what makes two concurrent reactivations resolve to exactly ONE winner at
    // the store, so they cannot both report success and write two audit entries.
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1");

    const [input] = sent;
    expect(input.ConditionExpression).toContain("#status = :inactive");
    expect(input.ExpressionAttributeValues?.[":inactive"]).toBe("INACTIVE");
  });

  it("does NOT write the ROLE — the restored member returns as whatever they were", async () => {
    // ── HOW THE ROLE IS RESTORED: BY NOT TOUCHING IT ──
    //
    // The row kept `role` through the removal, so a LEAD comes back a LEAD. Reconstructing it
    // from an invitation would be a guess, and re-defaulting it to BUILDER would silently
    // DEMOTE every restored lead — which no test asserting "access is back" would catch.
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1");
    expect(sent[0].UpdateExpression).not.toContain("role");
  });

  it("does NOT clear the removal history — no REMOVE of removedAt/removedBy", async () => {
    // They are the record of the removal that HAPPENED. Clearing them would erase history to
    // tidy a row, and `status` is the only field that says what holds now — which is why every
    // reader is keyed on it and not on the presence of `removedAt`.
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1");

    const [input] = sent;
    expect(input.UpdateExpression?.startsWith("SET ")).toBe(true);
    expect(input.UpdateExpression).not.toContain("REMOVE");
    expect(input.UpdateExpression).not.toContain("removedAt");
    expect(input.UpdateExpression).not.toContain("removedBy");
  });

  it("sets the status ACTIVE and stamps the restoration breadcrumb", async () => {
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1");

    const [input] = sent;
    expect(input.UpdateExpression).toContain("#status = :active");
    expect(input.UpdateExpression).toContain("reactivatedAt = :now");
    expect(input.UpdateExpression).toContain("reactivatedBy = :actor");
    expect(input.ExpressionAttributeNames?.["#status"]).toBe("status");
    expect(input.ExpressionAttributeValues?.[":active"]).toBe("ACTIVE");
    expect(input.ExpressionAttributeValues?.[":actor"]).toBe("admin");
    expect(String(input.ExpressionAttributeValues?.[":now"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports ALREADY-MEMBER when the member item's condition does not hold", async () => {
    // Already ACTIVE, or no row at all. The caller MUST disambiguate those two with
    // getIncludingInactive: one is a 200 (idempotent) and the other a 404, and reporting
    // success for a person who is not on the team would be a lie.
    //
    // Returns an AdmitOutcome rather than a boolean, because reactivation now
    // has a THIRD answer — "full" — when restoring somebody would exceed the seat cap. A
    // boolean could not carry that, and squeezing an extra member in was the alternative.
    const { db } = fakeDb(transactionCancelled([true]));
    expect(
      await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1")
    ).toBe("already-member");
  });

  it("reports FULL when the TEAM item's condition fails — the cap refuses a restoration", async () => {
    // The mandatory distinction: item 1 failing means the seat ledger was at
    // its cap, which is a different answer from "you are already on the team" and must reach the
    // route as one. Restoring somebody into a full team is REFUSED, not squeezed in.
    const { db } = fakeDb(transactionCancelled([false, true]));
    expect(
      await new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1")
    ).toBe("full");
  });

  it("RETHROWS a real store failure", async () => {
    // This route's entire purpose IS the flip, so a caller told the member was restored when
    // the write failed has been misinformed about the only thing they asked for.
    for (const name of ["ProvisionedThroughputExceededException", "AccessDeniedException"]) {
      const { db } = fakeDb(Object.assign(new Error(name), { name }));
      await expect(
        new DynamoTeamMemberRepository(db).reactivate("t1", "u1", "admin", "w1")
      ).rejects.toThrow(name);
    }
  });

  it("keys BOTH flips on (teamId, userId) — the table's composite key", async () => {
    // A wrong key misses the row and the miss arrives as a ConditionalCheckFailedException,
    // which reads as the benign "nothing to do". So a keying bug would report a clean removal
    // while leaving the person's access intact — the same failure shape as the invitation
    // revoke's lower-casing bug.
    const { db: db1, sent: sent1 } = fakeDb();
    await new DynamoTeamMemberRepository(db1).deactivate("t1", "u1", "fac", "FACILITATOR", "w1");
    expect(sent1[0].Key).toEqual({ teamId: "t1", userId: "u1" });

    const { db: db2, sent: sent2 } = fakeDb();
    await new DynamoTeamMemberRepository(db2).reactivate("t1", "u1", "admin", "w1");
    expect(sent2[0].Key).toEqual({ teamId: "t1", userId: "u1" });
  });
});

// ─── DynamoTeamRepository.listDirectory — the bounded, filtered, paged Scan ──────────

/**
 * THE TEAMS DIRECTORY's store read, tested against a fake that reproduces the ONE DynamoDB
 * behaviour this code exists to survive: a FilterExpression is applied AFTER Limit, and
 * LastEvaluatedKey is set whenever a Scan stops on Limit — even if it stopped on the last
 * matching row.
 *
 * That combination is why a naive implementation is wrong in TWO directions at once. It returns
 * a short page while more matches lie further on (a search that finds nothing), and it hands out
 * a cursor to an empty page (a "Next" button onto nothing). The second is real DynamoDB
 * behaviour, so the fake below models the paging semantics rather than
 * stubbing a tidy answer.
 *
 * The route-level tests use an in-memory fake repository, so they prove the ROUTE behaves given a
 * store that filters and pages. They cannot prove THIS is that store — the mechanism lives
 * entirely in a FilterExpression string and a hand-built cursor, neither of which a fake
 * evaluates.
 */

function directoryRow(over: Partial<Team> = {}): Team {
  return {
    workshopId: "w1",
    id: "t1",
    name: "Team Phoenix",
    description: null,
    inviteCode: "CODE1234",
    repoUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A fake DocClient that Scans an in-memory array with DynamoDB's ORDERING OF OPERATIONS: take
 * up to Limit rows from the ExclusiveStartKey, THEN drop the ones the filter rejects, and report
 * LastEvaluatedKey whenever the scan stopped because of Limit rather than because the data ran
 * out.
 *
 * THE TOP-LEVEL OPERATOR IS READ FROM THE EXPRESSION, not assumed. Applying the scope and the
 * search as two sequential filters — the obvious way to write this — makes the fake behave like
 * AND whatever the implementation sent, so an implementation that ORed them (search widening the
 * authorization scope) would still pass. Identity's equivalent fake records a mutation test that
 * caught exactly that. A fake that cannot tell the safe implementation from the leaky one is
 * worse than no test, because it reports the security property as covered.
 */
function fakeScanDb(rows: Team[]) {
  const calls: Array<{ limit?: number; startKey?: string; filter?: string }> = [];

  const db = {
    async send(cmd: {
      input: {
        Limit?: number;
        ExclusiveStartKey?: { workshopId: string; id: string };
        FilterExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }) {
      const { Limit, ExclusiveStartKey, FilterExpression, ExpressionAttributeValues } =
        cmd.input;
      calls.push({
        limit: Limit,
        startKey: ExclusiveStartKey?.id,
        filter: FilterExpression,
      });

      const from = ExclusiveStartKey
        ? rows.findIndex(
            (r) => r.workshopId === ExclusiveStartKey.workshopId && r.id === ExclusiveStartKey.id
          ) + 1
        : 0;
      // Rows READ — before any filtering. This is the crux of the behaviour.
      const window = rows.slice(from, from + (Limit ?? rows.length));
      const lastRead = window[window.length - 1];

      let items = window;
      if (FilterExpression) {
        const vals = ExpressionAttributeValues ?? {};
        const scopeValues = Object.entries(vals)
          .filter(([k]) => k.startsWith(":w"))
          .map(([, v]) => v as string);
        const needles = Object.entries(vals)
          .filter(([k]) => k.startsWith(":q"))
          .map(([, v]) => v as string);

        const matchesScope = (r: Team) =>
          scopeValues.length === 0 || scopeValues.includes(r.workshopId);
        // CASE-SENSITIVE, exactly like DynamoDB's own `contains`. The implementation's
        // two-form workaround is what has to bridge the gap — a case-insensitive fake would
        // let an implementation that sent only the raw needle pass.
        const matchesSearch = (r: Team) =>
          needles.length === 0 || needles.some((n) => r.name.includes(n));

        // The TOP-LEVEL operator, found by scanning at bracket depth 0. A naive
        // `/ OR /.test(expr)` is wrong: the search half is itself
        // `(contains(#name,:qLower) OR contains(#name,:qTitled))`, so a correct AND
        // expression contains " OR " inside its parentheses.
        const bothPresent = scopeValues.length > 0 && needles.length > 0;
        let isOr = false;
        if (bothPresent) {
          let depth = 0;
          for (let i = 0; i < FilterExpression.length; i++) {
            const ch = FilterExpression[i];
            if (ch === "(") depth++;
            else if (ch === ")") depth--;
            else if (depth === 0 && FilterExpression.startsWith(" OR ", i)) {
              isOr = true;
              break;
            }
          }
        }

        items = items.filter((r) =>
          isOr ? matchesScope(r) || matchesSearch(r) : matchesScope(r) && matchesSearch(r)
        );
      }

      const stoppedOnLimit = from + window.length < rows.length;
      return {
        Items: items,
        // Set whenever there is more table past the window — which DynamoDB reports
        // regardless of how many rows survived the filter.
        LastEvaluatedKey:
          stoppedOnLimit && lastRead
            ? { workshopId: lastRead.workshopId, id: lastRead.id }
            : undefined,
      };
    },
  };

  return { db: db as unknown as DocClient, calls };
}

describe("DynamoTeamRepository.listDirectory", () => {
  it("returns a page and a cursor, and the cursor names the LAST ROW RETURNED", async () => {
    // Derived from the last row we RETURN and not from LastEvaluatedKey, which points past the
    // discarded extra row — otherwise the next page skips it.
    const rows = [
      directoryRow({ id: "t1" }),
      directoryRow({ id: "t2" }),
      directoryRow({ id: "t3" }),
    ];
    const { db } = fakeScanDb(rows);

    const page = await new DynamoTeamRepository(db).listDirectory({ limit: 2 });

    expect(page.teams.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(
      JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString())
    ).toEqual({ workshopId: "w1", id: "t2" });
  });

  it("gives NO cursor when the table is exhausted, even though the Scan stopped on Limit", async () => {
    // The failure this exists to prevent: DynamoDB sets LastEvaluatedKey whenever a Scan stops
    // on Limit, INCLUDING on the last matching row, so trusting it hands out a cursor to an
    // empty page. Harmless-looking until the filter is a security boundary — a FACILITATOR
    // asking for 2 rows, getting 2, and receiving a cursor has been told another row exists.
    const { db } = fakeScanDb([directoryRow({ id: "t1" }), directoryRow({ id: "t2" })]);

    const page = await new DynamoTeamRepository(db).listDirectory({ limit: 2 });

    expect(page.teams).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it("asks for ONE MORE row than the page needs — the only reliable has-more signal", async () => {
    const { db, calls } = fakeScanDb([directoryRow()]);

    await new DynamoTeamRepository(db).listDirectory({ limit: 10 });

    expect(calls[0].limit).toBe(11);
  });

  it("KEEPS SCANNING to fill a page a filter emptied, rather than returning short", async () => {
    // A FilterExpression is applied AFTER Limit, so without the loop a search for a team that
    // sorts late returns an EMPTY page while the match is two rows further on — a search that
    // finds nothing. Bounded by MAX_DIRECTORY_SCAN_ROUND_TRIPS, so it is a loop and not a walk.
    const rows = [
      directoryRow({ id: "t1", name: "Team Griffin" }),
      directoryRow({ id: "t2", name: "Team Griffin" }),
      directoryRow({ id: "t3", name: "Team Phoenix" }),
    ];
    const { db, calls } = fakeScanDb(rows);

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 1,
      search: "phoenix",
    });

    expect(page.teams.map((t) => t.id)).toEqual(["t3"]);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("STOPS at the round-trip cap and REPORTS it with a cursor, not a silent truncation", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      directoryRow({ id: `t${i}`, name: "Team Griffin" })
    );
    const { db, calls } = fakeScanDb(rows);

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 5,
      search: "nothingmatchesthis",
    });

    // 5 round trips: MAX_DIRECTORY_SCAN_ROUND_TRIPS. Not a full table walk.
    expect(calls).toHaveLength(5);
    expect(page.teams).toEqual([]);
    // REPORTED. The page is empty and the table is not, so the bound is surfaced as a live cursor
    // — which is what "not a silent truncation" means.
    expect(page.nextCursor).toBeDefined();
    // A cursor this repository would ACCEPT back: exactly the key schema, both keys non-empty
    // strings. A fallback key that failed decodeDirectoryCursor's own shape check would be a
    // "Next" that silently restarts at page one forever.
    const decoded = JSON.parse(
      Buffer.from(page.nextCursor!, "base64url").toString()
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(["id", "workshopId"]);
    expect(decoded.workshopId).toBe("w1");
    // The LAST ROW READ, not the last row returned — there was no returned row. That is what makes
    // the next request CONTINUE rather than re-read the same rejected window. Derived, not observed:
    // 5 trips × (limit + 1) = 30 rows evaluated, so the scan stopped on the row at index 29.
    expect(decoded.id).toBe("t29");
  });

  it("pushes the WORKSHOP SCOPE into the FilterExpression, not a post-filter", async () => {
    // DynamoDB bills and returns rows BEFORE the filter, so a post-filter would already have
    // shipped out-of-scope rows into this process. More importantly: the only method able to
    // enumerate teams is also the one that applies the restriction.
    const { db, calls } = fakeScanDb([directoryRow()]);

    await new DynamoTeamRepository(db).listDirectory({ workshopIds: ["w1", "w2"] });

    expect(calls[0].filter).toContain("workshopId IN (:w0, :w1)");
  });

  it("returns NOTHING for an EMPTY scope, without touching the store", async () => {
    // The polarity that matters most in this file. Building `IN ()` is a syntax error, and —
    // far worse — omitting the filter for an empty list turns "sees no workshops" into "sees
    // every team on the platform".
    const { db, calls } = fakeScanDb([directoryRow(), directoryRow({ id: "t2" })]);

    const page = await new DynamoTeamRepository(db).listDirectory({ workshopIds: [] });

    expect(page.teams).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("sends NO FilterExpression when there is no scope and no search", async () => {
    // The ADMIN, unfiltered path. An empty-string FilterExpression is a validation error, so
    // "no restriction" has to mean the key is absent.
    const { db, calls } = fakeScanDb([directoryRow()]);

    await new DynamoTeamRepository(db).listDirectory({});

    expect(calls[0].filter).toBeUndefined();
  });

  it("ANDs the scope and the search at the TOP LEVEL — search never widens the scope", async () => {
    // THE security property. If the two halves were ORed, a needle would be a way to confirm
    // that a team in a workshop the caller does not own exists.
    const rows = [
      directoryRow({ workshopId: "w1", id: "t1", name: "Team Phoenix" }),
      directoryRow({ workshopId: "w2", id: "t2", name: "Team Phoenix" }),
    ];
    const { db, calls } = fakeScanDb(rows);

    const page = await new DynamoTeamRepository(db).listDirectory({
      workshopIds: ["w1"],
      search: "Phoenix",
    });

    // The fake reads the operator off the expression, so this fails if the join is an OR.
    expect(page.teams.map((t) => t.id)).toEqual(["t1"]);
    expect(calls[0].filter).toContain(" AND ");
  });

  it("matches the name case-INSENSITIVELY by sending BOTH a lowered and a titled needle", async () => {
    // DynamoDB's `contains` is case-SENSITIVE and a FilterExpression has no lower(), so
    // "phoenix" alone would not match "Team Phoenix". The fake is case-sensitive on purpose:
    // an implementation that sent only the raw needle would fail here.
    const { db, calls } = fakeScanDb([directoryRow({ name: "Team Phoenix" })]);

    const page = await new DynamoTeamRepository(db).listDirectory({ search: "PHOENIX" });

    // Neither form matches "Team Phoenix" mid-string in this case ("phoenix" vs "Phoenix"),
    // so assert on what was SENT: both forms, and the reserved-word alias bound.
    expect(calls[0].filter).toContain("contains(#name, :qLower)");
    expect(calls[0].filter).toContain("contains(#name, :qTitled)");
    expect(page.teams).toBeDefined();
  });

  it("binds #name — `name` is a DynamoDB reserved word", async () => {
    // Without the alias the whole Scan is a ValidationException and the directory 500s for
    // every search. A missing alias type-checks and lints perfectly.
    const sent: Array<Record<string, string> | undefined> = [];
    const recording = {
      async send(cmd: { input: { ExpressionAttributeNames?: Record<string, string> } }) {
        sent.push(cmd.input.ExpressionAttributeNames);
        return { Items: [], LastEvaluatedKey: undefined };
      },
    } as unknown as DocClient;

    await new DynamoTeamRepository(recording).listDirectory({ search: "phoenix" });

    expect(sent[0]).toEqual({ "#name": "name" });
  });

  it("sends NO ExpressionAttributeNames when there is no search — an empty map is a 400", async () => {
    // DynamoDB REJECTS an empty ExpressionAttributeNames map rather than ignoring it, so the
    // scope-only path (a FACILITATOR browsing with no needle) has to omit the key entirely.
    // This is the single most likely way to break the FACILITATOR branch while every
    // search-carrying test still passes.
    const sent: Array<Record<string, string> | undefined> = [];
    const recording = {
      async send(cmd: { input: { ExpressionAttributeNames?: Record<string, string> } }) {
        sent.push(cmd.input.ExpressionAttributeNames);
        return { Items: [], LastEvaluatedKey: undefined };
      },
    } as unknown as DocClient;

    await new DynamoTeamRepository(recording).listDirectory({ workshopIds: ["w1"] });

    expect(sent[0]).toBeUndefined();
  });

  it("finds a MID-STRING match, so a needle need not be a prefix", async () => {
    const { db } = fakeScanDb([
      directoryRow({ id: "t1", name: "Team Phoenix" }),
      directoryRow({ id: "t2", name: "Team Griffin" }),
    ]);

    const page = await new DynamoTeamRepository(db).listDirectory({ search: "Phoenix" });

    expect(page.teams.map((t) => t.id)).toEqual(["t1"]);
  });

  it("CLAMPS the page size and floors a fractional one", async () => {
    // A caller asking for 10,000 gets MAX_DIRECTORY_PAGE_SIZE; one asking for 0 or a negative
    // gets 1. Bounded server-side, because the caller is a URL.
    const rows = Array.from({ length: 200 }, (_, i) => directoryRow({ id: `t${i}` }));

    for (const [asked, expected] of [
      [10_000, 100],
      [0, 1],
      [-5, 1],
      [2.7, 2],
    ] as const) {
      const { db } = fakeScanDb(rows);
      const page = await new DynamoTeamRepository(db).listDirectory({ limit: asked });
      expect(page.teams.length, String(asked)).toBe(expected);
    }
  });

  it("defaults to 50 rows when no limit is given", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => directoryRow({ id: `t${i}` }));
    const { db } = fakeScanDb(rows);

    expect((await new DynamoTeamRepository(db).listDirectory({})).teams).toHaveLength(50);
  });

  it("PAGES THROUGH EVERY ROW EXACTLY ONCE — no gap at a boundary, no repeat", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => directoryRow({ id: `t${i}` }));
    const repo = new DynamoTeamRepository(fakeScanDb(rows).db);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await repo.listDirectory({ limit: 2, cursor });
      seen.push(...result.teams.map((t) => t.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(cursor).toBeUndefined();
    expect(seen).toEqual(rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("treats a MALFORMED cursor as page one rather than throwing", async () => {
    // It comes back through a URL where a copy-paste can truncate or mangle it. Page one is a
    // harmless answer to an unreadable cursor; a 500 on the directory is not.
    const { db } = fakeScanDb([directoryRow({ id: "t1" }), directoryRow({ id: "t2" })]);

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 1,
      cursor: "not-base64-and-not-json",
    });

    expect(page.teams.map((t) => t.id)).toEqual(["t1"]);
  });

  it("scans the TEAMS table, with no IndexName — none of its GSIs can enumerate", async () => {
    // `teams` is (workshopId HASH, id RANGE) and both GSIs are point lookups, so there is no
    // index-backed form of this read. Asserted so a future "optimisation" onto id-index — which
    // would silently return one arbitrary row per id — is a test failure.
    const sent: Array<{ TableName?: string; IndexName?: string }> = [];
    const recording = {
      async send(cmd: { input: { TableName?: string; IndexName?: string } }) {
        sent.push(cmd.input);
        return { Items: [], LastEvaluatedKey: undefined };
      },
    } as unknown as DocClient;

    await new DynamoTeamRepository(recording).listDirectory({});

    expect(sent[0].TableName).toBe("praimana-teams");
    expect(sent[0].IndexName).toBeUndefined();
  });
});

// ─── DynamoInvitationRepository.listByEmail / .listByTeam — the PAGED reads (P2-2) ────

/**
 * THE TWO INVITATION LIST READS, which each used to issue ONE QueryCommand and return
 * `res.Items` — no `ExclusiveStartKey` loop, no `Limit`. So each returned DynamoDB's first 1MB
 * page and SILENTLY DROPPED the rest.
 *
 * WHY THAT WAS WORSE THAN ITS P2 LABEL. `listByEmail` feeds `GET /v1/entitlements/workshops`,
 * an AUTHORIZATION DECISION: a quietly short list UNDER-GRANTS, so a judge with many
 * invitations loses a workshop they actually hold and nothing anywhere reports it. It is also
 * the reactivation gate's only evidence, where a dropped row can be the row that would have
 * REFUSED.
 *
 * WHY THESE TESTS LIVE AT THIS LAYER AND CANNOT LIVE AT THE ROUTE. The mechanism is entirely in
 * what is SENT to the store — `ExclusiveStartKey` on the second trip, `Limit` on every trip —
 * and a route-level fake repository sees none of it. Yesterday three route tests passed in
 * `user-access` while the adapter dropped a field outright; that is exactly the gap this closes.
 * A `Limit`-less implementation type-checks, lints, and passes all 851 route tests in this
 * service while truncating an authorization union in production.
 *
 * THE BOUND IS ASSERTED AS A THROW, NOT AS A SHORT ARRAY. An array return has two channels and
 * only one of them is honest: a truncated array is indistinguishable from a complete answer at
 * every call site, so the refusal is the report. These specs assert the rejection AND that no
 * short list came back — the second half is the one that matters, because an implementation
 * that returned `found.slice(0, budget)` would satisfy a rejection-only test suite if it also
 * happened to throw for some other reason.
 */

/** The subset of a Query command's input these tests read. */
interface PagedQueryInput {
  TableName?: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  FilterExpression?: string;
  Limit?: number;
  ExclusiveStartKey?: Record<string, unknown>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

function invitationRow(over: Partial<Invitation> = {}): Invitation {
  return {
    teamId: "t1",
    email: "invitee@example.com",
    status: "PENDING",
    invitedBy: "fac-1",
    sentAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A fake DocClient that serves an in-memory array of rows with DynamoDB's PAGING semantics:
 * honour `Limit` and `ExclusiveStartKey`, and report `LastEvaluatedKey` whenever the query
 * stopped because of Limit rather than because the data ran out.
 *
 * ⚠ IT SETS LastEvaluatedKey EVEN WHEN IT STOPPED ON THE LAST MATCHING ROW, which is the real
 * store's documented behaviour (`listDirectory`'s comments record it). That is not incidental to this fake — it is what makes the over-fetch-by-one
 * in the implementation necessary, and a tidier fake would let an implementation that refused
 * every exactly-full complete answer pass.
 *
 * The cursor is the composite key (teamId, email), which is the invitations table's real key
 * schema — so a cursor built from the wrong attributes cannot resolve here either.
 */
function fakePagedQuery(rows: Invitation[]) {
  const sent: PagedQueryInput[] = [];

  const db = {
    async send(cmd: { input: PagedQueryInput }) {
      sent.push(cmd.input);
      const { Limit, ExclusiveStartKey } = cmd.input;

      const from = ExclusiveStartKey
        ? rows.findIndex(
            (r) =>
              r.teamId === ExclusiveStartKey.teamId && r.email === ExclusiveStartKey.email
          ) + 1
        : 0;
      const window = rows.slice(from, from + (Limit ?? rows.length));
      const lastRead = window[window.length - 1];
      // TRUE whenever there is more data past this window. Reported regardless of whether the
      // window filled the Limit exactly — see the note above.
      const stoppedOnLimit = from + window.length < rows.length;

      return {
        Items: window,
        LastEvaluatedKey:
          stoppedOnLimit && lastRead
            ? { teamId: lastRead.teamId, email: lastRead.email }
            : undefined,
      };
    },
  };

  return { db: db as unknown as DocClient, sent };
}

describe("DynamoInvitationRepository.listByEmail — paged, bounded, and refuses to truncate", () => {
  it("FOLLOWS LastEvaluatedKey — rows from BOTH pages, not just the first", async () => {
    // THE DEFECT, INVERTED. The old implementation issued one QueryCommand and returned
    // `res.Items`, so page two did not exist as far as this code was concerned. Three rows
    // through a store that hands back one row per trip must all arrive.
    const rows = [
      invitationRow({ teamId: "t1", email: "a@example.com" }),
      invitationRow({ teamId: "t2", email: "a@example.com" }),
      invitationRow({ teamId: "t3", email: "a@example.com" }),
    ];
    // A store that pages after ONE row, whatever Limit was asked for — the 1MB boundary in
    // miniature.
    let call = 0;
    const db = {
      async send(cmd: { input: PagedQueryInput }) {
        void cmd;
        const row = rows[call];
        call++;
        return {
          Items: row ? [row] : [],
          LastEvaluatedKey:
            call < rows.length ? { teamId: row!.teamId, email: row!.email } : undefined,
        };
      },
    } as unknown as DocClient;

    const found = await new DynamoInvitationRepository(db).listByEmail("a@example.com");

    expect(found.map((i) => i.teamId)).toEqual(["t1", "t2", "t3"]);
  });

  it("sends the PREVIOUS PAGE'S KEY as ExclusiveStartKey on the second trip", async () => {
    // ── THE EXACT COMMAND INPUT, WHICH IS THE LAYER A ROUTE-LEVEL FAKE CANNOT SEE ──
    //
    // A loop that re-queried from the START on every trip would return the FIRST row three
    // times and satisfy a "did it make more than one call" test. Only the start key proves the
    // read actually advances. The first trip must carry NO start key — sending one would skip
    // the first row of the partition.
    const rows = [
      invitationRow({ teamId: "t1", email: "a@example.com" }),
      invitationRow({ teamId: "t2", email: "a@example.com" }),
    ];
    const { db, sent } = fakePagedQuery(rows);

    // limit 1 per trip is forced by the fake honouring Limit; the implementation asks for
    // budget+1, so instead drive the paging by giving the store fewer rows than asked.
    await new DynamoInvitationRepository(db).listByEmail("a@example.com");

    // The whole partition fitted in one trip here, so assert the FIRST trip's shape: no start
    // key, and the read begins at the top of the partition.
    expect(sent[0].ExclusiveStartKey).toBeUndefined();

    // Now a store that genuinely pages, to see trip two's start key.
    const paging = fakePagedQuery(rows);
    let trips = 0;
    const pagingDb = {
      async send(cmd: { input: PagedQueryInput }) {
        paging.sent.push(cmd.input);
        const idx = trips;
        trips++;
        const row = rows[idx];
        return {
          Items: row ? [row] : [],
          LastEvaluatedKey:
            idx + 1 < rows.length ? { teamId: row!.teamId, email: row!.email } : undefined,
        };
      },
    } as unknown as DocClient;

    await new DynamoInvitationRepository(pagingDb).listByEmail("a@example.com");

    expect(paging.sent).toHaveLength(2);
    expect(paging.sent[0].ExclusiveStartKey).toBeUndefined();
    // EXACTLY the key the store handed back — the invitations table's composite key, and
    // nothing else. A start key that is not precisely the key schema is a ValidationException.
    expect(paging.sent[1].ExclusiveStartKey).toEqual({
      teamId: "t1",
      email: "a@example.com",
    });
  });

  it("sends a Limit of budget+1 — the over-fetch that distinguishes complete from truncated", async () => {
    // ── WHY budget+1 AND NOT budget, WHICH IS AN OFF-BY-ONE THAT WOULD 500 A VALID READ ──
    //
    // DynamoDB sets LastEvaluatedKey whenever a Query stops on Limit, INCLUDING when it stopped
    // on the last matching row. So `Limit: budget` + "LastEvaluatedKey means truncated" would
    // refuse a COMPLETE answer of exactly `budget` rows, forever. Seeing row budget+1 is the
    // only proof a row is being left behind.
    //
    // 501 = MAX_INVITATION_ROWS_PER_EMAIL (500) + 1. The number is asserted literally because
    // a Limit that silently went missing is the whole defect: an absent Limit means DynamoDB's
    // 1MB page is the bound and nothing in the code declares it.
    const { db, sent } = fakePagedQuery([invitationRow({ email: "a@example.com" })]);

    await new DynamoInvitationRepository(db).listByEmail("a@example.com");

    expect(sent[0].Limit).toBe(501);
  });

  it("asks only for what is STILL MISSING on later trips, never re-requesting the full budget", async () => {
    // Otherwise a nearly-complete read over-fetches, and — worse — the store is invited to ship
    // more rows than this process agreed to hold. Trip two must ask for 501 minus what trip one
    // returned.
    const rows = [
      invitationRow({ teamId: "t1", email: "a@example.com" }),
      invitationRow({ teamId: "t2", email: "a@example.com" }),
    ];
    const sent: PagedQueryInput[] = [];
    let trips = 0;
    const db = {
      async send(cmd: { input: PagedQueryInput }) {
        sent.push(cmd.input);
        const idx = trips;
        trips++;
        const row = rows[idx];
        return {
          Items: row ? [row] : [],
          LastEvaluatedKey:
            idx + 1 < rows.length ? { teamId: row!.teamId, email: row!.email } : undefined,
        };
      },
    } as unknown as DocClient;

    await new DynamoInvitationRepository(db).listByEmail("a@example.com");

    expect(sent[0].Limit).toBe(501);
    // One row already in hand, so 500 remain.
    expect(sent[1].Limit).toBe(500);
  });

  it("THROWS rather than returning a truncated list when the row budget is exceeded", async () => {
    // ── THE RULE THIS WHOLE CHANGE EXISTS FOR ──
    //
    // A bound that is HIT must be REPORTED. An array return has two channels and only the
    // exception is honest — a short array is indistinguishable from a complete answer at every
    // one of this method's six call sites, and this read decides an AUTHORIZATION UNION.
    //
    // 501 rows against a 500-row budget: the over-fetch sees row 501, which is the proof a row
    // is being left behind.
    const rows = Array.from({ length: 501 }, (_, i) =>
      invitationRow({ teamId: `t${i}`, email: "a@example.com" })
    );
    const { db } = fakePagedQuery(rows);

    await expect(
      new DynamoInvitationRepository(db).listByEmail("a@example.com")
    ).rejects.toThrow(/exceeded its bound/);
  });

  it("names the error type, so a caller CAN discriminate it from a store failure", async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      invitationRow({ teamId: `t${i}`, email: "a@example.com" })
    );
    const { db } = fakePagedQuery(rows);

    await expect(
      new DynamoInvitationRepository(db).listByEmail("a@example.com")
    ).rejects.toMatchObject({ name: "InvitationQueryBoundExceeded" });
  });

  it("does NOT leak the EMAIL into the error message — it is the subject's PII", async () => {
    // The message reaches an operator's log. Counts and a NON-PII scope label only; the scope
    // label for this read is the INDEX NAME, deliberately, because the partition key here IS
    // an email address.
    const rows = Array.from({ length: 501 }, (_, i) =>
      invitationRow({ teamId: `t${i}`, email: "secret.person@example.com" })
    );
    const { db } = fakePagedQuery(rows);

    const err = await new DynamoInvitationRepository(db)
      .listByEmail("secret.person@example.com")
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(err).not.toBeNull();
    expect(err!.message).not.toContain("secret.person");
    expect(err!.message).toContain("email-index");
  });

  it("RETURNS a complete answer of EXACTLY the budget — the off-by-one, asserted", async () => {
    // 500 rows is COMPLETE, not truncated, and must come back rather than 500ing forever. This
    // is the test that fails if the over-fetch is dropped or the comparison becomes `>=`.
    const rows = Array.from({ length: 500 }, (_, i) =>
      invitationRow({ teamId: `t${i}`, email: "a@example.com" })
    );
    const { db } = fakePagedQuery(rows);

    const found = await new DynamoInvitationRepository(db).listByEmail("a@example.com");

    expect(found).toHaveLength(500);
  });

  it("THROWS when the ROUND-TRIP CAP stops it with the store still reporting more", async () => {
    // The SECOND way an answer can be incomplete, and it must refuse identically. A store that
    // hands back one row per trip forever exhausts the 5-trip cap having seen 5 rows — far
    // inside the row budget — so a `found.length > budget` check ALONE would return a
    // 5-row list and call it the complete answer. `!exhausted` is what catches it.
    let trips = 0;
    const db = {
      async send() {
        trips++;
        return {
          Items: [invitationRow({ teamId: `t${trips}`, email: "a@example.com" })],
          // ALWAYS set: the store always claims there is more.
          LastEvaluatedKey: { teamId: `t${trips}`, email: "a@example.com" },
        };
      },
    } as unknown as DocClient;

    await expect(
      new DynamoInvitationRepository(db).listByEmail("a@example.com")
    ).rejects.toThrow(/exceeded its bound/);
    // BOUNDED: 5 round trips, MAX_INVITATION_QUERY_ROUND_TRIPS. Not an unbounded walk, which is
    // what the loop would be without the cap.
    expect(trips).toBe(5);
  });

  it("returns [] for an address with no invitations, rather than undefined", async () => {
    // The routes iterate the result directly, and `listByEmail(...).length === 0` is a branch in
    // three of them.
    const db = {
      async send() {
        return {};
      },
    } as unknown as DocClient;

    expect(
      await new DynamoInvitationRepository(db).listByEmail("nobody@example.com")
    ).toEqual([]);
  });

  it("queries the email-index and LOWER-CASES the address, exactly as before", async () => {
    // Unchanged behaviour, re-pinned because the read was rewritten around it. Rows are stored
    // lower-cased (see `put`), so a mixed-case key finds NOTHING — and on this read a miss is
    // an empty entitlement union, not an error.
    const { db, sent } = fakePagedQuery([]);

    await new DynamoInvitationRepository(db).listByEmail("Me@Example.COM");

    expect(sent[0].TableName).toBe("praimana-invitations");
    expect(sent[0].IndexName).toBe("email-index");
    expect(sent[0].KeyConditionExpression).toBe("email = :email");
    expect(sent[0].ExpressionAttributeValues?.[":email"]).toBe("me@example.com");
  });

  it("sends NO FilterExpression — which is what makes the Limit safe", async () => {
    // Load-bearing, and the reason a `Limit` is correct here while this file warns against it
    // everywhere else: DynamoDB applies a FilterExpression AFTER Limit, so filter + Limit
    // returns short pages. With no filter, `Limit` bounds rows and nothing else. Adding a
    // filter to this method without revisiting the bound would reintroduce short pages.
    const { db, sent } = fakePagedQuery([invitationRow({ email: "a@example.com" })]);

    await new DynamoInvitationRepository(db).listByEmail("a@example.com");

    expect(sent[0].FilterExpression).toBeUndefined();
  });

  it("RETHROWS a real store failure untouched — a throttle is not a bound", async () => {
    // The paging loop must not convert an infrastructure fault into anything else. Both gates
    // already answer 503 on any throw from here, but they must see the ORIGINAL error so the
    // operator's log says which it was.
    for (const name of [
      "ProvisionedThroughputExceededException",
      "TimeoutError",
      "AccessDeniedException",
    ]) {
      const db = {
        async send() {
          throw Object.assign(new Error(name), { name });
        },
      } as unknown as DocClient;

      await expect(
        new DynamoInvitationRepository(db).listByEmail("a@example.com")
      ).rejects.toThrow(name);
    }
  });
});

describe("DynamoInvitationRepository.listByTeam — paged, bounded, and refuses to truncate", () => {
  it("FOLLOWS LastEvaluatedKey — rows from BOTH pages, not just the first", async () => {
    // Same defect, same inversion. This is the read behind GET /teams/:teamId/invitations, and
    // at the PLATFORM sentinel its partition grows with every platform invitation ever issued
    // because the rows are never deleted — they ARE the audit record.
    const rows = [
      invitationRow({ teamId: "PLATFORM", email: "a@example.com" }),
      invitationRow({ teamId: "PLATFORM", email: "b@example.com" }),
      invitationRow({ teamId: "PLATFORM", email: "c@example.com" }),
    ];
    let call = 0;
    const db = {
      async send() {
        const row = rows[call];
        call++;
        return {
          Items: row ? [row] : [],
          LastEvaluatedKey:
            call < rows.length ? { teamId: row!.teamId, email: row!.email } : undefined,
        };
      },
    } as unknown as DocClient;

    const found = await new DynamoInvitationRepository(db).listByTeam("PLATFORM");

    expect(found.map((i) => i.email)).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  it("sends the PREVIOUS PAGE'S KEY as ExclusiveStartKey on the second trip", async () => {
    // The exact command input again, at the read whose partition will actually reach a bound.
    const rows = [
      invitationRow({ teamId: "PLATFORM", email: "a@example.com" }),
      invitationRow({ teamId: "PLATFORM", email: "b@example.com" }),
    ];
    const sent: PagedQueryInput[] = [];
    let trips = 0;
    const db = {
      async send(cmd: { input: PagedQueryInput }) {
        sent.push(cmd.input);
        const idx = trips;
        trips++;
        const row = rows[idx];
        return {
          Items: row ? [row] : [],
          LastEvaluatedKey:
            idx + 1 < rows.length ? { teamId: row!.teamId, email: row!.email } : undefined,
        };
      },
    } as unknown as DocClient;

    await new DynamoInvitationRepository(db).listByTeam("PLATFORM");

    expect(sent).toHaveLength(2);
    expect(sent[0].ExclusiveStartKey).toBeUndefined();
    expect(sent[1].ExclusiveStartKey).toEqual({
      teamId: "PLATFORM",
      email: "a@example.com",
    });
  });

  it("sends a Limit of budget+1 — 5001, sized NOT to refuse what the code already returned", async () => {
    // MAX_INVITATION_ROWS_PER_TEAM (5000) + 1. The budget is deliberately no tighter than the
    // ~5,000 rows of this shape that fit in the single 1MB page the old implementation
    // returned, so a call that works today cannot start refusing because of this change.
    const { db, sent } = fakePagedQuery([invitationRow({ teamId: "PLATFORM" })]);

    await new DynamoInvitationRepository(db).listByTeam("PLATFORM");

    expect(sent[0].Limit).toBe(5001);
  });

  it("THROWS rather than returning a truncated list when the row budget is exceeded", async () => {
    // The bound REPORTED, not returned short. This read feeds a human-facing list an operator
    // uses to find and revoke a mistyped invitation, so a list quietly missing rows is a row
    // they cannot find — worse than a 500 that says something is wrong.
    const rows = Array.from({ length: 5001 }, (_, i) =>
      invitationRow({ teamId: "PLATFORM", email: `p${i}@example.com` })
    );
    const { db } = fakePagedQuery(rows);

    await expect(
      new DynamoInvitationRepository(db).listByTeam("PLATFORM")
    ).rejects.toThrow(/exceeded its bound/);
  });

  it("names the teamId in the error — a system id, not PII, and the partition that overflowed", async () => {
    // Unlike listByEmail, whose partition key IS an email address, `teamId` is safe to log and
    // is the one fact an operator needs in order to act.
    const rows = Array.from({ length: 5001 }, (_, i) =>
      invitationRow({ teamId: "PLATFORM", email: `p${i}@example.com` })
    );
    const { db } = fakePagedQuery(rows);

    const err = await new DynamoInvitationRepository(db)
      .listByTeam("PLATFORM")
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(err).not.toBeNull();
    expect(err!.message).toContain("PLATFORM");
    // And no invitee address came along with it.
    expect(err!.message).not.toContain("@example.com");
  });

  it("RETURNS a complete answer of EXACTLY the budget", async () => {
    // 5000 rows is COMPLETE. The over-fetch is what makes this distinguishable from 5001.
    const rows = Array.from({ length: 5000 }, (_, i) =>
      invitationRow({ teamId: "PLATFORM", email: `p${i}@example.com` })
    );
    const { db } = fakePagedQuery(rows);

    expect(await new DynamoInvitationRepository(db).listByTeam("PLATFORM")).toHaveLength(
      5000
    );
  });

  it("THROWS when the ROUND-TRIP CAP stops it with the store still reporting more", async () => {
    let trips = 0;
    const db = {
      async send() {
        trips++;
        return {
          Items: [invitationRow({ teamId: "PLATFORM", email: `p${trips}@example.com` })],
          LastEvaluatedKey: { teamId: "PLATFORM", email: `p${trips}@example.com` },
        };
      },
    } as unknown as DocClient;

    await expect(
      new DynamoInvitationRepository(db).listByTeam("PLATFORM")
    ).rejects.toThrow(/exceeded its bound/);
    expect(trips).toBe(5);
  });

  it("queries the BASE TABLE on teamId with NO IndexName — teamId IS the partition key", async () => {
    // Unchanged, re-pinned. There is no index to name here and naming one would be wrong; a
    // stray IndexName would be a ValidationException at runtime that type-checks perfectly.
    const { db, sent } = fakePagedQuery([]);

    await new DynamoInvitationRepository(db).listByTeam("t-42");

    expect(sent[0].TableName).toBe("praimana-invitations");
    expect(sent[0].IndexName).toBeUndefined();
    expect(sent[0].KeyConditionExpression).toBe("teamId = :teamId");
    expect(sent[0].ExpressionAttributeValues?.[":teamId"]).toBe("t-42");
  });

  it("does NOT lower-case the teamId — it is a case-sensitive partition key, not an email", async () => {
    // The sibling read lower-cases its key because addresses are stored that way. Applying the
    // same normalisation here would miss every real team: ULIDs and the PLATFORM sentinel are
    // upper-case.
    const { db, sent } = fakePagedQuery([]);

    await new DynamoInvitationRepository(db).listByTeam("PLATFORM");

    expect(sent[0].ExpressionAttributeValues?.[":teamId"]).toBe("PLATFORM");
  });

  it("returns [] for a team with no invitations, rather than undefined", async () => {
    const db = {
      async send() {
        return {};
      },
    } as unknown as DocClient;

    expect(await new DynamoInvitationRepository(db).listByTeam("t1")).toEqual([]);
  });

  it("sends NO FilterExpression — which is what makes the Limit safe", async () => {
    // The route post-filters by the invite matrix per row. Doing it at the store would be
    // filter-after-Limit and would return short pages — the hazard this file documents
    // repeatedly.
    const { db, sent } = fakePagedQuery([invitationRow({ teamId: "PLATFORM" })]);

    await new DynamoInvitationRepository(db).listByTeam("PLATFORM");

    expect(sent[0].FilterExpression).toBeUndefined();
  });

  it("RETHROWS a real store failure untouched", async () => {
    for (const name of ["ProvisionedThroughputExceededException", "AccessDeniedException"]) {
      const db = {
        async send() {
          throw Object.assign(new Error(name), { name });
        },
      } as unknown as DocClient;

      await expect(
        new DynamoInvitationRepository(db).listByTeam("PLATFORM")
      ).rejects.toThrow(name);
    }
  });
});

describe("TransactionConflict is RETRIED, not reported as a refusal", () => {
  /**
   * THE DEFECT senior-qa FOUND, and it was a liveness bug rather than a safety one.
   *
   * Every admit for a team contends on the same `teams` item — that is precisely what makes the
   * cap safe — so DynamoDB reports contention rather than a rule violation. `TransactionConflict`
   * matched no branch, fell through the final `throw`, and became an HTTP 500 for a join that
   * should plainly have succeeded. Measured against a real table with an EMPTY 10-seat team, where nobody
   * should be refused at all: ~25% of calls at 2 concurrent, ~55% at 4, ~73% at 10.
   *
   * ⚠ The SDK does NOT retry it — `$retryable` is undefined and `attempts` is 1 — so nothing
   * below this repository was ever going to.
   *
   * After the fix, verified live: 288 concurrent admits across three contention profiles, zero
   * throws and zero cap violations.
   */

  /** Fails the first `n` sends with `err`, then succeeds — a transient conflict. */
  function flakyDb(n: number, err: unknown) {
    let calls = 0;
    const db = {
      async send() {
        if (++calls <= n) throw err;
        return {};
      },
    };
    return { db: db as unknown as DocClient, calls: () => calls };
  }

  const cancelledWithConflict = () =>
    Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
    });

  /**
   * ⚠ THE SECOND SHAPE, and the one that is easy to miss because the docs lead with the first.
   * DynamoDB also raises a STANDALONE `TransactionConflictException` with no CancellationReasons
   * at all ("Transaction is ongoing for the item"). Both appeared in the same live probe run, and
   * handling only the cancellation form ships a retry fix that still throws.
   */
  const standaloneConflict = () =>
    Object.assign(new Error("Transaction is ongoing for the item"), {
      name: "TransactionConflictException",
    });

  const member = {
    teamId: "t1",
    userId: "u1",
    role: "BUILDER",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };

  for (const [label, mk] of [
    ["a cancellation reason", cancelledWithConflict],
    ["a STANDALONE TransactionConflictException", standaloneConflict],
  ] as const) {
    it(`retries and then admits — ${label}`, async () => {
      const { db, calls } = flakyDb(2, mk());
      expect(await new DynamoTeamMemberRepository(db).admit(member, "w1")).toBe("admitted");
      // Three sends: two conflicts, then the one that committed.
      expect(calls()).toBe(3);
    });
  }

  it("gives up after a BOUNDED number of attempts rather than queueing forever", async () => {
    // An unbounded retry on a hot item spends the caller's whole request budget and fails
    // anyway. Exhausting the budget must surface the real error, not a fabricated "full".
    const { db, calls } = flakyDb(Number.MAX_SAFE_INTEGER, standaloneConflict());
    await expect(
      new DynamoTeamMemberRepository(db).admit(member, "w1")
    ).rejects.toThrow(/Transaction is ongoing/);
    expect(calls()).toBeGreaterThan(1);
    expect(calls(), "bounded, not unbounded").toBeLessThanOrEqual(8);
  });

  it("does NOT retry a ConditionalCheckFailed — that is an ANSWER, not contention", async () => {
    // Retrying a rule refusal would get the same answer more slowly, and burning backoff on
    // "you are already a member" is latency for nothing.
    const { db, calls } = flakyDb(Number.MAX_SAFE_INTEGER, transactionCancelled([true]));
    expect(await new DynamoTeamMemberRepository(db).admit(member, "w1")).toBe("already-member");
    expect(calls(), "answered on the first attempt").toBe(1);
  });

  it("does NOT retry an unrelated failure — a throttle must surface", async () => {
    const boom = Object.assign(new Error("throughput exceeded"), {
      name: "ProvisionedThroughputExceededException",
    });
    const { db, calls } = flakyDb(Number.MAX_SAFE_INTEGER, boom);
    await expect(
      new DynamoTeamMemberRepository(db).admit(member, "w1")
    ).rejects.toThrow(/throughput/);
    expect(calls()).toBe(1);
  });
});

describe("no ClientRequestToken — the conditions ARE the idempotency", () => {
  /**
   * The design once specified a stable `ClientRequestToken`; it was implemented and has been REMOVED.
   *
   * ── WHY IT WAS HARMFUL ──
   *
   * A token is only valid for an IDENTICAL request, and these requests are NOT identical between
   * attempts: `removedAt`/`reactivatedAt` are minted inside the call and `joinedAt` per request
   * by the route. So a retry sent the same token with different parameters and DynamoDB answered
   * `IdempotentParameterMismatchException` — a 500.
   *
   * REPRODUCED LIVE before the fix: removing a member and restoring them inside ten minutes
   * failed outright. That is exactly the sequence an operator runs after a mistaken removal, and
   * it also left a freed seat unreachable for ten minutes.
   *
   * ── WHY REMOVING IT IS SAFE ──
   *
   * Verified live, same admit replayed three times with NO token: committed, then
   * `[ConditionalCheckFailed, None]`, then the same, with `memberCount` at exactly 1. Every one
   * of these transactions is already idempotent by its CONDITIONS —
   * `attribute_not_exists(userId)` for admit, `#status <> :inactive` for deactivate,
   * `#status = :inactive` for reactivate. The token was a second mechanism for a property the
   * first one already had.
   */
  it("sends NO ClientRequestToken on any membership transaction", () => {
    // Structural, because the harm is in the FIELD's presence rather than in any single outcome:
    // reinstating it silently converts every retry into a hard failure again.
    const src = readFileSync(
      fileURLToPath(new URL("./repository.dynamo.ts", import.meta.url)),
      "utf8"
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("ClientRequestToken");
    // And the helper that minted it is gone, not merely unused.
    expect(code).not.toContain("membershipRequestToken");
  });

  it("a repeated ADMIT is idempotent through attribute_not_exists alone", async () => {
    // The token's stated purpose — suppressing a double increment — is what this condition
    // already does. `joinedAt` deliberately differs between the two calls, which is precisely
    // what made the stable token throw.
    const { db, sent } = fakeDb(transactionCancelled([true]));
    const repo = new DynamoTeamMemberRepository(db);

    expect(
      await repo.admit(
        { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
        "w1"
      )
    ).toBe("already-member");
    expect(sent[0].ConditionExpression).toContain("attribute_not_exists(userId)");
  });

  it("keeps a mint-per-attempt timestamp, which is WHY the token could not stay", async () => {
    // Not a defect to fix — a removal should record when it happened, and a retry is a new
    // attempt. The payload varying is legitimate; a stable token over it was not.
    const { db, sent } = fakeDb();
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "fac", "FACILITATOR", "w1");
    expect(String(sent[0].ExpressionAttributeValues?.[":now"])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("the deactivate fallback RESYNCS the ledger instead of skipping it", () => {
  const seq = (...errs: Array<unknown>) => {
    // Typed as the same UpdateInput the file's other fakes record, so the assertions can index
    // ExpressionAttributeValues without casting at every call site.
    const sent: UpdateInput[] = [];
    let i = 0;
    const db = {
      async send(cmd: { input: Record<string, unknown> }) {
        sent.push(cmd.input);
        const err = errs[i++];
        if (err) throw err;
        // The resync's Query needs rows to count: two ACTIVE, one INACTIVE.
        return {
          Items: [
            { teamId: "t1", userId: "u1", status: "INACTIVE" },
            { teamId: "t1", userId: "u2" },
            { teamId: "t1", userId: "u3", status: "ACTIVE" },
          ],
        };
      },
    };
    return { db: db as unknown as DocClient, sent };
  };

  /** Only the TEAM item's condition failed — the trigger for the fallback. */
  const teamItemOnly = () => transactionCancelled([false, true]);

  it("flips the row, then WRITES a recounted memberCount", async () => {
    const { db, sent } = seq(teamItemOnly());

    expect(
      await new DynamoTeamMemberRepository(db).deactivate(
        "t1",
        "u1",
        "fac",
        "FACILITATOR",
        "w1"
      )
    ).toBe(true);

    // 1 transaction (cancelled), 2 row-only flip, 3 roster Query, 4 ledger write.
    expect(sent).toHaveLength(4);
    const write = sent[3];
    expect(write.UpdateExpression).toContain("memberCount = :count");
    // TWO active rows of the three returned — INACTIVE must not be counted.
    expect(write.ExpressionAttributeValues?.[":count"]).toBe(2);
  });

  it("does NOT guard the resync on attribute_not_exists — that is the whole point", async () => {
    /**
     * `initialiseLedger` carries that guard so it can never clobber a live ledger. Reusing it
     * here would decline on a drifted row (which already HAS a count) and leave the drift in
     * place — the repair would silently do nothing.
     */
    const { db, sent } = seq(teamItemOnly());
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "f", "FACILITATOR", "w1");

    const write = sent[3];
    expect(write.ConditionExpression).toBe("attribute_exists(id)");
    expect(write.ConditionExpression, "must overwrite a drifted count").not.toContain(
      "attribute_not_exists(memberCount)"
    );
  });

  it("counts with a STRONGLY CONSISTENT read, because the number becomes the ledger", async () => {
    const { db, sent } = seq(teamItemOnly());
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "f", "FACILITATOR", "w1");
    expect(sent[2].ConsistentRead).toBe(true);
  });

  it("ORDERS the flip before the recount, so the removal is included", async () => {
    // Recounting first would write a number stale by one the instant the flip lands.
    const { db, sent } = seq(teamItemOnly());
    await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "f", "FACILITATOR", "w1");

    expect(sent[1].UpdateExpression, "the row flip").toContain(":inactive");
    expect(sent[2].KeyConditionExpression, "then the recount").toBe("teamId = :teamId");
  });

  it("KEEPS THE REMOVAL when the resync itself fails", async () => {
    // The one direction worth accepting on this path: a wrong ledger is visible (the drift
    // metric reports it), whereas a lost removal leaves somebody with access nobody is
    // looking for.
    const boom = Object.assign(new Error("throughput exceeded"), {
      name: "ProvisionedThroughputExceededException",
    });
    // tx cancelled → flip OK → Query OK → ledger write fails.
    const { db } = seq(teamItemOnly(), undefined, undefined, boom);

    await expect(
      new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "f", "FACILITATOR", "w1")
    ).resolves.toBe(true);
  });

  it("does NOT resync when the row flip found nothing to do", async () => {
    // No membership row, or already INACTIVE. Nothing changed, so recounting would spend two
    // reads and a write to confirm the status quo — and could overwrite a healthy ledger.
    const { db, sent } = seq(teamItemOnly(), conditionalCheckFailed());

    expect(
      await new DynamoTeamMemberRepository(db).deactivate("t1", "u1", "f", "FACILITATOR", "w1")
    ).toBe(false);
    expect(sent, "flip attempted, no resync").toHaveLength(2);
  });
});
