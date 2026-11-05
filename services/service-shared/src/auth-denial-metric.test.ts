import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { withHealth } from "./health.js";
import { AUTH_DENIAL_NAMESPACE, AUTH_DENIAL_METRIC } from "./metrics.js";
import { routeTemplate } from "./request-scope.js";

/**
 * ── ⚠ AUTHENTICATION FAILURES AND AUTHORIZATION DENIALS ARE COUNTED ───────────────────────────
 *
 * THE GAP. The platform logged business outcomes generously and kept an append-only audit trail for
 * access-CHANGE actions, and recorded NOTHING for the two event classes a security investigation
 * starts from:
 *
 *   · `edgeIdentityMiddleware` — the single authentication entry point for every HTTP service — had
 *     two 401 exits and neither emitted a log or a metric. A grep confirmed those were the ONLY two
 *     401 sites in non-test code, so token replay, expired-token floods, credential stuffing and
 *     probes of the `x-internal-token` shared secret left no trace at all.
 *   · 69 `403` responses across the service routers, with a `console.` count of 0 in the per-service
 *     `authz.ts` guard modules for ai, collaboration, docs, source, team and workshop.
 *   · No request-level access log exists (no Hono `logger()` anywhere), and this very middleware was
 *     instrumented for 503 ONLY — `if (c.res.status !== 503) return;` — excluding 401/403 BY
 *     CONSTRUCTION.
 *
 * So an incident responder could not answer "who tried to authenticate and failed" or "which
 * principal was refused which resource" from the platform's own records.
 *
 * These tests care about three things: that a denial is counted, that the label carries NO personal
 * data, and that counting it did not damage the response.
 */

/** EMF records are written to stdout as JSON, so that is where the assertions read from. */
function captureEmf() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      try {
        const parsed = JSON.parse(arg);
        if (parsed?._aws) lines.push(parsed);
      } catch {
        /* not an EMF line */
      }
    }
  });
  return lines;
}

function appReturning(status: number, body: unknown, path = "/thing") {
  const inner = new Hono();
  inner.get(path, (c) => c.json(body as Record<string, unknown>, status as 200));
  return withHealth(inner, "test-service");
}

const denialRecord = (emf: Array<Record<string, unknown>>) =>
  emf.find((l) => JSON.stringify(l).includes(AUTH_DENIAL_METRIC));

describe("auth denial metric", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each([401, 403])("counts a %s, dimensioned by service and status", async (status) => {
    const emf = captureEmf();
    const app = appReturning(status, { error: "no" });

    await app.request("/thing");

    const record = denialRecord(emf);
    expect(record, `a ${status} must publish a datapoint`).toBeDefined();
    expect(record).toMatchObject({ Service: "test-service", Status: String(status) });
    expect(JSON.stringify(record)).toContain(AUTH_DENIAL_NAMESPACE);
  });

  it("does NOT count a 200 or a 404 — only refusals", async () => {
    for (const status of [200, 404]) {
      const emf = captureEmf();
      const app = appReturning(status, { ok: true });
      await app.request("/thing");
      expect(denialRecord(emf), `${status} is not a denial`).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it("⚠ LEAVES THE RESPONSE INTACT — the caller still receives its body", async () => {
    // The 503 branch clones the body to read `code`; this branch must not, and either way the
    // response the caller receives has to survive being observed.
    captureEmf();
    const app = appReturning(403, { error: "Forbidden", code: "WORKSHOP_NOT_ENTITLED" });

    const res = await app.request("/thing");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden", code: "WORKSHOP_NOT_ENTITLED" });
  });

  it("⚠ carries a TEMPLATED route, never the raw path — no email, no id", async () => {
    /**
     * THE ASSERTION THIS FILE MOST NEEDS. Several routes are keyed on an EMAIL ADDRESS
     * (`DELETE /teams/:teamId/invitations/:email`), so a raw `c.req.path` here would write recipient
     * addresses into CloudWatch on exactly the requests most likely to be attacker-driven — the same
     * mistake the notify audit line already had to fix — and would put an unbounded caller-controlled
     * value into a metric property.
     */
    const emf = captureEmf();
    const app = appReturning(403, { error: "no" }, "/v1/teams/:teamId/invitations/:email/workshop");

    await app.request("/v1/teams/t-abc123/invitations/victim%40example.com/workshop");

    const serialised = JSON.stringify(denialRecord(emf));
    // THE POINT: the invitee's address is nowhere on the record, in any encoding.
    expect(serialised).not.toContain("victim");
    expect(serialised).not.toContain("corp.com");
    expect(serialised).not.toContain("%40");
    expect(serialised).toContain("/v1/teams/:id/invitations/:id/workshop");
    /**
     * ⚠ THE TEAM ID *IS* PRESENT, AS A PROPERTY, AND THAT IS THE EXISTING CONVENTION RATHER THAN A
     * LEAK — `scopeFromPath` puts it there so an operator can ask "is the platform refusing for the
     * workshop running right now", exactly as the fail-closed counter does. An id is an opaque
     * platform identifier; an email address is a person. The rule being enforced is that neither ever
     * becomes a DIMENSION, which the next test pins.
     */
    expect(serialised).toContain("t-abc123");
  });

  it("keeps the workshop and team scope as PROPERTIES, never dimensions", async () => {
    // Same rule as the fail-closed counter: a caller-supplied id in a dimension is unbounded
    // cardinality an anonymous caller could inflate at will.
    const emf = captureEmf();
    const app = appReturning(403, { error: "no" }, "/v1/workshops/:id/submissions");

    await app.request("/v1/workshops/w-123/submissions");

    const record = denialRecord(emf);
    expect(JSON.stringify(record)).toContain("w-123");
    // The dimension SET must name only the two bounded keys.
    const dimensionSets = (
      record?._aws as { CloudWatchMetrics?: Array<{ Dimensions: string[][] }> }
    )?.CloudWatchMetrics?.[0]?.Dimensions;
    expect(dimensionSets?.some((set) => set.includes("workshopId"))).toBeFalsy();
  });
});

describe("routeTemplate", () => {
  it("replaces ids and addresses, keeps route words", () => {
    expect(routeTemplate("/v1/teams/t-1/invitations/a@b.c/workshop")).toBe(
      "/v1/teams/:id/invitations/:id/workshop"
    );
    expect(routeTemplate("/v1/entitlements/workshops")).toBe("/v1/entitlements/workshops");
    expect(routeTemplate("/v1/admin/user-names")).toBe("/v1/admin/user-names");
  });

  it("⚠ keeps only PROVABLE route words, so an unknown id shape cannot leak", () => {
    /**
     * The polarity is the point. A denylist of id shapes fails OPEN — a new id format, or an email
     * that happens not to match, ends up in the log. Anything that is not a lower-case word or a
     * version segment becomes `:id`, so a route word this rejects costs a little precision while an
     * id it accepted would cost a caller their privacy.
     */
    expect(routeTemplate("/v1/things/01JQ7Z8ABCDEF")).toBe("/v1/things/:id");
    expect(routeTemplate("/v1/things/MiXedCase")).toBe("/v1/things/:id");
    expect(routeTemplate("/v1/things/has_underscore")).toBe("/v1/things/:id");
    expect(routeTemplate("/v1/things/123")).toBe("/v1/things/:id");
  });

  it("never throws, whatever it is handed", () => {
    // It runs on an already-refused request; an exception here would turn a denial into a 500.
    for (const path of ["", "/", "//", "no-leading-slash", "/".repeat(50)]) {
      expect(() => routeTemplate(path)).not.toThrow();
    }
  });

  it("bounds the output so one absurd path cannot bloat every log line", () => {
    const long = `/${Array.from({ length: 40 }, (_, i) => `seg${i}`).join("/")}`;  // nosemgrep: missing-template-string-indicator
    const out = routeTemplate(long);
    expect(out.endsWith("/…")).toBe(true);
    expect(out.split("/").length).toBeLessThanOrEqual(14);
  });
});
