// ── LOCAL WORK IS SCOPED BY USER **AND** EXPERIENCE ─────────────────────────────
//
// Two participants on one machine must not see each other's chats, and one participant in two
// experiences must not see them merged. That is the feature.
//
// ⚠ BUT THE ASSERTION THAT MATTERS MOST IS THE OPPOSITE ONE: scoping must never HIDE work that
// already exists. "Old chats gone missing" was reported once already — a duplicate project row,
// not a filter — and adding an experience filter is the obvious way to cause it for real. Rows
// written before `workshop_id` existed carry NULL, and `workshop_id = <anything>` matches NULL in
// no SQL dialect. So every read treats NULL as VISIBLE, and migration 10 back-fills as well.
// Two independent protections, both pinned here.

import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  app: { getPath: () => "/tmp", setBadgeCount: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock("better-sqlite3", () => ({ default: class {} }));

/** Every SQL statement the handlers prepare, so a test can assert on the query itself. */
const prepared: string[] = [];
/** Bound parameters per statement, in order. */
const bound: unknown[][] = [];

const store = new Map<string, string>();
/** Whether the fake's ownership lookup resolves — see the `get()` note below. */
let ownedSessions = true;
vi.mock("../database", async () => {
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    readSetting: (key: string) => store.get(key) ?? null,
    writeSetting: (key: string, value: string) => {
      store.set(key, value);
    },
    getDb: () => ({
      prepare: (sql: string) => {
        prepared.push(sql);
        return {
          all: (...args: unknown[]) => {
            bound.push(args);
            return [];
          },
          get: (...args: unknown[]) => {
            bound.push(args);
            /**
             * ⚠ THE OWNERSHIP LOOKUP IS THE ONE `get()` THAT CAN ANSWER, driven by `ownedSessions`.
             * `db:addMessage` now asks whether the named session belongs to the active account before
             * it inserts, and a fake that answered `undefined` to
             * everything would make every write test a refusal test without saying so.
             */
            if (sql.includes("FROM chat_sessions WHERE id = ?")) {
              return ownedSessions ? { ok: 1 } : undefined;
            }
            return undefined;
          },
          run: (...args: unknown[]) => {
            bound.push(args);
            return undefined;
          },
        };
      },
    }),
  };
});

/**
 * ⚠ MOCKED SEPARATELY FROM `../database`, DELIBERATELY. `activeUserId()` is a two-key read
 * (`active_user_id`, falling back to `user_id`) and it lives in its own module so every query that
 * scopes by account names the same function — see active-account.ts, whose own test pins the
 * fallback. Here it is stubbed from the same `store` these tests already drive, so a case can set
 * the active account by writing a settings row and these tests stay about the SQL.
 */
/**
 * ⚠ AND `activeExperience` FOR THE SAME REASON. It moved here from a private helper in db.ts when the
 * transcript-sync paths needed it too (they honoured the account but not
 * the workshop, so a previous workshop's transcripts were published into a newly joined team). The
 * trimming behaviour these tests pin — "   " is not an experience — belongs to that function now, so
 * the stub has to reproduce it or the three whitespace cases below would assert against the mock.
 */
vi.mock("../active-account", () => ({
  activeUserId: () => store.get("active_user_id") || store.get("user_id") || null,
  activeExperience: () => {
    const value = store.get("workshop_id");
    return value && value.trim() ? value : null;
  },
}));

import { setupDbHandlers } from "./db";
import { recordUserChosenPath } from "../project-paths";

setupDbHandlers();

/**
 * `db:addProject` now refuses a path no native picker returned, because each row it writes
 * widens the filesystem boundary `allowedRoots()` enforces. These tests are about SCOPING,
 * not provenance, so they establish the precondition the real flow establishes — the user
 * chose the folder in a dialog — and leave the refusal itself to project-paths.test.ts.
 */
recordUserChosenPath("/tmp/p1");

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return handler({}, ...args);
}

/** The last statement prepared, which is the one the handler under test used. */
const lastSql = () => prepared[prepared.length - 1] ?? "";
const lastParams = () => bound[bound.length - 1] ?? [];

beforeEach(() => {
  store.clear();
  prepared.length = 0;
  bound.length = 0;
  store.set("user_id", "user-1");
  store.set("active_user_id", "user-1");
  // Owned by default: every case here is about a legitimate operation unless it says otherwise.
  ownedSessions = true;
});

describe("db:getProjects", () => {
  it("scopes by user AND experience when both are known", () => {
    store.set("workshop_id", "exp-1");

    invoke("db:getProjects");

    expect(lastSql()).toContain("user_id = ?");
    expect(lastSql()).toContain("workshop_id");
    expect(lastParams()).toEqual(["user-1", "exp-1"]);
  });

  /**
   * ⚠ THE DATA-LOSS GUARD. A bare `workshop_id = ?` would hide every project written before the
   * column existed, because NULL matches nothing. This is the clause that keeps them visible even
   * if migration 10's back-fill could not reach them.
   */
  it("treats a NULL experience as VISIBLE, never filtered out", () => {
    store.set("workshop_id", "exp-1");

    invoke("db:getProjects");

    expect(lastSql(), "legacy rows must survive the filter").toContain("workshop_id IS NULL OR");
  });

  /**
   * ⚠ NO EXPERIENCE IS A REAL STATE, not an error: a user signed in but not yet on a team has no
   * `workshop_id`. Matching `workshop_id = NULL` would return nothing, so the app would look empty
   * to someone who has simply not joined a team yet.
   */
  it("falls back to user-only scoping when there is no experience", () => {
    store.delete("workshop_id");

    invoke("db:getProjects");

    expect(lastSql()).toContain("user_id = ?");
    expect(lastSql()).not.toContain("workshop_id");
    expect(lastParams()).toEqual(["user-1"]);
  });

  it("treats an EMPTY experience the same as an absent one", () => {
    // A cleared setting is realistically "" rather than missing, and `workshop_id = ''` would match
    // nothing at all.
    store.set("workshop_id", "   ");

    invoke("db:getProjects");

    expect(lastSql()).not.toContain("workshop_id");
  });

  it("returns nothing when there is no user, rather than everything", async () => {
    // Failing closed on identity is right: an unscoped read would show one participant another's
    // work on a shared machine. `await`ed because the handler is async — the query is never even
    // prepared, which is the stronger property.
    store.clear();
    expect(await invoke("db:getProjects")).toEqual([]);
    expect(prepared, "no query should reach the database at all").toHaveLength(0);
  });
});

describe("db:getSessions", () => {
  it("scopes by project, user and experience", () => {
    store.set("workshop_id", "exp-1");

    invoke("db:getSessions", "proj-1");

    expect(lastSql()).toContain("project_id = ?");
    expect(lastSql()).toContain("user_id = ?");
    expect(lastSql()).toContain("workshop_id IS NULL OR");
    expect(lastParams()).toEqual(["proj-1", "user-1", "exp-1"]);
  });

  it("keeps chats from before experience scoping visible", () => {
    store.set("workshop_id", "exp-1");
    invoke("db:getSessions", "proj-1");
    expect(lastSql()).toContain("workshop_id IS NULL OR");
  });

  it("falls back to user-only when there is no experience", () => {
    store.delete("workshop_id");
    invoke("db:getSessions", "proj-1");
    expect(lastSql()).not.toContain("workshop_id");
  });
});

describe("writes stamp the experience, so reads can rely on it", () => {
  /**
   * ⚠ READ FROM SETTINGS, NOT TAKEN FROM THE CALLER. The renderer passed `workshopId` optionally
   * and never actually did — which is why both columns sat NULL for the app's entire history.
   * Reading it here means a project is tagged whether or not a call site remembers, and a renderer
   * cannot mis-tag its work as belonging to an experience it is not in.
   */
  it("db:addProject records the current experience and team", () => {
    store.set("workshop_id", "exp-1");
    store.set("team_id", "team-1");

    invoke("db:addProject", { id: "p1", name: "n", path: "/tmp/p1" });

    const insert = prepared.find((q) => q.includes("INSERT INTO projects")) ?? "";
    expect(insert).toContain("workshop_id");
    expect(insert).toContain("team_id");
    const params = bound[bound.length - 1];
    expect(params).toContain("exp-1");
    expect(params).toContain("team-1");
  });

  /**
   * ── ⚠ AND THE CALLER CANNOT OVERRIDE EITHER ONE ───────────────────────────────────────────────
   *
   * The bindings were `project.workshopId ?? currentExperience()` — the caller's value PREFERRED, the setting
   * a mere fallback — which is the opposite of what the comment above promised, and the preload bridge
   * forwarded the field.
   *
   * ⚠ WHY IT MATTERED: a projects row is a filesystem-confinement grant (`allowedRoots`). A row
   * tagged `workshopId: "no-such-workshop"` stayed inside the boundary while being invisible to
   * `db:getProjects`, so it never appeared in any list the UI can revoke from.
   */
  it("⚠ IGNORES a caller-supplied experience and team", () => {
    store.set("workshop_id", "exp-1");
    store.set("team_id", "team-1");

    invoke("db:addProject", {
      id: "p2",
      name: "n",
      // The same picker-approved folder: this case is about the SCOPING columns, and
      // `assertUserChosen` (its own cases below) is what governs the path.
      path: "/tmp/p1",
      // Not in the parameter type any more; a caller can still put them on the wire.
      workshopId: "no-such-workshop",
      teamId: "not-my-team",
    } as never);

    const params = bound[bound.length - 1];
    expect(params, "the settings decide").toContain("exp-1");
    expect(params).toContain("team-1");
    expect(params, "the caller does not").not.toContain("no-such-workshop");
    expect(params).not.toContain("not-my-team");
  });

  it("db:createSession stamps the experience at creation time", () => {
    store.set("workshop_id", "exp-1");

    invoke("db:createSession", { id: "s1", projectId: "p1" });

    expect(lastSql()).toContain("workshop_id");
    // Stamped at creation, so a chat stays with the experience it was had in even if the user later
    // joins another. A chat is a record of work, not a live pointer.
    expect(lastParams()).toContain("exp-1");
  });

  it("stamps NULL rather than an empty string when there is no experience", () => {
    // An empty string would tag rows with a value no live experience matches — invisible under a
    // strict filter, and undoing the back-fill's purpose.
    store.delete("workshop_id");

    invoke("db:createSession", { id: "s1", projectId: "p1" });

    expect(lastParams()).toContain(null);
    expect(lastParams()).not.toContain("");
  });
});

/**
 * ── ⚠ THE CHANNELS THAT KEYED ON A ROW ID ALONE ────────────────────────────────────────────────
 *
 * Three of these read `WHERE id = ?` and nothing else, while `db:getSessions` two describes up had bound the
 * account since the day it was written. Multi-account switching on one profile is a first-class feature, so
 * "another account's row" is not hypothetical: account B could read A's whole transcript, forge the shared
 * flag on it, or delete it.
 *
 * ⚠ EVERY ASSERTION IS `user_id IS ?`, NOT `= ?`, and that is the data-loss guard rather than a
 * style point: rows written before the column existed carry NULL, `NULL = NULL` is never true, and
 * with `=` these three statements would silently do nothing for exactly the oldest chats.
 */
describe("per-account chat channels bind the active account", () => {
  it("db:deleteSession cannot delete another account's chat", () => {
    invoke("db:deleteSession", "s1");

    expect(lastSql()).toContain("DELETE FROM chat_sessions");
    expect(lastSql()).toContain("user_id IS ?");
    expect(lastParams()).toEqual(["s1", "user-1"]);
  });

  it("db:setSessionShared cannot forge the shared flag on another account's chat", () => {
    invoke("db:setSessionShared", "s1", "2026-01-01T00:00:00Z");

    expect(lastSql()).toContain("UPDATE chat_sessions");
    expect(lastSql()).toContain("user_id IS ?");
    expect(lastParams()).toEqual(["2026-01-01T00:00:00Z", "s1", "user-1"]);
  });

  /**
   * `chat_messages` has no `user_id` of its own — the session owns the account — so the only way to
   * scope a transcript read is through the join. `m.*` keeps the returned shape identical to the
   * unscoped query this replaced, so no renderer has to change.
   */
  it("db:getMessages reaches the owner through the session", () => {
    invoke("db:getMessages", "s1");

    expect(lastSql()).toContain("JOIN chat_sessions");
    expect(lastSql()).toContain("s.user_id IS ?");
    expect(lastSql(), "the returned columns must not change shape").toContain("SELECT m.*");
    expect(lastParams()).toEqual(["s1", "user-1"]);
  });

  /** The switcher's key wins over the plain sign-in key — see active-account.ts. */
  it("follows the switched account, not the signed-in one", () => {
    store.set("active_user_id", "user-2");

    invoke("db:deleteSession", "s1");

    expect(lastParams()).toEqual(["s1", "user-2"]);
  });
});

/**
 * ── ⚠ IDS ARE VALIDATED WHERE THEY ENTER ───────────────────────────────────────────────────────
 *
 * A chat's row id is reused verbatim as the SERVER's thread id, so `x/../../../v1/auth/me?z=` stored here
 * became an authenticated request, with the user's bearer, against an endpoint the desktop never bridged. The
 * URL sites encode now as well; this is the half that keeps the stored data honest. See row-id.ts.
 */
describe("row ids are refused before they are stored", () => {
  it("db:createSession refuses a path-shaped id", async () => {
    await expect(
      invoke("db:createSession", { id: "x/../../../v1/auth/me?z=", projectId: "p1" })
    ).rejects.toThrow(/not in a form/i);
    expect(prepared, "nothing may reach the database").toHaveLength(0);
  });

  it("db:addMessage refuses a path-shaped id, and a path-shaped session id", async () => {
    await expect(
      invoke("db:addMessage", { id: "a/b", sessionId: "s1", role: "user", content: "hi" })
    ).rejects.toThrow(/not in a form/i);
    await expect(
      invoke("db:addMessage", { id: "m1", sessionId: "s1?x=1", role: "user", content: "hi" })
    ).rejects.toThrow(/not in a form/i);
    expect(prepared).toHaveLength(0);
  });

  it("accepts the ids the app actually generates", () => {
    // `crypto.randomUUID()` is what every call site passes.
    invoke("db:createSession", { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", projectId: "p1" });
    expect(prepared.length).toBeGreaterThan(0);
  });

  /**
   * ⚠ A SILENT NO-OP, NOT A THROW. This channel is called from a retry button in a message bubble;
   * a rejected promise there surfaces as an unhandled error in the renderer for what is either a
   * stale view or an attack, and neither deserves one.
   */
  it("sync:retryMessage drops a path-shaped id without touching the database", async () => {
    expect(await invoke("sync:retryMessage", "x/../v1/auth/me")).toEqual({ retried: false });
  });
});

describe("db:addProject is idempotent per folder", () => {
  /**
   * The bug that started this: two rows for one folder, `getProjects` ordering by `created_at DESC`,
   * and `App.tsx` selecting `[0]` — so the app loaded the NEW row and asked for its chats while nine
   * hung off the older one. A path IS a project's identity.
   */
  it("looks for an existing row before inserting", () => {
    invoke("db:addProject", { id: "p1", name: "n", path: "/tmp/p1" });

    const select = prepared.find((q) => q.includes("SELECT * FROM projects WHERE path")) ?? "";
    expect(select, "must check for a duplicate first").toBeTruthy();
    // `IS`, not `=`: `NULL = NULL` is never true, and legacy rows carry a NULL user_id — exactly the
    // rows most likely to have been duplicated.
    expect(select).toContain("user_id IS ?");
    // The OLDEST match wins, so the row carrying the longest history is the one kept.
    expect(select).toContain("ORDER BY created_at");
  });
});

// ── ⚠ A WRITE INTO SOMEBODY ELSE'S CHAT ─────────────────────────────────────────────────────
//
// `assertSafeRowId` guarded the SHAPE of both ids and nothing guarded whose session it was, while the
// three sibling operations on the same table all bind the account and the comment above them records
// that they were fixed after review found this exact omission. This channel was the write that was
// missed.
//
// ⚠ AND THE PLANTED ROW TRAVELS, which is what raises it above a tidy-up. It is stamped 'pending', and
// the background sweep selects pending rows scoped to the SESSION's owner — so a row inserted under
// another local account's session is pushed to THAT account's team thread, under THAT account's bearer,
// the next time they are active, and shows up in their history as their own conversation.
describe("⚠ db:addMessage will not write into a session this account does not own", () => {
  /** The fake `get()` answers `undefined` unless a test says the session resolves. */
  function sessionResolves(yes: boolean) {
    ownedSessions = yes;
  }

  beforeEach(() => {
    store.set("user_id", "user-a");
    sessionResolves(false);
  });

  it("⚠ runs no INSERT for a session that does not resolve for this account", async () => {
    await invoke("db:addMessage", { id: "m1", sessionId: "chat-of-user-b", role: "user", content: "hi" });

    expect(
      prepared.filter((sql) => sql.includes("INSERT INTO chat_messages")),
      "nothing may be written into another account's chat"
    ).toEqual([]);
  });

  it("asks the question with the account bound, not assumed", async () => {
    await invoke("db:addMessage", { id: "m1", sessionId: "chat-of-user-b", role: "user", content: "hi" });

    const lookup = prepared.find((sql) => sql.includes("FROM chat_sessions WHERE id = ?"));
    expect(lookup, "the ownership lookup must happen").toBeTruthy();
    expect(lookup).toContain("user_id IS ?");
  });

  /**
   * ⚠ THE REFUSAL IS INDISTINGUISHABLE FROM A WRITE. These channels are called on rows the renderer
   * believes it owns, so a throw would be a crash dialog for a stale UI — and a DIFFERENT return value
   * would be a probe for which session ids exist under the other accounts on this machine.
   */
  it("returns the caller's own object either way, and never throws", async () => {
    const message = { id: "m1", sessionId: "chat-of-user-b", role: "user", content: "hi" };

    const refused = await invoke("db:addMessage", message);
    sessionResolves(true);
    const written = await invoke("db:addMessage", message);

    expect(refused).toEqual(message);
    expect(written, "same shape, so a caller cannot tell them apart").toEqual(refused);
  });

  it("writes normally once the session is this account's own", async () => {
    // The predicate must not break the case it exists to permit.
    sessionResolves(true);

    await invoke("db:addMessage", { id: "m1", sessionId: "chat-of-user-a", role: "user", content: "hi" });

    const insert = prepared.find((sql) => sql.includes("INSERT INTO chat_messages"));
    expect(insert, "a legitimate write must still happen").toBeTruthy();
  });

  /**
   * ⚠ AND IT IS STILL STAMPED 'pending', because that is what makes a stopped turn visible as a gap
   * rather than silently untracked. Re-asserted here because the ownership gate sits directly above the
   * line that decides it, and a fix that returned early too eagerly would have removed the status.
   */
  it("still stamps a legitimate row 'pending' so the sweep can settle it", async () => {
    sessionResolves(true);

    await invoke("db:addMessage", { id: "m1", sessionId: "chat-of-user-a", role: "user", content: "hi" });

    const args = bound[bound.length - 1];
    expect(args, "sync_status is the last bound parameter").toContain("pending");
  });
});
