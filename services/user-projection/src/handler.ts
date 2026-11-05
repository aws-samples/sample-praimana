import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  Context,
  DynamoDBBatchItemFailure,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";

/**
 * THE PROJECTION. Fans every change to `praimana-users` out into all FIVE
 * services' local users read-models, so member lists, chat authors, commit authors,
 * shared-thread bylines and contribution rows render a NAME instead of null.
 *
 * WHY THIS EXISTS. Five services (ai, team, collaboration, evaluation, source) each
 * keep a tiny private projection of `{id, name, email}` rather than reading Identity's
 * users table — that is the whole point of the bounded-context split, and it is what
 * lets a roster render without a synchronous hop into Identity per member. Each
 * read-model class carries the same comment: "populated by consuming the Identity
 * service's user.created / user.updated events (WIRE THE CONSUMER TO CALL upsert())".
 *
 * ── WHY A DYNAMODB STREAM AND NOT AN EVENT ──
 *
 * This function originally consumed EventBridge, and that is what it was still doing
 * when names came back as raw email addresses. Two independent defects, both structural:
 *
 *   1. `praimana-users` has FIVE writers (Identity's PATCH /me, the Cognito
 *      post-confirmation trigger, user-access's setStatus, scripts/create-admin.mjs,
 *      and a console edit). Only two published `user.created` — one conditionally, one
 *      on a code path that is disabled. `user.updated` was SUBSCRIBED by the rule and
 *      published by NOTHING, so completing a profile via PATCH /me never reached a
 *      read-model. Every new writer is a new chance to forget the publish.
 *   2. EventBridge gives no ordering. Two writes to one row can be delivered and
 *      projected out of order, and because the projection is last-write-wins that
 *      leaves the WRONG name in place permanently, not transiently.
 *
 * A stream on the table fixes both by construction: there is no publisher to forget,
 * and DynamoDB Streams guarantee per-key ordering within a shard. The alternatives
 * (publish `user.updated` from PATCH /me; have Identity write all five tables itself)
 * were rejected — the first covers 1 writer of 5 and keeps the ordering hazard, the
 * second puts five-table convergence inside a form-save's latency budget.
 *
 * ── Design notes ──
 *
 * IDEMPOTENT BY CONSTRUCTION. Stream delivery is at-least-once, so this WILL see the
 * same record twice — a retried batch replays every record in it. A `PutCommand` of a
 * full item is naturally idempotent: replaying it writes byte-identical data. There is
 * deliberately no read-then-write and no conditional expression — the projection has no
 * history to protect (unlike an invitation's acceptedAt), and the row carries no
 * timestamp and no counter, which is what makes a plain Put safe to replay.
 *
 * LAST-WRITE-WINS IS SAFE ONLY BECAUSE THE SHARD IS ORDERED. The stream hands us a
 * key's changes in the order they happened, and this handler applies records
 * SEQUENTIALLY (see projectBatch), so the newest image is written last. Both halves of
 * that are load-bearing: `ParallelizationFactor` MUST stay 1, and a SECOND event source
 * mapping on this stream is forbidden — either one lets two concurrent invocations hold
 * two images of the same user and race, which is the exact defect EventBridge had.
 *
 * PARTIAL FAILURE IS REPORTED PER RECORD, NOT THROWN. On the stream path a thrown error
 * fails the WHOLE batch, and one permanently-poison record then stalls the shard until
 * the record ages out — every other user's name stops updating behind it. So the stream
 * path returns `batchItemFailures` and the EventBridge path (which has no shard to
 * stall, and whose rule has its own DLQ) still throws.
 *
 * NO CROSS-TABLE TRANSACTION. The five tables are owned by five different bounded
 * contexts; a TransactWriteItems across them would couple their availability, which is
 * the opposite of why they are separate. They converge independently.
 *
 * NO DELETE. A REMOVE record is ignored, and the role holds no DeleteItem: revocation
 * in this system is disable-not-delete (see user-access's setStatus and the invitations
 * DeleteItem note in the template), so a user row disappearing is either a mistake or a
 * hard purge. Leaving a stale display name behind is strictly better than a roster row
 * that renders blank, which reads as a broken component.
 */

/**
 * Bounds on a single PutItem, because the SDK's defaults leave the socket without a
 * deadline and this handler is on a shard that must not be held open.
 *
 * 2s is ~200x the p99 of a PutItem against an on-demand table; anything slower is a
 * throttle or a network fault, and waiting on it only burns the shard's progress. Three
 * attempts covers a retryable throttle without turning one bad dependency into a
 * 15s-timeout function error (which would fail the whole batch instead of one record).
 */
const DDB_REQUEST_TIMEOUT_MS = 2_000;
const DDB_CONNECTION_TIMEOUT_MS = 1_000;
const DDB_MAX_ATTEMPTS = 3;

/**
 * Wall-clock reserve kept back so the handler can always RETURN its
 * `batchItemFailures` rather than being killed on the Lambda timeout.
 *
 * Being killed is the bad outcome: the ESM sees a function error, retries the entire
 * batch, and we lose the per-record granularity that keeps one poison record from
 * stalling the shard. 2s is comfortably more than the return path needs.
 */
const RESPONSE_RESERVE_MS = 2_000;

/**
 * Budget used when no Lambda Context is supplied (tests, or a future direct call).
 * Matches the template's 15s function Timeout minus the reserve above, so the fallback
 * cannot be MORE generous than the real deadline.
 */
const FALLBACK_BUDGET_MS = 13_000;

const client = new DynamoDBClient({
  maxAttempts: DDB_MAX_ATTEMPTS,
  requestHandler: {
    requestTimeout: DDB_REQUEST_TIMEOUT_MS,
    connectionTimeout: DDB_CONNECTION_TIMEOUT_MS,
  },
});
const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * The read-models to keep in step, resolved from env so the wiring lives in the
 * template rather than here. Names default to the same literals each service's own
 * read-model class defaults to — if those drift, the projection writes to a table
 * nothing reads, which is why the defaults are duplicated rather than invented.
 *
 * ALL SIX, and the count is asserted in handler.test.ts. It was three for the whole
 * life of the deployment while five services had a read-model class, so
 * `praimana-ai-users-readmodel` and `praimana-evaluation-users-readmodel`
 * sat at 0 rows with a READER and no writer: ai/src/routes.ts recorded
 * `sharedByName: null` on every shared thread and evaluation/src/routes.ts rendered
 * `name: null` on every contribution row. A table with a reader and no writer fails
 * silently by design — the reader's `?? null` is indistinguishable from "no name yet".
 */
export const TARGET_TABLES = [
  process.env.TABLE_TEAM_USERS_READMODEL || "praimana-team-users-readmodel",
  process.env.TABLE_COLLABORATION_USERS_READMODEL ||
    "praimana-collaboration-users-readmodel",
  process.env.TABLE_SOURCE_USERS_READMODEL || "praimana-source-users-readmodel",
  process.env.TABLE_AI_USERS_READMODEL || "praimana-ai-users-readmodel",
  process.env.TABLE_EVALUATION_USERS_READMODEL ||
    "praimana-evaluation-users-readmodel",
  /**
   * SIXTH, added with the docs service's read-model rather than after it. The comment above records
   * what happens otherwise: a reader with no writer sits at 0 rows and renders a null name for ever,
   * indistinguishable from "no name yet". Docs had the inverse problem — no reader at all — and
   * fixing that without this entry would have produced exactly the documented failure.
   */
  process.env.TABLE_DOCS_USERS_READMODEL || "praimana-docs-users-readmodel",
];

/** The `{id, name, email}` projection every read-model stores. */
export interface UserView {
  id: string;
  name: string;
  email?: string;
}

/**
 * Turn an event detail — or an unmarshalled stream NewImage, which is the same shape —
 * into the projection row, or null when it cannot be one.
 *
 * PURE, and exported, so the whole decision table is testable without a DynamoDB
 * client. ONE function for both event shapes deliberately: a stream record and an
 * EventBridge detail must project IDENTICALLY, or a row's name would depend on which
 * path delivered it and the cutover would be visible to users.
 *
 * The validation matters more than it looks:
 *
 *   - `id` is the PARTITION KEY. A row without one cannot be written at all, so an
 *     event missing it is dropped rather than throwing — throwing would retry forever
 *     and then DLQ an event that can never succeed.
 *   - `name` FALLS BACK TO THE EMAIL, then to the id. A read-model row whose name is
 *     empty renders as a blank line, which is worse than "Unknown" because it looks
 *     like a rendering bug rather than missing data. Note user-access already
 *     publishes `name: user.email` for admin-provisioned users, so the email fallback
 *     is the common case, not an edge one.
 *   - `email` is OMITTED when absent rather than written as undefined/"" — the field
 *     is optional on UserView and a blank string would render as an empty contact.
 *   - Everything else on the row is DROPPED, `role` above all: copying it into a
 *     read-model invites a reader to authorize against a stale copy. This matters more
 *     now than it did on the EventBridge path, because a stream NewImage carries the
 *     WHOLE user row (authProvider, status, timestamps) rather than a
 *     hand-built detail — an allowlist of three fields, not a spread.
 */
export function toUserView(detail: unknown): UserView | null {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;

  const id = typeof d.id === "string" ? d.id.trim() : "";
  if (!id) return null;

  const email = typeof d.email === "string" ? d.email.trim() : "";
  const rawName = typeof d.name === "string" ? d.name.trim() : "";
  // Never empty: a blank name in a roster reads as a broken component.
  const name = rawName || email || id;

  return { id, name, ...(email ? { email } : {}) };
}

/** The AttributeValue map shape `unmarshall` accepts. @types/aws-lambda declares its
 *  own structurally-incompatible AttributeValue union, so the bridge is a named cast
 *  here rather than an `any` at each call site. */
type StreamImage = Parameters<typeof unmarshall>[0];

/**
 * Decode a stream record's NewImage into a projection row.
 *
 * Returns null for anything unprojectable — a REMOVE record (which carries OldImage
 * only), a KEYS_ONLY-shaped record, or an image with no usable id. All of those are
 * ACKNOWLEDGED by the caller, never retried: none of them can become writable on a
 * second attempt.
 *
 * `unmarshall` can throw on an attribute type it does not know. That is deterministic
 * per record, so it is treated the same way — logged and acknowledged — because
 * retrying it three times and then stalling the shard produces the same nothing, more
 * slowly, for every user behind it.
 */
export function recordToUserView(record: DynamoDBRecord): UserView | null {
  const image = record.dynamodb?.NewImage;
  if (!image) return null;

  let plain: Record<string, unknown>;
  try {
    plain = unmarshall(image as unknown as StreamImage);
  } catch (err) {
    // No id logged: we could not decode the image, so we have nothing safe to name it
    // by except the stream's own sequence number.
    console.error("[user-projection] could not unmarshall stream image", {
      eventName: record.eventName,
      sequenceNumber: record.dynamodb?.SequenceNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  return toUserView(plain);
}

/**
 * Write one projection row to all five read-models. Returns the tables that failed.
 *
 * Settled, not all: one context's table being throttled must not stop the other four
 * converging. `Promise.all` would abandon the remaining writes on the first rejection —
 * which is how a single throttled table would leave four read-models stale.
 *
 * `abortSignal` is the caller's deadline, and it is passed to every send rather than
 * merely checked before them: `requestTimeout` bounds ONE attempt, so three retried
 * attempts against a throttled table can outlive the batch's remaining budget and get
 * the function killed — losing the partial-failure report entirely. An aborted send
 * rejects, which reports that record for re-delivery, which is the right answer.
 *
 * Never logs `name` or `email`. The id is the correlation handle an operator needs; the
 * display name and address are user data and do not belong in CloudWatch.
 */
async function writeAll(view: UserView, abortSignal?: AbortSignal): Promise<string[]> {
  const results = await Promise.allSettled(
    TARGET_TABLES.map((TableName) =>
      db.send(new PutCommand({ TableName, Item: view }), { abortSignal })
    )
  );

  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status !== "rejected") return;
    failed.push(TARGET_TABLES[i]);
    console.error("[user-projection] read-model write failed", {
      table: TARGET_TABLES[i],
      userId: view.id,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    });
  });
  return failed;
}

/**
 * DynamoDB Stream path. Records in, `batchItemFailures` out.
 *
 * SEQUENTIAL over records, ON PURPOSE. A single batch can hold two changes to the SAME
 * user id, and applying them concurrently means the winner is decided by wall-clock
 * latency instead of by sequence number — reintroducing exactly the out-of-order defect
 * that made a stream the chosen fix. The fan-out to five tables inside each record IS
 * concurrent, so the bound on in-flight writes is 5, not BatchSize x 5.
 *
 * At BatchSize 10 that is at most 10 sequential steps of ~10ms. The batch is not
 * coalesced to the last image per id (which would be equivalent under last-write-wins
 * and cheaper) because reporting a failure for a collapsed group means reporting its
 * LOWEST sequence number, and that bookkeeping is not worth it for ten records.
 *
 * A FAILURE DOES NOT STOP THE LOOP. Lambda re-delivers from the lowest reported
 * sequence number, so records after a failure are replayed anyway; continuing gets the
 * other KEYS in the batch converged now, and the replay is idempotent.
 */
async function projectBatch(
  records: DynamoDBRecord[],
  context?: Context
): Promise<DynamoDBBatchResponse> {
  const budget =
    typeof context?.getRemainingTimeInMillis === "function"
      ? Math.max(0, context.getRemainingTimeInMillis() - RESPONSE_RESERVE_MS)
      : FALLBACK_BUDGET_MS;
  const deadline = Date.now() + budget;

  const batchItemFailures: DynamoDBBatchItemFailure[] = [];
  let projected = 0;
  let skipped = 0;
  let abandoned = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    // Out of budget: report THIS record and every record after it as failed, so the
    // ESM re-delivers from here instead of the Lambda being killed and the whole batch
    // being retried with no partial credit for what already converged.
    if (Date.now() >= deadline) {
      abandoned = records.length - i;
      for (const deferred of records.slice(i)) {
        pushFailure(batchItemFailures, deferred);
      }
      console.error("[user-projection] out of time budget — remainder deferred", {
        abandoned,
        projected,
      });
      break;
    }

    const view = recordToUserView(record);
    if (!view) {
      // ACKNOWLEDGED, not retried, and scoped to THIS RECORD. A REMOVE record or an
      // image with no usable id will never become writable, so retrying it only stalls
      // the shard behind something no operator can act on. Everything else in the batch
      // still gets projected.
      skipped++;
      continue;
    }

    // One controller per record, aborted in `finally` so no listener and no timer
    // outlives the record that created it — a controller retained per record across a
    // TRIM_HORIZON replay is a leak, not a theoretical one.
    const abort = new AbortController();
    const remaining = deadline - Date.now();
    const timer = setTimeout(() => abort.abort(), Math.max(1, remaining));
    let failed: string[];
    try {
      failed = await writeAll(view, abort.signal);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }

    if (failed.length > 0) {
      pushFailure(batchItemFailures, record);
      continue;
    }
    projected++;
  }

  // Level-gated summary rather than one line per record: a backfill replay walks the
  // whole table through TRIM_HORIZON and per-record logging would be the expensive part
  // of the invocation.
  console.log("[user-projection] stream batch complete", {
    records: records.length,
    projected,
    skipped,
    abandoned,
    failed: batchItemFailures.length,
    tables: TARGET_TABLES.length,
  });

  return { batchItemFailures };
}

/**
 * Record a record as needing re-delivery.
 *
 * A record with no SequenceNumber cannot be checkpointed against, and reporting an
 * empty identifier would ACKNOWLEDGE it — a silent loss. That shape does not come out
 * of DynamoDB Streams, so it is treated as fail-closed: throw, and let the bounded
 * MaximumRetryAttempts put the batch's metadata in the DLQ where it is visible.
 */
function pushFailure(into: DynamoDBBatchItemFailure[], record: DynamoDBRecord): void {
  const itemIdentifier = record.dynamodb?.SequenceNumber;
  if (!itemIdentifier) {
    throw new Error(
      "user-projection: stream record has no SequenceNumber — cannot report it as " +
        "failed without acknowledging it"
    );
  }
  into.push({ itemIdentifier });
}

/**
 * Lambda entry point for BOTH shapes, dispatched on the one field that separates them.
 *
 * A DynamoDB Stream event is `{ Records: [...] }`; an EventBridge event never has
 * `Records` and always has `detail`. One dispatch, one shared `toUserView`, so the two
 * paths cannot drift into projecting different rows.
 *
 * DEPLOY ORDER IS LOAD-BEARING, and this is why. If the event source mapping lands
 * BEFORE this dual-shape code, a stream event reaches the old single-shape handler with
 * no `detail`, `toUserView(undefined)` returns null, and the handler LOGS AND
 * ACKNOWLEDGES: the checkpoint advances, nothing lands in the DLQ, and the projection
 * is silently missing every change made during the gap. That is worse than the
 * user-access outage this codebase already ate, which at least failed closed. Publish
 * the zip first, then create the ESM.
 */
export const handler = async (
  event: DynamoDBStreamEvent,
  context?: Context
): Promise<DynamoDBBatchResponse> => {
  // ONE SHAPE, deliberately. The EventBridge branch that used to live here was cutover
  // cover for a single deploy and has been removed along with UserProjectionRule.
  //
  // The removal trigger was "one week of the IteratorAge alarm staying OK". That gate was
  // replaced by STRONGER evidence than elapsed time, because the alarm cannot supply what
  // it promised: with writes this sparse it reports OK from "no datapoints received", which
  // is indistinguishable from nothing having happened at all. What was verified instead,
  // against the live stack:
  //
  //   - The rule had invoked this function ZERO times since the stream went live, while the
  //     stream had processed real batches. Nothing was relying on the fallback.
  //   - An INSERT of a brand-new user propagated to all five read-models — the exact case
  //     the rule existed to cover (user.created). Verified with a probe row, then removed.
  //   - Both user.created publishers write the users row BEFORE publishing
  //     (cognito-postconfirmation writes then publishes; user-access guards its publish on
  //     profileWritten), so every event the rule could deliver is preceded by a stream
  //     record. The stream strictly dominates it.
  //   - Nothing else on the bus consumes user.created — the only other rule is
  //     praimana-evaluation-activity, which matches different detail-types.
  //
  // A non-stream invocation is now a MISCONFIGURATION rather than a supported path, so it
  // throws instead of being quietly tolerated. An empty Records array is not that: an ESM
  // may legitimately deliver one, and it is a no-op.
  if (!event || !("Records" in event)) {
    throw new Error(
      "user-projection: expected a DynamoDB stream event with Records — this function no " +
        "longer accepts EventBridge, so an event without Records means something is wired " +
        "to it that should not be"
    );
  }

  return projectBatch(event.Records ?? [], context);
};
