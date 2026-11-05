import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { SignJWT } from "jose";
import { expiryOf, needsRefresh } from "./cognito-refresh";

/**
 * TOKEN REFRESH, the thing whose absence caused the reported "Backend error: 401".
 *
 * The Cognito ID token lives 30 minutes and nothing renewed it: NextAuth's `jwt` callback only
 * populated on initial sign-in. So somebody reading one page for 31 minutes had every subsequent
 * API call refused, and the page rendered it as a data-load failure.
 *
 * ── WHY THE HTTP CALL IS EXERCISED AGAINST A STUBBED `fetch` ──
 *
 * The CONTRACT with Cognito was verified against the real token endpoint, and the finding is
 * recorded in the module: probing the real token endpoint with a bogus token returns
 * `{"error":"invalid_grant"}` and NOT `invalid_client`, proving the secretless client's
 * `client_id`-in-body authentication is accepted. That is the part a stub could never establish.
 *
 * What the stub is for is the rest: that no Basic header is sent without a secret, that a missing
 * `id_token` is a failure rather than an undefined bearer, that a timeout returns null instead of
 * throwing, and that no token ever reaches a log line.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.COGNITO_HOSTED_UI_DOMAIN = "https://pool.auth.us-east-1.amazoncognito.com";
  process.env.COGNITO_CLIENT_ID = "client-abc";
  delete process.env.COGNITO_CLIENT_SECRET;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A real signed JWT, so `decodeJwt` reads a genuine `exp` rather than a hand-built string. */
async function tokenExpiringIn(seconds: number): Promise<string> {
  return new SignJWT({ "cognito:groups": ["PARTICIPANT"] })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
    .sign(new TextEncoder().encode("test-secret-not-verified-here"));
}

function stubFetch(reply: Partial<Response> | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.ok ?? true,
        status: reply.status ?? 200,
        json: reply.json ?? (async () => ({})),
        text: reply.text ?? (async () => ""),
      } as Response;
    })
  );
  return calls;
}

describe("needsRefresh, the skew is the point", () => {
  it("refreshes BEFORE expiry, not at it", () => {
    /**
     * Refreshing exactly at `exp` guarantees a race: a request already in flight carries the old
     * token and can land after it expired. The headroom is longer than any request here while
     * still using ~97% of a 30-minute token.
     */
    const now = 1_000_000;
    expect(needsRefresh(now + 30_000, now), "30s left ⇒ refresh").toBe(true);
    expect(needsRefresh(now + 5 * 60_000, now), "5min left ⇒ not yet").toBe(false);
  });

  it("treats an UNKNOWN expiry as needing refresh", () => {
    // Absent means we could not read the token's own claim. Assuming it is still good is exactly
    // the failure that produces a 401 on the next call.
    expect(needsRefresh(undefined, Date.now())).toBe(true);
    expect(needsRefresh(0, Date.now())).toBe(true);
  });

  it("refreshes an already-expired token", () => {
    const now = 1_000_000;
    expect(needsRefresh(now - 1, now)).toBe(true);
  });
});

describe("expiryOf reads the TOKEN's own exp", () => {
  it("returns the claim in epoch ms", async () => {
    /**
     * Read from the token rather than computed as `now + expires_in`, because the two disagree
     * whenever the server and client clocks differ, and this value decides when the next refresh
     * fires, so a skewed clock would either refresh constantly or refresh too late and 401.
     */
    const token = await tokenExpiringIn(1800);
    const exp = expiryOf(token);
    expect(exp).toBeGreaterThan(Date.now() + 1_700_000);
    expect(exp).toBeLessThan(Date.now() + 1_900_000);
  });

  it("treats an UNREADABLE token as already expired, not as valid forever", async () => {
    // Forces one more refresh attempt rather than trusting a bearer whose lifetime is unknown.
    expect(expiryOf("not-a-jwt")).toBe(0);
    expect(expiryOf("")).toBe(0);
    expect(needsRefresh(expiryOf("garbage"), Date.now())).toBe(true);
  });
});

describe("refreshCognitoIdToken", () => {
  it("posts a refresh_token grant with client_id in the BODY and no Basic header", async () => {
    /**
     * THE TRAP THIS PINS, and it is documented on the provider config too: a secretless Cognito
     * client that receives `Authorization: Basic base64(clientId:)` answers `invalid_client`.
     * Against the real endpoint, with `client_id` in the body the same endpoint answers `invalid_grant`,
     * i.e. client auth accepted and only the (bogus) token rejected.
     */
    const idToken = await tokenExpiringIn(1800);
    const calls = stubFetch({ json: async () => ({ id_token: idToken }) });
    const { refreshCognitoIdToken } = await import("./cognito-refresh");

    const res = await refreshCognitoIdToken("refresh-xyz");

    expect(res?.idToken).toBe(idToken);
    expect(calls[0].url).toBe(
      "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token"
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization, "no Basic auth without a secret").toBeUndefined();
    const body = String(calls[0].init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=client-abc");
    expect(body).toContain("refresh_token=refresh-xyz");
    // Bounded: this sits on the request path of a page load, so a hung IdP must not hold a
    // render open.
    expect(calls[0].init.signal).toBeTruthy();
  });

  it("DOES send Basic auth when a secret is configured", async () => {
    // Mirrors the provider's own conditional so the two cannot drift; a client that genuinely
    // has a secret must authenticate that way.
    process.env.COGNITO_CLIENT_SECRET = "s3cret";
    const idToken = await tokenExpiringIn(60);
    const calls = stubFetch({ json: async () => ({ id_token: idToken }) });
    const { refreshCognitoIdToken } = await import("./cognito-refresh");

    await refreshCognitoIdToken("r");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
  });

  it("returns the expiry from the NEW token", async () => {
    const idToken = await tokenExpiringIn(1800);
    stubFetch({ json: async () => ({ id_token: idToken }) });
    const { refreshCognitoIdToken } = await import("./cognito-refresh");

    const res = await refreshCognitoIdToken("r");

    expect(res?.expiresAt).toBe(expiryOf(idToken));
  });

  for (const [label, reply] of [
    ["invalid_grant, a spent or revoked token", { ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }],
    ["a 500 from the IdP", { ok: false, status: 500, text: async () => "" }],
    ["a timeout", Object.assign(new Error("aborted"), { name: "TimeoutError" })],
    ["a transport failure", new Error("ECONNREFUSED")],
    ["a 200 with no id_token", { json: async () => ({ access_token: "only-this" }) }],
    ["a 200 with a non-string id_token", { json: async () => ({ id_token: 42 }) }],
    ["non-JSON", { json: async () => { throw new Error("not json"); } }],
  ] as const) {
    it(`returns NULL rather than throwing on ${label}`, async () => {
      /**
       * NULL IS A THIRD ANSWER, DELIBERATELY. This runs inside NextAuth's `jwt` callback, and
       * throwing there destroys the session, turning a transient IdP blip into a forced
       * re-login with a password and a TOTP code. Null lets the caller keep the session, withhold
       * the bearer, and let the user's next action drive a clean redirect.
       */
      stubFetch(reply as Partial<Response> | Error);
      const { refreshCognitoIdToken } = await import("./cognito-refresh");

      await expect(refreshCognitoIdToken("r")).resolves.toBeNull();
    });
  }

  it("returns null WITHOUT a request when misconfigured or given no token", async () => {
    const calls = stubFetch({ json: async () => ({}) });
    const { refreshCognitoIdToken } = await import("./cognito-refresh");

    expect(await refreshCognitoIdToken("")).toBeNull();

    delete process.env.COGNITO_HOSTED_UI_DOMAIN;
    vi.resetModules();
    const { refreshCognitoIdToken: noDomain } = await import("./cognito-refresh");
    expect(await noDomain("r")).toBeNull();

    expect(calls, "must not fire a request it cannot form").toHaveLength(0);
  });

  it("NEVER logs the refresh token", async () => {
    /**
     * A refresh token is a 30-DAY credential. One in a log line is a credential sitting in
     * CloudWatch for the retention period, readable by anyone with log access, a far worse
     * exposure than the 30-minute bearer it renews.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' });
    const { refreshCognitoIdToken } = await import("./cognito-refresh");

    await refreshCognitoIdToken("super-secret-refresh-token");

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("super-secret-refresh-token");
    // The error CODE is logged, because that is what tells an operator whether to expect
    // re-authentication (spent token) or a retry (transient).
    expect(logged).toContain("invalid_grant");
  });
});
