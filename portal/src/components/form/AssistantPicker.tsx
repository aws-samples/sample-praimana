"use client";

import type { AssistantId, AssistantDefinition } from "@praimana/shared";

/**
 * Which coding assistants participants may use.
 *
 * The toggle rows are kept almost exactly as they were, `role="switch"` + `aria-checked`
 * + a per-row `aria-label` was already correct, and the icon/greyscale treatment is the
 * one thing on the old form that already read well. Two changes only:
 *
 *   1. The "at least one" rule is stated UP FRONT as a hint, not only after the user has
 *      turned the last one off. An error you could have prevented is worse than a hint
 *      nobody needed.
 *   2. When the rule IS broken, the message is a bordered alert wired to the group via
 *      aria-describedby, and the count is shown in the section heading, so "how many are
 *      on" is answerable without counting rows.
 *
 * `fieldset`/`legend` because this is one decision made of several controls; the legend is
 * visually hidden since FormSection already renders the visible heading, and two identical
 * titles is noise for a screen-reader user.
 */
export function AssistantPicker({
  assistants,
  enabled,
  onToggle,
  describedBy,
}: {
  assistants: readonly AssistantDefinition[];
  enabled: AssistantId[];
  onToggle: (id: AssistantId) => void;
  describedBy?: string;
}) {
  const none = enabled.length === 0;

  return (
    <fieldset aria-describedby={describedBy}>
      <legend className="sr-only">AI assistants available to participants</legend>

      <div className="space-y-2">
        {assistants.map((a) => {
          const on = enabled.includes(a.id as AssistantId);
          return (
            <div
              key={a.id}
              className={`flex items-center justify-between rounded-lg border p-3 ${
                on ? "border-brand-border bg-surface-3" : "border-hairline bg-surface-1"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.img}
                  alt=""
                  aria-hidden="true"
                  className={`h-7 w-7 shrink-0 rounded-full ${on ? "" : "opacity-40 grayscale"}`}
                />
                <div className="min-w-0">
                  <div
                    className={`truncate text-sm font-medium ${on ? "text-ink" : "text-ink-subtle"}`}
                  >
                    {a.name}
                  </div>
                  {/* The state in WORDS as well as in the switch position and colour.
                      gray-600 not gray-400: this is the text that says what the control
                      is doing, and it failed AA at 400 on a white surface. */}
                  <div className="text-xs text-ink-subtle">
                    {on ? "Available to participants" : "Not available"}
                  </div>
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${on ? "Disable" : "Enable"} ${a.name}`}
                onClick={() => onToggle(a.id as AssistantId)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 ${
                  on ? "bg-brand" : "bg-ink-tertiary"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-surface-3 shadow transition-transform ${
                    on ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>

      {none && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-text"
        >
          <span aria-hidden="true">✕</span>
          <span>
            Turn on at least one assistant. With none enabled, participants
            would have no AI tooling in the desktop app.
          </span>
        </p>
      )}
    </fieldset>
  );
}
