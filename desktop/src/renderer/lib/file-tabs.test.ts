// ── ⚠ TABS MUST NOT COST ANYONE THEIR UNSAVED WORK ───────────────────────────────────────
//
// Before this, opening a file replaced the one before it, so following a reference lost your place and
// any edit in it.
//
// Everything here is about the ways a tab list can destroy work or lose the participant's place: the cap
// making room by closing something, closing the active tab and landing nowhere, and switching project while
// files from the old one are open.

import { describe, it, expect } from "vitest";
import {
  EMPTY_TABS,
  MAX_OPEN_TABS,
  closeTab,
  closeTabsOutside,
  openTab,
  tabLabel,
  tabLabels,
  type TabState,
} from "./file-tabs";

const state = (open: string[], active: string | null = open[open.length - 1] ?? null): TabState => ({
  open,
  active,
});

describe("opening", () => {
  it("adds a file and shows it", () => {
    const { state: next } = openTab(EMPTY_TABS, "/p/a.ts");

    expect(next.open).toEqual(["/p/a.ts"]);
    expect(next.active).toBe("/p/a.ts");
  });

  it("keeps earlier files open", () => {
    let s = openTab(EMPTY_TABS, "/p/a.ts").state;
    s = openTab(s, "/p/b.ts").state;

    expect(s.open).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(s.active).toBe("/p/b.ts");
  });

  /**
   * ⚠ FOCUSES RATHER THAN RE-ADDS. Re-adding would move the tab to the end of the row, so clicking a search
   * result for a file you already had open would make it jump position — and, worse, `openTab` returning a new
   * order means the "oldest" tab for eviction purposes would change every time you revisited one.
   */
  it("focuses a file that is already open, without moving it", () => {
    const before = state(["/p/a.ts", "/p/b.ts", "/p/c.ts"]);

    const { state: after } = openTab(before, "/p/a.ts");

    expect(after.open, "the order is untouched").toEqual(before.open);
    expect(after.active).toBe("/p/a.ts");
  });
});

describe("⚠ the cap never eats unsaved work", () => {
  const full = state(Array.from({ length: MAX_OPEN_TABS }, (_, i) => `/p/f${i}.ts`));

  it("makes room by closing the OLDEST clean tab", () => {
    const { state: after, refused } = openTab(full, "/p/new.ts");

    expect(refused).toBeUndefined();
    expect(after.open.length).toBe(MAX_OPEN_TABS);
    expect(after.open, "the oldest went").not.toContain("/p/f0.ts");
    expect(after.open).toContain("/p/new.ts");
    expect(after.active).toBe("/p/new.ts");
  });

  /** THE assertion this module exists for. */
  it("passes over a dirty tab however old it is", () => {
    const { state: after } = openTab(full, "/p/new.ts", (p) => p === "/p/f0.ts");

    expect(after.open, "the oldest tab was dirty, so it stays").toContain("/p/f0.ts");
    expect(after.open, "the next oldest clean one went instead").not.toContain("/p/f1.ts");
  });

  /**
   * ⚠ REFUSES RATHER THAN PICKING A VICTIM. With every tab dirty there is no way to honour the request
   * without discarding an edit, and discarding one to satisfy a tab limit is the worst possible reading of
   * "bounded".
   */
  it("refuses, with a reason, when every open file is dirty", () => {
    const { state: after, refused } = openTab(full, "/p/new.ts", () => true);

    expect(after).toEqual(full);
    expect(refused, "the participant must be told why").toBeTruthy();
    expect(refused).toContain("unsaved");
  });

  it("does not evict when the file is already open, even at the cap", () => {
    const { state: after, refused } = openTab(full, "/p/f3.ts", () => true);

    expect(refused).toBeUndefined();
    expect(after.open).toEqual(full.open);
    expect(after.active).toBe("/p/f3.ts");
  });
});

describe("closing", () => {
  /**
   * ⚠ LANDS ON THE LEFT NEIGHBOUR, computed from the position BEFORE the removal. Reading the index after
   * filtering shifts every later tab left by one and lands on the wrong file.
   */
  it("shows the left neighbour when the active tab closes", () => {
    const after = closeTab(state(["/a", "/b", "/c"], "/b"), "/b");

    expect(after.open).toEqual(["/a", "/c"]);
    expect(after.active).toBe("/a");
  });

  it("shows the right neighbour when the first tab closes", () => {
    const after = closeTab(state(["/a", "/b", "/c"], "/a"), "/a");

    expect(after.active).toBe("/b");
  });

  /** Closing something you were not reading must not move you. */
  it("leaves the active tab alone when a background tab closes", () => {
    const after = closeTab(state(["/a", "/b", "/c"], "/c"), "/a");

    expect(after.active).toBe("/c");
    expect(after.open).toEqual(["/b", "/c"]);
  });

  it("empties completely when the last tab closes", () => {
    expect(closeTab(state(["/a"], "/a"), "/a")).toEqual(EMPTY_TABS);
  });

  it("ignores a path that is not open", () => {
    const before = state(["/a", "/b"], "/a");

    expect(closeTab(before, "/nope")).toEqual(before);
  });
});

describe("⚠ switching project cannot leave a foreign file open", () => {
  /**
   * The editor READS AND WRITES the path it holds. A tab left over from the previous folder would still save
   * to it, outside the project the participant believes they are in.
   */
  it("closes files outside the new root and keeps the ones inside", () => {
    const after = closeTabsOutside(state(["/old/a.ts", "/new/b.ts"], "/old/a.ts"), "/new");

    expect(after.open).toEqual(["/new/b.ts"]);
    expect(after.active).toBe("/new/b.ts");
  });

  /**
   * ⚠ THE TRAILING SEPARATOR. Root `/a/proj` must not keep a file from `/a/project-two`, which starts with
   * the same characters — the prefix trap `assertWithinProject` guards in main.
   */
  it("does not keep a file from a sibling folder with a shared prefix", () => {
    const after = closeTabsOutside(state(["/a/project-two/x.ts"]), "/a/proj");

    expect(after).toEqual(EMPTY_TABS);
  });

  it("keeps the same file showing when it survived", () => {
    const after = closeTabsOutside(state(["/new/a.ts", "/new/b.ts", "/old/c.ts"], "/new/a.ts"), "/new");

    expect(after.active).toBe("/new/a.ts");
  });

  it("changes nothing when every file is already inside", () => {
    const before = state(["/new/a.ts", "/new/b.ts"], "/new/a.ts");

    expect(closeTabsOutside(before, "/new")).toBe(before);
  });

  it("accepts a root with a trailing separator", () => {
    const after = closeTabsOutside(state(["/new/a.ts", "/old/b.ts"]), "/new/");

    expect(after.open).toEqual(["/new/a.ts"]);
  });
});

describe("labels", () => {
  it("uses the file's own name", () => {
    expect(tabLabel("/a/b/index.ts")).toBe("index.ts");
  });

  /**
   * ⚠ AMBIGUOUS NAMES GAIN THEIR DIRECTORY. A project has twenty files called `index.ts`, and four tabs all
   * reading "index.ts" cannot be told apart — the same reason the search results show their directory.
   */
  it("disambiguates only the names that repeat", () => {
    const labels = tabLabels(["/p/a/index.ts", "/p/b/index.ts", "/p/other.ts"]);

    expect(labels["/p/a/index.ts"]).toBe("a/index.ts");
    expect(labels["/p/b/index.ts"]).toBe("b/index.ts");
    expect(labels["/p/other.ts"], "unique names stay short").toBe("other.ts");
  });
});
