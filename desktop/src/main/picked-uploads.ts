import path from "path";

/**
 * Files the user chose in the native UPLOAD picker, so `docs:upload` can refuse a path the
 * renderer invented.
 *
 * ── ⚠ WHY THIS IS SEPARATE FROM `recordUserChosenPath` ──
 *
 * Project roots and upload files are vouched for the same way but judged by opposite rules.
 * `project-paths.ts` refuses `$HOME`, `~/.ssh` and system directories, because a project root
 * that wide hands every file handler the user's credentials. An upload is the deliberate
 * exception documented on `files:selectUpload`: the point is to attach a file that may live
 * ANYWHERE — a downloaded PDF, an exported report. Reusing the project primitive would either
 * refuse legitimate uploads or weaken the project rule, so the two sets stay distinct.
 *
 * ── WHAT THIS CLOSES ──
 *
 * `docs:upload` read `params.filePath` with no confinement, no provenance and no extension
 * check in main, then PUT the bytes to the team's document store — a shared, versioned bucket
 * other participants can list. So it was a working exfiltration primitive:
 * `docsUpload({ filePath: "~/.aws/credentials", path: "notes.md" })` uploaded a credential file
 * under a plausible name, and the server's extension allowlist applied to the STORED path, not
 * the source. `files.ts` documents confinement as being enforced "where it belongs" — but the
 * basename reduction it refers to only sanitises the DESTINATION key, never the source path.
 *
 * ── SESSION-SCOPED, NOT SINGLE-USE ──
 *
 * A stricter design consumes the entry on first upload. It was rejected on purpose: an upload
 * that fails on a flaky venue connection is exactly when a participant clicks retry, and
 * single-use turns that retry into "Not a file you chose" — breaking a legitimate flow to close
 * a gap that is already shut. Re-uploading a file the user really did pick is not the threat;
 * reading one they never picked is.
 *
 * Bounded, because an unbounded set fed by a renderer-triggered handler is a slow leak. 64 is far
 * above any real session (the picker is single-select and one upload is one click) and eviction is
 * oldest-first, so the only casualty is a retry of something picked 64 files ago.
 */
const MAX_REMEMBERED = 64;

/** Insertion-ordered, which is what makes oldest-first eviction a one-liner on a Set. */
const pickedUploads = new Set<string>();

/** Record a file the native upload picker just returned. Returns it resolved. */
export function recordPickedUpload(target: string): string {
  const resolved = path.resolve(target);  // nosemgrep: path-join-resolve-traversal
  // Re-inserting must refresh recency, and a Set keeps FIRST-insertion order, so delete first.
  pickedUploads.delete(resolved);
  pickedUploads.add(resolved);
  while (pickedUploads.size > MAX_REMEMBERED) {
    const oldest = pickedUploads.values().next().value as string | undefined;
    if (oldest === undefined) break;
    pickedUploads.delete(oldest);
  }
  return resolved;
}

/** True if the native upload picker returned `target` in this session. */
export function wasPickedForUpload(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  return pickedUploads.has(path.resolve(target));  // nosemgrep: path-join-resolve-traversal
}

/**
 * The vouched, RESOLVED path for `target`, or null if the picker never returned it.
 *
 * ⚠ USE THIS RATHER THAN THE CALLER'S SPELLING. Checking `path.resolve(x)` and then reading `x`
 * lets the two diverge: the value that passed the gate and the value handed to `stat`/`readFile`
 * would be different strings for the same intended file. Nothing exploitable follows from it
 * today, but "verify one path, act on another" is the shape that later becomes a bug — so the
 * handler reads back exactly what was approved.
 */
export function resolvePickedUpload(target: string): string | null {
  if (!wasPickedForUpload(target)) return null;
  return path.resolve(target);  // nosemgrep: path-join-resolve-traversal
}

/** Test seam: forget everything. Not called by the app. */
export function __resetPickedUploads(): void {
  pickedUploads.clear();
}
