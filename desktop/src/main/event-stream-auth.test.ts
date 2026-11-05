// ── ⚠ THE BEARER MUST NOT RIDE IN A URL ───────────────────────────────────────────────────────
//
// A URL is the least private part of a request — reverse-proxy and load-balancer access logs, APM traces and
// error reports all capture it, and none of them is treated as a credential store.
//
// This file pins the DESKTOP half: the token travels in the `Authorization` header and nowhere
// else, asserted over the whole main process rather than the one call site that was reported.
//
// ── ⚠ THE OTHER HALF OF THE CONTRACT IS NOT ASSERTED HERE, AND MUST NOT BE ────────────────────
//
// The change is only safe because the SERVER accepts a Bearer header on the upgrade — and that
// was worth checking rather than assuming, since the desktop's old comment claimed the server
// "prefers the header when present" when in fact the query param takes precedence. Had the
// header branch not existed, this change would have silently killed every realtime badge and
// notification.
//
// That check used to live here, reading `../../../services/collaboration/src/ws-server.ts`. It
// resolved OUTSIDE this repository, so it passed only where the repos happen to sit side by
// side; in this repo's own CI checkout the path did not exist, the read threw, and the failure
// took down the Validate gate that guards the publish pipeline. THIS REPO IS SELF-CONTAINED —
// no test here reads a file belonging to another repo.
//
// The assertion now lives in the repo that owns the file, where it is always present and where
// anyone editing `tokenFromRequest` is actually looking, and it pins observable BEHAVIOUR
// through a real upgrade rather than matching source text:
//
//     services/collaboration/src/ws-token-source.test.ts
//
// If the desktop's header carrier ever stops working, that is the file that fails.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const AI = readFileSync(local("./handlers/ai.ts"), "utf8");
const code = AI.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the desktop's event stream authorizes by header", () => {
  it("builds a URL with no query string at all", () => {
    const build = code.slice(code.indexOf("const wsUrl ="), code.indexOf("new WebSocket("));
    expect(build).toContain("/events`");
    expect(build, "no token in the URL").not.toMatch(/token=/);
    expect(build, "no query string at all").not.toContain("?");
  });

  it("passes the bearer as a header on the upgrade", () => {
    expect(code).toMatch(
      /new WebSocket\(wsUrl, \{\s*headers: \{ Authorization: `Bearer \$\{token\}` \},/
    );
  });

  it("leaks no token through any URL anywhere in main", () => {
    /**
     * The sweep, not just this call site. `?token=` was one instance of a pattern, and the same
     * mistake in a `fetch` URL would be just as loggable — so the guard is written over the whole
     * main process rather than the line that was reported.
     */
    expect(code).not.toMatch(/[?&]token=\$\{/);
    expect(code).not.toMatch(/[?&]access_token=/);
  });
});
