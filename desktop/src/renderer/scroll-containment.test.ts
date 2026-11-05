// ── ⚠ NO VIEW MAY SCROLL THE WINDOW ──────────────────────────────────────────────────────
//
// THE CAUSE was one line, repeated in three chat views:
//
//     messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
//
// `scrollIntoView` scrolls EVERY scrollable ancestor of the element, not the nearest one — so appending
// a message scrolled the transcript, then the chat column, then `#root`, then `body`, pushing the whole
// app off the top of the window. And `overflow: hidden` on those ancestors is no defence: it suppresses
// the scrollbar and USER scrolling while leaving the element scrollable PROGRAMMATICALLY.
//
// ── WHY A SOURCE SCAN RATHER THAN A BEHAVIOURAL TEST ──
//
// The defect is not observable in jsdom: it has no layout, so `scrollHeight` and `clientHeight` are 0
// and every scroll is a no-op. A test that rendered these views and asserted "the window did not move"
// would pass on the broken code, which is worse than no test. What CAN be checked mechanically is that
// the dangerous call is absent — the same technique `view-theme.test.ts` uses for stray light colours,
// and for the same reason: the guarantee lives in the source, so the source is what to assert on.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(__dirname, "components");

/** Every view, not a hand-listed few — a new chat view must inherit this rule automatically. */
const views = readdirSync(COMPONENTS).filter((f) => f.endsWith(".tsx"));

/** Comments are stripped so the prohibition can be DISCUSSED in prose without tripping its own test. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("⚠ scrolling is contained to the element that owns it", () => {
  it.each(views)("%s does not call scrollIntoView", (file) => {
    const source = code(readFileSync(join(COMPONENTS, file), "utf8"));

    /**
     * ⚠ THE WHOLE API IS FORBIDDEN, not just the argument-less form. `block: "nearest"` is often
     * suggested as the fix and it is only a mitigation: it still consults and may still move ancestors.
     * `scrollToLatest` scrolls ONE resolved element, so nothing above it can move by construction —
     * which is a property, where "nearest" is a hope.
     */
    expect(source, `${file} must use scrollToLatest() instead of scrollIntoView()`).not.toMatch(
      /\.scrollIntoView\s*\(/
    );
  });

  /**
   * The positive half: the helper the views must use exists, is scoped to one element, and never touches
   * `window`. A test that only forbids the old call would pass if somebody replaced it with
   * `window.scrollTo`, which is the same defect wearing a different name.
   */
  it("the helper scrolls one resolved element and never the window", () => {
    const helper = code(readFileSync(join(__dirname, "lib", "scroll-to-latest.ts"), "utf8"));

    expect(helper).toMatch(/scroller\.scrollTo\(/);
    expect(helper).not.toMatch(/window\.scroll/);
    expect(helper).not.toMatch(/document\.(body|documentElement)\.scroll/);
    expect(helper).not.toMatch(/\.scrollIntoView\s*\(/);
  });

  /**
   * ⚠ AND THE SHELL STAYS CONSTRAINED. `html, body, #root { overflow: hidden }` is not what fixes the
   * reported bug — the containment above is — but it is what stops a stray overflow from giving the app
   * a second scrollbar, which is how this was first noticed.
   */
  it("the document itself is not a scroll container", () => {
    const css = readFileSync(join(__dirname, "index.css"), "utf8");
    expect(css).toMatch(/html,\s*\n?body,\s*\n?#root\s*\{[^}]*overflow:\s*hidden/);
  });
});
