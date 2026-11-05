// ── THE SYNC STATUS COLUMN, AND THE TURN A RETRY REBUILDS ────────────────────────────────
//
// Migration 11 records whether each message reached the team's transcript; `SyncBadge` renders it and
// offers a retry. The risky half is `loadTurnForRetry`: the schema records NO link between a prompt and
// its reply, so the pairing is POSITIONAL, and getting it wrong re-pushes the wrong text under someone's
// question. These tests pin that pairing against a real in-memory SQLite database rather than a fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
/**
 * ⚠ `node:sqlite`, NOT `better-sqlite3`, AND THAT IS FORCED RATHER THAN PREFERRED. The app's driver is a
 * NATIVE module compiled against Electron's Node ABI (133); vitest runs under system Node (137), so
 * loading it here fails with NODE_MODULE_VERSION mismatch — which is why every other test in this repo
 * mocks it away.
 *
 * Mocking it away is exactly what must NOT happen in this file. The behaviour under test IS the SQL: the
 * positional pairing, the CHECK constraint, the `CASE` that clears `synced_at`. A hand-written fake would
 * assert that my queries match my fake's idea of them and prove nothing about SQLite. Node's own built-in
 * driver is a real engine, so the real migrations run against it.
 */
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

let db: DatabaseSync;

vi.mock("./database", () => ({ getDb: () => db }));

const {
  loadTurnForRetry,
  markMessagesSynced,
  markMessagesFailed,
  readMessageTimes,
  readSyncStatus,
  countUnsyncedMessages,
} = await import("./message-sync-status");

/**
 * The REAL schema, applied by running the real migration list — so the CHECK constraint on
 * `sync_status` and the partial index are exercised exactly as they will be on a participant's machine.
 * A hand-written CREATE TABLE here could drift from migrations.ts and hide precisely the mismatch this
 * file should catch.
 */
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  db.prepare(
    "INSERT INTO projects (id, name, path) VALUES ('p1', 'proj', '/tmp/p')"
  ).run();
  db.prepare(
    "INSERT INTO chat_sessions (id, project_id, title, ai_provider) VALUES ('s1', 'p1', 'Chat', 'claude')"
  ).run();
});

/** Insert a row with an explicit timestamp, since the pairing is by `created_at` order. */
function msg(id: string, role: string, content: string, at: string, status?: string) {
  db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
     VALUES (?, 's1', ?, ?, ?, ?)`
  ).run(id, role, content, at, status ?? null);
}

// ─── THE STATUS TRANSITIONS ──────────────────────────────────────────────────────────

describe("recording whether a message travelled", () => {
  it("stamps synced with a timestamp, in one statement", () => {
    msg("u1", "user", "hello", "2026-08-13T10:00:00Z", "pending");

    markMessagesSynced(["u1"], null, "s1");

    const row = db.prepare("SELECT sync_status, synced_at FROM chat_messages WHERE id = 'u1'").get() as {
      sync_status: string;
      synced_at: string | null;
    };
    expect(row.sync_status).toBe("synced");
    // ⚠ A 'synced' row with no timestamp would be indistinguishable from a half-applied update.
    expect(row.synced_at).toBeTruthy();
  });

  /**
   * ⚠ THE TIMESTAMP IS CLEARED ON THE WAY BACK DOWN. A row that synced and later failed must not keep a
   * `synced_at` claiming otherwise — that field is what a future retry sweep would use to decide what it
   * may skip.
   */
  it("clears synced_at when a previously-synced row fails", () => {
    msg("u1", "user", "hello", "2026-08-13T10:00:00Z", "pending");
    markMessagesSynced(["u1"], null, "s1");

    markMessagesFailed(["u1"], null, "s1");

    const row = db.prepare("SELECT sync_status, synced_at FROM chat_messages WHERE id = 'u1'").get() as {
      sync_status: string;
      synced_at: string | null;
    };
    expect(row.sync_status).toBe("failed");
    expect(row.synced_at).toBeNull();
  });

  it("ignores ids that do not exist, rather than throwing", () => {
    // A stopped turn has no assistant row, so the caller legitimately passes an id for a row that was
    // never written. That is not an error to report.
    expect(() => markMessagesSynced(["nope"], null, "s1")).not.toThrow();
  });

  it("ignores an empty id list", () => {
    expect(() => markMessagesSynced([], null, "s1")).not.toThrow();
    expect(() => markMessagesFailed([""], null, "s1")).not.toThrow();
  });

  /**
   * ── ⚠ THE STATUS WRITE CANNOT REACH ANOTHER ACCOUNT'S ROW ────────────────────────────────────
   *
   * This was `WHERE id IN (…)` alone, and the ids arrive as `turn.userMessageId`, which is renderer-supplied
   * on `cli:send` and never ownership-checked before the update.
   *
   * ⚠ AND THE HARM IS SILENCE, WHICH IS WHY IT IS WORTH A TEST OF ITS OWN. Both the retry and the sweep
   * select on `sync_status IN ('pending','failed')`, so a row forced to 'synced' leaves BOTH selections
   * for ever: the turn is never pushed, and nothing reports the gap. A failed push at least leaves
   * 'failed' for somebody to notice.
   */
  it("⚠ refuses to stamp a row owned by another local account", () => {
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s-b', 'p1', 'Theirs', 'claude', 'user-b')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('b1', 's-b', 'user', 'theirs', '2026-08-13T10:00:00Z', 'pending')`
    ).run();

    // account A, naming account B's row id — the shape `cli:send` permits.
    markMessagesSynced(["b1"], "user-a", "s-b");

    const row = db.prepare("SELECT sync_status FROM chat_messages WHERE id = 'b1'").get() as {
      sync_status: string;
    };
    expect(row.sync_status, "must still be owed, and still visible as owed").toBe("pending");
  });

  /**
   * ── ⚠ AND IT CANNOT REACH ANOTHER SESSION OF THE **SAME** ACCOUNT ─────────────────────────────
   *
   * The account predicate above was added in an earlier cycle and the session predicate was not, so the
   * finding survived its own fix: `cli:send` authorises `params.sessionId` and forwards
   * `params.userMessageId` verbatim, so renderer-resident code could send a trivial prompt in a chat it owns
   * while naming a PENDING id from any other chat of the same account — and that row was stamped `synced`.
   *
   * ⚠ THE ACCOUNT PREDICATE CANNOT CATCH THIS, which is the whole point of a second test: both rows
   * belong to `user-a`, so `user_id IS ?` matches. Only the turn's own session distinguishes them.
   *
   * Same silence as above: pushed nowhere, retried never, swept never, and SyncBadge renders nothing —
   * the module's own words, "a silent, unrecoverable hole in the transcript while the UI affirms
   * delivery".
   */
  it("⚠ refuses to stamp a row in another session of the same account", () => {
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s2', 'p1', 'Another chat of mine', 'claude', 'user-a')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('other', 's2', 'user', 'a real turn', '2026-08-13T10:00:00Z', 'pending')`
    ).run();

    // The turn being pushed is in 's1'; the id named belongs to 's2'. Same account, different chat.
    markMessagesSynced(["other"], "user-a", "s1");

    expect(
      (
        db.prepare("SELECT sync_status FROM chat_messages WHERE id = 'other'").get() as {
          sync_status: string;
        }
      ).sync_status,
      "must still be owed, so the retry and the sweep can still see it"
    ).toBe("pending");
  });

  /** The same omission on the way down: a foreign row must not be marked failed either. */
  it("⚠ refuses to mark a row in another session of the same account failed", () => {
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s2', 'p1', 'Another', 'claude', 'user-a')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('other', 's2', 'user', 'x', '2026-08-13T10:00:00Z', 'synced')`
    ).run();

    markMessagesFailed(["other"], "user-a", "s1");

    expect(
      (
        db.prepare("SELECT sync_status FROM chat_messages WHERE id = 'other'").get() as {
          sync_status: string;
        }
      ).sync_status
    ).toBe("synced");
  });

  it("stamps the owner's own row through the same predicate", () => {
    // The predicate must not break the case it exists to permit.
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    msg("u1", "user", "mine", "2026-08-13T10:00:00Z", "pending");

    markMessagesSynced(["u1"], "user-a", "s1");

    expect(
      (db.prepare("SELECT sync_status FROM chat_messages WHERE id = 'u1'").get() as { sync_status: string })
        .sync_status
    ).toBe("synced");
  });

  /**
   * ⚠ THE SCHEMA IS THE BACKSTOP. Migration 11 carries a CHECK constraint, so a status this module does
   * not know about fails the write loudly instead of being stored where no query matches it.
   */
  it("the schema refuses a status outside the closed set", () => {
    msg("u1", "user", "hello", "2026-08-13T10:00:00Z");
    expect(() =>
      db.prepare("UPDATE chat_messages SET sync_status = 'probably' WHERE id = 'u1'").run()
    ).toThrow();
  });

  it("reads back a stored status, and null for an untracked row", () => {
    msg("u1", "user", "a", "2026-08-13T10:00:00Z", "failed");
    msg("u2", "user", "b", "2026-08-13T10:01:00Z"); // legacy: no status

    expect(readSyncStatus("u1")).toBe("failed");
    expect(readSyncStatus("u2")).toBeNull();
    expect(readSyncStatus("missing")).toBeNull();
  });

  /**
   * ⚠ LEGACY ROWS ARE NOT COUNTED. NULL means "written before this column existed", i.e. unknown —
   * counting those would report a backlog of every message ever sent and invite a retry sweep across a
   * 30-day history.
   */
  it("counts only rows it has actually tracked", () => {
    msg("u1", "user", "a", "2026-08-13T10:00:00Z", "pending");
    msg("u2", "user", "b", "2026-08-13T10:01:00Z", "failed");
    msg("u3", "user", "c", "2026-08-13T10:02:00Z", "synced");
    msg("u4", "user", "d", "2026-08-13T10:03:00Z"); // unknown

    expect(countUnsyncedMessages(null, null)).toBe(2);
  });
});

// ─── ⚠ THE POSITIONAL PAIRING ────────────────────────────────────────────────────────

describe("⚠ rebuilding the turn a retry must re-push", () => {
  it("pairs a user message with the reply that followed it", () => {
    msg("u1", "user", "why is the build red?", "2026-08-13T10:00:00Z", "failed");
    msg("a1", "assistant", "the lockfile drifted", "2026-08-13T10:00:05Z", "failed");

    expect({ ...loadTurnForRetry("u1", null, null)! }).toEqual({
      sessionId: "s1",
      aiProvider: "claude",
      userMessage: "why is the build red?",
      userMessageId: "u1",
      assistantMessage: "the lockfile drifted",
      assistantMessageId: "a1",
    });
  });

  it("pairs an assistant reply with the prompt before it", () => {
    msg("u1", "user", "first", "2026-08-13T10:00:00Z", "synced");
    msg("a1", "assistant", "first reply", "2026-08-13T10:00:05Z", "synced");
    msg("u2", "user", "second", "2026-08-13T10:01:00Z", "pending");
    msg("a2", "assistant", "second reply", "2026-08-13T10:01:05Z", "failed");

    // Retrying the SECOND reply must rebuild the second turn, not the first.
    expect(loadTurnForRetry("a2", null, null)).toMatchObject({
      userMessage: "second",
      userMessageId: "u2",
      assistantMessage: "second reply",
      assistantMessageId: "a2",
    });
  });

  /**
   * ⚠ THE CASE THIS WHOLE FUNCTION EXISTS FOR, AND THE ONE MOST EASILY GOT WRONG. A stopped turn has no
   * reply. If the search for "the next assistant row" is not bounded by the next USER row, the prompt
   * adopts the FOLLOWING turn's answer — and the retry then pushes somebody else's reply under this
   * question, silently corrupting the transcript it was meant to repair.
   */
  it("does NOT adopt the next turn's reply for a stopped turn", () => {
    msg("u1", "user", "stopped question", "2026-08-13T10:00:00Z", "failed");
    msg("u2", "user", "next question", "2026-08-13T10:01:00Z", "synced");
    msg("a2", "assistant", "answer to the NEXT one", "2026-08-13T10:01:05Z", "synced");

    const turn = loadTurnForRetry("u1", null, null);

    expect(turn).toMatchObject({ userMessageId: "u1", assistantMessage: "" });
    expect(turn).not.toHaveProperty("assistantMessageId");
  });

  it("returns a user-only turn when the reply was never written", () => {
    msg("u1", "user", "only message", "2026-08-13T10:00:00Z", "pending");

    expect(loadTurnForRetry("u1", null, null)).toMatchObject({
      userMessage: "only message",
      assistantMessage: "",
    });
  });

  /**
   * ⚠ A LONE ASSISTANT ROW IS NOT RETRYABLE. `POST /sync` needs at least one message and the turn's
   * identity comes from its prompt; pushing a reply with no question would be a turn nobody asked.
   */
  it("refuses an assistant row with no preceding prompt", () => {
    msg("a1", "assistant", "orphan reply", "2026-08-13T10:00:00Z", "failed");

    expect(loadTurnForRetry("a1", null, null)).toBeNull();
  });

  it("refuses an unknown id, so nothing is pushed from nothing", () => {
    expect(loadTurnForRetry("does-not-exist", null, null)).toBeNull();
  });

  it("refuses a system row", () => {
    // System messages are local-only by nature — there is no server-side turn for one.
    msg("x1", "system", "session resumed", "2026-08-13T10:00:00Z");
    expect(loadTurnForRetry("x1", null, null)).toBeNull();
  });

  it("does not cross session boundaries", () => {
    // Another session's reply must never be paired with this session's prompt.
    db.prepare(
      "INSERT INTO chat_sessions (id, project_id, title, ai_provider) VALUES ('s2', 'p1', 'Other', 'codex')"
    ).run();
    msg("u1", "user", "mine", "2026-08-13T10:00:00Z", "failed");
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at)
       VALUES ('a9', 's2', 'assistant', 'other session reply', '2026-08-13T10:00:05Z')`
    ).run();

    const turn = loadTurnForRetry("u1", null, null);
    expect(turn!.assistantMessage).toBe("");
    expect(turn!.sessionId).toBe("s1");
  });

  it("carries the session's own provider, so the retry is attributed correctly", () => {
    db.prepare("UPDATE chat_sessions SET ai_provider = 'codex' WHERE id = 's1'").run();
    msg("u1", "user", "q", "2026-08-13T10:00:00Z", "failed");

    expect(loadTurnForRetry("u1", null, null)!.aiProvider).toBe("codex");
  });
});

// ── ⚠ A RETRY BELONGS TO THE ACCOUNT THAT IS SIGNED IN ───────────────────────────────────
//
// The reassembled turn is pushed with the CURRENT account's bearer, and on a 404 a thread is created under
// the CURRENT account's team. So without a predicate, one IPC call published another local account's private
// conversation into the caller's own team's transcript — and the background sweep did the same on a shared
// laptop with no attacker at all, simply because somebody signed in.
describe("⚠ the retry lookup is scoped to one local account", () => {
  /** A session owned by a second local account, with an unsynced turn in it. */
  function otherAccountTurn() {
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s-b', 'p1', 'Theirs', 'claude', 'user-b')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('b1', 's-b', 'user', 'my private question', '2026-08-13T10:00:00Z', 'failed')`
    ).run();
  }

  it("refuses a turn belonging to another account", () => {
    otherAccountTurn();
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();

    expect(loadTurnForRetry("b1", "user-a", null)).toBeNull();
  });

  it("returns that account's own turn", () => {
    otherAccountTurn();
    expect(loadTurnForRetry("b1", "user-b", null)).toMatchObject({ userMessage: "my private question" });
  });

  /**
   * ⚠ LEGACY SESSIONS CARRY NULL, and `user_id = NULL` is never true in SQL — hence `IS ?`. Without it,
   * every turn written before account scoping existed would be permanently unretryable, which is a
   * silent "retry does nothing" for exactly the oldest backlog.
   */
  it("still reaches a session written before accounts were recorded", () => {
    msg("u1", "user", "old question", "2026-08-13T10:00:00Z", "failed");
    // `s1` has a NULL user_id, and nobody is signed in.
    expect(loadTurnForRetry("u1", null, null)).toMatchObject({ userMessage: "old question" });
  });

  /**
   * ⚠ AND THE STATUS CLAUSE IS THE OTHER HALF OF THE SAME FINDING. `countUnsyncedMessages` and the
   * sweep both exclude `sync_status IS NULL` — "written before this column existed" — but a retry BY
   * ID bypassed both, so one call could re-push a 30-day history. A confirmed turn is likewise not
   * owed to anybody.
   */
  it("refuses a turn it has already synced, and one it never tracked", () => {
    msg("u1", "user", "synced already", "2026-08-13T10:00:00Z", "synced");
    msg("u2", "user", "never tracked", "2026-08-13T10:01:00Z"); // legacy NULL

    expect(loadTurnForRetry("u1", null, null)).toBeNull();
    expect(loadTurnForRetry("u2", null, null)).toBeNull();
  });
});

describe("⚠ the unsynced count is scoped the same way the sweep is", () => {
  /**
   * A gate and the query it gates must agree about what is eligible. An unscoped count sent the sweep
   * looking for work it then (correctly) refused to do — a backlog figure that never shrinks, and a
   * sweep that re-runs on every trigger.
   */
  it("counts only the active account's backlog", () => {
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    msg("u1", "user", "mine", "2026-08-13T10:00:00Z", "failed");
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s-b', 'p1', 'Theirs', 'claude', 'user-b')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('b1', 's-b', 'user', 'theirs', '2026-08-13T10:00:00Z', 'failed')`
    ).run();

    expect(countUnsyncedMessages("user-a", null)).toBe(1);
    expect(countUnsyncedMessages("user-b", null)).toBe(1);
    expect(countUnsyncedMessages(null, null)).toBe(0);
  });

  /**
   * The same agreement, one dimension over. When the workshop predicate went into `unsyncedRowIds`
   * this count had to gain it too, or the sweep's cheap exit would pass, the selection would return
   * nothing, and `remaining` would report a debt no sweep will ever settle.
   */
  it("counts only the current experience's backlog", () => {
    db.prepare("UPDATE chat_sessions SET workshop_id = 'ws-a' WHERE id = 's1'").run();
    msg("u1", "user", "recorded in A", "2026-08-13T10:00:00Z", "failed");

    expect(countUnsyncedMessages(null, "ws-a")).toBe(1);
    expect(countUnsyncedMessages(null, "ws-b"), "not owed to the team we are in now").toBe(0);
  });
});

/**
 * ── ⚠ AND THE TIMESTAMP READ IS SCOPED THE SAME WAY ──────────────────────────────────────────
 *
 * The secondary half of the same finding. `readMessageTimes` takes the same renderer-supplied ids and
 * the value it returns is FORWARDED TO THE REMOTE TEAM by `syncCliTurn` — so unscoped it was a channel
 * for learning when another local account wrote a message, published under the caller's own bearer.
 */
describe("⚠ the timestamp read is scoped to the active account", () => {
  beforeEach(() => {
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    msg("u1", "user", "mine", "2026-08-13T10:00:00Z", "pending");
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s-b', 'p1', 'Theirs', 'claude', 'user-b')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('b1', 's-b', 'user', 'theirs', '2026-08-13T11:00:00Z', 'pending')`
    ).run();
  });

  it("returns the owner's own timestamps", () => {
    expect(readMessageTimes(["u1"], "user-a", "s1")).toHaveProperty("u1");
  });

  it("⚠ omits another account's row rather than reporting its time", () => {
    const times = readMessageTimes(["u1", "b1"], "user-a", "s1");
    expect(times).toHaveProperty("u1");
    expect(times, "no evidence of when they wrote it").not.toHaveProperty("b1");
  });

  /**
   * The documented degradation for an id that does not resolve: no `createdAt`, and the service falls
   * back to its own stamp. A refused row is indistinguishable from an absent one, which is the point.
   */
  it("degrades to no timestamp rather than throwing", () => {
    expect(() => readMessageTimes(["does-not-exist"], "user-a", "s1")).not.toThrow();
    // ⚠ AND ANOTHER SESSION OF THE SAME ACCOUNT IS NOT READABLE EITHER. `created_at` from these ids is
    // FORWARDED TO THE REMOTE TEAM by `syncCliTurn`, so an unscoped read published when another of the
    // participant's chats was written, under their own bearer.
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s2', 'p1', 'Another', 'claude', 'user-a')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sync_status)
       VALUES ('other', 's2', 'user', 'x', '2026-08-13T10:00:00Z', 'pending')`
    ).run();
    expect(readMessageTimes(["other"], "user-a", "s1"), "another chat of mine is still not mine to read here").toEqual({});

    expect(readMessageTimes(["does-not-exist"], "user-a", "s1")).toEqual({});
  });
});

// ── ⚠ A TURN IS ONLY EVER PUSHED INTO THE EXPERIENCE IT WAS RECORDED IN ──────────────────
//
// `chat_sessions.workshop_id` is stamped at creation so a chat stays with the experience it was had
// in, and every READ path honours it. The push did not: it reads whatever `team_id` is current at push
// time, so a participant who left workshop A with turns still `pending`/`failed` and joined team B had
// A's private transcripts filed into B's thread store — no attacker, no prompt, on the next startup.
describe("⚠ the retry lookup is scoped to the experience the turn belongs to", () => {
  /** A turn recorded while the user was in workshop A, still owed to the server. */
  function turnFromWorkshopA() {
    db.prepare("UPDATE chat_sessions SET workshop_id = 'ws-a' WHERE id = 's1'").run();
    msg("u1", "user", "workshop A discussion", "2026-08-13T10:00:00Z", "failed");
  }

  it("refuses a turn from a workshop the user has since left", () => {
    turnFromWorkshopA();
    // The user has joined team B, whose experience is ws-b.
    expect(loadTurnForRetry("u1", null, "ws-b")).toBeNull();
  });

  it("returns it once that experience is current again", () => {
    turnFromWorkshopA();
    /**
     * ⚠ THE ROW IS DEFERRED, NOT DROPPED. It keeps its `failed` status throughout, so returning to
     * workshop A settles the backlog rather than losing it — which is what makes refusing above an
     * acceptable trade rather than data loss.
     */
    expect(loadTurnForRetry("u1", null, "ws-a")).toMatchObject({
      userMessage: "workshop A discussion",
    });
  });

  /**
   * ⚠ A SESSION WITH NO WORKSHOP IS STILL RETRYABLE, matching the read paths' `IS NULL OR` clause.
   * Migration 10 back-fills these, but a row it could not reach must not become permanently unsyncable
   * — that would be the "retry does nothing" symptom for exactly the oldest backlog.
   */
  it("still reaches a session written before experiences were recorded", () => {
    msg("u1", "user", "pre-workshop question", "2026-08-13T10:00:00Z", "failed");
    expect(loadTurnForRetry("u1", null, "ws-b")).toMatchObject({
      userMessage: "pre-workshop question",
    });
  });

  /**
   * ⚠ AND WITH NO EXPERIENCE CURRENT, ONLY PROVENANCE-UNKNOWN ROWS ARE ELIGIBLE. "Signed in, not on a
   * team" is a real state, and the safe reading of "nowhere to publish to" is never a row stamped with
   * a real workshop — not "anything goes".
   */
  it("refuses a stamped turn when no experience is current", () => {
    turnFromWorkshopA();
    expect(loadTurnForRetry("u1", null, null)).toBeNull();
  });
});

// ── ⚠ A RETRY MUST NOT MAKE THE RECORD WORSE ─────────────────────────────────────────────
//
// The token counts are stored on the assistant row and pushed to the portal, and the server OVERWRITES a turn
// on `clientTurnId`. So a re-push that omitted them would REDUCE the portal's total for that thread — pressing
// "retry" to fix a sync would quietly damage the figure it had already reported.
//
// Driven against the real schema, because the columns and the NULL-versus-zero distinction ARE the behaviour.
describe("⚠ a rebuilt turn carries the stored token counts", () => {
  /**
   * Insert a counted assistant row. `null` means never counted, which is not zero.
   *
   * ⚠ STAMPED 'failed', because a retry only reassembles a turn it is still owed — see the status
   * clause on `loadTurnForRetry`. These rows carried no status when the tests were written, which was
   * a fixture shortcut rather than a realistic row: a row the sync has never tracked is one written
   * before the column existed, and re-pushing those was the 30-day-history hazard the clause closes.
   */
  function counted(id: string, at: string, input: number | null, output: number | null) {
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, input_tokens, output_tokens, sync_status)
       VALUES (?, 's1', 'assistant', 'reply', ?, ?, ?, 'failed')`
    ).run(id, at, input, output);
  }

  it("carries them when the retry starts from the assistant row", () => {
    msg("u1", "user", "ask", "2026-08-14 10:00:00", "failed");
    counted("a1", "2026-08-14 10:00:05", 13027, 61);

    expect(loadTurnForRetry("a1", null, null)!.tokens).toEqual({ inputTokens: 13027, outputTokens: 61 });
  });

  /**
   * ⚠ AND WHEN IT STARTS FROM THE USER ROW, where the counts live on the REPLY rather than on the row asked
   * about. Reading them off the user row would always find nothing and lose them on every retry pressed from
   * a prompt — which is the half of the UI a participant is most likely to click.
   */
  it("carries them when the retry starts from the user row", () => {
    msg("u1", "user", "ask", "2026-08-14 10:00:00", "failed");
    counted("a1", "2026-08-14 10:00:05", 900, 40);

    expect(loadTurnForRetry("u1", null, null)!.tokens).toEqual({ inputTokens: 900, outputTokens: 40 });
  });

  /** NULL must not become 0: a re-push claiming a measured zero would overwrite what the portal knew. */
  it("omits the field entirely for an uncounted turn", () => {
    msg("u1", "user", "ask", "2026-08-14 10:00:00", "failed");
    counted("a1", "2026-08-14 10:00:05", null, null);

    const turn = loadTurnForRetry("a1", null, null)!;
    expect(turn.tokens).toBeUndefined();
    expect(turn, "no key at all").not.toHaveProperty("tokens.inputTokens");
  });

  it("carries a partial count without inventing the missing half", () => {
    msg("u1", "user", "ask", "2026-08-14 10:00:00", "failed");
    counted("a1", "2026-08-14 10:00:05", null, 61);

    expect(loadTurnForRetry("a1", null, null)!.tokens).toEqual({ outputTokens: 61 });
  });

  /** A genuine zero is a measurement and must survive the round trip. */
  it("keeps a measured zero", () => {
    msg("u1", "user", "ask", "2026-08-14 10:00:00", "failed");
    counted("a1", "2026-08-14 10:00:05", 0, 0);

    expect(loadTurnForRetry("a1", null, null)!.tokens).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  /** A stopped turn has no reply, so there is nothing to carry — and no crash looking for it. */
  it("has nothing to carry when the turn produced no reply", () => {
    msg("u1", "user", "ask", "2026-08-14 10:00:00", "failed");

    expect(loadTurnForRetry("u1", null, null)!.tokens).toBeUndefined();
  });
});
