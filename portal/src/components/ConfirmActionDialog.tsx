"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { AUDIT_REASON_MAX } from "@praimana/shared";

/**
 * THE confirmation step for an access-affecting action, removing someone from a team,
 * disabling or restoring their platform access.
 *
 * ── WHY THIS EXISTS RATHER THAN window.confirm() ──
 * The invitation Revoke button on the team page uses `confirm()`, and for that action it
 * is defensible: one sentence, no input, and the row it acts on is an un-redeemed
 * invitation. Three properties of `confirm()` make it the wrong instrument for the two
 * actions this component serves, and each of them is a failure an operator would have to
 * diagnose rather than see:
 *
 *   1. IT CANNOT COLLECT THE REASON. Both mutations accept an optional `reason` that
 *      lands in a permanent audit trail (AUDIT_REASON_MAX), and for a team removal the
 *      audit entry is the ONLY trace the person was ever on the team, the membership row
 *      is hard-deleted. `prompt()` is not an alternative: it cannot present the
 *      consequences alongside the field, and it cannot distinguish "left it blank" from
 *      "changed my mind".
 *   2. IT IS SUPPRESSIBLE. Once a browser offers "prevent this page from creating more
 *      dialogs" and the operator accepts, `confirm()` returns false without displaying
 *      anything, so the button silently does nothing, forever, on the one control whose
 *      job is to be believed. A dead destructive control that looks alive is the exact
 *      class of defect that produced this work.
 *   3. IT CANNOT STRUCTURE THE CONSEQUENCE. Disabling access has three distinct
 *      consequences (no sign-in, pending invitations destroyed, team memberships
 *      untouched) and one of them is irreversible while the action as a whole is not.
 *      Flattened into one alert string, the irreversible clause reads as small print.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ──
 * NOT a typed-name confirmation. Removing one person from one team is significant, not
 * catastrophic: the team's work is untouched and re-admission costs an invitation or the
 * join code. Typed confirmation on a roster clean-up would be friction an operator learns
 * to rush, which makes the NEXT catastrophic confirmation weaker.
 *
 * NOT a <form>. In a form, Enter pressed anywhere outside a textarea activates the
 * default submit button, which here is the destructive one. A destructive action must
 * not be reachable by Enter from a routine input, so the buttons are plain buttons and
 * Enter does nothing until focus is actually on one of them.
 *
 * NOT a body-scroll lock. Setting `overflow: hidden` on <body> removes the scrollbar and
 * reflows the page underneath by its width, which moves every control on the screen at
 * the moment a pointer is travelling towards this dialog. The fixed backdrop already
 * intercepts every pointer event.
 *
 * NO ANIMATION, so there is nothing for `prefers-reduced-motion` to suppress and nothing
 * moving while the operator reads the consequence.
 *
 * ── MOUNTING IS OPENING ──
 * There is no `open` prop: the caller renders this only while it should be on screen.
 * Same choice, and the same reason, as Disclosure, an unmounted dialog is unambiguously
 * neither focusable nor clickable, which is the property that matters when the thing
 * inside it deletes a membership row.
 */

/**
 * How much visual weight the confirm button carries.
 *
 * "destructive" is for an action with an IRREVERSIBLE component. Disabling access is
 * reversible in the sense that access can be restored, but the pending invitations it
 * destroys are gone for good, so it is destructive, and only restoring access is
 * "neutral". Giving a restore the same red button as a removal would teach the operator
 * that red means nothing.
 */
export type ConfirmTone = "destructive" | "neutral";

/**
 * THE DISABLED STATE IS DARKER, NOT FADED, and that is a contrast decision rather than a
 * stylistic one.
 *
 * The reflex here is `disabled:bg-danger-field-border` (or `disabled:opacity-50`), and both put white
 * text on a pale wash: measured, white on red-300 is 1.90:1 and fails WCAG AA outright.
 * That would be tolerable on a button whose label nobody needs to read, but the disabled
 * label is "Removing…" / "Disabling…", which is the ONLY acknowledgement the operator gets
 * that their click was received. Making the acknowledgement unreadable at the moment it
 * matters is how a double-click happens.
 *
 * So pending goes to the 700 shade: white on red-700 is 6.47:1 and on primary-700 6.70:1,
 * against 4.83:1 and 5.17:1 for the enabled 600 shades. Better contrast than the enabled
 * state, and it reads as "engaged" rather than "dead". `cursor-default` carries the
 * not-clickable half, which is what opacity was really being used for.
 */
const CONFIRM_BUTTON: Record<ConfirmTone, string> = {
  destructive:
    "bg-danger-text-strong text-brand-ink hover:bg-danger-text-strong focus:ring-danger-text disabled:bg-danger-text-strong disabled:cursor-default",
  neutral:
    "bg-brand text-brand-ink hover:bg-brand-hover focus:ring-brand disabled:bg-brand-hover disabled:cursor-default",
};

/** Everything inside the dialog that can hold focus, for the Tab wrap below. */
const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), [href]';

export function ConfirmActionDialog({
  title,
  target,
  consequences,
  reversibility,
  confirmLabel,
  pendingLabel,
  tone,
  pending,
  reasonHint,
  onConfirm,
  onDismiss,
  fallbackFocus,
  returnToFallback,
}: {
  /** A question naming the action AND its specific target. Never "Are you sure?". */
  title: string;
  /**
   * WHO this is about, restated under the heading in a fixed position.
   *
   * The title already names them, but the title is also the thing an operator skips when
   * they have clicked this five times today. Repeating the identity where the eye lands
   * after the question is what makes "wrong row" recoverable before the click, not after.
   */
  target: ReactNode;
  /**
   * The consequences, ONE FACT PER ITEM, with real values in them. Rendered as a list so
   * the irreversible clause cannot hide inside a paragraph.
   */
  consequences: ReactNode[];
  /**
   * What can and cannot be undone, in the operator's words. Required rather than
   * optional: "is this recoverable" is the question that decides the click, and a dialog
   * that omits it has left the operator to guess.
   */
  reversibility: ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while the mutation is in flight. */
  pendingLabel: string;
  tone: ConfirmTone;
  /** True from submit until the mutation settles. Drives the pending state. */
  pending: boolean;
  /**
   * What a reason is FOR on this action, so the field is worth filling in.
   *
   * OMIT IT ENTIRELY for an action whose mutation records no reason, and the field is not
   * rendered at all. That is not a convenience: a textarea whose contents are silently
   * discarded is worse than no textarea, because an operator who takes the trouble to explain
   * a disclosure believes they have left a record and has not. The two access mutations DO
   * persist it (see AUDIT_REASON_MAX and normalizeAuditReason); the ratings publish route
   * accepts only a generationId, so it passes nothing here.
   *
   * The focus trap is unaffected, it recomputes the focusable set from the DOM on every
   * keypress rather than assuming which controls exist (see onKeyDown).
   */
  reasonHint?: string;
  /** The operator's note, or `""` when no reason field was offered. */
  onConfirm: (reason: string) => void;
  /**
   * Dismiss without acting. Called by Cancel, Escape and a backdrop click.
   *
   * REMAINS AVAILABLE WHILE PENDING, deliberately. The obvious alternative, lock the
   * dialog until the mutation settles, assumes the mutation settles, and nothing on this
   * path guarantees that: `backendFetch` passes no AbortSignal, so a hung request would
   * trap the operator in a modal with no way out during exactly the incident they opened
   * it for. So dismissal stays open and the caller records the outcome as UNKNOWN, which
   * is the truth: the request was sent and nobody knows whether it landed.
   */
  onDismiss: (wasPending: boolean) => void;
  /**
   * Where focus goes when it must NOT go back to the element that opened this dialog.
   *
   * `.focus()` on a detached element is a no-op, so without this a keyboard operator lands
   * on <body> and tabs from the top of the page again, the same defect
   * the CREATE FORM'S PHASE EDITOR had, before that editor was removed (the phase pipeline is fixed
   * now, see FIXED_PHASE_PIPELINE). Its `focusTargetAfterMove` helper went with it; the failure mode
   * it guarded against is described here because THIS dialog still has it.
   */
  fallbackFocus?: () => HTMLElement | null | undefined;
  /**
   * "Is the trigger about to be destroyed?", asked at close time.
   *
   * ⚠ THIS CANNOT BE A BOOLEAN PROP, and the reason is a timing bug worth naming. After a
   * successful team removal the trigger is DOOMED but still mounted: the roster shrinks
   * only when the invalidated query refetches, which is several ticks later. So a cleanup
   * that merely checks `isConnected` finds the Remove button alive, focuses it, and focus
   * drops to <body> when the row unmounts a moment later, the exact stranding this prop
   * exists to prevent, in the case it most needs to.
   *
   * A boolean prop would not help either: the caller learns the outcome in its mutation
   * callback, and the same batch unmounts this component, so no re-render carries the new
   * value down. A callback is read at cleanup time, which is after the caller has set
   * whatever it is reading, so pass one backed by a REF the mutation callback mutates,
   * not by state.
   */
  returnToFallback?: () => boolean;
}) {
  const headingId = useId();
  const targetId = useId();
  const consequencesId = useId();
  const reversibilityId = useId();
  const reasonId = useId();
  const reasonHintId = useId();

  const panelRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  /** The element that had focus when this mounted, so it can be given it back. */
  const openerRef = useRef<Element | null>(null);
  /**
   * Read by the unmount cleanup, so they must not be stale closures over the first render's
   * props, hence refs refreshed every render rather than effect dependencies. (An effect
   * with these in its dependency array would re-run on every render, re-stealing focus from
   * the textarea the operator is typing in.)
   */
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;
  const returnToFallbackRef = useRef(returnToFallback);
  returnToFallbackRef.current = returnToFallback;

  const [reason, setReason] = useState("");

  /**
   * KEEP FOCUS INSIDE THE DIALOG WHEN THE CONFIRM BUTTON DISABLES ITSELF.
   *
   * A keyboard operator activates Confirm with Enter or Space, so focus is ON that button
   * when `pending` flips true, and a disabled element cannot hold focus, so the browser
   * drops it to <body>. At that point Escape does nothing (the handler is on the panel),
   * Tab starts from the top of the document BEHIND the backdrop, and the operator is locked
   * out of a modal that is still on screen, mid-destructive-action. This is the same class
   * of bug as the deleted phase editor's focus helper had, arriving from the opposite direction.
   *
   * Moves focus to the dismiss button, which is deliberately the control that stays live
   * while pending (see onDismiss), so the escape hatch is where focus lands.
   *
   * Guarded on the focus actually having been lost from the dialog: an operator who clicked
   * with a pointer and then tabbed into the textarea must not have it yanked away.
   */
  useEffect(() => {
    if (!pending) return;
    const root = panelRef.current;
    if (!root) return;
    if (root.contains(document.activeElement)) return;
    dismissRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    // The PANEL takes focus, not a button. Focusing Confirm would arm the destructive
    // action on the very next Enter; focusing Cancel reads out the wrong half of the
    // choice first. A focused container announces its own accessible name and description
    //, the question and every consequence, and leaves nothing pre-armed.
    panelRef.current?.focus();

    return () => {
      const opener = openerRef.current;
      /**
       * PUT FOCUS BACK SOMEWHERE USABLE, and verify it actually landed.
       *
       * Getting this wrong strands a keyboard operator on <body>, where Tab restarts from
       * the top of the document and the Escape handler bound to this panel is gone with the
       * panel. Two shipped defects both reduced to the same mistaken assumption, that
       * `opener.isConnected` means `opener.focus()` will work and keep working:
       *
       *   DISMISSED MID-FLIGHT. The trigger is `disabled` for the duration of the request
       *     (that is the double-submit guard doing its job), and a disabled element refuses
       *     focus silently. The old code saw `isConnected === true`, called `focus()`, and
       *     `return`ed, skipping the fallback at exactly the moment the operator most needs
       *     to read the notice, because the outcome is UNKNOWN.
       *   ROW LEFT THE LIST. Focus lands on the trigger successfully, and the invalidated
       *     query then resolves and unmounts the row underneath it. Instrumenting this
       *     cleanup proved it: connected, focusable, `activeElement === opener`, and <body>
       *     a moment later, after this function had already returned.
       *
       * So the check is not "will focus land" but "did it land, and did it stay". Predicting
       * is hopeless: the ways an element quietly refuses focus are open-ended (disabled,
       * `inert`, `visibility: hidden`, an ancestor `display: none`, a competing focus call),
       * and the unmount is driven by a network refetch with no deadline to sample at. A
       * lone `setTimeout(0)` was measured firing BEFORE the refetch committed.
       *
       * `focusout` is the honest instrument, it fires when focus leaves, whenever that is,
       * and needs no guess about React's timing.
       */
      const doomed = returnToFallbackRef.current?.() ?? false;
      if (!doomed && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();

        if (document.activeElement === opener) {
          const rescue = () => {
            // Deferred one task: at focusout time activeElement is still transitioning, and
            // the browser may be moving focus somewhere legitimate. Reading it on the next
            // task sees where it actually settled.
            setTimeout(() => {
              const active = document.activeElement;
              // <body>/null ONLY. If focus has legitimately moved elsewhere by now, the
              // operator tabbed, another component claimed it, stealing it back is worse
              // than the bug.
              if (!active || active === document.body) {
                fallbackRef.current?.()?.focus();
              }
            }, 0);
          };
          opener.addEventListener("focusout", rescue, { once: true });
          // Bounded, so this cannot outlive the interaction it belongs to: an operator who
          // simply carries on working must not have a listener waiting to yank focus minutes
          // later. 5s covers a refetch several times over, and `once` means the normal path
          // removes it on first fire.
          setTimeout(() => opener.removeEventListener("focusout", rescue), 5000);
          return;
        }
        // focus() was a no-op, the disabled-trigger case. Fall through to the fallback.
      }
      fallbackRef.current?.()?.focus();
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // Stopped here so Escape cannot also reach a listener on the page behind, closing
      // this dialog and a panel underneath it on one keypress would leave the operator
      // somewhere they did not navigate to.
      event.stopPropagation();
      onDismiss(pending);
      return;
    }
    if (event.key !== "Tab") return;

    // The trap. aria-modal tells a screen reader the rest of the page is inert; it does
    // NOT stop Tab, so without this a keyboard operator walks out of a dialog that is
    // still on screen and starts operating controls behind the backdrop.
    const root = panelRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    // Wrapping from the panel itself (the initial focus target) counts as wrapping from
    // the start, so Shift+Tab on open lands on the last control rather than escaping.
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const remaining = AUDIT_REASON_MAX - [...reason].length;

  return (
    <div
      // A backdrop click dismisses, which for a confirmation is the FAIL-SAFE direction:
      // a pointer that misses the confirm button and lands here cancels rather than acts.
      // Guarded on the target so a click inside the panel cannot bubble out and close it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onDismiss(pending);
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--scrim)/0.5)] p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        // ALL THREE, in reading order. Focus lands on the panel, so this is the one
        // announcement a screen-reader operator gets before deciding, omitting the
        // reversibility line would leave the single most decision-relevant sentence to be
        // discovered by arrowing around afterwards.
        aria-describedby={`${targetId} ${consequencesId} ${reversibilityId}`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        // max-h + overflow so the dialog survives 200% zoom and a small viewport with its
        // buttons still reachable, rather than pushing them off-screen.
        className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg bg-surface-3 p-6 shadow-xl focus:outline-none focus:ring-2 focus:ring-brand"
      >
        <h2 id={headingId} className="text-base font-semibold text-ink">
          {title}
        </h2>

        <p id={targetId} className="mt-1 text-sm text-ink-subtle break-words">
          {target}
        </p>

        <ul
          id={consequencesId}
          className="mt-4 space-y-1.5 border-t pt-4 text-sm text-ink-muted"
        >
          {consequences.map((consequence, i) => (
            <li key={i} className="flex gap-2">
              {/* Decorative: the list semantics already say "item", and a bullet read
                  aloud per line is noise. */}
              <span aria-hidden="true" className="text-ink-tertiary">
                ·
              </span>
              <span className="min-w-0">{consequence}</span>
            </li>
          ))}
        </ul>

        {/* Reversibility is called out rather than listed, because it is the one line that
            decides the click. Never colour alone, the tone carries a word ("cannot be
            undone" / "can be restored") and the border repeats it. */}
        <p
          id={reversibilityId}
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            tone === "destructive"
              ? "border-danger-border bg-danger-bg text-danger-text"
              : "border-hairline bg-surface-1 text-ink-muted"
          }`}
        >
          {reversibility}
        </p>

        {/* Rendered ONLY when the caller's mutation actually persists a reason. See the
            `reasonHint` prop note: a field whose contents are discarded is worse than no
            field, because the operator believes they have left a record. */}
        {reasonHint !== undefined && (
          <div className="mt-4">
            <label
              htmlFor={reasonId}
              className="block text-xs font-medium text-ink-subtle"
            >
              {/* gray-500 (4.63:1), not the gray-400 (2.85:1) this codebase uses for
                  de-emphasised labels elsewhere. "(optional)" is the word that decides whether
                  an operator stops to type, so it has to be readable at 4 a.m., and this
                  dialog is the one screen where the de-emphasis is not worth the contrast. */}
              Reason <span className="font-normal text-ink-subtle">(optional)</span>
            </label>
            {/* OPTIONAL, and that is the whole design of this field. It lands in a permanent
                audit trail, so an operator who has a reason should be able to record it
                without leaving the dialog, but making it required would put a text field
                between an operator and an action they have already decided on, during the
                incident that prompted it. Blank collapses to no attribute server-side
                (normalizeAuditReason), so an empty box costs nothing. */}
            <p id={reasonHintId} className="mt-0.5 text-xs text-ink-subtle">
              {reasonHint}
            </p>
            <textarea
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              // Capped at the input rather than only validated on submit, and capped from
              // the SHARED constant the services truncate at, a reason that fits this box
              // always survives the write intact.
              maxLength={AUDIT_REASON_MAX}
              rows={2}
              aria-describedby={reasonHintId}
              className="mt-1.5 w-full resize-none rounded-md border border-field-border px-3 py-2 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            />
            {/* tabular-nums and a reserved line: the counter must not change the height of
                the dialog, or the buttons move as the operator types. Not a live region -
                announcing a number per keystroke would make the field unusable with a
                screen reader. */}
            <p className="mt-1 text-right text-xs tabular-nums text-ink-subtle">
              {remaining} characters left
            </p>
          </div>
        )}

        {/* justify-between, so the two buttons sit at OPPOSITE ends of the footer. A
            pointer aimed at one and landing short hits empty space rather than the other,
            which for a destructive dialog is the difference between nothing happening
            and the thing happening. */}
        <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
          <button
            ref={dismissRef}
            type="button"
            onClick={() => onDismiss(pending)}
            className="rounded-md border px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
          >
            {/* The word changes while a request is in flight because the meaning does:
                nothing is being cancelled at that point, the dialog is only being put
                away, and the caller records the outcome as unknown. */}
            {pending ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            // Disabled the instant it is pressed. A second click on a destructive control
            // is the hazard this closes; the mutations are idempotent server-side, but a
            // team removal's second attempt answers "not a member" and an operator cannot
            // tell that from a first attempt that failed.
            disabled={pending}
            onClick={() => onConfirm(reason)}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ${CONFIRM_BUTTON[tone]}`}
          >
            {pending ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
