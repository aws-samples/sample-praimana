"use client";

import type { ReactNode } from "react";

/**
 * ── THE ROW VOCABULARY, EXTRACTED FROM /experiences ─────────────────────────────────────────
 *
 * The experiences list was redesigned from a three-card grid into aligned dense rows, and the
 * three reasons it needed to be are not specific to workshops:
 *
 *   1. `flex … justify-between` LAYS OUT EACH ROW INDEPENDENTLY, so a value in the third slot
 *      lands at a different x in every row and a column cannot be scanned, only read. Every
 *      list in this product had that shape: the eight admin tabs, the team directory, the
 *      submissions list.
 *   2. PROPORTIONAL FIGURES DO NOT ALIGN. "6 teams" over "12 teams" over "4 teams" is ragged
 *      on the digit without `tabular-nums`, which is the single setting that makes a column of
 *      numbers read as a column.
 *   3. A CENTRED "Loading…" THROWS THE LAYOUT AWAY and the page jumps when data arrives.
 *
 * ── ⚠ THE LIST IS ONE BORDERED PANEL; THE ROWS ARE NOT BORDERED BOXES ───────────────────────
 *
 * REPORTED: rows had "a thick border on the left but no right border, and the top row is missing
 * both". That was exactly true and it was a design gap rather than a rendering bug: the list drew
 * only `border-y` plus dividers, so there were no vertical edges anywhere, which left the admin
 * user row's 4px `border-l` STATUS marker (the "no access" edge) as the only vertical border on
 * screen. It read as a half-drawn box.
 *
 * The fix is deliberately NOT "border every row on four sides". That is a stack of forty cards,
 * which is the exact treatment these lists were converted away from: card elevation claims a
 * hierarchy homogeneous rows do not have, and the gaps and borders cost an operator rows per
 * screen on the densest lists in the product.
 *
 * Bordering the COLLECTION instead gives every row a left and a right edge (the panel's), gives
 * the first row a top edge and the last a bottom, keeps one hairline between any two rows, and
 * puts the status marker back INSIDE a frame where it reads as a status again.
 *
 * `overflow-hidden` is load-bearing with `rounded-xl`: without it the first and last rows' own
 * backgrounds (a hover, or the tinted surface of a deactivated account) square off the corners the
 * panel just rounded.
 *
 * ⚠ THIS IS A VOCABULARY, NOT A TABLE COMPONENT, and that is a deliberate limit. A generic
 * `<DataTable columns={…}>` would have to absorb every list's differences, expandable detail,
 * per-row action buttons, disabled states, multi-line cells, and each new caller would either
 * bend the API or bypass it. What every list genuinely shares is the GRID TRACK and the
 * skeleton that has to match it, so that is what is shared. Callers keep their own markup.
 */

/**
 * The grid track for a row, as a STATIC class plus a per-list CSS variable.
 *
 * ⚠ THIS CANNOT BE A TEMPLATE STRING, and the first version of it was. `md:grid-cols-[${cols}]`
 * looks obvious and produces NOTHING: Tailwind generates utilities by scanning source text for
 * literal class names, so a value composed at runtime is never emitted. The rows would have
 * collapsed to a single column with no error anywhere, the same class of silent failure as a
 * token that resolves to `transparent`.
 *
 * A literal `md:grid-cols-[var(--row-cols)]` IS in the source, so it is generated; the actual
 * track is then supplied per list as an inline custom property. That also keeps the media query,
 * which an inline `gridTemplateColumns` could not express at all.
 *
 * ⚠ USE `minmax(0,1fr)` FOR THE FLEXIBLE COLUMN, NEVER A BARE `1fr`. `1fr` carries
 * `min-width:auto`, so one long unbroken name refuses to shrink and shoves every other column off
 * the right edge instead of truncating. It is one of two ways an aligned grid silently stops being
 * aligned.
 *
 * ⚠ AND NEVER PUT `auto` IN A TRACK. That is the other way, and it is the one that shipped.
 * EACH ROW IS ITS OWN GRID, the `<li>` carries the `display: grid`, because it also needs a hover
 * background and per-row state styling, and a `display: contents` row can hold neither. So columns
 * line up across rows only because every row resolves the SAME track to the same widths. An `auto`
 * track resolves against its own row's content, so one row with a longer value in that column gets
 * a narrower flexible column than its neighbours and every boundary before it shifts.
 *
 * It surfaced on the admin Users tab: the signed-in operator's own row carries a longer
 * explanation than any other ("This is you, so you cannot change your own access"), its `auto`
 * action column grew, and its role badge sat left of the column every other row formed. Give every
 * non-flexible track a fixed width and let its content wrap or truncate inside it.
 *
 * ⚠ CROSS-AXIS ALIGNMENT IS NOT INCLUDED. Real rows want `md:items-baseline` so text sits on one
 * baseline; a skeleton cannot, because an empty box's baseline is its bottom margin edge, so
 * `items-baseline` aligns placeholder bars by their bottoms and drops them out of line. Each
 * caller states its own, see `SkeletonRows`, which uses `md:items-center`.
 *
 * Below `md` the grid is one column: four numeric columns cannot align in 375px.
 */
export const ROW_GRID =
  "grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-3.5 md:grid-cols-[var(--row-cols)]";

/** The per-list track, e.g. `rowCols("8rem minmax(0,1fr) 6rem 5rem")`. */
export function rowCols(columns: string): React.CSSProperties {
  return { "--row-cols": columns } as React.CSSProperties;
}

/**
 * The three states a lifecycle can be in, as tones rather than as colours.
 *
 * ⚠ THREE TONES, NOT ONE PER STATE. Admin painted six workshop statuses and five roles in six
 * and five distinct hues, which is a rainbow that tells an operator nothing at a glance: to use
 * it they had to learn the key. Collapsing to "live / needs action / finished" means the colour
 * carries the only question a scan is asking, and the LABEL beside it carries the specifics.
 * `--status-*` in globals.css holds the values; all three are contrast-checked.
 */
export type StatusTone = "active" | "pending" | "idle";

const TONE_DOT: Record<StatusTone, string> = {
  active: "bg-status-active",
  pending: "bg-status-pending",
  idle: "bg-status-idle",
};

/**
 * A status dot with its label.
 *
 * ⚠ THE LABEL IS NOT OPTIONAL, and that is the point of making this a component. A bare
 * coloured dot is meaningless without a key, and it is invisible to a screen reader entirely -
 * the original experiences list shipped three colours and no words. The dot is `aria-hidden`
 * because the text beside it already says everything the dot does.
 */
export function StatusDot({
  tone,
  label,
  className = "",
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      <span className="truncate text-xs text-ink-subtle">{label}</span>
    </span>
  );
}

/**
 * Placeholder rows on the same grid the real rows will use.
 *
 * ⚠ IT TAKES THE SAME `columns` STRING AS THE REAL LIST, which is the entire reason this is
 * shared rather than hand-written per screen. A skeleton whose geometry differs from the loaded
 * state is not a skeleton, it is a second layout that the page jumps out of, the exact defect
 * it exists to remove.
 *
 * ⚠ `aria-hidden` ON THE BARS PLUS ONE LIVE REGION. Without it a screen reader announces a dozen
 * empty divs; with it the user hears the label once. The count defaults to 3: enough to read as
 * "a list is coming", few enough not to imply a queue to someone who has one item.
 */
export function SkeletonRows({
  columns,
  rows = 3,
  label = "Loading",
}: {
  columns: string;
  rows?: number;
  label?: string;
}) {
  return (
    <>
      <p className="sr-only" role="status">
        {label}
      </p>
      <ul aria-hidden="true" className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
        {Array.from({ length: rows }, (_, row) => (
          <li
            key={row}
            style={rowCols(columns)}
            className={`${ROW_GRID} animate-pulse md:items-center`}
          >
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-surface-3" />
              <span className="h-3 w-20 rounded bg-surface-3" />
            </span>
            <span className="min-w-0">
              {/* Widths vary per row so it reads as text rather than as a progress bar, and so
                  it does not imply every name is the same length. */}
              <span
                className="block h-3.5 rounded bg-surface-3"
                style={{ width: `${58 - row * 9}%` }}
              />
            </span>
            <span className="hidden h-3 rounded bg-surface-3 md:block" />
            <span className="hidden h-3 rounded bg-surface-3 md:block" />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A person's initial in a circle.
 *
 * Three copies of this existed, the admin user row, the chat author line and the team
 * directory, each with its own size, its own colour pair and its own answer to "what if the
 * name is empty". They are one thing.
 *
 * ⚠ `aria-hidden`, ALWAYS. An avatar built from a name's first letter tells a screen reader
 * nothing that the adjacent name does not, and "A" read aloud before every row is noise. Callers
 * must render the name as text; this is decoration for the eye only.
 */
export function InitialAvatar({
  name,
  size = "md",
  muted = false,
}: {
  name: string | null | undefined;
  size?: "sm" | "md";
  /** Deactivated accounts: the avatar recedes rather than carrying the brand. */
  muted?: boolean;
}) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const box = size === "sm" ? "h-8 w-8 text-xs" : "h-9 w-9 text-sm";
  return (
    <span
      aria-hidden="true"
      className={`${box} grid shrink-0 place-items-center rounded-full font-medium ${
        muted ? "bg-surface-2 text-ink-subtle" : "bg-brand-subtle text-brand-text"
      }`}
    >
      {initial}
    </span>
  );
}

/**
 * A section heading at Linear's `headline` step.
 *
 * The tracking is the point rather than the size: at display sizes default Inter spacing is most
 * of what makes a heading read as a default. `text-2xl font-bold` was used on ten screens; this
 * is the one place that decision now lives.
 */
export function SectionHeading({
  children,
  description,
  level = 2,
}: {
  children: ReactNode;
  description?: ReactNode;
  /** `1` only where nothing above the page already owns the document's h1. */
  level?: 1 | 2;
}) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <div>
      <Tag className="text-[28px] font-semibold tracking-heading-tight">{children}</Tag>
      {description && (
        <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-ink-subtle text-pretty">
          {description}
        </p>
      )}
    </div>
  );
}
