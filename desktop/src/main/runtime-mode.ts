import { app } from "electron";

/**
 * ── ⚠ AM I A DEV BUILD? THE ANSWER MUST NOT COME FROM THE ENVIRONMENT ─────────────────────────
 *
 * Three security decisions were gated on a single runtime read of `process.env.NODE_ENV`:
 *
 *   renderer-document.ts — is `http://localhost:5173` a TRUSTED renderer origin? (consulted by
 *                          BOTH `will-navigate` and the IPC sender guard, so it decides who may
 *                          reach ~120 privileged channels)
 *   index.ts             — load the dev server instead of the packaged document?
 *   index.ts             — apply the loose `CSP_DEV` with `'unsafe-inline' 'unsafe-eval'`?
 *
 * An environment variable is not a property of the build; it is a text field any local process can
 * set. `launchctl setenv NODE_ENV development` needs no privilege, is inherited by anything launched
 * from the Dock, and binding `127.0.0.1:5173` needs no privilege either — port > 1024. Together they
 * made a signed, notarized, TCC-approved application load an attacker's page AS ITS OWN RENDERER,
 * with the preload bridge attached. `contextIsolation` and `sandbox` do not help: the bridge is the
 * prize, not Node.
 *
 * `vite.config.ts` already states the principle for its own build-time values — "never read from
 * `process.env` at run time, because an env var another local process can set is a text field the
 * user cannot see" — and main was violating it for the most security-critical switch in the app.
 *
 * ── WHY BOTH CONDITIONS, RATHER THAN JUST `app.isPackaged` ──
 *
 * `app.isPackaged` is the HARD gate: Electron derives it from the executable's path, and no
 * environment variable can flip it. That alone closes the attack on the shipped artifact.
 *
 * It is not sufficient on its own for the OTHER two uses, though, because "not packaged" does not
 * mean "a Vite dev server is listening". Running `electron .` against a built `dist/` — which is how
 * the app is smoke-tested — is unpackaged and has no dev server, so keying document selection on
 * `isPackaged` alone would send it to `loadURL("http://localhost:5173")` and open a blank window.
 *
 * So: `isPackaged` decides whether dev mode is POSSIBLE, and `NODE_ENV` remains the intent signal
 * within a dev checkout. A packaged build ignores `NODE_ENV` entirely.
 *
 * ⚠ RESIDUAL, STATED: on a machine where the user runs an UNPACKAGED checkout, an attacker who can
 * set `NODE_ENV` and bind 5173 can still be trusted. That is a developer working tree, not the
 * artifact users install, and the same attacker could simply edit the source. The threat this closes
 * is against the shipped app.
 */
export function isDevRuntime(): boolean {
  // Read at call time, not module load: `app.isPackaged` is available immediately, but a frozen
  // constant would also freeze this decision before tests can drive it.
  if (app.isPackaged) return false;
  return process.env.NODE_ENV === "development";
}
