// ── ⚠ THE OTHER HALF OF THE SYNC FEATURE ─────────────────────────────────────────────────
//
// Backlog 8f. Every message carries a sync status and a retry button, and until now the button was the
// ONLY way a failed push was ever re-attempted: one message, one click, by a human who noticed.
//
// ⚠ THE SCENARIO THIS EXISTS FOR IS THE ONE THAT ACTUALLY HAPPENED. This pool's ID tokens last 30
// minutes. A participant works through a session, the token expires, and every turn pushed after that
// fails — the transcripts are written locally and marked `failed`, and the portal shows a conversation
// that stops mid-afternoon. That was the original report ("HTTP 401 … may be session is timed out").
// The token comes back on the next sign-in, and at that moment the machine knows exactly which turns
// it owes the server and can settle them without being asked. `countUnsyncedMessages` and the partial
// index `idx_messages_unsynced` were both built for this sweep and had no caller.
//
// ── WHAT MAKES THIS SAFE TO RUN UNATTENDED ──
//
// ⚠ IDEMPOTENT BY CONSTRUCTION, NOT BY CARE. It reuses `retryMessageSync`, so a swept turn takes the
// identical path as the button: `clientTurnId` is the assistant row's id and the AI service derives
// message ids from it, so a re-push OVERWRITES rather than appending. A turn that was actually stored
// before the failure was recorded converges instead of duplicating.
//
// ⚠ BOUNDED, and every bound is here rather than implied: how many turns per sweep, how long between
// attempts, how many consecutive failures before it stops, and how old a row must be to qualify. An
// unbounded sweep over a 30-day history on a cold network is a self-inflicted retry storm.
//
// ⚠ IT SHEDS LOAD OBSERVABLY. When more turns remain than the cap allows, or the breaker trips, it
// says so — `debugLog` plus the returned summary. A sweep that silently stops halfway reads as "all
// synced" to the next person who looks.
//
// ⚠ NO TOKEN LOGIC OF ITS OWN. `retryMessageSync` → `syncCliTurn` → `authedFetch` → `fetchAuthed`,
// which is main's single token authority and already refreshes and broadcasts `auth:expired`. A sweep
// that fetched its own bearer would be the second refresh authority the design
// forbids.

import { getDb, readSetting } from "./database";
import { activeUserId, activeExperience } from "./active-account";
import { teamAccessVerdict, teamAccessReasonText } from "./team-access-state";
import { debugLog } from "./debug-log";
import { isSessionUsable } from "./session-liveness";
import {
  SYNC_FAILED,
  SYNC_PENDING,
  SYNC_SYNCED,
  countUnsyncedMessages,
  readSyncStatus,
} from "./message-sync-status";

/**
 * How many TURNS one sweep will attempt.
 *
 * A workshop session is tens of turns, not thousands, so this clears a realistic backlog in one pass
 * while putting a hard ceiling on the work a single trigger can cause. What is left over is reported
 * and picked up by the next sweep rather than pushed now.
 */
const MAX_TURNS_PER_SWEEP = 25;

/**
 * Spacing between attempts.
 *
 * ⚠ SEQUENTIAL WITH A GAP, NOT A FAN-OUT. Twenty-five simultaneous pushes on the network that just
 * came back is precisely the burst that gets throttled, and each push is itself two or three requests
 * (thread probe, maybe a create, then the sync). Paced, the whole backlog costs a few seconds of
 * background time and looks like ordinary traffic.
 */
const GAP_MS = 250;

/**
 * Consecutive failures before the sweep gives up.
 *
 * ⚠ THE BREAKER IS THE POINT, NOT AN OPTIMISATION. The most likely reason a push fails is that the
 * session is not actually usable — a revoked refresh token, the wrong platform, no network. Under
 * those conditions every attempt fails, and each failure re-stamps rows `failed`, so a sweep without
 * a breaker would walk the whole backlog to no effect and hammer a dead endpoint doing it. Three in a
 * row is enough to conclude the problem is not this turn.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How settled a row must be before the sweep touches it.
 *
 * ⚠ THIS IS A RACE GUARD, and without it the sweep can collide with a turn still being pushed by the
 * handler that created it — the row is `pending` for the whole round trip. The push is idempotent, so
 * a collision would not corrupt anything, but it would double the traffic for every live turn and
 * could mark a row `failed` from a duplicate attempt while the original was still in flight. Two
 * minutes is far longer than a sync takes and far shorter than a participant's patience.
 */
const MIN_AGE_MS = 2 * 60 * 1000;

export interface SweepSummary {
  /** Turns attempted in this pass. */
  attempted: number;
  /** Attempts whose row came back `synced`. */
  recovered: number;
  /** Attempts that did not. */
  failed: number;
  /** Rows still unsynced when the sweep finished — the number to report, not to hide. */
  remaining: number;
  /** True when the breaker stopped the pass early. */
  gaveUp: boolean;
}

/** One sweep at a time. A second trigger while one runs is dropped, not queued. */
let running = false;

/**
 * Ids of unsynced rows worth attempting, oldest first.
 *
 * ⚠ ORDERED OLDEST-FIRST ON PURPOSE: the oldest gap is the one a reader notices, and it is also the
 * one most likely to be past `MIN_AGE_MS`. `sync_status IS NULL` is excluded for the same reason
 * `countUnsyncedMessages` excludes it — NULL means "written before this column existed", i.e. unknown,
 * and sweeping those would re-push a 30-day history.
 */
function unsyncedRowIds(limit: number): string[] {
  /**
   * ── ⚠ SCOPED TO THE ACTIVE LOCAL ACCOUNT ────────────────────────────────────────────────────
   *
   * This is the half of that finding with NO ATTACKER IN IT.
   *
   * The sweep is scheduled at startup and immediately after a session is adopted, and it pushed every
   * unsynced row on the machine with the newly signed-in account's bearer, creating threads under that
   * account's team. So on a shared laptop where account B has turns left `failed` — the exact scenario
   * this sweep was written for, an expired token — account A merely SIGNING IN published B's private
   * conversations to A's team. No IPC call, no hostile dependency, just the feature working as written.
   *
   * The status and age filters were already right; the account predicate was the only thing missing.
   */
  /**
   * ⚠ THE CUTOFF IS COMPUTED BY SQLITE, NOT BY JAVASCRIPT. `created_at` is written by
   * `datetime('now')` — UTC, `YYYY-MM-DD HH:MM:SS` — so a JS-built cutoff has to reproduce that
   * format AND agree with SQLite about the current time. Both are avoidable: `datetime('now', ?)`
   * uses the same clock and the same format as the column it is compared with, so the comparison
   * cannot be wrong for a formatting reason. The modifier is derived from the one constant.
   */
  const modifier = `-${Math.round(MIN_AGE_MS / 1000)} seconds`;
  const rows = getDb()
    .prepare(
      /**
       * ⚠ JOINED FOR THE PREDICATE ONLY. `chat_messages` carries no account of its own — the session
       * owns it — so scoping a turn means reaching through `chat_sessions`. `s.user_id IS ?` rather
       * than `= ?` because a legacy session carries NULL, and with `=` the sweep would silently stop
       * settling exactly the oldest backlog it exists to clear.
       */
      /**
       * ── ⚠ AND SCOPED TO THE EXPERIENCE THE TURN WAS RECORDED IN ─────────────────────────────
       *
       * THE SECOND HALF WITH NO ATTACKER IN IT, and the more serious one.
       *
       * The account predicate above stopped one local account publishing another's turns. It did
       * nothing about the SAME account crossing a TENANT boundary, because the push reads the
       * CURRENT `team_id` at push time (handlers/cli-sync.ts) while these rows carry the workshop
       * they were recorded in. So a participant who left workshop A with turns still `pending` or
       * `failed` — the exact backlog this sweep exists to clear — and then joined team B had team A's
       * private AI transcripts filed into team B's thread store on the next launch. No IPC call, no
       * hostile dependency, no prompt: the feature working as written, on a normal user journey.
       *
       * ⚠ THE COLUMN WAS ALREADY THERE FOR THIS. `db:createSession` stamps `workshop_id` at creation
       * "so a chat stays with the experience it was had in even if the user later joins another"
       * (handlers/db.ts), and every READ path honours it (`db:getSessions`, `db:getProjects`). This
       * was the one place that read the session and ignored the stamp.
       *
       * ⚠ `IS ?` RATHER THAN `= ?`, AND IT CARRIES THE NULL CASE ON PURPOSE. With the experience
       * bound to null — signed in, not on a team — the clause collapses to "workshop_id IS NULL"
       * twice over, i.e. only rows whose OWN provenance is unknown are eligible. That is the safe
       * reading of "nowhere to publish to": never a row stamped with a real workshop.
       *
       * ⚠ A ROW EXCLUDED HERE IS DEFERRED, NOT DROPPED. It keeps its `pending`/`failed` status and is
       * swept the moment its own experience is current again. Erring toward NOT PUBLISHING is the
       * opposite of the read paths' bias, and deliberately so: a read showing one extra project is a
       * mild confusion, a push into the wrong tenant is a disclosure that cannot be taken back.
       */
      `SELECT m.id FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
        WHERE m.sync_status IN (?, ?)
          AND m.created_at <= datetime('now', ?)
          AND s.user_id IS ?
          AND (s.workshop_id IS NULL OR s.workshop_id IS ?)
        ORDER BY m.created_at ASC
        LIMIT ?`
    )
    .all(
      SYNC_PENDING,
      SYNC_FAILED,
      modifier,
      activeUserId(),
      activeExperience(),
      limit
    ) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Re-push every turn this machine still owes the server.
 *
 * Never throws: it is called from startup and from sign-in, and a failed sweep must not fail either.
 */
export async function sweepUnsyncedTurns(
  /** Injected in tests. Production passes nothing and gets the real retry. */
  deps?: {
    retry?: (messageId: string) => Promise<{ retried: boolean; status?: string }>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<SweepSummary> {
  const empty: SweepSummary = {
    attempted: 0,
    recovered: 0,
    failed: 0,
    remaining: 0,
    gaveUp: false,
  };

  if (running) {
    debugLog("[sync-sweep] already running — this trigger is dropped");
    return empty;
  }
  running = true;

  try {
    // Cheapest possible exit, and the common one: nothing is owed.
    if (countUnsyncedMessages(activeUserId(), activeExperience()) === 0) return empty;

    /**
     * ── ⚠ NO SESSION, NO SWEEP ────────────────────────────────────────────────────────────
     *
     * That is this function. `scheduleSweep("startup")` fires 5 seconds after launch with no
     * preconditions at all, so on a machine that owes the server some turns it pushed them while the
     * user was sitting on the SIGN-IN screen — and every failure came back as a red
     * "Couldn't sync to the server" toast over a login form, describing work the reader cannot act on
     * and had not asked for.
     *
     * The module header says this function has "NO TOKEN LOGIC OF ITS OWN", and that is still true:
     * this is not token logic, it is a PRECONDITION. There is no point attempting a team-scoped push
     * when the app is not signed in or not on a team — `fetchAuthed` would throw "Not logged in" for
     * each turn in turn, marking rows failed and raising one toast per turn for a condition that
     * resolves itself the moment somebody signs in.
     *
     * ⚠ AND THE ROWS ARE LEFT ALONE. Skipping is not failing: nothing is marked, nothing is retried,
     * `remaining` still reports the debt. `scheduleSweep("session-adopted")` runs at sign-in, which is
     * exactly when the backlog CAN be settled — so the work is deferred to the moment it can succeed
     * rather than burned now.
     */
    /**
     * ⚠ AND DO NOT PUSH AT A TEAM ALREADY KNOWN TO REFUSE.
     *
     * Two turns attempted on every launch, both refused, and they cannot succeed until the team problem is
     * fixed — so every one of those requests was waste, repeated on every start.
     *
     * The information already existed: the startup probe logs `team:checkAccess: the service refused
     * this team (HTTP 403)` SECONDS BEFORE this sweep runs. It simply had no way to reach here, because
     * `retryMessageSync` returns `{ retried, status }` with no HTTP status and no reason. team-access-state
     * is that channel.
     *
     * Keyed by team id, so re-joining is self-healing: a verdict about the old team does not apply to the
     * new one, and the sweep resumes with nothing to clear.
     */
    const currentTeam = readSetting("team_id");
    if (teamAccessVerdict(currentTeam) === "unreadable") {
      const remaining = countUnsyncedMessages(activeUserId(), activeExperience());
      debugLog(
        `[sync-sweep] skipped: this team is refused by the server (${teamAccessReasonText()}) — ` +
          `${remaining} row(s) still owed, deferred until access is restored`
      );
      return { ...empty, remaining };
    }

    const url = readSetting("server_url");
    const token = readSetting("auth_token");
    const teamId = readSetting("team_id");
    /**
     * ⚠ `!isSessionUsable()` AS WELL AS `!token`, because the two are different questions and only the
     * second was being asked. A session whose refresh has failed still HAS `auth_token` — it is cleared by
     * an explicit sign-out, not by a 401 — so this guard passed and the sweep pushed turns at a credential
     * already known not to work, one failed request and one alert per owed turn. See session-liveness.ts.
     */
    if (!url || !token || !teamId || !isSessionUsable()) {
      const remaining = countUnsyncedMessages(activeUserId(), activeExperience());
      debugLog(
        `[sync-sweep] skipped: no signed-in session on a team (server_url=${!!url} token=${!!token} ` +
          `team_id=${!!teamId}) — ${remaining} row(s) still owed, deferred to sign-in`
      );
      return { ...empty, remaining };
    }

    const retry =
      deps?.retry ??
      (async (id: string) => {
        // Imported lazily so this module does not pull the whole sync/HTTP stack into startup — and
        // so a test can drive the sweep without electron or a network.
        const { retryMessageSync } = await import("./handlers/cli-sync");
        return retryMessageSync(id);
      });
    const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const candidates = unsyncedRowIds(MAX_TURNS_PER_SWEEP * 2);
    let attempted = 0;
    let recovered = 0;
    let failed = 0;
    let consecutive = 0;
    let gaveUp = false;

    for (const id of candidates) {
      if (attempted >= MAX_TURNS_PER_SWEEP) break;

      /**
       * ⚠ RE-READ BEFORE ATTEMPTING, because one retry settles a WHOLE TURN. `retryMessageSync`
       * pushes the user message and the reply together and stamps both, so the partner row of a turn
       * already handled in this same pass is no longer unsynced. Without this check every two-row turn
       * would be pushed twice — harmless server-side thanks to the idempotency key, and still double
       * the requests for no reason.
       */
      const status = readSyncStatus(id);
      /**
       * ⚠ THIS ALSO EXCLUDES NULL, WHICH THE QUERY ALREADY DOES — deliberately two layers, and
       * mutation testing proved they are independent: adding `OR sync_status IS NULL` to the WHERE
       * clause changes no behaviour, because `readSyncStatus` returns null for an untracked row and
       * this line skips it. Do not remove either as redundant. The query keeps the scan small; this
       * keeps the DECISION in one place, and it is the same line that stops a turn being pushed twice
       * via its partner row.
       */
      if (status !== SYNC_PENDING && status !== SYNC_FAILED) continue;

      attempted += 1;
      let ok = false;
      try {
        const result = await retry(id);
        ok = result.retried && result.status === SYNC_SYNCED;
      } catch (err) {
        // `retryMessageSync` is not supposed to throw; if it ever does, one bad row must not end the
        // sweep for the rest.
        debugLog("[sync-sweep] retry threw for", id, err instanceof Error ? err.message : String(err));
      }

      if (ok) {
        recovered += 1;
        consecutive = 0;
      } else {
        failed += 1;
        consecutive += 1;

        /**
         * ⚠ A PERMANENT REFUSAL ENDS THE SWEEP IMMEDIATELY, without waiting for the consecutive-failure
         * breaker to count to its limit.
         *
         * The breaker exists for "the session or the network is the problem", and it is right to require
         * a few failures before believing that. A 403 or 404 on the team is different in kind: it is a
         * verdict, learned by `checkedFetch` during the push that just failed, and every remaining turn
         * would be refused for the identical reason. Counting to the limit would mean two or three more
         * requests to establish something already known — which is exactly the waste this change exists
         * to remove.
         */
        if (teamAccessVerdict(readSetting("team_id")) === "unreadable") {
          gaveUp = true;
          debugLog(
            `[sync-sweep] stopping: the server refuses this team (${teamAccessReasonText()}) — the ` +
              `remaining turns would fail identically`
          );
          break;
        }

        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          gaveUp = true;
          debugLog(
            `[sync-sweep] stopping after ${consecutive} consecutive failures — the session or the ` +
              `network is the problem, not these turns`
          );
          break;
        }
      }

      if (attempted < MAX_TURNS_PER_SWEEP) await sleep(GAP_MS);
    }

    const remaining = countUnsyncedMessages(activeUserId(), activeExperience());
    if (attempted > 0) {
      debugLog(
        `[sync-sweep] attempted ${attempted}, recovered ${recovered}, failed ${failed}, ` +
          `${remaining} row(s) still unsynced${gaveUp ? " (stopped early)" : ""}`
      );
    }
    return { attempted, recovered, failed, remaining, gaveUp };
  } catch (err) {
    debugLog("[sync-sweep] aborted:", err instanceof Error ? err.message : String(err));
    return empty;
  } finally {
    running = false;
  }
}

/**
 * Fire a sweep without waiting for it, for callers on a hot path (startup, sign-in).
 *
 * ⚠ THE DELAY IS DELIBERATE. At startup the first seconds belong to the window, the migrations and the
 * session check; at sign-in they belong to getting the participant into the app. Neither should wait on
 * a background reconciliation, and `MIN_AGE_MS` means nothing useful is lost by starting a little late.
 */
export function scheduleSweep(reason: string, delayMs = 5000): void {
  setTimeout(() => {
    void sweepUnsyncedTurns().then((s) => {
      if (s.attempted > 0) debugLog(`[sync-sweep] (${reason}) recovered ${s.recovered}/${s.attempted}`);
    });
  }, delayMs).unref?.();
}

/** Test seam: the module-level guard would otherwise leak between cases. */
export function __resetSweepForTest(): void {
  running = false;
}
