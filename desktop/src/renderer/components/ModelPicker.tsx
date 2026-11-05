// ── ⚠ ONE MODEL PICKER, SHARED BY EVERY COMPOSER ──────────────────────────────────────────
//
// This lived inside `AssistantChatView.tsx` and was therefore available to Claude and Codex only — Kiro's composer is
// a different component (`KiroChatView.tsx`) and had no model control at all. Extracted rather than copied,
// for the reason already recorded next to `SendIcon`, which made the same journey for the same reason:
//
//     "⚠ `SendIcon` MOVED TO ITS OWN FILE so Kiro's composer can use the same one. Copying an 8-line SVG is
//      how two send buttons end up a stroke width apart."
//
// A duplicated picker is worse than a duplicated icon. The two copies would drift on the things that carry
// meaning — whether "default" is stated, whether the 1M badge appears, what happens when the list is empty —
// and each drift is a composer telling a participant something slightly untrue about which model is
// answering. That specific failure is the one this control already exists to prevent; see the note on the
// empty list below.
//
// ⚠ MOVED VERBATIM. The body is unchanged from the version that shipped in `AssistantChatView`, so nothing about
// Claude's or Codex's picker changes with this extraction — only who can import it.

import { resolveModel, type ModelOption } from "../lib/model-label";

export function ModelPicker({
  selectedModel,
  onSelect,
  options,
  defaultModel,
  disabled,
  dark,
}: {
  selectedModel: string;
  onSelect: (id: string) => void;
  options: ModelOption[];
  defaultModel: string;
  disabled?: boolean;
  dark: boolean;
}) {
  /**
   * ── ⚠ NOTHING TO OFFER MEANS NOTHING TO SHOW ──────────────────────────────────────────────
   *
   * `cli:getModels` read `~/.claude/settings.json` for EVERY assistant, so Codex was offered Claude's models
   * and the composer stated one of them as the model answering. That handler is now assistant-aware and
   * returns an empty list for anything but Claude — and this is the half that keeps the promise: with no
   * models and no default, the control disappears instead of rendering "Default" beside an assistant whose
   * model we genuinely do not know.
   *
   * A picker with nothing in it is worse than no picker: it invites a click that cannot change
   * anything.
   */
  if (options.length === 0 && !defaultModel) return null;

  /**
   * Resolved in a PURE module, not here. It has to reconcile a prefixed default
   * (`global.anthropic.claude-opus-5[1m]`) against an unprefixed list (`claude-opus-5[1m]`) — a real
   * mismatch in the live settings file, and the kind of thing that needs a test rather than a comment.
   */
  const model = resolveModel(selectedModel, defaultModel, options);

  return (
    /* `group/model` is what makes the hover border below reachable — a named group so it cannot be
        triggered by an unrelated ancestor's hover. */
    <div className="group/model relative flex items-center">
      {/*
        THE PAINTED ROW. `pointer-events-none` throughout so every click lands on the invisible select
        above it, and `aria-hidden` because that select already carries the accessible name and value —
        without it a screen reader would read the model twice, once as decoration.
      */}
      <div
        aria-hidden="true"
        className={`pointer-events-none flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
          dark
            ? disabled
              ? "border-transparent text-surface-faint"
              : "border-transparent text-surface-text group-hover/model:border-surface-line"
            : disabled
              ? "border-transparent text-surface-muted"
              : "border-transparent text-surface-text"
        }`}
      >
        {/*
          The brand spark. `brand-accent` is legal here because it is a GLYPH, not text — 5.68:1 on this
          surface, and the indicator floor is 3:1. Dimmed rather than hidden while a turn runs, so the row
          does not change shape when it becomes unavailable.
        */}
        <span className={`text-[11px] leading-none ${disabled ? "opacity-40" : "text-brand-accent"}`}>
          ✳
        </span>

        <span className="font-medium">{model.name}</span>

        {/*
          The 1M badge, shown ONLY for the extended-context variant. It is the single most consequential
          thing about a model choice in this app — a workshop turn that reads a large repository either
          fits or does not — and the old row could not express it at all.
        */}
        {model.extended && (
          <span
            className={`rounded px-1 text-[9px] font-semibold leading-[1.4] ${
              /*
                ⚠ `bg-orange-100` WAS A LITERAL TAILWIND ORANGE, the last one in the app — a light-theme
                leftover that tinted this badge amber while the dark variant used the brand hue.
                ⚠ AND THE OBVIOUS REPLACEMENT FAILED. `bg-blue-100` with `brand-strong` measures 4.24:1,
                under the 4.5:1 this 9px label needs — the same trap as the accent itself, where the
                plausible pick was a fraction short. `brand-dark` on the same chip is 5.49:1.
              */
              dark ? "bg-surface-raised text-brand-accent" : "bg-blue-100 text-brand-dark"
            }`}
          >
            1M
          </span>
        )}

        {model.tagline && (
          <span className="text-surface-muted">· {model.tagline}</span>
        )}

        {/*
          "default" is stated when nothing was explicitly chosen. "The default happens to be Opus 5" and "I
          chose Opus 5" are different facts, and a reader who cannot tell them apart cannot tell whether
          their selection took effect.
        */}
        {model.isDefault && (
          <span className={`text-[10px] ${dark ? "text-surface-faint" : "text-surface-muted"}`}>default</span>
        )}

        <span className={`text-[8px] leading-none text-surface-muted`}>▾</span>
      </div>

      {/*
        ⚠ THE REAL <select>, ON TOP, INVISIBLE.

        `opacity-0` and NOT `sr-only` or `hidden`: it must still occupy this exact box so it receives the
        clicks and shows the platform dropdown anchored here. Hiding it any other way would either move the
        menu to the corner of the window or stop it opening at all.
      */}
      <select
        value={selectedModel}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        aria-label="Model"
        className="absolute inset-0 w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      >
        {/*
          The default option NAMES the model rather than saying "Default", so the dropdown and the row
          beneath it agree — and so the choice is legible before it is made.
        */}
        <option value="">
          {resolveModel("", defaultModel, options).name} (default)
        </option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {/*
              Codex states its own one-liner per model ("Balanced agentic coding model for everyday work").
              Shown in the MENU and not in the row beneath it, which sits beside a counter and a keyboard
              hint and has no room — and which the reference screenshot keeps terse too ("5.5 High").
              Claude's options carry no tagline of their own, so nothing changes for them.
            */}
            {m.tagline ? ` — ${m.tagline}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
