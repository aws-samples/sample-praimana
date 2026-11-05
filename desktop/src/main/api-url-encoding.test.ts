// ── ⚠ NO UNENCODED SEGMENT IN AN AUTHENTICATED URL, EVER AGAIN ──────────────────────────────────
//
// Main is deliberately the only holder of the Cognito bearer: the token keys are on neither settings
// allowlist, no IPC response returns one, and `fetchAuthed` is the single place the header is attached. The
// renderer is therefore meant to reach only the endpoints main chooses to expose.
//
// Eight `fetch` sites broke that by interpolating a caller-chosen id straight into the path. The
// exploit needs no encoding trick, because `fetch` hands the string to the WHATWG URL parser:
//
//     `${url}/v1/ai/threads/${threadId}/messages`   with threadId = "x/../../../v1/auth/me?z="
//       →  GET https://api…/v1/auth/me              with the victim's bearer attached
//
// ── WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOURAL TEST ──
//
// The defect was never in one handler's logic — it was a rule that held in `team-data.ts` (which has
// always wrapped every segment) and was simply not known in the other five modules. A test per site
// would pass while the NEXT handler someone writes reintroduces it. What has to be pinned is the
// invariant across the module, so this reads the sources the way a reviewer would and fails on the
// pattern rather than on an outcome.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const HANDLERS = path.join(__dirname, "handlers");

/**
 * Interpolations that are legitimately not `encodeURIComponent`.
 *
 * ⚠ THE FIRST INTERPOLATION IN A URL IS THE ORIGIN, and encoding it would break the URL — `https://`
 * would become `https%3A%2F%2F`. The origin is main-authoritative (it comes from the validated
 * platform config, and `server_url` is on neither renderer allowlist), which is what makes leaving it
 * raw safe and is why this review classified the finding as request FORGERY inside the platform API
 * rather than arbitrary-host SSRF.
 */
const ORIGIN_EXPRESSIONS = new Set([
  "url",
  "serverUrl",
  "ctx.url",
  "toWsOrigin(url)",
  "platform.apiBaseUrl",
]);

/**
 * Non-origin interpolations that carry no caller-controlled path text.
 *
 * Kept as an explicit, tiny list rather than a pattern: every entry is a decision, and a regex like
 * "anything ending in Limit" is how the next unsafe value slips through.
 */
const SAFE_EXPRESSIONS = new Set([
  "MESSAGE_PAGE_LIMIT",
  "qs.toString()",
  // A pre-encoded query string ("" or "?a=b…") built from URLSearchParams, appended AFTER the path.
  // It carries no path text, and its contents are already percent-encoded by URLSearchParams.
  "query",
]);

interface Interpolation {
  file: string;
  literal: string;
  expression: string;
  isFirst: boolean;
}

/**
 * The source with COMMENTS REMOVED.
 *
 * ⚠ NOT COSMETIC. This codebase documents a finding by quoting the defective URL, so the prose
 * beside each fix contains exactly the pattern this test looks for — the scan would fail on its own
 * explanation of why it exists. Only block comments and whole-line `//` comments are stripped: a
 * trailing `//` cannot be removed safely because `https://` contains one.
 */
function withoutComments(source: string): string {
  let inBlock = false;
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        return "";
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlock = true;
        return "";
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return "";
      return line;
    })
    .join("\n");
}

/** Every `${…}` inside every backtick literal that names a `/v1/` path, across the handlers. */
function interpolationsInApiUrls(): Interpolation[] {
  const found: Interpolation[] = [];
  for (const name of fs.readdirSync(HANDLERS)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const source = withoutComments(fs.readFileSync(path.join(HANDLERS, name), "utf8"));
    for (const literal of source.match(/`[^`]*\/v1\/[^`]*`/g) ?? []) {
      const expressions = [...literal.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
      expressions.forEach((expression, i) => {
        found.push({ file: name, literal, expression, isFirst: i === 0 });
      });
    }
  }
  return found;
}

describe("authenticated API URLs", () => {
  it("finds the URL literals to check, so a broken scanner cannot pass vacuously", () => {
    const all = interpolationsInApiUrls();
    // If a refactor moves these URLs somewhere this scan cannot see, that is a failure of the test,
    // and it must say so rather than reporting success over an empty list.
    expect(all.length).toBeGreaterThan(20);
    expect(new Set(all.map((i) => i.file)).size).toBeGreaterThan(3);
  });

  it("encodes every interpolated path segment", () => {
    const offenders = interpolationsInApiUrls()
      .filter((i) => !(i.isFirst && ORIGIN_EXPRESSIONS.has(i.expression)))
      .filter((i) => !SAFE_EXPRESSIONS.has(i.expression))
      .filter((i) => !i.expression.includes("encodeURIComponent"))
      .map((i) => `${i.file}: \${${i.expression}} in ${i.literal}`);

    expect(
      offenders,
      "each of these puts a caller-influenced value into an authenticated URL path — wrap it in " +
        "encodeURIComponent, or add it to SAFE_EXPRESSIONS with the reason it carries no path text"
    ).toEqual([]);
  });

  /**
   * ⚠ AND THE BEARER STAYS IN THE HEADER. A separate finding in the same review: the ID token was
   * also copied into the event-stream URL's query string, where it lands in proxy and load-balancer
   * access logs. Pinned here because it is the same class of mistake — a credential-bearing request
   * whose URL carries something it should not.
   */
  it("never puts a token in a URL", () => {
    for (const name of fs.readdirSync(HANDLERS)) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      const source = withoutComments(fs.readFileSync(path.join(HANDLERS, name), "utf8"));
      for (const literal of source.match(/`[^`]*`/g) ?? []) {
        expect(literal, `${name} must not carry a token in a URL`).not.toMatch(
          /[?&]token=\$\{/
        );
      }
    }
  });
});
