import fs from "fs";
import { BrowserWindow } from "electron";
import { assertRealPathWithinProject } from "./project-paths";
import { debugLog } from "./debug-log";

/**
 * ── ⚠ AN OPEN EDITOR TAB HAS TO KNOW WHEN SOMETHING ELSE WRITES THE FILE ──────────────────────
 *
 * The editor read the file ONCE, keyed on the path, and kept `content`/`original` in React state for the
 * lifetime of the tab. Nothing re-read it, and this app had no file watching of any kind — `fs.watch`,
 * `watchFile` and `chokidar` appeared nowhere in `src/main`.
 *
 * ⚠ WATCHING IS THE ONLY SIGNAL THAT COVERS THE REPORTED CASE. Announcing from `files:writeFile` would be
 * simpler and would miss exactly the writer that prompted this: kiro's `fs_write` and claude's `Write` are
 * the AGENT'S OWN tools, running in a spawned process, writing to disk without passing through any IPC
 * channel of ours. The filesystem is the only place both writers meet.
 *
 * ⚠ AND THE STALE EDITOR IS THE SMALLER HALF. A tab that does not refresh is annoying; a tab that saves its
 * pre-agent copy over the agent's work is DATA LOSS, and that was live. See `readStamp` — the same mtime
 * used to filter events is what `files:writeFile` compares against to refuse a stale write.
 */

/** One watcher per open path. Keyed by the RESOLVED path, so two spellings do not double-watch. */
const watchers = new Map<string, fs.FSWatcher>();

/**
 * Debounce timers per path.
 *
 * ⚠ A SINGLE SAVE IS SEVERAL EVENTS. `fs.watch` reports the truncate and the write separately, and an
 * editor that rewrites via a temp file plus rename produces more still — so an un-debounced watcher fires a
 * reload mid-write and reads a half-written file. 120ms is comfortably longer than the gap within one write
 * and far shorter than a human noticing.
 */
const timers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 120;

/**
 * What the file looked like when we last read or wrote it: `mtimeMs` and `size`.
 *
 * ⚠ BOTH FIELDS, BECAUSE mtime ALONE IS TOO COARSE. Some filesystems carry second granularity, so a write
 * within the same second as the read is invisible to mtime; the size catches most of those, and the pair is
 * what every editor uses for this. It is a staleness check, not a security control — anything that can write
 * the file can also set its times.
 */
export interface FileStamp {
  mtimeMs: number;
  size: number;
}

const stamps = new Map<string, FileStamp>();

/** The current stamp for a path, or null when it does not exist. */
export function readStamp(resolvedPath: string): FileStamp | null {
  try {
    const st = fs.statSync(resolvedPath);  // nosemgrep: detect-non-literal-fs-filename
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function rememberStamp(resolvedPath: string): void {
  const stamp = readStamp(resolvedPath);
  if (stamp) stamps.set(resolvedPath, stamp);
}

/** True when the file on disk differs from what we last read or wrote. */
export function hasChangedSince(resolvedPath: string): boolean {
  const known = stamps.get(resolvedPath);
  if (!known) return false;
  const now = readStamp(resolvedPath);
  if (!now) return true; // Deleted counts as changed.
  return now.mtimeMs !== known.mtimeMs || now.size !== known.size;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Start watching a file the editor has open.
 *
 * ⚠ CONFINED LIKE EVERY OTHER PATH. `assertRealPathWithinProject` throws for anything outside an open
 * project, so the renderer cannot use this to learn about `~/.ssh` — a watcher is a read, and a read of a
 * path the renderer names is exactly what project-paths.ts exists to bound. It also returns the resolved
 * path, which is what everything here keys on.
 *
 * Idempotent: opening the same file twice watches it once.
 */
export function watchOpenFile(filePath: string): void {
  const resolved = assertRealPathWithinProject(filePath, { mustExist: true });
  rememberStamp(resolved);
  if (watchers.has(resolved)) return;

  try {
    const watcher = fs.watch(resolved, () => {  // nosemgrep: detect-non-literal-fs-filename
      const existing = timers.get(resolved);
      if (existing) clearTimeout(existing);
      timers.set(
        resolved,
        setTimeout(() => {
          timers.delete(resolved);
          /**
           * ⚠ OUR OWN SAVES ARE FILTERED HERE, not in the renderer. `files:writeFile` re-stamps after
           * writing, so a save the participant just made no longer differs and raises nothing — without
           * this every save would bounce back as "this file changed on disk".
           */
          if (!hasChangedSince(resolved)) return;
          broadcast("file:changed-on-disk", { path: resolved });
        }, DEBOUNCE_MS)
      );
    });
    /**
     * ⚠ AN `error` LISTENER IS NOT OPTIONAL. `fs.watch` emits on the watcher rather than throwing — a file
     * deleted or replaced by rename raises ENOENT here, and an unhandled 'error' on an EventEmitter takes
     * the whole main process down. Losing the watcher is the correct outcome; losing the app is not.
     */
    watcher.on("error", (err) => {
      debugLog("[file-watch] watcher error, dropping:", err instanceof Error ? err.message : err);
      unwatchOpenFile(resolved);
    });
    watchers.set(resolved, watcher);
  } catch (err) {
    // A file we cannot watch still opens; it simply will not refresh. Never fail the open for this.
    debugLog("[file-watch] could not watch:", err instanceof Error ? err.message : err);
  }
}

/** Stop watching, when the tab closes. Safe to call for a path that is not watched. */
export function unwatchOpenFile(filePath: string): void {
  const resolved = (() => {
    try {
      return assertRealPathWithinProject(filePath);
    } catch {
      return filePath;
    }
  })();
  const timer = timers.get(resolved);
  if (timer) {
    clearTimeout(timer);
    timers.delete(resolved);
  }
  const watcher = watchers.get(resolved);
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* Already closed. */
    }
    watchers.delete(resolved);
  }
  stamps.delete(resolved);
}

/**
 * Drop every watcher.
 *
 * ⚠ BOUNDED BY THE TAB CAP IN PRACTICE, but this exists for the project switch: the old project's files are
 * no longer inside `allowedRoots()`, so a watcher on one is both useless and a handle held open on a tree
 * the participant has left.
 */
export function unwatchAll(): void {
  for (const path of [...watchers.keys()]) unwatchOpenFile(path);
}

/** Test seam: how many files are being watched right now. */
export function __watchedCount(): number {
  return watchers.size;
}
