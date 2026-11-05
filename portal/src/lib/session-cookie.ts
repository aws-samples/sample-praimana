/**
 * ── THE SESSION COOKIE'S NAME AND KEYS, IN ONE PLACE ──────────────────────────────────────────
 *
 * Split out of `lib/auth.ts` rather than exported from it, for two reasons:
 *
 *   1. `lib/server-token.ts` needs both values to decrypt the session cookie, and importing them
 *      from `lib/auth.ts` would pull NextAuth's entire runtime configuration, providers, callbacks,
 *      the Cognito client, into every route handler that only wants the bearer. It also forces any
 *      test of such a route to mock the whole auth module.
 *   2. They are CONFIGURATION, not behaviour. Auth.js derives the JWE encryption key from
 *      (secret, salt) where the salt defaults to the cookie name, so these two values must agree
 *      between the code that WRITES the cookie (`lib/auth.ts`) and the code that READS it
 *      (`lib/server-token.ts`). Two literals would be a silent decrypt failure the day either
 *      changed.
 */

/**
 * ── COOKIE HARDENING ─────────────────────────────────────────────────────────────────────────
 *
 * TRUE in production (any non-localhost deploy). This forces the `Secure` flag, the cookie is
 * never sent over plaintext HTTP, and the `__Secure-` prefix, a defence against cookie injection
 * from a sibling subdomain.
 *
 * In local dev (http://localhost) it must be FALSE, because browsers refuse to store a `Secure`
 * cookie delivered over `http://`. The condition uses the same signal NextAuth itself would (the
 * NEXTAUTH_URL scheme) and falls back to true when the variable is absent, because a deployed
 * environment that forgot to set it must not silently weaken.
 */
export const useSecureCookies = (() => {
  const url = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "";
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
    return false;
  }
  return true;
})();

/**
 * The session cookie's name, which is ALSO the JWE decryption salt (Auth.js's default salt is the
 * cookie name, and this app customises the name).
 */
export const SESSION_COOKIE_NAME = useSecureCookies
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

/**
 * ── SESSION SIGNING KEYS, NEWEST FIRST, SO ROTATION IS NOT A SCHEDULED OUTAGE ────────────────
 *
 * `NEXTAUTH_SECRET` is the single key for the JWE session cookie, so holding it is equivalent to
 * minting a session for any user at any role (see "Secret management" in portal/README.md). That
 * made the 90-day rotation policy
 * all-or-nothing: swapping the value invalidates every active session at once, signing every user
 * out mid-workshop. A security finding named that as the reason rotation had never been
 * exercised.
 *
 * Auth.js accepts an ARRAY and tries each key on decode, using the FIRST for everything it issues
 * (`JWTDecodeParams.secret`: "the first secret that successfully decrypts the JWT will be used …
 * The newer secret should be added to the start of the array"). So a rotation becomes: set
 * `NEXTAUTH_SECRET_PREVIOUS` to the outgoing value, set `NEXTAUTH_SECRET` to the new one, deploy,
 * then remove `NEXTAUTH_SECRET_PREVIOUS` once the longest session could have expired (24h, see
 * `session.maxAge`). Existing cookies keep decrypting throughout; new ones use the new key.
 *
 * ⚠ THE OVERLAP IS A WINDOW, NOT A HOME. While `NEXTAUTH_SECRET_PREVIOUS` is set, a compromised OLD
 * key still mints valid sessions, which is the point during a planned rotation and exactly wrong
 * during an emergency revocation. The revocation procedure in "Secret management" in
 * portal/README.md rotates WITHOUT the overlap for
 * that reason; leaving this variable set is how a revocation silently fails to revoke.
 *
 * ⚠ THE RESOLUTION ORDER MATCHES AUTH.JS'S OWN (`AUTH_SECRET ?? NEXTAUTH_SECRET`, see
 * `next-auth/lib/env.js`), so a deployment setting only `NEXTAUTH_SECRET` behaves exactly as before.
 */
export const SESSION_SECRETS: string[] = [
  process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "",
  process.env.NEXTAUTH_SECRET_PREVIOUS ?? "",
].filter((s) => s.length > 0);
