import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createTeamRoutes } from "./routes.js";
import type {
  AdmitOutcome,
  Invitation,
  InvitationRepository,
  Team,
  TeamMember,
  TeamMemberRepository,
  TeamRepository,
  UserView,
  UsersReadModel,
  AuditRepository,
  AuditEntryWrite,
  AuditEntryRead,
} from "./domain.js";
import { isInactiveMembership } from "./domain.js";
import type { WorkshopAccess, WorkshopDirectory, WorkshopRef } from "./authz.js";

/**
 * RECONNAISSANCE SPECS from an authorization audit.
 *
 * These exist to turn "I read the code and believe X" into "the real Hono app answered
 * X to an unauthorized caller's identity headers". Nothing here is a fix, and nothing
 * here weakens or replaces an existing assertion: each spec pins CURRENT behaviour, so
 * the ones marked OPEN DEFECT will FAIL the moment the defect is fixed, which is the
 * signal that the register entry can be closed.
 *
 * The harness is a deliberate copy of routes.test.ts's fakes rather than an import: that
 * file exports nothing, and this audit must not edit it.
 */
const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(identity: { id: string; email?: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
    ...(identity.email ? { "x-identity-email": identity.email } : {}),
  };
}

// ─── Fakes (mirrors of routes.test.ts, same semantics) ──────────────────────

class FakeTeams implements TeamRepository {
  /**
   * SET the seat cap. Not exercised by this file's tests, which predate the
   * cap — present so the fake satisfies the interface rather than to model behaviour.
   */
  async setSeatCap(): Promise<boolean> {
    return true;
  }

  constructor(readonly rows: Team[] = []) {}
  async getById(id: string) {
    return this.rows.find((t) => t.id === id) ?? null;
  }
  async getByInviteCode(inviteCode: string) {
    return this.rows.find((t) => t.inviteCode === inviteCode) ?? null;
  }
  async listByWorkshop(workshopId: string) {
    return this.rows.filter((t) => t.workshopId === workshopId);
  }
  async listDirectory(opts: {
    limit?: number;
    cursor?: string;
    search?: string;
    workshopIds?: readonly string[];
  }) {
    const scope = opts.workshopIds;
    const rows = scope
      ? this.rows.filter((t) => scope.includes(t.workshopId))
      : this.rows;
    return { teams: rows, nextCursor: undefined };
  }
  async put(t: Team) {
    this.rows.push(t);
    return t;
  }
  async update() {}
}

class FakeMembers implements TeamMemberRepository {
  /**
   * ADMIT. The real one is a TransactWriteItems that also moves the team's
   * `memberCount` under a cap ConditionExpression; this file's tests predate the cap and are
   * about other rules, so it admits unconditionally and reports the idempotent case honestly.
   * Cap behaviour is covered where the fake models the seat ledger.
   */
  async admit(member: TeamMember): Promise<AdmitOutcome> {
    const existing = this.rows.find(
      (m) => m.teamId === member.teamId && m.userId === member.userId
    );
    if (existing) return "already-member";
    this.rows.push(member);
    return "admitted";
  }

  constructor(readonly rows: TeamMember[] = []) {}
  async get(teamId: string, userId: string) {
    const row = await this.getIncludingInactive(teamId, userId);
    if (row && isInactiveMembership(row.status)) return null;
    return row;
  }
  async getIncludingInactive(teamId: string, userId: string) {
    return this.rows.find((m) => m.teamId === teamId && m.userId === userId) ?? null;
  }
  async listByTeam(teamId: string) {
    return (await this.listByTeamIncludingInactive(teamId)).filter(
      (m) => !isInactiveMembership(m.status)
    );
  }
  async listByTeamIncludingInactive(teamId: string) {
    return this.rows.filter((m) => m.teamId === teamId);
  }
  async listByUser(userId: string) {
    return this.rows
      .filter((m) => m.userId === userId)
      .filter((m) => !isInactiveMembership(m.status));
  }
  async put(member: TeamMember) {
    const i = this.rows.findIndex(
      (m) => m.teamId === member.teamId && m.userId === member.userId
    );
    if (i === -1) this.rows.push(member);
    else this.rows[i] = member;
    return member;
  }
  async deactivate(
    teamId: string,
    userId: string,
    removedBy: string,
    removedByRole: string
  ) {
    const row = this.rows.find((m) => m.teamId === teamId && m.userId === userId);
    if (!row || isInactiveMembership(row.status)) return false;
    row.status = "INACTIVE";
    row.removedAt = "2026-08-04T00:00:00.000Z";
    row.removedBy = removedBy;
    row.removedByRole = removedByRole;
    return true;
  }
  async reactivate(teamId: string, userId: string, reactivatedBy: string): Promise<AdmitOutcome> {
    const row = this.rows.find((m) => m.teamId === teamId && m.userId === userId);
    if (!row || !isInactiveMembership(row.status)) return "already-member";
    row.status = "ACTIVE";
    row.reactivatedAt = "2026-08-04T00:00:00.000Z";
    row.reactivatedBy = reactivatedBy;
    return "admitted";
  }
}

class FakeInvitations implements InvitationRepository {
  constructor(readonly rows: Invitation[] = []) {}
  /** Set to make listByEmail throw — the "a half failed" branch. */
  listByEmailThrows?: Error;
  async get(teamId: string, email: string) {
    return (
      this.rows.find((i) => i.teamId === teamId && i.email === email.toLowerCase()) ?? null
    );
  }
  async listByEmail(email: string) {
    if (this.listByEmailThrows) throw this.listByEmailThrows;
    return this.rows.filter((i) => i.email === email.toLowerCase());
  }
  async getByTokenHash(tokenHash: string) {
    return this.rows.find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async listByTeam(teamId: string) {
    return this.rows.filter((i) => i.teamId === teamId);
  }
  async put(invitation: Invitation) {
    const stored = { ...invitation, email: invitation.email.toLowerCase() };
    const i = this.rows.findIndex(
      (r) => r.teamId === stored.teamId && r.email === stored.email
    );
    if (i === -1) this.rows.push(stored);
    else this.rows[i] = stored;
    return stored;
  }
  async accept(teamId: string, email: string, acceptedBy?: string) {
    const row = this.rows.find(
      (i) => i.teamId === teamId && i.email === email.toLowerCase()
    );
    if (!row || row.status === "ACCEPTED") return false;
    row.status = "ACCEPTED";
    row.acceptedAt = "2026-08-02T00:00:00.000Z";
    if (acceptedBy) row.acceptedBy = acceptedBy;
    return true;
  }
  async revoke(teamId: string, email: string) {
    const i = this.rows.findIndex(
      (inv) => inv.teamId === teamId && inv.email === email.toLowerCase()
    );
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
  async markRevoked(teamId: string, email: string, revokedBy: string) {
    const row = this.rows.find(
      (i) => i.teamId === teamId && i.email === email.toLowerCase()
    );
    if (!row || row.status === "REVOKED") return false;
    row.status = "REVOKED";
    row.revokedAt = "2026-08-04T00:00:00.000Z";
    row.revokedBy = revokedBy;
    return true;
  }
  /**
   * Mirrors DynamoInvitationRepository.clearWorkshop: only `workshopId` is REMOVED (never
   * blanked), `status` and the provenance survive, and a row with nothing to clear reports
   * FALSE. See the fuller note on the copy in routes.test.ts.
   */
  async clearWorkshop(teamId: string, email: string, revokedBy: string) {
    const row = this.rows.find(
      (i) => i.teamId === teamId && i.email === email.toLowerCase()
    );
    if (!row || !row.workshopId) return false;
    delete row.workshopId;
    row.workshopRevokedAt = "2026-08-06T00:00:00.000Z";
    row.workshopRevokedBy = revokedBy;
    return true;
  }
}

class FakeUsers implements UsersReadModel {
  constructor(private readonly rows: UserView[] = []) {}
  async get(id: string) {
    return this.rows.find((u) => u.id === id) ?? null;
  }
  async upsert(view: UserView) {
    this.rows.push(view);
  }
  async delete() {}
}

class FakeWorkshops implements WorkshopAccess {
  /**
   * The workshop's team-size TEMPLATE, read once at team creation.
   *
   * Returns the platform ceiling here so existing tests are unaffected by the cap: they are
   * about ownership and authorization, not seats. Tests that exercise the cap set their own
   * value, and the "unavailable" case has its own dedicated test — a fake that returned
   * "unavailable" by default would make every creation test assert a 503.
   */
  async teamSeatTemplate(): Promise<number | "unavailable" | "invalid"> {
    return 10;
  }

  /** Every probe of EITHER method — the assertion target for "no east-west call was
   *  made". Both are recorded, so a gate that switched which one it asks is still seen. */
  probes: Array<{ workshopId: string; userId: string; role: string }> = [];
  constructor(private readonly owns = false) {}
  async ownsWorkshop(workshopId: string, userId: string, role: string) {
    this.probes.push({ workshopId, userId, role });
    return this.owns;
  }
  async ownsTeamWorkshop(teamId: string, userId: string, role: string) {
    this.probes.push({ workshopId: teamId, userId, role });
    return this.owns;
  }
}

class FakeWorkshopDirectory implements WorkshopDirectory {
  constructor(private readonly owned: WorkshopRef[] | "unavailable" = []) {}
  async listOwnedWorkshops() {
    return this.owned;
  }
  async resolveWorkshopNames() {
    return {};
  }
}

class FakeAudit implements AuditRepository {
  readonly entries: AuditEntryRead[] = [];
  private tick = 0;
  async record(entry: AuditEntryWrite) {
    const occurredAt = new Date(
      Date.UTC(2026, 7, 4, 0, 0, ++this.tick)
    ).toISOString();
    this.entries.push({ ...entry, occurredAt, at: `${occurredAt}#x` });
    return true;
  }
  async listBySubject(subjectId: string) {
    return this.entries.filter((e) => e.subjectId === subjectId).reverse();
  }
  async listByTeam(teamId: string) {
    return this.entries.filter((e) => e.teamId === teamId).reverse();
  }
}

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

const invitation = (over: Partial<Invitation> = {}): Invitation => ({
  teamId: "t1",
  email: "invitee@example.com",
  status: "PENDING",
  invitedBy: "admin",
  sentAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function build(
  over: Partial<{
    teams: FakeTeams;
    members: FakeMembers;
    invitations: FakeInvitations;
    users: FakeUsers;
    workshops: WorkshopAccess;
    events: InMemoryPublisher;
    audit: AuditRepository;
    workshopDirectory: FakeWorkshopDirectory;
  }> = {}
) {
  const deps = {
    teams: over.teams ?? new FakeTeams([team()]),
    members: over.members ?? new FakeMembers([]),
    invitations: over.invitations ?? new FakeInvitations([]),
    users: over.users ?? new FakeUsers([]),
    workshops: over.workshops ?? new FakeWorkshops(false),
    events: over.events ?? new InMemoryPublisher(),
    audit: over.audit ?? new FakeAudit(),
    workshopDirectory: over.workshopDirectory ?? new FakeWorkshopDirectory([]),
  };
  return { app: createTeamRoutes(deps), deps };
}

// ════════════════════════════════════════════════════════════════════════════
// P0-2 — the roster leak. Register says "CONFIRMED exploitable". VERIFY.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON P0-2: GET /v1/workshops/:workshopId/teams", () => {
  it("FIXED: an unrelated PARTICIPANT gets 200 with an EMPTY list, not the roster", async () => {
    // The register's exploit: a gateway authorizer claim for an unrelated PARTICIPANT
    // returned 200 with team name and roster. Drive exactly that shape now.
    const teams = new FakeTeams([team({ id: "t1", name: "Team One" })]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "insider", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const workshops = new FakeWorkshops(false);
    const { app } = build({ teams, members, workshops });

    const res = await app.request("/v1/workshops/w1/teams", {
      headers: asUser({ id: "stranger", email: "s@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: unknown[] };
    // THE FIX: intersected with the caller's own memberships, which is empty.
    expect(body.teams).toEqual([]);
    // And it cost NO east-west hop — the staff-role gate precedes the probe.
    expect(workshops.probes).toHaveLength(0);
  });

  it("FIXED: ?withMembers=1 discloses no EMAIL on the filtered branch", async () => {
    // A member of ONE team in the workshop reaches the enrichment path legitimately.
    // The address is what must stay behind.
    const teams = new FakeTeams([
      team({ id: "t1", name: "Team One" }),
      team({ id: "t2", name: "Team Two" }),
    ]);
    const members = new FakeMembers([
      { teamId: "t1", userId: "u1", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
      { teamId: "t2", userId: "other", role: "BUILDER", joinedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const users = new FakeUsers([
      { id: "u1", name: "Una", email: "una@example.com" },
      { id: "other", name: "Otto", email: "otto@example.com" },
    ]);
    const { app } = build({ teams, members, users });

    const res = await app.request("/v1/workshops/w1/teams?withMembers=1", {
      headers: asUser({ id: "u1", email: "una@example.com", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      teams: Array<{ id: string; members: Array<{ user: { email?: string } }> }>;
    };
    // Only their own team, and t2's roster is not reachable at all.
    expect(body.teams.map((t) => t.id)).toEqual(["t1"]);
    // No address anywhere in the payload — asserted on the raw text so a nested or
    // renamed field cannot hide one.
    expect(raw).not.toContain("una@example.com");
    expect(raw).not.toContain("otto@example.com");
    expect(body.teams[0].members[0].user.email).toBeUndefined();
  });

  it("FIXED: a JUDGE who does not own the workshop sees no teams", async () => {
    // A JUDGE gets all teams IFF ENTITLED. No entitlement check exists on
    // this route, so today they are on the membership branch — which for a judge (never
    // a team member) is empty. Narrower than the rule, so pinned as the current answer.
    const teams = new FakeTeams([team({ id: "t1" })]);
    const workshops = new FakeWorkshops(false);
    const { app } = build({ teams, workshops });

    const res = await app.request("/v1/workshops/w1/teams", {
      headers: asUser({ id: "judge-1", email: "j@example.com", role: "JUDGE" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { teams: unknown[] }).toEqual({ teams: [] });
    // JUDGE is not a staff role, so no probe. Confirms the cycle invariant.
    expect(workshops.probes).toHaveLength(0);
  });

  it("requires authentication — anonymous is 401", async () => {
    const { app } = build();
    const res = await app.request("/v1/workshops/w1/teams");
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P1-2 — an accepted entitlement cannot be revoked.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON P1-2: revoking an ACCEPTED workshop entitlement", () => {
  /**
   * ⚠ RE-POINTED — P1-2 IS FIXED, AND NOTHING HERE WAS WEAKENED.
   *
   * WHAT THE THREE SPECS BELOW ASSERTED, AND WHY THEY WERE RIGHT. The register claimed an
   * accepted workshop entitlement could not be revoked; these proved it by driving the app:
   * DELETE on an ACCEPTED row answered 409 with `workshopId` untouched, the judge's
   * entitlement survived end to end through `/entitlements/workshops`, and no route of any
   * plausible shape existed that could clear the field (404 for all four probed).
   *
   * WHAT FIXED IT: `DELETE /v1/teams/:teamId/invitations/:email/workshop` (routes.ts), which
   * clears `workshopId` ONLY — the row, its `status`, its `acceptedAt` and its provenance all
   * survive.
   *
   * ⚠ THE 409 IS STILL 409, AND THAT ASSERTION IS KEPT VERBATIM. Gate 4 on the DELETE was NOT
   * relaxed: that row IS the audit record, so DELETING it would destroy history to fix an
   * access bug. The first spec below is UNCHANGED except in name — it still pins the refusal —
   * and what changed is that the refusal is no longer the END of the story, because a second
   * route exists that withdraws the entitlement without destroying anything. That inversion of
   * gate 4 between two routes IS the fix, and the two specs that follow pin both halves.
   *
   * The third spec's own instruction ("If any of these starts answering, P1-2 has a route and
   * this test is the thing to update") is what is being followed here. It keeps probing the
   * three shapes that STILL do not exist, so it remains a real absence check.
   */
  it("FIXED-BY-DESIGN: DELETE on an ACCEPTED row is STILL 409 — that row is the audit record", async () => {
    // The register's claim, re-verified and DELIBERATELY UNCHANGED. A JUDGE's grant lives
    // entirely in `invitation.workshopId` (WORKSHOP_POLICY.JUDGE = "REQUIRED"), and this route
    // refuses to destroy the row that carries it — correctly. The entitlement is withdrawn by
    // the sibling route below instead, which destroys nothing.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "judge@example.com",
        status: "ACCEPTED",
        platformRole: "JUDGE",
        workshopId: "w1",
        scope: "PLATFORM",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/teams/PLATFORM/invitations/judge%40example.com",
      { method: "DELETE", headers: asUser({ id: "admin-1", role: "ADMIN" }) }
    );

    expect(res.status).toBe(409);
    // NOT a defect any more, and the same two assertions prove it: the DELETE touches
    // NOTHING. Both the grant and the history survive its refusal, which is what makes the
    // refusal safe and the separate route necessary.
    expect(invitations.rows[0].workshopId).toBe("w1");
    expect(invitations.rows[0].status).toBe("ACCEPTED");
  });

  it("FIXED: the entitlement is GONE end to end through /entitlements/workshops", async () => {
    // ── THE INVERSION OF THE OLD `OPEN DEFECT` SPEC, WHICH ASSERTED `workshopIds: ["w1"]` ──
    //
    // That spec drove the 409 and then had the same judge ask for their entitled workshops,
    // and they still got w1. THAT was the finding — not the 409. The same two-step now runs
    // the WITHDRAWAL route in place of the DELETE and the union comes back EMPTY.
    //
    // ⚠ IT MUST BE THE FIELD AND NOT THE STATUS THAT CHANGED. `/entitlements/workshops`
    // filters REVOKED and expired rows (see the UNREGISTERED block below),
    // so a fix that flipped `status` to REVOKED would ALSO empty this union — and would have
    // destroyed the acceptance record to do it. The status assertion below is what
    // distinguishes the two, and it is the reason this route exists rather than reusing
    // markRevoked.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "judge@example.com",
        status: "ACCEPTED",
        acceptedAt: "2026-08-02T00:00:00.000Z",
        acceptedBy: "judge-1",
        platformRole: "JUDGE",
        workshopId: "w1",
        scope: "PLATFORM",
      }),
    ]);
    const { app } = build({ invitations });

    const revoke = await app.request(
      "/v1/teams/PLATFORM/invitations/judge%40example.com/workshop",
      { method: "DELETE", headers: asUser({ id: "admin-1", role: "ADMIN" }) }
    );
    expect(revoke.status).toBe(200);
    expect((await revoke.json()) as { revoked: boolean }).toMatchObject({
      revoked: true,
    });

    const entitled = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "judge-1", email: "judge@example.com", role: "JUDGE" }),
    });

    expect(entitled.status).toBe(200);
    expect((await entitled.json()) as { workshopIds: string[] }).toEqual({
      workshopIds: [],
      truncated: false,
    });

    // THE FIELD went; the ROW and its whole history stayed. This is the assertion that says
    // the fix cleared an entitlement rather than falsifying an acceptance.
    expect(invitations.rows).toHaveLength(1);
    expect(invitations.rows[0].workshopId).toBeUndefined();
    expect(invitations.rows[0].status).toBe("ACCEPTED");
    expect(invitations.rows[0].acceptedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("the withdrawal route is the ONLY new shape — the other three still 404", async () => {
    // ── RE-POINTED: this was `no route exists that clears workshopId … 404 for every
    //    plausible shape`, asserting all FOUR were absent. ────────────────────────────
    //
    // DELETE …/invitations/:email/workshop now EXISTS and is asserted at 200 above, so it has
    // moved out of this loop. The other three were never built and are still absent, which is
    // worth keeping: /entitlements/* is a READ surface (E(self), keyed entirely on the
    // caller's own verified claims and taking no parameters), so a revoke verb there would be
    // an authorization write on a route with no subject and no gates. The withdrawal belongs
    // on the invitation that carries the grant, which is where it went.
    //
    // Absence still proven by driving the app rather than by grep, and the instruction stands:
    // if any of these starts answering, it is a new route and this test is what to update.
    const headers = asUser({ id: "admin-1", role: "ADMIN" });

    for (const [method, path] of [
      ["PATCH", "/v1/teams/PLATFORM/invitations/judge%40example.com/workshop"],
      ["DELETE", "/v1/entitlements/workshops/w1"],
      ["POST", "/v1/entitlements/revoke"],
    ] as const) {
      // A FRESH row per probe, so a route that DID answer could not be excused by an earlier
      // iteration having already cleared the field.
      const invitations = new FakeInvitations([
        invitation({
          teamId: "PLATFORM",
          email: "judge@example.com",
          status: "ACCEPTED",
          platformRole: "JUDGE",
          workshopId: "w1",
        }),
      ]);
      const { app } = build({ invitations });
      const res = await app.request(path, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(404);
      // And nothing was written on the way to the 404.
      expect(invitations.rows[0].workshopId, `${method} ${path}`).toBe("w1");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UNREGISTERED — found in review. GET /v1/entitlements/workshops has NO
// tests at all, and its invitation half filters neither STATUS nor EXPIRY.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON UNREGISTERED: /v1/entitlements/workshops honours a REVOKED grant", () => {
  it("FIXED: a REVOKED invitation grants NOTHING", async () => {
    // ── WHAT THIS USED TO ASSERT, AND WHY THE INVERSION MATTERS ──
    //
    // This spec was written as "OPEN DEFECT: a REVOKED invitation still grants the
    // workshop" and it PASSED, because the invitation half of the union was
    // `if (typeof inv.workshopId === "string" && inv.workshopId)` with no status filter at
    // all. Every OTHER reader of this table already filtered REVOKED — lookup-by-email, the
    // pre-signup trigger, resolveRoleFromInvitations, liveInvitationKeys — so this route was
    // the single reader that did not.
    //
    // The consequence was concrete rather than theoretical: DELETE
    // /teams/:teamId/members/:userId calls `markRevoked` in order to withdraw the grant, and
    // this route handed the workshop straight back, leaving rows in exactly that state
    // (REVOKED, still carrying workshopId).
    //
    // Now filtered on the two TERMINAL states. Do not "simplify" this to an ACCEPTED-only
    // allowlist: see the PENDING spec below, which pins the grant that would break.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "judge@example.com",
        status: "REVOKED",
        platformRole: "JUDGE",
        workshopId: "w1",
        revokedAt: "2026-08-04T00:00:00.000Z",
        revokedBy: "admin-1",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "judge-1", email: "judge@example.com", role: "JUDGE" }),
    });

    expect(res.status).toBe(200);
    // A withdrawn grant is NOT an entitlement. 200 with an empty union, never a 403: the
    // question "which workshops may I see" was answered, and the answer is none.
    expect((await res.json()) as { workshopIds: string[] }).toEqual({
      workshopIds: [],
      truncated: false,
    });
  });

  it("FIXED: an EXPIRED invitation grants NOTHING", async () => {
    // The second axis, and it was the same story: `isExpired` was applied by
    // lookup-by-email and lookup-by-token, and by this route neither.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "judge@example.com",
        status: "PENDING",
        platformRole: "JUDGE",
        workshopId: "w1",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "judge-1", email: "judge@example.com", role: "JUDGE" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { workshopIds: string[] }).toEqual({
      workshopIds: [],
      truncated: false,
    });
  });

  it("PENDING is honoured too — a grant applies before it is redeemed", async () => {
    // Pinned as the DELIBERATE half: a newly-invited judge should see the
    // workshop on their first sign-in, so PENDING must count. That is why the fix for
    // the two defects above is a REVOKED/expiry filter, not a status allowlist of
    // ACCEPTED — which would break exactly this case.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "judge@example.com",
        status: "PENDING",
        platformRole: "JUDGE",
        workshopId: "w1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "judge-1", email: "judge@example.com", role: "JUDGE" }),
    });

    expect((await res.json()) as { workshopIds: string[] }).toEqual({
      workshopIds: ["w1"],
      truncated: false,
    });
  });

  it("an INACTIVE membership contributes nothing — the repository's inverted default holds", async () => {
    // The polarity, verified through this route: a removed member's workshop
    // must drop out of E(self). It does, because listByUser filters INACTIVE.
    const teams = new FakeTeams([team({ id: "t1", workshopId: "w9" })]);
    const members = new FakeMembers([
      {
        teamId: "t1",
        userId: "u1",
        role: "BUILDER",
        joinedAt: "2026-01-01T00:00:00.000Z",
        status: "INACTIVE",
      },
    ]);
    const { app } = build({ teams, members, invitations: new FakeInvitations([]) });

    const res = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "u1", email: "u1@example.com", role: "PARTICIPANT" }),
    });

    expect((await res.json()) as { workshopIds: string[] }).toEqual({
      workshopIds: [],
      truncated: false,
    });
  });

  it("no email claim is a 503, never an empty union", async () => {
    const { app } = build();
    const res = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "u1", role: "JUDGE" }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "ENTITLEMENTS_UNAVAILABLE",
    });
  });

  it("a failed half is a 503, never a partial union", async () => {
    const invitations = new FakeInvitations([]);
    invitations.listByEmailThrows = new Error("ProvisionedThroughputExceededException");
    const { app } = build({ invitations });

    const res = await app.request("/v1/entitlements/workshops", {
      headers: asUser({ id: "u1", email: "u1@example.com", role: "JUDGE" }),
    });
    expect(res.status).toBe(503);
  });

  it("takes NO subject parameter — ?userId= and ?email= are ignored", async () => {
    // The enumeration-oracle check. A caller naming someone else's address must get
    // their OWN union, not that person's.
    const invitations = new FakeInvitations([
      invitation({
        teamId: "PLATFORM",
        email: "victim@example.com",
        status: "PENDING",
        platformRole: "JUDGE",
        workshopId: "secret-workshop",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ invitations });

    const res = await app.request(
      "/v1/entitlements/workshops?email=victim%40example.com&userId=victim",
      { headers: asUser({ id: "nosy", email: "nosy@example.com", role: "JUDGE" }) }
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as { workshopIds: string[] }).toEqual({
      workshopIds: [],
      truncated: false,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P2-2 — listByTeam / listByEmail unpaginated.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON P2-2: unpaginated invitation Queries", () => {
  it("FIXED: both listByTeam and listByEmail page, bound, and REFUSE to truncate", async () => {
    // ── WHAT THIS SPEC USED TO ASSERT, AND WHY IT IS INVERTED RATHER THAN DELETED ──
    //
    // It was "OPEN DEFECT: neither listByTeam nor listByEmail follows LastEvaluatedKey", and it
    // PASSED: both methods issued ONE QueryCommand and returned `res.Items`, with no
    // ExclusiveStartKey loop and no Limit. DynamoDB's first 1MB page was the whole answer either
    // one would ever see, and the rest was dropped in silence. Per this file's own header — "the
    // ones marked OPEN DEFECT will FAIL the moment the defect is fixed, which is the signal that
    // the register entry can be closed" — this is that signal, so the polarity flips and the
    // entry is closed. Nothing here is weakened: the assertions still name the same three
    // mechanisms, they now require them PRESENT.
    //
    // Still proven against the SOURCE rather than a fake, for the reason the original gave: a
    // fake cannot model a 1MB page boundary. The BEHAVIOURAL proof — that paging is followed,
    // that the bound is reported as a throw, and the exact ExclusiveStartKey/Limit sent to the
    // store — lives in repository.dynamo.test.ts, which drives the real repository against a
    // DocClient that reproduces DynamoDB's paging semantics.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("./repository.dynamo.ts", import.meta.url),
      "utf8"
    );

    // Both readers now delegate to ONE shared bounded helper, which is where the loop lives —
    // deliberately, so the two cannot drift into bounding themselves differently.
    const helper = src.slice(src.indexOf("async function listInvitationsBounded("));
    const helperBody = helper.slice(0, helper.indexOf("\n}"));
    // The three mechanisms whose absence WAS the defect.
    expect(helperBody).toContain("ExclusiveStartKey");
    expect(helperBody).toContain("LastEvaluatedKey");
    expect(helperBody).toContain("Limit");
    // And the bound is REPORTED, never returned as a quietly short list.
    expect(helperBody).toContain("InvitationQueryBoundExceeded");

    // Each reader reaches the store ONLY through that helper — a second raw QueryCommand in
    // either body would be an unpaged read again, which is exactly how this regresses.
    for (const signature of [
      "async listByEmail(email: string): Promise<Invitation[]>",
      "async listByTeam(teamId: string): Promise<Invitation[]>",
    ]) {
      const method = src.slice(src.indexOf(signature));
      const body = method.slice(0, method.indexOf("\n  }"));
      expect(body, signature).toContain("listInvitationsBounded");
      expect(body, signature).not.toContain("new QueryCommand");
    }
  });
});
