// ── THE BULK BATCH AUDIT ROW, IN DYNAMODB ────────────────────────────────────────────────
//
// Keyed `workshopId` + `batchId`, because the only read is "show me this experience's uploads, newest
// first" — which that key answers with a single backwards Query and no index. `batchId` is a ULID, so
// the sort key is already chronological; adding a createdAt index would be a second copy of an
// ordering the key gives away for free.

import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type {
  BulkBatch,
  BulkBatchProgress,
  BulkBatchRepository,
} from "./bulk-batch.js";

const TABLE = process.env.TABLE_BULK_BATCHES || "praimana-bulk-batches";

/** See repository.dynamo.ts — matched on `name`, the stable contract on an AWS SDK error. */
function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ConditionalCheckFailedException"
  );
}

export class DynamoBulkBatchRepository implements BulkBatchRepository {
  constructor(private readonly db: DocClient) {}

  async create(batch: BulkBatch): Promise<void> {
    await this.db.send(
      new PutCommand({
        TableName: TABLE,
        Item: batch,
        /**
         * ⚠ NOT AN UPSERT. `batchId` is a fresh ULID so a collision is not a real scenario — but if
         * one ever occurred, overwriting would erase the audit record of a DIFFERENT upload, which is
         * the one thing this table exists to prevent. Failing loudly is strictly better.
         */
        ConditionExpression: "attribute_not_exists(batchId)",
      })
    );
  }

  async update(
    workshopId: string,
    batchId: string,
    progress: BulkBatchProgress
  ): Promise<boolean> {
    /**
     * ⚠ BUILT FROM AN ALLOWLIST OF FIELD NAMES, NOT FROM THE CALLER'S OBJECT KEYS. The update
     * expression is the one place in this file where a name becomes part of a DynamoDB expression, so
     * iterating whatever keys arrived would let a caller name an attribute nobody intended — the
     * status of the row, or a field a future schema adds. Only these seven are writable after accept,
     * and `undefined` values are skipped so a partial progress report does not blank the rest.
     */
    const WRITABLE = [
      "status",
      "startedAt",
      "completedAt",
      "counts",
      "failures",
      "failuresTruncated",
      "reportSent",
      "error",
    ] as const;

    const sets: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    for (const field of WRITABLE) {
      const value = (progress as unknown as Record<string, unknown>)[field];
      if (value === undefined) continue;
      sets.push(`#${field} = :${field}`);
      names[`#${field}`] = field;
      values[`:${field}`] = value;
    }

    // Nothing to write is not an error, but it must not send an empty UpdateExpression.
    if (sets.length === 0) return true;

    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { workshopId, batchId },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          // See the interface note: a PATCH must never MANUFACTURE an audit row for a batch nobody
          // accepted. Without this, a replayed DLQ event whose row was pruned would create one.
          ConditionExpression: "attribute_exists(batchId)",
        })
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async listByWorkshop(workshopId: string, limit: number): Promise<BulkBatch[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "workshopId = :w",
        ExpressionAttributeValues: { ":w": workshopId },
        // Newest first: the sort key is a ULID, so descending IS reverse-chronological.
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items ?? []) as BulkBatch[];
  }
}
