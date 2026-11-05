// ── ⚠ THE PER-PERSON TABLE IS OFF, AND STAYS OFF UNTIL THE FIGURES ARE COMPARABLE ────────
//
// The token comparison table is hidden for now and parked on the backlog, BACKLOG 9a.
//
// ⚠ NOTHING PINNED THIS BEFORE. `perPerson` in `lib/token-insights.ts` has thorough unit tests, but they
// cover the ARITHMETIC, no test asserted whether the table was rendered at all. So hiding it broke nothing,
// and equally nothing would have caught it silently returning in a later edit. That asymmetry is the gap this
// file closes.
//
// The reason it is hidden is a measurement problem, not a preference: one real Codex turn reported 13.2M
// context tokens where a Claude turn reports tens of thousands, Kiro reports nothing at all, and
// `computeTokenInsights` sums all of them into one column regardless of provider. A row per person invites
// exactly the comparison those numbers cannot support. BACKLOG 9a lists what must be true first.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const panel = readFileSync(join(__dirname, "TokenUsagePanel.tsx"), "utf8");
const stripped = panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("⚠ the per-person comparison table is not rendered", () => {
  it("keeps the flag off", () => {
    expect(stripped, "the constant must exist and be false").toMatch(
      /const SHOW_PER_PERSON = false/
    );
  });

  /**
   * ⚠ THE FLAG MUST ACTUALLY GATE THE TABLE. A constant nobody reads is the same bug as a parser nobody
   * calls, so this asserts the guard sits on the render, not merely that the constant is declared.
   */
  it("gates the table on it", () => {
    expect(stripped).toMatch(/SHOW_PER_PERSON && insights\.perPerson\.length > 0/);
  });

  /**
   * ⚠ HIDDEN, NOT DELETED, and that is deliberate: the aggregate `perPerson` builds is correct and tested,
   * and this panel's own totals come from the same computation. Ripping it out would throw away working code
   * and its tests to achieve what one constant achieves reversibly.
   */
  it("still keeps the table markup and the honest heading, for when it returns", () => {
    expect(panel, "the heading claims only what the data supports").toContain(
      "By conversations they started"
    );
    expect(panel, "and the attribution caveat travels with it").toContain(
      "Attributed to whoever started each conversation"
    );
  });

  /**
   * ⚠ THE REST OF THE PANEL IS UNAFFECTED. Team totals, the cache rate, the own-trend line and the factual
   * signals were never the thing being compared between people, and hiding the table must not have taken any
   * of them with it.
   */
  it("leaves the team-level figures in place", () => {
    for (const kept of ["Context sent", "Served from cache", "Generated", "Conversations"]) {
      expect(panel, `${kept} must survive`).toContain(kept);
    }
    expect(stripped, "the own-trend line").toContain("insights.trend");
    expect(stripped, "and the signals list").toContain("insights.signals");
  });

  /** A hidden feature with no recorded reason becomes a mystery; the pointer is part of the change. */
  it("points at the backlog entry that says what must be true first", () => {
    expect(panel).toMatch(/BACKLOG 9a/);
  });
});
