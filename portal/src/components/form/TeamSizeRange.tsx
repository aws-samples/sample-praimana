"use client";

/**
 * Min and max team size as ONE coupled control.
 *
 * The two numbers were previously disconnected inputs side by side, with nothing saying
 * they were related and nothing at all saying min ≤ max. A facilitator could set min 6 /
 * max 3 and the form would look perfectly happy about it.
 *
 * Three things fix that, and all three are needed:
 *   1. A plain-language read-out of the CONSEQUENCE ("Teams of 3 to 6 people"), so the
 *      operator never has to hold both numbers in their head to know what they chose.
 *   2. An inline error when min > max, wired to both inputs, stated as the rule.
 *   3. The service's own bounds shown as hints (min 2–6, max 2–10) rather than left to be
 *      discovered by rejection. These mirror the zod schema in the workshop router; they
 *      are HINTS, the server is the gate.
 *
 * The read-out uses tabular-nums so the digits do not shift the sentence's width as the
 * numbers change under the stepper, which is otherwise a small but real jitter directly
 * under the pointer.
 */
export function TeamSizeRange({
  min,
  max,
  onChange,
  /** Service bounds, mirrored from the create input schema. */
  minBound = { lo: 2, hi: 6 },
  maxBound = { lo: 2, hi: 10 },
}: {
  min: number;
  max: number;
  onChange: (next: { minTeamSize: number; maxTeamSize: number }) => void;
  minBound?: { lo: number; hi: number };
  maxBound?: { lo: number; hi: number };
}) {
  const inverted = min > max;
  const errorId = inverted ? "team-size-error" : undefined;

  const control =
    "w-full rounded-md border px-3 py-2 text-sm text-ink tabular-nums focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand";

  return (
    <div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="minTeamSize"
            className="mb-1.5 block text-sm font-medium text-ink-muted"
          >
            Smallest team
          </label>
          <input
            id="minTeamSize"
            type="number"
            inputMode="numeric"
            min={minBound.lo}
            max={minBound.hi}
            value={min}
            onChange={(e) =>
              onChange({
                minTeamSize: Number(e.target.value),
                maxTeamSize: max,
              })
            }
            aria-describedby={
              ["min-team-hint", errorId].filter(Boolean).join(" ") || undefined
            }
            aria-invalid={inverted || undefined}
            className={`${control} ${inverted ? "border-danger-field-border bg-danger-bg" : "border-field-border"}`}
          />
          <p id="min-team-hint" className="mt-1.5 text-xs text-ink-subtle">
            {minBound.lo}–{minBound.hi} people
          </p>
        </div>

        <div>
          <label
            htmlFor="maxTeamSize"
            className="mb-1.5 block text-sm font-medium text-ink-muted"
          >
            Largest team
          </label>
          <input
            id="maxTeamSize"
            type="number"
            inputMode="numeric"
            min={maxBound.lo}
            max={maxBound.hi}
            value={max}
            onChange={(e) =>
              onChange({
                minTeamSize: min,
                maxTeamSize: Number(e.target.value),
              })
            }
            aria-describedby={
              ["max-team-hint", errorId].filter(Boolean).join(" ") || undefined
            }
            aria-invalid={inverted || undefined}
            className={`${control} ${inverted ? "border-danger-field-border bg-danger-bg" : "border-field-border"}`}
          />
          <p id="max-team-hint" className="mt-1.5 text-xs text-ink-subtle">
            {maxBound.lo}–{maxBound.hi} people
          </p>
        </div>
      </div>

      {inverted ? (
        <p
          id={errorId}
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-text"
        >
          <span aria-hidden="true">✕</span>
          <span>
            The smallest team can&apos;t be larger than the largest. Set the
            smallest to {max} or fewer.
          </span>
        </p>
      ) : (
        /* role="status" so the read-out is announced when it settles, and the
           consequence is stated in the facilitator's words, not the schema's. */
        <p
          role="status"
          className="mt-3 rounded-md bg-surface-1 px-3 py-2 text-sm text-ink-subtle"
        >
          Teams of{" "}
          <span className="font-medium tabular-nums text-ink">{min}</span>{" "}
          to{" "}
          <span className="font-medium tabular-nums text-ink">{max}</span>{" "}
          {max === 1 ? "person" : "people"}.
          {min === max && " Every team will be exactly this size."}
        </p>
      )}
    </div>
  );
}
