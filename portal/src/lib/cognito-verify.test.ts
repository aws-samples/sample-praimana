import { describe, it, expect, beforeAll, vi } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

// jose v6 dropped the `KeyLike` export; generateKeyPair now yields WebCrypto
// CryptoKeys. Derived from the function itself so it tracks the library rather than
// restating a shape that changed once already.
type TestKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
type TestKey = TestKeyPair["privateKey"];

/**
 * The trust boundary of the custom auth UI, tested with REAL cryptography.
 *
 * Why real keys rather than a mocked jwtVerify: the entire security value of this
 * module is that a forged token fails. A test that mocks the verifier would pass
 * just as happily against a version of this file that only decodes the JWT, which
 * is precisely the bug worth guarding against, since the token now arrives from
 * client-side JavaScript and anyone can POST a hand-written one.
 *
 * So: generate a keypair, serve it as the pool's JWKS, and sign tokens with it. A
 * token signed by a DIFFERENT key must be rejected, and that assertion is only
 * meaningful if the verification is genuine.
 */

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL";
const CLIENT_ID = "test-client-id";

let goodKey: TestKeyPair;
let attackerKey: TestKeyPair;
let verifyCognitoIdToken: typeof import("./cognito-verify").verifyCognitoIdToken;

/** A signed token with the given claims, overridable per test. */
async function makeToken(
  claims: Record<string, unknown> = {},
  key: TestKey = goodKey.privateKey
): Promise<string> {
  return new SignJWT({
    token_use: "id",
    email: "ada@example.com",
    "cognito:groups": ["ADMIN"],
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("sub-123")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key);
}

beforeAll(async () => {
  goodKey = await generateKeyPair("RS256");
  attackerKey = await generateKeyPair("RS256");

  const jwk = await exportJWK(goodKey.publicKey);
  const jwks = { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] };

  // jose's createRemoteJWKSet fetches the JWKS over HTTP; serve it from a stub so
  // no network is involved but the signature check is still the real one.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/.well-known/jwks.json`) {
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  process.env.COGNITO_ISSUER = ISSUER;
  process.env.COGNITO_CLIENT_ID = CLIENT_ID;

  // Imported after the env is set: the module reads both at module scope.
  ({ verifyCognitoIdToken } = await import("./cognito-verify"));
});

describe("verifyCognitoIdToken", () => {
  it("accepts a properly signed ID token and returns the identity it proves", async () => {
    const identity = await verifyCognitoIdToken(await makeToken());
    expect(identity).toEqual({
      id: "sub-123",
      email: "ada@example.com",
      role: "ADMIN",
    });
  });

  it("REJECTS a token signed by a different key", async () => {
    // The single most important assertion in this file: a forged token, correct in
    // every claim, signed by a key that isn't the pool's. If this ever passes,
    // anyone can mint themselves an admin session by POSTing a JWT.
    const forged = await makeToken({}, attackerKey.privateKey);
    expect(await verifyCognitoIdToken(forged)).toBeNull();
  });

  it("rejects an unsigned (alg: none) token", async () => {
    // The classic JWT attack. jose refuses it, but that's worth pinning rather than
    // assuming.
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" })
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        sub: "sub-123",
        iss: ISSUER,
        aud: CLIENT_ID,
        token_use: "id",
        "cognito:groups": ["ADMIN"],
        exp: Math.floor(Date.now() / 1000) + 600,
      })
    ).toString("base64url");

    expect(await verifyCognitoIdToken(`${header}.${body}.`)).toBeNull();
  });

  it("rejects a token from a DIFFERENT user pool", async () => {
    const wrongIssuer = await new SignJWT({ token_use: "id", email: "a@b.c" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHER")
      .setAudience(CLIENT_ID)
      .setSubject("sub-123")
      .setExpirationTime("10m")
      .sign(goodKey.privateKey);

    expect(await verifyCognitoIdToken(wrongIssuer)).toBeNull();
  });

  it("rejects a token minted for a different app client", async () => {
    // Same pool, same signing keys, only `aud` differs. Without the audience check
    // a token issued to any other client in the pool would be accepted.
    const wrongAudience = await new SignJWT({
      token_use: "id",
      email: "a@b.c",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience("some-other-client")
      .setSubject("sub-123")
      .setExpirationTime("10m")
      .sign(goodKey.privateKey);

    expect(await verifyCognitoIdToken(wrongAudience)).toBeNull();
  });

  it("rejects an ACCESS token, which shares the signing keys and issuer", async () => {
    // Signature + issuer + audience alone would let this through. It is not what the
    // API Gateway authorizer accepts as our bearer, so admitting it would produce
    // unexplained 401s later instead of a clear failure at sign-in.
    const accessToken = await makeToken({ token_use: "access" });
    expect(await verifyCognitoIdToken(accessToken)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ token_use: "id", email: "a@b.c" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject("sub-123")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(goodKey.privateKey);

    expect(await verifyCognitoIdToken(expired)).toBeNull();
  });

  it("rejects a token with no subject", async () => {
    const noSub = await new SignJWT({ token_use: "id", email: "a@b.c" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime("10m")
      .sign(goodKey.privateKey);

    expect(await verifyCognitoIdToken(noSub)).toBeNull();
  });

  it.each([undefined, null, "", "not-a-jwt", "a.b.c"])(
    "returns null rather than throwing for %o",
    async (value) => {
      expect(await verifyCognitoIdToken(value as string)).toBeNull();
    }
  );

  it("does NOT take the role from anything but cognito:groups", async () => {
    // A client-supplied `role` claim must be ignored. If it weren't, the browser
    // could name its own privileges, the whole point of reading the group instead.
    const claimingAdmin = await makeToken({
      role: "ADMIN",
      "custom:role": "ADMIN",
      "cognito:groups": ["PARTICIPANT"],
    });

    const identity = await verifyCognitoIdToken(claimingAdmin);
    expect(identity?.role).toBe("PARTICIPANT");
  });

  it("fails CLOSED when COGNITO_ISSUER is unset", async () => {
    // The bug this guards: a missing env var making verification a no-op, so every
    // token is "valid" and the first person to POST one gets whatever role they
    // claimed. An unconfigured environment must admit NOBODY.
    //
    // Needs a fresh module registry because the issuer is read at module scope, the
    // already-imported instance has the real value baked in.
    vi.resetModules();
    const previous = process.env.COGNITO_ISSUER;
    delete process.env.COGNITO_ISSUER;

    try {
      const mod = await import("./cognito-verify");
      // A perfectly valid token, correctly signed. Still rejected, because there is
      // no configured pool to verify it against.
      expect(await mod.verifyCognitoIdToken(await makeToken())).toBeNull();
    } finally {
      process.env.COGNITO_ISSUER = previous;
      vi.resetModules();
    }
  });

  it("fails CLOSED when COGNITO_CLIENT_ID is unset", async () => {
    // Same polarity as the issuer check: a missing client id must reject all tokens
    // rather than silently skip the audience comparison. Without this, any valid ID
    // token from the same user pool, including one minted for a different app
    // client, would be accepted and converted into a portal session.
    vi.resetModules();
    const previous = process.env.COGNITO_CLIENT_ID;
    delete process.env.COGNITO_CLIENT_ID;

    try {
      const mod = await import("./cognito-verify");
      // A perfectly valid token, correctly signed, correct audience. Still rejected,
      // because there is no configured client id to compare against.
      expect(await mod.verifyCognitoIdToken(await makeToken())).toBeNull();
    } finally {
      process.env.COGNITO_CLIENT_ID = previous;
      vi.resetModules();
    }
  });

  it("fails CLOSED when COGNITO_CLIENT_ID is empty string", async () => {
    // ⚠ AN EXPLICITLY EMPTY VALUE IS TREATED THE SAME AS UNSET. The deploy guard in
    // platform-portal.yaml asserts a NON-EMPTY value (`grep -Eq "^$k=.+"`), so an empty
    // variable fails the build, but the runtime must not depend on that guard being right.
    // Belt and braces: the guard stops the deploy, this stops the sign-in.
    vi.resetModules();
    process.env.COGNITO_CLIENT_ID = "";

    try {
      const mod = await import("./cognito-verify");
      expect(await mod.verifyCognitoIdToken(await makeToken())).toBeNull();
    } finally {
      process.env.COGNITO_CLIENT_ID = CLIENT_ID;
      vi.resetModules();
    }
  });

  it("returns an empty email rather than null when the claim is absent", async () => {
    // The token still PROVES an identity (the sub is signed), so rejecting it would
    // lock out a valid user over a cosmetic field. The identity service falls back to
    // the stored row's email.
    const noEmail = await new SignJWT({ token_use: "id" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject("sub-123")
      .setExpirationTime("10m")
      .sign(goodKey.privateKey);

    const identity = await verifyCognitoIdToken(noEmail);
    expect(identity?.id).toBe("sub-123");
    expect(identity?.email).toBe("");
  });
});
