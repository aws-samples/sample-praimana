// ── ⚠ THE BEARER IS READ FROM THE COOKIE, PROVED AGAINST A COOKIE AUTH.JS ACTUALLY WROTE ──────
//
// `getAccessToken()` replaced `session.accessToken` as the way every server consumer obtains the
// Cognito ID token it forwards to `/v1/*`. The reason is `session-token-exposure.test.ts`: whatever the
// `session()` callback returns is also the body of the public `GET /api/auth/session`, so the token was
// being handed to in-page JavaScript on every page load.
//
// ⚠ THIS FILE EXISTS BECAUSE EVERY OTHER TEST OF THAT CHANGE MOCKS IT. Mocks prove the wiring; they
// cannot prove the JWE actually decrypts. Auth.js derives the encryption key from (secret, salt) where
// the salt defaults to the COOKIE NAME, which this app customises, so a wrong salt, a wrong secret
// resolution order, or a renamed cookie would make `getAccessToken()` return undefined for every real
// session. The symptom would be a 401 on every authenticated call, i.e. a completely broken app, and no
// mocked test would notice.
//
// So this encodes a cookie with Auth.js's own `encode()` and reads it back through the real function.

import { describe, it, expect } from "vitest";
import { encode } from "next-auth/jwt";
import { SESSION_COOKIE_NAME, SESSION_SECRETS } from "@/lib/session-cookie";
import { getAccessToken } from "@/lib/server-token";

const secret = SESSION_SECRETS[0];

async function cookieFor(payload: Record<string, unknown>) {
  return encode({ token: payload, secret, salt: SESSION_COOKIE_NAME, maxAge: 3600 });
}

function reqWith(jwe: string) {
  return new Request("http://localhost/api/trpc/x", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwe}` },
  });
}

describe("getAccessToken against a real Auth.js cookie", () => {
  it("is configured at all, an empty secret list would make every case vacuously undefined", () => {
    // The failure mode this guards: with no secret, `getAccessToken` returns undefined by design
    // (fail closed), and every assertion below would pass for the wrong reason. `vitest.setup.ts`
    // supplies one from `.env.test` or generates an ephemeral one, so this failing means that setup
    // file is not running, check `setupFiles` in vitest.config.mts.
    expect(
      SESSION_SECRETS.length,
      "no session key configured: vitest.setup.ts should load .env.test or generate an ephemeral key"
    ).toBeGreaterThan(0);
    // Not pinned to a literal: the name depends on NEXTAUTH_URL's scheme (`__Secure-` when deployed).
    // What matters is that the encoder and the reader use the SAME value, which they do by importing it.
    expect(SESSION_COOKIE_NAME).toMatch(/authjs\.session-token$/);
  });

  it("returns the bearer from the encrypted cookie", async () => {
    const jwe = await cookieFor({ id: "u1", role: "ADMIN", accessToken: "the-id-token" });
    await expect(getAccessToken(reqWith(jwe))).resolves.toBe("the-id-token");
  });

  it("withholds it when refreshFailed is set, the eviction semantics", async () => {
    const jwe = await cookieFor({ id: "u1", accessToken: "stale", refreshFailed: true });
    await expect(getAccessToken(reqWith(jwe))).resolves.toBeUndefined();
  });

  it("returns undefined with no cookie at all", async () => {
    await expect(getAccessToken(new Request("http://localhost/x"))).resolves.toBeUndefined();
  });

  it("returns undefined for a cookie encrypted under a different key", async () => {
    const foreign = await encode({
      token: { accessToken: "nope" },
      secret: "a-completely-different-secret-value-0000",
      salt: SESSION_COOKIE_NAME,
      maxAge: 3600,
    });
    await expect(getAccessToken(reqWith(foreign))).resolves.toBeUndefined();
  });
});
