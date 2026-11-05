// ── ⚠ THE TAB WIRING, WHERE THE DATA LOSS WOULD LIVE ─────────────────────────────────────
//
// `lib/file-tabs.ts` holds the rules and is tested there. What is asserted here is the wiring in `App.tsx`,
// which has no return value and is where an unsaved edit would actually be lost: an editor remounted on every
// tab switch throws away its edited text, and a dirty flag that outlives its editor makes the tab cap
// unrecoverable.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const app = strip(readFileSync(join(__dirname, "App.tsx"), "utf8"));

describe("⚠ every open file stays mounted", () => {
  /**
   * ⚠ THE OBVIOUS VERSION LOSES WORK. `<FileEditorView filePath={tabs.active} />` renders one editor and
   * remounts it on every switch — and the editor holds its own edited text, so switching tabs would silently
   * discard unsaved changes and reset the scroll position.
   */
  it("renders one editor per open file, not one for the active file", () => {
    expect(app, "mapped over the open tabs").toMatch(/tabs\.open\.map\(\(path\) => \(/);
    expect(app, "a single editor bound to the active path is the losing version").not.toMatch(
      /<FileEditorView\s+filePath=\{tabs\.active\}/
    );
  });

  /** Hidden, not unmounted — the same rule the chat pane follows, for the same reason. */
  it("hides the inactive editors rather than removing them", () => {
    expect(app).toMatch(/path === tabs\.active \? "flex" : "hidden"/);
  });

  /** Keyed by path, so React cannot reuse one file's editor state for another file. */
  it("keys each editor on its path", () => {
    const block = app.slice(app.indexOf("tabs.open.map"), app.indexOf("tabs.open.map") + 400);
    expect(block).toMatch(/key=\{path\}/);
  });
});

describe("⚠ dirty state is tracked outside the editor", () => {
  /**
   * Two things outside the editor need the answer: the tab row marks the file, and `openTab` refuses to evict
   * it at the cap. Without this, the cap would happily close a file with unsaved edits.
   */
  it("lifts it into App and passes it to the tab row", () => {
    expect(app).toMatch(/const \[dirtyFiles, setDirtyFiles\]/);
    expect(app).toMatch(/<FileTabs[\s\S]{0,200}?dirty=\{dirtyFiles\}/);
  });

  it("feeds it into the open decision, so a dirty tab is never evicted", () => {
    expect(app).toMatch(/openTab\(tabs, filePath, \(p\) => dirtyFiles\.has\(p\)\)/);
  });

  /**
   * ⚠ AND THE FLAG MUST DIE WITH THE EDITOR. A closed file leaving a permanent dirty flag behind would make
   * the cap unreachable-and-unrecoverable: a dirty path is never evicted, so the twelfth slot could never be
   * freed without restarting the app.
   */
  it("clears the flag when a file closes and when its editor unmounts", () => {
    expect(app, "on close").toMatch(/function handleCloseFile[\s\S]{0,400}?setDirtyFiles/);
    expect(app, "and on unmount").toMatch(/useEffect\(\(\) => \(\) => onDirtyChange\?\.\(filePath, false\)/);
  });
});

describe("⚠ the cap refuses out loud", () => {
  /** A cap that silently declines is indistinguishable from a broken click. */
  it("shows the refusal instead of dropping it", () => {
    expect(app).toMatch(/if \(refused\) toast\.error\(refused\)/);
  });
});

describe("⚠ switching project cannot leave a foreign file open", () => {
  /**
   * The editor READS AND WRITES the path it holds, so a tab left over from the previous folder would still
   * save outside the project the participant believes they are in. Equally, clearing ALL tabs would be the old
   * single-file behaviour — files inside the new root are kept.
   */
  it("prunes tabs to the new root rather than clearing them", () => {
    expect(app).toMatch(/setTabs\(\(prev\) => closeTabsOutside\(prev, project\.path\)\)/);
    expect(app, "the old blanket clear must be gone").not.toMatch(/setOpenFilePath\(null\)/);
  });
});

describe("⚠ the editor column still drives the layout", () => {
  /** `paneLayout` decides whether a pinned pane fits; it must read the tabs, not a deleted variable. */
  it("reports the editor as open from the active tab", () => {
    expect(app).toMatch(/editorOpen: !!tabs\.active/);
    expect(app, "no stale single-file state anywhere").not.toMatch(/\bopenFilePath\b/);
  });
});
