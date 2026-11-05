/**
 * How an AI provider is NAMED and STYLED, in one place.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * The provider label was written inline as a two-way ternary in two separate places:
 *
 *     aiProvider.includes("kiro") ? "Kiro" : "Claude"
 *
 * With no Codex branch, so every Codex thread was labelled "Claude", while the ICON
 * beside it, written as a three-way chain in a third place, correctly showed the Codex
 * mark. Same value, same screen, two different answers.
 *
 * That is what a scattered ternary buys: adding a provider means finding every copy, and
 * the copies had already drifted. So the mapping lives here once, and the icon derives
 * from the same source as the name, they cannot disagree again.
 *
 * The stored values are the desktop's `ai_command` (`claude`, `kiro`, `kiro-cli`,
 * `codex`), passed through to `aiProvider` on the thread. Matching is substring-based and
 * case-insensitive because `kiro` and `kiro-cli` are both real, and a future
 * `claude-code` should not fall through to the unknown case.
 */

export interface AiProviderDisplay {
  /** Human name for the badge and the message author line. */
  label: string;
  /**
   * Tailwind classes for the badge.
   *
   * ⚠ ONE `series-*` HUE PER PROVIDER, and they must stay distinct, the badge exists to tell
   * Kiro from Codex from Claude at a glance, which is the definition of a categorical scale.
   * They were raw `orange-50/orange-600`, `blue-50/sky-600`, `purple-50/purple-600`, i.e. three
   * unrelated Tailwind hues that no rebrand could reach and that had never been contrast-checked.
   * The `/10` tint and the solid text now come from the SAME token, so they cannot drift apart.
   */
  badgeClass: string;
  /** Icon basename under /public/icons, `null` when we have no mark for it. */
  icon: string | null;
}

/**
 * Order matters: `kiro-cli` must be tested before any shorter prefix that could also
 * match it. Checked longest-first below for that reason.
 */
const PROVIDERS: Array<{ match: string; display: AiProviderDisplay }> = [
  {
    match: "kiro",
    display: {
      label: "Kiro",
      badgeClass: "bg-series-6/10 text-series-6",
      icon: "kiro",
    },
  },
  {
    match: "codex",
    display: {
      label: "Codex",
      badgeClass: "bg-series-7/10 text-series-7",
      icon: "codex",
    },
  },
  {
    match: "claude",
    display: {
      label: "Claude",
      badgeClass: "bg-series-1/10 text-series-1",
      icon: "claude",
    },
  },
];

/**
 * An unrecognised provider is named honestly rather than guessed at.
 *
 * The old code's `: "Claude"` fallback is exactly how Codex ended up mislabelled, a
 * default that looks like data. A value we do not recognise gets a neutral badge and no
 * icon, so a new assistant shows up as unfamiliar instead of as the wrong one.
 */
const UNKNOWN: AiProviderDisplay = {
  label: "Assistant",
  badgeClass: "bg-surface-2 text-ink-subtle",
  icon: null,
};

/** Resolve a stored `aiProvider` to its display. Null/absent → generic, never "Claude". */
export function aiProviderDisplay(aiProvider?: string | null): AiProviderDisplay {
  if (!aiProvider) return UNKNOWN;
  const v = aiProvider.trim().toLowerCase();
  if (!v) return UNKNOWN;
  for (const p of PROVIDERS) {
    if (v.includes(p.match)) return p.display;
  }
  return UNKNOWN;
}
