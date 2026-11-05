import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

/**
 * `.git` IS NOT ORDINARY PROJECT CONTENT — the write rule, and the git-side second layer.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT USES REAL GIT ──
 *
 * git-actions.test.ts mocks `simple-git`, which is right for the questions it asks (no `--force`, no
 * `--hard`, bounded network calls) and useless for this one: whether git runs a repo-local config
 * value is a property of GIT, and a fake would confirm my assumptions about it while proving none of
 * them. Both halves here are measured against a real repository:
 *
 *   1. every mutating channel refuses a path inside `.git` — real fs, real handlers
 *   2. a poisoned `.git/config` does not execute when `git:status` / `git:diff` run — real git
 *
 * (2) needs the `git` binary. That is not an environment assumption worth guarding: handlers/git.ts
 * exists to shell out to git, so a machine without it cannot run the feature under test at all.
 */

vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn() },
  shell: { trashItem: vi.fn(async () => {}), openPath: vi.fn() },
}));

/** The project root every test operates inside; a fresh temp dir per test. */
let ROOT = "";

vi.mock("../database", () => ({
  readSetting: (key: string) => (key === "project_path" ? ROOT : null),
  writeSetting: () => {},
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
}));

vi.mock("../active-account", () => ({
  activeUserId: () => "test-user",
  activeExperience: () => null,
}));

const handlers = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

/** A git invocation as the DEVELOPER setting the fixture up — never as the renderer. */
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

beforeEach(async () => {
  vi.clearAllMocks();
  handlers.clear();
  // macOS: /var is a symlink to /private/var, so the root must be the REAL path or every
  // realpath-based check would treat legitimate children as escapes.
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitmeta-")));

  const { ipcMain } = await import("electron");
  (ipcMain.handle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (channel: string, fn: (event: unknown, ...args: any[]) => Promise<any>) => {
      handlers.set(channel, fn);
    }
  );
  const { setupFileHandlers } = await import("./files");
  const { setupFileOpsHandlers } = await import("./file-ops");
  const { setupGitHandlers } = await import("./git");
  setupFileHandlers();
  setupFileOpsHandlers();
  setupGitHandlers();
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

/** The message the rule refuses with, so a test cannot pass on an unrelated throw. */
const REFUSAL = /\.git folder/;

describe("the write rule: no renderer channel may put content into .git", () => {
  beforeEach(() => {
    fs.mkdirSync(inRoot(".git"), { recursive: true });
    fs.writeFileSync(inRoot(".git", "config"), "[core]\n\tbare = false\n");
    fs.mkdirSync(inRoot(".git", "hooks"), { recursive: true });
  });

  it("files:writeFile refuses .git/config", async () => {
    await expect(
      call("files:writeFile", inRoot(".git", "config"), '[core]\n\tfsmonitor = "touch /tmp/x"\n')
    ).rejects.toThrow(REFUSAL);
    // The pre-existing file is untouched, not truncated by a partially-applied write.
    expect(fs.readFileSync(inRoot(".git", "config"), "utf-8")).toContain("bare = false");
  });

  it("files:writeFile refuses a hook, and .git at any depth", async () => {
    await expect(
      call("files:writeFile", inRoot(".git", "hooks", "pre-commit"), "#!/bin/sh\n")
    ).rejects.toThrow(REFUSAL);
    fs.mkdirSync(inRoot("nested", "sub", ".git"), { recursive: true });
    await expect(
      call("files:writeFile", inRoot("nested", "sub", ".git", "config"), "x")
    ).rejects.toThrow(REFUSAL);
  });

  it("files:writeFile refuses the case-folded and Windows-trimmed spellings", async () => {
    // Verified on macOS: `.GIT/probe` lands in `.git/probe`, so an exact-match check is a spelling
    // suggestion rather than a rule. Windows trims a trailing dot, so `.git.` names `.git` on disk.
    for (const spelling of [".GIT", ".Git", ".gIt", ".git.", ".git "]) {
      await expect(call("files:writeFile", inRoot(spelling, "config"), "x")).rejects.toThrow(
        REFUSAL
      );
    }
  });

  it("fileOps:createFolder refuses to manufacture a .git", async () => {
    // The composition that matters in a project that is not yet a repository: create `.git`,
    // create `config` in it, write the payload — three channels that each look harmless.
    await expect(call("fileOps:createFolder", ROOT, ".git")).rejects.toThrow(REFUSAL);
  });

  it("fileOps:createFile refuses a file inside .git", async () => {
    await expect(call("fileOps:createFile", inRoot(".git"), "config")).rejects.toThrow(REFUSAL);
  });

  it("fileOps:rename refuses both ends", async () => {
    fs.mkdirSync(inRoot("prepared"));
    // TO `.git` — the same manufacture as createFolder, by a different verb.
    await expect(call("fileOps:rename", inRoot("prepared"), ".git")).rejects.toThrow(REFUSAL);
    // AWAY from `.git` — which would clear the way for one.
    await expect(call("fileOps:rename", inRoot(".git"), "dotgit-backup")).rejects.toThrow(REFUSAL);
    expect(fs.existsSync(inRoot(".git", "config"))).toBe(true);
  });

  it("fileOps:move and fileOps:copy refuse .git as a destination", async () => {
    fs.writeFileSync(inRoot("config"), '[core]\n\tfsmonitor = "touch /tmp/x"\n');
    await expect(call("fileOps:copy", inRoot("config"), inRoot(".git"))).rejects.toThrow(REFUSAL);
    await expect(call("fileOps:move", inRoot("config"), inRoot(".git"))).rejects.toThrow(REFUSAL);
    expect(fs.readFileSync(inRoot(".git", "config"), "utf-8")).toContain("bare = false");
  });

  it("still permits ordinary project content, including .gitignore and .github", async () => {
    // The rule is about the repository's own directory, not about a leading dot or the word "git".
    await expect(call("files:writeFile", inRoot(".gitignore"), "node_modules\n")).resolves.toEqual({
      success: true,
    });
    await expect(
      call("files:writeFile", inRoot(".gitattributes"), "* text=auto\n")
    ).resolves.toEqual({ success: true });
    await expect(call("fileOps:createFolder", ROOT, ".github")).resolves.toMatchObject({
      path: inRoot(".github"),
    });
    await expect(call("fileOps:createFolder", ROOT, "gitstuff")).resolves.toMatchObject({
      path: inRoot("gitstuff"),
    });
  });
});

describe("the second layer: a poisoned .git/config does not execute", () => {
  /** Sentinels the poisoned values would create. Absent == the value never ran. */
  let fired = "";
  const ran = (name: string) => fs.existsSync(path.join(fired, name));  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal

  beforeEach(() => {
    fired = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitmeta-fired-")));
    git("init", "-q", ".");
    fs.writeFileSync(inRoot("f.txt"), "a\n");
    git("add", "f.txt");
    git("commit", "-qm", "init");
    fs.writeFileSync(inRoot("f.txt"), "a\nb\n");

    // Arriving the way the write rule cannot prevent: a cloned repo, or the in-app agent, whose
    // pre-approved fs_write never passes through an IPC handler.
    fs.writeFileSync(inRoot(".gitattributes"), "*.txt diff=poison\n");
    fs.appendFileSync(
      inRoot(".git", "config"),
      `[core]\n\tfsmonitor = "touch ${fired}/fsmonitor"\n` +
        `[diff]\n\texternal = "touch ${fired}/external"\n` +
        `[diff "poison"]\n\ttextconv = "touch ${fired}/textconv; cat"\n`
    );
  });

  afterEach(() => {
    fs.rmSync(fired, { recursive: true, force: true });
  });

  it("git:status does not run core.fsmonitor, and still reports the change", async () => {
    const status = await call("git:status", ROOT);
    expect(ran("fsmonitor")).toBe(false);
    // Hardening that broke the feature would be the other failure mode: simple-git rejects the
    // `core.fsmonitor` key without its unsafe flag, and every call errors while looking safe.
    expect(status.isRepo).toBe(true);
    expect(status.modified).toContain("f.txt");
  });

  it("git:diff does not run diff.external or diff.<driver>.textconv, and still diffs", async () => {
    const diff = await call("git:diff", ROOT);
    expect(ran("external")).toBe(false);
    // `--no-textconv` is a SEPARATE flag: measured on git 2.55, a textconv driver still executed
    // under `--no-ext-diff` alone.
    expect(ran("textconv")).toBe(false);
    expect(diff).toContain("+b");
  });

  it("git:diff for a single file is hardened the same way", async () => {
    const diff = await call("git:diff", ROOT, "f.txt");
    expect(ran("external")).toBe(false);
    expect(ran("textconv")).toBe(false);
    expect(diff).toContain("+b");
  });

  it("git:log and git:branches do not execute either", async () => {
    await call("git:log", ROOT, 5);
    await call("git:branches", ROOT);
    expect(fs.readdirSync(fired)).toEqual([]);
  });
});
