// Pure bounds for the drag-resizable pinned shared-chat pane. No DOM — see pane-pin.test.ts for the
// same "assert the pure helper" shape.

import { describe, it, expect } from "vitest";
import { PIN_DEFAULT_W, PIN_MIN_W, pinnedPaneMaxWidth, clampPinnedWidth } from "./pinned-pane";

describe("pinned pane width bounds", () => {
  it("defaults to 384px (the old w-96 the pane started as)", () => {
    expect(PIN_DEFAULT_W).toBe(384);
  });

  it("caps the max at 42% of the window so the pinned pane cannot crowd out the live chat", () => {
    expect(pinnedPaneMaxWidth(1000)).toBe(420);
    expect(pinnedPaneMaxWidth(1600)).toBe(672);
  });

  it("clamps a too-wide drag down to the 42% max", () => {
    // On a 1000px window the max is 420; a drag asking for 900 is pinned to 420.
    expect(clampPinnedWidth(900, 1000)).toBe(420);
  });

  it("clamps a too-narrow drag up to the min so the transcript stays legible", () => {
    expect(clampPinnedWidth(50, 1600)).toBe(PIN_MIN_W);
    expect(clampPinnedWidth(-200, 1600)).toBe(PIN_MIN_W);
  });

  it("leaves a width inside the range unchanged (rounded)", () => {
    expect(clampPinnedWidth(500, 1600)).toBe(500);
    expect(clampPinnedWidth(500.6, 1600)).toBe(501);
  });

  /**
   * ⚠ THE MIN WINS ON A TINY WINDOW. If 42% is below the legibility floor, the clamp must not pin the
   * pane to that too-small max — it keeps PIN_MIN_W instead, and the live chat's own min-w-0 + scroll
   * absorb the overflow.
   */
  it("keeps the min when 42% of a tiny window would be smaller than the min", () => {
    // 42% of 600 is 252, below the 280 min — so a mid drag still clamps to the min, not to 252.
    expect(pinnedPaneMaxWidth(600)).toBeLessThan(PIN_MIN_W);
    expect(clampPinnedWidth(260, 600)).toBe(PIN_MIN_W);
  });
});
