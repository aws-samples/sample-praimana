// Multi-user local login (accounts). Each account that signs in on this machine
// is remembered so you can switch between them without re-entering credentials —
// the flow used to test team sharing (log in as A, share a chat, switch to B,
// see it appear as shared by A). The auth token is encrypted at rest.
//
// The "active" account's session lives in the `settings` table (server_url,
// auth_token, team_id, …) exactly as before — accounts is a saved-sessions store
// layered on top. Switching an account copies its saved values back into
// settings; signing in/out keeps the accounts row (removeAccount deletes it).

import {
  getDb,
  readSetting,
  writeSetting,
  encryptSecret,
  decryptSecret,
  isSecretStorageAvailable,
} from "./database";
import { PLATFORM_SETTING_KEYS, storedFingerprint, readPlatformConfig } from "./platform-config";
import {
  readActiveProfileIdentity,
  writeActiveProfileIdentity,
  clearActiveProfileIdentity,
} from "./profile";
import { revokeRefreshToken } from "./cognito-refresh";

export interface StoredAccount {
  id: string;
  email: string;
  name: string | null;
  serverUrl: string | null;
  teamId: string | null;
  teamName: string | null;
  workshopId: string | null;
  lastActiveAt: string;
  /**
   * The platform this account signed in to, and that platform's config fingerprint.
   *
   * Both are exposed so the switcher can LABEL a row rather than silently hide it —
   * the rule is that accounts from another platform stay visible and the
   * switch is refused with an explanation. A hidden row looks like data loss; a
   * labelled one that refuses explains itself.
   *
   * `platformFingerprint` is null for rows saved before platform scoping existed
   * (migration 8 back-fills the URL but deliberately not the fingerprint).
   */
  platformUrl: string | null;
  platformFingerprint: string | null;
  /** True when this account belongs to the platform currently configured. */
  onCurrentPlatform: boolean;
}

// Setting keys that make up a signed-in session. Switching accounts swaps these.
const SESSION_KEYS = {
  serverUrl: "server_url",
  authToken: "auth_token",
  refreshToken: "cognito_refresh_token",
  teamId: "team_id",
  teamName: "team_name",
  workshopId: "workshop_id",
  inviteCode: "team_invite_code",
  userEmail: "user_email",
  userId: "user_id",
  userName: "user_name",
} as const;

/**
 * The platform an account is being saved against.
 *
 * Read from the CONFIGURED platform rather than passed in, so there is one answer to
 * "which platform is this session on" and it is the same one `backendOrigin()` uses.
 */
function currentPlatform(): { url: string | null; fingerprint: string | null } {
  return {
    /**
     * The API origin identifies the platform for a saved account.
     *
     * Was the portal URL, which no longer exists as a stored value — the desktop is
     * configured with an Access Key now, and `server_url` is the durable, human-meaningful
     * identifier a refused switch can name ("this account signed in to <url>").
     */
    url: readSetting(PLATFORM_SETTING_KEYS.apiBaseUrl) || null,
    fingerprint: storedFingerprint(),
  };
}

/**
 * Record (or refresh) the account that just signed in, and mark it active.
 * Called from the login/register handlers once a session is established. Reads
 * the freshly-written settings so it captures the current token/team.
 */
export function upsertActiveAccount(params: {
  id: string;
  email: string;
  name?: string | null;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  const serverUrl = readSetting("server_url");
  const authToken = readSetting("auth_token");
  const refreshToken = readSetting("cognito_refresh_token");
  const teamId = readSetting("team_id");
  const teamName = readSetting("team_name");
  const workshopId = readSetting("workshop_id");
  const inviteCode = readSetting("team_invite_code");
  // Stamped on every sign-in, which is also what upgrades a legacy row's NULL
  // fingerprint to a real one the moment that account is used again.
  const platform = currentPlatform();

  db.prepare(
    `INSERT INTO accounts (id, email, name, server_url, auth_token, cognito_refresh_token, team_id, team_name, workshop_id, team_invite_code, platform_url, config_fingerprint, created_at, last_active_at)
     VALUES (@id, @email, @name, @serverUrl, @authToken, @refreshToken, @teamId, @teamName, @workshopId, @inviteCode, @platformUrl, @fingerprint, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       name = excluded.name,
       server_url = excluded.server_url,
       auth_token = excluded.auth_token,
       cognito_refresh_token = excluded.cognito_refresh_token,
       team_id = excluded.team_id,
       team_name = excluded.team_name,
       workshop_id = excluded.workshop_id,
       team_invite_code = excluded.team_invite_code,
       platform_url = excluded.platform_url,
       config_fingerprint = excluded.config_fingerprint,
       last_active_at = excluded.last_active_at`
  ).run({
    id: params.id,
    email: params.email,
    name: params.name ?? null,
    serverUrl: serverUrl ?? null,
    authToken: authToken ? encryptSecret(authToken) : null,
    refreshToken: refreshToken ? encryptSecret(refreshToken) : null,
    teamId: teamId ?? null,
    teamName: teamName ?? null,
    workshopId: workshopId ?? null,
    inviteCode: inviteCode ?? null,
    platformUrl: platform.url,
    fingerprint: platform.fingerprint,
    now,
  });

  writeSetting("active_user_id", params.id);
}

/**
 * Persist the current session's evolving state (token refresh, team join) back
 * onto the active account row so a later switch restores the latest values.
 */
export function syncActiveAccountFromSettings(): void {
  const id = readSetting("active_user_id") || readSetting("user_id");
  if (!id) return;
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(id);
  if (!exists) return;

  const authToken = readSetting("auth_token");
  const refreshToken = readSetting("cognito_refresh_token");
  /**
   * ── ⚠ A MIRROR THAT MUST NOT TAKE THE CALLER DOWN ──
   *
   * `encryptSecret` REFUSES when the keychain is unavailable rather than writing a token in
   * cleartext (database.ts). This function is a best-effort mirror of the live session onto the
   * remembered-account row, and it runs from `renewAuthToken` and from team joins — background
   * paths with nobody watching. A throw there would surface as an unhandled rejection in whatever
   * request happened to trigger it.
   *
   * So the refusal is honoured by SKIPPING the mirror. The cost is a switch-back that needs a fresh
   * sign-in; the alternative was a cleartext credential, and the caller's own sign-in path already
   * explains the condition to the user.
   *
   * ⚠ CHECKED BEFORE the UPDATE, not around it, so the row is never left with a token written and
   * the rest of the columns stale.
   */
  if ((authToken || refreshToken) && !isSecretStorageAvailable()) {
    console.warn(
      "[accounts] keychain unavailable — not mirroring this session onto the saved account row"
    );
    return;
  }
  const platform = currentPlatform();
  db.prepare(
    `UPDATE accounts SET
       server_url = @serverUrl,
       auth_token = @authToken,
       cognito_refresh_token = @refreshToken,
       team_id = @teamId,
       team_name = @teamName,
       workshop_id = @workshopId,
       team_invite_code = @inviteCode,
       platform_url = @platformUrl,
       config_fingerprint = @fingerprint,
       last_active_at = @now
     WHERE id = @id`
  ).run({
    id,
    serverUrl: readSetting("server_url") ?? null,
    authToken: authToken ? encryptSecret(authToken) : null,
    refreshToken: refreshToken ? encryptSecret(refreshToken) : null,
    teamId: readSetting("team_id") ?? null,
    teamName: readSetting("team_name") ?? null,
    workshopId: readSetting("workshop_id") ?? null,
    inviteCode: readSetting("team_invite_code") ?? null,
    // Kept current for the same reason the token is: this row is what a later switch
    // restores, and a stale platform stamp would let a refused switch through.
    platformUrl: platform.url,
    fingerprint: platform.fingerprint,
    now: new Date().toISOString(),
  });
}

/**
 * All saved accounts, most-recently-active first. Tokens are never returned.
 *
 * ⚠ ACCOUNTS FROM OTHER PLATFORMS ARE INCLUDED, flagged rather than filtered. The
 * rule: keep them visible and refuse the switch with an explanation. A
 * filtered list reads as "the app forgot my account"; a labelled row that says why it
 * cannot be used is the honest version, and it tells the user what to change.
 */
/**
 * ── ⚠ WHICH IDENTITIES THIS PROFILE ALREADY BELONGS TO ────────────────────────────────────────
 *
 * The problem behind the request is real and was diagnosed from a live install: one profile
 * (`…-jarvisdeploy`) had accumulated THREE account rows across TWO identities, on two different
 * backends, and the workshop pointer left behind by a sign-out belonged to only one of them. A profile
 * is presented to the user as "their" workspace, and a second identity signing into it silently makes
 * that untrue — the projects, chats and team of two people interleaved in one directory.
 *
 * ⚠ THIS IS NOT A SECURITY BOUNDARY AND MUST NOT BE DESCRIBED AS ONE. profile.ts and index.ts both
 * record that profiles are "not a security boundary between two people on one machine", and that is
 * unchanged: anything running as this user can still read every profile's database. What this closes is
 * an ACCIDENT — the wrong identity being added to a workspace that already has one — not an attack.
 *
 * ⚠ THE EMAIL IS RETURNED ONLY WHEN THERE IS EXACTLY ONE — because that is all the UI needs, NOT to
 * withhold it. An earlier version of this comment justified the restriction with the disclosure
 * SettingsView cites for deleting the account switcher ("a list of other people's accounts on a shared
 * machine disclosed every previous signed-in user's email to whoever opened Settings next"). That is
 * not the threat model here: this app is always used by ONE person, who holds several
 * addresses — one per experience or team — so there is nobody else at the keyboard to disclose to.
 *
 * The shape stays as it is because the single-identity case is the one that locks its field, and a count
 * is sufficient for the rest. Returning the whole list would be safe under that model, and is what a
 * "pick which of your accounts" chooser would need if the multi-identity case is ever to lock too.
 */
/*
 * ⚠ THE BINDING LIVES IN THE PROFILE'S SIDECAR, NOT IN A SETTING. It was a settings row first, and that put
 * it in the one place the PROFILE CHOOSER cannot read: the chooser opens no database by design
 * (ProfileChooser and profile.ts both state the invariant), so the list could name a profile's team and not
 * the address that works in it — which is the only thing distinguishing two profiles of one deployment, and
 * exactly what somebody picking a profile needs.
 *
 * ⚠ ONE WRITER, NOT TWO COPIES. Keeping a settings row AND a sidecar field would be two records of one fact
 * with different lifetimes — the shape that produced the last two rounds of this bug — so the setting is gone
 * rather than mirrored. `profile.ts` owns it; these three functions are the only readers here.
 */

/**
 * ── ⚠ THE BINDING SURVIVES WHAT THE `accounts` TABLE DOES NOT ─────────────────────────────────
 *
 * ⚠ THE FIRST VERSION READ ONLY THE `accounts` TABLE, AND THE REPORTED FLOW IS THE ONE FLOW THAT
 * EMPTIES IT. `platform:reset` — "Sign in to another experience", which is exactly what you reach for
 * when a portal link is for a different workspace — calls `forgetAccountsForPlatform`, which DELETES
 * the rows for the platform being left. Verified on the reporter's machine: `…-codevibranium` has zero
 * `accounts` rows and an empty `user_email`, so it is indistinguishable from a profile nobody has ever
 * used, and the lock correctly did nothing. A record that the act of arriving destroys is not a record.
 *
 * So the binding is its own setting, written once the FIRST sign-in succeeds and deliberately absent
 * from `SIGN_OUT_SETTINGS`: signing out does not make a profile stop being yours.
 *
 * ⚠ AND IT **IS** RELEASED WHEN THE EXPERIENCE CHANGES — see `releaseProfileIdentity`. The
 * model is one profile per experience, with different email addresses for different experiences or teams, so
 * a profile repointed at another platform legitimately expects a different address. Binding across a
 * platform change would turn this from accident prevention into a lockout.
 *
 * ⚠ NOT RENDERER-WRITABLE, and it must never be added to `RENDERER_WRITABLE_SETTINGS`. It is an input
 * to an authorization decision now (`isForeignToProfile`), so a renderer that could write it could
 * nominate whose profile this is — the same class of defect as the tenant keys, which that file records
 * at length.
 */
export function bindProfileIdentity(email: unknown): void {
  if (typeof email !== "string" || email.trim().length === 0) return;
  // First-writer-wins and the never-throw contract both live in `writeActiveProfileIdentity`.
  writeActiveProfileIdentity(email);
}

/**
 * Release the binding, because this profile is being repointed at a different platform.
 *
 * Called from `platform:connect` when the fingerprint changes and from `platform:reset`, the two places
 * that mean "this profile is for a different experience now".
 */
export function releaseProfileIdentity(): void {
  clearActiveProfileIdentity();
}

export function profileIdentity(): { count: number; onlyEmail: string | null } {
  try {
    const rows = getDb()
      .prepare("SELECT DISTINCT lower(trim(email)) AS email FROM accounts WHERE email IS NOT NULL AND trim(email) <> ''")
      .all() as Array<{ email: string }>;
    /**
     * ⚠ THE BINDING IS UNIONED IN, NOT PREFERRED. A profile can hold accounts the binding does not name
     * (several identities signed in before this existed, as `…-jarvisdeploy` does) and can hold a binding
     * with no rows (the reported case, after a reset forgot them). Both mean "in use", and counting them
     * separately is how `count === 1` stays a truthful answer to "is there exactly one identity here".
     */
    const emails = new Set(rows.map((r) => r.email));
    const bound = readActiveProfileIdentity();
    if (bound) emails.add(bound);
    const all = [...emails];
    return {
      count: all.length,
      onlyEmail: all.length === 1 ? all[0] : null,
    };
  } catch {
    /**
     * ⚠ A FAILED LOOKUP REPORTS "NO IDENTITIES", WHICH LEAVES SIGN-IN OPEN. The opposite default would
     * lock somebody out of their own workspace because a migration was mid-flight — and the
     * main-process check below fails the same way for the same reason. This is accident prevention; it
     * must never become the thing that prevents a legitimate sign-in.
     */
    return { count: 0, onlyEmail: null };
  }
}

/**
 * True when `email` is NOT one of this profile's remembered identities, on a profile that has some.
 *
 * ⚠ COUNTED AS "NOT FOREIGN" ON AN EMPTY PROFILE, so a fresh profile — and every install that predates
 * the `accounts` table — signs in exactly as before. The rule only ever narrows a profile that has
 * already established who it belongs to.
 */
export function isForeignToProfile(email: unknown): boolean {
  if (typeof email !== "string" || email.trim().length === 0) return false;
  const { count } = profileIdentity();
  if (count === 0) return false;
  const candidate = email.trim().toLowerCase();
  // The binding alone is enough to admit somebody: it may be the only record left after a reset.
  if (readActiveProfileIdentity() === candidate) return false;
  try {
    const row = getDb()
      .prepare("SELECT 1 AS ok FROM accounts WHERE lower(trim(email)) = ? LIMIT 1")
      .get(candidate) as { ok?: number } | undefined;
    return !row;
  } catch {
    return false;
  }
}

export function listAccounts(): {
  accounts: StoredAccount[];
  activeUserId: string | null;
  /** The platform these rows are being compared against — the switcher labels with it. */
  currentPlatformUrl: string | null;
} {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, email, name, server_url, team_id, team_name, workshop_id, platform_url, config_fingerprint, last_active_at FROM accounts ORDER BY last_active_at DESC"
    )
    .all() as Array<{
    id: string;
    email: string;
    name: string | null;
    server_url: string | null;
    team_id: string | null;
    team_name: string | null;
    workshop_id: string | null;
    platform_url: string | null;
    config_fingerprint: string | null;
    last_active_at: string;
  }>;

  const platform = currentPlatform();

  return {
    activeUserId: readSetting("active_user_id") || readSetting("user_id"),
    currentPlatformUrl: platform.url,
    accounts: rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      serverUrl: r.server_url,
      teamId: r.team_id,
      teamName: r.team_name,
      workshopId: r.workshop_id,
      lastActiveAt: r.last_active_at,
      platformUrl: r.platform_url,
      platformFingerprint: r.config_fingerprint,
      onCurrentPlatform: isSamePlatform(r.config_fingerprint, platform),
    })),
  };
}

/**
 * Whether a saved account's platform matches the configured one.
 *
 * ⚠ A NULL ON EITHER SIDE MEANS "UNKNOWN, ALLOW". Two cases, both real:
 *
 *   - the account row predates platform scoping (migration 8 back-fills the URL but
 *     deliberately not the fingerprint), and
 *   - the app has a session but no fingerprint yet, which is every install upgrading
 *     into this change before its next sign-in.
 *
 * Refusing on unknown would lock people out of accounts that work today, to prevent a
 * failure that is already handled: a token from the wrong pool 401s, the existing
 * refresh path fails, and `auth:expired` sends the user to sign in. So the strict
 * check earns its keep only when BOTH sides are known, and the next sign-in stamps the
 * row (see `upsertActiveAccount`).
 */
function isSamePlatform(
  accountFingerprint: string | null,
  current: { url: string | null; fingerprint: string | null }
): boolean {
  /**
   * ── ⚠ NO PLATFORM CONFIGURED IS NOT "UNKNOWN, ALLOW" — IT IS A REFUSAL ─────────────────────
   *
   * The two nulls are not the same kind of null:
   *
   *   accountFingerprint === null    the ROW predates platform scoping (migration 8 back-fills the
   *                                  URL and deliberately not the fingerprint). Legacy data, and
   *                                  refusing it would lock people out of accounts that work today.
   *   current.fingerprint === null    the INSTALL has a platform but has not recorded a fingerprint
   *                                  for it — every install upgrading into this change before its
   *                                  next sign-in. Also legacy, also allowed.
   *   NEITHER url NOR fingerprint    THERE IS NO PLATFORM AT ALL. Not a legacy state: it is the state
   *                                  `platform:reset` creates, since `clearPlatformConfig` blanks all
   *                                  eight platform settings. Treating it as "unknown, allow" meant a
   *                                  switch could restore the decrypted bearer, the 30-day refresh
   *                                  token and `connected=true` for the platform the user had just
   *                                  deliberately left — and with no fingerprint stamped, the boot
   *                                  drift check then had nothing to compare.
   *
   * ⚠ SO THE TEST IS "IS THERE A PLATFORM", NOT "IS THERE A FINGERPRINT", and the distinction is what
   * keeps the mid-upgrade install working. With no platform there is nothing to be the same as, and the
   * honest answer is no. The row's own origin is checked separately below, which is what covers the
   * upgrading install whose fingerprint is absent.
   */
  if (!current.url && !current.fingerprint) return false;
  if (!accountFingerprint || !current.fingerprint) return true;
  return accountFingerprint === current.fingerprint;
}

/**
 * Switch to a saved account: restore its session settings so the app behaves as
 * if that user had just signed in. Returns whether the account still has a team
 * (so the renderer knows which screen to land on). Does NOT validate the token —
 * a 401 later triggers the normal refresh/re-login flow.
 */
export function switchAccount(accountId: string): {
  ok: boolean;
  error?: string;
  teamJoined?: boolean;
} {
  const db = getDb();
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as
    | {
        id: string;
        email: string;
        name: string | null;
        server_url: string | null;
        auth_token: string | null;
        cognito_refresh_token: string | null;
        team_id: string | null;
        team_name: string | null;
        workshop_id: string | null;
        team_invite_code: string | null;
        platform_url: string | null;
        config_fingerprint: string | null;
      }
    | undefined;
  if (!row) return { ok: false, error: "Account not found" };

  /**
   * ⚠ REFUSED ACROSS PLATFORMS, and refused BEFORE anything is written.
   *
   * Every credential on this row belongs to one Cognito pool. Restoring it under a
   * different platform would produce an app that says "signed in" while every request
   * 401s — and it would overwrite the CURRENT session's settings on the way, so the
   * user loses the working session to gain a broken one. The order matters: this
   * returns before `syncActiveAccountFromSettings`, so a refused switch leaves both
   * accounts exactly as they were.
   *
   * The message names the platform to change TO, because "wrong platform" without the
   * value is an error the user cannot act on.
   */
  const platform = currentPlatform();
  if (!isSamePlatform(row.config_fingerprint, platform)) {
    return {
      ok: false,
      error:
        `${row.email} signed in to ${row.platform_url || "a different platform"}. ` +
        `Change the platform URL in Account to sign in as them.`,
    };
  }

  // Persist the outgoing account's latest state before swapping.
  syncActiveAccountFromSettings();

  const token = decryptSecret(row.auth_token) ?? "";
  const refreshToken = decryptSecret(row.cognito_refresh_token) ?? "";

  /**
   * ⚠ CHECKED HERE, IN THE SAME "BEFORE ANYTHING IS WRITTEN" SPOT AS THE PLATFORM CHECK ABOVE.
   *
   * These `writeSetting` calls put a credential back into `settings`, and those writes now REFUSE
   * when the keychain is unavailable (database.ts). A refusal from the middle of this sequence is the
   * worst case in the file: `syncActiveAccountFromSettings()` has already run, so the OUTGOING
   * session has been mirrored away, and a throw would leave the app with neither account usable —
   * losing a working session to gain a broken one, which is precisely what the platform check exists
   * to prevent.
   *
   * Only when there is actually a credential to store: an account row with no token restores a
   * signed-out shell, which needs no keychain.
   */
  if ((token || refreshToken) && !isSecretStorageAvailable()) {
    return {
      ok: false,
      error:
        "This computer's keychain is unavailable, so this account's saved credentials cannot be " +
        "restored securely. The app will not store them unencrypted.",
    };
  }

  /**
   * ── ⚠ `server_url` IS NOT WRITTEN HERE ANY MORE ────────────────────────────────────────────
   *
   * It is a PLATFORM key, and the platform keys have exactly three documented writers: `platform:connect`,
   * `platform:reset` and `consumePlatformSeed`. Writing it from a switch let an account row move the origin
   * every authenticated request goes to, without the fingerprint that describes it — leaving the origin and
   * the fingerprint naming different platforms, which is the very state the boot drift check reads to decide
   * whether to sign the user out.
   *
   * ⚠ AND NOTHING IS LOST BY DROPPING IT, because the switch above already refuses unless the row's
   * platform matches the configured one. If they match, the configured `server_url` is already right;
   * if they do not, the switch never gets here. A row that disagrees is refused rather than applied,
   * which is the same fail-closed direction as the keychain check.
   */
  if (row.server_url && row.server_url !== readSetting(SESSION_KEYS.serverUrl)) {
    return {
      ok: false,
      error:
        `${row.email} signed in to ${row.platform_url || row.server_url}, which is not the platform ` +
        `this app is connected to. Change the platform in Account to sign in as them.`,
    };
  }

  writeSetting(SESSION_KEYS.authToken, token);
  writeSetting(SESSION_KEYS.refreshToken, refreshToken);
  writeSetting(SESSION_KEYS.teamId, row.team_id ?? "");
  writeSetting(SESSION_KEYS.teamName, row.team_name ?? "");
  writeSetting(SESSION_KEYS.workshopId, row.workshop_id ?? "");
  writeSetting(SESSION_KEYS.inviteCode, row.team_invite_code ?? "");
  writeSetting(SESSION_KEYS.userEmail, row.email);
  writeSetting(SESSION_KEYS.userId, row.id);
  writeSetting(SESSION_KEYS.userName, row.name ?? "");
  writeSetting("active_user_id", row.id);

  // Reflect gating flags so App.tsx routes to the right screen.
  writeSetting("connected", token ? "true" : "false");
  writeSetting("team_joined", row.team_id ? "true" : "false");

  db.prepare("UPDATE accounts SET last_active_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );

  return { ok: true, teamJoined: !!row.team_id };
}

/**
 * ── ⚠ FORGETTING A CREDENTIAL LOCALLY IS NOT INVALIDATING IT ───────────────────────────────────
 *
 * Nothing in the tree ever revoked either credential: sign-out blanked local rows, `removeAccount` was a bare
 * `DELETE FROM accounts`, `platform:reset` cleared the config. All three DISCARD a credential and none of
 * them ended its life at Cognito, so a refresh token copied off the machine beforehand kept working for the
 * remainder of its 30-day lifetime — and there was no mechanism in this client to stop that.
 *
 * This is that mechanism, and all three paths use it: `signOutAccount` (which keeps the row and clears
 * its credential), `removeAccount` and `forgetAccountsForPlatform`. The sign-out rule settled the one
 * that was a trade rather than an oversight — signing in again after sign-out requires the username and
 * password — so nothing in this app now discards a credential locally
 * without trying to end it at Cognito as well.
 *
 * ⚠ BEST-EFFORT AND RECORDED, NEVER FATAL. The caller is deleting the row either way; failing the
 * deletion because a network request timed out would strand the user in the state they asked to
 * leave. So the outcome becomes an audit record — an unrevoked token is a fact worth having — and the
 * local delete proceeds.
 *
 * @returns whether the credential is now dead at Cognito, for the caller's audit detail.
 */
async function revokeStoredCredential(refreshToken: string | null): Promise<string> {
  const token = decryptSecret(refreshToken);
  if (!token) return "no-token";

  const platform = readPlatformConfig();
  if (!platform) return "no-platform";

  const result = await revokeRefreshToken(platform, token);
  if (result.ok) return "revoked";
  /**
   * ⚠ `unsupported` NAMES A POOL MISCONFIGURATION, and it is worth its own code in the log: Cognito
   * answers that when the app client has token revocation disabled, which no client-side change can
   * work around. An operator reading "revoke:unsupported" knows where to look; "revoke:failed" does
   * not tell them the request was refused rather than lost.
   */
  return `revoke-failed:${result.reason}`;
}

/**
 * ── ⚠ SIGN OUT MEANS OUT: THE STORED CREDENTIAL GOES TOO ───────────────────────────────────────
 *
 * THE RULE: sign-out logs the user out and clears the login session; signing in again requires the
 * username and password.
 *
 * Sign-out used to be a purely LOCAL wipe of the session settings, and it deliberately left this row's
 * `auth_token` and 30-day `cognito_refresh_token` in place so the user could switch back without
 * re-authenticating. That trade is now decided explicitly rather than inherited — the other way, and
 * this function is the decision.
 *
 * ⚠ THE ROW SURVIVES, THE CREDENTIAL DOES NOT, and the distinction is what keeps the account chooser
 * useful. The row carries the email, the display name and the last team, so the account still appears
 * in the switcher and still says who it is — and `switchAccount` already handles a row with no token
 * correctly: it writes `connected = "false"`, which lands the app on the sign-in screen. So switching
 * to a signed-out account asks for the password, which is exactly the rule.
 *
 * ⚠ REVOKED FIRST, THEN CLEARED. The other order deletes the only copy of the token this process has
 * and then tries to revoke it — a local wipe dressed up as a revocation.
 *
 * ⚠ AND IT TOUCHES ONE ROW. Another saved account left signed in from an earlier switch keeps its own
 * credential, because the user never signed THAT session out — `auth:removeAccount` and
 * `platform:reset` are what end those, and both now revoke as well.
 *
 * @returns a short code for the audit detail: what happened to the credential at Cognito.
 */
export async function signOutAccount(accountId: string): Promise<string> {
  const db = getDb();
  const row = db
    .prepare("SELECT cognito_refresh_token FROM accounts WHERE id = ?")
    .get(accountId) as { cognito_refresh_token: string | null } | undefined;
  if (!row) return "no-row";

  const revocation = await revokeStoredCredential(row.cognito_refresh_token);

  /**
   * ⚠ NULL, NOT "". The column is nullable and `decryptSecret(null)` is the "no credential" case every
   * reader already handles; an empty string would be a stored value that decrypts to nothing, which
   * `switchAccount` would then treat as a token it has.
   */
  db.prepare(
    "UPDATE accounts SET auth_token = NULL, cognito_refresh_token = NULL WHERE id = ?"
  ).run(accountId);

  return revocation;
}

/** Forget a saved account, and end its credential's life at Cognito first. */
export async function removeAccount(accountId: string): Promise<{ ok: boolean; revocation: string }> {
  const db = getDb();
  const row = db
    .prepare("SELECT cognito_refresh_token FROM accounts WHERE id = ?")
    .get(accountId) as { cognito_refresh_token: string | null } | undefined;

  // Read BEFORE the delete, obviously — but stated because the ordering is the whole function.
  const revocation = row ? await revokeStoredCredential(row.cognito_refresh_token) : "no-row";
  db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  return { ok: true, revocation };
}

/**
 * ── ⚠ FORGET EVERY ACCOUNT SAVED FOR A PLATFORM BEING LEFT ────────────────────────────────────
 *
 * `platform:reset` is the "disconnect from this experience" action, and the confirmation the user is shown
 * says outright: "You'll be signed out, and the saved accounts for it will be forgotten" (AccountPanel.tsx).
 * It tore down the session and cleared the eight platform settings — and left the `accounts` table untouched,
 * so every row's encrypted bearer and 30-DAY REFRESH TOKEN stayed on disk indefinitely, with no in-app way to
 * see or clear them: the account list is not reachable from the unconfigured state.
 *
 * So a participant who deliberately left a platform on a shared laptop left live renewal credentials
 * for it behind, believing the dialog.
 *
 * ⚠ ROWS WITH A NULL FINGERPRINT GO TOO, and that is deliberate rather than sloppy. A null means
 * "written before platform scoping", i.e. this install has only ever had one platform — the one being
 * disconnected — so those rows belong to it. Keeping them would leave exactly the credentials this
 * function exists to remove, on exactly the installs that upgraded into the feature.
 *
 * @param fingerprint the platform being left, or null when this install never recorded one.
 * @returns how many rows were forgotten, for the audit record.
 */
export async function forgetAccountsForPlatform(
  fingerprint: string | null
): Promise<{ forgotten: number; revoked: number }> {
  const db = getDb();

  /**
   * ⚠ THE TOKENS ARE REVOKED BEFORE THE ROWS GO, and sequentially rather than in parallel. Leaving a
   * platform is a deliberate, one-off act on a shared machine — the exact scenario this finding is
   * about — so the credentials being discarded are worth ending at Cognito rather than merely
   * deleting. Sequential because a workshop laptop has a handful of accounts and a burst of identical
   * unauthenticated POSTs is the shape that gets throttled.
   */
  const rows = db
    .prepare(
      "SELECT id, cognito_refresh_token FROM accounts WHERE config_fingerprint IS ? OR config_fingerprint IS NULL"
    )
    .all(fingerprint) as Array<{ id: string; cognito_refresh_token: string | null }>;

  let revoked = 0;
  for (const row of rows) {
    if ((await revokeStoredCredential(row.cognito_refresh_token)) === "revoked") revoked++;
  }

  const result = db
    .prepare("DELETE FROM accounts WHERE config_fingerprint IS ? OR config_fingerprint IS NULL")
    .run(fingerprint);
  /* better-sqlite3 reports `changes`; node:sqlite reports the same field. */
  return { forgotten: Number((result as { changes?: number | bigint })?.changes ?? 0), revoked };
}
