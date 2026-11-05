import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import { CSP_PROD_META } from "./src/csp-policy";

/**
 * ── ⚠ THREE BUILD-TIME `define`s WERE REMOVED, AND WHY THAT IS THE FIX ────────────────────────
 *
 * `__DEFAULT_PORTAL_URL__`, `__ALLOWED_AUTH_HOSTS__` and `__ACCESS_KEY_SECRET__` were injected here
 * and had ZERO consumers in `src/` or `shared/` — verified by grep, not assumed. They were dead
 * values carrying live-sounding security documentation, which is worse than no documentation:
 *
 *   `__ALLOWED_AUTH_HOSTS__`'s docblock described it as the answer to "is this host allowed to
 *   collect a credential". The real check is the hardcoded `isAwsAuthHost` regex at
 *   platform-config.ts:159, which never consulted this value — so a customer with a CUSTOM Cognito
 *   auth domain would set the documented env var, believe they had allowed their host, and be
 *   silently refused at sign-in.
 *
 *   `__ACCESS_KEY_SECRET__`'s docblock claimed "the desktop logs a warning at startup when it
 *   detects [the dev default]". No such warning exists. It also pointed at
 *   `shared/constants/access-key.ts` — a path that does not exist in this
 *   standalone repo, because the Access Key feature is not here at all.
 *
 * Deleted rather than wired up: wiring one would be a FEATURE decision (and, for the auth-host
 * allowlist, a change to what hosts may collect a password), not a security fix. If a custom auth
 * domain is ever needed, it needs implementing in `isAwsAuthHost` with a reviewer — not an env var
 * that appears to work.
 *
 * ⚠ AND `define` APPLIES TO THE RENDERER BUILD TOO, which is why leaving a secret-shaped value here
 * was worth removing on its own: a future consumer added in the renderer would have inlined it into a
 * bundle any injected script can read. It is absent from `dist/` today only because nothing read it.
 */

/**
 * ⚠ THE VENDORED SHARED CODE, ALIASED — AND REPEATED IN EVERY NESTED BUILD.
 *
 * 16 source files import `@praimana/shared`; pointing the specifier at `./shared` keeps every one of
 * those imports byte-identical to the upstream copy, so this repo can still be diffed against upstream.
 *
 * ⚠ IT MUST BE REPEATED INSIDE EACH `electron()` ENTRY, for the same reason `define` is: vite-plugin-electron
 * builds main and preload with their own nested vite config, which does NOT inherit the top-level `resolve`.
 * Set only at the top level, the renderer resolved fine and the MAIN build failed with
 * "Rollup failed to resolve import @praimana/shared from src/main/deep-link.ts".
 */
const SHARED_ALIAS = {
  alias: { "@praimana/shared": path.resolve(__dirname, "shared/index.ts") },
};

/**
 * ── ⚠ THE PRODUCTION CSP, INJECTED AS A META TAG AT BUILD TIME ────────────────────────────────
 *
 * The policy was delivered only as a response header (`onHeadersReceived` in src/main/index.ts).
 * A `file://` load — which is how the packaged app loads the renderer — has no HTTP response and
 * so no headers, and `index.html` carried no meta tag, so the shipped build very likely ran with
 * no policy at all.
 *
 * `apply: "build"` is the whole reason this is a plugin rather than a line in `index.html`: Vite
 * serves that same file in dev, where the production policy would break HMR on the first hot
 * update (no `'unsafe-eval'`, no inline script, no `ws://localhost:5173`). Dev keeps the header.
 *
 * The string comes from src/csp-policy.ts, shared with the header, so the two cannot drift.
 */
function csp(): Plugin {
  return {
    name: "inject-production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: { "http-equiv": "Content-Security-Policy", content: CSP_PROD_META },
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  /**
   * ⚠ THE VENDORED SHARED CODE, ALIASED RATHER THAN REWRITTEN. 16 source files import
   * `@praimana/shared`; pointing the specifier at `./shared` keeps every one of those imports
   * untouched, so this repo's source stays byte-identical to the upstream copy and can be diffed against it.
   * See README for why the code is duplicated rather than depended on.
   */
  resolve: SHARED_ALIAS,
  plugins: [
    react(),
    csp(),
    electron([
      {
        entry: "src/main/index.ts",
        vite: {
          resolve: SHARED_ALIAS,
          build: {
            outDir: "dist/main",
            lib: {
              entry: "src/main/index.ts",
              formats: ["cjs"],
            },
            rollupOptions: {
              // Node/native modules Electron loads from node_modules at runtime.
              // `ws` belongs here for the same reason as better-sqlite3: bundling
              // it inlines its OPTIONAL native peers (bufferutil,
              // utf-8-validate), and Vite replaces an unresolved optional peer
              // with a module that THROWS on import — so main crashed at load
              // with `Could not resolve "bufferutil"` even though ws only needs
              // those for a faster masking path and works fine without them.
              external: [
                "electron",
                "better-sqlite3",
                "simple-git",
                "ws",
                "path",
                "fs",
                "os",
                "crypto",
              ],
            },
          },
        },
      },
      {
        entry: "src/preload/index.ts",
        vite: {
          resolve: SHARED_ALIAS,
          build: {
            outDir: "dist/preload",
            rollupOptions: {
              external: ["electron"],
            },
          },
        },
        onstart(args) {
          args.reload();
        },
      },
    ]),
  ],
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
  },
});
