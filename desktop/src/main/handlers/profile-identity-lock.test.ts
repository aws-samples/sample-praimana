// ── ⚠ ONE PROFILE, ONE IDENTITY — ENFORCED IN MAIN, NOT BY A READONLY ATTRIBUTE ─────────────────
//
// The state that prompted it, read from a live install: the `…-jarvisdeploy` profile had accumulated
// THREE `accounts` rows across TWO identities pointing at two different backends, and a sign-out had left the workshop pointer of only
// one of them behind. A profile is presented as "your" workspace; a second identity signing into it
// makes that quietly untrue.
//
// ── ⚠ WHY THE TEST IS HERE AND NOT ONLY IN THE RENDERER ──
//
// `readOnly` on an input is a hint. This codebase treats the renderer document as the adversary — the
// read-only-role comment in shared/types/user.ts puts it as "defense-in-depth, not UI-only" — so the
// rule lives in `adoptSession`, which is the one function BOTH sign-in paths call
// (`auth:completeSignIn` and `ai:login`). A rule enforced at one of two doors is not a rule, which is
// the shape half the findings in the last security report had.
//
// ⚠ AND THE EMAIL COMPARED IS THE VERIFIED ONE. It comes from a token whose signature, issuer,
// audience, `token_use` and expiry have already been checked by `verifyIdTokenForAdoption` — never from
// a string the renderer typed, which would make the whole check theatre.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createSign, type KeyObject } from "crypto";

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => {
      handlers.set(channel, listener);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp", setBadgeCount: vi.fn(), getVersion: () => "0.0.0-test" },
  safeStorage: { isEncryptionAvailable: () => true },
  shell: { openExternal: vi.fn() },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("ws", () => ({ default: class {} }));

const store = new Map<string, string>();
const writeSetting = vi.fn((key: string, value: string) => {
  store.set(key, value);
});

vi.mock("../database", async () => {
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    EncryptionUnavailableError: actual.EncryptionUnavailableError,
    isSecretStorageAvailable: () => true,
    assertSecretStorageAvailable: () => {},
    readSetting: (key: string) => store.get(key) ?? null,
    writeSetting: (key: string, value: string) => writeSetting(key, value),
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
  };
});

/**
 * The identities this profile is pretending to already hold. Set per test — this is the one input the
 * rule reads, so it is the only thing these cases vary.
 */
let remembered: string[] = [];

/**
 * The durable binding, modelled separately from `remembered` because the whole point of it is that the
 * two have DIFFERENT lifetimes: `platform:reset` deletes the accounts rows and keeps the binding.
 */
let bound: string | null = null;

vi.mock("../accounts", () => ({
  upsertActiveAccount: vi.fn(),
  syncActiveAccountFromSettings: vi.fn(),
  listAccounts: vi.fn(() => ({ accounts: [], activeUserId: null })),
  switchAccount: vi.fn(() => ({ ok: true })),
  removeAccount: vi.fn(() => ({ ok: true })),
  bindProfileIdentity: vi.fn((email: unknown) => {
    // First writer wins, as the real one does.
    if (!bound && typeof email === "string" && email.trim()) bound = email.trim().toLowerCase();
  }),
  releaseProfileIdentity: vi.fn(() => {
    bound = null;
  }),
  profileIdentity: vi.fn(() => {
    const all = [...new Set([...remembered, ...(bound ? [bound] : [])])];
    return { count: all.length, onlyEmail: all.length === 1 ? all[0] : null };
  }),
  /** The real predicate's contract: never foreign on an empty profile; case- and space-insensitive. */
  isForeignToProfile: vi.fn((email: unknown) => {
    if (typeof email !== "string" || !email.trim()) return false;
    const known = [...remembered, ...(bound ? [bound] : [])];
    if (known.length === 0) return false;
    return !known.includes(email.trim().toLowerCase());
  }),
}));

vi.mock("../cognito-oauth", () => ({ loginWithHostedUi: vi.fn() }));
vi.mock("../cognito-refresh", () => ({ refreshViaCognitoIdp: vi.fn() }));

import { setupAIHandlers } from "./ai";
import { __resetJwksCache } from "../jwt-verify";

setupAIHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for "${channel}"`);
  return Promise.resolve(handler({}, ...args));
}

const POOL = "us-east-1_Abc123";
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const CLIENT_ID = "client-1";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

let signingKey: { publicKey: KeyObject; privateKey: KeyObject };

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeToken(email: string, sub = "user-uuid-1"): string {
  const header = { alg: "RS256", kid: "kid-1", typ: "JWT" };
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    token_use: "id",
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub,
    email,
    "cognito:groups": ["PARTICIPANT"],
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(signingKey.privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

beforeEach(() => {
  store.clear();
  remembered = [];
  bound = null;
  __resetJwksCache();
  signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

  store.set("cognito_pool_id", POOL);
  store.set("server_url", "https://backend.example");
  store.set("cognito_issuer", ISSUER);
  store.set("cognito_client_id", CLIENT_ID);
  store.set(
    "cognito_authorization_endpoint",
    "https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize"
  );
  store.set("cognito_token_endpoint", "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token");
  writeSetting.mockClear();

  vi.stubGlobal("fetch", (url: string) => {
    if (String(url) === JWKS_URL) {
      const jwk = signingKey.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [{ ...jwk, kid: "kid-1", alg: "RS256", use: "sig" }] }), {
          status: 200,
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("⚠ a second identity cannot be added to a profile that already has one", () => {
  it("refuses the foreign address, and says what to do instead", async () => {
    remembered = ["owner@example.com"];

    const res = await invoke("auth:completeSignIn", makeToken("someone.else@example.com"));

    expect(res.ok).toBe(false);
    expect(res.foreignIdentity, "the renderer needs to tell this apart from a bad password").toBe(
      true
    );
    // The remedy is the whole point of the message — a refusal with no next step reads as a bug.
    expect(res.error).toMatch(/switch to its profile or create a new one/i);
  });

  /**
   * ⚠ NOTHING IS WRITTEN, WHICH IS THE HALF THAT WOULD HURT. `adoptSession` documents why it checks
   * before its first write: a refusal from the middle leaves `user_email`, `user_id` and `connected`
   * persisted with no bearer — "a state whose only exit is Sign out". A half-adopted foreign identity
   * would be worse than the accident being prevented.
   */
  it("⚠ writes nothing at all — not even the non-secret half of the session", async () => {
    remembered = ["owner@example.com"];

    await invoke("auth:completeSignIn", makeToken("someone.else@example.com"));

    for (const key of ["auth_token", "user_id", "user_email", "connected", "cognito_refresh_token"]) {
      expect(writeSetting, `${key} must not be written`).not.toHaveBeenCalledWith(
        key,
        expect.anything()
      );
    }
  });

  it("does not reject the IPC call — a raw rejection reads as a crash", async () => {
    remembered = ["owner@example.com"];
    await expect(
      invoke("auth:completeSignIn", makeToken("someone.else@example.com"))
    ).resolves.toBeTruthy();
  });
});

describe("the rule only ever narrows a profile that already has an identity", () => {
  it("a FRESH profile signs in exactly as before", async () => {
    remembered = [];
    const res = await invoke("auth:completeSignIn", makeToken("anybody@example.com"));
    expect(res).toMatchObject({ ok: true });
    expect(writeSetting).toHaveBeenCalledWith("user_id", "user-uuid-1");
  });

  it("the profile's OWN identity still signs in", async () => {
    remembered = ["owner@example.com"];
    const res = await invoke("auth:completeSignIn", makeToken("owner@example.com"));
    expect(res).toMatchObject({ ok: true });
  });

  /**
   * ⚠ THE CASE THAT WOULD OTHERWISE BE A LOCKOUT, and the reason the renderer does not lock its field
   * when a profile has several identities. `…-jarvisdeploy` really holds two, and the account SWITCHER
   * was deleted (SettingsView records why: it disclosed every previous user's email on a shared
   * machine). So if the field were pinned to one of them, the other's chats and projects — which live
   * in that profile and nowhere else — would be unreachable by any route at all.
   */
  it("⚠ EVERY identity a multi-identity profile already holds can still sign in", async () => {
    remembered = ["first@example.com", "second@example.com"];

    for (const email of remembered) {
      writeSetting.mockClear();
      const res = await invoke("auth:completeSignIn", makeToken(email));
      expect(res, `${email} already has data in this profile`).toMatchObject({ ok: true });
    }
  });

  it("but a THIRD, new identity is still refused there", async () => {
    remembered = ["first@example.com", "second@example.com"];
    const res = await invoke("auth:completeSignIn", makeToken("third@example.com"));
    expect(res.ok).toBe(false);
    expect(res.foreignIdentity).toBe(true);
  });
});

describe("⚠ the binding outlives the accounts row, which is what the first version got wrong", () => {
  /**
   * ⚠ THE FIRST VERSION READ ONLY THE `accounts` TABLE, AND THE REPORTED FLOW EMPTIES IT.
   * `platform:reset` — "Sign in to another experience", which is what you reach for when a portal link
   * is for a different workspace — calls `forgetAccountsForPlatform`, deleting the rows for the platform
   * being left. Verified on the reporter's machine: `…-codevibranium` had ZERO accounts rows and an empty
   * `user_email`, so it was indistinguishable from a profile nobody had used and the lock did nothing.
   */
  it("⚠ still recognises the owner after a reset has forgotten every accounts row", async () => {
    // Signed in once: the binding is established.
    await invoke("auth:completeSignIn", makeToken("owner@example.com"));
    expect(bound, "the first sign-in binds the profile").toBe("owner@example.com");

    // A reset forgets the rows. The binding is what is left.
    remembered = [];

    const res = await invoke("auth:completeSignIn", makeToken("someone.else@example.com"));

    expect(res.ok, "a different address is still refused").toBe(false);
    expect(res.foreignIdentity).toBe(true);
  });

  it("⚠ and the field can still be locked, because one identity is still known", async () => {
    await invoke("auth:completeSignIn", makeToken("owner@example.com"));
    remembered = [];

    await expect(invoke("auth:profileIdentity")).resolves.toEqual({
      count: 1,
      onlyEmail: "owner@example.com",
    });
  });

  it("the owner themselves still signs in with nothing but the binding", async () => {
    await invoke("auth:completeSignIn", makeToken("owner@example.com"));
    remembered = [];

    await expect(invoke("auth:completeSignIn", makeToken("owner@example.com"))).resolves.toMatchObject(
      { ok: true }
    );
  });

  /**
   * ⚠ FIRST WRITER WINS. A profile belongs to whoever established it, not to the most recent visitor —
   * otherwise the binding would follow whoever last got in and guard nothing.
   */
  it("does not re-bind to a later identity", async () => {
    await invoke("auth:completeSignIn", makeToken("owner@example.com"));
    remembered = ["owner@example.com", "second@example.com"];

    await invoke("auth:completeSignIn", makeToken("second@example.com"));

    expect(bound).toBe("owner@example.com");
  });

  /**
   * ⚠ AND IT IS RELEASED WHEN THE EXPERIENCE CHANGES, which is the other half. The model is one
   * profile per experience, with different email addresses for different experiences or teams, so a profile
   * repointed at another platform legitimately expects a different address — `platform:connect` on a
   * changed fingerprint and `platform:reset` both call `releaseProfileIdentity`, and holding the binding
   * across that would be a lockout rather than a guard.
   */
  it("⚠ a released binding admits a new identity again", async () => {
    await invoke("auth:completeSignIn", makeToken("owner@example.com"));
    remembered = [];

    // What platform:reset / a changed platform:connect do.
    const { releaseProfileIdentity } = await import("../accounts");
    releaseProfileIdentity();

    await expect(
      invoke("auth:completeSignIn", makeToken("different-experience@example.com"))
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("the comparison is on the identity, not on its spelling", () => {
  it("matches regardless of case and surrounding space", async () => {
    remembered = ["owner@example.com"];
    for (const spelling of ["Owner@Example.com", "  owner@example.com  ", "OWNER@EXAMPLE.COM"]) {
      const res = await invoke("auth:completeSignIn", makeToken(spelling));
      expect(res, `${spelling} is the same person`).toMatchObject({ ok: true });
    }
  });
});

describe("what the pre-sign-in screen is allowed to learn", () => {
  /**
   * ⚠ A COUNT, AND AT MOST ONE ADDRESS — pinned as the CONTRACT, not as a privacy control.
   *
   * An earlier version of this file justified it with the disclosure SettingsView cites for deleting the
   * account switcher. That is not the threat model: one person uses this machine and
   * holds several addresses, one per experience or team, so the sign-in field now shows the full address.
   *
   * The assertion stays because the SHAPE is what the renderer is written against — `onlyEmail` is the
   * signal that locks the field, and `null` is what tells it not to. Widening this to the full list is a
   * deliberate change (it is what a "pick which of your accounts" chooser would need), and it should
   * break a test rather than silently alter what the pre-sign-in screen receives.
   */
  it("returns a count and no address for a multi-identity profile", async () => {
    remembered = ["first@example.com", "second@example.com"];
    const res = await invoke("auth:profileIdentity");

    expect(res.count).toBe(2);
    expect(res.onlyEmail, "two identities: nothing to lock the field to").toBeNull();
    expect(JSON.stringify(res)).not.toContain("first@example.com");
    expect(JSON.stringify(res)).not.toContain("second@example.com");
  });

  it("returns the single address, which is what lets the UI lock its field", async () => {
    remembered = ["owner@example.com"];
    await expect(invoke("auth:profileIdentity")).resolves.toEqual({
      count: 1,
      onlyEmail: "owner@example.com",
    });
  });

  it("reports a fresh profile as having none", async () => {
    remembered = [];
    await expect(invoke("auth:profileIdentity")).resolves.toEqual({ count: 0, onlyEmail: null });
  });
});
