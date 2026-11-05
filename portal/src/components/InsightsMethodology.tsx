"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "How is this calculated?", the scoring logic, shown to the people it scores.
 *
 * ── WHY THIS EXISTS ──
 *
 * The insights page ranks team members with an "AI Usage Score" out of 100. A number that
 * ranks people and does not say how it was produced invites two bad outcomes: quiet
 * distrust ("this is wrong and I can't argue with it"), and quiet gaming ("I'll open more
 * sessions"). Publishing the weights fixes the first and makes the second visible, if
 * someone games a metric they can read, the metric was the problem.
 *
 * Every number below is copied from the computation in insights/page.tsx rather than
 * described from memory. A methodology note that drifts from the code is worse than none,
 * so the weights are stated as they are implemented and the caveats are the honest ones.
 */

const WEIGHTS = [
  {
    label: "AI sessions",
    weight: "30%",
    detail:
      "Conversations this member started, as a share of the busiest member's count. Relative, not absolute, so a quiet week does not push the whole team to zero.",
  },
  {
    label: "Session depth",
    weight: "25%",
    detail:
      "Average messages per conversation, capped at five (5 × 20 = 100). Rewards working a problem through rather than opening many one-line threads.",
  },
  {
    label: "Task completion",
    weight: "25%",
    detail:
      "Board tasks assigned to this member that reached Done, as a share of their assigned tasks. Someone with no tasks assigned scores zero here.",
  },
  {
    label: "Team engagement",
    weight: "20%",
    detail:
      "Team-chat messages sent, as a share of the most active member's count. Also relative.",
  },
];

export function InsightsMethodology() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus returns to the trigger. A panel that can only be dismissed by
  // clicking the same small icon again is a trap for keyboard users.
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

  return (
    <span className="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="How these insights are calculated"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-field-border text-[11px] font-semibold text-ink-subtle hover:border-hairline-strong hover:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand"
      >
        i
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="How these insights are calculated"
          // Left-anchored and wide: this is prose, and a tooltip-width column would turn
          // four weighted factors into a ladder of two-word lines.
          className="absolute left-0 top-7 z-20 w-[22rem] rounded-lg border bg-surface-3 p-4 shadow-lg"
        >
          <h3 className="text-sm font-semibold text-ink">
            How these insights are calculated
          </h3>

          <p className="mt-2 text-xs text-ink-subtle leading-relaxed">
            Everything here is computed in your browser from this team&apos;s own activity -
            conversations, board tasks and team chat. Nothing is inferred about people
            outside the team, and no AI model is involved in these numbers.
          </p>

          <h4 className="mt-3 text-xs font-semibold text-ink-muted">
            AI Usage Score (0–100)
          </h4>
          <dl className="mt-1.5 space-y-2">
            {WEIGHTS.map((w) => (
              <div key={w.label}>
                <dt className="text-xs font-medium text-ink-muted">
                  {w.label} <span className="text-ink-tertiary">· {w.weight}</span>
                </dt>
                <dd className="text-xs text-ink-subtle leading-relaxed">{w.detail}</dd>
              </div>
            ))}
          </dl>

          {/* THE CAVEATS ARE PART OF THE METHODOLOGY, not a disclaimer bolted on. Each one
              is a real property of the formula above, and omitting them is what turns a
              rough activity signal into a performance rating. */}
          <h4 className="mt-3 text-xs font-semibold text-ink-muted">
            What it does not measure
          </h4>
          <ul className="mt-1.5 space-y-1 text-xs text-ink-subtle leading-relaxed list-disc pl-4">
            <li>
              <span className="font-medium text-ink-subtle">Quality.</span> It counts activity,
              not whether the work was any good. A member who solved the hard problem in
              three messages scores below one who took thirty.
            </li>
            <li>
              <span className="font-medium text-ink-subtle">Work outside the platform.</span>{" "}
              Pairing, whiteboarding and reviewing are invisible to it.
            </li>
            <li>
              <span className="font-medium text-ink-subtle">Comparisons across teams.</span>{" "}
              Two of the four factors are relative to the busiest member of{" "}
              <em>this</em> team, so a score means nothing outside it.
            </li>
          </ul>

          <p className="mt-3 rounded-md bg-warn-bg border border-warn-border/50 px-2.5 py-2 text-xs text-warn-text leading-relaxed">
            Use it to start a conversation in a retrospective, &ldquo;why was this phase
            quiet?&rdquo;, not to rank people. It is a rough signal of platform activity,
            and it is not a measure of contribution.
          </p>

          {/* The AI ratings are a separate, genuinely model-generated thing further down the
              page. Saying so here prevents the reader assuming these weights produced them. */}
          <p className="mt-3 text-xs text-ink-subtle leading-relaxed">
            The <span className="font-medium">AI-powered member ratings</span> lower down are
            different: those are generated by a model on demand and come with their own
            reasoning.
          </p>
        </div>
      )}
    </span>
  );
}
