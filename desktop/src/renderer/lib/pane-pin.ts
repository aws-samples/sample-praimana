// ── THE PIN, AS SEEN FROM THE PANE IT BELONGS TO ─────────────────────────────────────────
//
// ⚠ THE COMPLAINT IS REACHABILITY, NOT PLACEMENT. The only pin control lived on the sidebar row, and the
// sidebar row disappears when the panel collapses to the icon rail — so the feature that exists to give you
// more screen took away the control for putting two views on screen. The rail has no room for a second
// control per row (that was a deliberate decision, and it stands), so the pin moves to where the view
// itself is: the pane's top-right corner, which is present in both sidebar states.
//
// This module is the STATE, not the markup — three booleans' worth of meaning that the button's wording
// depends on, kept pure so it can be asserted without a DOM.

export interface PanePinState {
  /** Whether this pane's view is the pinned one. Drives the glyph and the pressed state. */
  pinned: boolean;
  /**
   * ⚠ PINNED, BUT NOT YET SHOWING A SECOND PANE — and the reason this type exists.
   *
   * Pinning the view you are LOOKING AT is legitimate and is how the feature is meant to be used: pin Team
   * Chat, then open the AI chat, and Team Chat stays on the right. But at the moment you click, nothing
   * visible happens — `paneLayout` suppresses the pinned pane while it duplicates the active one. A button
   * that appears to do nothing reads as broken, so this state exists purely so the wording can say
   * "it will stay when you switch" instead of leaving you to guess.
   */
  deferred: boolean;
  /** Filled pin when pinned, outline when not — the same pair the sidebar row uses. */
  glyph: string;
  /** Hover text. Says what the click DOES, and in the deferred case what has already happened. */
  title: string;
  /** The accessible name. Never "📌" — a glyph is not a name. */
  srLabel: string;
}

export function panePinState(input: {
  /** The view this pane is rendering. */
  paneView: string;
  /** The view currently open, which may be the same one. */
  activeView: string;
  pinnedView: string | null;
  /** Human name for the view — for the chat pane this is the ASSISTANT's name, not "chat". */
  label: string;
}): PanePinState {
  const { paneView, activeView, pinnedView, label } = input;

  const pinned = pinnedView === paneView;
  const deferred = pinned && activeView === paneView;

  return {
    pinned,
    deferred,
    glyph: pinned ? "📌" : "📍",
    title: deferred
      ? `${label} is pinned — it stays on screen when you open another view. Click to unpin.`
      : pinned
        ? `Unpin ${label}`
        : `Pin ${label} so it stays on screen when you open another view`,
    srLabel: pinned ? `Unpin ${label}` : `Pin ${label}`,
  };
}
