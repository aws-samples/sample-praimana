// ── THE THEME RESOLVER: THREE MODES, ONE OS SIGNAL, ONE RENDERED RESULT ───────────────────
//
// Pure decisions, so they are tested as pure functions — no Electron, no display. The mistakes these
// guard against are all about the seams: a stored value from a future build, a missing setting on a
// fresh install, and the one that matters most — an explicit choice quietly losing to the OS.

import { describe, it, expect } from "vitest";
import {
  readThemeMode,
  resolveTheme,
  nativeThemeSource,
  DEFAULT_THEME_MODE,
  THEME_MODES,
} from "./theme-mode";

describe("readThemeMode — validating what was stored", () => {
  it("passes the three real modes through", () => {
    expect(readThemeMode("light")).toBe("light");
    expect(readThemeMode("dark")).toBe("dark");
    expect(readThemeMode("system")).toBe("system");
  });

  /**
   * ⚠ THE DEFAULT IS `system`, and this is the one behaviour change worth a test of its own: every existing
   * install has no `theme_mode` setting, so `null` is the common case, not an edge one. It must resolve to
   * the documented default rather than to whatever `undefined` coerces to.
   */
  it("falls back to the default for anything unrecognised", () => {
    expect(readThemeMode(null)).toBe(DEFAULT_THEME_MODE);
    expect(readThemeMode(undefined)).toBe(DEFAULT_THEME_MODE);
    expect(readThemeMode("")).toBe(DEFAULT_THEME_MODE);
    expect(readThemeMode("sepia")).toBe(DEFAULT_THEME_MODE);
    // Case-sensitive on purpose: the stored value is one we write, never one a human types.
    expect(readThemeMode("Dark")).toBe(DEFAULT_THEME_MODE);
    expect(readThemeMode("SYSTEM")).toBe(DEFAULT_THEME_MODE);
  });

  it("the default is itself a valid mode", () => {
    expect(THEME_MODES).toContain(DEFAULT_THEME_MODE);
  });
});

describe("resolveTheme — an explicit choice wins over the OS", () => {
  /**
   * ⚠ THE WHOLE REASON THIS IS THREE VALUES AND NOT A BOOLEAN. "dark" means dark on a machine set to light.
   * A `prefers-color-scheme` media query would invert exactly these two rows, which is why the resolution
   * happens here and the stylesheet only obeys an attribute.
   */
  it("honours an explicit mode regardless of the OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("follows the OS only under `system`", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("nativeThemeSource", () => {
  /**
   * Identity today — our three strings match Electron's `themeSource` values. The test exists so the
   * coupling is asserted rather than assumed: if either vocabulary drifts, this fails instead of leaving
   * the native chrome (dialogs, scrollbars) silently disagreeing with the app.
   */
  it("maps every mode to the matching Electron themeSource", () => {
    expect(nativeThemeSource("light")).toBe("light");
    expect(nativeThemeSource("dark")).toBe("dark");
    expect(nativeThemeSource("system")).toBe("system");
  });
});
