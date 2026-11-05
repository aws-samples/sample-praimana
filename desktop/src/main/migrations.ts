// SQLite schema migrations (EA-H5). Versioned via `PRAGMA user_version` so an
// auto-updating client can evolve its local schema forward safely instead of
// relying on `CREATE TABLE IF NOT EXISTS` (which can never add columns/constraints
// to an existing table). Migrations run in order; each bumps user_version.
//
// RULES:
//  - Never edit an existing migration once shipped — append a new one.
//  - Migrations must be idempotent-safe within their version step.
//  - `MIGRATIONS[i]` migrates the DB from version i to version i+1.

/** Minimal DB surface used here — matches better-sqlite3's Database. */
export interface MigratableDb {
  pragma(source: string): unknown;
  exec(sql: string): unknown;
}

// Migration 1: the original baseline schema (settings/projects/sessions/messages).
/**
 * ── ⚠ `chat_messages.input_tokens` / `output_tokens` HAVE ALWAYS EXISTED ──────────────────
 *
 * They are in the baseline below and nothing ever wrote to them — until the desktop app began showing the context or
 * tokens used for each AI conversation and each message. `saveMessage` now fills them from the CLI's own
 * `turn.completed`.
 *
 * ⚠ AND A MIGRATION TO ADD THEM WOULD HAVE BEEN A BUG. I wrote one before reading the baseline; it failed
 * every fresh database with `duplicate column name: input_tokens`, and the suite caught it at once because
 * these tests build the schema from the real MIGRATIONS list rather than from a fixture.
 *
 * ⚠ AND THE NOTE CANNOT LIVE INSIDE THE SQL. My first attempt put it in the template literal below, where the
 * BACKTICKS around `saveMessage` closed the template and the file stopped parsing — the same two-character
 * trap as the `*` before a `/` that once broke `tailwind.config.ts`. Prose about SQL goes above the SQL.
 *
 * NULL means "never counted", which is not 0: every row written before this, plus every turn from an assistant
 * that reports nothing (Claude's spawn path, Kiro). The UI renders nothing for NULL rather than a zero that
 * would understate a conversation while looking authoritative.
 */
const MIGRATION_1_BASELINE = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    workshop_id TEXT,
    team_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT,
    ai_provider TEXT NOT NULL DEFAULT 'claude',
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON chat_sessions(project_id, updated_at);
`;

// Migration 2: store the native Kiro ACP session id per chat so a restarted
// agent can resume its real conversation state via session/load (not a lossy
// transcript replay). Nullable — legacy rows and non-Kiro sessions leave it NULL.
const MIGRATION_2_ACP_SESSION_ID = `
  ALTER TABLE chat_sessions ADD COLUMN acp_session_id TEXT;
`;

// Migration 3: record when a chat was shared with the team (the "Share AI chat"
// feature). NULL = private (default). Set to an ISO timestamp when shared,
// cleared back to NULL on unshare. Lets the chat header show shared status
// instantly on load without a network round-trip.
const MIGRATION_3_SHARED_AT = `
  ALTER TABLE chat_sessions ADD COLUMN shared_at TEXT;
`;

// Migration 4: multi-user local login. Stores each account that has signed in on
// this machine (id = backend user id) so you can switch between them without
// re-entering credentials — used to test the team-sharing loop (log in as A,
// share, switch to B, see it as shared by A). The auth token is encrypted at
// rest (see database.ts encryptSecret). chat_sessions gains a user_id so each
// account only sees its own local chats; legacy rows (NULL) stay visible to all.
const MIGRATION_4_ACCOUNTS = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    server_url TEXT,
    auth_token TEXT,
    team_id TEXT,
    team_name TEXT,
    workshop_id TEXT,
    team_invite_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  ALTER TABLE chat_sessions ADD COLUMN user_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON chat_sessions(user_id, project_id, updated_at);
`;

// Migration 5: scope projects to the owning account too. Previously projects
// were shared across every account on the machine, so switching users still
// showed another user's projects (and, through them, their chats). Adding a
// user_id makes the whole local session — projects → chat_sessions → messages —
// user-specific. Legacy rows (NULL) are handled by strict query scoping.
const MIGRATION_5_PROJECT_USER = `
  ALTER TABLE projects ADD COLUMN user_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, created_at);
`;

// Migration 6: native Cognito auth. The session bearer is now the Cognito ID
// token (still stored in the `auth_token` setting/column), renewed with a
// long-lived Cognito refresh token. Store that refresh token per account —
// encrypted at rest, like auth_token — so switching to a saved account can renew
// its expired ID token without a full re-login. Legacy rows (NULL) simply can't
// auto-refresh and fall back to re-login, which is correct for pre-Cognito
// sessions that no longer have a valid token anyway.
const MIGRATION_6_COGNITO_REFRESH = `
  ALTER TABLE accounts ADD COLUMN cognito_refresh_token TEXT;
`;

// Migration 7: store the Claude Agent SDK's own session id per chat, so a turn
// after an app restart RESUMES the real conversation instead of starting a new one.
//
// `resumeId` lived only in an in-memory Map in claude-code.ts, so a restart — or a dev rebuild — emptied it.
// The next message opened a fresh SDK conversation with no history, and Claude answered a "retry" with "this
// is the first message I've received": true of the conversation it had, and baffling to a participant looking
// at a full transcript above it.
//
// Deliberately a SECOND column beside `acp_session_id` rather than a shared one.
// The two are different vendors' opaque ids used through different mechanisms
// (Kiro's `session/load` vs the SDK's `resume` option), and a session can only ever
// have one assistant — but sharing the column would mean a Kiro id could be handed
// to the SDK if a session's provider ever changed. Nullable: legacy rows, non-Claude
// sessions, and any chat whose first turn has not completed all leave it NULL.
const MIGRATION_7_SDK_SESSION_ID = `
  ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT;
`;

// Migration 8: scope each saved account to the PLATFORM it belongs to.
//
// The app no longer has one build-time backend. A participant can point it at a
// different platform (platform-config.ts), and each platform is a different Cognito
// pool — so a saved account is only meaningful against the platform it signed in to.
// Switching to an account from another pool would restore a bearer that 401s and a
// refresh token the new pool's token endpoint rejects, presenting a "signed in" app
// whose every request fails.
//
// `platform_url` is BACK-FILLED from the existing `server_url` column, which already
// held the API origin the account signed in against. That is the best available
// evidence and it is honest: for every row written before this migration it is
// exactly the value the session used.
//
// `config_fingerprint` is deliberately left NULL on back-fill rather than computed.
// The fingerprint covers the portal URL and the Cognito values, and NONE of those were
// recorded per-account before now — a value invented here would be a guess that the
// switch path then treats as authoritative. NULL means "unknown, allow and re-stamp
// on next sign-in", which is what `switchAccount` implements: refusing legacy rows
// would lock people out of accounts that work today.
const MIGRATION_8_ACCOUNT_PLATFORM = `
  ALTER TABLE accounts ADD COLUMN platform_url TEXT;
  ALTER TABLE accounts ADD COLUMN config_fingerprint TEXT;

  UPDATE accounts SET platform_url = server_url WHERE platform_url IS NULL;
`;

// Migration 9: one project per folder per user — and REPOINT the chats of any duplicate that
// already exists, rather than orphaning them.
//
// ⚠ THIS FIXES A REPORTED DATA-LOSS SYMPTOM, not a hypothetical. "Old chats gone missing" after a
// sign-in: a second `projects` row had been created for the same path, `db:getProjects` orders by
// `created_at DESC`, and App.tsx selects `[0]` — so the app loaded the NEW row and asked for its
// chats while nine of them hung off the older one. Nothing was deleted; everything was filtered.
//
// The three statements have to run in this order, and each is load-bearing:
//
//   1. REPOINT chat_sessions at the OLDEST row for each (path, user_id). Oldest, because that is
//      the row carrying the history — keeping the newest would preserve the empty one and discard
//      the reason anyone cares.
//   2. REPOINT projects' own dependents the same way. `chat_messages` follows its session, so it
//      needs nothing; `chat_sessions.project_id` is the only pointer.
//   3. DELETE the now-empty duplicates, then add the unique index. The index is created LAST
//      because it would refuse to build while duplicates remain — which is exactly the guarantee
//      wanted, but only after the data has been made to satisfy it.
//
// ⚠ THE INDEX USES COALESCE, because a legacy row can carry `user_id IS NULL` and SQLite treats
// every NULL as distinct in a unique index — so `(path, NULL)` would be insertable without limit
// and the constraint would not bind on the rows most likely to be duplicated.
const MIGRATION_9_PROJECT_PATH_UNIQUE = `
  UPDATE chat_sessions
     SET project_id = (
       SELECT keep.id FROM projects keep
        WHERE keep.path = (SELECT p.path FROM projects p WHERE p.id = chat_sessions.project_id)
          AND keep.user_id IS (SELECT p.user_id FROM projects p WHERE p.id = chat_sessions.project_id)
        ORDER BY keep.created_at
        LIMIT 1
     )
   WHERE project_id IN (
     SELECT dupe.id FROM projects dupe
      WHERE EXISTS (
        SELECT 1 FROM projects other
         WHERE other.path = dupe.path
           AND other.user_id IS dupe.user_id
           AND other.created_at < dupe.created_at
      )
   );

  DELETE FROM projects
   WHERE EXISTS (
     SELECT 1 FROM projects other
      WHERE other.path = projects.path
        AND other.user_id IS projects.user_id
        AND other.created_at < projects.created_at
   );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path_user
    ON projects(path, COALESCE(user_id, ''));
`;

// Migration 10: scope local work by EXPERIENCE as well as by user.
//
// ⚠ THE COLUMNS ALREADY EXISTED AND WERE DEAD. `projects.workshop_id` and `projects.team_id` have
// been in the schema since migration 1, are accepted by `db:addProject`, and were NEVER written
// (verified: every row NULL) and never queried. Dead columns that read as working scoping are worse
// than absent ones — anyone assuming "projects are tagged by experience" was wrong, and nothing
// failed to correct them. This migration makes them mean what they look like.
//
// ── ⚠ WHY EXISTING ROWS ARE BACK-FILLED AND NOT LEFT NULL ──
//
// A participant's chats predate this column. Filtering on `workshop_id = <current>` with those
// rows still NULL would hide every chat anyone has ever had — the EXACT symptom just reported
// ("old chats gone missing"), reintroduced by the fix for it. So legacy rows are stamped with the
// experience the install is currently in, which is the only experience they could have belonged
// to: this app has held one session at a time for its whole history.
//
// ⚠ AND THE QUERIES TREAT NULL AS VISIBLE ANYWAY (`workshop_id IS NULL OR workshop_id = ?`), so a
// row this back-fill cannot reach — an install with no `workshop_id` setting at the moment it
// upgrades — degrades to being shown rather than vanishing. Two independent protections against
// the same failure, because that failure is data a participant would experience as loss.
const MIGRATION_10_EXPERIENCE_SCOPE = `
  ALTER TABLE chat_sessions ADD COLUMN workshop_id TEXT;

  UPDATE projects
     SET workshop_id = (SELECT value FROM settings WHERE key = 'workshop_id')
   WHERE workshop_id IS NULL
     AND (SELECT value FROM settings WHERE key = 'workshop_id') IS NOT NULL
     AND (SELECT value FROM settings WHERE key = 'workshop_id') != '';

  UPDATE chat_sessions
     SET workshop_id = (SELECT p.workshop_id FROM projects p WHERE p.id = chat_sessions.project_id)
   WHERE workshop_id IS NULL;

  CREATE INDEX IF NOT EXISTS idx_projects_experience ON projects(user_id, workshop_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_experience
    ON chat_sessions(project_id, user_id, workshop_id, updated_at);
`;

/**
 * Migration 11: per-message SYNC STATE, so "did this reach the team's transcript?" is answerable
 * locally instead of inferred from a log line.
 *
 * ── ⚠ WHY THIS IS NOT BOOKKEEPING ──
 *
 * The desktop writes every message to SQLite immediately and pushes it to the server separately, and
 * without this nothing records whether the second half happened. Two sync failures show what that
 * costs. The sync read `auth_token` once and this pool expires ID tokens after **30 minutes**, so half
 * an hour into any session every push 401'd — and a stopped turn synced nothing at all, so the
 * participant's own question was missing from the portal while sitting in their local database. In both
 * cases the row was RIGHT HERE and no one could tell it had not travelled.
 *
 * ── THE THREE VALUES, AND WHY `NULL` IS A FOURTH ──
 *
 *   'pending'  written, not yet acknowledged by the server.
 *   'synced'   the server accepted it; `synced_at` says when.
 *   'failed'   a push was attempted and refused. Distinct from 'pending' because it means somebody
 *              should look, where 'pending' may simply be in flight.
 *
 * ⚠ LEGACY ROWS STAY `NULL`, WHICH MEANS "UNKNOWN" — deliberately not backfilled to either value.
 * Marking them 'synced' would assert something nobody verified, and 'pending' would invent a backlog of
 * every message ever sent and invite a retry storm across a 30-day history. A future retry sweep must
 * therefore select on `sync_status IN ('pending','failed')` and leave NULL alone.
 *
 * Indexed on (sync_status) filtered to the unfinished states: the only query this exists to serve is
 * "what has not made it?", and a partial index keeps it O(unsynced) rather than O(all messages).
 */
const MIGRATION_11_MESSAGE_SYNC = `
  ALTER TABLE chat_messages ADD COLUMN sync_status TEXT
    CHECK (sync_status IS NULL OR sync_status IN ('pending', 'synced', 'failed'));
  ALTER TABLE chat_messages ADD COLUMN synced_at TEXT;

  CREATE INDEX IF NOT EXISTS idx_messages_unsynced
    ON chat_messages(sync_status)
    WHERE sync_status IN ('pending', 'failed');
`;

/** Ordered list. Index i takes the schema from version i → i+1. */
/**
 * ── ⚠ THE CLI'S OWN THREAD ID, SO A CHAT SURVIVES A RESTART ────────────────────────────────
 *
 * Two faults produced that, and this column fixes both:
 *
 *   1. Whether a chat had already started lived in `sessionStarted`, a module-level object in the main
 *      process — so a RESTART emptied it, the next message was sent as turn one, and Codex opened a
 *      brand-new thread. The desktop still showed the old transcript (it reads SQLite), so the UI had the
 *      history and the CLI had none. That mismatch is what reads as amnesia.
 *   2. Even within one run, continuation used `codex exec resume --last`, which resumes the most recent
 *      thread IN THE DIRECTORY rather than the one belonging to the open chat. Two chats in one project
 *      could braid together.
 *
 * ⚠ ONE COLUMN FOR THE WHOLE SPAWN PATH, not for Codex alone. It holds whichever id the spawned CLI
 * announces for the conversation — Codex's `thread_id` from `thread.started`, Claude's `session_id` from
 * its `system` init event — because `cli-assistant.ts` launches all of them and asks one question of the
 * row: "does this chat already have a conversation to resume?"
 *
 * ⚠ NOT REUSING `acp_session_id` OR `sdk_session_id`. Those belong to the two other LAUNCHERS: Kiro's ACP
 * client reloads by the first (migration 2) and the Claude Agent SDK resumes by the second (migration 7).
 * Three launchers, three lifetimes — sharing a column would make "which kind of id is this?" depend on
 * which launcher last wrote the row, and a Codex thread id handed to `session/load` fails in a way nobody
 * would trace back to a schema decision.
 *
 * NULLABLE, and null is meaningful: "this chat has no CLI thread yet", which is exactly the question
 * `buildCliArgs` needs answered and the durable replacement for the in-memory flag.
 */
const MIGRATION_12_CLI_THREAD = `
  ALTER TABLE chat_sessions ADD COLUMN cli_thread_id TEXT;
`;

/**
 * ── ⚠ THE REST OF THE TOKEN BREAKDOWN ────────────────────────────────────────────────────
 *
 * `input_tokens` and `output_tokens` were already in the baseline. These two are the ones that make an
 * optimisation figure possible rather than guessable:
 *
 *   cached_input_tokens     — the part of the prompt served from cache instead of re-read. `cached / input`
 *                             IS the saving, measured. Without it, "50% savings" could only be an estimate
 *                             against a hypothetical.
 *   reasoning_output_tokens — the share of the reply spent thinking rather than answering, which is the other
 *                             lever a participant can move by asking a narrower question.
 *
 * ⚠ THIS ONE WAS CHECKED AGAINST THE BASELINE FIRST. The previous attempt to add token columns duplicated two
 * that had been there since migration 1 and failed every fresh database with `duplicate column name`. These
 * two do not exist anywhere in the list above.
 *
 * NULL means "not reported", which is not 0 — every existing row, and every turn from an assistant that
 * reports nothing (Claude's spawn path, Kiro).
 */
const MIGRATION_13_TOKEN_BREAKDOWN = `
  ALTER TABLE chat_messages ADD COLUMN cached_input_tokens INTEGER;
  ALTER TABLE chat_messages ADD COLUMN reasoning_output_tokens INTEGER;
`;

/**
 * ── ⚠ CACHE *WRITES*, WHICH ARE WHAT MAKE THE ANALYSIS ACTIONABLE ────────────────────────
 *
 * `cached_input_tokens` says how much was READ from cache. This says how much was WRITTEN to it, and the pair
 * is what separates a normal first turn (writes a lot, reads nothing — full price, unavoidable) from a
 * conversation throwing its cache away (keeps writing, never reads — a new thread per question, or gaps long
 * enough to expire it). With only the read figure both look the same, and the second is the one a participant
 * can actually fix.
 *
 * NULL means not reported, as with every other count.
 */
const MIGRATION_14_CACHE_WRITES = `
  ALTER TABLE chat_messages ADD COLUMN cache_write_input_tokens INTEGER;
`;

/**
 * ── ⚠ HOW FULL THE CONVERSATION WAS, WHICH IS A STATE AND NOT A COUNT ────────────────────
 *
 * It was missing because it never left the renderer. Kiro's `_kiro.dev/metadata` frame carries
 * `contextUsagePercentage`, the main process forwarded it to the UI, and `KiroChatView` held it in React
 * state — so it died with the component and nothing ever reached the server. This column is the first link
 * of the chain that carries it.
 *
 * ⚠ IT IS THE ONLY FIGURE HERE THAT MUST NEVER BE SUMMED. Every other number on this row is additive:
 * two turns of 500 tokens are 1,000 tokens. Two turns at 40% context are not 80% of anything — this is a
 * reading of how full the window was AT THAT TURN, so a rollup takes the LAST one, never a total or a mean.
 * `timing.ts` in the ai service enforces that; the column stores the per-turn reading it reads back.
 *
 * ⚠ AND IT IS NOT A TOKEN COUNT, which is why it is a column of its own rather than a sixth token field.
 * Kiro reports NO tokens at all (probed: kiro-cli 2.18.1 emits only `stopReason` at turn end), so
 * `input_tokens` and its siblings stay NULL for Kiro forever. Storing a percentage among them would invite
 * exactly the arithmetic the paragraph above forbids.
 *
 * NULL means "not reported", as with every other optional figure: every row before this, and every
 * assistant that does not publish one (Claude's spawn path, Codex).
 */
const MIGRATION_15_CONTEXT_USAGE = `
  ALTER TABLE chat_messages ADD COLUMN context_usage_percent INTEGER;
`;

export const MIGRATIONS: string[] = [
  MIGRATION_1_BASELINE,
  MIGRATION_2_ACP_SESSION_ID,
  MIGRATION_3_SHARED_AT,
  MIGRATION_4_ACCOUNTS,
  MIGRATION_5_PROJECT_USER,
  MIGRATION_6_COGNITO_REFRESH,
  MIGRATION_7_SDK_SESSION_ID,
  MIGRATION_8_ACCOUNT_PLATFORM,
  MIGRATION_9_PROJECT_PATH_UNIQUE,
  MIGRATION_10_EXPERIENCE_SCOPE,
  MIGRATION_11_MESSAGE_SYNC,
  MIGRATION_12_CLI_THREAD,
  MIGRATION_13_TOKEN_BREAKDOWN,
  MIGRATION_14_CACHE_WRITES,
  MIGRATION_15_CONTEXT_USAGE,
  // Future: append new migration SQL strings here. Do not modify the above.
];

export const LATEST_VERSION = MIGRATIONS.length;

/**
 * Apply any pending migrations. Reads `PRAGMA user_version`, runs each migration
 * from the current version up to LATEST_VERSION, and bumps the version after
 * each. Returns the resulting version. Safe to call on every startup.
 */
export function runMigrations(db: MigratableDb): number {
  const row = db.pragma("user_version") as Array<{ user_version: number }> | number;
  // better-sqlite3 returns [{ user_version: N }] for a read pragma.
  const current = Array.isArray(row) ? row[0]?.user_version ?? 0 : (row as number) ?? 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec(MIGRATIONS[version]);
    db.pragma(`user_version = ${version + 1}`);
  }

  return MIGRATIONS.length;
}
