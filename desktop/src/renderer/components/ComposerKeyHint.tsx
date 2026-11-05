/**
 * ── ⚠ THE COMPOSER'S KEYBOARD CONTRACT, FOR EYES AND FOR SCREEN READERS ───────────────────────
 *
 * `⏎ send · ⇧⏎ newline` already existed in all three composers — `AssistantChatView`,
 * `KiroChatView`, `TeamChatView` — as three near-identical inline spans. It was carried
 * `aria-hidden="true"` in every one, which is a defensible choice for the GLYPHS (a screen reader
 * announcing "return symbol middle dot up-arrowhead return symbol" is worse than silence) and left a
 * real gap: the keyboard contract was available to sighted users only.
 *
 * ⚠ AND THE TEXTAREAS HAD NO ACCESSIBLE NAME AT ALL. No `<label>`, no `aria-label`. So a screen
 * reader announced an unnamed multiline text box whose only description was a placeholder — and
 * placeholders are an unreliable accessible name at the best of times, doubly so here now that this
 * app's placeholder changes with the workshop phase. During a turn it got worse: `aria-disabled` with
 * nothing saying why.
 *
 * So this component carries BOTH renderings of one fact:
 *
 *   the glyph line   `aria-hidden`, unchanged in appearance, hidden while a turn is in flight
 *   an sr-only line  the same contract in words, ALWAYS rendered, referenced by `aria-describedby`
 *
 * ── ⚠ WHY THE SR-ONLY LINE IS ALWAYS RENDERED ──
 *
 * It is the target of the textarea's `aria-describedby`, and a description that disappears mid-turn
 * would leave that attribute pointing at nothing — which some screen readers announce as an empty
 * description and others skip silently, neither of them useful. Keeping the element and changing its
 * WORDING is what lets the busy state be explained rather than merely un-narrated.
 *
 * ── WHY A COMPONENT AND NOT THREE SPANS ──
 *
 * `CharCounter`'s header makes this argument already and names the bugs behind it: the sync badge, the
 * copy button and the "Shared" label were each written once, wired into `AssistantChatView`, and never
 * into `KiroChatView` — three separate reports from that one habit. Adding a second, invisible half to
 * a hint that already exists in triplicate is exactly how the fourth one happens.
 */

export function ComposerKeyHint({
  /**
   * The id the composer's `aria-describedby` points at. Supply `useId()` — two composers can be
   * mounted at once when a chat is pinned beside another pane, and a hardcoded id would make the
   * document invalid and the association ambiguous.
   */
  id,
  /**
   * True while a turn is in flight (`streaming` in the AI composers, `sending` in team chat).
   *
   * ⚠ HIDES THE GLYPHS, NOT THE DESCRIPTION. The composer is `readOnly` at that moment, so offering a
   * keybinding is advice rather than help — the previous inline spans got this right and it is
   * preserved exactly. The sr-only text instead explains that the box is temporarily read-only, which
   * is the part a screen-reader user could not otherwise discover: `aria-disabled` says "unavailable"
   * without saying why or for how long.
   */
  busy = false,
  /**
   * Which muted ink to use.
   *
   * `AssistantChatView` alone varies this by surface (`usesDarkSurface`), which is why it is a prop
   * rather than a constant — the three spans were near-identical, not identical, and flattening that
   * difference would have changed one view's appearance while claiming to be a refactor.
   */
  tone = "faint",
  /** What the assistant is called, for the busy sentence. Omitted in team chat, which has no agent. */
  busySubject,
}: {
  id: string;
  busy?: boolean;
  tone?: "faint" | "muted";
  busySubject?: string;
}) {
  const description = busy
    ? `This box is read-only until ${busySubject ?? "the current message"} finishes. You can type again then.`
    : "Press Enter to send. Press Shift plus Enter for a new line.";

  return (
    <>
      {/*
        ⚠ THE VISIBLE HALF IS UNCHANGED — same glyphs, same 10px, same `hidden sm:inline`, same
        `aria-hidden`. A composer this small cannot afford the words on a narrow pane, and the sr-only
        half below is what makes hiding them at that width acceptable rather than a second gap.
      */}
      {!busy && (
        <span
          aria-hidden="true"
          className={`hidden text-[10px] sm:inline ${
            tone === "muted" ? "text-surface-muted" : "text-surface-faint"
          }`}
        >
          ⏎ send · ⇧⏎ newline
        </span>
      )}
      {/*
        Not `aria-live`: this is a DESCRIPTION, read when focus reaches the box or on request, not an
        announcement. A live region here would interrupt the reply being read out to say the composer
        is busy, which the user just caused and already knows.
      */}
      <span id={id} className="sr-only">
        {description}
      </span>
    </>
  );
}
