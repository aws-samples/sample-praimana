import { describe, it, expect, afterEach, vi } from "vitest";
import { EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";
import { HttpTeamRoster } from "./snapshot-sources.http.js";
import type { AuthContext } from "./authz.js";

/**
 * `HttpTeamRoster.isActiveMember` — the east-west client that closed the last half of the
 * peer-rating finding.
 *
 * ── WHY THIS FILE EXISTS AND WHAT IT PROTECTS ─────────────────────────────────────────────
 *
 * Three properties of this client are invisible from a route-level fake, and each of them is the
 * reason the port was added rather than incidental to it:
 *
 *   1. ⚠ ONLY A BOOLEAN CROSSES THE PORT. The callee's roster response carries members' EMAIL
 *      ADDRESSES (opted in by Team for the team's own People list) and, on removed rows, the
 *      removing operator's raw Cognito sub. The whole reason this port answers a QUESTION rather
 *      than returning the roster is that a boolean cannot leak what it does not carry — and a route
 *      test, which sees only the boolean, cannot tell whether that is true.
 *
 *   2. ⚠ `"unavailable"` IS NOT `false`. `false` means "not on this team", which a member can act
 *      on; an unanswered hop reported that way makes an outage look like a validation rule. The
 *      route answers 404 for one and 503 + Retry-After for the other, so collapsing them here would
 *      undo that distinction where no route test could see it.
 *
 *   3. ⚠ IT RE-PRESENTS THE CALLER'S OWN TOKEN. This service gains no ambient authority: the callee
 *      gates the roster on `requireTeamRead`, so the answer is only ever one the caller could have
 *      obtained themselves.
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

/**
 * The inbound Hono Context, reduced to the two things this client's transport reads.
 *
 * ⚠ IT MUST CARRY `identity` AS WELL AS THE HEADERS, unlike the ctx in team-access.http.test.ts.
 * The shared `getJson` in snapshot-sources.http.ts calls `forwardedIdentityHeaders(auth,
 * requireIdentity(auth))`, and `requireIdentity` reads `c.get("identity")` and THROWS when it is
 * absent — inside getJson's try, so the throw is swallowed as `"unavailable"` and NO FETCH HAPPENS.
 * A ctx without it makes every assertion here pass vacuously against a client that never ran.
 */
function ctx(headers: Record<string, string>): AuthContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
    get: (key: string) =>
      key === "identity"
        ? { id: "u1", email: "u1@example.com", role: "PARTICIPANT" }
        : undefined,
  } as unknown as AuthContext;
}

const BEARER = "header.payload.signature";
const withBearer = () => ctx({ authorization: `Bearer ${BEARER}` });

/** A roster response in the shape Team's `GET /teams/:teamId/members` actually returns. */
const roster = (
  members: Array<{ userId: string; status?: string; email?: string; removedBy?: string }>
) => json({ members });

const client = () => new HttpTeamRoster("http://team.test/v1");

describe("HttpTeamRoster.isActiveMember", () => {
  it("asks Team's EXISTING roster route — no new endpoint", async () => {
    // ⚠ A DELIBERATE CONSTRAINT. Every route is wired in an API Gateway template that does not live
    // in this repo, so a client written against a route that already exists is deployable on its
    // own while a new callee route is not verifiable from here and would ship broken.
    const spy = stubFetch(() => roster([{ userId: "u2" }]));

    await client().isActiveMember("t1", "u2", withBearer());

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe("http://team.test/v1/teams/t1/members");
  });

  it("re-presents the CALLER's bearer token and bounds the call in time", async () => {
    const spy = stubFetch(() => roster([{ userId: "u2" }]));

    await client().isActiveMember("t1", "u2", withBearer());

    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${BEARER}`);
    // A callee answering slowly but successfully would otherwise pin this Lambda for the full
    // gateway timeout per waiter and fill reserved concurrency.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(EAST_WEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("percent-encodes the team id", async () => {
    const spy = stubFetch(() => roster([]));
    await client().isActiveMember("t 1/../x", "u2", withBearer());
    expect(String(spy.mock.calls[0][0])).toBe(
      "http://team.test/v1/teams/t%201%2F..%2Fx/members"
    );
  });

  it("answers TRUE for an active member and FALSE for a stranger", async () => {
    stubFetch(() => roster([{ userId: "u2" }, { userId: "u3", status: "ACTIVE" }]));
    const c = client();

    await expect(c.isActiveMember("t1", "u2", withBearer())).resolves.toBe(true);
    await expect(c.isActiveMember("t1", "u3", withBearer())).resolves.toBe(true);
    await expect(c.isActiveMember("t1", "nobody", withBearer())).resolves.toBe(false);
  });

  it("answers FALSE for a REMOVED member", async () => {
    // The row survives a removal, but somebody who has lost the access to see or answer
    // an opinion is not a person a teammate may still file a new one about.
    stubFetch(() => roster([{ userId: "u2", status: "INACTIVE" }]));

    await expect(client().isActiveMember("t1", "u2", withBearer())).resolves.toBe(false);
  });

  it("treats an ABSENT status as active, matching the callee's own reading", async () => {
    // Team normalises this field ("ALWAYS PRESENT AND NEVER ABSENT"), so a row without one means a
    // callee one deploy behind — and an absent status has always MEANT active on the stored row.
    // Reading it as inactive would silently refuse every rating against an older Team.
    stubFetch(() => roster([{ userId: "u2" }]));

    await expect(client().isActiveMember("t1", "u2", withBearer())).resolves.toBe(true);
  });

  it("⚠ NOTHING BUT THE BOOLEAN CROSSES THE PORT", async () => {
    // The disclosure property, asserted on the RETURN VALUE rather than trusted. The response below
    // carries an email and a removing operator's sub — exactly the fields Team opts into for its own
    // People list and exactly the ones this service has no business holding.
    stubFetch(() =>
      roster([
        { userId: "u2", email: "teammate@corp.example" },
        { userId: "gone", status: "INACTIVE", removedBy: "admin-sub-9" },
      ])
    );

    const answer = await client().isActiveMember("t1", "u2", withBearer());

    expect(answer).toBe(true);
    // A boolean, not an object that happens to be truthy — the shape is the guarantee.
    expect(typeof answer).toBe("boolean");
    expect(JSON.stringify(answer)).not.toContain("teammate@corp.example");
    expect(JSON.stringify(answer)).not.toContain("admin-sub-9");
  });

  it("answers UNAVAILABLE, never false, on every failed hop", async () => {
    // ⚠ INCLUDING 403 AND 404. This call is made only after the route's own guard established the
    // caller is a member, so a 403 means the two services DISAGREE about membership — a fault, not
    // an answer about who is on the team. Mapping any of these to `false` would tell a member their
    // teammate does not exist.
    for (const status of [403, 404, 500, 502, 503]) {
      stubFetch(() => json({ error: "nope" }, status));
      await expect(
        client().isActiveMember("t1", "u2", withBearer()),
        `status ${status}`
      ).resolves.toBe("unavailable");
    }
  });

  it("answers UNAVAILABLE when the transport throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    );

    await expect(client().isActiveMember("t1", "u2", withBearer())).resolves.toBe(
      "unavailable"
    );
  });

  it("answers UNAVAILABLE on a shape it does not recognise", async () => {
    // A response without a members array is not an empty team. Reporting it as `false` would refuse
    // a legitimate rating on the strength of a payload this client could not read.
    for (const body of [{}, { members: null }, { members: "nope" }, []]) {
      stubFetch(() => json(body));
      await expect(
        client().isActiveMember("t1", "u2", withBearer()),
        JSON.stringify(body)
      ).resolves.toBe("unavailable");
    }
  });

  it("answers UNAVAILABLE with no request context, rather than refusing", async () => {
    // No context ⇒ the question cannot be asked at all, which is not the same as a negative answer.
    const spy = stubFetch(() => roster([{ userId: "u2" }]));

    await expect(client().isActiveMember("t1", "u2")).resolves.toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers FALSE for an empty roster, because that IS an answer", async () => {
    // The one case where an empty list is determined rather than a failure: Team said the team has
    // no members. `false` is correct here and `"unavailable"` would be a lie.
    stubFetch(() => roster([]));

    await expect(client().isActiveMember("t1", "u2", withBearer())).resolves.toBe(false);
  });
});
