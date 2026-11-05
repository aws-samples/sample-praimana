// ── COPY THIS MESSAGE ────────────────────────────────────────────────────────────────────
//
// One icon, always visible, with the word only in the tooltip and the accessible name.
//
// ── ⚠ WHY THE LABEL WENT, AND WHY THE HOVER-REVEAL WENT TOO ──
//
// The visible word "Copy" was the reason a one-line message had a footer as tall as its content. It is now
// carried by `title` (for the pointer) and `aria-label` (for everything else), so the control costs the width
// of one glyph.
//
// ⚠ ALWAYS VISIBLE IS AN ACCESSIBILITY IMPROVEMENT HERE, NOT A REGRESSION. The old
// `opacity-0 group-hover:opacity-100` needed `group-focus-within` bolted on precisely because a control that
// is invisible while still in the tab order is a trap — a keyboard user tabs to something they cannot see.
// Removing the reveal removes the trap along with it.
//
// ⚠ AND IT IS STILL NEVER `hidden` OR `display:none` in any state. Those drop it from the accessibility tree,
// so a screen-reader user would have no copy action at all.

import { useState } from "react";
import { IconTooltip } from "./IconTooltip";

/** How long the confirmation shows. Long enough to read, short enough not to linger on the next hover. */
const CONFIRM_MS = 1200;

export function CopyButton({
  text,
  /** A message on a light fill (the user's own terracotta bubble) needs light ink. */
  onLight = false,
  /** Extra positioning from the caller — every layout puts this in a different corner. */
  className = "",
  label = "Copy message",
}: {
  text: string;
  onLight?: boolean;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * ⚠ NOTHING TO COPY MEANS NO BUTTON. An empty message renders one in the DOM otherwise, and a control
   * that silently does nothing is worse than an absent one.
   */
  if (!text.trim()) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), CONFIRM_MS);
    } catch {
      /**
       * `writeText` rejects when the document is not focused or the clipboard is denied, and a button that
       * appears to do nothing sends someone to select the text by hand without knowing why. The state is
       * visible and clears itself.
       */
      setFailed(true);
      setTimeout(() => setFailed(false), CONFIRM_MS);
    }
  }

  const tone = onLight
    ? "text-white hover:bg-black/10"
    : "text-surface-muted hover:bg-surface-raised hover:text-surface-text";

  const tip = copied ? "Copied" : failed ? "Could not copy" : label;

  return (
    <IconTooltip label={tip}>
    <button
      type="button"
      onClick={copy}
      // The live state goes in the accessible name, so a screen reader hears the confirmation too —
      // the ✓ glyph below is decorative and announces nothing.
      aria-label={copied ? "Copied to clipboard" : failed ? "Could not copy" : label}
      title={copied ? "Copied" : failed ? "Could not copy" : label}
      className={[
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent",
        /*
          ⚠ `leading-none` IS WHAT KEEPS THIS OFF ITS OWN LINE. A line-height inherited from the message would
          make the glyph occupy a full text row — the height the visible label used to cost.
        */
        "inline-flex items-center rounded leading-none transition-colors",
        /*
          ── ⚠ AN 11px GLYPH IN A 24×24 TARGET, WHICH IS NOT A CONTRADICTION ──────────────────
          
The last one settles it: the GLYPH is what was meant, not just the target.
          
          ⚠ THE GLYPH AND THE TARGET ARE SEPARATE, which is why the middle steps looked like no change at all.
          `h-6 w-6` is the BUTTON — 24×24, WCAG 2.2 SC 2.5.8's minimum pointer target (AA) — and `text-[16px]`
          is the mark inside it. Setting only the target left the icon looking identical, which is exactly what
          was reported.
          
          ⚠ `-my-1.5` IS WHAT KEEPS THE FOOTER OFF ITS OWN LINE. A 24px box in a row of ~14px text would grow
          the row by 10px on every message — undoing the height fix that started this whole thread. The
          negative margin lets the target overhang its row instead of expanding it, which costs nothing because
          the overhang is transparent.
        */
        "h-6 w-6 justify-center text-[16px]",
        "-my-1.5",
        tone,
        className,
      ].join(" ")}
    >
      {/*
        The glyph alone. The outcome still reaches a screen reader through `aria-label` above, which changes
        to "Copied to clipboard" / "Could not copy" — so the confirmation is not sight-only.
      */}
      <span aria-hidden="true">{copied ? "✓" : failed ? "!" : "⧉"}</span>
    </button>
    </IconTooltip>
  );
}
