import { getToken } from "next-auth/jwt";
import { SESSION_COOKIE_NAME, SESSION_SECRETS } from "@/lib/session-cookie";
import type { AppToken } from "@/types/next-auth";

/**
 * ── THE OUTBOUND BEARER, READ FROM THE ENCRYPTED SESSION COOKIE ────────────────────────────────
 *
 * Every `/v1/*` call this BFF makes presents the caller's own Cognito ID token. This module is
 * where that token is obtained, and it is SERVER-ONLY by construction.
 *
 * ⚠ IT USED TO COME OFF `session.accessToken`, WHICH SENT IT TO THE BROWSER. In Auth.js v5 the
 * `session()` callback's return value is the body of the public `GET /api/auth/session` endpoint,
 * which `<SessionProvider>` polls from every page, so a ~30-minute full-impersonation token
 * against every service was delivered to in-page JavaScript on every page load, for no functional
 * reason (all six consumers were server-side). Reading it here
 * instead keeps it inside the httpOnly JWE cookie the design already relies on.
 *
 * ⚠ WHY `getToken` AND NOT `auth()`. `auth()` returns the SESSION, the sanitised, client-shaped
 * projection that no longer carries the bearer, which is the entire point. `getToken` decrypts the
 * JWT cookie itself, which is where the token has always actually lived. Auth.js v5 marks this
 * subpath "not recommended" in favour of `auth()` for AUTHENTICATION; this is not authentication,
 * it is reading a credential out of our own cookie, and `auth()` cannot do it by design.
 *
 * ⚠ THE SALT IS THE COOKIE NAME. Auth.js derives the encryption key from (secret, salt), and its
 * default salt is the cookie name, which this app customises. Both are imported from
 * `lib/session-cookie.ts`, the same module `lib/auth.ts` configures the cookie from, so a rename
 * cannot leave this silently unable to decrypt.
 */

/** Anything `getToken` can read the session cookie from. A real `Request` satisfies it. */
type TokenSource = Parameters<typeof getToken>[0]["req"];

/**
 * The caller's Cognito ID token, or `undefined` when there is no session or the last refresh
 * failed.
 *
 * ⚠ THE `undefined` ON REFRESH FAILURE IS LOAD-BEARING AND MUST NOT BE "FIXED". It is the whole
 * session-eviction mechanism: `protectedProcedure` throws UNAUTHORIZED when the token is absent,
 * and the client turns that into the expired-session notice and the redirect to /login. Returning
 * the stale token instead would produce the same failure one network round trip later, as an
 * unexplained 401 in the service logs. This preserves exactly what the `session()` callback used to
 * do with `t.refreshFailed`.
 */
export async function getAccessToken(req: TokenSource): Promise<string | undefined> {
  // No key configured → no token. Fails CLOSED, the same polarity as `cognito-verify.ts`: an unset
  // secret must mean "nobody is authenticated", not "skip the check".
  if (SESSION_SECRETS.length === 0) return undefined;

  const token = (await getToken({
    req,
    secret: SESSION_SECRETS,
    salt: SESSION_COOKIE_NAME,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_NAME.startsWith("__Secure-"),
  })) as AppToken | null;

  if (!token || token.refreshFailed) return undefined;
  return token.accessToken;
}
