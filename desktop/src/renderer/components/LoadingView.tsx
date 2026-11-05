import logo from "../assets/logo.png";
import { BrandName } from "./BrandName";

/**
 * ── ⚠ THE SCREEN THAT COVERS THE LAUNCH ───────────────────────────────────────────────────────
 *
 * ⚠ IT REPLACED A DELIBERATELY BLANK DIV, AND THE REASONING FOR THAT DIV IS WORTH RECORDING BECAUSE IT
 * WAS RIGHT WHEN IT WAS WRITTEN. `App` used to gate first paint on ONE local IPC round-trip, and a
 * spinner that appears and vanishes inside a frame is flicker rather than feedback — so blank was
 * correct. What changed is the wait: the gate now covers the projects read and the team-access probe as
 * well, and that probe is a network call (bounded at 4s by `READ_TIMEOUT_MS`). Seconds of blank window
 * reads as a hung app, which is the one thing worse than a flash of the wrong screen.
 *
 * ⚠ NO PROGRESS TEXT, AND NO PERCENTAGE. Nothing here knows how far through it is, and the honest
 * options are "say nothing" or invent a number. A named step ("Loading projects…") would also flicker
 * through three states in under a second on a warm launch, which is worse than one steady frame.
 *
 * ⚠ THE ANIMATION IS ONE ELEMENT AND RESPECTS `prefers-reduced-motion`. Tailwind's `motion-safe:`
 * prefix leaves a static ring for anybody who has asked the OS for less movement — the same courtesy
 * this app owes on a screen it shows on every single launch.
 */
export function LoadingView() {
  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-4 bg-surface-bg"
      /**
       * ⚠ ANNOUNCED, because a screen reader otherwise meets an unlabelled page for the whole launch.
       * `role="status"` with `aria-live="polite"` says it once without interrupting.
       */
      role="status"
      aria-live="polite"
    >
      {/* Explicit width/height reserve the box, so the logo landing does not shift the group — the same
          reason SignInView sizes its copy. */}
      <img src={logo} width={48} height={48} className="rounded-xl" alt="" />
      <div
        className="h-6 w-6 rounded-full border-2 border-surface-line border-t-brand-accent motion-safe:animate-spin"
        aria-hidden="true"
      />
      <p className="text-sm text-surface-muted">Starting <BrandName />…</p>
    </div>
  );
}
