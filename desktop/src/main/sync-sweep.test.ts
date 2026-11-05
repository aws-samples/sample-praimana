// ── ⚠ THE SELF-HEALING SWEEP (backlog 8f) ────────────────────────────────────────────────
//
// A failed push used to be permanent unless a human noticed a badge and clicked retry. The scenario is
// concrete and it happened: this pool's ID tokens last 30 minutes, so a participant's later turns fail,
// the portal shows a conversation that stops mid-afternoon, and the transcripts sit locally marked
// `failed`. The sweep settles them the next time the app has a session.
//
// ⚠ DRIVEN AGAINST A REAL SQLITE DATABASE, for the same reason `message-sync-status.test.ts` is: the
// behaviour under test IS partly the SQL — the status filter, the age cutoff computed by SQLite's own
// clock, the oldest-first ordering. A fake would assert that my queries match my fake's idea of them.
//
// The RETRY is injected, because what matters here is the SCHEDULING POLICY — how many, in what order,
// how it stops — not the HTTP beneath it, which `cli-sync.auth.test.ts` already covers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

let db: DatabaseSync;

/**
 * ⚠ `readSetting` IS PART OF THE MOCK NOW, because the sweep has a PRECONDITION: it does not attempt a
 * team-scoped push unless the app is signed in and on a team. These tests are about sweep MECHANICS, so
 * they establish that precondition the way the real flow does — `session` below — and the precondition
 * itself is tested separately at the bottom of this file.
 */
let session: Record<string, string | null> = {};
vi.mock("./database", () => ({
  getDb: () => db,
  readSetting: (key: string) => session[key] ?? null,
}));
vi.mock("./debug-log", () => ({ debugLog: () => {} }));
/**
 * ⚠ THE ACTIVE ACCOUNT IS PART OF THE MOCK TOO, driven from the same `session` map. The sweep is
 * scoped to one local account (see the finding written up in sync-sweep.ts), so "who is signed in" is
 * now an input to the candidate query and these tests have to be able to set it.
 *
 * ⚠ AND SO IS THE ACTIVE EXPERIENCE, for the same reason and from the same map: the sweep is scoped to
 * the workshop a turn was recorded in as well as the account that recorded it. Both read through the
 * real `workshop_id` / `user_id` settings keys, so driving them from `session` keeps the fixture
 * honest about which of the two predicates a given case is exercising.
 */
vi.mock("./active-account", () => ({
  activeUserId: () => session["active_user_id"] || session["user_id"] || null,
  activeExperience: () => session["workshop_id"] || null,
}));

const { sweepUnsyncedTurns, __resetSweepForTest } = await import("./sync-sweep");
const { markMessagesSynced, readSyncStatus } = await import("./message-sync-status");
const { noteTeamUnreadable, noteTeamReadable, __resetTeamAccessState } = await import(
  "./team-access-state"
);

/** The real schema, from the real migration list. */
beforeEach(() => {
  __resetTeamAccessState();
  session = {
    server_url: "https://api.example.test",
    auth_token: "live-token",
    team_id: "team-1",
  };
  db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  db.prepare("INSERT INTO projects (id, name, path) VALUES ('p1', 'proj', '/tmp/p')").run();
  db.prepare(
    "INSERT INTO chat_sessions (id, project_id, title, ai_provider) VALUES ('s1', 'p1', 'Chat', 'codex')"
  ).run();
  __resetSweepForTest();
});

/**
 * Insert a message with an explicit age, so the `MIN_AGE_MS` cutoff can be exercised.
 * `datetime('now', ...)` writes exactly the format the column uses.
 */
function addMessage(
  id: string,
  role: "user" | "assistant",
  status: string | null,
  ageMinutes: number
) {
  db.prepare(
    `INSERT INTO chat_messages (id, session_id, role, content, sync_status, created_at)
     VALUES (?, 's1', ?, ?, ?, datetime('now', ?))`
  ).run(id, role, `${role} text ${id}`, status, `-${ageMinutes} minutes`);
}

/** A retry that succeeds, marking the whole turn as the real one does. */
const succeedingRetry = (turnRows: Record<string, string[]>) => {
  const calls: string[] = [];
  return {
    calls,
    retry: async (id: string) => {
      calls.push(id);
      // The real `retryMessageSync` pushes the user message AND the reply, stamping both — under the
      // signed-in account AND the turn's own session, which the status write is now scoped to.
      // `'s1'` is the chat every row here belongs to; `session` above is the SETTINGS row, not a chat.
      markMessagesSynced(turnRows[id] ?? [id], session["user_id"] ?? null, "s1");
      return { retried: true, status: "synced" };
    },
  };
};

const noSleep = async () => {};

describe("⚠ the sweep settles what the last session left owing", () => {
  it("does nothing at all when nothing is unsynced", async () => {
    addMessage("m1", "user", "synced", 30);
    const { retry, calls } = succeedingRetry({});

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual([]);
    expect(summary.attempted).toBe(0);
  });

  it("retries a failed turn and reports it recovered", async () => {
    addMessage("u1", "user", "failed", 30);
    addMessage("a1", "assistant", "failed", 29);
    const { retry, calls } = succeedingRetry({ u1: ["u1", "a1"] });

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual(["u1"]);
    expect(summary.recovered).toBe(1);
    expect(summary.remaining).toBe(0);
    expect(readSyncStatus("a1")).toBe("synced");
  });

  /**
   * ⚠ ONE ATTEMPT PER TURN, NOT PER ROW. `retryMessageSync` pushes both halves and stamps both, so the
   * partner row is no longer unsynced by the time the loop reaches it. Without re-reading the status
   * mid-sweep, every two-row turn would be pushed twice — idempotent server-side, and still double the
   * requests for nothing.
   */
  it("does not push the same turn twice via its partner row", async () => {
    addMessage("u1", "user", "pending", 30);
    addMessage("a1", "assistant", "pending", 29);
    addMessage("u2", "user", "pending", 20);
    addMessage("a2", "assistant", "pending", 19);
    const { retry, calls } = succeedingRetry({ u1: ["u1", "a1"], u2: ["u2", "a2"] });

    await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls, "one call per TURN").toEqual(["u1", "u2"]);
  });

  it("takes the oldest gap first", async () => {
    addMessage("newer", "user", "failed", 10);
    addMessage("older", "user", "failed", 90);
    const { retry, calls } = succeedingRetry({});

    await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls[0]).toBe("older");
  });
});

describe("⚠ every bound is real", () => {
  /**
   * ⚠ THE RACE GUARD. A turn being pushed right now is `pending` for the whole round trip. Sweeping it
   * would double the traffic for every live turn and could stamp it `failed` from a duplicate attempt
   * while the original was still in flight.
   */
  it("leaves a just-written row alone", async () => {
    addMessage("fresh", "user", "pending", 0);
    const { retry, calls } = succeedingRetry({});

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls, "a row seconds old is still in flight").toEqual([]);
    expect(summary.attempted).toBe(0);
    /**
     * ⚠ AND IT IS STILL REPORTED AS OWED. An earlier version of this assertion expected 0 while its own
     * comment said "still owed" — a self-contradiction, and the code was right: skipping a row because
     * it is too FRESH is not the same as having nothing to do, and a sweep that reported "0 remaining"
     * there would tell the next reader everything was settled. The row is picked up by a later sweep.
     */
    expect(summary.remaining, "deferred, not done").toBe(1);
  });

  it("caps how many turns one sweep attempts, and says what is left", async () => {
    for (let i = 0; i < 40; i++) addMessage(`u${i}`, "user", "failed", 90 - i);
    const { retry, calls } = succeedingRetry({});

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls.length, "bounded at MAX_TURNS_PER_SWEEP").toBe(25);
    expect(summary.attempted).toBe(25);
    // Shed load OBSERVABLY: the leftovers are reported, not hidden.
    expect(summary.remaining).toBe(15);
  });

  /**
   * ⚠ THE BREAKER IS THE POINT. If the session is unusable — revoked refresh token, wrong platform, no
   * network — EVERY attempt fails and each failure re-stamps the row. Without stopping, the sweep walks
   * the whole backlog to no effect and hammers a dead endpoint doing it.
   */
  it("stops after consecutive failures instead of walking the backlog", async () => {
    for (let i = 0; i < 20; i++) addMessage(`u${i}`, "user", "failed", 90 - i);
    const calls: string[] = [];
    const retry = async (id: string) => {
      calls.push(id);
      return { retried: true, status: "failed" };
    };

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls.length, "three strikes, not twenty").toBe(3);
    expect(summary.gaveUp).toBe(true);
    expect(summary.recovered).toBe(0);
  });

  /** A success resets the count, so one bad turn among good ones does not end the pass. */
  it("keeps going when failures are not consecutive", async () => {
    for (let i = 0; i < 6; i++) addMessage(`u${i}`, "user", "failed", 90 - i);
    const calls: string[] = [];
    const retry = async (id: string) => {
      calls.push(id);
      // Alternate: fail, succeed, fail, succeed…  never three in a row.
      const failing = calls.length % 2 === 1;
      if (!failing) markMessagesSynced([id], null, "s1");
      return { retried: true, status: failing ? "failed" : "synced" };
    };

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(summary.gaveUp).toBe(false);
    expect(calls.length).toBe(6);
  });

  /** A throwing retry must not end the sweep — one bad row is not the whole backlog. */
  it("survives a retry that throws", async () => {
    addMessage("bad", "user", "failed", 90);
    addMessage("good", "user", "failed", 80);
    const calls: string[] = [];
    const retry = async (id: string) => {
      calls.push(id);
      if (id === "bad") throw new Error("boom");
      markMessagesSynced([id], null, "s1");
      return { retried: true, status: "synced" };
    };

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual(["bad", "good"]);
    expect(summary.recovered).toBe(1);
  });
});

describe("⚠ two sweeps cannot overlap", () => {
  /**
   * Startup and sign-in can both fire within seconds of each other. Two concurrent sweeps would push
   * every turn twice and race each other's status reads.
   */
  it("drops a trigger that arrives while one is running", async () => {
    addMessage("u1", "user", "failed", 30);
    let inFlight = 0;
    let maxConcurrent = 0;
    const retry = async (id: string) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      markMessagesSynced([id], null, "s1");
      return { retried: true, status: "synced" };
    };

    const [first, second] = await Promise.all([
      sweepUnsyncedTurns({ retry, sleep: noSleep }),
      sweepUnsyncedTurns({ retry, sleep: noSleep }),
    ]);

    expect(maxConcurrent, "never two at once").toBe(1);
    // One of them did the work; the other was dropped rather than queued.
    expect(first.attempted + second.attempted).toBe(1);
  });
});

describe("⚠ rows from before the column existed are left alone", () => {
  /**
   * `sync_status IS NULL` means "written before migration 11", i.e. unknown — not failed. Sweeping those
   * would re-push a 30-day history on first launch after an update.
   */
  it("never sweeps a NULL status, even alongside real work", async () => {
    /**
     * ⚠ THE REAL PENDING ROW IS WHAT MAKES THIS TEST WORK. A first version inserted ONLY legacy NULL
     * rows — and passed for the wrong reason: `countUnsyncedMessages` excludes NULL, so the sweep
     * exited at its cheap early return and never ran the query being tested. The mutation that added
     * `OR sync_status IS NULL` to the WHERE clause passed the suite. Mixing in one genuine pending row
     * forces the query to execute, so the filter itself is under test.
     *
     * It matters on the first launch after an update: `sync_status IS NULL` means "written before
     * migration 11", i.e. UNKNOWN rather than failed, and sweeping those re-pushes a 30-day history.
     */
    addMessage("legacy1", "user", null, 5000);
    addMessage("legacy2", "assistant", null, 4999);
    addMessage("real", "user", "failed", 90);
    const { retry, calls } = succeedingRetry({});

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls, "only the tracked row").toEqual(["real"]);
    expect(summary.attempted).toBe(1);
  });
});

// ── ⚠ ONE ACCOUNT'S BACKLOG, NOT THE MACHINE'S ───────────────────────────────────────────
//
// This is the half of that finding with NO ATTACKER IN IT, which is what makes it worth its own block.
//
// The sweep is scheduled at startup and immediately after a session is adopted, and it pushed EVERY
// unsynced row on the machine with the newly signed-in account's bearer, creating threads under that
// account's team. So on a shared laptop where account B had turns left `failed` — the exact scenario
// this sweep exists for — account A merely signing in published B's private conversations to A's team.
describe("⚠ the sweep only settles the active account's turns", () => {
  /** A second local account with an unsynced turn of its own. */
  function otherAccountBacklog() {
    db.prepare(
      `INSERT INTO chat_sessions (id, project_id, title, ai_provider, user_id)
       VALUES ('s-b', 'p1', 'Theirs', 'codex', 'user-b')`
    ).run();
    db.prepare(
      `INSERT INTO chat_messages (id, session_id, role, content, sync_status, created_at)
       VALUES ('b1', 's-b', 'user', 'their private question', 'failed', datetime('now', '-90 minutes'))`
    ).run();
  }

  it("leaves another account's failed turn alone", async () => {
    session["user_id"] = "user-a";
    db.prepare("UPDATE chat_sessions SET user_id = 'user-a' WHERE id = 's1'").run();
    addMessage("mine", "user", "failed", 90);
    otherAccountBacklog();
    const { retry, calls } = succeedingRetry({});

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls, "the other account's turn must not be pushed").toEqual(["mine"]);
    expect(summary.attempted).toBe(1);
    expect(readSyncStatus("b1"), "and its status is untouched").toBe("failed");
  });

  /**
   * ⚠ THE CHEAP EXIT IS SCOPED TOO. `countUnsyncedMessages` gates the sweep, so if it counted the
   * machine's backlog while the candidate query returned one account's, the sweep would wake up on
   * every trigger, find nothing it may push, and report a backlog that never shrinks.
   */
  it("does not even start when the only backlog belongs to somebody else", async () => {
    session["user_id"] = "user-a";
    otherAccountBacklog();
    const { retry, calls } = succeedingRetry({});

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual([]);
    expect(summary.attempted).toBe(0);
    expect(summary.remaining, "nothing is owed by this account").toBe(0);
  });

  /**
   * ⚠ AND LEGACY SESSIONS STILL GET SWEPT. A session written before `user_id` existed carries NULL;
   * `user_id = NULL` is never true in SQL, so with `=` instead of `IS` the sweep would silently stop
   * settling exactly the oldest backlog it was written for. Every other test in this file relies on
   * this, since `s1` has no owner — it is asserted once, explicitly, so a future `=` fails here with a
   * reason rather than everywhere with a puzzle.
   */
  it("still settles a session written before accounts were recorded", async () => {
    addMessage("old", "user", "failed", 90);
    const { retry, calls } = succeedingRetry({});

    await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual(["old"]);
  });
});

describe("⚠ NO SESSION, NO SWEEP", () => {
  /**
   * `scheduleSweep("startup")` fires 5 seconds after launch with no preconditions, so on a machine that
   * owed the server some turns it pushed them while the user sat on the SIGN-IN screen. Every failure
   * came back as a red "Couldn't sync to the server" toast over a login form — one per turn — for a
   * condition that resolves itself the moment somebody signs in.
   */
  it.each([
    ["no server_url", { server_url: null }],
    ["no auth_token", { auth_token: null }],
    ["no team_id", { team_id: null }],
    ["nothing at all", { server_url: null, auth_token: null, team_id: null }],
  ])("does not attempt a push when there is %s", async (_label, missing) => {
    addMessage("m1", "user", "failed", 10);
    addMessage("m2", "assistant", "failed", 10);
    session = { ...session, ...missing };
    const retry = vi.fn();

    const summary = await sweepUnsyncedTurns({ retry, sleep: async () => {} });

    // The property that fixes the report: nothing was pushed, so nothing could fail, so no toast.
    expect(retry).not.toHaveBeenCalled();
    expect(summary.attempted).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it("SKIPPING IS NOT FAILING — the debt is reported and the rows are untouched", async () => {
    /**
     * The distinction that matters. Marking these rows failed would burn the retry budget and light up
     * the UI for a condition that is about to resolve; `scheduleSweep("session-adopted")` runs at
     * sign-in, which is exactly when the backlog CAN be settled.
     */
    addMessage("m1", "user", "failed", 10);
    addMessage("m2", "assistant", "failed", 10);
    const before = readSyncStatus("m1");
    session = { ...session, auth_token: null };

    const summary = await sweepUnsyncedTurns({ retry: vi.fn(), sleep: async () => {} });

    expect(summary.remaining).toBeGreaterThan(0);
    expect(readSyncStatus("m1"), "the row must be left exactly as it was").toBe(before);
  });

  it("still sweeps normally once a session IS present", async () => {
    // The guard must not become a permanent off switch — this is the non-regression.
    addMessage("m1", "user", "failed", 10);
    addMessage("m2", "assistant", "failed", 10);
    const retry = vi.fn(async () => ({ retried: true, status: "synced" }));

    const summary = await sweepUnsyncedTurns({ retry, sleep: async () => {} });

    expect(retry).toHaveBeenCalled();
    expect(summary.attempted).toBeGreaterThan(0);
  });
});

describe("⚠ NO PUSHING AT A TEAM THE SERVER REFUSES", () => {
  /**
   * Two turns attempted on every launch, both refused, and neither could succeed until the team problem
   * was fixed. The verdict already existed — the startup probe logs it SECONDS EARLIER — but
   * `retryMessageSync` returns `{ retried, status }` with no HTTP status, so the sweep had no way to ask.
   */
  it("skips entirely when the team is already known to be refused", async () => {
    addMessage("m1", "user", "failed", 10);
    addMessage("m2", "assistant", "failed", 10);
    noteTeamUnreadable("team-1", "HTTP 403");
    const retry = vi.fn();

    const summary = await sweepUnsyncedTurns({ retry, sleep: async () => {} });

    // The property the report asked for: zero requests.
    expect(retry).not.toHaveBeenCalled();
    expect(summary.attempted).toBe(0);
    expect(summary.remaining).toBeGreaterThan(0);
  });

  it("the verdict is keyed by TEAM, so re-joining is self-healing", async () => {
    /**
     * A verdict about the old team says nothing about the new one. This is what makes re-joining work
     * with nothing to remember to clear — the alternative, a persisted flag, would keep a fixed team
     * looking broken.
     */
    addMessage("m1", "user", "failed", 10);
    addMessage("m2", "assistant", "failed", 10);
    noteTeamUnreadable("some-other-team", "HTTP 403");
    const retry = vi.fn(async () => ({ retried: true, status: "synced" }));

    const summary = await sweepUnsyncedTurns({ retry, sleep: async () => {} });

    expect(retry, "a verdict about another team must not block this one").toHaveBeenCalled();
    expect(summary.attempted).toBeGreaterThan(0);
  });

  it("resumes once access is restored, without a relaunch", async () => {
    addMessage("m1", "user", "failed", 10);
    addMessage("m2", "assistant", "failed", 10);
    noteTeamUnreadable("team-1", "HTTP 403");
    noteTeamReadable("team-1");
    const retry = vi.fn(async () => ({ retried: true, status: "synced" }));

    await sweepUnsyncedTurns({ retry, sleep: async () => {} });

    expect(retry).toHaveBeenCalled();
  });

  it("stops mid-sweep the moment a refusal is learned, rather than counting to the breaker", async () => {
    /**
     * The consecutive-failure breaker exists for "the session or the network is the problem" and rightly
     * wants a few failures before believing it. A 403 is a verdict: every remaining turn fails
     * identically, so counting to the limit is two or three more requests to establish what is known.
     */
    for (let i = 1; i <= 8; i++) addMessage(`u${i}`, "user", "failed", 20 + i);
    // The first push learns the verdict, exactly as checkedFetch does in production.
    const retry = vi.fn(async () => {
      noteTeamUnreadable("team-1", "HTTP 403");
      return { retried: false };
    });

    const summary = await sweepUnsyncedTurns({ retry, sleep: async () => {} });

    expect(retry, "one attempt, then stop").toHaveBeenCalledTimes(1);
    expect(summary.attempted).toBe(1);
    expect(summary.gaveUp).toBe(true);
  });
});

// ── ⚠ THE SWEEP NEVER PUBLISHES A TURN INTO A TENANT IT WAS NOT RECORDED IN ──────────────
//
// ⚠ THIS IS THE PATH WITH NO ATTACKER IN IT, and that is why it gets its own block rather than relying
// on the retry-level cases in message-sync-status.test.ts. `scheduleSweep` fires at startup and again
// the moment a session is adopted; the push then reads whatever `team_id` is CURRENT. So a participant
// who finished workshop A with turns still owed and joined team B had A's private transcripts filed
// into B's thread store on the next launch — no IPC call, no hostile dependency, nobody clicking
// anything. The sweep is the component that decided to send them.
//
// ⚠ TWO LAYERS HOLD THIS, AND MUTATION TESTING SAYS SO: removing the predicate from `unsyncedRowIds`
// alone leaves every case here GREEN, because `countUnsyncedMessages` carries it too and the cheap exit
// at the top of the sweep fires first. Only removing both fails these three. Same relationship as the
// `readSyncStatus` re-read documented in the module — do not delete either as redundant, and do not
// read a green suite here as proof that one of them is doing the work.
describe("⚠ the sweep is scoped to the experience a turn was recorded in", () => {
  /** Put the fixture session in workshop A, with a turn still owed to the server. */
  function turnRecordedInWorkshopA() {
    db.prepare("UPDATE chat_sessions SET workshop_id = 'ws-a' WHERE id = 's1'").run();
    addMessage("u1", "user", "failed", 30);
    addMessage("a1", "assistant", "failed", 29);
  }

  it("⚠ does not push workshop A's turns after the user joins team B", async () => {
    turnRecordedInWorkshopA();
    // The state after `ai:joinTeam` / `ai:selectTeam` writes the new tenant.
    session.team_id = "team-b";
    session.workshop_id = "ws-b";
    const retry = vi.fn(async () => ({ retried: true, status: "synced" }));

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(retry, "team B must never be told about workshop A's chats").not.toHaveBeenCalled();
    expect(summary.attempted).toBe(0);
  });

  /**
   * ── ⚠ "REMAINING" IS NOW PER-TENANT, AND THAT IS A REAL TRADE ────────────────────────────────
   *
   * Worth stating plainly rather than discovering later. `countUnsyncedMessages` carries the same
   * workshop predicate as the selection — it has to, or the cheap exit would pass and the query return
   * nothing on every trigger — so while the user is in team B the summary reports ZERO remaining even
   * though workshop A's rows are still `pending`/`failed` on disk.
   *
   * ⚠ THE ROWS ARE UNTOUCHED, WHICH IS WHAT MAKES THAT ACCEPTABLE. Nothing is stamped, nothing is
   * dropped: returning to workshop A makes them eligible again and the next sweep settles them. What is
   * lost is only the COUNT while a different tenant is active, and reporting a debt the sweep will
   * correctly refuse to settle would be the worse of the two — a backlog figure that never shrinks,
   * which is exactly what the account-scoping comment on `countUnsyncedMessages` warns about.
   *
   * The alternative — an unscoped count beside a scoped selection — is the self-contradiction the
   * freshness case above already ran into once. A gate and its query must agree.
   */
  it("⚠ leaves the rows untouched, so returning to that workshop still settles them", async () => {
    turnRecordedInWorkshopA();
    session.team_id = "team-b";
    session.workshop_id = "ws-b";

    const summary = await sweepUnsyncedTurns({ retry: vi.fn(), sleep: noSleep });

    expect(summary.remaining, "no debt is owed to team B — see the note above").toBe(0);
    expect(readSyncStatus("u1"), "but the row is still owed to somebody").toBe("failed");
    expect(readSyncStatus("a1"), "both halves of the turn").toBe("failed");
  });

  it("settles them the moment that experience is current again", async () => {
    turnRecordedInWorkshopA();
    session.workshop_id = "ws-a";
    const { retry, calls } = succeedingRetry({ u1: ["u1", "a1"] });

    const summary = await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual(["u1"]);
    expect(summary.recovered).toBe(1);
  });

  /**
   * ⚠ A SESSION WITH NO WORKSHOP IS STILL SWEPT, matching the `IS NULL OR` clause every read path uses.
   * Migration 10 back-fills these; a row it could not reach must not become permanently unsyncable,
   * which would be a silent "sync never completes" for the oldest backlog on an upgraded install.
   */
  it("still sweeps a session written before experiences were recorded", async () => {
    addMessage("u1", "user", "failed", 30);
    session.workshop_id = "ws-b";
    const { retry, calls } = succeedingRetry({ u1: ["u1"] });

    await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(calls).toEqual(["u1"]);
  });

  /**
   * ⚠ AND WITH NO EXPERIENCE CURRENT, A STAMPED TURN IS STILL REFUSED. "Signed in, not on a team" is a
   * real state; the safe reading of "nowhere to publish to" is never a row stamped with a real workshop.
   */
  it("refuses a stamped turn when no experience is current", async () => {
    turnRecordedInWorkshopA();
    delete session.workshop_id;
    const retry = vi.fn(async () => ({ retried: true, status: "synced" }));

    await sweepUnsyncedTurns({ retry, sleep: noSleep });

    expect(retry).not.toHaveBeenCalled();
  });
});
