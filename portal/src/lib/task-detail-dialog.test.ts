import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE BOARD'S TASK DETAIL DIALOG, opened by clicking a card, because the cards clamp their
 * description to two lines and carry no creator, no timestamps and no full assignee name.
 *
 * ⚠ THE SAME LIMITATION AS confirm-dialog-focus.test.ts, and for the same reason: this package sets
 * `environment: "node"` and has no jsdom, happy-dom or @testing-library anywhere in its tree. So
 * nothing here observes a real click, a real focus move or a real Escape keypress.
 *
 * NOT verified here, and each needs a browser:
 *   · that clicking a card actually opens the dialog;
 *   · that Tab is genuinely trapped inside the panel;
 *   · that focus returns to the card, or falls back when the card was replaced by a refetch;
 *   · that a screen reader announces the title and body from the aria wiring.
 *
 * WHAT IS verified is the part that is decidable from the source and would break silently: that the
 * card is a real button rather than a clickable div, that the dialog is keyed on an ID rather than a
 * captured object, that the three assignee states stay distinct, and that the timestamps come from
 * the hydration-safe formatter. Those are the decisions; the DOM behaviour follows the contract
 * ConfirmActionDialog already established and this component deliberately mirrors.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const DIALOG = readCode("../components/TaskDetailDialog.tsx");
const BOARD = readCode("../app/w/[workshopId]/t/[teamId]/board/page.tsx");

describe("the card is a real control, not a clickable div", () => {
  it("renders each task as a <button> that opens the dialog", () => {
    /**
     * A div with an onClick is unreachable by Tab, does not activate on Enter or Space, and
     * announces itself as nothing. The card IS the control now, so it has to be a button, this is
     * the regression that would make the board keyboard-inoperable while looking fine.
     */
    expect(BOARD).toContain("onClick={() => setSelectedTaskId(task.id)}");
    const openerIndex = BOARD.indexOf("onClick={() => setSelectedTaskId(task.id)}");
    const buttonBefore = BOARD.lastIndexOf("<button", openerIndex);
    const divBefore = BOARD.lastIndexOf("<div", openerIndex);
    expect(buttonBefore, "the click handler must sit on a <button>").toBeGreaterThan(divBefore);
  });

  it("declares that it opens a dialog", () => {
    // Without this a screen-reader operator has no warning that activating the card moves them into
    // a modal rather than navigating.
    expect(BOARD).toContain('aria-haspopup="dialog"');
  });

  it("carries a visible focus ring", () => {
    // A button reachable by Tab with no focus style is reachable and invisible.
    expect(BOARD).toMatch(/focus:ring-2 focus:ring-brand/);
  });

  it("shows the assignee's NAME in the avatar tooltip, never the raw sub", () => {
    /**
     * It used to be `title={task.assigneeId}`, a Cognito sub, which tells a reader nothing and is
     * an internal identifier that should not be on screen at all.
     */
    expect(BOARD).not.toContain("title={task.assigneeId}");
    expect(BOARD).toContain('title={task.assigneeName ?? "Unknown"}');
  });
});

describe("the open dialog tracks the board, rather than a snapshot of it", () => {
  it("stores the selected task's ID, not the task object", () => {
    /**
     * ⚠ THE STALENESS BUG THIS AVOIDS. The board's query refetches, Analyze Chat invalidates it,
     * and react-query refetches on mount and on window focus, so a dialog holding a captured object
     * would keep displaying the old title, status and assignee while the card behind it had already
     * changed. Looking the task up by id on every render means the panel shows what the board shows.
     */
    expect(BOARD).toContain("useState<string | null>(null)");
    // ⚠ `(t: any)` BECAME `(t)` when `task.list`'s response gained a declared type, the parameter
    // is inferred now. The assertion is unchanged in substance: it still requires the lookup to go
    // through `tasks?.find(... t.id === selectedTaskId)` on every render, which is the property that
    // prevents the stale snapshot described above.
    expect(BOARD).toContain("tasks?.find((t) => t.id === selectedTaskId)");
  });

  it("closes rather than showing a task that has disappeared", () => {
    // If the lookup yields nothing after a refetch, `selectedTask` is null and the dialog unmounts -
    // instead of displaying a task that no longer exists.
    expect(BOARD).toContain("{selectedTask && (");
  });

  it("MOUNTS ONLY WHILE OPEN, the same contract as ConfirmActionDialog", () => {
    // No `open` prop: an unmounted dialog is unambiguously neither focusable nor clickable, which is
    // the property that matters for a modal.
    expect(DIALOG).not.toMatch(/\bopen\??:\s*boolean/);
  });
});

describe("modal keyboard contract, mirrored from ConfirmActionDialog", () => {
  it("traps Tab in both directions", () => {
    // aria-modal tells a screen reader the rest of the page is inert; it does NOT stop Tab, so
    // without this an operator walks out of a dialog that is still on screen.
    expect(DIALOG).toContain("event.shiftKey");
    expect(DIALOG).toContain("event.preventDefault()");
    expect(DIALOG).toMatch(/last\.focus\(\)/);
    expect(DIALOG).toMatch(/first\.focus\(\)/);
  });

  it("recomputes the focusable set from the DOM rather than assuming it", () => {
    // Same reason as the confirm dialog: the set is read on each keypress, so it cannot go stale.
    expect(DIALOG).toContain("root.querySelectorAll<HTMLElement>(FOCUSABLE)");
  });

  it("stops Escape from reaching the page behind", () => {
    // Otherwise one keypress closes this dialog AND something underneath it, leaving the operator
    // somewhere they did not navigate to.
    const escIndex = DIALOG.indexOf('event.key === "Escape"');
    expect(escIndex).toBeGreaterThan(-1);
    expect(DIALOG.slice(escIndex, escIndex + 200)).toContain("event.stopPropagation()");
  });

  it("focuses the PANEL on open, not a button", () => {
    // A focused container announces its own name and description, the task's title and details -
    // and leaves nothing pre-armed.
    expect(DIALOG).toContain("panelRef.current?.focus()");
    expect(DIALOG).toContain('tabIndex={-1}');
  });

  it("has a focus backstop on the board for when the card is gone", () => {
    // `.focus()` on a detached element is a no-op, so without a fallback a keyboard operator lands
    // on <body> and tabs from the top of the document.
    expect(DIALOG).toContain('[data-board-scroll]');
    expect(BOARD).toContain("data-board-scroll");
  });

  it("dismisses on a backdrop click, guarded against inner clicks bubbling", () => {
    expect(DIALOG).toContain("if (event.target === event.currentTarget) onDismiss()");
  });

  it("is announced as a modal dialog with a name and a description", () => {
    expect(DIALOG).toContain('role="dialog"');
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DIALOG).toContain("aria-labelledby={headingId}");
    expect(DIALOG).toContain("aria-describedby={bodyId}");
  });
});

describe("what the panel says about a task", () => {
  it("keeps THREE assignee states distinct", () => {
    /**
     * "Unassigned" is a fact about the task; "Unknown" means there IS an assignee whose name did not
     * resolve. Collapsing them would tell a reader nobody owns a card that somebody does, the same
     * distinction the service's enrichment makes by omitting the field entirely.
     */
    expect(DIALOG).toContain("Unassigned");
    expect(DIALOG).toContain('task.assigneeName ?? "Unknown"');
    expect(DIALOG).toContain("task.assigneeId ? (");
  });

  it("shows who created the task, by name", () => {
    expect(DIALOG).toContain("Created by");
    expect(DIALOG).toContain("task.creatorName");
  });

  it("preserves line breaks in the description", () => {
    // An AI-written description carries its own line breaks; collapsing them turns a list of steps
    // into a paragraph. The card clamps to two lines, which is why this panel exists at all.
    expect(DIALOG).toContain("whitespace-pre-wrap");
    expect(DIALOG).not.toContain("line-clamp");
  });

  it("labels the AI badge in words, not with a bare emoji", () => {
    // The card shows a lone 🤖 with a `title`, which a screen reader may not announce. There is room
    // here to say it.
    expect(DIALOG).toContain("AI-generated");
  });

  it("uses the HYDRATION-SAFE formatter for both timestamps", () => {
    /**
     * This renders inside a client component that Next.js also prerenders, so a locale-formatted
     * instant differs between the server and the browser, the mismatch format-datetime.ts exists to
     * close. `toLocaleString` here would reintroduce it.
     */
    expect(DIALOG).toContain("formatInstantUtc(task.createdAt)");
    expect(DIALOG).toContain("formatInstantUtc(task.updatedAt)");
    expect(DIALOG).not.toContain("toLocaleString");
    expect(DIALOG).not.toContain("toLocaleDateString");
  });

  it("hides 'last changed' when nothing has changed", () => {
    /**
     * A task written and never touched has `createdAt === updatedAt`, and printing one instant under
     * two labels invites the reader to hunt for a difference that is not there, the same failure as
     * the insights header's clock, which implied an event at a moment when none occurred.
     */
    expect(DIALOG).toContain("task.updatedAt !== task.createdAt");
    expect(DIALOG).toContain("{wasChanged && (");
  });

  it("degrades a missing timestamp to words, not to 'Invalid Date'", () => {
    expect(DIALOG).toContain('|| "at an unknown time"');
  });

  it("says where editing happens instead of offering a control that is not there", () => {
    // Editing lives in the desktop app, which has the full form. A reader who opened this to change
    // something needs the answer rather than a dead end.
    expect(DIALOG).toContain("Edit this task in the desktop app.");
  });
});
