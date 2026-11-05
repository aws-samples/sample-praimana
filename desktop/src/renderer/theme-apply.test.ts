// ── APPLYING THE THEME TO THE DOCUMENT ───────────────────────────────────────────────────
//
// `applyTheme` is the one line the whole feature comes down to at runtime: it puts the resolved mode
// where CSS can act on it. The suite runs under the `node` environment (no DOM), which is why the
// function takes its root element as a PARAMETER — a tiny stub stands in for `<html>`, and the two
// side-effects that matter are observable on it.

import { describe, it, expect } from "vitest";
import { applyTheme, THEME_ATTRIBUTE, THEME_LABELS, THEME_HINTS } from "./lib/theme";

/** The two things `applyTheme` touches, and nothing else. */
function fakeRoot() {
  const attrs: Record<string, string> = {};
  return {
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    style: {} as { colorScheme?: string },
    attrs,
  };
}

describe("applyTheme", () => {
  it("writes the resolved mode onto the root's data-theme", () => {
    const light = fakeRoot();
    applyTheme("light", light as unknown as HTMLElement);
    expect(light.attrs[THEME_ATTRIBUTE]).toBe("light");

    const dark = fakeRoot();
    applyTheme("dark", dark as unknown as HTMLElement);
    expect(dark.attrs[THEME_ATTRIBUTE]).toBe("dark");
  });

  /**
   * ⚠ DARK IS WRITTEN, NOT LEFT IMPLICIT. Dark is the `:root` default, so removing the attribute would
   * colour correctly — but "no attribute" and "dark" would then be indistinguishable to a test, a
   * screenshot, or a future `[data-theme="dark"]` rule. The attribute always states the mode.
   */
  it("states dark explicitly rather than relying on the default", () => {
    const root = fakeRoot();
    applyTheme("dark", root as unknown as HTMLElement);
    expect(root.attrs[THEME_ATTRIBUTE], "dark is named, not absent").toBe("dark");
  });

  /**
   * ⚠ `color-scheme` IS SET, and it is not cosmetic: it governs the built-ins this app does not style —
   * scrollbars, the caret default, `<select>` popups. Without it a light theme keeps dark scrollbars and a
   * dark dropdown menu, which reads as a rendering fault.
   */
  it("sets color-scheme so native controls follow", () => {
    const light = fakeRoot();
    applyTheme("light", light as unknown as HTMLElement);
    expect(light.style.colorScheme).toBe("light");
  });

  it("re-applying replaces rather than accumulates", () => {
    const root = fakeRoot();
    applyTheme("light", root as unknown as HTMLElement);
    applyTheme("dark", root as unknown as HTMLElement);
    expect(root.attrs[THEME_ATTRIBUTE]).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});

describe("the three modes are labelled for humans", () => {
  it("names each mode, with Auto for system", () => {
    expect(THEME_LABELS.light).toBe("Light");
    expect(THEME_LABELS.dark).toBe("Dark");
    // ⚠ "Auto", not "System" — the hint beneath already says what it follows.
    expect(THEME_LABELS.system).toBe("Auto");
  });

  it("every mode has a one-line hint", () => {
    for (const mode of ["light", "dark", "system"] as const) {
      expect(THEME_HINTS[mode], `${mode} needs a hint`).toBeTruthy();
    }
  });
});
