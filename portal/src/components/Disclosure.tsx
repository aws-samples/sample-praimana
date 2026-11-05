"use client";

import type { ReactNode } from "react";

/**
 * A show/hide toggle for a section that is PRIMARY content, a roster, a list, a table.
 *
 * Why this is not components/form/AdvancedDisclosure. That component is the right shape
 * for the opposite problem, and four of its decisions are wrong here:
 *
 *   1. It is collapsed-by-default furniture for controls a facilitator should IGNORE.
 *      A roster is what the operator came to the page to read, so it opens by default and
 *      collapsing is a scanning aid, not a way to defer work.
 *   2. It REQUIRES a `summary` line describing what you are skipping. There is no honest
 *      summary of "Members" beyond the count, and padding one out would add a line of
 *      noise above every list on the page.
 *   3. It is a card, `rounded-xl border bg-surface-3` with a bordered panel inside. The team
 *      page's rows already carry their own borders, so wrapping them would double up.
 *      This wrapper is visually weightless: the only new pixels are the caret.
 *   4. Its heading is a hardcoded <h2>. This sits under the page's <h2> title and must be
 *      an <h3>, so the level is a prop and the heading outline stays legal.
 *
 * What the two share, deliberately, so the app has ONE collapse idiom: a real <button>
 * with aria-expanded/aria-controls, the same focus ring, and a caret that ROTATES rather
 * than swapping ▸/▾, the glyph swap changes the element's width and nudges the title
 * sideways on every toggle.
 *
 * THE COUNT LIVES IN THE HEADING, not in a badge beside it. The reason to collapse a
 * roster is to scan the page, so the number is the one thing that must survive being
 * closed, "Members (3)" is still an answer, "Members ▸" is a question. Being inside the
 * heading text also means a screen reader announces it with the section name for free.
 */
export function Disclosure({
  id,
  title,
  count,
  open,
  onToggle,
  notice,
  headingLevel = 3,
  className = "",
  children,
}: {
  /** Stable id. Owns `${id}-panel` and `${id}-heading`. */
  id: string;
  title: string;
  /** Rendered as "Title (n)". Pass a number, `0` is a real answer and does render. */
  count?: number;
  open: boolean;
  onToggle: () => void;
  /**
   * Content that must stay visible WHEN COLLAPSED, an error from an action taken inside
   * the panel, typically. It sits outside the panel on purpose: hiding a failure message
   * because the operator later collapsed the list would lose information, and the
   * alternative (forcing the panel open) makes the toggle stop responding to clicks.
   */
  notice?: ReactNode;
  /** Heading level for the section title. Must match the surrounding outline. */
  headingLevel?: 2 | 3;
  /** Outer spacing only, e.g. "mb-8". */
  className?: string;
  children: ReactNode;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <section aria-labelledby={`${id}-heading`} className={className}>
      <Heading id={`${id}-heading`}>
        {/* -mx-2 px-2 so the hover surface bleeds outside the text box without moving the
            title one pixel horizontally, the heading stays aligned with the rows below
            it whether this component is used or not. */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          className="-mx-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
        >
          <span
            aria-hidden="true"
            className={`shrink-0 text-xs text-ink-subtle transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="font-semibold">
            {title}
            {typeof count === "number" && (
              /* tabular-nums so the heading does not re-flow its own width when the
                 count crosses 9 → 10 after an invite is sent. */
              <span className="tabular-nums"> ({count})</span>
            )}
          </span>
        </button>
      </Heading>

      {notice}

      {/* Conditional render rather than keeping the panel mounted and visually hidden.
          Same choice as AdvancedDisclosure, for the same reason plus one: the rows inside
          carry a destructive control (Revoke), and unmounting is the unambiguous way to
          guarantee it is neither focusable nor clickable while the operator cannot see it.
          Cost of this choice: scroll position within the panel is not preserved across a
          collapse, which is the correct trade for a list this short. */}
      {open && (
        <div id={`${id}-panel`} className="mt-3">
          {children}
        </div>
      )}
    </section>
  );
}
