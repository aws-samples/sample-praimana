// ── THE OPEN-FILE TAB ROW ─────────────────────────────────────────────────────────────────
//
// The rules about WHICH tabs exist live in `lib/file-tabs.ts`; this file is only the row.

import { tabLabels } from "../lib/file-tabs";

export function FileTabs({
  open,
  active,
  dirty,
  onSelect,
  onClose,
}: {
  open: string[];
  active: string | null;
  /** Paths with unsaved changes — marked, so closing one is a visibly deliberate act. */
  dirty: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  if (open.length === 0) return null;

  const labels = tabLabels(open);

  return (
    /*
      ⚠ SCROLLS RATHER THAN WRAPS. A second row of tabs would change the height of the strip above the
      editor, and that strip sits beside the chat pane's header — the alignment the pane-header work just
      fixed. `overflow-x-auto` keeps it exactly one row however many files are open.
    */
    <div
      role="tablist"
      aria-label="Open files"
      className="flex h-9 flex-shrink-0 items-stretch overflow-x-auto border-b border-surface-line bg-surface-bg"
    >
      {open.map((path) => {
        const isActive = path === active;
        const isDirty = dirty.has(path);

        return (
          /*
            ⚠ NOT A NESTED BUTTON. The tab is a button and so is its ✕, and a button inside a button is
            invalid HTML that browsers resolve by dropping one of them. They are SIBLINGS in a flex row, which
            is the same shape the sidebar rows use for their pin.
          */
          <div
            key={path}
            className={`group/tab flex flex-shrink-0 items-center border-r border-surface-line ${
              isActive ? "bg-surface-panel" : "bg-surface-bg hover:bg-surface-panel/60"
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(path)}
              /* The full path, because a tab shows a name and a name is not unique. */
              title={path}
              className={`flex max-w-[13rem] items-center gap-1.5 py-1.5 pl-3 pr-1.5 text-xs ${
                isActive ? "text-surface-text" : "text-surface-muted"
              }`}
            >
              {/* Decorative: the accessible name is the label beside it. */}
              <span aria-hidden="true" className="text-[10px] opacity-60">
                ▤
              </span>
              <span className="truncate">{labels[path]}</span>
              {isDirty && (
                /*
                  ⚠ A WORD FOR THE SCREEN READER, A DOT FOR THE EYE. A bare dot conveys "unsaved" only to
                  someone who can see it, and this is the cue that a close is about to lose work.
                */
                <>
                  <span aria-hidden="true" className="text-[13px] leading-none text-brand-accent">
                    •
                  </span>
                  <span className="sr-only">unsaved changes</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={() => onClose(path)}
              aria-label={`Close ${labels[path]}${isDirty ? " — it has unsaved changes" : ""}`}
              /*
                ⚠ ALWAYS RENDERED, and only its OPACITY changes on hover. Rendering it conditionally would
                change the tab's width as the pointer moved across the row, shifting every tab to its right —
                and would put it out of reach of the keyboard, since `group-hover` never fires for a focus.
                `focus-visible:opacity-100` brings it back for tab-key users.
              */
              className={`mr-1.5 rounded px-1 text-[11px] leading-none transition-opacity focus:outline-none focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-brand-accent ${
                isActive
                  ? "text-surface-muted opacity-100 hover:text-surface-text"
                  : "text-surface-muted opacity-0 group-hover/tab:opacity-100"
              }`}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
