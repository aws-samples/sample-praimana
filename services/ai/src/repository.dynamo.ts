import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type {
  AiThread,
  AiMessage,
  ThreadRepository,
  MessageRepository,
  TeamAiRatingRepository,
  TeamAiRatingSnapshot,
} from "./domain.js";
// A VALUE, so it cannot ride on the `import type` above.
import { GENERATION_LEASE_MS } from "./domain.js";

/**
 * DynamoDB implementations of the AI repositories. This is the ONLY file in the
 * service that knows about DynamoDB commands or table names. Everything else
 * depends on the interfaces in domain.ts. To extract/re-home later, you write a
 * new implementation of the same interfaces — routes stay untouched.
 */

// Tables THIS service owns. It references no other context's tables.
const TABLES = {
  aiThreads: process.env.TABLE_AI_THREADS || "praimana-ai-threads",
  aiMessages: process.env.TABLE_AI_MESSAGES || "praimana-ai-messages",
  /**
   * ⚠ KEEP THIS DEFAULT IN STEP WITH `TABLE_TEAM_AI_RATINGS` in the template.
   *
   * The `-v2` notes in the evaluation service's repository explain why a drifted default is
   * worse than a crash: if this named a table that EXISTS but is empty, every read would
   * succeed and return nothing — a silent wrong answer, where a missing table at least
   * fails loudly.
   */
  teamAiRatings:
    process.env.TABLE_TEAM_AI_RATINGS || "praimana-team-ai-ratings",
} as const;

export class DynamoThreadRepository implements ThreadRepository {
  constructor(private readonly db: DocClient) {}

  async get(teamId: string, id: string): Promise<AiThread | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.aiThreads, Key: { teamId, id } })
    );
    return (res.Item as AiThread) ?? null;
  }

  async getById(id: string): Promise<AiThread | null> {
    // aiThreads is keyed by (teamId, id); the id-index GSI resolves by id alone.
    // The thread-keyed routes need this to learn which team a thread belongs to
    // before they can authorize the caller against it.
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.aiThreads,
        IndexName: "id-index",
        KeyConditionExpression: "id = :id",
        ExpressionAttributeValues: { ":id": id },
        Limit: 1,
      })
    );
    return (res.Items?.[0] as AiThread) ?? null;
  }

  async listByTeam(teamId: string, sharedOnly: boolean): Promise<AiThread[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.aiThreads,
        KeyConditionExpression: "teamId = :teamId",
        ...(sharedOnly
          ? {
              // `shared` is a DynamoDB reserved word — alias it.
              FilterExpression: "#shared = :true",
              ExpressionAttributeNames: { "#shared": "shared" },
              ExpressionAttributeValues: { ":teamId": teamId, ":true": true },
            }
          : { ExpressionAttributeValues: { ":teamId": teamId } }),
        ScanIndexForward: false,
      })
    );
    return (res.Items as AiThread[]) ?? [];
  }

  async put(thread: AiThread): Promise<AiThread> {
    await this.db.send(
      new PutCommand({ TableName: TABLES.aiThreads, Item: thread })
    );
    return thread;
  }

  /**
   * ⚠ AN UPDATE OF ONE ATTRIBUTE, NEVER A PUT. See the interface note: a full-item write here can wipe
   * a share that landed since the row was read, which has happened once already in this table.
   *
   * `attribute_exists(teamId)` makes this a no-op on a row that is gone rather than resurrecting a
   * partial item — an Update with no condition CREATES the key it cannot find, which would leave a
   * thread carrying nothing but an `updatedAt`.
   *
   * The conditional failure is swallowed: the caller has already stored the messages, and a display
   * timestamp is not worth failing a sync over.
   */
  async touch(teamId: string, id: string, at: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: TABLES.aiThreads,
          Key: { teamId, id },
          UpdateExpression: "SET updatedAt = :at",
          ConditionExpression: "attribute_exists(teamId)",
          ExpressionAttributeValues: { ":at": at },
        })
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") return;
      throw err;
    }
  }
}

export class DynamoMessageRepository implements MessageRepository {
  constructor(private readonly db: DocClient) {}

  async listByThread(threadId: string): Promise<AiMessage[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.aiMessages,
        KeyConditionExpression: "threadId = :threadId",
        ExpressionAttributeValues: { ":threadId": threadId },
        ScanIndexForward: true,
      })
    );
    return (res.Items as AiMessage[]) ?? [];
  }

  /**
   * Messages with `createdAt` strictly greater than `since`, ascending. `createdAt` is the RANGE
   * key, so the `>` is a key-condition range read — DynamoDB walks only the newer tail, it does not
   * scan the thread. Returns [] when nothing is newer (the common live-poll case).
   */
  async listByThreadSince(threadId: string, since: string): Promise<AiMessage[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.aiMessages,
        KeyConditionExpression: "threadId = :threadId AND createdAt > :since",
        ExpressionAttributeValues: { ":threadId": threadId, ":since": since },
        ScanIndexForward: true,
      })
    );
    return (res.Items as AiMessage[]) ?? [];
  }

  /**
   * One newest-first page for scroll-up pagination.
   *
   * ⚠ QUERIED DESCENDING, RETURNED ASCENDING. The page we WANT is the newest `limit` messages older
   * than `before`, so the Query runs `ScanIndexForward: false` to take them from the newest end.
   * But the client prepends a page above what it already shows, so it needs the page in reading
   * order — hence the `.reverse()` before returning. `nextBefore` is the OLDEST `createdAt` in the
   * page (the first element after reversing); the next call passes it as `before` to get the page
   * above. Null when fewer than `limit` came back, i.e. we reached the start of the thread.
   *
   * ⚠ `before` IS EXCLUSIVE via `createdAt < :before`, not a DynamoDB `ExclusiveStartKey`. The range
   * key is a timestamp with millisecond resolution and within-batch `+i` offsets, so it is unique
   * per row in practice; using the value as the cursor keeps the API stable and stateless rather
   * than leaking an opaque LastEvaluatedKey the desktop would have to round-trip.
   */
  async listByThreadPage(
    threadId: string,
    opts: { limit: number; before?: string }
  ): Promise<{ messages: AiMessage[]; nextBefore: string | null }> {
    const keyCondition = opts.before
      ? "threadId = :threadId AND createdAt < :before"
      : "threadId = :threadId";
    const values: Record<string, string> = { ":threadId": threadId };
    if (opts.before) values[":before"] = opts.before;

    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.aiMessages,
        KeyConditionExpression: keyCondition,
        ExpressionAttributeValues: values,
        ScanIndexForward: false,
        Limit: opts.limit,
      })
    );
    const newestFirst = (res.Items as AiMessage[]) ?? [];
    const messages = [...newestFirst].reverse();
    // A full page MIGHT have more above it; a short page means we hit the start of the thread.
    const nextBefore =
      newestFirst.length === opts.limit && messages.length > 0 ? messages[0].createdAt : null;
    return { messages, nextBefore };
  }

  async put(message: AiMessage): Promise<AiMessage> {
    await this.db.send(
      new PutCommand({ TableName: TABLES.aiMessages, Item: message })
    );
    return message;
  }
}

/**
 * The generation lease's reserved sort value, in the same partition as the snapshots.
 *
 * ONE TABLE, NOT TWO. A lease is a fact about a team's generations, it is read and written on the
 * same partition key, and a second table would be another resource to provision, tag, alarm and
 * grant — for one item per team with a sixty-second life.
 *
 * `!` (0x21) sorts below every ULID (0x30-0x37 today), so a descending "newest" query passes over
 * it — but `latest()` does NOT rely on that: it bounds the key range explicitly. See the comment
 * there, which is where this would otherwise break in six months.
 */
const CLAIM_SORT_KEY = "!claim";

/**
 * The lower bound for "a real generation id", so the lease can never be mistaken for a snapshot.
 * `"0"` is below every ULID and above `!`.
 */
const ULID_SORT_FLOOR = "0";


/**
 * Snapshot store for model-written team ratings.
 *
 * Keyed (teamId, generationId) where generationId is a ULID, so "newest" is a Query with
 * `Limit: 1` and `ScanIndexForward: false` — no pointer row to keep consistent, history for
 * free, and correct ordering without trusting a wall clock.
 *
 * The same partition also holds a short-lived generation LEASE — see CLAIM_SORT_KEY.
 */
export class DynamoTeamAiRatingRepository implements TeamAiRatingRepository {
  constructor(private readonly db: DocClient) {}

  async latest(teamId: string): Promise<TeamAiRatingSnapshot | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teamAiRatings,
        /**
         * ⚠ THE LOWER BOUND IS LOAD-BEARING, and it is explicit rather than left to ASCII luck.
         *
         * This table also holds the generation LEASE (see claimGeneration), keyed on the reserved
         * sort value CLAIM_SORT_KEY = "!claim". `!` is 0x21 and a ULID's first character is
         * currently 0-7 (0x30-0x37), so a descending scan skips the claim WHENEVER A REAL SNAPSHOT
         * EXISTS — but on a team with zero snapshots the claim would be the only item and this
         * would return it as though it were an analysis.
         *
         * `>= "0"` excludes every non-ULID sort value by construction, so the invariant does not
         * depend on which character the ULID alphabet happens to start with in 2026. Pinned by a
         * test that claims on an empty team and asserts this returns null.
         */
        KeyConditionExpression: "teamId = :teamId AND generationId >= :minGenerationId",
        ExpressionAttributeValues: {
          ":teamId": teamId,
          ":minGenerationId": ULID_SORT_FLOOR,
        },
        // Descending on the ULID sort key ⇒ the first row IS the newest generation.
        ScanIndexForward: false,
        Limit: 1,
      })
    );
    return (res.Items?.[0] as TeamAiRatingSnapshot) ?? null;
  }

  /**
   * Take the generation lease with a CONDITIONAL WRITE — the only construct that can hold this
   * invariant, because the check and the act have to be one operation.
   */
  async claimGeneration(
    teamId: string,
    actorId: string,
    now: number
  ): Promise<boolean> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.teamAiRatings,
          Item: {
            teamId,
            generationId: CLAIM_SORT_KEY,
            claimedById: actorId,
            claimedAt: new Date(now).toISOString(),
            /** Epoch SECONDS — what DynamoDB TTL requires; the guard below compares the same unit. */
            expiresAt: Math.floor((now + GENERATION_LEASE_MS) / 1000),
          },
          /**
           * Free if no lease exists, OR if the one that does has lapsed.
           *
           * THE `expiresAt` DISJUNCT IS NOT REDUNDANT WITH THE TTL. DynamoDB's TTL deletion is
           * asynchronous and documented as taking up to 48 hours, so a lease whose only release
           * was TTL would wedge this route for a day and a half after one killed Lambda. TTL is
           * enabled purely so dead rows do not accumulate; expiry is enforced HERE, on read.
           */
          ConditionExpression:
            "attribute_not_exists(generationId) OR expiresAt < :now",
          ExpressionAttributeValues: {
            ":now": Math.floor(now / 1000),
          },
        })
      );
      return true;
    } catch (err) {
      // The condition failing is the ANSWER, not an error: somebody else holds the lease. Every
      // other failure (throttle, timeout, AccessDenied) is a real fault and is rethrown, so a
      // broken table cannot read as "busy" and silently disable generation.
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        return false;
      }
      throw err;
    }
  }

  async releaseGeneration(teamId: string): Promise<void> {
    try {
      await this.db.send(
        new DeleteCommand({
          TableName: TABLES.teamAiRatings,
          Key: { teamId, generationId: CLAIM_SORT_KEY },
        })
      );
    } catch (err) {
      /**
       * SWALLOWED, deliberately, and this is the one place in this file that swallows.
       *
       * Release runs in a `finally` after a generation that may well have SUCCEEDED and been
       * stored. Throwing here would turn a completed analysis into a 500 for the executive who
       * triggered it, and the failure is self-healing: the lease expires in under a minute either
       * way. Logged so it is not invisible.
       */
      console.warn("[ratings] failed to release the generation lease", {
        teamId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }

  async put(snapshot: TeamAiRatingSnapshot): Promise<TeamAiRatingSnapshot> {
    await this.db.send(
      new PutCommand({ TableName: TABLES.teamAiRatings, Item: snapshot })
    );
    return snapshot;
  }

  /**
   * Publish ONE generation, and only while it is still the newest.
   *
   * The staleness check is the point. Publishing is a disclosure to people outside the
   * team, so it must apply to the snapshot the publisher was actually looking at — without
   * this, a regeneration landing mid-review would silently publish text nobody approved.
   * A superseded generation returns null and the route turns that into a 409.
   *
   * `attribute_exists(teamId)` guards against publishing a generation that never existed;
   * `attribute_not_exists(publishedAt)` makes a double-publish a no-op rather than a
   * re-stamp, so the recorded actor stays the person who actually decided.
   */
  async publish(
    teamId: string,
    generationId: string,
    publishedById: string
  ): Promise<TeamAiRatingSnapshot | null> {
    const newest = await this.latest(teamId);
    if (!newest || newest.generationId !== generationId) return null;

    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: TABLES.teamAiRatings,
          Key: { teamId, generationId },
          UpdateExpression:
            "SET publishedAt = :now, publishedById = :actor",
          ConditionExpression:
            "attribute_exists(teamId) AND attribute_not_exists(publishedAt)",
          ExpressionAttributeValues: {
            ":now": new Date().toISOString(),
            ":actor": publishedById,
          },
          ReturnValues: "ALL_NEW",
        })
      );
      return (res.Attributes as TeamAiRatingSnapshot) ?? null;
    } catch (err) {
      // Already published ⇒ return what is stored rather than failing. The caller asked for
      // a state that already holds, and re-stamping would overwrite the real actor.
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return this.latest(teamId);
      }
      throw err;
    }
  }
}

