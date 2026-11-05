import { describe, it, expect, afterEach, vi } from "vitest";
import { EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";
import { HttpTeamAccess } from "./team-access.http.js";
import type { AuthContext } from "./authz.js";

/**
 * `HttpTeamAccess.writeScope` — the east-west client behind the server-derived scope, BACKLOG P0-3.
 *
 * ── WHY THIS FILE EXISTS AND WHAT IT PROTECTS ──
 *
 * The four boolean methods are fail-CLOSED: anything that is not an explicit `true` is a
 * denial, and a route test cannot tell the difference between "Team said no" and "we could
 * not ask" because both produce a 403. `writeScope` MUST tell them apart, because the
 * `workshopId` it returns is about to be PERSISTED as the scope every later authorization
 * decision about that submission rests on. A row stored with `workshopId: null` is
 * permanently unscoreable — the scoring guard refuses null scopes with
 * SUBMISSION_SCOPE_UNKNOWN and cannot do otherwise — so collapsing a failed hop into a
 * determined `null` turns a two-second Team brownout into a data-repair task.
 *
 * The distinction lives entirely in this file's `"unavailable"` versus `{ workshopId: null }`
 * returns, and in ONE `in` operator (`"workshopId" in data`) that a `?? null` would silently
 * replace. Neither is visible from a route-level fake.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) => impl(String(url), init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The inbound Hono Context, reduced to the one thing this client reads: the headers. */
function ctx(headers: Record<string, string>): AuthContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as AuthContext;
}

const BEARER = "header.payload.signature";
const withBearer = () => ctx({ authorization: `Bearer ${BEARER}` });

describe("HttpTeamAccess.writeScope — the decision AND the scope, from one hop", () => {
  it("asks the SAME /access route with ?withWorkshop=1 — no second endpoint", async () => {
    // The "no new hop" requirement, asserted as a URL. If this ever called a separate
    // route, the create path would make two east-west calls to learn one thing.
    const spy = stubFetch(() => json({ canWrite: true, workshopId: "w1" }));
    await new HttpTeamAccess("http://team.test/v1").writeScope(
      "t1",
      "u1",
      "PARTICIPANT",
      withBearer()
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      "http://team.test/v1/teams/t1/access?withWorkshop=1"
    );
  });

  it("does NOT send withWorkshop on the four boolean methods", async () => {
    // The parameter costs Team an extra store read, and four of the five callers have no use
    // for the workshop. Asserting the ABSENCE is what keeps this change inert for the
    // submission reads and the rating routes.
    const spy = stubFetch(() =>
      json({ canRead: true, canWrite: true, canReadContent: true, canWriteContent: true })
    );
    const access = new HttpTeamAccess("http://team.test/v1");
    await access.canRead("t1", "u1", "PARTICIPANT", withBearer());
    await access.canWrite("t1", "u1", "PARTICIPANT", withBearer());
    await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer());
    await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer());

    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain("withWorkshop");
    }
  });

  it("re-presents the CALLER's bearer token and bounds the call in time", async () => {
    // Same two properties as every other east-west call in this repo: the callee re-derives
    // the identity from verified claims (a tokenless internal hop is 401'd by the gateway),
    // and the wait is bounded so a slow-but-successful Team cannot pin this Lambda for the
    // full 29s gateway timeout.
    const spy = stubFetch(() => json({ canWrite: true, workshopId: "w1" }));
    await new HttpTeamAccess("http://team.test/v1").writeScope(
      "t1",
      "u1",
      "PARTICIPANT",
      withBearer()
    );

    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${BEARER}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The ceiling is the shared constant, never a local literal.
    expect(EAST_WEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("returns the workshop and the write decision on a well-formed 200", async () => {
    stubFetch(() => json({ canWrite: true, workshopId: "w-real" }));
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toEqual({ canWrite: true, workshopId: "w-real" });
  });

  it("keeps a FALSE write decision even when a workshop comes back", async () => {
    // Team returns `workshopId: null` for a refused caller, but a consumer must not infer
    // the decision from the scope or vice versa — they are two independent fields.
    stubFetch(() => json({ canWrite: false, workshopId: "w-real" }));
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toEqual({ canWrite: false, workshopId: "w-real" });
  });

  it("reports a DETERMINED null when Team says the team has no workshop", async () => {
    // Distinct from "unavailable": Team answered, and the answer is "none". The route turns
    // this into a 404, not a 503.
    stubFetch(() => json({ canWrite: true, workshopId: null }));
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toEqual({ canWrite: true, workshopId: null });
  });

  // ── THE ROLLING-DEPLOY GUARANTEE: ABSENT IS NOT NULL ──────────────────────

  it("reports UNAVAILABLE when the field is ABSENT — an older Team, not an empty scope", async () => {
    // ⚠ THE MOST IMPORTANT ASSERTION IN THIS FILE. An older Team service ignores the query
    // parameter and omits the key entirely. `data.workshopId ?? null` would read that as
    // "this team has no workshop" and the route would 404 every submission create — or
    // worse, a future edit that stored it would write a permanently-unscoreable row on
    // every create until Team caught up. The implementation tests the KEY's presence
    // (`"workshopId" in data`), and this is what pins that choice.
    stubFetch(() => json({ canRead: true, canWrite: true, canReadContent: true }));
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toBe("unavailable");
  });

  it("reports UNAVAILABLE for a workshopId that is neither a string nor null", async () => {
    // A number, an object, an empty string. Coercing any of them would put unvalidated data
    // into a field that is about to become a stored authorization scope.
    for (const workshopId of [42, {}, [], "", true]) {
      stubFetch(() => json({ canWrite: true, workshopId }));
      expect(
        await new HttpTeamAccess("http://team.test/v1").writeScope(
          "t1",
          "u1",
          "PARTICIPANT",
          withBearer()
        )
      ).toBe("unavailable");
    }
  });

  // ── EVERY FAILURE IS "UNAVAILABLE", NEVER A DENIAL AND NEVER A NULL SCOPE ──

  it("reports UNAVAILABLE for every non-2xx, including 401/403/404", async () => {
    // Unlike the four boolean methods, a non-2xx here is NOT a denial. There is no status on
    // this route that means "this team has no workshop" — that answer is a 200 with an
    // explicit null. A 404 in particular is the expected transient state of a rolling
    // deploy, which is why DEPLOY ORDER IS TEAM FIRST.
    for (const status of [400, 401, 403, 404, 500, 502, 503]) {
      stubFetch(() => json({ error: "nope" }, status));
      expect(
        await new HttpTeamAccess("http://team.test/v1").writeScope(
          "t1",
          "u1",
          "PARTICIPANT",
          withBearer()
        )
      ).toBe("unavailable");
    }
  });

  it("reports UNAVAILABLE on a connect error, an abort, and a non-JSON body", async () => {
    // A timeout aborts the fetch, so it lands in the same catch as a connect error —
    // identical semantics, bounded wait.
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toBe("unavailable");

    stubFetch(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toBe("unavailable");

    // An HTML error page from a misrouted gateway must not read as a determined answer.
    stubFetch(
      () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope(
        "t1",
        "u1",
        "PARTICIPANT",
        withBearer()
      )
    ).toBe("unavailable");
  });

  it("reports UNAVAILABLE with NO Context — it did not ask, so it does not know", async () => {
    // The four boolean methods return DENY_ALL here, correctly: no token means the gateway
    // would 401 the call. This one must not, because a denial and an unasked question
    // demand different responses (403 vs 503) and only one of them is honest.
    const spy = stubFetch(() => json({ canWrite: true, workshopId: "w1" }));
    expect(
      await new HttpTeamAccess("http://team.test/v1").writeScope("t1", "u1", "PARTICIPANT")
    ).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("URL-encodes the teamId — a path segment is never interpolated raw", async () => {
    const spy = stubFetch(() => json({ canWrite: false, workshopId: null }));
    await new HttpTeamAccess("http://team.test/v1").writeScope(
      "t/../../admin",
      "u1",
      "PARTICIPANT",
      withBearer()
    );
    expect(String(spy.mock.calls[0][0])).toBe(
      "http://team.test/v1/teams/t%2F..%2F..%2Fadmin/access?withWorkshop=1"
    );
  });
});
