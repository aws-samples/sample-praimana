import { decodeJwt } from "jose";

/**
 * Exchange a Cognito refresh token for a fresh ID token.
 *
 * ── WHY THIS EXISTS ──
 *
 * The Cognito ID token (our API bearer) lives 30 minutes and NOTHING renewed it: the NextAuth
 * `jwt` callback only populated on initial sign-in. So a user reading one page for 31 minutes had
 * every subsequent API call answered 401, which surfaced as "Couldn't load this team's phases …
 * Backend error: 401" until that was made an honest expired-session redirect. This makes the
 * expiry stop happening in the first place, for the 30 days the refresh token is valid.
 *
 * ── VERIFIED AGAINST THE LIVE ENDPOINT BEFORE BEING WRITTEN ──
 *
 * The app client is secretless with `code` flow and `ALLOW_REFRESH_TOKEN_AUTH`. Probing the real
 * token endpoint with a deliberately bogus token returned:
 *
 *     {"error":"invalid_grant"}   HTTP 400
 *
 * `invalid_grant`, NOT `invalid_client`, i.e. client authentication was ACCEPTED with `client_id`
 * in the body and only the token itself was rejected. That distinction is the whole reason this
 * can work without a secret, and it is the same trap documented on the provider config in
 * auth.ts: sending Basic auth with an empty secret gets `invalid_client` instead.
 *
 * ── WHAT COGNITO DOES AND DOES NOT RETURN ──
 *
 * A refresh_token grant returns a new `id_token` and `access_token` but NO new `refresh_token` -
 * Cognito keeps the original until it expires. So the caller must carry the old one forward; a
 * naive `refreshToken: data.refresh_token` would blank it and break every later refresh.
 */

/** Cognito's Hosted UI domain, e.g. https://<prefix>.auth.<region>.amazoncognito.com */
const HOSTED_UI = process.env.COGNITO_HOSTED_UI_DOMAIN ?? "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET ?? "";

/**
 * Bounded, because this sits on the request path of every page load once the token is stale.
 * A hung IdP must not hold a render open, an abort lands in the caller's failure branch, which
 * withholds the bearer and lets the existing expired-session redirect take over.
 */
const REFRESH_TIMEOUT_MS = 5_000;

export interface RefreshResult {
  idToken: string;
  /** Epoch ms, read from the new token's own `exp`, never computed from `expires_in` locally. */
  expiresAt: number;
}

/**
 * @returns the new ID token, or `null` when refresh is impossible or refused.
 *
 * NULL IS A DELIBERATE THIRD ANSWER rather than a throw. This runs inside NextAuth's `jwt`
 * callback, and throwing there destroys the session outright, turning a transient IdP blip into
 * a forced re-login with a password and a TOTP code. Returning null lets the caller keep the
 * session, mark it un-bearer-able, and let the user's next action drive a clean redirect.
 */
export async function refreshCognitoIdToken(
  refreshToken: string
): Promise<RefreshResult | null> {
  if (!refreshToken || !HOSTED_UI || !CLIENT_ID) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  /**
   * A secretless client MUST NOT send Basic auth, see the note above and the provider config in
   * auth.ts. Only a client that genuinely has a secret authenticates that way, and this mirrors
   * the same conditional so the two cannot drift.
   */
  if (CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(
      `${CLIENT_ID}:${CLIENT_SECRET}`
    ).toString("base64")}`;
  }

  let res: Response;
  try {
    res = await fetch(`${HOSTED_UI}/oauth2/token`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or transport failure. Logged WITHOUT the token, a refresh token in a log line is
    // a 30-day credential sitting in CloudWatch.
    console.warn("[auth] refresh request failed", {
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return null;
  }

  if (!res.ok) {
    /**
     * `invalid_grant` means the refresh token is spent, revoked, or the user was disabled, a
     * PERMANENT refusal, and the honest outcome is re-authentication. Every other status is
     * transient, but both map to null here: the caller cannot usefully distinguish them, since
     * either way it has no bearer for this request.
     */
    const detail = await res.text().catch(() => "");
    console.warn("[auth] refresh refused", {
      status: res.status,
      // The error CODE only, never the body verbatim, Cognito echoes nothing sensitive today,
      // but a log line that grows a token later is a leak nobody notices.
      code: /"error"\s*:\s*"([a-z_]+)"/.exec(detail)?.[1] ?? "unknown",
    });
    return null;
  }

  const data = (await res.json().catch(() => null)) as {
    id_token?: unknown;
  } | null;
  const idToken = typeof data?.id_token === "string" ? data.id_token : null;
  if (!idToken) {
    console.warn("[auth] refresh returned no id_token");
    return null;
  }

  return { idToken, expiresAt: expiryOf(idToken) };
}

/**
 * The token's own `exp`, in epoch ms.
 *
 * READ FROM THE TOKEN, not computed as `now + expires_in`. The two disagree whenever the server
 * and the client clocks differ, and this value decides when the next refresh fires, so deriving
 * it locally means a skewed clock either refreshes constantly or refreshes too late and 401s.
 *
 * `decodeJwt` does NOT verify, and does not need to: this token came from the IdP over TLS in
 * direct response to our own request. It is verified where it is USED, the API gateway's JWT
 * authorizer checks it against the pool's JWKS on every call.
 *
 * A token with no readable `exp` is treated as ALREADY EXPIRED rather than valid forever: that
 * forces one more refresh attempt rather than trusting a bearer whose lifetime is unknown.
 */
export function expiryOf(idToken: string): number {
  try {
    const { exp } = decodeJwt(idToken);
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Should the token be refreshed now?
 *
 * The SKEW is the point. Refreshing exactly at `exp` guarantees a race: a request already in
 * flight carries the old token and can land after it expires. Sixty seconds of headroom is longer
 * than any request here (the east-west budget is 2.5s, the slowest generation 45s, and that one
 * is a mutation the user triggers, not a page load) while still using ~97% of a 30-minute token.
 */
const REFRESH_SKEW_MS = 60 * 1000;

export function needsRefresh(expiresAt: number | undefined, now: number): boolean {
  // Unknown expiry ⇒ refresh. An absent value means we could not read the token's own claim, and
  // assuming it is still good is the failure that produces a 401 on the next call.
  if (!expiresAt) return true;
  return now >= expiresAt - REFRESH_SKEW_MS;
}
