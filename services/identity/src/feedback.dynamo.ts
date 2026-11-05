import { PutCommand, QueryCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { FeedbackPage, FeedbackReport, FeedbackRepository } from "./domain.js";

/**
 * DynamoDB store for feedback and bug reports.
 *
 * ── ⚠ TWO GSIs, AND NEITHER IS DECORATION ──
 *
 * The table is keyed on `id` alone (a ULID), which answers "get one report" and nothing else. The two
 * access patterns the Administration screen actually has both need an index:
 *
 *   · `byCreated`  — HASH `entity` (the constant "FEEDBACK") + RANGE `createdAt`. A constant partition key
 *     so every report lands in one partition and can be read NEWEST FIRST in one Query.
 *     ⚠ YES, THAT IS A HOT PARTITION BY CONSTRUCTION. It is the right trade here and would not be at
 *     volume: reports arrive at human speed (a handful per workshop), and the alternative — a Scan with
 *     a sort in the Lambda — cannot paginate and gets slower with every row ever written. If this ever
 *     took real write volume the fix is a sharded key (`FEEDBACK#<yyyy-mm>`), and the read would then
 *     have to fan out across shards.
 *
 *   · `unread` — HASH `unread`, present ONLY while the report is NEW. A SPARSE index: acknowledged rows
 *     leave it altogether, so the badge count is a Query with `Select: COUNT` over exactly the unread
 *     rows rather than a Scan of everything with a filter.
 *
 * ── ⚠ THE NULL-INDEX-KEY TRAP, WHICH THIS SERVICE IS THE SECOND TO HIT ──
 *
 * DynamoDB REJECTS a write whose index key attribute is present-but-NULL. It does not quietly skip the
 * index; the whole `PutItem` fails. So a sparse key must be ABSENT, which means DELETING the property
 * rather than assigning `null` — and reads must put it back so the domain type stays honest.
 *
 * `apps/services/evaluation/src/repository.dynamo.ts` carries the identical warning after the identical
 * trap. Two services now, which is why this comment names it rather than assuming the next reader knows.
 */

/** Constant partition key for the `byCreated` index — see the note above on why it is constant. */
const ENTITY = "FEEDBACK";

/** Page size for list(). Bounded so one screen load cannot become an unbounded read. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Attributes that are INDEX KEYS and may legitimately be absent.
 *
 * One entry today. Named as a list anyway, because the moment there are two the shape of the fix matters
 * more than the saving of writing it out once.
 */
const SPARSE_INDEX_KEYS = ["unread"] as const;

/** Strip absent sparse keys before writing — see the NULL-index-key note in the header. */
function forStorage(report: FeedbackReport): Record<string, unknown> {
  const item: Record<string, unknown> = { ...report, entity: ENTITY };
  for (const key of SPARSE_INDEX_KEYS) {
    if (item[key] === null || item[key] === undefined) delete item[key];
  }
  return item;
}

/** Drop the storage-only `entity` attribute on the way out, so callers see the domain type. */
function fromStorage(item: Record<string, unknown> | undefined): FeedbackReport | null {
  if (!item) return null;
  const row = { ...item };
  delete row.entity;
  /**
   * ⚠ A ROW WRITTEN BEFORE `subject` EXISTED HAS NONE, and the domain type says `string`. The cast below
   * would happily hand a caller `undefined` under a `string` annotation — the inbox would then render
   * "undefined" as a heading, or throw on `.trim()`, at the one moment somebody is trying to read a bug
   * report. Normalised here, at the boundary that knows the row is old, rather than by every reader
   * guessing.
   *
   * Empty rather than a placeholder like "(no subject)": the display decides how to word an absence, and a
   * sentinel stored in a string field is one somebody will eventually search for as if it were real.
   */
  if (typeof row.subject !== "string") row.subject = "";
  return row as unknown as FeedbackReport;
}

export class DynamoFeedbackRepository implements FeedbackRepository {
  private readonly table = process.env.TABLE_FEEDBACK || "praimana-feedback";

  constructor(private readonly db: DocClient) {}

  async create(report: FeedbackReport): Promise<FeedbackReport> {
    await this.db.send(
      new PutCommand({ TableName: this.table, Item: forStorage(report) })
    );
    return report;
  }

  async list(opts: { limit?: number; cursor?: string } = {}): Promise<FeedbackPage> {
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "byCreated",
        KeyConditionExpression: "#entity = :entity",
        ExpressionAttributeNames: { "#entity": "entity" },
        ExpressionAttributeValues: { ":entity": ENTITY },
        // Newest first — an inbox is read from the top.
        ScanIndexForward: false,
        Limit: limit,
        ...(opts.cursor
          ? { ExclusiveStartKey: JSON.parse(Buffer.from(opts.cursor, "base64url").toString()) }
          : {}),
      })
    );

    /**
     * ⚠ THE COUNT IS A SECOND QUERY, NOT `items.filter(...)`. Filtering the page would count only the
     * unread reports ON THIS PAGE — so a badge would read "3" while fifty more sat behind the cursor. It
     * is a `Select: COUNT` over the sparse index, so it reads no item bodies.
     */
    const unreadCount = await this.unreadCount();

    return {
      items: (res.Items ?? [])
        .map((item) => fromStorage(item as Record<string, unknown>))
        .filter((r): r is FeedbackReport => r !== null),
      // base64url so the cursor survives a query string without escaping.
      ...(res.LastEvaluatedKey
        ? { nextCursor: Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64url") }
        : {}),
      unreadCount,
    };
  }

  async unreadCount(): Promise<number> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "unread",
        KeyConditionExpression: "#unread = :new",
        ExpressionAttributeNames: { "#unread": "unread" },
        ExpressionAttributeValues: { ":new": "NEW" },
        // ⚠ COUNT, not the items. The badge needs a number; reading fifty report bodies to produce one
        // integer is the kind of waste that only shows up under load.
        Select: "COUNT",
      })
    );
    return res.Count ?? 0;
  }

  async acknowledge(
    id: string,
    adminId: string,
    at: string
  ): Promise<FeedbackReport | null> {
    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id },
          /**
           * ⚠ `REMOVE unread` IS THE WHOLE POINT OF THIS WRITE. Setting the status is cosmetic; removing
           * the sparse index key is what takes the report out of the badge count. Forgetting the REMOVE
           * would leave a permanently non-zero counter that no amount of clicking could clear.
           */
          UpdateExpression:
            "SET #status = :ack, acknowledgedAt = :at, acknowledgedById = :by REMOVE #unread",
          ExpressionAttributeNames: { "#status": "status", "#unread": "unread" },
          ExpressionAttributeValues: { ":ack": "ACKNOWLEDGED", ":at": at, ":by": adminId },
          // ⚠ ONLY that the row EXISTS — deliberately NOT `#status = NEW`. Two admins clicking at once is
          // the normal case, and a conditional failure there would raise an error about something that is
          // already true. Idempotent by design (see the port).
          ConditionExpression: "attribute_exists(id)",
          ReturnValues: "ALL_NEW",
        })
      );
      return fromStorage(res.Attributes as Record<string, unknown> | undefined);
    } catch (err) {
      // The only condition is existence, so a failure here means "no such report" — a 404 for the route,
      // not a 500. Any other error still propagates.
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }

  /** Read one report. Not on the port — used only by tests and future support tooling. */
  async get(id: string): Promise<FeedbackReport | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { id } })
    );
    return fromStorage(res.Item as Record<string, unknown> | undefined);
  }
}
