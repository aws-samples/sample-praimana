/**
 * PURE logic for the sidebar file tree's management actions.
 *
 * Everything here is a decision the UI has to make *before* it touches IPC: which directory a
 * paste lands in, which cached directory listings a mutation invalidates, how much of a filename
 * to pre-select when renaming, what the clipboard looks like after a paste. None of it needs a
 * DOM, a filesystem, or React — which is why it lives here rather than inside Sidebar.tsx: this
 * package's vitest runs in `node` with no jsdom, so logic that stays pure is logic that can be
 * tested, and the rest can only be reasoned about.
 *
 * ── PATH HANDLING ──
 *
 * Paths arrive from the main process already built with `path.join`, so they use the host
 * separator. The renderer has no `path` module (and importing node:path into the renderer bundle
 * to split a string would be a poor trade), so the helpers below accept BOTH separators. The rest
 * of this renderer already assumes POSIX (`App.tsx` does `filePath.split("/").pop()`); these
 * helpers are deliberately stricter than that so a Windows build does not silently compute the
 * wrong parent directory and refresh the wrong node.
 *
 * ── CASE IS NEVER FOLDED ──
 *
 * macOS and Windows are usually case-insensitive and Linux is not, so folding case here would
 * make two genuinely different paths compare equal on Linux — and the thing being decided is
 * sometimes "is this destination inside the folder I am moving", where a false positive blocks a
 * legal move and a false negative is a recursive copy. The authoritative check lives in the main
 * process against real paths (`assertNotIntoOwnSubtree`); these comparisons only shape the menu,
 * so they stay literal and let main have the last word.
 */

export type EntryKind = "file" | "dir";

/** The one item held on the tree's clipboard. Single-item by design — see `cutItem`. */
export interface ClipboardItem {
  mode: "cut" | "copy";
  path: string;
  name: string;
  kind: EntryKind;
}

interface PathLike {
  path: string;
  name: string;
  type: EntryKind;
}

function isSep(ch: string): boolean {
  return ch === "/" || ch === "\\";
}

/** Drop trailing separators, but never reduce a path to nothing (`"/"` stays `"/"`). */
function trimTrailingSeparators(p: string): string {
  let end = p.length;
  while (end > 1 && isSep(p[end - 1])) end--;
  return p.slice(0, end);
}

function lastSeparatorIndex(p: string): number {
  for (let i = p.length - 1; i >= 0; i--) {
    if (isSep(p[i])) return i;
  }
  return -1;
}

/**
 * The containing directory of `p`, or `""` when there is no separator to split on.
 *
 * Returns `""` rather than `"."` deliberately: `"."` is a path the main process would happily
 * resolve relative to the app's cwd, and a refresh of the wrong directory is a tree that lies.
 * `""` is not a path, so callers must check it — and the ones below do.
 */
export function parentDirOf(p: string): string {
  const s = trimTrailingSeparators(p);
  const i = lastSeparatorIndex(s);
  if (i < 0) return "";
  if (i === 0) return s.slice(0, 1); // POSIX root: "/foo" -> "/"
  // Windows drive root: "C:\foo" -> "C:\" (dropping the separator would give the drive-relative
  // path "C:", which resolves against the drive's *current* directory, not its root).
  if (i === 2 && s[1] === ":") return s.slice(0, 3);
  return s.slice(0, i);
}

/** The final segment of `p`. */
export function basenameOf(p: string): string {
  const s = trimTrailingSeparators(p);
  const i = lastSeparatorIndex(s);
  return i < 0 ? s : s.slice(i + 1);
}

/** Two paths denoting the same node, ignoring only trailing separators. */
export function samePath(a: string, b: string): boolean {
  return trimTrailingSeparators(a) === trimTrailingSeparators(b);
}

/**
 * `candidate` is `ancestor` itself, or lives underneath it.
 *
 * The separator check after the prefix match is the point: without it `/a/project2` counts as a
 * child of `/a/project`, which would dim the wrong rows on a cut and prune the wrong cache
 * entries after a delete.
 */
export function isSelfOrDescendant(ancestor: string, candidate: string): boolean {
  const a = trimTrailingSeparators(ancestor);
  const c = trimTrailingSeparators(candidate);
  if (a === c) return true;
  return c.length > a.length && c.startsWith(a) && isSep(c[a.length]);
}

/**
 * Which directory a paste lands in.
 *
 * A folder is its own destination; a FILE pastes into the folder that contains it. That is what
 * every file manager does and what a user means by "paste here" with a file selected — the
 * alternative (refusing, or treating the file as a container) would make paste unusable for the
 * common case of "put this next to that".
 */
export function pasteTargetDir(target: PathLike): string {
  return target.type === "dir" ? target.path : parentDirOf(target.path);
}

/**
 * Which directory a "New File"/"New Folder" is created in, for a given right-click target.
 *
 * Same rule as paste, and deliberately the same function: right-clicking a file and choosing
 * "New File" creates a SIBLING, not a child of a file.
 */
export function createTargetDir(target: PathLike): string {
  return pasteTargetDir(target);
}

/** Clipboard entry for a cut. Single-item: multi-select does not exist in this tree yet, and a
 *  clipboard that can hold more than the UI can show is a source of surprise, not power. */
export function cutItem(entry: PathLike): ClipboardItem {
  return { mode: "cut", path: entry.path, name: entry.name, kind: entry.type };
}

export function copyItem(entry: PathLike): ClipboardItem {
  return { mode: "copy", path: entry.path, name: entry.name, kind: entry.type };
}

/**
 * The clipboard after a SUCCESSFUL paste.
 *
 * A cut is consumed — the source no longer exists at that path, so keeping it would leave a
 * clipboard pointing at nothing and the next paste would fail with a confusing "not found". A
 * copy is retained, so "copy once, paste into three folders" works.
 */
export function clipboardAfterPaste(clipboard: ClipboardItem | null): ClipboardItem | null {
  if (!clipboard) return null;
  return clipboard.mode === "cut" ? null : clipboard;
}

/**
 * The clipboard after `removedPath` disappeared (trashed, moved, or renamed).
 *
 * Cleared when the clipboard source was that node or lived inside it. Without this, deleting a
 * folder you had just cut leaves a clipboard whose paste fails against the filesystem — a real
 * error message for a state the UI should never have offered.
 */
export function clipboardAfterRemoval(
  clipboard: ClipboardItem | null,
  removedPath: string
): ClipboardItem | null {
  if (!clipboard) return null;
  return isSelfOrDescendant(removedPath, clipboard.path) ? null : clipboard;
}

/** Whether a row should render de-emphasised because it (or an ancestor) is cut and pending. */
export function isCutPending(clipboard: ClipboardItem | null, path: string): boolean {
  if (!clipboard || clipboard.mode !== "cut") return false;
  return isSelfOrDescendant(clipboard.path, path);
}

export interface PasteCheck {
  /** Paste is offered. */
  ok: boolean;
  /** Present when `ok` is false: shown IN the menu item, never only on hover. */
  reason?: string;
  /** Present when `ok` is true but the operation would change nothing. */
  noop?: boolean;
}

/**
 * Can the clipboard be pasted into `destDir`?
 *
 * Only refuses what is genuinely impossible, and states why in words the menu can render. The
 * main process re-checks all of it (`assertNotIntoOwnSubtree`, `assertAbsent`) and its messages
 * are the ones shown when a race beats this check — this exists so the common mistakes are
 * visible as a disabled item with a reason instead of an error after the fact.
 */
export function canPasteInto(clipboard: ClipboardItem | null, destDir: string): PasteCheck {
  if (!clipboard) return { ok: false, reason: "nothing copied yet" };
  if (!destDir) return { ok: false, reason: "no destination folder" };
  if (clipboard.kind === "dir" && isSelfOrDescendant(clipboard.path, destDir)) {
    return { ok: false, reason: "cannot paste a folder into itself" };
  }
  // A cut into the folder the item is already in is legal and does nothing. Offered rather than
  // disabled, because "paste" with nothing to do is better answered by a plain message than by a
  // greyed item the user has to work out the reason for.
  if (clipboard.mode === "cut" && samePath(parentDirOf(clipboard.path), destDir)) {
    return { ok: true, noop: true };
  }
  return { ok: true };
}

/**
 * The name to place a rename caret around, split so the EXTENSION is left unselected.
 *
 * Renaming `notes.md` should pre-select `notes`: the extension carries the file's type and
 * overtyping it by accident turns a markdown file into something the editor will not open.
 *
 *   notes.md        -> stem "notes"        ext ".md"
 *   archive.tar.gz  -> stem "archive.tar"  ext ".gz"   (matches path.extname)
 *   .gitignore      -> stem ".gitignore"   ext ""      (a leading dot is not an extension)
 *   Makefile        -> stem "Makefile"     ext ""
 *
 * Directories select whole: a dot in a folder name (`.github`, `v1.2`) is part of the name, and
 * pre-selecting only part of it makes the common "rename the whole thing" case need an extra
 * keystroke.
 */
export function splitNameForRename(
  name: string,
  kind: EntryKind = "file"
): { stem: string; ext: string } {
  if (kind === "dir") return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** A mutation that just succeeded, described in terms of the paths it touched. */
export type TreeOp =
  | { kind: "create"; parentDir: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; from: string; destDir: string }
  | { kind: "copy"; destDir: string }
  | { kind: "trash"; target: string };

/**
 * Which directory listings must be re-read after `op`.
 *
 * THIS IS THE BUG THIS MODULE EXISTS FOR. `FileTree` caches `childEntries` by directory path and
 * only ever fills a key once, on first expand. Every mutation below changes the contents of at
 * least one directory, and a create/rename/delete that does not invalidate its parent leaves the
 * tree showing a file that is gone or hiding one that exists — the most dangerous outcome here,
 * because the next click acts on a path that no longer means what the row says.
 *
 * A move touches TWO directories and forgetting the source is the easy half to miss.
 */
export function dirsToRefresh(op: TreeOp): string[] {
  const dirs: string[] = [];
  switch (op.kind) {
    case "create":
      dirs.push(op.parentDir);
      break;
    case "rename":
      // Rename is in-place (main joins the new name onto `dirname(src)`), so both paths share a
      // parent. `to` is included anyway so a future non-in-place rename cannot silently skip it.
      dirs.push(parentDirOf(op.from), parentDirOf(op.to));
      break;
    case "move":
      dirs.push(parentDirOf(op.from), op.destDir);
      break;
    case "copy":
      dirs.push(op.destDir);
      break;
    case "trash":
      dirs.push(parentDirOf(op.target));
      break;
  }
  const seen = new Set<string>();
  return dirs.filter((d) => {
    if (!d) return false; // parentDirOf gave up — refreshing "" would read the wrong directory
    const key = trimTrailingSeparators(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where to put a popup of known size so it stays fully on screen.
 *
 * Pure, and takes the viewport as arguments rather than reading `window`, for two reasons: it can
 * be tested without a DOM, and the caller reads the viewport ONCE at open time instead of the menu
 * measuring itself after it has been painted. Measuring would mean a layout read straight after a
 * write and a visible jump as the menu corrected its own position — this way the first painted
 * frame is already in the right place.
 *
 * Near an edge the popup FLIPS to the other side of the pointer rather than sliding, so it never
 * covers the row it was opened from. The final clamp is a backstop for a viewport smaller than the
 * popup, where flipping cannot help and being cut off at the far edge is worse than at the near one.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 6
): { left: number; top: number } {
  let left = x;
  if (left + width + margin > viewportWidth) left = x - width;
  if (left < margin) left = margin;

  let top = y;
  if (top + height + margin > viewportHeight) top = y - height;
  if (top < margin) top = margin;

  return { left, top };
}

/**
 * Drop `removedPath` and everything under it from a path-keyed cache.
 *
 * Needed for the same reason as `dirsToRefresh`: after a folder is renamed, moved, or trashed,
 * every cached listing and expand-state under its OLD path describes a directory that is not
 * there. Left in place they resurrect as soon as a new folder takes the old name.
 *
 * Returns the SAME object when nothing matched, so callers can skip a `setState` that would only
 * re-render the tree to produce identical output.
 */
export function pruneSubtree<T>(
  record: Record<string, T>,
  removedPath: string
): Record<string, T> {
  const doomed = Object.keys(record).filter((k) => isSelfOrDescendant(removedPath, k));
  if (doomed.length === 0) return record;
  const next: Record<string, T> = { ...record };
  for (const k of doomed) delete next[k];
  return next;
}

/**
 * ── ⚠ EVERY FOLDER BETWEEN A ROOT AND A FILE, OUTERMOST FIRST ───────────────────────────────────
 *
 * Revealing a file means expanding each of its ancestors in turn, and the ORDER matters: a folder's children
 * are fetched when it opens, so `src` has to be expanded before `src/lib` exists as a row to expand. Hence
 * outermost first, and the caller awaits each one.
 *
 * ⚠ THE ROOT ITSELF IS EXCLUDED, because it is not a collapsible row — `ensureExpanded` returns true for it
 * without doing anything, and including it would make every reveal start with a no-op.
 *
 * ⚠ AND A FILE OUTSIDE THE ROOT YIELDS NOTHING rather than walking upward for ever. That is the guard against
 * an `activeFilePath` from a project the tree has already switched away from: there is nothing to reveal, and
 * a `while` loop with no floor would climb to `/`.
 */
export function ancestorsWithin(rootPath: string, filePath: string): string[] {
  if (!rootPath || !filePath) return [];
  if (!isSelfOrDescendant(rootPath, filePath)) return [];

  const chain: string[] = [];
  let dir = parentDirOf(filePath);
  /** Bounded by the descendant check above; the depth cap is a belt on a pathological path. */
  for (let hops = 0; hops < 64 && dir && !samePath(dir, rootPath); hops++) {
    chain.push(dir);
    const next = parentDirOf(dir);
    if (samePath(next, dir)) break; // `parentDirOf("/")` is `"/"` — the real terminator.
    dir = next;
  }
  return chain.reverse();
}
