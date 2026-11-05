// ── ⚠ SEVERAL FILES OPEN AT ONCE, WITHOUT LOSING ANYONE'S EDITS ──────────────────────────
//
// Until now `openFilePath` was a single string: opening a file REPLACED the one before it, so following a
// reference meant losing your place, and an unsaved edit went with it.
//
// ── WHY THIS IS A MODULE AND NOT A `useState` IN THE VIEW ──
//
// Because the open/close rules have to be exercised, and the interesting ones are all about NOT destroying
// work:
//
//   ⚠ BOUNDED. An unbounded tab list is an unbounded number of mounted editors, each holding a file's text
//     twice (current and original, to know whether it is dirty). Opening a folder's worth of files should not
//     be a memory decision the app makes silently.
//
//   ⚠ AND THE BOUND MUST NOT EAT UNSAVED WORK. At the cap, room is made by closing the OLDEST CLEAN tab. A
//     dirty tab is never closed to make room — if every tab is dirty the open is REFUSED with a reason,
//     which is the honest answer. Silently discarding an edit to honour a tab limit would be the worst
//     possible reading of "bounded".
//
//   ⚠ CLOSING THE ACTIVE TAB MUST LAND SOMEWHERE SENSIBLE — the neighbour to the left, or the right when it
//     was the first. Landing on "nothing" would close the whole editor because one of five files was closed.

/** The open tabs, oldest first, and which one is showing. */
import { basenameOf, parentDirOf } from "./file-tree-ops";

export interface TabState {
  /** Paths in the order they were opened. Order is what makes "the oldest clean tab" meaningful. */
  open: string[];
  /** The visible file, or null when nothing is open. */
  active: string | null;
}

export const EMPTY_TABS: TabState = { open: [], active: null };

/**
 * How many files may be open at once.
 *
 * Twelve is past what fits on one row at a readable width, so the row scrolls before the cap is reached —
 * i.e. the limit is about held memory, not about layout. A participant in a workshop opens a handful.
 */
export const MAX_OPEN_TABS = 12;

export interface OpenResult {
  state: TabState;
  /**
   * Set when the request could not be honoured in full. Shown to the participant — a cap that silently
   * refuses is indistinguishable from a broken click.
   */
  refused?: string;
}

/**
 * Open a file, or focus it if it is already open.
 *
 * @param isDirty Asked per path rather than passed as a set, because the answer lives in each mounted
 *                editor. A path this returns true for will never be closed to make room.
 */
export function openTab(
  state: TabState,
  path: string,
  isDirty: (path: string) => boolean = () => false
): OpenResult {
  // Already open: focus it. Re-adding would move it in the order and lose its place in the row.
  if (state.open.includes(path)) {
    return { state: { open: state.open, active: path } };
  }

  if (state.open.length < MAX_OPEN_TABS) {
    return { state: { open: [...state.open, path], active: path } };
  }

  /**
   * At the cap. The oldest CLEAN tab goes; a dirty one is passed over however old it is.
   */
  const evictable = state.open.find((p) => !isDirty(p));
  if (!evictable) {
    return {
      state,
      refused: `All ${MAX_OPEN_TABS} open files have unsaved changes. Save or close one first.`,
    };
  }

  return {
    state: {
      open: [...state.open.filter((p) => p !== evictable), path],
      active: path,
    },
  };
}

/**
 * Close one tab and choose what to show next.
 *
 * ⚠ THE NEIGHBOUR TO THE LEFT, and it is the position in the ORIGINAL list that decides — computed before
 * the path is removed. Reading the index afterwards shifts every tab left by one and lands on the wrong file.
 */
export function closeTab(state: TabState, path: string): TabState {
  const index = state.open.indexOf(path);
  if (index === -1) return state;

  const open = state.open.filter((p) => p !== path);
  if (open.length === 0) return EMPTY_TABS;

  // Only the ACTIVE tab closing moves the focus; closing a background tab must not change what you are reading.
  if (state.active !== path) return { open, active: state.active };

  /**
   * ⚠ `index - 1`, NOT `Math.min(index, …)`. My first version used the latter and landed on the tab to the
   * RIGHT — because after filtering, position `index` is occupied by what used to be its right neighbour. It
   * read as correct and contradicted the rule stated above; the test caught it.
   *
   * Clamped at 0, which is what makes closing the FIRST tab land on the one that is now first.
   */
  return { open, active: open[Math.max(0, index - 1)] };
}

/** Close every tab whose path is not under `root` — used when the project folder changes. */
export function closeTabsOutside(state: TabState, root: string): TabState {
  /**
   * ⚠ THE TRAILING SEPARATOR MATTERS. Without it, root `/a/proj` would keep a file from `/a/project-two`,
   * because the string starts with the same characters. The same prefix trap `assertWithinProject` guards
   * against in main.
   */
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const open = state.open.filter((p) => p.startsWith(prefix));

  if (open.length === state.open.length) return state;
  if (open.length === 0) return EMPTY_TABS;

  return {
    open,
    // Keep showing the same file when it survived; otherwise fall back to the first that did.
    active: state.active && open.includes(state.active) ? state.active : open[0],
  };
}

/**
 * The label for a tab: the file's own name.
 *
 * ⚠ `basenameOf`, NOT `split("/")`. Paths arrive from the main process built with `path.join`, so on
 * Windows they are separator-separated by `\` and splitting on `/` finds nothing — the tab would be
 * labelled `C:\Users\me\proj\src\main.ts` in full, on every tab. The helper accepts both
 * separators and handles the drive root; see the note at the top of file-tree-ops.ts, which called
 * this assumption out and hardened itself against it while the rest of the renderer kept it.
 */
export function tabLabel(path: string): string {
  return basenameOf(path) || path;
}

/**
 * Disambiguate tabs that would otherwise show the same name.
 *
 * ⚠ A PROJECT HAS TWENTY FILES CALLED `index.ts`, and four tabs all reading "index.ts" are unusable — the
 * same reason the file-search rows show their directory. Only the AMBIGUOUS ones gain a parent directory, so
 * the common case stays short.
 */
export function tabLabels(open: string[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const p of open) {
    const name = tabLabel(p);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const labels: Record<string, string> = {};
  for (const p of open) {
    const name = tabLabel(p);
    if ((counts.get(name) ?? 0) > 1) {
      /**
       * ⚠ THE WORST OF THE SEPARATOR BUGS, because it produced `undefined` rather than a wrong string:
       * `split("/")` on a Windows path yields a ONE-element array, and `slice(-2, -1)` of that is empty,
       * so the disambiguator vanished exactly where duplicate names made it necessary.
       */
      const parent = basenameOf(parentDirOf(p));
      labels[p] = parent ? `${parent}/${name}` : name;
    } else {
      labels[p] = name;
    }
  }
  return labels;
}
