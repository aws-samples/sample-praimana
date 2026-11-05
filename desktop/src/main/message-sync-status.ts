// ── DID THIS MESSAGE REACH THE TEAM'S TRANSCRIPT? ────────────────────────────────────────
//
// The desktop writes every message to SQLite immediately and pushes it to the server separately. This
// module owns the record of whether the second half happened.
//
// ⚠ IT EXISTS BECAUSE TWO SYNC FAILURES WERE INVISIBLE IN EXACTLY THE SAME WAY. The sync read
// `auth_token` once and this pool expires ID tokens after 30 MINUTES, so half an hour into any session
// every push 401'd; and a stopped turn pushed nothing at all, so the participant's own question was
// missing from the portal while sitting in their local database. Both times the row was right there and
// nothing said it had not travelled — the only evidence was a line in a console log.
//
// ── ⚠ ONE MODULE, BECAUSE FOUR PLACES INSERT MESSAGES AND TWO PUSH THEM ──
//
// `db.ts` (the renderer's user message), `cli-assistant.ts`, `claude-code.ts` and `kiro-acp.ts` all
// INSERT, and `cli-sync.ts` plus `kiro-acp.ts` both PUSH. Spreading `UPDATE ... SET sync_status` across
// them is how one path ends up writing a status nothing else reads, or forgetting to write one at all —
// which is the class of bug this whole column is here to expose.

import { getDb } from "./database";

/**
 * ⚠ THE VALUES ARE A CLOSED SET AND THE SCHEMA ENFORCES IT. Migration 11 carries a CHECK constraint, so
 * a typo here fails the write loudly instead of storing a status no query matches.
 */
export const SYNC_PENDING = "pending";
export const SYNC_SYNCED = "synced";
export const SYNC_FAILED = "failed";

export type SyncStatus = typeof SYNC_PENDING | typeof SYNC_SYNCED | typeof SYNC_FAILED;

/**
 * Mark rows as accepted by the server.
 *
 * ⚠ `synced_at` IS SET IN THE SAME STATEMENT, never as a second write. A row reading 'synced' with no
 * timestamp would be indistinguishable from a partially applied update, and this is the field a future
 * retry sweep uses to decide what it may skip.
 *
 * Ids that do not exist are silently ignored — the sync sends a turn, and a turn's assistant half has no
 * row when the reply was empty (a stopped turn). That is not an error to report.
 */
export function markMessagesSynced(
  ids: readonly string[],
  userId: string | null,
  sessionId: string
): void {
  update(ids, SYNC_SYNCED, userId, sessionId);
}

/**
 * Mark rows as refused.
 *
 * ⚠ DISTINCT FROM LEAVING THEM 'pending', and the distinction is the whole point: 'pending' may simply
 * be in flight, whereas 'failed' means a push was made and rejected, so somebody should look. Collapsing
 * the two would put every message that is merely slow into the same bucket as every message that was
 * actually lost.
 */
export function markMessagesFailed(
  ids: readonly string[],
  userId: string | null,
  sessionId: string
): void {
  update(ids, SYNC_FAILED, userId, sessionId);
}

/**
 * ── ⚠ THE STATUS WRITE IS SCOPED TO THE TURN'S SESSION **AND** TO THE ACCOUNT ──────────────────
 *
 * ⚠ TWO PREDICATES, ADDED IN TWO CYCLES, AND THE FIRST ONE ALONE DID NOT CLOSE THE FINDING. Worth
 * writing down as a pattern rather than as two bug fixes: the account predicate below was added for
 * the report quoted next, and the follow-up report (Low — "sync-status stamping keys on a
 * renderer-supplied message id never tied to the turn's session") found the same defect surviving
 * inside one account, because `cli:send` authorises `params.sessionId` while forwarding
 * `params.userMessageId` verbatim. A participant has many chats; scoping to the participant scopes to
 * none of them. Both predicates are required and neither implies the other.
 *
 * This was `WHERE id IN (…)` and nothing else, in a module where every sibling statement binds the account.
 * The ids arrive as `turn.userMessageId`, which is renderer-supplied on `cli:send` and forwarded to
 * `syncCliTurn` without an ownership check, so a caller naming another local account's row id stamped that
 * row `synced`.
 *
 * ⚠ AND THE DAMAGE IS THAT THE ROW GOES QUIET FOR EVER. Both the sweep and the retry path select on
 * `sync_status IN ('pending','failed')`, so a row forced to `synced` drops out of BOTH permanently:
 * the turn is never pushed, and nothing anywhere reports a gap. That is worse than a failed push,
 * which at least leaves `failed` for somebody to see — this is a silent, unrecoverable hole in
 * another account's transcript while the UI affirms delivery.
 *
 * ⚠ `session_id = ?` IS THE TURN BEING PUSHED, passed down from `syncCliTurn` rather than derived
 * from the ids — deriving it from the row would ask the data to vouch for itself. An id from another
 * chat simply matches nothing, which is the right failure: the row stays `pending`, so the retry and
 * the sweep can both still see it, and nothing is silently settled.
 *
 * ⚠ A SUBQUERY RATHER THAN A JOIN, because SQLite's UPDATE has no FROM clause. Same predicate as the
 * reads either way: `chat_messages` carries no account of its own, so ownership is reached through
 * `chat_sessions`, and `user_id IS ?` rather than `= ?` keeps legacy NULL rows settleable.
 */
function update(
  ids: readonly string[],
  status: SyncStatus,
  userId: string | null,
  sessionId: string
): void {
  const real = ids.filter((id) => !!id);
  if (real.length === 0) return;

  /**
   * ⚠ PARAMETERISED, WITH THE PLACEHOLDERS GENERATED FROM THE COUNT — never the ids interpolated. These
   * are UUIDs from our own code today, but a message id is data and this is the one place in the module
   * where a value could reach the SQL text.
   *
   * `synced_at` is cleared when the status is not 'synced', so a row that succeeded and later failed
   * cannot keep a timestamp claiming otherwise.
   */
  const holes = real.map(() => "?").join(", ");
  getDb()
    .prepare(
      `UPDATE chat_messages
          SET sync_status = ?,
              synced_at = CASE WHEN ? = '${SYNC_SYNCED}' THEN datetime('now') ELSE NULL END
        WHERE id IN (${holes})
          AND session_id = ?
          AND session_id IN (SELECT id FROM chat_sessions WHERE user_id IS ?)`
    )
    .run(status, status, ...real, sessionId, userId ?? null);
}

/** One turn, reassembled from the transcript so a retry can re-push exactly what failed. */
export interface RetryableTurn {
  sessionId: string;
  aiProvider: string | null;
  userMessage: string;
  userMessageId: string;
  /** Empty when the turn produced no reply — a stopped turn is still worth re-pushing. */
  assistantMessage: string;
  assistantMessageId?: string;
  /**
   * The counts stored on the assistant row, when it has them.
   *
   * ⚠ THIS CLOSES A GAP THE PORTAL WORK LEFT OPEN. Before migration 13 there was nowhere local to read them
   * from, so a retried turn was re-pushed WITHOUT counts — and because the server overwrites the turn on
   * `clientTurnId`, pressing retry silently REDUCED the portal's token total for that thread. Carrying them
   * makes a re-push identical to the original.
   */
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningOutputTokens?: number;
  };
  /**
   * How full the context window was at the end of this turn, when the assistant said (Kiro only).
   *
   * ⚠ CARRIED FOR EXACTLY THE REASON `tokens` IS: the server overwrites a turn keyed on `clientTurnId`, so a
   * retry that dropped this field would erase a reading the portal already holds. Outside the `tokens` bag
   * because it is a state and not a count — see `contextUsageOf`.
   */
  contextUsagePercent?: number;
}

/**
 * ── ⚠ A RETRY IS PER *TURN*, NOT PER MESSAGE, BECAUSE THE SERVER'S UNIT IS A TURN ─────────
 *
 * `POST /v1/ai/threads/:id/sync` takes the messages of one turn together, and `clientTurnId` — the
 * assistant row's id — is the idempotency key it derives message ids from. So retrying "this message"
 * has to mean "re-push the turn this message belongs to", or a retry on the user half would push a
 * user-only turn over a pair that had already partly landed.
 *
 * ⚠ THE PAIRING IS POSITIONAL, WHICH IS ALL THE SCHEMA SUPPORTS. `chat_messages` records no link
 * between a prompt and its reply — only `created_at` order within a session. So a user row pairs with
 * the NEXT assistant row and an assistant row with the PREVIOUS user row, which is exactly the order
 * the transcript is written and read in. It is stated here because it is an assumption rather than a
 * constraint: if a future feature ever interleaves turns, this is the function that breaks first, and a
 * real `turn_id` column would be the fix.
 *
 * Returns null when the id is unknown, so the caller answers "nothing to retry" rather than pushing a
 * turn assembled from nothing.
 */
/**
 * The tokens clause for a `RetryableTurn`, or nothing.
 *
 * ⚠ NULL MUST NOT BECOME 0. A row with no counts is one nobody measured — every row written before migration
 * 13 — and a zero would be re-pushed as a measurement, overwriting whatever the portal already knew.
 */
function tokensOf(row: {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens: number | null;
  reasoning_output_tokens: number | null;
}) {
  const tokens = {
    ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { outputTokens: row.output_tokens } : {}),
    ...(row.cached_input_tokens !== null ? { cachedInputTokens: row.cached_input_tokens } : {}),
    ...(row.cache_write_input_tokens !== null
      ? { cacheWriteInputTokens: row.cache_write_input_tokens }
      : {}),
    ...(row.reasoning_output_tokens !== null
      ? { reasoningOutputTokens: row.reasoning_output_tokens }
      : {}),
  };
  return Object.keys(tokens).length > 0 ? { tokens } : {};
}

/**
 * The context-fullness clause for a `RetryableTurn`, or nothing.
 *
 * ⚠ SEPARATE FROM `tokensOf` BECAUSE IT IS NOT A TOKEN COUNT, and travels outside the `tokens` bag for the
 * same reason — everything in that bag is summed across a thread, and a percentage of a window is a state,
 * not a quantity. See the note on `CliTurn.contextUsagePercent`.
 *
 * ⚠ AND IT EXISTS AT ALL BECAUSE A RETRY OVERWRITES. The server keys the turn on `clientTurnId`, so a
 * re-push omitting this field would DELETE a reading the portal already had — the retry button quietly
 * making the record worse, which is precisely the failure the tokens note above guards against.
 */
function contextUsageOf(row: { context_usage_percent: number | null }) {
  return row.context_usage_percent !== null
    ? { contextUsagePercent: row.context_usage_percent }
    : {};
}

/**
 * ── ⚠ A RETRY IS SCOPED TO THE ACCOUNT THAT IS SIGNED IN ──────────────────────────────────────
 *
 * This lookup was `WHERE m.id = ?` and nothing else, while `db:getSessions` two modules over has bound the
 * account since the day it was written.
 *
 * What the omission cost: the reassembled turn is pushed with the CURRENTLY SIGNED-IN account's
 * bearer to `/v1/ai/threads/{id}/sync`, and on a 404 the thread is first created under
 * `/v1/ai/teams/{team_id}/threads` — the current account's team. So on a shared machine,
 * `sync:retryMessage` let renderer-resident code publish another local account's private AI
 * conversation into its own team's transcript, and the background sweep did the same with no attacker
 * involved at all (see sync-sweep.ts).
 *
 * ⚠ THE STATUS FILTER IS THE SECOND HALF, and it is the one that protects a 30-day history. A row
 * with `sync_status IS NULL` was written before the column existed; migration 10 deliberately
 * excluded those from sweeping, and `countUnsyncedMessages` excludes them too — but a retry by id
 * bypassed both, so one IPC call could re-push a month of chats. Only a turn this code has tracked,
 * and has not yet confirmed, is retryable.
 *
 * ⚠ `s.user_id IS ?` RATHER THAN `= ?`: legacy sessions carry NULL and `NULL = NULL` is never true,
 * so `=` would make every pre-scoping turn permanently unretryable.
 *
 * ⚠ AND THE EXPERIENCE PREDICATE IS THE THIRD HALF, added with the sweep's: transcript-sync
 * selection ignored the workshop a chat belongs to. The account predicate
 * says WHO may push; this says WHERE the turn may be pushed TO. Without it, `sync:retryMessage` gave
 * renderer code on demand exactly what the sweep did by itself: a turn recorded in workshop A
 * re-pushed into whatever team is current now. The two selection paths must agree, because they are
 * the same operation with and without a human clicking.
 *
 * @param userId the active local account, from `activeUserId()`. Passed in rather than read here so
 *        this module stays a pure transcript reader — the same reason it takes no `getSetting`.
 * @param experience the current experience, from `activeExperience()`. Passed in for the same reason.
 */
export function loadTurnForRetry(
  messageId: string,
  userId: string | null,
  experience: string | null
): RetryableTurn | null {
  const db = getDb();

  const row = db
    .prepare(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
              m.input_tokens, m.output_tokens, m.cached_input_tokens,
              m.cache_write_input_tokens, m.reasoning_output_tokens,
              m.context_usage_percent, s.ai_provider
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.id = ?
          AND s.user_id IS ?
          AND (s.workshop_id IS NULL OR s.workshop_id IS ?)
          AND m.sync_status IN ('${SYNC_PENDING}', '${SYNC_FAILED}')`
    )
    .get(messageId, userId ?? null, experience ?? null) as
    | {
        id: string;
        session_id: string;
        role: string;
        content: string;
        created_at: string;
        input_tokens: number | null;
        output_tokens: number | null;
        cached_input_tokens: number | null;
        cache_write_input_tokens: number | null;
        reasoning_output_tokens: number | null;
        context_usage_percent: number | null;
        ai_provider: string | null;
      }
    | undefined;

  if (!row) return null;

  if (row.role === "user") {
    /**
     * The reply, if one was ever written. Bounded to the next assistant row BEFORE any later user row,
     * so a stopped turn does not adopt the reply from the following turn — which would re-push somebody
     * else's answer under this prompt.
     */
    const reply = db
      .prepare(
        `SELECT id, content, input_tokens, output_tokens, cached_input_tokens,
                cache_write_input_tokens, reasoning_output_tokens, context_usage_percent
           FROM chat_messages
          WHERE session_id = ? AND created_at > ? AND role IN ('assistant', 'user')
          ORDER BY created_at ASC LIMIT 1`
      )
      .get(row.session_id, row.created_at) as
      | {
          id: string;
          content: string;
          input_tokens: number | null;
          output_tokens: number | null;
          cached_input_tokens: number | null;
          cache_write_input_tokens: number | null;
          reasoning_output_tokens: number | null;
          context_usage_percent: number | null;
        }
      | undefined;

    const isReply = !!reply && !isUserRow(db, reply.id);
    return {
      sessionId: row.session_id,
      aiProvider: row.ai_provider,
      userMessage: row.content,
      userMessageId: row.id,
      assistantMessage: isReply ? reply!.content : "",
      ...(isReply ? { assistantMessageId: reply!.id } : {}),
      /* The counts live on the ASSISTANT row, so they come from the reply — not from this user row. */
      ...(isReply ? tokensOf(reply!) : {}),
      /* Same for the context reading: Kiro reports it at turn end, so it sits on the reply. */
      ...(isReply ? contextUsageOf(reply!) : {}),
    };
  }

  if (row.role !== "assistant") return null;

  // An assistant row: its prompt is the nearest preceding user row.
  const prompt = db
    .prepare(
      `SELECT id, content FROM chat_messages
        WHERE session_id = ? AND created_at < ? AND role = 'user'
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(row.session_id, row.created_at) as { id: string; content: string } | undefined;

  // No prompt means nothing the /sync contract can express — it requires at least one message, and a
  // lone assistant reply would be a turn nobody asked for.
  if (!prompt) return null;

  return {
    sessionId: row.session_id,
    aiProvider: row.ai_provider,
    userMessage: prompt.content,
    userMessageId: prompt.id,
    assistantMessage: row.content,
    assistantMessageId: row.id,
    ...tokensOf(row),
    ...contextUsageOf(row),
  };
}

function isUserRow(db: ReturnType<typeof getDb>, id: string): boolean {
  const r = db.prepare("SELECT role FROM chat_messages WHERE id = ?").get(id) as
    | { role?: string }
    | undefined;
  return r?.role === "user";
}

/**
 * ── ⚠ THE TRUE LOCAL TIMESTAMPS, SO THE SERVER NEED NOT INVENT THEM ──────────────────────
 *
 * Because the sync sent no timestamps, the AI service stamped each message `now + i` milliseconds and
 * flagged the row `synced: true`. `timing.ts` then REFUSES to infer user compose time across any
 * synced message — correctly, since gaps of 1ms describe a for-loop and would show "a user who read
 * and replied in one millisecond", dragging every average to zero. So every gap in a desktop thread
 * was unusable, inferred time was 0, and the panel honestly reported that it could not measure.
 *
 * The desktop has the real times all along: `chat_messages.created_at`, written when each message was
 * actually written. Sending them turns a refusal into a measurement.
 */
export function readMessageTimes(
  ids: readonly string[],
  userId: string | null,
  sessionId: string
): Record<string, string> {
  const real = ids.filter((id) => !!id);
  if (real.length === 0) return {};

  /**
   * ⚠ SCOPED, FOR THE SAME REASON `update` IS. The ids reaching here are the same renderer-supplied
   * `userMessageId` the status write takes, and the value read — `created_at` — is FORWARDED TO THE
   * REMOTE TEAM by `syncCliTurn`. Unscoped, that made this a channel for learning when another local
   * account wrote a message, published under the caller's own bearer.
   *
   * A row that does not resolve simply has no `createdAt`, which is the same degradation the function
   * already documents for an unknown id: the service falls back to its own stamp.
   */
  const holes = real.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.created_at FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.id IN (${holes}) AND m.session_id = ? AND s.user_id IS ?`
    )
    .all(...real, sessionId, userId ?? null) as Array<{
    id: string;
    created_at: string | null;
  }>;

  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.created_at) continue;
    /**
     * ⚠ NORMALISED TO ISO-8601 WITH A ZONE. SQLite's `datetime('now')` yields "2026-08-13 11:45:59" —
     * no `T`, no offset — which `Date.parse` treats as LOCAL time in some engines and UTC in others.
     * Sending that ambiguity to a service that compares it against other timestamps is how a gap comes
     * out negative and gets discarded as clock skew.
     */
    const iso = r.created_at.includes("T") ? r.created_at : r.created_at.replace(" ", "T") + "Z";
    const at = Date.parse(iso);
    if (!Number.isNaN(at)) out[r.id] = new Date(at).toISOString();
  }
  return out;
}

/** The stored status for one row, or null when unknown / no such row. */
export function readSyncStatus(messageId: string): SyncStatus | null {
  const row = getDb()
    .prepare("SELECT sync_status FROM chat_messages WHERE id = ?")
    .get(messageId) as { sync_status?: string | null } | undefined;
  const v = row?.sync_status ?? null;
  return v === SYNC_PENDING || v === SYNC_SYNCED || v === SYNC_FAILED ? v : null;
}

/**
 * How many messages are written locally but not confirmed on the server.
 *
 * ⚠ `sync_status IS NULL` IS EXCLUDED, and that is not an oversight. NULL means "written before this
 * column existed", i.e. unknown — counting those would report a backlog of every message ever sent and
 * invite a retry sweep across a 30-day history. Only rows this code has actually tracked are counted.
 *
 * ⚠ AND IT COUNTS ONE ACCOUNT'S BACKLOG, not the machine's. This is the sweep's cheap exit and its
 * "remaining" report, so an unscoped count would send the sweep looking for work it will (correctly)
 * refuse to do — reporting a backlog that never shrinks, and re-running on every trigger. It is the
 * same predicate `unsyncedRowIds` applies; a gate and its query must agree about what is eligible.
 *
 * ⚠ WHICH IS WHY THE EXPERIENCE PREDICATE HAD TO COME HERE TOO. When the workshop scope was added to
 * `unsyncedRowIds` this count would otherwise have kept reporting rows
 * the sweep now declines to publish: the cheap exit at the top of `sweepUnsyncedTurns` would pass,
 * the selection would return nothing, and every trigger would do the whole gate-and-query dance to
 * discover that again — while `remaining` reported a debt no sweep will ever settle.
 *
 * @param userId the active local account, from `activeUserId()`. Passed in for the same reason
 *        `loadTurnForRetry` takes it: this module reads transcripts and does not decide who is acting.
 * @param experience the current experience, from `activeExperience()`. Same reason.
 */
export function countUnsyncedMessages(userId: string | null, experience: string | null): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.sync_status IN ('${SYNC_PENDING}', '${SYNC_FAILED}')
          AND s.user_id IS ?
          AND (s.workshop_id IS NULL OR s.workshop_id IS ?)`
    )
    .get(userId ?? null, experience ?? null) as { n?: number } | undefined;
  return row?.n ?? 0;
}
