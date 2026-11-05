// ── APPLYING THE THEME TO THE DOCUMENT ───────────────────────────────────────────────────
//
// The main process decides light or dark (see `main/theme-mode.ts`); this puts the answer where CSS can
// see it. `index.css` defines the dark palette on `:root` and the light one on `[data-theme="light"]`, so
// the entire app re-colours from one attribute.
//
// ── ⚠ WHY THE ATTRIBUTE IS SET FOR BOTH MODES, NOT JUST LIGHT ──
//
// Dark is the `:root` default, so `data-theme="dark"` is technically unnecessary — removing the attribute
// would do. It is written anyway, because "no attribute" and "dark" then become indistinguishable to
// anything inspecting the DOM: a test, a screenshot tool, or a future `[data-theme="dark"]` rule that
// silently never matches. The attribute always states the resolved mode.

export type ResolvedTheme = "light" | "dark";
export type ThemeMode = "light" | "dark" | "system";

export const THEME_ATTRIBUTE = "data-theme";

/**
 * Write the resolved theme onto `<html>`.
 *
 * ⚠ ON `documentElement`, NOT `body`. The custom properties have to be in scope for everything that reads
 * them, and `body`'s own `background-color` is one of those readers — scoping the variables to `body`
 * would leave its background resolving against `:root`, i.e. permanently dark.
 */
export function applyTheme(resolved: ResolvedTheme, root: HTMLElement): void {
  root.setAttribute(THEME_ATTRIBUTE, resolved);
  /**
   * ⚠ `color-scheme` IS NOT COSMETIC. It tells the engine which built-ins to use for things this app does
   * not style: scrollbars, the caret's default colour, `<select>` popups and form controls. Without it a
   * light theme keeps dark scrollbars and a dark `<select>` menu, which reads as a rendering fault rather
   * than a theme.
   */
  root.style.colorScheme = resolved;
}

/**
 * The label a participant reads for each mode.
 *
 * ⚠ "Auto" AND NOT "System", because the row beneath it already says what it follows ("matches your
 * machine"). Two words for one idea, one of them jargon, is how a setting ends up needing a tooltip.
 */
export const THEME_LABELS: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "Auto",
};

/** The one-line explanation under each choice. Only Auto genuinely needs one; the others get parity. */
export const THEME_HINTS: Record<ThemeMode, string> = {
  light: "Always light.",
  dark: "Always dark.",
  system: "Matches your machine.",
};
