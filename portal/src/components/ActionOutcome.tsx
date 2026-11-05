"use client";

/**
 * The RESULT of an access-affecting action, in one shape used by every screen that
 * performs one.
 *
 * ── WHY THERE ARE FOUR STATES AND NOT TWO ──
 * "Worked" and "failed" are the two an operator is usually offered, and the gap between
 * them is where double-submits come from. Removing a member and disabling access are
 * network mutations against services that can time out, and both are the kind of action
 * an operator repeats when they cannot tell what happened. So the states are:
 *
 *   CONFIRMED  the server answered, and the thing it answered is what was asked for.
 *   PARTIAL    the action TOOK EFFECT but a guarantee attached to it did not. Both
 *              mutations report this honestly, `audited: false` means an access change
 *              happened with NO RECORD of who made it, which the services themselves
 *              describe as worth an alarm. Reported as its own state because it must
 *              neither be celebrated as a clean success nor retried as a failure: the
 *              retry would not fix the audit entry and would act a second time.
 *   FAILED     the server refused, and nothing happened. Safe to correct and retry.
 *   UNKNOWN    the request was sent and no answer was seen, the operator closed the
 *              dialog while it was in flight, or the tab was navigated. THE ONE THAT
 *              MATTERS: it is indistinguishable from success at the screen, so it must
 *              say "reload before you try again" rather than let an operator repeat a
 *              destructive action on a guess.
 *
 * ── WHY IT IS RENDERED AWAY FROM THE ROW ──
 * The row is the LEAST durable place to put this. A removal destroys its own row; a
 * disable causes a refetch that replaces every row object; paging swaps the whole list.
 * A notice held in row state disappears at exactly the moment it is needed, which is the
 * reasoning the team page already applies to a failed revoke (see the `notice` prop on
 * Disclosure). So callers hold this in the LIST's state and render it outside the list,
 * and the message names the person, a notice that outlives the row it refers to has to
 * say who it was about.
 */

export type ActionOutcomeKind = "confirmed" | "partial" | "failed" | "unknown";

export interface ActionOutcomeState {
  kind: ActionOutcomeKind;
  /**
   * One or two full sentences: what happened, to whom, and, for anything other than a
   * clean success, what to do next. Never a bare code and never "Something went wrong".
   */
  message: string;
}

/**
 * Fixed treatment per state. Severity is encoded three ways over and above the colour -
 * the word in `label`, the glyph, and the ARIA role, because a red panel read through
 * glare, at an angle, or with a colour-vision deficiency is just a panel.
 *
 * `role="alert"` for the two states that need answering NOW and only those. A confirmed
 * or partial outcome is `role="status"`, which announces politely instead of interrupting
 * whatever the operator is reading.
 */
const OUTCOME: Record<
  ActionOutcomeKind,
  { label: string; glyph: string; className: string; assertive: boolean }
> = {
  confirmed: {
    label: "Done",
    glyph: "✓",
    className: "border-success-border bg-success-bg text-success-text",
    assertive: false,
  },
  partial: {
    label: "Done, with a gap",
    glyph: "!",
    className: "border-warn-border bg-warn-bg text-warn-text",
    assertive: false,
  },
  failed: {
    label: "Not done",
    glyph: "✕",
    className: "border-danger-border bg-danger-bg text-danger-text",
    assertive: true,
  },
  unknown: {
    label: "Outcome unknown",
    glyph: "?",
    className: "border-warn-border bg-warn-bg text-warn-text",
    assertive: true,
  },
};

export function ActionOutcome({
  outcome,
  onDismiss,
  className = "",
}: {
  outcome: ActionOutcomeState | null;
  /**
   * Acknowledgement. Present on every state INCLUDING the failures, because a notice an
   * operator cannot clear is a notice that is still on screen during the next action and
   * will be read as being about that one.
   *
   * Nothing here is auto-dismissed on a timer. A failed or unknown access change is not a
   * toast; it persists until the person who caused it says they have seen it.
   */
  onDismiss: () => void;
  /** Outer spacing only, e.g. "mb-4". */
  className?: string;
}) {
  if (!outcome) return null;

  const { label, glyph, className: tone, assertive } = OUTCOME[outcome.kind];

  return (
    <div
      role={assertive ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tone} ${className}`}
    >
      {/* Decorative: `label` beside it says the same thing in words. */}
      <span aria-hidden="true" className="mt-px font-semibold">
        {glyph}
      </span>
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{label}.</span> {outcome.message}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        // A real label, not "×". "Dismiss" alone would be one of several on a page.
        aria-label={`Dismiss this message: ${label}`}
        className="-my-1 -mr-1 shrink-0 rounded px-1.5 py-1 text-xs font-medium underline decoration-dotted hover:bg-ink/5 focus:outline-none focus:ring-2 focus:ring-current"
      >
        Dismiss
      </button>
    </div>
  );
}
