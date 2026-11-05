import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * ── ⚠ EVERY HONO ROUTE NEEDS A GATEWAY ROUTE, AND ONE DID NOT HAVE ONE ─────────────────────
 *
 * THE SYMPTOM: "Delete was refused (HTTP 404)".
 *
 * `DELETE /v1/teams/:teamId/docs` existed in `routes.ts`, had six passing tests, and was present in the
 * deployed bundle — and every request 404'd. API Gateway HttpApi routes are PER-METHOD, so the existing
 * `GET /v1/teams/{teamId}/docs` mapping did not cover DELETE on the same path. The request never reached
 * the Lambda.
 *
 * ── ⚠ WHY NOTHING CAUGHT IT, WHICH IS THE PART WORTH FIXING ──
 *
 * Both layers of verification shared one blind spot:
 *
 *   · the unit tests call `app.request(...)` — the Hono app DIRECTLY. No gateway involved, so a missing
 *     mapping is invisible by construction.
 *   · the live check invoked the LAMBDA with a synthetic API Gateway event. Also no gateway. It proved
 *     the handler works and could never have proved the route is reachable.
 *
 * Passing tests plus a passing live probe, and the feature was unusable. The warning was even already
 * written in the template, on `UpdateMe`: "the request would 404 at the gateway before ever reaching
 * Hono — which looks exactly like a missing handler." It was there and the mapping was still forgotten.
 *
 * So this test DERIVES the expectation from the service's own routes rather than listing them: add a
 * method to `routes.ts` without adding its mapping and this fails, without anyone having to remember.
 *
 * ⚠ WHAT IT STILL CANNOT PROVE: that the deployed stack matches this template, or that API Gateway
 * resolves a specific path ahead of a greedy one. Those need a live probe against the URL — not against
 * the Lambda. That distinction is the whole lesson of this file.
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

/** The docs function's `Events:` block — the only place its gateway routes are declared. */
function docsFunctionEvents(): string {
  // ⚠ NO-OP WITHOUT THE TEMPLATE. `describe.skipIf` still EVALUATES the describe body during
  // collection, so helpers called there run even when every test in them is skipped — and an
  // `expect` in here would fail the file rather than skip it. Guarded at the top so the absent-
  // template path stays a todo. See `sibling-repo.ts`.
  if (!HAS_TEMPLATE) return "";
  const start = TEMPLATE.indexOf("  DocsFunction:");
  expect(start, "DocsFunction must exist in the template").toBeGreaterThan(-1);
  const events = TEMPLATE.indexOf("      Events:", start);
  expect(events, "DocsFunction must declare Events").toBeGreaterThan(-1);
  // Up to the next top-level resource (two-space indent), which ends this function's block.
  const next = TEMPLATE.slice(events).search(/\n {2}[A-Za-z][A-Za-z0-9]*:\n/);
  return TEMPLATE.slice(events, next === -1 ? undefined : events + next);
}

/**
 * Every route the service registers, as `{ method, path }` with Hono's `:param` turned into the
 * gateway's `{param}`. Read from the source because that is the thing that must not drift.
 */
function honoRoutes(): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];
  const re = /\bdocs\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (const match of ROUTES_SRC.matchAll(re)) {
    const method = match[1].toUpperCase();
    // The app is mounted with `.basePath("/v1")`, so a registered "/teams/:id/docs" is served at
    // "/v1/teams/{id}/docs".
    const path = `/v1${match[2]}`.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    found.push({ method, path });
  }
  return found;
}

describe.skipIf(!HAS_TEMPLATE)("every docs route is reachable through the gateway", () => {
  const events = docsFunctionEvents();
  const routes = honoRoutes();

  it("found the routes and the template block it is comparing", () => {
    // A scan that matched nothing would pass every assertion below. This is the canary.
    expect(routes.length).toBeGreaterThanOrEqual(6);
    expect(events).toContain("Type: HttpApi");
  });

  it("⚠ maps EVERY method on EVERY path — the check that was missing", () => {
    /**
     * A mapping must match BOTH the path and the method. Asserting the path alone is what made this bug
     * possible: `/v1/teams/{teamId}/docs` was present (for GET) while DELETE on it was not.
     */
    for (const { method, path } of routes) {
      // The Path and Method lines are adjacent in the Events block, in either order.
      const mapped =
        new RegExp(`Path: "?${path.replace(/[{}]/g, "\\$&")}"?\\s*\\n\\s*Method: ${method}\\b`).test(  // nosemgrep: missing-template-string-indicator
          events
        ) ||
        new RegExp(`Method: ${method}\\s*\\n\\s*Path: "?${path.replace(/[{}]/g, "\\$&")}"?`).test(  // nosemgrep: missing-template-string-indicator
          events
        );
      expect(mapped, `${method} ${path} has no HttpApi route on DocsFunction — it will 404`).toBe(
        true
      );
    }
  });

  it("maps the DELETE that was reported as a 404, by name", () => {
    // Named explicitly as well as derived, so the regression that prompted this file is legible in a
    // failure message rather than only in a loop.
    expect(events).toMatch(/Path: "\/v1\/teams\/\{teamId\}\/docs"\s*\n\s*Method: DELETE/);
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
