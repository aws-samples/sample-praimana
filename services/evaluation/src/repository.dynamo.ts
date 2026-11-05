import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import { POINTER_ID, isReservedId } from "./domain.js";
import type {
  Submission,
  WorkshopResults,
  WorkshopResultsRepository,
  SubmissionPatch,
  Score,
  MemberRating,
  SubmissionRepository,
  ScoreRepository,
  MemberRatingRepository,
  CreateUniqueOutcome,
  PatchOutcome,
} from "./domain.js";

/**
 * DynamoDB implementations of the Evaluation repositories. These are the ONLY
 * files (with the two read-model modules) that know about DynamoDB commands or
 * table names. Everything else depends on the interfaces in domain.ts. To
 * extract/re-home later, you write a new implementation of the same interfaces —
 * routes stay untouched.
 */

// Tables THIS service owns. It references no other context's tables.
const TABLES = {
  /**
   * ⚠ `-v2`, and the suffix is load-bearing rather than cosmetic.
   *
   * The original `praimana-submissions` was created with the WRONG KEY SCHEMA
   * (`workshopId` HASH / `teamId` RANGE, no GSIs) against code that reads `{teamId, id}` and a
   * `byId` index — so all four methods here raised ValidationException and the feature was
   * non-functional. Correcting the schema needs a table REPLACEMENT, and CloudFormation
   * refuses to replace a custom-named resource, so the table had to be renamed to be fixed.
   *
   * THE DEFAULT MATTERS AS MUCH AS THE ENV VAR. The old table still exists and is empty, so a
   * default left pointing at it would make every read SUCCEED AND RETURN NOTHING — a silent
   * wrong answer, which is worse than the ValidationException it replaced. Keep this in step
   * with `TABLE_SUBMISSIONS` in the infrastructure CloudFormation template.
   */
  submissions:
    process.env.TABLE_SUBMISSIONS || "praimana-submissions-v2",
  scores: process.env.TABLE_SCORES || "praimana-scores",
  /**
   * ⚠ `-v2`, for the same reason as `submissions` above and found at the same time.
   *
   * The original table was keyed (teamId, userId) while the item this service writes carries
   * `teamId`/`id`/`raterId`/`ratedUserId` and no `userId` — so `put` could never succeed and
   * peer ratings were silently non-functional. Correcting the key needs a replacement, and
   * CloudFormation will not replace a custom-named table, so it had to be renamed to be fixed.
   *
   * The default matters as much as the env var: the old table still exists and is empty, so a
   * default left pointing at it makes every read SUCCEED AND RETURN NOTHING — a silent wrong
   * answer, worse than the ValidationException it replaces. Keep in step with
   * `TABLE_MEMBER_RATINGS` in the infrastructure CloudFormation template.
   */
  memberRatings:
    process.env.TABLE_MEMBER_RATINGS || "praimana-member-ratings-v2",
  /**
   * ⚠ NO `-v2` HERE, because this table is NEW rather than corrected. Keep in step with
   * `TABLE_WORKSHOP_RESULTS` in the infrastructure CloudFormation template — and note the default is a
   * table that does not exist until that template is deployed, so every results read fails LOUDLY
   * (ResourceNotFoundException) rather than succeeding and returning nothing.
   */
  workshopResults:
    process.env.TABLE_WORKSHOP_RESULTS || "praimana-workshop-results",
} as const;

/** DynamoDB's cancellation codes, spelled out rather than compared as bare strings at each site. */
const TRANSACTION_CONFLICT = "TransactionConflict";
const TRANSACTION_CONDITION_FAILED = "ConditionalCheckFailed";
/** Four attempts, ~25/50/100ms of jittered backoff. Matches the team service's ledger transaction. */
const TRANSACTION_CONFLICT_ATTEMPTS = 4;
const TRANSACTION_CONFLICT_BASE_DELAY_MS = 25;

/**
 * POSITION OF EACH ITEM IN THE CREATE TRANSACTION.
 *
 * ⚠ NAMED, NOT WRITTEN AS `0`/`1`, because the whole disambiguation below is POSITIONAL: swap the
 * two `TransactItems` without changing these and "another writer already created this team's
 * submission" becomes "this exact id already exists", which are different answers to the caller.
 */
const TX_SUBMISSION_ITEM = 0;
const TX_POINTER_ITEM = 1;

/**
 * How many released submissions one experience's judging list returns.
 *
 * 200 is far above any real workshop (the largest run so far is single-digit teams) and far below a
 * page size that would matter. It exists because "every query is bounded" is a standing constraint,
 * not because 200 is a product decision — and the caller REPORTS truncation rather than hiding it.
 */
const MAX_SUBMISSIONS_PER_WORKSHOP = 200;

/**
 * A cancellation caused by CONTENTION rather than by an answer.
 *
 * Mirrors `team/src/repository.dynamo.ts:151`. Two shapes: the standalone
 * `TransactionConflictException`, and a `TransactionCanceledException` whose reasons include one.
 */
function isTransactionConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === "TransactionConflictException") return true;
  if (name !== "TransactionCanceledException") return false;
  const reasons = (err as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  return reasons.some(
    (r) =>
      typeof r === "object" && r !== null && (r as { Code?: unknown }).Code === TRANSACTION_CONFLICT
  );
}

/**
 * Retry ONLY on contention.
 *
 * A `ConditionalCheckFailed` is an ANSWER — "this team already has a submission" — and retrying it
 * returns the same answer more slowly. A `TransactionConflict` is not an answer at all, so it is the
 * one reason worth another attempt.
 */
async function withConflictRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= TRANSACTION_CONFLICT_ATTEMPTS || !isTransactionConflict(err)) throw err;
      // Exponential with full jitter. `Math.random` is backoff timing — not observable, not
      // required to be reproducible.
      const ceiling = TRANSACTION_CONFLICT_BASE_DELAY_MS * 2 ** (i - 1);
      await new Promise((r) => setTimeout(r, Math.random() * ceiling));
    }
  }
}

/** Which items' conditions failed, by position — or null when this was not a cancelled transaction. */
function transactionConditionFailures(err: unknown): boolean[] | null {
  if (
    typeof err !== "object" ||
    err === null ||
    !("name" in err) ||
    (err as { name: unknown }).name !== "TransactionCanceledException"
  ) {
    return null;
  }
  const reasons = (err as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return null;
  return reasons.map(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      (r as { Code?: unknown }).Code === TRANSACTION_CONDITION_FAILED
  );
}

/**
 * ── ⚠ AN INDEXED ATTRIBUTE MUST BE ABSENT, NOT NULL — AND DYNAMODB REFUSES THE WRITE ────────
 *
 * MEASURED against a real throwaway DynamoDB table, because
 * this is exactly the class of thing no in-memory fake can tell you. Writing a draft with
 * `releasedAt: null` while a GSI keys on `releasedAt` fails:
 *
 *   ValidationException: One or more parameter values were invalid:
 *   Type mismatch for Index Key releasedAt Expected: S Actual: NULL
 *
 * ⚠ IT IS A REJECTION, NOT AN EXCLUSION. The intuition — "a null key just keeps the item out of the
 * sparse index" — is WRONG, and believing it would have meant NO DRAFT COULD BE CREATED AT ALL once
 * `byWorkshop` existed. Every unit test in this service passed while that was true; the fakes hold
 * plain objects and have no notion of an index key. Same shape as the BACKLOG entry about fakes
 * accepting an illegal DynamoDB expression.
 *
 * The third probe row settled the fix: with the attribute ABSENT the write succeeds, the item is in
 * the base table, and the index correctly does not contain it.
 *
 * ⚠ SO WRITES STRIP, AND READS RESTORE. Stripping alone would make readers see `undefined` where the
 * domain type promises `string | null`, which is a type lie that would surface as
 * `releasedAt === null` being false for an unreleased submission. Both halves live HERE, in the
 * adapter, because the adapter is the only layer that should know DynamoDB has this rule at all.
 *
 * ⚠ AND IT IS WHY THE `status` FILTER ON `listReleasedByWorkshop` IS NOT MERELY DEFENSIVE. A REOPENED
 * submission KEEPS its `releasedAt` (a reopen retains the release audit), so it stays in the sparse index
 * while being a DRAFT again. The index cannot express "currently released"; only the filter can.
 */
const INDEXED_NULLABLE_ATTRIBUTES = ["releasedAt", "workshopId"] as const;

function forStorage(submission: Submission): Record<string, unknown> {
  const item: Record<string, unknown> = { ...submission };
  for (const attribute of INDEXED_NULLABLE_ATTRIBUTES) {
    if (item[attribute] === null) delete item[attribute];
  }
  return item;
}

/** The inverse: an absent indexed attribute reads back as the `null` the domain type promises. */
function fromStorage(item: Record<string, unknown> | undefined): Submission | null {
  if (!item) return null;
  const row = { ...item } as Record<string, unknown>;
  for (const attribute of INDEXED_NULLABLE_ATTRIBUTES) {
    if (row[attribute] === undefined) row[attribute] = null;
  }
  return row as unknown as Submission;
}

export class DynamoSubmissionRepository implements SubmissionRepository {
  constructor(private readonly db: DocClient) {}

  async get(teamId: string, id: string): Promise<Submission | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.submissions, Key: { teamId, id } })
    );
    return fromStorage(res.Item as Record<string, unknown> | undefined);
  }

  /** Resolve a submission by its opaque id alone (used by the scoring routes,
   *  which are not team-scoped). Backed by a GSI on `id` in production; here it
   *  scans the id index via a query on the reverse key. */
  async getById(submissionId: string): Promise<Submission | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.submissions,
        IndexName: "byId",
        KeyConditionExpression: "id = :id",
        ExpressionAttributeValues: { ":id": submissionId },
        Limit: 1,
      })
    );
    return fromStorage(res.Items?.[0] as Record<string, unknown> | undefined);
  }

  async listByTeam(teamId: string): Promise<Submission[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.submissions,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
        ScanIndexForward: false,
      })
    );
    /**
     * ⚠ THE POINTER ROW SHARES THIS PARTITION AND IS NOT A SUBMISSION.
     *
     * Filtered in the CLIENT rather than with a `KeyConditionExpression` on `id`, because the
     * sentinel sorts as `#…` — below every ULID — so excluding it by range would mean encoding an
     * assumption about ULID ordering into the query. `isReservedId` is the same predicate the writer
     * refuses ids with, so reader and writer cannot disagree about what "reserved" means.
     */
    return ((res.Items as Array<Record<string, unknown>>) ?? [])
      .map((row) => fromStorage(row) as Submission)
      .filter((row) => !isReservedId(row.id));
  }

  async put(submission: Submission): Promise<Submission> {
    await this.db.send(
      // ⚠ `forStorage`, ALWAYS. A release writes a non-null `releasedAt`, but a REOPEN writes this
      // same row back with `status: "DRAFT"` and the audit intact, and a legacy row can still carry
      // `workshopId: null`. One conversion on the way out is what keeps every caller safe.
      new PutCommand({ TableName: TABLES.submissions, Item: forStorage(submission) })
    );
    return submission;
  }

  /**
   * ── ⚠ THE `byWorkshop` GSI, AND WHY ITS RANGE KEY IS `releasedAt` ───────────────────────
   *
   * `workshopId` HASH + `releasedAt` RANGE, projection ALL. Two properties fall out of that choice:
   *
   *   1. NEWEST RELEASE FIRST for free (`ScanIndexForward: false`), which is the order a judging
   *      panel wants.
   *   2. THE INDEX IS SPARSE. DynamoDB indexes an item only when EVERY key attribute is present and
   *      of the indexed type, and a DRAFT carries `releasedAt: null` — type NULL, not a string — so
   *      drafts are absent from the index altogether.
   *
   * ⚠ AND THE STATUS FILTER BELOW IS STILL APPLIED, DELIBERATELY. Sparseness is an OPTIMISATION here,
   * never the access control: if it were the control, then the day someone writes `releasedAt: ""` or
   * backfills a placeholder, every draft in the experience appears in a judge's list — a leak caused
   * by a data change far from this file. Two independent reasons a draft cannot be listed is the
   * right number when the failure is "the panel reads work the team had not submitted".
   *
   * ⚠ BOUNDED, AND TRUNCATION IS REPORTED. A silently short list reads as "that team never
   * submitted", which is the same class of lie the unavailable-not-an-answer rule forbids.
   */
  async listReleasedByWorkshop(
    workshopId: string,
    limit = MAX_SUBMISSIONS_PER_WORKSHOP
  ): Promise<{ submissions: Submission[]; truncated: boolean }> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.submissions,
        IndexName: "byWorkshop",
        KeyConditionExpression: "workshopId = :workshopId",
        ExpressionAttributeValues: { ":workshopId": workshopId },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    const rows = ((res.Items as Array<Record<string, unknown>>) ?? []).map(
      (row) => fromStorage(row) as Submission
    );
    return {
      submissions: rows.filter((s) => s.status === "SUBMITTED" && !isReservedId(s.id)),
      // `LastEvaluatedKey` rather than `rows.length === limit`: a full page that happens to be the
      // last page is not truncation, and reporting it as such would show a warning forever.
      truncated: Boolean(res.LastEvaluatedKey),
    };
  }

  async pointer(teamId: string): Promise<string | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.submissions, Key: { teamId, id: POINTER_ID } })
    );
    return (res.Item as { submissionId?: string } | undefined)?.submissionId ?? null;
  }

  /**
   * ── ONE SUBMISSION PER TEAM, HELD BY THE STORE ──────────────────────
   *
   * Both rows or neither: the submission under `attribute_not_exists(id)`, and the pointer under the
   * same condition. Two concurrent creates therefore cannot both win — one commits, the other's
   * POINTER condition fails and it is told the winner's id.
   *
   * ⚠ WHY NOT `listByTeam()` THEN `put()`. A route-level "does one already exist?" read cannot hold
   * against a concurrent writer: both callers read "none", both write, and the team has two
   * submissions with no error anywhere. The same conditional-transaction reasoning, reused verbatim.
   */
  async createUnique(submission: Submission): Promise<CreateUniqueOutcome> {
    try {
      await withConflictRetry(() =>
        this.db.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: TABLES.submissions,
                  // ⚠ WITHOUT `forStorage` THIS TRANSACTION IS REJECTED OUTRIGHT: a new submission has
                  // `releasedAt: null`, and `byWorkshop` keys on it. See the note above `forStorage`.
                  Item: forStorage(submission),
                  ConditionExpression: "attribute_not_exists(id)",
                },
              },
              {
                Put: {
                  TableName: TABLES.submissions,
                  Item: {
                    teamId: submission.teamId,
                    id: POINTER_ID,
                    submissionId: submission.id,
                  },
                  ConditionExpression: "attribute_not_exists(id)",
                },
              },
            ],
          })
        )
      );
      return { outcome: "created", submission };
    } catch (err) {
      const failures = transactionConditionFailures(err);
      /**
       * Not a cancelled transaction, or cancelled for a reason not modelled here (throttle,
       * validation). RETHROWN — reporting "a submission already exists" on a throttle would send the
       * caller to look at a record that is not there.
       */
      if (!failures) throw err;

      /**
       * ⚠ THE POINTER IS THE AUTHORITY, so its failure is checked FIRST. Either condition failing
       * means the team already has a submission; the pointer is the row that says WHICH.
       *
       * The submission item's condition can fail on its own when a caller re-sends an explicit `id`
       * that already exists — same conclusion for the caller (nothing new was created), reached by a
       * different route, so the pointer read below covers both.
       */
      if (failures[TX_POINTER_ITEM] || failures[TX_SUBMISSION_ITEM]) {
        const existing = await this.pointer(submission.teamId);
        /**
         * ⚠ A FAILED CONDITION WITH NO POINTER MEANS A PRE-POINTER ROW EXISTS. Rows created before
         * this change have no pointer, so falling back to the id we tried is wrong — it is the id
         * that did NOT get written. `listByTeam` is the only honest answer, and an empty result
         * would be a genuine contradiction worth surfacing rather than papering over.
         */
        if (existing) return { outcome: "exists", submissionId: existing };
        const rows = await this.listByTeam(submission.teamId);
        if (rows.length > 0) return { outcome: "exists", submissionId: rows[0].id };
        throw err;
      }
      throw err;
    }
  }

  /**
   * ── EDITING A DRAFT WITHOUT REWRITING AUTHORSHIP ────────────────────────────────
   *
   * ⚠ AN `UpdateCommand` OVER NAMED ATTRIBUTES, NOT A READ-MERGE-`put`. Two reasons, and both are
   * about what the old `put` did:
   *
   *   1. It rewrote `createdById` and `createdAt` from the current caller, so a second teammate
   *      saving a draft silently reassigned authorship. Attributes that are not in this
   *      `UpdateExpression` CANNOT be touched — the guarantee is structural, not remembered.
   *   2. A read-merge-write also loses a concurrent teammate's edit to a different field, because
   *      the whole item is overwritten by whatever the reader had.
   *
   * ⚠ THE `DRAFT` CHECK IS PART OF THE WRITE, not a preceding read. Checking status first would
   * leave a window in which an executive releases the submission between the check and the write, so
   * an edit would land on a released record and change what judges see after the snapshot was taken.
   */
  async patch(teamId: string, id: string, fields: SubmissionPatch): Promise<PatchOutcome> {
    const entries = Object.entries(fields) as Array<[keyof SubmissionPatch, string | null]>;

    // `updatedAt` is always written, so a patch that sets nothing else still records that the team
    // touched the draft. Names go through #placeholders — `status`, `summary` and `solution` are all
    // DynamoDB reserved words, and a bare identifier is a ValidationException at runtime only.
    const names: Record<string, string> = { "#updatedAt": "updatedAt", "#status": "status" };
    const values: Record<string, unknown> = {
      ":updatedAt": new Date().toISOString(),
      ":draft": "DRAFT",
    };
    const sets = ["#updatedAt = :updatedAt"];

    for (const [field, value] of entries) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }

    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: TABLES.submissions,
          Key: { teamId, id },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: "attribute_exists(id) AND #status = :draft",
          ReturnValues: "ALL_NEW",
        })
      );
      return {
        outcome: "patched",
        submission: fromStorage(res.Attributes as Record<string, unknown>) as Submission,
      };
    } catch (err) {
      if ((err as { name?: string })?.name !== "ConditionalCheckFailedException") throw err;
      /**
       * ⚠ THE TWO REFUSALS ARE INDISTINGUISHABLE FROM THE CANCELLATION ALONE — DynamoDB reports one
       * `ConditionalCheckFailed` for "no such row" and for "row is SUBMITTED". A read decides which,
       * and the caller needs the difference: a 404 and a 409 send someone to different places.
       *
       * The read is only on the REFUSAL path, so the happy path stays one round trip.
       */
      const current = await this.get(teamId, id);
      return current ? { outcome: "not-draft" } : { outcome: "not-found" };
    }
  }
}

export class DynamoScoreRepository implements ScoreRepository {
  constructor(private readonly db: DocClient) {}

  async listBySubmission(submissionId: string): Promise<Score[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.scores,
        KeyConditionExpression: "submissionId = :submissionId",
        ExpressionAttributeValues: { ":submissionId": submissionId },
      })
    );
    return (res.Items as Score[]) ?? [];
  }

  /**
   * ⚠ `attribute_not_exists(submissionId)` — A JUDGE SCORES ONCE, AND THIS IS WHAT MAKES THAT TRUE.
   *
   * Identical shape to `DynamoWorkshopResultsRepository.create` beside this file, for identical
   * reasons: a read-then-write loses a double-click, and the refusal is an ANSWER rather than a fault
   * so the route can answer 409.
   *
   * The condition names the PARTITION key, which is the idiom for "this item must not already exist" —
   * the pair `(submissionId, judgeId)` is the row's identity, so a second score from the SAME judge is
   * refused while a different judge's score is a different row and lands normally.
   */
  async create(score: Score): Promise<"created" | "already-scored"> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.scores,
          Item: score,
          ConditionExpression: "attribute_not_exists(submissionId)",
        })
      );
      return "created";
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return "already-scored";
      }
      throw err;
    }
  }
}

export class DynamoMemberRatingRepository implements MemberRatingRepository {
  constructor(private readonly db: DocClient) {}

  async listByTeam(teamId: string): Promise<MemberRating[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.memberRatings,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as MemberRating[]) ?? [];
  }

  /**
   * ⚠ CONDITIONAL, and the id encodes the (rater, rated) pair — see MemberRatingRepository.create.
   * `attribute_not_exists(teamId)` on a Put means "no item on this KEY"; for a composite key,
   * naming either key attribute is the idiomatic existence test, since a stored item has both.
   */
  async create(rating: MemberRating): Promise<"created" | "already-rated"> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.memberRatings,
          Item: rating,
          ConditionExpression: "attribute_not_exists(teamId)",
        })
      );
      return "created";
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return "already-rated";
      }
      throw err;
    }
  }
}

export class DynamoWorkshopResultsRepository implements WorkshopResultsRepository {
  constructor(private readonly db: DocClient) {}

  async get(workshopId: string): Promise<WorkshopResults | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.workshopResults, Key: { workshopId } })
    );
    return (res.Item as WorkshopResults) ?? null;
  }

  /**
   * ⚠ `attribute_not_exists(workshopId)` — PUBLICATION IS ONCE, AND THE STORE ENFORCES IT.
   *
   * Not a "have they published already?" read followed by a write: two owners pressing Publish in the
   * same second would both read "no" and both write, and the stored ranking would be whichever landed
   * second. A declared result changing under the people who declared it is the failure to avoid.
   *
   * The refusal is an ANSWER ("already published"), not an error — so the route can report it as a 409
   * rather than a fault.
   */
  async create(results: WorkshopResults): Promise<"created" | "already-published"> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.workshopResults,
          Item: results,
          ConditionExpression: "attribute_not_exists(workshopId)",
        })
      );
      return "created";
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return "already-published";
      }
      throw err;
    }
  }

  /**
   * Withdraw the ranking so the experience can be judged again. See the interface note: the only caller
   * is REOPEN, and the released snapshot is deliberately left alone.
   *
   * Unconditional, because DELETE on an absent key is already a no-op in DynamoDB — a reopen on an
   * unpublished experience must not fail.
   */
  async clear(workshopId: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({
        TableName: TABLES.workshopResults,
        Key: { workshopId },
      })
    );
  }
}
