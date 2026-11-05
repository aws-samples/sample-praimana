import { describe, it, expect, afterEach, vi } from "vitest";
import { EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";
import { HttpWorkshopAccess } from "./workshop-access.http.js";
import type { AuthContext } from "./authz.js";
import type { Team, TeamRepository } from "./domain.js";

/**
 * HttpWorkshopAccess answers the one question that lets team STAFF reach a team they
 * are not a member of: "do you own the workshop this team belongs to?"
 *
 * It is two lookups split across the two services that own the data — teamId →
 * workshopId locally, workshopId → ownerId through the Workshop service's own API.
 * The tests below pin both halves, because getting either one wrong is silent: this
 * class fails CLOSED, so a broken call reads exactly like "not the owner". That is
 * precisely how the previous implementation (a request to a nonexistent
 * /teams/:teamId/workshop-owner route) went unnoticed while denying every
 * facilitator every team.
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

const team = (over: Partial<Team> = {}): Team => ({
  workshopId: "w1",
  id: "t1",
  name: "Team One",
  description: null,
  inviteCode: "CODE1234",
  repoUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function teamsRepo(rows: Team[]): TeamRepository {
  return {
    getById: async (id) => rows.find((t) => t.id === id) ?? null,
    setSeatCap: async () => true,
    getByInviteCode: async (code) => rows.find((t) => t.inviteCode === code) ?? null,
    listByWorkshop: async (workshopId) =>
      rows.filter((t) => t.workshopId === workshopId),
    put: async (t) => t,
    // THROWS rather than returning an empty page. This client resolves teamId → workshopId
    // and nothing else; a directory enumeration reached from an OWNERSHIP PROBE would be a
    // real defect, and a quiet `[]` would hide it.
    listDirectory: async () => {
      throw new Error("HttpWorkshopAccess must never enumerate the teams directory");
    },
  };
}

/** The inbound request's Context, reduced to the headers this client reads. */
const BEARER = "header.payload.signature";
function withBearer(): AuthContext {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? `Bearer ${BEARER}` : undefined,
    },
  } as unknown as AuthContext;
}

describe("HttpWorkshopAccess", () => {
  it("resolves teamId → workshopId locally, then asks Workshop for that workshop", async () => {
    // The path shape IS the contract: GET /workshops/:workshopId on the Workshop
    // service's own API. The previous /teams/:teamId/workshop-owner existed nowhere.
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team({ id: "t1", workshopId: "w-42" })]),
      "http://workshop.test/v1"
    );

    expect(await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())).toBe(
      true
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe("http://workshop.test/v1/workshops/w-42");
  });

  it("url-encodes the workshop id", async () => {
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team({ id: "t1", workshopId: "w 1/../x" })]),
      "http://workshop.test/v1"
    );

    await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer());
    expect(String(spy.mock.calls[0][0])).toBe(
      "http://workshop.test/v1/workshops/w%201%2F..%2Fx"
    );
  });

  it("re-presents the caller's own bearer token", async () => {
    // WORKSHOP_SERVICE_URL is the public API, where every route sits behind the
    // Cognito JWT authorizer — a tokenless hop is 401'd before Workshop's Lambda runs.
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer());

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
  });

  it("says NO when the caller is not the workshop's owner", async () => {
    stubFetch(() => json({ workshop: { ownerId: "someone-else" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    expect(
      await access.ownsTeamWorkshop("t1", "not-the-owner", "FACILITATOR", withBearer())
    ).toBe(false);
  });

  it("says NO for an unknown team without calling Workshop at all", async () => {
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(teamsRepo([]), "http://workshop.test/v1");

    expect(
      await access.ownsTeamWorkshop("nope", "owner-1", "FACILITATOR", withBearer())
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("says NO when the team carries no workshopId", async () => {
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team({ workshopId: "" })]),
      "http://workshop.test/v1"
    );

    expect(
      await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())
    ).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("says NO on a non-2xx from the Workshop service", async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      stubFetch(() => json({ workshop: { ownerId: "owner-1" } }, status));
      const access = new HttpWorkshopAccess(
        teamsRepo([team()]),
        "http://workshop.test/v1"
      );
      expect(
        await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())
      ).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("says NO when the Workshop service is unreachable", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    expect(
      await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())
    ).toBe(false);
  });

  it("says NO on a body with no ownerId, and on a non-JSON body", async () => {
    // A 200 with an unexpected shape (an error envelope, a gateway's HTML) must not
    // read as ownership.
    for (const body of [{}, { workshop: {} }, { workshop: { ownerId: 42 } }]) {
      stubFetch(() => json(body));
      const access = new HttpWorkshopAccess(
        teamsRepo([team()]),
        "http://workshop.test/v1"
      );
      expect(
        await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())
      ).toBe(false);
      vi.restoreAllMocks();
    }

    stubFetch(() => new Response("<html>gateway timeout</html>", { status: 200 }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );
    expect(
      await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())
    ).toBe(false);
  });

  it("never matches an EMPTY ownerId against an empty userId", async () => {
    // Two absent values are not a match. Without the non-empty check, a workshop row
    // missing its ownerId would hand ownership to a caller with a blank id.
    stubFetch(() => json({ workshop: { ownerId: "" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    expect(await access.ownsTeamWorkshop("t1", "", "FACILITATOR", withBearer())).toBe(
      false
    );
  });

  it("says NO without any request when there is no Context to take a token from", async () => {
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    expect(await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  // ─── Bounded wait (P1-1) ──────────────────────────────────────────────────

  it("passes an AbortSignal with the east-west deadline", async () => {
    // Fail-closed bounds the OUTCOME; this bounds the TIME. A Workshop service
    // answering in 30s with zero errors would otherwise pin one Team Lambda per
    // waiter for the full 29s gateway timeout.
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer());

    const { signal } = spy.mock.calls[0][1] as RequestInit;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
    expect(EAST_WEST_TIMEOUT_MS).toBeLessThan(29_000);
  });

  it("says NO when the deadline fires, exactly as for a connect error", async () => {
    // A TimeoutError must mean what ECONNREFUSED means: not the owner. The timeout
    // changes how long we wait, never what the answer means.
    stubFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const access = new HttpWorkshopAccess(
      teamsRepo([team()]),
      "http://workshop.test/v1"
    );

    expect(
      await access.ownsTeamWorkshop("t1", "owner-1", "FACILITATOR", withBearer())
    ).toBe(false);
  });

  it("defaults its base URL from WORKSHOP_SERVICE_URL", async () => {
    const previous = process.env.WORKSHOP_SERVICE_URL;
    process.env.WORKSHOP_SERVICE_URL = "http://from-env/v1";
    const spy = stubFetch(() => json({ workshop: { ownerId: "owner-1" } }));
    try {
      await new HttpWorkshopAccess(teamsRepo([team()])).ownsTeamWorkshop(
        "t1",
        "owner-1",
        "FACILITATOR",
        withBearer()
      );
    } finally {
      if (previous === undefined) delete process.env.WORKSHOP_SERVICE_URL;
      else process.env.WORKSHOP_SERVICE_URL = previous;
    }

    expect(String(spy.mock.calls[0][0])).toBe("http://from-env/v1/workshops/w1");
  });
});
