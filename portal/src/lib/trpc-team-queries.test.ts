import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The two BFF QUERIES behind the team screens that read history and enumerate teams:
 * `team.listFormerMembers` and `team.listDirectory`.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT ASSERT.
 *
 * It does NOT test authorization. `requireTeamRead` gates former-members, and
 * `canReadDirectory` plus the per-role owned-workshop SCOPE gates the directory, both in the
 * team service, both asserted in its own suite against the HTTP surface that actually enforces
 * them. Every service route is mapped behind a JWT authorizer that does NO role scoping, and the
 * browser holds its own token, so this layer is not on the only path to the service. Asserting a
 * gate here would document a boundary that does not exist.
 *
 * What it DOES test is what only this layer can get wrong, each of which type-checks and lints
 * perfectly in its broken form:
 *
 *   1. THE RIGHT ENDPOINT, METHOD AND QUERY SHAPE. HttpApi routes are per-method and per-path,
 *      so a typo 404s at the gateway before the Lambda runs.
 *   2. THE CALLER'S TOKEN IS FORWARDED, or the gateway 401s it.
 *   3. A `null` FROM THE SERVICE STAYS `null`. Every null on a former-member row is either a
 *      deliberate visibility SUPPRESSION or a genuine UNKNOWN, and coercing one to "" renders a
 *      blank cell that reads as a data problem. Same for the directory's two nulls, where a
 *      `?? 0` would turn "we could not count" into "nobody is on this team".
 *   4. THE SEARCH IS FORWARDED TO THE SERVICE. A search applied in the browser instead finds
 *      nobody past page 1, which on a small table looks exactly like a working feature.
 *   5. TRUNCATION IS SURFACED, not swallowed. A quietly short list reads as "there is no more".
 */

const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({
  backendFetch,
  // Imported by trpc.ts for its error-mapping middleware. The real class is not needed here,
  // but the export must exist or the module fails to load.
  BackendError: class BackendError extends Error {
    status = 500;
  },
}));

import { teamRouter } from "@/lib/trpc/routers/team";

/**
 * A caller with a SIGNED-IN context. `protectedProcedure` requires BOTH `session.user.id` and
 * `accessToken`, and its auth middleware runs first, so a context that is merely close enough
 * would make every assertion pass or fail for the wrong reason (UNAUTHORIZED rather than the
 * behaviour under test).
 */
function caller(role = "ADMIN") {
  return teamRouter.createCaller({
    accessToken: "test-token",
    session: { user: { id: "sub-1", email: "a@example.com", role } },
  } as never);
}

beforeEach(() => {
  backendFetch.mockReset();
});

// ─── team.listFormerMembers ──────────────────────────────────────────────────

/** A complete row, every field populated, so a test can null exactly one thing at a time. */
const formerMember = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  removedAt: "2026-03-01T00:00:00.000Z",
  removedByName: "Grace Hopper",
  removedByRole: "FACILITATOR",
  reason: "left the programme",
  joinedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("team.listFormerMembers", () => {
  beforeEach(() => {
    backendFetch.mockResolvedValue({ formerMembers: [formerMember()], truncated: false });
  });

  it("GETs the former-members route with the team id in the path", async () => {
    await caller().listFormerMembers({ teamId: "t1" });

    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe("/v1/teams/t1/former-members");
    // The route is mapped GET-only at the gateway. A method here would be the wrong shape;
    // `backendFetch` defaults to GET, so there must be none.
    expect(init.method).toBeUndefined();
  });

  it("ENCODES the team id", async () => {
    // An id carrying a slash would change which route the gateway matched, and a 404 from a
    // mis-built path is indistinguishable from "this team has no removals".
    await caller().listFormerMembers({ teamId: "t/1#x" });

    expect(backendFetch.mock.calls[0][0]).toBe("/v1/teams/t%2F1%23x/former-members");
  });

  it("forwards the caller's bearer token", async () => {
    await caller().listFormerMembers({ teamId: "t1" });
    expect(backendFetch.mock.calls[0][1].token).toBe("test-token");
  });

  it("surfaces EVERY contract field on a row", async () => {
    const result = await caller().listFormerMembers({ teamId: "t1" });

    expect(result.formerMembers).toHaveLength(1);
    expect(result.formerMembers[0]).toEqual({
      userId: "u1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      removedAt: "2026-03-01T00:00:00.000Z",
      removedByName: "Grace Hopper",
      removedByRole: "FACILITATOR",
      reason: "left the programme",
      joinedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("keeps a SUPPRESSED removedByName as NULL, never coerced to an empty string", async () => {
    // THE assertion this file exists for. `removedByName: null` is a deliberate visibility
    // suppression: a FACILITATOR reading a removal an ADMIN performed must not learn that
    // admin's name. The UI has to render "Not shown", following the InvitedByNote precedent
    // where a hidden inviter is reported as `hidden: true`, and it can only do that if the
    // null survives this layer. A `?? ""` here renders a blank cell that reads as missing data.
    backendFetch.mockResolvedValue({
      formerMembers: [formerMember({ removedByName: null })],
      truncated: false,
    });

    const row = (await caller("FACILITATOR").listFormerMembers({ teamId: "t1" }))
      .formerMembers[0];

    expect(row.removedByName).toBeNull();
    expect(row.removedByName).not.toBe("");
    // The ROLE is still disclosed even when the name is not, "removed by an Admin" names no
    // account, and suppressing it too would leave a row that refuses to say by whom in any form.
    expect(row.removedByRole).toBe("FACILITATOR");
  });

  it("keeps an UNKNOWN name and email as NULL", async () => {
    // A different kind of null from the one above: the read-model has no row for this person
    // yet. The removal is the fact and the name is decoration on it, so the service keeps the
    // row, and this layer must not turn "unknown" into "".
    backendFetch.mockResolvedValue({
      formerMembers: [formerMember({ name: null, email: null })],
      truncated: false,
    });

    const row = (await caller().listFormerMembers({ teamId: "t1" })).formerMembers[0];

    expect(row.name).toBeNull();
    expect(row.email).toBeNull();
  });

  it("keeps a NULL joinedAt, a removal predating the denormalisation is not 'never joined'", async () => {
    // The audit table is append-only so there is no backfill, and the invitation's acceptedAt
    // is deliberately NOT substituted (one row carries one acceptedAt while a person can be
    // removed and re-added several times, so attributing it to a particular removal would be a
    // guess rendered as a fact). The client must render null as "join date unknown".
    backendFetch.mockResolvedValue({
      formerMembers: [formerMember({ joinedAt: null })],
      truncated: false,
    });

    const row = (await caller().listFormerMembers({ teamId: "t1" })).formerMembers[0];

    expect(row.joinedAt).toBeNull();
  });

  it("keeps a NULL reason, an absent note is not an empty one", async () => {
    backendFetch.mockResolvedValue({
      formerMembers: [formerMember({ reason: null })],
      truncated: false,
    });

    expect(
      (await caller().listFormerMembers({ teamId: "t1" })).formerMembers[0].reason
    ).toBeNull();
  });

  it("SURFACES truncated: true, so a short list is not presented as complete", async () => {
    // On an audit-derived view a quietly truncated list reads as "nobody else was removed",
    // which is the one wrong answer worth guarding against.
    backendFetch.mockResolvedValue({ formerMembers: [formerMember()], truncated: true });

    expect((await caller().listFormerMembers({ teamId: "t1" })).truncated).toBe(true);
  });

  it("reads `truncated` STRICTLY, a stringy value is not truncated in either direction", async () => {
    for (const value of [undefined, null, "false", "true", 1, {}]) {
      backendFetch.mockResolvedValue({ formerMembers: [], truncated: value });
      const result = await caller().listFormerMembers({ teamId: "t1" });
      expect(result.truncated, JSON.stringify(value)).toBe(false);
    }
  });

  it("returns an empty list, not undefined, when the service sends no rows", async () => {
    // A component `.map()`s this. An undefined here is a runtime crash on a team that simply
    // has no removals, which is the common case.
    for (const body of [{}, { formerMembers: undefined }, { formerMembers: null }]) {
      backendFetch.mockResolvedValue(body);
      expect((await caller().listFormerMembers({ teamId: "t1" })).formerMembers).toEqual([]);
    }
  });

  it("rejects for an anonymous caller, without touching the backend", async () => {
    const anonymous = teamRouter.createCaller({} as never);

    const err = await anonymous
      .listFormerMembers({ teamId: "t1" })
      .then(() => null, (e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("UNAUTHORIZED");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("PROPAGATES a backend refusal rather than rendering an empty history", async () => {
    // A 403 from requireTeamRead absorbed here would show "no former members" to somebody who
    // is simply not allowed to see them, a false statement about the team.
    backendFetch.mockRejectedValue(new Error("Forbidden"));

    await expect(caller("PARTICIPANT").listFormerMembers({ teamId: "t1" })).rejects.toThrow();
  });
});

// ─── team.listDirectory ──────────────────────────────────────────────────────

const directoryTeam = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Team Phoenix",
  workshopId: "w1",
  workshopName: "Workshop One",
  memberCount: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("team.listDirectory", () => {
  beforeEach(() => {
    backendFetch.mockResolvedValue({ teams: [directoryTeam()], nextCursor: undefined });
  });

  it("GETs the directory route with a default limit", async () => {
    await caller().listDirectory();

    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    // A STATIC third segment. There is no /v1/teams/{teamId} mapping at three segments, and
    // API Gateway prefers a static segment over a path variable, but the path has to be
    // exactly this or it 404s before the Lambda runs.
    expect(path).toBe("/v1/teams/directory?limit=50");
    expect(init.method).toBeUndefined();
  });

  it("forwards the caller's bearer token", async () => {
    await caller().listDirectory();
    expect(backendFetch.mock.calls[0][1].token).toBe("test-token");
  });

  it("FORWARDS the search needle to the SERVICE, so the match happens in the store", async () => {
    // THE assertion this exists for. A search applied to the loaded page in the browser finds
    // nobody past page 1, fine for skimming, wrong precisely when the reason you are searching
    // is to act on something specific, because the operator concludes the team does not exist.
    // A route that dropped this parameter returns everything, which on page 1 of a small table
    // is indistinguishable from a working search.
    await caller().listDirectory({ search: "phoenix" });

    const path = backendFetch.mock.calls[0][0] as string;
    expect(path).toContain("search=phoenix");
  });

  it("URL-ENCODES the needle, so a `&` cannot inject another parameter", async () => {
    await caller().listDirectory({ search: "a&limit=9999 b+c" });

    const path = backendFetch.mock.calls[0][0] as string;
    // URLSearchParams escapes it; the raw form must not appear.
    expect(path).not.toContain("&limit=9999");
    expect(path).toContain("search=a%26limit%3D9999+b%2Bc");
  });

  it("trims the needle and REFUSES one over the cap", async () => {
    await caller().listDirectory({ search: "  spaced  " });
    expect(backendFetch.mock.calls[0][0]).toContain("search=spaced");

    await expect(caller().listDirectory({ search: "x".repeat(101) })).rejects.toThrow();
    await expect(caller().listDirectory({ search: "x".repeat(100) })).resolves.toBeTruthy();
  });

  it("omits `search` entirely when it is absent or empty", async () => {
    // An empty `search=` is a filter that matches everything, which costs a store expression to
    // say the same thing as no filter.
    for (const input of [undefined, { search: undefined }, { search: "   " }]) {
      backendFetch.mockClear();
      await caller().listDirectory(input);
      expect(backendFetch.mock.calls[0][0]).not.toContain("search=");
    }
  });

  it("passes the limit and the cursor through, the cursor OPAQUELY", async () => {
    await caller().listDirectory({ limit: 25, cursor: "eyJhIjoxfQ" });

    const path = backendFetch.mock.calls[0][0] as string;
    expect(path).toContain("limit=25");
    expect(path).toContain("cursor=eyJhIjoxfQ");
  });

  it("refuses a limit outside the service's own bounds", async () => {
    await expect(caller().listDirectory({ limit: 0 })).rejects.toThrow();
    await expect(caller().listDirectory({ limit: 101 })).rejects.toThrow();
    await expect(caller().listDirectory({ limit: 2.5 })).rejects.toThrow();
    await expect(caller().listDirectory({ limit: 100 })).resolves.toBeTruthy();
  });

  it("surfaces every row field, and the cursor", async () => {
    backendFetch.mockResolvedValue({ teams: [directoryTeam()], nextCursor: "next-page" });

    const result = await caller().listDirectory();

    expect(result.teams[0]).toEqual({
      id: "t1",
      name: "Team Phoenix",
      workshopId: "w1",
      workshopName: "Workshop One",
      memberCount: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.nextCursor).toBe("next-page");
  });

  it("keeps a NULL memberCount as NULL, never coerced to 0", async () => {
    // "We could not count" and "nobody is on this team" are different facts, and 0 is a number
    // an operator would act on. A `?? 0` here is a one-character mistake that renders a
    // populated team as empty.
    backendFetch.mockResolvedValue({ teams: [directoryTeam({ memberCount: null })] });

    const row = (await caller().listDirectory()).teams[0];

    expect(row.memberCount).toBeNull();
    expect(row.memberCount).not.toBe(0);
  });

  it("keeps a NULL workshopName as NULL, with the id still available to fall back on", async () => {
    // Null means the name could not be resolved (workshops are another service's data and the
    // lookup is best-effort), NOT "no workshop". Coercing it would hide a degraded lookup.
    backendFetch.mockResolvedValue({ teams: [directoryTeam({ workshopName: null })] });

    const row = (await caller().listDirectory()).teams[0];

    expect(row.workshopName).toBeNull();
    expect(row.workshopId).toBe("w1");
  });

  it("reports a real 0 count as 0, distinctly from null", async () => {
    backendFetch.mockResolvedValue({ teams: [directoryTeam({ memberCount: 0 })] });

    expect((await caller().listDirectory()).teams[0].memberCount).toBe(0);
  });

  it("returns an empty list, not undefined, when the service sends no rows", async () => {
    for (const body of [{}, { teams: undefined }, { teams: null }]) {
      backendFetch.mockResolvedValue(body);
      expect((await caller().listDirectory()).teams).toEqual([]);
    }
  });

  it("rejects for an anonymous caller, without touching the backend", async () => {
    const anonymous = teamRouter.createCaller({} as never);

    const err = await anonymous.listDirectory().then(() => null, (e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("UNAUTHORIZED");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("PROPAGATES a 503 rather than absorbing it into an empty directory", async () => {
    // The service answers DIRECTORY_SCOPE_UNAVAILABLE when a FACILITATOR's owned-workshop scope
    // could not be determined. An empty directory is indistinguishable from a correct one, so
    // swallowing this would render a plausible, wrong page with no error anywhere, the exact
    // failure shape this check exists to prevent.
    backendFetch.mockRejectedValue(new Error("DIRECTORY_SCOPE_UNAVAILABLE"));

    await expect(caller("FACILITATOR").listDirectory()).rejects.toThrow();
  });

  it("PROPAGATES a 403 rather than showing an empty directory to a refused role", async () => {
    backendFetch.mockRejectedValue(new Error("Forbidden"));

    await expect(caller("PARTICIPANT").listDirectory()).rejects.toThrow();
  });

  it("does NOT gate on the caller's role in this layer", async () => {
    // ASSERTED AS AN INTENTION, not as a permission, the service is the boundary and holds
    // both the role gate and the owned-workshop scope. A copy here would silently go stale.
    await caller("PARTICIPANT").listDirectory();

    expect(backendFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── team.getById / team.listMembers, the LIVE roster excludes removed people ───

/**
 * A REMOVED MEMBER MUST NOT APPEAR IN THE LIVE ROSTER, and this is a regression pin for a
 * defect reported against the running dev stack.
 *
 * Observed: Participant Three was removed, the membership row was correctly INACTIVE, the
 * removal showed correctly under Former members, and the person ALSO still rendered in the
 * Members list. The same person shown as both current and former says the relationship both
 * ended and did not, and on this screen the consequences run past cosmetics: the workspace
 * layout derives `isMember` from this very array to decide which tabs exist.
 *
 * ── WHY THE SERVICE IS NOT THE THING THAT CHANGED ──
 *
 * `GET /v1/teams/:teamId/members` returns INACTIVE rows DELIBERATELY, it is the only caller
 * of the repository's `IncludingInactive` variant, so a roster can offer a Reactivate action
 * on a row an audit entry alone cannot support. That contract is correct. What was missing
 * was the exclusion in every consumer that wants the LIVE team, which is all of them.
 *
 * ── THE POLARITY IS THE PART A FUTURE EDIT WILL GET WRONG ──
 *
 * The filter excludes the DENY value; it does NOT require `status === "ACTIVE"`. Every row
 * written before the field existed carries NO status attribute and absent means ACTIVE (the
 * service's `isInactiveMembership` is built on the same rule). The strict form would empty
 * every legacy team's roster, and because `isMember` is derived from it, would also hide the
 * workspace tabs from every member of those teams. That is a platform-wide lockout dressed
 * as a tidy-up, so the legacy case is asserted explicitly below.
 */
describe("team.getById, the roster is the LIVE team", () => {
  const teamsPayload = { teams: [{ id: "t1", name: "Team Phoenix" }] };
  const workshopPayload = { workshop: { name: "Accelerator" } };

  /**
   * Resolves each of getById's FOUR parallel fetches by path.
   *
   * ⚠ THE `/phases` BRANCH MUST COME BEFORE THE BARE WORKSHOP FALL-THROUGH. Both paths start
   * `/v1/workshops/w1`, so ordering is what distinguishes them, and getting it wrong here would
   * feed the phase list a workshop object, which yields an empty pipeline and silently passes every
   * roster assertion below while testing nothing about phases.
   */
  const mockRoster = (members: unknown[]) => {
    backendFetch.mockImplementation((path: string) => {
      if (path.includes("/teams/t1/members")) return Promise.resolve({ members });
      if (path.includes("/phases")) return Promise.resolve({ phases: [] });
      if (path.includes("/teams")) return Promise.resolve(teamsPayload);
      return Promise.resolve(workshopPayload);
    });
  };

  it("OMITS an INACTIVE member, the defect reported live", async () => {
    mockRoster([
      { userId: "active-1", role: "BUILDER", status: "ACTIVE" },
      { userId: "removed-1", role: "BUILDER", status: "INACTIVE" },
    ]);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.members.map((m: { userId: string }) => m.userId)).toEqual(["active-1"]);
    // Asserted on the serialized shape too: the layout's isMember does a `.some()` over
    // this array, so a row surviving anywhere in it re-grants the workspace tabs.
    expect(JSON.stringify(team.members)).not.toContain("removed-1");
  });

  it("KEEPS a member whose row has NO status, absent is ACTIVE, not removed", async () => {
    // ⚠ THE LOCKOUT CASE. Every row written before `status` existed looks like this. A
    // filter written as `status === "ACTIVE"` empties these teams and, via isMember, hides
    // every workspace tab from their members.
    mockRoster([{ userId: "legacy-1", role: "BUILDER" }]);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.members).toHaveLength(1);
    expect(team.members[0].userId).toBe("legacy-1");
  });

  it("treats status case-INSENSITIVELY, and tolerates surrounding whitespace", async () => {
    // The constant is copied across service bundles; a casing difference must never be the
    // thing that decides whether a removed person still has a place on the roster.
    mockRoster([
      { userId: "a", status: "inactive" },
      { userId: "b", status: "Inactive" },
      { userId: "c", status: " INACTIVE " },
      { userId: "d", status: "ACTIVE" },
    ]);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.members.map((m: { userId: string }) => m.userId)).toEqual(["d"]);
  });

  it("still fills the user fallback for the members it KEEPS", async () => {
    // The filter must not have displaced the mapper it sits in front of.
    mockRoster([{ userId: "u1", role: "LEAD" }]);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.members[0].id).toBe("u1");
    expect(team.members[0].user).toEqual({ id: "u1", name: "Unknown" });
  });

  it("survives a roster of only removed people without throwing", async () => {
    mockRoster([{ userId: "gone", status: "INACTIVE" }]);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.members).toEqual([]);
  });
});

/**
 * ── team.getById, THE PHASE LIST, WHICH USED TO BE A HARDCODED `[]` ─────────────────────────
 *
 * This procedure returned `teamPhases: []` unconditionally, and two screens read it as real data:
 * the workspace layout's phase badge and stepper (both behind `length > 0`, so both permanently
 * invisible) and the insights page's "Phases Passed" tile, which therefore reported `0 of 0` as a
 * statement of fact on a page executives read.
 *
 * The status is DERIVED, not stored, progression is workshop-wide and facilitator-controlled, so a
 * phase's state is a comparison against the workshop's `currentPhaseOrder`. `lib/phase-status.ts`
 * owns that comparison and is tested on its own; what THIS file tests is the wiring only this layer
 * can get wrong: asking the right endpoint, feeding it the right `currentPhaseOrder`, and, the one
 * with real consequences, not letting a phase-list failure take the roster down with it.
 */
describe("team.getById, the phase list and its failure posture", () => {
  const teamsPayload = { teams: [{ id: "t1", name: "Team Phoenix" }] };

  /** Resolves the four fetches, with the workshop's current phase and the pipeline configurable. */
  const mockPhases = (
    phases: unknown[],
    currentPhaseOrder: number | undefined,
    opts: { phasesFail?: boolean } = {}
  ) => {
    backendFetch.mockImplementation((path: string) => {
      if (path.includes("/teams/t1/members")) return Promise.resolve({ members: [] });
      if (path.includes("/phases")) {
        return opts.phasesFail
          ? Promise.reject(new Error("phases unavailable"))
          : Promise.resolve({ phases });
      }
      if (path.includes("/teams")) return Promise.resolve(teamsPayload);
      return Promise.resolve({ workshop: { name: "Accelerator", currentPhaseOrder } });
    });
  };

  const pipeline = [
    { id: "p1", order: 1, name: "Ideation" },
    { id: "p2", order: 2, name: "Build" },
    { id: "p3", order: 3, name: "Demo" },
  ];

  it("returns the workshop's phases with a status derived from currentPhaseOrder", async () => {
    mockPhases(pipeline, 2);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.phases).toEqual([
      { id: "p1", order: 1, name: "Ideation", status: "COMPLETED" },
      { id: "p2", order: 2, name: "Build", status: "IN_PROGRESS" },
      { id: "p3", order: 3, name: "Demo", status: "NOT_STARTED" },
    ]);
  });

  it("counts completed phases the way the insights tile reports them", async () => {
    // The regression: this was unconditionally 0 of 0.
    mockPhases(pipeline, 3);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.phases.filter((p) => p.status === "COMPLETED")).toHaveLength(2);
    expect(team.phases).toHaveLength(3);
  });

  it("reports nothing started when the facilitator has not begun the workshop", async () => {
    // A workshop row with no `currentPhaseOrder` at all, the pre-start state.
    mockPhases(pipeline, undefined);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.phases.every((p) => p.status === "NOT_STARTED")).toBe(true);
  });

  it("asks the workshop's OWN phases endpoint", async () => {
    // A typo here 404s at the gateway; the catch below would then swallow it into an empty
    // pipeline, so the stepper would vanish with no error anywhere. Pin the path.
    mockPhases(pipeline, 1);

    await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(backendFetch).toHaveBeenCalledWith(
      "/v1/workshops/w1/phases",
      expect.objectContaining({ token: "test-token" })
    );
  });

  /**
   * ⚠ THE ONE WITH REAL CONSEQUENCES. The phases are decoration on this payload; the ROSTER decides
   * whether the workspace tabs exist at all (the layout derives `isMember` from it). Without the
   * `.catch` on the phases call, one unreadable phase list would reject the whole `Promise.all` and
   * blank a team's entire workspace, turning a missing stepper into a missing workspace.
   */
  it("keeps the roster when the phase list fails, rather than failing the whole query", async () => {
    backendFetch.mockImplementation((path: string) => {
      if (path.includes("/teams/t1/members"))
        return Promise.resolve({ members: [{ userId: "u1", role: "LEAD" }] });
      if (path.includes("/phases")) return Promise.reject(new Error("phases unavailable"));
      if (path.includes("/teams")) return Promise.resolve(teamsPayload);
      return Promise.resolve({ workshop: { name: "Accelerator", currentPhaseOrder: 2 } });
    });

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.members.map((m: { userId: string }) => m.userId)).toEqual(["u1"]);
    expect(team.phases).toEqual([]);
  });

  it("survives a workshop with no phases configured", async () => {
    mockPhases([], 0);

    const team = await caller().getById({ teamId: "t1", workshopId: "w1" });

    expect(team.phases).toEqual([]);
  });
});

describe("team.listMembers, filtered too, though nothing consumes it yet", () => {
  it("OMITS an INACTIVE member", async () => {
    // Filtered even with no caller today: an unfiltered pass-through in something named
    // `listMembers` is a trap the next consumer has no reason to suspect.
    backendFetch.mockResolvedValue({
      members: [
        { userId: "active-1", status: "ACTIVE" },
        { userId: "removed-1", status: "INACTIVE" },
      ],
    });

    const members = await caller().listMembers({ teamId: "t1" });

    expect(members.map((m: { userId: string }) => m.userId)).toEqual(["active-1"]);
  });

  it("KEEPS a legacy row with no status", async () => {
    backendFetch.mockResolvedValue({ members: [{ userId: "legacy-1" }] });

    const members = await caller().listMembers({ teamId: "t1" });

    expect(members).toHaveLength(1);
  });
});
