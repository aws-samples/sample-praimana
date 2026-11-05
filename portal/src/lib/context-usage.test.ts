// ── ⚠ THE BUG THIS FILE EXISTS FOR: A MISSING FIELD RENDERED AS A BLANK ───────────────────
//
// REPORTED: "can u check for kiro why percentage number is missing", the timing strip drew the word
// `Context`, then `% full`, with nothing in between.
//
// The guard was `t.ai.contextUsagePercent !== null`. `undefined !== null` is TRUE, so a MISSING field passed
// the guard and React rendered the value as empty. And missing is the ordinary case: any ai-service that
// predates the field omits it from the timing response, so every request to a backend that has not been
// redeployed hits exactly this.
//
// ⚠ IT SHIPPED BECAUSE NOTHING COULD TEST IT. The decision lived in JSX, and the portal's tests are
// pure-logic only, no jsdom, React rendering is e2e scope (see vitest.config.ts). So the fix was to move the
// decision OUT of the component, and this file is the half that makes the fix worth more than the one-line
// version of it. The first case below is the reported symptom, verbatim.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contextUsageReading, CONTEXT_ALARM_THRESHOLD } from "./context-usage";

describe("⚠ contextUsageReading, absent must be absent, never a blank", () => {
  /**
   * ⚠ THE REPORTED BUG. An ai-service that has not been redeployed sends no `contextUsagePercent` at all, so
   * the property reads `undefined`. This is the case the old `!== null` guard let through.
   */
  it("returns null for undefined, a service too old to send the field", () => {
    expect(contextUsageReading(undefined)).toBeNull();
  });

  /** A service that DID look and measured nothing: a Claude or Codex thread. */
  it("returns null for null, measured nothing", () => {
    expect(contextUsageReading(null)).toBeNull();
  });

  /**
   * ⚠ AND THIS IS WHY THE TEST IS `typeof`, NOT TRUTHINESS. A fresh conversation genuinely reports 0% full.
   * `value && …`, `!value` or `Number(value) || null` would all discard it, and the strip would fall silent on
   * the one thread where the figure is least ambiguous.
   */
  it("KEEPS 0, which is a real reading and not an absence", () => {
    expect(contextUsageReading(0)).toBe(0);
  });

  it("keeps an ordinary reading", () => {
    expect(contextUsageReading(62)).toBe(62);
  });

  it("keeps 100, a genuinely full window", () => {
    expect(contextUsageReading(100)).toBe(100);
  });

  /**
   * ⚠ OUT OF RANGE IS DROPPED, NOT CLAMPED, the same rule the sync route applies on the way in. Clamping 140
   * to 100 would tell a participant their conversation is full on evidence already known to be wrong, and they
   * would compact a chat that did not need it.
   */
  it.each([
    ["above 100", 140],
    ["negative", -5],
  ])("returns null for an out-of-range reading (%s)", (_label, raw) => {
    expect(contextUsageReading(raw)).toBeNull();
  });

  /** Untrusted JSON: the field could be anything, and none of these may reach a template. */
  it.each([
    ["a numeric string", "62"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", { percent: 62 }],
    ["an array", [62]],
    ["a boolean", true],
    ["an empty string", ""],
  ])("returns null for %s", (_label, raw) => {
    expect(contextUsageReading(raw)).toBeNull();
  });

  /** A legacy row may hold the agent's raw value, the live probe returned 10.665900230407715. */
  it("rounds a fractional reading", () => {
    expect(contextUsageReading(10.665900230407715)).toBe(11);
    expect(contextUsageReading(99.6)).toBe(100);
  });

  /**
   * ⚠ ROUNDING MUST NOT MANUFACTURE A FULL WINDOW. `Math.round` on a value already inside the range cannot
   * exceed 100, but a future change to the order of the range check and the rounding could, so the boundary
   * is pinned rather than left to reading order.
   */
  it("never returns a value outside 0..100", () => {
    for (const raw of [0, 0.4, 50.5, 99.9, 100]) {
      const value = contextUsageReading(raw)!;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe("the amber threshold", () => {
  /**
   * ⚠ SHARED WITH THE DESKTOP'S HEADER (the 85 check in `KiroChatView`). Two surfaces disagreeing about when a
   * conversation is "nearly full" would be a worse defect than either number being slightly off, which is why
   * this is a named constant rather than a literal in the JSX.
   */
  it("is 85, matching the desktop", () => {
    expect(CONTEXT_ALARM_THRESHOLD).toBe(85);
  });
});

/**
 * ── ⚠ AND THE COMPONENT MUST ACTUALLY USE IT ──────────────────────────────────────────────
 *
 * "The helper exists" and "the UI calls it" are different claims, and only the second one fixed anything -
 * a lesson already recorded in the desktop's `vscode-parity.test.ts`, where mutation testing found exactly
 * this gap. Every case above would keep passing if `ThreadTiming` went back to comparing against `null`
 * inline, which is the bug that was reported.
 *
 * Source assertions rather than a render test, because the portal has no jsdom (React is e2e scope). Narrow on
 * purpose: they pin the GUARD, not the markup around it.
 */
describe("⚠ ThreadTiming guards on the helper, not on null", () => {
  const component = readFileSync(join(__dirname, "..", "components", "ThreadTiming.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("calls contextUsageReading", () => {
    expect(component).toContain("contextUsageReading(t.ai.contextUsagePercent)");
  });

  /**
   * ⚠ THE REGRESSION ITSELF. `contextUsagePercent !== null` is the exact expression that rendered
   * "Context % full" with no number, and it must not return in any form.
   */
  it("never compares contextUsagePercent against null or undefined directly", () => {
    expect(component).not.toMatch(/contextUsagePercent\s*!==\s*null/);
    expect(component).not.toMatch(/contextUsagePercent\s*!==\s*undefined/);
    /* Nor truthiness, which would silently discard a real 0% reading. */
    expect(component).not.toMatch(/t\.ai\.contextUsagePercent\s*&&/);
  });

  /** The rendered value must be the CHECKED one, or the guard protects a different variable than it draws. */
  it("renders the resolved reading rather than the raw field", () => {
    expect(component).toMatch(/\{contextUsage\}% full/);
    expect(component).not.toMatch(/\{t\.ai\.contextUsagePercent\}% full/);
  });

  /**
   * ⚠ THE TYPE MUST ADMIT BOTH ABSENCES. Declared `number | null` it looked always-present, so the compiler
   * had nothing to say about the `undefined` that actually arrives, the type was as much the bug as the guard.
   */
  it("types the field as optional AND nullable, as the wire really is", () => {
    expect(component).toMatch(/contextUsagePercent\?:\s*number\s*\|\s*null/);
  });

  /** The threshold is shared with the desktop, not re-typed as a literal here. */
  it("uses the shared threshold constant", () => {
    expect(component).toContain("CONTEXT_ALARM_THRESHOLD");
  });
});
