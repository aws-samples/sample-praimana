import { ipcMain, dialog } from "electron";
import fs from "fs";
import path from "path";
import {
  assertNotRepositoryMetadata,
  assertRealPathWithinProject,
  assertUserChosen,
  isRealPathWithinProject,
  recordUserChosenPath,
} from "../project-paths";
import { readSetting, writeSetting } from "../database";
import { activeUserId } from "../active-account";
import { recordSecurityEvent, redactedTarget } from "../security-audit";
import { recordPickedUpload } from "../picked-uploads";
import {
  watchOpenFile,
  unwatchOpenFile,
  rememberStamp,
  hasChangedSince,
  readStamp,
} from "../file-watch";

/**
 * Where each native dialog should open, remembered for this session.
 *
 * ── ⚠ ELECTRON 43 STOPPED DOING THIS FOR US ──
 *
 * Through Electron 42, omitting `defaultPath` let the OS track and restore the last-used
 * directory between invocations. As of 43 an omitted `defaultPath` means the Downloads folder
 * (or home) EVERY time, so "Switch folder" would reopen at Downloads instead of beside the
 * project the user is working in — a small papercut repeated on every use. Electron's own
 * guidance for the change is to track it yourself and pass `defaultPath`, which is what this
 * does.
 *
 * Session-scoped rather than persisted: it is a convenience, not state worth a settings row,
 * and `project_path` is already the durable answer for the folder picker. No security weight
 * either way — `defaultPath` only chooses where the dialog OPENS. What the user picks is still
 * vouched by `recordUserChosenPath`.
 */
let lastUploadDir: string | undefined;

/** `defaultPath` for the folder picker: where they are working now, if anywhere. */
function folderDialogDefault(): string | undefined {
  return readSetting("project_path") || undefined;
}

export function setupFileHandlers() {
  /**
   * Choose the working folder.
   *
   * ⚠ THIS IS THE ONLY ORIGIN OF A PROJECT PATH IN THE APP, and therefore the only place
   * that can vouch for one. `recordUserChosenPath` remembers what the OS dialog returned so
   * `files:commitProjectPath` and `db:addProject` can later refuse a path the renderer
   * invented — see project-paths.ts for why that gate is the whole security property.
   *
   * A forbidden root (home, `/`, a system directory) is refused HERE, with a native error
   * box, and reported to the renderer as a plain cancel. Both existing call sites already
   * treat null as "user changed their mind", so the refusal needs no renderer change — and
   * the message lands attached to the click that caused it instead of as a denied file read
   * three screens later.
   */
  ipcMain.handle("files:selectDirectory", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      // Electron 43 no longer restores the last-used directory — see folderDialogDefault.
      defaultPath: folderDialogDefault(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    try {
      return recordUserChosenPath(result.filePaths[0]);
    } catch (err) {
      dialog.showErrorBox("Folder not allowed", (err as Error).message);
      return null;
    }
  });

  /**
   * Record the chosen folder as THE working directory.
   *
   * Replaces `setSetting("project_path", …)`, which was the app's worst security defect: the
   * renderer wrote the one setting `allowedRoots()` builds the filesystem boundary from, so
   * it could place its own confinement fence around the user's home directory. See
   * ALLOWLIST_SOURCE_SETTINGS in project-paths.ts.
   *
   * The value is unchanged and the write is still a single settings row — the only difference
   * is that main now insists the path came from its own picker. That is enough, because the
   * renderer never had any other way to learn a legitimate project path in the first place.
   */
  ipcMain.handle("files:commitProjectPath", async (_event, projectPath: string) => {
    const vouched = assertUserChosen(projectPath);
    writeSetting("project_path", vouched);
    /**
     * ── ⚠ RECORDED, FOR THE REASON THE COMMENT ABOVE GIVES ────────────────────────────────────
     *
     * This setting is what `allowedRoots()` builds the confinement fence from, and the note above calls its
     * predecessor "the app's worst security defect" — yet a change to it left no trace, in a file that did
     * not import `recordSecurityEvent` at all.
     *
     * ⚠ THE SAME EVENT AS `db:addProject`, distinguished by `detail` rather than by a second event
     * name. Both answer one question — "what widened what this machine will touch?" — and an
     * investigator greps for the question, not for the two mechanisms that happen to implement it.
     *
     * ⚠ AFTER `assertUserChosen`, so a refused path records nothing: it throws, and no boundary moved.
     * The record describes the value that was actually written, not the caller's argument.
     */
    recordSecurityEvent({
      event: "project.grant",
      outcome: "success",
      userId: activeUserId() ?? undefined,
      detail: `root:${redactedTarget(vouched)}`,
    });
    return { success: true };
  });

  /**
   * Pick ONE file to upload to the team's document store.
   *
   * The extension filter mirrors the docs service's allowlist
   * (services/docs/src/upload-policy.ts). It is a COURTESY, not a control — the dialog
   * filter is client-side and the server re-checks the extension, the size, and the path
   * before issuing a presigned URL. Keeping them in step still matters: a picker that
   * offers a `.zip` and then fails on upload wastes the user's time twice.
   *
   * Deliberately NOT confined to the project directory, unlike every read handler here:
   * the point is to attach a file that may live anywhere (a downloaded PDF, an exported
   * report). Confinement is enforced where it belongs instead — the stored path is
   * reduced to a basename before it becomes an S3 key, so a local absolute path never
   * shapes the team's document tree.
   */
  ipcMain.handle("files:selectUpload", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Documents", extensions: ["md", "txt", "pdf", "html"] },
        { name: "All files", extensions: ["*"] },
      ],
      // Where they last attached from, else the project — not Downloads every time, which is
      // what Electron 43 does when `defaultPath` is omitted. Uploads legitimately come from
      // anywhere, so the LAST-USED directory is the useful answer here rather than the project.
      defaultPath: lastUploadDir ?? folderDialogDefault(),
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    // ⚠ VOUCHED FOR HERE, CHECKED IN `docs:upload`. Without this, that handler read whatever
    // absolute path the renderer named and PUT the bytes to the team's shared document store.
    const filePath = recordPickedUpload(result.filePaths[0]);
    lastUploadDir = path.dirname(filePath);
    return { filePath, name: path.basename(filePath) };
  });

  ipcMain.handle("files:readDirectory", async (_event, dirPath: string) => {
    const EXCLUDED = ["node_modules", ".DS_Store", "__pycache__"];

    /**
     * ── ⚠ REALPATH, BECAUSE THIS IS THE HANDLER A SYMLINK TURNS INTO A FILESYSTEM BROWSER ────
     *
     * `assertWithinProject` compares `path.resolve(target)` against the roots, which is purely
     * textual, and project-paths.ts demonstrates the bypass verbatim: `ln -s / <project>/x` and
     * `<project>/x/etc` resolves to itself, passes, and `readdirSync` lists `/etc`. Recursing on each
     * returned `path` then walks the whole filesystem — names, types and sizes — and the renderer's
     * CSP is `connect-src *` (csp-policy.ts), so it has somewhere to send them.
     *
     * ⚠ ONE SYMLINK IS ALL IT TAKES, AND GIT WRITES THEM VERBATIM. The precondition is not an
     * attacker with a shell: it is cloning a repository that carries a directory symlink, which is
     * exactly what this app asks participants to do.
     *
     * ⚠ THIS COMPLETES A MIGRATION THE SIBLINGS ALREADY MADE. `files:readFile` moved to the realpath
     * variant and retracted the "reads are bounded" justification while doing it — "the reader here is
     * not the user; it is the RENDERER, and it has network egress" (:230-241 below) — and
     * `files:searchFiles` re-checks every hit for the same reason. These three were the residue.
     */
    const safeDir = assertRealPathWithinProject(dirPath, { mustExist: true });
    const entries = fs.readdirSync(safeDir, { withFileTypes: true });  // nosemgrep: detect-non-literal-fs-filename
    return entries
      .filter((e) => !EXCLUDED.includes(e.name))
      .map((entry) => ({
        name: entry.name,
        path: path.join(safeDir, entry.name),  // nosemgrep: path-join-resolve-traversal
        type: entry.isDirectory() ? "dir" : ("file" as const),
        /**
         * ⚠ `lstatSync`, SO A LINK IS DESCRIBED RATHER THAN FOLLOWED. `statSync` follows, so a symlink
         * inside the project reported the SIZE of whatever it points at — a much smaller leak than the
         * traversal above, but the same kind, and not closed by the guard on `dirPath`.
         *
         * It also makes this line agree with the one above it: `withFileTypes` gives a `Dirent` from
         * `readdir`, which does NOT follow links, so a symlinked directory is already reported as a
         * "file" here. Sizing it by its target was the inconsistency.
         */
        size: entry.isFile()
          ? fs.lstatSync(path.join(safeDir, entry.name)).size  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
          : undefined,
      }))
      .sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "dir" ? -1 : 1;
      });
  });

  /**
   * ── ⚠ FIND A FILE BY NAME, BOUNDED ON EVERY AXIS ──────────────────────────────────────────
   *
   * `files:readDirectory` above is single-level, which is right for a tree that expands on demand and
   * useless for search — so this is the one place that walks. Everything about it is bounded, because an
   * unbounded recursive walk over a real repository is a UI freeze and a memory spike triggered by typing:
   *
   *   MAX_RESULTS  — stops the walk as soon as the list is full. A search that returns 2,000 files has not
   *                  answered the question anyway; the user narrows it instead.
   *   MAX_VISITED  — a hard ceiling on entries examined, so a pathological tree (a deep monorepo, a
   *                  generated directory nobody thought to exclude) cannot spin. Reported via `truncated`
   *                  rather than silently, so the UI can say the list is partial.
   *   MAX_DEPTH    — cheap protection against a symlink loop that `EXCLUDED` does not cover.
   *
   * ⚠ SAME GUARD AS EVERY OTHER FILE ROUTE. `assertRealPathWithinProject` on the root, and each
   * candidate is checked again after resolution: a symlink inside the project pointing OUT of it would
   * otherwise let a search list — and then open — arbitrary files on the machine.
   *
   * ⚠ THE ROOT CHECK IS THE REALPATH VARIANT TOO, AND THE PER-HIT CHECK STAYS. This route was never
   * exploitable — the check at each hit already refused a symlinked-out result — but the ROOT was
   * lexical, and it was the last `assertWithinProject` left on this boundary once the three handlers in
   * the symlink finding were converted. Converting it makes the invariant a flat
   * one worth asserting: no entry point on the project boundary decides confinement lexically. Two
   * layers here, deliberately, same as the bounds above.
   *
   * ⚠ MATCHES THE RELATIVE PATH, NOT ONLY THE BASENAME. "routes" should find `src/api/routes.ts`, and
   * "api/routes" should too; basename-only matching makes the second impossible and is surprising in a
   * project where twenty files are called `index.ts`.
   */
  ipcMain.handle(
    "files:searchFiles",
    async (_event, rootPath: string, query: string) => {
      const MAX_RESULTS = 50;
      const MAX_VISITED = 20_000;
      const MAX_DEPTH = 12;
      // The tree's own exclusions plus the ones only a recursive walk meets.
      const SKIP = new Set([
        "node_modules",
        ".git",
        ".DS_Store",
        "__pycache__",
        "dist",
        "build",
        ".next",
        ".turbo",
        "coverage",
        ".venv",
      ]);

      const root = assertRealPathWithinProject(rootPath, { mustExist: true });
      const needle = (query || "").trim().toLowerCase();
      // An empty query is not an error and not "everything" — it is no question, so there is no answer.
      if (!needle) return { files: [], truncated: false };

      const files: { name: string; path: string; relPath: string }[] = [];
      let visited = 0;
      let truncated = false;

      const walk = (dir: string, depth: number): void => {
        if (files.length >= MAX_RESULTS || visited >= MAX_VISITED || depth > MAX_DEPTH) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });  // nosemgrep: detect-non-literal-fs-filename
        } catch {
          // An unreadable directory is skipped, not fatal: one permission error must not fail the search.
          return;
        }
        for (const entry of entries) {
          if (files.length >= MAX_RESULTS || visited >= MAX_VISITED) {
            truncated = true;
            return;
          }
          if (SKIP.has(entry.name)) continue;
          visited += 1;
          const full = path.join(dir, entry.name);  // nosemgrep: path-join-resolve-traversal
          if (entry.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.isFile()) {
            const relPath = path.relative(root, full);
            // Real-path checked, same reason as files:readFile above — a listed result is a path the
            // renderer will then ask to READ, so the two checks must agree.
            if (relPath.toLowerCase().includes(needle) && isRealPathWithinProject(full)) {
              files.push({ name: entry.name, path: full, relPath });
            }
          }
        }
      };

      walk(root, 0);
      return { files, truncated };
    }
  );

  /**
   * ⚠ REAL-PATH CHECKED NOW, AND THE OLD JUSTIFICATION WAS WRONG ABOUT WHO READS.
   *
   * project-paths.ts argued the lexical check was acceptable for reads because "the worst case is
   * showing the user a file they could already open in any editor". The reader here is not the user;
   * it is the RENDERER, and it has network egress (`connect-src *`). Paired with `files:searchFiles`,
   * which walks through symlinks, one link in a project turned the two into a general-purpose file
   * reader plus an exfiltration channel — and reads are where the credentials are.
   *
   * `mustExist: true`: reading a file that is not there is an error either way, and saying so here
   * keeps the refusal specific.
   */
  ipcMain.handle("files:readFile", async (_event, filePath: string) => {
    const safePath = assertRealPathWithinProject(filePath, { mustExist: true });
    const text = fs.readFileSync(safePath, "utf-8");  // nosemgrep: detect-non-literal-fs-filename
    /**
     * ⚠ STAMPED ON READ, WHICH IS WHAT MAKES THE STALE-WRITE GUARD BELOW MEAN ANYTHING. The editor's whole
     * notion of "unchanged" is the copy it read here; recording the file's mtime and size at the same moment
     * is what lets a later save know whether the ground moved underneath it.
     */
    rememberStamp(safePath);
    return text;
  });

  /**
   * ⚠ `assertRealPathWithinProject`, NOT `assertWithinProject` — this is an OVERWRITE.
   *
   * The rule is stated in project-paths.ts: the lexical check is acceptable for reads, and for
   * "RENAME, MOVE, DELETE and OVERWRITE it is not… following that link would let the renderer
   * destroy `~/.ssh/id_rsa`". `file-ops.ts` obeys it at all fourteen of its mutating call
   * sites. This handler is an overwrite that did not, so a symlink anywhere in an open project
   * escaped it: `writeFile("<project>/link/authorized_keys", …)` resolved outside and wrote
   * there, while every path the renderer sent looked project-relative.
   *
   * Not `{ mustExist: true }`: writing a NEW file is the common case, and the ancestor walk
   * already resolves the nearest existing parent — so a new file in a real directory is fine
   * and a new file inside a symlinked-out directory is not.
   */
  ipcMain.handle("files:writeFile", async (_event, filePath: string, content: string) => {
    const safePath = assertRealPathWithinProject(filePath);
    /**
     * ⚠ AND NOT INTO `.git`, WHICH CONFINEMENT ALONE PERMITS. This is the channel the
     * `.git/config` -> command-execution finding rides: `<project>/.git/config` is inside the root,
     * so `assertRealPathWithinProject` says yes, and `git:status` — which Sidebar.tsx fires on every
     * active-project change, with no user gesture — then runs `core.fsmonitor` through a shell. It is
     * also the one mutating channel with no `validateName`, so nothing else here constrained the name.
     */
    assertNotRepositoryMetadata(safePath);
    /**
     * ── ⚠ REFUSE TO OVERWRITE A FILE THAT CHANGED SINCE WE READ IT ────────────────────────────
     *
     * The stale tab was the visible half. This is the half that loses work: `dirty` is computed against the
     * `original` the editor read on open, so saving after the agent rewrote the file wrote the participant's
     * PRE-AGENT copy straight over the agent's edit, silently, with no diff and no undo.
     *
     * ⚠ IT REFUSES RATHER THAN MERGING. Three-way merge is a real feature and not one to invent in a save
     * handler; declining and saying why leaves both versions intact and the decision with the person. The
     * renderer turns this into the "changed on disk" banner, where Reload and Keep mine are both available.
     *
     * ⚠ AND ONLY WHEN WE HAVE A STAMP. A path never read through `files:readFile` — a new file the editor
     * is creating — has nothing to be stale against, and `hasChangedSince` returns false for it. This must
     * not become a reason a first save fails.
     */
    if (hasChangedSince(safePath)) {
      return {
        success: false as const,
        staleOnDisk: true as const,
        error:
          "This file changed on disk since you opened it — most likely the assistant edited it. " +
          "Reload to see the new version, or keep your copy and save again.",
      };
    }
    fs.writeFileSync(safePath, content, "utf-8");  // nosemgrep: detect-non-literal-fs-filename
    // Our own write must not come back as somebody else's change. See file-watch.ts.
    rememberStamp(safePath);
    /**
     * ⚠ AND IT IS RECORDED, WHICH IT WAS NOT. `files:writeFile` recorded nothing, while every one of
     * the six mutating handlers in file-ops.ts writes a `file.mutate`
     * record, so RENAMING a file was audited and REWRITING its contents was not — and this is the
     * least constrained mutation channel in the app, the one with no `validateName`.
     *
     * ⚠ AFTER THE SYSCALL, for the reason `auditMutation` states: an event recorded first would claim
     * something that may not have happened, and an audit failure must never fail the file operation.
     *
     * ⚠ AND IT IS WHY THE RETENTION PARTITION HAD TO LAND FIRST. This adds a renderer-driven
     * `file.mutate` on the busiest write channel in the app — under a flat recency window that would
     * have made the eviction finding strictly easier to exploit, not harder. Closing an attribution
     * gap by widening an eviction one is not a fix.
     */
    recordSecurityEvent({
      event: "file.mutate",
      outcome: "success",
      userId: activeUserId() ?? undefined,
      detail: `write:${redactedTarget(safePath)}`,
    });
    return { success: true };
  });

  /**
   * ── ⚠ WATCH ONLY WHAT IS OPEN ─────────────────────────────────────────────────────────────
   *
   * The renderer owns the tab list, so it says which files matter; main owns the watchers, because a
   * renderer holding OS handles is the thing `contextIsolation` exists to prevent. Both channels are
   * confined by `assertRealPathWithinProject` inside file-watch.ts — a watcher is a read.
   *
   * Idempotent in both directions: opening a file twice watches once, closing an unwatched file is fine.
   */
  ipcMain.handle("files:watch", async (_event, filePath: string) => {
    try {
      watchOpenFile(filePath);
      return { watching: true as const };
    } catch (err) {
      // A file that cannot be watched still opens — it just will not refresh itself.
      return { watching: false as const, error: err instanceof Error ? err.message : "unwatchable" };
    }
  });

  /**
   * ── ⚠ WHEN THE FILE ON DISK WAS LAST WRITTEN ──────────────────────────────────────────────
   *
   * ⚠ THE SAME STAMP THE STALENESS CHECK USES, not a second reading of the filesystem. `readStamp` is what
   * `files:writeFile` compares against to refuse a stale overwrite, so the time the header shows and the time
   * the guard reasons about are the same number by construction — a separate `statSync` here would be a
   * second answer that could disagree with the first.
   *
   * Confined like every other path, and `null` for a file that is not there rather than a throw: a tab whose
   * file was deleted underneath it should say so, not fail to render.
   */
  ipcMain.handle("files:stat", async (_event, filePath: string) => {
    try {
      const safePath = assertRealPathWithinProject(filePath, { mustExist: true });
      return readStamp(safePath);
    } catch {
      return null;
    }
  });

  ipcMain.handle("files:unwatch", async (_event, filePath: string) => {
    unwatchOpenFile(filePath);
    return { watching: false as const };
  });

  ipcMain.handle("files:getProjectInfo", async (_event, projectPath: string) => {
    // Was unconfined: it reported existence for any path and returned the `name` out of any
    // package.json on disk. Small, but it is a read of renderer-supplied input either way.
    /**
     * ⚠ AND THEN LEXICAL-ONLY, WHICH LEFT IT AN EXISTENCE ORACLE THROUGH A SYMLINK. Same finding as
     * `files:readDirectory` above: this reports whether `<dir>/package.json` exists and returns the
     * `name` out of it, for any directory a link inside the project can reach.
     */
    const safeProject = assertRealPathWithinProject(projectPath, { mustExist: true });
    const packageJsonPath = path.join(safeProject, "package.json");  // nosemgrep: path-join-resolve-traversal
    let name = path.basename(safeProject);
    if (fs.existsSync(packageJsonPath)) {  // nosemgrep: detect-non-literal-fs-filename
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));  // nosemgrep: detect-non-literal-fs-filename
        name = pkg.name || name;
      } catch {}
    }
    return { name, path: safeProject };
  });
}
