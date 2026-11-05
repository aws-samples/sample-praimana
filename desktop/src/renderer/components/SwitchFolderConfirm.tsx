import { useEffect, useLayoutEffect, useRef } from "react";
import { basenameOf } from "../lib/file-tree-ops";

/**
 * ── ⚠ WHAT THE FOLDER PICKER DOES NOT SAY ─────────────────────────────────────────────────────
 *
 * ⚠ THIS IS NOT A SECURITY GATE, AND MUST NOT BE MISTAKEN FOR ONE. The native picker already IS the
 * consent step in this app's design — `recordUserChosenPath` (main/project-paths.ts) treats "a human
 * selected this in an OS dialog" as the provenance that lets `commitProjectPath` and `db:addProject`
 * widen the filesystem boundary, and nothing in the renderer can forge it. A renderer that skipped
 * this dialog would gain nothing it did not already have.
 *
 * What it adds is LEGIBILITY. "Choose a folder" is a question about navigation; it says nothing about
 * the three things that actually happen next, and two of them are irreversible-ish enough to be worth
 * a sentence:
 *
 *   1. the folder becomes writable by the editor, the Git actions and the assistant
 *   2. the folder currently open is closed, along with its open editors
 *   3. an assistant may START RUNNING in the new folder to install the project framework
 *
 * The third is the one nobody would predict from a folder picker, and it only recently became
 * reachable on a switch at all — see the ordering note in App.tsx's `performSwitch`.
 *
 * ⚠ NO "DON'T ASK AGAIN", DELIBERATELY. A consent notice that can be permanently dismissed is a
 * notice for the one person who read it and a no-op for everyone after them — and the cost here is
 * one keystroke on an action nobody performs in a loop. If it ever becomes a complaint, the honest
 * fix is to make switching cheaper, not to hide what it does.
 *
 * ⚠ NO FRAMEWORK IS NAMED. Which one installs is the facilitator's configuration and is not known
 * until `framework:check` answers, so the wording stays generic exactly as it does in main
 * (handlers/framework.ts). Naming AI-DLC here would be wrong for every experience that chose
 * something else.
 */
export function SwitchFolderConfirm({
  folderPath,
  currentProjectName,
  assistantName,
  onCancel,
  onConfirm,
}: {
  folderPath: string;
  /** Omitted on first run, when there is no folder to close. */
  currentProjectName?: string | null;
  assistantName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  /**
   * Focus lands on Cancel in the SAME commit that mounts the dialog — the rule the file tree's
   * trash confirmation already follows: the affirmative button must never be the default, and a
   * painted frame with focus still on the trigger behind the overlay sends a fast keyboard user's
   * next keystroke to the wrong control.
   */
  useLayoutEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
  }, []);

  /**
   * Focus returns on UNMOUNT rather than in either handler, so every way out — Cancel, Escape,
   * clicking the backdrop, confirming — funnels through one place that cannot be forgotten. The
   * `isConnected` guard matters because confirming re-renders the sidebar the trigger lives in.
   */
  useEffect(() => {
    return () => {
      const target = restoreTo.current;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  const folderName = basenameOf(folderPath) || folderPath;
  const titleId = "switch-folder-title";
  const bodyId = "switch-folder-consequences";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8"
      onClick={onCancel}
    >
      <div
        ref={boxRef}
        /**
         * `alertdialog` with `aria-modal`, and both are true statements here: Tab is trapped between
         * the two buttons below, so the rest of the app genuinely is unreachable until this closes.
         * `aria-describedby` points at the consequence list rather than the title, so a screen reader
         * speaks what will happen before focus settles on Cancel.
         */
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-md rounded-lg border border-surface-line bg-surface-bg p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
            return;
          }
          if (e.key !== "Tab") return;
          const focusables = Array.from(
            boxRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []
          );
          if (focusables.length === 0) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          const active = document.activeElement;
          if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id={titleId} className="text-sm font-medium text-surface-text">
          Open <span className="break-all font-mono">{folderName}</span> as your project?
        </h2>
        {/*
          The FULL path, not just the leaf. Two checkouts of one repo have the same folder name, and
          the path is the only thing that tells a participant which of them they just picked — the
          same reason the trash confirmation shows the name it is about rather than truncating it.
        */}
        <p className="mt-1 break-all font-mono text-[11px] leading-4 text-surface-muted">
          {folderPath}
        </p>

        <ul id={bodyId} className="mt-3 space-y-1.5 text-[11px] leading-4 text-surface-muted">
          <li>
            Everything inside becomes readable and writable — by the editor, by the Git actions, and
            by the assistant running in it.
          </li>
          {currentProjectName && (
            <li>
              <span className="break-all font-mono text-surface-text">{currentProjectName}</span>{" "}
              closes, along with any files you have open from it.
            </li>
          )}
          <li>
            {assistantName} may run setup in this folder to install the project framework, which can
            create and modify files.
          </li>
        </ul>

        {/* Cancel first and focused, affirmative button separated from it — the file tree's rule. */}
        <div className="mt-4 flex items-center gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded border border-surface-edge px-2.5 py-1 text-[11px] text-surface-text hover:bg-surface-raised focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-blue-300"
          >
            Cancel
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-brand-strong px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-brand-accent hover:text-surface-bg focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-blue-300"
          >
            Open folder
          </button>
        </div>
      </div>
    </div>
  );
}
