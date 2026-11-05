import type { ReactNode } from "react";

/**
 * One titled, numbered group of fields on a long form.
 *
 * Exists because the Create Experience form was a single flat 441-line <form> in which
 * "Experience Name" carried exactly the same visual weight as a raw JSON textarea.
 * Eight unrelated field clusters read as one undifferentiated list, so a facilitator
 * had to re-read the whole column to find the one control they came for.
 *
 * The STEP NUMBER is the load-bearing part, not decoration. It gives the form a spoken
 * shape ("format is in section 1, phases in section 2") so a facilitator who is
 * interrupted, the normal case when you are setting up a workshop with people in the
 * room, can resume by number instead of by re-reading. It is aria-hidden because a
 * screen-reader user gets the same structure for free from the heading outline, and
 * hearing "two" before every heading is noise.
 *
 * `aria-labelledby` on the <section> rather than a bare <div>: this turns each group
 * into a landmark a screen reader can jump between, which is the non-visual equivalent
 * of the numbered card.
 */
export function FormSection({
  id,
  step,
  title,
  description,
  aside,
  children,
}: {
  /** Stable id, also the anchor for the heading association. */
  id: string;
  /** 1-based position, shown in the gutter. */
  step: number;
  title: string;
  /** One line on what the group decides. Omit rather than pad. */
  description?: ReactNode;
  /** Optional status/summary content, right-aligned against the heading. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="rounded-xl border border-hairline bg-surface-3 p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-sm font-semibold text-brand-text"
        >
          {step}
        </span>
        <div className="min-w-0 flex-1">
          {/* items-baseline so a one-line aside sits on the heading's baseline and a
              two-line one grows DOWNWARD rather than nudging the heading. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2
              id={`${id}-heading`}
              className="text-base font-semibold text-ink"
            >
              {title}
            </h2>
            {aside}
          </div>
          {description && (
            <p className="mt-1 text-sm text-ink-subtle">{description}</p>
          )}
        </div>
      </div>

      <div className="mt-5">{children}</div>
    </section>
  );
}
