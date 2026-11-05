"use client";

import { useId } from "react";

/**
 * WHAT THE AI RATINGS DO NOT CAPTURE, the service's own caveats, rendered on the screen
 * rather than left in a code comment.
 *
 * ── WHY THIS IS A COMPONENT AND NOT A SENTENCE IN THE CARD ──
 *
 * The AI service carries `coverage` in the snapshot PAYLOAD deliberately (see
 * TeamAiRatingSnapshot in the ai service's `domain.ts`): "people are ranked by these
 * numbers, so what the numbers miss travels with them to the screen". Two audiences receive
 * it, a member reading their own per-member coaching, and a judge reading the published team
 * summary, and both are about to act on a number about a person. One component so the two
 * cannot drift into saying different things about the same limitation.
 *
 * ── NOT A POPOVER, NOT A TOOLTIP, NOT BEHIND A DISCLOSURE ──
 *
 * The reflex is to tuck caveats behind an "i" icon, the way InsightsMethodology does for the
 * heuristic score. That is the right shape there, those weights explain a formula someone may
 * want to audit, and the wrong shape here. These sentences change how the number should be
 * READ, so they have to be legible in the same glance as the number: "counts activity, not
 * quality" is not supplementary detail, it is the difference between a score meaning something
 * and meaning nothing. Hover does not exist on touch and is unreachable by keyboard, and a
 * collapsed panel is a caveat nobody reads.
 *
 * ── QUIET, NOT HIDDEN ──
 *
 * Amber, bordered, and small, but at AA contrast (see the class note below), because this is
 * not a decorative aside. It is deliberately NOT red: nothing here is a fault or an alert, and
 * a red panel over "here is what this measurement misses" would teach an operator that the
 * card is broken. Amber is the same tone InsightsMethodology's closing caution uses, so the
 * two read as the same kind of statement.
 */

/**
 * BOUNDED, like every list in this codebase, and the bound is DISCLOSED when it bites.
 *
 * The service currently emits two caveats and the array is server-built, so 12 will not
 * truncate in practice, the cap exists so a future service that emits fifty cannot turn a
 * card into a wall of text. When it does bite the remainder is stated in words rather than
 * silently dropped: a caveat list that quietly ends is read as complete, which is the one
 * wrong answer on a panel whose entire job is to say what is missing.
 */
const MAX_COVERAGE_SHOWN = 12;

export function RatingCoverage({
  coverage,
  /**
   * Heading level, for the same reason ContentLoadError takes one: this renders inside the
   * ratings card (whose own heading is an <h3>) and inside the published-summary panel (also
   * an <h3>), so a hardcoded level would be right in one place and skip a rank in the other.
   */
  headingLevel = 4,
  /** Outer spacing only, e.g. "mt-4". */
  className = "",
}: {
  coverage: string[];
  headingLevel?: 3 | 4;
  className?: string;
}) {
  // A generated id, not a literal: a member's card and a published-summary panel can both be
  // on a page, and two sections sharing one `aria-labelledby` target would point the second
  // one's accessible name at the first one's heading. Hooks run before the early return below,
  // which is why this sits above it.
  const headingId = useId();

  // Renders NOTHING rather than an empty panel with a heading. An older snapshot written
  // before `coverage` existed has none, and a heading over an empty list reads as data that
  // failed to arrive, see the SentAt precedent for why a placeholder is worse than absence.
  if (coverage.length === 0) return null;

  const shown = coverage.slice(0, MAX_COVERAGE_SHOWN);
  const withheld = coverage.length - shown.length;
  const Heading = headingLevel === 3 ? "h3" : "h4";

  return (
    // amber-800 (#92400e) on amber-50 (#fffbeb) is 6.68:1, AA comfortably, and the right side
    // of AAA's 4.5:1 floor for small text at this size, which is where the reflexive amber-600
    // (#d97706, 2.98:1 here) would fail outright. The heading goes one step darker to amber-900
    // (#78350f, 9.03:1). The border repeats the boundary so the panel is still a panel on a
    // badly-calibrated wall display where the 50-level wash all but disappears.
    <section
      className={`rounded-lg border border-warn-border bg-warn-bg px-3 py-2.5 ${className}`}
      aria-labelledby={headingId}
    >
      <Heading id={headingId} className="text-xs font-semibold text-warn-text">
        What these numbers do not capture
      </Heading>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-warn-text">
        {shown.map((caveat, i) => (
          // Index keys: this list is replaced wholesale when a new snapshot arrives and has no
          // identity of its own, no reordering and no per-item state.
          <li key={i}>{caveat}</li>
        ))}
      </ul>
      {withheld > 0 && (
        <p className="mt-1.5 text-xs font-medium text-warn-text">
          {withheld} further {withheld === 1 ? "caveat is" : "caveats are"} recorded
          against this analysis and not shown here.
        </p>
      )}
    </section>
  );
}
