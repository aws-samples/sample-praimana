// ── THE PIN ON THE PANE ──────────────────────────────────────────────────────────────────
//
// The complaint was REACHABILITY: the only pin was on the sidebar row, and collapsing the panel to the icon
// rail took it away — so the feature for gaining screen removed the control for splitting it.
//
// ⚠ THEN THE PLACEMENT ITSELF WAS WRONG. In the top-right corner the pin landed
// past the header's own controls and read as a fourth unlabelled button. It now renders INSIDE the header's
// title group, so the assertions below moved with it: the old ones pinned `absolute right-2 top-2` and a
// `pr-9` reservation in every header, and those were the defect rather than the contract.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { panePinState } from "./lib/pane-pin";

/** Comments stripped — a guard that its own prose can satisfy is not a guard. See sidebar-rail.test.ts. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const app = strip(readFileSync(join(__dirname, "App.tsx"), "utf8"));

describe("pane pin state", () => {
  it("offers to pin a view that is not pinned", () => {
    const s = panePinState({ paneView: "board", activeView: "board", pinnedView: null, label: "Board" });

    expect(s.pinned).toBe(false);
    expect(s.deferred).toBe(false);
    expect(s.srLabel).toBe("Pin Board");
    expect(s.title).toContain("Pin Board");
  });

  it("offers to UNPIN the pane that is the pinned one", () => {
    // Active view is the board; team chat is pinned beside it. This is the pinned pane.
    const s = panePinState({
      paneView: "team-chat",
      activeView: "board",
      pinnedView: "team-chat",
      label: "Team Chat",
    });

    expect(s.pinned).toBe(true);
    expect(s.deferred).toBe(false);
    expect(s.srLabel).toBe("Unpin Team Chat");
    expect(s.title).toBe("Unpin Team Chat");
  });

  /**
   * ⚠ THE STATE THIS TYPE EXISTS FOR. Pinning the view you are LOOKING AT is the intended way to use the
   * feature — pin Team Chat, then open the AI chat, and Team Chat stays on the right. But at the click
   * itself nothing visible happens, because `paneLayout` suppresses a pinned pane that would duplicate the
   * active one. A button that appears to do nothing reads as broken, so the wording has to say so.
   */
  it("says the pin has taken effect when it pins the view already open", () => {
    const s = panePinState({
      paneView: "team-chat",
      activeView: "team-chat",
      pinnedView: "team-chat",
      label: "Team Chat",
    });

    expect(s.pinned).toBe(true);
    expect(s.deferred).toBe(true);
    // It must NOT be the bare "Unpin" wording, which would leave the participant with no explanation for
    // why the screen did not change.
    expect(s.title).not.toBe("Unpin Team Chat");
    expect(s.title).toMatch(/pinned/i);
    expect(s.title, "explains that it applies on the NEXT view switch").toMatch(/another view|switch/i);
  });

  it("distinguishes the two states by glyph", () => {
    const off = panePinState({ paneView: "board", activeView: "board", pinnedView: null, label: "Board" });
    const on = panePinState({ paneView: "board", activeView: "chat", pinnedView: "board", label: "Board" });

    expect(off.glyph).not.toBe(on.glyph);
  });

  /** A glyph is not an accessible name — a screen reader would announce "pushpin" and nothing else. */
  it("never uses the glyph as the accessible name", () => {
    for (const pinnedView of [null, "board"]) {
      const s = panePinState({ paneView: "board", activeView: "chat", pinnedView, label: "Board" });
      expect(s.srLabel).not.toContain(s.glyph);
      expect(s.srLabel).toContain("Board");
    }
  });
});

describe("⚠ every pinnable view has a name, and the pin reaches every pane", () => {
  /**
   * PANE_LABELS must cover PINNABLE_VIEWS minus `chat`. Chat is excluded on purpose: its name is whichever
   * assistant is configured, so App supplies it as state. Without this check, adding a pinnable view would
   * ship a tooltip reading "Pin source-control".
   */
  it("PANE_LABELS covers every pinnable view except chat", () => {
    const pinnable = /const PINNABLE_VIEWS: readonly View\[\] = \[([^\]]*)\]/.exec(app);
    expect(pinnable, "PINNABLE_VIEWS is declared as a literal array").not.toBeNull();
    const views = [...pinnable![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(views.length).toBeGreaterThan(1);

    const labelBlock = /const PANE_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(app);
    expect(labelBlock, "PANE_LABELS is declared as a literal object").not.toBeNull();
    const labelled = [...labelBlock![1].matchAll(/(?:"([^"]+)"|(\w[\w-]*)):/g)].map((m) => m[1] ?? m[2]);

    expect([...labelled].sort()).toEqual(views.filter((v) => v !== "chat").sort());
    // And the chat label really does come from state rather than a constant.
    expect(app).toMatch(/v === "chat" \? assistantName/);
  });

  /**
   * ⚠ EVERY PANE MUST HAND ITS PIN DOWN, and this is the check the old prop-free overlay did not need. The
   * pin is decided by `App` and rendered by the view, so a pane that forgot to provide it would silently
   * lose the ONLY pin a participant with a collapsed sidebar can reach.
   */
  it("wraps all three panes in a provider carrying that pane's pin", () => {
    const providers = [...app.matchAll(/<PanePinProvider pin=\{pinFor\(/g)].length;
    expect(providers, "chat pane, active pane, pinned pane").toBe(3);

    // The pin for each pane is that pane's own view, not a hardcoded one.
    expect(app).toMatch(/<PanePinProvider pin=\{pinFor\("chat"\)\}>/);
    expect(app).toMatch(/<PanePinProvider pin=\{pinFor\(view\)\}>\{renderView\(view\)\}/);
    expect(app).toMatch(/<PanePinProvider pin=\{pinFor\(pinnedView!\)\}>\{renderView\(pinnedView!\)\}/);
  });

  /**
   * ⚠ AND IT IS NO LONGER RENDERED AS A BARE SIBLING. `{pinFor(v)}` beside the view is exactly the overlay
   * that was reported: it put the button in the pane's corner instead of the pane's header. Leaving one
   * behind alongside the provider would show TWO pins on that pane.
   */
  it("never renders a pin outside a provider", () => {
    expect(app, "a bare {pinFor(…)} is the old corner overlay").not.toMatch(/\{pinFor\([^)]*\)\}(?!>)/);
  });
});

describe("⚠ the pin sits beside its pane's title", () => {
  /**
   * Every pinnable view must render the slot, or that pane has no pin at all. `phases` and `team-chat` are
   * included deliberately: their headers never had a `pr-9` reservation, so they are the two most likely to
   * be missed.
   */
  const VIEW_COMPONENTS: Record<string, string> = {
    chat: "AssistantChatView",
    kiro: "KiroChatView",
    board: "BoardView",
    phases: "PhasesView",
    "team-chat": "TeamChatView",
  };

  it.each(Object.entries(VIEW_COMPONENTS))("%s renders the pin slot", (_view, component) => {
    const source = strip(readFileSync(join(__dirname, "components", `${component}.tsx`), "utf8"));

    expect(source, `${component} must render <PanePinSlot />`).toContain("<PanePinSlot />");  // nosemgrep: html-in-template-string
    expect(source, `${component} must import it`).toMatch(/import \{ PanePinSlot \} from/);
  });

  /**
   * ⚠ BESIDE THE TITLE, NOT AMONG THE ACTIONS — which is the actual instruction ("next to the text"). The
   * check is POSITIONAL: the slot must appear before the header's action cluster, because moving it after
   * Share/New/history would recreate the reported layout while still containing the slot.
   */
  it("places the slot with the assistant's name, ahead of the header controls", () => {
    const source = strip(readFileSync(join(__dirname, "components", "AssistantChatView.tsx"), "utf8"));
    const slot = source.indexOf("<PanePinSlot />");
    const label = source.indexOf("assistantLabel(currentCli)");
    /**
     * ⚠ THE ACTIONS CONTAINER IS THE LANDMARK THAT MATTERS, and finding that out took a mutation. The first
     * version compared against `onClick={handleUnshare}`, and moving the slot INTO the actions cluster still
     * passed — because the share button sits further down inside that same cluster, so the slot was still
     * "before" it. That mutation IS the reported layout: the pin grouped with Share, New and history.
     *
     * The header has exactly two groups — the title (`gap-2`) and the actions (`gap-1`) — so the boundary
     * between them is the real assertion: the slot must fall on the title side of it.
     *
     * (Searching from `label` rather than from 0, because `gap-1` also appears in the transcript below.)
     */
    const actions = source.indexOf('className="flex items-center gap-1"', label);

    expect(label).toBeGreaterThan(-1);
    expect(actions, "the header's actions cluster").toBeGreaterThan(-1);
    expect(slot, "the slot follows the assistant's name").toBeGreaterThan(label);
    expect(slot, "and stays in the title group, not with Share/New/history").toBeLessThan(actions);
  });

  /**
   * ⚠ THE RESERVATION MUST BE GONE, not merely unused. `pr-9` existed only to keep an overlay off the
   * controls at a header's right edge; left behind it is 36px of dead space in every pane header, and it
   * would quietly invite someone to restore the overlay it was protecting.
   */
  it.each(["BoardView", "AssistantChatView", "KiroChatView"])(
    "%s no longer reserves a corner for an overlay",
    (view) => {
      const source = strip(readFileSync(join(__dirname, "components", `${view}.tsx`), "utf8"));
      const header = source.slice(0, source.indexOf("justify-between") + 400);
      expect(header, `${view} still reserves the old pin corner`).not.toContain("pr-9");
    }
  );

  /**
   * ⚠ AND THE BUTTON ITSELF MUST NOT BE POSITIONED. In a flex row `absolute` would lift it out of the flow
   * and back over whatever sits at that corner — the same defect, with the slot in place to disguise it.
   */
  it("the pin is laid out in the flow of the header row", () => {
    const pin = strip(readFileSync(join(__dirname, "components", "PanePin.tsx"), "utf8"));

    expect(pin, "no longer an overlay").not.toContain("absolute");
    expect(pin).not.toMatch(/\bright-2\b/);
    expect(pin).not.toMatch(/\btop-2\b/);
    // It must not be squeezed to nothing by a title that is long or a row that is tight.
    expect(pin).toContain("flex-shrink-0");
  });

  /**
   * ⚠ ALWAYS VISIBLE, unlike the sidebar row's pin, which appears on hover. This is the only pin a
   * participant with a collapsed sidebar can reach, and an invisible control is one nobody knows exists.
   * `opacity-0` here would recreate the reported problem in a new place.
   */
  it("is not hidden until hover", () => {
    const pin = strip(readFileSync(join(__dirname, "components", "PanePin.tsx"), "utf8"));
    expect(pin).not.toContain("opacity-0");
    expect(pin).not.toContain("group-hover");
  });

  /** A toggle needs a pressed state, and a keyboard user needs to see focus. */
  it("announces its pressed state and shows a focus ring", () => {
    const pin = strip(readFileSync(join(__dirname, "components", "PanePin.tsx"), "utf8"));
    expect(pin).toContain("aria-pressed");
    expect(pin).toContain("focus-visible:ring");
    expect(pin, "the glyph is decorative; aria-label is the name").toContain('aria-hidden="true"');
  });
});

// ── ⚠ THE LAYOUT WAS BEING SAVED AND NEVER READ ───────────────────────────────────────────
//
// `sidebar_collapsed` and `pinned_view` each had a `setSetting` on toggle and no `getSetting` anywhere, so
// the comments claiming they persisted were wrong: the sidebar re-expanded and the pin vanished at every
// launch. These guards exist because a write with no read is invisible —
// it looks like working code and produces no error.
describe("⚠ persisted layout is read back, not just written", () => {
  it.each(["sidebar_collapsed", "pinned_view"])("%s is both written and read", (key) => {
    expect(app, `${key} is written`).toContain(`setSetting("${key}"`);
    expect(app, `${key} is READ BACK — a write with no read persists nothing`).toContain(
      `getSetting("${key}")`
    );
  });

  /**
   * The restore must NOT live in `checkState`, which re-runs on sign-out, assistant changes and session
   * expiry — re-applying stored layout there would yank a panel the participant had just opened back to
   * whatever was last written.
   */
  it("restores layout on mount only, not inside checkState", () => {
    // `\n {2}\}` = the closing brace at method indentation, i.e. the end of checkState itself.
    const checkState = /async function checkState\(\)[\s\S]*?\n {2}\}\n/.exec(app);
    expect(checkState).not.toBeNull();
    expect(checkState![0]).not.toContain("sidebar_collapsed");
    expect(checkState![0]).not.toContain("pinned_view");
  });

  /**
   * A stored view key outlives the build that wrote it. Restoring one that is no longer pinnable would
   * bring back a pane with no pin control able to remove it.
   */
  it("validates the restored pin against PINNABLE_VIEWS", () => {
    expect(app).toMatch(/PINNABLE_VIEWS\.includes\(pinned as View\)/);
  });
});
