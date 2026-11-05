import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { withHealth } from "./health.js";
import { FAIL_CLOSED_NAMESPACE, FAIL_CLOSED_METRIC, UNCODED_REFUSAL } from "./metrics.js";

/**
 * ── FAIL-CLOSED REFUSALS ARE COUNTED, AND THE RESPONSE IS UNHARMED ────────────────────────
 *
 * This middleware exists because `AWS/Lambda Errors` cannot see this platform's characteristic
 * failure: a fail-closed 503 is a SUCCESSFUL invocation (measured: 0 errors across 7 days while the
 * gateway refused 1,019 requests). So these tests care about two things in equal measure — that the
 * refusal is counted, and that counting it did not damage the response the caller receives.
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

function appReturning(status: number, body: unknown) {
  const inner = new Hono();
  inner.get("/thing", (c) => c.json(body as Record<string, unknown>, status as 200));
  return withHealth(inner, "test-service");
}

describe("fail-closed refusal metric", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("counts a coded 503, dimensioned by service and code", async () => {
    const emf = captureEmf();
    const app = appReturning(503, { error: "temporarily unavailable", code: "TEAM_SCOPE_UNAVAILABLE" });

    await app.request("/thing");

    const record = emf.find((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC));
    expect(record, "a 503 must publish a datapoint").toBeDefined();
    expect(record).toMatchObject({ Service: "test-service", Code: "TEAM_SCOPE_UNAVAILABLE" });
    expect(JSON.stringify(record)).toContain(FAIL_CLOSED_NAMESPACE);
  });

  it("⚠ LEAVES THE RESPONSE INTACT — reading the body must not consume it", async () => {
    // The failure this guards: `c.res.json()` without clone() empties the body, and the caller gets
    // an empty 503. An observability addition that breaks the error path is the worst trade available.
    captureEmf();
    const app = appReturning(503, { error: "nope", code: "ENTITLEMENTS_UNAVAILABLE" });

    const res = await app.request("/thing");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "nope", code: "ENTITLEMENTS_UNAVAILABLE" });
  });

  it("counts an UNCODED 503 rather than dropping it", async () => {
    // Dropping it would under-report exactly where the code is missing — which is also where the
    // handler is least well understood.
    const emf = captureEmf();
    const app = appReturning(503, { error: "no code here" });

    await app.request("/thing");

    const record = emf.find((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC));
    expect(record).toMatchObject({ Code: UNCODED_REFUSAL });
  });

  it("does NOT count a success, a 4xx, or a 500", async () => {
    for (const status of [200, 403, 404, 500]) {
      const emf = captureEmf();
      await appReturning(status, { error: "x", code: "SOMETHING" }).request("/thing");
      expect(
        emf.some((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC)),
        `status ${status} must not be counted as a fail-closed refusal`
      ).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("records the route path as a PROPERTY, never a dimension", async () => {
    // Route paths carry ids, and one metric per id is unbounded cardinality.
    const emf = captureEmf();
    await appReturning(503, { code: "WORKSHOP_UNAVAILABLE" }).request("/thing");

    const record = emf.find((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC))!;
    expect(record.routePath).toBe("/thing");
    const dimensionSets = (record._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> })
      .CloudWatchMetrics[0].Dimensions;
    for (const set of dimensionSets) expect(set).not.toContain("routePath");
  });

  it("still answers /health, which the middleware must not disturb", async () => {
    captureEmf();
    const res = await appReturning(200, {}).request("/health");
    expect(res.status).toBe(200);
  });

  it("never throws on a non-JSON 503 body", async () => {
    captureEmf();
    const inner = new Hono();
    inner.get("/thing", (c) => c.text("gateway said no", 503));
    const res = await withHealth(inner, "test-service").request("/thing");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("gateway said no");
  });
});
