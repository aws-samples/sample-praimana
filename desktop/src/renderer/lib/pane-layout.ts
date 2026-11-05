// ── WHICH PANE GOES WHERE ────────────────────────────────────────────────────────────────
//
// Extracted from App's JSX so the arrangement can be asserted. There are four interacting inputs — the
// active view, the pinned view, whether a file editor is open, and whether a project exists — and the
// rules between them are not obvious from reading the markup.
//
// ⚠ THE CHAT PANE IS THE REASON THIS IS SUBTLE. Its DOM position is FIXED for the life of the app: the
// AI session, the in-flight stream and the retained tool blocks all live in that subtree, and React
// reconciles by position — so re-parenting it to move it right would unmount and destroy all three. It is
// moved with flex `order` instead, which is why "which side is it on" is a computed class rather than a
// different place in the tree.

export interface PaneLayout {
  /** The persistent chat subtree: shown, and which side it takes. */
  chat: { visible: boolean; order: "order-1" | "order-2" };
  /** Whether the pinned view gets its own pane beside the active one. */
  showPinned: boolean;
}

export function paneLayout(input: {
  view: string;
  pinnedView: string | null;
  /** A file editor already splits the window; see `showPinned`. */
  editorOpen: boolean;
}): PaneLayout {
  const { view, pinnedView, editorOpen } = input;

  const chatIsActive = view === "chat";
  const chatIsPinned = pinnedView === "chat" && !chatIsActive;

  return {
    chat: {
      visible: chatIsActive || chatIsPinned,
      // The active view takes the left, the pinned one the right — including when chat is the pinned one.
      order: chatIsPinned ? "order-2" : "order-1",
    },
    /**
     * ⚠ THREE CONDITIONS, EACH FOR ITS OWN REASON:
     *
     *   · `pinnedView !== "chat"` — chat has its own persistent pane above; a second copy here would be
     *     two live sessions rendering the same conversation.
     *   · `pinnedView !== view` — pinning the view you are already on would show it twice, and two boards
     *     would fight over the same drag state.
     *   · `!editorOpen` — the editor is itself a deliberate split, and a third column leaves all three
     *     around 300px, narrower than the commit field, the board columns or the chat composer are usable
     *     at. The pin is REMEMBERED, not cleared, so closing the file brings it straight back.
     */
    showPinned: !!pinnedView && pinnedView !== "chat" && pinnedView !== view && !editorOpen,
  };
}
