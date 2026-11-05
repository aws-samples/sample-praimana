import { isForbiddenProjectRoot } from "./project-paths";

/**
 * ── ⚠ ROOTS WRITTEN BY AN EARLIER BUILD ARE NOT TRUSTWORTHY ───────────────────────────────────
 *
 * `project_path` used to be renderer-writable, so any install that ran a build from before that was
 * fixed may still have `$HOME` — or anything else the renderer chose — sitting in its settings table
 * or its `projects` rows. `allowedRoots()` reads exactly those two places, so the ORIGINAL hole
 * survived the fix for precisely the users who had already been exposed to it: the gate stopped new
 * bad writes and did nothing about the ones already on disk. Upgrading did not undo it.
 *
 * ⚠ THIS IS CLEANUP, NOT THE CONTROL. `allowedRoots()` filters forbidden roots on every READ, so the
 * boundary is already safe without this. What this adds is that the bad row is GONE rather than
 * silently skipped forever — the user gets one honest "re-pick your folder" instead of a project that
 * mysteriously has no files, and support has a log line explaining why.
 *
 * ⚠ NOT A SQL MIGRATION, deliberately. migrations.ts is a list of pure SQL strings, and this test is
 * not expressible there: it needs `realpath`, the home directory, and the macOS
 * `/System/Volumes/Data` firmlink strip. Encoding an approximation of it in SQL would be a second,
 * weaker definition of the boundary — exactly the kind of drift the rest of this work removed.
 *
 * ⚠ RUNS ON EVERY BOOT rather than once behind a marker. It is two cheap queries, it is idempotent
 * (a removed row cannot be removed twice), and it therefore also catches a hand-edited settings table
 * or a future code path that forgets the write gate. A one-shot marker would be one more piece of
 * state to get out of sync with the thing it describes.
 */
interface RepairableDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export interface RootRepairResult {
  /** `project_path` was pointing somewhere it must not; the row was cleared. */
  clearedProjectPath: string | null;
  /** `projects` rows removed, by path, so a log line can name them. */
  removedProjects: string[];
}

export function repairProjectRoots(db: RepairableDb): RootRepairResult {
  const result: RootRepairResult = { clearedProjectPath: null, removedProjects: [] };

  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'project_path'").get() as
      | { value?: unknown }
      | undefined;
    const stored = typeof row?.value === "string" ? row.value : "";
    if (stored && isForbiddenProjectRoot(stored)) {
      // Deleted rather than blanked: an empty string and an absent key are treated the same by
      // `readSetting`, and a missing key is the honest representation of "no folder chosen".
      db.prepare("DELETE FROM settings WHERE key = 'project_path'").run();
      result.clearedProjectPath = stored;
    }
  } catch {
    /* A settings table that cannot be read is a bigger problem, and not this function's to report. */
  }

  try {
    const rows = db.prepare("SELECT path FROM projects").all() as Array<{ path?: unknown }>;
    for (const r of rows) {
      const p = typeof r.path === "string" ? r.path : "";
      if (p && isForbiddenProjectRoot(p)) {
        db.prepare("DELETE FROM projects WHERE path = ?").run(p);
        result.removedProjects.push(p);
      }
    }
  } catch {
    /* projects table may not exist yet on a very old database */
  }

  /**
   * Logged as a WARNING, and not gated behind the debug flag: this is a visible change to the user's
   * state (a folder they will have to re-pick), so support needs to be able to explain it from a log
   * they already have. Silence here would make the re-pick prompt look like data loss.
   */
  if (result.clearedProjectPath || result.removedProjects.length > 0) {
    console.warn(
      "[project-roots] removed stored project root(s) that are too broad or contain credentials — " +
        "these were writable by an earlier build and must be re-picked in the folder picker: " +
        JSON.stringify({
          project_path: result.clearedProjectPath,
          projects: result.removedProjects,
        })
    );
  }

  return result;
}
