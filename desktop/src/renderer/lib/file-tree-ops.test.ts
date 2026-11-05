import { describe, it, expect } from "vitest";
import {
  basenameOf,
  canPasteInto,
  clampMenuPosition,
  clipboardAfterPaste,
  clipboardAfterRemoval,
  copyItem,
  createTargetDir,
  cutItem,
  dirsToRefresh,
  isCutPending,
  isSelfOrDescendant,
  parentDirOf,
  pasteTargetDir,
  pruneSubtree,
  samePath,
  splitNameForRename,
  type ClipboardItem,
} from "./file-tree-ops";

/**
 * TESTS FOR THE TREE'S DECISIONS, NOT ITS PIXELS.
 *
 * This package's vitest runs in `environment: "node"` with no jsdom, so nothing here renders a
 * component or dispatches an event — a test that needed a DOM would have to bring one in, and the
 * repo has deliberately kept the renderer out of the suite. What IS testable is every decision the
 * tree makes before it calls IPC, which is exactly where the interesting failures live: pasting
 * into the wrong directory, refreshing the wrong cache key, selecting the extension on a rename.
 *
 * The filesystem effects themselves are already covered by src/main/handlers/file-ops.test.ts
 * against a real temp directory; duplicating that here with fakes would prove nothing.
 */

const file = (path: string) => ({ path, name: basenameOf(path), type: "file" as const });
const dir = (path: string) => ({ path, name: basenameOf(path), type: "dir" as const });

describe("parentDirOf", () => {
  it("returns the containing directory", () => {
    expect(parentDirOf("/p/src/index.ts")).toBe("/p/src");
    expect(parentDirOf("/p/src")).toBe("/p");
  });

  it("keeps the POSIX root as a root rather than collapsing it to empty", () => {
    // "/foo" -> "" would make dirsToRefresh drop the entry and the tree would go stale.
    expect(parentDirOf("/foo")).toBe("/");
  });

  it("ignores trailing separators", () => {
    expect(parentDirOf("/p/src/")).toBe("/p");
  });

  it("handles Windows separators and keeps the drive root's separator", () => {
    expect(parentDirOf("C:\\p\\src\\index.ts")).toBe("C:\\p\\src");
    // "C:" without the separator is DRIVE-RELATIVE, i.e. a different directory entirely.
    expect(parentDirOf("C:\\p")).toBe("C:\\");
  });

  it("returns empty — not '.' — when there is nothing to split on", () => {
    // "." would resolve against the app's cwd in main; "" is not a path, so callers must check.
    expect(parentDirOf("loose-name.txt")).toBe("");
  });
});

describe("basenameOf", () => {
  it("returns the final segment", () => {
    expect(basenameOf("/p/src/index.ts")).toBe("index.ts");
    expect(basenameOf("/p/src/")).toBe("src");
    expect(basenameOf("C:\\p\\notes.md")).toBe("notes.md");
    expect(basenameOf("solo")).toBe("solo");
  });
});

describe("samePath", () => {
  it("ignores only trailing separators", () => {
    expect(samePath("/p/src", "/p/src/")).toBe(true);
    expect(samePath("/p/src", "/p/Src")).toBe(false); // case is never folded — Linux is sensitive
  });
});

describe("isSelfOrDescendant", () => {
  it("counts the folder itself", () => {
    expect(isSelfOrDescendant("/p/src", "/p/src")).toBe(true);
  });

  it("counts children at any depth", () => {
    expect(isSelfOrDescendant("/p/src", "/p/src/a/b/c.ts")).toBe(true);
  });

  it("does NOT treat a name-prefix sibling as a child", () => {
    // The regression this guards: "/p/src2" starts with "/p/src", so a bare startsWith would dim
    // it on a cut and prune its cache on a delete.
    expect(isSelfOrDescendant("/p/src", "/p/src2")).toBe(false);
    expect(isSelfOrDescendant("/p/src", "/p/src2/deep.ts")).toBe(false);
  });

  it("is not symmetric", () => {
    expect(isSelfOrDescendant("/p/src/a", "/p/src")).toBe(false);
  });
});

describe("pasteTargetDir / createTargetDir", () => {
  it("pastes into a folder itself", () => {
    expect(pasteTargetDir(dir("/p/src"))).toBe("/p/src");
  });

  it("pastes into the PARENT of a file, not the file", () => {
    expect(pasteTargetDir(file("/p/src/index.ts"))).toBe("/p/src");
  });

  it("creates a sibling when the target is a file", () => {
    expect(createTargetDir(file("/p/src/index.ts"))).toBe("/p/src");
    expect(createTargetDir(dir("/p/src"))).toBe("/p/src");
  });
});

describe("clipboard transitions", () => {
  it("marks mode and carries name/kind", () => {
    expect(cutItem(file("/p/a.txt"))).toEqual({
      mode: "cut",
      path: "/p/a.txt",
      name: "a.txt",
      kind: "file",
    });
    expect(copyItem(dir("/p/src"))).toEqual({
      mode: "copy",
      path: "/p/src",
      name: "src",
      kind: "dir",
    });
  });

  it("consumes a cut on paste but keeps a copy", () => {
    // A cut source no longer exists at that path; keeping it would make the next paste fail.
    expect(clipboardAfterPaste(cutItem(file("/p/a.txt")))).toBeNull();
    // Copy-once-paste-thrice has to work.
    const copied = copyItem(file("/p/a.txt"));
    expect(clipboardAfterPaste(copied)).toBe(copied);
    expect(clipboardAfterPaste(null)).toBeNull();
  });

  it("clears when the clipboard source is deleted", () => {
    const c = cutItem(file("/p/src/a.txt"));
    expect(clipboardAfterRemoval(c, "/p/src/a.txt")).toBeNull();
    expect(clipboardAfterRemoval(c, "/p/src")).toBeNull(); // an ancestor went away
    expect(clipboardAfterRemoval(c, "/p/src2")).toBe(c); // prefix sibling must not clear it
    expect(clipboardAfterRemoval(c, "/p/other")).toBe(c);
  });

  it("dims a cut item and everything under it, and nothing on a copy", () => {
    const cut = cutItem(dir("/p/src"));
    expect(isCutPending(cut, "/p/src")).toBe(true);
    expect(isCutPending(cut, "/p/src/a.txt")).toBe(true);
    expect(isCutPending(cut, "/p/src2")).toBe(false);
    expect(isCutPending(copyItem(dir("/p/src")), "/p/src")).toBe(false);
    expect(isCutPending(null, "/p/src")).toBe(false);
  });
});

describe("canPasteInto", () => {
  const srcDir: ClipboardItem = copyItem(dir("/p/src"));

  it("refuses with a stated reason when the clipboard is empty", () => {
    const r = canPasteInto(null, "/p");
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("refuses a folder into itself or its own subtree", () => {
    expect(canPasteInto(srcDir, "/p/src").ok).toBe(false);
    expect(canPasteInto(srcDir, "/p/src/nested").ok).toBe(false);
    expect(canPasteInto(srcDir, "/p/src/nested").reason).toMatch(/itself/);
  });

  it("allows a folder into a prefix-sibling directory", () => {
    expect(canPasteInto(srcDir, "/p/src2").ok).toBe(true);
  });

  it("allows a FILE copy back into its own directory — that is how you duplicate it", () => {
    // main auto-renames to "a 2.txt", so this is a real operation, not a no-op.
    const r = canPasteInto(copyItem(file("/p/src/a.txt")), "/p/src");
    expect(r.ok).toBe(true);
    expect(r.noop).toBeUndefined();
  });

  it("flags a cut back into the same directory as a no-op", () => {
    const r = canPasteInto(cutItem(file("/p/src/a.txt")), "/p/src");
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(true);
  });

  it("refuses when there is no destination directory", () => {
    // parentDirOf can return "" for a path with no separator; pasting into "" would resolve
    // against the app's cwd, i.e. outside the project.
    expect(canPasteInto(srcDir, "").ok).toBe(false);
  });

  it("allows a CUT out of a folder into that folder's own parent", () => {
    // The reverse of the self-paste no-op, and a case the subtree check must not catch: /p is not
    // inside /p/src, so moving src's child up to /p is legal.
    const r = canPasteInto(cutItem(file("/p/src/a.txt")), "/p");
    expect(r.ok).toBe(true);
    expect(r.noop).toBeUndefined();
  });

  it("allows a cut FOLDER into a sibling directory", () => {
    expect(canPasteInto(cutItem(dir("/p/src")), "/p/docs")).toEqual({ ok: true });
  });
});

describe("splitNameForRename", () => {
  it("leaves the extension out of the pre-selection", () => {
    expect(splitNameForRename("notes.md")).toEqual({ stem: "notes", ext: ".md" });
  });

  it("treats only the LAST dot as the extension", () => {
    expect(splitNameForRename("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: ".gz" });
  });

  it("does not treat a leading dot as an extension", () => {
    // Selecting "" and leaving ".gitignore" unselected would look like a broken rename.
    expect(splitNameForRename(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(splitNameForRename(".env.local")).toEqual({ stem: ".env", ext: ".local" });
  });

  it("selects the whole name when there is no extension", () => {
    expect(splitNameForRename("Makefile")).toEqual({ stem: "Makefile", ext: "" });
  });

  it("selects a whole directory name, dots included", () => {
    expect(splitNameForRename(".github", "dir")).toEqual({ stem: ".github", ext: "" });
    expect(splitNameForRename("v1.2", "dir")).toEqual({ stem: "v1.2", ext: "" });
  });

  it("handles a trailing dot without producing an out-of-range selection", () => {
    expect(splitNameForRename("weird.")).toEqual({ stem: "weird", ext: "." });
  });
});

describe("dirsToRefresh", () => {
  it("refreshes the parent after a create", () => {
    expect(dirsToRefresh({ kind: "create", parentDir: "/p/src" })).toEqual(["/p/src"]);
  });

  it("refreshes the parent once after an in-place rename", () => {
    expect(
      dirsToRefresh({ kind: "rename", from: "/p/src/a.txt", to: "/p/src/b.txt" })
    ).toEqual(["/p/src"]);
  });

  it("refreshes BOTH ends of a move", () => {
    // The source directory is the half that is easy to forget; miss it and the moved row stays
    // visible at a path that no longer exists.
    expect(dirsToRefresh({ kind: "move", from: "/p/src/a.txt", destDir: "/p/docs" })).toEqual([
      "/p/src",
      "/p/docs",
    ]);
  });

  it("collapses a move within one directory to a single refresh", () => {
    expect(dirsToRefresh({ kind: "move", from: "/p/src/a.txt", destDir: "/p/src" })).toEqual([
      "/p/src",
    ]);
    expect(dirsToRefresh({ kind: "move", from: "/p/src/a.txt", destDir: "/p/src/" })).toEqual([
      "/p/src",
    ]);
  });

  it("refreshes only the destination after a copy", () => {
    expect(dirsToRefresh({ kind: "copy", destDir: "/p/docs" })).toEqual(["/p/docs"]);
  });

  it("refreshes the parent after a trash", () => {
    expect(dirsToRefresh({ kind: "trash", target: "/p/src/a.txt" })).toEqual(["/p/src"]);
  });

  it("drops an unresolvable parent instead of emitting a relative path", () => {
    // "" would be sent to readDirectory and resolve somewhere unrelated.
    expect(dirsToRefresh({ kind: "trash", target: "loose.txt" })).toEqual([]);
  });
});

describe("clampMenuPosition", () => {
  const W = 200;
  const H = 300;

  it("opens at the pointer when there is room", () => {
    expect(clampMenuPosition(50, 60, W, H, 1000, 800)).toEqual({ left: 50, top: 60 });
  });

  it("flips left of the pointer near the right edge", () => {
    expect(clampMenuPosition(950, 60, W, H, 1000, 800).left).toBe(750);
  });

  it("flips above the pointer near the bottom edge", () => {
    expect(clampMenuPosition(50, 700, W, H, 1000, 800).top).toBe(400);
  });

  it("clamps rather than going off the near edge when flipping cannot fit it", () => {
    // Viewport narrower/shorter than the menu: cut off at the far edge, never at the top-left,
    // because the top-left is where the first item (and the focus) is.
    const r = clampMenuPosition(10, 10, W, H, 150, 200);
    expect(r.left).toBe(6);
    expect(r.top).toBe(6);
  });
});

describe("pruneSubtree", () => {
  it("removes the node and its descendants", () => {
    const cache = {
      "/p": [1],
      "/p/src": [2],
      "/p/src/deep": [3],
      "/p/src2": [4],
      "/p/other": [5],
    };
    expect(pruneSubtree(cache, "/p/src")).toEqual({
      "/p": [1],
      "/p/src2": [4], // prefix sibling survives
      "/p/other": [5],
    });
  });

  it("returns the SAME object when nothing matched, so no needless re-render", () => {
    const cache = { "/p/src": [1] };
    expect(pruneSubtree(cache, "/p/nothing-here")).toBe(cache);
  });

  it("does not mutate the input", () => {
    const cache = { "/p/src": [1], "/p/other": [2] };
    pruneSubtree(cache, "/p/src");
    expect(Object.keys(cache).sort()).toEqual(["/p/other", "/p/src"]);
  });

  it("works on the boolean expand-state map too", () => {
    const expanded: Record<string, boolean> = { "/p/src": true, "/p/src/deep": true };
    expect(pruneSubtree(expanded, "/p/src")).toEqual({});
  });
});
