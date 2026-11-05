import { createPublicKey, createVerify, type KeyObject } from "crypto";

/**
 * ── ⚠ RS256 SIGNATURE VERIFICATION AGAINST THE POOL'S JWKS ────────────────────────────────────
 *
 * `auth:completeSignIn` accepts an ID token FROM THE RENDERER and checked only the claims —
 * `iss`, `aud`, `token_use`, `exp` — read out of an unverified payload decode. The reasoning was
 * written down and was defensible at the time: the API gateway verifies signatures on every
 * request, so a forged token "buys nothing" because the first real call rejects it.
 *
 * That reasoning stated its own expiry condition — *"If this token ever becomes authoritative for a
 * LOCAL decision, that reasoning stops holding and the signature must be checked"* — and the
 * condition had already been met, twice in the same handler:
 *
 *   1. `collapseCognitoGroups(claims["cognito:groups"])` drives the desktop role gate, under a
 *      comment asserting the claims are trustworthy. Unsigned, they are not.
 *   2. `sub` becomes `user_id` / `active_user_id`, which is the SCOPING KEY for the local SQLite
 *      `projects` and `chat_sessions` queries and for saved-account switching. A forged token
 *      therefore installs a local session under any identity and exposes another local account's
 *      rows in this profile's database.
 *
 * Neither is something the gateway can see, because neither involves calling it.
 *
 * ── POSTURE ──
 *
 * Fails CLOSED. Every path that cannot positively verify returns false: no network, malformed
 * JWKS, unknown `kid`, wrong algorithm, bad signature. An unverifiable token is not a valid one.
 */

/** How long a fetched key set stays usable before it is refreshed. */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum gap between JWKS fetches for one issuer.
 *
 * ⚠ THIS IS A DoS BOUND, NOT AN OPTIMISATION. An unknown `kid` is the signal for "the pool rotated
 * its keys, refetch" — and it is also trivially forgeable, since the header is attacker-controlled.
 * Without a cooldown, a renderer looping `completeSignIn` with random `kid` values turns each
 * attempt into an outbound request to Cognito.
 */
const REFETCH_COOLDOWN_MS = 60 * 1000;

/**
 * How far PAST the TTL a key set may still be used when the endpoint cannot be reached.
 *
 * ⚠ WITHOUT THIS CEILING THE MODULE CONTRADICTED ITS OWN HEADER. On a failed fetch `fetchKeySet`
 * returns the stale set and never updates `fetchedAt`, and `keyFor` used whatever came back — so a key
 * survived its 24h TTL indefinitely as long as the JWKS stayed unreachable, which a local attacker
 * arranges with one line in /etc/hosts. Measured before the fix: a token verified at hour 0 still
 * verified at hour 25, and at one year. That unwinds key ROTATION, which is the whole reason a retired
 * key must stop working.
 *
 * A grace window rather than a hard cliff, because the opposite failure is real too: a network blip
 * during rotation must not lock every user out of sign-in. One hour is long enough to ride out an
 * outage and far short of a rotation cycle.
 */
const JWKS_STALE_GRACE_MS = 60 * 60 * 1000;

/** Bounded like every other cache here: a real deployment has ONE issuer, and Cognito publishes 2 keys. */
const MAX_ISSUERS = 4;
const MAX_KEYS_PER_ISSUER = 16;

/** Cognito's JWKS is a few hundred bytes; anything larger is not one. */
const MAX_JWKS_BYTES = 64 * 1024;

/** The token is presented by a user who is waiting, so this is seconds-class. */
const JWKS_TIMEOUT_MS = 5000;

interface KeySet {
  fetchedAt: number;
  lastAttemptAt: number;
  keys: Map<string, KeyObject>;
}

const cache = new Map<string, KeySet>();

/** Test seam. Not called by the app. */
export function __resetJwksCache(): void {
  cache.clear();
}

function base64UrlToBuffer(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * The JWKS URL for a Cognito issuer.
 *
 * ⚠ https ONLY, AND DERIVED — never taken from the token. A JWKS URL read from the token being
 * verified would let the token nominate its own signer, which is no verification at all. The
 * issuer comes from the stored platform config, and the caller has already checked that the
 * token's `iss` equals it.
 */
export function jwksUrlFor(issuer: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
}

/**
 * Read a response body, refusing once it exceeds the cap.
 *
 * ⚠ THE CAP USED TO BE CHECKED AFTER `await res.text()`, which is the opposite of what its comment
 * claimed. Measured: a 50MB body materialised 52,428,800 bytes in-process before the check fired, so
 * the "must not stream unbounded bytes into memory" comment described a bound that did not exist.
 * Streaming and counting as we go is what makes it true. The 5s timeout was the only real limit.
 */
async function readBounded(res: Response): Promise<string> {
  const body = res.body;
  // No stream (a mocked or bodyless response): fall back, and still refuse an oversized result.
  if (!body) {
    const text = await res.text();
    if (text.length > MAX_JWKS_BYTES) throw new Error("JWKS response too large");
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_JWKS_BYTES) {
        throw new Error("JWKS response too large");
      }
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the refusal path as well as the happy one.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function fetchKeySet(issuer: string): Promise<KeySet | null> {
  const url = jwksUrlFor(issuer);
  if (!url) return null;

  const existing = cache.get(issuer);
  const now = Date.now();
  if (existing && now - existing.lastAttemptAt < REFETCH_COOLDOWN_MS) {
    // Inside the cooldown: reuse whatever we have rather than making a request per attempt.
    return existing;
  }

  const attemptStamp = now;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      /**
       * ⚠ `redirect: "error"`. `fetch` follows redirects by default, so a compromised or hijacked
       * endpoint could bounce this to a host of its choosing — and the `https:` check in `jwksUrlFor`
       * only ever saw the FIRST URL. The JWKS location is derived from the validated issuer, so there
       * is no legitimate reason for it to redirect anywhere.
       */
      redirect: "error",
    });
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);

    const text = await readBounded(res);

    const doc = JSON.parse(text) as { keys?: unknown };
    if (!Array.isArray(doc.keys)) throw new Error("JWKS has no keys array");

    const keys = new Map<string, KeyObject>();
    for (const entry of doc.keys.slice(0, MAX_KEYS_PER_ISSUER)) {
      const jwk = entry as Record<string, unknown>;
      const kid = typeof jwk.kid === "string" ? jwk.kid : "";
      // Only RSA signing keys are relevant; Cognito publishes exactly these.
      if (!kid || jwk.kty !== "RSA") continue;
      if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
      try {
        keys.set(kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch {
        // One unusable key must not discard the rest of the set.
        continue;
      }
    }
    if (keys.size === 0) throw new Error("JWKS contained no usable RSA keys");

    // Bound the number of issuers, evicting the oldest. A second issuer only appears if the app
    // is repointed at another platform, so this is a leak guard rather than a working eviction.
    if (!cache.has(issuer) && cache.size >= MAX_ISSUERS) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const set: KeySet = { fetchedAt: Date.now(), lastAttemptAt: attemptStamp, keys };
    cache.set(issuer, set);
    return set;
  } catch (err) {
    console.warn(
      "[auth] could not fetch the pool's signing keys:",
      err instanceof Error ? err.message : "unknown error"
    );
    if (existing) {
      // Record the failed attempt so the cooldown applies, but keep the usable old key set: a
      // transient network failure must not invalidate keys that are still correct.
      existing.lastAttemptAt = attemptStamp;
      return existing;
    }
    return null;
  }
}

async function keyFor(issuer: string, kid: string): Promise<KeyObject | null> {
  const cached = cache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    const hit = cached.keys.get(kid);
    if (hit) return hit;
    // Cache is fresh but does not know this kid — either a rotation, or a forged header. Refetch
    // once, rate-limited by the cooldown inside fetchKeySet.
    const refreshed = await fetchKeySet(issuer);
    return usable(refreshed)?.keys.get(kid) ?? null;
  }
  const set = await fetchKeySet(issuer);
  return usable(set)?.keys.get(kid) ?? null;
}

/**
 * A key set is usable while it is inside its TTL, or inside the grace window past it.
 *
 * ⚠ THE CHECK THAT MAKES "FAILS CLOSED" TRUE. `fetchKeySet` returns the stale set on a failed fetch —
 * correct, so a blip does not lock anyone out — but it leaves `fetchedAt` untouched, so without this
 * the TTL was advisory and a retired key never expired.
 */
function usable(set: KeySet | null): KeySet | null {
  if (!set) return null;
  const age = Date.now() - set.fetchedAt;
  if (age <= JWKS_TTL_MS + JWKS_STALE_GRACE_MS) return set;
  console.warn(
    "[auth] refusing to verify against signing keys that are past their staleness ceiling and " +
      "cannot be refreshed — the pool's JWKS endpoint is unreachable"
  );
  return null;
}

/**
 * True if `token` carries a valid RS256 signature from `issuer`'s published keys.
 *
 * Verifies the SIGNATURE ONLY. The caller keeps its own `iss` / `aud` / `exp` / `token_use` checks,
 * which are cheap and should run FIRST — there is no reason to fetch a key set for a token that is
 * already known to be for the wrong pool.
 */
export async function hasValidSignature(token: string, issuer: string): Promise<boolean> {
  if (typeof token !== "string" || typeof issuer !== "string" || !issuer) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return false;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlToBuffer(headerPart).toString("utf-8"));
  } catch {
    return false;
  }

  /**
   * ⚠ THE ALGORITHM COMES FROM AN ATTACKER-CONTROLLED HEADER, so it is checked against a fixed
   * expectation rather than used to select a verifier. Trusting it is the classic JWT break: `none`
   * skips verification entirely, and `HS256` invites verifying an RSA token with the PUBLIC key as
   * an HMAC secret — a key that is, by definition, published.
   */
  if (header.alg !== "RS256") {
    console.warn("[auth] refused a token whose header does not claim RS256");
    return false;
  }
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) return false;

  const key = await keyFor(issuer, kid);
  if (!key) return false;

  try {
    return createVerify("RSA-SHA256")
      .update(`${headerPart}.${payloadPart}`)
      .verify(key, base64UrlToBuffer(signaturePart));
  } catch {
    // A malformed signature makes `verify` throw rather than return false.
    return false;
  }
}
