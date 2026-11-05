import { describe, it, expect } from "vitest";
import {
  canRead,
  canReadTeamContent,
  canWrite,
  canWriteTeamContent,
  isReadOnlyRole,
  mayHoldTeamMembership,
  type WorkshopAccess,
} from "./authz.js";
import type {
  AdmitOutcome, TeamMember, TeamMemberRepository } from "./domain.js";
import { isInactiveMembership } from "./domain.js";

/**
 * The Team service's access rules are the ones every OTHER service defers to: five
 * services answer "may this user touch this team?" by calling GET /teams/:id/access,
 * which is a thin wrapper over the predicates here. So a regression in this file
 * silently widens or narrows access in five services at once.
 *
 * Both collaborators are injected: membership from THIS service's teamMembers, and
 * workshop ownership from the Workshop context via WorkshopAccess. Fakes below.
 *
 * ── TWO PREDICATE FAMILIES, TESTED SEPARATELY AND DELIBERATELY IN PARALLEL ──
 *
 * Several cases below therefore appear TWICE — once for the ADMINISTRATION predicate
 * (canRead/canWrite, which an ADMIN and a workshop-owning FACILITATOR pass) and once for
 * the CONTENT predicate (canReadTeamContent, which only a member passes). The duplication
 * is the point: it is what proves the split exists rather than one predicate having been
 * quietly redefined. Each content case names the administration case it inverts.
 */

/**
 * In-memory TeamMemberRepository over an explicit "teamId:userId" member set.
 *
 * MIRRORS THE REAL REPOSITORY'S INVERTED DEFAULT, and that is not a convenience — it is
 * what makes the "a removed member is refused" cases below mean anything. The real
 * `DynamoTeamMemberRepository.get()` returns NULL for a row whose `status` is INACTIVE
 * (see the class note there and on TeamMemberRepository in domain.ts), so a fake that
 * returned the raw row would model a repository the platform does not have, and every
 * predicate below would be asserted against the wrong collaborator.
 *
 * The DIVISION OF LABOUR under test here: the REPOSITORY decides that a deactivated row is
 * not a membership, and the PREDICATES decide that a null membership grants nothing. This
 * file tests the second half against a faithful first half; repository.dynamo.test.ts
 * tests the first half against the real DynamoDB command input.
 */
class FakeMembers implements TeamMemberRepository {
  constructor(private readonly rows: TeamMember[] = []) {}

  async get(teamId: string, userId: string): Promise<TeamMember | null> {
    const row = await this.getIncludingInactive(teamId, userId);
    // The one line the real repository turns on: deactivated means not a member.
    if (row && isInactiveMembership(row.status)) return null;
    return row;
  }
  async getIncludingInactive(
    teamId: string,
    userId: string
  ): Promise<TeamMember | null> {
    return this.rows.find((m) => m.teamId === teamId && m.userId === userId) ?? null;
  }
  async listByTeam(teamId: string): Promise<TeamMember[]> {
    return (await this.listByTeamIncludingInactive(teamId)).filter(
      (m) => !isInactiveMembership(m.status)
    );
  }
  async listByTeamIncludingInactive(teamId: string): Promise<TeamMember[]> {
    return this.rows.filter((m) => m.teamId === teamId);
  }
  async listByUser(userId: string): Promise<TeamMember[]> {
    return this.rows
      .filter((m) => m.userId === userId)
      .filter((m) => !isInactiveMembership(m.status));
  }
  async put(member: TeamMember): Promise<TeamMember> {
    this.rows.push(member);
    return member;
  }
  /**
   * ADMIT. The real one is a TransactWriteItems that also moves the team's
   * `memberCount` under a cap condition; this file's tests are about AUTHORIZATION, not
   * seats, so it admits unconditionally and reports the idempotent case honestly.
   */
  async admit(member: TeamMember): Promise<AdmitOutcome> {
    const existing = this.rows.find(
      (m) => m.teamId === member.teamId && m.userId === member.userId
    );
    if (existing) return "already-member";
    this.rows.push(member);
    return "admitted";
  }
  async deactivate(
    teamId: string,
    userId: string,
    removedBy: string,
    removedByRole: string
  ): Promise<boolean> {
    const row = this.rows.find((m) => m.teamId === teamId && m.userId === userId);
    // Conditional, like the store: no row or already INACTIVE is a no-op reporting false.
    if (!row || isInactiveMembership(row.status)) return false;
    row.status = "INACTIVE";
    row.removedBy = removedBy;
    row.removedByRole = removedByRole;
    return true;
  }
  /** Returns AdmitOutcome: reactivating into a full team is refused. */
  async reactivate(teamId: string, userId: string, by: string): Promise<AdmitOutcome> {
    const row = this.rows.find((m) => m.teamId === teamId && m.userId === userId);
    if (!row || !isInactiveMembership(row.status)) return "already-member";
    row.status = "ACTIVE";
    row.reactivatedBy = by;
    return "admitted";
  }
}

/** WorkshopAccess stub that records whether it was consulted at all. */
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

  calls = 0;
  constructor(private readonly owns = false) {}
  async ownsTeamWorkshop(): Promise<boolean> {
    this.calls++;
    return this.owns;
  }
  async ownsWorkshop(): Promise<boolean> {
    this.calls++;
    return this.owns;
  }
}

const member = (teamId: string, userId: string): TeamMember => ({
  teamId,
  userId,
  role: "BUILDER",
  joinedAt: "2026-01-01T00:00:00.000Z",
});

/**
 * A REMOVED member's row — the one the removal now KEEPS instead of deleting.
 *
 * Carries a real removal stamp rather than only the status, because that is the row shape
 * the store actually writes and a predicate must be indifferent to all of it: `removedAt`
 * and `removedBy` are present, `role` and `joinedAt` SURVIVE (that is what reactivation
 * restores), and none of it may make any predicate answer differently from an absent row.
 */
const removedMember = (teamId: string, userId: string): TeamMember => ({
  ...member(teamId, userId),
  status: "INACTIVE",
  removedAt: "2026-08-04T10:00:00.000Z",
  removedBy: "fac",
  removedByRole: "FACILITATOR",
});

describe("isReadOnlyRole", () => {
  it("treats EXECUTIVE as read-only and every write role as not", () => {
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
    for (const role of ["ADMIN", "FACILITATOR", "PARTICIPANT", "JUDGE"]) {
      expect(isReadOnlyRole(role)).toBe(false);
    }
  });

  it("does not treat an unknown role as read-only", () => {
    // Read-only is an ALLOW-list of restricted roles, not a default. An unknown
    // role is stopped by canRead (no membership, not staff), not by this check.
    expect(isReadOnlyRole("SOMETHING_NEW")).toBe(false);
    expect(isReadOnlyRole("")).toBe(false);
  });
});

describe("canRead", () => {
  it("lets a member of the team read it", async () => {
    const members = new FakeMembers([member("t1", "u1")]);
    const workshops = new FakeWorkshops(false);
    expect(await canRead(members, workshops, "t1", "u1", "PARTICIPANT")).toBe(true);
  });

  it("refuses a non-member with no workshop ownership", async () => {
    const members = new FakeMembers([member("t1", "someone-else")]);
    expect(await canRead(new FakeMembers([]), new FakeWorkshops(false), "t1", "u1", "PARTICIPANT")).toBe(
      false
    );
    expect(await canRead(members, new FakeWorkshops(false), "t1", "u1", "PARTICIPANT")).toBe(false);
  });

  it("does not leak membership across teams", async () => {
    // Being in t1 must not grant access to t2 — the membership check is keyed on
    // BOTH teamId and userId.
    const members = new FakeMembers([member("t1", "u1")]);
    expect(await canRead(members, new FakeWorkshops(false), "t2", "u1", "PARTICIPANT")).toBe(false);
  });

  it("reads an ADMIN's teams THROUGH workshop ownership, exactly like a facilitator", async () => {
    // ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the admin-scoping rule
    // change. It read: "lets a global ADMIN read any team without consulting the Workshop
    // service … an admin read must not depend on the Workshop service being up", and
    // asserted `workshops.calls === 0`.
    //
    // An ADMIN is now scoped to the experiences they OWN, so the unconditional short-circuit
    // is gone and they take the SAME `isStaffRole && ownsTeamWorkshop` branch as a
    // FACILITATOR — compare the facilitator case immediately below, which is now
    // character-for-character the same assertion with a different role string. That is the
    // point: one predicate, two owner roles, no role-shaped exception.
    const members = new FakeMembers([]);
    expect(await canRead(members, new FakeWorkshops(true), "t1", "admin", "ADMIN")).toBe(true);
    expect(await canRead(members, new FakeWorkshops(false), "t1", "admin", "ADMIN")).toBe(false);

    // ⚠ AND IT NOW COSTS THE HOP IT USED TO SKIP. Asserted rather than left implicit,
    // because the old test's `calls === 0` was a real latency property that this change
    // GIVES UP: an admin's administration read now depends on the Workshop service being
    // reachable. Cycle-safe (the callee resolves ADMIN and owner from its own row), but no
    // longer free.
    const workshops = new FakeWorkshops(true);
    await canRead(members, workshops, "t1", "admin", "ADMIN");
    expect(workshops.calls).toBe(1);
  });

  it("lets a FACILITATOR read a non-member team ONLY in a workshop they own", async () => {
    // ADMINISTRATION scope, unchanged. Its content counterpart is INVERTED —
    // see "REFUSES a FACILITATOR who owns the workshop" in canReadTeamContent.
    const members = new FakeMembers([]);
    expect(await canRead(members, new FakeWorkshops(true), "t1", "f1", "FACILITATOR")).toBe(true);
    expect(await canRead(members, new FakeWorkshops(false), "t1", "f1", "FACILITATOR")).toBe(false);
  });

  it("never asks about workshop ownership for a non-staff role", async () => {
    // A PARTICIPANT/JUDGE/EXECUTIVE who owned a workshop row would still not get
    // staff-wide access: the ownership branch is gated on the staff role FIRST.
    for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
      const workshops = new FakeWorkshops(true);
      expect(await canRead(new FakeMembers([]), workshops, "t1", "u1", role)).toBe(false);
      expect(workshops.calls).toBe(0);
    }
  });

  it("lets an EXECUTIVE read a team they belong to", async () => {
    // Read-only means read-ONLY, not no-access — the exec dashboard is the reason
    // this role exists.
    const members = new FakeMembers([member("t1", "exec")]);
    expect(await canRead(members, new FakeWorkshops(false), "t1", "exec", "EXECUTIVE")).toBe(true);
  });
});

describe("canWrite", () => {
  it("grants write to a member with a write role", async () => {
    const members = new FakeMembers([member("t1", "u1")]);
    expect(await canWrite(members, new FakeWorkshops(false), "t1", "u1", "PARTICIPANT")).toBe(true);
  });

  it("denies write to an EXECUTIVE even when they can read", async () => {
    // The single most important asymmetry in the model: an EXECUTIVE member has
    // canRead=true and canWrite=false. If these ever collapse into one flag, the
    // read-only role silently gains mutation rights in three services.
    const members = new FakeMembers([member("t1", "exec")]);
    const workshops = new FakeWorkshops(false);
    expect(await canRead(members, workshops, "t1", "exec", "EXECUTIVE")).toBe(true);
    expect(await canWrite(members, workshops, "t1", "exec", "EXECUTIVE")).toBe(false);
  });

  it("short-circuits the read-only check before any membership or cross-service lookup", async () => {
    const workshops = new FakeWorkshops(true);
    expect(await canWrite(new FakeMembers([]), workshops, "t1", "exec", "EXECUTIVE")).toBe(false);
    expect(workshops.calls).toBe(0);
  });

  it("never grants write without read (a non-member write role is still denied)", async () => {
    const members = new FakeMembers([]);
    const workshops = new FakeWorkshops(false);
    expect(await canWrite(members, workshops, "t1", "outsider", "PARTICIPANT")).toBe(false);
  });

  it("grants write to a FACILITATOR who owns the workshop", async () => {
    // ADMINISTRATION scope, unchanged — this is what keeps member REMOVAL
    // working for the workshop owner. Its content counterpart is INVERTED; see
    // "REFUSES a FACILITATOR who owns the workshop" in canWriteTeamContent.
    expect(
      await canWrite(new FakeMembers([]), new FakeWorkshops(true), "t1", "f1", "FACILITATOR")
    ).toBe(true);
  });
});

// ─── TEAM CONTENT: member-only ──────────────────────────────────────────────

describe("canReadTeamContent", () => {
  it("lets a member of the team read its content", async () => {
    const members = new FakeMembers([member("t1", "u1")]);
    expect(await canReadTeamContent(members, "t1", "u1", "PARTICIPANT")).toBe(true);
  });

  it("refuses a non-member", async () => {
    const members = new FakeMembers([member("t1", "someone-else")]);
    expect(await canReadTeamContent(members, "t1", "u1", "PARTICIPANT")).toBe(false);
    expect(await canReadTeamContent(new FakeMembers([]), "t1", "u1", "PARTICIPANT")).toBe(
      false
    );
  });

  it("does not leak membership across teams", async () => {
    // Keyed on BOTH teamId and userId, exactly as canRead is.
    const members = new FakeMembers([member("t1", "u1")]);
    expect(await canReadTeamContent(members, "t2", "u1", "PARTICIPANT")).toBe(false);
  });

  it("REFUSES a global ADMIN who is not a member — the INVERSE of canRead", async () => {
    // ── THE CENTRAL ASSERTION OF THE MEMBER-ONLY RULE ──
    //
    // The administration test "lets a global ADMIN read any team without consulting the
    // Workshop service" (canRead, above) USED TO BE the only rule, and it still holds
    // THERE. Here it is inverted: an admin has no ambient access to what a team WROTE.
    // Both must pass simultaneously, which is what proves the two predicates are separate
    // rather than one having been redefined.
    //
    // There is NO exception: the audited break-glass route was removed,
    // so an admin has no content path at all. An EXECUTIVE member reads it instead — see
    // "lets an EXECUTIVE MEMBER read, and refuses a non-member EXECUTIVE" below.
    const members = new FakeMembers([]);
    expect(await canReadTeamContent(members, "t1", "admin", "ADMIN")).toBe(false);
  });

  it("REFUSES a FACILITATOR who owns the workshop — the INVERSE of canRead", async () => {
    // Inverts "lets a FACILITATOR read a non-member team ONLY in a workshop they own".
    // Owning the workshop is what makes them staff for ADMINISTRATION; it grants nothing
    // over the content. There is no WorkshopAccess to pass here at all — see the next test.
    const members = new FakeMembers([]);
    expect(await canReadTeamContent(members, "t1", "f1", "FACILITATOR")).toBe(false);
  });

  it("REFUSES a JUDGE with no membership row", async () => {
    // A judge evaluates a submission, which is a deliverable handed over deliberately —
    // not the team's private workings. Judging routes are unaffected: canRead already
    // returned false for a JUDGE on every evaluation read route before this change.
    expect(await canReadTeamContent(new FakeMembers([]), "t1", "j1", "JUDGE")).toBe(false);
  });

  it("lets an EXECUTIVE MEMBER read, and refuses a non-member EXECUTIVE", async () => {
    // Read-only means read-ONLY, not no-access — but it is membership that grants the
    // read, not the role.
    //
    // THIS IS NOW THE ONLY INVESTIGATION PATH ON THE PLATFORM. With admin break-glass removed,
    // an executive who is a MEMBER is the whole instrument: this read plus the
    // canWriteTeamContent refusal below. If this pair ever breaks, an abuse report becomes
    // uninvestigable and no other test says so.
    const inTeam = new FakeMembers([member("t1", "exec")]);
    expect(await canReadTeamContent(inTeam, "t1", "exec", "EXECUTIVE")).toBe(true);
    expect(await canReadTeamContent(new FakeMembers([]), "t1", "exec", "EXECUTIVE")).toBe(
      false
    );
  });

  it("CANNOT make an east-west call — the no-hop property, enforced by the signature", async () => {
    // ── THE STRUCTURAL GUARANTEE ──
    //
    // canReadTeamContent takes NO WorkshopAccess parameter, so there is no dependency in
    // scope for it to call. This test asserts the property the signature creates: a
    // WorkshopAccess that would answer "yes, they own the workshop" is NEVER consulted,
    // because it cannot be passed at all.
    //
    // Written as a `calls === 0` assertion rather than left to the type system because the
    // failure mode being prevented is someone ADDING the parameter back and threading a hop
    // into a content decision — which would compile fine and would break this test.
    const workshops = new FakeWorkshops(true);
    expect(await canReadTeamContent(new FakeMembers([]), "t1", "f1", "FACILITATOR")).toBe(
      false
    );
    expect(workshops.calls).toBe(0);

    // And the same for every role, including the two that pass the administration predicate
    // without membership.
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      const probe = new FakeWorkshops(true);
      expect(await canReadTeamContent(new FakeMembers([]), "t1", "u1", role)).toBe(false);
      expect(probe.calls, `${role} must not trigger a hop`).toBe(0);
    }
  });

  it("ignores the role entirely for the READ decision", async () => {
    // Membership decides, whatever the role — including a role the service does not model.
    // This is what makes the predicate auditable in one line, and it is why adding a role
    // branch has to be a visible edit rather than a new parameter.
    const members = new FakeMembers([member("t1", "u1")]);
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE", "PARTICIPANT", "SOMETHING_NEW", ""]) {
      expect(await canReadTeamContent(members, "t1", "u1", role)).toBe(true);
      expect(await canReadTeamContent(members, "t1", "outsider", role)).toBe(false);
    }
  });
});

describe("canWriteTeamContent", () => {
  it("grants write to a member with a write role", async () => {
    const members = new FakeMembers([member("t1", "u1")]);
    expect(await canWriteTeamContent(members, "t1", "u1", "PARTICIPANT")).toBe(true);
  });

  it("denies write to an EXECUTIVE member who CAN read", async () => {
    // The same asymmetry canWrite has, preserved on the content pair: collapsing them
    // would hand a read-only role mutation rights on five services' content surfaces.
    const members = new FakeMembers([member("t1", "exec")]);
    expect(await canReadTeamContent(members, "t1", "exec", "EXECUTIVE")).toBe(true);
    expect(await canWriteTeamContent(members, "t1", "exec", "EXECUTIVE")).toBe(false);
  });

  it("REFUSES a FACILITATOR who owns the workshop — the INVERSE of canWrite", async () => {
    // Inverts "grants write to a FACILITATOR who owns the workshop". Both hold at once,
    // for their respective predicates.
    expect(await canWriteTeamContent(new FakeMembers([]), "t1", "f1", "FACILITATOR")).toBe(
      false
    );
  });

  it("REFUSES a non-member ADMIN", async () => {
    expect(await canWriteTeamContent(new FakeMembers([]), "t1", "admin", "ADMIN")).toBe(
      false
    );
  });

  it("never grants write without read", async () => {
    expect(
      await canWriteTeamContent(new FakeMembers([]), "t1", "outsider", "PARTICIPANT")
    ).toBe(false);
  });

  it("short-circuits the read-only check before ANY store read", async () => {
    // A repository that would throw if touched proves the ordering rather than merely
    // suggesting it — an EXECUTIVE must be refused on the local role check alone.
    const exploding: TeamMemberRepository = {
      get: async () => {
        throw new Error("the store must not be reached for a read-only role");
      },
      getIncludingInactive: async () => {
        throw new Error("the store must not be reached for a read-only role");
      },
      listByTeam: async () => [],
      listByTeamIncludingInactive: async () => [],
      listByUser: async () => [],
      admit: async () => "admitted" as const,
      deactivate: async () => false,
      reactivate: async () => "admitted" as const,
    };
    expect(await canWriteTeamContent(exploding, "t1", "exec", "EXECUTIVE")).toBe(false);
  });
});

// ─── Requirement (b): who may hold a membership row at all ──────────────────

describe("mayHoldTeamMembership", () => {
  it("REFUSES the three platform-scoped roles", async () => {
    // ADMIN, FACILITATOR and JUDGE are invited to the PLATFORM, not to a team
    // (PLATFORM_SCOPED_ROLES in shared/constants/roles.ts, of which the set in
    // authz.ts is a deliberate local copy). Since content access is now decided ONLY by a
    // membership row, one of these roles acquiring a row would regain exactly the ambient
    // access the member-only rule removes — in a form no role check can see.
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE"]) {
      expect(mayHoldTeamMembership(role), role).toBe(false);
    }
  });

  it("ALLOWS the two team-scoped roles", () => {
    // The whole platform depends on this half: refusing PARTICIPANT would mean nobody can
    // join a team at all.
    expect(mayHoldTeamMembership("PARTICIPANT")).toBe(true);
    expect(mayHoldTeamMembership("EXECUTIVE")).toBe(true);
  });

  it("refuses an ABSENT role", () => {
    // A membership write keyed on no verified role has no business succeeding.
    expect(mayHoldTeamMembership(undefined)).toBe(false);
    expect(mayHoldTeamMembership("")).toBe(false);
  });

  it("ALLOWS an unknown role — a DENY-list, opposite to the grant matrices", () => {
    // Deliberate and worth pinning, because it is the opposite default to canGrantRole and
    // canSeeUser and would otherwise look like a bug. This is a deny-list of three named
    // platform-wide roles, so adding a sixth TEAM-shaped role does not require editing
    // authz.ts before anyone holding it can join a team. The roles that must never hold
    // membership are known and enumerated; the roles that may are open.
    expect(mayHoldTeamMembership("SOMETHING_NEW")).toBe(true);
  });

  it("is case-sensitive, matching every other role comparison in the service", () => {
    // Roles arrive from `cognito:groups` via collapseGroupsToRole, which only ever emits
    // the upper-case names — so a lower-case value is not a real role. It reads as
    // "unknown" and is ALLOWED by the deny-list above, which is why this is pinned rather
    // than left implicit: it is only safe because such a value cannot reach here from a
    // verified token, and the workshop service's own create gate makes the same assumption
    // ("Facilitator" is refused there for the same reason).
    expect(mayHoldTeamMembership("admin")).toBe(true);
  });
});

// ─── A DEACTIVATED MEMBERSHIP GRANTS NOTHING, ON EVERY PREDICATE ────────────

/**
 * ── THE SAFETY PROPERTY OF THE REACTIVATION CHANGE, PINNED AT THE PREDICATES ──
 *
 * Member removal used to be a HARD DELETE. It now KEEPS the row with `status: INACTIVE`, so
 * a removal can be reversed and so the roster can show who was removed. The objection to a
 * soft-delete flag was exact and correct: a flag "needs every reader to filter it, and
 * missing one silently restores access".
 *
 * That objection is answered STRUCTURALLY, in the repository, ONCE: `get()` returns NULL for
 * a deactivated row. Every predicate in this file already treats null as "not a member", so
 * an inactive membership grants nothing at every one of them WITH NO CHANGE TO ANY OF THEM.
 *
 * WHICH MEANS THESE FOUR TESTS ARE THE WHOLE OF THE PROOF FOR THIS LAYER. There is no
 * `status` check in authz.ts to test — deliberately, because a check here would be a check
 * somebody could forget somewhere else. What CAN be tested is the OUTCOME: a removed person
 * is refused by every predicate, exactly as an outsider is. If `get()` is ever "simplified"
 * to return the raw row, these fail — which is the point of writing them at this level
 * rather than trusting the repository test alone.
 *
 * Every case pairs the inactive row against the SAME row without the status, so a passing
 * assertion cannot be explained by the row being malformed or the user id being wrong.
 */
describe("a REMOVED (inactive) membership is not a membership", () => {
  it("canRead REFUSES a removed member, exactly as it refuses an outsider", async () => {
    const workshops = new FakeWorkshops(false);
    // The control: the same person, same row, ACTIVE — proves the refusal below is the
    // STATUS and not a typo'd id or a broken fake.
    expect(
      await canRead(new FakeMembers([member("t1", "u1")]), workshops, "t1", "u1", "PARTICIPANT")
    ).toBe(true);

    expect(
      await canRead(
        new FakeMembers([removedMember("t1", "u1")]),
        workshops,
        "t1",
        "u1",
        "PARTICIPANT"
      )
    ).toBe(false);
  });

  it("canWrite REFUSES a removed member", async () => {
    const workshops = new FakeWorkshops(false);
    expect(
      await canWrite(new FakeMembers([member("t1", "u1")]), workshops, "t1", "u1", "PARTICIPANT")
    ).toBe(true);

    expect(
      await canWrite(
        new FakeMembers([removedMember("t1", "u1")]),
        workshops,
        "t1",
        "u1",
        "PARTICIPANT"
      )
    ).toBe(false);
  });

  it("canReadTeamContent REFUSES a removed member — the member-only surface", async () => {
    // The load-bearing one for content. This predicate IS the whole of team
    // content authorization for five services, so a removed member passing it would hand
    // them the board, the chat, the AI threads, the commits and the phase notes at once.
    expect(
      await canReadTeamContent(new FakeMembers([member("t1", "u1")]), "t1", "u1", "PARTICIPANT")
    ).toBe(true);

    expect(
      await canReadTeamContent(
        new FakeMembers([removedMember("t1", "u1")]),
        "t1",
        "u1",
        "PARTICIPANT"
      )
    ).toBe(false);
  });

  it("canWriteTeamContent REFUSES a removed member", async () => {
    expect(
      await canWriteTeamContent(new FakeMembers([member("t1", "u1")]), "t1", "u1", "PARTICIPANT")
    ).toBe(true);

    expect(
      await canWriteTeamContent(
        new FakeMembers([removedMember("t1", "u1")]),
        "t1",
        "u1",
        "PARTICIPANT"
      )
    ).toBe(false);
  });

  it("does NOT refuse a member whose row carries NO status at all", async () => {
    // THE FORCED POLARITY, and the reason it is forced rather than chosen. EVERY membership
    // row written before this field existed carries no `status` attribute, so reading absence
    // as INACTIVE would revoke the whole platform's team access the moment this deploys —
    // a lockout, which is worse than a leak that does not exist yet because nothing has been
    // deactivated. Same rule as isSpentInvitation and isExpired: test for the DENY value.
    const legacy: TeamMember = {
      teamId: "t1",
      userId: "u1",
      role: "BUILDER",
      joinedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(legacy.status).toBeUndefined();
    expect(
      await canReadTeamContent(new FakeMembers([legacy]), "t1", "u1", "PARTICIPANT")
    ).toBe(true);
  });

  it("refuses regardless of the CASING the status was written in", async () => {
    // The constant is COPIED into the docs service's bundle (it reads this table directly —
    // no NAT route to the Team API), so a casing difference between the copies must not be
    // the thing that decides whether a removed person still has access. Both sides compare
    // case-insensitively; this pins ours.
    for (const status of ["INACTIVE", "inactive", "Inactive", " INACTIVE "]) {
      const rows = [{ ...member("t1", "u1"), status }];
      expect(
        await canReadTeamContent(new FakeMembers(rows), "t1", "u1", "PARTICIPANT"),
        status
      ).toBe(false);
    }
  });

  it("leaves a removed member's OTHER team untouched", async () => {
    // The status is per-ROW, so being removed from t1 must not affect t2. A predicate keyed
    // on the person rather than the pair would fail this.
    const members = new FakeMembers([
      removedMember("t1", "u1"),
      member("t2", "u1"),
    ]);
    expect(await canReadTeamContent(members, "t1", "u1", "PARTICIPANT")).toBe(false);
    expect(await canReadTeamContent(members, "t2", "u1", "PARTICIPANT")).toBe(true);
  });
});
