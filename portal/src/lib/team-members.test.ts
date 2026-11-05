// ── ⚠ THE FOURTH CONSUMER OF THE ROSTER FOLD HAD NO FILTER ────────────────────────────────────
//
// The rule is "a membership row with `status === "INACTIVE"` must not count as a member anywhere",
// and it exists because `GET /v1/teams/:id/members` returns removed rows DELIBERATELY so a
// Reactivate action can exist. Three consumers applied it, `team.getById`, `team.listMembers`, and
// an independent re-implementation in the desktop `team-data` route. `workshop.getById`, the fourth
// consumer of the same `?withMembers=1` fold, applied nothing.
//
// The consequence was on the screen staff use to review a running experience: the per-team avatar
// strip and the "n / maxTeamSize members" seat line, the workshop-wide member total, and the People
// tab, which carries each person's email where the caller is entitled to it, were all built from
// the unfiltered array. So a facilitator was told a removed participant was still on the team, team
// occupancy read as full when it was not, and a removed person's PII stayed on a staff surface
// after their access was withdrawn. No attacker action needed: any removal produced the divergence.
//
// Both the predicate and the fold now live here so the fifth consumer has one thing to import.

import { describe, it, expect } from "vitest";
import { isActiveMember, withActiveMembers } from "./team-members";
import type { TeamMemberRecord } from "./backend-types";

const member = (over: Partial<TeamMemberRecord> = {}): TeamMemberRecord => ({
  teamId: "t1",
  userId: "u1",
  role: "MEMBER",
  joinedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("isActiveMember", () => {
  it("excludes INACTIVE, case- and whitespace-insensitively", () => {
    // Case-insensitive for the same reason the service is; trimmed because a stored value with a
    // stray space must not read as active.
    for (const status of ["INACTIVE", "inactive", "Inactive", " INACTIVE ", "\tinactive\n"]) {
      expect(isActiveMember(member({ status })), JSON.stringify(status)).toBe(false);
    }
  });

  it("keeps ACTIVE", () => {
    for (const status of ["ACTIVE", "active", " Active "]) {
      expect(isActiveMember(member({ status })), status).toBe(true);
    }
  });

  it("⚠ KEEPS A ROW WITH NO STATUS, AND THE POLARITY IS FORCED", () => {
    // Rows written before `status` existed carry no attribute and absent means ACTIVE, so a
    // `=== "ACTIVE"` form would empty every legacy team's roster and, on the workspace layout -
    // take the tabs with it. This is the assertion that must not be "tidied".
    expect(isActiveMember(member())).toBe(true);
    expect(isActiveMember(member({ status: undefined }))).toBe(true);
    expect(isActiveMember(member({ status: "" }))).toBe(true);
  });

  it("keeps an unrecognised status rather than dropping the person", () => {
    // Excluded on the DENY value only: a status this tier has never heard of must not silently
    // remove someone from their own team.
    expect(isActiveMember(member({ status: "PENDING" }))).toBe(true);
  });
});

describe("withActiveMembers, the fold workshop.getById was missing", () => {
  it("drops INACTIVE rows and counts only what survived", () => {
    const folded = withActiveMembers({
      id: "team-1",
      members: [
        member({ userId: "active-1", status: "ACTIVE" }),
        member({ userId: "removed", status: "INACTIVE" }),
        member({ userId: "legacy" }),
      ],
    });
    expect(folded.members.map((m) => m.userId)).toEqual(["active-1", "legacy"]);
    expect(folded._count.members).toBe(2);
  });

  it("⚠ OVERRIDES A SERVICE-SUPPLIED _count RATHER THAN PREFERRING IT", () => {
    // This is the half of the fix that filtering alone would have missed. The old code read
    // `t._count?.members ?? (t.members || []).length`, so whenever the service supplied a count -
    // which INCLUDES INACTIVE rows, that unfiltered total was what drove the "n / maxTeamSize"
    // seat line. Filtering the array while trusting the count would have left the seat line wrong.
    const folded = withActiveMembers({
      id: "team-1",
      members: [member({ status: "ACTIVE" }), member({ userId: "gone", status: "INACTIVE" })],
      _count: { members: 2 },
    });
    expect(folded._count.members).toBe(1);
  });

  it("normalises a bare team from a backend that ignored withMembers", () => {
    // The behaviour the original comment at the call site existed for, kept.
    // `members: undefined` rather than the key omitted, which is what the wire case actually is -
    // and TS refuses an argument with NO property in common with the generic's constraint.
    const folded = withActiveMembers({ id: "team-1", members: undefined });
    expect(folded.members).toEqual([]);
    expect(folded._count.members).toBe(0);
  });

  it("preserves the team's other fields", () => {
    const folded = withActiveMembers({ id: "team-1", name: "Phoenix", maxTeamSize: 6, members: [] });
    expect(folded).toMatchObject({ id: "team-1", name: "Phoenix", maxTeamSize: 6 });
  });

  it("does not mutate its input", () => {
    const team = { id: "t", members: [member({ status: "INACTIVE" })] };
    withActiveMembers(team);
    expect(team.members).toHaveLength(1);
  });
});
