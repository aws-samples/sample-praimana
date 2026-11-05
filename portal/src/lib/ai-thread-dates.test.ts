// ── ⚠ TWO DATES ON ONE SCREEN, MEANING DIFFERENT THINGS ──────────────────────────────────────
//
// REPORTED: "a chat created on 16 August but updated today, what date should we show? currently it's
// showing 16 August instead of when it was last updated."
//
// ── THE LIST WAS CONTRADICTING ITSELF ──
//
// The sidebar SORTS by `updatedAt || createdAt`, so a thread started on the 16th and used today sits at
// the TOP. It then LABELLED that row with `createdAt`, "16 Aug". The order said "most recent" and the
// date said something else, which reads as broken ordering rather than as a mislabelled date. Those two
// expressions have to be the same one, and this file is what keeps them that way.
//
// ── AND CREATION DID NOT DISAPPEAR, IT MOVED ──
//
// The thread header showed no date at all, so it is where creation now lives, labelled "Started",
// because the one thing worse than the original bug is two bare dates on one screen meaning different
// things with nothing to tell them apart.
//
// Source assertions, matching `ai-refresh.test.ts` beside this file: vitest runs `environment: "node"`
// with no DOM, so what can be checked is the code that computes these, not a rendered tree.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const page = readFileSync(
  fileURLToPath(new URL("../app/w/[workshopId]/t/[teamId]/ai/page.tsx", import.meta.url)),
  "utf8"
);
/** Comments stripped: a guard its own prose can satisfy is not a guard, and this page's prose quotes
 *  both expressions at length, so without this every assertion below would pass on the explanation. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("⚠ the conversations list is labelled with what it is sorted by", () => {
  it("sorts by last activity", () => {
    // Unchanged behaviour, pinned because the label below is only correct while this holds.
    expect(code).toContain("b.updatedAt || b.createdAt");
    expect(code).toContain("a.updatedAt || a.createdAt");
  });

  it("labels each row with last activity, NOT creation", () => {
    // The regression itself. `thread.createdAt` alone in the row is what produced "16 Aug" on a thread
    // used today.
    expect(code).toContain("formatMessageInstant(thread.updatedAt || thread.createdAt)");
  });

  it("does not render a bare thread.createdAt anywhere in the row", () => {
    // Belt and braces on the exact prior expression, so re-adding it is a failing test rather than a
    // silent return to the reported bug.
    expect(code).not.toContain("formatMessageInstant(thread.createdAt)");
  });
});

describe("⚠ the header states the CREATION date, and says so", () => {
  it("derives it from createdAt with no updatedAt fallback", () => {
    // A fallback here would make the one label that means "started" quietly report a modification
    // time, on exactly the threads where the distinction is the point.
    expect(code).toContain("activeThreadMeta.createdAt");
    expect(code).not.toContain("activeThreadMeta?.updatedAt || activeThreadMeta?.createdAt");
  });

  it("labels it in words rather than showing a second bare date", () => {
    expect(code).toContain("Started {startedAt}");
  });

  it("omits the clause when there is no usable date", () => {
    // `formatMessageInstant` is the PORTAL's adapter and returns "" for an absent/unparseable value, so
    // the falsy guard is what stops the header printing "Started" with nothing after it.
    expect(code).toContain("{startedAt && <> · Started {startedAt}</>}");
  });
});

describe("⚠ the active thread's metadata is resolved ONCE", () => {
  /**
   * The page already carried a note that the provider display was hoisted "resolved ONCE... which is how
   * they came to disagree", while the header did its own `threads?.find(...)` for the title anyway.
   * Adding a third lookup for the creation date would have continued the pattern.
   */
  it("does the lookup exactly once", () => {
    const finds = code.match(/threads\?\.find\(/g) ?? [];
    expect(finds).toHaveLength(1);
  });

  it("feeds the title, the provider and the start date from that one row", () => {
    expect(code).toContain("const activeThreadMeta = threads?.find(");
    expect(code).toContain("aiProviderDisplay(activeThreadMeta?.aiProvider)");
    expect(code).toContain("activeThreadMeta?.title");
  });
});
