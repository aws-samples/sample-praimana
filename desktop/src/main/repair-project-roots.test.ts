import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";

/**
 * ROOTS PERSISTED BY A PRE-FIX BUILD.
 *
 * The picker gate made new writes trustworthy; it did nothing for what was already on disk. Any
 * install that ran a build where the renderer could `setSetting("project_path", os.homedir())` still
 * had `$HOME` in its settings table, so the ORIGINAL boundary hole survived the fix for exactly the
 * users who had already been exposed to it.
 *
 * These tests drive the repair against a fake table rather than SQLite: what matters is WHICH rows it
 * decides to remove, and `isForbiddenProjectRoot` — the real implementation, deliberately not mocked —
 * is what makes that decision.
 */

vi.mock("./database", () => ({
  readSetting: () => null,
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

import { repairProjectRoots } from "./repair-project-roots";

/** A stand-in for the two tables the repair touches, recording the statements it ran. */
function fakeDb(settings: Record<string, string>, projects: string[]) {
  const ran: string[] = [];
  return {
    ran,
    settings,
    projects,
    prepare(sql: string) {
      ran.push(sql);
      return {
        get: () =>
          sql.includes("FROM settings") && "project_path" in settings
            ? { value: settings.project_path }
            : undefined,
        all: () => (sql.includes("FROM projects") ? projects.map((p) => ({ path: p })) : []),
        run: (param?: unknown) => {
          if (sql.startsWith("DELETE FROM settings")) delete settings.project_path;
          if (sql.startsWith("DELETE FROM projects")) {
            const i = projects.indexOf(String(param));
            if (i >= 0) projects.splice(i, 1);
          }
          return undefined;
        },
      };
    },
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  warn.mockClear();
});

describe("repairProjectRoots", () => {
  it("clears a project_path that an earlier build let the renderer set to $HOME", () => {
    // The original P0, as it survives on disk after upgrading.
    const db = fakeDb({ project_path: os.homedir() }, []);

    const result = repairProjectRoots(db);

    expect(result.clearedProjectPath).toBe(os.homedir());
    expect(db.settings.project_path).toBeUndefined();
  });

  it("clears the firmlink spelling of $HOME too", () => {
    // /System/Volumes/Data/Users/me IS the home directory and realpath does not collapse it.
    const viaFirmlink = "/System/Volumes/Data" + os.homedir();
    const db = fakeDb({ project_path: viaFirmlink }, []);

    expect(repairProjectRoots(db).clearedProjectPath).toBe(viaFirmlink);
  });

  it("removes forbidden rows from the projects table, which are the DURABLE half", () => {
    /**
     * Worse than the setting: a `projects` row survives the restart that clears the in-memory picker
     * set, so an unchecked insert was a permanent boundary grant.
     */
    const good = path.join(os.tmpdir(), "real-project");
    const db = fakeDb({}, [os.homedir(), path.join(os.homedir(), "Library", "LaunchAgents"), good]);

    const result = repairProjectRoots(db);

    expect(result.removedProjects).toHaveLength(2);
    expect(db.projects).toEqual([good]);
  });

  it("leaves a legitimate project root alone", () => {
    const good = path.join(os.tmpdir(), "my-repo");
    const db = fakeDb({ project_path: good }, [good]);

    const result = repairProjectRoots(db);

    expect(result).toEqual({ clearedProjectPath: null, removedProjects: [] });
    expect(db.settings.project_path).toBe(good);
    expect(db.projects).toEqual([good]);
  });

  it("says nothing when there was nothing to repair", () => {
    // A warning on every clean boot is a warning people stop reading.
    const good = path.join(os.tmpdir(), "my-repo");
    repairProjectRoots(fakeDb({ project_path: good }, [good]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("WARNS when it changes the user's state, naming what it removed", () => {
    // The user will be asked to re-pick a folder; support needs to be able to explain why from a log
    // they already have, or the prompt reads as data loss.
    repairProjectRoots(fakeDb({ project_path: os.homedir() }, []));

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("re-picked");
    expect(line).toContain(os.homedir());
  });

  it("is idempotent — a second run finds nothing and says nothing", () => {
    // It runs on every boot rather than once behind a marker, so this is the property that makes
    // that safe.
    const db = fakeDb({ project_path: os.homedir() }, [os.homedir()]);

    const first = repairProjectRoots(db);
    warn.mockClear();
    const second = repairProjectRoots(db);

    expect(first.clearedProjectPath).toBe(os.homedir());
    expect(second).toEqual({ clearedProjectPath: null, removedProjects: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("survives a database that cannot answer, rather than failing the boot", () => {
    // It runs inside initDatabase; throwing here would mean the app does not start.
    const broken = {
      prepare() {
        throw new Error("no such table");
      },
    };
    expect(() => repairProjectRoots(broken)).not.toThrow();
    expect(repairProjectRoots(broken)).toEqual({ clearedProjectPath: null, removedProjects: [] });
  });
});
