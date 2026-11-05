// ── ⚠ A READ IS AN EXFILTRATION PRIMITIVE, SO READS RESOLVE SYMLINKS TOO ──────────────────────
//
// Those three handlers gated on `assertWithinProject`, which compares `path.resolve(target)` against
// the open project roots and is therefore purely textual. One directory symlink inside a project
// defeats it:
//
//     ln -s / <project>/x
//     path.resolve("<project>/x/etc")  ->  "<project>/x/etc"   ✔ passes the lexical check
//     fs.realpathSync(same)            ->  "/etc"              ✘ outside the project
//
// `files:readDirectory` then lists the target, and every entry it returns is a path the renderer can
// pass straight back in — so recursion turns one link into a walkable enumeration of the whole
// filesystem, with names, types and sizes. The renderer's CSP is `connect-src *`, so it has an egress
// path for what it finds.
//
// ⚠ THE PRECONDITION IS NOT AN ATTACKER WITH A SHELL. `git clone` writes symlinks verbatim, and cloning
// a repository is the first thing this app asks a participant to do.
//
// ⚠ REAL FILESYSTEM, REAL SYMLINKS, for the reason project-paths.realpath.test.ts gives: whether a link
// resolves out of a project is a property of the filesystem, not of my assumptions. A fake would assert
// that these handlers call the guard I think they call — which is what the source-text assertions in
// session-ownership.test.ts are for, and is a weaker claim than this one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let ROOT = "";
let OUTSIDE = "";

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(), trashItem: vi.fn() },
  app: { getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
}));

vi.mock("../database", () => ({
  readSetting: (key: string) => (key === "project_path" ? ROOT : null),
  writeSetting: vi.fn(),
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }) }),
}));
vi.mock("../debug-log", () => ({ debugLog: () => {} }));
vi.mock("../security-audit", () => ({
  recordSecurityEvent: vi.fn(),
  redactedTarget: (s: string) => String(s),
}));

const { setupFileHandlers } = await import("./files");
const { setupFileOpsHandlers } = await import("./file-ops");

setupFileHandlers();
setupFileOpsHandlers();

const invoke = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

beforeEach(() => {
  // macOS: /var is a symlink to /private/var, so the root must be the REAL path.
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "readconf-")));
  OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "readconf-outside-")));
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const inRoot = (...p: string[]) => path.join(ROOT, ...p);

/** The hostile repository: one directory symlink pointing out of the project. */
function plantEscapeLink(name = "escape") {
  fs.symlinkSync(OUTSIDE, inRoot(name), "dir");  // nosemgrep: detect-non-literal-fs-filename
  return inRoot(name);
}

describe("⚠ files:readDirectory", () => {
  it("lists a real directory inside the project", async () => {
    fs.mkdirSync(inRoot("src"));
    fs.writeFileSync(inRoot("src", "index.ts"), "export {}");

    const entries = await invoke("files:readDirectory", inRoot("src"));

    expect(entries.map((e: any) => e.name)).toEqual(["index.ts"]);
  });

  it("⚠ REFUSES to list through a symlink that leaves the project", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "not yours");
    const link = plantEscapeLink();

    await expect(invoke("files:readDirectory", link)).rejects.toThrow(/outside an open project/i);
  });

  /**
   * ⚠ THE ENUMERATION, WHICH IS THE ACTUAL FINDING. Listing the link's target is one leak; being able to
   * feed each returned `path` back in is what makes it a filesystem browser. Asserted one level deeper
   * than the case above so a fix that only guarded the first call would still fail here.
   */
  it("⚠ REFUSES a path BELOW the escaping link, so recursion cannot walk out", async () => {
    fs.mkdirSync(path.join(OUTSIDE, "deep"));
    fs.writeFileSync(path.join(OUTSIDE, "deep", "secret.txt"), "not yours");
    plantEscapeLink();

    await expect(invoke("files:readDirectory", inRoot("escape", "deep"))).rejects.toThrow(
      /outside an open project/i
    );
  });

  it("still refuses a plainly outside path", async () => {
    await expect(invoke("files:readDirectory", OUTSIDE)).rejects.toThrow(/outside an open project/i);
  });

  /**
   * ⚠ A LINK'S OWN SIZE, NOT ITS TARGET'S. `statSync` follows, so a symlink inside the project reported
   * the size of whatever it pointed at — a far smaller leak than the traversal, and one the guard on the
   * directory does not close because the link is a legitimate entry of a legitimate directory.
   */
  it("describes a symlinked file rather than following it", async () => {
    const target = path.join(OUTSIDE, "big.bin");
    fs.writeFileSync(target, "x".repeat(4096));
    fs.symlinkSync(target, inRoot("link.bin"));

    const entries = await invoke("files:readDirectory", ROOT);
    const link = entries.find((e: any) => e.name === "link.bin");

    expect(link, "the entry is still listed — it IS inside the project").toBeTruthy();
    expect(link.size, "but not sized by its target").not.toBe(4096);
  });
});

describe("⚠ files:getProjectInfo", () => {
  it("reads a package.json inside the project", async () => {
    fs.writeFileSync(inRoot("package.json"), JSON.stringify({ name: "mine" }));

    expect(await invoke("files:getProjectInfo", ROOT)).toMatchObject({ name: "mine" });
  });

  /**
   * ⚠ AN EXISTENCE ORACLE PLUS A CONTENT FIELD. It reports whether `<dir>/package.json` is there and
   * returns the `name` out of it, which through a link is a probe for any directory on the machine.
   */
  it("⚠ REFUSES to read through a symlink that leaves the project", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "package.json"), JSON.stringify({ name: "theirs" }));
    const link = plantEscapeLink();

    await expect(invoke("files:getProjectInfo", link)).rejects.toThrow(/outside an open project/i);
  });
});

describe("⚠ fileOps:revealInFolder", () => {
  it("reveals a file inside the project", async () => {
    fs.writeFileSync(inRoot("notes.md"), "hello");

    await expect(invoke("fileOps:revealInFolder", inRoot("notes.md"))).resolves.toMatchObject({
      revealed: inRoot("notes.md"),
    });
  });

  /**
   * Read-only, so the stakes are lower than the mutations in the same file — but "open a native window
   * anywhere on disk, selecting a named file" is not something the renderer should be able to ask for.
   */
  it("⚠ REFUSES to reveal through a symlink that leaves the project", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "not yours");
    plantEscapeLink();

    await expect(
      invoke("fileOps:revealInFolder", inRoot("escape", "secret.txt"))
    ).rejects.toThrow(/outside an open project/i);
  });
});

describe("⚠ files:searchFiles", () => {
  it("finds a file inside the project", async () => {
    fs.mkdirSync(inRoot("src"));
    fs.writeFileSync(inRoot("src", "routes.ts"), "export {}");

    const result = await invoke("files:searchFiles", ROOT, "routes");

    expect(result.files.map((f: any) => f.name)).toEqual(["routes.ts"]);
  });

  /**
   * ⚠ THE PER-HIT CHECK WAS ALWAYS HERE, so this route was never exploitable. Pinned anyway, because the
   * root check became the real-path variant in the same change and a regression in either layer should
   * fail something.
   */
  it("⚠ does not return hits that resolve out of the project", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "routes.ts"), "theirs");
    plantEscapeLink();

    const result = await invoke("files:searchFiles", ROOT, "routes");

    expect(result.files, "a symlinked-out hit is not a result").toEqual([]);
  });

  it("refuses a root that is itself reached through an escaping link", async () => {
    const link = plantEscapeLink();

    await expect(invoke("files:searchFiles", link, "anything")).rejects.toThrow(
      /outside an open project/i
    );
  });
});

/**
 * ── ⚠ NO ENTRY POINT ON THIS BOUNDARY DECIDES CONFINEMENT TEXTUALLY ───────────────────────────
 *
 * The flat invariant the conversion leaves behind, and the reason `files:searchFiles` was converted
 * too even though its per-hit check already covered it. `assertWithinProject` still exists — it is what
 * `assertRealPathWithinProject` calls first — but no IPC handler may be the last word on a path.
 */
describe("⚠ the lexical guard has no callers left among the handlers", () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");  // nosemgrep: detect-non-literal-fs-filename
  };
  /** Comments discuss the lexical guard by name; only code counts. */
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  for (const file of ["./files.ts", "./file-ops.ts"]) {
    it(`${file} calls only the real-path variant`, async () => {
      const code = strip(await read(file));
      // `assertRealPathWithinProject(` contains the shorter name, so match a call that is NOT that one.
      const lexicalCalls = code.match(/(?<!RealPath)(?<![A-Za-z])assertWithinProject\(/g) ?? [];
      expect(lexicalCalls, `${file} must not decide a path lexically`).toEqual([]);
    });
  }
});

// ── ⚠ ONE VALIDATED STRING IS USED FOR EVERY SYSCALL IN THE HANDLER ──────────────────────────
//
// The cases above prove a symlink cannot take a read OUT of the project. This pins something
// narrower that had no coverage at all: that `files:readDirectory` consumes the value the guard
// RETURNED, and never re-reads the caller's original argument afterwards.
//
// It calls `assertRealPathWithinProject(dirPath)` -> `safeDir`, and three lines then use it:
// `readdirSync`, the `path.join` building each entry's `path`, and the `lstatSync` sizing each file.
// One of them previously used the raw `dirPath` - the "validate one value, act on another"
// shape - and reverting that fix broke NO test, which is why this block exists.
//
// ⚠ BE PRECISE ABOUT WHAT THE FIX WAS AND WAS NOT, because it was first recorded as more than it is.
// `assertRealPathWithinProject` returns `path.resolve(target)` - the LEXICALLY normalised path. It
// calls `realpathSync` to DECIDE containment and then throws that resolution away (project-paths.ts,
// `return resolved`). So `safeDir` is not the symlink-resolved real path, and for an
// already-absolute argument it is very often the identical string to `dirPath`.
//
// That means the change was a CONSISTENCY fix, not a TOCTOU fix. An earlier disposition of this work
// claimed it closed a symlink-swap race; it does not. The kernel still re-resolves the string at each
// later syscall, so the window between the guard's `realpathSync` and the handler's `readdirSync`
// remains. Closing it properly means changing the guard's contract to return the REAL path and
// auditing every caller that currently relies on getting a lexical one back - a deliberate design
// change, not a one-line edit, and not done here.
//
// What is genuinely worth locking down is therefore the consistency itself: exactly one validated
// string reaches the filesystem. That is asserted two ways below - behaviourally, and at the source,
// because the behavioural check alone cannot distinguish the two variables when they are equal.
describe("⚠ files:readDirectory uses the guard's return value, not the raw argument", () => {
  it("lists and sizes correctly through an INTERNAL symlink, which the guard permits", async () => {
    // Both link and target inside the project: containment allows it (the rule is about where a
    // link POINTS, not that it is a link), so this exercises the success path rather than a refusal.
    fs.mkdirSync(inRoot("real"));
    fs.writeFileSync(inRoot("real", "five.txt"), "12345");
    fs.symlinkSync(inRoot("real"), inRoot("link"), "dir");

    const entries = await invoke("files:readDirectory", inRoot("link"));
    expect(entries.map((e: any) => e.name)).toEqual(["five.txt"]);

    const file = entries[0];
    // Paths come back under the caller's own (lexical) directory - documenting the guard's actual
    // contract. If `assertRealPathWithinProject` is ever changed to return the REAL path, this
    // assertion flips to inRoot("real", ...) and that change should be deliberate and reviewed,
    // not discovered.
    expect(file.path).toBe(inRoot("link", "five.txt"));
    // And the size proves the lstatSync - the line that held the raw argument - reached the real
    // file through that path rather than stat'ing a link or nothing at all.
    expect(file.type).toBe("file");
    expect(file.size).toBe(5);
  });

  /**
   * ⚠ THE ASSERTION THAT ACTUALLY CATCHES THE REGRESSION. The behavioural test above passes with
   * EITHER variable whenever the two strings are equal, which is the common case - so it cannot
   * detect a revert. This reads the source instead, in the same spirit as the lexical-guard check
   * at the end of this file: after the guard has produced `safeDir`, the handler body must not
   * mention `dirPath` again.
   */
  it("the readDirectory body never touches dirPath after the guard has run", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const code = readFileSync(fileURLToPath(new URL("./files.ts", import.meta.url)), "utf8");  // nosemgrep: detect-non-literal-fs-filename
    const marker = "const safeDir = assertRealPathWithinProject(dirPath";
    const at = code.indexOf(marker);
    expect(at, "readDirectory must still validate dirPath into safeDir").toBeGreaterThan(-1);

    // The handler body: from the guard to the end of the returned/sorted chain.
    const body = code.slice(at, code.indexOf("});", code.indexOf(".sort(", at)));
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const strays = stripped.match(/(?<![A-Za-z])dirPath(?![A-Za-z])/g) ?? [];

    // The guard call itself is the only legitimate mention, and it sits at index 0 of the slice.
    expect(
      strays.length,
      `readDirectory referenced dirPath ${strays.length} times after validating it; ` +
        "every syscall must consume safeDir so exactly one validated string reaches the filesystem",
    ).toBe(1);
  });
});
