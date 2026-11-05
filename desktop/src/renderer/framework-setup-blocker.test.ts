// ── ⚠ THE ONE MODAL WITH NO WAY OUT ───────────────────────────────────────────────────────────
//
// Every other dialog in this app can be dismissed — Escape, backdrop, Cancel. This one deliberately
// cannot, because the folder is already open while `framework:install` is still writing into it and
// running an assistant turn there. That makes two properties load-bearing rather than nice to have:
//
//   1. IT MUST ACTUALLY BLOCK — pointer AND keyboard. An overlay that stops the mouse but lets Tab
//      reach the composer behind it does not prevent the thing it exists to prevent: a second agent
//      turn in the same working tree.
//   2. IT MUST NEVER LOOK HUNG. A modal with no controls and no changing text is indistinguishable
//      from a freeze, and that is the moment somebody force-quits an app mid-write.
//
// The escape hatch is in main, not here: curl 120s, tar 60s, and `runCliAgent`'s own 120s timer, which
// kills the process and RESOLVES. The caller clears this overlay in a `finally`
// (switch-folder-order.test.ts pins that), so even a hung agent takes it down.
//
// Asserted against source: this package's vitest is node-only, so there is no DOM to render into.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const src = readFileSync(local("./components/FrameworkSetupBlocker.tsx"), "utf8");
/** Comments explain at length what the code must NOT do, so they would defeat every absence check. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("⚠ it blocks the pointer and the keyboard", () => {
  it("covers the window above every other overlay", () => {
    expect(code).toMatch(/fixed inset-0/);
    /**
     * Above the confirm dialog's `z-50`. The two can never be visible together — the confirmation is
     * cleared before the switch starts — so this is about which wins if a future edit overlaps them: a
     * block must never be paintable under a dialog that can be dismissed.
     */
    expect(code).toMatch(/z-\[60\]/);
  });

  it("takes focus, because blocking the pointer is only half of blocking", () => {
    // Without this, Tab still walks the app behind the overlay and Enter activates what it lands on.
    expect(code).toMatch(/tabIndex=\{-1\}/);
    expect(code).toMatch(/boxRef\.current\?\.focus\(\)/);
  });

  it("swallows Tab, since there is nowhere inside to move to", () => {
    expect(code).toMatch(/e\.key === "Tab"[\s\S]{0,40}e\.preventDefault\(\)/);
  });

  /**
   * ⚠ THE ABSENCE IS THE ASSERTION. A Cancel button, a backdrop dismiss or an Escape handler would each
   * defeat the request — and each is exactly what a well-meaning edit would add, since every other
   * dialog in this app has all three.
   */
  it("offers no way to dismiss it", () => {
    expect(code, "no cancel handler").not.toMatch(/onCancel/);
    expect(code, "no backdrop dismiss").not.toMatch(/onClick=/);
    expect(code, "and Escape is left unbound").not.toMatch(/"Escape"/);
  });
});

describe("⚠ it never looks hung", () => {
  it("renders the live step from framework:progress", () => {
    expect(code, "the step is a prop, not a static sentence").toMatch(/step \|\| "Starting…"/);
  });

  it("announces the step as it changes", () => {
    // Otherwise a screen-reader user gets one announcement — the title — for up to five minutes.
    expect(code).toMatch(/aria-live="polite"/);
    expect(code).toMatch(/role="status"/);
  });

  it("states that the folder is already open, which is why waiting is safe", () => {
    // The switch has completed by the time this appears; without saying so, the block reads as the
    // switch itself being stuck — the very symptom that prompted the reorder behind it.
    expect(src).toMatch(/Your folder is open and ready/);
  });

  it("marks itself busy and interrupting for assistive technology", () => {
    expect(code).toMatch(/role="alertdialog"/);
    expect(code).toMatch(/aria-modal="true"/);
    expect(code).toMatch(/aria-busy="true"/);
  });
});

describe("⚠ it names no framework", () => {
  it("takes the name as a prop, as main supplies it", () => {
    expect(code).toMatch(/frameworkName/);
    for (const named of [/AI-?DLC/i, /Spec ?Kit/i, /OpenSpec/i]) {
      expect(code, `${named} is the facilitator's choice, not ours`).not.toMatch(named);
    }
  });
});
