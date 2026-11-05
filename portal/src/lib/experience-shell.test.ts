import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { sourceWithoutComments } from "./source-under-test";

/**
 * ── EVERY PAGE UNDER ONE EXPERIENCE GETS THE SAME SHELL ────────────────────────────────────
 *
 * REPORTED: "results tab and submissions is missing the common header we used have".
 *
 * They were. `AppHeader` and `SiteFooter` were imported by `experiences/[id]/page.tsx` and
 * `settings/page.tsx` individually, so the four pages added later, submissions, one submission,
 * results, activity, came up with no product header, no way home and no profile menu. Nothing threw;
 * the pages just started halfway down.
 *
 * ── ⚠ WHY THIS TEST IS A DIRECTORY SCAN AND NOT FOUR ASSERTIONS ──
 *
 * The bug is not "these four pages are wrong". It is "the shell is per-page, so the NEXT page will be
 * wrong too", and asserting the four known pages would pass while the fifth repeats the fault. So this
 * enumerates the directory: whatever pages exist, none of them may carry the shell itself, and the
 * layout must. That makes the guard survive files nobody has written yet.
 *
 * The team workspace has had this right since it was built (`w/…/[teamId]/layout.tsx` says so in its
 * header). The experiences area simply never got its layout.
 */

const EXPERIENCE_DIR = join(__dirname, "..", "app", "experiences", "[id]");

/** Every `page.tsx` at or below `experiences/[id]`, relative to that directory. */
function pagesUnder(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {  // nosemgrep: detect-non-literal-fs-filename
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...pagesUnder(join(dir, entry.name), rel));  // nosemgrep: path-join-resolve-traversal
    else if (entry.name === "page.tsx") found.push(rel);
  }
  return found;
}

describe("the experience area's page shell", () => {
  const pages = pagesUnder(EXPERIENCE_DIR);

  it("finds the pages it is supposed to be guarding", () => {
    // A scan that silently matched nothing would pass every assertion below. This is the canary.
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(pages).toContain("page.tsx");
    expect(pages).toContain("results/page.tsx");
    expect(pages).toContain("submissions/page.tsx");
  });

  it("⚠ has a layout that provides BOTH the header and the footer", () => {
    const layout = join(EXPERIENCE_DIR, "layout.tsx");
    expect(existsSync(layout), "experiences/[id]/layout.tsx must exist").toBe(true);

    const src = sourceWithoutComments(layout);
    expect(src).toContain("<AppHeader />");
    expect(src).toContain("<SiteFooter />");
    // The footer must be able to sit at the bottom of a short page rather than under the content.
    expect(src).toContain("min-h-screen");
  });

  it("⚠ NO page renders the shell itself, that is what would double the header", () => {
    /**
     * The other half of the fix, and the one that breaks silently in the opposite direction: once the
     * layout supplies the header, a page that also imports it renders TWO. Both existing pages did
     * import it, so this is a real regression risk rather than a hypothetical.
     */
    for (const page of pages) {
      const src = sourceWithoutComments(join(EXPERIENCE_DIR, page));
      expect(src, `${page} must not render <AppHeader>, the layout does`).not.toContain("<AppHeader");  // nosemgrep: html-in-template-string
      expect(src, `${page} must not render <SiteFooter>, the layout does`).not.toContain(  // nosemgrep: html-in-template-string
        "<SiteFooter"
      );
    }
  });

  it("⚠ no page pins a full viewport height inside the layout", () => {
    /**
     * `min-h-screen` on a page's own wrapper was correct when the page WAS the shell. Inside a layout
     * that already sets it, it pushes the footer a whole screen below the content, so the loading
     * states of the two original pages had to change with the move. This catches the next one to be
     * copy-pasted from a page outside this area.
     */
    for (const page of pages) {
      const src = sourceWithoutComments(join(EXPERIENCE_DIR, page));
      expect(src, `${page} must not set min-h-screen; the layout owns page height`).not.toContain(
        "min-h-screen"
      );
    }
  });
});

/**
 * The precedent this fix follows, asserted so the two areas cannot silently diverge back.
 */
describe("the team workspace already did this, and still does", () => {
  it("keeps its own layout-level header", () => {
    const layout = join(
      __dirname,
      "..",
      "app",
      "w",
      "[workshopId]",
      "t",
      "[teamId]",
      "layout.tsx"
    );
    // Read raw: this only checks the import is present, and the file's header comment quotes the very
    // reasoning being relied on, so stripping is unnecessary here.
    expect(readFileSync(layout, "utf8")).toContain("AppHeader");
  });
});

/**
 * ── ⚠ THE CREATE FORM CANNOT EDIT THE PHASE PIPELINE ───────────────────────────────────────
 *
 * THE RULE: the phases of a new experience are neither editable nor removable.
 *
 * Two reasons it had to go, and the second is the one that decides it:
 *
 *   1. Phases are IMMUTABLE once created, the service refuses every later change with
 *      `PHASES_IMMUTABLE`, because phase ids key every team's notes and appear in released submission
 *      snapshots. So the editor offered a permanent, uncorrectable choice.
 *   2. ⚠ THE PLATFORM FINDS TWO FEATURES BY PHASE NAME. Renaming Build removed the documents panel;
 *      renaming Demo removed its two URL fields. The editor was offering to break the product, silently.
 *
 * Source assertions because this package's vitest is `environment: "node"` with no jsdom, the same
 * convention as the rest of this file.
 */
describe("the create form's phase pipeline is read-only", () => {
  const CREATE_PAGE = join(__dirname, "..", "app", "experiences", "new", "page.tsx");
  const src = sourceWithoutComments(CREATE_PAGE);

  it("⚠ does not import the deleted editor, and no editor remains to import", () => {
    expect(src).not.toContain("PhasePipelineEditor");
    // Deleted rather than left unused: a wired-but-unreferenced control is an invitation.
    expect(existsSync(join(__dirname, "..", "components", "form", "PhasePipelineEditor.tsx"))).toBe(
      false
    );
  });

  it("takes the pipeline from the SHARED constant, with no local state or setter", () => {
    // `useState` here was the whole mechanism: it is what an add/remove/rename control wrote to.
    expect(src).toContain("FIXED_PHASE_PIPELINE");
    expect(src).not.toContain("setPhasesList");
  });

  it("⚠ still SENDS the phases on create, read-only must not mean absent", () => {
    // The easiest way to over-correct: make the form read-only and stop submitting them, leaving every
    // new experience with no pipeline at all.
    expect(src).toContain("setPhases.mutateAsync({ workshopId: workshop.id, phases })");
  });

  it("no longer promises phases can be renamed or reordered later", () => {
    // That sentence became untrue the moment the service began refusing changes, and it is the kind of
    // untruth a facilitator only discovers when they try.
    expect(src).not.toContain("renamed or reordered later");
  });
});
