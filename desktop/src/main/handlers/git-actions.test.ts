import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
// vi.mock calls below are HOISTED above this import by vitest, so the module under test
// resolves the fakes rather than the real electron/simple-git.
import { setupGitHandlers } from "./git";

/**
 * THE GIT ACTION BAR'S HANDLERS — what they refuse, and what they never do.
 *
 * ── WHY THESE ARE THE ASSERTIONS ──
 *
 * This screen puts destructive-sounding verbs in front of a workshop participant who
 * may not use git day to day. So the tests are mostly about the ABSENCE of danger and
 * the PRESENCE of a usable message:
 *
 *   1. no handler may reach for --force, --hard, reset or clean
 *   2. every network call is bounded, or a hung remote parks the UI forever
 *   3. failures come back as { ok:false, error } with git's own wording preserved,
 *      because "no upstream branch" and "nothing to commit" need different actions
 *   4. pull is --ff-only: a GUI must not start a merge it cannot help resolve
 */

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

vi.mock("electron", () => ({
  /* `debug-log.ts` hard-gates on the packaged fact now — an unpackaged build is what these tests are. */
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
}));

vi.mock("../project-paths", () => ({
  // The real ones throw for paths outside the project; these tests are about the git
  // logic, and path confinement has its own suite (project-paths.test.ts).
  //
  // Both are stubbed because the READ handlers keep the lexical check while the MUTATING ones
  // (commit, push, pull, fetch) use the realpath variant — a symlinked repoPath would otherwise
  // let them operate on a repository outside the project.
  assertWithinProject: vi.fn(),
  assertRealPathWithinProject: vi.fn(),
}));

/** Records every git call so the ARGUMENTS can be asserted, not just the outcome. */
const calls: Array<{ method: string; args: unknown[] }> = [];
let behaviour: Map<string, any> = new Map();

function record(method: string) {
  return (...args: unknown[]) => {
    calls.push({ method, args });
    const b = behaviour.get(method);
    if (typeof b === "function") return b(...args);
    if (b instanceof Error) return Promise.reject(b);
    return Promise.resolve(b ?? {});
  };
}

const gitOptions: unknown[] = [];

vi.mock("simple-git", () => {
  const factory = (_path: string, options?: unknown) => {
    gitOptions.push(options);
    return {
      checkIsRepo: record("checkIsRepo"),
      status: record("status"),
      add: record("add"),
      commit: record("commit"),
      push: record("push"),
      pull: record("pull"),
      fetch: record("fetch"),
      getRemotes: record("getRemotes"),
      log: record("log"),
      diff: record("diff"),
      branchLocal: record("branchLocal"),
    };
  };
  // simple-git 4.x: git.ts imports the NAMED export { simpleGit }. Expose both
  // the named and default so the mock matches the import regardless.
  return { simpleGit: factory, default: factory };
});

setupGitHandlers();

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

const CLEAN = { files: [], current: "main", modified: [], created: [], deleted: [], staged: [], ahead: 0, behind: 0 };
const DIRTY = { ...CLEAN, files: [{ path: "a.md" }, { path: "b.md" }], modified: ["a.md"], created: ["b.md"] };
const ONE_REMOTE = [{ name: "origin", refs: {} }];

beforeEach(() => {
  calls.length = 0;
  gitOptions.length = 0;
  behaviour = new Map();
});

describe("git:isRepo — the gate the UI hides behind", () => {
  it("reports true for a repository", async () => {
    behaviour.set("checkIsRepo", true);
    expect(await invoke("git:isRepo", "/p")).toEqual({ isRepo: true });
  });

  it("reports FALSE rather than throwing on a plain folder", async () => {
    // The whole reason this handler exists: every other git handler rejects here, and
    // the renderer needs an answer it can branch on without an error boundary.
    behaviour.set("checkIsRepo", new Error("not a git repository"));
    expect(await invoke("git:isRepo", "/p")).toEqual({ isRepo: false });
  });
});

/**
 * The sidebar asks for the branch label on every project change without gating on `git:isRepo`, so
 * a plain folder rejected here every time — a stack trace from main that the renderer's
 * `.catch(() => {})` then hid. The pair of tests below is the whole fix: the ORDINARY case is an
 * answer, and a REAL failure still rejects, because collapsing the two is what made an
 * `index.lock` collision indistinguishable from a folder with no repository in it.
 */
describe("git:status — an answer for a plain folder, a rejection for a real fault", () => {
  it("returns the repository's state, marked as a repository", async () => {
    behaviour.set("status", DIRTY);
    expect(await invoke("git:status", "/p")).toMatchObject({
      isRepo: true,
      branch: "main",
      modified: ["a.md"],
      created: ["b.md"],
    });
  });

  it("answers with an empty status instead of throwing on a plain folder", async () => {
    behaviour.set("status", new Error("fatal: not a git repository (or any of the parent directories)"));
    behaviour.set("checkIsRepo", false);

    const res = await invoke("git:status", "/p");

    expect(res).toEqual({
      isRepo: false,
      branch: null,
      modified: [],
      created: [],
      deleted: [],
      staged: [],
      ahead: 0,
      behind: 0,
    });
  });

  /**
   * ⚠ THE HALF THAT KEEPS THIS HONEST. Without it the implementation could satisfy the test above
   * with a blanket `catch`, and a broken repository would report itself as clean with no branch —
   * the panel would render a healthy empty state over a real problem.
   */
  it("still rejects when the folder IS a repository and git failed for another reason", async () => {
    behaviour.set("status", new Error("Unable to create '/p/.git/index.lock': File exists"));
    behaviour.set("checkIsRepo", true);

    await expect(invoke("git:status", "/p")).rejects.toThrow(/index\.lock/);
  });

  /**
   * `checkIsRepo` itself throwing means no git binary or an unreadable directory. Treated as "not a
   * repository", the same conflation `git:isRepo` makes deliberately — there are no git actions to
   * offer either way, and the alternative is an unhandled rejection from a branch label.
   */
  it("treats an unanswerable folder as not a repository", async () => {
    behaviour.set("status", new Error("spawn git ENOENT"));
    behaviour.set("checkIsRepo", new Error("spawn git ENOENT"));
    expect(await invoke("git:status", "/p")).toMatchObject({ isRepo: false, branch: null });
  });

  /** The happy path must not pay for the classification — one git call, not two. */
  it("does not ask whether it is a repository when the status succeeds", async () => {
    behaviour.set("status", CLEAN);
    await invoke("git:status", "/p");
    expect(calls.map((c) => c.method)).toEqual(["status"]);
  });
});

describe("git:commit", () => {
  it("stages everything then commits, in that order", async () => {
    behaviour.set("status", DIRTY);
    behaviour.set("commit", { commit: "abc1234" });

    const res = await invoke("git:commit", { repoPath: "/p", message: "add docs" });

    expect(res).toMatchObject({ ok: true, commit: "abc1234", filesChanged: 2 });
    const order = calls.map((c) => c.method);
    expect(order.indexOf("add")).toBeLessThan(order.indexOf("commit"));
    expect(calls.find((c) => c.method === "add")!.args[0]).toEqual(["-A"]);
    expect(calls.find((c) => c.method === "commit")!.args[0]).toBe("add docs");
  });

  it("refuses an empty message WITHOUT touching the repo", async () => {
    const res = await invoke("git:commit", { repoPath: "/p", message: "   " });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses a runaway message", async () => {
    const res = await invoke("git:commit", { repoPath: "/p", message: "x".repeat(2001) });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("says 'nothing to commit' on a clean tree, and does not commit", async () => {
    behaviour.set("status", CLEAN);
    const res = await invoke("git:commit", { repoPath: "/p", message: "noop" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing to commit/i);
    expect(calls.some((c) => c.method === "commit")).toBe(false);
  });

  it("returns git's own message on failure instead of throwing", async () => {
    behaviour.set("status", DIRTY);
    behaviour.set("commit", new Error("Please tell me who you are"));
    const res = await invoke("git:commit", { repoPath: "/p", message: "x" });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/who you are/);
  });
});

describe("git:push", () => {
  it("sets upstream, so a first push of a new branch works", async () => {
    // Without --set-upstream the first push fails with advice a GUI user cannot act on.
    behaviour.set("getRemotes", ONE_REMOTE);
    behaviour.set("status", { ...CLEAN, current: "feature/x" });

    const res = await invoke("git:push", "/p");

    expect(res).toMatchObject({ ok: true, branch: "feature/x", remote: "origin" });
    expect(calls.find((c) => c.method === "push")!.args[0]).toEqual([
      "--set-upstream",
      "origin",
      "feature/x",
    ]);
  });

  it("refuses when there is no remote, and never calls push", async () => {
    behaviour.set("getRemotes", []);
    const res = await invoke("git:push", "/p");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no remote/i);
    expect(calls.some((c) => c.method === "push")).toBe(false);
  });

  it("is bounded by a timeout", async () => {
    behaviour.set("getRemotes", ONE_REMOTE);
    behaviour.set("status", CLEAN);
    await invoke("git:push", "/p");
    expect(gitOptions.some((o: any) => o?.timeout?.block > 0)).toBe(true);
  });
});

describe("git:pull — --ff-only, never a merge", () => {
  it("passes --ff-only", async () => {
    // A GUI pull that starts a merge can leave a conflicted tree this screen cannot
    // resolve, stranding a participant in a repo they cannot fix from the app.
    behaviour.set("getRemotes", ONE_REMOTE);
    behaviour.set("pull", { summary: { changes: 3, insertions: 10, deletions: 1 } });

    const res = await invoke("git:pull", "/p");

    expect(res).toMatchObject({ ok: true, changed: 3 });
    expect(calls.find((c) => c.method === "pull")!.args[0]).toEqual(["--ff-only"]);
  });

  it("explains a diverged branch in words a participant can act on", async () => {
    behaviour.set("getRemotes", ONE_REMOTE);
    behaviour.set("pull", new Error("fatal: Not possible to fast-forward, aborting."));

    const res = await invoke("git:pull", "/p");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/terminal/i);
    // The raw git wording alone would leave them stuck.
    expect(res.error).not.toMatch(/^fatal:/);
  });
});

describe("git:fetch", () => {
  it("reports how far behind the branch is", async () => {
    behaviour.set("getRemotes", ONE_REMOTE);
    behaviour.set("status", { ...CLEAN, behind: 4 });
    const res = await invoke("git:fetch", "/p");
    expect(res).toMatchObject({ ok: true, behind: 4 });
  });
});

describe("no handler can destroy uncommitted work", () => {
  it("the source contains no --force, --hard, reset or clean", async () => {
    // Asserted against the source because it is a rule about the whole file, not about
    // one call path — a future edit adding `git.reset(["--hard"])` should fail here.
    const src = readFileSync(join(__dirname, "git.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["--force", "-f\"", "--hard", ".reset(", ".clean(", "push --delete"]) {
      expect(code, `git.ts must not use ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("git:sync pushes docs to the service that exists", () => {
  it("the dead /api/desktop/sync-git call is gone", async () => {
    // It never existed as a route (git log -S finds no commit adding it) and it THREW,
    // which made the docs push below it unreachable — the reason the versioned bucket
    // stayed empty while every .md was being collected correctly.
    const src = readFileSync(join(__dirname, "git.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("/api/desktop/sync-git");
    expect(code).toContain("/v1/teams/");
  });
});
