// ── ⚠ THE CSRF EXEMPTION MUST MATCH HOW EACH ROUTE ACTUALLY AUTHENTICATES ────────────────────
//
// `middleware.ts` skips the Origin check for bearer-authenticated routes, and the reasoning is sound:
// CSRF is an attack on AMBIENT credentials, it works because the browser attaches the session cookie
// to a request the user did not intend. A bearer token is not ambient; no third-party page can set an
// `Authorization` header cross-origin without a CORS preflight this app never answers. So there is
// nothing for CSRF to ride on, and applying the check there would only 403 legitimate non-browser
// clients (an Electron renderer does send an `Origin`).
//
// ⚠ THE EXEMPTION USED TO BE THE `/api/desktop/` PREFIX, AND THAT WAS WRONG FOR ONE ROUTE.
// `/api/desktop/download` authenticates with `await auth()`, the SESSION COOKIE, and its own header
// says so. A path-prefix exemption justified by an authentication property that is not prefix-wide is
// a latent trap: it was harmless only because that route is GET-only while the check applies to
// mutating methods, so the first POST added under that prefix would have silently inherited a CSRF
// exemption it did not deserve.
//
// This test is what stops the list and the reality drifting apart, in either direction: a bearer route
// missing from the list gets 403s it should not, and a cookie route added to it loses CSRF protection.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DESKTOP_API = join(__dirname, "..", "app", "api", "desktop");
const MIDDLEWARE = join(__dirname, "..", "middleware.ts");

/** Does this route file wrap its handler in `withBearer`, or read the session cookie? */
function authMechanism(routeFile: string): "bearer" | "cookie" {
  const src = readFileSync(routeFile, "utf8");
  // The WRAPPER, not a mention: `download/route.ts` names `withBearer` in a comment explaining that
  // it deliberately does NOT use it, which is exactly the confusion a substring match would inherit.
  const wraps = /=\s*withBearer\(|withBearer\(\s*async/.test(src);
  return wraps ? "bearer" : "cookie";
}

/** Every `/api/desktop/*` route, with how it authenticates. */
function desktopRoutes(): Array<{ path: string; auth: "bearer" | "cookie" }> {
  return readdirSync(DESKTOP_API)
    .filter((entry) => {
      try {
        readFileSync(join(DESKTOP_API, entry, "route.ts"));
        return true;
      } catch {
        return false;
      }
    })
    .map((entry) => ({
      path: `/api/desktop/${entry}`,
      auth: authMechanism(join(DESKTOP_API, entry, "route.ts")),
    }));
}

/** The exemption list as `middleware.ts` declares it. */
function declaredExemptions(): string[] {
  const src = readFileSync(MIDDLEWARE, "utf8");
  const block = /const BEARER_ONLY_ROUTES: readonly string\[\] = \[([\s\S]*?)\];/.exec(src);
  expect(block, "BEARER_ONLY_ROUTES should be declared as a literal array").not.toBeNull();
  return [...(block as RegExpExecArray)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the CSRF exemption list", () => {
  it("⚠ EXEMPTS EXACTLY THE BEARER-AUTHENTICATED ROUTES, no more and no fewer", () => {
    const routes = desktopRoutes();
    const bearer = routes.filter((r) => r.auth === "bearer").map((r) => r.path).sort();
    expect(bearer.length, "there should be desktop routes to reason about").toBeGreaterThan(0);
    expect(declaredExemptions().sort()).toEqual(bearer);
  });

  it("⚠ DOES NOT EXEMPT THE COOKIE-AUTHENTICATED DOWNLOAD ROUTE", () => {
    // Named explicitly rather than left to the set comparison above, because this specific route is
    // the reason the prefix form was a bug, and a reader should see why it is called out.
    const routes = desktopRoutes();
    const cookieRoutes = routes.filter((r) => r.auth === "cookie").map((r) => r.path);
    expect(cookieRoutes, "download reads `await auth()`").toContain("/api/desktop/download");
    for (const path of cookieRoutes) {
      expect(declaredExemptions(), `${path} is cookie-authenticated`).not.toContain(path);
    }
  });

  it("is a literal list rather than a path prefix", () => {
    // A `startsWith("/api/desktop/")` would silently re-acquire the bug the moment a
    // cookie-authenticated route joined the namespace.
    const src = readFileSync(MIDDLEWARE, "utf8");
    expect(src).not.toMatch(/isBearerOnlyRoute[\s\S]{0,200}startsWith\("\/api\/desktop\/"\)/);
  });
});
