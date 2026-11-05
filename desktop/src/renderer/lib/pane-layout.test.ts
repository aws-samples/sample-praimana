// ── WHICH PANE GOES WHERE ────────────────────────────────────────────────────────────────
//
// The arrangement has four interacting inputs and one hard constraint that is invisible in the markup: the
// chat subtree's DOM POSITION MUST NEVER CHANGE. The AI session, the in-flight stream and the retained
// tool blocks live in it, and React reconciles by position — re-parenting it to move it right would
// unmount and destroy all three. So "which side is chat on" is a flex `order`, and these assertions are
// what stop someone "simplifying" that into a second render site.

import { describe, it, expect } from "vitest";
import { paneLayout } from "./pane-layout";

const layout = (over: Partial<Parameters<typeof paneLayout>[0]> = {}) =>
  paneLayout({ view: "chat", pinnedView: null, editorOpen: false, ...over });

describe("one pane, when nothing is pinned", () => {
  it("shows chat on the left when chat is the active view", () => {
    expect(layout()).toEqual({ chat: { visible: true, order: "order-1" }, showPinned: false });
  });

  it("hides the chat pane when another view is active", () => {
    // Hidden, never unmounted — that is the point of the persistent pane.
    expect(layout({ view: "board" }).chat.visible).toBe(false);
    expect(layout({ view: "board" }).showPinned).toBe(false);
  });
});

describe("⚠ two panes, with the pinned view on the right", () => {
  it("keeps chat left and puts the pinned view right", () => {
    const l = layout({ view: "chat", pinnedView: "team-chat" });
    expect(l.chat).toEqual({ visible: true, order: "order-1" });
    expect(l.showPinned).toBe(true);
  });

  /**
   * ⚠ THE CASE THE `order` CLASS EXISTS FOR. With another view active and CHAT pinned, chat must appear on
   * the RIGHT — but its DOM position is the first child and cannot move. `order-2` does it visually; a
   * second render site would unmount the session.
   */
  it("moves chat right with order-2 when chat is the pinned one", () => {
    const l = layout({ view: "team-chat", pinnedView: "chat" });
    expect(l.chat).toEqual({ visible: true, order: "order-2" });
    // No separate pinned pane: chat IS the pinned pane.
    expect(l.showPinned).toBe(false);
  });

  it("shows both panes for two non-chat views", () => {
    const l = layout({ view: "board", pinnedView: "phases" });
    expect(l.chat.visible).toBe(false);
    expect(l.showPinned).toBe(true);
  });
});

describe("⚠ a view is never rendered twice", () => {
  /**
   * Pinning the view you are already on would put two live copies side by side — two boards fighting over
   * the same drag state, or two team chats both polling the same endpoint.
   */
  it.each(["chat", "team-chat", "board", "phases"])(
    "does not open a second pane when %s is both active and pinned",
    (v) => {
      const l = layout({ view: v, pinnedView: v });
      expect(l.showPinned).toBe(false);
      // And chat stays on the LEFT in that case — it is the active view, not a pinned one.
      if (v === "chat") expect(l.chat.order).toBe("order-1");
    }
  );
});

describe("⚠ the editor's split wins, and the pin is remembered", () => {
  /**
   * A third column leaves all three around 300px on a typical window — narrower than the commit field,
   * the board columns and the chat composer are usable at. The editor is itself a deliberate split, so it
   * takes precedence.
   */
  it("suppresses the pinned pane while a file is open", () => {
    expect(layout({ view: "board", pinnedView: "phases", editorOpen: true }).showPinned).toBe(false);
  });

  it("brings it back when the file closes", () => {
    // ⚠ THE STATE IS UNCHANGED — `pinnedView` is still set, so this is suppression, not clearing. Losing
    // the pin on every file open would make pinning useless to anyone who edits code.
    const open = layout({ view: "board", pinnedView: "phases", editorOpen: true });
    const closed = layout({ view: "board", pinnedView: "phases", editorOpen: false });
    expect(open.showPinned).toBe(false);
    expect(closed.showPinned).toBe(true);
  });

  it("still shows chat beside the editor, as it always did", () => {
    // The editor + chat split predates pinning and must not regress: chat stays visible.
    expect(layout({ view: "chat", editorOpen: true }).chat.visible).toBe(true);
  });
});
