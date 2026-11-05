// ── ⚠ TWO PINNED PANES MUST LINE UP ──────────────────────────────────────────────────────
//
// They are ONE cause — pinning puts two panes in a row, so their header bars become a single line across the
// window, and they were four different heights set independently in four files:
//
//   AssistantChatView py-2 (~34px) · TeamChatView py-2.5 (~37px) · BoardView py-3 (~42px) · editor py-1.5 (~29px)
//
// Nothing was "not separated"; the separation was drawn crooked.

import { describe, it, expect } from "vitest";
import { hex, contrast } from "./palette.testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANE_HEADER, PANE_DIVIDER } from "./lib/pane-header";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (...p: string[]) => strip(readFileSync(join(__dirname, ...p), "utf8"));

const app = read("App.tsx");

/** Every pane with a header bar. The editor is included: it was the shortest AND the last light one. */
const PANES = ["AssistantChatView", "KiroChatView", "BoardView", "TeamChatView", "PhasesView"];

describe("⚠ one height, declared once", () => {
  it("fixes the height rather than padding it", () => {
    /**
     * ⚠ A FIXED HEIGHT AND NOT PADDING, which is the whole reason the four drifted apart: `py-2` around a
     * 20px button and `py-2` around a 14px label are two different heights. `h-10` is the same 40px whatever
     * the header contains.
     */
    expect(PANE_HEADER).toMatch(/\bh-10\b/);
    expect(PANE_HEADER).toContain("items-center");
    expect(PANE_HEADER, "the rule is part of the contract").toContain("border-b");
    expect(PANE_HEADER, "and it must be coloured, not inherited").toContain("border-surface-line");
  });

  it.each(PANES)("%s uses the shared header", (pane) => {
    const source = read("components", `${pane}.tsx`);

    /**
     * ⚠ THE USE, NOT THE IMPORT. `toContain("PANE_HEADER")` was satisfied by the import line alone: a
     * mutation that deleted PhasesView's entire header bar and left the import behind passed this suite.
     * The same import-line trap that once let a deleted counter threshold through.
     */
    expect(source, `${pane} must apply PANE_HEADER to a header row`).toMatch(
      /className=\{(?:`[^`]*\$\{PANE_HEADER\}[^`]*`|PANE_HEADER)\}/
    );
    /** The import may bring `PANE_TITLE` along with it — both come from the same module. */
    expect(source).toMatch(/import \{ PANE_HEADER(, PANE_TITLE)? \} from "\.\.\/lib\/pane-header"/);
  });

  /**
   * ⚠ ONE TITLE STYLE TOO, because matching heights was not enough. The names were `text-lg font-bold`
   * (Board, Phases), `text-sm font-medium` (chat) and `text-sm font-semibold` (Team Chat) — so two pinned
   * panes still read as different kinds of thing, which is the other half of "title bar height not good".
   */
  it.each(PANES)("%s names itself in the shared title style", (pane) => {
    const source = read("components", `${pane}.tsx`);

    /** The USE again: an import alone would satisfy a `toContain`. */
    expect(source, `${pane} must apply PANE_TITLE to its name`).toMatch(
      /className=\{(?:PANE_TITLE|[^}]*PANE_TITLE[^}]*)\}/
    );
  });

  /** The editor's header lives in App.tsx rather than its own file. */
  it("the file editor uses it too", () => {
    expect(app).toContain("PANE_HEADER");
  });

  /**
   * ⚠ NO PANE MAY RESTATE ITS OWN HEIGHT. A `py-*` left on a header row adds to the fixed height and puts
   * that pane back out of line — the exact drift being fixed, reintroduced one file at a time.
   */
  it.each(PANES)("%s does not set its own vertical padding on the header row", (pane) => {
    const source = read("components", `${pane}.tsx`);
    const header = source.slice(source.indexOf("PANE_HEADER") - 200, source.indexOf("PANE_HEADER") + 200);

    expect(header, `${pane} restates a height`).not.toMatch(/\bpy-\d/);
    expect(header).not.toMatch(/\bh-\d+\b/);
  });

  /**
   * ⚠ AND THE EDITOR HEADER MUST NOT BE LIGHT. It was `bg-gray-50` with `text-gray-600` and an UNCOLOURED
   * `border-b` — the last light panel in the app, sitting directly beside the dark chat pane.
   */
  it("the file editor's header is themed with the rest of the app", () => {
    /**
     * ⚠ BOUNDED TO THE FUNCTION, not a fixed character count. My first version took 900 characters and ran
     * past the closing brace into the loading state below — which was ALSO still light, so the assertion
     * failed on the header it was meant to be checking. (That leftover is now fixed too; the slice is still
     * bounded, because a window that reaches into unrelated code cannot say what it is testing.)
     */
    const start = app.indexOf("function header(");
    const header = app.slice(start, app.indexOf("\n  }", start));

    expect(header).not.toContain("bg-gray-50");
    expect(header).not.toContain("text-gray-600");
    expect(header).not.toContain("text-gray-400");
    expect(header).toContain("bg-surface-panel");
  });
});

describe("⚠ the divider between two panes is visible", () => {
  /**
   * ⚠ THICKER AND LIGHTER THAN `surface-line`, because this one carries INFORMATION. `surface-line` (#374151)
   * is 1.72:1 against the page — correct for a hairline inside a panel where nothing depends on seeing it, and
   * too faint when it is the only thing saying "these are two separate panes".
   */
  /**
   * ⚠ MEASURED, NOT NAMED. My first fix was `border-surface-raised` with a comment claiming it was lighter
   * than `surface-line` — and the two are the SAME HEX (#374151), so the change was two pixels of the
   * identical colour. A test asserting the class name would have passed. This one computes the ratio from
   * the Tailwind config, so the same mistake cannot be made again under a different token name.
   */
  /**
   * ⚠ NOW CHECKED IN BOTH MODES. The divider was measured once, against the dark palette, because that was
   * the only palette. A light theme can fail this independently — a border that reads clearly on
   * near-black can vanish on near-white — so the floor is asserted per mode rather than once.
   */
  it.each(["dark", "light"] as const)(
    "clears the 3:1 non-text floor on both surfaces a pane can present (%s)",
    (mode) => {
      const token = /border-surface-([a-z]+)/.exec(PANE_DIVIDER)?.[1] ?? "";
      expect(token, "the divider must use a surface token").not.toBe("");

      const divider = hex(`surface-${token}`, mode);

      expect(
        contrast(divider, hex("surface-bg", mode)),
        `on the page background (${mode})`
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(divider, hex("surface-panel", mode)),
        `and on a panel-coloured header (${mode})`
      ).toBeGreaterThanOrEqual(3);

      // Two pixels, because one of a legible colour still reads as a hairline at this scale.
      expect(PANE_DIVIDER).toMatch(/border-l-2/);
      /** ⚠ AND IT MUST NOT BE THE FAINT HAIRLINE TOKEN, which is what it was mistaken for once. */
      expect(divider, "the divider must not be surface-line").not.toBe(hex("surface-line", mode));
    }
  );

  it("is applied to the pinned pane", () => {
    expect(app).toMatch(/order-2[\s\S]{0,140}?\$\{PANE_DIVIDER\}/);
  });

  /**
   * ⚠ AND TO THE CHAT PANE WHEN IT IS THE ONE ON THE RIGHT. Reported twice, latterly as "the left border for
   * tabs missing": the divider lived only on the pinned-view element, and pinning the CHAT does not render
   * there. `paneLayout` moves the persistent chat pane with flex `order` instead — it must never be
   * re-parented, or its CLI process dies — so a pinned chat sat second with no left edge at all.
   */
  it("is applied to the chat pane when it is second", () => {
    expect(app).toMatch(/chatPane\.order === "order-2" \? PANE_DIVIDER/);
  });

  /**
   * ⚠ AND NOT WHEN IT IS FIRST, which is not symmetry for its own sake: a left border on the leftmost pane
   * draws a line down the middle of the window against the sidebar, where there are not two panes to divide.
   */
  it("is conditional, so a chat on the left has no stray edge", () => {
    const chatPane = app.slice(app.indexOf("chatPane.visible ?"), app.indexOf("chatPane.visible ?") + 300);

    expect(chatPane, "the divider must be conditional").toMatch(/\? PANE_DIVIDER : ""/);
  });
});

describe("⚠ the tab row does not disturb the alignment", () => {
  /**
   * ⚠ ONE ROW, SCROLLING. A wrapping tab row changes the height of the strip above the editor, which sits
   * beside the chat pane's header — putting back the misalignment this whole change fixes.
   */
  it("scrolls horizontally instead of wrapping", () => {
    const tabs = read("components", "FileTabs.tsx");

    expect(tabs).toContain("overflow-x-auto");
    expect(tabs, "a fixed row height").toMatch(/\bh-9\b/);
    expect(tabs).not.toContain("flex-wrap");
  });
});
