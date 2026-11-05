// ── HOW MUCH ROOM IS LEFT ─────────────────────────────────────────────────────────────────
//
// ⚠ ONE COMPONENT, THREE COMPOSERS — and that is a deliberate response to tonight's bugs rather than
// tidiness. The sync badge, the copy button and the "Shared" label were each written once, wired into
// `AssistantChatView`, and never into `KiroChatView`; three separate reports came from that one habit. A
// counter pasted into three action rows would be the fourth instance of it.
//
// The limits themselves live in `@praimana/shared` so the desktop and the portal cannot
// disagree about them. This component only renders one.

import { SHOW_REMAINING_WITHIN } from "@praimana/shared";

export function CharCounter({
  value,
  max,
  /** Hidden while a turn is in flight, where the composer is read-only and the number cannot change. */
  hidden = false,
}: {
  value: string;
  max: number;
  hidden?: boolean;
}) {
  const remaining = max - value.length;

  /**
   * ⚠ SILENT UNTIL IT MATTERS. A permanent counter on every message box tells the 99% of messages
   * that are one line long that they are being measured. It appears only once the limit is close
   * enough to act on, which is the only moment the number is information rather than noise.
   */
  if (hidden || remaining > SHOW_REMAINING_WITHIN) return null;

  const atLimit = remaining <= 0;

  return (
    <span
      /**
       * ⚠ A LIVE REGION, because this is the one hint that changes as you type. Without it a screen
       * reader user reaches the cap with no warning and no explanation for why the send button stopped
       * working. `polite` so it waits for a pause rather than interrupting every keystroke.
       */
      role="status"
      aria-live="polite"
      className={`text-[10px] tabular-nums ${atLimit ? "text-tool-error-text" : "text-surface-faint"}`}
    >
      {/*
        The NUMBER, not a percentage or a bar: "180 left" is directly actionable, and at the limit the
        message says what to do rather than restating the count as "0 left".
      */}
      {atLimit ? "Message is too long" : `${remaining} left`}
    </span>
  );
}
