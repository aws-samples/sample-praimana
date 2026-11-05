import { describe, it, expect } from "vitest";
import { isBuildPhase, buildPhaseIdFor, type PhaseLike } from "./build-phase";

/**
 * WHICH PHASE CARRIES THE TEAM'S FILES.
 *
 * The Code tab was removed and its two surviving panels, the document list and a per-author
 * rollup, moved onto the build phase. That makes a NAME MATCH load-bearing, which is
 * uncomfortable enough to pin properly: phases are data a facilitator types, not an enum, and the
 * store keeps only order/name/description.
 *
 * The asymmetry drives every test below. A phase we fail to recognise loses the panel and the
 * files become UNREACHABLE, there is no tab any more. A phase we wrongly recognise shows the
 * panel in a slightly odd place. So the fallback must never return nothing, and must never return
 * more than one.
 */

const phase = (id: string, order: number, name: string): PhaseLike => ({ id, order, name });

/** The seeded pipeline in dev, verified against the live phases table. */
const CANONICAL: PhaseLike[] = [
  phase("p1", 1, "Ideation"),
  phase("p2", 2, "Build"),
  phase("p3", 3, "Demo"),
];

describe("isBuildPhase recognises ordinary names for building", () => {
  for (const name of [
    "Build",
    "build",
    "  BUILD  ",
    "Building",
    "Development",
    "Develop",
    "Hack",
    "Hacking",
    "Implementation",
    "Prototype",
    "Build & Test",
    "Design and Build",
  ]) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(isBuildPhase(name)).toBe(true);
    });
  }

  for (const name of [
    "Ideation",
    "Demo",
    "Presentation",
    "Judging",
    "Retrospective",
    "Kickoff",
    "",
    "   ",
  ]) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(isBuildPhase(name)).toBe(false);
    });
  }

  it("matches WHOLE WORDS, so a phase merely mentioning building is not it", () => {
    /**
     * A substring test would claim "Rebuild the pitch deck" and "Prebuild checks" are the build
     * phase. Both are plausible facilitator names for a phase that is not where code is written,
     * and either would attach the file list to the wrong row.
     */
    expect(isBuildPhase("Rebuild the pitch")).toBe(false);
    expect(isBuildPhase("Prebuild checks")).toBe(false);
    // …but a compound name containing the word IS a match.
    expect(isBuildPhase("Build/Test")).toBe(true);
  });

  it("treats null and undefined as not-the-build-phase", () => {
    expect(isBuildPhase(null)).toBe(false);
    expect(isBuildPhase(undefined)).toBe(false);
  });
});

describe("buildPhaseIdFor picks EXACTLY ONE phase", () => {
  it("finds Build in the canonical pipeline", () => {
    expect(buildPhaseIdFor(CANONICAL)).toBe("p2");
  });

  it("returns null only when there are NO phases", () => {
    // The page already renders "No phases defined for this workshop yet" before this is reached;
    // null is the honest answer rather than an invented anchor.
    expect(buildPhaseIdFor([])).toBeNull();
  });

  it("attaches to ONE phase even when two names match", () => {
    /**
     * ⚠ THE DUPLICATE-PANEL FAILURE. Rendering the file list twice gives a reader two copies of
     * the same documents with no way to tell which is authoritative, so the helper returns an
     * id, not a predicate, and the earlier phase in PIPELINE ORDER wins.
     */
    const two = [
      phase("a", 1, "Ideation"),
      phase("b", 2, "Build"),
      phase("c", 3, "Development"),
      phase("d", 4, "Demo"),
    ];
    expect(buildPhaseIdFor(two)).toBe("b");
  });

  it("uses PIPELINE order, not array order", () => {
    // The API is not required to return phases sorted, and "first match" must mean first in the
    // workshop's sequence, otherwise the answer depends on a scan order nobody controls.
    const shuffled = [
      phase("late", 4, "Development"),
      phase("demo", 5, "Demo"),
      phase("early", 2, "Build"),
      phase("idea", 1, "Ideation"),
    ];
    expect(buildPhaseIdFor(shuffled)).toBe("early");
  });

  it("does not mutate the caller's array", () => {
    /**
     * It sorts internally, and an in-place sort would reorder the very array the page is
     * rendering, the exact bug already found once on the insights page's memoised metrics.
     *
     * ⚠ THE INPUT MUST BE UNSORTED FOR THIS TO PROVE ANYTHING. My first version of this test
     * passed `CANONICAL`, which is already in order, so an in-place `.sort()` left it looking
     * untouched and the test survived the mutation. Verified by re-running that mutation against
     * this version.
     */
    const input = [
      phase("demo", 3, "Demo"),
      phase("build", 2, "Build"),
      phase("idea", 1, "Ideation"),
    ];
    const before = input.map((p) => p.id);

    buildPhaseIdFor(input);

    expect(input.map((p) => p.id), "the caller's order must survive").toEqual(before);
  });
});

describe("when NO name matches, the panel still appears somewhere sensible", () => {
  /**
   * WHY THERE IS A FALLBACK AT ALL. A workshop naming its phases "Explore / Make / Show" would
   * otherwise have no files panel anywhere, and with the Code tab deleted the documents would be
   * unreachable from the portal entirely. Losing the files is a worse outcome than putting the
   * panel on a row somebody has to think about for a second.
   */
  it("uses the phase BEFORE the last in a three-phase pipeline", () => {
    const renamed = [
      phase("x", 1, "Explore"),
      phase("y", 2, "Make"),
      phase("z", 3, "Show"),
    ];
    expect(buildPhaseIdFor(renamed)).toBe("y");
  });

  it("uses the LAST phase when there are only one or two", () => {
    // "Before the last" is meaningless here, and the second of two phases is where work lands.
    expect(buildPhaseIdFor([phase("only", 1, "Workshop")])).toBe("only");
    expect(
      buildPhaseIdFor([phase("first", 1, "Plan"), phase("second", 2, "Do")])
    ).toBe("second");
  });

  it("still prefers a NAME match over the positional guess", () => {
    // Five phases, the build one first, position would pick the fourth.
    const five = [
      phase("a", 1, "Build"),
      phase("b", 2, "Review"),
      phase("c", 3, "Polish"),
      phase("d", 4, "Rehearse"),
      phase("e", 5, "Demo"),
    ];
    expect(buildPhaseIdFor(five)).toBe("a");
  });
});
