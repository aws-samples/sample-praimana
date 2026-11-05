import {
  canAccessStaffScreens,
  canManageUsers,
  canManageWorkshopSettings,
  PARTICIPANT_LANDING_PATH,
} from "@praimana/shared";

/**
 * WHICH ROUTES EACH ROLE MAY REACH, as pure functions.
 *
 * Split out of middleware.ts so it can be unit-tested. middleware.ts itself imports
 * `@/lib/auth`, which pulls in next-auth and its runtime config, so the module cannot
 * be loaded in a plain node test, which in practice meant the route gates were the
 * one authorization layer with no tests at all. The middleware now composes these
 * predicates and keeps only the redirect mechanics.
 *
 * This is UI ROUTING, not the security boundary. Every mutation is independently
 * gated server-side (tRPC role checks plus each service's own authz). These functions
 * decide where a browser is sent, and nothing more.
 */

/**
 * Reachable without a session at all. /join is the emailed invite link: the recipient has no
 * account yet by definition, so gating it behind auth would send every invitee to /login and
 * strand the token.
 *
 * ── ⚠ THE DESKTOP ENTRY IS FOUR EXACT PATHS, NOT THE `/api/desktop` PREFIX ─────────────────────
 *
 * The bare prefix was here, and `matchesPath` prefix-matches, so the WHOLE namespace was exempt
 * from `isPublicPath`'s callers, and `isPublicPath` is consulted BEFORE the `!req.auth` redirect
 * and before `isForbiddenPath` (`middleware.ts`). Two consequences, the second worse than the
 * first: those four routes were reachable with no session (intended, they are bearer-authenticated
 * and now VERIFY the bearer), and ANY ROUTE ADDED UNDER THE PREFIX IN FUTURE silently inherited the
 * exemption whether it wanted it or not. This was raised as a security finding.
 *
 * ⚠ `/api/desktop/download` IS DELIBERATELY ABSENT, and it is the fifth route under that prefix.
 * It authenticates with `await auth()`, the SESSION COOKIE, so it belongs behind the edge gates
 * like every other cookie-authenticated route. Under the old prefix it was exempt from them by
 * accident of where it lived. This is the same trap `BEARER_ONLY_ROUTES` and
 * `csrf-exemption.test.ts` exist to catch for the CSRF check; `route-gates.test.ts` now asserts
 * this list agrees with that one.
 */
export const PUBLIC_PATHS = [
  "/",
  "/login",
  "/join",
  "/api/auth",
  "/api/desktop/team-data",
  "/api/desktop/create-task",
  "/api/desktop/send-message",
  "/api/desktop/join-team",
];

// Reachable by ANY signed-in role, participants included.
//
// /profile belongs here: it is where a user edits their OWN name and organisation
// and changes their OWN password. Confining participants away from it would leave
// the "View profile" item in their header menu redirecting to /welcome, and, worse,
// leave them with no way to change their password at all.
export const PARTICIPANT_PATHS = [
  PARTICIPANT_LANDING_PATH,
  "/profile",
  /**
   * ── ⚠ /how-it-works BELONGS HERE OR IT IS USELESS ────────────────────────────────────────
   *
   * The documentation page is for EVERY signed-in role, chosen explicitly over
   * staff-only. Participants are the audience most likely to need it: they install a desktop app, work in
   * phases they did not design, and are judged by a process nobody has explained.
   *
   * Omitting this line would send every one of them to /welcome the moment they clicked the link in their
   * own menu, a page written for them that they alone could not read. That is the SAME failure the Submit
   * tab had: a surface offered to a role the route gate then bounces, and it is invisible
   * unless you sign in as that role or think of it here.
   */
  "/how-it-works",
  /**
   * ⚠ AND SO DOES /desktop, FOR THE SAME REASON AND MORE SHARPLY. It is the page that hands somebody the
   * INSTALLER, and a participant is the person who needs it most. Omitting it would bounce every participant
   * who clicked "Desktop app" in their own menu.
   *
   * ⚠ THIS IS THE THIRD TIME THIS TRAP HAS APPEARED, the Submit tab, /how-it-works above,
   * and this. `profile-menu-destinations.test.ts` now DERIVES the check from the menu itself rather than
   * relying on somebody remembering this list, because remembering is exactly what failed three times.
   */
  "/desktop",
  "/api/trpc",
  "/api/auth",
  /**
   * ── ⚠ THE DOWNLOAD ITSELF, WHICH IS THE FOURTH TIME THIS TRAP HAS APPEARED ──────────────────
   *
   * `/welcome` and `/desktop` both link at `/api/desktop/download?platform=…` with a plain
   * `<a href>`, so the click is a TOP-LEVEL NAVIGATION and the middleware gates it exactly like a
   * page. Absent from this list, gate (a) forbade it for every PARTICIPANT and the redirect went
   * to `landingPathForRole("PARTICIPANT")`, `/welcome`. Which means both download buttons, on the
   * one screen whose purpose is handing a new participant the installer, silently RELOADED THE PAGE
   * THEY WERE ALREADY ON. No error, nothing in the console: a 302 back to the referrer.
   *
   * ⚠ AND IT STAYS OUT OF `PUBLIC_PATHS`. That absence is deliberate and documented above: the
   * route authenticates with the session cookie, so it must keep the `!req.auth` redirect. This
   * entry only says a signed-in participant is not the wrong ROLE for it, they are the primary
   * audience. `canAccessStaffScreens` roles were never affected, which is why this survived: staff
   * download the installer fine and participants are the only ones who cannot.
   */
  "/api/desktop/download",

  /**
   * ⚠ THE SAME TRAP, FIFTH TIME: the connect.json download. `/welcome` step 3 links at
   * `/api/desktop/connect-json` with a plain `<a href download>`, a top-level navigation gated like a
   * page. It is the run-from-source counterpart of the installer download, a participant drops the
   * file next to start.sh, so the primary audience is again PARTICIPANT, and omitting it would 302
   * them back to /welcome exactly as the installer download did. Cookie-authenticated, so it stays out
   * of PUBLIC_PATHS for the same reason the installer route does.
   */
  "/api/desktop/connect-json",
];

// User management: viewing every account on the platform, changing roles, revoking
// access. ADMIN and FACILITATOR only, see canManageUsers / USER_ADMIN_GRANTS.
export const USER_ADMIN_PATHS = ["/admin"];

/**
 * CONFIGURING an experience. ADMIN and FACILITATOR only, see
 * canManageWorkshopSettings.
 *
 * A regex list rather than a prefix list because the settings path has the workshop
 * id in the MIDDLE (`/experiences/<id>/settings`), so the USER_ADMIN_PATHS
 * `startsWith` form cannot express it. `/experiences` itself must stay open to JUDGE
 * and EXECUTIVE, they read the list and the detail pages, so this can only ever be
 * the narrow tail, never the `/experiences` prefix.
 *
 * `[^/]+` for the id, not `.+`: a greedy match would let `/experiences/a/settings/b`
 * match as settings, or let a nested path masquerade as one. Anchored at both ends so
 * a suffix cannot escape the gate, and a trailing slash is allowed because Next
 * serves it identically.
 */
export const WORKSHOP_ADMIN_PATTERNS = [
  /^\/experiences\/[^/]+\/settings\/?$/,
  /^\/experiences\/new\/?$/,
];

/** Prefix match: exact, or a path segment below it (never a substring, `/adminx`
 *  must NOT match `/admin`).
 *
 *  The root path "/" is treated as exact-match only. The prefix form `p + "/"` would
 *  degenerate to `startsWith("//")` for p === "/", incorrectly matching any path
 *  with a doubled leading slash. Since "/" has no meaningful "child" paths in the
 *  segment-boundary sense (every path already starts with "/"), exact match is the
 *  only correct semantic. */
export function matchesPath(pathname: string, paths: string[]): boolean {
  return paths.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(p + "/"))
  );
}

function matchesPattern(pathname: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(pathname));
}

/** No session needed. Checked FIRST, whatever the session state. */
export function isPublicPath(pathname: string): boolean {
  return matchesPath(pathname, PUBLIC_PATHS);
}

/**
 * True if a signed-in caller with this role must be redirected away from `pathname`.
 *
 * The three authZ gates in one place, ordered from broadest to narrowest, so a role
 * can never satisfy a narrow gate while failing a broad one:
 *
 *   1. a PARTICIPANT is confined to their own surface;
 *   2. the Administration area is ADMIN + FACILITATOR;
 *   3. experience CONFIGURATION is ADMIN + FACILITATOR.
 *
 * Fails CLOSED: every predicate it consults returns false for an absent or
 * unrecognised role, so a token whose groups we cannot read is treated as the least
 * privileged caller rather than waved through.
 */
export function isForbiddenPath(
  pathname: string,
  role: string | null | undefined
): boolean {
  if (!canAccessStaffScreens(role) && !matchesPath(pathname, PARTICIPANT_PATHS)) {
    return true;
  }
  if (matchesPath(pathname, USER_ADMIN_PATHS) && !canManageUsers(role)) {
    return true;
  }
  if (
    matchesPattern(pathname, WORKSHOP_ADMIN_PATTERNS) &&
    !canManageWorkshopSettings(role)
  ) {
    return true;
  }
  return false;
}
