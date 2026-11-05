import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the database module that project-paths depends on, so we can drive the
// set of allowed roots without a real SQLite/Electron environment.
const mockReadSetting = vi.fn<(key: string) => string | null>();
const mockRows = vi.fn<() => { path: string }[]>();

/** The last `projects` query the boundary ran, so a test can assert on the query itself. */
let lastProjectsSql = "";
/** …and what it bound, which is where the account predicate is observable. */
let lastProjectsParams: unknown[] = [];

vi.mock("./database", () => ({
  readSetting: (key: string) => mockReadSetting(key),
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        lastProjectsSql = sql;
        lastProjectsParams = args;
        return mockRows();
      },
    }),
  }),
}));

/**
 * ⚠ STUBBED SEPARATELY FROM `./database`, for the same reason db.scoping.test.ts does it: the
 * account is a two-key read that lives in its own module (active-account.ts, which has its own
 * test), and driving it from the same `mockReadSetting` keeps these cases about the BOUNDARY.
 */
vi.mock("./active-account", () => ({
  activeUserId: () => mockReadSetting("active_user_id") || mockReadSetting("user_id") || null,
  /**
   * ⚠ THE BOUNDARY IS EXPERIENCE-SCOPED NOW. `db:addProject` honoured a caller-supplied
   * `workshop_id`, creating filesystem-boundary grants the UI could not see or revoke.
   * Driven from the same settings stub, so a test opts in by setting `workshop_id`.
   */
  activeExperience: () => mockReadSetting("workshop_id") || null,
}));

import os from "os";
import path from "path";
import {
  isWithinProject,
  assertWithinProject,
  allowedRoots,
  recordUserChosenPath,
  wasUserChosen,
  assertUserChosen,
  ALLOWLIST_SOURCE_SETTINGS,
  isForbiddenProjectRoot,
} from "./project-paths";

describe("project-paths confinement (EA-H4/H5 security invariant)", () => {
  beforeEach(() => {
    mockReadSetting.mockReset();
    mockRows.mockReset();
    // Default: one open project at /Users/dev/proj, none in the projects table.
    mockReadSetting.mockImplementation((k) => (k === "project_path" ? "/Users/dev/proj" : null));
    mockRows.mockReturnValue([]);
  });

  it("allows the project root itself", () => {
    expect(isWithinProject("/Users/dev/proj")).toBe(true);
  });

  it("allows nested files and directories", () => {
    expect(isWithinProject("/Users/dev/proj/src/index.ts")).toBe(true);
    expect(isWithinProject("/Users/dev/proj/a/b/c")).toBe(true);
  });

  it("rejects paths outside the project", () => {
    expect(isWithinProject("/Users/dev/other")).toBe(false);
    expect(isWithinProject("/etc/passwd")).toBe(false);
    expect(isWithinProject("/Users/dev/.ssh/id_rsa")).toBe(false);
  });

  it("rejects path traversal escapes", () => {
    expect(isWithinProject("/Users/dev/proj/../secret")).toBe(false);
    expect(isWithinProject("/Users/dev/proj/../../etc/passwd")).toBe(false);
    expect(isWithinProject("/Users/dev/proj/sub/../../escape")).toBe(false);
  });

  it("rejects the sibling-prefix trick (proj vs proj-evil)", () => {
    // A naive startsWith(root) check would wrongly allow this.
    expect(isWithinProject("/Users/dev/proj-evil/x")).toBe(false);
    expect(isWithinProject("/Users/dev/projataque")).toBe(false);
  });

  it("rejects empty / non-string input", () => {
    expect(isWithinProject("")).toBe(false);
    // @ts-expect-error — exercising runtime guard against bad callers
    expect(isWithinProject(undefined)).toBe(false);
    // @ts-expect-error — exercising runtime guard against bad callers
    expect(isWithinProject(null)).toBe(false);
  });

  it("honours additional roots from the projects table", () => {
    mockRows.mockReturnValue([{ path: "/Users/dev/second" }]);
    expect(isWithinProject("/Users/dev/second/file.md")).toBe(true);
    expect(isWithinProject("/Users/dev/proj/file.md")).toBe(true);
  });

  it("allowedRoots dedupes and resolves", () => {
    mockReadSetting.mockImplementation((k) => (k === "project_path" ? "/Users/dev/proj" : null));
    mockRows.mockReturnValue([{ path: "/Users/dev/proj" }, { path: "/Users/dev/second" }]);
    const roots = allowedRoots();
    expect(roots).toContain("/Users/dev/proj");
    expect(roots).toContain("/Users/dev/second");
    expect(roots.filter((r) => r === "/Users/dev/proj")).toHaveLength(1);
  });

  it("assertWithinProject throws for outside paths, returns resolved for inside", () => {
    expect(() => assertWithinProject("/etc/passwd")).toThrow(/Access denied/);
    expect(assertWithinProject("/Users/dev/proj/src")).toBe("/Users/dev/proj/src");
  });

  it("fails closed when there are no open projects", () => {
    mockReadSetting.mockReturnValue(null);
    mockRows.mockReturnValue([]);
    expect(isWithinProject("/Users/dev/proj/anything")).toBe(false);
  });

  /**
   * ── ⚠ THE BOUNDARY BELONGS TO ONE LOCAL ACCOUNT ────────────────────────────────────────────
   *
   * This query had no predicate at all, while every other read of the same table binds the account. The
   * effect was a grant that outlived the account that made it: after `auth:switchAccount`, account B's
   * filesystem fence still contained every folder account A had ever opened — readable, writable, trashable,
   * and a valid agent cwd — while `db:getProjects` listed none of them and `db:removeProject` would not let B
   * revoke the row.
   */
  it("scopes the projects table to the active local account", () => {
    mockReadSetting.mockImplementation((k) => (k === "active_user_id" ? "user-2" : null));
    mockRows.mockReturnValue([]);

    allowedRoots();

    expect(lastProjectsSql).toContain("FROM projects");
    expect(lastProjectsSql).toContain("user_id IS ?");
    expect(lastProjectsParams).toEqual(["user-2"]);
  });

  /**
   * ⚠ LEGACY ROWS STAY GRANTED, AND THAT IS NOT A LOOPHOLE — it is the difference between shipping
   * this and breaking every existing install. A project added before the column existed carries
   * NULL; `user_id = NULL` matches nothing in SQL, so a strict predicate would drop every
   * pre-profiles project out of the boundary at once and the app would refuse to read its own files.
   */
  it("keeps rows written before the column existed inside the boundary", () => {
    mockReadSetting.mockImplementation((k) => (k === "active_user_id" ? "user-2" : null));
    allowedRoots();
    expect(lastProjectsSql).toContain("user_id IS NULL");
  });

  /**
   * ── ⚠ THE BOUNDARY CANNOT EXCEED WHAT THE UI LISTS ──────────────────────────────────────────
   *
   * Three queries over one table disagreed: `db:getProjects` filtered on the experience, this function did
   * not, and `db:removeProject` deletes by id — so a row tagged with another experience stayed granted for
   * ever while being absent from every list the UI can revoke from.
   */
  it("⚠ scopes the boundary to the active experience", () => {
    mockReadSetting.mockImplementation((k) =>
      k === "active_user_id" ? "user-2" : k === "workshop_id" ? "exp-1" : null
    );

    allowedRoots();

    expect(lastProjectsSql).toContain("workshop_id = ?");
    expect(lastProjectsParams).toEqual(["user-2", "exp-1"]);
  });

  /** Same escape hatch as the account predicate, and for the same install-breaking reason. */
  it("keeps rows written before experience scoping inside the boundary", () => {
    mockReadSetting.mockImplementation((k) =>
      k === "active_user_id" ? "user-2" : k === "workshop_id" ? "exp-1" : null
    );
    allowedRoots();
    expect(lastProjectsSql).toContain("workshop_id IS NULL");
  });

  /** With no experience configured there is nothing to scope by, so every owned row stands. */
  it("does not filter by experience when none is configured", () => {
    mockReadSetting.mockImplementation((k) => (k === "active_user_id" ? "user-2" : null));
    allowedRoots();
    expect(lastProjectsSql).not.toContain("workshop_id");
    expect(lastProjectsParams).toEqual(["user-2"]);
  });
});

/**
 * The boundary is only as trustworthy as its INPUTS. These tests cover the write side: a
 * path becomes a project root because a native dialog returned it, never because the
 * renderer said so. Delete `assertUserChosen` from files.ts / db.ts and the renderer can
 * point `allowedRoots()` at the home directory again, which is the defect this replaces.
 */
describe("project root provenance (renderer must not choose the boundary)", () => {
  it("names project_path as a boundary input, so setting-access can refuse to make it writable", () => {
    expect(ALLOWLIST_SOURCE_SETTINGS.has("project_path")).toBe(true);
  });

  it("rejects a path the picker never returned", () => {
    expect(wasUserChosen("/Users/dev/never-picked")).toBe(false);
    expect(() => assertUserChosen("/Users/dev/never-picked")).toThrow(/Access denied/);
  });

  it("accepts a path the picker returned, and resolves it", () => {
    const picked = recordUserChosenPath("/Users/dev/picked");
    expect(picked).toBe("/Users/dev/picked");
    expect(wasUserChosen("/Users/dev/picked")).toBe(true);
    expect(assertUserChosen("/Users/dev/picked")).toBe("/Users/dev/picked");
  });

  it("matches on the RESOLVED path, so a traversal spelling of a picked root still passes and a sibling does not", () => {
    recordUserChosenPath("/Users/dev/resolved-check");
    // Same directory, spelled the long way round — legitimate, and must not be refused.
    expect(wasUserChosen("/Users/dev/sub/../resolved-check")).toBe(true);
    // A different directory that merely shares a prefix — must not inherit the grant.
    expect(wasUserChosen("/Users/dev/resolved-check-evil")).toBe(false);
  });

  it("does not grant children of a picked root (the grant is the root itself)", () => {
    recordUserChosenPath("/Users/dev/parent");
    // `allowedRoots()` handles nesting; provenance is about which ROOTS may be recorded, and
    // a subdirectory is not something the user chose.
    expect(wasUserChosen("/Users/dev/parent/child")).toBe(false);
  });

  it("rejects empty / non-string input rather than recording it", () => {
    expect(() => recordUserChosenPath("")).toThrow(/No folder selected/);
    // @ts-expect-error — exercising runtime guard against bad callers
    expect(() => recordUserChosenPath(undefined)).toThrow(/No folder selected/);
    expect(wasUserChosen("")).toBe(false);
  });

  /**
   * ⚠ THE CASE PROVENANCE ALONE DOES NOT COVER. The native dialog will return the home
   * directory if the user selects it, and then every check downstream is satisfied for
   * `~/.ssh` and `~/.aws` with real consent behind it. So these are refused at the picker.
   */
  /**
   * ⚠ THIS WAS AN `it.each` OVER THE IMPLEMENTATION'S OWN LIST, and that is why four bypasses
   * survived it. A test that enumerates the same six paths the code enumerates can only fail if
   * someone REMOVES an entry; it says nothing about the entries nobody thought of. The rule is now a
   * containment test, so these cases are derived from the SHAPE of the rule instead — and the four
   * measured bypasses are named individually below.
   */
  it.each([
    ["/", "the filesystem root"],
    [os.homedir(), "the home directory"],
    [path.dirname(os.homedir()), "the parent of all home directories"],
    [path.join(os.homedir(), "Library"), "the user Library"],
    [path.join(os.homedir(), ".ssh"), "the SSH key directory"],
    [path.join(os.homedir(), ".aws"), "the AWS credentials directory"],
    ["/etc", "a system directory"],
  ])("refuses %s as a project root even though the picker returned it (%s)", (target) => {
    expect(() => recordUserChosenPath(target)).toThrow(/cannot be used as a project/);
    expect(wasUserChosen(target)).toBe(false);
  });

  describe("the four bypasses the exact-match denylist allowed, each measured on macOS", () => {
    it("REFUSES $HOME reached through the /System/Volumes/Data firmlink", () => {
      /**
       * The sharpest one. `realpathSync("/System/Volumes/Data/Users/me")` returns that path
       * UNCHANGED — it does not collapse to `/Users/me` — so an exact-match list missed it while the
       * directory it names IS the home directory. Accepting it handed the renderer $HOME by
       * prefixing every path with 20 characters.
       */
      const viaFirmlink = "/System/Volumes/Data" + os.homedir();
      expect(isForbiddenProjectRoot(viaFirmlink)).toBe(true);
      expect(() => recordUserChosenPath(viaFirmlink)).toThrow(/cannot be used as a project/);
    });

    it("REFUSES ~/Library/LaunchAgents — named three times in the comments as the hazard", () => {
      // Login persistence: a plist here plus files:writeFile is code execution at next sign-in.
      const launchAgents = path.join(os.homedir(), "Library", "LaunchAgents");
      expect(isForbiddenProjectRoot(launchAgents)).toBe(true);
    });

    it("REFUSES /private/etc and /private/var — what a picker actually returns for /etc and /var", () => {
      expect(isForbiddenProjectRoot("/private/etc")).toBe(true);
      expect(isForbiddenProjectRoot("/private/var")).toBe(true);
    });

    it("REFUSES the other credential directories the list simply did not name", () => {
      for (const d of [".gnupg", ".kube", ".docker", ".config"]) {
        expect(isForbiddenProjectRoot(path.join(os.homedir(), d)), d).toBe(true);
      }
    });
  });

  describe("and it still allows real work", () => {
    it("allows a normal project folder, including deep inside home", () => {
      expect(isForbiddenProjectRoot(path.join(os.homedir(), "work", "my-repo"))).toBe(false);
      expect(isForbiddenProjectRoot(path.join(os.homedir(), "Documents", "clientwork"))).toBe(false);
    });

    it("allows a temp directory, which the suite and real users both rely on", () => {
      /**
       * ⚠ THE CASE THAT SHAPED THE RULE. `os.tmpdir()` resolves under `/private/var`, so excluding
       * the `/var` AREA would refuse every temp project — including this repo's own fixtures. `/var`
       * is refused exactly; its descendants are not.
       */
      expect(isForbiddenProjectRoot(os.tmpdir())).toBe(false);
      expect(isForbiddenProjectRoot(path.join(os.tmpdir(), "proj"))).toBe(false);
    });

    it("allows a subdirectory of an excluded AREA's sibling", () => {
      // /usr is excluded, /usr-local-ish names are not — the check is path-segment aware.
      expect(isForbiddenProjectRoot("/usrlocal/src")).toBe(false);
    });
  });

  it("still allows a normal folder inside the home directory", () => {
    const normal = path.join(os.homedir(), "work", "my-repo");
    expect(recordUserChosenPath(normal)).toBe(normal);
    expect(wasUserChosen(normal)).toBe(true);
  });

  it("allows a temp directory, which the suite and real users both rely on", () => {
    // Exact-match refusal, not an ancestor walk: `/var` is forbidden, a folder under it is not.
    const temp = path.join(os.tmpdir(), "project-paths-provenance");
    expect(recordUserChosenPath(temp)).toBe(path.resolve(temp));
  });
});
