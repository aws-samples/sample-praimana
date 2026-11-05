// ── RESOLVING AN ACCESS KEY INTO A PLATFORM ────────────────────────────────────
//
// The controls under test, in order of how much they matter:
//
//   1. The login endpoint comes from AWS's OIDC discovery document, and that document's
//      `issuer` must name the pool the Access Key asked about. That binding is what stops
//      a redirect, a stale response, or a substituted document from pointing sign-in at
//      another pool.
//   2. `assertAwsDiscoveryHost` — the endpoints must be AWS hosts. Belt and braces over
//      (1), because `authorizationEndpoint` is where a PERSON types a password.
//   3. A partial config is never persisted; a fingerprint change is what forces a
//      sign-out, and cosmetic differences must NOT read as a change.
//
// The Access Key codec itself (AES-256-GCM, tamper detection) is tested in the shared package
// and not repeated here.

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

// In-memory stand-in for the settings table. `transaction` runs straight through — the
// property under test is WHICH keys are written, not atomicity (better-sqlite3's job).
const store = new Map<string, string>();
vi.mock("./database", () => ({
  readSetting: (key: string) => store.get(key) ?? null,
  writeSetting: (key: string, value: string) => {
    store.set(key, value);
  },
  getDb: () => ({ transaction: (fn: () => void) => () => fn() }),
}));

import {
  assertAwsDiscoveryHost,
  configFingerprint,
  validateDiscovery,
  resolvePlatform,
  readPlatformConfig,
  savePlatformConfig,
  isPlatformConfigured,
  storedFingerprint,
  clearPlatformConfig,
  PlatformConfigError,
} from "./platform-config";

const POOL = "us-east-1_EXAMPLE01";
const CLIENT = "clientaaaaaaaaaaaaaaaaaaaa";
const API = "https://api.acme.example";
const ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL}`;
const AUTHZ = "https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize";
const TOKEN = "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token";

const PARAMS = { poolId: POOL, clientId: CLIENT, apiBaseUrl: API };

/** A discovery document as AWS actually serves one, with overrides. */
function discovery(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHZ,
    token_endpoint: TOKEN,
    scopes_supported: ["openid", "email", "profile", "phone"],
    ...overrides,
  };
}

/** A `fetch` that answers AWS discovery with `body`. */
function mockDiscovery(body: unknown, init: { status?: number } = {}) {
  return vi.fn(async () => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    body: null,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

describe("assertAwsDiscoveryHost", () => {
  it("accepts a Cognito Hosted UI host and the IdP host", () => {
    expect(() => assertAwsDiscoveryHost(AUTHZ, "sign-in endpoint")).not.toThrow();
    expect(() =>
      assertAwsDiscoveryHost("https://cognito-idp.eu-west-1.amazonaws.com/x", "issuer")
    ).not.toThrow();
  });

  /**
   * ⚠ THE PHISHING SHAPES. Each is a host an attacker can register, and each would pass a
   * naive `includes`/`endsWith` check. If any of these stops throwing, a substituted
   * discovery document could send a user's password to a look-alike page.
   */
  it.each([
    "https://evil-amazoncognito.com/oauth2/authorize",
    "https://pool.auth.us-east-1.amazoncognito.com.evil.test/oauth2/authorize",
    "https://evil.test/pool.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    "https://pool.auth.us-east-1.amazoncognito.com@evil.test/oauth2/authorize",
    "https://login.microsoftonline.com/oauth2/authorize",
    "https://cognito-idp.us-east-1.amazonaws.com.evil.test/x",
  ])("rejects a non-AWS host: %s", (endpoint) => {
    expect(() => assertAwsDiscoveryHost(endpoint, "sign-in endpoint")).toThrow(
      PlatformConfigError
    );
  });

  it("rejects plaintext even on an AWS-shaped host", () => {
    expect(() =>
      assertAwsDiscoveryHost("http://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize", "x")
    ).toThrow(PlatformConfigError);
  });

  it("rejects a malformed endpoint rather than passing it through", () => {
    expect(() => assertAwsDiscoveryHost("not a url", "x")).toThrow(PlatformConfigError);
    expect(() => assertAwsDiscoveryHost("", "x")).toThrow(PlatformConfigError);
  });
});

describe("validateDiscovery", () => {
  it("accepts a well-formed document and derives a fingerprint", () => {
    const config = validateDiscovery(PARAMS, discovery());
    expect(config.poolId).toBe(POOL);
    expect(config.region).toBe("us-east-1");
    expect(config.apiBaseUrl).toBe(API);
    expect(config.cognito.authorizationEndpoint).toBe(AUTHZ);
    expect(config.cognito.tokenEndpoint).toBe(TOKEN);
    expect(config.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * ⚠ THE BINDING THAT MAKES ALL OF THIS WORK.
   *
   * The document must name the pool we asked about. Without this check, a redirect, a
   * cached response, or a substituted document for ANOTHER pool would be accepted — and
   * the app would authenticate users against a pool the Access Key never named.
   */
  it("REFUSES a document whose issuer names a different pool", () => {
    const otherPool = discovery({
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Attacker",
    });
    expect(() => validateDiscovery(PARAMS, otherPool)).toThrow(/does not match the pool/);
  });

  it("refuses an issuer in a different region than the pool id", () => {
    // Same pool suffix, wrong region. The discovery URL was built from the pool's own
    // region, so this can only mean a substituted response.
    const wrongRegion = discovery({
      issuer: `https://cognito-idp.eu-west-1.amazonaws.com/${POOL}`,
    });
    expect(() => validateDiscovery(PARAMS, wrongRegion)).toThrow(/does not match the pool/);
  });

  it("applies the AWS-host control to the ENDPOINTS, not just the issuer", () => {
    // The attack this closes: a correct issuer alongside a hostile authorize endpoint.
    expect(() =>
      validateDiscovery(PARAMS, discovery({ authorization_endpoint: "https://evil.test/login" }))
    ).toThrow(/not an AWS Cognito host/);
    expect(() =>
      validateDiscovery(PARAMS, discovery({ token_endpoint: "https://evil.test/token" }))
    ).toThrow(/not an AWS Cognito host/);
  });

  it.each([
    ["issuer", { issuer: "" }],
    ["authorization_endpoint", { authorization_endpoint: "" }],
    ["token_endpoint", { token_endpoint: "" }],
  ])("rejects a document missing %s", (_name, override) => {
    expect(() => validateDiscovery(PARAMS, discovery(override))).toThrow(PlatformConfigError);
  });

  it("rejects non-object bodies rather than reading properties off them", () => {
    for (const body of [null, undefined, "a string", 42, []]) {
      expect(() => validateDiscovery(PARAMS, body)).toThrow(PlatformConfigError);
    }
  });

  /**
   * Scopes are INTERSECTED with what the pool supports. Requesting one the pool does not
   * support makes Cognito reject the authorize request outright, which presents to the
   * user as "sign-in is broken" with no clue why.
   */
  it("intersects requested scopes with what the pool supports", () => {
    const limited = validateDiscovery(PARAMS, discovery({ scopes_supported: ["openid", "email"] }));
    expect(limited.cognito.scopes).toEqual(["openid", "email"]);
  });

  it("falls back to the standard scopes when the document lists none", () => {
    expect(validateDiscovery(PARAMS, discovery({ scopes_supported: [] })).cognito.scopes).toEqual([
      "openid",
      "email",
      "profile",
    ]);
    expect(
      validateDiscovery(PARAMS, discovery({ scopes_supported: "nonsense" })).cognito.scopes
    ).toEqual(["openid", "email", "profile"]);
  });
});

describe("resolvePlatform", () => {
  it("fetches AWS discovery for the pool and resolves the platform", async () => {
    const fetchMock = mockDiscovery(discovery());
    vi.stubGlobal("fetch", fetchMock);

    const config = await resolvePlatform(PARAMS);

    expect(config.poolId).toBe(POOL);
    expect(config.cognito.authorizationEndpoint).toBe(AUTHZ);
    // ⚠ IT ASKED AWS, at the standard well-known path for the pool — not our own API.
    const url = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe(
      `https://cognito-idp.us-east-1.amazonaws.com/${POOL}/.well-known/openid-configuration`
    );
  });

  it("rejects a malformed pool id BEFORE any network call", async () => {
    const fetchMock = mockDiscovery(discovery());
    vi.stubGlobal("fetch", fetchMock);

    // The traversal case: an unvalidated pool id would move the discovery URL, and the login
    // page with it. Validation happens inside `oidcDiscoveryUrl`, before the fetch.
    await expect(resolvePlatform({ ...PARAMS, poolId: "x/../../evil.example/" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an unknown pool in terms the user can act on", async () => {
    vi.stubGlobal("fetch", mockDiscovery({}, { status: 404 }));
    await expect(resolvePlatform(PARAMS)).rejects.toThrow(/does not recognise the user pool/);
  });

  it("reports an unreadable document rather than throwing a parse error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: null,
        text: async () => "<html>not json</html>",
      })) as unknown as typeof fetch
    );
    await expect(resolvePlatform(PARAMS)).rejects.toThrow(/unreadable discovery document/);
  });

  it("reports a network failure with a next step", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch
    );
    await expect(resolvePlatform(PARAMS)).rejects.toThrow(/Could not reach AWS Cognito/);
  });
});

describe("configFingerprint", () => {
  const base = {
    poolId: POOL,
    apiBaseUrl: API,
    issuer: ISSUER,
    clientId: CLIENT,
    authorizationEndpoint: AUTHZ,
  };

  it("is stable for the same platform", () => {
    expect(configFingerprint(base)).toBe(configFingerprint(base));
  });

  /**
   * ⚠ COSMETIC DIFFERENCES MUST NOT READ AS A ROTATION. A fingerprint that changed on a
   * trailing slash or a capital letter would sign every user out on the next poll for no
   * reason — the worst kind of bug, because it looks like a security feature working.
   */
  it("ignores trailing slashes and host case", () => {
    expect(configFingerprint({ ...base, apiBaseUrl: `${API}/` })).toBe(configFingerprint(base));
    expect(configFingerprint({ ...base, apiBaseUrl: "https://API.Acme.Example" })).toBe(
      configFingerprint(base)
    );
  });

  it("does NOT fold case on the pool id or client id — both are case-sensitive", () => {
    // Folding would make two genuinely different pools/clients look like one platform.
    expect(configFingerprint({ ...base, poolId: POOL.toUpperCase() })).not.toBe(
      configFingerprint(base)
    );
    expect(configFingerprint({ ...base, clientId: CLIENT.toUpperCase() })).not.toBe(
      configFingerprint(base)
    );
  });

  it.each(["poolId", "apiBaseUrl", "issuer", "clientId", "authorizationEndpoint"] as const)(
    "changes when %s changes — this is what forces the sign-out",
    (field) => {
      const changed = {
        ...base,
        [field]:
          field === "clientId" || field === "poolId" ? "different" : "https://other.example",
      };
      expect(configFingerprint(changed)).not.toBe(configFingerprint(base));
    }
  );
});

describe("persistence", () => {
  it("round-trips a saved config", () => {
    savePlatformConfig(validateDiscovery(PARAMS, discovery()));

    expect(isPlatformConfigured()).toBe(true);
    const read = readPlatformConfig();
    expect(read?.poolId).toBe(POOL);
    expect(read?.apiBaseUrl).toBe(API);
    expect(read?.cognito.authorizationEndpoint).toBe(AUTHZ);
    expect(read?.cognito.tokenEndpoint).toBe(TOKEN);
    // Recomputed from the stored fields and equal to what was recorded — the equality the
    // drift check reads.
    expect(read?.fingerprint).toBe(storedFingerprint());
  });

  it("reports unconfigured when nothing is stored", () => {
    expect(isPlatformConfigured()).toBe(false);
    expect(readPlatformConfig()).toBeNull();
  });

  /**
   * A HALF-WRITTEN CONFIG IS "UNCONFIGURED", not "configured with gaps" — otherwise the
   * app enters sign-in with no pool to sign in against.
   */
  it.each([
    "cognito_pool_id",
    "server_url",
    "cognito_issuer",
    "cognito_client_id",
    "cognito_authorization_endpoint",
    "cognito_token_endpoint",
  ])("treats a config missing %s as unconfigured", (key) => {
    savePlatformConfig(validateDiscovery(PARAMS, discovery()));
    store.delete(key);
    expect(readPlatformConfig()).toBeNull();
    expect(isPlatformConfigured()).toBe(false);
  });

  it("reports a change when the platform is replaced, and none when it is re-saved", () => {
    const first = validateDiscovery(PARAMS, discovery());
    // Nothing recorded before, so the FIRST save is not a "change" — there is no session
    // to void on a fresh install.
    expect(savePlatformConfig(first).changed).toBe(false);
    expect(savePlatformConfig(first).changed).toBe(false);

    const other = validateDiscovery(
      { ...PARAMS, apiBaseUrl: "https://other.example" },
      discovery()
    );
    expect(savePlatformConfig(other).changed).toBe(true);
  });

  /**
   * ⚠ DETECTING A HAND-EDITED SETTINGS ROW. `readPlatformConfig` recomputes the
   * fingerprint from the stored fields rather than trusting the stored one, so a row edited
   * outside `savePlatformConfig` no longer matches. That mismatch is what
   * `checkPlatformDrift` reads.
   */
  it("recomputes the fingerprint, so a tampered row no longer matches the recorded one", () => {
    savePlatformConfig(validateDiscovery(PARAMS, discovery()));
    store.set("server_url", "https://attacker.example");
    expect(readPlatformConfig()?.fingerprint).not.toBe(storedFingerprint());
  });

  /**
   * ⚠ RESET CLEARS EVERYTHING, INCLUDING THE FINGERPRINT. Leaving the fingerprint behind would
   * put a recorded value on disk with no config to match it — a contradictory state the next
   * reader of these rows should not have to reason about.
   */
  it("clearPlatformConfig returns the install to unconfigured", () => {
    savePlatformConfig(validateDiscovery(PARAMS, discovery()));
    expect(isPlatformConfigured()).toBe(true);

    clearPlatformConfig();

    expect(isPlatformConfigured()).toBe(false);
    expect(readPlatformConfig()).toBeNull();
    expect(storedFingerprint()).toBeNull();
    expect(store.get("portal_url") || "").toBe("");
  });
});

