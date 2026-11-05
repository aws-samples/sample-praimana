/**
 * The send control's arrow, shared by every assistant's composer.
 *
 * ── WHY IT IS ITS OWN FILE ──
 *
 * It lived in `AssistantChatView.tsx`, which serves Claude and Codex. Kiro's composer is a separate component, so making
 * the two match meant either exporting this or copying it — and a copied 8-line SVG is how two send buttons end
 * up subtly different strokes apart, which is precisely the inconsistency the request is about.
 *
 * Line art rather than a text glyph (↑, ➤) so it aligns on the button's optical centre at any font size and
 * inherits the button's colour through `currentColor`. `aria-hidden` because the button carries the name.
 */
export function SendIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}
