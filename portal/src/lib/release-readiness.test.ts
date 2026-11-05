import { describe, it, expect } from "vitest";
import { isReleasableDemoUrl, releaseReadiness } from "./release-readiness";

/**
 * RELEASE READINESS, the client half of the release preconditions.
 *
 * ⚠ THESE MIRROR THE SERVICE'S OWN RELEASE PRECONDITIONS ON PURPOSE. The artifact, demo-link and
 * https-only cases are asserted against the evaluation service in
 * `the evaluation service's `routes.test.ts``; the same cases are asserted here against the
 * client's copy. That is what makes the duplication in `release-readiness.ts` survivable: if the
 * server's protocol rule ever changes, this file fails and names the divergence.
 */

describe("isReleasableDemoUrl", () => {
  it("accepts https", () => {
    expect(isReleasableDemoUrl("https://demo.example/team")).toBe(true);
  });

  it("accepts an UPPERCASE scheme, it parses rather than pattern-matches", () => {
    // The case a `startsWith("https://")` check gets wrong.
    expect(isReleasableDemoUrl("HTTPS://demo.example")).toBe(true);
  });

  it("refuses http, because this link is handed to a panel of judges", () => {
    expect(isReleasableDemoUrl("http://demo.example")).toBe(false);
  });

  it("refuses javascript:, which is the reason this is an allowlist and not a blocklist", () => {
    expect(isReleasableDemoUrl("javascript:alert(1)")).toBe(false);
  });

  it("refuses other schemes", () => {
    expect(isReleasableDemoUrl("ftp://files.example/demo")).toBe(false);
    expect(isReleasableDemoUrl("data:text/html,<h1>hi</h1>")).toBe(false);
  });

  it("refuses text that is not a URL at all", () => {
    // A team typing "coming soon" must not be releasable.
    expect(isReleasableDemoUrl("coming soon")).toBe(false);
    expect(isReleasableDemoUrl("demo.example")).toBe(false);
  });

  it("refuses empty, null and undefined", () => {
    expect(isReleasableDemoUrl("")).toBe(false);
    expect(isReleasableDemoUrl(null)).toBe(false);
    expect(isReleasableDemoUrl(undefined)).toBe(false);
  });
});

describe("releaseReadiness", () => {
  const ready = {
    artifactCount: 2,
    demoUrl: "https://demo.example",
    hasUnsavedEdits: false,
  };

  it("reports no blockers when everything is in place", () => {
    const readiness = releaseReadiness(ready);
    expect(readiness.blockers).toEqual([]);
    expect(readiness).toMatchObject({ artifactsOk: true, demoOk: true, savedOk: true });
  });

  it("zero files blocks, and says so in the team's terms", () => {
    const readiness = releaseReadiness({ ...ready, artifactCount: 0 });
    expect(readiness.artifactsOk).toBe(false);
    expect(readiness.blockers).toHaveLength(1);
    expect(readiness.blockers[0]).toMatch(/files/i);
    // ⚠ Documents carry no phase attribution, so the copy must NOT claim a
    // build-phase check the server cannot perform.
    expect(readiness.blockers[0]).not.toMatch(/build/i);
  });

  it("a missing demo link blocks, DISTINCTLY from missing files", () => {
    const noDemo = releaseReadiness({ ...ready, demoUrl: null });
    const noFiles = releaseReadiness({ ...ready, artifactCount: 0 });
    expect(noDemo.blockers[0]).not.toBe(noFiles.blockers[0]);
    expect(noDemo.blockers[0]).toMatch(/https:\/\//);
  });

  it("⚠ unsaved edits block, because release reads the STORE and not the form", () => {
    // Without this, an executive releases a submission missing the demo link a teammate has
    // typed but not saved, and is told NO_DEMO_URL while looking straight at it.
    const readiness = releaseReadiness({ ...ready, hasUnsavedEdits: true });
    expect(readiness.savedOk).toBe(false);
    expect(readiness.blockers).toHaveLength(1);
    expect(readiness.blockers[0]).toMatch(/save/i);
  });

  it("reports EVERY blocker, so the checklist is not solved one round trip at a time", () => {
    const readiness = releaseReadiness({
      artifactCount: 0,
      demoUrl: "http://demo.example",
      hasUnsavedEdits: true,
    });
    expect(readiness.blockers).toHaveLength(3);
  });

  it("orders them files → demo → unsaved, matching the checklist on screen", () => {
    const readiness = releaseReadiness({
      artifactCount: 0,
      demoUrl: null,
      hasUnsavedEdits: true,
    });
    expect(readiness.blockers.map((b) => b.slice(0, 12))).toEqual([
      "The team has",
      "A demo link ",
      "Save the cha",
    ]);
  });
});
