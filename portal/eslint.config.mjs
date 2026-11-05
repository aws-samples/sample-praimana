import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * One flat config for this repo.
 *
 * ⚠ WITHOUT IT, `pnpm lint` drops into `next lint`'s interactive "shall I create a config?" prompt,
 * which in CI is a hang, not an error. ESLint 9 walks UP from each linted file to find this config.
 * It is scoped to this repo: `src/**` for the app, and `shared/**` for the vendored copy, which is
 * linted here because nothing else lints it.
 *
 * Type-aware linting is deliberately OFF (no `projectService`). Rules that need type information are the slow
 * ones, and `pnpm type-check` already runs `tsc` over this repo — the compiler is the authority on types, so
 * ESLint here is scoped to what the compiler does NOT catch.
 */
export default tseslint.config(
  // Never lint build output, dependencies, or generated bundles.
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/out/**",
      "**/coverage/**",
      "**/build/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  /**
   * ── ⚠ REGISTERING `@next/next` GLOBALLY, WITH NO RULES, TO SATISFY NEXT'S OWN DETECTION ──────
   *
   * `next build` printed this on every build:
   *
   *   ⚠ The Next.js plugin was not detected in your ESLint configuration.
   *
   * IT WAS A FALSE ALARM, AND FINDING THAT OUT IS THE POINT — the plugin was configured, loaded and
   * reporting (`@next/next/no-img-element` fired during the same build). The warning comes from
   * `next/dist/lib/eslint/runLintCheck.js`, which decides the question by calling
   * `eslint.calculateConfigForFile(<the eslint config file itself>)` and looking for `@next/next` in
   * the resulting `plugins`. The block below scopes the plugin to `files: ["src/**"]`, and
   * `eslint.config.mjs` is not under `src/` — so the plugin correctly did not apply to the file Next
   * chose to probe, and Next read that as "not installed".
   *
   * Registering the plugin here with NO `files` and NO rules makes it visible to that probe while
   * changing nothing about what gets linted: a registered-but-unused plugin contributes no rules.
   * The RULES stay scoped below, which is what keeps them off `shared/` and the config files.
   *
   * ⚠ NOT SILENCED, DIAGNOSED. Suppressing the line (or ignoring it) would leave a real question
   * open — "is the Next plugin running?" — and the honest answer needed the detection to agree with
   * reality rather than be told to be quiet.
   */
  { plugins: { "@next/next": nextPlugin } },

  {
    rules: {
      // `_`-prefixed args are the house convention for "required by a signature
      // but unused" (interface implementations, middleware, event handlers).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // ─── The vendored shared library ──────────────────────────────────────────
  // Plain modules with no DOM and no bundler: they run in the browser, in Node under vitest, and
  // (upstream) inside Lambda handlers. `process`/`console` are the only globals they reach for.
  {
    files: ["shared/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
  },

  // ─── Next.js portal ───────────────────────────────────────────────────────
  // The `next lint` wrapper is deprecated (removed in Next 16) and only knows
  // how to bootstrap an eslintrc, so we consume the plugin's own flat config
  // directly and run plain `eslint` instead.
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },

  // ─── The backend boundary (portal BFF) — ⚠ THE GAP THIS EXISTED FOR IS CLOSED ──────────────
  //
  // ORIGINALLY: `backendFetch` returned parsed JSON with no declared shape, so every caller that
  // mapped over a response annotated the callback param `any` — ~50 call sites across the routers
  // and the pages. This block downgraded the rule to `warn` for those two globs, and recorded the
  // real fix: give the API responses declared types and have `backendFetch` return them, "at which
  // point these annotations disappear on their own."
  //
  // ⚠ THAT IS DONE, AND THE COUNT IS NOW ZERO. `backendFetch<T>()` carries the shape,
  // `src/lib/backend-types.ts` declares the responses, and `RouterOutputs` (`src/lib/trpc/client.ts`)
  // gives the pages a name for what a procedure returns. `pnpm lint` reports no warnings at all. The
  // one remaining `any` is the documented default inside `backend.ts` itself, which is NOT in these
  // globs and is disabled inline at the line.
  //
  // ⚠ NOW `error`, PROMOTED FROM `warn` ONCE THE COUNT REACHED ZERO — a new `any` in a router or a
  // page is a REGRESSION, not unfinished work, and it should stop a build rather than scroll past in a
  // wall of warnings. The block is kept (rather than deleted, letting these files inherit the global
  // rule) because the two globs are the boundary this whole arrangement is about; the next person to
  // ask "why is `any` singled out for the BFF layer?" needs the history above, not silence.
  //
  // ⚠ THE 72 STILL-UNTYPED CALL SITES DO NOT NEED AN `any` AND THAT IS WHY THIS IS SAFE. They pass no
  // type argument and inherit `backendFetch`'s permissive default, which is declared and disabled once
  // inside `backend.ts` — a file OUTSIDE these globs. So typing the remaining routes stays incremental
  // and nobody is forced to annotate anything to keep the build green.
  //
  // If a genuinely unavoidable `any` appears here, an inline
  // `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>` is the intended escape
  // hatch: it survives review as a visible, justified, greppable decision, which a warning nobody reads
  // does not.
  {
    files: ["src/lib/trpc/routers/**/*.ts", "src/app/**/*.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },

  // ─── React: the rule that catches a crash the compiler cannot ─────────────
  //
  // ⚠ ADDED AFTER SHIPPING THE EXACT BUG IT CATCHES. A `useEffect` was placed after a component's
  // early-return guards, so on the loading and setup screens the hook was skipped and on every other
  // render it ran — React counted a different number of hooks between renders and the whole app
  // crashed with "Rendered more hooks than during the previous render."
  //
  // Nothing else in this repo could catch it: `tsc` sees valid code, and vitest's environment is
  // `node`, so there is no render to observe. `rules-of-hooks` is a lint rule precisely because this
  // is a static property of where the call sits.
  //
  // `exhaustive-deps` stays OFF. It is advisory, it is noisy on deliberate mount-only effects (this app
  // has several, each documented), and a wrong autofix there introduces bugs rather than preventing them.
  //
  // ⚠ AND IT DOES NOT COVER THIS APP'S MOST COMMON HOOK CALL — MEASURED, NOT ASSUMED. `isHook` in
  // eslint-plugin-react-hooks 7.1.1 treats a member expression as a hook only when the OBJECT is a
  // single PascalCase identifier: `React.useState()` and `Namespace.useThing()` qualify. Every hook
  // call in this application is `trpc.<router>.<procedure>.useQuery()` / `.useMutation()`, whose object
  // is a NESTED member expression with a lowercase root — so the rule does not classify it as a hook and
  // has nothing to say about where it sits. Proven with a probe: in one file the PascalCase form was
  // flagged after an early return and the tRPC form on the next line was not.
  //
  // That is the rule's documented heuristic, not a defect in it. The consequence is real: `UsersTab`
  // shipped `trpc.admin.setUserAccess.useMutation` below an `if (error) return`, so ANY error on the
  // Administration → Users tab crashed the tab instead of rendering the message it had ready, and lint
  // was green throughout. `src/lib/hooks-after-early-return.test.ts` is the missing half — a source scan
  // for that shape, with the shipped bug as its fixture.
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },

  // ─── Test files ───────────────────────────────────────────────────────────
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      // Fixtures and mocks legitimately reach for `any`.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ─── Plain JS tooling (scripts, config files) ─────────────────────────────
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: "readonly", console: "readonly", module: "writable" },
    },
  }
);
