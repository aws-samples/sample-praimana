import { defineConfig } from "@playwright/test";

/**
 * ── THE PLAYWRIGHT HARNESS ──────────────────────────────────────────────────────────────────
 *
 * `testDir` is `tests/e2e`, relative to this config's own directory, so `pnpm dev` boots the portal
 * from the repo root with no extra path handling.
 *
 * ⚠ WHAT THIS SUITE IS FOR, so it is not mistaken for slow unit tests. `vitest.config.mts` runs
 * `environment: "node"` with no DOM, which is why ~1580 unit tests can cover gating predicates and
 * request correlation as pure functions but CANNOT observe a real focus model, a real tab order, or
 * how many requests actually went out. Those four things are what these specs assert. See
 * `tests/e2e/README.md`.
 *
 * ⚠ THE BROWSER IS VISIBLE (`headless: false`), DELIBERATELY — watching the confirm dialog take and
 * lose focus is the point of the suite. Override per run with `--headed=false` or `CI=true` if a
 * runner has no display.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3001",
    browserName: "chromium",
    headless: false,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  /**
   * ⚠ ONLY THE PORTAL IS BOOTED HERE. Its API target is whatever `BACKEND_URL` in `.env` points
   * at (`:8080` in `.env.example`), an origin fronting the microservices in `../services`. Nothing
   * in this repository starts that origin, so provide one or point it at a deployed API;
   * `tests/e2e/README.md` ("Services") has the commands and the warning that a process manager
   * reporting UP is not proof of a listening socket.
   */
  webServer: [
    {
      /**
       * ⚠ IF EVERY SPEC FAILS WITH "Page not found", SUSPECT THE ENVIRONMENT, NOT THE CODE.
       *
       * Two distinct causes have produced this, both diagnosed the hard way:
       *   1. A LINGERING `next dev` from an earlier run. `reuseExistingServer: true` hands the suite
       *      that process, and if it was started against a different build it serves a 404 for every
       *      route.  →  pkill -f "next dev"
       *   2. A PRODUCTION `.next` left by `pnpm build` in the directory `next dev` uses.
       *      →  rm -rf .next
       *
       * Neither is automated here. `rm -rf .next && pnpm dev` in this command races the dev server's
       * first compile and fails the same way for a different reason — measured, not assumed — and
       * `reuseExistingServer: false` cannot bind while cause 1 holds the port. Clear them as
       * separate steps:
       *
       *   pkill -f "next dev"; rm -rf .next; pnpm test:e2e
       *
       * THE TELL: every spec fails, in page SETUP, before any assertion about behaviour. A genuine
       * defect fails one or two specs ON an assertion. Twice now this has read as a regression in the
       * code under test and been neither.
       */
      command: "pnpm dev",
      port: 3001,
      reuseExistingServer: true,
    },
  ],
});
