import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `cli:trustWorkspace` — writes `hasTrustDialogAccepted` into ~/.claude.json.
 *
 * ── WHY THIS NEEDS TESTS AT ALL ──
 *
 * Trusting a workspace tells Claude Code to honour that project's
 * `permissions.allow` — i.e. it PRE-APPROVES tool use, which is a confirmation the CLI
 * would otherwise put in front of the user. So this handler grants a privilege, and the
 * only thing standing between it and "any renderer-supplied path is now trusted" is its
 * allowlist check.
 *
 * The app calls it right after the user picks a folder in a native dialog, which is what
 * makes it defensible: it records a decision the user has just made, for one directory
 * they chose themselves. That justification collapses the moment the path stops being
 * one they opened — hence the first block below.
 */

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
  /**
   * ⚠ THE CONFIRMATION IS ANSWERED "Trust folder" FOR EVERY CASE HERE, and it has to be stated rather
   * than buried in the mock. `cli:trustWorkspace` now raises a native dialog before granting (a
   * Medium security finding — the grant was implicit), so without an answer every case in this file
   * hangs on a promise nothing resolves. These tests are about WHAT IS WRITTEN once the participant
   * agrees; that they are asked at all is asserted in workspace-trust.test.ts.
   */
  dialog: {
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })),
  },
}));

const disk = new Map<string, string>();

vi.mock("fs", () => ({
  default: {
    existsSync: (p: string) => disk.has(String(p)),
    readFileSync: (p: string) => {
      const v = disk.get(String(p));
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, data: string) => disk.set(String(p), String(data)),
  },
}));

vi.mock("os", () => ({ default: { homedir: () => "/home/u" } }));

/**
 * The projects the user has actually opened.
 *
 * ⚠ `user_id` IS PART OF THE DOUBLE NOW, because the handler no longer reads this table itself — it
 * asks `allowedRoots()`, whose whole point is that the query is SCOPED. A double that returns every row
 * regardless of the bound parameter cannot tell a correct implementation from the defect that was
 * reported, which is exactly why the old 13 tests passed either way.
 *
 * `user_id` omitted means a legacy row (NULL), which the real query admits via `user_id IS NULL`.
 */
let projectRows: Array<{ path: string; user_id?: string | null }> = [];
const settings = new Map<string, string>();

vi.mock("../database", () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      /**
       * Mirrors `SELECT path FROM projects WHERE user_id IS ? OR user_id IS NULL`. Unscoped SQL (what
       * the handler used to run) gets every row — so a regression to the hand-rolled query would show
       * up here as another account's folder becoming trustable.
       */
      all: (userId?: string | null) =>
        sql.includes("user_id IS ?")
          ? projectRows.filter(
              (r) => (r.user_id ?? null) === (userId ?? null) || (r.user_id ?? null) === null
            )
          : projectRows,
      run: vi.fn(),
      get: () => undefined,
    }),
  }),
  readSetting: (k: string) => settings.get(k) ?? null,
  writeSetting: vi.fn(),
}));

vi.mock("../debug-log", () => ({ debugLog: vi.fn() }));
vi.mock("better-sqlite3", () => ({ default: class {} }));

import { setupCliAssistantHandlers } from "./cli-assistant";
setupCliAssistantHandlers();

const trust = (p: string) => handlers.get("cli:trustWorkspace")!({}, p);
const CLAUDE_JSON = "/home/u/.claude.json";

const trustedPaths = () => {
  const raw = disk.get(CLAUDE_JSON);
  if (!raw) return [];
  const cfg = JSON.parse(raw);
  return Object.entries(cfg.projects ?? {})
    .filter(([, v]) => (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted)
    .map(([k]) => k);
};

beforeEach(() => {
  disk.clear();
  projectRows = [];
  settings.clear();
});

describe("only folders the user actually opened can be trusted", () => {
  it("REFUSES a path that is not an opened project, and writes nothing", async () => {
    // The attack this blocks: a compromised renderer trusting "/" or the user's home
    // directory, which would pre-approve tool use across every file they own.
    const res = await trust("/etc");
    expect(res.error).toMatch(/access denied/i);
    expect(disk.has(CLAUDE_JSON)).toBe(false);
  });

  it.each(["/", "/home/u", "/home/u/.ssh", "/Users"])("refuses %s", async (p) => {
    projectRows = [{ path: "/work/repo" }];
    expect((await trust(p)).error).toMatch(/access denied/i);
    expect(trustedPaths()).toEqual([]);
  });

  it("trusts a folder in the projects table", async () => {
    projectRows = [{ path: "/work/repo" }];
    const res = await trust("/work/repo");
    expect(res).toEqual({ trusted: true });
    expect(trustedPaths()).toEqual(["/work/repo"]);
  });

  it("trusts the CURRENT project_path even before it reaches the table", async () => {
    settings.set("project_path", "/work/fresh");
    expect(await trust("/work/fresh")).toEqual({ trusted: true });
  });

  it("refuses a PARENT of an opened project", async () => {
    // /work contains the project but is not the project. Trusting upward would widen
    // the grant to every sibling repo.
    projectRows = [{ path: "/work/repo" }];
    expect((await trust("/work")).error).toMatch(/access denied/i);
  });

  it("refuses a CHILD of an opened project", async () => {
    // Not a security hole, but not a decision the user made either — the allowlist is
    // exact paths on purpose.
    projectRows = [{ path: "/work/repo" }];
    expect((await trust("/work/repo/src")).error).toMatch(/access denied/i);
  });

  it("normalises before comparing, so a traversal cannot slip past", async () => {
    projectRows = [{ path: "/work/repo" }];
    // Resolves to /work/repo — the same folder, expressed awkwardly. Accepting it is
    // correct; what matters is that resolution happens BEFORE the comparison, so
    // "/work/repo/../other" cannot be accepted by a raw string match.
    expect(await trust("/work/repo/../repo")).toEqual({ trusted: true });
    expect((await trust("/work/repo/../other")).error).toMatch(/access denied/i);
  });
});

describe("writing ~/.claude.json", () => {
  it("PRESERVES unrelated config rather than replacing the file", async () => {
    // This file holds the user's own Claude Code state. Clobbering it to add one flag
    // would be a data-loss bug in someone's personal configuration.
    disk.set(
      CLAUDE_JSON,
      JSON.stringify({
        someTopLevelSetting: "keep me",
        projects: { "/other/repo": { hasTrustDialogAccepted: true, history: [1, 2] } },
      })
    );
    projectRows = [{ path: "/work/repo" }];

    await trust("/work/repo");

    const cfg = JSON.parse(disk.get(CLAUDE_JSON)!);
    expect(cfg.someTopLevelSetting).toBe("keep me");
    expect(cfg.projects["/other/repo"]).toEqual({ hasTrustDialogAccepted: true, history: [1, 2] });
    expect(cfg.projects["/work/repo"].hasTrustDialogAccepted).toBe(true);
  });

  it("creates the file when it does not exist", async () => {
    projectRows = [{ path: "/work/repo" }];
    await trust("/work/repo");
    expect(trustedPaths()).toEqual(["/work/repo"]);
  });

  it("is idempotent", async () => {
    projectRows = [{ path: "/work/repo" }];
    await trust("/work/repo");
    await trust("/work/repo");
    expect(trustedPaths()).toEqual(["/work/repo"]);
  });

  it("keeps a project's OTHER keys when adding the flag", async () => {
    disk.set(
      CLAUDE_JSON,
      JSON.stringify({ projects: { "/work/repo": { history: ["a"], allowedTools: ["x"] } } })
    );
    projectRows = [{ path: "/work/repo" }];

    await trust("/work/repo");

    const p = JSON.parse(disk.get(CLAUDE_JSON)!).projects["/work/repo"];
    expect(p.history).toEqual(["a"]);
    expect(p.allowedTools).toEqual(["x"]);
    expect(p.hasTrustDialogAccepted).toBe(true);
  });

  it("returns an error rather than throwing on malformed JSON", async () => {
    // A corrupt ~/.claude.json must not crash the setup flow — the caller treats a
    // failure here as "one permission prompt later", not a failed install.
    disk.set(CLAUDE_JSON, "{ not json");
    projectRows = [{ path: "/work/repo" }];
    const res = await trust("/work/repo");
    expect(res.error).toBeTruthy();
    expect(res.trusted).toBeUndefined();
  });
});

/**
 * ── ⚠ THE TWO CASES THAT WERE MISSING, AND THE DEFECT THAT LIVED IN THE GAP ────────────────────
 *
 * Thirteen tests covered traversal, parents, children, normalisation and the `~/.claude.json` merge, and NONE
 * of them covered ownership or forbidden roots, which is why a handler that granted trust across local
 * accounts passed them all.
 *
 * It now asks `isOpenProjectRoot()`, which reads through `allowedRoots()`. These two tests are about the
 * properties that come with that, not about the call: they must hold however it is implemented.
 */
describe("⚠ the boundary's own rules apply, not a hand-rolled copy of them", () => {
  beforeEach(() => {
    disk.clear();
    projectRows = [];
    settings.clear();
  });

  it("refuses a project row belonging to ANOTHER local account", async () => {
    /**
     * The case that would have caught the defect. Account B is signed in; the folder was opened by A.
     * `db:getProjects` would not list it and `db:removeProject` would not let B revoke it — so trusting
     * it grants a privilege over a folder B was never granted, and A cannot take it back.
     */
    settings.set("active_user_id", "user-b");
    projectRows = [{ path: "/work/alices-repo", user_id: "user-a" }];

    const res = await trust("/work/alices-repo");

    expect(res.error).toBeTruthy();
    expect(trustedPaths(), "nothing was written").toEqual([]);
  });

  it("still trusts the ACTIVE account's own row, and legacy rows with no owner", async () => {
    // The other half of the same rule: scoping must not lock people out of their own projects, and a
    // row written before the column existed carries NULL — `user_id IS NULL` admits it deliberately.
    settings.set("active_user_id", "user-b");
    projectRows = [
      { path: "/work/bobs-repo", user_id: "user-b" },
      { path: "/work/legacy-repo" },
    ];

    expect((await trust("/work/bobs-repo")).trusted).toBe(true);
    expect((await trust("/work/legacy-repo")).trusted).toBe(true);
  });

  it("refuses a stored row that is itself a forbidden root", async () => {
    /**
     * ⚠ THE ROW CAN BE WRONG. `allowedRoots()` filters forbidden roots on READ precisely because a
     * stale row from an older build, or a hand-edited database, can name `$HOME` — and the hand-rolled
     * version had no such filter, so it accepted what the boundary refuses. `/home/u` is the mocked home
     * directory, which contains `.ssh` and `.aws`.
     */
    projectRows = [{ path: "/home/u" }];

    const res = await trust("/home/u");

    expect(res.error).toBeTruthy();
    expect(trustedPaths()).toEqual([]);
  });

  it("writes the RESOLVED path, so the CLI can find the key it looks up", async () => {
    /**
     * The guard verified `path.resolve(folderPath)` while the write used the caller's spelling — the
     * "verify one path, act on another" shape. Not an escape (both name one directory), but Claude Code
     * looks a folder up by the string it is invoked with, so the trust silently did nothing.
     */
    projectRows = [{ path: "/work/repo" }];

    await trust("/work/repo/../repo");

    expect(trustedPaths()).toEqual(["/work/repo"]);
  });
});
