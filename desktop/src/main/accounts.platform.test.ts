// ── SAVED ACCOUNTS ARE SCOPED TO A PLATFORM ────────────────────────────────────
//
// The app can be pointed at a different platform now, and each platform is a different
// Cognito pool. A saved account's stored bearer and refresh token belong to exactly one
// of them, so restoring an account across platforms would produce an app that reports
// "signed in" while every request 401s — and it would overwrite the CURRENT working
// session on the way there.
//
// The rule is: keep those accounts VISIBLE and refuse the switch with an
// explanation. A filtered list reads as "the app forgot my account"; a labelled row that
// says why it cannot be used tells the user what to change.
//
// These tests pin both halves, plus the legacy case that must NOT be broken: rows saved
// before platform scoping existed carry no fingerprint and have to keep working.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
}));
vi.mock("better-sqlite3", () => ({ default: class {} }));

const settings = new Map<string, string>();

/** One saved account row, as the `accounts` table holds it. */
interface Row {
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
  last_active_at: string;
}

const rows = new Map<string, Row>();

/**
 * A stand-in for better-sqlite3 that understands only the shapes accounts.ts actually
 * uses. Matching on a distinctive fragment of each statement rather than parsing SQL: the
 * point is to exercise the module's DECISIONS (which row, refuse or proceed, what gets
 * written), and a real SQL engine would add nothing to that while requiring the native
 * module the test runner cannot load.
 */
vi.mock("./database", () => ({
  readSetting: (key: string) => settings.get(key) ?? null,
  writeSetting: (key: string, value: string) => {
    settings.set(key, value);
  },
  encryptSecret: (v: string) => v,
  decryptSecret: (v: string | null) => v,
  /**
   * ⚠ TRUE HERE, and it has to be stated. `switchAccount` now refuses BEFORE its first write when
   * secrets cannot be stored encrypted — restoring an account writes its token back into `settings`.
   * These cases are about the PLATFORM check, so the keychain is assumed working; the refusal itself
   * is covered in no-plaintext-credentials.test.ts.
   */
  isSecretStorageAvailable: () => true,
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (arg?: unknown) => {
        if (sql.includes("SELECT 1 FROM accounts")) {
          return rows.has(String(arg)) ? { 1: 1 } : undefined;
        }
        if (sql.includes("SELECT * FROM accounts")) {
          return rows.get(String(arg));
        }
        // The narrow reads `signOutAccount` and `removeAccount` do before touching the row.
        if (sql.includes("SELECT cognito_refresh_token FROM accounts")) {
          const row = rows.get(String(arg));
          return row ? { cognito_refresh_token: row.cognito_refresh_token } : undefined;
        }
        return undefined;
      },
      all: (arg?: unknown) => {
        /**
         * `forgetAccountsForPlatform` reads the rows it is about to delete, so their refresh tokens can
         * be revoked at Cognito first — see the note there. Matched on the fingerprint clause, and the
         * NULL arm is deliberate: an unfingerprinted row belongs to the only platform this install has
         * ever had, which is the one being left.
         */
        if (sql.includes("config_fingerprint IS ?")) {
          const fingerprint = arg === undefined ? null : (arg as string | null);
          return [...rows.values()].filter(
            (r) => r.config_fingerprint === fingerprint || r.config_fingerprint === null
          );
        }
        return [...rows.values()].sort((a, b) => b.last_active_at.localeCompare(a.last_active_at));
      },
      run: (params?: any) => {
        if (sql.includes("INSERT INTO accounts")) {
          const existing = rows.get(params.id);
          rows.set(params.id, {
            ...(existing ?? {}),
            id: params.id,
            email: params.email,
            name: params.name,
            server_url: params.serverUrl,
            auth_token: params.authToken,
            cognito_refresh_token: params.refreshToken,
            team_id: params.teamId,
            team_name: params.teamName,
            workshop_id: params.workshopId,
            team_invite_code: params.inviteCode,
            platform_url: params.platformUrl,
            config_fingerprint: params.fingerprint,
            last_active_at: params.now,
          });
        } else if (sql.includes("SET auth_token = NULL")) {
          /**
           * `signOutAccount` — THE RULE: sign-out keeps the row and destroys its credential, so
           * the switcher still names the account while getting back into it costs a password.
           */
          const existing = rows.get(String(params));
          if (existing) {
            rows.set(String(params), {
              ...existing,
              auth_token: null,
              cognito_refresh_token: null,
            });
          }
          return undefined;
        } else if (sql.includes("DELETE FROM accounts") && sql.includes("config_fingerprint")) {
          /**
           * `forgetAccountsForPlatform` — the one statement here that BINDS POSITIONALLY, and its
           * NULL clause is deliberate: a row with no fingerprint predates platform scoping, so on an
           * install that has only ever had the platform being left, it belongs to that platform.
           */
          const fingerprint = params === undefined ? null : (params as string | null);
          let changes = 0;
          for (const [id, r] of [...rows]) {
            if (r.config_fingerprint === fingerprint || r.config_fingerprint === null) {
              rows.delete(id);
              changes++;
            }
          }
          return { changes };
        } else if (sql.includes("UPDATE accounts SET")) {
          const existing = rows.get(params.id);
          if (existing) {
            rows.set(params.id, {
              ...existing,
              server_url: params.serverUrl,
              auth_token: params.authToken,
              cognito_refresh_token: params.refreshToken,
              team_id: params.teamId,
              team_name: params.teamName,
              workshop_id: params.workshopId,
              team_invite_code: params.inviteCode,
              platform_url: params.platformUrl,
              config_fingerprint: params.fingerprint,
              last_active_at: params.now,
            });
          }
        }
        return undefined;
      },
    }),
  }),
}));

import {
  listAccounts,
  switchAccount,
  upsertActiveAccount,
  forgetAccountsForPlatform,
  signOutAccount,
} from "./accounts";

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

/**
 * Configure the app as being on a given platform.
 *
 * Keyed on the API ORIGIN (`server_url`), which is how `accounts.ts` identifies a platform:
 * it is the durable, human-meaningful value a refused switch can name back to the user
 * ("this account signed in to <url>"). The pool id is set too, since a real install has one.
 */
function onPlatform(apiOrigin: string, fingerprint: string | null) {
  settings.set("server_url", apiOrigin);
  settings.set("cognito_pool_id", "us-east-1_Abc123");
  if (fingerprint) settings.set("platform_config_fingerprint", fingerprint);
  else settings.delete("platform_config_fingerprint");
}

function saveRow(overrides: Partial<Row> & { id: string; email: string }) {
  rows.set(overrides.id, {
    name: null,
    server_url: "https://api.a.example",
    auth_token: "token",
    cognito_refresh_token: "refresh",
    team_id: "team-1",
    team_name: "Team One",
    workshop_id: "ws-1",
    team_invite_code: "CODE",
    platform_url: "https://a.example",
    config_fingerprint: FP_A,
    last_active_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as Row);
}

beforeEach(() => {
  settings.clear();
  rows.clear();
});

describe("listAccounts", () => {
  it("KEEPS accounts from other platforms in the list, flagged rather than hidden", () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });
    saveRow({
      id: "u2",
      email: "elsewhere@example.com",
      config_fingerprint: FP_B,
      platform_url: "https://b.example",
    });

    const { accounts, currentPlatformUrl } = listAccounts();

    expect(accounts).toHaveLength(2);
    expect(currentPlatformUrl).toBe("https://api.a.example");
    expect(accounts.find((a) => a.id === "u1")?.onCurrentPlatform).toBe(true);
    // Visible, marked unusable, and carrying the URL the UI needs to explain itself.
    const other = accounts.find((a) => a.id === "u2");
    expect(other?.onCurrentPlatform).toBe(false);
    expect(other?.platformUrl).toBe("https://b.example");
  });

  it("never returns a token, on any row", () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "u1", email: "mine@example.com" });

    const serialised = JSON.stringify(listAccounts());
    expect(serialised).not.toContain("token");
    expect(serialised).not.toContain("refresh");
  });
});

describe("switchAccount across platforms", () => {
  it("allows a switch within the same platform", () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });

    const result = switchAccount("u1");
    expect(result.ok).toBe(true);
    expect(settings.get("user_email")).toBe("mine@example.com");
  });

  it("REFUSES a switch to an account from another platform, naming where it belongs", () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({
      id: "u2",
      email: "elsewhere@example.com",
      config_fingerprint: FP_B,
      platform_url: "https://b.example",
    });

    const result = switchAccount("u2");
    expect(result.ok).toBe(false);
    // The message has to name the platform to change TO: "wrong platform" alone is an
    // error the user cannot act on.
    expect(result.error).toContain("https://b.example");
    expect(result.error).toContain("elsewhere@example.com");
  });

  /**
   * ⚠ THE REFUSAL MUST NOT DAMAGE THE CURRENT SESSION.
   *
   * The check runs BEFORE `syncActiveAccountFromSettings` and before any write, so a
   * refused switch leaves both accounts exactly as they were. Get this wrong and the user
   * loses a working session to gain a broken one — strictly worse than the bug the
   * refusal exists to prevent.
   */
  it("writes NOTHING when it refuses", () => {
    onPlatform("https://api.a.example", FP_A);
    settings.set("user_email", "current@example.com");
    settings.set("auth_token", "current-token");
    settings.set("connected", "true");
    saveRow({
      id: "u2",
      email: "elsewhere@example.com",
      config_fingerprint: FP_B,
      platform_url: "https://b.example",
    });

    switchAccount("u2");

    expect(settings.get("user_email")).toBe("current@example.com");
    expect(settings.get("auth_token")).toBe("current-token");
    expect(settings.get("connected")).toBe("true");
  });

  /**
   * ⚠ LEGACY ROWS MUST KEEP WORKING. Migration 8 back-fills `platform_url` but
   * deliberately NOT the fingerprint, because none was recorded per-account before it
   * existed and an invented one would be a guess the switch path then trusts. NULL means
   * "unknown, allow, re-stamp on next sign-in" — refusing instead would lock people out
   * of accounts that work today, to prevent a failure the existing 401 → refresh →
   * auth:expired path already handles.
   */
  it("allows a switch to a legacy row that has no fingerprint", () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "old", email: "legacy@example.com", config_fingerprint: null });

    expect(switchAccount("old").ok).toBe(true);
  });

  it("allows a switch when the APP has no fingerprint yet — an install mid-upgrade", () => {
    // Settings exist but nothing has been saved through savePlatformConfig yet. Signing
    // this user out would punish them for upgrading.
    onPlatform("https://api.a.example", null);
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });

    expect(switchAccount("u1").ok).toBe(true);
  });

  it("still refuses an unknown account", () => {
    onPlatform("https://api.a.example", FP_A);
    expect(switchAccount("nope").ok).toBe(false);
  });

  /**
   * ── ⚠ WITH NO PLATFORM AT ALL, THERE IS NOTHING TO BE THE SAME AS ────────────────────────
   *
   * `platform:reset` blanks all eight platform settings, and the guard read `!accountFingerprint ||
   * !currentFingerprint → allow` — so in exactly that state a switch restored the decrypted bearer, the
   * 30-day refresh token and `connected=true` for the platform the participant had just deliberately left,
   * stamping no fingerprint, leaving the boot drift check nothing to compare.
   *
   * ⚠ AND THE PREDICATE IS "IS THERE A PLATFORM", NOT "IS THERE A FINGERPRINT" — the case above this
   * one (a configured install mid-upgrade) must keep working, and it does.
   */
  it("REFUSES a switch when no platform is configured at all", () => {
    settings.clear();
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });

    const result = switchAccount("u1");
    expect(result.ok).toBe(false);
    expect(settings.get("auth_token"), "no credential may be restored").toBeUndefined();
  });

  /**
   * ⚠ AND A ROW CANNOT MOVE THE ORIGIN. `server_url` is a PLATFORM key with three documented writers
   * — platform:connect, platform:reset, consumePlatformSeed — and a switch was a fourth, so an account
   * row could point every authenticated request somewhere else without the fingerprint that describes
   * it. The switch refuses instead.
   */
  it("REFUSES a row whose own origin is not the configured one", () => {
    onPlatform("https://api.a.example", null);
    saveRow({
      id: "u1",
      email: "mine@example.com",
      server_url: "https://api.elsewhere.example",
      config_fingerprint: null,
    });

    expect(switchAccount("u1").ok).toBe(false);
    expect(settings.get("server_url"), "the configured origin is untouched").toBe(
      "https://api.a.example"
    );
  });
});

/**
 * ── ⚠ DISCONNECTING FORGETS THE CREDENTIALS IT PROMISES TO FORGET ────────────────────────────
 *
 * `platform:reset` cleared the config and the session and left the `accounts` table intact, so every saved
 * row's encrypted bearer and 30-DAY REFRESH TOKEN stayed on disk indefinitely — unreachable from inside the
 * app, because the account list is not shown once unconfigured. The confirmation dialog said the opposite:
 * "You'll be signed out, and the saved accounts for it will be forgotten."
 */
describe("forgetAccountsForPlatform", () => {
  it("deletes the rows for the platform being left, and reports how many", async () => {
    saveRow({ id: "a1", email: "a@example.com", config_fingerprint: FP_A });
    saveRow({ id: "a2", email: "b@example.com", config_fingerprint: FP_A });

    expect((await forgetAccountsForPlatform(FP_A)).forgotten).toBe(2);
    expect(listAccounts().accounts).toHaveLength(0);
  });

  it("leaves another platform's rows alone", async () => {
    saveRow({ id: "a1", email: "a@example.com", config_fingerprint: FP_A });
    saveRow({ id: "b1", email: "b@example.com", config_fingerprint: FP_B });

    expect((await forgetAccountsForPlatform(FP_A)).forgotten).toBe(1);
    expect(listAccounts().accounts.map((a) => a.id)).toEqual(["b1"]);
  });

  /**
   * ⚠ UNFINGERPRINTED ROWS GO TOO, and that is the case the fix would otherwise miss entirely. A NULL
   * means "saved before platform scoping existed", i.e. on an install that has only ever had the
   * platform now being disconnected — so those rows belong to it. Keeping them would leave exactly
   * the credentials this exists to remove, on exactly the installs that upgraded into the feature.
   */
  it("also forgets rows written before platform scoping existed", async () => {
    saveRow({ id: "legacy", email: "old@example.com", config_fingerprint: null });

    expect((await forgetAccountsForPlatform(FP_A)).forgotten).toBe(1);
    expect(listAccounts().accounts).toHaveLength(0);
  });

  /**
   * ── ⚠ AND IT TRIES TO END THE CREDENTIAL'S LIFE AT COGNITO ─────────────────────────────────
   *
   * A local delete forgets a credential; it does not invalidate it, so a refresh token copied off a shared
   * laptop before somebody disconnected kept working for the rest of its 30-day life.
   *
   * ⚠ NO PLATFORM CONFIGURED IN THIS FIXTURE, so the revocation cannot be attempted — which is the
   * property being asserted: it is BEST-EFFORT, and the rows go either way. Failing a disconnect
   * because a network request could not be made would strand the user in the state they asked to
   * leave. The revocation request itself is covered in cognito-refresh.test.ts.
   */
  it("still deletes the rows when the credential cannot be revoked", async () => {
    saveRow({ id: "a1", email: "a@example.com", config_fingerprint: FP_A });

    const result = await forgetAccountsForPlatform(FP_A);

    expect(result.forgotten).toBe(1);
    expect(result.revoked, "nothing could be revoked without a platform config").toBe(0);
    expect(listAccounts().accounts).toHaveLength(0);
  });
});

describe("upsertActiveAccount", () => {
  it("stamps the current platform, which is what upgrades a legacy row", () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "old", email: "legacy@example.com", config_fingerprint: null });
    settings.set("server_url", "https://api.a.example");

    upsertActiveAccount({ id: "old", email: "legacy@example.com" });

    expect(rows.get("old")?.config_fingerprint).toBe(FP_A);
    expect(rows.get("old")?.platform_url).toBe("https://api.a.example");
  });
});

/**
 * ── ⚠ SIGN OUT: THE ROW STAYS, THE CREDENTIAL GOES ────────────────────────────────────────────
 *
 * THE RULE: sign-out logs the user out and clears the login session; signing in again requires the
 * username and password.
 *
 * Sign-out was a purely local wipe of the SESSION settings; this row kept its own copy of the bearer and the
 * 30-day refresh token so switching back needed no password, and nothing anywhere revoked either. That trade
 * is now decided rather than inherited.
 */
describe("signOutAccount", () => {
  it("clears the credential but keeps the account listed", async () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });

    await signOutAccount("u1");

    // Still in the switcher, still says who it is — that is the half worth keeping.
    expect(listAccounts().accounts.map((a) => a.id)).toEqual(["u1"]);
    expect(listAccounts().accounts[0].email).toBe("mine@example.com");
  });

  /**
   * ⚠ THE PROPERTY THE RULE REQUIRES, asserted through the switch rather than the column: with no
   * credential, `switchAccount` writes `connected = "false"`, which is what lands the app on the
   * sign-in screen. Checking the column alone would prove the write and not the outcome.
   */
  it("makes switching back land on the sign-in screen", async () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });

    await signOutAccount("u1");
    settings.delete("auth_token");
    const result = switchAccount("u1");

    expect(result.ok, "the account is still switchable — it just has no session").toBe(true);
    expect(settings.get("connected"), "no token means not connected").toBe("false");
    expect(settings.get("auth_token") || "").toBe("");
    expect(settings.get("cognito_refresh_token") || "").toBe("");
  });

  /**
   * ⚠ AND IT TOUCHES ONE ROW. Another saved account left signed in by an earlier switch keeps its own
   * credential, because the user never signed THAT session out — `auth:removeAccount` and
   * `platform:reset` are what end those, and both revoke as well.
   */
  it("leaves another saved account's credential alone", async () => {
    onPlatform("https://api.a.example", FP_A);
    saveRow({ id: "u1", email: "mine@example.com", config_fingerprint: FP_A });
    saveRow({ id: "u2", email: "theirs@example.com", config_fingerprint: FP_A });

    await signOutAccount("u1");

    settings.delete("auth_token");
    switchAccount("u2");
    expect(settings.get("connected"), "u2 was never signed out").toBe("true");
  });

  it("is harmless for an account that is not there", async () => {
    expect(await signOutAccount("nope")).toBe("no-row");
  });
});
