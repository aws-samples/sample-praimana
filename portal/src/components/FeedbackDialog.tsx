"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import {
  FEEDBACK_BOUNDS,
  FEEDBACK_FIELD_LABELS,
  FEEDBACK_PROMPTS,
  FEEDBACK_SUBJECT_PLACEHOLDERS,
  FEEDBACK_TITLES,
  MAX_FEEDBACK_MESSAGE,
  MAX_FEEDBACK_SUBJECT,
  checkFeedbackField,
  checkFeedbackReport,
  feedbackWordHint,
  type FeedbackField,
  type FeedbackKind,
} from "@praimana/shared";

/**
 * ── REPORTING A BUG OR SENDING FEEDBACK, IN THE APP ────────────────────────────────────────
 *
 * REPLACES A `mailto:`. The report is stored and the
 * platform emails staff, so the reporter's own mail client is no longer part of the path.
 *
 * ── ⚠ WHAT THE CONTEXT IS, AND WHAT IT IS NOT ──
 *
 * The route and the ids the reporter was on travel with the report so a triager does not have to ask "where
 * were you". `usePathname` and NOT the full URL: a query string on this platform can carry an invite token,
 * and while this body no longer leaves the platform in an email it is still stored and read by other people.
 *
 * ⚠ NOTHING ABOUT *WHO* IS SENT. The service takes the reporter's id, email and role from the verified
 * token. A field here would be ignored at best and a spoofing surface at worst.
 *
 * ── ⚠ WHY A DIALOG AND NOT A PAGE ──
 *
 * A bug is reported in the middle of hitting it. Navigating to a form loses the screen the reporter was
 * describing, and, worse, loses whatever they had half-typed elsewhere. This opens over the page and the
 * page is still behind it, which is also why the context it captures is accurate: it is the page they are
 * still on.
 *
 * ── ⚠ TWO FIELDS WITH WORD FLOORS, AND WHAT THAT OBLIGES THE FORM TO DO ──
 *
 * The bounds: subject 5–15 words, description 20–200. A MINIMUM is unusual in a form and
 * it is friction by design, so the whole burden of making it bearable falls here:
 *
 *   · the requirement is stated UNDER EACH FIELD BEFORE anything is typed, never sprung on Send;
 *   · a live counter counts UP TO the floor ("7 / 20 words"), so progress is visible rather than only
 *     failure;
 *   · Send is disabled until both fields pass, with the reason named beside it, a disabled button whose
 *     cause is invisible is the version of this that generates support requests of its own;
 *   · nothing is truncated. `maxLength` is the CHARACTER cap only; the word ceiling REFUSES, so a reporter
 *     never silently loses the end of a sentence.
 */
/**
 * The line under a field: what it wants, and how far along you are.
 *
 * ── ⚠ UNDER THE FLOOR IS NOT AN ERROR STATE ──
 *
 * A field being half-written is the NORMAL condition of a field being written, so "7 / 20 words" is grey.
 * Red is reserved for the one case a reporter must act on, over the ceiling, where more typing makes it
 * worse. Colouring in-progress input red trains people to ignore the colour, which is how the genuine
 * problem then gets ignored too.
 *
 * ⚠ AND THE REQUIREMENT IS SHOWN WHILE THE FIELD IS EMPTY. That is the whole point of putting it here: a
 * floor discovered by pressing Send is a floor that wasted the reporter's time.
 */
function FieldHint({ field, value }: { field: FeedbackField; value: string }) {
  const { minWords, maxWords } = FEEDBACK_BOUNDS[field];
  const over = checkFeedbackField(field, value)?.code.endsWith("_TOO_LONG") ?? false;

  return (
    <span className="mt-1 flex items-baseline justify-between text-xs">
      <span className="text-ink-subtle">
        {minWords}–{maxWords} words
      </span>
      <span className={over ? "font-medium text-danger-text" : "text-ink-subtle"}>
        {feedbackWordHint(field, value)}
      </span>
    </span>
  );
}

export function FeedbackDialog({
  kind,
  onClose,
}: {
  kind: FeedbackKind;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const params = useParams();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);
  const submit = trpc.feedback.submit.useMutation({ onSuccess: () => setSent(true) });

  /**
   * Focus the FIRST field on open (the subject now, not the description), and close on Escape.
   *
   * ⚠ ESCAPE IS THE ONE KEYBOARD AFFORDANCE THAT MATTERS HERE, because this covers the page: without it a
   * keyboard user who opened it by mistake has to tab to find Cancel. Removed on unmount so a closed dialog
   * does not keep swallowing the key.
   */
  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * What is still wrong, if anything, the SHARED validator, so this is the same verdict the BFF and the
   * service will reach. `null` means Send is allowed.
   *
   * ⚠ NOT A SECOND IMPLEMENTATION OF THE RULE. A form that counted words its own way would eventually
   * disagree with the API by one word, and the reporter would be the one to discover it.
   */
  const problem = checkFeedbackReport({ subject, message });
  const remaining = MAX_FEEDBACK_MESSAGE - message.length;

  return (
    <div
      // A plain overlay with a backdrop click-out. `aria-modal` + role=dialog so assistive tech treats the
      // page behind as inert even though this is not a native <dialog>.
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgb(var(--scrim)/0.32)] p-4 pt-24"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        className="w-full max-w-lg rounded-xl border border-hairline bg-surface-3 p-6 shadow-lg"
        // The backdrop closes; a click INSIDE must not bubble up to it and close the form mid-sentence.
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="feedback-title" className="text-lg font-semibold text-ink">
          {FEEDBACK_TITLES[kind]}
        </h2>

        {sent ? (
          <>
            {/*
              ⚠ A DISTINCT SUCCESS STATE RATHER THAN CLOSING ON SEND. Closing immediately gives a reporter
              no evidence anything happened, and the commonest response to that is to send it again, which
              is how an inbox fills with duplicates.
            */}
            <p className="mt-3 text-sm text-ink-muted">
              Thank you, this has been sent to the team running the platform.
            </p>
            <p className="mt-1 text-xs text-ink-subtle">
              They can see which page you were on, so you don&apos;t need to explain where you were.
            </p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-hover"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-subtle">{FEEDBACK_PROMPTS[kind]}</p>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-ink-muted">
                {FEEDBACK_FIELD_LABELS.subject}
              </span>
              <input
                ref={boxRef}
                type="text"
                value={subject}
                placeholder={FEEDBACK_SUBJECT_PLACEHOLDERS[kind]}
                // The CHARACTER cap only. The word ceiling is enforced by refusing, never by truncating
                // mid-sentence, see the header.
                maxLength={MAX_FEEDBACK_SUBJECT}
                onChange={(e) => setSubject(e.target.value)}
                className="mt-1 w-full rounded-md border border-field-border px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <FieldHint field="subject" value={subject} />
            </label>

            <label className="mt-4 block">
              <span className="text-xs font-medium text-ink-muted">
                {FEEDBACK_FIELD_LABELS.message}
              </span>
              <textarea
                rows={7}
                value={message}
                // Matches the service's cap exactly, the shared constant. A courtesy that stops a paste
                // being refused after the fact; the service refuses over-long text rather than truncating
                // it, so the two numbers must be the same number.
                maxLength={MAX_FEEDBACK_MESSAGE}
                onChange={(e) => setMessage(e.target.value)}
                className="mt-1 w-full rounded-md border border-field-border px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <FieldHint field="message" value={message} />
            </label>

            {/* The CHARACTER cap, and only near it: a second counter on a half-written box is noise. */}
            {remaining < 500 && (
              <p className="mt-1 text-xs text-ink-subtle">{remaining} characters left</p>
            )}

            {submit.error && (
              <p role="alert" className="mt-3 text-sm text-danger-text">
                {submit.error.message}
              </p>
            )}

            <div className="mt-5 flex items-center justify-end gap-3">
              {/*
                ⚠ THE REASON SEND IS DISABLED, NEXT TO SEND. A greyed-out button with no explanation is the
                version of this that generates a support request about the support form. `aria-live` so the
                reason reaches a screen reader when it changes, rather than only on a re-read of the dialog.
              */}
              {problem && (
                <p aria-live="polite" className="mr-auto text-xs text-ink-subtle">
                  {problem.message}
                </p>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-field-border px-4 py-2 text-sm text-ink-muted hover:bg-surface-1"
              >
                Cancel
              </button>
              <button
                type="button"
                // Disabled until BOTH fields pass, as well as in-flight: the service refuses the same input,
                // and finding that out after pressing Send is a worse way to learn it.
                disabled={problem !== null || submit.isPending}
                onClick={() =>
                  submit.mutate({
                    kind,
                    subject,
                    message,
                    surface: "portal",
                    location: pathname,
                    ...(typeof params.workshopId === "string"
                      ? { workshopId: params.workshopId }
                      : typeof params.id === "string"
                        ? { workshopId: params.id }
                        : {}),
                    ...(typeof params.teamId === "string" ? { teamId: params.teamId } : {}),
                  })
                }
                className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-60"
              >
                {submit.isPending ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
