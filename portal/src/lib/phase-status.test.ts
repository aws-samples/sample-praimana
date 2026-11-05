import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { sourceWithoutComments } from "@/lib/source-under-test";
import {
  readSiblingRepoSource,
  siblingRepoPresent,
} from "@/lib/sibling-repo-source";
import {
  derivePhaseStatus,
  phasesWithStatus,
  type PhaseStatusInput,
} from "./phase-status";

/**
 * PHASE STATUS IS A COMPARISON AGAINST THE WORKSHOP'S `currentPhaseOrder`, and these tests exist
 * because the portal previously had no implementation of it at all.
 *
 * `team.getById` returned a hardcoded `teamPhases: []`. The workspace layout's stepper is gated on
 * `length > 0` so it never rendered, and the insights page reported "0 of 0 phases" as fact on a
 * page executives read. The rule was never wrong, it was absent, while two screens behaved as
 * though it were present.
 *
 * The boundary that matters is the CURRENT phase: off by one in either direction and a facilitator
 * either sees the phase they are running marked finished, or the one they finished marked live.
 */

const phase = (order: number, name = `Phase ${order}`): PhaseStatusInput => ({
  id: `p${order}`,
  order,
  name,
});

describe("derivePhaseStatus, the boundary at the current phase", () => {
  it("marks earlier phases COMPLETED", () => {
    expect(derivePhaseStatus(1, 3)).toBe("COMPLETED");
    expect(derivePhaseStatus(2, 3)).toBe("COMPLETED");
  });

  it("marks the current phase IN_PROGRESS, not COMPLETED", () => {
    // The off-by-one that would tell a facilitator the phase they are running is done.
    expect(derivePhaseStatus(3, 3)).toBe("IN_PROGRESS");
  });

  it("marks later phases NOT_STARTED", () => {
    expect(derivePhaseStatus(4, 3)).toBe("NOT_STARTED");
  });

  /**
   * ⚠ 0 MEANS THE FACILITATOR HAS NOT STARTED THE WORKSHOP, not "phase zero is current".
   * `workshop.getById` normalises a missing `currentPhaseOrder` to 0 for exactly this case, and
   * phase orders are 1-based, so nothing can compare equal to it.
   */
  it("treats currentPhaseOrder 0 as nothing started", () => {
    expect(derivePhaseStatus(1, 0)).toBe("NOT_STARTED");
    expect(derivePhaseStatus(3, 0)).toBe("NOT_STARTED");
  });

  it("never reports COMPLETED for a workshop that has not begun", () => {
    // The insights page counts COMPLETED to report "x of y phases". A single wrong COMPLETED here
    // is a claim about a team's progress that nobody made.
    for (let order = 1; order <= 5; order++) {
      expect(derivePhaseStatus(order, 0)).not.toBe("COMPLETED");
    }
  });
});

describe("phasesWithStatus, what the stepper and the insights count read", () => {
  it("orders by `order`, whatever order the API returned them in", () => {
    // A stepper is a SEQUENCE; the API's ordering is not part of any contract.
    const out = phasesWithStatus([phase(3), phase(1), phase(2)], 2);
    expect(out.map((p) => p.order)).toEqual([1, 2, 3]);
  });

  it("does not reorder the caller's array", () => {
    const input = [phase(3), phase(1)];
    phasesWithStatus(input, 1);
    expect(input.map((p) => p.order)).toEqual([3, 1]);
  });

  it("yields exactly one IN_PROGRESS phase", () => {
    const out = phasesWithStatus([phase(1), phase(2), phase(3)], 2);
    expect(out.filter((p) => p.status === "IN_PROGRESS")).toHaveLength(1);
    expect(out.find((p) => p.status === "IN_PROGRESS")?.order).toBe(2);
  });

  it("counts completed phases the way the insights page reports them", () => {
    // The regression this closes: this figure was unconditionally 0.
    const out = phasesWithStatus([phase(1), phase(2), phase(3)], 3);
    expect(out.filter((p) => p.status === "COMPLETED")).toHaveLength(2);
    expect(out).toHaveLength(3);
  });

  it("keeps each phase's id and name", () => {
    // The stepper keys on id and labels with name; losing either renders an unlabelled row.
    const [first] = phasesWithStatus([phase(1, "Ideation")], 1);
    expect(first.id).toBe("p1");
    expect(first.name).toBe("Ideation");
  });

  it("survives an empty pipeline", () => {
    expect(phasesWithStatus([], 0)).toEqual([]);
  });
});

/**
 * ── ⚠ THE DESKTOP HOLDS THE SAME RULE, AND THIS IS THE DRIFT CHECK BETWEEN THE TWO ──────────
 *
 * The desktop derives its phase pill from the identical comparison in
 * `src/renderer/components/PhasesView.tsx`. Nothing enforces that agreement, the rule is not in
 * `shared/`, because that directory is a drift-checked mirror and a portal-authored file there would
 * have no upstream to be checked against. So the agreement is exactly the kind this repo already
 * guards by reading a sibling repo's source: **present ⇒ assert, absent ⇒ `it.todo`** (see
 * `lib/sibling-repo-source.ts` for why that is the least bad of three bad options, and for the
 * `AIAP_DESKTOP_REPO` override).
 *
 * The failure to catch is one front-end's operator being changed while the other's stays put, after
 * which the portal and the desktop disagree about whether a team has finished a phase, on the same
 * workshop, from the same `currentPhaseOrder`.
 *
 * ⚠ MATCHED STRUCTURALLY, NOT TEXTUALLY, because the two modules name the variable differently, the
 * desktop's local is `currentOrder`, ours is the parameter `currentPhaseOrder`. Requiring identical
 * text would fail on a correct rename and teach the next reader to delete the test. What must not
 * differ is which operator maps to which state.
 *
 * ⚠ BOTH SIDES ARE READ WITH COMMENTS STRIPPED. Ours mentions these operators in prose; without the
 * stripping this suite could pass on its own documentation. That exact failure has happened twice in
 * this repo (see `lib/source-under-test.ts`).
 */
const DESKTOP_PRESENT = siblingRepoPresent("desktop");

/** `order < X → COMPLETED`, `order === X → IN_PROGRESS`, anything later → NOT_STARTED. */
const COMPLETED_COMPARISON = /order < \w+\s*\n?\s*\? "COMPLETED"/;
const IN_PROGRESS_COMPARISON = /order === \w+\s*\n?\s*\? "IN_PROGRESS"/;

describe("the comparison this module implements", () => {
  const ours = sourceWithoutComments(
    fileURLToPath(new URL("./phase-status.ts", import.meta.url))
  );

  it("maps `order < current` to COMPLETED", () => {
    expect(ours).toMatch(COMPLETED_COMPARISON);
  });

  it("maps `order === current` to IN_PROGRESS", () => {
    expect(ours).toMatch(IN_PROGRESS_COMPARISON);
  });

  it("has NOT_STARTED as the remaining case", () => {
    expect(ours).toContain('"NOT_STARTED"');
  });
});

describe.skipIf(!DESKTOP_PRESENT)("the desktop derives it the same way", () => {
  const theirs = DESKTOP_PRESENT
    ? readSiblingRepoSource(
        "desktop",
        "src",
        "renderer",
        "components",
        "PhasesView.tsx"
      )
    : "";

  it("maps `order < current` to COMPLETED, as this module does", () => {
    expect(theirs).toMatch(COMPLETED_COMPARISON);
  });

  it("maps `order === current` to IN_PROGRESS, as this module does", () => {
    expect(theirs).toMatch(IN_PROGRESS_COMPARISON);
  });

  it("has NOT_STARTED as the remaining case, as this module does", () => {
    expect(theirs).toContain('"NOT_STARTED"');
  });

  /**
   * ⚠ THE ONE THAT WOULD CATCH A SILENT REDESIGN. If the desktop ever moves to a STORED per-team
   * status, this comparison disappears from its source and the three assertions above stop being
   * about anything, but they would still pass if the strings happened to survive elsewhere in the
   * file. Pinning the derivation to `currentPhaseOrder` is what makes "the desktop still derives it"
   * an assertion rather than a coincidence.
   */
  it("still derives from the workshop's currentPhaseOrder rather than a stored field", () => {
    expect(theirs).toContain("currentPhaseOrder");
  });
});

describe.skipIf(DESKTOP_PRESENT)("the desktop derives it the same way", () => {
  it.todo(
    "is checked against PhasesView.tsx when the desktop repo is checked out beside this one (or AIAP_DESKTOP_REPO is set)"
  );
});
