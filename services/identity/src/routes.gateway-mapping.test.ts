import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * ── ⚠ EVERY HONO ROUTE NEEDS A GATEWAY ROUTE ───────────────────────────────────────────────
 *
 * This is the second copy of this guard, and the reason is the bug it was written for: the docs service
 * shipped `DELETE /v1/teams/:teamId/docs` with six passing tests and no gateway mapping, and every request
 * 404'd at the edge. HttpApi routes are PER-METHOD, so an existing GET on the same path covers nothing.
 *
 * ⚠ NEITHER LAYER OF NORMAL VERIFICATION CAN SEE IT. Unit tests call the Hono app directly, and even a
 * live Lambda invoke with a synthetic API Gateway event skips the gateway — so a missing mapping is
 * invisible to both by construction. Only a request to the URL, or this test, finds it.
 *
 * Identity gained three routes with the feedback inbox, which is why it gets the guard now.
 *
 * ⚠ WHAT THIS STILL CANNOT PROVE: that the deployed stack matches this template. That needs a probe
 * against the real URL.
 */

/**
 * ⚠ `infrastructureTemplateText()` RETURNS "" WHEN THE TEMPLATE IS ABSENT, NOT NULL, and the
 * difference decides whether this file loads. Module-scope helpers below derive values from
 * TEMPLATE during COLLECTION, before any `describe` runs, so a null would throw and the file would
 * FAIL rather than skip. `HAS_TEMPLATE` is what gates the assertions.
 */
const TEMPLATE = infrastructureTemplateText();
const HAS_TEMPLATE = hasInfrastructureTemplate();
const ROUTES_SRC = readFileSync(fileURLToPath(new URL("./routes.ts", import.meta.url)), "utf8");

/** The identity function's `Events:` block — the only place its gateway routes are declared. */
function identityFunctionEvents(): string {
  // ⚠ NO-OP WITHOUT THE TEMPLATE. `describe.skipIf` still EVALUATES the describe body during
  // collection, so helpers called there run even when every test in them is skipped — and an
  // `expect` in here would fail the file rather than skip it. Guarded at the top so the absent-
  // template path stays a todo. See `sibling-repo.ts`.
  if (!HAS_TEMPLATE) return "";
  const start = TEMPLATE.indexOf("  IdentityFunction:");
  expect(start, "IdentityFunction must exist in the template").toBeGreaterThan(-1);
  const events = TEMPLATE.indexOf("      Events:", start);
  expect(events, "IdentityFunction must declare Events").toBeGreaterThan(-1);
  const next = TEMPLATE.slice(events).search(/\n {2}[A-Za-z][A-Za-z0-9]*:\n/);
  return TEMPLATE.slice(events, next === -1 ? undefined : events + next);
}

/**
 * Every route the service registers, with Hono's `:param` turned into the gateway's `{param}`.
 *
 * ⚠ TWO ROUTERS WITH DIFFERENT BASE PATHS. `identity` is mounted at `/v1/auth` and `admin` at `/v1/admin`,
 * so the prefix depends on which variable registered the route. Assuming one prefix would silently pass
 * every admin route while checking nothing.
 */
function honoRoutes(): Array<{ method: string; path: string }> {
  const BASE: Record<string, string> = { identity: "/v1/auth", admin: "/v1/admin" };
  const found: Array<{ method: string; path: string }> = [];
  const re = /\b(identity|admin)\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (const match of ROUTES_SRC.matchAll(re)) {
    const path = `${BASE[match[1]]}${match[3]}`
      .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
      // `identity.get("/config")` → /v1/auth/config; a bare "/" would double the slash.
      .replace(/\/+$/, "");
    found.push({ method: match[2].toUpperCase(), path });
  }
  return found;
}

describe.skipIf(!HAS_TEMPLATE)("every identity route is reachable through the gateway", () => {
  const events = identityFunctionEvents();
  const routes = honoRoutes();

  it("found the routes and the template block it is comparing", () => {
    // A scan that matched nothing would pass every assertion below. This is the canary.
    expect(routes.length).toBeGreaterThanOrEqual(6);
    expect(events).toContain("Type: HttpApi");
    // Both routers must be represented, or the prefix logic above is silently wrong.
    expect(routes.some((r) => r.path.startsWith("/v1/auth"))).toBe(true);
    expect(routes.some((r) => r.path.startsWith("/v1/admin"))).toBe(true);
  });

  it("⚠ maps EVERY method on EVERY path — matching the pair, not the path alone", () => {
    // Asserting the path alone is what let the docs bug through: the path existed for GET while DELETE on
    // it did not.
    for (const { method, path } of routes) {
      const p = path.replace(/[{}]/g, "\\$&");
      const mapped =
        new RegExp(`Path: "?${p}"?\\s*\\n\\s*Method: ${method}\\b`).test(events) ||
        new RegExp(`Method: ${method}\\s*\\n\\s*Path: "?${p}"?`).test(events);
      expect(mapped, `${method} ${path} has no HttpApi route on IdentityFunction — it will 404`).toBe(
        true
      );
    }
  });

  it("maps the three feedback routes by name", () => {
    /**
     * Named as well as derived, so the routes this file was created for are legible in a failure message
     * rather than only inside a loop.
     *
     * ⚠ ORDER-AGNOSTIC, and the first draft was not — it assumed `Path:` then `Method:` and failed on a
     * correct template that writes `Method:` first. A test that depends on the order of two independent
     * YAML keys is testing formatting, not routing.
     */
    const mapped = (method: string, path: string) => {
      const p = path.replace(/[{}]/g, "\\$&");
      return (
        new RegExp(`Path: "?${p}"?\\s*\\n\\s*Method: ${method}\\b`).test(events) ||  // nosemgrep: detect-non-literal-regexp
        new RegExp(`Method: ${method}\\s*\\n\\s*Path: "?${p}"?`).test(events)  // nosemgrep: detect-non-literal-regexp
      );
    };
    expect(mapped("POST", "/v1/auth/feedback"), "POST /v1/auth/feedback").toBe(true);
    expect(mapped("GET", "/v1/admin/feedback"), "GET /v1/admin/feedback").toBe(true);
    expect(
      mapped("POST", "/v1/admin/feedback/{id}/acknowledge"),
      "POST the acknowledge route"
    ).toBe(true);
  });
});

/**
 * ⚠ ABSENT SIBLING REPO ⇒ A TODO, NEVER A SILENT PASS. Every assertion above is skipped when the
 * infrastructure repo is not checked out beside this one, so this reports the gap in the run summary
 * instead of leaving a low test count to be noticed by nobody. See `sibling-repo.ts`.
 */
if (!HAS_TEMPLATE) {
  describe("the infrastructure template", () => {
    it.todo(TEMPLATE_ABSENT_TODO);
  });
}
