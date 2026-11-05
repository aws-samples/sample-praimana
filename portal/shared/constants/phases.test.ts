import { describe, it, expect } from "vitest";
import { FIXED_PHASE_PIPELINE } from "./phases";
import { PHASE_LINK_FIELDS } from "./phase-links";

/**
 * ── THE THREE PHASES EVERY EXPERIENCE RUNS ─────────────────────────────────────────────────
 *
 * "why am i able to edit the phases when creating a new experience … make these non editable and
 * removable".
 *
 * ⚠ THE NAMES ARE NOT COSMETIC, WHICH IS THE REAL REASON THIS FILE EXISTS. Two features find their
 * phase BY NAME, so a rename silently removes them:
 *
 *   · `PHASE_LINK_FIELDS` keys the Demo phase's two URL inputs on the lower-cased name "demo";
 *   · `buildPhaseIdFor` (portal) finds the documents panel by the name "build".
 *
 * The create form used to let a facilitator rename Build to "Development", which took the file panel
 * away with no error anywhere. That editor is gone; these assertions are what stop the names drifting
 * apart from the code that depends on them.
 */
describe("FIXED_PHASE_PIPELINE", () => {
  it("is exactly Ideation → Build → Demo, in that order", () => {
    // Pinned against a deployed phases table: Ideation/1, Build/2, Demo/3 on every
    // existing experience. Phases are IMMUTABLE once created, so this ordering is permanent for every
    // experience already created against it.
    expect(FIXED_PHASE_PIPELINE.map((p) => p.name)).toEqual(["Ideation", "Build", "Demo"]);
  });

  it("⚠ names the Demo phase exactly as PHASE_LINK_FIELDS keys it", () => {
    // If these two ever disagree, the Demo phase silently loses its "Live application URL" and
    // "Demo video link" fields — and nothing throws.
    const demo = FIXED_PHASE_PIPELINE.find((p) => p.name === "Demo");
    expect(demo, "a phase called Demo must exist").toBeDefined();
    expect(PHASE_LINK_FIELDS[demo!.name.toLowerCase()]).toBeDefined();
  });

  it("⚠ keeps a phase called Build, which the documents panel is found by", () => {
    // `buildPhaseIdFor` matches on this name (with a positional fallback, so the files never become
    // unreachable — but the fallback attaches the panel to the WRONG phase, which is its own bug).
    expect(FIXED_PHASE_PIPELINE.some((p) => p.name.toLowerCase() === "build")).toBe(true);
  });

  it("gives every phase a description, so no experience needs one added later", () => {
    /**
     * The experience page used to prompt "Add a description in Settings to describe what teams do
     * here". No settings screen has ever edited phases, and they are immutable now — so that prompt was
     * a dead end. Supplying descriptions here is what makes it unnecessary rather than merely hidden.
     */
    for (const phase of FIXED_PHASE_PIPELINE) {
      expect(phase.description.trim().length, phase.name).toBeGreaterThan(20);
    }
  });

  it("has no duplicate names — two phases with one name would break both lookups", () => {
    const names = FIXED_PHASE_PIPELINE.map((p) => p.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});
