import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TreeContextMenu, TrashConfirmPopover, type MenuEntry } from "./TreeContextMenu";
import { useToast } from "./Toast";
/* The toolbar's five icons are unlabelled without it — see the note on ToolbarButton. */
import { IconTooltip } from "./IconTooltip";
import {
  basenameOf,
  canPasteInto,
  clipboardAfterPaste,
  clipboardAfterRemoval,
  copyItem,
  createTargetDir,
  cutItem,
  dirsToRefresh,
  isCutPending,
  parentDirOf,
  pasteTargetDir,
  pruneSubtree,
  splitNameForRename,
  type ClipboardItem,
  type TreeOp,
  ancestorsWithin,
  samePath,
} from "../lib/file-tree-ops";
import { scrollRowIntoView } from "../lib/scroll-to-latest";

const api = (window as any).electronAPI;

/**
 * ── THE FILE TREE, EXTRACTED FROM Sidebar.tsx ──
 *
 * Moved here UNCHANGED in behaviour so two surfaces can render one tree: the narrow sidebar rail, and
 * the full Explorer panel that replaced the old "Code" view.
 *
 * WHY EXTRACTED RATHER THAN COPIED. This is ~700 lines carrying a lot of hard-won detail — the
 * stale-cache invalidation after every mutation, the single-flight ref that a `setBusy` cannot
 * provide, the remount `key` that stops a second right-click reusing the first menu's coordinates,
 * the `useLayoutEffect` that returns focus to a row whose element a rename just destroyed. A second
 * copy would start identical and drift, and the drift would be in the parts nobody re-reads.
 *
 * ⚠ THE PLATFORM LABELS MOVED WITH IT. `MOD` and `REVEAL_LABEL` are consumed by the context menu
 * built in here, not by the sidebar chrome, so they belong to this module. Sidebar.tsx no longer
 * needs them.
 */

/**
 * Platform-appropriate labels, resolved ONCE at module load.
 *
 * The modifier glyph and the file-manager's name are the difference between a hint a user can
 * follow and one they have to translate. `navigator.platform` is deprecated but is the only thing
 * available synchronously in this renderer, and it is reliable in Electron.
 */
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || "");
const IS_WINDOWS = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const REVEAL_LABEL = IS_MAC
  ? "Reveal in Finder"
  : IS_WINDOWS
    ? "Show in File Explorer"
    : "Show in file manager";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** Where a popup was opened from, and which row it acts on. */
interface MenuState {
  /**
   * A per-open counter used as React's `key` on the popup.
   *
   * ⚠ THIS IS LOAD-BEARING, NOT BOOKKEEPING. The popup freezes its clamped position in
   * `useState(initialiser)`, which runs on MOUNT only. Right-clicking row B while row A's menu is
   * open dispatches `pointerdown` (closing it) and `contextmenu` (opening the new one) in the SAME
   * React batch, so React only ever sees `menu` go from one object to another — the component
   * re-renders instead of remounting, and the menu appears at row A's coordinates with focus still
   * on row A's first item. A changing key forces the remount, which re-runs both.
   */
  id: number;
  x: number;
  y: number;
  /** `null` = opened on empty tree space or the header "+", i.e. the project ROOT. */
  entry: FileEntry | null;
}

/**
 * Confirmation state. `entry` is NON-nullable here, unlike `MenuState`: the project root cannot be
 * trashed (main refuses it), so a confirmation with no entry is a state that must not be
 * representable rather than one guarded at the render site.
 */
interface ConfirmTrashState {
  /** Same remount key as `MenuState.id`, for the same reason. */
  id: number;
  x: number;
  y: number;
  entry: FileEntry;
}

/** A row being renamed in place, plus how much of the name to pre-select. */
interface RenameState {
  path: string;
  name: string;
  selectionEnd: number;
}

/**
 * Keyboard actions a row can request WITHOUT going through the menu.
 *
 * These exist because a keyboard user should not have to open a menu to do the four things they do
 * most; the menu remains the discoverable path and lists each shortcut next to its item, so the
 * two never disagree about what a key does. Delete is deliberately NOT in this set — see
 * `TrashConfirmPopover`; a destructive action reachable by one keypress from a navigation context
 * is exactly what the confirmation exists to prevent.
 */
type RowShortcut = "rename" | "cut" | "copy" | "paste";

/**
 * WHERE THIS TREE IS BEING RENDERED.
 *
 *   "rail"  — the 240px sidebar column. Unchanged from before the extraction.
 *   "panel" — the full-width Explorer view, matching the VS Code explorer: a titled section header with a real
 * toolbar (new file, new folder,
 *             refresh, collapse all) rather than the rail's single "+".
 *
 * ONE prop rather than two components, because the DIFFERENCE IS ONLY CHROME. Every behaviour below
 * — expansion, the caches and their invalidation, the context menu, focus restoration, single-flight
 * — is identical, and forking the component to change a header is how the two would drift.
 */
export type FileTreeVariant = "rail" | "panel";

export function FileTree({
  rootPath,
  projectName,
  onOpenFile,
  variant = "rail",
  onSwitchFolder,
  switching,
  assistantBusy,
  refreshSignal,
  activeFilePath,
}: {
  rootPath: string;
  projectName: string;
  onOpenFile?: (path: string) => void;
  /**
   * The file the editor currently shows, so the tree can reveal and mark it.
   *
   * Driven from `tabs.active` in App, so this follows every route into a file — the tree itself, the search
   * bar, a tab click, the git panel — rather than only clicks that started here.
   */
  activeFilePath?: string | null;
  variant?: FileTreeVariant;
  /**
   * Open a different working folder.
   *
   * Lives in this toolbar because the old "Working Folder / Switch" panel above the tree was removed — it
   * printed the folder's name a second time under a heading of its own, when the tree's section header
   * already names it. Switch is a folder-level action, so it belongs on the folder-level toolbar.
   *
   * Optional: the Explorer panel variant is rendered inside a view that already has a project, so it does
   * not offer one.
   */
  onSwitchFolder?: () => void;
  /** A turn is in flight: the switch is refused, and the tooltip says why. See App.tsx. */
  assistantBusy?: boolean;
  /** A switch in progress — disables the button and shows it is working. */
  switching?: boolean;
  /**
   * ── ⚠ RE-READ THE FOLDER WHEN SOMETHING OUTSIDE THIS COMPONENT WROTE TO IT ──────────────────
   *
   * A counter, not a boolean: the shell increments it, and any CHANGE means "what you listed is
   * stale". A boolean would need resetting, which is a second render and a second thing to forget.
   *
   * The case that made it necessary: the switch now opens the folder BEFORE `framework:install` runs
   * (see performSwitch), so the tree lists the folder as it was a moment before an agent copied a
   * framework tree into it. Every mutation made THROUGH the tree already refreshes what it touched —
   * this is for the writes it cannot see.
   */
  refreshSignal?: number;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [childEntries, setChildEntries] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState(true);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<ConfirmTrashState | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  /**
   * A "New file"/"New folder" in progress: an empty inline input inside `parentDir`, committed the
   * same way a rename is. Creating via the same inline affordance rather than a prompt keeps one
   * naming interaction in the app instead of two, and `window.prompt` is not available under this
   * app's CSP anyway.
   */
  const [creating, setCreating] = useState<{ parentDir: string; kind: "file" | "dir" } | null>(null);
  /** Single-flight: an operation in progress disables the menu items that would race it. */
  const [busy, setBusy] = useState(false);
  /**
   * The same flag as a ref, because `setBusy(true)` does not take effect until the next render:
   * two activations in the same tick (a double-press, a stuck key) would both read `busy === false`
   * from state and both fire. The ref is the actual guard; the state exists only to grey the menu.
   */
  const busyRef = useRef(false);

  /**
   * The row to move focus to once the tree next renders, by path.
   *
   * Needed because the operations that finish a keyboard interaction destroy the element focus was
   * on: a rename unmounts the input AND re-keys the row to its new path, and a delete removes the
   * row entirely. Without this, focus lands on `document.body` and a keyboard user is dumped back
   * to the start of the tab order at the exact moment they were mid-task.
   */
  const [focusPath, setFocusPath] = useState<string | null>(null);

  const isPanel = variant === "panel";
  /**
   * The panel header's root chevron. Collapses the WHOLE tree without discarding `childEntries`, so
   * re-expanding is instant and costs no IPC — the caches are the expensive thing, not the rendering.
   * Rail-only surfaces never set this.
   */
  const [rootCollapsed, setRootCollapsed] = useState(false);

  /**
   * ⚠ TOAST IS HELD IN A REF AND NEVER PUT IN A DEPENDENCY ARRAY.
   *
   * `ToastProvider` builds its context value as an inline object literal, so `useToast()` returns a
   * NEW object on every provider render — and the provider re-renders every time any toast anywhere
   * in the app appears or expires. Listing `toast` in the mount effect below would therefore re-run
   * it on an unrelated toast, and that effect resets `expanded`, `childEntries` and the clipboard:
   * one background sync failure would collapse the user's whole tree and silently drop what they
   * had just cut.
   *
   * The ref keeps the effect keyed on `rootPath` alone, which is the only thing that should reset
   * the tree. (Memoising the provider's context value would fix this at the source and is worth
   * doing — noted as a follow-up rather than changed here, because it affects every consumer.)
   */
  const toast = useToast();
  const toastRef = useRef(toast);
  // Refreshed on every render so the ref never holds a stale closure over a dismissed provider.
  toastRef.current = toast;

  /**
   * The row (or the header "+") the current popup came from, so focus can go back to it.
   *
   * A ref rather than state on purpose — it is written during the event that opens the menu and
   * read on unmount, and putting it in state would re-render the whole tree to store something
   * nothing renders.
   */
  const menuOriginRef = useRef<HTMLElement | null>(null);
  /** Fallback focus target when the originating row no longer exists (it was just deleted). */
  const treeRef = useRef<HTMLDivElement | null>(null);

  /**
   * A read-only mirror of `childEntries` for use inside async callbacks.
   *
   * `refreshDirs` runs after an `await`, so the `childEntries` captured by its closure can already
   * be a version behind — several refreshes may be in flight. It only needs to know WHICH keys are
   * cached, never their contents, so a ref updated on every render is the cheap correct answer.
   */
  const childEntriesRef = useRef(childEntries);
  childEntriesRef.current = childEntries;

  const loadRoot = useCallback(async () => {
    const files: FileEntry[] = await api.readDirectory(rootPath);
    setEntries(files);
  }, [rootPath]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .readDirectory(rootPath)
      .then((files: FileEntry[]) => {
        if (cancelled) return;
        setEntries(files);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        // Was silently swallowed before. An unreadable project folder is worth saying out loud —
        // otherwise the tree renders as a convincing empty project.
        toastRef.current.error(
          `Could not read this folder: ${err instanceof Error ? err.message : "unknown error"}`
        );
      });
    // Switching project invalidates every cached listing, the clipboard, and any popup: their
    // paths belong to a folder the app is no longer pointed at.
    setExpanded({});
    setChildEntries({});
    setClipboard(null);
    setMenu(null);
    setConfirmTrash(null);
    setRename(null);
    setCreating(null);
    return () => {
      cancelled = true;
    };
    // `rootPath` ONLY — see the toastRef note above for why `toast` must not be here.
  }, [rootPath]);

  /** @returns whether the folder is expanded when this resolves. */
  async function toggleDir(dirPath: string): Promise<boolean> {
    if (expanded[dirPath]) {
      setExpanded((prev) => ({ ...prev, [dirPath]: false }));
      return false;
    }
    if (!childEntries[dirPath]) {
      try {
        const files = await api.readDirectory(dirPath);
        setChildEntries((prev) => ({ ...prev, [dirPath]: files }));
      } catch (err) {
        // Was an unhandled rejection before, which left the row looking like it did nothing.
        toastRef.current.error(
          `Could not open ${basenameOf(dirPath)}: ${err instanceof Error ? err.message : "unknown error"}`
        );
        return false; // do NOT mark it expanded — an expanded-but-empty folder is a lie
      }
    }
    setExpanded((prev) => ({ ...prev, [dirPath]: true }));
    return true;
  }

  /**
   * Re-read the directories a mutation touched.
   *
   * THE STALE-CACHE FIX. `childEntries` is filled once per directory on first expand and was never
   * invalidated, so before this every create/rename/delete left the tree describing a filesystem
   * that had moved on. `dirsToRefresh` decides which keys are affected (both ends of a move
   * included); this only performs the reads.
   *
   * A directory that is NOT currently cached is skipped rather than fetched: it will be read when
   * it is first expanded, and prefetching it here would spend IPC on rows nobody is looking at.
   * The root is always re-read because it is always rendered.
   */
  const refreshDirs = useCallback(
    async (dirs: string[]) => {
      /** `entries === null` means "this directory is gone — drop the cache key". */
      type Refreshed = { dir: string; entries: FileEntry[] | null } | null;

      const results: Refreshed[] = await Promise.all(
        dirs.map(async (dirPath): Promise<Refreshed> => {
          if (dirPath === rootPath) {
            try {
              await loadRoot();
            } catch (err) {
              toastRef.current.error(
                `The tree may be out of date — could not re-read the project folder: ${err instanceof Error ? err.message : "unknown error"}`
              );
            }
            return null;
          }
          // Via the ref, not the render-time closure: several refreshes can be in flight and the
          // closure's copy of the cache would be stale.
          if (!Object.prototype.hasOwnProperty.call(childEntriesRef.current, dirPath)) {
            return null;
          }
          try {
            const files: FileEntry[] = await api.readDirectory(dirPath);
            return { dir: dirPath, entries: files };
          } catch {
            // The directory is gone (it was the source of a move, or it was trashed). Dropping the
            // key is the honest outcome: it will be re-read if it ever comes back.
            return { dir: dirPath, entries: null };
          }
        })
      );

      // ONE state update for all of them, not one per directory: a move touches two directories and
      // two sequential setStates would render the tree in an intermediate state where the file
      // exists in neither place.
      setChildEntries((prev) => {
        let next: Record<string, FileEntry[]> | null = null;
        for (const r of results) {
          if (r === null) continue;
          if (next === null) next = { ...prev };
          if (r.entries === null) delete next[r.dir];
          else next[r.dir] = r.entries;
        }
        // Same object when nothing changed — no re-render for an identical tree.
        return next ?? prev;
      });
    },
    [loadRoot, rootPath]
  );

  /**
   * Put focus back on a row once it exists in the DOM.
   *
   * Runs in a layout effect so focus moves in the same commit that painted the row — a `useEffect`
   * or a `setTimeout` would leave one frame with focus on `document.body`, which is enough for a
   * screen reader to announce nothing and for the next keypress to go to the wrong place.
   *
   * The query is a single read against a freshly-committed DOM, before any write in this effect, so
   * it does not force an extra layout pass. Falls back to the tree container when the row is not
   * there (a rename that failed, a delete): focus lands SOMEWHERE inside the tree either way.
   */
  useLayoutEffect(() => {
    if (!focusPath) return;
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-tree-path="${CSS.escape(focusPath)}"]`
    );
    (el ?? treeRef.current)?.focus();
    setFocusPath(null);
  }, [focusPath, entries, childEntries]);

  /** Forget every cached listing and expand-state at or under `path`, which no longer exists. */
  const forgetSubtree = useCallback((path: string) => {
    setChildEntries((prev) => pruneSubtree(prev, path));
    setExpanded((prev) => pruneSubtree(prev, path));
  }, []);

  /**
   * ONE path for every mutation: single-flight, refresh what it touched, and surface the failure.
   *
   * Every message shown on failure comes VERBATIM from the main process. Those strings are written
   * for the user (`"f.txt" already exists here`, `Cannot move or copy a folder into itself`,
   * `That folder is larger than 250 MB — copy it outside the app`) and rewording them here would
   * lose the specific, actionable half. Only a non-Error rejection gets a generic fallback.
   */
  const run = useCallback(
    async function run<T>(
      op: () => Promise<T>,
      after: (result: T) => { ops: TreeOp[]; forget?: string[]; success?: string }
    ): Promise<T | null> {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      try {
        const result = await op();
        const plan = after(result);
        for (const p of plan.forget ?? []) forgetSubtree(p);
        const dirs = plan.ops.flatMap(dirsToRefresh);
        await refreshDirs(Array.from(new Set(dirs)));
        if (plan.success) toastRef.current.success(plan.success);
        return result;
      } catch (err) {
        toastRef.current.error(
          err instanceof Error ? err.message : "That file operation did not complete"
        );
        return null;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [forgetSubtree, refreshDirs]
  );

  /** Expand a folder before creating inside it, so the new row is visible where it lands. */
  async function ensureExpanded(dirPath: string): Promise<boolean> {
    if (dirPath === rootPath || expanded[dirPath]) return true;
    return toggleDir(dirPath);
  }

  /**
   * ── ⚠ REVEAL THE FILE THE EDITOR IS SHOWING ───────────────────────────────────────────────
   *
   * ⚠ SEQUENTIALLY, AND AWAITED, because a folder's children are fetched when it opens. `src/lib/x.ts` needs
   * `src` expanded before `src/lib` is a row that can be expanded at all, so the ancestors are walked
   * outermost-first and each toggle is awaited — a `forEach` of un-awaited toggles reveals nothing below the
   * first level.
   *
   * ⚠ IT BAILS THE MOMENT A FOLDER WILL NOT OPEN. `ensureExpanded` returns false for an unreadable directory
   * and has already said why; continuing would scroll to a row that is not going to exist.
   *
   * ⚠ AND IT DOES NOT FIGHT THE USER. `cancelled` stops a reveal whose file is no longer the active one —
   * clicking through three tabs quickly would otherwise leave two in-flight walks both scrolling the pane.
   */
  useEffect(() => {
    if (!activeFilePath) return;
    let cancelled = false;

    void (async () => {
      for (const dir of ancestorsWithin(rootPath, activeFilePath)) {
        if (cancelled) return;
        if (!(await ensureExpanded(dir))) return;
      }
      if (cancelled) return;
      /**
       * ⚠ THE ROW IS FOUND BY `data-tree-path`, the same attribute the rename/create focus effect uses — so
       * there is one way to address a row rather than two that could disagree. It may legitimately be absent
       * for a beat while the newly-expanded level renders, which is what the rAF is for.
       */
      requestAnimationFrame(() => {
        if (cancelled) return;
        const row = document.querySelector<HTMLElement>(
          `[data-tree-path="${CSS.escape(activeFilePath)}"]`
        );
        /**
         * ⚠ `scrollRowIntoView`, NOT `scrollIntoView`. scroll-containment.test.ts forbids the whole API and
         * caught my first version of this line: `scrollIntoView` walks EVERY scrollable ancestor, so
         * revealing a file could push the app off the top of the window — the reported bug that helper
         * exists for. `block: "nearest"` is a mitigation, not a fix, and the test says so.
         */
        scrollRowIntoView(row);
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeFilePath, rootPath]);

  async function startCreate(target: FileEntry | null, kind: "file" | "dir") {
    const parentDir = target ? createTargetDir(target) : rootPath;
    if (!parentDir) {
      toastRef.current.error("Could not work out which folder to create that in.");
      return;
    }
    /**
     * BAIL if the folder would not open. The create input renders inside a folder's expanded
     * children, so on an unreadable directory it would mount somewhere invisible: the user would see
     * nothing happen, focus would jump to an off-screen input, and their typing would go into a
     * field they cannot see. `ensureExpanded` has already shown the reason.
     */
    if (!(await ensureExpanded(parentDir))) return;
    setRename(null);
    setCreating({ parentDir, kind });
  }

  async function commitCreate(name: string) {
    const pending = creating;
    setCreating(null);
    if (!pending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      // Empty input = cancel, not an error to report back. Focus still has to go somewhere, and
      // "the folder it would have been created in" is the least surprising place.
      setFocusPath(pending.parentDir);
      return;
    }
    const res = await run(
      () =>
        (pending.kind === "dir"
          ? api.createFolder(pending.parentDir, trimmed)
          : api.createFile(pending.parentDir, trimmed)) as Promise<{ path: string }>,
      () => ({ ops: [{ kind: "create", parentDir: pending.parentDir }] })
    );
    // Land focus on the row just created, so a keyboard user can immediately act on it. On failure
    // it falls back to the parent, which still exists.
    setFocusPath(res?.path ?? pending.parentDir);
  }

  function startRename(entry: FileEntry) {
    const { stem } = splitNameForRename(entry.name, entry.type);
    setCreating(null);
    setRename({ path: entry.path, name: entry.name, selectionEnd: stem.length });
  }

  async function commitRename(newName: string) {
    const pending = rename;
    setRename(null);
    if (!pending) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === pending.name) {
      // Nothing to do, but the input is unmounting — put focus back on the unchanged row.
      setFocusPath(pending.path);
      return;
    }
    const res = await run(
      () => api.renamePath(pending.path, trimmed) as Promise<{ path: string }>,
      (result) => ({
        ops: [{ kind: "rename", from: pending.path, to: result.path }],
        // The old path is dead: any cached listing or expand-state under it describes a directory
        // that is not there, and would resurrect if a new folder took the old name.
        forget: [pending.path],
      })
    );
    // The row is re-keyed by the rename, so React unmounts the old one. Follow it to the new path;
    // on failure the original row is still there.
    setFocusPath(res?.path ?? pending.path);
    setClipboard((prev) => clipboardAfterRemoval(prev, pending.path));
  }

  async function doPaste(target: FileEntry | null) {
    if (!clipboard) return;
    const destDir = target ? pasteTargetDir(target) : rootPath;
    const check = canPasteInto(clipboard, destDir);
    if (!check.ok) {
      toastRef.current.error(check.reason ?? "That cannot be pasted here.");
      return;
    }
    if (check.noop) {
      toastRef.current.info(`${clipboard.name} is already in that folder.`);
      return;
    }
    const item = clipboard;
    if (item.mode === "cut") {
      const res = await run(
        () => api.movePath(item.path, destDir) as Promise<{ path: string; moved: boolean }>,
        () => ({
          ops: [{ kind: "move", from: item.path, destDir }],
          forget: [item.path],
        })
      );
      // Only consume the clipboard when the move actually happened. A failed paste must leave the
      // item on the clipboard so the user can retry somewhere else.
      if (res) setClipboard((prev) => clipboardAfterPaste(prev));
    } else {
      await run(
        () => api.copyPath(item.path, destDir) as Promise<{ path: string }>,
        () => ({ ops: [{ kind: "copy", destDir }] })
      );
    }
  }

  async function doTrash(entry: FileEntry) {
    const res = await run(
      () => api.trashPath(entry.path),
      () => ({
        ops: [{ kind: "trash", target: entry.path }],
        forget: [entry.path],
        // Confirms the outcome AND restates where the item went, so recovery is discoverable at the
        // moment it matters rather than only in the confirmation the user has already dismissed.
        success: `${entry.name} moved to the Trash — recover it from there if needed`,
      })
    );
    setClipboard((prev) => clipboardAfterRemoval(prev, entry.path));
    // The row is gone, so there is nothing to focus: the layout effect's fallback puts focus on the
    // tree container, which keeps a keyboard user inside the tree instead of on document.body.
    // On failure the row survives and gets focus back.
    setFocusPath(res ? parentDirOf(entry.path) : entry.path);
  }

  async function doReveal(entry: FileEntry | null) {
    try {
      await api.revealInFolder(entry ? entry.path : rootPath);
    } catch (err) {
      toastRef.current.error(
        err instanceof Error ? err.message : "Could not show that in the file manager"
      );
    }
  }

  /** Monotonic source for the popup remount keys. See `MenuState.id`. */
  const popupSeqRef = useRef(0);

  /** Open the popup for `entry` (or for the root when `entry` is null). */
  const openMenu = useCallback(
    (x: number, y: number, entry: FileEntry | null, origin: HTMLElement | null) => {
      menuOriginRef.current = origin ?? treeRef.current;
      setConfirmTrash(null);
      setMenu({ id: ++popupSeqRef.current, x, y, entry });
    },
    []
  );

  const closeMenu = useCallback(() => setMenu(null), []);
  const closeConfirm = useCallback(() => setConfirmTrash(null), []);

  /**
   * The keyboard shortcuts a focused row handles directly.
   *
   * Cut and Copy give an immediate, VISIBLE acknowledgement (the clipboard strip appears at the top
   * of the tree and the row dims) — without that, ⌘X on a file would look like nothing happened,
   * and the user would press it again.
   */
  function handleRowShortcut(entry: FileEntry, action: RowShortcut) {
    if (busy) return;
    switch (action) {
      case "rename":
        startRename(entry);
        break;
      case "cut":
        setClipboard(cutItem(entry));
        break;
      case "copy":
        setClipboard(copyItem(entry));
        break;
      case "paste":
        void doPaste(entry);
        break;
    }
  }

  /**
   * The menu's contents.
   *
   * ORDER IS FIXED and Delete is always last, behind a separator, at the far end from the routine
   * items — so the muscle memory for "New File" (top) never lands near the destructive one, in any
   * context. The root menu omits Rename/Cut/Delete entirely rather than showing them disabled:
   * main refuses to delete a project root, and offering an action that can only fail is worse than
   * not offering it.
   */
  /**
   * ── THE PANEL TOOLBAR'S FOUR ACTIONS ──
   *
   * Each reuses the machinery the context menu already drives rather than reaching for IPC itself, so
   * "New file" from the toolbar and "New file" from the menu cannot diverge in behaviour.
   */

  /**
   * Create at the ROOT, via the same inline-input flow the menu uses.
   *
   * `startCreate(null, kind)` targets the project root — which is what a toolbar button should do,
   * since it belongs to the section header rather than to any row. The originating element is recorded
   * so focus can return to it if the flow is cancelled.
   */
  function startCreateFromToolbar(kind: "file" | "dir", el: HTMLElement | null) {
    menuOriginRef.current = el;
    // Expanding is unnecessary: the root is always rendered, so the input is always visible.
    if (rootCollapsed) setRootCollapsed(false);
    void startCreate(null, kind);
  }

  /**
   * Re-read the root and every directory currently cached.
   *
   * WHY THIS BUTTON EXISTS AT ALL, given that mutations already refresh what they touch: changes made
   * OUTSIDE the app are invisible to it. Claude writes files, a git sync pulls them, the participant
   * edits in another editor — none of that goes through `run()`, so nothing invalidates the cache.
   * Before this, the only way to see them was to switch project and back.
   *
   * Bounded by what is ALREADY cached — it re-reads open folders, never walks the tree — so the cost
   * is proportional to what is on screen rather than to the size of the repository. A `node_modules`
   * that was never expanded is never read.
   */
  const refreshAll = useCallback(async () => {
    const dirs = [rootPath, ...Object.keys(childEntriesRef.current)];
    await refreshDirs(dirs);
  }, [refreshDirs, rootPath]);

  /**
   * Act on `refreshSignal`, and not on the mount that carries its first value.
   *
   * ⚠ THE SKIP-FIRST GUARD IS NOT DEFENSIVE PADDING. This component mounts with whatever the counter
   * has already reached — it is 3 by the third switch — so an unguarded effect would fire a full
   * re-read on top of the initial load, doubling the disk work of every switch. A `> 0` test would
   * have exactly the same bug from the second switch onward.
   *
   * ⚠ AND IT REFRESHES WHAT IS OPEN, NOT THE WHOLE TREE. `refreshAll` walks the root plus the folders
   * actually expanded, so a `node_modules` nobody opened is never read — the same rule the toolbar's
   * Refresh button follows.
   */
  const seenSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === seenSignal.current) return;
    seenSignal.current = refreshSignal;
    void refreshAll();
  }, [refreshSignal, refreshAll]);

  /**
   * Collapse every folder, keeping the caches.
   *
   * Discarding `childEntries` here would make the next expand re-read from disk for no benefit: the
   * listings are still valid, the user just wants them out of the way. Refresh is the button for
   * "these might be stale".
   */
  function collapseAll() {
    setExpanded({});
    setRootCollapsed(false);
  }

  function buildEntries(state: MenuState): MenuEntry[] {
    const entry = state.entry;
    const destDir = entry ? pasteTargetDir(entry) : rootPath;
    const pasteCheck = canPasteInto(clipboard, destDir);
    const busyReason = busy ? "working…" : undefined;

    const items: MenuEntry[] = [
      {
        id: "new-file",
        label: "New File",
        onSelect: () => void startCreate(entry, "file"),
        disabledReason: busyReason,
      },
      {
        id: "new-folder",
        label: "New Folder",
        onSelect: () => void startCreate(entry, "dir"),
        disabledReason: busyReason,
      },
    ];

    if (entry) {
      items.push(
        { separator: true, id: "sep-edit" },
        {
          id: "rename",
          label: "Rename",
          hint: "F2",
          onSelect: () => startRename(entry),
          disabledReason: busyReason,
        },
        {
          id: "cut",
          label: "Cut",
          hint: `${MOD}X`,
          onSelect: () => setClipboard(cutItem(entry)),
          disabledReason: busyReason,
        },
        {
          id: "copy",
          label: "Copy",
          hint: `${MOD}C`,
          onSelect: () => setClipboard(copyItem(entry)),
          disabledReason: busyReason,
        }
      );
    } else {
      items.push({ separator: true, id: "sep-edit" });
    }

    items.push({
      id: "paste",
      /**
       * The label names the DESTINATION, not the item being pasted.
       *
       * What is on the clipboard is already stated persistently in the strip at the top of the tree;
       * where it will land is the part that can surprise, because right-clicking a FILE pastes into
       * that file's PARENT. Naming the folder answers "paste where?" before the click instead of
       * after it. Keeping the label short also keeps it inside the menu's fixed width, so the
       * safety-relevant half is the half that never gets truncated.
       */
      label: clipboard ? `Paste into ${entry ? basenameOf(destDir) : projectName}` : "Paste",
      hint: `${MOD}V`,
      onSelect: () => void doPaste(entry),
      disabledReason: busyReason ?? (pasteCheck.ok ? undefined : pasteCheck.reason),
    });

    items.push({ separator: true, id: "sep-os" }, {
      id: "reveal",
      label: REVEAL_LABEL,
      onSelect: () => void doReveal(entry),
    });

    if (entry) {
      items.push({ separator: true, id: "sep-danger" }, {
        id: "trash",
        label: "Move to Trash…",
        danger: true,
        // The trailing ellipsis says a confirmation follows — the label itself distinguishes this
        // from the items that act immediately.
        //
        // The confirmation opens at the SAME anchor point as the menu, which is what puts its
        // "Move to Trash" button well below where the menu item the user just clicked was: the
        // menu's Delete row is last, the confirmation's button is ~110px down from the anchor.
        // A double-click on the menu item cannot land on the confirm button.
        onSelect: () =>
          setConfirmTrash({ id: ++popupSeqRef.current, x: state.x, y: state.y, entry }),
        disabledReason: busyReason,
      });
    }

    return items;
  }

  if (loading) {
    return (
      <div className={`text-xs text-surface-muted ${isPanel ? "px-4 py-3" : "p-3"}`}>
        Loading…
      </div>
    );
  }

  return (
    <div
      ref={treeRef}
      tabIndex={-1}
      className="py-1 min-h-full"
      /**
       * Right-clicking anywhere in the tree that is NOT a row opens the ROOT menu, which is how a
       * user creates a top-level file. `min-h-full` is what makes the empty space below the last
       * row a real target rather than a 1px strip.
       *
       * The rows call `stopPropagation`, so this only ever fires for genuine empty space.
       */
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, null, treeRef.current);
      }}
    >
      {/*
        ── THE SECTION HEADER: TWO ROWS ──

        WHY IT WAS ONE ROW AND WHY THAT FAILED. Name and four-to-five buttons shared a single line, so in a
        240px column the name got whatever was left — roughly 90px. A 23-character workshop folder name
        truncated to eight characters and an ellipsis, which is the one string on this panel a participant
        needs to read, and adding Switch to the toolbar made it worse.

        Two rows fixes it by giving the name the full width and the buttons their own line. It costs about
        22px of vertical space once per panel, which the tree gets back many times over by not truncating.
      */}
      <div className={isPanel ? "px-3 py-1.5" : "px-2 py-1"}>
      <div className="flex items-center gap-1">
        {/*
          The root collapse chevron. Folds the ENTIRE tree rather than one folder, as it does in VS Code, and
          it is `aria-expanded` on a real button so a keyboard user reaches the same action the toolbar's
          collapse-all offers.

          ⚠ NO LONGER GATED ON `isPanel`. It was — which meant that after the Explorer tab was removed and
          nothing rendered `variant="panel"` any more, the chevron was unreachable: dead code behind a flag
          with no live caller. Found by auditing what `isPanel` still guarded rather than by anything failing,
          because an absent control raises no error.
        */}
        <button
          type="button"
          onClick={() => setRootCollapsed((v) => !v)}
          aria-expanded={!rootCollapsed}
          aria-label={rootCollapsed ? `Expand ${projectName}` : `Collapse ${projectName}`}
          className="flex-shrink-0 rounded px-0.5 text-[10px] leading-none text-surface-muted hover:text-surface-text focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-brand-accent"
        >
          {rootCollapsed ? "▸" : "▾"}
        </button>
        {/*
          The folder name, now alone on its row and therefore able to use the whole width. `text-surface-text`
          in both variants rather than the rail's old `muted`: it is the heading of the panel and it was only
          dimmed because it used to compete with the buttons beside it.

          `title={rootPath}` gives the FULL PATH on hover, which the name alone cannot — two folders called
          `docs` are indistinguishable otherwise.
        */}
        <span
          className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-surface-text"
          title={rootPath}
        >
          {projectName}
        </span>
      </div>
        {/*
          ── ONE TOOLBAR, BOTH VARIANTS ──

          The rail used to get a single "+" opening the root context menu while the panel got four discrete
          buttons. That split made sense while the panel was the main surface; it is now inverted — the rail
          IS the Explorer, permanently visible, and the tab that hosted the panel is gone. So the rail gets
          the real toolbar rather than the reduced one.

          ⚠ ALWAYS VISIBLE, NOT hover-revealed. VS Code hides these until you hover the section, and that is
          the one detail from its design deliberately NOT copied: a hover-only control is unreachable by
          touch, invisible to anyone who does not know to look, and this app is met for the first time by
          workshop participants. The buttons are the discoverable path; the context menu is the shortcut.
        */}
        {/*
          ── ROW TWO: the actions ──
          Left-aligned under the name rather than right-aligned, so the row reads in the same direction as the
          tree below it and the buttons sit in a fixed place regardless of how long the folder name is. On the
          single-row version they moved horizontally with every project.
        */}
        <div className="mt-0.5 flex items-center gap-0.5">
          <ToolbarButton label="New file" onClick={(el) => startCreateFromToolbar("file", el)}>
            <NewFileIcon />
          </ToolbarButton>
          <ToolbarButton label="New folder" onClick={(el) => startCreateFromToolbar("dir", el)}>
            <NewFolderIcon />
          </ToolbarButton>
          <ToolbarButton label="Refresh" onClick={() => void refreshAll()}>
            <RefreshIcon />
          </ToolbarButton>
          <ToolbarButton label="Collapse folders" onClick={collapseAll}>
            <CollapseAllIcon />
          </ToolbarButton>
          {/*
            Switch, from the removed panel. Last in the row and separated by a rule: the four before it act
            INSIDE this folder, and this one replaces the folder — a different kind of action, and the one
            with consequences, so it does not sit flush against "New file".
          */}
          {onSwitchFolder && (
            <>
              <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-surface-line" />
              {/*
                ── ⚠ DISABLED WHILE THE ASSISTANT IS MID-TURN, AND IT SAYS SO ──────────────────

                ⚠ THE LABEL CARRIES THE REASON, not just the state. A control that greys out with no
                explanation reads as broken — the same rule the context menu follows for its disabled
                items, which state their reason as text rather than hiding it in a `title`. Here the
                tooltip IS the text, and it is the one place a participant will look.
              */}
              <ToolbarButton
                label={
                  switching
                    ? "Opening folder…"
                    : assistantBusy
                      ? "Can't change folder while the assistant is working"
                      : "Open a different folder"
                }
                onClick={() => onSwitchFolder()}
                disabled={switching || assistantBusy}
              >
                <SwitchFolderIcon />
              </ToolbarButton>
            </>
          )}
        </div>
      </div>

      {/*
        The clipboard is stated persistently, not implied by the dimmed row alone. Two reasons: the
        cut row may be scrolled out of view or inside a collapsed folder, and dimming is a
        colour/opacity cue that a user with low vision or a glare-washed screen may not register.
        Cut vs Copy is spelled out in words as well as marked with a glyph.
      */}
      {clipboard && (
        <div
          /*
            ⚠ `text-surface-text`, NOT `muted`, and that is a measured requirement rather than a
            preference: this row sits on `surface.raised`, where `muted` falls to 4.06:1 — under the 4.5:1
            floor. On `raised` only `text` clears it (8.33:1). The token names do not encode where they are
            legal, so the rule is written where it applies.
          */
          className="mx-2 mb-1 flex items-center gap-1.5 rounded border border-surface-line bg-surface-raised px-2 py-1 text-[11px] text-surface-text"
          role="status"
        >
          <span aria-hidden="true">{clipboard.mode === "cut" ? "✂" : "⧉"}</span>
          <span className="flex-shrink-0 uppercase tracking-wide text-surface-text">
            {clipboard.mode === "cut" ? "Cut" : "Copied"}
          </span>
          <span className="truncate font-mono text-surface-text" title={clipboard.path}>
            {clipboard.name}
          </span>
          <button
            type="button"
            onClick={() => setClipboard(null)}
            aria-label={`Clear clipboard (${clipboard.name})`}
            className="ml-auto flex-shrink-0 rounded px-1 text-surface-muted hover:text-surface-text focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-brand-accent"
          >
            ✕
          </button>
        </div>
      )}

      {/*
        THE ROOT LISTING, hidden while the panel's root chevron is collapsed.

        `rootCollapsed` is only ever true in the panel variant, so the rail renders exactly what it did
        before the extraction. The in-progress create input is inside the same guard on purpose: an
        input for a row that is about to appear in a hidden list would be typing into nowhere — which is
        why `startCreateFromToolbar` un-collapses first rather than relying on this.
      */}
      {!rootCollapsed && (
        <>
          {/* A brand-new top-level file/folder is named here, above the listing, where the root's own
              children begin. */}
          {creating && creating.parentDir === rootPath && (
            <InlineNameInput
              initialValue=""
              selectionEnd={0}
              placeholder={creating.kind === "dir" ? "New folder name" : "New file name"}
              depth={0}
              icon={creating.kind === "dir" ? "📁" : "📄"}
              onCommit={commitCreate}
              onCancel={() => setCreating(null)}
            />
          )}

          {/*
            An EMPTY project folder says so. Before, it rendered as nothing at all — indistinguishable
            from a tree that had failed to load, which is the more alarming of the two readings.
          */}
          {entries.length === 0 && !creating && (
            <p className={`text-xs italic text-surface-muted ${isPanel ? "px-4 py-3" : "px-3 py-2"}`}>
              This folder is empty.
            </p>
          )}

          <TreeLevel
            entries={entries}
            expanded={expanded}
            childEntries={childEntries}
            clipboard={clipboard}
            rename={rename}
            creating={creating}
            onToggle={toggleDir}
            onOpenFile={onOpenFile}
            activeFilePath={activeFilePath ?? null}
            onOpenMenu={openMenu}
            onRowShortcut={handleRowShortcut}
            onCommitRename={commitRename}
            onCancelRename={() => setRename(null)}
            onCommitCreate={commitCreate}
            onCancelCreate={() => setCreating(null)}
            depth={0}
          />
        </>
      )}

      {/* `key` forces a REMOUNT per open — see MenuState.id. Without it, reopening on another row in
          the same tick reuses the frozen position and focus index. */}
      {menu && (
        <TreeContextMenu
          key={menu.id}
          x={menu.x}
          y={menu.y}
          label={menu.entry ? `Actions for ${menu.entry.name}` : `Actions for ${projectName}`}
          entries={buildEntries(menu)}
          restoreFocusTo={menuOriginRef}
          onClose={closeMenu}
        />
      )}

      {confirmTrash && (
        <TrashConfirmPopover
          key={confirmTrash.id}
          x={confirmTrash.x}
          y={confirmTrash.y}
          name={confirmTrash.entry.name}
          kind={confirmTrash.entry.type}
          restoreFocusTo={menuOriginRef}
          onConfirm={() => void doTrash(confirmTrash.entry)}
          onClose={closeConfirm}
        />
      )}

    </div>
  );
}

/**
 * The inline name input, used for BOTH rename and create.
 *
 * ── WHY IT IS ITS OWN COMPONENT WITH LOCAL STATE ──
 *
 * The value lives here, not in `FileTree`. Lifting it would re-render every row in the tree on
 * each keystroke; kept local, typing repaints one input. It is also why the input is keyed by path
 * at the call site — remounting is what resets it for the next row.
 *
 * ── SELECTION ──
 *
 * `selectionEnd` is the length of the filename STEM, so renaming `notes.md` arrives with `notes`
 * selected and `.md` intact behind the caret. Done in one LAYOUT effect on mount — focus, then
 * `setSelectionRange`, with no layout read between them — so the first painted frame already has the
 * caret and selection in place. With a plain `useEffect` there is a frame where the input is visible
 * and unfocused, and a keystroke in that gap goes to the row behind it.
 */
function InlineNameInput({
  initialValue,
  selectionEnd,
  placeholder,
  depth,
  icon,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  selectionEnd: number;
  placeholder?: string;
  depth: number;
  icon: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Guards against committing twice — blur fires when Enter's commit moves focus away. */
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, selectionEnd);
  }, [selectionEnd]);

  function commit() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  }

  function cancel() {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  }

  return (
    <div
      className="flex items-center gap-1 py-[3px]"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      // The tree's container turns a right-click into the root menu; inside the input the browser's
      // own editing menu (cut/paste/spelling) is the useful one, so the event stops here.
      onContextMenu={(e) => e.stopPropagation()}
    >
      <span className="w-3 flex-shrink-0" />
      <span aria-hidden="true" className="flex-shrink-0 text-[11px]">
        {icon}
      </span>
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder ?? "New name"}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Both stopped: Enter would otherwise reach the row's keydown handler and Escape would
          // close a popup that is not the thing the user is trying to dismiss.
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        /**
         * Blur COMMITS rather than cancelling.
         *
         * Clicking away from a half-typed name and losing it is the more annoying failure, and the
         * commit is safe in both directions: an unchanged or empty value is discarded by the
         * handlers, and a name the filesystem refuses comes back as the main process's own message
         * rather than as a silent loss.
         */
        onBlur={commit}
        /* Matches the row's own size: an inline rename that rendered smaller than the name it replaces
           would make the text appear to shrink the moment you started editing it. */
        className="min-w-0 flex-1 rounded border border-brand-accent bg-surface-raised px-1 py-0 text-sm text-surface-text outline-none focus:border-brand-accent"
      />
    </div>
  );
}

function TreeLevel({
  entries,
  expanded,
  childEntries,
  clipboard,
  rename,
  creating,
  onToggle,
  onOpenFile,
  activeFilePath,
  onOpenMenu,
  onRowShortcut,
  onCommitRename,
  onCancelRename,
  onCommitCreate,
  onCancelCreate,
  depth,
}: {
  entries: FileEntry[];
  expanded: Record<string, boolean>;
  childEntries: Record<string, FileEntry[]>;
  clipboard: ClipboardItem | null;
  rename: RenameState | null;
  creating: { parentDir: string; kind: "file" | "dir" } | null;
  // Returns a promise the rows ignore — declared `unknown` so a floating promise is not implied.
  onToggle: (path: string) => unknown;
  onOpenFile?: (path: string) => void;
  /** The file the editor shows, so its row reads as the selected one. */
  activeFilePath?: string | null;
  onOpenMenu: (x: number, y: number, entry: FileEntry | null, origin: HTMLElement | null) => void;
  onRowShortcut: (entry: FileEntry, action: RowShortcut) => void;
  onCommitRename: (value: string) => void;
  onCancelRename: () => void;
  onCommitCreate: (value: string) => void;
  onCancelCreate: () => void;
  depth: number;
}) {
  return (
    <>
      {entries.map((entry) => {
        const isDir = entry.type === "dir";
        const isOpen = expanded[entry.path];
        const children = childEntries[entry.path];
        const cutPending = isCutPending(clipboard, entry.path);
        // Narrowed to the state object rather than a boolean, so the input below can read it
        // without a non-null assertion.
        const renaming = rename && rename.path === entry.path ? rename : null;
        const creatingHere = creating && creating.parentDir === entry.path ? creating : null;

        return (
          <div key={entry.path}>
            {renaming ? (
              <InlineNameInput
                initialValue={renaming.name}
                selectionEnd={renaming.selectionEnd}
                depth={depth}
                icon={getIcon(entry)}
                onCommit={onCommitRename}
                onCancel={onCancelRename}
              />
            ) : (
              <button
                type="button"
                /**
                 * STILL A <button>, deliberately.
                 *
                 * A full `role="tree"`/`treeitem` conversion would be the textbook answer, but it
                 * replaces this tree's per-row tab stops with a single composite widget plus its own
                 * roving-tabindex and typeahead — a much larger behavioural change than adding a
                 * context menu, and one that would silently alter how every existing user navigates.
                 * The native button semantics already give each row a tab stop, Enter/Space
                 * activation, and an accessible name. `aria-expanded` is the one thing that was
                 * missing, and it is added below.
                 */
                aria-expanded={isDir ? Boolean(isOpen) : undefined}
                aria-haspopup="menu"
                // Focus target for the layout effect in FileTree, which has to find a row that did
                // not exist when the operation started (a rename re-keys it, a create adds it).
                data-tree-path={entry.path}
                /**
                 * ⚠ `aria-current`, NOT ONLY A BACKGROUND. The selected row is a fact a screen reader needs
                 * as much as a sighted reader — "which file am I looking at" is the whole point of revealing
                 * it — and colour alone says nothing to either assistive tech or somebody who cannot
                 * distinguish the two greys.
                 */
                aria-current={!isDir && activeFilePath && samePath(entry.path, activeFilePath) ? "true" : undefined}
                className={
                  // ⚠ `text-sm`, up from `text-xs`. 12px was tight for the longest thing in the column and the only text
                  // here somebody reads character by character — a filename, where `config` vs `configs`
                  // matters. The row keeps `py-[3px]`, so the column shows nearly as many entries.
                  "flex w-full items-center gap-1 rounded py-[3px] text-left text-sm " +
                  "hover:bg-surface-raised focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-brand-accent " +
                  /**
                   * ⚠ THE SELECTED ROW IS MARKED, AND ONLY FILES CAN BE SELECTED. A folder is expanded, not
                   * opened, so highlighting one would claim a state the editor does not have.
                   *
                   * `surface-raised` is the same token `hover` uses, so the selected row reads as
                   * persistently hovered rather than introducing a colour this panel does not otherwise
                   * have — and `font-medium` carries the distinction where the two greys are close.
                   */
                  (!isDir && activeFilePath && samePath(entry.path, activeFilePath)
                    ? "bg-surface-raised font-medium"
                    : "")
                }
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                onClick={() => {
                  if (isDir) onToggle(entry.path);
                  else if (onOpenFile) onOpenFile(entry.path);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // Stops the tree container from also handling it as a root-level right-click.
                  e.stopPropagation();
                  onOpenMenu(e.clientX, e.clientY, entry, e.currentTarget);
                }}
                onKeyDown={(e) => {
                  /**
                   * Shift+F10 and the Menu/ContextMenu key are the two platform-standard ways to
                   * open a context menu from the keyboard. Both are honoured, so whichever a user
                   * already knows works. The popup is positioned from the ROW's rectangle rather
                   * than a pointer position, so it appears attached to the row the user is on.
                   *
                   * `getBoundingClientRect` here is a read inside an EVENT handler, before any
                   * write in this frame — not a read-after-write, so it forces no extra layout.
                   */
                  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    onOpenMenu(r.left + 12, r.bottom, entry, e.currentTarget);
                    return;
                  }
                  // F2: the rename shortcut on every platform this ships to, and it needs no
                  // modifier because it cannot be mistaken for a text-entry keystroke.
                  if (e.key === "F2") {
                    e.preventDefault();
                    onRowShortcut(entry, "rename");
                    return;
                  }
                  // ⌘/Ctrl + X/C/V, matching the labels in the menu. `altKey` is excluded so a
                  // system-level Alt combination is not swallowed.
                  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
                    const action =
                      e.key === "x" || e.key === "X"
                        ? "cut"
                        : e.key === "c" || e.key === "C"
                          ? "copy"
                          : e.key === "v" || e.key === "V"
                            ? "paste"
                            : null;
                    if (action) {
                      e.preventDefault();
                      onRowShortcut(entry, action);
                    }
                  }
                }}
              >
                {/*
                  THE DIMMING IS ON THIS INNER SPAN, NOT ON THE BUTTON.

                  Two reasons, both bugs I would otherwise have shipped:
                    * `opacity` on the button fades its FOCUS RING too, and a 50%-opacity focus
                      indicator on a cut row fails the 3:1 non-text contrast requirement — the row a
                      keyboard user is standing on would become the hardest one to locate.
                    * It would also fade the "CUT" label below, which is the redundant TEXT cue that
                      exists precisely so the state does not depend on opacity.
                  Opacity on a span creates a compositing layer and animates nothing; no layout
                  property changes, so adding or dropping the class cannot reflow the row.
                */}
                <span
                  className={`flex min-w-0 flex-1 items-center gap-1 ${cutPending ? "opacity-50" : ""}`}
                >
                  {isDir ? (
                    <span aria-hidden="true" className="w-3.5 flex-shrink-0 text-center text-[11px] text-surface-muted">
                      {isOpen ? "▾" : "▸"}
                    </span>
                  ) : (
                    <span aria-hidden="true" className="w-3 flex-shrink-0" />
                  )}
                  <span aria-hidden="true" className="flex-shrink-0 text-[13px]">{getIcon(entry)}</span>
                  <span className={`truncate ${isDir ? "text-surface-text" : "text-surface-muted"}`}>
                    {entry.name}
                  </span>
                </span>
                {/*
                  Cut state as TEXT as well as opacity, at full contrast. Colour/opacity alone is not
                  a status: it is invisible under glare, on an angled wall display, and to a user who
                  has turned opacity effects down. The row is already `flex`, so this occupies the
                  trailing slot the truncating name yields — the name shortens, the row does not
                  change height, and nothing below it moves.
                */}
                {cutPending && (
                  <span className="flex-shrink-0 pr-2 text-[10px] font-medium uppercase tracking-wide text-surface-text">
                    cut
                  </span>
                )}
              </button>
            )}

            {/* A new child of THIS folder is named at the top of its expanded children, which is
                where the row will appear once the dir-before-file sort has run. */}
            {isDir && isOpen && creatingHere && (
              <InlineNameInput
                initialValue=""
                selectionEnd={0}
                placeholder={creatingHere.kind === "dir" ? "New folder name" : "New file name"}
                depth={depth + 1}
                icon={creatingHere.kind === "dir" ? "📁" : "📄"}
                onCommit={onCommitCreate}
                onCancel={onCancelCreate}
              />
            )}

            {isDir && isOpen && children && (
              <TreeLevel
                entries={children}
                expanded={expanded}
                childEntries={childEntries}
                clipboard={clipboard}
                rename={rename}
                creating={creating}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                activeFilePath={activeFilePath}
                onOpenMenu={onOpenMenu}
                onRowShortcut={onRowShortcut}
                onCommitRename={onCommitRename}
                onCancelRename={onCancelRename}
                onCommitCreate={onCommitCreate}
                onCancelCreate={onCancelCreate}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * One icon button in the panel's section-header toolbar.
 *
 * `title` AND `aria-label` from the same string, so the tooltip a mouse user gets and the name a screen
 * reader announces cannot drift apart — the icons are line art with no text, so the label IS the
 * control's only name.
 *
 * The click handler receives the ELEMENT rather than the event: the only thing any caller needs from it
 * is somewhere to return focus to, and passing the element makes that the obvious use rather than
 * something to dig out of `currentTarget` (which is null by the time an async handler resumes).
 */
/**
 * ── ⚠ A TOOLTIP THAT ACTUALLY APPEARS, ON EVERY ONE OF THESE ──────────────────────────────────
 *
 * ⚠ THEY ALL CARRIED `title` ALREADY, and that is precisely the bug rather than a defence. This is the
 * same finding IconTooltip was written for (the copy and refresh icons' tooltips on AI messages did not
 * appear on hover), and both of its causes apply here with more force:
 *
 *   1. THE TARGET IS TINY — a 16px glyph in `p-1`. Chromium shows a `title` only after the pointer RESTS
 *      for about a second, and on a target this small the pointer crosses rather than settles.
 *   2. IT WOULD BE CLIPPED — the tree sits in an `overflow-y-auto` container (Sidebar.tsx), which clips
 *      any absolutely positioned child. IconTooltip portals to `document.body` for exactly this.
 *
 * ⚠ `title` IS KEPT ALONGSIDE, matching CopyButton: it is the fallback if the bubble ever fails to mount,
 * and the bubble is `aria-hidden` so nothing is announced twice — the accessible name is `aria-label`.
 *
 * ⚠ WRAPPED HERE, NOT AT THE FIVE CALL SITES. One wrapper means a sixth button cannot ship without one,
 * which is how these five came to be inconsistent with the chat's icons in the first place.
 */
function ToolbarButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: (el: HTMLElement) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <IconTooltip label={label}>
    <button
      type="button"
      onClick={(e) => onClick(e.currentTarget)}
      disabled={disabled}
      title={label}
      aria-label={label}
      /*
        `disabled:` states rather than hiding the button: a control that vanishes mid-operation moves every
        button beside it, so a second click lands on the wrong one.
      */
      className="rounded p-1 text-surface-muted hover:bg-surface-raised hover:text-surface-text focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-brand-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
    </IconTooltip>
  );
}

/**
 * ── THE TOOLBAR ICONS ──
 *
 * Line art at 16px on a 1.2 stroke, matching the VS Code explorer's weight. Inline SVG rather
 * than the emoji used for file rows, for one reason that matters: emoji render at the mercy of the
 * platform font and would not sit on a shared baseline with each other at this size, so a row of four
 * would look ragged. `aria-hidden` on every one — ToolbarButton carries the accessible name.
 */
function IconFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function NewFileIcon() {
  return (
    <IconFrame>
      <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h5" />
      <path d="M9 1.5 12.5 5v3" />
      <path d="M9 1.5V5h3.5" />
      <path d="M11.5 10v4M9.5 12h4" />
    </IconFrame>
  );
}

function NewFolderIcon() {
  return (
    <IconFrame>
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h3.5a1 1 0 0 1 1 1V9" />
      <path d="M1.5 4.5v8a1 1 0 0 0 1 1h6" />
      <path d="M11.5 10v4M9.5 12h4" />
    </IconFrame>
  );
}

function RefreshIcon() {
  return (
    <IconFrame>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2" />
      <path d="M13.5 2.5V6H10" />
    </IconFrame>
  );
}

/** Two arrows swapping — "replace this folder with another", distinct from the four that act inside it. */
function SwitchFolderIcon() {
  return (
    <IconFrame>
      <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7.5Z" />
      <path d="M6 8.5h4M8.5 7l1.5 1.5L8.5 10" />
    </IconFrame>
  );
}

function CollapseAllIcon() {
  return (
    <IconFrame>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d="M5 8h6" />
    </IconFrame>
  );
}

function getIcon(entry: FileEntry): string {
  if (entry.type === "dir") {
    if (entry.name === "node_modules") return "📦";
    if (entry.name === ".git") return "🔒";
    if (entry.name.startsWith(".")) return "⚙️";
    if (entry.name === "src") return "📂";
    return "📁";
  }
  const ext = entry.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "🔷";
    case "js": case "jsx": return "🟡";
    case "json": return "📋";
    case "md": return "📝";
    case "css": return "🎨";
    case "html": return "🌐";
    case "py": return "🐍";
    case "rs": return "🦀";
    case "go": return "🔵";
    case "yaml": case "yml": return "⚙️";
    case "toml": return "⚙️";
    case "sh": return "🖥️";
    default: return "📄";
  }
}
