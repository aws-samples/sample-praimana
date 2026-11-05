// `auth:completeSignIn` — the handler that turns a RENDERER-SUPPLIED ID token into a local session.
//
// ── ⚠ THIS HANDLER HAD NO TESTS AT ALL ─────────────────────────────────────────────────────────
//
// It is the app's only path from "the renderer says here is a token" to a stored session, a local
// role gate and the `user_id` that scopes every local database query — and none of it was covered.
// A suite that never invokes it passes whatever the handler does, which is how a signature check
// could be added (or removed) with every test still green.
//
// Signatures are REAL here: a generated RSA keypair signs the tokens, the public half is served as a
// JWKS from a stubbed fetch, and only the network is faked. See jwt-verify.test.ts for the same
// reasoning applied to the verifier itself.

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
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("ws", () => ({ default: class {} }));

const store = new Map<string, string>();
const writeSetting = vi.fn((key: string, value: string) => {
  store.set(key, value);
});

/**
 * ⚠ THE KEYCHAIN IS PART OF THIS HANDLER'S CONTRACT NOW. `adoptSession` refuses to store a session
 * when secrets cannot be encrypted (database.ts), so these tests have to say whether it can — and the
 * default is YES, because these cases are about the sign-in itself. `keychainAvailable = false` drives
 * the refusal case below.
 */
let keychainAvailable = true;

vi.mock("../database", async () => {
  const actual = await vi.importActual<typeof import("../database")>("../database");
  return {
    isSensitiveSetting: actual.isSensitiveSetting,
    // The real class, so `instanceof` in the handler matches what this mock throws.
    EncryptionUnavailableError: actual.EncryptionUnavailableError,
    isSecretStorageAvailable: () => keychainAvailable,
    assertSecretStorageAvailable: (what = "your sign-in") => {
      if (!keychainAvailable) throw new actual.EncryptionUnavailableError(what);
    },
    readSetting: (key: string) => store.get(key) ?? null,
    writeSetting: (key: string, value: string) => writeSetting(key, value),
    getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
  };
});

vi.mock("../accounts", () => ({
  upsertActiveAccount: vi.fn(),
  syncActiveAccountFromSettings: vi.fn(),
  listAccounts: vi.fn(() => ({ accounts: [], activeUserId: null })),
  switchAccount: vi.fn(() => ({ ok: true })),
  removeAccount: vi.fn(() => ({ ok: true })),
  /**
   * ⚠ A FRESH PROFILE, so every case in this file signs in exactly as it did before the one-identity
   * rule existed. That is the right default here: this file is about the ADMISSION checks (issuer,
   * audience, signature, role gate) and the keychain refusal, and a profile that already belongs to
   * somebody else is a different question with its own file (profile-identity-lock.test.ts).
   */
  profileIdentity: vi.fn(() => ({ count: 0, onlyEmail: null })),
  isForeignToProfile: vi.fn(() => false),
  /** No-ops: this file is about the admission checks, and a fresh profile binds without consequence. */
  bindProfileIdentity: vi.fn(),
  releaseProfileIdentity: vi.fn(),
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
let jwksRequests = 0;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A token with the claims this handler checks, correctly signed unless told otherwise. */
function makeToken(
  overrides: Record<string, unknown> = {},
  opts: { key?: KeyObject; kid?: string } = {}
): string {
  const header = { alg: "RS256", kid: opts.kid ?? "kid-1", typ: "JWT" };
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    token_use: "id",
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "user-uuid-1",
    email: "participant@example.com",
    "cognito:groups": ["PARTICIPANT"],
    ...overrides,
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(opts.key ?? signingKey.privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

beforeEach(() => {
  store.clear();
  __resetJwksCache();
  jwksRequests = 0;
  signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });

  // A COMPLETE platform config — readPlatformConfig treats a partial one as unconfigured, which
  // would make every case below fail for the wrong reason.
  store.set("cognito_pool_id", POOL);
  store.set("server_url", "https://backend.example");
  store.set("cognito_issuer", ISSUER);
  store.set("cognito_client_id", CLIENT_ID);
  store.set("cognito_authorization_endpoint", "https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize");
  store.set("cognito_token_endpoint", "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token");
  writeSetting.mockClear();

  vi.stubGlobal("fetch", (url: string) => {
    const target = String(url);
    if (target === JWKS_URL) {
      jwksRequests++;
      const jwk = signingKey.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [{ ...jwk, kid: "kid-1", alg: "RS256", use: "sig" }] }), {
          status: 200,
        })
      );
    }
    // Any other call (the best-effort profile lookup) is not what these tests are about.
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a genuine sign-in still works — the non-regression that matters", () => {
  it("accepts a correctly signed token for an allowed role and stores the session", async () => {
    const res = await invoke("auth:completeSignIn", makeToken());

    expect(res).toMatchObject({ ok: true });
    expect(writeSetting).toHaveBeenCalledWith("auth_token", expect.any(String));
    expect(writeSetting).toHaveBeenCalledWith("user_id", "user-uuid-1");
  });

  it("accepts an EXECUTIVE too", async () => {
    // DESKTOP_APP_ROLES is exactly [EXECUTIVE, PARTICIPANT] — an executive is both staff in the
    // portal and a desktop user, which is why the gate is not the complement of the staff check.
    const res = await invoke("auth:completeSignIn", makeToken({ "cognito:groups": ["EXECUTIVE"] }));
    expect(res).toMatchObject({ ok: true });
  });
});

/**
 * ── ⚠ A VALID SIGN-IN IS REFUSED WHEN THE SECRET CANNOT BE STORED SAFELY ──────────────────────
 *
 * Now it refuses — and the token, the role and the signature here are all VALID, which is the point: the
 * refusal is about this machine, not this account.
 *
 * ⚠ ASSERTED BEHAVIOURALLY, not by reading the source, because the thing that matters is what the
 * handler RETURNS and what it leaves behind. The two failure modes a source check cannot see are an
 * uncaught throw arriving as a raw IPC rejection, and a half-written session.
 */
describe("no keychain, no stored session", () => {
  it("refuses a perfectly good sign-in, and says why", async () => {
    keychainAvailable = false;
    try {
      const res = await invoke("auth:completeSignIn", makeToken());

      expect(res).toMatchObject({ ok: false });
      // Actionable, and clearly about the computer rather than the credentials.
      expect((res as { error: string }).error).toMatch(/keychain/i);
      expect((res as { error: string }).error).toMatch(/gnome-keyring|kwallet/i);
    } finally {
      keychainAvailable = true;
    }
  });

  it("⚠ leaves NOTHING behind — not even the non-secret half of the session", async () => {
    /**
     * The partial-write case, which is why the check runs before the first write rather than at each
     * one. `user_email`, `user_id` and `connected` are not secrets and would have been written
     * happily; the app would then relaunch believing it is signed in with no bearer to prove it, and
     * the only way out is Sign out.
     */
    keychainAvailable = false;
    try {
      await invoke("auth:completeSignIn", makeToken());

      for (const key of ["auth_token", "cognito_refresh_token", "user_id", "user_email", "connected"]) {
        expect(writeSetting, `${key} must not be written`).not.toHaveBeenCalledWith(
          key,
          expect.anything()
        );
      }
    } finally {
      keychainAvailable = true;
    }
  });

  it("does not reject the IPC call — a raw rejection reads as a crash", async () => {
    // "Error invoking remote method 'auth:completeSignIn'" tells a participant nothing.
    keychainAvailable = false;
    try {
      await expect(invoke("auth:completeSignIn", makeToken())).resolves.toMatchObject({ ok: false });
    } finally {
      keychainAvailable = true;
    }
  });
});

describe("the signature is now required", () => {
  it("REFUSES a token signed by another key, and stores nothing", async () => {
    // Well-formed, right issuer, right audience, unexpired — and minted by somebody else.
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

    const res = await invoke("auth:completeSignIn", makeToken({}, { key: attacker.privateKey }));

    expect(res).toMatchObject({ ok: false });
    // No session, no token, no identity — the refusal must leave nothing behind.
    expect(writeSetting).not.toHaveBeenCalledWith("auth_token", expect.anything());
    expect(writeSetting).not.toHaveBeenCalledWith("user_id", expect.anything());
  });

  it("REFUSES a token whose groups were tampered with after signing", async () => {
    // The exact escalation the role gate cared about: re-write the payload to grant a group.
    const token = makeToken();
    const [h, , s] = token.split(".");
    const forged = b64url(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        token_use: "id",
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: "user-uuid-1",
        "cognito:groups": ["EXECUTIVE"],
      })
    );

    const res = await invoke("auth:completeSignIn", `${h}.${forged}.${s}`);

    expect(res).toMatchObject({ ok: false });
    expect(writeSetting).not.toHaveBeenCalledWith("user_id", expect.anything());
  });

  it("REFUSES an unsigned (alg: none) token", async () => {
    const h = b64url(JSON.stringify({ alg: "none", kid: "kid-1" }));
    const p = b64url(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        token_use: "id",
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: "attacker",
      })
    );

    expect(await invoke("auth:completeSignIn", `${h}.${p}.`)).toMatchObject({ ok: false });
  });

  it("refuses when the signing keys cannot be fetched — fail closed, not open", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));

    const res = await invoke("auth:completeSignIn", makeToken());

    expect(res).toMatchObject({ ok: false });
    expect(writeSetting).not.toHaveBeenCalledWith("auth_token", expect.anything());
  });
});

describe("the cheap claim checks still run FIRST", () => {
  it("refuses a wrong-issuer token WITHOUT fetching any signing keys", async () => {
    // Ordering is deliberate: no network round trip for a token already known to be for another
    // pool, and no way to make this handler probe an arbitrary issuer's JWKS.
    const res = await invoke(
      "auth:completeSignIn",
      makeToken({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other" })
    );

    expect(res).toMatchObject({ ok: false });
    expect(jwksRequests).toBe(0);
  });

  it("refuses a token for a different app client without a fetch", async () => {
    const res = await invoke("auth:completeSignIn", makeToken({ aud: "some-other-client" }));
    expect(res).toMatchObject({ ok: false });
    expect(jwksRequests).toBe(0);
  });

  it("refuses an access token without a fetch", async () => {
    const res = await invoke("auth:completeSignIn", makeToken({ token_use: "access" }));
    expect(res).toMatchObject({ ok: false });
    expect(jwksRequests).toBe(0);
  });

  it("refuses an expired token without a fetch", async () => {
    const res = await invoke("auth:completeSignIn", makeToken({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(res).toMatchObject({ ok: false });
    expect(jwksRequests).toBe(0);
  });

  it("refuses a missing or non-string token", async () => {
    expect(await invoke("auth:completeSignIn", "")).toMatchObject({ ok: false });
    expect(await invoke("auth:completeSignIn", undefined)).toMatchObject({ ok: false });
    expect(await invoke("auth:completeSignIn", 42)).toMatchObject({ ok: false });
    expect(jwksRequests).toBe(0);
  });
});

describe("the role gate is enforced on a VERIFIED token", () => {
  it("refuses a role the desktop app is not for, leaving no session", async () => {
    const res = await invoke("auth:completeSignIn", makeToken({ "cognito:groups": ["ADMIN"] }));

    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/executives and participants/i);
    // Refused BEFORE adoptSession, so nothing is left signed in to a state the UI cannot serve.
    expect(writeSetting).not.toHaveBeenCalledWith("auth_token", expect.anything());
  });

  it("treats absent or unrecognised groups as PARTICIPANT, which IS allowed", async () => {
    /**
     * ⚠ ASSERTING THE REAL RULE, NOT THE ONE I EXPECTED. `collapseCognitoGroups` documents
     * "Unknown/empty → PARTICIPANT (the least privileged), so a missing claim can never grant
     * elevated access" — so a groupless token signs in as a participant rather than being refused.
     *
     * Worth pinning precisely because it is the counter-intuitive case: it looks like a hole and is
     * in fact the fail-closed direction for a platform whose default role is the weakest one. What
     * makes it safe is the signature check above — before it, ANY claim could be invented; now the
     * pool has to have actually issued this token.
     */
    expect(await invoke("auth:completeSignIn", makeToken({ "cognito:groups": [] }))).toMatchObject({
      ok: true,
    });
    expect(
      await invoke("auth:completeSignIn", makeToken({ "cognito:groups": ["NotARole"] }))
    ).toMatchObject({ ok: true });
  });

  it("REFUSES the staff-only roles", async () => {
    for (const group of ["ADMIN", "FACILITATOR", "JUDGE"]) {
      const res = await invoke("auth:completeSignIn", makeToken({ "cognito:groups": [group] }));
      expect(res, group).toMatchObject({ ok: false });
    }
  });
});
