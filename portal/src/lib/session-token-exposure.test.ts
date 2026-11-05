// ── ⚠ THE OUTBOUND BEARER MUST NOT REACH THE BROWSER ──────────────────────────────────────────
//
// In Auth.js v5 whatever the `session()` callback returns IS the JSON body of the public
// `GET /api/auth/session` endpoint, and `<SessionProvider>` makes every page fetch it. So a single
// line, `session.accessToken = t.accessToken`, handed the Cognito ID token to in-page JavaScript
// on every page load.
//
// That token is the SOLE bearer for every `/v1/*` service call (`lib/backend.ts`), i.e. a ~30-minute
// full-impersonation credential against every service, and this portal is a BFF whose gates it
// bypasses entirely. No client code ever read it: all consumers were server-side. This was raised
// as a security finding.
//
// The fix has three parts and this file pins all three, because each is individually reversible by
// someone who needs the token in a hurry:
//
//   1. The `session()` callback does not assign it.
//   2. `Session` does not declare it, so re-adding (1) is a compile error rather than a regression.
//   3. `lib/server-token.ts`, which CAN read it, is never imported by a client component.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const AUTH = join(SRC, "lib", "auth.ts");
const TYPES = join(SRC, "types", "next-auth.d.ts");

/** Every `.ts`/`.tsx` file under `src/`, excluding tests. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(abs);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return [abs];
  });
}

/**
 * Source with comments removed.
 *
 * ⚠ NECESSARY, NOT TIDINESS. The callback this file inspects DOCUMENTS the line it no longer has
 * ("this used to read `session.accessToken = …`"), and `csrf-exemption.test.ts` records the same
 * trap for `withBearer`: a substring assertion over raw source tests the documentation. Every
 * `⚠`-marked comment in this codebase quotes the defect it replaced, so any test that greps for a
 * defect has to read past them.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The body of the `session()` callback in `lib/auth.ts`, comments removed. */
function sessionCallback(): string {
  const src = readFileSync(AUTH, "utf8");
  const start = src.indexOf("session({ session, token })");
  expect(start, "auth.ts should declare a session() callback").toBeGreaterThan(-1);
  // Up to the next callback or the end of the callbacks block, `pages:` follows it.
  const end = src.indexOf("\n  pages:", start);
  expect(end, "the callbacks block should be followed by `pages:`").toBeGreaterThan(start);
  return stripComments(src.slice(start, end));
}

describe("the session object served to the browser", () => {
  it("⚠ CARRIES NO BEARER, the session() callback assigns only identity fields", () => {
    const body = sessionCallback();

    // The exact line that was the finding, in any spacing.
    expect(body).not.toMatch(/session\.accessToken\s*=/);
    // Nor smuggled in under another name or via a spread of the token.
    expect(body).not.toMatch(/session\s*\.\s*\w+\s*=\s*t\.accessToken/);
    expect(body).not.toMatch(/\.\.\.\s*t\b/);
    expect(body).not.toMatch(/\.\.\.\s*token\b/);

    // What it SHOULD still do, so this test fails if the callback is gutted rather than corrected.
    expect(body).toMatch(/session\.user\.id\s*=/);
    expect(body).toMatch(/session\.user\.role\s*=/);
  });

  it("⚠ IS NOT TYPED TO CARRY ONE, so re-adding the assignment will not compile", () => {
    const types = readFileSync(TYPES, "utf8");
    const iface = types.slice(types.indexOf("interface Session"), types.indexOf("interface User"));
    expect(iface).not.toMatch(/^\s*accessToken\?*:/m);
  });

  it("⚠ IS NEVER READ FOR A TOKEN BY CLIENT CODE", () => {
    const offenders = sourceFiles()
      .filter((file) => /^\s*["']use client["']/.test(readFileSync(file, "utf8")))
      // Comments stripped: a client component may legitimately EXPLAIN that it must not read the
      // token, and that explanation must not read as a violation.
      .filter((file) => /\baccessToken\b/.test(stripComments(readFileSync(file, "utf8"))))
      .map((file) => file.replace(`${SRC}/`, ""));

    expect(
      offenders,
      "a client component reading `accessToken` means the token is back on the session, or is " +
        "being obtained some other way that puts it in the browser"
    ).toEqual([]);
  });

  it("⚠ AND THE SERVER-ONLY READER IS NEVER PULLED INTO A CLIENT BUNDLE", () => {
    // `lib/server-token.ts` decrypts the session cookie. Imported from a client component it would
    // either fail at build or, worse, drag the secret-handling path toward the browser.
    const offenders = sourceFiles()
      .filter((file) => {
        const src = readFileSync(file, "utf8");
        return (
          /^\s*["']use client["']/.test(src) && /@\/lib\/server-token/.test(stripComments(src))
        );
      })
      .map((file) => file.replace(`${SRC}/`, ""));

    expect(offenders).toEqual([]);
  });

  it("has server-side consumers reading the token from the cookie instead", () => {
    // The other half of the change: the six consumers still get a bearer, just not via the session.
    // If this drops to zero, the token is being obtained somewhere new and this file is looking at
    // the wrong place.
    const consumers = sourceFiles().filter((file) =>
      /getAccessToken\(/.test(stripComments(readFileSync(file, "utf8")))
    );
    expect(consumers.length, "server routes and the tRPC context read via getAccessToken()")
      .toBeGreaterThanOrEqual(6);
    expect(statSync(join(SRC, "lib", "server-token.ts")).isFile()).toBe(true);
  });
});
