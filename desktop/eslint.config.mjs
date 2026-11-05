import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * ── ⚠ A SELF-CONTAINED ESLINT FLAT CONFIG ──────────────────────────────────────────────────
 *
 * This is the one ESLint flat config for this repo. It is worth keeping because `pnpm lint`
 * needs it and ESLint 9 exits with code 2 before linting a single file when it cannot find an
 * `eslint.config.{js,mjs,cjs}`.
 *
 * ⚠ KEEP THE RULE SET DELIBERATE. An invented rule set is worse than none: it silently diverges
 * from the project's intent, and the first `pnpm lint` after that produces a wall of findings
 * that are style opinions rather than defects, which is how a lint step gets switched off for
 * good.
 *
 * Everything here IS the desktop app, so the config is scoped accordingly — there is no portal or
 * services block. In particular `@next/eslint-plugin-next` is intentionally absent; carrying it
 * would add a Next.js dependency to an Electron app.
 */
export default tseslint.config(
  // Never lint build output, dependencies, or generated bundles. `release/` holds 195MB installers and
  // `build/` holds icons — neither is source.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/out/**",
      "**/coverage/**",
      "**/build/**",
      "release/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // `_`-prefixed args are the house convention for "required by a signature but unused" (interface
      // implementations, Hono middleware, event handlers).
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

  // ─── The desktop app's own relaxations ───────
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "no-empty": "warn",
      // This app strips ANSI escape sequences out of CLI-assistant and ACP subprocess output, and `\x1b` IS
      // the escape character it has to match — the control char is the point, not an accident.
      "no-control-regex": "off",
    },
  },

  // ─── React ────────────────────────────────────────────────────────────────────────────────
  //
  // `exhaustive-deps` stays OFF, as upstream: it is advisory, noisy on deliberate mount-only effects (this
  // app has several, each documented), and a wrong autofix there introduces bugs rather than preventing them.
  {
    files: ["**/*.{jsx,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },

  // ─── Test files ───────────────────────────────────────────────────────────────────────────
  {
    files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: {
      // Fixtures and mocks legitimately reach for `any`.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // ─── Plain JS tooling (scripts, config files) ─────────────────────────────────────────────
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  }
);
