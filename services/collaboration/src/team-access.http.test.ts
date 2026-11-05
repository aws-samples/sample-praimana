import { describe, it, expect, afterEach, vi } from "vitest";
import {
  EAST_WEST_TIMEOUT_MS,
  EAST_WEST_TIMEOUT_DEFAULT_MS,
} from "@praimana/service-shared";
import { HttpTeamAccess } from "./team-access.http.js";
import type { AuthContext } from "./authz.js";

/**
 * HttpTeamAccess is the only place Collaboration crosses a service boundary on the
 * hot path, and it is the one component that decides access on the strength of a
 * NETWORK response. Its contract is therefore fail-CLOSED: any outcome that isn't
 * an explicit `true` from the Team service must be a denial. A regression that
 * fails open would grant every team to every caller whenever Team is down.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) =>
    impl(String(url), init)
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The inbound request's Hono Context, reduced to the one thing this client reads
 * from it: the caller's headers. Every call needs one, because the call is made AS
 * the caller — it re-presents their bearer token (see forwardedIdentityHeaders).
 */
function ctx(headers: Record<string, string>): AuthContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as AuthContext;
}

/** A caller who arrived over the normal north-south path, bearer token and all. */
const BEARER = "header.payload.signature";
const withBearer = () => ctx({ authorization: `Bearer ${BEARER}` });

describe("HttpTeamAccess", () => {
  it("reads canRead/canWrite from the Team service response", async () => {
    stubFetch(() => json({ canRead: true, canWrite: false }));
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canRead("t1", "u1", "EXECUTIVE", withBearer())).toBe(true);
    expect(await access.canWrite("t1", "u1", "EXECUTIVE", withBearer())).toBe(false);
  });

  // ── the CONTENT pair, and the fields must not be confused ──────────

  it("reads canReadContent/canWriteContent as SEPARATE fields from the wide pair", async () => {
    // ── THE DRIFT ASSERTION FOR THIS CONSUMER ──
    //
    // The response deliberately has the two pairs DISAGREEING — wide true, content false —
    // which is exactly what the Team service answers for a non-member ADMIN or a
    // workshop-owning FACILITATOR. A client that read the content methods off `canRead`
    // (a plausible copy-paste) would return true here and hand that caller the team's board,
    // chat, AI threads and code.
    stubFetch(() =>
      json({
        canRead: true,
        canWrite: true,
        canReadContent: false,
        canWriteContent: false,
      })
    );
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canRead("t1", "admin", "ADMIN", withBearer())).toBe(true);
    expect(await access.canWrite("t1", "admin", "ADMIN", withBearer())).toBe(true);
    expect(await access.canReadContent("t1", "admin", "ADMIN", withBearer())).toBe(false);
    expect(await access.canWriteContent("t1", "admin", "ADMIN", withBearer())).toBe(false);
  });

  it("reads the content pair as TRUE for a member, independently of the wide pair", async () => {
    // The inverse direction, so neither field can be a hard-coded constant.
    stubFetch(() =>
      json({
        canRead: true,
        canWrite: true,
        canReadContent: true,
        canWriteContent: true,
      })
    );
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
    expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
  });

  it("DENIES content when the field is ABSENT — the rolling-deploy case", async () => {
    // ── WHY THE DEPLOY ORDER IS TEAM FIRST ──
    //
    // This is the response an OLDER Team service sends: the wide pair only. `!!undefined` is
    // false, so a consumer deployed ahead of Team denies every legitimate member's content
    // rather than over-granting. That is the correct direction and it is the reason the
    // fields were ADDED instead of `canRead` being redefined — but it also means shipping
    // consumers first would 403 every member until Team caught up.
    stubFetch(() => json({ canRead: true, canWrite: true }));
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    // …while the wide pair still reads correctly, so an unmigrated ROUTE keeps working.
    expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
  });

  it("denies ALL FOUR when the Team service returns a non-2xx", async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      stubFetch(() =>
        json(
          {
            canRead: true,
            canWrite: true,
            canReadContent: true,
            canWriteContent: true,
          },
          status
        )
      );
      const access = new HttpTeamAccess("http://team.test/v1");
      expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
      expect(await access.canWrite("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
      expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(
        false
      );
      expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(
        false
      );
      vi.restoreAllMocks();
    }
  });

  it("denies ALL FOUR when the call throws (Team service unreachable)", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const access = new HttpTeamAccess("http://team.test/v1");

    // The fail-closed guarantee. An outage must degrade to "no access", never to
    // "all access".
    expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWrite("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("denies all four when the deadline fires", async () => {
    // A timeout is "we do not know", and this client's answer to that is and must remain
    // "denied" — for the content pair as much as the wide one.
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const access = new HttpTeamAccess("http://team.test/v1");
    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("denies when the body is missing the flags entirely", async () => {
    // A 200 with an unexpected shape (an error envelope, an HTML page from a
    // misrouted gateway) must not read as permission.
    stubFetch(() => json({}));
    const access = new HttpTeamAccess("http://team.test/v1");
    expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWrite("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("denies the content pair on a body that is not JSON at all", async () => {
    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 200 }));
    const access = new HttpTeamAccess("http://team.test/v1");
    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("denies the content pair WITHOUT a call when there is no request context", async () => {
    const spy = stubFetch(() =>
      json({ canRead: true, canWrite: true, canReadContent: true, canWriteContent: true })
    );
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canReadContent("t1", "u1", "ADMIN")).toBe(false);
    expect(await access.canWriteContent("t1", "u1", "ADMIN")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("coerces truthy-but-not-true values to real booleans, on all four", async () => {
    stubFetch(() =>
      json({ canRead: "yes", canWrite: 1, canReadContent: "y", canWriteContent: 1 })
    );
    const access = new HttpTeamAccess("http://team.test/v1");
    expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
    expect(await access.canWrite("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
    expect(await access.canReadContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
    expect(await access.canWriteContent("t1", "u1", "PARTICIPANT", withBearer())).toBe(true);
  });

  it("denies on a body that is not JSON at all", async () => {
    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 200 }));
    const access = new HttpTeamAccess("http://team.test/v1");
    expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("calls the Team service's OWN /access endpoint, url-encoding the team id", async () => {
    // The boundary rule: Collaboration asks Team through Team's API. It must never
    // read teams/teamMembers directly. The path shape is that contract.
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));
    await new HttpTeamAccess("http://team.test/v1").canRead(
      "t 1/../x",
      "u1",
      "ADMIN",
      withBearer()
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe(
      "http://team.test/v1/teams/t%201%2F..%2Fx/access"
    );
  });

  it("re-presents the CALLER's own bearer token", async () => {
    // The Team service re-derives identity from the token's verified claims and
    // authorizes as the SAME user. This is also what gets the call PAST the API
    // Gateway: TEAM_SERVICE_URL is the public API, where every route sits behind the
    // Cognito JWT authorizer, so a tokenless hop is 401'd before Team's Lambda runs.
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));
    await new HttpTeamAccess("http://team.test/v1").canWrite(
      "t1",
      "u-77",
      "FACILITATOR",
      withBearer()
    );

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
  });

  it("does not send x-identity-* alongside a bearer token", async () => {
    // Forwarding both would invite the callee to prefer the cheap-to-forge headers.
    // The token is the only thing that should carry identity on this hop.
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));
    try {
      await new HttpTeamAccess("http://team.test/v1").canRead(
        "t1",
        "u-77",
        "FACILITATOR",
        withBearer()
      );
    } finally {
      delete process.env.INTERNAL_SERVICE_TOKEN;
    }

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(Object.keys(headers)).toEqual(["authorization"]);
  });

  it("denies WITHOUT calling the Team service when there is no request context", async () => {
    // No Context ⇒ no caller token to re-present ⇒ the gateway would 401 the call
    // anyway. Denying here keeps the fail-closed contract and saves the round trip;
    // what it must never do is fall back to a forgeable header-only hop.
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canRead("t1", "u1", "ADMIN")).toBe(false);
    expect(await access.canWrite("t1", "u1", "ADMIN")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("falls back to the internal-hop headers when the caller had no bearer", async () => {
    // A request that itself arrived over the trusted-internal path (local dev,
    // same-process runs) has identity but no token to forward. It keeps working.
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));
    try {
      await new HttpTeamAccess("http://team.test/v1").canWrite(
        "t1",
        "u-77",
        "FACILITATOR",
        ctx({ "x-internal-token": "test-internal-token", "x-identity-id": "u-77" })
      );
    } finally {
      delete process.env.INTERNAL_SERVICE_TOKEN;
    }

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["x-identity-id"]).toBe("u-77");
    expect(headers["x-identity-role"]).toBe("FACILITATOR");
    expect(headers["x-internal-token"]).toBe("test-internal-token");
    expect(headers.authorization).toBeUndefined();
  });

  // ─── Bounded wait (P1-1) ──────────────────────────────────────────────────
  //
  // Fail-closed bounds the OUTCOME; these bound the TIME. The failure mode that
  // motivates them is a Team service answering slowly with zero errors: without a
  // deadline every waiter holds its Lambda for the full 29s gateway timeout and
  // concurrency fills with threads doing nothing.

  it("passes an AbortSignal with the east-west deadline on every call", async () => {
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));
    await new HttpTeamAccess("http://team.test/v1").canRead(
      "t1",
      "u1",
      "PARTICIPANT",
      withBearer()
    );

    const { signal } = spy.mock.calls[0][1] as RequestInit;
    expect(signal).toBeInstanceOf(AbortSignal);
    // Not yet aborted — the deadline is a ceiling, not an immediate cancellation.
    expect((signal as AbortSignal).aborted).toBe(false);
  });

  it("denies when the deadline fires, exactly as it does for a connect error", async () => {
    // A TimeoutError rejection must be indistinguishable from ECONNREFUSED at the
    // contract level: both are "we do not know", and this client's answer to that is
    // and must remain "denied".
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const access = new HttpTeamAccess("http://team.test/v1");

    expect(await access.canRead("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
    expect(await access.canWrite("t1", "u1", "PARTICIPANT", withBearer())).toBe(false);
  });

  it("uses a deadline well under the 29s API Gateway timeout it replaces", async () => {
    // The SHIPPED DEFAULT is load-shedding policy, not taste — pinned so changing it is
    // a deliberate, reviewed change rather than a drive-by. Raised 800 → 2500
    // after a measured first-call PrivateLink cost of 1802ms was denying
    // legitimate workshop owners on every cold start; see east-west.ts for the
    // measurement and the accepted cost.
    expect(EAST_WEST_TIMEOUT_DEFAULT_MS).toBe(2500);

    // The FLOOR carries the lesson, asserted separately so it survives the next
    // revision of the number above: at or below the measured 1802ms first-call cost, a
    // cold caller aborts its own authorization probe and reports "denied" to a user who
    // is in fact authorized.
    expect(EAST_WEST_TIMEOUT_DEFAULT_MS).toBeGreaterThan(1802);

    // The CEILING that was the original point of having a timeout at all: bound the
    // wait far tighter than the 29s gateway timeout, so one slow dependency cannot
    // hold Lambdas until concurrency fills.
    expect(EAST_WEST_TIMEOUT_DEFAULT_MS).toBeLessThan(29_000);

    // With no override set, the effective value IS the default — i.e. the env plumbing
    // cannot change what ships by merely existing.
    expect(EAST_WEST_TIMEOUT_MS).toBe(EAST_WEST_TIMEOUT_DEFAULT_MS);
  });

  it("defaults its base URL from TEAM_SERVICE_URL", async () => {
    const previous = process.env.TEAM_SERVICE_URL;
    process.env.TEAM_SERVICE_URL = "http://from-env/v1";
    const spy = stubFetch(() => json({ canRead: true, canWrite: true }));

    await new HttpTeamAccess().canRead("t1", "u1", "ADMIN", withBearer());

    expect(String(spy.mock.calls[0][0])).toBe("http://from-env/v1/teams/t1/access");
    if (previous === undefined) delete process.env.TEAM_SERVICE_URL;
    else process.env.TEAM_SERVICE_URL = previous;
  });
});
