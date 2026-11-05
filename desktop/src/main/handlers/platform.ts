// ── PLATFORM CONFIGURATION, THE IPC SIDE ───────────────────────────────────────
//
// Read the current config, commit a confirmed connect link, check for drift, collect a link
// delivered by an `praimana://` deep link, and reset the install.
//
// ⚠ THE RENDERER CANNOT WRITE THE CONFIG BY WRITING A SETTING. `cognito_pool_id` and its
// siblings are absent from `RENDERER_WRITABLE_SETTINGS` on purpose (setting-access.ts).
// Changing the platform VOIDS THE SESSION, and a teardown is not something the renderer gets
// to trigger by setting a string — it has to come through `platform:connect`, which redeems
// the code, resolves the pool against AWS discovery, tears the session down in the one place
// that does it correctly, and tells every window what happened.
//
// ⚠ `platform:connect` TAKES NO ARGUMENTS. It reads the pending link from main
// (`deep-link.ts`), so a renderer cannot supply a platform of its own choosing — it can only
// confirm or decline the one the OS delivered.
//
// ⚠ BUT IT IS TOLD EVERYTHING IT IS CONFIRMING. `platform:pendingLink` returns the pool id and
// client id as well as the two origins, because those are the fields that decide which identity
// provider the app trusts, and the panel is the only thing standing between a link and that
// decision. An earlier revision withheld them on the grounds that the renderer "only needs to
// show the origins" — which was the defect, not the design: the pool is where the participant's
// password goes. Reading a value OUT is not the same as accepting one IN, and only the latter
// was ever the risk on this path.

import { ipcMain, BrowserWindow } from "electron";
import { regionFromPoolId } from "@praimana/shared";
import {
  takePendingConnectLink,
  hasPendingConnectLink,
  peekPendingConnectLink,
} from "../deep-link";
import { getDb, readSetting, writeSetting } from "../database";
import { recordSecurityEvent } from "../security-audit";
import { profileIdentity, releaseProfileIdentity } from "../accounts";
import { forgetAccountsForPlatform } from "../accounts";
import {
  resolvePlatform,
  readPlatformConfig,
  savePlatformConfig,
  clearPlatformConfig,
  storedFingerprint,
  isPlatformConfigured,
  configFingerprint,
  PlatformConfigError,
} from "../platform-config";

/**
 * How this module ends a session.
 *
 * ⚠ INJECTED, NOT IMPORTED, to keep the dependency acyclic. The teardown lives in
 * handlers/ai.ts because that module owns the cached bearer and the event stream, and
 * ai.ts needs THIS module to know which platform to sign in against — so importing in
 * both directions would be a cycle. Electron's CJS output tolerates some cycles and
 * silently hands back a half-initialised module for others; a parameter cannot.
 *
 * It is also the seam the tests use: asserting "a platform change tears the session
 * down" needs nothing more than a spy here.
 */
export type SessionTeardown = () => void;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Turn a caught error into a message safe to show the user.
 *
 * `ConnectStringError` and `PlatformConfigError` are both written FOR the person
 * pasting — "that connect string is incomplete", "Cognito does not recognise the user
 * pool …" — so they pass through verbatim. Anything else is unexpected and gets a
 * generic line rather than leaking a stack or an internal path onto the setup screen.
 */
function userFacingError(err: unknown): string {
  if (err instanceof PlatformConfigError) return err.message;
  return "Could not complete sign-in. Please start again from the portal.";
}

/**
 * Sign the user out because the platform is no longer the one they signed in to.
 *
 * ⚠ A DISTINCT EVENT FROM `auth:expired`, deliberately. Both end at the sign-in
 * screen, but "your session expired" is a false statement here — the session was
 * fine, the platform changed — and a user told the wrong reason will retry the wrong
 * fix. The renderer shows a different message for each.
 */
function voidSessionForPlatformChange(
  tearDownSession: SessionTeardown,
  reason: "changed" | "rotated"
): void {
  tearDownSession();
  broadcast("platform:changed", { reason });
}

/**
 * LOCAL integrity check: do the stored config fields still describe the platform whose
 * fingerprint we recorded?
 *
 * ⚠ THIS DOES NOT DETECT A SERVER-SIDE POOL ROTATION — it never reaches the network.
 * The fingerprint is recomputed from the SAME rows it is compared against, so the only
 * way they diverge is if something wrote those rows without going through
 * `savePlatformConfig`: a hand-edited SQLite file, a partial write, or a future code
 * path that sets `server_url` directly (which is why `ai:login` no longer does).
 *
 * For a rotation on the server, see `recheckPlatformFromServer`.
 *
 * Cheap enough for startup — two settings reads and a hash, no I/O.
 */
export function checkPlatformDrift(tearDownSession: SessionTeardown): boolean {
  const config = readPlatformConfig();
  const recorded = storedFingerprint();

  // Nothing configured, or nothing recorded yet: no drift to detect. An install
  // upgrading into this change has settings but no fingerprint, and must NOT be
  // signed out for it — the fingerprint is stamped on its next save/sign-in.
  if (!config || !recorded) return false;

  if (config.fingerprint !== recorded) {
    voidSessionForPlatformChange(tearDownSession, "rotated");
    return true;
  }
  return false;
}

/**
 * When the last server-side re-check ran, so the status poll cannot turn into a request
 * per client every 15 seconds. `0` means "never".
 */
let lastServerRecheckMs = 0;

/**
 * How often the server-side re-check may actually hit the network.
 *
 * 15 minutes, against what it is detecting: a pool rotation is a deliberate operational
 * act, and the failure mode while undetected is a 401 that the existing refresh →
 * `auth:expired` path already handles. So this is a nicety that produces an ACCURATE
 * message ("the platform changed") instead of a misleading one ("your session expired")
 * — not a control, and not worth a request per quarter-minute per participant.
 */
const SERVER_RECHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * UPSTREAM check: re-read AWS's discovery document for the configured pool, and void the
 * session if the platform's identity changed underneath us.
 *
 * ⚠ IT ASKS AWS, NOT OUR PORTAL. The connect string is rebuilt from what is stored and
 * re-resolved, so this catches a pool whose OAuth endpoints moved — a custom auth domain
 * added or removed, or a pool replaced behind the same id. It CANNOT detect a customer
 * changing which pool their portal hands out, because nothing on disk points at the
 * portal any more; that case surfaces the next time someone pastes a fresh string.
 *
 * Throttled (see above) and FAILS OPEN: a network error or a 5xx must not sign anyone
 * out, because "briefly offline" is overwhelmingly more common than "pool rotated", and
 * treating them alike would log people out every time the wifi dropped.
 *
 * ⚠ IT DOES NOT PERSIST THE NEW CONFIG. Saving it would silently re-point the app at
 * whatever AWS now reports, which is a decision for the user — not a side effect of a
 * background poll. It only detects, tears down, and lets the user re-confirm.
 */
export async function recheckPlatformFromServer(
  tearDownSession: SessionTeardown
): Promise<boolean> {
  const config = readPlatformConfig();
  const recorded = storedFingerprint();
  if (!config || !recorded) return false;

  const now = Date.now();
  if (now - lastServerRecheckMs < SERVER_RECHECK_INTERVAL_MS) return false;
  // Stamped BEFORE the await, not after: two polls that overlap would otherwise both
  // pass the throttle and both hit the network.
  lastServerRecheckMs = now;

  let fresh;
  try {
    fresh = await resolvePlatform({
      poolId: config.poolId,
      clientId: config.cognito.clientId,
      apiBaseUrl: config.apiBaseUrl,
    });
  } catch {
    // Fail open — see above. Deliberately not logged: an offline laptop would fill the
    // log with an expected condition.
    return false;
  }

  if (fresh.fingerprint !== recorded) {
    voidSessionForPlatformChange(tearDownSession, "rotated");
    return true;
  }
  return false;
}

export function setupPlatformHandlers(tearDownSession: SessionTeardown) {
  /**
   * The current platform config, for the setup screen and the Account view.
   *
   * ⚠ RETURNS THE ACCESS KEY, NOT THE DECRYPTED VALUES, for the copyable field — so
   * Account shows the user the same opaque token the portal gave them rather than
   * re-exposing the pool id and API origin in the UI. The resolved endpoints are
   * returned too, because the sign-in configuration panel displays them and they are
   * what a facilitator asks for when a connection misbehaves.
   *
   * No token or credential crosses this boundary; those stay in main.
   */
  ipcMain.handle("platform:get", async () => {
    const config = readPlatformConfig();
    if (!config) return { configured: false as const };
    return {
      configured: true as const,
      poolId: config.poolId,
      region: config.region,
      apiBaseUrl: config.apiBaseUrl,
      cognito: config.cognito,
      /**
       * The portal, so the sign-in screen can name it and flow 2 can open it.
       *
       * ⚠ NO CONNECT STRING AND NO ACCESS KEY. There is nothing for a user to copy any more:
       * the config arrives with the session, so a copyable credential-shaped value would be a
       * thing to lose rather than a thing to use.
       */
      portalUrl: readSetting("portal_url") || "",
    };
  });

  /**
   * Describe the pending deep link so the renderer can ask the user to confirm it.
   *
   * ⚠ IT DOES NOT REDEEM THE CODE, and it does not consume the link. The code is single-use and
   * lives 60 seconds, so spending it to render a confirmation screen would leave nothing to
   * commit when the user clicked.
   *
   * The API origin is the value that matters here: it is where the desktop will send this
   * session's bearer on every request, and a hostile link's whole purpose is to name one of its
   * own. Showing it is what turns "a link opened my app" into a decision the user can make.
   */
  ipcMain.handle("platform:pendingLink", async () => {
    if (!hasPendingConnectLink()) return { pending: false as const };
    // Peek, do not take: `platform:connect` is what consumes it.
    const proposal = peekPendingConnectLink();
    if (!proposal) return { pending: false as const };
    const { link, id: linkId } = proposal;
    const current = readPlatformConfig();

    /**
     * ── ⚠ WHETHER COMMITTING CHANGES THE PLATFORM — ASKED THE SAME WAY THE COMMIT ASKS IT ──
     *
     * This compared ONLY `apiBaseUrl` against `server_url`, while `platform:connect` decides `changed` from
     * the whole FINGERPRINT — which includes the pool id, the client id and the issuer (`configFingerprint`).
     * So the one substitution that matters most read as harmless: a link naming the REAL portal and the REAL
     * API alongside an ATTACKER'S OWN Cognito pool produced `wouldSignOut: false`, the panel showed no
     * warning, the button said a bare "Connect" — and then the commit tore the session down anyway. The
     * screen misstated the consequence of its own click.
     *
     * ⚠ COMPUTED WITHOUT A NETWORK CALL, deliberately: this runs on every mount of the setup
     * screen, and a confirmation panel must not be a way to make the app fetch. The two fields it
     * cannot know for the LINK's pool — `issuer` and `authorizationEndpoint` — are taken from the
     * stored config, which is sound for the only question being asked:
     *
     *   - if the link's pool, client or API differ, the fingerprint differs whatever is
     *     substituted for those two, so the answer is already "yes, it changes";
     *   - if all three match, the issuer and authorization endpoint ARE the stored ones, because
     *     the issuer is derived from the pool id and the endpoints belong to that pool.
     *
     * A pool whose endpoints moved on AWS's side is a different question, and `recheckPlatform-
     * FromServer` is what asks it.
     */
    const wouldSignOut =
      current != null &&
      configFingerprint({
        poolId: link.poolId,
        apiBaseUrl: link.apiBaseUrl,
        clientId: link.clientId,
        issuer: current.cognito.issuer,
        authorizationEndpoint: current.cognito.authorizationEndpoint,
      }) !== current.fingerprint;

    /**
     * ── ⚠ IS THIS PROFILE ALREADY SOMEBODY'S WORKSPACE? ───────────────────────────────────────
     *
     * ⚠ AND `wouldSignOut` COULD NOT HAVE CAUGHT IT, which is why this is a separate field. Measured on
     * the reporter's own machine: the `…-codevibranium` and `…-jarvisdeploy` profiles carry the SAME
     * `cognito_pool_id`, the SAME client id, the SAME `server_url` and the SAME `portal_url` — they are
     * two workshops inside ONE deployment. So the link named exactly the platform that profile already
     * had, the fingerprint matched, `wouldSignOut` was false, the panel showed no warning, and
     * `platform:connect` recorded `initial:`/no change. Nothing about the PLATFORM was wrong, and the
     * screen correctly said so.
     *
     * ⚠ THE LINK CANNOT NAME A WORKSPACE. It carries a one-time code, the portal URL and the API base
     * URL — no workshop, no team, no profile (deep-link.ts states the last of these at length). Workshop
     * and team come from sign-in and team-join, AFTER this screen. So the app cannot detect "this link is
     * for a different workspace", and this field does not pretend to: it answers the question the app CAN
     * answer, which is whether the profile about to receive the link is already in use.
     *
     * That is the question the participant needed asked. Their remedy — a new profile — is unavailable
     * from this screen unless the screen raises it, and by the time a workspace turns out to be mixed in
     * the wrong profile the chats and projects are already there.
     */
    const identity = profileIdentity();

    /**
     * ── ⚠ THE SIGNAL THAT SURVIVES A DISCONNECT: DOES THIS PROFILE CONTAIN WORK? ──────────────
     *
     * It could not: `platform:reset` forgets the accounts rows, clears `team_id`/`team_name` via the session
     * teardown, and releases the identity binding — deliberately, all three — so by the time the portal link
     * arrives the profile looks untouched to every signal above.
     *
     * Measured on the reporter's machine: `…-codevibranium` has ZERO accounts and no team, and still holds
     * 1 project, 1 chat session and 6 messages. THE WORK IS WHAT SURVIVES. No sign-out, disconnect or
     * platform reset deletes a project row or a transcript, which is exactly why they are the honest
     * answer to "is this somebody's workspace already".
     *
     * ⚠ AND IT IS THE RIGHT QUESTION ANYWAY. The harm being prevented is two workspaces' chats and
     * projects interleaved in one profile — so asking "is there already work here" is asking about the
     * thing at stake, where "is there a remembered credential" was a proxy for it that the arrival flow
     * happened to erase.
     */
    let hasWork = false;
    try {
      const db = getDb();
      const counted = db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM chat_sessions) AS n"
        )
        .get() as { n?: number } | undefined;
      hasWork = (counted?.n ?? 0) > 0;
    } catch {
      /**
       * No database yet, or a migration mid-flight. Reports "no work", which leaves the panel silent —
       * the same direction every other degraded answer in this file takes: never invent a warning, and
       * never let a transient fault block a legitimate setup.
       */
    }

    return {
      pending: true as const,
      /**
       * Whether this profile already belongs to somebody: a remembered account, or a joined team.
       * `configured` is deliberately separate — a profile can be pointed at a platform and never used.
       */
      profileInUse: identity.count > 0 || !!readSetting("team_id") || hasWork,
      /** So the panel can say what is at stake rather than only that something is. */
      profileHasWork: hasWork,
      profileAccountCount: identity.count,
      profileTeamName: readSetting("team_name") || null,
      configured: current != null,
      /**
       * ⚠ HANDED BACK ON COMMIT, so the click names the proposal it was shown. See the note on
       * `PendingProposal` in deep-link.ts: without this, `platform:connect` committed whatever
       * occupied the slot at that instant, and a page that overwrote it between render and click got
       * its own platform persisted under the participant's confirmation of a different one.
       */
      linkId,
      portalUrl: link.portalUrl,
      apiBaseUrl: link.apiBaseUrl,
      /**
       * ⚠ THE POOL AND CLIENT NOW CROSS TO THE RENDERER, and they must: they are what decide
       * which identity provider this app trusts, and the renderer feeds them to Amplify for the
       * app's OWN SRP form — the one that collects the participant's email, password and TOTP.
       * A confirmation screen that withholds them is asking for a signature on an unread line.
       *
       * Neither is a secret. Both travel in every OAuth redirect, and AWS publishes the pool's
       * endpoints unauthenticated at its `.well-known/openid-configuration`; `desktop-link.ts`
       * says so in as many words, and the link they arrived in is readable from `process.argv`.
       */
      poolId: link.poolId,
      clientId: link.clientId,
      region: regionFromPoolId(link.poolId),
      /**
       * Whether committing would sign the current user out. Worded honestly by the renderer:
       * a warning that appears when nothing will happen is one people learn to click past.
       */
      wouldSignOut,
      /**
       * What is configured TODAY, so the panel can show the CHANGE rather than a bare value.
       *
       * ⚠ THIS IS THE PART THAT ACTUALLY DEFENDS ANYTHING. A pool id shown on its own is
       * unreadable to a participant who has never seen theirs — `us-east-1_AbCdEfGhI` and
       * `us-east-1_XyZwVuTsR` are indistinguishable without a baseline. A DIFF against the pool
       * they are already signed in to is a comparison that needs no memory.
       *
       * `null` on a fresh install, where there is nothing to compare and the panel says so.
       */
      current:
        current == null
          ? null
          : {
              poolId: current.poolId,
              apiBaseUrl: current.apiBaseUrl,
              region: current.region,
            },
    };
  });

  /**
   * ── COMMIT THE CONFIRMED LINK ──
   *
   * Consume the pending link and store the platform it names, resolving the pool's real
   * endpoints from AWS discovery on the way.
   *
   * ⚠ THIS DOES NOT SIGN ANYONE IN. It used to redeem a one-time code for a session; that path
   * is gone, because the portal cannot mint a session for the desktop (measured,
   * and `AdminInitiateAuth` is refused by the
   * pool). Sign-in is now the app's own SRP form, which runs after this.
   *
   * ⚠ ORDER: resolve → detect change → SIGN OUT → save.
   *
   *   Resolving first means a bad link changes NOTHING: a link naming a pool AWS does not
   *   recognise leaves a working install exactly as it was.
   *
   *   Tearing down before saving means the old session is gone before the new origin is
   *   stored, so no request can be built against the new API carrying the previous platform's
   *   bearer.
   *
   * ⚠ IT TAKES THE PROPOSAL'S ID — AND THAT IS NOT THE SAME AS TAKING A PLATFORM. The renderer
   * still cannot supply a pool, a client or an origin; it names WHICH of main's own proposals it is
   * confirming, and main refuses if that is not the one it is holding. The distinction is the whole
   * point: an argument the renderer can INVENT would be the vulnerability, an argument it can only
   * ECHO is what binds the click to the screen. See `PendingProposal` in deep-link.ts.
   */
  ipcMain.handle("platform:connect", async (_event, linkId: unknown) => {
    const link = takePendingConnectLink(typeof linkId === "string" ? linkId : "");
    if (!link) {
      return {
        ok: false as const,
        error: "That link is no longer available. Please click it again on the website.",
      };
    }

    let config;
    try {
      config = await resolvePlatform({
        poolId: link.poolId,
        clientId: link.clientId,
        apiBaseUrl: link.apiBaseUrl,
      });
    } catch (err) {
      // The link named a pool this app could not resolve or would not trust. Recorded because it is
      // an attempt to point this install at a different identity provider.
      recordSecurityEvent({ event: "platform.connect", outcome: "failure", detail: "unresolvable" });
      return { ok: false as const, error: userFacingError(err) };
    }

    const previous = storedFingerprint();
    const changed = previous != null && previous !== config.fingerprint;
    if (changed) {
      voidSessionForPlatformChange(tearDownSession, "changed");
      /**
       * ⚠ THE PROFILE IDENTITY BINDING GOES WITH THE PLATFORM, and only with it. The model is
       * one profile per experience, with different email addresses for different experiences or teams, so a
       * profile pointed at a DIFFERENT platform legitimately expects a different address — holding the
       * old binding across that would be a lockout, not a guard. An unchanged fingerprint keeps it,
       * which is the case that prompted the binding: arriving via a portal link for the same deployment.
       */
      releaseProfileIdentity();
    }

    savePlatformConfig(config);
    writeSetting("portal_url", link.portalUrl);

    /**
     * ⚠ `changed` IS THE PART WORTH AUDITING. A first-time connect is ordinary setup; a connect that
     * MOVES an existing install to a different Cognito pool voids the session and changes which
     * identity provider the app trusts, which is the single most consequential configuration change
     * this app can undergo. The fingerprint is recorded, not the URL — it identifies the platform
     * without putting a customer's hostname in the file.
     */
    recordSecurityEvent({
      event: "platform.connect",
      outcome: "success",
      detail: changed ? `changed:${config.fingerprint}` : `initial:${config.fingerprint}`,
    });

    return {
      ok: true as const,
      changed,
      apiBaseUrl: config.apiBaseUrl,
      portalUrl: link.portalUrl,
    };
  });

  /**
   * ── RESET: "SIGN IN TO ANOTHER EXPERIENCE" ──
   *
   * Clears the platform config AND the session, returning the app to first run.
   *
   * ⚠ DISTINCT FROM SIGN OUT, and the difference is the point. Sign-out keeps the config, so
   * signing back in needs nothing re-entered — that is why the platform keys are absent from
   * `SIGN_OUT_SETTINGS`. Reset is the deliberate act of leaving a platform entirely, and it is
   * the only thing that discards the configuration.
   *
   * The renderer confirms first and names what is lost: this also drops the saved accounts for
   * that platform, which cannot be recovered from inside the app.
   */
  ipcMain.handle("platform:reset", async () => {
    /**
     * ── ⚠ IT NOW FORGETS THE ACCOUNTS IT PROMISES TO FORGET ────────────────────────────────
     *
     * This tore the session down and cleared the eight platform settings, and left the `accounts` table alone
     * — so every saved row's encrypted bearer and 30-DAY REFRESH TOKEN stayed on disk after the user
     * deliberately left the platform, with no way to see or clear them from inside the app (the account list
     * is unreachable once unconfigured). The confirmation dialog said the opposite in as many words: "You'll
     * be signed out, and the saved accounts for it will be forgotten" (AccountPanel.tsx).
     *
     * ⚠ THE FINGERPRINT IS READ FIRST, BEFORE ANYTHING CLEARS IT. `clearPlatformConfig` blanks the
     * row this identifies the outgoing platform by, so reading it afterwards would delete nothing —
     * or, with the NULL clause, everything for the wrong reason.
     */
    const leaving = storedFingerprint();
    /**
     * ⚠ AND THE TOKENS ARE REVOKED, not just deleted. A local delete forgets a credential; it does not
     * invalidate it, and a refresh token copied off a shared laptop before somebody disconnected kept
     * working for the rest of its 30-day life. See `revokeStoredCredential` in accounts.ts — the
     * revocation is best-effort, so a network failure still leaves the rows gone.
     */
    const { forgotten, revoked } = await forgetAccountsForPlatform(leaving);
    // Leaving a platform entirely: the binding describes an experience this profile no longer has.
    releaseProfileIdentity();

    // Session first, config second — the same ordering as a platform change, for the same
    // reason: no window may observe a live session against a platform that is being removed.
    // Before the teardown, so the outgoing platform is still identifiable.
    recordSecurityEvent({
      event: "platform.reset",
      outcome: "success",
      detail: `${leaving ?? "unrecorded"}:forgot-${forgotten}:revoked-${revoked}`,
    });
    tearDownSession();
    clearPlatformConfig();
    broadcast("platform:changed", { reason: "reset" });
    return { ok: true as const };
  });

  /** Whether this install has been configured — the gate App.tsx reads at startup. */
  ipcMain.handle("platform:isConfigured", async () => {
    return { configured: isPlatformConfigured() };
  });

  /**
   * Whether an `praimana://` deep link is waiting. A BOOLEAN, and nothing else.
   *
   * ── ⚠ ITS DOCSTRING USED TO CLAIM A CONSUME IT HAS NEVER PERFORMED ────────────────────────────
   *
   * It said "Consumed on read, so a link cannot be re-offered after the user declines it" while the body only
   * ever returned `hasPendingConnectLink()`. Nothing was consumed, so declining — navigating away, closing
   * the panel — left the proposal armed, and the comment was the reason nobody looked. That is corrected here
   * rather than by making the function match the sentence: the expiry in `deep-link.ts` is what actually
   * bounds a proposal's life, and a "decline" this channel cannot observe is not something it can implement.
   *
   * ⚠ IT PREFILLS NOTHING AND COMMITS NOTHING. `platform:pendingLink` describes the proposal and
   * `platform:connect` — naming its id — is the only thing that commits one.
   */
  ipcMain.handle("platform:takeDeepLink", async () => {
    // Retained for the renderer's cold-start check; the link itself is described by
    // `platform:pendingLink` and consumed by `platform:connect`.
    return { pending: hasPendingConnectLink() };
  });
}

/**
 * Re-exported for the tests, which assert the fingerprint's normalisation rules
 * directly rather than through an IPC round-trip.
 */
export { configFingerprint };
