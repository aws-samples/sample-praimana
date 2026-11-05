// ── ⚠ THE PIN BELONGS BESIDE THE TITLE, NOT IN THE CORNER ────────────────────────────────
//
// ⚠ THE FIRST TIME, THE WRONG PIN WAS MOVED. There are two — the sidebar row's and the pane's — and "on
// the tabs" was read as the sidebar rows. The one that needed moving is the PANE pin, and "far right
// corner" is literally its old `absolute right-2 top-2`. It landed after the header's own
// control cluster, so it read as a fourth, unexplained button rather than as this pane's own affordance.
//
// ── WHY A CONTEXT AND NOT A PROP ──
//
// The pin is decided by `App` (which view is pinned is app state), but it must RENDER inside each pane's own
// header, next to that header's title — and the header lives inside the view component. Five views are
// pinnable, so the alternative was five new component props threaded through five call sites.
//
// ⚠ AND A PROP WOULD HAVE BEEN EASY TO FORGET, WHICH IS THE FAILURE MODE THAT MATTERS. A view that ignored
// its `pin` prop would silently lose the only pin a participant with a COLLAPSED sidebar can reach — the
// exact capability the pane pin was added for. `pane-pin-slot.test.ts` asserts every pinnable view renders
// a slot, which is a check a prop could not offer as cheaply.
//
// ⚠ AN ABSENT PROVIDER RENDERS NOTHING RATHER THAN THROWING. A view is also reachable outside a pinnable
// pane, and a missing pin is a missing convenience — not a reason to blank the pane with an error boundary.

import { createContext, useContext, type ReactNode } from "react";

/** The pin element for the pane currently being rendered, or null when this pane cannot be pinned. */
const PanePinContext = createContext<ReactNode>(null);

export function PanePinProvider({ pin, children }: { pin: ReactNode; children: ReactNode }) {
  return <PanePinContext.Provider value={pin}>{children}</PanePinContext.Provider>;
}

/**
 * Renders this pane's pin, if it has one.
 *
 * Place it immediately after the header's TITLE, inside the same flex row, so it reads as belonging to the
 * name of the thing it pins — "Codex 📌" — rather than joining the row of actions at the other end.
 */
export function PanePinSlot() {
  return <>{useContext(PanePinContext)}</>;
}
