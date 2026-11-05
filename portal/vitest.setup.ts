/**
 * ── TEST ENVIRONMENT: LOAD `.env.test`, WHICH VITEST DOES NOT DO ITSELF ────────────────────────
 *
 * ⚠ VITEST LOADS NO ENV FILE INTO `process.env`. Measured, not assumed: a sentinel placed in
 * `.env.test` and every unprefixed variable in the repo's own `.env` both read back as `undefined`
 * inside a test under vitest 4.1.10. Vite's env handling exposes `VITE_`-prefixed values on
 * `import.meta.env`; server-side modules like `lib/session-cookie.ts` read `process.env`, and nothing
 * bridges the two. So a `.env.test` file on its own would be silently inert — which is worse than not
 * having one, because it looks like configuration.
 *
 * `process.loadEnvFile` is Node's own parser (Node 20.12+; this repo runs 24). No dependency added.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const ENV_TEST = join(__dirname, ".env.test");

if (existsSync(ENV_TEST)) {
  process.loadEnvFile(ENV_TEST);
}

/**
 * ── ⚠ THE FALLBACK EXISTS SO A MISSING `.env.test` DEGRADES TO "STILL TESTED", NOT TO "SKIPPED" ──
 *
 * `.env.test` is gitignored (`.env.*`), so it is NOT present on a fresh clone or in CI. The only test
 * that needs a session key is `lib/server-token.test.ts`, and it is the one test that proves the
 * session cookie actually decrypts — everything else about that path is mocked. Two bad outcomes were
 * available and both are avoided here:
 *
 *   · No secret at all → `getAccessToken()` fails closed by design, so every assertion in that file
 *     would pass for the wrong reason. A vacuous test is worse than a missing one.
 *   · Skipping the file when the variable is absent → it would never run in CI, i.e. exactly where a
 *     regression would otherwise be caught.
 *
 * A random per-run key is the right answer instead: that test encodes and decodes with whatever
 * `SESSION_SECRETS` holds, so the value's ORIGIN is irrelevant to what it proves. It is generated, not
 * hardcoded, so no fake-secret string sits in a tracked file for a scanner to flag — which is the
 * reason this file exists at all.
 *
 * ⚠ IT IS DERIVED, SO A LOCAL `.env.test` STILL WINS. Set the variable there when you want a stable
 * key across runs (debugging a cookie by hand, for instance).
 */
if (!process.env.NEXTAUTH_SECRET && !process.env.AUTH_SECRET) {
  process.env.NEXTAUTH_SECRET = `vitest-ephemeral-${crypto.randomUUID()}`;
}
