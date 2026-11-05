// ── FIND A FILE BY NAME ───────────────────────────────────────────────────────────────────
//
// ⚠ IT SITS BELOW THE TREE, NOT ABOVE IT, and that is the intended placement. It also
// happens to be the right one: the tree is the primary way to browse and takes the space, while search is
// what you reach for when you already know the name. Above the tree it would push the thing people use most
// down the panel on every launch.
//
// The walk itself is in main (`files:searchFiles`), bounded on results, entries visited and depth, because
// an unbounded recursive walk over a real repository is a UI freeze triggered by typing.

import { useEffect, useRef, useState } from "react";
import { parentDirOf } from "../lib/file-tree-ops";

const api = (window as any).electronAPI;

/** A file the search found. `relPath` is what the row shows — a bare basename is ambiguous. */
interface Hit {
  name: string;
  path: string;
  relPath: string;
}

/**
 * How long to wait after the last keystroke before walking the tree.
 *
 * ⚠ THE DEBOUNCE IS THE WHOLE REASON THIS IS NOT A `useEffect` ON EVERY CHANGE. Each search is a recursive
 * filesystem walk in the main process; firing one per character turns "components" into eleven walks, all
 * but the last of them wasted, and they queue behind each other on the same IPC channel.
 */
const DEBOUNCE_MS = 180;

export function FileSearch({
  rootPath,
  onOpenFile,
  variant = "panel",
}: {
  rootPath: string;
  onOpenFile?: (filePath: string) => void;
  /**
   * Where this instance is mounted.
   *
   * ⚠ `bar` IS NOW THE ONE IN USE, and it lives in the WINDOW TITLE BAR, centred — having first been in the
   * sidebar and then in a strip of its own. The two variants differ in more than padding: in the sidebar the
   * results pushed the tree down the column, while here they must FLOAT, because the title bar is 40px tall
   * and anything that grows it would shove the entire window's contents down on every keystroke.
   *
   * `panel` is kept rather than deleted: it is the shape that works in a 240px column, and this component is
   * the only thing that knows how to lay itself out for one.
   */
  variant?: "panel" | "bar";
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);

  /**
   * ⚠ GUARDS AGAINST AN OUT-OF-ORDER ANSWER. Two walks can be in flight when typing resumes mid-search, and
   * the slower one may land last — putting results for "comp" under the query "components". Each request
   * takes a sequence number and only the newest may write state.
   */
  const seq = useRef(0);

  /** For the blur on open — see the row's `onClick`. */
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * ── ⚠ FOCUSED FROM A KEYBOARD SHORTCUT, VIA A WINDOW EVENT ────────────────────────────────────
   *
   * ⚠ AN EVENT RATHER THAN A PROP, because this component sits in the title bar and the shortcut is
   * registered in App — threading a `focusSignal` counter down would make every keystroke a re-render of the
   * bar, and this app already uses window events for exactly this shape of renderer-to-renderer signal
   * (`ai:response-complete`, `ai:permission-pending`).
   */
  useEffect(() => {
    const onFocusRequest = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("editor:quick-open", onFocusRequest);
    return () => window.removeEventListener("editor:quick-open", onFocusRequest);
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      setTruncated(false);
      setSearching(false);
      return;
    }

    const mine = ++seq.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api.searchFiles?.(rootPath, term);
        if (mine !== seq.current) return; // A newer query has already been issued.
        setHits(result?.files ?? []);
        setTruncated(!!result?.truncated);
      } catch {
        // A failed search shows no results rather than an error banner in a 240px panel: the input is still
        // there, and the next keystroke retries. Nothing was destroyed and nothing is hidden.
        if (mine === seq.current) {
          setHits([]);
          setTruncated(false);
        }
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, rootPath]);

  const isBar = variant === "bar";

  return (
    <div className={isBar ? "relative w-full" : "border-t border-surface-line px-2 py-2"}>
      <label htmlFor="file-search" className="sr-only">
        Search files in this project
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id="file-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears rather than blurs: the box is small and the results push the panel around, so
            // "get rid of this" is the common intent.
            if (e.key === "Escape") {
              e.preventDefault();
              setQuery("");
            }
          }}
          placeholder="Search files…"
          spellCheck={false}
          autoComplete="off"
          className={`w-full rounded border border-surface-line bg-surface-bg pr-6 text-surface-text placeholder:text-surface-muted focus:border-blue-500 focus:outline-none ${
            /* `py-0.5` and `text-xs`: this sits in a 40px title bar beside the traffic lights, so the field
               is ~26px tall. Centred text, as the reference layout draws it. */
            isBar ? "px-3 py-0.5 text-center text-xs" : "px-2 py-1.5 text-xs"
          }`}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear the file search"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-surface-muted hover:text-surface-text"
          >
            ✕
          </button>
        )}
      </div>

      {/*
        ⚠ A LIVE REGION, so a screen-reader user learns the result count. Without it the only feedback is a
        list appearing below a text box, which is invisible to anyone not looking at it. Polite, so it waits
        for a pause rather than announcing on every keystroke.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {query.trim()
          ? searching
            ? "Searching"
            : `${hits.length} file${hits.length === 1 ? "" : "s"} found${truncated ? ", list is partial" : ""}`
          : ""}
      </p>

      {query.trim() && !searching && hits.length === 0 && (
        <p
          className={
            isBar
              ? "absolute left-0 right-0 top-full z-50 mt-1 rounded border border-surface-line bg-surface-panel px-2 py-1.5 text-[11px] text-surface-muted shadow-lg"
              : "mt-1.5 px-1 text-[11px] text-surface-muted"
          }
        >
          No matching files.
        </p>
      )}

      {hits.length > 0 && (
        /*
          Capped in height and scrollable: the results sit at the BOTTOM of the panel, so an unbounded list
          would push the tree off the top of the sidebar as you type.
        */
        <ul
          className={
            isBar
              ? /*
                  ⚠ ABSOLUTE, AND ABOVE THE PANES. In the bar this list CANNOT take part in the layout: the
                  strip is one row tall and beside it sit the editor and the chat, so a list in flow would
                  push both down and then back up as you typed. `z-30` clears the pane headers underneath.
                */
                /*
                  ⚠ `z-50`, RAISED FROM `z-30` WHEN THIS MOVED INTO THE TITLE BAR. The strip is now the FIRST
                  element in the window, so everything it must cover — both panes, their headers, the pinned
                  divider — comes after it in the DOM and would otherwise paint on top. The panes use `z-10`
                  and `z-20` internally and none of them creates a stacking context, so they compare directly
                  with this one.
                */
                "absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded border border-surface-line bg-surface-panel shadow-lg"
              : "mt-1.5 max-h-48 overflow-y-auto"
          }
        >
          {hits.map((hit) => (
            <li key={hit.path}>
              <button
                type="button"
                onClick={() => {
                  onOpenFile?.(hit.path);
                  /**
                   * ⚠ CLEARED ON OPEN: selecting a file from the search results closes the search bar and
                   * clears the search text.
                   *
                   * The results stayed open over the very file they had just opened — so the thing you asked
                   * to see was covered by the list you asked it from, and the next search began by selecting
                   * and deleting the old query. Clearing the text closes the list, because the list is
                   * rendered from it.
                   *
                   * ⚠ AND THE FIELD IS BLURRED TOO. In the title bar a focused-but-empty box keeps its ring
                   * over the window chrome, which reads as "still searching" when the search is finished.
                   */
                  setQuery("");
                  inputRef.current?.blur();
                }}
                title={hit.relPath}
                className="w-full rounded px-1 py-1 text-left hover:bg-surface-raised"
              >
                <span className="block truncate text-xs text-surface-text">{hit.name}</span>
                {/*
                  ⚠ THE DIRECTORY IS SHOWN, and it is not decoration: a project has twenty files called
                  `index.ts`, and a list of identical names is unusable. `dir` rather than the full relative
                  path so the row does not wrap; `title` carries the whole thing.
                */}
                <span className="block truncate text-[10px] text-surface-muted">
                  {/* parentDirOf handles both separators; the old split showed the whole relative path. */}
                  {parentDirOf(hit.relPath) || "."}
                </span>
              </button>
            </li>
          ))}
          {/*
            ⚠ THE TRUNCATION NOTE LIVES INSIDE THE LIST IN BAR MODE, because the list FLOATS: a note rendered
            after it would be positioned behind the panes and never seen. My first version simply hid it here,
            which is worse than a layout bug — a capped list that does not say it is capped reads as the
            complete set of matches. Shed load observably.
          */}
          {truncated && isBar && (
            <li className="border-t border-surface-line px-2 py-1 text-[10px] text-surface-faint">
              Showing the first {hits.length}. Narrow the search to see more.
            </li>
          )}
        </ul>
      )}

      {truncated && !isBar && (
        <p className="mt-1 px-1 text-[10px] text-surface-faint">
          {/* Shed load OBSERVABLY: a capped list must not read as a complete one. */}
          Showing the first {hits.length}. Narrow the search to see more.
        </p>
      )}
    </div>
  );
}
