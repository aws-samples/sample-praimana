// ── THE PALETTE, PARSED FROM `index.css`, FOR TESTS ──────────────────────────────────────
//
// ⚠ TEST-ONLY. Nothing in the app imports this — the app reads colours through Tailwind classes, which
// resolve to the CSS variables at render time. This exists so the contrast suites can do arithmetic on the
// values, which requires knowing the numbers.
//
// ── ⚠ WHY IT PARSES THE STYLESHEET INSTEAD OF DECLARING THE HEXES ──
//
// Five test files used to carry their own copy of `#111827` and friends, read out of `tailwind.config.ts`
// with `expect(config).toContain('bg: "#111827"')`. That worked while the config held literal hexes. It no
// longer does: the config maps every token to `rgb(var(--token) / <alpha-value>)` and the VALUES moved to
// `index.css`, where the two modes sit side by side.
//
// Re-declaring the hexes in a test helper would put the palette in two places again — and a contrast suite
// asserting against a stale copy is worse than no suite, because it reports green while the app renders
// something else. So the numbers come from the one file that defines them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Mode = "dark" | "light";

const CSS = readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

/** `17 24 39` → `#111827`. The stylesheet stores channels so Tailwind's alpha modifiers work. */
function channelsToHex(channels: string): string {
  const parts = channels.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`not an "R G B" triple: ${JSON.stringify(channels)}`);
  }
  return "#" + parts.map((n) => n.toString(16).padStart(2, "0")).join("");
}

/**
 * Pull one block's custom properties.
 *
 * ⚠ MATCHED ON THE SELECTOR, not on position, so reordering the two blocks in the stylesheet cannot
 * silently swap the palettes under every assertion in the suite.
 */
function readBlock(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector + " {");
  if (start === -1) throw new Error(`no "${selector}" block in index.css`);
  const body = CSS.slice(start, CSS.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z-]+):\s*([0-9\s]+);/g)) {
    out[m[1]] = channelsToHex(m[2]);
  }
  return out;
}

/** Dark is `:root` — the fallback, and the mode this app shipped with. */
export const DARK = readBlock(":root");
/** Light is the attribute the renderer sets on `<html>`. */
export const LIGHT = readBlock('[data-theme="light"]');

export const PALETTES: Record<Mode, Record<string, string>> = { dark: DARK, light: LIGHT };

/**
 * A token's hex in one mode, by its Tailwind name — `surface-bg`, `brand-accent`, `tool-error-text`.
 *
 * ⚠ THROWS ON AN UNKNOWN TOKEN rather than returning undefined. A typo'd name flowing into the contrast
 * maths would produce `NaN`, and a comparison against `NaN` is false — so a mistyped assertion would
 * silently pass. Failing loudly is the whole point of a fixture.
 */
export function hex(token: string, mode: Mode = "dark"): string {
  const value = PALETTES[mode][token];
  if (!value) throw new Error(`no --${token} in the ${mode} palette`);
  return value;
}

/* ── WCAG relative luminance and contrast, from the spec ────────────────────────────────── */

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance(hexValue: string): number {
  const h = hexValue.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast between two TOKENS in one mode — the form most assertions want. */
export function ratio(tokenA: string, tokenB: string, mode: Mode = "dark"): number {
  return contrast(hex(tokenA, mode), hex(tokenB, mode));
}

/** Both palettes must describe the same token set, or one mode has a hole. */
export const TOKEN_NAMES = Object.keys(DARK).sort();
