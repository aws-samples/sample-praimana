/**
 * ── ⚠ THE `CompressionStream` EDGE-RUNTIME BUILD WARNING IS NOT FIXABLE FROM HERE ─────────────
 *
 * `next build` reports, on every build:
 *
 *   ./node_modules/jose/dist/webapi/lib/deflate.js
 *   A Node.js API is used (CompressionStream at line: 10) which is not supported in the Edge Runtime.
 *
 * `middleware.ts` → `lib/auth.ts` → this module, and middleware runs on the Edge runtime, so it is
 * natural to assume these `jose` imports are the cause and that subpath imports
 * (`jose/jwks/remote`, `jose/jwt/verify`) would fix it. THEY DO NOT, this was tried and reverted.
 * `@auth/core/jwt.js` imports the `jose` BARREL itself to encrypt the session cookie as a JWE, and
 * `next-auth` is a hard dependency of `lib/auth.ts`, so `webapi/index.js`, and with it
 * `jwe_decrypt.js` → `deflate.js`, is in the middleware bundle no matter what specifier this file
 * uses. Narrowing these imports saved nothing and only churned the auth path.
 *
 * The warning is benign: it is a STATIC reference in a JWE branch (compressed `zip` headers) that
 * neither this module nor `@auth/core` ever executes. It goes away when `@auth/core` stops importing
 * the barrel, which is upstream's call, not this repo's.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { collapseCognitoGroups } from "@praimana/shared";

/**
 * SERVER-SIDE verification of a Cognito ID token.
 *
 * This module is the trust boundary of the custom-UI auth flow, and the reason it
 * exists deserves stating plainly. The browser now drives authentication itself
 * through the Amplify Auth SDK, so the ID token arrives at our server from
 * client-side JavaScript. A token from that direction is UNTRUSTED INPUT, anyone
 * can POST a hand-written JWT to the session endpoint. What makes the resulting
 * session trustworthy is not that Amplify produced the token, but that we verify
 * its SIGNATURE against Cognito's published JWKS here, on the server, before
 * minting anything.
 *
 * Verified, not merely decoded:
 *   - signature, against the pool's JWKS (an unsigned/forged token cannot pass)
 *   - `iss`, so a token from another Cognito pool is rejected
 *   - `aud`, so a token minted for a different app client is rejected
 *   - `exp`/`nbf`, enforced by jose
 *   - `token_use === "id"`, checked below, see why that matters
 *
 * The role is then read from `cognito:groups`, which only Cognito can set. It is
 * never taken from anything the client says about itself.
 */

const COGNITO_ISSUER = process.env.COGNITO_ISSUER || "";
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";

export interface VerifiedCognitoIdentity {
  /** The Cognito `sub`. */
  id: string;
  email: string;
  /** Collapsed from `cognito:groups`, Cognito's word, not the client's. */
  role: string;
}

// Lazily built and cached for the life of the process; jose caches the keys and
// honours the endpoint's cache headers, so this is one fetch per key rotation
// rather than one per sign-in.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function getJwks() {
  if (!COGNITO_ISSUER) return undefined;
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${COGNITO_ISSUER}/.well-known/jwks.json`));
  }
  return jwks;
}

/**
 * Verify a raw Cognito ID token (no "Bearer " prefix) and return the identity it
 * proves, or null if it proves nothing.
 *
 * Returns null, never throws and never returns a partial identity, so every
 * caller has exactly one failure mode to handle and no path accidentally treats a
 * rejected token as a valid one.
 */
export async function verifyCognitoIdToken(
  token: string | undefined | null
): Promise<VerifiedCognitoIdentity | null> {
  if (!token) return null;

  const keySet = getJwks();
  // Not configured → fail CLOSED. An unset COGNITO_ISSUER must mean "nobody gets
  // in", not "skip verification", which is the version of this bug that grants
  // everyone an admin session in an environment where someone forgot a variable.
  if (!keySet) return null;

  // Not configured → fail CLOSED. An unset COGNITO_CLIENT_ID must mean "nobody
  // gets in", not "skip the audience check". Without an audience comparison any
  // signature-valid ID token from the same user pool, including one minted for a
  // different app client, would be accepted and converted into a portal session.
  // This is the same polarity as the COGNITO_ISSUER check above.
  if (!COGNITO_CLIENT_ID) return null;

  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: COGNITO_ISSUER,
      // Cognito puts the app client id in `aud` on ID tokens. Without this check a
      // token issued to a DIFFERENT app client in the same pool would be accepted.
      audience: COGNITO_CLIENT_ID,
    });

    const claims = payload as JWTPayload & {
      email?: unknown;
      token_use?: unknown;
      "cognito:groups"?: unknown;
    };

    // Insist on an ID token specifically. Cognito ACCESS tokens are signed by the
    // same keys and carry the same issuer, so signature + issuer alone would let
    // one through, and an access token has no `email` and, more importantly, is
    // not what the API Gateway JWT authorizer accepts as our bearer. Rejecting it
    // here surfaces the mistake at sign-in instead of as unexplained 401s later.
    if (claims.token_use !== "id") return null;

    if (!payload.sub) return null;

    return {
      id: String(payload.sub),
      email: typeof claims.email === "string" ? claims.email : "",
      role: collapseCognitoGroups(claims["cognito:groups"]),
    };
  } catch {
    // Any failure, bad signature, wrong issuer/audience, expired, malformed, is
    // the same answer: this token proves nothing.
    return null;
  }
}
