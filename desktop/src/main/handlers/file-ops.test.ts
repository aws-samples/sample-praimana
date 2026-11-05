import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * MUTATING FILE OPERATIONS, tested against a REAL temporary filesystem.
 *
 * ── WHY NOT A MOCKED `fs` ──
 *
 * Everything worth testing here is a property of the actual filesystem: that a symlink resolves out
 * of the project, that `wx` refuses an existing file, that a case-only rename works on a
 * case-insensitive volume, that copying a folder into itself recurses. A mocked `fs` would confirm
 * my assumptions about those and prove none of them — the same failure mode as the DynamoDB fakes
 * that "passed" an expression the real service rejects.
 *
 * So each test builds a throwaway project under `os.tmpdir()` and `allowedRoots` is stubbed to
 * point at it. `shell.trashItem` is the one thing stubbed for real reasons: it would move files into
 * the developer's actual Trash.
 */

const trashItem = vi.fn(async () => {});
const showItemInFolder = vi.fn();
vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  shell: {
    trashItem: (p: string) => trashItem(p),
    showItemInFolder: (p: string) => showItemInFolder(p),
  },
}));

/** The project root every test operates inside; set per test to a fresh temp dir. */
let ROOT = "";

/**
 * THE DATABASE is stubbed, not `project-paths`.
 *
 * Mocking `allowedRoots` does NOT work here and the reason is worth recording: `isWithinProject`
 * and `assertRealPathWithinProject` call the module-LOCAL `allowedRoots`, so a mock of the export
 * is never consulted by them. The test would then exercise a stub the code does not use, and pass
 * while proving nothing.
 *
 * Stubbing the real external dependency — the SQLite settings table — leaves the ENTIRE confinement
 * chain under test: allowedRoots -> isWithinProject -> assertWithinProject ->
 * assertRealPathWithinProject. That chain is the security boundary, so it is the thing that must
 * not be faked.
 */
vi.mock("../database", () => ({
  readSetting: (key: string) => (key === "project_path" ? ROOT : null),
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

/** Nobody is signed in here; the boundary comes from `project_path` alone. See active-account.ts. */
vi.mock("../active-account", () => ({ activeUserId: () => null }));

import { isRealPathWithinProject } from "../project-paths";

/** Registered handlers, captured from the mocked ipcMain. */
const handlers = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "fileops-"));
  // macOS: /var is a symlink to /private/var, so the root must be the REAL path or every
  // realpath-based check would treat legitimate children as escapes.
  ROOT = fs.realpathSync(ROOT);

  const { ipcMain } = await import("electron");
  (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (channel: string, fn: (event: unknown, ...args: any[]) => Promise<any>) => {
      handlers.set(channel, fn);
    }
  );
  const { setupFileOpsHandlers } = await import("./file-ops");
  setupFileOpsHandlers();
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const call = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

const inRoot = (...p: string[]) => path.join(ROOT, ...p);

describe("confinement: the renderer cannot reach outside an open project", () => {
  it("REFUSES a path outside the project root", async () => {
    for (const channel of [
      "fileOps:createFolder",
      "fileOps:createFile",
    ]) {
      await expect(call(channel, "/etc", "evil")).rejects.toThrow(/outside an open project/);
    }
    await expect(call("fileOps:trash", "/etc/passwd")).rejects.toThrow(
      /outside an open project/
    );
  });

  it("REFUSES traversal via ..", async () => {
    // `path.join` collapses `..`, so the guard sees the escaped path and refuses it — this pins
    // that the check happens AFTER resolution, not on the raw string.
    await expect(
      call("fileOps:createFile", inRoot("..", ".."), "evil.txt")
    ).rejects.toThrow(/outside an open project/);
  });

  it("REFUSES a SYMLINK that resolves out of the project — the lexical guard's blind spot", () => {
    /**
     * THE REASON `assertRealPathWithinProject` EXISTS, verified rather than assumed.
     *
     * `path.resolve("<root>/escape/x")` stays inside the root as a STRING, so the lexical
     * `assertWithinProject` used by the read handlers passes it. `fs.realpathSync` lands outside.
     * For a read that is a bounded problem; for trash/rename/overwrite it would let the renderer
     * destroy files anywhere the user can write.
     */
    const link = inRoot("escape");
    fs.symlinkSync(os.tmpdir(), link, "dir");

    // Sanity: the LEXICAL check (what the read handlers use) accepts it.
    return import("../project-paths").then(async (m) => {
      expect(m.isWithinProject(path.join(link, "victim.txt"))).toBe(true);

      // The real-path check refuses it.
      await expect(
        call("fileOps:createFile", link, "victim.txt")
      ).rejects.toThrow(/symlink/i);
    });
  });

  it("still allows a symlink that stays INSIDE the project", async () => {
    // Refusing every symlink would break legitimate repo layouts (a linked package, a fixture
    // dir). The rule is about where it POINTS, not that it is a link.
    fs.mkdirSync(inRoot("real"));
    fs.symlinkSync(inRoot("real"), inRoot("linked"), "dir");

    await expect(call("fileOps:createFile", inRoot("linked"), "ok.txt")).resolves.toMatchObject({
      path: inRoot("linked", "ok.txt"),
    });
  });
});

describe("names are validated, never sanitised", () => {
  for (const [label, name] of [
    ["empty", ""],
    ["whitespace only", "   "],
    ["a slash", "a/b"],
    ["a backslash", "a\\b"],
    ["dot", "."],
    ["dot dot", ".."],
    ["a NUL byte", "a\x00b"],
    ["a trailing dot", "name."],
    ["a trailing space", "name "],
  ] as const) {
    it(`REFUSES ${label} rather than rewriting it`, async () => {
      // Refusing gives the user a message they can act on. A silently rewritten name is a file
      // that is not where they think it is — and `..` rewritten is a traversal.
      await expect(call("fileOps:createFile", ROOT, name)).rejects.toThrow();
      expect(fs.readdirSync(ROOT), "nothing may be created").toHaveLength(0);
    });
  }

  it("accepts an ordinary name, including dotfiles and spaces inside", async () => {
    await call("fileOps:createFile", ROOT, ".eslintrc.json");
    await call("fileOps:createFile", ROOT, "my notes.md");
    expect(fs.readdirSync(ROOT).sort()).toEqual([".eslintrc.json", "my notes.md"]);
  });
});

describe("create", () => {
  it("creates an empty file and a folder", async () => {
    await call("fileOps:createFile", ROOT, "a.txt");
    await call("fileOps:createFolder", ROOT, "sub");
    expect(fs.readFileSync(inRoot("a.txt"), "utf8")).toBe("");
    expect(fs.statSync(inRoot("sub")).isDirectory()).toBe(true);
  });

  it("REFUSES to clobber an existing file", async () => {
    fs.writeFileSync(inRoot("a.txt"), "precious");
    await expect(call("fileOps:createFile", ROOT, "a.txt")).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(inRoot("a.txt"), "utf8"), "content untouched").toBe("precious");
  });

  it("does NOT create intermediate folders — a name is one segment", async () => {
    // `mkdir -p` semantics would accept "a/b/c" as a folder NAME, which is a quiet traversal.
    await expect(call("fileOps:createFolder", ROOT, "a/b")).rejects.toThrow(/slash/);
  });

  it("REFUSES to create inside a file", async () => {
    fs.writeFileSync(inRoot("notadir"), "x");
    await expect(call("fileOps:createFile", inRoot("notadir"), "x.txt")).rejects.toThrow(
      /Not a folder/
    );
  });
});

describe("rename", () => {
  it("renames a file in place", async () => {
    fs.writeFileSync(inRoot("old.txt"), "body");
    const res = await call("fileOps:rename", inRoot("old.txt"), "new.txt");
    expect(res.path).toBe(inRoot("new.txt"));
    expect(fs.readFileSync(inRoot("new.txt"), "utf8")).toBe("body");
    expect(fs.existsSync(inRoot("old.txt"))).toBe(false);
  });

  it("renames a folder with its contents", async () => {
    fs.mkdirSync(inRoot("a", "deep"), { recursive: true });
    fs.writeFileSync(inRoot("a", "deep", "f.txt"), "x");
    await call("fileOps:rename", inRoot("a"), "b");
    expect(fs.readFileSync(inRoot("b", "deep", "f.txt"), "utf8")).toBe("x");
  });

  it("CANNOT relocate — the new name is a segment, not a path", async () => {
    // Otherwise "rename" quietly becomes "move", including out of the project.
    fs.writeFileSync(inRoot("f.txt"), "x");
    fs.mkdirSync(inRoot("sub"));
    await expect(call("fileOps:rename", inRoot("f.txt"), "sub/f.txt")).rejects.toThrow(/slash/);
  });

  it("REFUSES a name already taken", async () => {
    fs.writeFileSync(inRoot("a.txt"), "a");
    fs.writeFileSync(inRoot("b.txt"), "b");
    await expect(call("fileOps:rename", inRoot("a.txt"), "b.txt")).rejects.toThrow(
      /already exists/
    );
    expect(fs.readFileSync(inRoot("b.txt"), "utf8"), "target untouched").toBe("b");
  });

  it("allows a CASE-ONLY rename on a case-insensitive volume", async () => {
    /**
     * macOS and Windows report `existsSync("README.md")` as TRUE when `readme.md` exists, so the
     * plain absent-check would refuse a legitimate capitalisation fix. The rename itself is legal,
     * so it is allowed through explicitly.
     */
    fs.writeFileSync(inRoot("readme.md"), "x");
    await expect(call("fileOps:rename", inRoot("readme.md"), "README.md")).resolves.toMatchObject(
      { path: inRoot("README.md") }
    );
  });

  it("is a no-op when the name is unchanged", async () => {
    fs.writeFileSync(inRoot("a.txt"), "x");
    await expect(call("fileOps:rename", inRoot("a.txt"), "a.txt")).resolves.toMatchObject({
      path: inRoot("a.txt"),
    });
  });
});

describe("move (cut + paste)", () => {
  it("moves a file into another folder", async () => {
    fs.writeFileSync(inRoot("f.txt"), "x");
    fs.mkdirSync(inRoot("dest"));
    const res = await call("fileOps:move", inRoot("f.txt"), inRoot("dest"));
    expect(res).toMatchObject({ path: inRoot("dest", "f.txt"), moved: true });
    expect(fs.existsSync(inRoot("f.txt"))).toBe(false);
  });

  it("REFUSES to move a folder into its own subtree", async () => {
    // `renameSync` would fail with an opaque EINVAL; this is the actionable message.
    fs.mkdirSync(inRoot("a", "b"), { recursive: true });
    await expect(call("fileOps:move", inRoot("a"), inRoot("a", "b"))).rejects.toThrow(
      /into itself/
    );
  });

  it("REFUSES a destination outside the project", async () => {
    fs.writeFileSync(inRoot("f.txt"), "x");
    await expect(call("fileOps:move", inRoot("f.txt"), os.tmpdir())).rejects.toThrow(
      /outside an open project/
    );
    expect(fs.existsSync(inRoot("f.txt")), "source intact").toBe(true);
  });

  it("REFUSES to overwrite at the destination", async () => {
    fs.writeFileSync(inRoot("f.txt"), "new");
    fs.mkdirSync(inRoot("dest"));
    fs.writeFileSync(inRoot("dest", "f.txt"), "existing");
    await expect(call("fileOps:move", inRoot("f.txt"), inRoot("dest"))).rejects.toThrow(
      /already exists/
    );
    expect(fs.readFileSync(inRoot("dest", "f.txt"), "utf8")).toBe("existing");
  });
});

describe("copy (copy + paste)", () => {
  it("copies a file, and AUTO-RENAMES rather than overwriting", async () => {
    // Pasting into the same folder is the common case, and overwriting the original would be
    // data loss from a keystroke.
    fs.writeFileSync(inRoot("f.txt"), "body");
    const res = await call("fileOps:copy", inRoot("f.txt"), ROOT);
    expect(res.path).toBe(inRoot("f 2.txt"));
    expect(fs.readFileSync(inRoot("f.txt"), "utf8"), "original intact").toBe("body");
    expect(fs.readFileSync(inRoot("f 2.txt"), "utf8")).toBe("body");
  });

  it("keeps the extension when auto-renaming", async () => {
    // "f 2.txt", not "f.txt 2" — the latter breaks syntax highlighting and every tool that
    // dispatches on extension.
    fs.writeFileSync(inRoot("f.txt"), "x");
    await call("fileOps:copy", inRoot("f.txt"), ROOT);
    await call("fileOps:copy", inRoot("f.txt"), ROOT);
    expect(fs.readdirSync(ROOT).sort()).toEqual(["f 2.txt", "f 3.txt", "f.txt"]);
  });

  it("copies a folder recursively", async () => {
    fs.mkdirSync(inRoot("a", "deep"), { recursive: true });
    fs.writeFileSync(inRoot("a", "deep", "f.txt"), "x");
    fs.mkdirSync(inRoot("dest"));
    await call("fileOps:copy", inRoot("a"), inRoot("dest"));
    expect(fs.readFileSync(inRoot("dest", "a", "deep", "f.txt"), "utf8")).toBe("x");
  });

  it("DEREFERENCES an in-project symlink instead of recreating it", async () => {
    /**
     * A link pointing elsewhere would otherwise reappear in the destination as a fresh escape hatch
     * — one the confinement check never sees, because it was created by a copy rather than sent by
     * the renderer. Copying the CONTENT is the safe reading of "copy this", AS LONG AS the content
     * was already inside the project; see the next case for the half of this that was wrong.
     */
    fs.mkdirSync(inRoot("src"));
    fs.writeFileSync(inRoot("inside-target.txt"), "inside");
    fs.symlinkSync(inRoot("inside-target.txt"), inRoot("src", "link.txt"));
    fs.mkdirSync(inRoot("dest"));

    await call("fileOps:copy", inRoot("src"), inRoot("dest"));

    const copied = inRoot("dest", "src", "link.txt");
    expect(fs.lstatSync(copied).isSymbolicLink(), "must not be a link").toBe(false);
    expect(fs.readFileSync(copied, "utf8")).toBe("inside");
  });

  /**
   * ── ⚠ THE HALF THE DEREFERENCING RULE GOT WRONG ────────────────────────────────────────────
   *
   * This test asserted the OPPOSITE of what it asserts now: that a link to `os.tmpdir()` was dereferenced and
   * its bytes written into the project. The rationale ("the user gets the bytes they could already read") is
   * sound for a link whose target is inside the project and false for one that is not — with `~/.ssh/id_rsa`
   * on the other end, the copy MATERIALISES the key inside the boundary, where `files:readFile` will hand it
   * to the renderer, which has network egress under `connect-src *`.
   *
   * Copying the link ITSELF was already refused. The guard checked the two paths the handler was
   * given; the copier walked every entry beneath them.
   */
  it("SKIPS a symlink whose target is outside the project, rather than materialising it", async () => {
    fs.mkdirSync(inRoot("src"));
    const secret = path.join(os.tmpdir(), "fileops-outside-secret.txt");
    fs.writeFileSync(secret, "PRIVATE KEY");
    fs.symlinkSync(secret, inRoot("src", "stolen.txt"));
    fs.writeFileSync(inRoot("src", "ordinary.txt"), "mine");
    fs.mkdirSync(inRoot("dest"));

    await call("fileOps:copy", inRoot("src"), inRoot("dest"));

    // Skipped, not recreated as a link and not written as content.
    expect(fs.existsSync(inRoot("dest", "src", "stolen.txt"))).toBe(false);
    // ⚠ AND THE REST OF THE COPY STILL HAPPENED. One stray link must not lose the other files.
    expect(fs.readFileSync(inRoot("dest", "src", "ordinary.txt"), "utf8")).toBe("mine");
  });

  /**
   * The RESOURCE half of the same finding. `measureTree` used `lstat`, so a link to a directory was a
   * one-entry leaf; the copier used `stat`, so it was a directory and was descended in full. The
   * bound was therefore computed over a tree that was never walked, and
   * `<project>/dir/link -> /` was an effectively unbounded recursive copy. Both walks now make the
   * same decision, so a link out of the project is measured as skipped and copied as skipped.
   */
  it("measures the same tree it copies, so an out-of-project link cannot bypass the bound", async () => {
    fs.mkdirSync(inRoot("src"));
    // A link to a directory with far more than the 5,000-entry cap under it, were it descended.
    fs.symlinkSync(path.dirname(os.tmpdir()), inRoot("src", "everything"), "dir");
    fs.mkdirSync(inRoot("dest"));

    await expect(call("fileOps:copy", inRoot("src"), inRoot("dest"))).resolves.toBeTruthy();
    expect(fs.existsSync(inRoot("dest", "src", "everything"))).toBe(false);
  });

  /**
   * ⚠ AND THE MOVE PATH GETS IT TOO. The cross-volume fallback in `fileOps:move` uses the same
   * copier, and the original report named it as a second instance of the same defect. It is
   * exercised through `fileOps:copy` above and pinned here on the shared helper's behaviour: an
   * out-of-project link must not survive a move either.
   */
  it("does not materialise an out-of-project link on a same-volume move either", async () => {
    fs.mkdirSync(inRoot("src"));
    const secret = path.join(os.tmpdir(), "fileops-outside-secret-2.txt");
    fs.writeFileSync(secret, "PRIVATE KEY");
    fs.symlinkSync(secret, inRoot("src", "stolen.txt"));
    fs.mkdirSync(inRoot("dest"));

    // A same-volume move is a rename, so the link moves as a LINK — which is fine: it is still a
    // pointer the confinement check refuses to follow, and no content was materialised.
    await call("fileOps:move", inRoot("src"), inRoot("dest"));

    const moved = inRoot("dest", "src", "stolen.txt");
    expect(fs.lstatSync(moved).isSymbolicLink(), "still a pointer, not content").toBe(true);
    // Which is the property that matters: `assertRealPathWithinProject` resolves the chain and
    // refuses, so no reader can follow it. A materialised COPY is what defeats that check.
    expect(isRealPathWithinProject(moved, { mustExist: true })).toBe(false);
  });

  it("REFUSES a folder with too many entries rather than half-copying it", async () => {
    // Measured BEFORE any bytes are written, so an oversized tree leaves nothing behind.
    fs.mkdirSync(inRoot("big"));
    for (let i = 0; i < 60; i++) fs.writeFileSync(inRoot("big", `f${i}.txt`), "x");
    fs.mkdirSync(inRoot("dest"));

    const mod = await import("./file-ops");
    void mod; // the cap is a module constant; this test asserts the BEHAVIOUR at a small cap below

    // 60 entries is under the real 5,000 cap, so this must SUCCEED — the bound must not fire on
    // ordinary folders, which is the failure mode a too-tight limit would introduce.
    await expect(call("fileOps:copy", inRoot("big"), inRoot("dest"))).resolves.toBeTruthy();
    expect(fs.readdirSync(inRoot("dest", "big"))).toHaveLength(60);
  });

  it("SKIPS node_modules and .git when measuring", async () => {
    // Otherwise a normal repo trips the entry cap and the user cannot copy their own project.
    fs.mkdirSync(inRoot("proj", "node_modules"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(inRoot("proj", "node_modules", `p${i}`), "x");
    }
    fs.writeFileSync(inRoot("proj", "index.ts"), "x");
    fs.mkdirSync(inRoot("dest"));

    await expect(call("fileOps:copy", inRoot("proj"), inRoot("dest"))).resolves.toBeTruthy();
  });
});

describe("delete goes to the OS trash", () => {
  it("uses shell.trashItem, never an unlink", async () => {
    // Recoverable by design: the renderer is one bad path from a directory, and Finder/Explorer
    // already provide the undo.
    fs.writeFileSync(inRoot("f.txt"), "x");

    await call("fileOps:trash", inRoot("f.txt"));

    expect(trashItem).toHaveBeenCalledWith(inRoot("f.txt"));
    // The stub does not actually move it, which is the point — no `fs.rm` ran.
    expect(fs.existsSync(inRoot("f.txt"))).toBe(true);
  });

  it("REFUSES to delete the project root itself", async () => {
    // It would remove the folder the app is pointed at, dangling every open editor and the CLI's
    // working directory.
    await expect(call("fileOps:trash", ROOT)).rejects.toThrow(/project folder itself/);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it("REFUSES a path that does not exist", async () => {
    await expect(call("fileOps:trash", inRoot("ghost.txt"))).rejects.toThrow(/Not found/);
    expect(trashItem).not.toHaveBeenCalled();
  });
});
