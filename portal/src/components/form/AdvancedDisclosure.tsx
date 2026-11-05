"use client";

import type { ReactNode } from "react";

/**
 * A collapsed "advanced" region for controls a facilitator should be able to IGNORE.
 *
 * The Developer Setup Config, a repo URL, a branch, a guide link and a raw JSON blob -
 * is not facilitator work. It ships with sensible defaults, it is editable afterwards on
 * the workshop's Settings page, and a facilitator who has never seen it should be able to
 * create a working experience without opening it. But it must stay reachable: some
 * operator genuinely needs the escape hatch, so hiding it behind a role check would trade
 * one broken workflow for another.
 *
 * So: collapsed by default, labelled with what it is FOR and what happens if you leave it
 * alone, and marked as having defaults already applied. The point of the summary line is
 * that a facilitator can decide NOT to open this in about two seconds.
 *
 * A <button> + conditional render rather than <details>/<summary>: the app has no
 * <details> anywhere, and the native element's open state is not controllable, which
 * matters here because the section must FORCE ITSELF OPEN when the JSON inside it is
 * invalid, an error hidden inside a collapsed panel is an error nobody can fix.
 */
export function AdvancedDisclosure({
  id,
  title,
  summary,
  open,
  onToggle,
  /** Shown next to the title when closed, e.g. "Defaults applied" or an error count. */
  badge,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-3">
      <h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          className="flex w-full items-center gap-3 rounded-xl px-5 py-4 text-left hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
        >
          {/* A rotated caret, not a swapped ▸/▾ glyph: the character swap changed the
              element's width and nudged the title sideways on every toggle. */}
          <span
            aria-hidden="true"
            className={`shrink-0 text-xs text-ink-subtle transition-transform ${open ? "rotate-90" : ""}`}
          >
            ▶
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">{title}</span>
              {badge}
            </span>
            <span className="mt-0.5 block text-xs text-ink-subtle">{summary}</span>
          </span>
        </button>
      </h2>

      {/* Conditional render rather than a `hidden` class: the JSON textarea inside is
          expensive to keep mounted for no reason, and a collapsed panel's controls must
          not be in the tab order. */}
      {open && (
        <div id={`${id}-panel`} className="border-t border-hairline px-5 py-4">
          {children}
        </div>
      )}
    </div>
  );
}
