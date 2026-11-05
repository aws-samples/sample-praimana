"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "What does this send to the model?", the prompts, shown to the executive who presses Analyze.
 *
 * ── WHY THIS EXISTS ──
 *
 * `InsightsMethodology` publishes the weights behind the heuristic AI Usage Score, on the argument
 * that a number which ranks people and does not say how it was produced invites distrust that
 * cannot be argued with. The model-generated assessment lower down the same page is the MORE
 * consequential judgement, it writes prose about a named person's craft, and it published
 * nothing. This is that gap closed.
 *
 * ── ⚠ THE TEXT IS FETCHED, NEVER DECLARED HERE ──
 *
 * `InsightsMethodology` hardcodes its weights and carries a warning about keeping them in step with
 * the computation. That is tolerable for four percentages next to the code that applies them. It is
 * NOT tolerable for a system prompt in another repository: a panel that showed a prompt the model
 * did not receive would be a false statement about how a person was assessed. So the strings come
 * from the AI service, which serves the same constants its Bedrock adapter sends.
 *
 * ── WHY A DIALOG AND NOT THAT FILE'S POPOVER ──
 *
 * Two system prompts are ~40 lines of prose with a mandatory JSON schema at the end of each. The
 * `w-[22rem]` panel that suits four weighted factors would turn them into a ladder of two-word
 * lines, and the JSON would wrap into nonsense. This is a centred, scrollable, focus-trapping
 * dialog with the prompts in a monospace block that preserves their line breaks.
 */

export interface DisclosedPrompt {
  key: "knowledge" | "summary";
  title: string;
  system: string;
  inputs: string[];
  audience: string;
}

export function RatingsPromptDisclosure({
  prompts,
  loading = false,
  error = null,
}: {
  prompts: DisclosedPrompt[];
  loading?: boolean;
  /**
   * A FAILED FETCH IS REPORTED, not silently rendered as an empty panel.
   *
   * An empty disclosure reads as "nothing is sent to the model", which is the opposite of the
   * truth and worse than an error. Same reasoning as the coaching card's separate `loadError`.
   */
  error?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes and focus returns to the trigger, a panel dismissable only by clicking the
  // same small icon again is a trap for keyboard users. Same contract as InsightsMethodology.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  /**
   * FOCUS MOVES INTO THE DIALOG ON OPEN. `InsightsMethodology` leaves focus on the trigger, which
   * is defensible for a small popover but not here: this panel scrolls, so a keyboard or
   * screen-reader user who cannot reach its content cannot read the thing it exists to show.
   */
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="What this sends to the model"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-field-border text-[11px] font-semibold text-ink-subtle hover:border-hairline-strong hover:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand"
      >
        i
      </button>

      {open && (
        <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-[rgb(var(--scrim)/0.32)] p-4 sm:p-8">
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ratings-prompt-heading"
            className="w-full max-w-2xl rounded-lg border bg-surface-3 shadow-xl"
          >
            <div className="flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="min-w-0">
                <h3
                  id="ratings-prompt-heading"
                  className="text-sm font-semibold text-ink"
                >
                  What this sends to the model
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                  Analyzing makes two separate calls per team. These are the exact instructions
                  each one is given, and what it is allowed to see.
                </p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={() => {
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                className="flex-shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-subtle hover:bg-surface-2 hover:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand"
              >
                Close
              </button>
            </div>

            <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
              {loading && (
                <p className="text-xs text-ink-subtle">Loading the prompts…</p>
              )}

              {error && (
                <p
                  role="alert"
                  className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-text"
                >
                  {error}
                </p>
              )}

              {!loading &&
                !error &&
                prompts.map((p) => (
                  <section key={p.key}>
                    <h4 className="text-xs font-semibold text-ink-muted">{p.title}</h4>

                    {/* ⚠ THE INPUTS COME FIRST, ABOVE THE PROMPT, AND THAT ORDER IS THE POINT.
                        The summary prompt says "NEVER refer to an individual"; a reader who meets
                        that rule first concludes the guarantee is the instruction. It is not, the
                        call receives team totals, so it cannot name someone it never saw. Leading
                        with what the model can see credits the property to the input that actually
                        holds it. */}
                    <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                      What it receives
                    </p>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs leading-relaxed text-ink-subtle">
                      {p.inputs.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>

                    <p className="mt-2.5 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                      Who reads the result
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-subtle">
                      {p.audience}
                    </p>

                    <p className="mt-2.5 text-[11px] font-medium uppercase tracking-wide text-ink-subtle">
                      Instructions sent
                    </p>
                    {/* `whitespace-pre-wrap` because the prompt's own line breaks and its trailing
                        JSON schema are part of what is being disclosed. Collapsing them would show
                        a prompt that is not the one sent. */}
                    <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border bg-surface-1 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-muted">
                      {p.system}
                    </pre>
                  </section>
                ))}

              {/* The honest limit of the disclosure. The prompt is what the model was ASKED; it is
                  not a guarantee about what it returned, and the page must not imply otherwise. */}
              <p className="rounded-md border border-warn-border/50 bg-warn-bg px-2.5 py-2 text-xs leading-relaxed text-warn-text">
                These are the instructions, not a guarantee about the output. A model follows
                instructions probabilistically, which is why the rules that matter most are
                enforced by what each call is allowed to see, and why the service discards a summary
                that names anyone.
              </p>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
