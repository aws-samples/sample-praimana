import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, createSign, createHmac, type KeyObject } from "crypto";

/**
 * RS256 VERIFICATION, WITH REAL KEYS AND REAL SIGNATURES.
 *
 * ── WHY NOT A MOCKED VERIFIER ──
 *
 * The whole value of this module is that a signature it accepts is genuinely valid. A test that
 * stubs the crypto would assert my assumptions about signing and prove none of them — so these
 * tests generate an RSA keypair, serve its public half as a JWKS from a stubbed `fetch`, and sign
 * real tokens with the private half. Only the network is faked.
 *
 * The refusals matter more than the acceptance here: `none`, algorithm confusion, an unknown `kid`,
 * a tampered payload, and a signature from the wrong key must all fail, and the module must fail
 * CLOSED when the key set cannot be fetched at all.
 */

import { hasValidSignature, jwksUrlFor, __resetJwksCache } from "./jwt-verify";

const ISSUER = "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Example";
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

let goodKey: { publicKey: KeyObject; privateKey: KeyObject };
let otherKey: { publicKey: KeyObject; privateKey: KeyObject };
let jwksRequests = 0;
/** Every URL fetch was called with, asserted in test bodies rather than inside the stub. */
let requestedUrls: string[] = [];
let respond: () => Response;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Sign a token the way Cognito does: RS256 over `header.payload`. */
function signToken(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown> = { sub: "user-1" }
): string {
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createSign("RSA-SHA256").update(`${h}.${p}`).sign(privateKey);
  return `${h}.${p}.${b64url(sig)}`;
}

/** The JWKS document for a public key, in Cognito's shape. */
function jwksFor(key: KeyObject, kid: string) {
  const jwk = key.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}

beforeEach(() => {
  __resetJwksCache();
  jwksRequests = 0;
  requestedUrls = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
  goodKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  respond = () => new Response(JSON.stringify(jwksFor(goodKey.publicKey, "kid-1")), { status: 200 });
  vi.stubGlobal("fetch", (url: string) => {
    /**
     * ⚠ THE URL IS RECORDED, NOT ASSERTED HERE. An `expect` inside this stub could never fail a test:
     * every call site is inside `fetchKeySet`'s try/catch, which swallowed the thrown assertion and
     * turned it into a plain "could not fetch" — so for the many tests that expect `false`, a WRONG
     * url was indistinguishable from the right one. It is asserted in the test body instead.
     */
    requestedUrls.push(String(url));
    jwksRequests++;
    return Promise.resolve(respond());
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("jwksUrlFor", () => {
  it("derives the well-known path from the issuer", () => {
    expect(jwksUrlFor(ISSUER)).toBe(JWKS_URL);
    // A trailing slash must not double up.
    expect(jwksUrlFor(`${ISSUER}/`)).toBe(JWKS_URL);
  });

  it("refuses a non-https or unparseable issuer", () => {
    // The issuer comes from stored config, but a JWKS fetched over http could be swapped in flight,
    // which would let an attacker nominate the signing key.
    expect(jwksUrlFor("http://cognito-idp.eu-west-1.amazonaws.com/pool")).toBeNull();
    expect(jwksUrlFor("file:///etc/passwd")).toBeNull();
    expect(jwksUrlFor("not a url")).toBeNull();
    expect(jwksUrlFor("")).toBeNull();
  });
});

describe("accepts a genuinely valid token", () => {
  it("verifies a correctly signed RS256 token", async () => {
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1", typ: "JWT" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(true);
  });

  it("fetches the derived well-known URL and nothing else", async () => {
    // Asserted HERE rather than inside the fetch stub, where a failure was swallowed.
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await hasValidSignature(token, ISSUER);
    expect(requestedUrls).toEqual([JWKS_URL]);
  });

  it("caches the key set — a second verification makes no extra request", async () => {
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await hasValidSignature(token, ISSUER);
    await hasValidSignature(token, ISSUER);
    expect(jwksRequests).toBe(1);
  });
});

describe("refuses forgeries", () => {
  it("REFUSES alg: none — the classic break", async () => {
    // An unsigned token with an empty signature must never be treated as verified.
    const h = b64url(JSON.stringify({ alg: "none", kid: "kid-1" }));
    const p = b64url(JSON.stringify({ sub: "attacker" }));
    await expect(hasValidSignature(`${h}.${p}.`, ISSUER)).resolves.toBe(false);
  });

  it("REFUSES algorithm confusion — HS256 signed with the PUBLIC key as the secret", async () => {
    // The public key is published, so if the header could select HMAC verification anyone could
    // mint tokens. The header is checked against a fixed RS256 expectation instead of steering it.
    const pubPem = goodKey.publicKey.export({ type: "spki", format: "pem" }) as string;
    const h = b64url(JSON.stringify({ alg: "HS256", kid: "kid-1" }));
    const p = b64url(JSON.stringify({ sub: "attacker" }));
    const mac = createHmac("sha256", pubPem).update(`${h}.${p}`).digest();
    await expect(hasValidSignature(`${h}.${p}.${b64url(mac)}`, ISSUER)).resolves.toBe(false);
  });

  it("REFUSES a token signed by a different key", async () => {
    // Correctly formed, correctly signed — by somebody else's pool.
    const token = signToken(otherKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });

  it("REFUSES a tampered payload, even with the original signature", async () => {
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" }, { sub: "user-1" });
    const [h, , s] = token.split(".");
    // The exact attack the role gate cared about: grant yourself a group.
    const forged = b64url(JSON.stringify({ sub: "user-1", "cognito:groups": ["Executives"] }));
    await expect(hasValidSignature(`${h}.${forged}.${s}`, ISSUER)).resolves.toBe(false);
  });

  it("REFUSES an unknown kid, after one rate-limited refetch attempt", async () => {
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-unknown" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });

  it("does not fetch the JWKS once per attempt when the kid is forged", async () => {
    // An attacker-controlled `kid` is a refetch trigger, so without a cooldown a loop here would
    // become an outbound request per attempt against Cognito.
    for (let i = 0; i < 25; i++) {
      const token = signToken(goodKey.privateKey, { alg: "RS256", kid: `forged-${i}` });
      await hasValidSignature(token, ISSUER);
    }
    expect(jwksRequests).toBeLessThanOrEqual(2);
  });

  it("REFUSES malformed tokens without throwing", async () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "....", "not.a.jwt"]) {
      await expect(hasValidSignature(bad, ISSUER), bad).resolves.toBe(false);
    }
  });

  it("REFUSES when the issuer is empty or not https", async () => {
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, "")).resolves.toBe(false);
    await expect(hasValidSignature(token, "http://evil.test/pool")).resolves.toBe(false);
  });
});

describe("fails closed when the key set is unavailable", () => {
  it("refuses when the JWKS request fails", async () => {
    respond = () => new Response("nope", { status: 500 });
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });

  it("refuses when the network throws (offline)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("ENOTFOUND")));
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });

  it("refuses when the JWKS has no usable RSA keys", async () => {
    respond = () => new Response(JSON.stringify({ keys: [{ kty: "EC", kid: "kid-1" }] }), { status: 200 });
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });

  it("refuses when the JWKS is not JSON, or has no keys array", async () => {
    respond = () => new Response("<html>gateway error</html>", { status: 200 });
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);

    __resetJwksCache();
    respond = () => new Response(JSON.stringify({ keys: "nope" }), { status: 200 });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });

  it("refuses an oversized JWKS BEFORE materialising it, and for that reason alone", async () => {
    /**
     * ⚠ THE FIRST VERSION OF THIS TEST PASSED FOR THREE REASONS AND ISOLATED NONE. Its JWKS used
     * `kid: "x"` while the token said `kid-1` (a miss), its JWK had no `n`/`e` so `createPublicKey`
     * threw (an empty set), and it was oversized. Any one of those produced `false`. Worse, its name
     * claimed the bytes were not held in memory, and that was FALSE of the code: the cap was checked
     * after `await res.text()`, so a 50MB body materialised in full first.
     *
     * So this version isolates the size: the JWKS is otherwise VALID and carries the RIGHT kid, and a
     * real stream is used so the reader stops mid-body. The only reason it can fail is the cap.
     */
    const jwk = goodKey.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const oversized = JSON.stringify({
      keys: [{ ...jwk, kid: "kid-1", alg: "RS256", use: "sig" }],
      padding: "A".repeat(80_000),
    });
    let delivered = 0;
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(oversized);
            // Chunked, so the cap can refuse partway through rather than after the whole body.
            for (let i = 0; i < bytes.length; i += 8192) {
              const chunk = bytes.subarray(i, i + 8192);
              delivered += chunk.byteLength;
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
        { status: 200 }
      );

    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);

    // Proof the same document verifies when it is small enough — so size is the discriminator.
    __resetJwksCache();
    respond = () =>
      new Response(JSON.stringify({ keys: [{ ...jwk, kid: "kid-1", alg: "RS256", use: "sig" }] }), {
        status: 200,
      });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(true);
    expect(delivered, "the oversized body was streamed, not handed over whole").toBeGreaterThan(0);
  });

  it("keeps serving a cached key set when a later refresh fails", async () => {
    /**
     * A transient outage must not invalidate keys that are still correct — otherwise a blip during key
     * rotation would lock every user out of sign-in.
     *
     * ⚠ TIME IS ADVANCED, AND THAT IS THE WHOLE TEST. The first version of this asserted the same two
     * calls without moving the clock: the second call found the cache fresh and `kid-1` present, so it
     * returned from cache and `fetchKeySet` was NEVER REACHED — the 503 responder was never invoked, no
     * refresh was attempted, and the name described something that did not happen. The path it claimed
     * to cover is the one that produced the indefinite-stale-key bug, and it was untested.
     */
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(true);
    expect(jwksRequests).toBe(1);

    // Past the TTL, so a refresh really is attempted, and it really does fail.
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    respond = () => new Response("", { status: 503 });

    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(true);
    expect(jwksRequests, "a refresh must have been attempted").toBe(2);
  });

  it("REFUSES a stale key once the grace window is past — rotation must not be undone", async () => {
    /**
     * The P2. On a failed fetch `fetchKeySet` returns the stale set and leaves `fetchedAt` untouched,
     * and `keyFor` used whatever came back — so a retired key verified forever while the JWKS stayed
     * unreachable, which a local attacker arranges with one line in /etc/hosts. Measured before the
     * fix: still verifying at hour 25, and at one year. That contradicted this module's own "fails
     * CLOSED" header and ai.ts's claim that a rotated-away key is a refusal.
     */
    const token = signToken(goodKey.privateKey, { alg: "RS256", kid: "kid-1" });
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(true);

    respond = () => new Response("", { status: 503 });

    // Inside TTL + grace: still trusted, so a blip does not lock anyone out.
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 30 * 60 * 1000);
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(true);

    // Past the ceiling: refused, however long the endpoint stays down.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);

    vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await expect(hasValidSignature(token, ISSUER)).resolves.toBe(false);
  });
});
