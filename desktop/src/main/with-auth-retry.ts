// EA-H6 / EA-M8: perform an authenticated request that transparently refreshes
// the token on a 401 and retries once. Extracted as a pure function (deps
// injected) so the expiry → refresh → retry path is unit-testable without
// Electron. Used by the main-process authed calls and the SSE stream.

export interface AuthRetryDeps {
  /** Current bearer token, or null if none is cached. */
  getToken: () => string | null;
  /** Refresh the token via /auth/refresh; return new token or null on failure. */
  refresh: () => Promise<string | null>;
  /** Perform the request with the given token (fresh Request each call). */
  doFetch: (token: string) => Promise<Response>;
  /** Called when refresh fails and the session is unrecoverable (→ re-login). */
  onAuthExpired?: () => void;
}

/**
 * Run an authed request. If it returns 401 (or throws "Not logged in"), refresh
 * the token once and retry. If refresh fails, invoke onAuthExpired and surface
 * the failure. Returns the (final) Response.
 *
 * @throws if there is no token at all and refresh yields none.
 */
export async function fetchWithAuthRetry(deps: AuthRetryDeps): Promise<Response> {
  let token = deps.getToken();

  // No token cached — try to obtain one before the first request.
  if (!token) {
    token = await deps.refresh();
    if (!token) {
      deps.onAuthExpired?.();
      throw new Error("Not logged in");
    }
  }

  const first = await deps.doFetch(token);
  if (first.status !== 401) return first;

  // 401 → the token is expired/invalid. Refresh once and retry.
  const fresh = await deps.refresh();
  if (!fresh) {
    deps.onAuthExpired?.();
    return first; // caller sees the 401; session is unrecoverable
  }
  return deps.doFetch(fresh);
}
