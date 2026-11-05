// ── ⚠ THE MIDDLEWARE MATCHER IS A SECURITY BOUNDARY, NOT A PERFORMANCE HINT ───────────────────
//
// Anything the matcher excludes runs NONE of `middleware.ts`: not the CSRF origin check, not the
// anonymous→/login redirect, and not the three role gates. The role gates are the sharp end,
// because they are NEGATED matches (`isForbiddenPath`), a path that never reaches them is not
// "unmatched", it is ALLOWED.
//
// ⚠ THE PATTERN THIS REPLACED TOOK EVERY GATE OFF ANY PATH ENDING IN AN IMAGE EXTENSION. It read
// `.*\.(?:png|jpg|jpeg|svg|gif|ico|webp|webmanifest)$`, unanchored to any prefix, so it was
// evaluated over the WHOLE path space rather than over `/public`: `GET /admin/users/export.png`
// skipped the lot. This was raised as a security finding.
//
// So the exclusion now NAMES the assets, and this test derives its check from `public/`, the
// directory Next actually serves from. Adding an asset without excluding it fails here, rather
// than being discovered later as a 302 on an icon; adding a ROUTE that happens to end in `.png`
// can no longer strip its own gates.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const MIDDLEWARE = join(__dirname, "..", "middleware.ts");
const PUBLIC_DIR = join(__dirname, "..", "..", "public");

/**
 * The matcher as `middleware.ts` declares it, converted to a RegExp.
 *
 * `JSON.parse` rather than a raw slice: the literal in the source contains `\\.` sequences, and
 * comparing against the escaped text instead of the value is how a test like this quietly stops
 * testing anything.
 */
function matcherRegExp(): RegExp {
  const src = readFileSync(MIDDLEWARE, "utf8");
  const block = /matcher:\s*\[\s*("(?:[^"\\]|\\.)*")\s*,?\s*\]/.exec(src);
  expect(block, "config.matcher should be a literal single-element array").not.toBeNull();
  const pattern = JSON.parse((block as RegExpExecArray)[1]) as string;
  return new RegExp(`^${pattern}$`);
}

/** True when middleware RUNS for this path, i.e. the request is gated. */
function isGated(pathname: string): boolean {
  return matcherRegExp().test(pathname);
}

/** Every file actually served out of `public/`, as the URL path the browser requests. */
function publicAssetPaths(dir: string = PUBLIC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return publicAssetPaths(abs);
    return [`/${relative(PUBLIC_DIR, abs).split(/[\\/]/).join("/")}`];
  });
}

describe("the middleware matcher", () => {
  it("⚠ GATES AN APP ROUTE THAT ENDS IN AN IMAGE EXTENSION, the finding this fixes", () => {
    // The exact shape that used to walk past every gate. If any of these comes back false, the
    // suffix test is back and authN + authZ are optional again.
    expect(isGated("/admin/users/export.png")).toBe(true);
    expect(isGated("/api/trpc/admin.listUsers.png")).toBe(true);
    expect(isGated("/experiences/w1/settings/logo.svg")).toBe(true);
    expect(isGated("/welcome/anything.webmanifest")).toBe(true);
    // Nothing under .well-known/ is published, so nothing there is exempt.
    expect(isGated("/.well-known/aws/securityagent-domain-verification.json")).toBe(true);
  });

  it("gates the ordinary application and API paths", () => {
    for (const path of [
      "/",
      "/login",
      "/welcome",
      "/admin",
      "/admin/users",
      "/profile",
      "/api/trpc/workshop.list",
      "/api/desktop/team-data",
      "/api/invite",
    ]) {
      expect(isGated(path), `${path} must reach the gate chain`).toBe(true);
    }
  });

  it("⚠ EXCLUDES EVERY FILE IN public/, DERIVED FROM THE DIRECTORY ITSELF", () => {
    const assets = publicAssetPaths();
    expect(assets.length, "there should be public assets to reason about").toBeGreaterThan(0);
    for (const asset of assets) {
      expect(
        isGated(asset),
        `${asset} is served from public/ and must be excluded in middleware.ts's matcher, ` +
          `a browser requesting it directly would otherwise be answered with an HTML redirect`
      ).toBe(false);
    }
  });

  it("excludes the Next.js internals", () => {
    expect(isGated("/_next/static/chunks/main.js")).toBe(false);
    expect(isGated("/_next/image?url=%2Ficon-192.png&w=64&q=75")).toBe(false);
  });

  it("⚠ CONTAINS NO UNANCHORED FILE-EXTENSION TEST", () => {
    // The regression guard proper: the bug was not "the wrong extensions were listed", it was
    // that a suffix alternative was evaluated against the whole path space. Any `$`-anchored
    // extension group is that same construction, whatever it lists.
    const src = readFileSync(MIDDLEWARE, "utf8");
    const matcherLine = /matcher:\s*\[\s*("(?:[^"\\]|\\.)*")/.exec(src)?.[1] ?? "";
    expect(matcherLine).not.toMatch(/\.\*\\\\\./);
    expect(matcherLine).not.toMatch(/\$\)/);
  });
});
