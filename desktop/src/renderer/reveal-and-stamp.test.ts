// ── ⚠ WHICH FILE, AND HOW CURRENT ───────────────────────────────────────────────────────────────
//
// Two features, one question underneath both: which file am I looking at, and is it current. The header
// answers the second, the tree answers the first.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relativeTime } from "./lib/relative-time";
import { ancestorsWithin } from "./lib/file-tree-ops";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/^\s*\/\/.*$/gm, " ");

const APP = read("./App.tsx");
const TREE = read("./components/FileTree.tsx");

describe("relativeTime — the header has room for four characters", () => {
  const now = Date.parse("2026-08-29T12:00:00Z");
  const ago = (ms: number) => relativeTime(now - ms, now);

  it("floors at ten seconds rather than counting every one", () => {
    // A header that ticks upward every second draws the eye away from the file it labels.
    expect(ago(0)).toBe("just now");
    expect(ago(9_000)).toBe("just now");
    expect(ago(10_000)).toBe("10s ago");
  });

  it("steps through seconds, minutes, hours and days", () => {
    expect(ago(45_000)).toBe("45s ago");
    expect(ago(60_000)).toBe("1m ago");
    expect(ago(90 * 60_000)).toBe("1h ago");
    expect(ago(26 * 3_600_000)).toBe("1d ago");
  });

  it("stops being an age past a week, where the date is the useful fact", () => {
    expect(ago(6 * 86_400_000)).toBe("6d ago");
    expect(ago(9 * 86_400_000)).toBe("over a week ago");
  });

  /**
   * ⚠ A FUTURE STAMP IS NOT AN ERROR. A clock stepped backwards by NTP, or a file copied with its original
   * timestamp from a machine minutes ahead, both produce one — and "just now" is the honest reading, where a
   * negative number would look like a bug in the app.
   */
  it("⚠ reads a future timestamp as just now, not as a negative age", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("⚠ the header stamp is refreshed wherever the file can change", () => {
  /**
   * ⚠ EVERY POINT, NOT JUST THE OPEN. "refersh time stamp as well" is the request, and a stamp that is only
   * read on open is wrong the moment anything writes — which is the whole situation this pairs with.
   */
  it("re-reads on open, on save, on outside write and on explicit reload", () => {
    const code = strip(APP);
    expect(
      (code.match(/refreshStamp\(\)/g) ?? []).length,
      "the definition plus every point the file can have moved"
    ).toBeGreaterThanOrEqual(5);
  });

  it("shows the disk time, from the same stamp the staleness guard uses", () => {
    expect(strip(APP)).toContain("api.statFile?.(filePath)");
    const handler = read("../main/handlers/files.ts");
    const stat = handler.slice(handler.indexOf('"files:stat"'), handler.indexOf('"files:unwatch"'));
    expect(stat, "not a second statSync that could disagree").toContain("readStamp(safePath)");
  });

  /**
   * ⚠ IT KEEPS SHOWING THE DISK TIME WHILE THE BUFFER IS DIRTY. "modified 30s ago" beside an unsaved dot is
   * exactly the state the reload banner is about, so the stamp must not be suppressed by `dirty`.
   */
  it("⚠ refreshes even when the tab has unsaved edits", () => {
    const code = strip(APP);
    const dirtyBranch = code.slice(code.indexOf("if (dirtyRef.current)"), code.indexOf("if (dirtyRef.current)") + 300);
    expect(dirtyBranch).toContain("refreshStamp()");
  });
});

describe("ancestorsWithin — the folders a reveal has to open", () => {
  it("returns them outermost first, excluding the root", () => {
    expect(ancestorsWithin("/p", "/p/src/lib/x.ts")).toEqual(["/p/src", "/p/src/lib"]);
  });

  it("returns nothing for a file directly in the root", () => {
    expect(ancestorsWithin("/p", "/p/x.ts")).toEqual([]);
  });

  /**
   * ⚠ A FILE OUTSIDE THE ROOT YIELDS NOTHING rather than walking to `/`. That is the guard against an active
   * path from a project the tree has already switched away from.
   */
  it("⚠ returns nothing for a file outside the root", () => {
    expect(ancestorsWithin("/p", "/other/x.ts")).toEqual([]);
    expect(ancestorsWithin("/p", "/x.ts")).toEqual([]);
  });

  it("is unbothered by empty inputs", () => {
    expect(ancestorsWithin("", "/p/x.ts")).toEqual([]);
    expect(ancestorsWithin("/p", "")).toEqual([]);
  });
});

describe("⚠ the tree reveals and marks the active file", () => {
  it("expands each ancestor in turn, awaiting every one", () => {
    const code = strip(TREE);
    /**
     * ⚠ AWAITED, because a folder's children are fetched when it opens: `src/lib` is not a row that can be
     * expanded until `src` has been. A loop of un-awaited toggles reveals nothing below the first level.
     */
    expect(code).toMatch(/for \(const dir of ancestorsWithin\(rootPath, activeFilePath\)\)/);
    expect(code).toMatch(/await ensureExpanded\(dir\)/);
  });

  it("bails when a folder will not open", () => {
    const code = strip(TREE);
    expect(code, "ensureExpanded has already said why").toMatch(/if \(!\(await ensureExpanded\(dir\)\)\) return/);
  });

  /** Clicking through tabs quickly must not leave two walks both scrolling the pane. */
  it("cancels a reveal whose file is no longer active", () => {
    const code = strip(TREE);
    expect(code).toMatch(/let cancelled = false/);
    expect(code).toMatch(/cancelled = true/);
  });

  /**
   * ⚠ AND IT USES THE CONTAINED SCROLLER. scroll-containment.test.ts forbids `scrollIntoView` outright
   * because it walks every scrollable ancestor — the reported bug where the app rode off the top of the
   * window. My first version of this reveal used it with `block: "nearest"`, which that test calls a
   * mitigation rather than a fix, and it was caught there.
   */
  it("⚠ scrolls through scrollRowIntoView, never scrollIntoView", () => {
    const code = strip(TREE);
    expect(code).toContain("scrollRowIntoView(row)");
    expect(code).not.toMatch(/\.scrollIntoView\s*\(/);
  });

  it("marks the row for assistive tech as well as visually", () => {
    expect(TREE, "colour alone says nothing to a screen reader").toContain('aria-current=');
    expect(strip(TREE)).toMatch(/samePath\(entry\.path, activeFilePath\)/);
  });

  /** A folder is expanded, not opened — highlighting one would claim a state the editor does not have. */
  it("⚠ never marks a folder as the open file", () => {
    const code = strip(TREE);
    expect(code).toMatch(/!isDir && activeFilePath && samePath\(entry\.path, activeFilePath\)/);
  });

  /** Driven from the tab state, so it follows every route into a file rather than tree clicks alone. */
  it("is driven by the active tab", () => {
    expect(strip(APP)).toContain("activeFilePath={tabs.active}");
  });
});
