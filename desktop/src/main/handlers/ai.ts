import { ipcMain, BrowserWindow, app } from "electron";
import {
  getDb,
  readSetting,
  writeSetting,
  assertSecretStorageAvailable,
  EncryptionUnavailableError,
} from "../database";
import {
  upsertActiveAccount,
  syncActiveAccountFromSettings,
  listAccounts,
  switchAccount,
  removeAccount,
  signOutAccount,
} from "../accounts";
import WebSocket from "ws";
import { fetchWithAuthRetry } from "../with-auth-retry";
import { SIGN_OUT_SETTINGS } from "../setting-access";
import { backendOriginOrNull } from "../backend-origin";
import { readPlatformConfig } from "../platform-config";
import { debugLog } from "../debug-log";
import { scheduleSweep } from "../sync-sweep";
import { markSessionAlive, markSessionDead } from "../session-liveness";
// One-way: this module imports the re-check, and PASSES its own teardown in. The
// reverse import would be a cycle — see SessionTeardown in handlers/platform.ts.
import { recheckPlatformFromServer } from "./platform";
import { loginWithHostedUi, type CognitoConfig } from "../cognito-oauth";
import { refreshViaCognitoIdp } from "../cognito-refresh";
import { canSignInToDesktopApp, collapseCognitoGroups } from "@praimana/shared";
import { hasValidSignature } from "../jwt-verify";
import { recordSecurityEvent } from "../security-audit";
import { activeUserId } from "../active-account";
import { bindProfileIdentity, isForeignToProfile, profileIdentity } from "../accounts";
import { isSessionOwnedByActiveAccount } from "../session-ownership";
import { isSafeRowId } from "../row-id";
import { excludeOwnThreads } from "../shared-threads-filter";

// Decode a JWT payload WITHOUT verifying the signature.
//
// ⚠ THE NAME IS THE WARNING: this reads claims, it does not validate them. Safe for the Hosted UI
// path, where main itself obtained the token over TLS from the configured token endpoint and reads
// only display claims (sub/email/name) from it.
//
// ⚠ NOT SUFFICIENT FOR A RENDERER-SUPPLIED TOKEN. `auth:completeSignIn` takes one from the renderer
// and derives a local role gate and the local DB scoping key from its claims, so it calls
// `hasValidSignature` (../jwt-verify) before believing anything decoded here. Any future caller
// that makes a LOCAL decision from these claims owes the same check.
function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    if (!part) return {};
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * What the user is told when the keychain cannot hold their credential.
 *
 * ⚠ ONE SENTENCE, SHARED BY BOTH SIGN-IN PATHS, for the same reason the role refusal is shared: two
 * wordings for one condition read as two different faults. It says what happened, that it is this
 * machine rather than their account, and what would fix it — a refusal with no next step gets
 * reported as "the app is broken".
 */
const KEYCHAIN_REFUSAL_MESSAGE =
  "This computer's keychain is unavailable, so your sign-in cannot be stored securely. " +
  "The app will not save credentials unencrypted. On Linux, start your keyring service " +
  "(gnome-keyring or kwallet) and try again; otherwise contact your facilitator.";

function getSetting(key: string): string | null {
  return readSetting(key);
}

/**
 * ── ⚠ THE FOUR TENANT ROWS, WRITTEN TOGETHER, IN MAIN ONLY ─────────────────────────────────────
 *
 * `team_id`, `team_name`, `team_invite_code` and `workshop_id` were renderer-writable, which made the tenant
 * key client-controlled for every team-scoped request in the app. They are off both write paths now
 * (setting-access.ts refuses at boot if that regresses), and this is the only writer.
 *
 * ⚠ ONE FUNCTION BECAUSE THEY ARE ONE FACT. Two call sites writing three of the four is how an install
 * ends up with a `team_id` whose name and invite code describe the previous team — which the Account
 * panel then displays, and `syncActiveAccountFromSettings` then mirrors onto the saved account row.
 *
 * ⚠ AN ABSENT VALUE IS WRITTEN AS "", NOT SKIPPED. Skipping leaves the OLD team's row in place, which
 * is the same divergence one step later: a team with no workshop must clear the workshop, not inherit
 * one. `writeSetting` with "" is how every other clear in this file is done.
 */
function writeTeamContext(team: {
  id: string;
  name: string;
  workshopId?: string | null;
  inviteCode?: string | null;
}): void {
  writeSetting("team_id", team.id);
  writeSetting("team_name", team.name || "");
  writeSetting("workshop_id", team.workshopId || "");
  writeSetting("team_invite_code", team.inviteCode || "");
  // Remember the team on the active account so switching back restores it.
  syncActiveAccountFromSettings();

  /**
   * ── ⚠ AND THE EVENT STREAM FOLLOWS THE TENANT, BECAUSE IT IS BOUND TO ONE ────────────────────
   *
   * `startTeamEventStream` reads `team_id` ONCE, remembers it in `eventStreamTeamId`, and builds
   * `ws(s)://…/v1/teams/{teamId}/events` from that captured value — it never re-reads the setting. So the
   * socket is bound to the team it was started for, and the only two places that re-bound it were
   * `events:subscribe` and `auth:switchAccount`, which stops and restarts it explicitly.
   *
   * ⚠ THE TWO HANDLERS THAT ACTUALLY CHANGE THE TENANT BOTH CAME THROUGH HERE AND DID NEITHER.
   * `ai:joinTeam` and `ai:selectTeam` write all four rows above and left the socket on the old team,
   * and the renderer's only trigger is `useTeamUnread`, whose subscribe sits in a `[]`-dependency
   * effect inside a hook mounted once at the top of `App` — so nothing re-subscribed either.
   *
   * ⚠ THE FUNCTIONAL HALF IS THE WORSE ONE, and it is why this is here rather than in the handlers:
   * the NEW team received no events at all until the app was restarted, while the OLD team's frames
   * kept arriving and were badged and chimed as the new team's activity. Two bugs from one omission.
   *
   * ⚠ IT BELONGS IN THIS FUNCTION FOR THE REASON THE FUNCTION EXISTS. The comment above says the four
   * rows are one fact and that two call sites writing three of them is how an install ends up
   * describing the previous team. A socket bound to the previous team is the same divergence one step
   * further out, so it is re-bound where the fact is written and both handlers inherit it — rather
   * than at two call sites that a third would then forget.
   *
   * ⚠ STOP THEN START, NOT START ALONE. `startTeamEventStream` no-ops when it is already streaming the
   * team it reads from settings, and by this point the setting is already the NEW team — so a bare
   * start would compare the new id against the old capture, decide they differ, and work; but the
   * explicit stop is what guarantees the old socket is torn down rather than left to the reconnect
   * loop. It is also exactly what `auth:switchAccount` does.
   */
  stopTeamEventStream();
  startTeamEventStream();
}

/**
 * ── ⚠ IS THIS FRAME FOR THE TENANT THE UI IS SHOWING RIGHT NOW? ────────────────────────────────
 *
 * Defence in depth for the re-bind in `writeTeamContext`: the team event WebSocket was never re-bound
 * when the tenant changed, so the previous team's events kept flowing into the new team's UI.
 * The re-bind is the fix; this is the backstop, and it covers two things the re-bind
 * cannot:
 *
 *   - the window between the tenant being written and the old socket actually closing, since the
 *     abort unwinds an in-flight `ws` asynchronously;
 *   - MEMBERSHIP REVOKED SERVER-SIDE, which is the case `team-access-state` exists for. This socket's
 *     authorisation was checked at handshake ONLY, so if the user is removed from the team the frames
 *     keep arriving for the life of the connection and nothing local knows. Whether the server closes
 *     such sockets on revocation is not visible from this repository.
 *
 * ⚠ COMPARED AGAINST THE SETTING, NOT AGAINST THE CAPTURED `teamId`. The captured value is what the
 * socket was OPENED for, so comparing a frame to it would always agree and assert nothing. The
 * question this answers is whether the frame matches the tenant the UI is showing NOW.
 *
 * ⚠ AN UNLABELLED FRAME IS FORWARDED, NOT DROPPED, and that is the important default. Not every event
 * shape carries `teamId`, so dropping frames without one would silently break whichever event type
 * omits it — and a tenant filter must not become a feature gate. Only a frame that POSITIVELY names a
 * different team is refused.
 *
 * ⚠ AND SO IS EVERY FRAME WHEN THE APP IS ON NO TEAM. "No current tenant" is a real state (signed in,
 * not yet joined), and in it there is nothing to disagree with — the socket cannot be open for a team
 * the settings do not name, so a mismatch here would mean the settings were cleared under a live
 * connection, which the re-bind already handles.
 *
 * Extracted rather than left inline in the message handler so it can be tested at all: driving the
 * real socket needs a WebSocket server, and this is the whole of the decision.
 */
export function isFrameForCurrentTenant(
  frameTeamId: unknown,
  currentTeamId: string | null | undefined
): boolean {
  if (typeof frameTeamId !== "string" || !frameTeamId) return true;
  if (!currentTeamId) return true;
  return frameTeamId === currentTeamId;
}

// ── Real-time team event stream (WebSocket) ──────────────────────────────────
// Holds one long-lived WebSocket to the collaboration service's /events endpoint
// and forwards each pushed event (chat message / board task / phase update) to
// the renderer over IPC. Replaces renderer-side polling for the unread badges +
// notification sound. (Previously SSE; the server now upgrades this path to a
// WebSocket — see the collaboration service's ws-server. The IPC contract
// — a "team:event" broadcast per event, skipping the {type:"connected"} hello —
// is unchanged.)
let eventStreamAbort: AbortController | null = null;
let eventStreamTeamId: string | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// Turn an http(s):// server URL into the ws(s):// origin for the socket.
function toWsOrigin(url: string): string {
  return url.replace(/^http(s?):\/\//i, "ws$1://").replace(/\/+$/, "");
}

async function runTeamEventStream(url: string, teamId: string, signal: AbortSignal) {
  let backoffMs = 3000;
  const MAX_BACKOFF = 60000;

  while (!signal.aborted) {
    const token = authToken || getSetting("auth_token");
    if (!token) {
      broadcast("auth:expired", { reason: "no-token" });
      return;
    }

    // Result of this connection attempt, resolved once the socket closes or the
    // handshake is rejected. "reconnect" → back off and retry; "refresh" → the
    // token expired, renew and retry immediately; "stop" → give up (aborted or
    // unrecoverable auth failure, which already signalled the renderer).
    const outcome = await new Promise<"reconnect" | "refresh" | "stop">((resolve) => {
      /**
       * ── ⚠ THE BEARER GOES IN THE HEADER, NEVER IN THE URL ────────────────────────────────
       *
       * A URL is the least private part of a request — it lands in reverse-proxy and load-balancer access
       * logs, in APM traces and in error reports, none of which are treated as credential stores and most of
       * which are readable by people who should not hold a live bearer. The header is not logged by any of
       * them by default.
       *
       * ⚠ AND THE OLD COMMENT HERE HAD THE PRECEDENCE BACKWARDS. It said the server "prefers the
       * header when present"; `tokenFromRequest` (services/collaboration/src/ws-server.ts:291)
       * checks the query param FIRST and only falls back to `Authorization: Bearer`. So while both
       * were sent, the logged copy was the one actually authorizing the socket — and the header was
       * dead weight that made the arrangement look safer than it was.
       *
       * ⚠ REMOVING IT IS SAFE, AND THAT IS CHECKED RATHER THAN ASSUMED: the same function accepts
       * a Bearer header, `ws` sends the `headers` option on the upgrade request, and this client is
       * Node. The query param exists for BROWSERS — `new WebSocket()` in a page cannot set headers
       * (ws-server.ts:25) — which is why the server still supports it and why the portal is
       * unaffected by this change.
       */
      const wsUrl = `${toWsOrigin(url)}/v1/teams/${encodeURIComponent(teamId)}/events`;
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      let settled = false;
      const done = (o: "reconnect" | "refresh" | "stop") => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(o);
      };

      // Abort (team switch / shutdown): tear the socket down and stop the loop.
      const onAbort = () => {
        try {
          ws.terminate();
        } catch {
          /* already closing */
        }
        done("stop");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        backoffMs = 3000; // healthy connection — reset backoff
      });

      ws.on("message", (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data?.type === "connected") return;
          // The backstop for the re-bind in `writeTeamContext` — see `isFrameForCurrentTenant`.
          const currentTeam = getSetting("team_id");
          if (!isFrameForCurrentTenant(data?.teamId, currentTeam)) {
            debugLog(
              `[team-events] dropped a frame for team ${String(data?.teamId).slice(0, 8)} — the app ` +
                `is now on ${String(currentTeam).slice(0, 8)}`
            );
            return;
          }
          broadcast("team:event", data);
        } catch {
          /* ignore malformed frame */
        }
      });

      // EA-M8: a 401 on the upgrade means the token expired — don't hot-loop
      // against a dead credential. `ws` surfaces the rejected handshake here
      // with the HTTP status (a browser WebSocket can't see it, but the Node
      // client can). Refresh once; if that fails, stop and signal re-login.
      ws.on("unexpected-response", (_req, res) => {
        if (res.statusCode === 401) {
          void renewAuthToken().then((fresh) => {
            if (!fresh) {
              authToken = null;
              broadcast("auth:expired", { reason: "token-refresh-failed" });
              done("stop");
            } else {
              done("refresh"); // retry immediately with the refreshed token
            }
          });
          return;
        }
        done("reconnect");
      });

      // Any transport error → reconnect (unless it was the 401 path above).
      ws.on("error", () => done("reconnect"));
      // Normal/abnormal close → reconnect (abort handled by onAbort first).
      ws.on("close", () => done("reconnect"));
    });

    if (outcome === "stop") return;
    if (outcome === "refresh") continue; // skip the backoff; token is fresh

    // Transient network/backend error — exponential backoff, then reconnect.
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
  }
}

function startTeamEventStream(): void {
  const url = getSetting("server_url");
  const token = getSetting("auth_token");
  const teamId = getSetting("team_id");
  if (!url || !token || !teamId) return;

  // Already streaming this team — no-op.
  if (eventStreamAbort && eventStreamTeamId === teamId) return;

  stopTeamEventStream();
  eventStreamTeamId = teamId;
  eventStreamAbort = new AbortController();
  void runTeamEventStream(url, teamId, eventStreamAbort.signal);
}

function stopTeamEventStream(): void {
  eventStreamAbort?.abort();
  eventStreamAbort = null;
  eventStreamTeamId = null;
}

function getServerUrl(): string {
  const url = getSetting("server_url");
  if (!url) throw new Error("Not connected to server");
  return url;
}

// The API bearer is the Cognito ID token (it carries aud + email +
// cognito:groups, which the gateway's JWT authorizer verifies). We never store a
// password; the session is renewed with the Cognito refresh token, which
// survives ID-token expiry (30 min) up to the refresh-token lifetime (30 days).
let authToken: string | null = null;

// Cached Cognito config, so a token refresh doesn't have to re-read it on every
// 401. Cleared on sign-out and on a platform change (`tearDownSession`).
let cognitoConfig: CognitoConfig | null = null;

/**
 * The pool config for the CONFIGURED platform.
 *
 * ⚠ NO LONGER FETCHED FROM `/v1/auth/config`. It comes from the platform config this
 * process already validated — Cognito-owned Hosted UI host, Cognito-shaped issuer
 * (platform-config.ts). Re-discovering it from the API would mean the value we
 * VALIDATED is not the value we authenticate against, which is the entire point of
 * validating it; and the token endpoint this feeds is where a refresh token is sent.
 */
function getCognitoConfig(): CognitoConfig | null {
  if (cognitoConfig) return cognitoConfig;
  const platform = readPlatformConfig();
  if (!platform) return null;
  cognitoConfig = {
    issuer: platform.cognito.issuer,
    clientId: platform.cognito.clientId,
    authorizationEndpoint: platform.cognito.authorizationEndpoint,
    tokenEndpoint: platform.cognito.tokenEndpoint,
    scopes: platform.cognito.scopes,
  };
  return cognitoConfig;
}

/**
 * Force a token refresh (call when a request 401s). Exchanges the stored Cognito
 * refresh token for a fresh ID token. Returns the new ID token, or null if the
 * session can't be renewed (refresh token expired/revoked) and the user must
 * sign in again.
 */
async function renewAuthToken(): Promise<string | null> {
  const refreshToken = getSetting("cognito_refresh_token");
  if (!refreshToken) return null;

  const platform = readPlatformConfig();
  if (!platform) return null;

  /**
   * ⚠ `cognito-idp`, NOT THE HOSTED UI TOKEN ENDPOINT — the same API the native form's SRP
   * sign-in used. A known blocking concern was exactly this mismatch: a refresh token
   * minted through `cognito-idp` might be refused at `/oauth2/token`, and the old refresher
   * swallowed every failure into `null`, so the symptom would have been "every session dies
   * after 30 minutes" with no diagnosable cause. Refreshing on the minting API removes the
   * question. See cognito-refresh.ts.
   */
  const result = await refreshViaCognitoIdp(platform, refreshToken);
  if (!result.ok) {
    /**
     * ⚠ ONLY A REVOKED TOKEN ENDS THE SESSION. A network failure must NOT: returning null here
     * broadcasts `auth:expired` and sends the user back to sign-in, so treating a dropped wifi
     * connection as a revocation would sign out a whole workshop on one blip. The caller retries
     * on the next request.
     */
    if (result.reason === "network") {
      debugLog("[auth] token renewal deferred — network");
      return getSetting("auth_token");
    }
    return null;
  }

  const tokens = result.tokens;

  /**
   * ── ⚠ THE RENEWED TOKEN MUST NAME THE PERSON WHO SIGNED IN ────────────────────────────────────
   *
   * `auth:completeSignIn` fully admits the ID TOKEN — `iss`, `aud`, `token_use`, `exp`, RS256 signature and
   * the desktop role gate — and the 30-DAY REFRESH TOKEN handed over in the same call got only `typeof ===
   * "string"`, with nothing tying it to the `sub` that had just been verified. Whatever it later produced was
   * installed here as the process-wide bearer with no check at all.
   *
   * ⚠ THE REFRESH GRANT CONSTRAINS NO IDENTITY, which is what makes that exploitable rather than
   * untidy: `refreshViaCognitoIdp` sends only `ClientId` + `REFRESH_TOKEN` (cognito-refresh.ts), so
   * ANY refresh token minted for this app client is accepted — including one belonging to a
   * different participant of the same workshop pool. Renderer-resident code (the actor this file's
   * comments name at the sign-in handler) could therefore complete a legitimate sign-in with the
   * victim's real ID token while substituting somebody else's refresh token: for the ID token's ~30
   * minutes the app is the victim, and from the FIRST RENEWAL onward every authenticated request
   * carries the other identity — while local row scoping stays keyed to the victim's `user_id`, so
   * their work is published under the substituted account.
   *
   * ⚠ WHY `sub` AND NOT A SIGNATURE CHECK. This token arrived in the body of our own TLS response
   * from `cognito-idp`, using the client id out of the platform config this process validated — so
   * `iss`, `aud` and `token_use` are guaranteed by construction and the token is genuine. It is
   * simply possibly SOMEBODY ELSE'S, and only the subject reveals that. Re-fetching JWKS to
   * re-prove what TLS already proved would also add a fail-closed network dependency to a function
   * that deliberately has none — the branch above returns the existing token on a network failure
   * precisely so one dropped connection does not sign out a whole workshop.
   *
   * ⚠ COMPARED AGAINST `active_user_id` FIRST: on a machine with several saved accounts that is the
   * switching key, so it — not `user_id` — is who the session is currently for. When neither is set
   * there is nothing to bind to and the comparison is skipped rather than guessed at.
   */
  const renewedSub = decodeJwtPayload(tokens.idToken).sub;
  const expectedSub = getSetting("active_user_id") || getSetting("user_id") || "";
  if (expectedSub && renewedSub !== expectedSub) {
    console.warn("[auth] refusing a renewed token that names a different subject");
    /**
     * ⚠ THE REFRESH TOKEN IS DISCARDED, not merely this response. It has proven itself to be for
     * another identity and it lives 30 days, so leaving it in place would re-run this refusal on
     * every subsequent request and keep a foreign credential on disk across restarts.
     */
    writeSetting("cognito_refresh_token", "");
    recordSecurityEvent({ event: "auth.renew", outcome: "refused", detail: "subject-mismatch" });
    authToken = null;
    return null;
  }

  authToken = tokens.idToken;
  /**
   * ⚠ A RENEWAL THAT CANNOT BE PERSISTED IS TREATED AS A FAILED RENEWAL, not as a crash.
   *
   * This runs deep inside `fetchAuthed`, on a background sweep and on a WebSocket 401 — none of
   * which has a user in front of it or any way to show a message. Throwing from here would turn a
   * broken keychain into an unhandled rejection in whichever request happened to trigger the
   * refresh. Returning null routes into the caller's existing expiry path, which broadcasts
   * `auth:expired` and sends the user to sign-in, where the refusal above explains itself properly.
   */
  try {
    writeSetting("auth_token", tokens.idToken); // encrypted at rest
  } catch (err) {
    if (err instanceof EncryptionUnavailableError) {
      console.error("[auth] token renewed but cannot be stored encrypted:", err.message);
      recordSecurityEvent({ event: "auth.renew", outcome: "refused", detail: "keychain-unavailable" });
      authToken = null;
      return null;
    }
    throw err;
  }
  // Cognito doesn't rotate the refresh token on this grant, so there's nothing
  // new to persist for it. Keep the active account's saved token current so a
  // switch restores a live session rather than a stale one.
  syncActiveAccountFromSettings();
  return tokens.idToken;
}

/**
 * EA-H6: authenticated fetch that refreshes the token on a 401 and retries once.
 * `build(token)` must construct a fresh request each call (headers include the
 * bearer). On unrecoverable expiry, broadcasts `auth:expired` so the renderer
 * can send the user back to sign-in.
 *
 * Exported so handlers/team-data.ts can make the board/chat/phases requests here
 * in main rather than in the renderer. Main stays
 * the SINGLE token authority — `authToken` above is the only cached bearer and
 * `renewAuthToken` the only refresher — so moving those call sites does not add
 * a second refresh path.
 */
/**
 * Whether the current dead session has already been announced — see `onAuthExpired` below.
 *
 * Module state deliberately, like `authToken` itself: the condition belongs to the process's session, and a
 * per-call flag could not dedupe across the callers that produce the flood.
 */
let authExpiredAnnounced = false;

export function fetchAuthed(build: (token: string) => Promise<Response>): Promise<Response> {
  return fetchWithAuthRetry({
    getToken: () => authToken || getSetting("auth_token"),
    refresh: renewAuthToken,
    doFetch: build,
    onAuthExpired: () => {
      authToken = null;
      /**
       * ── ⚠ ANNOUNCED ON THE EDGE, NOT ON EVERY REQUEST ─────────────────────────────────────
       *
       * `fetchAuthed` wraps EVERY authenticated call, so this fired once per failed request — and the
       * requests are pollers: `chat:getTeamMessages` every 5 seconds, `team:checkAccess`, the board, the
       * phases, plus the startup sync sweep. The renderer's listener shows a toast each time, so one dead
       * session produced an unbounded stream of identical alerts and buried the one that mattered.
       *
       * ⚠ THE SAME SHAPE AS THE AUDIT-LOG FLOOD, and the same answer: the defect is not that the callers
       * poll — they are supposed to — it is that a repeated CONDITION was reported as repeated EVENTS. One
       * transition into "the session is dead" is one event. `noteFailure` in team-data.ts already reached
       * this conclusion for its console lines and dedupes per (channel, reason); this is the broadcast it
       * could not dedupe from over there.
       *
       * Cleared by `adoptSession` and by the teardown, so the NEXT death is announced again — a latch that
       * never reopens would silence the second expiry of a long session.
       */
      if (!authExpiredAnnounced) {
        authExpiredAnnounced = true;
        // Stop every poller and the sweep spending requests on a credential now known not to work.
        markSessionDead();
        broadcast("auth:expired", { reason: "token-refresh-failed" });
      }
    },
  });
}

/**
 * Tear the signed-in session down: stream, cached bearer, cached pool config, rows.
 *
 * ⚠ EXTRACTED SO THERE IS EXACTLY ONE TEARDOWN. A platform change must void the
 * session for the same reason a sign-out does — the stored bearer belongs to one
 * Cognito pool — and a second, hand-rolled copy of this sequence in the platform
 * handler is how one of them silently stops clearing `authToken`. That exact bug
 * already happened once when the wipe lived in the renderer: the settings rows were
 * cleared and main's in-memory bearer was not, so every request after a "sign-out"
 * kept using the signed-out user's live token until the process exited.
 *
 * ⚠ ORDER IS LOAD-BEARING. Stop the event stream FIRST, so its loop cannot observe a
 * half-cleared session and re-broadcast `auth:expired`; then drop the cached bearer;
 * then wipe the rows.
 *
 * The saved `accounts` rows are deliberately kept, so the user can switch back without
 * re-authenticating. `auth:removeAccount` is what forgets an account.
 */
export function tearDownSession(): void {
  stopTeamEventStream();
  authToken = null;
  // The next session gets its own expiry announcement. See `onAuthExpired`.
  authExpiredAnnounced = false;
  markSessionAlive();
  cognitoConfig = null; // next sign-in may target a different server/pool
  for (const key of SIGN_OUT_SETTINGS) {
    writeSetting(key, "");
  }
  try {
    app.setBadgeCount(0);
  } catch {
    /* unsupported platform — ignore */
  }
}

/**
 * Adopt a session obtained OUTSIDE the browser OAuth flow — i.e. from the desktop's own native
 * SRP sign-in form, handed over via `auth:completeSignIn`.
 *
 * ⚠ IT LIVES HERE BECAUSE THIS MODULE OWNS THE BEARER. `authToken` is main's only cached
 * bearer and `renewAuthToken` its only refresher; a credential written from another module
 * would leave the cache and the settings row disagreeing, which is the exact leak the
 * renderer-driven sign-out once had (rows cleared, cache live).
 *
 * ⚠ NO REFRESH TOKEN IS STORED YET, and this is the one loose end. Amplify holds one in the
 * renderer after SRP, but it is deliberately in-memory only (`localStorage` in
 * Electron is unencrypted LevelDB), so it dies with the window. Until renewal is wired through
 * `REFRESH_TOKEN_AUTH` on `cognito-idp` — the same API the sign-in used, so no new grant is
 * needed — a session adopted here lasts the ID token's ~30 minutes.
 */
/**
 * ⚠ SETTLING UNSYNCED TURNS IS PART OF ADOPTING A SESSION (backlog 8f). This is the precise moment the
 * 8f scenario resolves: turns failed because the ID token had expired, and a token now exists again.
 * Scheduling the sweep from anywhere else would either fire without auth or need its own signal for
 * "auth is back", which this function already is.
 */
/**
 * ── ⚠ THE ADMISSION CHECKS EVERY ID TOKEN MUST PASS, IN ONE PLACE ─────────────────────────────
 *
 * Two handlers adopt a session and only one applied the app's own admission rules: `auth:completeSignIn`
 * checked `iss`, `aud`, `token_use`, `exp`, the signature and the desktop role gate; `ai:login` verified the
 * signature and then hand-rolled its persistence.
 *
 * The impact is bounded and worth stating plainly: the token still has to be minted by the configured
 * pool through the PKCE/loopback flow and its signature is verified against that pool's JWKS, so this
 * was never acceptance of a forged token. What it was is a rule enforced on one of two doors — and the
 * role rule is documented in-code as a PRODUCT rule precisely so that nobody later "fixes" the check
 * that looks anomalous by deleting it.
 *
 * ⚠ SO THE FIX IS ONE FUNCTION, NOT A SECOND COPY OF THE CHECKS. A copy is how the two paths drift
 * again; both call this, and a future third adoption path has one obvious thing to call.
 *
 * ⚠ ORDER IS PART OF THE CONTRACT. The claim checks are free and local, so they run first and a
 * wrong-pool or expired token is refused without touching the network. The signature is verified
 * BEFORE the role gate, because `cognito:groups` out of an unverified token is attacker-chosen.
 *
 * @returns the verified claims, or a refusal carrying both the sentence the user sees and the
 *          code-shaped `detail` the audit log records.
 */
async function verifyIdTokenForAdoption(
  idToken: string,
  platform: NonNullable<ReturnType<typeof readPlatformConfig>>
): Promise<
  | { ok: true; claims: Record<string, unknown>; userId: string; email: string; role: string }
  | { ok: false; error: string; detail: string; userId?: string }
> {
  const claims = decodeJwtPayload(idToken);
  const iss = typeof claims.iss === "string" ? claims.iss : "";
  const aud = typeof claims.aud === "string" ? claims.aud : "";
  const tokenUse = typeof claims.token_use === "string" ? claims.token_use : "";
  const exp = typeof claims.exp === "number" ? claims.exp : 0;

  if (iss !== platform.cognito.issuer) {
    // The one that stops a token from somebody else's pool being installed as a session.
    console.warn("[auth] refused a sign-in token whose issuer is not the configured pool");
    return {
      ok: false,
      detail: "issuer-mismatch",
      error: "That session is for a different platform.",
    };
  }
  if (aud !== platform.cognito.clientId) {
    console.warn("[auth] refused a sign-in token issued for a different app client");
    return {
      ok: false,
      detail: "audience-mismatch",
      error: "That session was not issued for this app.",
    };
  }
  if (tokenUse !== "id") {
    return { ok: false, detail: "not-an-id-token", error: "That is not an identity token." };
  }
  if (exp * 1000 <= Date.now()) {
    return {
      ok: false,
      detail: "expired",
      error: "That session has already expired. Please sign in again.",
    };
  }

  /**
   * ⚠ FAIL-CLOSED. A verification that cannot complete — offline, JWKS unreachable, key rotated away
   * — is a refusal, not a pass. Sign-in already requires the network on both paths, so this adds no
   * offline capability that was there before.
   */
  if (!(await hasValidSignature(idToken, platform.cognito.issuer))) {
    console.warn("[auth] refused a sign-in token whose signature did not verify against the pool");
    // ⚠ THE MOST IMPORTANT LINE IN THIS FILE'S AUDIT TRAIL. A signature failure is not a user
    // mistake — it is a token this pool did not issue, i.e. someone trying.
    return {
      ok: false,
      detail: "bad-signature",
      error:
        "That sign-in could not be verified against your platform's sign-in service. Please try again.",
    };
  }

  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const email = typeof claims.email === "string" ? claims.email : "";
  const role = collapseCognitoGroups(claims["cognito:groups"]);

  /**
   * ⚠ THE PRODUCT RULE, APPLIED ON BOTH DOORS NOW. A facilitator or admin gains no privilege by
   * getting in — the desktop calls the same API with the same token — but a rule enforced on one of
   * two sign-in buttons is not enforced, and the asymmetry is what invites its removal.
   */
  if (!canSignInToDesktopApp(role)) {
    console.warn("[auth] refused a desktop sign-in for a role this app is not for", { role });
    return {
      ok: false,
      userId,
      detail: `role-not-permitted:${role}`,
      error:
        "The desktop app is for team members — executives and participants. Your account signs in to the platform in a browser instead.",
    };
  }

  return { ok: true, claims, userId, email, role };
}

/**
 * A sign-in refused because this profile already belongs to somebody else.
 *
 * ⚠ ITS OWN TYPE, SO THE HANDLERS CAN SAY SOMETHING USEFUL. Both sign-in paths already catch
 * `EncryptionUnavailableError` and turn it into a sentence; this is the second such case, and a generic
 * `Error` would reach the user as "Sign in failed" — which for this cause is actively misleading,
 * because nothing is wrong with their password.
 */
export class ForeignIdentityError extends Error {
  constructor() {
    super(
      "This profile is already signed in to a different account. To use another account, " +
        "switch to its profile or create a new one."
    );
    this.name = "ForeignIdentityError";
  }
}

export function adoptSession(session: {
  idToken: string;
  /** Empty when Cognito returned none — the session then lasts one ID-token lifetime. */
  refreshToken?: string;
  userId: string;
  email: string;
  name: string;
}): void {
  /**
   * ── ⚠ CHECKED FIRST, BEFORE A SINGLE WRITE ──
   *
   * The credential writers now REFUSE rather than storing a token in cleartext (database.ts), and a
   * refusal from the middle of this function would be worse than the hole it closes: `user_email`,
   * `user_id` and `connected` would already be persisted, so the app would relaunch believing it is
   * signed in with no bearer to prove it — a state whose only exit is Sign out.
   *
   * So the question is asked once, up front, and the whole adoption either happens or does not.
   * `authToken` is not assigned before it either: an in-memory bearer with no stored counterpart is
   * the same inconsistency one process lifetime later.
   *
   * @throws EncryptionUnavailableError — caught by both sign-in handlers, which turn it into a
   *         sentence the user can act on.
   */
  /**
   * ── ⚠ ONE PROFILE, ONE IDENTITY — REFUSED BEFORE ANYTHING IS WRITTEN ──────────────────────────
   *
   * See `profileIdentity` in accounts.ts for the live state that prompted it — one profile holding three
   * account rows across two identities, on two backends.
   *
   * ⚠ HERE RATHER THAN IN THE TWO HANDLERS, because there are two adoption paths (`auth:completeSignIn`
   * at :835 and `ai:login` at :1053) and a rule enforced at one of two doors is not a rule — the exact
   * shape of half the findings in the last security report. This function is what both call, so a third
   * sign-in path nobody has written yet inherits the check.
   *
   * ⚠ AND IT IS MAIN, NOT THE RENDERER. The UI locks its email field for the same reason, but this
   * codebase treats the renderer document as the adversary — `shared/types/user.ts` puts it plainly for
   * the read-only role: "defense-in-depth, not UI-only". A readonly attribute is a hint; this is the
   * check. The email compared is the one `verifyIdTokenForAdoption` read from a signature-verified
   * token, never a string the renderer typed.
   *
   * ⚠ BEFORE `assertSecretStorageAvailable` AND BEFORE EVERY WRITE, for the reason that check gives
   * about itself: a refusal from the middle of this function leaves `user_email`, `user_id` and
   * `connected` persisted with no bearer, a state whose only exit is Sign out.
   */
  if (isForeignToProfile(session.email)) {
    throw new ForeignIdentityError();
  }

  assertSecretStorageAvailable("your sign-in");

  authToken = session.idToken;
  // A new session may expire in its turn, and that expiry has to be announceable. See `onAuthExpired`.
  authExpiredAnnounced = false;
  markSessionAlive();
  // Cleared so the next renewal re-reads the pool from the platform config just saved, rather
  // than reusing a previous platform's endpoints.
  cognitoConfig = null;

  // Fire-and-forget, delayed: getting the participant into the app comes first.
  scheduleSweep("session-adopted");

  writeSetting("auth_token", session.idToken); // encrypted at rest
  /**
   * ⚠ WRITTEN EVEN WHEN EMPTY, deliberately. A previous platform's refresh token left in place
   * would be sent to the new pool on the first renewal, which fails in a way that reads as "the
   * session expired" rather than "the wrong credential was used".
   */
  writeSetting("cognito_refresh_token", session.refreshToken ?? ""); // encrypted at rest
  writeSetting("user_email", session.email);
  /**
   * ⚠ THE PROFILE'S DURABLE BINDING, which `user_email` above is not: that key is in
   * `SIGN_OUT_SETTINGS` and the `accounts` row a reset deletes, so between them a profile can end up
   * with no record of whose it is while still holding its chats and projects. First writer wins — see
   * `bindProfileIdentity`.
   */
  bindProfileIdentity(session.email);
  writeSetting("user_password", ""); // clear any legacy stored password
  if (session.userId) {
    writeSetting("user_id", session.userId);
    writeSetting("user_name", session.name || "");
    // Remember this account on this machine for multi-user switching.
    upsertActiveAccount({ id: session.userId, email: session.email, name: session.name });
  }
  // The renderer's gate: it reads this to decide whether to show the sign-in screen.
  writeSetting("connected", "true");
}

export function setupAIHandlers() {
  /**
   * ── ACCEPT A SESSION FROM THE NATIVE SIGN-IN FORM ──
   *
   * The renderer did SRP against Cognito and hands over the resulting ID token.
   *
   * ⚠ THE TOKEN IS VERIFIED AGAINST THE CONFIGURED POOL BEFORE IT IS TRUSTED. The renderer is
   * the hostile-adjacent surface — a malicious transitive dependency in the Vite bundle runs
   * there — so "the renderer says this is a valid token" is not a claim main may accept. An
   * unverified token would let anything in that bundle install a session for any identity it
   * liked, including one minted against a pool of its own choosing.
   *
   * What is checked, and why each matters:
   *
   *   iss   must be the CONFIGURED pool. This is the control: a token from an attacker's own
   *         Cognito pool is otherwise perfectly well-formed and correctly signed.
   *   aud   must be our app client, so a token for a different client of the same pool is not
   *         accepted.
   *   exp   must be in the future — an expired token would be stored and then fail on first use.
   *   token_use must be "id": an ACCESS token carries different claims and is not our bearer.
   *
   * ⚠ THE SIGNATURE *IS* NOW CHECKED, BECAUSE THIS TOKEN BECAME AUTHORITATIVE LOCALLY.
   *
   * It used to be skipped, deliberately and with the reasoning written down: verifying needs the
   * pool's JWKS, a fetch and a cache, while the API gateway's JWT authorizer already verifies
   * signature + issuer + audience on EVERY request (`edge-identity.ts`) — so a forged token bought
   * nothing, being stored locally and then rejected by the first real call.
   *
   * That note also named its own expiry condition: *"If this token ever becomes authoritative for a
   * LOCAL decision, that reasoning stops holding and the signature must be checked."* The condition
   * was already met, twice, in this very handler:
   *
   *   • `cognito:groups` drives the desktop role gate below — a decision made entirely locally,
   *     which the gateway never sees.
   *   • `sub` becomes `user_id` / `active_user_id`, the SCOPING KEY for the local `projects` and
   *     `chat_sessions` queries. A forged token installed a local session under any identity and
   *     surfaced another local account's rows.
   *
   * So the signature is verified against the configured pool's JWKS (src/main/jwt-verify.ts),
   * AFTER the cheap claim checks: a token for the wrong pool is refused without a network call.
   */
  ipcMain.handle(
    "auth:completeSignIn",
    async (_event, idToken: unknown, refreshToken?: unknown) => {
    if (typeof idToken !== "string" || !idToken) {
      return { ok: false, error: "No session was provided." };
    }

    const platform = readPlatformConfig();
    if (!platform) {
      return { ok: false, error: "This app isn't connected to a platform yet." };
    }

    /**
     * ⚠ ONE AUTHORITY FOR THE ADMISSION CHECKS. `iss`, `aud`, `token_use`, `exp`, the signature and
     * the desktop role gate all live in `verifyIdTokenForAdoption` now, because the OTHER adoption
     * path (`ai:login`) applied only some of them — see the note on that function. The long
     * explanations of each check moved there with it.
     */
    const verified = await verifyIdTokenForAdoption(idToken, platform);
    if (!verified.ok) {
      recordSecurityEvent({
        event: "auth.signin",
        outcome: "refused",
        ...(verified.userId ? { userId: verified.userId } : {}),
        detail: verified.detail,
      });
      return { ok: false, error: verified.error };
    }

    const { userId, email } = verified;
    if (!userId) {
      return { ok: false, error: "That session carries no user identity." };
    }

    /**
     * The display name comes from the PLATFORM PROFILE, not from Cognito.
     *
     * This pool has `UsernameAttributes: [email]`, so `cognito:username` IS the generated UUID
     * and users carry no `name` attribute at all — a chain that fell through to it once
     * displayed `5458c448-8071-…` as somebody's name. Best-effort: a failure must not block a
     * sign-in that has already succeeded, so it degrades to the email.
     */
    let name = email;
    try {
      const res = await fetch(`${platform.apiBaseUrl}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${idToken}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = (await res.json()) as { user?: { name?: unknown } };
        const profileName = typeof body.user?.name === "string" ? body.user.name.trim() : "";
        if (profileName) name = profileName;
      }
    } catch {
      // Expected degradation (offline, profile not yet created), not an error worth logging.
    }

    /**
     * ⚠ THE ONE THROW THIS HANDLER EXPECTS, AND IT MUST NOT REACH THE RENDERER AS A REJECTION.
     *
     * `adoptSession` now refuses when secrets cannot be encrypted (database.ts). An uncaught throw
     * would surface as a raw IPC rejection — "Error invoking remote method 'auth:completeSignIn'" —
     * which tells the participant nothing and looks like a crash. Caught here, it becomes a sentence
     * and, crucially, a sign-in that did NOT half-happen.
     */
    try {
      adoptSession({
        idToken,
        // Optional: a sign-in that succeeded must not be rejected for its absence. Without it the
        // session lasts the ID token's ~30 minutes and then requires a fresh sign-in.
        refreshToken: typeof refreshToken === "string" ? refreshToken : "",
        userId,
        email,
        name,
      });
    } catch (err) {
      if (err instanceof EncryptionUnavailableError) {
        console.error("[auth] refusing to store a session unencrypted:", err.message);
        recordSecurityEvent({
          event: "auth.signin",
          outcome: "refused",
          userId,
          detail: "keychain-unavailable",
        });
        return { ok: false, error: KEYCHAIN_REFUSAL_MESSAGE };
      }
      /**
       * ⚠ THE SECOND EXPECTED THROW, AND IT IS AUDITED. The refusal is the whole point of the feature,
       * so a record of it is what lets somebody answer "why did my sign-in not take" afterwards — and
       * `foreign-identity` names the cause without putting either address in the log, which
       * security-audit.ts forbids for `detail`.
       */
      if (err instanceof ForeignIdentityError) {
        recordSecurityEvent({
          event: "auth.signin",
          outcome: "refused",
          userId,
          detail: "foreign-identity",
        });
        return { ok: false, error: err.message, foreignIdentity: true as const };
      }
      throw err;
    }
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId, detail: "browser-handoff" });
    return { ok: true, user: { id: userId, email, name } };
    }
  );

  // Sign in via the native Cognito Hosted UI (OAuth2 code + PKCE over a loopback
  // redirect). The desktop takes no email/password — Cognito owns credentials + MFA.
  // The API bearer is the Cognito ID token; the refresh token renews it without
  // re-prompting.
  ipcMain.handle(
    "ai:login",
    async (_event, params: { loginHint?: string } = {}) => {
      /**
       * 1. The CONFIGURED platform. Not a parameter and not `/v1/auth/config` any
       *    more: the pool comes from the config the user set up and this process
       *    already VALIDATED (platform-config.ts — Cognito-owned Hosted UI host,
       *    Cognito-shaped issuer). Reading it from the API here instead would mean
       *    the validated value is not the one we authenticate against, which is the
       *    whole point of validating it.
       */
      const platform = readPlatformConfig();
      if (!platform) {
        return {
          ok: false,
          needsPlatformConfig: true,
          error: "Set your platform URL before signing in.",
        };
      }
      const url = platform.apiBaseUrl;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const probe = await fetch(`${url}/v1/auth/config`, { signal: controller.signal });
        if (!probe.ok) {
          return { ok: false, error: `Server responded with HTTP ${probe.status}` };
        }
      } catch (err) {
        const aborted = err instanceof Error && err.name === "AbortError";
        // The URL IS the user's to change again, so pointing at it is help rather
        // than misdirection — but it names the platform, not a raw API origin.
        return {
          ok: false,
          error: aborted
            ? `${platform.apiBaseUrl} timed out. Check your connection and try again.`
            : `Cannot reach ${platform.apiBaseUrl}. Check your connection, or paste a fresh connect string in Account.`,
        };
      } finally {
        clearTimeout(timeout);
      }

      /**
       * 3. The pool config, from the validated platform config.
       *
       * Reset the cache first: a previous sign-in on this process may have cached a
       * DIFFERENT platform's pool, and authenticating against a stale one would send the
       * user to the wrong Hosted UI. `tearDownSession` clears it on a platform change,
       * but clearing it here too makes the login path correct on its own rather than
       * dependent on another function having run.
       */
      cognitoConfig = null;
      const cfg = getCognitoConfig();
      if (!cfg) {
        return {
          ok: false,
          needsPlatformConfig: true,
          error: "Set your platform URL before signing in.",
        };
      }

      // 4. Run the Hosted UI flow in the system browser. Resolves with tokens.
      let tokens;
      try {
        tokens = await loginWithHostedUi(cfg, params.loginHint?.trim() || undefined);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Sign-in failed" };
      }

      /**
       * 5. Derive identity from the ID token's claims.
       *
       * ⚠ THE SIGNATURE IS VERIFIED HERE TOO, and the asymmetry it removes is the point.
       *
       * This path's trust chain is genuinely different from `auth:completeSignIn`'s: main itself
       * obtained the token over TLS from the `cognito_token_endpoint` in the validated platform
       * config, so it never passed through the renderer. On that basis the check was deferred.
       *
       * But it writes `user_id` from `sub`, and `user_id` is the SCOPING KEY for the local `projects`
       * and `chat_sessions` queries — the same reason the other path needed verifying. `hasValidSignature`
       * exists now and its key set is cached, so the cost is one `await`, and leaving one adoption path
       * unverified is an inconsistency the next reader has to re-derive rather than a decision.
       */
      /**
       * ⚠ THE SAME ADMISSION CHECKS AS `auth:completeSignIn`, FROM THE SAME FUNCTION.
       *
       * This path verified the signature and stopped there: no `token_use`, no `aud`, no `exp`, and no role
       * gate — so an ADMIN/FACILITATOR/JUDGE token completed a desktop sign-in that `DESKTOP_APP_ROLES`
       * excludes.
       *
       * ⚠ AND I ARGUED AGAINST THE ROLE GATE HERE, WHICH WAS WRONG. My reasoning was that nothing
       * downstream reads the role, so a facilitator who got in gains no privilege. That is still true
       * and it was never the point: it is a PRODUCT rule about which accounts this app serves, and a
       * rule enforced on one of two doors is not enforced. Two sign-in buttons behaving differently is
       * also exactly the asymmetry that later gets "fixed" by deleting whichever check looks anomalous.
       *
       * ⚠ `platform` RATHER THAN `cfg`, because the shared checks compare `aud` against the configured
       * app client and `iss` against the configured issuer — both of which live on the validated
       * platform config. `cfg` carries the same issuer; using the config keeps ONE source for both.
       */
      const verified = await verifyIdTokenForAdoption(tokens.idToken, platform);
      if (!verified.ok) {
        recordSecurityEvent({
          event: "auth.signin",
          outcome: "refused",
          ...(verified.userId ? { userId: verified.userId } : {}),
          detail: verified.detail,
        });
        return { ok: false, error: verified.error };
      }
      const { userId, email } = verified;

      // The display name comes from the PLATFORM PROFILE, not from Cognito.
      //
      // This pool has `UsernameAttributes: [email]`, so Cognito's `Username` is the
      // generated UUID and equals `sub` — and users carry no `name` attribute at
      // all (verified against the live pool). The old chain fell through
      // claims.name -> claims["cognito:username"] -> email, so it landed on the
      // UUID and the app displayed `5458c448-8071-...` as the user's name. The
      // email fallback was unreachable.
      //
      // The real name lives in the identity service's profile row, derived from
      // firstName/lastName (identity/src/routes.ts:152). GET /v1/auth/me returns
      // it, so ask for it once here. Best-effort by design: a failure must not
      // block a sign-in that has already succeeded, so it degrades to the email —
      // a human-readable identifier, never the UUID.
      let name = email;
      try {
        const meController = new AbortController();
        const meTimeout = setTimeout(() => meController.abort(), 4000);
        try {
          const meRes = await fetch(`${url}/v1/auth/me`, {
            headers: { Authorization: `Bearer ${tokens.idToken}` },
            signal: meController.signal,
          });
          if (meRes.ok) {
            const body = (await meRes.json()) as { user?: { name?: unknown } };
            const profileName =
              typeof body.user?.name === "string" ? body.user.name.trim() : "";
            if (profileName) name = profileName;
          }
        } finally {
          clearTimeout(meTimeout);
        }
      } catch {
        // Keep the email fallback. Logged nowhere on purpose: this is an expected
        // degradation (offline, profile not yet created), not an error worth noise.
      }

      /**
       * 6. Adopt the session — THROUGH `adoptSession`, not by hand.
       *
       * This block used to write `auth_token`, `cognito_refresh_token`, `user_email`, `user_id` and
       * `user_name` itself and call `upsertActiveAccount` directly, which meant it skipped every invariant
       * that function owns:
       *
       *   • `connected = "true"` — the renderer's own gate. So this path left credentials on disk in
       *     a state the UI does not recognise as signed in.
       *   • `cognitoConfig = null` — without it the next renewal can reuse a previous platform's
       *     endpoints.
       *   • `scheduleSweep("session-adopted")` — the unsynced-turn backlog is never settled.
       *
       * ⚠ `server_url` IS STILL NOT WRITTEN, and `adoptSession` does not write it either. It is the
       * platform config's key, written in one transaction with the fingerprint that describes it;
       * writing it from a sign-in would leave the origin and the fingerprint naming different
       * platforms, which is the state the drift check reads to decide whether to sign the user out.
       */
      if (!userId) {
        return { ok: false, error: "That session carries no user identity." };
      }

      try {
        adoptSession({
          idToken: tokens.idToken,
          refreshToken: tokens.refreshToken,
          userId,
          email,
          name,
        });
      } catch (err) {
        if (err instanceof EncryptionUnavailableError) {
          console.error("[auth] refusing to store a session unencrypted:", err.message);
          recordSecurityEvent({
            event: "auth.signin",
            outcome: "refused",
            userId,
            detail: "keychain-unavailable",
          });
          return { ok: false, error: KEYCHAIN_REFUSAL_MESSAGE };
        }
        // The same refusal as the SRP path — see the note there. Both doors, or it is not a rule.
        if (err instanceof ForeignIdentityError) {
          recordSecurityEvent({
            event: "auth.signin",
            outcome: "refused",
            userId,
            detail: "foreign-identity",
          });
          return { ok: false, error: err.message, foreignIdentity: true as const };
        }
        throw err;
      }

      recordSecurityEvent({ event: "auth.signin", outcome: "success", userId, detail: "hosted-ui" });
      return { ok: true, user: { id: userId, email, name } };
    }
  );

  // Registration is invite-only and enforced server-side (identity service). The
  // desktop app is sign-in only — accounts are created from the emailed invite
  // link — so there is no "ai:register" handler here anymore.

  ipcMain.handle("ai:joinTeam", async (_event, inviteCode: string) => {
    const url = getServerUrl();

    const res = await fetchAuthed((token) =>
      fetch(`${url}/v1/teams/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ inviteCode }),
      })
    );

    const data = await res.json();
    if (!res.ok) {
      return { error: data.error || "Failed to join team" };
    }

    const team = data.team;
    /**
     * ⚠ THE INVITE CODE IS WRITTEN HERE TOO NOW. The renderer used to write it alongside the ids it
     * also wrote; with the tenant keys off the write allowlist (setting-access.ts) main owns all four,
     * and they must be written TOGETHER — a `team_id` without its `team_invite_code` is a team the
     * Account panel cannot describe, and the four rows are one fact.
     */
    writeTeamContext({
      id: team.id,
      name: team.name,
      workshopId: team.workshopId,
      inviteCode: typeof team.inviteCode === "string" ? team.inviteCode : inviteCode,
    });

    return { teamId: team.id, teamName: team.name };
  });

  /**
   * ── ⚠ ENTER A TEAM THIS USER ALREADY BELONGS TO ────────────────────────────────────────────
   *
   * `team_id` and `workshop_id` were on the renderer's WRITE allowlist, so `JoinTeamView` set them directly
   * when the participant picked one of their teams. That made the tenant key client-controlled: any code in
   * the renderer bundle could re-point every team-scoped request — including `share:shareSession`, which
   * publishes a private local transcript — at a team the user never selected, and overwrite the value
   * `ai:joinTeam` had established only after a server-verified join.
   *
   * ⚠ THE MEMBERSHIP IS RE-CHECKED AGAINST THE SERVER, not taken from the caller. `/v1/teams/mine` is
   * answered for the BEARER, so the id has to appear in a list the server produced for this user —
   * which is the control the client was missing entirely. The name and workshop id come from that
   * response as well, so a caller cannot mislabel a team it does have access to either.
   *
   * ⚠ AND `team_joined` STAYS WRITABLE. It is a screen-gating flag, not a tenant key: writing it
   * chooses which view renders, and the worst a renderer achieves by forging it is showing itself the
   * wrong screen. Kept on the allowlist deliberately rather than by omission.
   */
  ipcMain.handle("ai:selectTeam", async (_event, teamId: unknown) => {
    if (typeof teamId !== "string" || !teamId.trim()) {
      return { ok: false as const, error: "No team given" };
    }

    const url = getSetting("server_url");
    if (!url) return { ok: false as const, error: "Not connected to server" };

    let teams: Array<{ id?: unknown; name?: unknown; workshopId?: unknown; inviteCode?: unknown }>;
    try {
      const res = await fetchAuthed((token) =>
        fetch(`${url}/v1/teams/mine`, { headers: { Authorization: `Bearer ${token}` } })
      );
      if (!res.ok) return { ok: false as const, error: `Could not confirm your teams (HTTP ${res.status})` };
      const data = await res.json();
      teams = Array.isArray(data.teams) ? data.teams : [];
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Could not confirm your teams",
      };
    }

    const team = teams.find((t) => t && t.id === teamId);
    if (!team) {
      /* ⚠ ONE MESSAGE FOR "NOT A MEMBER" AND "NO SUCH TEAM" — a caller must not learn which. */
      recordSecurityEvent({ event: "auth.signin", outcome: "refused", detail: "team-not-a-member" });
      return { ok: false as const, error: "You are not a member of that team" };
    }

    writeTeamContext({
      id: teamId,
      name: typeof team.name === "string" ? team.name : "",
      workshopId: typeof team.workshopId === "string" ? team.workshopId : null,
      inviteCode: typeof team.inviteCode === "string" ? team.inviteCode : null,
    });

    return { ok: true as const, teamId, teamName: typeof team.name === "string" ? team.name : "" };
  });

  // Teams the user has already joined — backs the desktop "My Teams" view.
  ipcMain.handle("ai:getMyTeams", async () => {
    const url = getSetting("server_url");
    if (!url) return { teams: [] };
    try {
      const res = await fetchAuthed((token) =>
        fetch(`${url}/v1/teams/mine`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      if (!res.ok) return { teams: [] };
      const data = await res.json();
      return { teams: Array.isArray(data.teams) ? data.teams : [] };
    } catch {
      return { teams: [] };
    }
  });

  // Which AI assistants the facilitator enabled for this workshop. Falls back
  // to all assistants if unknown/unreachable so the app never locks itself out.
  ipcMain.handle("ai:getEnabledAssistants", async () => {
    const ALL = ["claude", "kiro", "codex"];
    const workshopId = getSetting("workshop_id");
    if (!workshopId) return { enabledAssistants: ALL };

    try {
      const url = getServerUrl();
      const res = await fetchAuthed((token) =>
        /**
         * ── ⚠ EVERY INTERPOLATED SEGMENT IS ENCODED ─────────────────────────────────────────
         *
         * Main is deliberately the ONLY holder of the bearer: `auth_token` is on neither settings allowlist,
         * no IPC response returns it, and `fetchAuthed` is the single place it is attached. The renderer is
         * therefore meant to reach only the endpoints main chooses to expose — and an unencoded id defeated
         * that, because `fetch` hands the string to the WHATWG URL parser, which collapses `..` and honours
         * `?`:
         *
         *     workshop_id = "x/../../../v1/auth/me?z="
         *       →  GET https://api…/v1/auth/me   with the victim's bearer attached
         *
         * `handlers/team-data.ts` has always wrapped every segment; these sites did not.
         * `encodeURIComponent` is the fix for the URL, and row-id.ts refuses a path-shaped id where
         * it is stored — see there for why both, rather than either.
         */
        fetch(`${url}/v1/workshops/${encodeURIComponent(workshopId)}/assistants`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      if (!res.ok) return { enabledAssistants: ALL };
      const data = await res.json();
      const list = Array.isArray(data.enabledAssistants) ? data.enabledAssistants : ALL;
      return { enabledAssistants: list.length > 0 ? list : ALL };
    } catch {
      return { enabledAssistants: ALL };
    }
  });

  /**
   * ── `ai:stream` REMOVED ──
   *
   * It POSTed a prompt to `/v1/ai/threads/:id/messages`, which invoked Bedrock server-side, and it
   * was bridged to the renderer as `api.aiStream` / `onStreamChunk` / `onStreamDone`. NOTHING in the
   * renderer ever called any of the three — verified by grep across the whole UI before removal.
   *
   * The service route it depended on now answers 410: this app records the participant's own local
   * CLI turns via `/sync` (see cli-assistant.ts and kiro-acp.ts), which is the whole design — their
   * assistant, their subscription, our transcript. A bridge that can spend money and has no caller
   * is a liability with no offsetting value.
   */

  ipcMain.handle("ai:getProviders", async () => {
    const connected = getSetting("connected");
    return connected === "true" ? [{ provider: "server", configured: true }] : [];
  });

  // ── Share AI chat with the team ────────────────────────────────────────────
  // A chat lives only in local SQLite until the user explicitly shares it. Share
  // pushes the local transcript to the backend and flags the thread `shared` so
  // it appears in teammates' "Team Chats" list. The local session id is reused
  // as the server thread id (same convention as syncToServer()).
  ipcMain.handle("share:shareSession", async (_event, sessionId: string) => {
    const url = getSetting("server_url");
    const teamId = getSetting("team_id");
    if (!url) return { ok: false, error: "Not connected to server" };
    if (!teamId) return { ok: false, error: "Join a team before sharing a chat" };

    const db = getDb();
    /**
     * ── ⚠ THE OWNER PREDICATE IS WHAT MAKES THIS A SHARE AND NOT A LEAK ──────────────────────
     *
     * This lookup was `WHERE id = ?` alone. Multi-account switching on one profile is a first-class feature
     * here, so account B could name account A's session id and this handler would read A's ENTIRE PRIVATE
     * TRANSCRIPT and POST it to B's team, with B's bearer — a request the server cannot distinguish from a
     * legitimate share by a member of that team.
     *
     * ⚠ AND THE REFUSAL IS THE EXISTING "Chat not found". A miss and a foreign row are the same
     * answer on purpose: a caller must not be able to use this channel to learn which session ids
     * exist under another account.
     */
    const userId = activeUserId();
    const session = db
      .prepare("SELECT id, title, ai_provider FROM chat_sessions WHERE id = ? AND user_id IS ?")
      .get(sessionId, userId) as { id: string; title: string | null; ai_provider: string } | undefined;
    if (!session) return { ok: false, error: "Chat not found" };

    const rows = db
      .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as { role: string; content: string }[];
    // Only the AI conversation is shared — system lines are local UI artifacts.
    const messages = rows.filter((m) => m.role === "user" || m.role === "assistant");

    try {
      const res = await fetchAuthed((token) =>
        // Segments encoded for the reason written out at `ai:getEnabledAssistants` above.
        fetch(`${url}/v1/ai/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(sessionId)}/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            title: session.title || "Chat",
            aiProvider: session.ai_provider || "claude",
            messages,
          }),
        })
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.error || `Share failed (HTTP ${res.status})` };
      }
      const sharedAt = new Date().toISOString();
      // Same predicate as the lookup: the flag belongs to the row this account owns.
      db.prepare("UPDATE chat_sessions SET shared_at = ? WHERE id = ? AND user_id IS ?").run(
        sharedAt,
        sessionId,
        userId
      );
      recordSecurityEvent({
        event: "chat.share",
        outcome: "success",
        ...(userId ? { userId } : {}),
        detail: `shared:${messages.length}-messages`,
      });
      return { ok: true, sharedAt };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Share failed" };
    }
  });

  ipcMain.handle("share:unshareSession", async (_event, sessionId: string) => {
    const url = getSetting("server_url");
    const teamId = getSetting("team_id");
    if (!url || !teamId) return { ok: false, error: "Not connected" };

    /**
     * ── ⚠ THE OWNER LOOKUP BEFORE THE NETWORK CALL, LIKE BOTH SIBLINGS ───────────────────────
     *
     * The config checks above were the whole of it: this then POSTed to
     * `/v1/ai/teams/{teamId}/threads/{sessionId}/unshare` with the user's bearer for whatever id the renderer
     * passed.
     *
     * ⚠ AND THE IDS ARE HANDED OUT, so this is not a guessing game. `share:getSharedThreads` below
     * returns the team's shared thread ids to the renderer verbatim, and those entries are other
     * participants' local session ids by design — so renderer-resident code can enumerate the team's
     * shared chats and attempt to retract each one in turn.
     *
     * ⚠ BOTH SIBLINGS ON THIS SURFACE ALREADY REFUSE TO DO THIS, and one of them says why in a
     * sentence worth repeating: it "stops the desktop from being the component that makes an unscoped
     * authenticated request on a caller's word" (`share:getSharedMessages`). `share:shareSession`
     * binds `id = ? AND user_id IS ?` before its POST. This was the third of three, written the loose
     * way.
     *
     * ⚠ THE SAME "Chat not found" THE SHARE PATH USES, deliberately: a miss and a foreign row must be
     * one answer, or the refusal becomes a way to learn which session ids exist under other accounts.
     *
     * What this does NOT establish is whether the platform API would have refused the retraction
     * itself — that service is not in this repository, so the cross-tenant effect stays unproven. The
     * desktop-side defect is not: an authenticated write issued on the caller's word, on the one
     * channel of three that did not check.
     */
    if (!isSessionOwnedByActiveAccount(sessionId)) return { ok: false, error: "Chat not found" };

    try {
      const res = await fetchAuthed((token) =>
        fetch(`${url}/v1/ai/teams/${encodeURIComponent(teamId)}/threads/${encodeURIComponent(sessionId)}/unshare`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { ok: false, error: data.error || `Unshare failed (HTTP ${res.status})` };
      }
      // Owner-scoped for the same reason as the share above.
      getDb()
        .prepare("UPDATE chat_sessions SET shared_at = NULL WHERE id = ? AND user_id IS ?")
        .run(sessionId, activeUserId());
      /**
       * ⚠ THE SUBJECT, WHICH THE `shared` RECORD TWO SCREENS UP ALREADY CARRIED. Withdrawing a
       * transcript from the team is as much a decision as publishing it, and an unattributed
       * withdrawal is the half an investigator would actually be asking about.
       */
      recordSecurityEvent({
        event: "chat.share",
        outcome: "success",
        userId: activeUserId() ?? undefined,
        detail: "unshared",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unshare failed" };
    }
  });

  /**
   * The chats shared with the CURRENT team.
   *
   * ⚠ EXTRACTED SO `share:getSharedMessages` CAN USE IT AS ITS SCOPE CHECK — see below.
   */
  async function sharedThreadsForTeam(): Promise<Array<{ id?: unknown; sharedById?: unknown }>> {
    const url = getSetting("server_url");
    const teamId = getSetting("team_id");
    if (!url || !teamId) return [];

    try {
      const res = await fetchAuthed((token) =>
        fetch(`${url}/v1/ai/teams/${encodeURIComponent(teamId)}/threads?shared=true`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.threads) ? data.threads : [];
    } catch {
      return [];
    }
  }

  // List chats OTHER teammates have shared with the team.
  //
  // ⚠ YOUR OWN SHARED CHATS ARE FILTERED OUT HERE. The server returns every shared thread for the team
  // (including ones this account shared), and the Team Chats list is for reading what OTHERS are doing —
  // seeing your own chat echoed back there is noise, and you already have it under "Chats". The thread
  // rows carry `sharedById` from the service (see cli-sync.ts / services/ai routes), so a thread is
  // "mine" when its `sharedById` equals the active local account.
  //
  // ⚠ ONLY THE LIST IS FILTERED, NOT `sharedThreadsForTeam` ITSELF, which is also the scope check for
  // `share:getSharedMessages`. Narrowing that would make your own thread unreadable rather than merely
  // unlisted; the list is the right place for a presentation choice. The decision is `excludeOwnThreads`
  // (pure, tested) rather than inlined, so the "mine" rule can be asserted without an IPC harness.
  ipcMain.handle("share:getSharedThreads", async () => {
    const threads = await sharedThreadsForTeam();
    return { threads: excludeOwnThreads(threads, activeUserId()) };
  });

  /**
   * Read-only transcript for a shared chat (used by the Team Chats viewer).
   *
   * ── ⚠ SCOPED TO THE TEAM, RATHER THAN TRUSTING THE THREAD ID ────────────────────────────────
   *
   * This was the one read path in the app that carried NO TENANT SCOPE AT ALL: it fetched
   * `/v1/ai/threads/{threadId}/messages` with main's bearer for whatever id the renderer passed, with no team
   * segment and no local membership check. Combined with the tenant key having been renderer-writable, the
   * client contributed nothing of its own to isolation on this path.
   *
   * ⚠ THE THREAD MUST APPEAR IN THIS TEAM'S SHARED LIST, which is the check rather than a team segment
   * in the URL: `/v1/ai/threads/:id/messages` is the endpoint the platform actually exposes, and
   * inventing a team-scoped one here would be a guess about a service this repository cannot see. The
   * shared list IS server-produced and team-scoped, so requiring the id to be in it re-uses the
   * server's own answer instead of asking it to trust ours.
   *
   * ⚠ AND THE SERVER REMAINS THE AUTHORIZATION POINT. This does not replace it; it stops the desktop
   * from being the component that makes an unscoped authenticated request on a caller's word.
   */
  ipcMain.handle(
    "share:getSharedMessages",
    async (
      _event,
      threadId: string,
      opts?: { since?: string; before?: string; limit?: number }
    ) => {
      const url = getSetting("server_url");
      if (!url) return { messages: [] };
      if (!isSafeRowId(threadId)) return { messages: [] };

      const shared = await sharedThreadsForTeam();
      if (!shared.some((t) => t && t.id === threadId)) {
        /* Empty rather than an error: to the viewer this is a chat that is no longer shared. */
        return { messages: [] };
      }

      /**
       * ── BOUNDED READS, FORWARDED TO THE SERVICE ─────────────────────────────────────────────
       * A multi-day shared thread is large, so the renderer asks for only what it needs:
       *   · { since } — the incremental tail for the live pinned-pane refresh.
       *   · { limit, before? } — one newest-first page for scroll-up pagination.
       *   · neither — the whole thread (unchanged), still used where a full read is wanted.
       * The query params match the AI service's `GET .../messages` contract. `nextBefore` is passed
       * straight back for the paginated case so the renderer can request the next older page.
       */
      const qs = new URLSearchParams();
      if (opts?.since) qs.set("since", opts.since);
      else if (opts?.limit) {
        qs.set("limit", String(opts.limit));
        if (opts.before) qs.set("before", opts.before);
      }
      // Built as its own string so the `/v1/` literal interpolates only `encodeURIComponent(threadId)`
      // and a bare `qs.toString()` (an already-encoded query, no path text) — see api-url-encoding.test.
      const query = qs.toString() ? `?${qs.toString()}` : "";

      try {
        const res = await fetchAuthed((token) =>
          fetch(`${url}/v1/ai/threads/${encodeURIComponent(threadId)}/messages${query}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        );
        if (!res.ok) return { messages: [] };
        const data = await res.json();
        return {
          messages: Array.isArray(data.messages) ? data.messages : [],
          // Present only for the paginated shape; undefined otherwise, which the renderer treats as
          // "no older page to fetch".
          nextBefore: typeof data.nextBefore === "string" ? data.nextBefore : null,
        };
      } catch {
        return { messages: [] };
      }
    }
  );

  // Renew the session token. Returns only whether the session is alive — NEVER
  // the token itself: the renewed ID token is stored
  // encrypted and used by main's own authed fetches, and no renderer code needs a
  // bearer any more now that the board/chat/phases requests run in main. `false`
  // means the session can't be renewed and the user must sign in again.
  ipcMain.handle("ai:renewToken", async () => {
    const token = await renewAuthToken();
    return { ok: token != null };
  });

  // ── Multi-user local login (account switching) ──────────────────────────────
  // List the accounts remembered on this machine (no tokens exposed).
  ipcMain.handle("auth:listAccounts", async () => {
    return listAccounts();
  });

  /**
   * How many identities this profile already belongs to, and the address when there is exactly one.
   *
   * ⚠ A COUNT AND AT MOST ONE ADDRESS, because that is what the UI needs — see `profileIdentity` in
   * accounts.ts for why this is no longer justified as withholding. The model is that this
   * machine has one user with several addresses, one per experience or team, so the shared-machine
   * disclosure that removed the account switcher does not apply here.
   */
  ipcMain.handle("auth:profileIdentity", async () => {
    return profileIdentity();
  });

  // Switch to a saved account: restore its session, reset the cached token, and
  // reconnect the team event stream for the new team.
  ipcMain.handle("auth:switchAccount", async (_event, accountId: string) => {
    /**
     * ── ⚠ THE AUDITED SUBJECT IS VALIDATED BEFORE IT IS AUDITED ───────────────────────────────
     *
     * `userId: accountId` came straight from the renderer with no shape check, and the record was
     * written EVEN WHEN THE ID MATCHED NO ACCOUNT — `switchAccount` returns "Account not found" before
     * touching any state, and this handler appended a `refused` record carrying the caller's chosen
     * string anyway. So renderer-resident code could plant `account.switch` records naming any identity
     * it liked, corrupting the only local answer to "who signed in on this machine".
     *
     * ⚠ REFUSED BEFORE ANY WORK, AND WITHOUT A RECORD. This is the fix for the second half of the
     * finding as much as the first: an id that is not even shaped like one names no account, so there is
     * no subject to attribute the event to — and recording it would be recording the attacker's string.
     * `isSafeRowId` is the convention this codebase already uses at every other renderer entry point
     * that takes an id (handlers/db.ts, share:getSharedMessages).
     *
     * ⚠ AND ~2000 CONSEQUENCE-FREE CALLS USED TO ROTATE GENUINE HISTORY OUT. The bound was chosen on the
     * stated assumption that these events are human-paced; two channels that each emitted one record per
     * call with no side effect broke that, and `rotateIfNeeded` re-chains the survivors so
     * `verifyAuditChain` still reports clean. Bounding what a caller can emit is the durable fix, and
     * this is most of it: a malformed id now costs nothing at all, and a well-formed one that names no
     * account is handled below.
     */
    if (!isSafeRowId(accountId)) return { ok: false as const, error: "Account not found" };

    /**
     * ── ⚠ AN ID THAT NAMES NO ACCOUNT PRODUCES NO RECORD ──────────────────────────────────────
     *
     * The third half of the same finding: ~2000 consequence-free calls used to push all genuine history
     * (`auth.signin`, `platform.connect`, `chat.share`, `file.mutate`, `docs.change`) out of the
     * rotation window, and `rotateIfNeeded` re-chains the survivors so `verifyAuditChain` still reports
     * clean. The bound was chosen on the stated assumption that these events are human-paced — "the
     * bound only ever fires on a machine doing something unusual" — and a channel that emits a record
     * per call with no side effect breaks exactly that assumption.
     *
     * `switchAccount` returns before touching any state for an unknown id, so nothing happens. Refusing
     * here, without a record, makes the flood cost ZERO records rather than one per call — which is a
     * more durable answer than a rate limiter, because it removes the primitive instead of throttling it.
     *
     * ⚠ THE TRADE, STATED. This loses one signal: "somebody called this channel with a well-formed id
     * that matches no account". That signal is worth less than the log it was destroying, and the module
     * header already concedes the log is "tamper-evident, not tamper-proof". A refusal for an account
     * that DOES exist — wrong platform, no keychain — is still recorded below, with its subject, and
     * that is the refusal a reader actually investigates.
     */
    const known = listAccounts().accounts.some((a) => a.id === accountId);
    if (!known) return { ok: false as const, error: "Account not found" };

    const result = switchAccount(accountId);
    /**
     * ⚠ THE SUBJECT IS THE RESOLVED ACCOUNT, OR THERE IS NO SUBJECT. On success the id named a real row,
     * so it is the account's own id and attributing the event to it is correct. On a refusal the app
     * never resolved anybody — recording the caller's string would let a chosen identity into the log
     * for an event that did not happen to them.
     *
     * The event is still recorded, because a refused switch is worth seeing; it simply names no subject.
     */
    recordSecurityEvent({
      event: "account.switch",
      outcome: result.ok ? "success" : "refused",
      ...(result.ok ? { userId: accountId } : {}),
      // The refusal reason is this app's own short string (wrong platform, no keychain); the
      // message itself is not recorded, since it can contain a platform URL.
      ...(result.ok ? {} : { detail: "refused" }),
    });
    if (result.ok) {
      // Drop the cached token so subsequent requests read the switched account's
      // token from settings, and reconnect the event stream for its team.
      authToken = getSetting("auth_token");
      stopTeamEventStream();
      if (result.teamJoined) startTeamEventStream();
    }
    return result;
  });

  // Forget a saved account. If it was the active one, the renderer signs out.
  ipcMain.handle("auth:removeAccount", async (_event, accountId: string) => {
    // Both gates from `auth:switchAccount`, same finding — see the notes there.
    if (!isSafeRowId(accountId)) return { ok: false };
    if (!listAccounts().accounts.some((a) => a.id === accountId)) return { ok: false };

    const result = await removeAccount(accountId);
    /**
     * Deleting a stored credential is a security event in its own right, whoever asked for it — and
     * the DETAIL now says whether the credential is dead at Cognito or merely gone from this disk.
     * This used to be a bare local delete, so "the account was
     * removed" was all a reader could ever learn, and a token copied off the machine beforehand kept
     * working for the rest of its 30-day life with nothing recording that.
     */
    recordSecurityEvent({
      event: "account.remove",
      outcome: result.ok ? "success" : "failure",
      userId: accountId,
      detail: result.revocation,
    });
    return { ok: result.ok };
  });

  // Sign out: tear down the session HERE rather than in the renderer.
  //
  // This used to be thirteen `setSetting(key, "")` calls from SettingsView, three
  // of them on credential keys — which meant the db:setSetting allowlist would
  // have had to leave the renderer write access to `auth_token` and
  // `cognito_refresh_token` for sign-out to keep working. Owning it here removes
  // that carve-out entirely.
  //
  // It also fixes a real leak the renderer-driven version had: clearing the
  // settings rows did NOT clear `authToken`, main's in-memory cached bearer, so
  // every `fetchAuthed` after a sign-out kept using the signed-out user's live
  // token until the process exited. Order matters — stop the event stream first
  // so the stream loop cannot observe a half-cleared session and re-broadcast
  // `auth:expired`, then drop the cached bearer, then wipe the rows.
  /**
   * ── ⚠ SIGNING OUT ENDS THE CREDENTIAL, NOT JUST THE SESSION ───────────────────────────────────
   *
   * THE RULE: sign-out logs the user out and clears the login session; signing in again requires the
   * username and password.
   *
   * It blanked the session settings and deliberately left the saved account row's bearer and 30-day refresh
   * token on disk, so switching back needed no password — and nothing anywhere revoked either credential, so
   * a token copied off the machine beforehand kept working for the rest of its life. The report asked for
   * that trade to be decided rather than inherited. It has been.
   *
   * ⚠ THE ACCOUNT ROW STILL SURVIVES, so the switcher keeps showing who this was; what goes is the
   * credential — see `signOutAccount`. `switchAccount` writes `connected = "false"` for a row with no
   * token, which lands the app on the sign-in screen. That IS the rule: the account is still listed,
   * and getting back into it costs a password.
   */
  ipcMain.handle("auth:signOut", async () => {
    /**
     * ⚠ READ BEFORE THE TEARDOWN. `tearDownSession` blanks `user_id`, so both the audit subject and the
     * row to sign out have to be resolved first — afterwards there is no subject left to attribute the
     * event to, and "someone signed out" without a who is barely a record.
     */
    const userId = getSetting("active_user_id") || getSetting("user_id") || "";

    /**
     * ⚠ AND BEFORE THE SETTINGS ARE WIPED, because `signOutAccount` needs the platform config to reach
     * Cognito. `tearDownSession` leaves the platform keys alone (they are absent from
     * `SIGN_OUT_SETTINGS` by design), so this would work either way — the ordering is stated so a
     * future change to that list cannot quietly turn every revocation into `no-platform`.
     *
     * Best-effort: a failed revocation must not fail the sign-out. The user asked to be signed out, the
     * local wipe below is the part they can see, and the outcome is recorded rather than thrown.
     */
    const revocation = userId ? await signOutAccount(userId) : "no-account";

    /**
     * ── ⚠ ONLY WHEN THERE WAS A SESSION TO END ────────────────────────────────────────────────
     *
     * This recorded a `success` on every call, including with NOBODY SIGNED IN (`revocation ===
     * "no-account"`), so ~2000 invokes evicted every genuine record from the rotation window while changing
     * nothing and attributing the event to no one.
     *
     * "Someone signed out" with no subject and no session is not a security event — the note above
     * already says a signout without a who "is barely a record". The teardown still runs
     * unconditionally, so the handler's behaviour is unchanged; only the empty record is gone.
     */
    if (userId) {
      recordSecurityEvent({
        event: "auth.signout",
        outcome: "success",
        userId,
        detail: revocation,
      });
    }
    tearDownSession();
    return { ok: true };
  });

  // Lightweight backend reachability probe for the header status pill. Hits the
  // unauthenticated /v1/health endpoint with a short timeout so a hung/down
  // backend surfaces as "offline" instead of stalling the UI.
  ipcMain.handle("ai:ping", async () => {
    const url = backendOriginOrNull();

    /**
     * ⚠ "NOT CONFIGURED" IS ITS OWN STATE, not a red pill.
     *
     * An app nobody has pointed at a platform yet is not OFFLINE — nothing is down,
     * and telling someone their backend is unreachable when they simply have not
     * finished setup sends them to debug a network. This pill has been wrong-by-default
     * once already (it probed a `/v1/health` route that does not exist on the deployed
     * API, so it read "Offline" permanently while every other request succeeded), and
     * a status indicator that is always red trains people to ignore the one signal
     * that should mean something.
     */
    if (!url) return { online: false, configured: false as const };

    /**
     * Piggy-back the server-side platform re-check on the status poll.
     *
     * ⚠ NOT AWAITED. The re-check is throttled to once every 15 minutes internally and
     * fails open, so it has nothing to contribute to THIS pill's answer — and awaiting it
     * would put a second network round-trip in front of a 15-second UI poll. If it does
     * find a rotation it tears the session down and broadcasts `platform:changed`, which
     * reaches the renderer on its own path.
     *
     * `void` + `catch` because an unhandled rejection here would be a crash in a poll.
     */
    void recheckPlatformFromServer(tearDownSession).catch(() => {});

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${url}/v1/auth/config`, { signal: controller.signal });
      if (!res.ok) return { online: false, configured: true as const, error: `HTTP ${res.status}` };
      // No version to report from this endpoint; the pill treats it as optional.
      return { online: true, configured: true as const };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        online: false,
        configured: true as const,
        error: aborted ? "Timed out" : "Unreachable",
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  // Renderer asks the main process to (re)connect the real-time team event
  // stream once the user is logged in + on a team. Idempotent.
  ipcMain.handle("events:subscribe", async () => {
    startTeamEventStream();
    return { streaming: eventStreamTeamId != null };
  });

  ipcMain.handle("events:unsubscribe", async () => {
    stopTeamEventStream();
    return { streaming: false };
  });

  // Reflect total unread team activity on the dock/taskbar icon. macOS shows a
  // numeric badge; other platforms show a dot where supported (setBadgeCount is
  // a no-op on Windows and safe to call everywhere).
  ipcMain.handle("badge:setCount", async (_event, count: number) => {
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    try {
      app.setBadgeCount(n);
    } catch {
      /* unsupported platform — ignore */
    }
    return { count: n };
  });
}
