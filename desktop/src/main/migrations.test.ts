import { describe, it, expect } from "vitest";
import { runMigrations, MIGRATIONS, LATEST_VERSION, type MigratableDb } from "./migrations";

// Fake DB implementing the minimal MigratableDb surface, so the migration
// runner is tested as pure logic without the native better-sqlite3 module
// (which is compiled for Electron's ABI, not the test runner's Node).
class FakeDb implements MigratableDb {
  version = 0;
  execCalls: string[] = [];

  pragma(source: string): unknown {
    const m = source.match(/^\s*user_version\s*=\s*(\d+)\s*$/);
    if (m) {
      this.version = Number(m[1]);
      return undefined;
    }
    if (source.trim() === "user_version") {
      return [{ user_version: this.version }];
    }
    return undefined;
  }

  exec(sql: string): unknown {
    this.execCalls.push(sql);
    return undefined;
  }
}

describe("runMigrations (EA-H5)", () => {
  it("migrates a fresh (v0) DB up to the latest version", () => {
    const db = new FakeDb();
    expect(runMigrations(db)).toBe(LATEST_VERSION);
    expect(db.version).toBe(LATEST_VERSION);
  });

  it("applies every migration exactly once on a fresh DB", () => {
    const db = new FakeDb();
    runMigrations(db);
    expect(db.execCalls).toHaveLength(MIGRATIONS.length);
    expect(db.execCalls[0]).toContain("CREATE TABLE IF NOT EXISTS settings");
  });

  it("adds the acp_session_id column for native Kiro resume", () => {
    const db = new FakeDb();
    runMigrations(db);
    const joined = db.execCalls.join("\n");
    expect(joined).toContain("ALTER TABLE chat_sessions ADD COLUMN acp_session_id");
  });

  it("adds the shared_at column for the share-with-team feature", () => {
    const db = new FakeDb();
    runMigrations(db);
    const joined = db.execCalls.join("\n");
    expect(joined).toContain("ALTER TABLE chat_sessions ADD COLUMN shared_at");
  });

  it("adds the accounts table and user_id column for multi-user local login", () => {
    const db = new FakeDb();
    runMigrations(db);
    const joined = db.execCalls.join("\n");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS accounts");
    expect(joined).toContain("ALTER TABLE chat_sessions ADD COLUMN user_id");
  });

  it("adds user_id to projects for per-user project scoping", () => {
    const db = new FakeDb();
    runMigrations(db);
    const joined = db.execCalls.join("\n");
    expect(joined).toContain("ALTER TABLE projects ADD COLUMN user_id");
  });

  it("⚠ adds sdk_session_id so a Claude chat RESUMES after a restart", () => {
    /**
     * `resumeId` lived only in an in-memory Map in claude-code.ts, which dies with the main process — so a
     * restart or a dev rebuild silently started a NEW SDK conversation while the renderer went on showing
     * the old transcript from SQLite. Nothing signalled that the assistant could no longer see any of it.
     *
     * This column is where the id survives, mirroring what `acp_session_id` already does for Kiro.
     */
    const db = new FakeDb();
    runMigrations(db);
    const joined = db.execCalls.join("\n");
    expect(joined).toContain("ALTER TABLE chat_sessions ADD COLUMN sdk_session_id");
  });

  it("keeps the SDK and Kiro resume ids in SEPARATE columns", () => {
    /**
     * They are different vendors' opaque ids consumed through different mechanisms — Kiro's `session/load`
     * against the SDK's `resume` option. A session only ever has one assistant, so ONE column would appear
     * to work; it would also mean a Kiro id could be handed to the SDK if a session's provider ever changed,
     * which fails in a way that looks like a corrupt conversation rather than a type error.
     */
    const db = new FakeDb();
    runMigrations(db);
    const joined = db.execCalls.join("\n");
    expect(joined).toContain("acp_session_id");
    expect(joined).toContain("sdk_session_id");
  });

  it("does not re-run migrations when already at latest (idempotent)", () => {
    const db = new FakeDb();
    runMigrations(db); // v0 -> latest
    db.execCalls = []; // reset spy
    const second = runMigrations(db);
    expect(second).toBe(LATEST_VERSION);
    expect(db.execCalls).toHaveLength(0); // nothing re-applied
  });

  it("only applies pending migrations when partially migrated", () => {
    const db = new FakeDb();
    db.version = LATEST_VERSION; // pretend fully migrated
    runMigrations(db);
    expect(db.execCalls).toHaveLength(0);
  });

  it("bumps user_version to exactly the migration count", () => {
    const db = new FakeDb();
    runMigrations(db);
    expect(db.version).toBe(MIGRATIONS.length);
  });

  describe("migration 8 — accounts are scoped to a platform", () => {
    /** Just migration 8's SQL, so an assertion cannot pass on some other migration. */
    const sql = MIGRATIONS[7];

    it("adds both columns a saved account needs to name its platform", () => {
      // The app can be pointed at a different platform now, and each is a different
      // Cognito pool — so a saved bearer/refresh token is only valid against one of them.
      expect(sql).toContain("ALTER TABLE accounts ADD COLUMN platform_url");
      expect(sql).toContain("ALTER TABLE accounts ADD COLUMN config_fingerprint");
    });

    it("BACK-FILLS platform_url from server_url, the only honest evidence available", () => {
      // `server_url` already held the API origin each account signed in against, so for
      // every pre-existing row it is exactly the value that session used.
      expect(sql).toMatch(/UPDATE accounts SET platform_url = server_url/);
    });

    /**
     * ⚠ THE FINGERPRINT IS DELIBERATELY LEFT NULL, and this test exists to stop someone
     * "completing" the back-fill later.
     *
     * The fingerprint covers the portal URL and the Cognito values, and NONE of those were
     * recorded per-account before this migration. A value invented here would be a guess
     * that `switchAccount` then treats as authoritative — so it would either refuse
     * accounts that are fine or accept ones that are not. NULL means "unknown, allow, and
     * re-stamp on next sign-in", which is what `switchAccount` and `upsertActiveAccount`
     * implement (see accounts.platform.test.ts).
     */
    it("does NOT invent a config_fingerprint for legacy rows", () => {
      expect(sql).not.toMatch(/SET config_fingerprint\s*=/);
      expect(sql).not.toMatch(/UPDATE accounts[\s\S]*config_fingerprint\s*=\s*['"]/);
    });

    it("is appended, not inserted — earlier migrations must never shift", () => {
      // MIGRATIONS[i] takes the schema from version i to i+1, so renumbering an existing
      // entry would silently re-run the wrong SQL on an already-migrated install.
      //
      // ⚠ THE COUNT IS MEANT TO CHANGE WHEN A MIGRATION IS ADDED — that is what makes this a
      // tripwire rather than noise. It fired on migration 11 (per-message sync status), which is the
      // check working: the fix is to confirm the new entry is at the END and bump the number, never
      // to loosen the assertion.
      expect(MIGRATIONS).toHaveLength(15);
      expect(MIGRATIONS[0]).toContain("CREATE TABLE IF NOT EXISTS settings");
      expect(MIGRATIONS[6]).toContain("sdk_session_id");
      expect(MIGRATIONS[10]).toContain("sync_status");
      /**
       * The identity of each recent entry, so an INSERT anywhere fails here too. Migration 12 adds
       * `cli_thread_id` — the CLI's own conversation id, which is what lets a chat survive a restart
       * instead of silently starting a new thread (reported for Codex).
       */
      expect(MIGRATIONS[11]).toContain("cli_thread_id");
      /**
       * Migration 13 adds the rest of the token breakdown — `cached_input_tokens` and
       * `reasoning_output_tokens`, which are what make a measured optimisation figure possible rather than a
       * guess. `input_tokens` / `output_tokens` are NOT here: they have been in the baseline all along, and an
       * earlier attempt to add them failed every fresh database with `duplicate column name`.
       */
      expect(MIGRATIONS[12]).toContain("cached_input_tokens");
      expect(MIGRATIONS[12]).toContain("reasoning_output_tokens");
      expect(
        MIGRATIONS[12],
        "input_tokens/output_tokens are in the baseline; re-adding them breaks every fresh install"
      ).not.toMatch(/ADD COLUMN input_tokens|ADD COLUMN output_tokens/);
      /**
       * Migration 14 adds `cache_write_input_tokens`. Paired with the READ figure from 13 it is what separates
       * a normal first turn from a conversation discarding its cache — the read figure alone cannot tell them
       * apart, and only the second is something a participant can act on.
       */
      expect(MIGRATIONS[13]).toContain("cache_write_input_tokens");
      /**
       * Migration 15 adds `context_usage_percent` — how full the assistant said its context window was at the
       * end of a turn. The portal showed no context-usage percentage for Kiro chats; it was
       * missing because the reading lived only in the desktop renderer's React state and no column, payload
       * or route carried it.
       *
       * ⚠ ASSERTED AS AN INTEGER COLUMN AND *NOT* AMONG THE TOKEN COLUMNS. It is a percentage — a reading of a
       * state at one instant — and everything named `*_tokens` beside it is additive and gets summed. A future
       * change that folded this in with them would produce "two 40% turns = 80% full", so the separation is
       * part of the schema's meaning rather than a naming preference.
       */
      expect(MIGRATIONS[14]).toContain("context_usage_percent");
      expect(
        MIGRATIONS[14],
        "a percentage must not arrive as a token column — it is never summed"
      ).not.toMatch(/_tokens/);
    });
  });

  /**
   * ── MIGRATION 9: THE ONE THAT RECOVERS DATA ──
   *
   * A reported symptom, not a theoretical one: "old chats gone missing" after a sign-in. A second
   * `projects` row existed for the same folder; `getProjects` orders by `created_at DESC` and
   * App.tsx selects `[0]`, so the app loaded the NEW row and asked for ITS chats while nine hung
   * off the older one. Nothing was deleted — everything was filtered.
   */
  describe("migration 9 — one project per folder, and the chats follow", () => {
    const sql = MIGRATIONS[8];

    it("REPOINTS chats before deleting anything", () => {
      /**
       * ⚠ ORDER IS THE WHOLE MIGRATION. Deleting duplicates first would orphan every chat that
       * pointed at them — turning a display bug into the data loss it only resembled.
       */
      const repointAt = sql.indexOf("UPDATE chat_sessions");
      const deleteAt = sql.indexOf("DELETE FROM projects");
      expect(repointAt).toBeGreaterThan(-1);
      expect(deleteAt).toBeGreaterThan(repointAt);
    });

    it("keeps the OLDEST row, which is the one carrying the history", () => {
      // Keeping the newest would preserve the empty duplicate and discard the reason anyone cares.
      expect(sql).toMatch(/ORDER BY keep\.created_at/);
      expect(sql).toMatch(/other\.created_at < dupe\.created_at/);
    });

    it("adds the unique index LAST, once the data can satisfy it", () => {
      // Created before the dedupe, it would refuse to build — which is the right guarantee, but
      // only after the rows have been made to comply.
      const indexAt = sql.indexOf("CREATE UNIQUE INDEX");
      expect(indexAt).toBeGreaterThan(sql.indexOf("DELETE FROM projects"));
      expect(sql).toContain("idx_projects_path_user");
    });

    /**
     * ⚠ COALESCE, NOT A BARE COLUMN. SQLite treats every NULL as distinct in a unique index, so
     * `(path, NULL)` would be insertable without limit — and legacy rows are exactly the ones
     * carrying a NULL user_id, i.e. the ones most likely to be duplicated.
     */
    it("makes the index bind on rows with a NULL user_id", () => {
      expect(sql).toMatch(/COALESCE\(user_id, ''\)/);
    });

    /**
     * ⚠ `IS`, NOT `=`. `NULL = NULL` is never true in SQL, so an `=` comparison would silently
     * skip every legacy row and leave the duplicates it was written to remove.
     */
    it("compares user_id with IS, so NULL matches NULL", () => {
      expect(sql).toMatch(/user_id IS/);
      expect(sql).not.toMatch(/user_id = dupe\.user_id/);
    });
  });

  /**
   * ── MIGRATION 10: SCOPING BY EXPERIENCE, WITHOUT LOSING ANYTHING ──
   *
   * `projects.workshop_id` and `projects.team_id` had been in the schema since migration 1, were
   * accepted by `db:addProject`, and were NEVER written or queried — verified against a real
   * database, every row NULL. Dead columns that read as working scoping are worse than absent ones.
   *
   * The risk in fixing that is reintroducing the bug it ships alongside: filter on
   * `workshop_id = <current>` while existing rows are NULL and EVERY chat disappears. Two
   * independent protections, and both are asserted here.
   */
  describe("migration 10 — experience scoping that cannot hide existing work", () => {
    const sql = MIGRATIONS[9];

    it("adds workshop_id to chat_sessions", () => {
      expect(sql).toContain("ALTER TABLE chat_sessions ADD COLUMN workshop_id");
    });

    /**
     * ⚠ PROTECTION ONE. Legacy rows are stamped with the experience the install is in — the only
     * one they could have belonged to, since this app has held one session at a time throughout its
     * history. Without this, scoping would hide every project and chat ever created.
     */
    it("BACK-FILLS existing rows from the current experience", () => {
      expect(sql).toMatch(/UPDATE projects[\s\S]*?SET workshop_id = \(SELECT value FROM settings/);
      expect(sql).toMatch(/WHERE workshop_id IS NULL/);
    });

    it("back-fills chats from their PROJECT, so the two agree", () => {
      // Reading the setting again could tag a chat with a different experience than its project if
      // the setting changed between the two statements.
      expect(sql).toMatch(/UPDATE chat_sessions[\s\S]*?SELECT p\.workshop_id FROM projects p/);
    });

    /**
     * ⚠ IT MUST NOT STAMP AN EMPTY EXPERIENCE. A user signed in but not yet on a team has no
     * `workshop_id`, and writing "" would tag rows with a value no live experience matches — making
     * them invisible under a strict filter and undoing the back-fill's whole purpose.
     */
    it("refuses to back-fill when there is no current experience", () => {
      expect(sql).toMatch(/IS NOT NULL/);
      expect(sql).toMatch(/!= ''/);
    });

    it("indexes what the scoped queries actually filter on", () => {
      expect(sql).toContain("idx_projects_experience");
      expect(sql).toContain("idx_sessions_experience");
    });
  });
});
