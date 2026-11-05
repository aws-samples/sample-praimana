"use client";

import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatInstantUtc } from "@/lib/format-datetime";

/**
 * ONE TASK, READ IN FULL, opened by clicking a card on the board.
 *
 * ── WHY A DIALOG AND NOT AN EXPANDING CARD ──
 *
 * The cards clamp their description to two lines (`line-clamp-2`), so on a board of any size the
 * detail simply is not readable: an AI-generated task's description is several sentences, and the
 * creator, the timestamps and the full assignee name were not on the card at all. Growing the card
 * in place would reflow every column beside it, on a horizontally-scrolling Kanban that moves the
 * cards a pointer is travelling towards.
 *
 * ── READ-ONLY, DELIBERATELY ──
 *
 * This shows a task; it does not edit one. Editing lives in the desktop app, which has the full
 * form (status, priority, assignee) and is where the team works. A half-edit surface in the portal
 * would be a second place for the same rules to drift, and the portal's board has no create form
 * either, so an edit dialog here would be the only mutation on the screen.
 *
 * The accessibility contract is deliberately the SAME as ConfirmActionDialog's, because the
 * failures it documents are properties of modals rather than of confirmations: Tab escaping a
 * dialog that is still on screen, Escape reaching a handler on the page behind, and focus dropping
 * to <body> when the dialog unmounts. What is NOT copied is everything specific to a destructive
 * action, no tone, no reversibility line, no disabled-while-pending dance, because nothing here
 * can be got wrong by pressing Enter.
 *
 * MOUNTING IS OPENING, as with the confirm dialog: the caller renders this only while it should be
 * on screen, so an unmounted dialog is unambiguously neither focusable nor clickable.
 */

/** Everything inside the dialog that can hold focus, for the Tab wrap. */
const FOCUSABLE = 'button:not([disabled]), [href]';

/** The subset of a task this panel reads. Mirrors what `task.list` returns. */
export interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId?: string;
  assigneeName?: string;
  creatorName?: string;
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Human labels for the stored status values, matching the board's column headings. */
const STATUS_LABELS: Record<string, string> = {
  BACKLOG: "Backlog",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  REVIEW: "Review",
  DONE: "Done",
};

export function TaskDetailDialog({
  task,
  onDismiss,
}: {
  task: TaskDetail;
  onDismiss: () => void;
}) {
  const headingId = useId();
  const bodyId = useId();

  const panelRef = useRef<HTMLDivElement>(null);
  /** The card that opened this, so focus can be given back to it. */
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    // The PANEL takes focus rather than the close button, so a screen reader announces the task's
    // title and details before landing on a control, the same reasoning as the confirm dialog,
    // where focusing a button would read out half the choice first.
    panelRef.current?.focus();

    return () => {
      /**
       * PUT FOCUS BACK ON THE CARD, if it is still there.
       *
       * Simpler than ConfirmActionDialog's cleanup, and legitimately so: that one has to survive
       * the row it was opened from being DELETED by the action it confirms, hence the focusout
       * rescue. Nothing here mutates anything, so the card that opened this dialog is still
       * mounted, the only real case is a background refetch having replaced it, and `isConnected`
       * catches that. Falling through to nothing would strand a keyboard operator on <body>, so
       * the board's scroll container is the backstop.
       */
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
        if (document.activeElement === opener) return;
      }
      document.querySelector<HTMLElement>("[data-board-scroll]")?.focus();
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      // Stopped here so Escape cannot also reach a listener on the page behind and close something
      // the operator did not open.
      event.stopPropagation();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;

    // The trap. `aria-modal` tells a screen reader the rest of the page is inert; it does NOT stop
    // Tab, so without this a keyboard operator walks out of a dialog that is still on screen.
    const root = panelRef.current;
    if (!root) return;
    const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * "Created" and "last changed" are shown as separate rows, and only when they DIFFER.
   *
   * A task written and never touched again has `createdAt === updatedAt`, and printing the same
   * instant twice under two different labels invites the reader to look for a difference that is
   * not there, the same failure as the insights header's clock, which said something happened at
   * a moment when nothing had.
   */
  const wasChanged = task.updatedAt !== task.createdAt;

  return (
    <div
      onClick={(event) => {
        // A backdrop click dismisses. Guarded on the target so a click inside the panel cannot
        // bubble out and close it.
        if (event.target === event.currentTarget) onDismiss();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--scrim)/0.5)] p-4"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        // max-h + overflow so a long AI-written description stays scrollable at 200% zoom with the
        // close button still reachable, rather than pushing it off-screen.
        className="w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto rounded-lg bg-surface-3 p-6 shadow-xl focus:outline-none focus:ring-2 focus:ring-brand"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="text-base font-semibold text-ink break-words">
            {task.title}
          </h2>
          {task.aiGenerated && (
            // Not icon-only: the card shows a bare 🤖 with a `title`, which a screen reader may or
            // may not announce and a colour-blind or zoomed-in reader may miss entirely. In the
            // detail view there is room to say it.
            <span className="flex-shrink-0 rounded-full border border-brand-border bg-brand-subtle px-2 py-0.5 text-xs font-medium text-brand-text">
              ✨ AI-generated
            </span>
          )}
        </div>

        <div id={bodyId} className="mt-4 space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              Description
            </h3>
            {task.description ? (
              // whitespace-pre-wrap: an AI-written description carries its own line breaks, and
              // collapsing them turns a list of steps into a paragraph.
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                {task.description}
              </p>
            ) : (
              <p className="mt-1 text-sm italic text-ink-tertiary">No description.</p>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-4 border-t pt-4 text-sm">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Status
              </dt>
              <dd className="mt-0.5 text-ink-muted">
                {STATUS_LABELS[task.status] ?? task.status}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Priority
              </dt>
              <dd className="mt-0.5 text-ink-muted">{task.priority}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Assignee
              </dt>
              {/* THREE STATES, not two. "Unassigned" is a fact about the task; "Unknown" means
                  there IS an assignee whose name did not resolve. Collapsing them would tell a
                  reader nobody owns a card that somebody does. */}
              <dd className="mt-0.5 text-ink-muted">
                {task.assigneeId ? (
                  task.assigneeName ?? "Unknown"
                ) : (
                  <span className="italic text-ink-tertiary">Unassigned</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Created by
              </dt>
              <dd className="mt-0.5 text-ink-muted">
                {task.creatorName ?? <span className="italic text-ink-tertiary">Unknown</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                Created
              </dt>
              {/* formatInstantUtc, not toLocaleString: this renders inside a client component that
                  Next.js also prerenders, and a locale-formatted instant differs between the two
                  runtimes, the hydration trap that module exists to close. */}
              <dd className="mt-0.5 tabular-nums text-ink-muted">
                <time dateTime={task.createdAt}>
                  {formatInstantUtc(task.createdAt) || "at an unknown time"}
                </time>
              </dd>
            </div>
            {wasChanged && (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                  Last changed
                </dt>
                <dd className="mt-0.5 tabular-nums text-ink-muted">
                  <time dateTime={task.updatedAt}>
                    {formatInstantUtc(task.updatedAt) || "at an unknown time"}
                  </time>
                </dd>
              </div>
            )}
          </dl>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4">
          {/* Says where editing IS, rather than offering a control that does not exist here. A
              reader who opened this to change something needs the answer, not a dead end. */}
          <p className="text-xs text-ink-subtle">Edit this task in the desktop app.</p>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
