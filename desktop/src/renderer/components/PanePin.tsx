// ── THE PIN BUTTON THAT SITS ON THE PANE ─────────────────────────────────────────────────
//
// One control, decided by App and rendered BESIDE ITS PANE'S TITLE through `PanePinSlot`. Its wording and
// pressed state come from `lib/pane-pin.ts`; this file is only the button.
//
// ⚠ IT IS NO LONGER ABSOLUTELY POSITIONED, and that is the fix rather than a tidy-up. As
// `absolute right-2 top-2` it landed past the header's own controls — the screenshot in the report shows it
// sitting after Share, New and history like a fourth unlabelled button — and, being an overlay, it also had
// to be kept off them with a `pr-9` reservation in every pinnable header. In the flow of the title row it
// needs neither: the row spaces it, and there is nothing to overlap.
//
// ⚠ ALWAYS VISIBLE, unlike the sidebar row's pin, which is revealed on hover. This is still the ONLY pin a
// participant with a collapsed sidebar can reach, and a control you cannot see is a control you do not know
// exists. It is dimmed rather than hidden, so it stays discoverable without competing with the view.

import { panePinState } from "../lib/pane-pin";

export function PanePin({
  paneView,
  activeView,
  pinnedView,
  label,
  onToggle,
}: {
  paneView: string;
  activeView: string;
  pinnedView: string | null;
  label: string;
  onToggle: () => void;
}) {
  const state = panePinState({ paneView, activeView, pinnedView, label });

  return (
    <button
      type="button"
      onClick={onToggle}
      /*
        `aria-pressed` rather than two different labels for the same button: this is a toggle with a state,
        and a screen reader announces "pressed" for it. The label still changes, because "Unpin Board" is
        more useful than "Board, pressed".
      */
      aria-pressed={state.pinned}
      aria-label={state.srLabel}
      title={state.title}
      className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[11px] leading-none shadow-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent ${
        state.pinned
          ? "border-brand-accent bg-surface-panel text-brand-accent"
          : "border-surface-line bg-surface-panel text-surface-muted hover:text-surface-text"
      }`}
    >
      {/*
        The glyph is decorative — `aria-label` above is the name. Announcing both would read the pushpin
        emoji's own description ("pushpin") after the label, which is noise.
      */}
      <span aria-hidden="true">{state.glyph}</span>
    </button>
  );
}
