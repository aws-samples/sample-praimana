// Auto-grow a chat textarea to fit its content, up to a max height. Only shows
// a scrollbar once the content exceeds the cap — otherwise overflow is hidden,
// so a single-line input never shows a stray scrollbar.
export const TEXTAREA_MAX_HEIGHT = 200;

export function autoGrow(el: HTMLTextAreaElement, maxHeight = TEXTAREA_MAX_HEIGHT): void {
  el.style.height = "auto";
  const next = Math.min(el.scrollHeight, maxHeight);
  el.style.height = next + "px";
  el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}
