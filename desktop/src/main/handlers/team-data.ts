// Board / team-chat / phases data access, moved OUT of the renderer
// (a governing security condition).
//
// These seven fetches used to run in the renderer, which meant the renderer had
// to hold the bearer: `getSetting("auth_token")` + `fetch(..., Authorization:
// Bearer <token>)`. That is what made the missing `db:getSetting` allowlist a
// credential-exposure defect rather than a theoretical one. The requests now run
// here, using the same `fetchAuthed` helper (and therefore the same single token
// authority + 401-refresh-retry) as every other authed call in handlers/ai.ts,
// and the token never crosses the IPC boundary.
//
// Each handler returns exactly the data its component already rendered, so the
// renderer keeps its existing loading/error states. Nothing here throws at the
// renderer: a transport failure comes back as the same "no data" shape the old
// `try {} catch {}` produced.

/**
 * ⚠ `app` IS IMPORTED, AND IT WAS NOT. `feedback:submit` calls `app.getVersion()` to stamp the installed
 * version on a report, and the import was missing — so `tsc -p tsconfig.main.json` failed with "Cannot find
 * name 'app'", and at RUNTIME the ReferenceError landed inside that handler's own try/catch and came back as
 * "Could not send that". Every desktop report would have failed, with the one message that says nothing
 * about why.
 *
 * `vite build` did not catch it because vite transpiles the renderer and does not type-check main; the
 * renderer's `type-check` script does not cover this tsconfig either. The main build is the gate that does.
 */
import { app, ipcMain } from "electron";
import { readSetting } from "../database";
import { fetchAuthed } from "./ai";
import { refreshHasFailed } from "../session-liveness";
/**
 * ⚠ READ FROM THE STORED CONFIG, NOT FETCHED.
 *
 * This used to call `fetchCognitoConfig(url)`, which read `/v1/auth/config` from our own
 * API — so the pool config shown here came from a server rather than from the value the
 * app actually authenticates against. That function is deleted (see cognito-oauth.ts); the
 * endpoints now come from AWS's OIDC discovery at configure time and are persisted.
 *
 * Reading the stored copy also makes this panel HONEST: it shows what sign-in will really
 * use, which is the whole point of displaying it to a facilitator.
 */
import { readPlatformConfig } from "../platform-config";
import { resolvePickedUpload } from "../picked-uploads";
import { noteTeamReadable, noteTeamUnreadable } from "../team-access-state";
// The word bounds a report must satisfy — the SAME function the identity service runs, so this handler and
// the API cannot disagree about what counts as a word.
import { checkFeedbackReport } from "@praimana/shared";
import { recordSecurityEvent, redactedTarget } from "../security-audit";
import { activeUserId } from "../active-account";

// ── Bounds ───────────────────────────────────────────────────────────────────
//
// READ_TIMEOUT_MS is 4s to match the existing probe convention in ai.ts
// (`ai:ping`, the login reachability check) and, more importantly, because
// TeamChatView polls `chat:getTeamMessages` on a 5s interval — a read that could
// outlive its own poll period would let in-flight requests stack up instead of
// completing between ticks.
const READ_TIMEOUT_MS = 4000;
// User-initiated writes get longer: the user is waiting on a confirmation and a
// slow backend is better than a spurious "not sent" on a request that landed.
const WRITE_TIMEOUT_MS = 10000;
// ⚠ NO `GENERATE_TIMEOUT_MS`. It bounded `phases:generatePhase` — a handler that called an endpoint the
// workshop service never had. Both are removed; see the note where the handler used to be below.
// Ceiling on concurrent IPC calls in flight here — counted per CALL, not per HTTP
// request, so the two-request handlers (board:getBoard, phases:getPhases) consume
// one slot and open two sockets. Real use needs ~3 concurrent calls (a board load,
// a phases load, and the 5s chat poll); 8 leaves headroom while keeping a spamming
// or compromised renderer from fanning out unboundedly into main's socket pool.
// Over the ceiling we SHED, visibly in the log, rather than queue — a queue here
// would just convert renderer pressure into main-process memory growth.
const MAX_IN_FLIGHT = 8;
// Page size for the team-chat poll — the same limit the renderer requested
// before, kept as a named bound so the response size stays capped.
const MESSAGE_PAGE_LIMIT = 100;
// A 20MB PUT straight to S3 is minutes-class work on a workshop-venue connection, so
// it gets its own generous-but-finite bound rather than the seconds-class write one.
const UPLOAD_TIMEOUT_MS = 300_000;
// Mirrors ALLOWED size in the docs service's upload-policy.ts. Checked here too so an
// oversized file fails instantly instead of after a pointless round trip; the server
// remains the authority, and S3 enforces it independently via the signed ContentLength.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * An AWS S3 endpoint, anchored at BOTH ends.
 *
 * Same discipline as `isAwsAuthHost` in platform-config.ts, and for the same reason recorded there:
 * `evil-amazonaws.com` and `…amazonaws.com.evil.test` must both fail, which a bare `endsWith` would
 * allow. Both addressing styles are accepted because the SDK chooses between them — virtual-hosted
 * (`<bucket>.s3.<region>.amazonaws.com`, the default) and path-style (`s3.<region>.amazonaws.com`),
 * with and without the region label. A bucket name may contain dots, so the leading portion is
 * allowed to as well.
 */
const S3_HOST = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * The URL the presigned PUT may go to, or `null` to refuse.
 *
 * ⚠ https ONLY, DEFAULT PORT ONLY, AND NO USERINFO. A presigned S3 URL is always all three, so each
 * exception would only ever admit something that is not one — and a port is how a host allowlist gets
 * turned into a reach-anything-on-that-host primitive.
 *
 * ⚠ NO LOOPBACK EXCEPTION HERE, unlike `assertSafeApiOrigin`. That one has one because
 * a local dev gateway genuinely serves the dev API over `http://localhost`; nothing presigns a
 * loopback upload — `S3DocStore` has no custom-endpoint path — so an exception would admit a
 * localhost SSRF target for no development benefit. Adding a MinIO/localstack dev store means
 * extending this deliberately.
 */
export function safeUploadTarget(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.port) return null;
  if (url.username || url.password) return null;
  if (!S3_HOST.test(url.hostname.toLowerCase())) return null;
  return url.toString();
}

/**
 * The headers a presigned PUT is allowed to carry.
 *
 * ⚠ AN ALLOWLIST, NOT A PASS-THROUGH, and this is the half that removes the request-forgery
 * primitive: forwarding the server's map verbatim let it put ANY header on a request main makes —
 * including an `Authorization` or a `Cookie` — on a host it also chose. `services/docs` sends exactly
 * `Content-Type` and `Content-Length`; `x-amz-*` is admitted because it is what a future presign
 * option (SSE, checksums, storage class) would legitimately need, and every one of those is covered
 * by the signature rather than a credential in its own right.
 *
 * Matched case-insensitively: HTTP header names are, and an allowlist that is not would be bypassed
 * by capitalisation.
 */
export function presignedPutHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const k = key.toLowerCase();
    if (k === "content-type" || k === "content-length" || k.startsWith("x-amz-")) {
      out[key] = value;
    }
  }
  return out;
}

// Guarded by the single main-process event loop: incremented/decremented only in
// `withSlot` below, never across an await boundary between the check and the
// increment, so no lock is needed.
let inFlight = 0;

/**
 * Run `work` if there is a free request slot, otherwise shed and return
 * `whenBusy` (always the caller's own "no data / failed" shape, so the renderer
 * treats a shed exactly as it already treats a failed fetch).
 */
async function withSlot<T>(label: string, whenBusy: T, work: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    console.warn(`[team-data] shed "${label}": ${inFlight} requests already in flight`);
    return whenBusy;
  }
  inFlight++;
  try {
    return await work();
  } finally {
    // Released on every path, including a thrown/aborted fetch.
    inFlight--;
  }
}

/**
 * Outcome of a board write. `status` is the HTTP status when the server answered
 * and null when it never did (timeout / transport error / dead session), so the
 * renderer can keep distinguishing the two the way its old try/catch did.
 */
interface TaskWriteResult {
  ok: boolean;
  status: number | null;
}

/** Server URL + team id, or null if the app isn't connected/on a team yet. */
function teamContext(): { url: string; teamId: string } | null {
  const url = readSetting("server_url");
  const teamId = readSetting("team_id");
  if (!url || !teamId) return null;
  return { url, teamId };
}

/**
 * Read `error` out of a failed JSON response without letting a non-JSON body
 * (an HTML 404 from a gateway, say) turn into a parse error the user sees.
 */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `${fallback} (HTTP ${res.status})`;
}

/**
 * ── ⚠ WHY A READ CAME BACK EMPTY, INSTEAD OF JUST "NOT ok" ────────────────────────────────
 *
 * Neither was true. The app was authenticated and the backend was healthy; the service was returning **403
 * Forbidden** on every team-scoped read, because the stored `team_id` no longer named a team this user is a
 * member of.
 *
 * The reason that was hard to see is that all three handlers collapsed EVERY failure into the same
 * `{ ok: false, …[] }`, and all three views render that as "no data yet". So a permanent, actionable
 * loss of access looked exactly like a slow network — an empty screen with nothing to act on, and
 * nothing in the log either, since `catch {}` swallowed it.
 *
 * `ok` keeps its old meaning and every existing `if (res?.ok)` still works; `reason` is additive, so
 * the renderer can tell the cases apart:
 *
 *   no-team      — signed in, but not on a team yet. Not a failure; the app has simply not joined one.
 *   no-session   — there is no session at all. Distinct from `no-team` BECAUSE THE REMEDIES DIFFER, and
 *                  conflating them is what made a signed-out profile look like an empty one: see the
 *                  note on `missingContextReason` below.
 *   access-lost  — 403. Authenticated, and the service refused THIS team. The actionable one.
 *   team-gone    — 404. The team no longer exists (recreated backend, deleted team).
 *   signed-out   — a 401 that survived the refresh retry. `auth:expired` has already been broadcast.
 *   unavailable  — timeout, transport error, or any other non-OK. Transient by assumption.
 *   busy         — shed locally by `withSlot`; never reached the network.
 */
export type TeamReadFailure =
  | "no-team"
  | "no-session"
  | "access-lost"
  | "team-gone"
  | "signed-out"
  | "unavailable"
  | "busy";

/**
 * ── ⚠ WHY A PRECONDITION FAILED: NO SESSION, OR A SESSION WITH NO TEAM ────────────────────────
 *
 * Nothing was missing — the request was never made. The profile had been signed out (`auth.signout / revoked`
 * in its own audit log, no `auth.signin` after it), so `teamContext()` returned null and every team-scoped
 * read returned early. Both reads and the user saw an empty screen with no explanation anywhere.
 *
 * ⚠ AND THE CAUSE WAS THE REASON CODE, NOT THE EARLY RETURN. `no-team` is documented above as "not a
 * failure; the app has simply not joined one" and `TeamAccessNotice` therefore renders NOTHING for it —
 * correctly, for a fresh install that has genuinely not joined a team. Reusing it for "there is no
 * session" made the one state with an actionable remedy invisible, which is the same defect
 * `TeamAccessNotice` was created to fix, one reason code out.
 *
 * ⚠ `auth_token` IS THE SIGNAL, not `connected`. `connected` is screen gating the renderer also writes;
 * the token is the thing whose absence actually makes every request below impossible.
 */
function missingContextReason(): TeamReadFailure {
  return readSetting("auth_token") ? "no-team" : "no-session";
}

/**
 * ── ⚠ REFUSE BEFORE THE REQUEST WHEN THE SESSION IS ALREADY KNOWN DEAD ────────────────────────
 *
 * `teamContext()` only asks whether a server and a team id are stored, and a 401'd session still has both —
 * `team_id` and `connected` are cleared by an explicit sign-out, not by a failed refresh. So every poller
 * kept spending requests to be told 401, which is what produced the alert flood in the first place.
 *
 * ⚠ ASKS `refreshHasFailed()`, NOT `!isSessionUsable()`. The first version used the latter and broke the
 * distinction this file draws two functions up: with NO token at all that returned `signed-out`, which
 * renders no banner, silently withdrawing the "You are not signed in to this profile" message added for the
 * blank-phases report. A token that is absent and one that no longer works are different states.
 *
 * ⚠ `signed-out` RATHER THAN A NEW REASON, deliberately. It already means "a 401 that survived the refresh
 * retry", which is exactly this, and `TeamAccessNotice` already renders nothing for it because `auth:expired`
 * owns that message. The behaviour a participant sees is unchanged; what changes is that it costs no request.
 */
function sessionIsDead(): boolean {
  return refreshHasFailed();
}

/** Classify a non-OK response. */
function readFailure(res: Response): TeamReadFailure {
  if (res.status === 403) return "access-lost";
  if (res.status === 404) return "team-gone";
  // A 401 only reaches a caller when the refresh retry could not save it (see with-auth-retry.ts).
  if (res.status === 401) return "signed-out";
  return "unavailable";
}

/**
 * Classify a thrown failure. `fetchWithAuthRetry` throws `Not logged in` when there is no token and
 * the refresh fails — that is a dead session, not a network blip, and reporting it as one would send
 * the user looking at their wifi.
 */
function thrownFailure(err: unknown): TeamReadFailure {
  return err instanceof Error && /not logged in/i.test(err.message) ? "signed-out" : "unavailable";
}

/**
 * Log a genuine, persistent failure once per (channel, reason) rather than on every poll.
 *
 * ⚠ THE RATE LIMIT IS THE POINT. `chat:getTeamMessages` polls every 5 seconds, so an unguarded
 * `console.warn` would emit ~17,000 identical lines a day and bury the one line that matters. Reset
 * when the reason changes, so a recovery and a later relapse both get recorded.
 */
const lastLoggedFailure = new Map<string, TeamReadFailure | null>();

function noteFailure(channel: string, reason: TeamReadFailure): void {
  /**
   * ⚠ SHARE THE VERDICT, so other subsystems stop guessing. `sync-sweep` cannot see an HTTP status and
   * was therefore pushing turns at a team already known to refuse them — two wasted requests on every
   * launch. Only the CONCLUSIVE reasons are recorded: a timeout must not stop the sweep from retrying.
   */
  const teamId = readSetting("team_id");
  if (teamId) {
    if (reason === "access-lost" || reason === "team-gone") {
      noteTeamUnreadable(teamId, reason === "access-lost" ? "HTTP 403" : "HTTP 404");
    }
  }

  // Transient states are not worth a line; they self-correct and would drown the real ones.
  // ⚠ `no-session` IS ABSENT FROM THIS LIST DELIBERATELY. It is neither transient nor expected-forever,
  // and the dedupe below means it costs ONE line per channel — which is the line that would have answered
  // "why is phases empty" without reading the database.
  if (reason === "unavailable" || reason === "busy" || reason === "no-team") {
    lastLoggedFailure.set(channel, reason);
    return;
  }
  if (lastLoggedFailure.get(channel) === reason) return;
  lastLoggedFailure.set(channel, reason);
  const detail =
    reason === "no-session"
      ? "there is no signed-in session in this profile — every team-scoped read will be empty until sign-in"
      : reason === "access-lost"
      ? "the service refused this team (HTTP 403) — the stored team_id may no longer name a team this user belongs to"
      : reason === "team-gone"
        ? "the team no longer exists (HTTP 404)"
        : "the session could not be renewed (HTTP 401)";
  console.warn(`[team-data] ${channel}: ${detail}`);
}

function noteSuccess(channel: string): void {
  lastLoggedFailure.set(channel, null);
  // Access restored mid-session resumes the sweep without needing a relaunch.
  const teamId = readSetting("team_id");
  if (teamId) noteTeamReadable(teamId);
}

/**
 * Test seam: forget what has been logged. Not called by the app.
 *
 * The dedupe state is module-level and therefore shared by every test in a file, so without this a
 * test asserting "logged exactly once" would pass or fail depending on which tests ran before it.
 */
export function __resetTeamReadLogState(): void {
  lastLoggedFailure.clear();
}

export function setupTeamDataHandlers() {
  /**
   * ── ⚠ IS THIS TEAM STILL READABLE? ────────────────────────────────────────────────────────
   *
   * THE QUESTION: why not check the user's session and redirect to sign-in, instead of signing the user in
   * and showing the message?
   *
   * The instinct is right and the destination is not, so this channel answers the question the app
   * can actually act on. A 403 means the token was ACCEPTED and the caller is simply not a member of
   * this team — the session is fine. Redirecting to LOGIN would mint a token for the same identity,
   * which the same team refuses again: login → 403 → login. The screen that fixes a team problem is
   * the join-team screen.
   *
   * One cheap request against the members endpoint, deliberately reusing `readFailure` so this probe
   * and the three read handlers can never disagree about what a 403 means.
   *
   * ⚠ IT REPORTS, IT DOES NOT DECIDE. Nothing is cleared here — not `team_joined`, not `team_id`. The
   * renderer derives its route from the answer, so a wrong or transient verdict costs a screen the
   * user can leave, never stored state they have to rebuild. That distinction is the whole reason a
   * mistaken 403 during a workshop is recoverable.
   */
  ipcMain.handle("team:checkAccess", async () => {
    const ctx = teamContext();
    if (sessionIsDead()) return { ok: false as const, reason: "signed-out" as TeamReadFailure };
    if (!ctx) return { ok: false as const, reason: missingContextReason() };

    return withSlot(
      "team:checkAccess",
      { ok: false as const, reason: "busy" as TeamReadFailure },
      async () => {
        try {
          const res = await fetchAuthed((token) =>
            fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/members`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            })
          );
          if (res.ok) {
            noteSuccess("team:checkAccess");
            return { ok: true as const };
          }
          const reason = readFailure(res);
          noteFailure("team:checkAccess", reason);
          return { ok: false as const, reason };
        } catch (err) {
          return { ok: false as const, reason: thrownFailure(err) };
        }
      }
    );
  });

  // ── Board (BoardView) ──────────────────────────────────────────────────────

  // Tasks + members for the board. `ok` mirrors the old `if (tasksRes.ok)` gate:
  // false leaves the board as-is, exactly as the renderer did before.
  ipcMain.handle("board:getBoard", async () => {
    // Pure: builds a shape, logs nothing. `withSlot` evaluates its `whenBusy` argument eagerly, so a
    // side effect in here would fire on every single call — including the ones that succeed.
    const emptyWith = (reason: TeamReadFailure) => ({
      ok: false as const, tasks: [] as unknown[], members: [] as unknown[], reason,
    });
    const failWith = (reason: TeamReadFailure) => {
      noteFailure("board:getBoard", reason);
      return emptyWith(reason);
    };
    const ctx = teamContext();
    if (sessionIsDead()) return emptyWith("signed-out");
    if (!ctx) return emptyWith(missingContextReason());

    return withSlot("board:getBoard", emptyWith("busy"), async () => {
      try {
        const [tasksRes, membersRes] = await Promise.all([
          fetchAuthed((token) =>
            fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/tasks`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            })
          ),
          fetchAuthed((token) =>
            fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/members`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            })
          ),
        ]);

        if (!tasksRes.ok) return failWith(readFailure(tasksRes));
        const tasksBody = (await tasksRes.json().catch(() => ({}))) as { tasks?: unknown[] };
        const membersBody = membersRes.ok
          ? ((await membersRes.json().catch(() => ({}))) as { members?: unknown[] })
          : {};
        noteSuccess("board:getBoard");
        return {
          ok: true as const,
          tasks: Array.isArray(tasksBody.tasks) ? tasksBody.tasks : [],
          members: Array.isArray(membersBody.members) ? membersBody.members : [],
        };
      } catch (err) {
        // Network failure, timeout, or an unrecoverable session (fetchAuthed
        // throws "Not logged in" and has already broadcast auth:expired).
        return failWith(thrownFailure(err));
      }
    });
  });

  // `status` is the HTTP status, or null when the request never produced a
  // response (timeout, transport error, unrecoverable session). BoardView keys
  // its form reset on that distinction — the pre-move code ignored a non-ok
  // status but skipped the reset when `fetch` threw — so it is preserved rather
  // than collapsed into a single boolean.
  ipcMain.handle(
    "board:createTask",
    async (
      _event,
      params: { title: string; description: string | null; priority: string; assigneeId: string | null }
    ) => {
      const failed: TaskWriteResult = { ok: false, status: null };
      const ctx = teamContext();
      if (!ctx) return failed;

      return withSlot("board:createTask", failed, async () => {
        try {
          const res = await fetchAuthed((token) =>
            fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/tasks`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                title: params.title,
                description: params.description,
                priority: params.priority,
                assigneeId: params.assigneeId,
              }),
              signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
            })
          );
          return { ok: res.ok, status: res.status };
        } catch {
          return failed;
        }
      });
    }
  );

  ipcMain.handle(
    "board:updateTask",
    async (
      _event,
      params: {
        taskId: string;
        title: string;
        description: string | null;
        status: string;
        priority: string;
        assigneeId: string | null;
      }
    ) => {
      const failed: TaskWriteResult = { ok: false, status: null };
      const ctx = teamContext();
      if (!ctx) return failed;

      return withSlot("board:updateTask", failed, async () => {
        try {
          const res = await fetchAuthed((token) =>
            /**
             * ⚠ THE PATH IS TEAM-SCOPED: `/v1/teams/{teamId}/tasks/{taskId}`.
             *
             * This URL was the cause. It read `/v1/tasks/{taskId}`, which does not exist: verified against
             * the deployed API, where it returns 404 while `/v1/auth/me` on the same host returns 401. The
             * real route is declared in the infrastructure CloudFormation template and handled by the collaboration service at
             * `app.patch("/teams/:teamId/tasks/:taskId")`.
             *
             * ⚠ IT FAILED SILENTLY, which is why it looked like a UI bug rather than a 404. The
             * renderer closes the dialog and reloads whenever the server ANSWERS at all
             * (`res?.status !== null`), and a 404 is an answer — so the card reverted to its old
             * column with no error anywhere.
             *
             * `createTask` two handlers above always used the team-scoped form, which is exactly
             * why ADDING cards worked and MOVING them did not.
             */
            fetch(
              `${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/tasks/${encodeURIComponent(params.taskId)}`,
              {
                method: "PATCH",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                // `teamId` also rides in the body: harmless duplication of the path parameter, and
                // the handler reads the PATH one, so the two cannot disagree in a way that matters.
                body: JSON.stringify({
                  teamId: ctx.teamId,
                  title: params.title,
                  description: params.description,
                  status: params.status,
                  priority: params.priority,
                  assigneeId: params.assigneeId,
                }),
                signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
              }
            )
          );
          return { ok: res.ok, status: res.status };
        } catch {
          return failed;
        }
      });
    }
  );

  // ── Team chat (TeamChatView) ───────────────────────────────────────────────

  // Polled every 5s by the renderer. Returns the raw message list; the renderer
  // still does its own normalisation/sort so the rendered output is unchanged.
  ipcMain.handle("chat:getTeamMessages", async () => {
    const emptyWith = (reason: TeamReadFailure) => ({
      ok: false as const, messages: [] as unknown[], reason,
    });
    const failWith = (reason: TeamReadFailure) => {
      noteFailure("chat:getTeamMessages", reason);
      return emptyWith(reason);
    };
    const ctx = teamContext();
    if (sessionIsDead()) return emptyWith("signed-out");
    if (!ctx) return emptyWith(missingContextReason());

    return withSlot("chat:getTeamMessages", emptyWith("busy"), async () => {
      try {
        const res = await fetchAuthed((token) =>
          fetch(
            `${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/messages?limit=${MESSAGE_PAGE_LIMIT}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            }
          )
        );
        if (!res.ok) return failWith(readFailure(res));
        const data = (await res.json().catch(() => ({}))) as { messages?: unknown[] };
        noteSuccess("chat:getTeamMessages");
        return {
          ok: true as const,
          messages: Array.isArray(data.messages) ? data.messages : [],
        };
      } catch (err) {
        return failWith(thrownFailure(err));
      }
    });
  });

  // `status` distinguishes an HTTP failure from a transport failure so the
  // renderer can keep showing the two different toasts it showed before.
  ipcMain.handle("chat:sendTeamMessage", async (_event, content: string) => {
    const failed: { ok: false; status: number | null } = { ok: false, status: null };
    const ctx = teamContext();
    if (!ctx) return failed;

    return withSlot("chat:sendTeamMessage", failed, async () => {
      try {
        const res = await fetchAuthed((token) =>
          fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ content }),
            signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
          })
        );
        return res.ok ? { ok: true as const } : { ok: false as const, status: res.status };
      } catch {
        return failed;
      }
    });
  });

  // ── Workshop phases (PhasesView) ───────────────────────────────────────────

  // Phase definitions + saved content, plus the workshop's current phase order
  // (the renderer derives each phase's COMPLETED/IN_PROGRESS/NOT_STARTED label
  // from it, as it did before). A failed workshop lookup yields order 0, the
  // same fallback the renderer used.
  ipcMain.handle("phases:getPhases", async () => {
    const emptyWith = (reason: TeamReadFailure, currentPhaseOrder = 0) => ({
      ok: false as const, phases: [] as unknown[], currentPhaseOrder, reason,
    });
    const failWith = (reason: TeamReadFailure, currentPhaseOrder = 0) => {
      noteFailure("phases:getPhases", reason);
      return emptyWith(reason, currentPhaseOrder);
    };
    const ctx = teamContext();
    const workshopId = readSetting("workshop_id");
    if (sessionIsDead()) return emptyWith("signed-out");
    if (!ctx || !workshopId) return emptyWith(missingContextReason());

    return withSlot("phases:getPhases", emptyWith("busy"), async () => {
      try {
        const [phasesRes, wsRes] = await Promise.all([
          fetchAuthed((token) =>
            fetch(
              `${ctx.url}/v1/workshops/teams/${encodeURIComponent(ctx.teamId)}/phases?workshopId=${encodeURIComponent(workshopId)}`,
              {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(READ_TIMEOUT_MS),
              }
            )
          ),
          fetchAuthed((token) =>
            fetch(`${ctx.url}/v1/workshops/${encodeURIComponent(workshopId)}`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            })
          ),
        ]);

        let currentPhaseOrder = 0;
        if (wsRes.ok) {
          const ws = (await wsRes.json().catch(() => ({}))) as {
            workshop?: { currentPhaseOrder?: number };
          };
          currentPhaseOrder = ws.workshop?.currentPhaseOrder || 0;
        }

        // `currentPhaseOrder` is preserved on failure exactly as before: it comes from the OTHER
        // request, which may well have succeeded, and the header reads better with the real phase
        // than with a 0 that means "before the first phase".
        if (!phasesRes.ok) return failWith(readFailure(phasesRes), currentPhaseOrder);
        const data = (await phasesRes.json().catch(() => ({}))) as { phases?: unknown[] };
        noteSuccess("phases:getPhases");
        return {
          ok: true as const,
          phases: Array.isArray(data.phases) ? data.phases : [],
          currentPhaseOrder,
        };
      } catch (err) {
        return failWith(thrownFailure(err));
      }
    });
  });

  ipcMain.handle(
    "phases:savePhase",
    async (_event, params: { phaseId: string; content: string }) => {
      const ctx = teamContext();
      if (!ctx) return { ok: false as const, error: "Not connected to a team" };

      const failed = { ok: false as const, error: "Save failed" };
      return withSlot("phases:savePhase", failed, async () => {
        try {
          const res = await fetchAuthed((token) =>
            fetch(
              `${ctx.url}/v1/workshops/teams/${encodeURIComponent(ctx.teamId)}/phases/${encodeURIComponent(params.phaseId)}`,
              {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ content: params.content }),
                signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
              }
            )
          );
          if (!res.ok) return { ok: false as const, error: await errorMessage(res, "Save failed") };
          return { ok: true as const };
        } catch {
          return failed;
        }
      });
    }
  );

  /**
   * ── ⚠ NO `phases:generatePhase` HANDLER. IT ANSWERED A ROUTE THAT DOES NOT EXIST ──────────
   *
   * It POSTed to `/v1/workshops/teams/:teamId/phases/:phaseId/generate`. That endpoint has never existed
   * in the workshop service (`git log -S` finds no commit adding it), so every call was a 404 dressed up
   * as "Generate failed".
   *
   * The "Generate from chat" button was removed from `PhasesView` first, which left this handler and its
   * preload bridge as a dead channel — reachable over IPC, callable, and guaranteed to fail. Both are
   * gone now, along with `GENERATE_TIMEOUT_MS`, which existed only to bound this one request.
   *
   * ⚠ RE-ADDING THE BRIDGE IS NOT THE FIX if this comes back. The workshop service has no model client:
   * it would need a Bedrock dependency and a cross-context read of the ai service's threads.
   */

  // ── Workshop setup guide (SelectAssistantView) ─────────────────────────────

  // Return the free-text setup instructions, not a URL. Only this one field is returned,
  // not the whole workshop record: a narrower response is a narrower disclosure.
  ipcMain.handle("workshop:getSetupInstructions", async () => {
    const none = { instructions: null as string | null };
    const url = readSetting("server_url");
    const workshopId = readSetting("workshop_id");
    if (!url || !workshopId) return none;

    return withSlot("workshop:getSetupInstructions", none, async () => {
      try {
        const res = await fetchAuthed((token) =>
          fetch(`${url}/v1/workshops/${encodeURIComponent(workshopId)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
          })
        );
        if (!res.ok) return none;
        const data = (await res.json().catch(() => ({}))) as {
          workshop?: { setupConfig?: { instructions?: string } };
        };
        const instructions = data.workshop?.setupConfig?.instructions;
        return {
          instructions:
            typeof instructions === "string" && instructions.trim() ? instructions : null,
        };
      } catch {
        return none;
      }
    });
  });

  // ── Team documents (Build phase) ───────────────────────────────────────────
  //
  // The docs service stores every synced `.md` in the versioned S3 bucket at
  // workshop/<id>/team/<id>/<path>, and since v0.2.3 also accepts direct uploads of
  // md/txt/pdf/html up to 20MB via a presigned PUT. These five handlers are the
  // desktop's whole view of that: list, version history, content, and the two-step
  // upload. The bearer never leaves main, same as every other handler in this file.

  /** The team's stored documents (latest-version pointers). */
  ipcMain.handle("docs:list", async () => {
    const empty = { ok: false as const, files: [] as unknown[] };
    const ctx = teamContext();
    if (!ctx) return empty;

    return withSlot("docs:list", empty, async () => {
      try {
        const res = await fetchAuthed((token) =>
          fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/docs`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
          })
        );
        if (!res.ok) return empty;
        const data = (await res.json().catch(() => ({}))) as { files?: unknown[] };
        return { ok: true as const, files: Array.isArray(data.files) ? data.files : [] };
      } catch {
        return empty;
      }
    });
  });

  /** Version history for one document, newest-first. */
  ipcMain.handle("docs:versions", async (_event, params: { path: string }) => {
    const empty = { ok: false as const, versions: [] as unknown[] };
    const ctx = teamContext();
    if (!ctx || !params?.path) return empty;

    return withSlot("docs:versions", empty, async () => {
      try {
        const res = await fetchAuthed((token) =>
          fetch(
            `${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/docs/versions?path=${encodeURIComponent(params.path)}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(READ_TIMEOUT_MS),
            }
          )
        );
        if (!res.ok) return empty;
        const data = (await res.json().catch(() => ({}))) as { versions?: unknown[] };
        return { ok: true as const, versions: Array.isArray(data.versions) ? data.versions : [] };
      } catch {
        return empty;
      }
    });
  });

  /** Content of a document — latest, or a specific version when `versionId` is given. */
  ipcMain.handle("docs:content", async (_event, params: { path: string; versionId?: string }) => {
    const empty = { ok: false as const, content: "" };
    const ctx = teamContext();
    if (!ctx || !params?.path) return empty;

    return withSlot("docs:content", empty, async () => {
      try {
        const qs = new URLSearchParams({ path: params.path });
        if (params.versionId) qs.set("versionId", params.versionId);
        const res = await fetchAuthed((token) =>
          fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/docs/content?${qs.toString()}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(READ_TIMEOUT_MS),
          })
        );
        if (!res.ok) return empty;
        const data = (await res.json().catch(() => ({}))) as {
          content?: string;
          versionId?: string;
          lastAuthor?: string;
        };
        return {
          ok: true as const,
          content: typeof data.content === "string" ? data.content : "",
          versionId: data.versionId ?? null,
          lastAuthor: data.lastAuthor ?? null,
        };
      } catch {
        return empty;
      }
    });
  });

  /**
   * Upload a file, end to end, in ONE ipc call.
   *
   * The three hops (ask for a presigned URL, PUT the bytes to S3, confirm) are
   * deliberately NOT exposed to the renderer separately. Two reasons: the renderer has
   * no business holding a presigned URL that grants an S3 write, and a half-finished
   * upload driven from the renderer would leave an object in the bucket with no pointer
   * row — a file nobody can list or read. Keeping the sequence here means the confirm
   * always follows the PUT in the same process that started it.
   *
   * The file is read from disk in main rather than passed across IPC as bytes: a 20MB
   * structured-clone through the bridge is pure waste when main can read the path.
   */
  ipcMain.handle("docs:upload", async (_event, params: { filePath: string; path?: string }) => {
    const failed = (error: string) => ({ ok: false as const, error });
    const ctx = teamContext();
    if (!ctx) return failed("Not connected to a team");
    if (!params?.filePath) return failed("No file chosen");

    /**
     * ⚠ PROVENANCE, BEFORE THE FILE IS TOUCHED.
     *
     * This handler is deliberately NOT confined to the project — an upload may be a downloaded
     * PDF or an exported report living anywhere. But "anywhere" has to mean "anywhere the USER
     * pointed at", not anywhere the renderer names: it `stat`s and `readFile`s the path and PUTs
     * the bytes to the team's shared, versioned document store, so an unvouched path was a
     * working exfiltration primitive (`~/.aws/credentials` uploaded as `notes.md` — the server's
     * extension allowlist applies to the STORED path, not the source).
     *
     * Checked before `stat` so the handler is not an existence oracle for arbitrary paths either.
     */
    const source = resolvePickedUpload(params.filePath);
    if (!source) {
      return failed("Choose a file with the file picker before uploading");
    }

    return withSlot("docs:upload", failed("Upload failed"), async () => {
      const { readFile, stat } = await import("fs/promises");
      const nodePath = await import("path");

      let size: number;
      try {
        const st = await stat(source);
        if (!st.isFile()) return failed("Not a file");
        size = st.size;
      } catch {
        return failed("Could not read that file");
      }
      if (size === 0) return failed("That file is empty");
      // Checked here as well as server-side so a 20MB+ file fails instantly rather
      // than after a pointless round trip. The server is still the authority.
      if (size > MAX_UPLOAD_BYTES) {
        return failed(
          `That file is ${(size / 1024 / 1024).toFixed(1)}MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`
        );
      }

      // Default the stored path to the file's own name; strip any directory so a
      // local absolute path never becomes part of the team's document tree.
      /**
       * ⚠ REDUCED TO A BASENAME, NOT JUST DE-SLASHED. This stripped leading slashes only, so a
       * renderer-supplied `path` of `../../other-team/notes.md` was forwarded verbatim and the
       * server was left to normalise it — an assumption about a service this repo cannot see. The
       * key is chosen from the file's own name either way, so there is no legitimate caller that
       * needs a directory component.
       */
      const storedPath = nodePath.basename(params.path || nodePath.basename(source));

      try {
        // 1. Ask the API for a presigned PUT. It authorizes membership and chooses the
        //    key, content type and byte ceiling — the client decides none of them.
        const urlRes = await fetchAuthed((token) =>
          fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/docs/upload-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ path: storedPath, sizeBytes: size }),
            signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
          })
        );
        if (!urlRes.ok) return failed(await errorMessage(urlRes, "Upload was refused"));
        const { upload } = (await urlRes.json()) as {
          upload?: { url: string; headers: Record<string, string> };
        };
        if (!upload?.url) return failed("The server did not return an upload URL");

        /**
         * ── ⚠ THE SECOND HOP IS VALIDATED, LIKE EVERY OTHER REMOTE URL IN THIS APP ─────────────
         *
         * `upload.url` and `upload.headers` came out of the platform's JSON with nothing but a truthiness
         * test, and were handed straight to `fetch` along with the full bytes of a local file — a file
         * explicitly allowed to live OUTSIDE the project boundary (that is what `resolvePickedUpload` exists
         * for, with the `~/.aws/credentials` reasoning above). So the platform, or anyone who had become the
         * platform for this install, could direct main to PUT a local file to any host, port and path, with
         * arbitrary request headers, from inside the participant's network.
         *
         * ⚠ WHAT THIS DOES AND DOES NOT CLOSE, stated plainly rather than overclaimed. It is
         * defence in depth, not a new trust boundary: the responder is already the API origin the
         * participant confirmed at connect time, over https. A SUBSTITUTED platform can still name
         * an S3 bucket it owns, exactly as it could name its own Cognito pool. What the checks
         * remove is the general-purpose primitive — an arbitrary host, an arbitrary port, a
         * non-HTTP scheme, and arbitrary headers on a request main makes from inside the network.
         *
         * The shape is knowable, so it is checked rather than trusted: `services/docs` presigns with
         * `@aws-sdk/s3-request-presigner` against a plain `S3Client` (no custom endpoint, no
         * `forcePathStyle`), so the host is always AWS S3's and the headers are always exactly
         * `Content-Type` and `Content-Length`.
         */
        const target = safeUploadTarget(upload.url);
        if (!target) {
          console.warn("[docs] refusing an upload URL that is not an AWS S3 endpoint");
          return failed("The server returned an upload location this app will not use");
        }

        // 2. PUT the bytes straight to S3. Bounded generously — 20MB on a venue
        //    connection is minutes-class work, not seconds.
        const body = await readFile(source);
        const putRes = await fetch(target, {
          method: "PUT",
          headers: presignedPutHeaders(upload.headers),
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        if (!putRes.ok) return failed(`Upload to storage failed (HTTP ${putRes.status})`);

        // 3. Confirm, so the file is indexed and listable. The API re-HEADs the object,
        //    so a confirm cannot invent a document that is not really there.
        const doneRes = await fetchAuthed((token) =>
          fetch(`${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/docs/upload-complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ path: storedPath }),
            signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
          })
        );
        if (!doneRes.ok) {
          return failed(await errorMessage(doneRes, "Upload stored but could not be indexed"));
        }
        const done = (await doneRes.json().catch(() => ({}))) as { versionId?: string };
        /**
         * ── ⚠ RECORDED, BECAUSE A DOCUMENT LEAVING THIS MACHINE IS A SECURITY EVENT ───────────
         *
         * "Who put that in the team's documents?" had no local answer. The name only, never the source path:
         * the local directory is a person's filesystem and the stored key is the fact.
         */
        recordSecurityEvent({
          event: "docs.change",
          outcome: "success",
          /**
           * ⚠ WHO, NOT ONLY WHAT. `docs:upload` and `docs:delete` omitted the acting user.
           * `recordSecurityEvent` drops an absent subject silently, so the chained
           * record carried an empty subject field and the log could not answer "who put that in the
           * team's documents?" — which this module's own header names as a reason the log exists. The
           * bulk sibling `git:uploadSelected` supplies it; these two did not.
           */
          userId: activeUserId() ?? undefined,
          detail: `upload:${redactedTarget(storedPath)}`,
        });
        return { ok: true as const, path: storedPath, sizeBytes: size, versionId: done.versionId ?? null };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "TimeoutError";
        return failed(aborted ? "Upload timed out" : "Upload failed");
      }
    });
  });

  /**
   * Remove one of the team's documents.
   *
   * ⚠ THE SERVICE DECIDES WHO MAY DELETE, not this handler — same guard as the upload (any team
   * member). "Only my own files" is not expressible: `lastAuthor` holds a Cognito sub for an upload and
   * a GIT AUTHOR NAME for a synced file, so an ownership test would work on some rows and silently fail
   * on most. See the route's own note.
   *
   * ⚠ AND NOTHING IS DESTROYED. The service drops the pointer row and writes an S3 DELETE MARKER on a
   * versioned bucket with no expiry, so the content stays recoverable by an operator. That is what makes
   * a member-level delete safe enough to put behind a single confirmation.
   */
  ipcMain.handle("docs:delete", async (_event, params: { path: string }) => {
    const failed = (error: string) => ({ ok: false as const, error });
    const ctx = teamContext();
    if (!ctx) return failed("Not connected to a team");
    if (!params?.path) return failed("No file chosen");

    return withSlot("docs:delete", failed("Delete failed"), async () => {
      try {
        const res = await fetchAuthed((token) =>
          fetch(
            `${ctx.url}/v1/teams/${encodeURIComponent(ctx.teamId)}/docs?path=${encodeURIComponent(params.path)}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
            }
          )
        );
        if (!res.ok) return failed(await errorMessage(res, "Delete was refused"));
        // The destructive half of the same pair — see the upload above.
        recordSecurityEvent({
          event: "docs.change",
          outcome: "success",
          // The subject, for the reason given at the upload record above — and more so for a delete.
          userId: activeUserId() ?? undefined,
          detail: `delete:${redactedTarget(params.path)}`,
        });
        return { ok: true as const, path: params.path };
      } catch (err) {
        const aborted = err instanceof Error && err.name === "TimeoutError";
        return failed(aborted ? "Delete timed out" : "Delete failed");
      }
    });
  });

  /**
   * ── FILE A BUG REPORT OR FEEDBACK ──────────────────────────────────────────────────────────
   *
   * THE RULE: reports go in the database and the platform emails staff — no `mailto:`; the backend emails
   * the current experience's facilitators and admins.
   *
   * ⚠ THIS REPLACED TWO `mailto:` LINKS, and the difference is not cosmetic. The old version handed the
   * participant's own mail client a prefilled draft, which meant a report could be lost to a misconfigured
   * client, arrived in one person's inbox, and needed a support address configured before the links would
   * render at all. Now the desktop POSTs and the platform does the rest.
   *
   * ⚠ THE CONTEXT IS ASSEMBLED HERE, IN MAIN, because main is what knows it: the app version comes from
   * `app.getVersion()` and the team/experience ids from local settings. The renderer supplies only the kind
   * and the message.
   *
   * ⚠ AND NOTHING ABOUT *WHO*. The service takes the reporter's id, email and role from the verified token
   * this request carries. A field here would be ignored at best and a spoofing surface at worst.
   */
  ipcMain.handle(
    "feedback:submit",
    async (
      _event,
      params: { kind: "BUG" | "FEEDBACK"; subject: string; message: string; location?: string }
    ) => {
      const failed = (error: string) => ({ ok: false as const, error });
      const ctx = teamContext();
      if (!ctx) return failed("Not connected to a platform");
      if (params?.kind !== "BUG" && params?.kind !== "FEEDBACK") return failed("Unknown report type");

      const subject = typeof params?.subject === "string" ? params.subject.trim() : "";
      const message = typeof params?.message === "string" ? params.message.trim() : "";
      /**
       * ⚠ THE SHARED BOUNDS, CHECKED IN MAIN AS WELL AS IN THE FORM. The bounds: subject
       * 5–15 words, description 20–200. Same function the service will run, so a report this handler
       * forwards cannot come back as a 400 the renderer has to translate — and the sentence shown is the
       * service's own wording either way.
       *
       * It is not a security check (nothing here is protected) but a round-trip saved and, more usefully, one
       * place where a renderer bug that skipped the form's own gate still cannot file an empty report.
       */
      const problem = checkFeedbackReport({ subject, message });
      if (problem) return failed(problem.message);

      return withSlot("feedback:submit", failed("Could not send that"), async () => {
        try {
          const res = await fetchAuthed((token) =>
            fetch(`${ctx.url}/v1/auth/feedback`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({
                kind: params.kind,
                subject,
                message,
                surface: "desktop",
                // `app.getVersion()` reads the packaged package.json — the version the participant actually
                // installed, which is the only figure worth putting in a bug report.
                version: app.getVersion(),
                location: params.location || "Account",
                workshopId: readSetting("workshop_id") || undefined,
                teamId: ctx.teamId,
              }),
              signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
            })
          );
          if (!res.ok) return failed(await errorMessage(res, "Could not send that"));
          return { ok: true as const };
        } catch (err) {
          const aborted = err instanceof Error && err.name === "TimeoutError";
          return failed(aborted ? "That timed out — please try again" : "Could not send that");
        }
      });
    }
  );

  /**
   * ── THE SIGNED-IN ACCOUNT, FOR THE READ-ONLY DETAILS PANEL ──
   *
   * ⚠ HALF OF THIS IS NOT ON DISK, which is why it is a handler rather than a few `getSetting` calls in the
   * renderer. Audited before building rather than assumed:
   *
   *   name, email, team name, ids  — already local settings.
   *   ROLE                         — NOT stored anywhere locally. It is authoritative from the ID token's
   *                                  `cognito:groups` claim and echoed by `GET /v1/auth/me`, which login
   *                                  already calls but reads only `name` from.
   *   EXPERIENCE NAME              — no local copy and no wired lookup; only `workshop_id` is stored.
   *                                  `GET /v1/workshops/:id` returns it and is gated on membership, which
   *                                  a participant satisfies.
   *   COGNITO CONFIG               — never persisted. `fetchCognitoConfig` reads `/v1/auth/config`, which is
   *                                  unauthenticated and is the same call sign-in makes.
   *
   * ⚠ NO SECRETS CROSS THIS BOUNDARY. `auth_token` and `cognito_refresh_token` are deliberately absent:
   * they are encrypted at rest precisely so they stay in main, and a details panel has no use for them. The
   * Cognito values returned here — issuer, client id, Hosted UI domain, scopes — are all PUBLIC by design;
   * they are handed to any browser during the OAuth redirect. The client SECRET, which this pool does not
   * use, would not be shown even if it existed.
   *
   * ⚠ EVERY REMOTE FIELD IS OPTIONAL AND DEGRADES. Three independent calls, each best-effort: offline, or
   * signed out, or a workshop the participant has left, must still render the local half rather than an
   * error. The renderer distinguishes "not available" from "empty" on that basis.
   */
  ipcMain.handle("account:getDetails", async () => {
    const local = {
      name: readSetting("user_name"),
      email: readSetting("user_email"),
      userId: readSetting("user_id"),
      teamId: readSetting("team_id"),
      teamName: readSetting("team_name"),
      workshopId: readSetting("workshop_id"),
      serverUrl: readSetting("server_url"),
    };

    return withSlot(
      "account:getDetails",
      { ...local, role: null, organization: null, workshopName: null, cognito: null },
      async () => {
      const url = local.serverUrl;

      /**
       * ROLE, from the profile endpoint. `Promise.allSettled` rather than sequential awaits: the three reads
       * are independent, and one slow or failing call must not delay or suppress the other two.
       */
      const [me, workshop, cognito] = await Promise.allSettled([
        url
          ? fetchAuthed((token) =>
              fetch(`${url}/v1/auth/me`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(READ_TIMEOUT_MS),
              })
            ).then((res) => (res.ok ? res.json() : null))
          : Promise.resolve(null),
        url && local.workshopId
          ? fetchAuthed((token) =>
              fetch(`${url}/v1/workshops/${encodeURIComponent(local.workshopId!)}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(READ_TIMEOUT_MS),
              })
            ).then((res) => (res.ok ? res.json() : null))
          : Promise.resolve(null),
        /**
         * Local, synchronous, and never fails — but kept in the `allSettled` tuple so the
         * destructuring below stays aligned with the three reads it was written for.
         */
        Promise.resolve(readPlatformConfig()),
      ]);

      const user =
        me.status === "fulfilled" && me.value
          ? ((me.value as { user?: Record<string, unknown> }).user ?? null)
          : null;
      const ws =
        workshop.status === "fulfilled" && workshop.value
          ? ((workshop.value as { workshop?: Record<string, unknown> }).workshop ?? null)
          : null;
      const cfg = cognito.status === "fulfilled" ? cognito.value : null;

      return {
        ...local,
        /**
         * PREFERRED FROM THE SERVER, falling back to the local copy. `/v1/auth/me` is authoritative for both
         * — the profile row is where the display name actually lives, and the stored setting is a snapshot
         * from login that a later profile edit would leave stale.
         */
        name: (typeof user?.name === "string" && user.name) || local.name,
        email: (typeof user?.email === "string" && user.email) || local.email,
        /** Authoritative from the token's group claim; no local fallback exists to be wrong. */
        role: typeof user?.role === "string" ? user.role : null,
        organization: typeof user?.organization === "string" ? user.organization : null,
        workshopName: typeof ws?.name === "string" ? ws.name : null,
        /**
         * ⚠ AN ALLOW-LIST, NOT A SPREAD. Every field named here is PUBLIC by design —
         * issuer, client id, and the two AWS-published OAuth endpoints all travel in a
         * normal sign-in redirect. Listing them explicitly means a future config field
         * carrying something sensitive cannot ride along into the renderer.
         */
        cognito: cfg
          ? {
              issuer: cfg.cognito.issuer,
              clientId: cfg.cognito.clientId,
              authorizationEndpoint: cfg.cognito.authorizationEndpoint,
              tokenEndpoint: cfg.cognito.tokenEndpoint,
              scopes: cfg.cognito.scopes,
            }
          : null,
      };
    });
  });
}
