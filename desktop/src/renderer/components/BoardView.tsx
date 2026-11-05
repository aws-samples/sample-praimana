import { useState, useEffect } from "react";
import { TeamAccessNotice } from "./TeamAccessNotice";
import { PanePinSlot } from "./PanePinSlot";
import { PANE_HEADER, PANE_TITLE } from "../lib/pane-header";

const api = (window as any).electronAPI;

interface Member {
  userId: string;
  user: { id: string; name: string };
  role: string;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assigneeId?: string;
  assigneeName?: string;
}

/**
 * ONE class string for every text input and select on this screen.
 *
 * There were nine copies of the light-theme version, and re-theming them individually is how three of them
 * would have ended up slightly different. `text-surface-text` on the raised fill, never `muted` — muted
 * measures 4.06:1 there, under the 4.5:1 floor.
 */
const INPUT_CLASS =
  "w-full rounded-md border border-surface-line bg-surface-raised px-3 py-2 text-sm text-surface-text " +
  "outline-none placeholder:text-surface-muted focus:border-brand-accent";

const COLUMNS = ["BACKLOG", "TODO", "IN_PROGRESS", "REVIEW", "DONE"];
const COLUMN_LABELS: Record<string, string> = {
  BACKLOG: "Backlog",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  REVIEW: "Review",
  DONE: "Done",
};

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

export function BoardView() {
  const [tasks, setTasks] = useState<Task[]>([]);
  /**
   * Why this pane is empty, when it is. Main classifies the failure (see team-data.ts); the only
   * ones surfaced are the permanent, actionable ones — a transient blip must not raise a banner.
   */
  const [accessReason, setAccessReason] = useState<unknown>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newTask, setNewTask] = useState({ title: "", description: "", priority: "MEDIUM", assigneeId: "" });
  const [editingTask, setEditingTask] = useState<Task | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  // The board's requests run in the MAIN process (board:getBoard) so the bearer
  // never reaches the renderer. Main also handles the token renewal that used to
  // happen here explicitly — fetchAuthed refreshes on a 401 and retries once —
  // so there is no renderer-side renew step any more.
  async function loadData() {
    const res = await api.getBoard();
    // Recorded on EVERY load, so a recovery clears the banner as readily as a failure raises it.
    setAccessReason(res?.reason);

    if (res?.ok) {
      const membersList = res.members || [];
      setMembers(membersList);

      const nameMap = new Map(membersList.map((m: any) => [m.userId, m.user?.name || "Unknown"]));
      const enrichedTasks = (res.tasks || []).map((t: any) => ({
        ...t,
        assigneeName: t.assigneeId ? nameMap.get(t.assigneeId) || null : null,
      }));
      setTasks(enrichedTasks);
    }
    setLoading(false);
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTask.title.trim() || !newTask.assigneeId) return;

    const res = await api.createTask({
      title: newTask.title.trim(),
      description: newTask.description.trim() || null,
      priority: newTask.priority,
      assigneeId: newTask.assigneeId || null,
    });

    // Reset the form whenever the server answered at all, ok or not — the same
    // rule as before the fetch moved to main, where a non-ok status still reset
    // and only a thrown/timed-out request kept the form open. `status === null`
    // is main's signal for "no response".
    if (res?.status !== null) {
      setNewTask({ title: "", description: "", priority: "MEDIUM", assigneeId: "" });
      setShowAdd(false);
      await loadData();
    }
  }

  async function handleUpdateTask(task: Task) {
    if (!task.title.trim() || !task.assigneeId) return;

    const res = await api.updateTask({
      taskId: task.id,
      title: task.title,
      description: task.description || null,
      status: task.status,
      priority: task.priority,
      assigneeId: task.assigneeId || null,
    });

    // Same rule as handleAddTask: close the modal when the server answered,
    // keep it open when the request never got a response.
    if (res?.status !== null) {
      setEditingTask(null);
      await loadData();
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-bg text-sm text-surface-muted">
        Loading board...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-bg">
      {/* ⚠ THE `pr-9` RESERVATION IS GONE: the pin is no longer an overlay in this pane's corner, so there
          is nothing to keep off the button at this row's right edge. It renders beside the heading, and the
          bar's height comes from `PANE_HEADER` so it lines up with whatever pane is pinned next to it. */}
      <div className={`${PANE_HEADER} justify-between`}>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className={PANE_TITLE}>Board</h2>
          <PanePinSlot />
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded-md bg-brand-strong px-3 py-1.5 text-sm text-white transition-colors hover:bg-brand-accent hover:text-surface-bg"
        >
          + Add Task
        </button>
      </div>

      <TeamAccessNotice reason={accessReason} />

      {showAdd && (
        <form onSubmit={handleAddTask} className="mx-4 mb-3 flex-shrink-0 space-y-3 rounded-lg border border-surface-line bg-surface-panel p-4">
          <div>
            <input
              type="text"
              value={newTask.title}
              onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
              placeholder="Task summary..."
              className={INPUT_CLASS}
              autoFocus
            />
          </div>
          <div>
            <textarea
              value={newTask.description}
              onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
              placeholder="Description (optional)"
              className={`${INPUT_CLASS} min-h-[50px]`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select
              value={newTask.priority}
              onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
              className={INPUT_CLASS}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>
              ))}
            </select>
            <select
              value={newTask.assigneeId}
              onChange={(e) => setNewTask({ ...newTask, assigneeId: e.target.value })}
              required
              className={INPUT_CLASS}
            >
              <option value="" disabled>Select assignee...</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.user?.name || m.userId}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!newTask.title.trim() || !newTask.assigneeId}
              className="rounded-md bg-brand-strong px-4 py-2 text-sm text-white transition-colors hover:bg-brand-accent hover:text-surface-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create Task
            </button>
            <button
              type="button"
              onClick={() => setShowAdd(false)}
              className="rounded-md border border-surface-line px-4 py-2 text-sm text-surface-text hover:bg-surface-raised"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto overflow-y-auto px-4 pb-4" style={{ flex: "1 1 0", minHeight: 0 }}>
        <div className="flex gap-4 min-w-max">
          {COLUMNS.map((col) => {
            const columnTasks = tasks.filter((t) => t.status === col);
            return (
              <div key={col} className="w-64 flex-shrink-0 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-surface-text">
                    {COLUMN_LABELS[col]}
                  </h3>
                  <span className="text-xs text-surface-muted">{columnTasks.length}</span>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto">
                  {columnTasks.map((task) => (
                    <div
                      key={task.id}
                      // `hover:border-surface-muted` replaces the light theme's shadow lift: a box-shadow is
                      // nearly invisible on a dark ground, so the affordance moves to the border.
                      className="relative rounded-lg border border-surface-line bg-surface-panel p-3 transition-colors hover:border-surface-muted"
                    >
                      <button
                        onClick={() => setEditingTask({ ...task })}
                        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-xs text-surface-muted hover:bg-surface-raised hover:text-brand-accent"
                        title="Edit task"
                      >
                        ✎
                      </button>
                      <p className="pr-6 text-sm font-medium text-surface-text">{task.title}</p>
                      {task.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-surface-muted">
                          {task.description}
                        </p>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        {/* The priority WORD is printed inside, so the colour is a reinforcement and never
                            the only carrier — which is what lets these use hue at all. `error-text` (5.98:1 on
                            this panel) and `warning` (8.48:1), not the light theme's `red-700`/`yellow-700`,
                            which measure 2.5:1 and 3.1:1 here. */}
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          task.priority === "HIGH" || task.priority === "URGENT"
                            ? "bg-surface-raised text-tool-error-text"
                            : task.priority === "MEDIUM"
                              ? "bg-surface-raised text-tool-warning"
                              : "bg-surface-raised text-surface-text"
                        }`}>
                          {task.priority.toLowerCase()}
                        </span>
                        {task.assigneeName ? (
                          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-xs text-surface-text">
                            {task.assigneeName}
                          </span>
                        ) : (
                          <span className="text-xs italic text-surface-faint">unassigned</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {columnTasks.length === 0 && (
                    <div className="rounded-lg border border-dashed border-surface-line p-4 text-center text-xs text-surface-muted">
                      No tasks
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit Task Modal */}
      {editingTask && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="w-full max-w-sm rounded-lg border border-surface-line bg-surface-bg p-5 shadow-xl">
            <h3 className="mb-4 font-semibold text-surface-text">Edit Task</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-surface-muted">Title</label>
                <input
                  type="text"
                  value={editingTask.title}
                  onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-surface-muted">Description</label>
                <textarea
                  value={editingTask.description || ""}
                  onChange={(e) => setEditingTask({ ...editingTask, description: e.target.value })}
                  className={`${INPUT_CLASS} min-h-[60px]`}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-surface-muted">Status</label>
                  <select
                    value={editingTask.status}
                    onChange={(e) => setEditingTask({ ...editingTask, status: e.target.value })}
                    className={INPUT_CLASS}
                  >
                    {COLUMNS.map((s) => (
                      <option key={s} value={s}>{COLUMN_LABELS[s]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-surface-muted">Priority</label>
                  <select
                    value={editingTask.priority}
                    onChange={(e) => setEditingTask({ ...editingTask, priority: e.target.value })}
                    className={INPUT_CLASS}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-surface-muted">Assignee</label>
                <select
                  value={editingTask.assigneeId || ""}
                  onChange={(e) => setEditingTask({ ...editingTask, assigneeId: e.target.value || undefined })}
                  required
                  className={INPUT_CLASS}
                >
                  <option value="" disabled>Select assignee...</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.user?.name || m.userId}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setEditingTask(null)}
                className="flex-1 rounded-md border border-surface-line px-3 py-2 text-sm text-surface-text hover:bg-surface-raised"
              >
                Cancel
              </button>
              <button
                onClick={() => handleUpdateTask(editingTask)}
                disabled={!editingTask.title.trim() || !editingTask.assigneeId}
                className="flex-1 rounded-md bg-brand-strong px-3 py-2 text-sm text-white transition-colors hover:bg-brand-accent hover:text-surface-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
