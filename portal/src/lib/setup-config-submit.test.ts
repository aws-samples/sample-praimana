import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Create Experience form's DEVELOPER SETUP submission rules.
 *
 * Developer setup is a single free-text `instructions` field: the natural-language steps the AI coding
 * assistant follows to set up a participant's project on the desktop app. The form sends
 * `{ instructions }` when the box has content and `undefined` when it is blank, so an experience with
 * no setup instructions simply has no `setupConfig`.
 *
 * Asserted as a pure function mirroring the page rather than through the DOM, because the portal suite
 * runs in `node` with no jsdom and the decision, not the markup, is what matters.
 */

/** Mirrors `getSetupConfigObject` in app/experiences/new/page.tsx. */
function getSetupConfigObject(cfg: { instructions: string }) {
  const instructions = cfg.instructions.trim();
  if (!instructions) return undefined;
  return { instructions };
}

describe("getSetupConfigObject, what actually gets submitted", () => {
  it("sends the trimmed instructions when the box has content", () => {
    expect(getSetupConfigObject({ instructions: "  Install deps and verify the build.  " })).toEqual({
      instructions: "Install deps and verify the build.",
    });
  });

  it("sends nothing when the box is blank, the explicit 'no setup' case", () => {
    // The service persists `body.setupConfig || null`, so omitting it is how an experience ends up
    // with no automated setup. A blank or whitespace-only box must omit the whole field.
    expect(getSetupConfigObject({ instructions: "" })).toBeUndefined();
    expect(getSetupConfigObject({ instructions: "   \n  " })).toBeUndefined();
  });

  it("preserves multi-line instructions verbatim (only the edges are trimmed)", () => {
    const multi = "1. Install dependencies.\n2. Verify the build.\n\nOnly safe commands.";
    expect(getSetupConfigObject({ instructions: multi })).toEqual({ instructions: multi });
  });
});

// ── THE SETUP INSTRUCTIONS FIELD STARTS EMPTY ────────────────────────────────────────────────
//
// Developer setup is optional and has NO default text: the create form seeds the instructions
// textarea with an empty string, so an experience ships no automated setup unless an operator
// writes some. A placeholder gives a hint but is not persisted. Pinned so a default is not
// reintroduced, a prefilled default means every experience silently ships that wording.
describe("the setup instructions field", () => {
  const page = readFileSync(
    join(__dirname, "..", "app", "experiences", "new", "page.tsx"),
    "utf8"
  );

  it("seeds the instructions field EMPTY, not with default prose", () => {
    expect(page).toMatch(/instructions:\s*""/);
    expect(page, "no default instruction text").not.toContain("Set up this project");
  });

  it("no longer references the removed repo/branch/assistants-JSON fields", () => {
    // The developer-setup section is one textarea now; the old shape must be gone from the form.
    expect(page).not.toContain("setupGuideUrl");
    expect(page).not.toContain("repoUrl");
    expect(page).not.toContain("dist/kiro");
  });
});
