/**
 * The backend origin — now CONFIGURED, not pinned at build time.
 *
 * ── WHAT CHANGED, AND WHY THE OLD REASONING NO LONGER APPLIES ──
 *
 * This file used to inline the origin via Vite `define` and refuse to read it from
 * anywhere else. The comment it carried was right about the risk, and that risk has
 * not gone away: the origin selects the Cognito pool the app authenticates against,
 * so a hostile value chooses the identity provider (the caller-chosen-provider risk).
 *
 * What changed is that the finding was written against **option D** — an in-app
 * native password form — and the finding's own wording scopes it to that:
 *
 *   "Today that is survivable, because the credential is entered in the SYSTEM
 *    BROWSER at a Cognito-owned domain the user can inspect in the address bar. It
 *    stops being survivable the moment sign-in moves in-app."
 *
 * Option D was never built. `cognito-oauth.ts` still calls `shell.openExternal`, so
 * the condition it named still holds and the origin can be configurable again.
 * It is NOT, however, a free-text field feeding straight into the OAuth flow:
 *
 *   - The user configures a PORTAL url; the API origin and the Cognito values are
 *     DISCOVERED from it (`platform-config.ts`).
 *   - The Hosted UI domain in that response must be a Cognito-owned host, or one
 *     allowlisted into this build. That check is what REPLACES the pin —
 *     see `assertCognitoHostedUi`.
 *   - The loopback redirect URI stays pinned in `cognito-oauth.ts`. Nothing the
 *     server says can move where the authorization code comes back to.
 *
 * ⚠ IF SIGN-IN EVER MOVES IN-APP, revisit this — see the same warning in
 * `platform-config.ts`, which is where the controls actually live.
 *
 * ── WHY THIS FILE STILL EXISTS ──
 *
 * Keeping ONE accessor, with the reasoning attached to it, is what stops the next
 * person from adding a call site that reads the raw setting and skips the
 * configured-check. The `PRAIMANA_BACKEND_URL` build variable is gone;
 * `PRAIMANA_PORTAL_URL` (see `platform-config.ts`) is its replacement, and it
 * sets a DEFAULT the user can see and change rather than a pin they cannot.
 */

import { readSetting } from "./database";
import { PLATFORM_SETTING_KEYS } from "./platform-config";

/** Strip trailing slashes so `${origin}/v1/...` never yields a double slash. */
function normalise(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * The configured API origin, or null when this install has not been configured yet.
 *
 * Null rather than a default, because there is no honest fallback. An origin invented
 * here would be a platform the participant never chose, and every request to it would
 * fail in a way that looks like a network problem rather than a missing setup step.
 */
export function backendOriginOrNull(): string | null {
  const configured = readSetting(PLATFORM_SETTING_KEYS.apiBaseUrl);
  if (!configured || !configured.trim()) return null;
  return normalise(configured);
}

/**
 * The configured API origin, throwing when absent.
 *
 * For call sites that cannot proceed without one and whose callers already surface an
 * error. Anything on a startup or polling path should use `backendOriginOrNull` and
 * report "not configured" as its own state instead — a thrown error on a 15-second
 * poll is noise, not information.
 */
export function backendOrigin(): string {
  const origin = backendOriginOrNull();
  if (!origin) {
    throw new Error(
      "This app is not connected to a platform yet. Set the platform URL in Account → Platform."
    );
  }
  return origin;
}
