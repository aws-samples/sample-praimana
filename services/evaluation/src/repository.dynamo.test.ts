import { describe, it, expect } from "vitest";
import type { DocClient } from "@praimana/service-shared";
import {
  DynamoSubmissionRepository,
  DynamoScoreRepository,
  DynamoMemberRatingRepository,
} from "./repository.dynamo.js";
import type { Submission } from "./domain.js";

/**
 * ADAPTER TESTS for the Evaluation repositories — BACKLOG P1-4.
 *
 * ── WHY THIS FILE EXISTS, AND WHY A ROUTE TEST COULD NOT HAVE CAUGHT IT ──
 *
 * The submissions table's key schema disagreed with this repository for as long as both
 * existed. The DEPLOYED table (and the infrastructure CloudFormation template, so this was
 * never deploy drift — the IaC was itself wrong) was `workshopId` HASH / `teamId` RANGE with
 * NO GSIs, while every method here addresses `teamId` HASH / `id` RANGE plus a `byId` index.
 * The result, confirmed against a deployed table: ALL FOUR methods raised ValidationException,
 * including `put` — which writes an item carrying no `workshopId` against a `workshopId`
 * partition key. Submissions could not be read OR created.
 *
 * Every route test in this service passed throughout, because they inject an in-memory
 * `FakeSubmissions` that implements the same INTERFACE and knows nothing about keys. The
 * mismatch lives entirely in the `Key`, `IndexName` and `KeyConditionExpression` the SDK is
 * handed — values a route-level fake never sees. The same gap was found in `user-access` the
 * day before, where three route tests passed while the adapter dropped a field outright.
 *
 * So the assertions here are on the COMMAND INPUT: exactly which key, which index and which
 * key-condition each method sends. That is the contract the template must satisfy, and it is
 * asserted in the one place where the template and the code can be compared at all.
 *
 * ⚠ THESE TESTS PIN THE CODE, AND THE TEMPLATE WAS CORRECTED TO MATCH THEM — not the other
 * way round. The deployed key could not express the domain (a team has MANY submissions, one
 * per id; `workshopId`/`teamId` permits exactly one row per team and makes a second
 * submission an overwrite). The table was empty (0 items, verified) and no client called the
 * API, so it was replaced. See the note above SubmissionsTable in the template.
 */

/** The subset of a Get/Put/Query/Update/Transact command's input these tests read. */
interface CommandInput {
  TableName?: string;
  IndexName?: string;
  Key?: Record<string, unknown>;
  Item?: Record<string, unknown>;
  KeyConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  ScanIndexForward?: boolean;
  Limit?: number;
  /** Added for the uniqueness transaction and the patch — see the two describes at the end. */
  TransactItems?: unknown;
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ReturnValues?: string;
}

/**
 * A fake DocClient that records the command input and returns what it is told.
 *
 * `result` is the SDK response to answer with, so the mapping of `Item`/`Items` onto the
 * domain type is exercised too — including the empty cases, which is where a `?? null`
 * versus `?? []` mistake hides.
 */
function fakeDb(result: Record<string, unknown> = {}) {
  const sent: CommandInput[] = [];
  const db = {
    async send(cmd: { input: CommandInput }) {
      sent.push(cmd.input);
      return result;
    },
  };
  return { db: db as unknown as DocClient, sent };
}

const row = (over: Partial<Submission> = {}): Submission => ({
  teamId: "t1",
  id: "s1",
  workshopId: "w1",
  status: "DRAFT",
  title: "Our project",
  summary: null,
  problemStatement: null,
  solution: null,
  demoUrl: null,
  videoUrl: null,
  repoUrl: null,
  slidesUrl: null,
  aiUsageSummary: null,
  submittedAt: null,
  createdById: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  releasedById: null,
  releasedAt: null,
  reopenedById: null,
  reopenedAt: null,
  reopenReason: null,
  snapshot: null,
  ...over,
});

describe("DynamoSubmissionRepository — the key schema P1-4 reconciled", () => {
  it("get() addresses the item by (teamId, id) — the TABLE key, exactly", async () => {
    // `toEqual` and not `toMatchObject`: an EXTRA key attribute is as fatal as a missing
    // one (DynamoDB rejects a Key with an attribute that is not part of the schema), and
    // that is precisely the shape of the defect — the old table wanted `workshopId`.
    const { db, sent } = fakeDb({ Item: row() });
    const found = await new DynamoSubmissionRepository(db).get("t1", "s1");

    expect(sent).toHaveLength(1);
    expect(sent[0].TableName).toBe("praimana-submissions-v2");
    expect(sent[0].Key).toEqual({ teamId: "t1", id: "s1" });
    // No index on a Get — it addresses the base table.
    expect(sent[0].IndexName).toBeUndefined();
    expect(found).toMatchObject({ teamId: "t1", id: "s1" });
  });

  it("get() returns null rather than undefined when the item is absent", async () => {
    const { db } = fakeDb({});
    expect(await new DynamoSubmissionRepository(db).get("t1", "nope")).toBeNull();
  });

  it("getById() queries the `byId` INDEX on id — the GSI that had to exist", async () => {
    // The index NAME is the load-bearing string. It is not derivable from anything else in
    // the codebase, so template and code agreeing on `byId` is a coincidence unless
    // asserted: the deployed table had no GSIs at all, and this Query was the read that
    // raised ValidationException on the scoring path.
    const { db, sent } = fakeDb({ Items: [row({ id: "s-9" })] });
    const found = await new DynamoSubmissionRepository(db).getById("s-9");

    expect(sent[0].TableName).toBe("praimana-submissions-v2");
    expect(sent[0].IndexName).toBe("byId");
    expect(sent[0].KeyConditionExpression).toBe("id = :id");
    expect(sent[0].ExpressionAttributeValues).toEqual({ ":id": "s-9" });
    // Limit 1: this resolves ONE submission, and `id` is unique, so a page of more than
    // one would mean a duplicate id — not something to iterate over.
    expect(sent[0].Limit).toBe(1);
    expect(found).toMatchObject({ id: "s-9" });
  });

  it("getById() returns null for an empty page AND for an absent Items array", async () => {
    // Both shapes occur: DynamoDB returns `Items: []` for a miss, and a malformed/mocked
    // response can omit it entirely. Neither may become `undefined`, because the scoring
    // route's `if (!submission) return 404` is what stops an orphan Score row — and
    // `undefined` passing a truthiness check is not the failure mode, an EXCEPTION on
    // `.workshopId` further down is.
    for (const result of [{ Items: [] }, {}]) {
      const { db } = fakeDb(result);
      expect(await new DynamoSubmissionRepository(db).getById("s-1")).toBeNull();
    }
  });

  it("getById() carries the SERVER-DERIVED workshopId through — the scope the guard reads", async () => {
    // The authorization link between P1-4 and P0-3, asserted rather than assumed. This is
    // the ONLY read on the scoring path, so whatever it returns is what the scope check
    // decides on. It is also why the `byId` GSI must project ALL: a projection omitting
    // `workshopId` would make every score POST fail with SUBMISSION_SCOPE_UNKNOWN — a data
    // problem wearing an access problem's clothes.
    const { db } = fakeDb({ Items: [row({ id: "s-9", workshopId: "w-real" })] });
    const found = await new DynamoSubmissionRepository(db).getById("s-9");
    expect(found?.workshopId).toBe("w-real");
  });

  it("listByTeam() queries the BASE table on teamId, newest first, with no index", async () => {
    const { db, sent } = fakeDb({ Items: [row()] });
    await new DynamoSubmissionRepository(db).listByTeam("t-42");

    expect(sent[0].TableName).toBe("praimana-submissions-v2");
    // The base table, NOT `byId`: teamId is the partition key, so this is a
    // single-partition Query and an index would be a pointless second copy.
    expect(sent[0].IndexName).toBeUndefined();
    expect(sent[0].KeyConditionExpression).toBe("teamId = :teamId");
    expect(sent[0].ExpressionAttributeValues).toEqual({ ":teamId": "t-42" });
    // Descending on the SORT KEY (`id`, a ULID) — which is only newest-first because ULIDs
    // sort lexicographically by time. That is another reason `id` had to be the range key:
    // under the old schema the sort key was `teamId` and this ordering was meaningless.
    expect(sent[0].ScanIndexForward).toBe(false);
  });

  it("listByTeam() returns [] rather than undefined for a team with none", async () => {
    const { db } = fakeDb({});
    expect(await new DynamoSubmissionRepository(db).listByTeam("t1")).toEqual([]);
  });

  it("put() writes the row with BOTH key attributes present on the item", async () => {
    // THE METHOD THE REGISTER UNDER-STATED. `put` raised ValidationException too, because
    // the item carries no `workshopId` and the old table made that the PARTITION KEY — so
    // submissions could not be CREATED either, not merely read. Asserting both key
    // attributes are on the item is what pins that the item and the schema agree.
    const { db, sent } = fakeDb({});
    const written = await new DynamoSubmissionRepository(db).put(row({ id: "s-new" }));

    expect(sent[0].TableName).toBe("praimana-submissions-v2");
    expect(sent[0].Item).toMatchObject({ teamId: "t1", id: "s-new" });
    expect(sent[0].Item?.teamId).toBeTruthy();
    expect(sent[0].Item?.id).toBeTruthy();
    // The stored row is returned unchanged, which is what the route responds with.
    expect(written.id).toBe("s-new");
  });

  it("put() stores workshopId as an ATTRIBUTE, and it is not a key", async () => {
    // Deliberately not in the key schema: nothing queries submissions by workshop, and the
    // guard reads it off the loaded record. Asserting it is on the item AND that the Key
    // shape above does not mention it is what keeps the template's AttributeDefinitions
    // honest — DynamoDB requires definitions for KEY attributes only.
    const { db, sent } = fakeDb({});
    await new DynamoSubmissionRepository(db).put(row({ workshopId: "w-derived" }));
    expect(sent[0].Item?.workshopId).toBe("w-derived");
  });

  it("does NOT address the table by workshopId anywhere — the defect, asserted as absent", async () => {
    // The regression guard for P1-4 as a whole. Every method is exercised and no command
    // may name `workshopId` in a Key or a KeyConditionExpression; the only permitted
    // mention is as an item attribute on `put`. If someone "fixes" a future
    // ValidationException by reintroducing the old partition key, this fails.
    const { db, sent } = fakeDb({ Items: [row()], Item: row() });
    const repo = new DynamoSubmissionRepository(db);
    await repo.get("t1", "s1");
    await repo.getById("s1");
    await repo.listByTeam("t1");
    await repo.put(row());

    expect(sent).toHaveLength(4);
    for (const input of sent) {
      expect(Object.keys(input.Key ?? {})).not.toContain("workshopId");
      expect(input.KeyConditionExpression ?? "").not.toContain("workshopId");
    }
  });
});

describe("DynamoScoreRepository — keyed (submissionId, judgeId)", () => {
  it("listBySubmission() queries the base table on submissionId", async () => {
    // The scores table's schema was already correct and is UNCHANGED by P1-4 (verified
    // live: `submissionId` HASH / `judgeId` RANGE). Pinned here anyway because it is the
    // other half of the scoring path, and it is the read the widening now serves to
    // judges — so a key mismatch here would surface as "the judge who scored cannot read
    // the result", which is exactly the symptom the widening was fixing.
    const { db, sent } = fakeDb({ Items: [] });
    await new DynamoScoreRepository(db).listBySubmission("s-7");

    expect(sent[0].TableName).toBe("praimana-scores");
    expect(sent[0].IndexName).toBeUndefined();
    expect(sent[0].KeyConditionExpression).toBe("submissionId = :submissionId");
    expect(sent[0].ExpressionAttributeValues).toEqual({ ":submissionId": "s-7" });
  });

  it("listBySubmission() returns [] when a submission has no scores yet", async () => {
    const { db } = fakeDb({});
    expect(await new DynamoScoreRepository(db).listBySubmission("s-7")).toEqual([]);
  });

  /**
   * ⚠ WAS "put() … so a re-score OVERWRITES rather than double-votes". `put` is gone and the behaviour
   * it asserted is superseded: a score is final once submitted, so a second one from the same judge is
   * REFUSED. The property that test really protected — one row per judge, never a second vote — is
   * unchanged and asserted below, now enforced by the STORE rather than by an overwrite.
   */
  it("create() writes both key attributes and refuses a second score from the same judge", async () => {
    // (submissionId, judgeId) is the row's identity. If either were missing from the item the write
    // would fail; if `judgeId` were not part of the key, one judge's score would displace another's.
    const { db, sent } = fakeDb({});
    const score = {
      submissionId: "s-7",
      judgeId: "judge-1",
      innovation: 5,
      execution: 5,
      aiUsage: 5,
      impact: 5,
      presentation: 5,
      comment: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(await new DynamoScoreRepository(db).create(score)).toBe("created");

    expect(sent[0].TableName).toBe("praimana-scores");
    expect(sent[0].Item).toMatchObject({ submissionId: "s-7", judgeId: "judge-1" });
    /**
     * ⚠ THE CONDITION IS THE WHOLE POINT, so it is asserted rather than assumed. Without it this is an
     * upsert and a second POST silently replaces a cast score — and a read-then-write would lose a
     * double-click, which is why the condition sits on the write instead of in front of it.
     */
    expect(sent[0].ConditionExpression).toBe("attribute_not_exists(submissionId)");
  });

  it("create() reports a clash as an ANSWER, not a thrown fault", async () => {
    // The route turns this into a 409 with its own code. A thrown Dynamo error would surface as a 500,
    // telling a judge the service is broken when in fact their score is already recorded.
    const { db } = fakeDb({});
    db.send = async () => {
      const err = new Error("The conditional request failed");
      (err as { name?: string }).name = "ConditionalCheckFailedException";
      throw err;
    };
    expect(
      await new DynamoScoreRepository(db).create({
        submissionId: "s-7",
        judgeId: "judge-1",
        innovation: 5,
        execution: 5,
        aiUsage: 5,
        impact: 5,
        presentation: 5,
        comment: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      })
    ).toBe("already-scored");
  });
});

describe("DynamoMemberRatingRepository — keyed (teamId, id)", () => {
  it("listByTeam() queries the base table on teamId", async () => {
    const { db, sent } = fakeDb({ Items: [] });
    await new DynamoMemberRatingRepository(db).listByTeam("t-3");

    expect(sent[0].TableName).toBe("praimana-member-ratings-v2");
    expect(sent[0].KeyConditionExpression).toBe("teamId = :teamId");
    expect(sent[0].ExpressionAttributeValues).toEqual({ ":teamId": "t-3" });
  });

  it("put() writes teamId and id onto the item", async () => {
    // ── FIXED. This spec was written as a FINDING and is now the regression pin.
    //
    // It used to say "deliberately not fixed here": the member-ratings TABLE was
    // `teamId` HASH / `userId` RANGE while `MemberRating` carries `teamId` + `id` +
    // `ratedUserId` and NO `userId` — so `put` could never succeed and peer ratings were
    // silently non-functional. The same defect class as P1-4 on a second table, and
    // `listByTeam` above only ever worked because it names the partition key alone.
    //
    // The same "which key expresses the domain?" choice was made as for submissions:
    // (teamId, id). Not (teamId, ratedUserId), which would make a person's rating
    // single-valued per team so a second rater silently overwrote the first — wrong for peer
    // rating by construction. The table was renamed to `-v2` because CloudFormation refuses
    // to replace a custom-named resource; it was empty, so there was no migration.
    //
    // The `userId` assertion below is KEPT deliberately, inverted in meaning: it used to
    // prove the defect, and it now proves the item shape did not quietly grow a field to
    // satisfy the old key instead of the key being corrected to fit the item.
    const { db, sent } = fakeDb({});
    await new DynamoMemberRatingRepository(db).create({
      teamId: "t-3",
      id: "r-1",
      raterId: "u1",
      ratedUserId: "u2",
      score: 50,
      comment: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // Both key attributes of the CORRECTED table are on the item, which is what makes the
    // write valid at all.
    expect(sent[0].Item).toMatchObject({ teamId: "t-3", id: "r-1" });
    // And no `userId` was invented to appease the OLD range key — the key moved, not the item.
    expect(sent[0].Item?.userId).toBeUndefined();
  });
});

/**
 * A client whose FIRST command throws and whose next returns `then` — the shape of `patch`'s
 * refusal path, where the condition fails and a follow-up read decides which refusal it was.
 */
function failingDb(err: { name: string }, then: Record<string, unknown>) {
  let first = true;
  const sent: CommandInput[] = [];
  const db = {
    async send(cmd: { input: CommandInput }) {
      sent.push(cmd.input);
      if (first) {
        first = false;
        throw Object.assign(new Error(err.name), err);
      }
      return then;
    },
  };
  return { db: db as unknown as DocClient, sent };
}

/**
 * ── THE UNIQUENESS TRANSACTION, THE POINTER, AND THE PATCH ────────
 *
 * These assert the COMMAND INPUT for the same reason the file's header gives: the conditions, the
 * item positions and the reserved words are all things a route-level fake never sees. A `patch` that
 * names `status` without a `#placeholder` type-checks, passes every route test, and raises
 * ValidationException the first time it runs — DynamoDB reserves that word.
 */
describe("DynamoSubmissionRepository — uniqueness pointer", () => {
  it("createUnique sends ONE transaction of TWO puts, both conditional on absence", async () => {
    const { db, sent } = fakeDb({});
    await new DynamoSubmissionRepository(db).createUnique(row({ teamId: "t1", id: "s1" }));

    expect(sent).toHaveLength(1);
    const items = sent[0].TransactItems as Array<{
      Put: { Item: Record<string, unknown>; ConditionExpression: string; TableName: string };
    }>;
    expect(items).toHaveLength(2);

    // ⚠ POSITION 0 IS THE SUBMISSION, POSITION 1 THE POINTER. The repository disambiguates the
    // cancellation POSITIONALLY, so swapping these silently changes which answer a loser gets.
    expect(items[0].Put.Item).toMatchObject({ teamId: "t1", id: "s1" });
    expect(items[1].Put.Item).toEqual({ teamId: "t1", id: "#pointer", submissionId: "s1" });

    // Both or neither: each is guarded, so two concurrent creates cannot both commit.
    expect(items[0].Put.ConditionExpression).toBe("attribute_not_exists(id)");
    expect(items[1].Put.ConditionExpression).toBe("attribute_not_exists(id)");
    // Same table — the pointer lives in the team's own partition, not a second table.
    expect(items[1].Put.TableName).toBe(items[0].Put.TableName);
  });

  /**
   * ⚠ NO RESERVED ID ON A SUBMISSION, AND THIS TEST CHECKS IT BY READING WHAT THE WRITER SENDS.
   *
   * `byId` is a HASH-on-`id` GSI read with `Limit: 1`, so if two teams' rows shared an `id`,
   * `getById` would return an arbitrary team's submission — and every authorization decision in this
   * service reads that record. The sentinel must therefore appear on the POINTER item only.
   */
  it("the sentinel appears on the pointer item and NEVER on the submission item", async () => {
    const { db, sent } = fakeDb({});
    await new DynamoSubmissionRepository(db).createUnique(row({ teamId: "t1", id: "s1" }));

    const items = sent[0].TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    const submissionItem = items[0].Put.Item;
    expect(submissionItem.id).toBe("s1");
    expect(String(submissionItem.id).startsWith("#")).toBe(false);
    expect(items[1].Put.Item.id).toBe("#pointer");
  });

  it("pointer() reads the sentinel row in the team's own partition", async () => {
    const { db, sent } = fakeDb({ Item: { teamId: "t1", id: "#pointer", submissionId: "s9" } });
    const got = await new DynamoSubmissionRepository(db).pointer("t1");

    expect(sent[0].Key).toEqual({ teamId: "t1", id: "#pointer" });
    expect(got).toBe("s9");
  });

  it("pointer() is null for a team that has none", async () => {
    const { db } = fakeDb({});
    expect(await new DynamoSubmissionRepository(db).pointer("t1")).toBeNull();
  });

  /** The pointer shares the partition, so an unfiltered list would return it as a submission. */
  it("listByTeam excludes the pointer row", async () => {
    const { db } = fakeDb({
      Items: [
        row({ teamId: "t1", id: "s1" }),
        { teamId: "t1", id: "#pointer", submissionId: "s1" },
        row({ teamId: "t1", id: "s2" }),
      ],
    });

    const got = await new DynamoSubmissionRepository(db).listByTeam("t1");

    expect(got.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(got.some((s) => s.id === "#pointer")).toBe(false);
  });
});

describe("DynamoSubmissionRepository — patch", () => {
  it("writes ONLY the named fields — createdById and createdAt are unreachable", async () => {
    const { db, sent } = fakeDb({ Attributes: row({ demoUrl: "https://demo.example" }) });
    await new DynamoSubmissionRepository(db).patch("t1", "s1", {
      demoUrl: "https://demo.example",
    });

    const expr = sent[0].UpdateExpression as string;
    expect(expr).toContain("#demoUrl = :demoUrl");
    // ⚠ THE GUARANTEE IS STRUCTURAL: an attribute absent from the expression cannot be written, which
    // is why this is an UpdateCommand rather than the read-merge-put that reassigned authorship.
    expect(expr).not.toContain("createdById");
    expect(expr).not.toContain("createdAt");
    expect(expr).not.toContain("workshopId");
    expect(expr).not.toContain("snapshot");
    // `status` appears only in the CONDITION, never as a SET target.
    expect(expr).not.toContain("#status =");
    expect(sent[0].Key).toEqual({ teamId: "t1", id: "s1" });
  });

  it("always advances updatedAt, even for an empty patch", async () => {
    const { db, sent } = fakeDb({ Attributes: row() });
    await new DynamoSubmissionRepository(db).patch("t1", "s1", {});

    expect(sent[0].UpdateExpression).toBe("SET #updatedAt = :updatedAt");
  });

  /**
   * ⚠ RESERVED WORDS. `status`, `summary` and `solution` are all DynamoDB reserved words. A bare
   * identifier here is a ValidationException at RUNTIME ONLY — it type-checks and every route test
   * passes. This is precisely the class of defect this file exists for.
   */
  it("routes every attribute name through a #placeholder", async () => {
    const { db, sent } = fakeDb({ Attributes: row() });
    await new DynamoSubmissionRepository(db).patch("t1", "s1", {
      summary: "s",
      solution: "x",
      title: "t",
    });

    const expr = sent[0].UpdateExpression as string;
    // Nothing in the expression is a bare attribute name.
    expect(expr).toMatch(/^SET (#[A-Za-z]+ = :[A-Za-z]+)(, #[A-Za-z]+ = :[A-Za-z]+)*$/);
    expect(sent[0].ExpressionAttributeNames).toMatchObject({
      "#summary": "summary",
      "#solution": "solution",
      "#title": "title",
      "#status": "status",
    });
  });

  it("refuses a non-DRAFT row inside the write, not after a read", async () => {
    const { db, sent } = fakeDb({ Attributes: row() });
    await new DynamoSubmissionRepository(db).patch("t1", "s1", { demoUrl: null });

    // ⚠ PART OF THE WRITE. Checking status first would leave a window in which a release lands
    // between the check and the update, so an edit would change what judges already read.
    expect(sent[0].ConditionExpression).toBe("attribute_exists(id) AND #status = :draft");
    expect(sent[0].ExpressionAttributeValues).toMatchObject({ ":draft": "DRAFT" });
  });

  it("keeps an explicit null — clearing a URL is an edit, not an omission", async () => {
    const { db, sent } = fakeDb({ Attributes: row({ demoUrl: null }) });
    await new DynamoSubmissionRepository(db).patch("t1", "s1", { demoUrl: null });

    expect(sent[0].UpdateExpression).toContain("#demoUrl = :demoUrl");
    expect(sent[0].ExpressionAttributeValues).toMatchObject({ ":demoUrl": null });
  });

  it("distinguishes not-found from not-draft by reading only on refusal", async () => {
    // A ConditionalCheckFailed cannot say WHICH half failed, and the caller needs the difference —
    // a 404 and a 409 send someone to different places.
    const notDraft = failingDb({ name: "ConditionalCheckFailedException" }, { Item: row({ status: "SUBMITTED" }) });
    expect(
      await new DynamoSubmissionRepository(notDraft.db).patch("t1", "s1", { title: "x" })
    ).toEqual({ outcome: "not-draft" });

    const missing = failingDb({ name: "ConditionalCheckFailedException" }, {});
    expect(
      await new DynamoSubmissionRepository(missing.db).patch("t1", "s1", { title: "x" })
    ).toEqual({ outcome: "not-found" });
  });

  it("rethrows an error that is not a failed condition", async () => {
    const { db } = failingDb({ name: "ProvisionedThroughputExceededException" }, {});
    await expect(
      new DynamoSubmissionRepository(db).patch("t1", "s1", { title: "x" })
    ).rejects.toMatchObject({ name: "ProvisionedThroughputExceededException" });
  });
});

/**
 * ── ⚠ THE NULL-INDEX-KEY REJECTION, PINNED ──────────────────────────────────────────────────
 *
 * These exist because a probe against a real throwaway DynamoDB table showed that DynamoDB REFUSES a
 * write whose indexed attribute is NULL-typed:
 *
 *   ValidationException: Type mismatch for Index Key releasedAt Expected: S Actual: NULL
 *
 * Not "excludes it from the sparse index" — REFUSES IT. So with `byWorkshop` in place, a `releasedAt:
 * null` draft could not be created AT ALL, and every route test in this service passed while that was
 * true: the fakes hold plain objects and know nothing about index keys.
 *
 * Asserting on the COMMAND INPUT is the only way to catch it without a live table, which is this
 * file's whole reason for existing.
 */
describe("DynamoSubmissionRepository — indexed attributes are absent, never null", () => {
  it("createUnique OMITS releasedAt on a draft rather than sending null", async () => {
    const { db, sent } = fakeDb({});
    await new DynamoSubmissionRepository(db).createUnique(row({ releasedAt: null }));

    const items = sent[0].TransactItems as Array<{ Put: { Item: Record<string, unknown> } }>;
    const submissionItem = items[0].Put.Item;

    expect("releasedAt" in submissionItem, "a NULL index key is rejected by DynamoDB").toBe(false);
    // The non-indexed nullable audit fields are UNAFFECTED — only index keys have this rule.
    expect(submissionItem.reopenedAt).toBeNull();
    expect(submissionItem.snapshot).toBeNull();
  });

  it("put OMITS a null releasedAt and a null workshopId", async () => {
    const { db, sent } = fakeDb({});
    await new DynamoSubmissionRepository(db).put(
      row({ releasedAt: null, workshopId: null })
    );

    expect("releasedAt" in (sent[0].Item ?? {})).toBe(false);
    // `workshopId` is byWorkshop's HASH key, and a pre-P0-3 row can carry null — same rule.
    expect("workshopId" in (sent[0].Item ?? {})).toBe(false);
  });

  it("put KEEPS a real releasedAt — stripping must not apply to a released row", async () => {
    const { db, sent } = fakeDb({});
    await new DynamoSubmissionRepository(db).put(
      row({ releasedAt: "2026-01-05T10:00:00.000Z", status: "SUBMITTED" })
    );

    expect(sent[0].Item?.releasedAt).toBe("2026-01-05T10:00:00.000Z");
  });

  it("reads RESTORE null, so an unreleased submission is not `undefined`", async () => {
    // Stripping alone would be a type lie: the domain promises `string | null`, and a caller
    // testing `releasedAt === null` would get false for a draft.
    const stored = { ...row() } as Record<string, unknown>;
    delete stored.releasedAt;
    delete stored.workshopId;

    const { db } = fakeDb({ Item: stored });
    const got = await new DynamoSubmissionRepository(db).get("t1", "s1");

    expect(got?.releasedAt).toBeNull();
    expect(got?.workshopId).toBeNull();
  });

  it("listReleasedByWorkshop queries the byWorkshop index, newest first, bounded", async () => {
    const { db, sent } = fakeDb({ Items: [row({ status: "SUBMITTED" })] });
    await new DynamoSubmissionRepository(db).listReleasedByWorkshop("w1");

    expect(sent[0].IndexName).toBe("byWorkshop");
    expect(sent[0].KeyConditionExpression).toBe("workshopId = :workshopId");
    expect(sent[0].ExpressionAttributeValues).toEqual({ ":workshopId": "w1" });
    expect(sent[0].ScanIndexForward, "newest release first").toBe(false);
    expect(sent[0].Limit, "every query is bounded").toBe(200);
  });

  /**
   * ⚠ THE FILTER IS NOT REDUNDANT WITH THE SPARSE INDEX, and this is the case that proves it: a
   * REOPENED submission keeps its `releasedAt` (a reopen retains the release audit) and so REMAINS in the index
   * while being a DRAFT again. The index cannot express "currently released"; only the filter can.
   */
  it("excludes a REOPENED submission, which the sparse index still contains", async () => {
    const { db } = fakeDb({
      Items: [
        row({ id: "s-live", status: "SUBMITTED", releasedAt: "2026-01-05T00:00:00.000Z" }),
        row({ id: "s-reopened", status: "DRAFT", releasedAt: "2026-01-04T00:00:00.000Z" }),
      ],
    });

    const { submissions } = await new DynamoSubmissionRepository(db).listReleasedByWorkshop("w1");

    expect(submissions.map((s) => s.id)).toEqual(["s-live"]);
  });

  it("reports truncation from LastEvaluatedKey, not from a full page", async () => {
    const full = { Items: [row({ status: "SUBMITTED" })], LastEvaluatedKey: { teamId: "t1" } };
    const { db } = fakeDb(full);
    expect((await new DynamoSubmissionRepository(db).listReleasedByWorkshop("w1")).truncated).toBe(
      true
    );

    const { db: db2 } = fakeDb({ Items: [row({ status: "SUBMITTED" })] });
    expect((await new DynamoSubmissionRepository(db2).listReleasedByWorkshop("w1")).truncated).toBe(
      false
    );
  });
});
