// ── ⚠ REFRESH ON THE PORTAL'S AI SCREEN ──────────────────────────────────────────────────
//
// A refresh icon beside the AI conversations list, in the right-hand corner, and one in each open
// conversation's right-hand corner: icon only, with a "Refresh" tooltip.
//
// ⚠ BUILT IN THE DESKTOP FIRST, and the portal needs it too, on the conversations list and on each
// conversation. Both now have it, and this file is the portal's guard.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const page = readFileSync(
  fileURLToPath(new URL("../app/w/[workshopId]/t/[teamId]/ai/page.tsx", import.meta.url)),
  "utf8"
);
/** Comments stripped: a guard its own prose can satisfy is not a guard. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("⚠ the conversations list can be refreshed", () => {
  /**
   * ⚠ AND IT IS THE LIST THAT MOST NEEDS IT. The open thread already polls every 5s; `getThreads` runs once on
   * mount, so a conversation created on someone's desktop never appears without a page reload.
   */
  it("refetches the thread list from its own header", () => {
    const header = code.indexOf("Conversations (");
    const button = code.indexOf("threadsQuery.refetch()", header);

    expect(header, "the list header").toBeGreaterThan(-1);
    expect(button, "a refresh in that header").toBeGreaterThan(header);
  });

  it("reports it is busy rather than looking inert", () => {
    expect(code).toMatch(/disabled=\{threadsQuery\.isFetching\}/);
    expect(code).toMatch(/aria-label=\{threadsQuery\.isFetching \? "Refreshing conversations"/);
  });
});

describe("⚠ an open conversation can be refreshed", () => {
  it("refetches the thread", () => {
    expect(code).toMatch(/activeThreadQuery\.refetch\(\)/);
    expect(code).toMatch(/aria-label=\{\s*activeThreadQuery\.isFetching\s*\?\s*"Refreshing this conversation"/);
  });

  /**
   * ⚠ THE TIMING STRIP MUST BE INVALIDATED TOO. `ThreadTiming` owns its own query with NO interval, so
   * refetching the thread alone updates the messages and leaves the token figures stale, the one number
   * someone is most likely to be watching right after a new turn lands.
   */
  it("also invalidates the timing query, or the token figures go stale", () => {
    expect(code).toMatch(/utils\.ai\.timing\.invalidate\(\{ threadId: activeThreadId \}\)/);
  });
});

describe("⚠ icon only, and considerate of motion", () => {
  /** The word belongs in the tooltip: these headers are narrow and already carry a title and a count. */
  it("has a tooltip and no visible caption", () => {
    expect(code).toMatch(/title="Refresh"/);
    expect(code).toMatch(/<RefreshIcon spinning=/);
    expect(code, "no visible word next to the glyph").not.toMatch(/<RefreshIcon[^>]*\/>\s*\n?\s*Refresh</);
  });

  it("does not spin for a reader who asked for less motion", () => {
    expect(code).toMatch(/motion-safe:animate-spin/);
  });

  /** Two buttons, two places, a single shared one would mean only one of the corners got it. */
  it("renders in both corners", () => {
    expect([...code.matchAll(/<RefreshIcon/g)].length, "list header and thread header").toBe(2);
  });
});
