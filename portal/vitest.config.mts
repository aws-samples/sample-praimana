import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for the portal BFF's security-critical, pure logic: authorization
// helpers, the AI-stream rate limiter, and backend error mapping. React/route
// integration is out of scope here (covered by e2e).

/**
 * ── ⚠ `.mts`, NOT `.ts`, AND THE ALTERNATIVE WOULD HAVE BROKEN THE BUILD ────────────────────
 *
 * As `vitest.config.ts` this file was loaded as CommonJS while containing ESM syntax, and every run
 * opened with a deprecation notice:
 *
 *   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is
 *       planned to become the default in a future major version of Vite:
 *       - ESM syntax in a file loaded as CommonJS. Use a `.mjs` extension or set `"type": "module"`.
 *
 * Advisory today, breaking when Vite flips that default — the config would simply fail to load.
 *
 * ⚠ THE OTHER REMEDY VITE SUGGESTS IS THE WRONG ONE HERE. `"type": "module"` in `package.json`
 * reinterprets every `.js` file in the repo as ESM, and `postcss.config.js` is `module.exports = {…}`
 * — so Tailwind's PostCSS pipeline would break, i.e. `next build` would break, to silence a warning
 * in the test runner. `.mts` scopes the fix to the one file that needs it and keeps the TypeScript
 * types this config relies on (`.mjs` would lose them). Vitest resolves `vitest.config.mts` natively;
 * no script or path needed changing.
 */
export default defineConfig({
  /**
   * ⚠ WITHOUT THIS LINE, EVERY TEST THAT IMPORTS A COMPONENT FAILS TO PARSE, depending on the resolved
   * Vite version.
   *
   * `tsconfig.json` sets `"jsx": "preserve"`, which is what Next requires (it owns the JSX transform, and
   * `next dev` rewrites the field if you change it). Vite reads that value and applies it to its own
   * transform. Vite 6 quietly compiled JSX in `.tsx` anyway; Vite 8 honours `preserve` literally, so the
   * transformed module still contains JSX and `vite:import-analysis` rejects it:
   *
   *   Failed to parse source for import analysis because the content contains invalid JS syntax.
   *   If you use tsconfig.json, make sure to not set jsx to preserve.
   *
   * A lockfile resolving Vite 6 compiles JSX regardless; a fresh install can resolve Vite 8, which does
   * not. Overriding the JSX runtime HERE keeps `tsconfig.json` saying what Next needs while the test
   * runner compiles what it needs.
   *
   * (`oxc`, not `esbuild`: Vite 8 transforms with Oxc. Both keys still exist, and setting the wrong one is
   * silently ignored.)
   */
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    /**
     * ⚠ `shared/` AND `tests/` ARE INCLUDED.
     *
     * `shared/**` — the vendored test files ship WITH their modules, and with only `src/**` they would be
     * collected by nothing: eight test files sitting in the repo looking like coverage while never running,
     * which is worse than not having them. This config is the only thing that runs them here.
     *
     * `tests/**` — `tests/e2e/totp.ts` is the vendored TOTP generator (see the header there). Its RFC 6238
     * vector test lives at `src/lib/totp.test.ts` and is already collected by `src/**`; the pattern is here
     * so a future test placed beside the helper is not silently ignored. Playwright specs were NOT copied
     * into this repo, so there is nothing here for vitest to collide with.
     */
    include: ["src/**/*.test.ts", "shared/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    /**
     * ⚠ `BACKEND_URL` IS SET HERE BECAUSE `lib/backend.ts` NO LONGER HAS A FALLBACK.
     *
     * It used to default to `http://localhost:4000` when the variable was absent, which meant a
     * deployment that lost the variable pointed the BFF at its own loopback instead of failing
     * (a security finding). The module now throws at load, so the test runner has to
     * supply a value like every other environment does — and this is the same origin `.env.example`
     * documents, so tests exercise the value a developer actually runs against.
     */
    /**
     * ⚠ `NEXTAUTH_SECRET` IS DELIBERATELY *NOT* HERE. It was, as a fixed fake string, and a tracked
     * config file is the wrong home for anything shaped like a key — a secret scanner cannot tell the
     * difference and should not have to. It now comes from `.env.test` (gitignored) when that file
     * exists, and from a random per-run value otherwise. See `vitest.setup.ts`, which also records why
     * a `.env.test` file alone would have been silently inert.
     *
     * `BACKEND_URL` stays: it is an origin, not a credential, and keeping it here means a fresh clone
     * with no `.env.test` still runs the whole suite rather than failing at every module that imports
     * `lib/backend.ts`.
     */
    env: { BACKEND_URL: "http://localhost:8080" },
    /**
     * Loads `.env.test` into `process.env` before any test module is imported — which matters because
     * `lib/session-cookie.ts` reads the secret at MODULE LOAD, so a value applied later would be too
     * late to affect `SESSION_SECRETS`.
     */
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /**
       * ⚠ VITEST DOES NOT READ `tsconfig.json` `paths`. Next does, which is why the app builds without an
       * alias here — but the test runner resolves nothing, and without this line every one of the ~60 files
       * importing `@praimana/shared` fails to load with "Failed to resolve import".
       */
      "@praimana/shared": fileURLToPath(
        new URL("./shared/index.ts", import.meta.url)
      ),
    },
  },
});
