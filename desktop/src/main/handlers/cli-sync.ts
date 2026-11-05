import { BrowserWindow } from "electron";
import { trimForSync } from "../trim-synced-message";
import { readSetting } from "../database";
import { debugLog } from "../debug-log";
import { noteTeamUnreadable } from "../team-access-state";
import { activeUserId, activeExperience } from "../active-account";
import {
  loadTurnForRetry,
  readMessageTimes,
  markMessagesFailed,
  markMessagesSynced,
  readSyncStatus,
  SYNC_FAILED,
  SYNC_SYNCED,
  type SyncStatus,
} from "../message-sync-status";
import type { fetchAuthed as FetchAuthed } from "./ai";

/**
 * SYNCING A COMPLETED ASSISTANT TURN TO THE TEAM'S TRANSCRIPT.
 *
 * ── WHY THIS IS ITS OWN MODULE ──
 *
 * Extracted VERBATIM from cli-assistant.ts, which was its only caller until a second assistant
 * implementation appeared (claude-code.ts, the SDK path with real permission prompts). Both must write
 * the team's history in exactly the same shape: the transcript feeds the AI assessment and the
 * `aiTurns` counter that ranks people, so two implementations with two slightly different sync
 * behaviours would be worse than either bug they fix.
 *
 * A COPY WOULD HAVE BEEN THE EASIER CHANGE and the wrong one. This function encodes several decisions
 * that are not obvious from its signature — the thread is created on a 404 rather than probed for,
 * every hop is bounded, a non-2xx is a real failure rather than a warning, and the renderer is told
 * when a sync fails instead of the error being swallowed. Duplicating it would duplicate all of that
 * and then let the two drift.
 *
 * Behaviour is UNCHANGED by the move: same bodies, same order, same timeout, same error handling.
 */

function getSetting(key: string): string | null {
  return readSetting(key);
}

// Notify the renderer that a background sync failed so it can surface a toast —
// replaces silent `catch {}` swallowing (EA-H2). Sync stays best-effort (chat is
// already persisted locally in SQLite); the user just gets a visible signal.
function notifySyncFailed(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[cli-assistant] sync failed (${context}):`, message);  // nosemgrep: unsafe-formatstring
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("sync:failed", { context, message });
  }
}

/**
 * ── ⚠ TELL THE RENDERER THE STATUS CHANGED ────────────────────────────────────────────────
 *
 * Both halves of that sentence were true, and the badge was reading a value that WAS correct when it
 * read it. The order in `cli-assistant.ts` is:
 *
 *   void syncCliTurn({...});                        // fire-and-forget, takes ~a second
 *   event.sender.send("cli:response-complete", ...); // fires immediately after
 *
 * The renderer reloads its message list on `cli:response-complete`, so it reads `sync_status` BEFORE the
 * push has finished writing it — always `pending` — and nothing ever told it to look again. The badge
 * therefore stayed on "not synced, retry" for the rest of the session, for a message already stored on the
 * server. Switching chats fixed it, which is why it looked intermittent.
 *
 * ⚠ NOT SOLVED BY AWAITING THE SYNC BEFORE `cli:response-complete`. That would hold the reply back behind
 * a network round trip — the transcript is already saved locally, and making the user wait for the server
 * to acknowledge it is the opposite of what fire-and-forget is for.
 *
 * So the status is PUSHED when it is written. The renderer patches the two rows it names rather than
 * re-reading the list: a reload mid-scroll moves the viewport, and this fires on every turn.
 */
function notifySyncStatus(ids: readonly string[], status: SyncStatus): void {
  if (ids.length === 0) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("sync:status", { ids: [...ids], status });
  }
}

/**
 * Every hop here is bounded. Sync runs after a CLI turn the user already saw, so a
 * hung request must not linger: without a timeout these `fetch` calls could sit
 * open indefinitely, holding the transcript hostage with no signal at all.
 */
const SYNC_TIMEOUT_MS = 10_000;

/** One bounded request. Non-2xx is a FAILURE and says so — see checkedFetch below. */
async function syncFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Throw on a non-2xx so the caller's `catch` reports it.
 *
 * WHY THIS EXISTS. These calls previously ignored the response entirely, so an HTTP
 * error was indistinguishable from success: only a thrown network error reached
 * `notifySyncFailed`, and a 404 or 403 reached nobody. That is how the missing
 * `/sync` route stayed invisible while every CLI transcript was silently dropped —
 * `praimana-ai-messages` held zero rows against a thread that existed.
 *
 * The body is included because the status alone does not distinguish "no such route"
 * from "not a member of this team", and both are things an operator needs to see.
 */
async function checkedFetch(label: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await authedFetch(url, init);
  if (!res.ok) {
    /**
     * ⚠ RECORD A PERMANENT REFUSAL, so the sweep stops walking a backlog it cannot land.
     *
     * 403 and 404 on a team-scoped push are verdicts, not blips: they will not resolve on the next turn,
     * so attempting turn 2 after turn 1 was refused is guaranteed waste. Recorded here as well as in
     * team-data's probe because this path can be the FIRST to learn it — a sweep can start before any
     * probe has run.
     */
    if (res.status === 403 || res.status === 404) {
      const teamId = readSetting("team_id");
      if (teamId) noteTeamUnreadable(teamId, `HTTP ${res.status}`);
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`${label} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }
  return res;
}

/**
 * ── ⚠ ONE BOUNDED REQUEST, WITH THE BEARER REFRESHED ON 401 ──────────────────────────────
 *
 * THE CAUSE was that this module read `auth_token` ONCE and sent it raw. This pool issues ID tokens
 * valid for **30 MINUTES** (`IdTokenValidity: 30`, units minutes — not the usual 60), and the desktop
 * sends the idToken as its bearer. So half an hour into any session every sync 401s, and it stays
 * broken until some unrelated `ai.ts` or `team-data.ts` call happens to refresh the stored token and
 * incidentally heal this path.
 *
 * ⚠ THE REFRESH ALREADY EXISTED AND THIS FILE JUST DID NOT USE IT. `fetchAuthed` wraps
 * `fetchWithAuthRetry`: on a 401 it refreshes once, retries, and only broadcasts `auth:expired` when
 * the session is genuinely unrecoverable. `ai.ts` calls it at ~30 sites and `team-data.ts` at ~20;
 * `ai.ts` describes main as "the SINGLE token authority". A second, refresh-less token reader in the
 * same process is exactly the drift that comment exists to prevent.
 *
 * ⚠ THE BUILDER MUST CONSTRUCT A FRESH REQUEST PER ATTEMPT, which is `fetchAuthed`'s contract: the
 * retry needs new headers carrying the NEW token, and `syncFetch` additionally needs a new
 * AbortController per attempt or the retry would inherit an already-fired timeout. Both fall out of
 * building the init inside the callback rather than outside it.
 *
 * ── ⚠ IMPORTED LAZILY, AND THE TYPE-ONLY IMPORT AT THE TOP IS THE OTHER HALF OF THAT ──
 *
 * A static `import { fetchAuthed } from "./ai"` is the obvious spelling and it was the first attempt.
 * It broke `trust-workspace.test.ts` immediately: that file mocks `../database` with the three exports
 * IT needs and imports `cli-assistant`, so the new edge dragged `ai.ts` — websockets, Cognito refresh,
 * the platform config reader — into a module graph that had no business loading it, and the suite
 * failed to collect on a missing `isSensitiveSetting` export.
 *
 * Extending that one mock would have papered over the real fault: the CLI turn handlers should not
 * statically depend on the whole auth stack to record a transcript. Deferring the import keeps the
 * graph as it was — nothing that never syncs ever loads `ai.ts` — while a real sync still goes through
 * the one token authority. Node caches the module after the first call, so this costs one already
 * -resolved promise per request.
 */
async function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { fetchAuthed } = (await import("./ai")) as { fetchAuthed: typeof FetchAuthed };
  return fetchAuthed((token) =>
    syncFetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
    })
  );
}

/**
 * ⚠ THREE OUTCOMES, NOT A BOOLEAN — and the first draft of this WAS a boolean, which was wrong in a way
 * worth recording. "Nothing was attempted" (mid-setup: no server, no team, nobody signed in) is not a
 * failure, but a boolean forced it to share `false` with a real refusal — so the rows would have been
 * stamped 'failed' for a push that never happened, and a future retry sweep would chase them.
 *
 *   "synced"   the server accepted it.
 *   "failed"   a push was made and refused. Stamp the rows; somebody should look.
 *   "skipped"  no push was attempted. Leave the rows 'pending' — the truth is "still waiting".
 */
type SyncOutcome = "synced" | "failed" | "skipped";

async function syncToServer(sessionId: string, userMessage: string, assistantMessage: string, aiProvider?: string, clientTurnId?: string, latencyMs?: number, userMessageId?: string, assistantMessageId?: string, tokens?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number }, contextUsagePercent?: number): Promise<SyncOutcome> {
  const serverUrl = getSetting("server_url");
  const authToken = getSetting("auth_token");
  const teamId = getSetting("team_id");

  if (!serverUrl || !authToken || !teamId) {
    // Not an error worth a toast — the user is mid-setup, not mid-failure. But it
    // must not be invisible either: a transcript is being kept local-only.
    //
    // `auth_token` is still read here — NOT to send, but as the "is anyone signed in?" test.
    // `fetchAuthed` supplies the bearer for every request below, and it may well be a fresher
    // one than this.
    debugLog("[cli-assistant] Skipping sync — missing server_url/auth_token/team_id");
    return "skipped";
  }

  /**
   * ── ⚠ A STOPPED TURN STILL SYNCS THE PERSON'S OWN MESSAGE ────────────────────────────
   *
   * It was never lost locally — `AssistantChatView` writes the user row before sending. It was lost in the
   * CLOUD, because a turn was only ever synced as a user+assistant PAIR and the call sites gate that
   * on a non-empty reply (`if (finalContent)`). Press Stop before the first token and nothing was sent
   * at all, so the question the participant asked simply did not exist on the portal.
   *
   * ⚠ THE ASSISTANT ROW IS OMITTED, NOT BLANKED. `POST /v1/ai/threads/:id/sync` rejects any message
   * with empty content outright (400 "each message needs non-empty content"), so a placeholder would
   * fail the whole sync and lose the user's message again by a different route.
   *
   * ⚠ AND OMITTING IT IS ALSO WHAT KEEPS THE COUNTERS HONEST. The service derives `aiTurns` from the
   * number of ASSISTANT messages, so a user-only sync credits ZERO turns — which is the property the
   * original `if (finalContent)` gate was protecting ("would credit an aiTurn for it"). The gate was
   * the right instinct applied to the wrong thing: it protected the counter by dropping the evidence.
   */
  /**
   * ⚠ THE REAL LOCAL TIMESTAMPS, WHEN WE KNOW WHICH ROWS THESE ARE. Without them the service stamps
   * `now + i` and flags the rows `synced`, which makes `timing.ts` refuse to infer any user compose
   * time — the reported "team time 0s / 5 gaps not counted". Best-effort: a row we cannot resolve simply
   * has no `createdAt` and the service falls back to its own stamp, exactly as before.
   */
  /**
   * ⚠ SCOPED. These ids include the renderer-supplied `userMessageId`, and the timestamps read back
   * are sent to the remote team below — see the note on `readMessageTimes`.
   */
  const times = readMessageTimes(
    [userMessageId, assistantMessageId].filter((x): x is string => !!x),
    activeUserId(),
    sessionId
  );

  /**
   * ⚠ TRIMMED FOR THE PAYLOAD ONLY. The full reply is already in SQLite; the AI service rejects a
   * message over its ceiling with a 400, so before this an over-long turn synced NOTHING and the
   * platform had no record of the longest pieces of work. See trim-synced-message.ts.
   */
  const trimResult = trimForSync(assistantMessage.trim());
  if (trimResult.trimmed) {
    debugLog(
      `[cli-sync] assistant reply trimmed for sync: ${assistantMessage.length} -> ` +
        `${trimResult.content.length} chars (${trimResult.removedLines} lines removed); ` +
        `the local transcript keeps the full text`
    );
  }
  const reply = trimResult.content;
  const messages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: userMessage,
      ...(userMessageId && times[userMessageId] ? { createdAt: times[userMessageId] } : {}),
    },
  ];
  if (reply) {
    messages.push({
      role: "assistant",
      content: reply,
      ...(assistantMessageId && times[assistantMessageId]
        ? { createdAt: times[assistantMessageId] }
        : {}),
      // MEASURED: wall-clock from spawn to process close. This process ran the CLI,
      // so it is the only place that can observe how long the turn actually took —
      // and without it GET /threads/:threadId/timing reports ZERO AI time for every
      // CLI thread while still showing the user's gaps, which reads as the
      // participant being idle when in fact the assistant was working.
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      /**
       * ⚠ SPREAD, NOT ASSIGNED, so an unreported count never becomes `0`. A real zero-output turn and a turn
       * whose CLI said nothing are different facts, and the portal reports coverage over exactly that
       * difference.
       */
      ...(tokens?.inputTokens !== undefined ? { inputTokens: tokens.inputTokens } : {}),
      ...(tokens?.outputTokens !== undefined ? { outputTokens: tokens.outputTokens } : {}),
      ...(tokens?.cachedInputTokens !== undefined
        ? { cachedInputTokens: tokens.cachedInputTokens }
        : {}),
      ...(tokens?.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: tokens.cacheWriteInputTokens }
        : {}),
      ...(tokens?.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: tokens.reasoningOutputTokens }
        : {}),
      /**
       * ── ⚠ HOW FULL THE CONVERSATION WAS, WHICH IS NOT A TOKEN COUNT ──────────────────────
       *
       * This is the field that was absent from the payload — the desktop had the number and never sent it.
       *
       * ⚠ SEPARATE FROM `tokens`, DELIBERATELY. Every member of that bag is ADDITIVE and gets summed
       * across a thread; this is a reading of a state at one moment. Carried inside the bag it would be
       * summed by whatever aggregates the rest, and "two turns at 40% = 80% full" is not a fact about
       * anything. The ai service's rollup takes the LAST value for the same reason.
       *
       * ⚠ AND SPREAD, so an unreported reading never becomes 0%. Only Kiro publishes this; Claude and
       * Codex omit the field entirely, and the portal renders nothing rather than an empty-looking window.
       */
      ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
    });
  }

  try {
    // A 404 here means "no such thread yet", which is expected on the first turn and
    // is NOT a failure — so this one probe stays unchecked on purpose. It still goes through
    // `authedFetch`, or a 401 here would send every first turn down the create path with a
    // dead token.
    /**
     * ── ⚠ EVERY INTERPOLATED SEGMENT IS ENCODED ───────────────────────────────────────────
     *
     * `sessionId` is a row id the RENDERER chose and this module reuses it as the server's thread id by
     * design. `fetch` parses the URL with the WHATWG parser, which collapses `..` and honours `?`, so
     * `x/../../../v1/auth/me?z=` did not name a thread — it rewrote the path, and `authedFetch` attached the
     * user's bearer to it. `handlers/team-data.ts` has always encoded its segments; these three sites did
     * not. The complementary half is row-id.ts, which refuses such an id where it is stored.
     */
    const threadCheck = await authedFetch(
      `${serverUrl}/v1/ai/threads/${encodeURIComponent(sessionId)}/messages`
    );

    /**
     * ── ⚠ CREATE ONLY ON A GENUINE 404 ───────────────────────────────────────────────────
     *
     * This used to also create when the probe returned a 200 with ZERO messages, on the reasonable-
     * sounding theory that an empty thread is as good as a missing one. It is not, and the difference
     * destroyed a real share.
     *
     * `POST /threads` was a full-item write, so a second create REPLACED the row — dropping `shared`,
     * `sharedAt`, `sharedById` and `sharedByName`, resetting `createdAt`, and renaming the thread to
     * whatever the latest prompt was. And because message syncs were failing on an expired bearer, the
     * thread had zero messages FOR EVERY SUBSEQUENT TURN, so this branch fired again and again. Thread
     * `4392b109` was shared at 11:47:01 and recreated at 12:48:42 with the share gone.
     *
     * The service now refuses to overwrite (it returns the existing thread), so this is belt to that
     * braces — but it is the fix that stops the pointless call, and "zero messages" was never evidence
     * of a missing thread in the first place: a thread whose sync has never succeeded looks exactly
     * like one that was just created.
     */
    if (threadCheck.status === 404) {
      await checkedFetch("thread create", `${serverUrl}/v1/ai/teams/${encodeURIComponent(teamId)}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: sessionId,
          title: userMessage.replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 80) || "Chat",
          aiProvider: aiProvider || "claude",
        }),
      });
    }

    await checkedFetch("message sync", `${serverUrl}/v1/ai/threads/${encodeURIComponent(sessionId)}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Idempotency key — the server derives deterministic message ids from it, so
        // an at-least-once retry converges instead of duplicating the turn.
        ...(clientTurnId ? { clientTurnId } : {}),
        messages,
      }),
    });
    return "synced";
  } catch (err) {
    notifySyncFailed("ai-chat", err);
    return "failed";
  }
}

/** The turn a caller wants recorded. Named fields, because the positional form had six arguments and
 *  two of them were optional strings — a call site could silently swap provider and turn id. */
export interface CliTurn {
  sessionId: string;
  userMessage: string;
  /**
   * Row ids to stamp with the outcome. Optional because the caller may not have one for either half —
   * a stopped turn has no assistant row, and a legacy call site may not pass the user's.
   *
   * ⚠ WITHOUT THESE THE SYNC IS UNOBSERVABLE, which is the state that let two failures hide. A turn
   * whose ids are absent still syncs; it just leaves no local record of having done so.
   */
  userMessageId?: string;
  assistantMessageId?: string;
  /**
   * The reply, or `""` when the turn produced none — a Stop before the first token, or a CLI that
   * exited silently. An empty value syncs the USER's message alone rather than nothing at all; see
   * `syncToServer`.
   */
  assistantMessage: string;
  aiProvider?: string;
  clientTurnId?: string;
  latencyMs?: number;
  /**
   * Token counts the CLI reported for this turn.
   *
   * ⚠ SAME STANDING AS `latencyMs`: measured by the process that ran the CLI, which is the only thing that
   * can see them, and OMITTED when it did not report any. They travel as message metadata and are
   * deliberately NOT added to the activity event — see the note at the call site in the ai service.
   */
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningOutputTokens?: number;
  };
  /**
   * How full the assistant said its context window was when this turn ended, 0..100.
   *
   * ⚠ NOT A MEMBER OF `tokens`, AND THE DISTINCTION IS THE POINT. Those are counts that legitimately sum
   * across a thread; this is a STATE at one instant. Only Kiro reports it (`_kiro.dev/metadata`), and only
   * `kiro-acp.ts` sets it — see the note on the field in `syncToServer` for why a rollup must take the last
   * reading rather than a total or an average.
   */
  contextUsagePercent?: number;
}

/**
 * ── ⚠ RETRY ONE TURN, ON DEMAND ──────────────────────────────────────────────────────────
 *
 * The participant's own recovery path: a message showing "not synced" offers a retry, and this is what
 * it calls. Until now a failed push was permanent — there is no background sweep — so a turn lost to an
 * expired token stayed lost even after the session recovered.
 *
 * ⚠ SAFE TO PRESS REPEATEDLY, and that rests on `clientTurnId`, which is the assistant row's id: the
 * server derives deterministic message ids from it, so a second push OVERWRITES the turn rather than
 * appending a duplicate. That property is what makes exposing this button reasonable at all — without
 * it, an impatient double-click would double the transcript and inflate the counters that rank people.
 *
 * Returns the resulting status so the caller can render the outcome without re-reading the database.
 */
export async function retryMessageSync(
  messageId: string
): Promise<{ retried: boolean; status?: SyncStatus }> {
  /**
   * ⚠ THE ACCOUNT IS READ HERE AND PASSED IN, so the predicate cannot be forgotten by a caller.
   * Without it, this function pushed whatever row the id named
   * — including another local account's private conversation — to the CURRENT account's team, with
   * the current account's bearer. See the note on `loadTurnForRetry`.
   */
  /**
   * ⚠ AND THE EXPERIENCE TOO, for the reason written out on `loadTurnForRetry`: the push below reads
   * the CURRENT `team_id`, so a turn recorded in a previous workshop would be published into whichever
   * team the user has joined since. The button and the background sweep must refuse the same rows.
   */
  const turn = loadTurnForRetry(messageId, activeUserId(), activeExperience());
  if (!turn) {
    // ⚠ ONE MESSAGE FOR FOUR CASES: absent, another account's, another workshop's, or already synced.
    // A caller must not be able to tell them apart, or this channel becomes a probe for which turns exist.
    debugLog("[cli-assistant] retry requested for a message that is not retryable:", messageId);
    return { retried: false };
  }

  await syncCliTurn({
    sessionId: turn.sessionId,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    ...(turn.aiProvider ? { aiProvider: turn.aiProvider } : {}),
    // The assistant row id doubles as the idempotency key, exactly as on the original push.
    ...(turn.assistantMessageId ? { clientTurnId: turn.assistantMessageId } : {}),
    userMessageId: turn.userMessageId,
    ...(turn.assistantMessageId ? { assistantMessageId: turn.assistantMessageId } : {}),
    /**
     * ⚠ THE STORED COUNTS GO WITH IT. The server overwrites the turn on `clientTurnId`, so a re-push that
     * omitted them would REDUCE the portal's token total for the thread — a retry making the record worse.
     */
    ...(turn.tokens ? { tokens: turn.tokens } : {}),
    /* Same reasoning as the counts: omitting it on a re-push would ERASE the portal's reading. */
    ...(turn.contextUsagePercent !== undefined
      ? { contextUsagePercent: turn.contextUsagePercent }
      : {}),
  });

  /**
   * Read back rather than inferred from the push's return: `syncCliTurn` already wrote the status, and
   * reporting anything else here would give the UI a second, possibly disagreeing, source of truth.
   */
  return { retried: true, status: readSyncStatus(messageId) ?? undefined };
}

/** Record one turn. Never throws: a failed sync must not fail a turn the user already saw. */
export async function syncCliTurn(turn: CliTurn): Promise<void> {
  /**
   * ── ⚠ SUCCESS IS LOGGED NOW, AND THE SILENCE WAS ITSELF A BUG REPORT ──────────────────────
   *
   * It was not stuck. That line is printed immediately BEFORE this fire-and-forget call, and only
   * FAILURES logged anything — so a successful sync produced exactly the same output as a hang. The turn in
   * question was verified present in `praimana-ai-messages`; the log simply never said so.
   *
   * ⚠ A LOG THAT ONLY SPEAKS WHEN THINGS BREAK CANNOT ANSWER "did it work?". The per-message badge answers
   * it in the UI, but the log is where someone looks when the UI is not enough — and an unanswerable
   * question there costs a support round trip and, this time, a false bug report. One line closes it.
   *
   * Timed, because "synced" and "synced after 9 seconds" are different facts: the second is the early
   * warning for the timeout that produces the failure this function used to be silent about.
   */
  const startedAt = Date.now();

  const outcome = await syncToServer(
    turn.sessionId,
    turn.userMessage,
    turn.assistantMessage,
    turn.aiProvider,
    turn.clientTurnId,
    turn.latencyMs,
    turn.userMessageId,
    turn.assistantMessageId,
    turn.tokens,
    turn.contextUsagePercent
  );

  /**
   * ── ⚠ THE LOCAL RECORD OF WHETHER IT TRAVELLED ─────────────────────────────────────────
   *
   * Written AFTER the push resolves, from its actual outcome — never optimistically before it. An
   * optimistic 'synced' is worse than no column at all: it is a positive claim that the transcript is
   * complete, made by the code that has no idea yet whether it is.
   *
   * ⚠ AND THE WRITE ITSELF CANNOT BE ALLOWED TO FAIL THE TURN. The push already happened and the
   * participant already saw the reply; a SQLite error here must degrade to "unknown status", which is
   * exactly what a `pending` row left in place means.
   */
  debugLog(
    `[cli-assistant] sync ${outcome} in ${Date.now() - startedAt}ms` +
      ` (${turn.assistantMessage.length}ch, session ${turn.sessionId.slice(0, 8)})`
  );

  const ids = [turn.userMessageId, turn.assistantMessageId].filter(
    (id): id is string => !!id
  );
  // A skipped push leaves the rows exactly as they are — 'pending' already says "not confirmed".
  if (ids.length === 0 || outcome === "skipped") return;

  try {
    /**
     * ⚠ THE ACCOUNT IS PASSED, NOT ASSUMED. `ids` carries `turn.userMessageId`, which is
     * renderer-supplied on `cli:send` — so without this predicate a caller could stamp another local
     * account's row `synced` and drop it out of both the retry and the sweep for ever. See `update`.
     */
    const owner = activeUserId();
    if (outcome === "synced") markMessagesSynced(ids, owner, turn.sessionId);
    else markMessagesFailed(ids, owner, turn.sessionId);
    // Broadcast only AFTER the write succeeds, so the UI cannot show a status the database disagrees with.
    notifySyncStatus(ids, outcome === "synced" ? SYNC_SYNCED : SYNC_FAILED);
  } catch (err) {
    debugLog(
      "[cli-assistant] could not record sync status:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
