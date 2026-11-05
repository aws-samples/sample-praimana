// ── KEEPING THE LATEST MESSAGE IN VIEW, WITHOUT MOVING THE PAGE ──────────────────────────
//
// ⚠ THIS REPLACES `anchor.scrollIntoView({ behavior: "smooth" })`, WHICH MOVED THE WHOLE WINDOW.
//
// REPORTED on the DESKTOP, whose chat views carried the identical line: "the scroll is moving and ai chat
// window goes up leaving empty space down", happening "only when i send a text and press enter". The
// portal's chat page had the same call, so it had the same defect, its transcript sits in a
// `h-[calc(100vh-12rem)]` column, and scrolling the document as well pushes the workspace header away.
//
// `scrollIntoView` does not scroll one container. It scrolls **every scrollable ancestor** of the
// element, walking up to the document, so appending a message scrolled the transcript AND the chat
// column AND `#root` AND `body`, pushing the entire app off the top of the window and leaving the
// shell's background below it. It fired on send because that is when a message is appended.
//
// ⚠ AND `overflow: hidden` IS NOT A DEFENCE, which is the part that made this confusing on the desktop:
// hidden suppresses the scrollbar and USER scrolling, while the element keeps its scroll container and
// stays scrollable PROGRAMMATICALLY (only `overflow: clip` does not).
//
// So the scroll is applied to ONE element, chosen explicitly. Nothing above it can move, by
// construction rather than by option.

/**
 * The nearest ancestor that actually scrolls, or null.
 *
 * ⚠ `scrollHeight > clientHeight` IS PART OF THE TEST, not just the overflow style. A styled-but-not-
 * overflowing container is not the scroller a message needs; picking it would silently do nothing while
 * the real scroller, further up, stayed where it was.
 */
function nearestScroller(from: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = from.parentElement;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      el.scrollHeight > el.clientHeight
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Scroll the transcript to its end.
 *
 * Takes the END ANCHOR the views already render (`<div ref={messagesEndRef} />`) rather than the
 * container, so adopting it is a one-line change at each call site and no view has to grow a second ref.
 *
 * A no-op when there is nothing to scroll: an empty or short transcript needs no movement, and forcing
 * one would fight a user who has deliberately scrolled up to read.
 */
export function scrollToLatest(anchor: HTMLElement | null): void {
  if (!anchor) return;
  const scroller = nearestScroller(anchor);
  if (!scroller) return;

  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
}
