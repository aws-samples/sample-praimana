// ── ⚠ COLLAPSED IS AN ICON RAIL, NOT A HIDDEN PANEL ──────────────────────────────────────
//
// The first version collapsed the sidebar to `w-0 overflow-hidden` from a wrapper in App. That gave the
// screen back and took NAVIGATION with it: reaching Team Chat meant expanding the panel, clicking, and
// collapsing again. VS Code keeps its activity bar for exactly this reason.
//
// A source scan, for the same reason the other renderer guards are: this package has no React Testing
// Library and its vitest environment is `node`, so there is no layout to measure. What can be checked is
// that each property survives — and every one of these was a separate decision that a later edit could
// quietly undo.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠ COMMENTS STRIPPED, as the other renderer guards do — and this file needed it. A
 * `toContain("pointer-events-none")` passed while the class had been REMOVED from the element, because
 * the phrase also appears in the comment explaining why it is there. An assertion satisfied by its own
 * prose is worse than no assertion; mutation testing is what exposed it.
 */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sidebar = strip(readFileSync(join(__dirname, "components", "Sidebar.tsx"), "utf8"));
const app = readFileSync(join(__dirname, "App.tsx"), "utf8");

describe("the rail is a width, owned by the sidebar", () => {
  it("has its own collapsed width rather than being zeroed by a wrapper", () => {
    /**
     * ⚠ THE SHAPE, NOT THE PIXEL VALUE. This pinned `w-12` and broke the first time the rail was widened
     * — a size is a design value that should be free to change, where "the collapsed state has
     * a width of its own, and it is not the expanded one" is the property worth guarding.
     */
    const m = /collapsed \? "(w-[\d.]+)" : "(w-[\d.]+)"/.exec(sidebar);
    expect(m, "the sidebar picks its own width from the collapsed flag").not.toBeNull();
    expect(m![1], "the rail is narrower than the panel").not.toBe(m![2]);
    expect(m![1], "and it is not zero — that is a hidden panel, not a rail").not.toBe("w-0");
  });

  /**
   * ⚠ APP MUST NOT WRAP IT IN A ZERO-WIDTH DIV ANY MORE. That is the old behaviour, and it would hide the
   * rail the sidebar now renders — the two mechanisms cannot both be right.
   */
  it("App passes the flag instead of hiding the panel", () => {
    expect(app).toContain("collapsed={sidebarCollapsed}");
    expect(app, "the old w-0 wrapper is gone").not.toMatch(/sidebarCollapsed \? "w-0/);
  });
});

describe("⚠ an icon-only button must still say what it is", () => {
  /**
   * With the label hidden, the button's accessible name is whatever `aria-label` provides — nothing,
   * without it, because the icon is an image or an emoji glyph. A rail of unnamed buttons is unusable by
   * a screen reader and unguessable by everyone else.
   */
  it("carries the label as aria-label", () => {
    /**
     * ⚠ NOW UNCONDITIONAL, WHICH IS STRICTLY STRONGER. It used to read
     * `aria-label={collapsed ? item.label : undefined}` — correct while the button CONTAINED the text, so
     * when expanded the visible label was its accessible name. The row has since inverted (the nav button
     * is a stretched `absolute inset-0` target so the pin can sit beside the text), which moved the text
     * OUT of the button — an unlabelled stretched button would announce nothing in either state.
     */
    expect(sidebar).toMatch(/aria-label=\{item\.label\}/);
    /**
     * ⚠ SCOPED TO THE NAV ROW'S OWN LABEL. A blanket `not.toMatch(/aria-label={collapsed ?/)` failed on the
     * COLLAPSE TOGGLE, whose label is correctly conditional ("Expand the side panel" / "Collapse the side
     * panel to icons"). Forbidding a pattern the file legitimately uses elsewhere is a test asserting the
     * wrong thing.
     */
    expect(sidebar, "the nav row's label is no longer conditional").not.toMatch(
      /aria-label=\{collapsed \? item\.label/
    );
  });

  /**
   * ⚠ A STYLED TOOLTIP, NOT THE NATIVE ONE. `title` was what this had, and it is the wrong tool on a
   * left-edge rail: about a second of hover before it appears, OS styling that ignores the theme, and no
   * control over placement — so it can render OVER the icon it describes. The replacement is instant, sits
   * to the right where there is room, and is `aria-hidden` because `aria-label` already names the button.
   */
  it("shows a styled tooltip on the rail rather than relying on the OS", () => {
    expect(sidebar, "the tooltip element").toMatch(/\{collapsed && \(\s*<span\s+aria-hidden="true"/);
    // Scoped to the tooltip's OWN className, so neither assertion can be satisfied by an unrelated
    // element that happens to share a utility class.
    const tooltipClass = /aria-hidden="true"\s+className="([^"]*absolute left-full[^"]*)"/.exec(sidebar);
    expect(tooltipClass, "the tooltip carries its own positioning").not.toBeNull();
    expect(tooltipClass![1], "positioned beside the rail").toContain("absolute left-full");
    expect(tooltipClass![1], "and it cannot swallow the click").toContain("pointer-events-none");
    expect(sidebar, "no native tooltip on the nav rows").not.toMatch(/title=\{collapsed \? item\.label/);
  });

  it("hides the text label but keeps rendering it when expanded", () => {
    /**
     * ⚠ CLASS-AGNOSTIC ON PURPOSE. This pinned `className="flex-1"` literally, and that class was REMOVED
     * deliberately: a stretching label pushed the pin to the row's far edge, which is why
     * the pin icon now sits next to the text instead of in the far right corner. The property worth guarding is
     * that the label renders when expanded and not when collapsed — its width is layout.
     */
    expect(sidebar).toMatch(/\{!collapsed && <span className="[^"]*">\{item\.label\}<\/span>\}/);
    expect(sidebar, "and it must not stretch, or the pin is pushed away again").not.toMatch(
      /<span className="[^"]*flex-1[^"]*">\{item\.label\}/
    );
  });
});

describe("⚠ unread survives collapsing — it is why the rail is watched", () => {
  /**
   * `ml-auto` needs a row to push against; in a centred 48px button there is none, so the count would
   * land on top of the icon. Dropping the badge instead would remove the one signal that makes a
   * collapsed rail worth looking at.
   */
  it("positions the badge on the icon when collapsed, and pushes it right when expanded", () => {
    expect(sidebar).toMatch(/collapsed \? "absolute right-0\.5 top-0\.5" : "ml-auto"/);
  });
});

describe("⚠ what the rail drops, and what it must not", () => {
  it("drops the app title, the label, the branch badge and the pin", () => {
    // Each is a thing 48px cannot hold. The pin's STATE is untouched — only its control is expanded-only.
    // The product name is expanded-only; the header ROW it lived in is now shared with the toggle.
    expect(sidebar).toMatch(/\{!collapsed && \(\s*<h1 className="flex-1 truncate text-sm font-bold text-surface-text">/);
    expect(sidebar).toMatch(/\{!collapsed && item\.key === "source-control" && branch/);
    expect(sidebar).toMatch(/\{!collapsed && pinnableViews\.includes\(item\.key\)/);
  });

  /**
   * ⚠ HIDDEN, NEVER UNMOUNTED. The tree loads its own data and remembers which folders are open;
   * unmounting on collapse would discard both and refetch on every toggle.
   */
  it("hides the file tree without unmounting it", () => {
    expect(sidebar).toMatch(/collapsed \? "hidden" : "flex-1"/);
    expect(sidebar, "still rendered unconditionally").toContain("<FileTree");
  });

  it("keeps the account button, as an avatar", () => {
    // The one row that survives: it is how you reach your own details, and the initial fits.
    expect(sidebar).toMatch(/collapsed \? "justify-center px-0" : "gap-2 px-3 text-left"/);
  });
});

describe("⚠ the collapse control is reachable in BOTH states", () => {
  /**
   * It moved out of the titlebar — where it was alone at the left edge, competing with the macOS traffic
   * lights that `titleBarStyle: "hiddenInset"` puts there — into the sidebar's own header row, which already
   * existed.
   *
   * ⚠ AND THAT CREATED A TRAP THIS PINS. The title is dropped on the rail, so an arrow rendered only
   * beside the title would vanish exactly when it is needed: collapsing would hide the only way to
   * expand, leaving Cmd/Ctrl+B as the sole escape and no visible affordance at all.
   */
  it("renders the toggle regardless of collapsed state", () => {
    // One button, outside the `!collapsed` guard that hides the title.
    expect(sidebar).toMatch(/\{onToggleCollapse && \(/);
    expect(sidebar).toMatch(/aria-label=\{collapsed \? "Expand the side panel"/);
    expect(sidebar).toMatch(/\{collapsed \? "▶" : "◀"\}/);
  });

  it("announces which state it is in", () => {
    // `aria-expanded` rather than a label that only says "toggle": a screen reader user needs to know
    // whether the panel is open, not just that a control exists.
    expect(sidebar).toMatch(/aria-expanded=\{!collapsed\}/);
  });

  it("is no longer in the titlebar, which is the drag region", () => {
    const app = readFileSync(join(__dirname, "App.tsx"), "utf8");
    expect(app, "the titlebar is right-aligned again").toContain("justify-end bg-surface-bg pr-3");
    expect(app, "and the sidebar owns the control").toContain("onToggleCollapse={toggleSidebar}");
  });
});
