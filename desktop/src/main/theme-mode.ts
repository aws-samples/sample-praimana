// ── THE THEME MODE: LIGHT, DARK, OR WHATEVER THE MACHINE SAYS ────────────────────────────
//
// Three values, and `system` is the interesting one: it is not a colour, it is a DEFERRAL. The
// participant is saying "ask the OS", so the mode has to be re-resolved whenever the OS changes its
// mind — which is why the main process owns this and pushes the result, rather than the renderer
// reading a media query once at startup.
//
// ── ⚠ WHY THIS MODULE HAS NO `electron` IMPORT ──
//
// Everything here is a pure decision over strings and one boolean. The Electron side is `handlers/theme.ts`,
// which is a thin shell around these functions. That split is what makes the rules testable without a
// display, and the rules are where the mistakes live — a stored value from a future build, a missing
// setting on a fresh install, an OS that reports light while the participant chose dark.

/** What the participant can choose. `system` defers to the OS. */
export type ThemeMode = "light" | "dark" | "system";

/** What the DOM ends up wearing. `system` never reaches this — it is resolved first. */
export type ResolvedTheme = "light" | "dark";

export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

/**
 * ⚠ THE DEFAULT IS `system`, AND THAT IS A DELIBERATE BEHAVIOUR CHANGE.
 *
 * This app shipped dark-only, so every existing install has no `theme_mode` setting at all. Defaulting to
 * `dark` would preserve exactly what they see today; defaulting to `system` means a participant whose
 * machine is in light mode opens the app and finds it light for the first time.
 *
 * `system` is chosen because it follows the participant's machine and is what every comparable
 * app does — but the consequence is named here rather than discovered: the change is visible on first
 * launch after updating, and one click in Settings pins it back to Dark for good.
 */
export const DEFAULT_THEME_MODE: ThemeMode = "system";

/**
 * Validate a stored mode.
 *
 * ⚠ ANYTHING UNRECOGNISED FALLS BACK RATHER THAN THROWING. The stored string outlives the build that
 * wrote it: a value from a future version, a hand-edited settings row, or a typo must not leave the app
 * with no theme at all. `null` (never set) and `"sepia"` (never valid) get the same treatment, because
 * the app's obligation is identical in both cases — render something correct.
 */
export function readThemeMode(stored: string | null | undefined): ThemeMode {
  return THEME_MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : DEFAULT_THEME_MODE;
}

/**
 * Turn a mode plus the OS's current preference into the theme actually rendered.
 *
 * ⚠ AN EXPLICIT CHOICE WINS OVER THE OS, always. That is the whole reason this is a three-value setting
 * and not a boolean: "dark" means dark on a machine set to light. Reading `prefers-color-scheme` in CSS
 * would invert that, which is why the stylesheet uses an attribute this function decides.
 */
export function resolveTheme(mode: ThemeMode, osPrefersDark: boolean): ResolvedTheme {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return osPrefersDark ? "dark" : "light";
}

/**
 * Electron's `nativeTheme.themeSource` accepts exactly these three strings, and they happen to match
 * ours — so this is an identity today. It exists so the coupling is stated: if either vocabulary ever
 * changes, one function fails rather than a silent mismatch that leaves `themeSource` on its default and
 * the native chrome (dialogs, scrollbars, the title bar) disagreeing with the app.
 */
export function nativeThemeSource(mode: ThemeMode): "light" | "dark" | "system" {
  return mode;
}
