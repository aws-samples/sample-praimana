// ── KEEPING THE LATEST MESSAGE IN VIEW, WITHOUT MOVING THE APP ───────────────────────────
//
// ⚠ THIS REPLACES `anchor.scrollIntoView({ behavior: "smooth" })`, WHICH MOVED THE WHOLE WINDOW.
//
// `scrollIntoView` does not scroll one container. It scrolls **every scrollable ancestor** of the
// element, walking up to the document, so appending a message scrolled the transcript AND the chat
// column AND `#root` AND `body` — pushing the entire app off the top of the window and leaving the
// shell's background below it. It fired on send because that is when a message is appended.
//
// ⚠ AND `overflow: hidden` IS NOT A DEFENCE, which is the part that made this confusing. Hidden
// suppresses the scrollbar and USER scrolling; the element keeps its scroll container and stays
// scrollable PROGRAMMATICALLY (only `overflow: clip` does not). So constraining `html, body, #root`
// removed the visible scrollbar and the app still rode up — the same bug with less evidence.
//
// So the scroll is applied to ONE element, chosen explicitly. Nothing above it can move, by
// construction rather than by option.

/**
 * The nearest ancestor that actually scrolls, or null.
 *
 * ⚠ `scrollHeight > clientHeight` IS PART OF THE TEST, not just the overflow style. A styled-but-not-
 * overflowing container is not the scroller a message needs; picking it would silently do nothing while
 * the real scroller — further up — stayed where it was.
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

/**
 * ── ⚠ BRING ONE ROW INTO VIEW, IN ITS OWN SCROLLER AND NOWHERE ELSE ─────────────────────────────
 *
 * ⚠ `scrollIntoView` IS WHAT THIS EXISTS TO AVOID, and my first version of the reveal used it with
 * `block: "nearest"`. scroll-containment.test.ts refuses the whole API and says why: "`block: 'nearest'` is
 * often suggested as the fix and it is only a mitigation: it still consults and may still move ancestors."
 * The test caught it, which is the entire reason it is a source scan rather than a jsdom render.
 *
 * ⚠ SO THE MATHS IS DONE AGAINST ONE RESOLVED SCROLLER. `offsetTop` is relative to the nearest positioned
 * ancestor rather than the scroller, so the row's position is derived from the two `getBoundingClientRect`s —
 * which is what makes this correct inside the tree's nested rows rather than only at its top level.
 *
 * ⚠ AND IT DOES NOTHING WHEN THE ROW IS ALREADY VISIBLE. Revealing a file that is on screen should not move
 * the pane at all: a jump with no purpose reads as the app fighting you, and this fires on every tab change.
 */
export function scrollRowIntoView(row: HTMLElement | null): void {
  if (!row) return;
  const scroller = nearestScroller(row);
  if (!scroller) return;

  const rowBox = row.getBoundingClientRect();
  const viewBox = scroller.getBoundingClientRect();

  /** A row's height of slack, so a revealed file is not flush against the edge it came in from. */
  const margin = rowBox.height;

  if (rowBox.top < viewBox.top + margin) {
    scroller.scrollTo({
      top: scroller.scrollTop + (rowBox.top - viewBox.top) - margin,
      behavior: "smooth",
    });
    return;
  }
  if (rowBox.bottom > viewBox.bottom - margin) {
    scroller.scrollTo({
      top: scroller.scrollTop + (rowBox.bottom - viewBox.bottom) + margin,
      behavior: "smooth",
    });
  }
}
