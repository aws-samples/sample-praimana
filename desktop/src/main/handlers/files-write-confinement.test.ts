import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * `files:writeFile` CONFINEMENT, tested against a REAL temporary filesystem.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * `file-ops.test.ts` covers the mutating module and pins the symlink rule there. `files.ts` was
 * never covered the same way, and that is precisely where the rule was broken: `files:writeFile`
 * is an OVERWRITE that used the lexical `assertWithinProject`, so a symlink inside an open
 * project resolved out of it and the write landed outside. Every path the renderer sent looked
 * project-relative.
 *
 * Same reasoning as file-ops.test.ts for using a real fs: whether a symlink resolves out of a
 * project is a property of the filesystem, and a mocked `fs` would confirm my assumptions about
 * it while proving none of them. And the same reasoning for stubbing the DATABASE rather than
 * `project-paths`: `assertRealPathWithinProject` calls the module-local `allowedRoots`, so
 * mocking that export would leave the test exercising a stub the code never consults. Stubbing
 * the settings table keeps the whole chain — allowedRoots → isWithinProject → assertWithinProject
 * → assertRealPathWithinProject — under test, which is the part that must not be faked.
 */

vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn() },
}));

/** The project root every test operates inside; a fresh temp dir per test. */
let ROOT = "";
/** A directory OUTSIDE the project, standing in for ~/.ssh. */
let OUTSIDE = "";

vi.mock("../database", () => ({
  readSetting: (key: string) => (key === "project_path" ? ROOT : null),
  writeSetting: () => {},
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

const handlers = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  // macOS: /var is a symlink to /private/var, so the root must be the REAL path or every
  // realpath-based check would treat legitimate children as escapes.
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fileswrite-")));
  OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fileswrite-outside-")));

  const { ipcMain } = await import("electron");
  (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (channel: string, fn: (event: unknown, ...args: any[]) => Promise<any>) => {
      handlers.set(channel, fn);
    }
  );
  const { setupFileHandlers } = await import("./files");
  setupFileHandlers();
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const call = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return fn({}, ...args);
};

const inRoot = (...p: string[]) => path.join(ROOT, ...p);

describe("files:writeFile — legitimate writes still work", () => {
  it("creates a new file inside the project", async () => {
    await expect(call("files:writeFile", inRoot("new.txt"), "hello")).resolves.toEqual({
      success: true,
    });
    expect(fs.readFileSync(inRoot("new.txt"), "utf-8")).toBe("hello");
  });

  it("overwrites an existing file inside the project", async () => {
    fs.writeFileSync(inRoot("existing.txt"), "before");

    await call("files:writeFile", inRoot("existing.txt"), "after");

    expect(fs.readFileSync(inRoot("existing.txt"), "utf-8")).toBe("after");
  });

  it("creates a new file in a nested real directory", async () => {
    // The ancestor walk resolves the nearest EXISTING parent, so an absent file is fine as long
    // as the directory holding it is genuinely inside the project.
    fs.mkdirSync(inRoot("src", "deep"), { recursive: true });

    await expect(
      call("files:writeFile", inRoot("src", "deep", "index.ts"), "export {};")
    ).resolves.toEqual({ success: true });
  });

  it("writes through a symlink that stays INSIDE the project", async () => {
    // Refusing every symlink would break legitimate repo layouts (a linked package, a fixture
    // dir). The rule is about where the link POINTS, not that it is a link.
    fs.mkdirSync(inRoot("real"));
    fs.symlinkSync(inRoot("real"), inRoot("linked"), "dir");

    await expect(call("files:writeFile", inRoot("linked", "ok.txt"), "fine")).resolves.toEqual({
      success: true,
    });
    expect(fs.readFileSync(inRoot("real", "ok.txt"), "utf-8")).toBe("fine");
  });
});

describe("files:writeFile — the symlink escape that the lexical guard allowed", () => {
  it("REFUSES a write through a symlinked DIRECTORY pointing out of the project", async () => {
    /**
     * The finding, reproduced end to end. A symlink in the tree is not exotic: git tracks
     * symlinks, so a cloned workshop repo can ship one, and the in-app agent can create one as
     * part of normal work.
     */
    fs.symlinkSync(OUTSIDE, inRoot("escape"), "dir");
    const target = inRoot("escape", "authorized_keys");

    // Sanity, and the whole point: the LEXICAL check this handler used to call ACCEPTS it.
    const m = await import("../project-paths");
    expect(m.isWithinProject(target)).toBe(true);

    await expect(call("files:writeFile", target, "ssh-rsa attacker")).rejects.toThrow(
      /outside an open project/i
    );
    // The property that matters is not the error, it is that nothing was written.
    expect(fs.existsSync(path.join(OUTSIDE, "authorized_keys"))).toBe(false);
  });

  it("REFUSES overwriting an existing file through a symlinked directory", async () => {
    // The destructive shape: the target already exists and holds something the user needs.
    fs.writeFileSync(path.join(OUTSIDE, "id_rsa"), "PRIVATE KEY");
    fs.symlinkSync(OUTSIDE, inRoot("escape"), "dir");

    await expect(
      call("files:writeFile", inRoot("escape", "id_rsa"), "clobbered")
    ).rejects.toThrow(/outside an open project/i);

    expect(fs.readFileSync(path.join(OUTSIDE, "id_rsa"), "utf-8")).toBe("PRIVATE KEY");
  });

  it("REFUSES a write through a symlinked FILE pointing out of the project", async () => {
    // `realpathSync` on the file itself resolves the link, so the escape is caught whether the
    // link is the directory or the leaf.
    fs.writeFileSync(path.join(OUTSIDE, "target.txt"), "original");
    fs.symlinkSync(path.join(OUTSIDE, "target.txt"), inRoot("link.txt"));

    await expect(call("files:writeFile", inRoot("link.txt"), "clobbered")).rejects.toThrow(
      /outside an open project/i
    );

    expect(fs.readFileSync(path.join(OUTSIDE, "target.txt"), "utf-8")).toBe("original");
  });

  it("REFUSES a nested symlink escape several levels down", async () => {
    fs.mkdirSync(inRoot("a", "b"), { recursive: true });
    fs.symlinkSync(OUTSIDE, inRoot("a", "b", "out"), "dir");

    await expect(
      call("files:writeFile", inRoot("a", "b", "out", "pwned.txt"), "x")
    ).rejects.toThrow(/outside an open project/i);
    expect(fs.existsSync(path.join(OUTSIDE, "pwned.txt"))).toBe(false);
  });

  it("REFUSES a plain path outside the project, and traversal out of it", async () => {
    await expect(call("files:writeFile", path.join(OUTSIDE, "x.txt"), "x")).rejects.toThrow(
      /outside an open project/i
    );
    await expect(
      call("files:writeFile", inRoot("..", "..", "etc", "hosts"), "x")
    ).rejects.toThrow(/outside an open project/i);
  });

  it("fails closed when no project is open", async () => {
    const noRoot = ROOT;
    ROOT = ""; // readSetting("project_path") now yields "" → no roots at all
    try {
      await expect(call("files:writeFile", path.join(noRoot, "x.txt"), "x")).rejects.toThrow(
        /outside an open project/i
      );
    } finally {
      ROOT = noRoot;
    }
  });
});

describe("files:readFile — deliberately still the lexical guard", () => {
  it("reads a normal file inside the project", async () => {
    fs.writeFileSync(inRoot("r.txt"), "contents");
    await expect(call("files:readFile", inRoot("r.txt"))).resolves.toBe("contents");
  });

  it("refuses a path outside the project", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "secret");
    await expect(call("files:readFile", path.join(OUTSIDE, "secret.txt"))).rejects.toThrow(
      /outside an open project/i
    );
  });

  /**
   * ⚠ THE TRADE-OFF WAS UPDATED, AND THIS TEST IS WHY IT WAS VISIBLE.
   *
   * This previously asserted the OPPOSITE: that a read DOES follow a symlink out of the project,
   * pinning the documented trade — "for a READ the worst case is showing the user a file they could
   * already open in any editor" — so the next person met a deliberate decision rather than assuming
   * reads were symlink-safe. Its own comment said that changing the trade should fail this test, and
   * that the answer would then be to update the trade rather than the assertion. That is what
   * happened.
   *
   * The trade was wrong about WHO READS. The reader is the renderer, not the user, and it has network
   * egress under `connect-src *` — so paired with `files:searchFiles`, which walks through symlinks,
   * one link in a project made the two a general-purpose file reader plus an exfiltration channel.
   * Reads are where the credentials are.
   */
  it("REFUSES a read through a symlink out of the project", async () => {
    fs.writeFileSync(path.join(OUTSIDE, "readable.txt"), "outside content");
    fs.symlinkSync(OUTSIDE, inRoot("escape"), "dir");

    await expect(call("files:readFile", inRoot("escape", "readable.txt"))).rejects.toThrow(
      /outside an open project/i
    );
  });

  it("still reads a symlink that stays INSIDE the project", async () => {
    // The rule remains about where the link POINTS. Refusing every link would break a repo layout.
    fs.mkdirSync(inRoot("real"));
    fs.writeFileSync(inRoot("real", "note.md"), "inside content");
    fs.symlinkSync(inRoot("real"), inRoot("linked"), "dir");

    await expect(call("files:readFile", inRoot("linked", "note.md"))).resolves.toBe("inside content");
  });
});

describe("files:writeFile — the DANGLING symlink, which existsSync cannot see", () => {
  /**
   * The escape the first version of this guard missed, and the reason it missed it: `existsSync`
   * FOLLOWS symlinks, so a link whose target does not exist yet reports `false` — indistinguishable
   * from "no such entry". The ancestor walk stepped past the link, settled on the project root,
   * passed, and `writeFileSync` then followed the link and created the file at its target.
   *
   * Overwriting an existing file outside was already blocked (the target exists, so realpath catches
   * it). Creating a NEW one was not — which is enough for `~/Library/LaunchAgents/*.plist` login
   * persistence, `~/.zshenv`, or `~/.ssh/authorized_keys` when absent.
   */
  it("REFUSES a write through a dangling symlink pointing out of the project", async () => {
    const target = path.join(OUTSIDE, "planted.txt");
    fs.symlinkSync(target, inRoot("dangling"), "file"); // target deliberately absent
    expect(fs.existsSync(inRoot("dangling"))).toBe(false); // the blind spot, stated

    await expect(call("files:writeFile", inRoot("dangling"), "PWNED")).rejects.toThrow(
      /outside an open project/i
    );

    // The property that matters: nothing was created outside the project.
    expect(fs.existsSync(target)).toBe(false);
  });

  it("REFUSES a dangling symlink to a path that does not exist ANYWHERE outside", async () => {
    // No part of the target chain exists, so every `existsSync` along it is false too.
    fs.symlinkSync("/tmp/definitely-absent-dir/deep/file.txt", inRoot("d2"), "file");
    await expect(call("files:writeFile", inRoot("d2"), "x")).rejects.toThrow(
      /outside an open project/i
    );
    expect(fs.existsSync("/tmp/definitely-absent-dir/deep/file.txt")).toBe(false);
  });

  it("REFUSES a RELATIVE dangling symlink that escapes via ..", async () => {
    // Resolved against the link's own directory, not the cwd — the subtle case.
    fs.symlinkSync("../" + path.basename(OUTSIDE) + "/rel.txt", inRoot("d3"), "file");
    await expect(call("files:writeFile", inRoot("d3"), "x")).rejects.toThrow(
      /outside an open project/i
    );
    expect(fs.existsSync(path.join(OUTSIDE, "rel.txt"))).toBe(false);
  });

  it("REFUSES a CHAIN of dangling symlinks ending outside", async () => {
    // a -> b -> outside/target. Following only one hop would clear this wrongly.
    fs.symlinkSync(path.join(OUTSIDE, "chain.txt"), inRoot("hop2"), "file");
    fs.symlinkSync(inRoot("hop2"), inRoot("hop1"), "file");
    await expect(call("files:writeFile", inRoot("hop1"), "x")).rejects.toThrow(
      /outside an open project/i
    );
    expect(fs.existsSync(path.join(OUTSIDE, "chain.txt"))).toBe(false);
  });

  it("still ALLOWS a dangling symlink whose target is inside the project", async () => {
    // The rule is about where the link POINTS, not that it is a link — this module says so, and a
    // fix that refused every link would break a legitimate repo layout.
    fs.mkdirSync(inRoot("real"), { recursive: true });
    fs.symlinkSync(inRoot("real", "created-via-link.txt"), inRoot("inside-link"), "file");

    await expect(call("files:writeFile", inRoot("inside-link"), "fine")).resolves.toEqual({
      success: true,
    });
    expect(fs.readFileSync(inRoot("real", "created-via-link.txt"), "utf-8")).toBe("fine");
  });

  it("refuses a symlink LOOP instead of hanging", async () => {
    // A real filesystem state. An unbounded chain walk would spin rather than refuse.
    fs.symlinkSync(inRoot("loopB"), inRoot("loopA"), "file");
    fs.symlinkSync(inRoot("loopA"), inRoot("loopB"), "file");
    await expect(call("files:writeFile", inRoot("loopA"), "x")).rejects.toThrow(
      /too many symbolic links|outside an open project/i
    );
  });
});
