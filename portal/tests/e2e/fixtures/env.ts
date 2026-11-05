/**
 * WHICH ENVIRONMENT VARIABLES EACH SPEC NEEDS, and what happens when they are absent.
 *
 * ── WHY SKIP RATHER THAN FAIL ──
 * A spec whose test account is not configured must say so in one sentence. The failure
 * mode being avoided is specific and it has burned this repo before: without an account,
 * sign-in silently does not complete, the next `getByRole` waits 30s on a page that never
 * loaded, and the report reads `locator resolved to 0 elements` — which sends the reader
 * hunting for a renamed button instead of setting a variable.
 *
 * ── AND WHY NOT SILENTLY PASS ──
 * `test.skip()` is reported as SKIPPED, never as passed. That distinction is the whole
 * point: a suite that quietly green-lights itself when it tested nothing manufactures
 * exactly the confidence this harness exists to withhold. Every skip carries the variable
 * names, so the gap is legible in the run output rather than inferred from a low test count.
 *
 * NOTHING HERE IS COMMITTED. Every value is read from the process environment. See
 * tests/e2e/README.md for the full list and how to obtain each one.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * `.env` is resolved as `join(REPO_ROOT, ".env")`.
 *
 * `REPO_ROOT` is anchored on `__dirname` (`tests/e2e/fixtures`, so three levels up is this repo's
 * root) rather than `process.cwd()`, so it does not depend on where the runner was invoked from. The
 * `.env` it points at is the same file local dev already keeps, so the README's promise holds: if you
 * can run the portal, you can run these specs with no extra setup.
 */
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const PORTAL_ENV = path.join(REPO_ROOT, ".env");

/**
 * One test account: the address, its password, and its TOTP enrolment secret.
 *
 * The secret belongs to a PURPOSE-MADE account, never a real operator's authenticator —
 * see the header of tests/e2e/totp.ts for why that distinction is not negotiable.
 */
export interface TestAccount {
  email: string;
  password: string;
  totpSecret: string;
  /** For diagnostics only — which variable group this came from. */
  label: string;
}

/**
 * Read a `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD` / `{PREFIX}_TOTP_SECRET` triple.
 *
 * Returns the MISSING variable names rather than a boolean, so a skip message can name
 * precisely what to set instead of "credentials not configured".
 */
export function readAccount(prefix: string): {
  account: TestAccount | null;
  missing: string[];
} {
  const keys = [`${prefix}_EMAIL`, `${prefix}_PASSWORD`, `${prefix}_TOTP_SECRET`];
  const missing = keys.filter((k) => !process.env[k]?.trim());
  if (missing.length > 0) return { account: null, missing };

  return {
    account: {
      email: process.env[keys[0]]!.trim(),
      password: process.env[keys[1]]!,
      totpSecret: process.env[keys[2]]!.trim(),
      label: prefix,
    },
    missing: [],
  };
}

/** A skip message that names the variables and points at the README. */
export function missingAccountMessage(prefix: string, missing: string[]): string {
  return (
    `SKIPPED — no ${prefix} test account configured. ` +
    `Set ${missing.join(", ")} in your environment. ` +
    `See tests/e2e/README.md ("Environment") for where each value comes from. ` +
    `This spec signs in through the REAL Cognito TOTP challenge and cannot be faked.`
  );
}

/**
 * The NextAuth signing secret, for the session-minting seam in session.ts.
 *
 * Read from the environment first, then from `.env` — which is where local dev
 * already keeps it, so a developer who can run the portal can run these specs with no extra
 * setup. Absent means the minted-session specs skip.
 *
 * NOT A PRODUCTION SECRET PATH: this reads the LOCAL dev file only, and the seam it feeds
 * is refused by any deployment whose secret this does not match (which is every one of
 * them). See session.ts for the full argument.
 */
export function readNextAuthSecret(): { secret: string | null; whereLooked: string[] } {
  const whereLooked = ["process.env.NEXTAUTH_SECRET"];
  const fromEnv = process.env.NEXTAUTH_SECRET?.trim();
  if (fromEnv) return { secret: fromEnv, whereLooked };

  whereLooked.push(PORTAL_ENV);
  try {
    const contents = fs.readFileSync(PORTAL_ENV, "utf8");
    // Tolerates quoted and unquoted values, which is how this file is actually written.
    const match = contents.match(/^\s*NEXTAUTH_SECRET\s*=\s*"?([^"\r\n]+)"?/m);
    if (match?.[1]?.trim()) return { secret: match[1].trim(), whereLooked };
  } catch {
    // Absent file is a normal case (CI without a checkout of .env), not an error.
  }
  return { secret: null, whereLooked };
}

export function missingSecretMessage(whereLooked: string[]): string {
  return (
    `SKIPPED — NEXTAUTH_SECRET not found. Looked in: ${whereLooked.join(", ")}. ` +
    `This spec mints a portal session cookie directly so it can exercise the dialog's ` +
    `focus and double-submit contract without consuming a TOTP code per test. ` +
    `See tests/e2e/README.md ("The two ways a spec authenticates").`
  );
}
