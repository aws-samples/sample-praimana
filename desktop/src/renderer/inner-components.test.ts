// ── ⚠ NO COMPONENT MAY BE DECLARED INSIDE ANOTHER COMPONENT ──────────────────────────────
//
// THE CAUSE was one declaration. `GitPanel` contained `function GitActions() { ... }` and rendered it as
// `<GitActions />`. A function declared inside a component has a NEW IDENTITY on every render, so React
// cannot match it against the previous tree: it treats each render as a different component type,
// unmounts the old subtree and mounts a fresh one. Every keystroke in the commit field destroyed the
// `<input>` that keystroke went into, and focus went with it.
//
// It is a whole class of bug, not one typo — the same declaration would silently reset scroll position,
// lose in-progress text, restart animations and discard any local state in the subtree. And it looks
// completely idiomatic, which is why it survived review.
//
// ── WHY A SOURCE SCAN AND NOT A RENDER TEST ──
//
// A render test is the stronger shape and is not available here: this package has no React Testing
// Library and its vitest environment is `node`, so there is no DOM to hold focus. Adding jsdom and RTL
// for one assertion is a larger change than the fix. What CAN be checked mechanically is the
// declaration — the same technique `view-theme.test.ts` and `scroll-containment.test.ts` use, and for
// the same reason: the guarantee lives in the source.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(__dirname, "components");
const views = readdirSync(COMPONENTS).filter((f) => f.endsWith(".tsx"));

/** Comments stripped, so the rule can be discussed in prose without tripping itself. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * An INDENTED declaration of a capitalised function — i.e. one nested inside something else.
 *
 * ⚠ CAPITALISATION IS THE TEST BECAUSE IT IS WHAT JSX DISPATCHES ON. `<GitActions />` resolves to a
 * component; `{renderGitActions()}` is a call. So a nested function whose name starts with a capital is
 * either already rendered as a component or one edit away from being, and the lowercase `render` prefix
 * is the convention that keeps it a call.
 *
 * Module-level declarations (column 0) are fine and are how a real shared component is written.
 */
const NESTED_COMPONENT = /^[ \t]+function\s+([A-Z]\w*)\s*\(/gm;

describe("⚠ components are declared at module level, never inside a render", () => {
  it.each(views)("%s declares no nested component", (file) => {
    const found = [...code(readFileSync(join(COMPONENTS, file), "utf8")).matchAll(NESTED_COMPONENT)].map(
      (m) => m[1]
    );

    expect(
      found,
      `${file}: ${found.join(", ")} — declared inside a render, so React remounts the subtree every ` +
        `render and any focus, scroll or local state inside it is destroyed. Hoist it to module level ` +
        `with props, or make it a lowercase render helper called as a function.`
    ).toEqual([]);
  });

  /**
   * The specific regression, named. `GitPanel` is where this was found, and `<GitActions />` is exactly
   * what a future tidy-up would restore — the helper is deliberately lowercase to resist that.
   */
  it("GitPanel calls its action bar rather than rendering it as a component", () => {
    const source = code(readFileSync(join(COMPONENTS, "GitPanel.tsx"), "utf8"));

    expect(source).not.toMatch(/<GitActions\b/);
    expect(source).toMatch(/\{renderGitActions\(\)\}/);
  });
});
