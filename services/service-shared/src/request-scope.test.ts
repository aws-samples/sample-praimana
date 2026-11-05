import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { withHealth } from "./health.js";
import { scopeFromPath, INVALID_SCOPE_ID } from "./request-scope.js";
import { FAIL_CLOSED_METRIC } from "./metrics.js";

/**
 * ── WHICH EXPERIENCE WAS BEING REFUSED? ────────────────────────────────────────────────────
 *
 * Two things are under test and the second matters more than the first: that the scope is
 * read correctly, and that it NEVER reaches a metric dimension — because the value is caller-supplied
 * and a dimension per value is unbounded cardinality an anonymous caller could inflate at will.
 */

describe("scopeFromPath", () => {
  it("reads the workshop and team ids out of a real route path", () => {
    expect(scopeFromPath("/v1/workshops/01JABC/submissions")).toEqual({ workshopId: "01JABC" });
    expect(scopeFromPath("/v1/teams/team-7/submissions/s1/release")).toEqual({ teamId: "team-7" });
  });

  it("finds them at ANY position, because each service sees a different prefix", () => {
    // The AI service mounts under /v1/ai, so anchoring on "/v1/teams" would silently report no team
    // for every AI route — which reads as "no team involved" rather than as a bug.
    expect(scopeFromPath("/v1/ai/teams/t1/ratings/analyze")).toEqual({ teamId: "t1" });
    // And a Lambda invoked with the service's own basePath stripped sees no /v1 at all.
    expect(scopeFromPath("/teams/t1/docs")).toEqual({ teamId: "t1" });
  });

  it("reads both when a path names both", () => {
    expect(scopeFromPath("/v1/workshops/w1/teams/t1/activity")).toEqual({
      workshopId: "w1",
      teamId: "t1",
    });
  });

  it("returns nothing for a path that names neither", () => {
    expect(scopeFromPath("/v1/auth/me")).toEqual({});
    expect(scopeFromPath("/health")).toEqual({});
    expect(scopeFromPath("")).toEqual({});
  });

  it("ignores a collection name with no id after it", () => {
    // `GET /v1/workshops` lists them; there is no single workshop in scope.
    expect(scopeFromPath("/v1/workshops")).toEqual({});
    expect(scopeFromPath("/v1/workshops/")).toEqual({});
  });

  it("⚠ reports a non-id segment as INVALID rather than passing caller text through", () => {
    // Passing it through would put arbitrary caller-controlled text into an operator's log line;
    // dropping it would hide a scan for junk ids at exactly the moment someone is probing the API.
    expect(scopeFromPath("/v1/workshops/../../etc/passwd")).toEqual({
      workshopId: INVALID_SCOPE_ID,
    });
    expect(scopeFromPath("/v1/workshops/a b c/x")).toEqual({ workshopId: INVALID_SCOPE_ID });
    expect(scopeFromPath(`/v1/teams/${"x".repeat(65)}`)).toEqual({ teamId: INVALID_SCOPE_ID });
  });

  it("survives a malformed percent-escape instead of throwing", () => {
    // decodeURIComponent throws on a lone `%`. This helper runs on an already-degraded request, so
    // throwing here would turn a reported refusal into a 500.
    expect(() => scopeFromPath("/v1/workshops/%E0%A4%A")).not.toThrow();
    expect(scopeFromPath("/v1/workshops/%E0%A4%A")).toEqual({ workshopId: INVALID_SCOPE_ID });
  });

  it("takes the FIRST occurrence, so a trailing segment cannot overwrite the real one", () => {
    expect(scopeFromPath("/v1/teams/real/teams/other")).toEqual({ teamId: "real" });
  });
});

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

function refusingAt(path: string) {
  const inner = new Hono();
  inner.get(path, (c) => c.json({ error: "nope", code: "TEAM_SCOPE_UNAVAILABLE" }, 503));
  return withHealth(inner, "test-service");
}

describe("a refusal carries its experience scope", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("puts workshopId and teamId on the refusal record", async () => {
    const emf = captureEmf();
    await refusingAt("/v1/workshops/w1/teams/t1/thing").request("/v1/workshops/w1/teams/t1/thing");

    const record = emf.find((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC))!;
    expect(record).toMatchObject({ workshopId: "w1", teamId: "t1" });
  });

  it("⚠ NEVER AS A DIMENSION — this is the cardinality guard, and the whole point", async () => {
    const emf = captureEmf();
    await refusingAt("/v1/workshops/w1/teams/t1/thing").request("/v1/workshops/w1/teams/t1/thing");

    const record = emf.find((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC))!;
    const dimensionSets = (record._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> })
      .CloudWatchMetrics[0].Dimensions;
    for (const set of dimensionSets) {
      expect(set).not.toContain("workshopId");
      expect(set).not.toContain("teamId");
    }
    // The dimensions that SHOULD be there still are — the guard must not have removed the signal.
    expect(dimensionSets.some((set) => set.includes("Service") && set.includes("Code"))).toBe(true);
  });

  it("omits the keys entirely when the path names no experience", async () => {
    const emf = captureEmf();
    await refusingAt("/v1/auth/me").request("/v1/auth/me");

    const record = emf.find((l) => JSON.stringify(l).includes(FAIL_CLOSED_METRIC))!;
    // Absent, not null and not "" — an empty string reads as "a workshop with no id" in Insights.
    expect(record).not.toHaveProperty("workshopId");
    expect(record).not.toHaveProperty("teamId");
  });
});
