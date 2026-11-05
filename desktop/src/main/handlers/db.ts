import { ipcMain, app } from "electron";
import { getDb, readSetting, writeSetting } from "../database";
import { canRendererRead, canRendererWrite } from "../setting-access";
import { assertUserChosen } from "../project-paths";
import { SYNC_PENDING } from "../message-sync-status";
import { assertSafeRowId, isSafeRowId } from "../row-id";
import { activeUserId, activeExperience } from "../active-account";
import { isSessionOwnedByActiveAccount } from "../session-ownership";
import { recordSecurityEvent, redactedTarget } from "../security-audit";

/**
 * The experience this install is currently in, or null.
 *
 * ⚠ NULL IS A REAL AND SURVIVABLE STATE — a user signed in but not yet on a team has no
 * `workshop_id`. When it is null the scoping falls back to user-only rather than matching
 * `workshop_id = NULL` (which in SQL matches nothing), so an unscoped user still sees their work
 * instead of an empty app.
 *
 * ⚠ THE DEFINITION MOVED TO active-account.ts AND THIS IS NOW AN ALIAS. It was private to this file,
 * which is why the sync paths could not scope by it and published a previous workshop's transcripts
 * into a newly joined team. The local name is kept because five call
 * sites below read as "the experience these rows belong to" rather than "the active experience".
 */
const currentExperience = activeExperience;

export function setupDbHandlers() {
  // Projects — strictly scoped to the active local account, same as chats, so
  // switching users never surfaces another user's projects. No NULL fallback.
  ipcMain.handle("db:getProjects", async () => {
    const db = getDb();
    const userId = readSetting("active_user_id") || readSetting("user_id");
    if (!userId) return [];
    /**
     * ⚠ `workshop_id IS NULL OR workshop_id = ?` — NOT a bare equality.
     *
     * A strict match would hide every row written before experience scoping existed, which is
     * precisely the "old chats gone missing" symptom this scoping was added alongside. Migration 10
     * back-fills those rows, and this clause is the second, independent guarantee: a row the
     * back-fill could not reach is SHOWN rather than lost. Erring toward visible is right here —
     * seeing one extra project is a mild confusion, losing all of them is data loss.
     */
    const experience = currentExperience();
    if (!experience) {
      return db
        .prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC")
        .all(userId);
    }
    return db
      .prepare(
        "SELECT * FROM projects WHERE user_id = ? AND (workshop_id IS NULL OR workshop_id = ?) ORDER BY created_at DESC"
      )
      .all(userId, experience);
  });

  /**
   * Add a project, or REUSE the row that already describes this folder for this user.
   *
   * ── ⚠ WHY THIS IS AN UPSERT AND NOT AN INSERT ──
   *
   * Nine chats hung off the older row and were therefore invisible.
   *
   * The trigger was a fresh sign-in: `handleSwitchFolder` clears existing projects before adding
   * one, but `getProjects` is scoped to the ACTIVE USER, so while `active_user_id` was momentarily
   * unset that cleanup found nothing to remove and the insert created a rival row.
   *
   * The real defect is that nothing made a duplicate impossible. A path IS the identity of a
   * project — two rows for one folder are never two projects — so this now returns the existing
   * row's id instead of creating a second. Migration 9 adds the unique index that makes it
   * enforceable rather than merely intended.
   *
   * ⚠ IT RETURNS THE SURVIVING ROW'S ID, WHICH MAY NOT BE THE ONE PASSED IN. Callers must use the
   * returned project rather than the object they sent, or they will hold an id that no row has.
   */
  /**
   * ⚠ NO `workshopId`/`teamId` IN THE PARAMETER TYPE. They were accepted and preferred over the
   * settings; removing them from the signature is what stops the next caller from reintroducing the
   * mis-tag. The scoping columns are main's to decide — see the INSERT below.
   */
  ipcMain.handle("db:addProject", async (_event, project: { id: string; name: string; path: string }) => {
    /**
     * ⚠ PROVENANCE FIRST — this row is a BOUNDARY GRANT, not just a record.
     *
     * `allowedRoots()` reads every `projects.path`, so an insert here widens what the file,
     * git and spawn handlers will touch — and unlike the `project_path` setting it does so
     * PERSISTENTLY, surviving the restart that clears the in-memory picker set. An unchecked
     * insert was therefore the more durable half of the same hole: `addProject({ path:
     * "/Users/<you>" })` and every path check in the app is satisfied forever.
     *
     * Verified before the upsert, so a rejected path cannot reuse an existing row either.
     */
    /**
     * ⚠ ACT ON THE VALUE THE GATE RETURNED, not on the caller's spelling. Verifying
     * `path.resolve(x)` and then storing `x` lets the two diverge — the exact "verify one path, act on
     * another" shape picked-uploads.ts warns about. Not a boundary escape here (`allowedRoots()`
     * re-resolves), but alternate spellings of one folder defeat migration 9's unique index, which is
     * the thing that migration exists to guarantee.
     */
    const vouchedPath = assertUserChosen(project.path);
    project = { ...project, path: vouchedPath };

    const db = getDb();
    const userId = readSetting("active_user_id") || readSetting("user_id");

    /**
     * Matched on (path, user_id). `IS` rather than `=` for the user, because a legacy row can
     * carry NULL and `NULL = NULL` is never true in SQL — the case that would silently defeat
     * this whole guard for exactly the rows most likely to be duplicated.
     */
    const existing = db
      .prepare("SELECT * FROM projects WHERE path = ? AND user_id IS ? ORDER BY created_at LIMIT 1")
      .get(project.path, userId ?? null) as
      | { id: string; name: string; path: string }
      | undefined;

    if (existing) {
      // The OLDEST match wins, so the row carrying the longest history is the one kept.
      return { ...project, id: existing.id, name: existing.name, path: existing.path };
    }

    /**
     * The experience and team are read from SETTINGS rather than taken from the caller.
     *
     * The renderer passed them optionally and never actually did, which is why both columns sat
     * NULL for the app's whole history. Reading them here means a project is tagged correctly
     * without every call site having to remember to — and a renderer cannot mis-tag its work as
     * belonging to an experience it is not in.
     *
     * ── ⚠ AND IT NOW DOES WHAT THAT PARAGRAPH SAYS ────────────────────────────────────────────
     *
     * The bindings were `project.workshopId ?? currentExperience()` and `project.teamId ??
     * readSetting("team_id")` — i.e. the caller's value was PREFERRED and the settings were only a fallback,
     * which is the exact opposite of the sentence above. The preload bridge forwarded both fields verbatim.
     *
     * ⚠ WHY A MIS-TAG MATTERED, given a projects row is a filesystem-confinement grant
     * (`allowedRoots`): a row inserted with `workshopId: "no-such-workshop"` stayed INSIDE the
     * boundary for ever while being invisible to `db:getProjects` — which filters
     * `workshop_id IS NULL OR workshop_id = ?` — so it was also absent from the list the
     * folder-switch handler walks, and could never be revoked from the UI, because the UI only ever
     * passes ids that `db:getProjects` returned.
     *
     * `assertUserChosen(project.path)` bounds this to folders that came back from a native dialog in
     * this session, so it was never arbitrary-path access. But `userChosenPaths` is additive and
     * never cleared, so after the user switched away from a folder — deleting its visible row —
     * renderer-resident code could re-insert it under a bogus tag and silently keep read/write/git/
     * agent access to the folder they believe they left, across restarts.
     */
    db.prepare(
      "INSERT INTO projects (id, name, path, workshop_id, team_id, user_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      project.id,
      project.name,
      project.path,
      currentExperience(),
      readSetting("team_id") ?? null,
      userId ?? null
    );
    /**
     * ── ⚠ RECORDED, BECAUSE THIS ROW IS THE BOUNDARY ──────────────────────────────────────────
     *
     * The provenance comment above already calls this row a BOUNDARY GRANT that widens what the file, git and
     * spawn handlers will touch, PERSISTENTLY — and nothing recorded it. This file did not even import
     * `recordSecurityEvent`, so "who widened the confinement fence, and when" had no local answer at all,
     * while `file.mutate` diligently recorded every write that grant then permitted.
     *
     * ⚠ AFTER THE INSERT, NOT BEFORE, and only on the path that actually inserts. The early return for
     * an existing row grants nothing new — the boundary already included that path — so recording it
     * would report a widening that did not happen, and on a fresh launch of a returning user that is
     * most of the traffic through here.
     *
     * ⚠ THE BASENAME ONLY, via `redactedTarget`. A full project path is a person's name, their
     * employer's and their client's in one string, and this log is plaintext — the rule the module
     * states for every other path it records.
     */
    recordSecurityEvent({
      event: "project.grant",
      outcome: "success",
      userId: userId ?? undefined,
      detail: `add:${redactedTarget(project.path)}`,
    });
    return project;
  });

  ipcMain.handle("db:removeProject", async (_event, id: string) => {
    const db = getDb();
    /**
     * ⚠ SCOPED TO THE ACTIVE ACCOUNT, like every other projects query in this file.
     *
     * It was a bare `WHERE id = ?`, so one row's worth of cross-account deletion was reachable while
     * `db:getProjects` and `db:getSessions` were strictly per-user by deliberate design. Small, but an
     * inconsistent scoping model is how the next query gets written the looser way.
     *
     * `IS` rather than `=` for the user, for the same reason `db:addProject` uses it: a legacy row can
     * carry NULL and `NULL = NULL` is never true in SQL, which would make this silently delete nothing
     * for exactly the oldest rows.
     */
    const userId = readSetting("active_user_id") || readSetting("user_id");
    db.prepare("DELETE FROM projects WHERE id = ? AND user_id IS ?").run(id, userId ?? null);
  });

  // Chat Sessions — strictly scoped to the active local account so switching
  // users only ever shows that user's own chats. There is intentionally no
  // "user_id IS NULL" fallback: an unowned chat would otherwise leak into every
  // account on this machine.
  ipcMain.handle("db:getSessions", async (_event, projectId: string) => {
    const db = getDb();
    const userId = readSetting("active_user_id") || readSetting("user_id");
    if (!userId) return [];
    // Same NULL-is-visible rule as projects, for the same reason — see db:getProjects.
    const experience = currentExperience();
    if (!experience) {
      return db
        .prepare(
          "SELECT * FROM chat_sessions WHERE project_id = ? AND user_id = ? ORDER BY updated_at DESC"
        )
        .all(projectId, userId);
    }
    return db
      .prepare(
        "SELECT * FROM chat_sessions WHERE project_id = ? AND user_id = ? AND (workshop_id IS NULL OR workshop_id = ?) ORDER BY updated_at DESC"
      )
      .all(projectId, userId, experience);
  });

  ipcMain.handle("db:createSession", async (_event, session: { id: string; projectId: string; title?: string; aiProvider?: string; model?: string }) => {
    const db = getDb();
    /**
     * ⚠ THE ID IS VALIDATED HERE, AT THE ONLY PLACE IT ENTERS. The renderer chooses it (a
     * `crypto.randomUUID()`), and this row id is later reused verbatim as the SERVER's thread id in
     * `/v1/ai/threads/${sessionId}/sync` and `/v1/ai/teams/${teamId}/threads/${sessionId}/share`.
     * A path-shaped id stored here is an authenticated request against an endpoint the desktop never
     * meant to bridge — see row-id.ts. Refusing at the door means no later reader has to wonder.
     */
    assertSafeRowId(session?.id, "chat");
    const userId = activeUserId();
    db.prepare(
      "INSERT INTO chat_sessions (id, project_id, title, ai_provider, model, user_id, workshop_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      session.id,
      session.projectId,
      session.title ?? null,
      session.aiProvider ?? "claude",
      session.model ?? null,
      userId ?? null,
      // Stamped at CREATION, so a chat stays with the experience it was had in even if the user
      // later joins another. A chat is a record of work, not a live pointer.
      currentExperience()
    );
    return session;
  });

  /**
   * ── ⚠ THE OWNER PREDICATE IS THE AUTHORIZATION, NOT THE CALLER'S WORD ────────────────────────
   *
   * `db:deleteSession`, `db:setSessionShared` and `db:getMessages` each took a row id from the renderer and
   * used it alone, while their siblings two functions up (`db:getSessions`, `db:removeProject`) bind the
   * active account and say in a comment why. So account B could read, forge the shared flag on, or destroy
   * account A's chat on the same machine — and multi-account switching on one profile is a first-class
   * feature here.
   *
   * ⚠ `user_id IS ?` RATHER THAN `= ?`, matching `db:removeProject`. A row written before the column
   * existed carries NULL, and `NULL = NULL` is never true in SQL — with `=` these statements would
   * silently affect nothing for exactly the oldest rows, which reads as "delete doesn't work".
   *
   * ⚠ AND A MISS IS SILENT, not an error. These channels are called on rows the renderer believes it
   * owns; a thrown error would surface as a crash dialog for what is either a stale UI or an attack,
   * and neither deserves one. The row simply is not there.
   */
  ipcMain.handle("db:deleteSession", async (_event, id: string) => {
    const db = getDb();
    db.prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id IS ?").run(id, activeUserId());
  });

  // Record/clear a chat's shared-with-team state locally (mirrors the server
  // flag) so the header can show shared status without a network round-trip.
  ipcMain.handle("db:setSessionShared", async (_event, id: string, sharedAt: string | null) => {
    const db = getDb();
    db.prepare("UPDATE chat_sessions SET shared_at = ? WHERE id = ? AND user_id IS ?").run(
      sharedAt,
      id,
      activeUserId()
    );
  });

  // Messages
  ipcMain.handle("db:getMessages", async (_event, sessionId: string) => {
    const db = getDb();
    /**
     * ⚠ JOINED TO `chat_sessions` PURELY FOR THE PREDICATE. `chat_messages` carries no `user_id` of
     * its own — the session owns the account — so the only way to scope a transcript read is through
     * its session. `m.*` keeps the returned shape identical to the unscoped version this replaced.
     *
     * ⚠ STILL RETURNS A BARE ARRAY, and still reads the WHOLE transcript. Pagination and the
     * incremental tail are SEPARATE channels (`db:getMessagesPage`, `db:getMessagesSince`) so this
     * one's many callers — both `loadMessages`, the retry refresh, the test fakes — keep working
     * unchanged. The two new channels own the bounded reads; see below.
     */
    return db
      .prepare(
        `SELECT m.* FROM chat_messages m
           JOIN chat_sessions s ON s.id = m.session_id
          WHERE m.session_id = ? AND s.user_id IS ?
          ORDER BY m.created_at ASC`
      )
      .all(sessionId, activeUserId());
  });

  /**
   * ── OWN-CHAT PAGINATION, LOCAL-SQLITE TWIN OF THE SHARED-CHAT SERVER ROUTE ──────────────────
   *
   * Your own transcript lives in local SQLite, so these are LIMIT/range queries rather than HTTP
   * calls — but the renderer drives them identically to the shared chat (5-per-page scroll-up, no
   * auto-scroll, incremental tail on refresh), so the two chats behave the same.
   *
   * One NEWEST-FIRST page of ≤ `limit` rows older than `before` (omit `before` for the newest page),
   * returned ASCENDING with a `nextBefore` cursor for the next older page (null at the thread start).
   */
  ipcMain.handle(
    "db:getMessagesPage",
    async (_event, sessionId: string, opts: { limit: number; before?: string }) => {
      const db = getDb();
      const me = activeUserId();
      const limit = Math.min(100, Math.max(1, Math.floor(opts?.limit ?? 5)));
      const params: unknown[] = [sessionId, me];
      let where = `m.session_id = ? AND s.user_id IS ?`;
      if (opts?.before) {
        where += ` AND m.created_at < ?`;
        params.push(opts.before);
      }
      const newestFirst = db
        .prepare(
          `SELECT m.* FROM chat_messages m
             JOIN chat_sessions s ON s.id = m.session_id
            WHERE ${where}
            ORDER BY m.created_at DESC
            LIMIT ?`
        )
        .all(...params, limit) as Array<{ created_at: string }>;
      const messages = [...newestFirst].reverse();
      const nextBefore =
        newestFirst.length === limit && messages.length > 0
          ? (messages[0] as { created_at: string }).created_at
          : null;
      return { messages, nextBefore };
    }
  );

  /** Rows NEWER than `since` (a `created_at`), ascending — the live-tail append for the own chat. */
  ipcMain.handle(
    "db:getMessagesSince",
    async (_event, sessionId: string, since: string) => {
      const db = getDb();
      const messages = db
        .prepare(
          `SELECT m.* FROM chat_messages m
             JOIN chat_sessions s ON s.id = m.session_id
            WHERE m.session_id = ? AND s.user_id IS ? AND m.created_at > ?
            ORDER BY m.created_at ASC`
        )
        .all(sessionId, activeUserId(), since);
      return { messages };
    }
  );

  /**
   * ── THE APP'S OWN VERSION ────────────────────────────────────────────────────────────
   *
   * ⚠ THERE WAS NO WAY FOR THE RENDERER TO KNOW IT. `app.getVersion()` was called in exactly one
   * place — `telemetry.ts`, to stamp a diagnostic — and no IPC channel exposed it. So the UI could not
   * have shown a version even if a row existed for it, which is why "add it to Settings" is two changes
   * rather than one.
   *
   * ⚠ ONE SOURCE, AND IT IS `package.json`. Electron reads the version from there for both a packaged
   * build and `pnpm dev`, and electron-builder puts the same value in the installer name
   * (`Praimana-<version>.dmg`, which the download service serves). So what Settings
   * shows, what the installer is called and what telemetry stamps cannot disagree — a hardcoded string
   * here would be a fourth version to forget to bump.
   */
  ipcMain.handle("app:getVersion", async () => ({ version: app.getVersion() }));

  /**
   * Retry one message's sync, from the indicator in its own bubble.
   *
   * ⚠ REGISTERED HERE, WITH THE OTHER MESSAGE CHANNELS, rather than in cli-sync — that module has no
   * `ipcMain` surface and giving it one would make a transcript writer also an IPC boundary. The work
   * itself stays in cli-sync, which owns the push.
   */
  ipcMain.handle("sync:retryMessage", async (_event, messageId: string) => {
    /**
     * ⚠ THE SHAPE CHECK IS NOT THE AUTHORIZATION. Any renderer code can name any message id here;
     * what stops it reaching another account's turn is the account predicate inside
     * `loadTurnForRetry` (message-sync-status.ts), not this. The check is here so a path-shaped id
     * cannot be forwarded to `/v1/ai/threads/${sessionId}/sync` — see row-id.ts.
     */
    if (!isSafeRowId(messageId)) return { retried: false };
    const { retryMessageSync } = await import("./cli-sync");
    return retryMessageSync(messageId);
  });

  ipcMain.handle("db:addMessage", async (_event, message: { id: string; sessionId: string; role: string; content: string }) => {
    const db = getDb();
    // Same reason as `db:createSession`: both ids reach an authenticated URL path. See row-id.ts.
    assertSafeRowId(message?.id, "message");
    assertSafeRowId(message?.sessionId, "chat");
    /**
     * ⚠ WRITTEN AS 'pending', NOT SILENTLY UNTRACKED. This is the participant's OWN message, inserted
     * from the renderer before the turn is sent, and it is the row that went missing from the portal
     * when a turn was stopped: present locally, never pushed, nothing recording the difference. A
     * 'system' row is local-only by nature, so it stays NULL (unknown) rather than claiming to be
     * waiting for a server that will never be told about it.
     */
    const syncStatus = message.role === "user" || message.role === "assistant" ? SYNC_PENDING : null;
    /**
     * ── ⚠ THE SESSION MUST BELONG TO THIS ACCOUNT BEFORE A ROW GOES INTO IT ──────────────────
     *
     * The two `assertSafeRowId` calls above check SHAPE and say so; neither asks whose session this is. Every
     * sibling operation on this table binds the account — `db:getMessages` joins for it, `db:deleteSession`
     * and `db:setSessionShared` bind it directly, and the comment at the head of those three records that
     * they were fixed after review found this exact omission. This channel was the write that was missed.
     *
     * ⚠ AND THE PLANTED ROW DOES NOT JUST SIT THERE, which is what makes it worth more than a tidy-up.
     * It is stamped `pending`, and the background sweep selects pending rows scoped to the SESSION's
     * owner (sync-sweep.ts) — so a row inserted under another local account's session is pushed to
     * THAT account's team thread, under THAT account's bearer, the next time they are active, and
     * renders in their local history as their own conversation.
     *
     * ⚠ SILENT ON A MISS, matching the three siblings: these channels are called on rows the renderer
     * believes it owns, so a throw would be a crash dialog for what is either a stale UI or an attack.
     * The caller gets its own object back, exactly as it does on success — a refusal must not be
     * distinguishable from a write, or this becomes a probe for which sessions exist.
     */
    if (!isSessionOwnedByActiveAccount(message.sessionId)) return message;
    db.prepare(
      "INSERT INTO chat_messages (id, session_id, role, content, sync_status) VALUES (?, ?, ?, ?, ?)"
    ).run(message.id, message.sessionId, message.role, message.content, syncStatus);
    return message;
  });

  // Settings (sensitive keys encrypted at rest — see database.ts).
  //
  // DENY BY DEFAULT. These two channels are the
  // renderer's only door into the settings table, and `readSetting` decrypts the
  // sensitive keys, so an unfiltered `db:getSetting` handed a live 30-day Cognito
  // refresh token to anything running in the renderer bundle. The allowlists live
  // in ../setting-access; `readSetting` is not called at all for a blocked key.
  ipcMain.handle("db:getSetting", async (_event, key: string) => {
    if (!canRendererRead(key)) {
      // Return null, not an error: a caller must not be able to tell "forbidden"
      // from "not set". Log the key (keys aren't secrets) but never the value.
      console.warn(`[db] blocked renderer read of setting "${key}" (not on the read allowlist)`);
      return null;
    }
    return readSetting(key);
  });

  ipcMain.handle("db:setSetting", async (_event, key: string, value: string) => {
    // Writes are silently dropped rather than thrown so a rejected write can't be
    // used as an oracle either, and so a stray call can't crash the renderer. The
    // credential keys are not writable at any value — clearing them is
    // `auth:signOut`'s job (handlers/ai.ts), not the renderer's.
    if (!canRendererWrite(key)) {
      console.warn(`[db] blocked renderer write of setting "${key}" (not on the write allowlist)`);
      return;
    }
    writeSetting(key, value);
  });
}
