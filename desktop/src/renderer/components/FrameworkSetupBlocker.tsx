import { useEffect, useRef } from "react";

/**
 * ── ⚠ THE ONE MODAL IN THIS APP WITH NO WAY OUT, AND WHY THAT IS CORRECT HERE ─────────────────
 *
 * The folder has ALREADY been switched by the time this appears — the sidebar, the tree and the tabs
 * are all pointing at the new project. What is still running is `framework:install`, which copies a
 * distribution into that folder and then runs an assistant turn in it (handlers/framework.ts). So for
 * a minute or two the participant is looking at a project whose files are being created underneath
 * them by an agent they did not start.
 *
 * Two things go wrong without a block, and neither is cosmetic:
 *
 *   1. THEY START WORKING IN IT. Opening a file that the setup agent is about to overwrite, or sending
 *      the assistant a message while a second CLI process is mid-turn in the same folder, is a race
 *      between two agents over one working tree.
 *   2. THEY SWITCH AGAIN. `performSwitch` would kill the CLI and re-point the folder while the install
 *      is still writing into the previous one — leaving a half-installed framework nobody will look at.
 *
 * ── ⚠ NO ESCAPE, NO BACKDROP DISMISS, NO CANCEL BUTTON — AND IT IS STILL BOUNDED ──
 *
 * Every dialog in this app can be dismissed; this one deliberately cannot, so the reason it can never
 * strand anybody has to be stated rather than assumed. The work it waits on is bounded IN MAIN, at
 * every step: `curl` at 120s, `tar` at 60s, and the agent at 120s, after which
 * `runCliAgent`'s timer kills the process and RESOLVES (framework.ts). The install therefore always
 * settles, and the caller clears this overlay in a `finally` — so a hung agent closes it too.
 *
 * ⚠ AND IT SHOWS THE STEP, which is what separates "blocked" from "frozen". `framework:progress`
 * streams a line per phase (download, extract, install, and the agent's own output), and it is
 * announced through `aria-live` as well as rendered — a modal with no controls and no changing text is
 * indistinguishable from a hang, and that is when people force-quit an app mid-write.
 */
export function FrameworkSetupBlocker({
  frameworkName,
  step,
}: {
  /** The facilitator's framework — never named in this file. See handlers/framework.ts. */
  frameworkName: string;
  /** The latest `framework:progress` line, or empty before the first one arrives. */
  step: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  /**
   * Focus moves INTO the dialog, because blocking the pointer is only half of blocking. Without this,
   * Tab still walks the app behind the overlay and Enter activates whatever it lands on — the composer
   * included, which is precisely the "two agents in one working tree" case this exists to prevent.
   *
   * There are no focusable controls inside, so the keydown handler below simply refuses Tab rather
   * than cycling between them.
   */
  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-8">
      <div
        ref={boxRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-busy="true"
        aria-labelledby="framework-setup-title"
        aria-describedby="framework-setup-step"
        onKeyDown={(e) => {
          /**
           * ⚠ TAB IS SWALLOWED, ESCAPE IS NOT HANDLED AT ALL. Both are the same decision: there is
           * nothing to move to and nothing to cancel. Escape is left unbound rather than bound to a
           * no-op so that a future editor sees an absence to justify, not a handler to "fix".
           */
          if (e.key === "Tab") e.preventDefault();
        }}
        className="w-full max-w-md rounded-lg border border-surface-line bg-surface-bg p-4 shadow-xl outline-none"
      >
        <h2
          id="framework-setup-title"
          className="flex items-center gap-2 text-sm font-medium text-surface-text"
        >
          {/*
            A CSS spin rather than an animated glyph: `animate-spin` is already in use elsewhere in the
            app, and a text spinner built from frames would need a timer this component has no other
            reason to own.
          */}
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 flex-shrink-0 animate-spin rounded-full border-2 border-surface-edge border-t-brand-accent"
          />
          Setting up {frameworkName}…
        </h2>

        <p className="mt-2 text-[11px] leading-4 text-surface-muted">
          Your folder is open and ready. An assistant is finishing the setup inside it, so this will
          stay until it is done — starting work now would collide with it.
        </p>

        {/*
          ⚠ `aria-live="polite"` AND `role="status"`, because the step is the only thing that changes.
          Rendering it silently would leave a screen-reader user with one announcement — the title —
          for up to five minutes of work, which is the same as no feedback.
        */}
        <p
          id="framework-setup-step"
          role="status"
          aria-live="polite"
          className="mt-3 min-h-[1rem] break-words font-mono text-[11px] leading-4 text-surface-text"
        >
          {step || "Starting…"}
        </p>
      </div>
    </div>
  );
}
