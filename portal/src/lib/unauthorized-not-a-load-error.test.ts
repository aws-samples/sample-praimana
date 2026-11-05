// ── ⚠ AN EXPIRED LOGIN IS NOT A FAILED LOAD, EVERYWHERE, NOT JUST ONCE ──────────────────
//
// REPORTED: "why do i see this Couldn't load this conversation … Backend error: 401 can add redirect hook for
// this to login page".
//
// The page-level gate has branched on 401 since the last round of this exact bug. The NARROWER error paths did
// not, so a 401 produced "the data is missing … report it and quote the message" for what is only an expired
// session, with the status quoted back at the reader as if it were a bug to file.
//
// ⚠ THE SAME SHAPE AS THE SYNC BADGE AND THE COPY BUTTON: built once, wired into one path, reported again from
// another. So this test enumerates EVERY site rather than the one that was reported, a new `ContentLoadError`
// without the 401 branch fails here, which is the only way this stops recurring.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every .tsx under src, so a new page cannot escape by being new. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = walk(SRC).filter((p) => readFileSync(p, "utf8").includes("<ContentLoadError"));

describe("⚠ every load-error site branches on 401 first", () => {
  it("finds the sites at all, so this test cannot pass by finding nothing", () => {
    expect(files.length, "expected several ContentLoadError sites").toBeGreaterThanOrEqual(5);
  });

  /**
   * ⚠ CHECKED PER SITE, NOT PER FILE, and a mutation is why. The first version asked whether the FILE
   * mentioned `isUnauthorized` anywhere; deleting the AI pane's 401 branch left two other mentions in that
   * file and the test still passed. That is the same "satisfied by the import line" failure that has bitten
   * this repo before. Each `<ContentLoadError` must have the decision in the code immediately preceding it.
   */
  const sites = files.flatMap((path) => {
    const src = readFileSync(path, "utf8");
    return [...src.matchAll(/<ContentLoadError/g)].map((m, i) => ({
      label: `${path.replace(SRC, "")} #${i + 1}`,
      /* The enclosing conditional and whatever branched before it. */
      before: src.slice(Math.max(0, m.index! - 1400), m.index!),
    }));
  });

  it("finds every individual site", () => {
    expect(sites.length, "one entry per ContentLoadError, not per file").toBeGreaterThanOrEqual(6);
  });

  it.each(sites.map((s) => [s.label, s.before]))(
    "%s is preceded by a 401 decision",
    (_label, before) => {
      /**
       * Three legitimate routes to the same decision, my first version accepted only one and failed the
       * board, chat and phases pages for being CORRECT:
       *
       *   gate.state === "expired"  the page-level gate, checked before its "failed" state
       *   isUnauthorized(...)       the file decides for a narrower path the gate does not cover
       *   sessionExpired            the decision arrives already made, for components handed
       *                             `error.message` as a STRING, which destroys the discriminator
       */
      const decided =
        /gate\.state === "expired"/.test(before) ||
        /isUnauthorized\(/.test(before) ||
        /sessionExpired \?/.test(before);

      expect(decided, "no 401 branch precedes this load-error site").toBe(true);
    }
  );

  /**
   * ⚠ WHERE THE GATE IS USED, `expired` MUST BE CHECKED BEFORE `failed`, and this is the property that makes
   * the gate an acceptable answer above. Both states come from the same gate; if the order were inverted a 401
   * would fall through to the load-failure branch and the bug would be back with every file still "guarded".
   */
  it("checks expired before failed wherever the gate decides", () => {
    for (const path of files) {
      const src = readFileSync(path, "utf8");
      if (!src.includes('gate.state === "expired"')) continue;

      const expired = src.indexOf('gate.state === "expired"');
      const failed = src.indexOf('gate.state === "failed"');
      expect(failed, `${path.replace(SRC, "")} checks the gate's failed state`).toBeGreaterThan(-1);
      expect(expired, `${path.replace(SRC, "")} must check expired first`).toBeLessThan(failed);
    }
  });

  /**
   * ⚠ NOBODY MAY STRING-MATCH THE STATUS. "Backend error: 401" is a message, not a contract, the same trap as
   * comparing errors with `instanceof` across two copies of tRPC. One predicate, in one place.
   */
  it("nobody detects a 401 by matching the message text", () => {
    for (const path of files) {
      const src = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, `${path.replace(SRC, "")} string-matches a status`).not.toMatch(
        /includes\(["']Backend error: 401|match\(\/.*401/
      );
    }
  });
});

// ── ⚠ ONE HANDLER FOR EVERY SERVICE CALL ─────────────────────────────────────────────────
//
// THE REQUIREMENT: every service call on the portal redirects the user to the login page on a 401.
//
// The old mechanism lived in React Query's `retry` callback, which is consulted only when a retry is being
// DECIDED, so a query with `retry: false`, or any mutation, produced a 401 that nothing acted on. The
// redirect was reachable by most calls and guaranteed for none.
describe("⚠ the 401 redirect is a property of the client, not a habit per call site", () => {
  const providers = readFileSync(
    fileURLToPath(new URL("../components/providers.tsx", import.meta.url)),
    "utf8"
  );

  it("handles every query failure, whatever the call site configured", () => {
    expect(providers).toMatch(/queryCache:\s*new QueryCache\(\{[\s\S]{0,200}?onError/);
    expect(providers).toMatch(/queryCache[\s\S]{0,240}?isUnauthorized\(error\)\) evictExpiredSession\(\)/);
  });

  /** ⚠ MUTATIONS TOO. A 401 on a write is the same expired session, and `retry` never covered them. */
  it("handles every mutation failure as well", () => {
    expect(providers).toMatch(/mutationCache:\s*new MutationCache\(\{[\s\S]{0,200}?onError/);
    expect(providers).toMatch(/mutationCache[\s\S]{0,240}?isUnauthorized\(error\)\) evictExpiredSession\(\)/);
  });

  /**
   * The `retry` branch stays, not for the eviction, but because retrying a 401 buys three refusals in the
   * service's logs and delays the screen by two round trips.
   */
  it("still refuses to retry a 401", () => {
    const retry = providers.slice(providers.indexOf("retry: (failureCount"), providers.indexOf("retry: (failureCount") + 300);
    expect(retry).toMatch(/isUnauthorized\(error\)/);
    expect(retry).toMatch(/return false/);
  });

  /** Eviction must be idempotent: several queries failing at once must not fire several sign-outs. */
  it("guards against firing more than once", () => {
    expect(providers).toMatch(/if \(evicting\) return;/);
  });
});
