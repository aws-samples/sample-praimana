import { describe, it, expect, afterEach, vi } from "vitest";
import { EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";
import { HttpWorkshopEntitlements } from "./workshop-entitlements.http.js";
import { NoWorkshopEntitlements, type AuthContext } from "./authz.js";

/**
 * `HttpWorkshopEntitlements` — the east-west client the judge-scoping guard reads
 * (BACKLOG P0-3).
 *
 * ── THE ONE PROPERTY THIS FILE EXISTS FOR ──
 *
 * "Could not determine" must never be returned as "you are entitled to nothing." For a
 * JUDGE the two are catastrophically different: an empty set means every score POST is
 * refused with "you are not judging this workshop", which a judge mid-judging would
 * reasonably read as their invitation having been revoked. It is the same class of defect as
 * the 403 that said "not the owner" when an ownership probe had timed out, which cost a full
 * day of debugging — and it is why EVERY non-2xx here is "unavailable",
 * including 404 and 403.
 *
 * ⚠ THIS IS A DELIBERATE SECOND COPY of workshop/src/workshop-entitlements.http.ts, against
 * the same route with the same contract. If the failure table below stops matching that
 * file's tests, one of the two services is wrong.
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

describe("HttpWorkshopEntitlements", () => {
  it("calls GET /entitlements/workshops with NO subject parameter at all", async () => {
    // The callee keys BOTH halves of the union on the
    // caller's own verified claims. A userId or email parameter would make this an
    // enumeration oracle for "who can see which workshop", so its ABSENCE is the assertion —
    // not merely that the interface has no such argument, but that the URL carries none.
    const spy = stubFetch(() => json({ workshopIds: ["w1"], truncated: false }));
    await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
      "JUDGE",
      withBearer()
    );

    const url = String(spy.mock.calls[0][0]);
    expect(url).toBe("http://team.test/v1/entitlements/workshops");
    expect(url).not.toContain("userId");
    expect(url).not.toContain("email");
    expect(url).not.toContain("?");
  });

  it("re-presents the caller's bearer token and bounds the call in time", async () => {
    const spy = stubFetch(() => json({ workshopIds: [], truncated: false }));
    await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
      "JUDGE",
      withBearer()
    );

    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${BEARER}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(EAST_WEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("returns the ids and the truncation flag on a well-formed 200", async () => {
    stubFetch(() => json({ workshopIds: ["w1", "w2"], truncated: true }));
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toEqual({ workshopIds: ["w1", "w2"], truncated: true });
  });

  it("treats a DETERMINED empty list as an answer, not as a failure", async () => {
    // A judge invited to nothing genuinely has none, and that is a 200 with `[]`. The guard
    // turns it into a 403 — which is correct — so it must be distinguishable from the 503
    // cases below.
    stubFetch(() => json({ workshopIds: [], truncated: false }));
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toEqual({ workshopIds: [], truncated: false });
  });

  it("drops non-string and empty ids rather than passing them to a scope comparison", async () => {
    // A `null` or `0` surviving into the array would be compared against a submission's
    // workshopId. Filtering at the boundary keeps the guard's `includes` honest.
    stubFetch(() => json({ workshopIds: ["w1", "", null, 7, {}, "w2"], truncated: false }));
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toEqual({ workshopIds: ["w1", "w2"], truncated: false });
  });

  it("defaults truncated to FALSE for anything that is not literally true", async () => {
    stubFetch(() => json({ workshopIds: ["w1"], truncated: "yes" }));
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toEqual({ workshopIds: ["w1"], truncated: false });
  });

  // ── EVERY UNDETERMINED CASE IS "unavailable" ────────────────────────────────

  it("reports UNAVAILABLE for every non-2xx, INCLUDING 404 and 403", async () => {
    // 404 diverges from HttpWorkshopMembership's reading on purpose: this route being
    // unmapped is the expected transient state of a rolling deploy (TEAM FIRST), and
    // reading it as "no entitlements" would refuse every judge with no error signal
    // anywhere. A 401/403 means the hop itself is broken — there is no legitimate reading in
    // which a caller's own entitlement list is forbidden to them.
    for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
      stubFetch(() => json({ error: "nope" }, status));
      expect(
        await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
          "JUDGE",
          withBearer()
        )
      ).toBe("unavailable");
    }
  });

  it("reports UNAVAILABLE on a connect error and on a timeout abort", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toBe("unavailable");

    stubFetch(() => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toBe("unavailable");
  });

  it("reports UNAVAILABLE for a 200 carrying an unrecognised body", async () => {
    // An error envelope, an HTML page from a misrouted gateway, a missing array. None may
    // read as a determined empty list — that is indistinguishable from "you may score
    // nothing".
    for (const body of [{}, { error: "boom" }, { workshopIds: "w1" }, { workshopIds: null }]) {
      stubFetch(() => json(body));
      expect(
        await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
          "JUDGE",
          withBearer()
        )
      ).toBe("unavailable");
    }

    stubFetch(
      () =>
        new Response("<html>502</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })
    );
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds(
        "JUDGE",
        withBearer()
      )
    ).toBe("unavailable");
  });

  it("reports UNAVAILABLE with NO Context, without making a request", async () => {
    const spy = stubFetch(() => json({ workshopIds: ["w1"], truncated: false }));
    expect(
      await new HttpWorkshopEntitlements("http://team.test/v1").listEntitledWorkshopIds("JUDGE")
    ).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("NoWorkshopEntitlements", () => {
  it("answers a DETERMINED empty set, never 'unavailable'", async () => {
    // Wiring this is a CONFIGURATION choice, which is a definite if restrictive answer.
    // Reporting "unavailable" would 503 every scoring attempt forever and look like a
    // permanent incident. Mirrors NoWorkshopMembership's reasoning exactly.
    expect(await new NoWorkshopEntitlements().listEntitledWorkshopIds()).toEqual({
      workshopIds: [],
      truncated: false,
    });
  });
});
