import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { landingPathForRole } from "@praimana/shared";
import { isForbiddenPath, isPublicPath } from "@/lib/route-gates";
import { buildContentSecurityPolicy, CSP_HEADER, NONCE_HEADER } from "@/lib/csp";

/**
 * Route gating, in order:
 *
 *  1. CSRF / ORIGIN CHECK, mutating requests to API routes must originate from this app.
 *  2. PUBLIC, no session needed, checked before anything else.
 *  3. authN, an anonymous request to a non-public path goes to /login.
 *  4. authZ, the three role gates, all in `isForbiddenPath`:
 *       a. a signed-in PARTICIPANT is confined to the onboarding page. They register
 *          in this browser app (the invite flow lands here), see their team join code
 *          + the desktop download, and build in the desktop app; the staff screens
 *          (workshops, team management, scoring) are not theirs.
 *       b. the Administration area is for ADMIN and FACILITATOR only, gate (a) is
 *          not enough, because canAccessStaffScreens admits JUDGE and EXECUTIVE, who
 *          score and observe but must not manage accounts.
 *       c. CONFIGURING an experience (its settings form, the create form) is ADMIN +
 *          FACILITATOR for the same reason: a judge evaluates an experience and an
 *          executive observes one; neither renames it, moves it through its
 *          lifecycle, or decides which AI assistants it offers.
 *
 * The RULES live in @/lib/route-gates so they can be unit-tested, this module
 * imports next-auth's runtime and cannot be loaded in a plain node test, which is
 * why the gates used to have none. What stays here is the redirect mechanics.
 *
 * This is UI routing, not the security boundary: every mutation is additionally gated
 * server-side (tRPC role checks + the services' own authz), so a participant who
 * bypasses the redirect still can't act as staff. Specifically for (c), the Workshop
 * service requires ownership-or-ADMIN on every workshop write, isOwnerOrAdmin in
 * the workshop service's `routes.ts`:46, applied by PATCH /v1/workshops/:id, PATCH
 * /status, PUT /phases and PATCH /current-phase, so reaching the settings form
 * anyway yields a form whose every Save returns 403.
 */

/**
 * ── CSRF / ORIGIN VALIDATION ────────────────────────────────────────────────────────────────
 *
 * Mutating requests (POST, PUT, PATCH, DELETE) to API routes must carry an Origin or Referer
 * header that matches this app's own origin. This is an explicit defence against cross-origin
 * request forgery, while SameSite=Lax on the session cookie already prevents cookie-bearing
 * cross-origin POSTs from most browser contexts, an explicit Origin check closes the remaining
 * edge cases (e.g. top-level form POSTs from a third-party page, which SameSite=Lax allows).
 *
 * ⚠ Only API routes are checked, page navigations (GET) are not mutating and pass through.
 * Auth.js's own /api/auth/* routes are excluded because they handle their own CSRF token.
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/trpc");
}

function isAuthRoute(pathname: string): boolean {
  return pathname.startsWith("/api/auth/");
}

/**
 * Routes authenticated by a BEARER TOKEN rather than by the session cookie.
 *
 * They are exempt from the Origin check because CSRF requires an AMBIENT credential and a bearer
 * token is not one, see the call site.
 *
 * ⚠ AN EXPLICIT LIST, NOT THE `/api/desktop/` PREFIX, AND THE DIFFERENCE IS A REAL BUG THIS FIXES.
 * The prefix form exempted the whole namespace on the grounds that "those routes are
 * bearer-authenticated", which is false for one of them: `/api/desktop/download` authenticates with
 * `await auth()`, the SESSION COOKIE, and its own header says so. A path-prefix exemption justified
 * by an authentication property that is not prefix-wide is a trap: it was harmless only because that
 * route is GET-only and this check applies to mutating methods, so the first POST added under
 * `/api/desktop/` would have inherited a CSRF exemption it did not deserve.
 *
 * ⚠ SO ADDING A ROUTE HERE IS A DECISION, and the test asserts the list matches the routes that
 * actually use `withBearer`. If you add a bearer route, add it here; if you add a cookie-authenticated
 * one, do not.
 */
const BEARER_ONLY_ROUTES: readonly string[] = [
  "/api/desktop/team-data",
  "/api/desktop/create-task",
  "/api/desktop/send-message",
  "/api/desktop/join-team",
];

function isBearerOnlyRoute(pathname: string): boolean {
  return BEARER_ONLY_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

function getOrigin(req: Request): string | null {
  // Prefer Origin (set by all modern browsers on cross-origin and same-origin POSTs).
  // Fall back to Referer's origin for older clients.
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Is this request's Origin the app's own?
 *
 * ⚠ COMPARED ON HOST, NOT ON THE WHOLE ORIGIN, AND GETTING THIS WRONG TAKES THE APP DOWN.
 * `req.nextUrl.origin` is derived from the forwarded host, but its PROTOCOL is whatever the
 * proxy spoke to the Next server, which behind Amplify/CloudFront is plain http on the inside
 * while the browser's `Origin` header says `https://`. A whole-origin equality test therefore
 * rejects EVERY mutating request in production while passing every test locally, where both
 * sides are http. The host is the part that actually identifies the site; the scheme is
 * separately guaranteed by HSTS and the redirect at the edge.
 *
 * `host` is trusted here only as far as it needs to be: this check exists to stop a THIRD-PARTY
 * PAGE driving a mutating request with the user's cookie, and an attacker's page cannot forge
 * the browser-set `Origin`. A forged `Host` on a direct (non-browser) request buys nothing,
 * because such a request has no ambient cookie to abuse, which is the same reason the
 * no-Origin case below is allowed through.
 */
function isSameSiteOrigin(requestOrigin: string, req: { nextUrl: URL; headers: Headers }): boolean {
  let originHost: string;
  try {
    originHost = new URL(requestOrigin).host;
  } catch {
    return false;
  }
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = req.headers.get("host");
  return (
    originHost === req.nextUrl.host ||
    (!!forwardedHost && originHost === forwardedHost) ||
    (!!host && originHost === host)
  );
}

/**
 * ── THE PER-REQUEST CSP NONCE ─────────────────────────────────────────────────────────────────
 *
 * 128 bits of CSP-safe base64, fresh per response. `crypto.randomUUID()` is available on the edge
 * runtime and is cryptographically random, but a UUID is only 122 bits and carries hyphens; the
 * getRandomValues form is both stronger and exactly what the CSP spec's nonce grammar wants.
 *
 * ⚠ IT MUST BE UNPREDICTABLE AND IT MUST NOT REPEAT. A reused nonce lets an injection that once
 * observed it stay valid on later responses, which is why this cannot be computed at build time,
 * and therefore why the policy moved out of `next.config.ts`.
 */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Attach the CSP (and the nonce the layout needs) to a response.
 *
 * ⚠ EVERY RETURN PATH IN THIS MIDDLEWARE GOES THROUGH HERE, including the 403, the redirects and
 * the public-path passthrough. A policy applied only to the "allowed" path would leave the
 * anonymous→/login redirect and the CSRF refusal without one, i.e. exactly the responses an attacker
 * is most likely to be looking at.
 */
function withSecurityHeaders(res: NextResponse, nonce: string): NextResponse {
  res.headers.set(CSP_HEADER, buildContentSecurityPolicy(nonce));
  return res;
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const method = req.method;

  /**
   * The nonce is generated once per request and travels two ways: into the response header (the
   * policy) and into the REQUEST headers (so the root layout can put it on the script tags Next
   * renders). Middleware cannot pass a value to a server component any other way.
   */
  const nonce = newNonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  const next = () => withSecurityHeaders(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
  const redirect = (url: URL) => withSecurityHeaders(NextResponse.redirect(url), nonce);

  /**
   * ── CSRF CHECK: a mutating, COOKIE-AUTHENTICATED call must come from this site ──
   *
   * Skips Auth.js's own routes (they carry their own CSRF token) and non-mutating methods.
   *
   * ⚠ AND SKIPS THE BEARER-ONLY ROUTES, WHICH IS A CORRECTNESS POINT RATHER THAN AN EXEMPTION.
   * CSRF is an attack on AMBIENT credentials: it works because the browser attaches the session
   * cookie to a request the user did not intend. `/api/desktop/*` is authenticated by an
   * `Authorization: Bearer` header (`withBearer`), which no third-party page can set on a
   * cross-origin request without a CORS preflight this app never answers, so there is nothing
   * for CSRF to ride on. Applying the check there would buy no safety and would 403 any legitimate
   * non-browser client that happens to send an `Origin` (an Electron renderer does).
   *
   * If no `Origin` and no `Referer` is present at all, the request is not coming from a browser
   * page context, so again there is no ambient cookie to abuse. Allowed through.
   */
  if (
    MUTATING_METHODS.has(method) &&
    isApiRoute(pathname) &&
    !isAuthRoute(pathname) &&
    !isBearerOnlyRoute(pathname)
  ) {
    const requestOrigin = getOrigin(req);
    if (requestOrigin && !isSameSiteOrigin(requestOrigin, req)) {
      return withSecurityHeaders(
        new NextResponse("Forbidden: cross-origin request", { status: 403 }),
        nonce
      );
    }
  }

  // Public paths pass FIRST, whatever the session state. /login especially must
  // stay reachable while signed in: a session whose role we can't read (a broken
  // or half-provisioned one) would otherwise be redirected away from the only
  // page that can fix it, an inescapable loop.
  if (isPublicPath(pathname)) {
    return next();
  }

  if (!req.auth) {
    return redirect(new URL("/login", req.nextUrl));
  }

  // Redirect to the role's OWN landing path rather than a fixed one, so a stray
  // /admin link sends a judge to the workshop list and a participant to /welcome -
  // never to a page the next gate would just bounce again. Both landing paths are
  // themselves permitted for the role that lands on them, so this cannot loop.
  const role = req.auth.user?.role;
  if (isForbiddenPath(pathname, role)) {
    return redirect(new URL(landingPathForRole(role), req.nextUrl));
  }

  return next();
});

export const config = {
  /**
   * ── ⚠ THE EXCLUSION IS AN ALLOWLIST OF REAL ASSETS, NOT A FILE-EXTENSION TEST ───────────────
   *
   * Why middleware skips anything at all: browsers request the PNG icons and the favicon
   * directly, and the anonymous→/login redirect would answer them with an HTML page instead of
   * the image.
   *
   * ⚠ THE SUFFIX FORM THAT WAS HERE REMOVED EVERY GATE FROM ANY PATH ENDING IN AN IMAGE
   * EXTENSION, ANYWHERE. It read `.*\.(?:png|jpg|...)$`, unanchored to any prefix, so it matched
   * over the WHOLE path space, not just `/public`. `GET /admin/users/export.png` therefore skipped
   * the CSRF origin check, the `!req.auth` redirect AND all three role gates in one go. The role
   * gates are the sharp end: they are NEGATED matches (`isForbiddenPath`), so a path that never
   * reaches them is not "unmatched", it is ALLOWED.
   *
   * ⚠ SO THIS NAMES THE FILES, and `middleware-matcher.test.ts` DERIVES its check from `public/`
   *, every file actually served from there must be excluded here, and nothing else may be. Adding
   * an asset without adding it here fails that test rather than being discovered as a 302 on an
   * icon; adding a ROUTE that happens to end in `.png` can no longer strip its own gates.
   *
   * Kept literal rather than composed from a constant: Next statically analyses this object at
   * build time, so an imported value would not be read.
   *
   * ⚠ NAME FULL PATHS, NEVER A DIRECTORY PREFIX such as `.well-known/`. A prefix would take every
   * gate off anything ever added under it — the same shape as the suffix form above.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|favicon\\.png|apple-touch-icon\\.png|icon-192\\.png|icon-512\\.png|icons/).*)",
  ],
};
