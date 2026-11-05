import { describe, it, expect } from "vitest";
import { join } from "path";
import { sourceWithoutComments } from "@/lib/source-under-test";

/**
 * ── ⚠ THE PROFILE PAGE'S TWO COLLAPSE/HELP RULES ───────────────────────────────────────────
 *
 * Two requirements: collapse Change password, and make "report a bug" and "give feedback" findable on the
 * profile page. The second is the interesting one: the links existed only in the avatar dropdown
 * AND render nothing without a configured address, so they were hidden twice over.
 *
 * Source assertions, same convention and same comment-stripping as the rest of this file.
 */
describe("the profile page", () => {
  const src = sourceWithoutComments(
    join(__dirname, "page.tsx")
  );

  it("collapses Change password with the COLLAPSED-BY-DEFAULT idiom", () => {
    /**
     * `AdvancedDisclosure`, not `Disclosure`. Both exist and their headers document the split:
     * `Disclosure` is for PRIMARY content and opens by default, which is the opposite of what a rarely
     * used password form wants.
     */
    expect(src).toContain("AdvancedDisclosure");
    expect(src).not.toContain('from "@/components/Disclosure"');
  });

  it("⚠ FORCES the panel open on an error or a success", () => {
    // A failure message inside a collapsed panel is a failure nobody can see, and the same is true of
    // the confirmation. This is the behaviour that made a controlled component necessary rather than
    // <details>/<summary>, whose open state cannot be driven.
    expect(src).toMatch(/open=\{open \|\| !!error \|\| !!done\}/);
  });

  it("offers the bug/feedback entry points on the PAGE, not only in the dropdown", () => {
    // The desktop puts the same two in its Account panel; a dropdown-only portal is the kind of
    // inconsistency that makes help feel absent.
    expect(src).toContain("REPORT_BUG_LABEL");
    expect(src).toContain("GIVE_FEEDBACK_LABEL");
  });

  it("⚠ ALWAYS renders them, no support address is needed any more", () => {
    /**
     * ⚠ THIS IS THE INVERSE OF THE TEST IT REPLACED, and the inversion is deliberate. It used to
     * assert `if (links.length === 0) return null` plus a `NEXT_PUBLIC_SUPPORT_EMAIL` read: with the mailto
     * version, an unconfigured deployment had to render NOTHING, because a `mailto:` with no recipient opens
     * a blank draft and reads as broken.
     *
     * That conditional is exactly what made the feature invisible: readers could not find where to report a
     * bug or give feedback. A stored report has no address to configure, so the entry points are
     * unconditional, and the env var must be GONE, not merely unused, or the next reader will wire it back
     * to something.
     */
    expect(src).not.toContain("NEXT_PUBLIC_SUPPORT_EMAIL");
    expect(src).not.toContain("return null");
    // And they open the in-app form rather than navigating anywhere.
    expect(src).toContain("<FeedbackDialog");
  });
});
