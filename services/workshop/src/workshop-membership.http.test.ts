import { describe, it, expect, afterEach, vi } from "vitest";
import { EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";
import { HttpWorkshopMembership } from "./workshop-membership.http.js";
import type { AuthContext } from "./authz.js";

/**
 * HttpWorkshopMembership is the membership branch of the workshop READ gate, and the
 * only place a workshop read crosses a service boundary.
 *
 * Its contract is THREE-VALUED, and that is the whole point of the class: `false` means
 * "the Team service told us no", while `"unavailable"` means "the Team service did not
 * tell us anything". Both deny the read — this is still fail-closed — but only the
 * first justifies a 403. Collapsing them would turn every brownout into "you don't
 * have access", a message that is untrue and that sends users to support instead of
 * showing them a retry.
 *
 * So the tests below are mostly a mapping table from wire outcome → verdict. Getting a
 * cell wrong is silent in production: either participants are told they lack access
 * they actually have, or a 503 storm is mislabelled as a permissions problem.
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

const client = () => new HttpWorkshopMembership("http://team.test/v1");

describe("HttpWorkshopMembership", () => {
  // ─── The mapping table ────────────────────────────────────────────────────

  it("returns TRUE only for an explicit isMember: true", async () => {
    stubFetch(() => json({ isMember: true }));
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(true);
  });

  it("returns FALSE for an explicit isMember: false — Team answered, and said no", async () => {
    stubFetch(() => json({ isMember: false }));
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("returns FALSE for 401/403/404 — understood and refused, or the route isn't there", async () => {
    // These are definite "not yes" answers: the request was understood. A 404 in
    // particular means this deployment has no membership route, which is a
    // configuration fact rather than a transient failure.
    for (const status of [401, 403, 404]) {
      stubFetch(() => json({ isMember: true }, status));
      expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("returns UNAVAILABLE for a 5xx — the callee is broken, not the caller unauthorized", async () => {
    for (const status of [500, 502, 503, 504]) {
      stubFetch(() => json({ isMember: true }, status));
      expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(
        "unavailable"
      );
      vi.restoreAllMocks();
    }
  });

  it("returns UNAVAILABLE for a 429 — a throttle is a retry, never a denial", async () => {
    stubFetch(() => json({ error: "slow down" }, 429));
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(
      "unavailable"
    );
  });

  it("returns UNAVAILABLE when the Team service is unreachable", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(
      "unavailable"
    );
  });

  it("returns UNAVAILABLE when the deadline fires", async () => {
    // The failure this whole timeout exists for: a callee that is slow rather than
    // down. It must surface as "we don't know" (→ 503), not as a denial.
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(
      "unavailable"
    );
  });

  it("returns UNAVAILABLE for a 200 whose body is not the expected shape", async () => {
    // An error envelope, a proxy's HTML page, or a field of the wrong type is not an
    // answer. It must never read as a grant, and must not be reported as a denial
    // either — the caller genuinely did not learn anything.
    for (const body of [{}, { isMember: "yes" }, { isMember: 1 }, { isMember: null }]) {
      stubFetch(() => json(body));
      expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(
        "unavailable"
      );
      vi.restoreAllMocks();
    }

    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 200 }));
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).toBe(
      "unavailable"
    );
  });

  it("never treats a truthy non-boolean as membership", async () => {
    // Deliberately stricter than HttpTeamAccess's `!!data.canRead`. This decides
    // whether an unrelated user reads a workshop, so only a real boolean counts.
    stubFetch(() => json({ isMember: "true" }));
    expect(await client().isMember("w1", "u1", "PARTICIPANT", withBearer())).not.toBe(true);
  });

  // ─── The request it makes ─────────────────────────────────────────────────

  it("calls the Team service's OWN membership route, url-encoding the workshop id", async () => {
    // The boundary rule: Workshop asks Team through Team's API, never reads
    // teams/teamMembers. The path shape is that contract.
    const spy = stubFetch(() => json({ isMember: true }));
    await client().isMember("w 1/../x", "u1", "PARTICIPANT", withBearer());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      "http://team.test/v1/workshops/w%201%2F..%2Fx/membership"
    );
  });

  it("puts NO userId in the URL — the callee keys on the token's own subject", async () => {
    // A membership probe that accepts a subject is an enumeration oracle for "who is in
    // which workshop". The user id travels only in the internal-hop headers, never as a
    // query parameter.
    const spy = stubFetch(() => json({ isMember: true }));
    await client().isMember("w1", "u-77", "PARTICIPANT", withBearer());

    const url = String(spy.mock.calls[0][0]);
    expect(url).not.toContain("u-77");
    expect(url).not.toContain("userId");
    expect(url).not.toContain("?");
  });

  it("re-presents the CALLER's own bearer token", async () => {
    // TEAM_SERVICE_URL is the public API, where every route sits behind the Cognito JWT
    // authorizer — a tokenless hop is 401'd before Team's Lambda runs. Forwarding the
    // caller's token also means the hop cannot express authority the caller lacked.
    const spy = stubFetch(() => json({ isMember: true }));
    await client().isMember("w1", "u1", "PARTICIPANT", withBearer());

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(Object.keys(headers)).toEqual(["authorization"]);
  });

  it("passes an AbortSignal with the east-west deadline", async () => {
    // Workshop reads are a page-render path, so an unbounded wait here holds one
    // Workshop Lambda per waiter for the full 29s gateway timeout.
    const spy = stubFetch(() => json({ isMember: true }));
    await client().isMember("w1", "u1", "PARTICIPANT", withBearer());

    const { signal } = spy.mock.calls[0][1] as RequestInit;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
    expect(EAST_WEST_TIMEOUT_MS).toBeLessThan(29_000);
  });

  it("falls back to internal-hop headers when the caller had no bearer", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
    const spy = stubFetch(() => json({ isMember: true }));
    try {
      await client().isMember(
        "w1",
        "u-77",
        "PARTICIPANT",
        ctx({ "x-internal-token": "test-internal-token", "x-identity-id": "u-77" })
      );
    } finally {
      delete process.env.INTERNAL_SERVICE_TOKEN;
    }

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-identity-id"]).toBe("u-77");
    expect(headers["x-identity-role"]).toBe("PARTICIPANT");
    expect(headers.authorization).toBeUndefined();
  });

  // ─── Short-circuits that make no request at all ───────────────────────────

  it("returns FALSE for an empty workshop id without calling anything", async () => {
    // Nothing to ask about — a definite no, not a failure.
    const spy = stubFetch(() => json({ isMember: true }));
    expect(await client().isMember("", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns UNAVAILABLE (not false) with no request when there is no Context", async () => {
    // No Context ⇒ no token to re-present ⇒ the gateway would 401 the call, so we
    // genuinely cannot find out. Reporting `false` here would silently 403 every
    // participant on a misconfigured hop and look like a permissions bug; 503 points at
    // the real cause. It must also not fall back to a forgeable header-only hop.
    const spy = stubFetch(() => json({ isMember: true }));
    expect(await client().isMember("w1", "u1", "PARTICIPANT")).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("defaults its base URL from TEAM_SERVICE_URL", async () => {
    const previous = process.env.TEAM_SERVICE_URL;
    process.env.TEAM_SERVICE_URL = "http://from-env/v1";
    const spy = stubFetch(() => json({ isMember: true }));
    try {
      await new HttpWorkshopMembership().isMember("w1", "u1", "PARTICIPANT", withBearer());
    } finally {
      if (previous === undefined) delete process.env.TEAM_SERVICE_URL;
      else process.env.TEAM_SERVICE_URL = previous;
    }

    expect(String(spy.mock.calls[0][0])).toBe("http://from-env/v1/workshops/w1/membership");
  });
});

describe("NoWorkshopMembership", () => {
  it("answers FALSE definitively, not 'unavailable'", async () => {
    // Wiring it means "this deployment has no membership source" — a definite, if
    // restrictive, answer. Returning "unavailable" would 503 every participant read and
    // look like a permanent incident.
    const { NoWorkshopMembership } = await import("./authz.js");
    expect(await new NoWorkshopMembership().isMember()).toBe(false);
  });
});
