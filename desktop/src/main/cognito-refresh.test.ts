// ── RENEWAL, AND THE ONE DISTINCTION THAT MATTERS ───────────────────────────────
//
// The assertion this file exists for: a NETWORK failure must not be reported as a revoked
// token. The caller signs the user out on `revoked` and defers on `network`, so collapsing the
// two — as the old Hosted-UI refresher did, by swallowing everything into `null` — turns a
// dropped wifi connection into a forced sign-out. On a workshop day that is the whole cohort.
//
// Second: the request must go to `cognito-idp`, NOT the Hosted UI token endpoint. That mismatch
// is a known blocking gate, and using the same API that minted the token is what
// dissolves it rather than answering it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { refreshViaCognitoIdp, revokeRefreshToken } from "./cognito-refresh";
import type { PlatformConfig } from "./platform-config";

const PLATFORM: PlatformConfig = {
  poolId: "us-east-1_EXAMPLE01",
  region: "us-east-1",
  apiBaseUrl: "https://api.acme.example",
  cognito: {
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE01",
    clientId: "clientaaaaaaaaaaaaaaaaaaaa",
    authorizationEndpoint: "https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    tokenEndpoint: "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token",
    scopes: ["openid", "email", "profile"],
  },
  fingerprint: "f".repeat(64),
};

/** Cognito's `InitiateAuth` success shape. */
function authSuccess(over: Record<string, unknown> = {}) {
  return {
    AuthenticationResult: {
      IdToken: "fresh-id-token",
      AccessToken: "fresh-access-token",
      ExpiresIn: 1800,
      ...over,
    },
  };
}

function respond(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status < 400,
    status,
    body: null,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshViaCognitoIdp — the happy path", () => {
  it("returns fresh tokens", async () => {
    vi.stubGlobal("fetch", respond(authSuccess()));

    const result = await refreshViaCognitoIdp(PLATFORM, "a-refresh-token");

    expect(result).toEqual({
      ok: true,
      tokens: { idToken: "fresh-id-token", accessToken: "fresh-access-token", expiresIn: 1800 },
    });
  });

  /**
   * ⚠ THE REQUEST GOES TO `cognito-idp`, NOT THE HOSTED UI. This is the whole point of the
   * module: a prior gate feared an SRP-minted refresh token being refused at
   * `/oauth2/token`, and the fix is to refresh on the API that minted it. If this ever posts to
   * `tokenEndpoint`, the gate is live again.
   */
  it("calls the regional cognito-idp endpoint with the InitiateAuth target", async () => {
    const fetchMock = respond(authSuccess());
    vi.stubGlobal("fetch", fetchMock);

    await refreshViaCognitoIdp(PLATFORM, "a-refresh-token");

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(url).not.toContain("amazoncognito.com"); // not the Hosted UI
    expect((init as RequestInit).headers).toMatchObject({
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    });
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(body.ClientId).toBe(PLATFORM.cognito.clientId);
    expect(body.AuthParameters.REFRESH_TOKEN).toBe("a-refresh-token");
  });

  it("builds the endpoint from the POOL's region, not a hardcoded one", async () => {
    const fetchMock = respond(authSuccess());
    vi.stubGlobal("fetch", fetchMock);

    await refreshViaCognitoIdp({ ...PLATFORM, region: "eu-west-2" }, "a-refresh-token");

    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://cognito-idp.eu-west-2.amazonaws.com/"
    );
  });

  it("falls back to the pool's ID-token lifetime when ExpiresIn is missing", async () => {
    // A missing field must not yield an immediately-stale session.
    vi.stubGlobal("fetch", respond(authSuccess({ ExpiresIn: undefined })));
    const result = await refreshViaCognitoIdp(PLATFORM, "a-refresh-token");
    expect(result.ok && result.tokens.expiresIn).toBe(1800);
  });
});

describe("⚠ network failures must NOT be reported as revoked", () => {
  /**
   * THE ASSERTION THE WHOLE FILE EXISTS FOR.
   *
   * `renewAuthToken` signs the user out on `revoked` and keeps the session on `network`. If a
   * connection error came back as `revoked`, every participant on a flaky network would be
   * signed out mid-workshop — which is exactly what the old refresher did by collapsing all
   * failures into `null`.
   */
  it("reports a thrown fetch as `network`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }) as unknown as typeof fetch
    );
    expect(await refreshViaCognitoIdp(PLATFORM, "a-refresh-token")).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("reports a 5xx as `network` — an AWS hiccup is not a revocation", async () => {
    vi.stubGlobal("fetch", respond({}, 500));
    expect(await refreshViaCognitoIdp(PLATFORM, "a-refresh-token")).toEqual({
      ok: false,
      reason: "network",
    });
    vi.stubGlobal("fetch", respond({}, 503));
    expect((await refreshViaCognitoIdp(PLATFORM, "a-refresh-token")).ok).toBe(false);
  });

  it("reports unreadable JSON as `network`, not revoked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        body: null,
        text: async () => "<html>proxy error</html>",
      })) as unknown as typeof fetch
    );
    expect(await refreshViaCognitoIdp(PLATFORM, "a-refresh-token")).toEqual({
      ok: false,
      reason: "network",
    });
  });

  /**
   * A 200 with no tokens should not happen. Reported as `network` rather than `revoked`: the
   * token was not REFUSED, so signing the user out would be the wrong conclusion.
   */
  it("reports a 200 with no AuthenticationResult as `network`", async () => {
    vi.stubGlobal("fetch", respond({}));
    expect(await refreshViaCognitoIdp(PLATFORM, "a-refresh-token")).toEqual({
      ok: false,
      reason: "network",
    });
    vi.stubGlobal("fetch", respond(authSuccess({ IdToken: undefined })));
    // The whole object, not `.reason` — `RefreshResult` is a union, so reading the field without
    // narrowing does not type-check, and this also pins `ok: false` rather than assuming it.
    expect(await refreshViaCognitoIdp(PLATFORM, "a-refresh-token")).toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("a genuinely dead token IS reported as revoked", () => {
  /**
   * Cognito answers a revoked, expired or wrong-client refresh token with 400
   * `NotAuthorizedException`. This is the one case where ending the session is correct: no
   * amount of retrying will help, and leaving the user in a silently-failing app is worse.
   */
  it("reports a 400 as `revoked`", async () => {
    vi.stubGlobal(
      "fetch",
      respond({ __type: "NotAuthorizedException", message: "Refresh Token has expired." }, 400)
    );
    expect(await refreshViaCognitoIdp(PLATFORM, "an-expired-token")).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it.each([400, 401, 403])("reports %i as revoked", async (status) => {
    vi.stubGlobal("fetch", respond({}, status));
    expect(await refreshViaCognitoIdp(PLATFORM, "t")).toEqual({ ok: false, reason: "revoked" });
  });
});

describe("guards before the network", () => {
  it.each([
    ["no refresh token", "", PLATFORM],
    ["no client id", "t", { ...PLATFORM, cognito: { ...PLATFORM.cognito, clientId: "" } }],
    ["no region", "t", { ...PLATFORM, region: "" }],
  ])("reports `unconfigured` and does not call fetch: %s", async (_name, token, platform) => {
    const fetchMock = respond(authSuccess());
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshViaCognitoIdp(platform as PlatformConfig, token as string);

    expect(result).toEqual({ ok: false, reason: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⚠ COGNITO DOES NOT ROTATE THE REFRESH TOKEN on this grant, so the result deliberately does
   * NOT carry one. A caller that "helpfully" cleared the stored token after a renewal would end
   * every session after 30 minutes — this asserts there is nothing there to tempt it.
   */
  it("returns no refresh token, because the grant does not rotate it", async () => {
    vi.stubGlobal("fetch", respond(authSuccess()));
    const result = await refreshViaCognitoIdp(PLATFORM, "a-refresh-token");
    expect(result.ok && result.tokens).not.toHaveProperty("refreshToken");
  });
});

// ── ⚠ REVOCATION: ENDING A CREDENTIAL'S LIFE, NOT JUST DELETING IT ───────────────────────────────
//
// Nothing in the tree ever revoked either credential: sign-out blanked local rows, removeAccount was a bare
// DELETE, and platform:reset cleared the config. All three DISCARD a credential and none of them invalidated
// it, so a refresh token copied off the machine beforehand kept working for the rest of its 30-day life.
//
// ⚠ THE VERDICTS ARE THE BEHAVIOUR HERE, exactly as they are for renewal above, and for a different
// reason: no caller ever fails on a revocation, so the only consumer of the answer is the AUDIT LOG.
// A verdict that collapses "the pool has revocation switched off" into "the network was down" hides a
// permanently broken revocation path behind something that looks retryable.
describe("revokeRefreshToken", () => {
  it("reports success on a 200", async () => {
    vi.stubGlobal("fetch", respond({}, 200));
    expect(await revokeRefreshToken(PLATFORM, "a-refresh-token")).toEqual({ ok: true });
  });

  it("goes to cognito-idp with the RevokeToken target, not the Hosted UI", async () => {
    /**
     * The same reasoning as the renewal: a token minted through `cognito-idp` may be refused by the
     * Hosted UI endpoint, and this file exists because that mismatch is un-diagnosable. Revocation has
     * the same exposure, so it uses the API that minted the token.
     */
    const fetchMock = respond({}, 200);
    vi.stubGlobal("fetch", fetchMock);

    await revokeRefreshToken(PLATFORM, "a-refresh-token");

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect(init.headers["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.RevokeToken"
    );
    // The public-client shape: the token and the client id, no SigV4.
    expect(JSON.parse(String(init.body))).toEqual({
      Token: "a-refresh-token",
      ClientId: PLATFORM.cognito.clientId,
    });
  });

  /**
   * ⚠ AN ALREADY-DEAD TOKEN IS A SUCCESS. Cognito answers a token it has already revoked, or one that
   * expired, with 400 — and "it is not valid any more" is precisely the outcome this function exists
   * to produce. Reporting it as a failure would fill the audit log with revocations that did their job.
   */
  it("treats a 400 as already revoked, which is success", async () => {
    vi.stubGlobal("fetch", respond({ __type: "NotAuthorizedException" }, 400));
    expect(await revokeRefreshToken(PLATFORM, "t")).toEqual({ ok: true });
  });

  /**
   * ⚠ THE ONE FAILURE A HUMAN MUST ACT ON. Cognito answers `UnsupportedOperationException` when the
   * app client has token revocation disabled — a POOL configuration issue no client-side change can
   * work around. An operator reading `revoke-failed:unsupported` in the audit log knows where to look.
   */
  it("distinguishes a pool with revocation switched off", async () => {
    vi.stubGlobal("fetch", respond({ __type: "UnsupportedOperationException" }, 400));
    expect(await revokeRefreshToken(PLATFORM, "t")).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("reports a 5xx and a thrown fetch as `network`", async () => {
    vi.stubGlobal("fetch", respond({}, 503));
    expect(await revokeRefreshToken(PLATFORM, "t")).toEqual({ ok: false, reason: "network" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    expect(await revokeRefreshToken(PLATFORM, "t")).toEqual({ ok: false, reason: "network" });
  });

  it.each([
    ["no refresh token", "", PLATFORM],
    ["no client id", "t", { ...PLATFORM, cognito: { ...PLATFORM.cognito, clientId: "" } }],
    ["no region", "t", { ...PLATFORM, region: "" }],
  ])("reports `unconfigured` without calling fetch: %s", async (_name, token, platform) => {
    const fetchMock = respond({}, 200);
    vi.stubGlobal("fetch", fetchMock);

    const result = await revokeRefreshToken(platform as PlatformConfig, token as string);

    expect(result).toEqual({ ok: false, reason: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
