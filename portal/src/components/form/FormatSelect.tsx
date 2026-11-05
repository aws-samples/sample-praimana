"use client";

/**
 * The Format dropdown, with all four of its states rendered as DIFFERENT things.
 *
 * This control is the reported bug. It used to render one shape for every outcome: a
 * <select> that was populated when the fetch worked and silently, operably EMPTY when it
 * did not. An empty-but-clickable dropdown is the worst possible failure here, it looks
 * like a working control that happens to have nothing in it, so the operator concludes
 * the platform has no formats rather than that something broke.
 *
 * The four states, and why each looks the way it does:
 *
 *   LOADING    A disabled <select> holding "Loading formats…", at the SAME height and in
 *              the same position as the real one. Not a spinner and not an absent
 *              element: the row must not change height when the data lands, because a
 *              form that reflows under the pointer is how a mis-click happens.
 *   POPULATED  A real <select> whose first option is an unselectable placeholder, so an
 *              unchosen format is VISIBLY unchosen and `required` can catch it.
 *   EMPTY      The call SUCCEEDED and returned nothing. Amber, with a warning glyph,
 *              stating that the catalogue is unseeded and who fixes it. Never a blank
 *              control.
 *   ERROR      The call FAILED. Red, with a Retry that re-runs the query rather than
 *              suggesting a page reload, which would discard everything else typed.
 *
 * EMPTY and ERROR are deliberately different colours AND different glyphs AND different
 * words, because they have different remedies: one needs an administrator to seed the
 * lookup table, the other needs a retry. Collapsing them into "no formats" is what hid
 * this bug in the first place.
 */
export function FormatSelect({
  value,
  onChange,
  formats,
  isLoading,
  isError,
  onRetry,
  id = "format",
  describedBy,
}: {
  value: string;
  onChange: (value: string) => void;
  formats: { name: string; value: string }[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  id?: string;
  describedBy?: string;
}) {
  const selectClass =
    "w-full rounded-md border border-field-border bg-surface-3 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand disabled:bg-surface-1 disabled:text-ink-tertiary";

  if (isLoading) {
    return (
      <select
        id={id}
        disabled
        aria-busy="true"
        aria-describedby={describedBy}
        className={selectClass}
      >
        <option>Loading formats…</option>
      </select>
    );
  }

  if (isError) {
    return (
      <div
        role="alert"
        className="rounded-md border border-danger-border bg-danger-bg px-3 py-3"
      >
        <p className="flex items-start gap-1.5 text-sm font-medium text-danger-text">
          <span aria-hidden="true">✕</span>
          <span>Couldn&apos;t load the format list.</span>
        </p>
        <p className="mt-1 pl-5 text-xs text-danger-text">
          Nothing you&apos;ve typed has been lost. Retry, if it keeps failing,
          the workshop service may be unavailable.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="ml-5 mt-2 rounded-md border border-danger-field-border bg-surface-3 px-3 py-1.5 text-xs font-semibold text-danger-text hover:bg-danger-bg focus:outline-none focus:ring-2 focus:ring-danger-text"
        >
          Retry
        </button>
      </div>
    );
  }

  if (formats.length === 0) {
    return (
      <div
        role="alert"
        className="rounded-md border border-warn-border bg-warn-bg px-3 py-3"
      >
        <p className="flex items-start gap-1.5 text-sm font-medium text-warn-text">
          <span aria-hidden="true">⚠</span>
          <span>No formats have been set up yet.</span>
        </p>
        <p className="mt-1 pl-5 text-xs text-warn-text">
          The format catalogue is empty, so an experience can&apos;t be created
          until an administrator adds at least one format. This isn&apos;t a
          problem with anything you did.
        </p>
      </div>
    );
  }

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required
      aria-describedby={describedBy}
      className={selectClass}
    >
      {/* disabled, so the placeholder can be the initial value but cannot be chosen
          BACK once a real format is picked. */}
      <option value="" disabled>
        Select a format…
      </option>
      {formats.map((f) => (
        <option key={f.value} value={f.value}>
          {f.name}
        </option>
      ))}
    </select>
  );
}
