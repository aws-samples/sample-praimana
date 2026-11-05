import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * One flat config for every service in this repo.
 *
 * ⚠ WITHOUT THIS FILE `pnpm lint` FAILS IN ALL 15 PACKAGES, AND THE ERROR NAMES THE WRONG CAUSE.
 * Every package here declares `eslint` and a `lint` script, so each one ran and each one died on:
 *
 *   ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
 *
 * which reads as "this package is misconfigured" 15 times over, rather than "the repo has no config".
 * ESLint 9 walks UP from the linted file to find its config, so this single file at the workspace root
 * serves all of them.
 *
 * ── WHAT THIS CONFIG DELIBERATELY OMITS ─────────────────────────────────────────────────────────
 * No Next.js, React-hooks or Electron sections: there is no front-end code in this workspace, and
 * importing those plugins would fail the very command this file exists to fix. This repo's `desktop`
 * package is a Lambda handler, NOT an Electron app, so there is no JSX in this workspace at all.
 *
 * Type-aware linting is deliberately OFF (no `projectService`). Rules needing type information are the
 * slow ones, and `pnpm type-check` already runs `tsc` across every package — the compiler is the
 * authority on types, so ESLint here is scoped to what the compiler does NOT catch.
 */
export default tseslint.config(
  // Never lint build output, dependencies, or generated bundles.
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/build/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // `_`-prefixed args are the house convention for "required by a signature but unused"
      // (interface implementations, Hono middleware, Lambda event handlers).
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

  // ─── Node/Lambda services + the shared libraries ────────────────────────────────────────────
  // Every package in this workspace is one of these, so the glob is the whole repo rather than the
  // monorepo's `apps/services/**` + `packages/shared/**` pair.
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
  },

  // ─── Test files ─────────────────────────────────────────────────────────────────────────────
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      // Fixtures and mocks legitimately reach for `any` — and this repo's fakes lean on
      // `as never` / `as unknown as` at the AWS-SDK boundary precisely so no real client is built.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ─── Plain JS tooling (scripts, config files, this file) ────────────────────────────────────
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  }
);
