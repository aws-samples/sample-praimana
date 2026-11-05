// ── ⚠ A TOOLTIP THAT ACTUALLY APPEARS ────────────────────────────────────────────────────
//
// The controls carried `title`, which is the browser's native tooltip, and it was not reaching people. Two
// reasons, and both are structural rather than bad luck:
//
//   ⚠ 1. THE TARGET IS TINY. An 11px glyph with `px-0.5` is roughly a 7×11px box, and Chromium only shows a
//        `title` after the pointer RESTS on the element for about a second. On a target that small the pointer
//        crosses it rather than settling, so the tooltip never fires. Making the icon bigger helps and does not
//        fix it.
//
//   ⚠ 2. IT WOULD BE CLIPPED ANYWAY. The transcript is `overflow-y-auto`, and an absolutely positioned child is
//        clipped by any scrolling ancestor. Anything drawn inside the message would be cut off at the pane edge
//        or, worse, extend the scroll area.
//
// So this renders `position: fixed` through a PORTAL to `document.body`, which no ancestor can clip, and shows
// on hover AND focus — the second being the part a native `title` never did for keyboard users at all.
//
// ⚠ THE BUBBLE IS `aria-hidden`. The wrapped control already carries its own `aria-label`; announcing the
// tooltip too would read the same sentence twice to a screen reader. This is a VISUAL affordance for people who
// can see the icon and cannot guess what it means — the accessible name was never the missing piece.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Gap between the control and the bubble, in px. Enough to read as attached without overlapping the glyph. */
const OFFSET = 6;

export function IconTooltip({
  label,
  children,
}: {
  /** The words. Short — this is a label, not documentation. */
  label: string;
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);

  /**
   * Measure at the moment of showing, never cached.
   *
   * ⚠ THE TRANSCRIPT SCROLLS AND STREAMS. A position captured on mount would be wrong by the time anyone
   * hovered — the message moves as tokens arrive and as the pane auto-scrolls.
   */
  const show = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({ left: r.left + r.width / 2, top: r.bottom + OFFSET });
  }, []);

  const hide = useCallback(() => setAt(null), []);

  /**
   * ⚠ ESCAPE DISMISSES IT, and hiding on scroll is not optional either: the bubble is `fixed`, so it would hang
   * in place over unrelated content while the message it belongs to scrolled away.
   */
  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [at, hide]);

  return (
    <span
      ref={hostRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      /* Focus and blur CAPTURE, so focusing the button INSIDE this wrapper counts — `onFocus` on a span does
         not fire for a descendant otherwise, and keyboard users are the ones a native title never served. */
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {at &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            /* `aria-hidden`: the control's own `aria-label` already says this. See the header note. */
            aria-hidden="true"
            style={{ left: at.left, top: at.top }}
            /*
              ⚠ `whitespace-nowrap` IS GONE, REPLACED BY A CAP. Reported of a 79-character sync label: "with
              very long tool tip". Nowrap made the bubble as wide as its sentence — about 420px hanging off a
              24px icon — and the fix is not only shorter labels, it is a bubble that cannot do that whatever
              it is handed. A `fixed` element with no width still shrinks to its content, so short labels stay
              on one line exactly as before; only a long one wraps.
            */
            className="pointer-events-none fixed z-[100] max-w-[220px] -translate-x-1/2 rounded border border-surface-line bg-surface-panel px-1.5 py-0.5 text-[11px] leading-tight text-surface-text shadow-lg"
          >
            {label}
          </span>,
          document.body
        )}
    </span>
  );
}
