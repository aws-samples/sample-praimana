import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ProfileChooser } from "./components/ProfileChooser";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme } from "./lib/theme";
import "./index.css";

const api = (window as any).electronAPI;

// Report uncaught renderer errors that escape React (async handlers, event
// callbacks, rejected promises) to the local opt-in telemetry log (EA-M6). The
// ErrorBoundary covers render-phase exceptions; these two cover the rest.
window.addEventListener("error", (e) => {
  try {
    api?.reportError?.({
      source: "renderer:error",
      message: e.message || String(e.error),
      stack: e.error?.stack,
    });
  } catch { /* ignore */ }
});
window.addEventListener("unhandledrejection", (e) => {
  try {
    const reason: any = e.reason;
    api?.reportError?.({
      source: "renderer:unhandledrejection",
      message: reason?.message || String(reason),
      stack: reason?.stack,
    });
  } catch { /* ignore */ }
});

/**
 * ── ⚠ THE PROFILE CHOOSER REPLACES THE APP, IT DOES NOT SIT INSIDE IT ─────────────────────
 *
 * `?chooser=1` is set by the main process when no profile has been chosen (see `decideLaunch`). In that mode
 * NO DATABASE IS OPEN and only the `profile:*` channels are registered, so `<App />` must not mount at all —
 * it would immediately call `getSetting`, `getProjects` and the rest against handlers that do not exist.
 *
 * ⚠ GATED HERE RATHER THAN INSIDE `App`, deliberately. A branch inside App would put the picker one careless
 * early `useEffect` away from touching a database that is not there, and the failure would be an empty window
 * with an error in a log nobody is watching. Swapping the root component makes it structurally impossible.
 */
const params = new URLSearchParams(window.location.search);
const showChooser = params.get("chooser") === "1";
const mustCreate = params.get("mustCreate") === "1";

/**
 * ── ⚠ THE THEME IS APPLIED BEFORE REACT MOUNTS, AND OUTSIDE THE COMPONENT TREE ─────────────
 *
 * Done here rather than in an `App` effect for two reasons:
 *
 *   1. The CHOOSER also needs a theme, and it is a different root component. A hook inside `App` would
 *      leave the profile picker permanently dark — the one screen a participant sees before anything else.
 *   2. An effect runs AFTER the first paint, so the app would flash the wrong palette on every launch for
 *      anyone not on dark. Setting the attribute before `createRoot` means the first frame is correct.
 *
 * ⚠ IT MUST NOT THROW IN CHOOSER MODE. `theme:get` reads the settings table, and the chooser runs with NO
 * DATABASE OPEN — that handler is registered after `initDatabase()`, past the early return. So a failure
 * here is expected in that mode and degrades to dark, which is `:root` in index.css and the mode this app
 * has always shipped. The picker being dark on a light machine is a cosmetic miss; a rejected promise on
 * the launch path is a blank window.
 */
void (async () => {
  try {
    const { resolved } = await api.themeGet();
    applyTheme(resolved, document.documentElement);
  } catch {
    /* No database (chooser mode) or an older main process — `:root` already renders dark. */
  }
})();

/**
 * Follow later changes: the participant switching mode in Settings, or the OS flipping while on Auto.
 *
 * ⚠ REGISTERED ONCE AT MODULE SCOPE, not per component. The theme belongs to the DOCUMENT, so a listener
 * that unmounts with a view would stop the app following the OS the moment somebody navigated away from
 * Settings — and it is main that pushes this, to every window in the profile.
 */
api?.onThemeChanged?.(({ resolved }: { resolved: "light" | "dark" }) =>
  applyTheme(resolved, document.documentElement)
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        {showChooser ? <ProfileChooser mustCreate={mustCreate} /> : <App />}
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
