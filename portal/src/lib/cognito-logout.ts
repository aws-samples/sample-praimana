/**
 * Federated sign-out for the Cognito Hosted UI.
 *
 * The bug this exists to fix: a bare `signOut()` clears the LOCAL NextAuth
 * cookie and nothing else. The Hosted UI keeps its own session cookie on the
 * Cognito domain, so the next `/oauth2/authorize` sees a live session, skips the
 * credential prompt entirely, and bounces straight back with a fresh code, which
 * presents as "Sign out did nothing: clicking Sign in goes right to the
 * dashboard." Ending a federated session has to happen at the IdP; the app cannot
 * do it by deleting its own cookie.
 *
 * So sign-out is two hops: NextAuth clears the local session and hands off to
 * FEDERATED_LOGOUT_PATH, which 302s the browser to Cognito's /logout. Cognito
 * clears its cookie and returns the user to POST_LOGOUT_PATH.
 *
 * `cognitoLogoutUrl` deliberately takes its config as ARGUMENTS rather than
 * reading process.env at module scope: that keeps this module safe to import from
 * a client component (which needs FEDERATED_LOGOUT_PATH) without a server-only
 * env var being inlined as `undefined` into the browser bundle, and it makes the
 * URL shape unit-testable without env juggling.
 */

/** Where the "Sign out" buttons send NextAuth's post-signout redirect. */
export const FEDERATED_LOGOUT_PATH = "/api/auth/federated-logout";

/**
 * Where Cognito returns the browser once ITS session is cleared.
 *
 * This value is not free: Cognito rejects the whole /logout request with
 * `redirect_mismatch` unless the `logout_uri` EXACTLY matches an entry in the app
 * client's LogoutURLs. `<origin>/login` is already registered for every
 * environment (prod + localhost:3001) via the CognitoLogoutUrls stack parameter,
 * so changing this path means changing that parameter too.
 */
export const POST_LOGOUT_PATH = "/login";

export interface CognitoLogoutConfig {
  /** e.g. https://praimana-<acct>.auth.us-east-1.amazoncognito.com */
  hostedUiDomain: string;
  clientId: string;
  /** This app's own origin, the base for the post-logout return URL. */
  appUrl: string;
}

/** Drop a trailing slash so joins can't produce a `//` that breaks exact matching. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The Hosted UI logout URL, or `null` when the Cognito env is incomplete.
 *
 * Null is a real case, not defensive padding: local dev can run without
 * COGNITO_HOSTED_UI_DOMAIN set. Callers must fall back to a plain local sign-out
 * instead of sending the browser to a malformed URL, a half-built /logout link
 * strands the user on a Cognito error page having ALREADY lost their local
 * session, which is strictly worse than not federating at all.
 */
export function cognitoLogoutUrl(config: CognitoLogoutConfig): string | null {
  const hostedUiDomain = trimTrailingSlash(config.hostedUiDomain || "");
  const appUrl = trimTrailingSlash(config.appUrl || "");
  const clientId = config.clientId || "";

  if (!hostedUiDomain || !clientId || !appUrl) return null;

  // URLSearchParams percent-encodes logout_uri for us; Cognito compares the
  // DECODED value against LogoutURLs, so the encoding is transparent to matching.
  const params = new URLSearchParams({
    client_id: clientId,
    logout_uri: `${appUrl}${POST_LOGOUT_PATH}`,
  });

  return `${hostedUiDomain}/logout?${params.toString()}`;
}
