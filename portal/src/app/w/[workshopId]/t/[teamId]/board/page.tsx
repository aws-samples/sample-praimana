"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { teamContentGate } from "@/lib/team-content-gate";
import { teamTabHref } from "@/lib/team-routes";
import {
  ContentLoadError,
  MemberOnlyNotice,
  SessionExpiredNotice,
} from "@/components/TeamContentNotice";
import { TaskDetailDialog } from "@/components/TaskDetailDialog";

type TaskStatus = "BACKLOG" | "TODO" | "IN_PROGRESS" | "REVIEW" | "DONE";
type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

/**
 * ── ⚠ THE FIVE COLUMNS NO LONGER CARRY FIVE DIFFERENT BACKGROUNDS ────────────────────────────
 *
 * They were grey, blue, amber, violet and green, one tint per stage. Three problems with that,
 * and none of them is a matter of taste:
 *
 *   1. THE COLOUR SAID NOTHING THE POSITION DOES NOT. A kanban board's meaning IS its left-to-right
 *      order; a reader learns "further right is further done" instantly and does not need a hue to
 *      repeat it. Five tints is a key to memorise for information already on screen.
 *   2. IT SPENT THE SEMANTIC PALETTE ON DECORATION. `bg-warn-bg` on "In Progress" and
 *      `bg-danger-bg`-adjacent hues elsewhere mean "caution" and "error" everywhere else in the
 *      product. A task being in progress is neither. Once every column is tinted, a card that
 *      genuinely IS urgent has nothing left to stand out against, which is exactly what the
 *      priority pill below needs.
 *   3. FIVE FULL-HEIGHT COLOUR BLOCKS DOMINATED THE SCREEN, so the cards, the actual content -
 *      read as less important than their containers.
 *
 * One neutral surface for every column, with a hairline. The stage is carried by the heading and by
 * the position, and the only colour left on the board belongs to the priority pills and whatever a
 * card itself needs.
 */
const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "BACKLOG", label: "Backlog" },
  { status: "TODO", label: "To Do" },
  { status: "IN_PROGRESS", label: "In Progress" },
  { status: "REVIEW", label: "Review" },
  { status: "DONE", label: "Done" },
];

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  LOW: "bg-surface-2 text-ink-subtle",
  MEDIUM: "bg-notice-bg text-notice-text",
  HIGH: "bg-series-6/15 text-series-6",
  URGENT: "bg-danger-bg text-danger-text",
};

export default function BoardPage() {
  const params = useParams();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;

  const tasksQuery = trpc.task.list.useQuery({ teamId });
  const tasks = tasksQuery.data;

  /**
   * WHICH TASK'S DETAIL PANEL IS OPEN, stored as an ID, not as the task object.
   *
   * Holding the object would freeze a snapshot: the board's query refetches (react-query refetches
   * on mount and on window focus by default), so a dialog holding a copy would keep showing the old
   * title and status while the card behind it had already changed. Looking the task up from `tasks`
   * on every render means the panel shows what the board shows.
   *
   * It also gives the disappearance case an honest answer: if the task is gone after a refetch, the
   * lookup yields nothing and the dialog closes, rather than displaying a task that no longer
   * exists.
   */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const found =
    (selectedTaskId && tasks?.find((t) => t.id === selectedTaskId)) || null;
  /**
   * `description` is NORMALISED, not asserted. `TaskDetail` requires the key (nullable), while a
   * task off the wire may simply omit it, the collaboration service declares it required, but
   * this is the layer that must not fall over if a row predates that. One `?? null` here is the
   * whole adaptation, and it exists because typing the response made the mismatch visible.
   */
  const selectedTask = found ? { ...found, description: found.description ?? null } : null;

  /**
   * NOTHING TO SHOW, AND WHY. The board is member-only, so `task.list` answers
   * 403 to a facilitator, judge or admin who is not on this team.
   *
   * Returned BEFORE the board renders rather than layered over it: a Kanban frame with five
   * empty columns behind an explanation reads as a team that has written no tasks, which is
   * a different and more alarming fact than "you cannot see this team's tasks". The columns
   * carry no information without their contents.
   */
  // Held until the query has answered, which this page did not do before: with no loading
  // branch, `tasks` is undefined on the first paint and the board renders five empty columns
  //, so a non-member saw "this team has written no tasks" for a beat before the notice
  // replaced it. A wrong answer shown briefly is still a wrong answer, and it is the one an
  // operator glancing at a colleague's screen takes away. Same idiom as the phases page.
  if (tasksQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-ink-tertiary">Loading board...</div>
      </div>
    );
  }

  const gate = teamContentGate([tasksQuery]);
  // SESSION EXPIRED outranks both branches below: a 401 means the server could not
  // evaluate any rule, so "member-only" would be a lie and "failed" blames the data.
  // Providers() is already signing out; this is what renders during that round trip.
  if (gate.state === "expired") {
    return <SessionExpiredNotice what="this team's board" />;
  }
  if (gate.state === "member-only") {
    return (
      <MemberOnlyNotice
        what="This team's board is visible to its members."
        teamHref={teamTabHref(workshopId, teamId)}
      />
    );
  }
  if (gate.state === "failed") {
    return (
      <ContentLoadError
        what="this team's board"
        detail={gate.detail}
        onRetry={gate.retry}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/**
       * NO BOARD HEADER ANY MORE. It existed solely to hold the "🤖 Analyze Chat" button and that
       * button's result banner, and the button had never worked: it POSTed to
       * `/v1/teams/:teamId/tasks/analyze-chat`, a path no service implements, so every press showed
       * "Error: Backend error: 404". See the note where `analyzeChat` was removed from the task
       * router for how the gateway made it a 404 rather than an honest 501.
       *
       * Removed rather than fixed, deliberately: implementing it means a real Bedrock
       * route with its own cooldown and its own gateway mapping. An empty bordered strip left behind
       * would be a header with nothing in it.
       */}

      {/* Kanban board.
          data-board-scroll + tabIndex: the focus backstop TaskDetailDialog falls back to if the
          card that opened it has been replaced by a refetch. Without a focusable element here a
          keyboard operator would land on <body> and Tab from the top of the document. */}
      <div
        data-board-scroll
        tabIndex={-1}
        className="flex-1 overflow-x-auto p-4 focus:outline-none"
      >
        <div className="flex gap-3 h-full min-w-max">
          {COLUMNS.map((col) => {
            const columnTasks =
              tasks?.filter((t) => t.status === col.status) ?? [];

            return (
              <div
                key={col.status}
                className="flex w-72 flex-col rounded-xl border border-hairline bg-surface-1 p-3"
              >
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-ink-muted">
                    {col.label}
                    {/* `tabular-nums` so the counts do not jitter the headings as cards move
                        between columns. */}
                    <span className="ml-1.5 text-xs text-ink-tertiary tabular-nums">
                      {columnTasks.length}
                    </span>
                  </h3>
                </div>

                <div className="flex-1 space-y-2 overflow-y-auto">
                  {/* ⚠ AN EMPTY COLUMN NOW SAYS SO. All five rendered as tall blank blocks when
                      they held nothing, which reads as "still loading" rather than "nothing here".
                      One quiet line per column, and it is `aria-hidden` because the heading already
                      announces the count. */}
                  {columnTasks.length === 0 && (
                    <p
                      aria-hidden="true"
                      className="px-1 py-6 text-center text-xs text-ink-tertiary"
                    >
                      Nothing here yet
                    </p>
                  )}
                  {columnTasks.map((task) => (
                    /**
                     * A REAL <button>, not a div with an onClick.
                     *
                     * The card is now the control that opens the detail dialog, so it has to be
                     * reachable by Tab, activate on Enter and Space, and announce itself as a
                     * button, none of which a clickable div does. `text-left` because a button's
                     * default centring would re-align every card's text.
                     */
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      aria-haspopup="dialog"
                      className="w-full text-left bg-surface-3 rounded-md border p-3 shadow-sm transition-colors hover:border-brand-border hover:bg-brand-wash/30 focus:outline-none focus:ring-2 focus:ring-brand"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{task.title}</p>
                        {task.aiGenerated && (
                          <span className="text-xs flex-shrink-0" title="AI generated">🤖</span>
                        )}
                      </div>
                      {task.description && (
                        <p className="text-xs text-ink-subtle mt-1 line-clamp-2">
                          {task.description}
                        </p>
                      )}
                      <div className="mt-2 flex items-center justify-between">
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded ${PRIORITY_COLORS[task.priority as TaskPriority] || ""}`}
                        >
                          {task.priority}
                        </span>
                        {task.assigneeId && (
                          /* title is the resolved NAME now, not the raw Cognito sub, a tooltip
                             showing a uuid told the reader nothing, and the sub is an identifier
                             that has no business being on screen. */
                          <div
                            className="w-5 h-5 rounded-full bg-brand-subtle flex items-center justify-center text-[10px] font-medium text-brand-text"
                            title={task.assigneeName ?? "Unknown"}
                          >
                            {task.assigneeName?.[0] || "?"}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* MOUNTED ONLY WHILE OPEN, the same contract as ConfirmActionDialog: an unmounted dialog is
          unambiguously neither focusable nor clickable. `selectedTask` is null both when nothing is
          selected and when the selected task has vanished from a refetch, so the second case closes
          the panel instead of showing a stale task. */}
      {selectedTask && (
        <TaskDetailDialog
          task={selectedTask}
          onDismiss={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
