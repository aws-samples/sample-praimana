// ── ⚠ THE NET UNDER ~20 CALL SITES THAT EACH HAVE TO REMEMBER TO ENCODE ──────────────────────
//
// A code review found that roughly twenty `backendFetch` callers spliced a caller-supplied
// identifier into the path, and while eleven of them called `encodeURIComponent`, several did not.
// Every site is encoded now — that is the fix. `assertSafeBackendPath` is the SECOND line, and it
// exists because the first line is a convention rather than a mechanism: the next route added
// without encoding should fail here instead of quietly becoming a request to a different place.
//
// The attack it closes, verbatim from the report: `teamId = "../../v1/admin/cost?x="` turns the
// intended `GET /v1/teams/<id>/tasks` into `GET /v1/admin/cost`, carrying the caller's own bearer
// token, with the non-2xx body forwarded back — "a probe-and-read oracle for the internal surface".
// The WHATWG URL parser does that collapsing inside `fetch`, so the string has to be refused
// BEFORE it gets there.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { assertSafeBackendPath, BackendError } from "./backend";
import { sourceWithoutComments } from "./source-under-test";

/** What the guard did, expressed as a value so each case reads as one line. */
function verdict(path: string): "allowed" | string {
  try {
    assertSafeBackendPath(path);
    return "allowed";
  } catch (err) {
    if (err instanceof BackendError) return err.code ?? "no-code";
    throw err;
  }
}

describe("assertSafeBackendPath — what it refuses", () => {
  /**
   * ⚠ THE HEADLINE CASE, AND THE ONE THE REPORT DEMONSTRATED. `..` segments are collapsed by the
   * URL parser, so this is not "an id containing dots" — it is a different route.
   */
  it("refuses a path that climbs out of its route with `..`", () => {
    expect(verdict("/v1/teams/../../v1/admin/cost/tasks")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/..%2F../tasks")).toBe("allowed"); // encoded SLASH: data, not structure
    expect(verdict("/v1/../admin")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/./admin")).toBe("INVALID_BACKEND_PATH");
  });

  /**
   * ⚠ THE THREE ENCODINGS THIS GUARD ORIGINALLY LET THROUGH. A security scan demonstrated them and
   * I reproduced each: every one passed the literal `.`/`..` check and was then collapsed by the
   * WHATWG parser inside `fetch` to exactly `/v1/admin/cost` — the same read the headline case
   * above was written to stop, spelled the way somebody trying would actually spell it.
   *
   * This is the half the first version of this file missed: it asserted the obvious spelling and
   * stopped, so a guard that existed to be a net had holes in the two encodings that matter.
   */
  it("⚠ REFUSES PERCENT-ENCODED DOT SEGMENTS — `%2e` is a dot to the URL parser", () => {
    // The parser decodes %2e BEFORE resolving dot segments, so any mixture of spellings is one.
    expect(verdict("/v1/teams/%2e%2e/%2e%2e/v1/admin/cost")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/.%2e/.%2e/v1/admin/cost")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/%2e./v1/admin")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/%2e/tasks")).toBe("INVALID_BACKEND_PATH");
    // Case-insensitively: %2E is the same byte.
    expect(verdict("/v1/teams/%2E%2E/v1/admin")).toBe("INVALID_BACKEND_PATH");
  });

  it("⚠ REFUSES A BACKSLASH — `fetch` treats it as a path separator", () => {
    // The segment loop splits on "/" only, so `..\..\` arrived as one long innocent segment while
    // the parser read it as two levels up.
    expect(verdict("/v1/teams/..\\..\\v1/admin/cost")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams\\admin")).toBe("INVALID_BACKEND_PATH");
  });

  it("still allows a percent-encoded id that merely CONTAINS dots", () => {
    // The check must not refuse a legitimate identifier. `%2e` alone inside a longer segment is
    // data — only a segment that IS a dot segment once decoded is structure.
    expect(verdict("/v1/teams/v1%2e2%2e3/docs")).toBe("allowed");
    expect(verdict("/v1/teams/a.b.c/docs")).toBe("allowed");
  });

  it("refuses a PROTOCOL-RELATIVE path — it would change the host entirely", () => {
    // `//evil.example/x` resolves against the scheme, not the origin: the bearer token would be
    // sent to somebody else's server. This is the one failure mode where the damage is not
    // "wrong route" but "wrong party".
    expect(verdict("//evil.example/v1/teams")).toBe("INVALID_BACKEND_PATH");
  });

  it("refuses a path that is not absolute", () => {
    expect(verdict("v1/teams/t1")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("")).toBe("INVALID_BACKEND_PATH");
  });

  it("refuses a fragment, because it TRUNCATES rather than addresses", () => {
    // Everything after `#` never reaches the server, so a `#` in a server-side path means the
    // value was built from something that thought it was a browser URL — or is smuggling.
    expect(verdict("/v1/teams/t1#/../admin")).toBe("INVALID_BACKEND_PATH");
  });

  it("refuses an EMPTY segment — an absent id, not a real key", () => {
    // `/v1/teams//tasks` is what an unset identifier produces. Gateways disagree about whether to
    // collapse it, so the route actually matched stops being predictable.
    expect(verdict("/v1/teams//tasks")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/t1/")).toBe("INVALID_BACKEND_PATH");
  });

  it("refuses whitespace and control characters", () => {
    expect(verdict("/v1/teams/t 1")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/t1\n/admin")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/t1\r\nX-Injected: 1")).toBe("INVALID_BACKEND_PATH");
    expect(verdict("/v1/teams/t1\u0000")).toBe("INVALID_BACKEND_PATH");
  });

  it("refuses with a 400 and a machine-readable code, not an unhandled throw", () => {
    // It has to travel the same route as every other refusal: `mapBackendErrors` turns a
    // BackendError into the right tRPC code, and a bare Error would surface as a 500 instead.
    try {
      assertSafeBackendPath("/v1/../admin");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BackendError);
      expect((err as BackendError).status).toBe(400);
      expect((err as BackendError).code).toBe("INVALID_BACKEND_PATH");
    }
  });
});

describe("assertSafeBackendPath — what it must NOT refuse", () => {
  /**
   * ⚠ THE HALF THAT KEEPS THIS FROM BEING A BREAKING CHANGE. A guard that refuses real traffic
   * gets reverted, and then the defect comes back. Every shape below is one this app actually
   * sends, taken from the routers.
   */
  it("allows the ordinary encoded-identifier paths the routers build", () => {
    const real = [
      "/v1/workshops",
      "/v1/workshops/catalogue",
      "/v1/workshops/01KZVC9WVW4MBZS362BE6EPR0E",
      "/v1/teams/01KZW0JA2MEV3V455T76J2KTZ5/tasks",
      "/v1/teams/t1/messages?limit=50",
      "/v1/workshops/teams/t1/phases?workshopId=w1",
      "/v1/submissions/s1/scores",
      "/v1/teams/PLATFORM/invitations",
      "/v1/admin/users?limit=50&cursor=eyJmb28iOjF9",
    ];
    for (const path of real) expect(verdict(path), path).toBe("allowed");
  });

  it("allows a percent-encoded identifier that contains a slash", () => {
    // `trpc-team-queries.test.ts` asserts a teamId of "t/1#x" must arrive as `t%2F1%23x`
    // "because an id carrying a slash would change which route the gateway matched". Once
    // encoded it is data, and this guard must agree — otherwise the correct fix looks broken.
    expect(verdict("/v1/teams/t%2F1%23x/docs")).toBe("allowed");
  });

  it("⚠ ALLOWS `..` INSIDE A QUERY VALUE, because there it is data", () => {
    // Only the path portion is segment-checked. A search needle of ".." is a legitimate string
    // and refusing it would be a bug in the guard, not a defence.
    expect(verdict("/v1/teams/directory?search=..")).toBe("allowed");
    expect(verdict("/v1/teams/directory?search=a%20b")).toBe("allowed");
  });
});

describe("⚠ AND IT IS ACTUALLY WIRED IN", () => {
  /**
   * The function being correct is worth nothing if nobody calls it. Asserted on the SOURCE because
   * exercising it through `backendFetch` would need a live fetch; what matters is that the call sits
   * BEFORE the request is built, since a check after `fetch` protects nothing.
   */
  it("backendFetch asserts the path before it builds the request", () => {
    const src = sourceWithoutComments(join(__dirname, "backend.ts"));
    const guardAt = src.indexOf("assertSafeBackendPath(path);");
    const fetchAt = src.indexOf("await fetch(");
    expect(guardAt, "the guard must be called").toBeGreaterThan(-1);
    expect(fetchAt, "the fetch should still be there").toBeGreaterThan(-1);
    expect(guardAt, "the guard must come BEFORE the fetch").toBeLessThan(fetchAt);
  });
});
