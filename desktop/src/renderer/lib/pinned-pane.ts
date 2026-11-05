// ── PINNED SHARED-CHAT PANE WIDTH ────────────────────────────────────────────────────────────
//
// The pinned shared-chat pane (a teammate's conversation docked beside the live AI chat) is
// drag-resizable: dragging the divider between the two panes trades width between them. The live
// chat is a `flex-1` column, so it absorbs whatever the pinned pane gives up and vice versa.
//
// These bounds are shared by BOTH chat views (KiroChatView and AssistantChatView) so the two resize
// identically, and are pure so they can be asserted without a DOM.

/** Default pinned-pane width in px — matches the fixed `w-96` the pane started as. */
export const PIN_DEFAULT_W = 384;

/** The narrowest the pinned pane may be dragged, in px. Below this the transcript stops being legible. */
export const PIN_MIN_W = 280;

/**
 * The widest the pinned pane may be dragged, as a fraction of the current window width. Capped at 42%
 * so the pane can never crowd out the live chat on the left — the whole point of pinning rather than
 * taking over is that you keep working in your own chat.
 */
export function pinnedPaneMaxWidth(windowWidth: number): number {
  return Math.round(windowWidth * 0.42);
}

/**
 * Clamp a candidate pinned-pane width to its legal range for the current window.
 *
 * ⚠ THE MIN WINS OVER THE MAX on a very narrow window. On a window so small that 42% is below
 * `PIN_MIN_W`, `pinnedPaneMaxWidth` would otherwise return a max under the min and the clamp would
 * pin the width to that too-small max. `Math.max(PIN_MIN_W, max)` keeps the pane legible instead,
 * accepting that on a tiny window the two panes may both want more room than exists — which the live
 * chat's own `min-w-0` + scroll handles — rather than letting the pane collapse.
 */
export function clampPinnedWidth(candidate: number, windowWidth: number): number {
  const max = Math.max(PIN_MIN_W, pinnedPaneMaxWidth(windowWidth));
  return Math.min(max, Math.max(PIN_MIN_W, Math.round(candidate)));
}
