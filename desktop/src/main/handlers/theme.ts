// ── THE ELECTRON SIDE OF THE THEME MODE ──────────────────────────────────────────────────
//
// A thin shell over `main/theme-mode.ts`, which owns every decision. This file only talks to Electron
// and to the settings table.
//
// ── ⚠ WHY THE MAIN PROCESS OWNS THE THEME AT ALL ──
//
// The renderer could read `prefers-color-scheme` itself, and that would be simpler and wrong in two ways:
//
//   1. `nativeTheme.themeSource` ALSO drives the native chrome — file dialogs, scrollbars, the traffic
//      lights' backdrop. Set only in CSS, a participant on Dark would get a light native file picker in
//      the middle of a dark app.
//   2. A media query cannot express "the participant chose dark on a light machine". The setting has three
//      values and only one of them defers to the OS, so the resolution has to happen where the setting is
//      read.
//
// So main resolves and PUSHES; the renderer applies what it is told. Same shape as the team event stream.

import { ipcMain, nativeTheme, BrowserWindow } from "electron";
import { readSetting, writeSetting } from "../database";
import {
  readThemeMode,
  resolveTheme,
  nativeThemeSource,
  DEFAULT_THEME_MODE,
  THEME_MODES,
  type ThemeMode,
} from "../theme-mode";
import { debugLog } from "../debug-log";

const SETTING_KEY = "theme_mode";

/** Current mode from settings, validated. */
function currentMode(): ThemeMode {
  return readThemeMode(readSetting(SETTING_KEY));
}

/** The mode plus what it resolves to right now, which is what every caller actually wants. */
function state(): { mode: ThemeMode; resolved: "light" | "dark" } {
  const mode = currentMode();
  return { mode, resolved: resolveTheme(mode, nativeTheme.shouldUseDarkColors) };
}

/** Send a resolved payload to every live window. Split from `broadcast` so the chooser path, which
 *  cannot read the settings table, can push its own state through the same channel. */
function push(payload: { mode: ThemeMode; resolved: "light" | "dark" }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("theme:changed", payload);
  }
}

function broadcast(): void {
  push(state());
}

/**
 * Apply the stored mode to Electron itself.
 *
 * ⚠ CALLED AT STARTUP AS WELL AS ON CHANGE, and that is not redundant: `themeSource` defaults to
 * `"system"` on every launch, so an install pinned to Light would get light CSS (the renderer reads the
 * setting) and system-coloured native dialogs until the participant touched the control again.
 */
function applyToElectron(mode: ThemeMode): void {
  nativeTheme.themeSource = nativeThemeSource(mode);
}

/**
 * ── ⚠ THE PROFILE CHOOSER'S THEME, WITHOUT A DATABASE ────────────────────────────────────
 *
 * The chooser runs before any profile is chosen, so `index.ts` returns early and registers only the
 * `profile:*` handlers — `setupThemeHandlers` is past that return. But `main.tsx` calls `theme:get`
 * before `createRoot` for BOTH roots, because an effect inside `App` would leave the picker
 * permanently dark and would flash the wrong palette on every launch. So main logged a missing
 * handler on every chooser launch, the renderer's try/catch swallowed it, and the picker fell back to
 * dark — cosmetically wrong on a light machine, which `main.tsx` already conceded in a comment.
 *
 * ⚠ MOVING `setupThemeHandlers` ABOVE THE EARLY RETURN DOES NOT WORK, and would look like it did.
 * `state()` → `currentMode()` → `readSetting()` calls `db.prepare(...)` on a module-level `db` that is
 * still undefined in chooser mode, so the handler would throw a TypeError instead of being absent:
 * the same broken outcome with a less honest error. Hence a separate, deliberately database-free
 * registration.
 *
 * ⚠ `mode` IS REPORTED AS `system`, AND THAT IS THE TRUTH RATHER THAN A PLACEHOLDER. `theme_mode` is a
 * PER-PROFILE setting, so before a profile is chosen there is no stored preference to honour — "ask
 * the OS" is the only meaningful answer, and it is already `DEFAULT_THEME_MODE`.
 *
 * ⚠ MUTUALLY EXCLUSIVE WITH `setupThemeHandlers`. Both register `theme:get`, and Electron throws on a
 * second handler for one channel. This is called ONLY inside the `launch.showChooser` branch, which
 * returns before `setupThemeHandlers()` is reached. Do not call it anywhere else.
 *
 * No `theme:set`: there is no settings table to persist to, and a preference chosen with no profile
 * selected would have nowhere to belong. No `theme:modes` either — the picker renders no theme
 * control, only the app's Settings screen does.
 */
export function setupChooserThemeHandlers(): void {
  const chooserState = (): { mode: ThemeMode; resolved: "light" | "dark" } => ({
    mode: DEFAULT_THEME_MODE,
    resolved: resolveTheme(DEFAULT_THEME_MODE, nativeTheme.shouldUseDarkColors),
  });

  // `nativeTheme.themeSource` already defaults to "system" on every launch, so there is deliberately
  // no `applyToElectron` call here: with no stored preference there is nothing to pin it to, and
  // setting it to its own default would be a no-op dressed up as a decision.

  // The OS can flip while the picker is open (macOS does it on a schedule). `main.tsx` registers its
  // `theme:changed` listener at module scope for both roots, so the chooser follows it for free.
  nativeTheme.on("updated", () => {
    const next = chooserState();
    debugLog(`[theme] os updated (chooser) — resolved=${next.resolved}`);
    push(next);
  });

  ipcMain.handle("theme:get", async () => chooserState());
}

export function setupThemeHandlers(): void {
  applyToElectron(currentMode());

  /**
   * ⚠ THE OS CHANGED ITS MIND. Only meaningful while the mode is `system`, but the listener is attached
   * unconditionally: Electron fires this for an explicit `themeSource` change too, and re-broadcasting the
   * same resolved value is harmless where missing a real OS flip is not. macOS fires it on the
   * light/dark schedule, which is exactly the case a startup-only read would never see.
   */
  nativeTheme.on("updated", () => {
    const next = state();
    debugLog(`[theme] os updated — mode=${next.mode} resolved=${next.resolved}`);
    broadcast();
  });

  /** What to render, and what the participant chose. The renderer needs both: one to apply, one to tick. */
  ipcMain.handle("theme:get", async () => state());

  ipcMain.handle("theme:set", async (_event, params: { mode?: unknown }) => {
    /**
     * ⚠ VALIDATED HERE, NOT TRUSTED FROM THE RENDERER. `readThemeMode` coerces anything unrecognised to
     * the default, so a bad value cannot be persisted and cannot reach `nativeTheme.themeSource`, which
     * throws on an unknown string and would take the window down with it.
     */
    const mode = readThemeMode(typeof params?.mode === "string" ? params.mode : null);
    writeSetting(SETTING_KEY, mode);
    applyToElectron(mode);

    /**
     * ⚠ BROADCAST RATHER THAN RETURNED-ONLY, so a SECOND window in the same profile follows. Two windows
     * share one settings table, so one of them changing the theme while the other stayed dark would be a
     * profile disagreeing with itself. The return value is for the caller's own immediate update.
     */
    broadcast();
    return state();
  });

  /** The list the Settings control renders, so the UI cannot offer a mode main would reject. */
  ipcMain.handle("theme:modes", async () => ({ modes: [...THEME_MODES] }));
}
