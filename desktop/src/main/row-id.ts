/**
 * ── ⚠ THE SHAPE OF AN ID THAT IS SAFE TO PUT IN A URL PATH ────────────────────────────────────
 *
 * Eight `fetch` sites in main interpolated a renderer- or server-supplied id straight into an authenticated
 * path:
 *
 *     fetch(`${url}/v1/ai/threads/${threadId}/messages`, { Authorization: `Bearer ${token}` })
 *
 * `fetch` parses that string with the WHATWG URL parser, which COLLAPSES `..` and honours `?` and
 * `#`. So a session id of `x/../../../v1/auth/me?z=` did not name a thread — it rewrote the whole
 * path, and main issued an authenticated request, with the user's bearer, to an endpoint the desktop
 * deliberately does not bridge.
 *
 * ── ⚠ WHY BOTH ENCODING AND A SHAPE CHECK, NOT EITHER ONE ──
 *
 * `encodeURIComponent` at every interpolation is the correct fix for the URL, and it is applied
 * (`handlers/team-data.ts` always did it; the other seven sites do now). But encoding a path-shaped
 * id turns the request into a 404 rather than refusing it, and the same value is ALSO a SQL row key
 * and a server thread id. So the id is validated where it ENTERS — `db:createSession`,
 * `db:addMessage`, the `share:*` handlers — and a value that could never have been a legitimate id
 * is refused before it is stored, forwarded or logged.
 *
 * Defence in depth in the honest sense: the encoding makes the URL correct, and this makes the
 * stored data correct. Neither alone covers both.
 *
 * ── WHAT THE CHARSET ADMITS ──
 *
 * Every id the app generates is `crypto.randomUUID()` (hex and dashes). Server ids are UUIDs too.
 * The set below is deliberately wider than that — `.`, `_`, `:` — so a future server id scheme does
 * not have to change this file, while still excluding every character that means something to a URL
 * parser: `/ \ ? # % & = + space` and control characters.
 */

/** Upper bound on an id. Long enough for a UUID with a prefix, short enough to bound a log line. */
export const MAX_ROW_ID_LENGTH = 128;

const SAFE_ROW_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * True when `value` is safe to use as one URL path segment and as a row key.
 *
 * ⚠ AN ALL-DOTS VALUE IS REFUSED even though every character in it is on the allowlist. `.` and
 * `..` are relative path components, and while a single segment cannot traverse on its own, an id
 * that is only dots is never a real id — the same reasoning as `sanitiseProfileName` in profile.ts.
 */
export function isSafeRowId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!SAFE_ROW_ID.test(value)) return false;
  return !/^\.+$/.test(value);
}

/**
 * `value` as a safe id, or throw.
 *
 * @param label what the id names, for the message the user or the log sees ("chat", "message").
 * @throws Error when the value could not be a legitimate id
 */
export function assertSafeRowId(value: unknown, label: string): string {
  if (!isSafeRowId(value)) {
    /**
     * ⚠ THE VALUE IS NOT IN THE MESSAGE. It came from the renderer and may end up in a log file or
     * a UI string; echoing an attacker-chosen path fragment back into either is how a refusal
     * becomes an injection of its own.
     */
    throw new Error(`That ${label} id is not in a form this app accepts`);
  }
  return value;
}
