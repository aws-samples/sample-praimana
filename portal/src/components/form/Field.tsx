import type { ReactNode } from "react";

/**
 * Label + hint + error scaffolding for ONE control, with the accessible wiring done
 * once instead of per field.
 *
 * The same job AuthField does for the auth screens, but as a WRAPPER rather than an
 * <input>, the Create Experience form needs the identical treatment around a <select>,
 * a <textarea>, a number pair and a phase list, and AuthField can only render an input.
 * Deliberately mirrors AuthField's markup, class names and error colours so the two
 * surfaces stay one visual language.
 *
 * The render-prop hands back the ids the control MUST adopt. Passing them back rather
 * than cloning the child is what makes the association impossible to forget: the caller
 * cannot render the control without being handed `describedBy`, and a hint or error that
 * is on screen but not announced is the failure mode this component exists to prevent.
 */
export function Field({
  id,
  label,
  hint,
  error,
  /** Right-aligned counterweight to the label, a character counter, a unit, "Optional". */
  labelAside,
  /** Renders the label as a <span> inside a group instead of a <label>. Use when the
   *  "field" is a set of controls (a fieldset) rather than one focusable element. */
  as = "label",
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  labelAside?: ReactNode;
  as?: "label" | "span";
  children: (ids: {
    id: string;
    describedBy: string | undefined;
    invalid: true | undefined;
  }) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const labelText = (
    <span className="text-sm font-medium text-ink-muted">{label}</span>
  );

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        {as === "label" ? (
          <label htmlFor={id}>{labelText}</label>
        ) : (
          labelText
        )}
        {labelAside}
      </div>

      {children({ id, describedBy, invalid: error ? true : undefined })}

      {hint && (
        <p id={hintId} className="mt-1.5 text-xs leading-relaxed text-ink-subtle">
          {hint}
        </p>
      )}
      {error && (
        /* role="alert" so a validation message that appears AFTER the user has moved
           on is announced rather than sitting there silently. Paired with the ✕ glyph
           and the red border: colour is never the only carrier. */
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 flex items-start gap-1 text-xs text-danger-text-strong"
        >
          <span aria-hidden="true">✕</span>
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The one text-input class string for this form family, so a field cannot drift from
 * its neighbours. `focus:ring-2` (not the `ring-1` the old form used) because a 1px
 * ring on a 1px border is not a visible focus indicator at arm's length, this matches
 * AuthField and /profile, which already moved to ring-2.
 */
export const CONTROL_CLASS =
  "w-full rounded-md border border-field-border px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand";

/** CONTROL_CLASS plus the invalid treatment, red border AND a tinted fill, so the
 *  error is legible without relying on hue discrimination. */
export function controlClass(invalid?: boolean) {
  return invalid
    ? `${CONTROL_CLASS.replace("border-field-border", "border-danger-field-border")} bg-danger-bg`
    : CONTROL_CLASS;
}
