// The governing security condition — the two remaining ways a bearer could reach the
// renderer, and the sign-out path the allowlist depends on.
//
//  1. `ai:renewToken` used to RETURN the renewed ID token to the renderer
//     (BoardView called it as a fallback). It must now return a status only.
//  2. Sign-out moved into main, because the renderer can no longer write the
//     credential keys — and because clearing the settings rows alone left
//     main's in-memory cached bearer live for the rest of the process.

import { describe, it, expect, vi, beforeEach } from "vitest";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp", setBadgeCount: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("ws", () => ({ default: class {} }));

const store = new Map<string, string>();
const writeSetting = vi.fn((key: string, value: string) => {
  store.set(key, value);
});

vi.mock("../database", async () => {
  // isSensitiveSetting must be the REAL one: setting-access.ts (imported
  // transitively by ai.ts) validates its allowlists against it at module load and
  // throws if a credential key ever appears there.
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    readSetting: (key: string) => store.get(key) ?? null,
    writeSetting: (key: string, value: string) => writeSetting(key, value),
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
  };
});

/**
 * ⚠ `signOutAccount` IS PART OF SIGN-OUT NOW, so the mock records what it was asked to do.
 *
 * THE RULE: sign-out logs the user out and clears the login session; signing in again requires the
 * username and password. Sign-out used to be a purely local
 * wipe that left the saved row's bearer and 30-day refresh token in place; it now revokes that
 * credential at Cognito and clears the columns. The revocation itself is covered in
 * cognito-refresh.test.ts and the row update in accounts.platform.test.ts — here the question is only
 * that the handler calls it, for the right account, before the teardown.
 */
const signedOutAccounts: string[] = [];
vi.mock("../accounts", () => ({
  upsertActiveAccount: vi.fn(),
  syncActiveAccountFromSettings: vi.fn(),
  listAccounts: vi.fn(() => ({ accounts: [], activeUserId: null })),
  switchAccount: vi.fn(() => ({ ok: true })),
  removeAccount: vi.fn(async () => ({ ok: true, revocation: "revoked" })),
  signOutAccount: vi.fn(async (id: string) => {
    signedOutAccounts.push(id);
    return "revoked";
  }),
}));

// The refresh grant. Returns a fresh ID token when the stored refresh token is
// live, null when it is not.
const refreshCognitoTokens = vi.fn();

vi.mock("../cognito-oauth", () => ({ loginWithHostedUi: vi.fn() }));

/**
 * Renewal now goes through `cognito-idp` — the same API the native SRP form used to sign in.
 * A prior refresh-token gate was the mismatch between that and the Hosted UI `/oauth2/token`; see
 * cognito-refresh.ts. Mocked to drive the success and failure paths.
 */
vi.mock("../cognito-refresh", () => ({
  refreshViaCognitoIdp: (...args: unknown[]) => refreshCognitoTokens(...args),
}));

import { setupAIHandlers } from "./ai";
import { SIGN_OUT_SETTINGS } from "../setting-access";

setupAIHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return Promise.resolve(handler({}, ...args));
}

/**
 * An ID token carrying `sub`, for the renewal-binding tests below.
 *
 * UNSIGNED, deliberately: the renewal path binds on the SUBJECT and does not re-verify the
 * signature — the token arrives in the body of main's own TLS response from `cognito-idp`, so its
 * origin is already established and a JWKS fetch there would add a fail-closed network dependency
 * to the one function that must survive a blip. See the note in `renewAuthToken`.
 */
function idTokenFor(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ sub })}.signature-not-checked-here`;  // nosemgrep: missing-template-string-indicator
}

beforeEach(() => {
  store.clear();
  /**
   * A COMPLETE platform config, not just `server_url`.
   *
   * The refresh grant now takes its pool config from the CONFIGURED platform rather than
   * fetching `/v1/auth/config` — so the value it authenticates against is the one that
   * was validated. `readPlatformConfig` treats a partial config as unconfigured, so
   * seeding only the origin would make every renewal return `{ ok: false }` for the
   * wrong reason and these tests would pass or fail for nothing to do with sign-out.
   */
  store.set("cognito_pool_id", "us-east-1_Abc123");
  store.set("server_url", "https://backend.example");
  store.set("cognito_issuer", "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Abc123");
  store.set("cognito_client_id", "client-1");
  store.set("cognito_authorization_endpoint", "https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize");
  store.set("cognito_token_endpoint", "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token");
  writeSetting.mockClear();
  refreshCognitoTokens.mockReset();
  signedOutAccounts.length = 0;
});

describe("ai:renewToken never returns the token", () => {
  it("returns { ok: true } on a successful renewal, not the token", async () => {
    store.set("cognito_refresh_token", "live-refresh-token");
    refreshCognitoTokens.mockResolvedValue({
      ok: true,
      tokens: { idToken: "brand-new-id-token", accessToken: "a", expiresIn: 1800 },
    });

    const res = await invoke("ai:renewToken");

    expect(res).toEqual({ ok: true });
    // The renewed token must appear NOWHERE in the IPC reply.
    expect(JSON.stringify(res)).not.toContain("brand-new-id-token");
    // It is still persisted for main's own use.
    expect(writeSetting).toHaveBeenCalledWith("auth_token", "brand-new-id-token");
  });

  it("returns { ok: false } when the session cannot be renewed", async () => {
    store.set("cognito_refresh_token", "expired-refresh-token");
    // `revoked` is the only outcome that ends a session — a network failure must not.
    refreshCognitoTokens.mockResolvedValue({ ok: false, reason: "revoked" });

    expect(await invoke("ai:renewToken")).toEqual({ ok: false });
  });

  /**
   * ⚠ A NETWORK FAILURE MUST NOT END THE SESSION.
   *
   * `ai:renewToken` returning false sends the user back to sign-in, so treating a dropped
   * connection as a revocation would sign out a whole workshop on one wifi blip. The stored
   * bearer is kept and the caller retries on the next request; only `revoked` is terminal.
   */
  it("KEEPS the session when renewal fails for network reasons", async () => {
    store.set("cognito_refresh_token", "live-refresh-token");
    store.set("auth_token", "still-valid-token");
    refreshCognitoTokens.mockResolvedValue({ ok: false, reason: "network" });

    expect(await invoke("ai:renewToken")).toEqual({ ok: true });
    // And the stored bearer is untouched — nothing was cleared.
    expect(store.get("auth_token")).toBe("still-valid-token");
  });

  /**
   * ── ⚠ A RENEWED TOKEN FOR A DIFFERENT PERSON IS REFUSED ─────────────────────────────────────
   *
   * The refresh grant sends only `ClientId` + `REFRESH_TOKEN`, so ANY refresh token minted for this app
   * client is accepted — including another participant's in the same workshop pool. `auth:completeSignIn`
   * verified the ID token thoroughly and took the refresh token on a `typeof` check, so renderer-resident
   * code could sign in as the victim and substitute somebody else's refresh token; from the first renewal on,
   * every request carried the other identity while local rows stayed scoped to the victim.
   */
  it("⚠ REFUSES a renewed token whose subject is not the signed-in user", async () => {
    store.set("cognito_refresh_token", "someone-elses-refresh-token");
    store.set("user_id", "victim-sub");
    store.set("auth_token", "victims-token");
    refreshCognitoTokens.mockResolvedValue({
      ok: true,
      tokens: { idToken: idTokenFor("attacker-sub"), accessToken: "a", expiresIn: 1800 },
    });

    expect(await invoke("ai:renewToken")).toEqual({ ok: false });
    // The substituted token must NOT have become the bearer.
    expect(writeSetting).not.toHaveBeenCalledWith("auth_token", idTokenFor("attacker-sub"));
    // And the foreign 30-day credential is discarded, not left to re-refuse on every request.
    expect(store.get("cognito_refresh_token")).toBe("");
  });

  it("accepts a renewed token that names the signed-in user", async () => {
    store.set("cognito_refresh_token", "live-refresh-token");
    store.set("user_id", "victim-sub");
    const renewed = idTokenFor("victim-sub");
    refreshCognitoTokens.mockResolvedValue({
      ok: true,
      tokens: { idToken: renewed, accessToken: "a", expiresIn: 1800 },
    });

    expect(await invoke("ai:renewToken")).toEqual({ ok: true });
    expect(writeSetting).toHaveBeenCalledWith("auth_token", renewed);
  });

  /** `active_user_id` is the switching key, so on a multi-account machine it is the binding. */
  it("binds to the ACTIVE account when several are saved", async () => {
    store.set("cognito_refresh_token", "live-refresh-token");
    store.set("user_id", "first-sub");
    store.set("active_user_id", "switched-to-sub");
    refreshCognitoTokens.mockResolvedValue({
      ok: true,
      tokens: { idToken: idTokenFor("first-sub"), accessToken: "a", expiresIn: 1800 },
    });

    // Names `user_id` but NOT the account currently switched to — still a mismatch.
    expect(await invoke("ai:renewToken")).toEqual({ ok: false });
  });

  it("returns { ok: false } when there is no refresh token at all", async () => {
    expect(await invoke("ai:renewToken")).toEqual({ ok: false });
    expect(refreshCognitoTokens).not.toHaveBeenCalled();
  });

  it("never returns a string (the old contract the renderer relied on)", async () => {
    store.set("cognito_refresh_token", "live");
    refreshCognitoTokens.mockResolvedValue({
      ok: true,
      tokens: { idToken: "tok", accessToken: "a", expiresIn: 1800 },
    });
    // A renderer that still did `token = await api.renewAuthToken()` would get an
    // object, not a bearer — the exposure is closed by shape, not by convention.
    expect(typeof (await invoke("ai:renewToken"))).toBe("object");
  });
});

describe("auth:signOut", () => {
  it("clears every sign-out setting, including all three credential keys", async () => {
    for (const key of SIGN_OUT_SETTINGS) store.set(key, "some-live-value");

    const res = await invoke("auth:signOut");

    expect(res).toEqual({ ok: true });
    for (const key of SIGN_OUT_SETTINGS) {
      expect(writeSetting).toHaveBeenCalledWith(key, "");
      expect(store.get(key)).toBe("");
    }
    for (const key of ["auth_token", "cognito_refresh_token", "user_password"]) {
      expect(store.get(key)).toBe("");
    }
  });

  /**
   * ── ⚠ MEMBERSHIP, NOT ITERATION — WHICH IS WHY THE GAP ABOVE SURVIVED ───────────────────────
   *
   * The case above loops `SIGN_OUT_SETTINGS` and asserts each member is cleared. That passes for
   * whatever the list happens to contain, so it can never catch a key MISSING from it — and one was:
   * `workshop_id`, the fourth tenant key, while its three siblings `team_id`, `team_name` and
   * `team_invite_code` were all listed.
   *
   * The `…-jarvisdeploy` profile sat signed out with `team_id`, `user_email`, `connected` and
   * `active_user_id` correctly empty and `workshop_id = 01M0XEG0…` still standing — a profile claiming a
   * workshop it had no session for.
   *
   * So this asserts the RULE the list is supposed to express: every tenant key goes, every platform key
   * stays. A fifth tenant key added tomorrow fails here rather than surviving a sign-out in the field.
   */
  it("⚠ clears every TENANT key, workshop_id included", () => {
    for (const key of ["team_id", "team_name", "team_invite_code", "workshop_id"]) {
      expect(SIGN_OUT_SETTINGS, `${key} is who you were working WITH — signing out ends it`).toContain(
        key
      );
    }
  });

  /**
   * The other half of the same rule, and the reason it is not just "clear everything": these say WHICH
   * DEPLOYMENT this install belongs to, not who is signed in. Wiping them would drop the user back to
   * the connect screen on every sign-out and erase the fingerprint the drift check compares against.
   */
  it("⚠ keeps every PLATFORM key, so signing out does not disconnect the install", () => {
    for (const key of [
      "server_url",
      "portal_url",
      "cognito_pool_id",
      "cognito_client_id",
      "cognito_issuer",
      "platform_config_fingerprint",
    ]) {
      expect(SIGN_OUT_SETTINGS, `${key} describes the platform, not the session`).not.toContain(key);
    }
  });

  /** And behaviourally, since the list is only a list until something reads it. */
  it("⚠ a signed-out profile no longer claims a workshop", async () => {
    store.set("workshop_id", "01M0XEG0TAEVXC0A452Q4MHCKM");
    store.set("team_id", "01M0XEKGAH9BTWP045MNRDGEG1");

    await invoke("auth:signOut");

    expect(store.get("workshop_id"), "activeExperience() would otherwise scope reads by it").toBe("");
    expect(store.get("team_id")).toBe("");
  });

  it("drops main's cached bearer so later requests cannot reuse it", async () => {
    // Establish a cached token via a successful renewal...
    store.set("cognito_refresh_token", "live-refresh-token");
    refreshCognitoTokens.mockResolvedValue({
      ok: true,
      tokens: { idToken: "cached-id-token", accessToken: "a", expiresIn: 1800 },
    });
    await invoke("ai:renewToken");

    // ...then sign out. Both the settings row AND the module-level cache must be
    // gone: clearing only the row (what the renderer used to do) left the cached
    // bearer authorising requests for the signed-out user until the app quit.
    await invoke("auth:signOut");

    // Prove it through an observable path: getMyTeams goes through fetchAuthed,
    // which falls back to the settings row when the cache is empty. With the
    // refresh grant now failing, an empty cache means the request is never made.
    refreshCognitoTokens.mockResolvedValue({ ok: false, reason: "revoked" });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ teams: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await invoke("ai:getMyTeams");

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("is idempotent — signing out twice is harmless", async () => {
    await invoke("auth:signOut");
    await expect(invoke("auth:signOut")).resolves.toEqual({ ok: true });
  });

  it("does not clear settings outside the sign-out list", async () => {
    // The user's assistant choice, folder and preferences survive a sign-out, as
    // they did before: only session state is wiped.
    const kept = ["ai_assistant", "ai_command", "project_path", "notify_sound", "telemetry_enabled"];
    for (const key of kept) store.set(key, "keep-me");

    await invoke("auth:signOut");

    for (const key of kept) {
      expect(store.get(key)).toBe("keep-me");
    }
  });

  /**
   * ── ⚠ SIGNING OUT ENDS THE STORED CREDENTIAL, NOT JUST THE LIVE SESSION ────────────────────
   *
   * THE RULE: sign-out logs the user out and clears the login session; signing in again requires the
   * username and password.
   *
   * The wipe above is LOCAL: it clears the settings rows. The saved `accounts` row kept its own copy of the
   * bearer and the 30-day refresh token so switching back needed no password, and nothing anywhere revoked
   * either — so a token copied off the machine beforehand stayed usable for the rest of its life.
   */
  it("signs the stored account out too, so switching back costs a password", async () => {
    store.set("user_id", "user-1");

    await invoke("auth:signOut");

    expect(signedOutAccounts).toEqual(["user-1"]);
  });

  /** The switcher's key wins over the plain sign-in key — the same rule every scoped query uses. */
  it("signs out the SWITCHED account when there is one", async () => {
    store.set("user_id", "user-1");
    store.set("active_user_id", "user-2");

    await invoke("auth:signOut");

    expect(signedOutAccounts).toEqual(["user-2"]);
  });

  /**
   * ⚠ RESOLVED BEFORE THE TEARDOWN, because `tearDownSession` blanks `user_id` — read afterwards there
   * would be no account to sign out and no subject to attribute the audit event to. Asserted through an
   * observable consequence rather than by ordering the source: the call happened AND it carried an id.
   */
  it("resolves the account before the settings are wiped", async () => {
    store.set("user_id", "user-1");

    await invoke("auth:signOut");

    expect(signedOutAccounts).toEqual(["user-1"]);
    expect(store.get("user_id"), "and the settings really were wiped afterwards").toBe("");
  });

  /**
   * ⚠ A REVOCATION THAT CANNOT BE MADE MUST NOT BLOCK THE SIGN-OUT. The user asked to be signed out;
   * the local wipe is the part they can see, and stranding them signed in because a network request
   * failed would be the wrong trade. The outcome is recorded instead — see `signOutAccount`.
   */
  it("still signs out when there is no account row to revoke", async () => {
    // No user_id at all: nothing to revoke, and sign-out still completes.
    const res = await invoke("auth:signOut");

    expect(res).toEqual({ ok: true });
    expect(signedOutAccounts).toEqual([]);
  });
});
