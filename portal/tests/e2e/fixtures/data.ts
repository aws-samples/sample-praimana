/**
 * Deterministic fixture data for the two screens under test.
 *
 * ── SEEDED, NOT RANDOM ──
 * Every id and name here is a fixed literal. There is no faker and no `Date.now()` in an
 * identifier, because a fixture that differs per run makes a failure un-replayable: the
 * whole value of a browser spec that catches a focus defect is that the reader can run the
 * same command and see the same thing. Where a spec needs variation (the boundary cases
 * below), the variants are enumerated, not generated.
 *
 * ── THE SHAPES ARE COPIED FROM THE ROUTERS, NOT INVENTED ──
 * `TeamMemberFixture` mirrors what team.getById's mapper emits (routers/team.ts:37 — every
 * member gets `id: m.userId` and a `user` object with a "Unknown" name fallback), and
 * `AdminUserFixture` mirrors the `AdminUser` interface (routers/admin.ts:42). A fixture that
 * drifts from the router would test the fixture.
 */

import type { SpecIdentity } from "./session";

/** The signed-in ADMIN most specs adopt. */
export const ADMIN_SELF: SpecIdentity = {
  id: "sub-admin-0001",
  email: "e2e-admin@example.test",
  name: "Ada Admin",
  role: "ADMIN",
};

/** A FACILITATOR, for the lateral-attack gating spec. */
export const FACILITATOR_SELF: SpecIdentity = {
  id: "sub-facil-0001",
  email: "e2e-facilitator@example.test",
  name: "Fred Facilitator",
  role: "FACILITATOR",
};

/** An EXECUTIVE, who is read-only and must be offered no Remove control. */
export const EXECUTIVE_SELF: SpecIdentity = {
  id: "sub-exec-0001",
  email: "e2e-executive@example.test",
  name: "Eve Executive",
  role: "EXECUTIVE",
};

export const WORKSHOP_ID = "wksp-e2e-0001";
export const TEAM_ID = "team-e2e-0001";
export const TEAM_NAME = "Team Peregrine";
export const WORKSHOP_NAME = "E2E Accelerator";

export interface TeamMemberFixture {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email?: string };
}

/**
 * The member every removal spec acts on.
 *
 * Named "Priya Patel" because the designer's accessible-name example uses it, so the specs
 * assert the exact string the implementation is documented to produce.
 */
export const MEMBER_PRIYA: TeamMemberFixture = {
  id: "sub-member-priya",
  userId: "sub-member-priya",
  role: "BUILDER",
  user: { id: "sub-member-priya", name: "Priya Patel", email: "priya@example.test" },
};

export const MEMBER_SAM: TeamMemberFixture = {
  id: "sub-member-sam",
  userId: "sub-member-sam",
  role: "BUILDER",
  user: { id: "sub-member-sam", name: "Sam Okafor", email: "sam@example.test" },
};

/** The caller's own row, which must never carry a Remove button. */
export function selfMember(identity: SpecIdentity): TeamMemberFixture {
  return {
    id: identity.id,
    userId: identity.id,
    role: "LEAD",
    user: { id: identity.id, name: identity.name, email: identity.email },
  };
}

/**
 * The `team.getById` response.
 *
 * Includes `workshop`, `members` and `teamPhases` because the LAYOUT queries the same
 * procedure (layout.tsx:30) and reads all three — a fixture missing `teamPhases` renders a
 * layout that throws on `.find`, which would surface as a blank page rather than as a
 * missing field.
 */
export function teamFixture(members: TeamMemberFixture[]) {
  return {
    id: TEAM_ID,
    name: TEAM_NAME,
    inviteCode: "E2ECODE1",
    workshopId: WORKSHOP_ID,
    workshop: { name: WORKSHOP_NAME },
    members,
    teamPhases: [],
    /**
     * ⚠ THE INSIGHTS PAGE READS `phases`, NOT `teamPhases`, and reads it UNGUARDED
     * (`team.phases.filter(...).length`). Omitting it crashed that page's error boundary with
     * "Cannot read properties of undefined (reading 'length')" and failed every test in
     * prompt-disclosure.spec.ts in SETUP.
     *
     * `teamPhases` is kept because the team-page specs were written against it; `phases` is what
     * team.getById actually returns today (see the router's note on renaming the field so it says
     * what it is — the workshop's phases, each with a derived status).
     */
    phases: [] as Array<{ status: string }>,
  };
}

export interface AdminUserFixture {
  id: string;
  email: string;
  name: string;
  role: string;
  organization?: string;
  createdAt: string;
  hasAccount: boolean;
  isSelf: boolean;
  /** Absent means ACTIVE — see isUserDeactivated's note on why the DENY value is tested. */
  status?: string;
  invitedBy?: unknown;
}

/** A fixed timestamp: a fixture with `new Date()` in it is a fixture that can flake. */
const CREATED_AT = "2026-01-15T09:00:00.000Z";

export function adminUser(over: Partial<AdminUserFixture> & { id: string; email: string; name: string; role: string }): AdminUserFixture {
  return {
    organization: "Example Corp",
    createdAt: CREATED_AT,
    hasAccount: true,
    isSelf: false,
    ...over,
  };
}

/** An ACTIVE participant — the row a FACILITATOR *may* act on. */
export const USER_PARTICIPANT = adminUser({
  id: "sub-user-participant",
  email: "pat@example.test",
  name: "Pat Participant",
  role: "PARTICIPANT",
});

/** A DEACTIVATED participant — the row that must show the "No access" badge and "Restore". */
export const USER_DISABLED = adminUser({
  id: "sub-user-disabled",
  email: "dana@example.test",
  name: "Dana Disabled",
  role: "PARTICIPANT",
  status: "DEACTIVATED",
});

/** An ADMIN row — a FACILITATOR must be offered NO control on it (lateral attack). */
export const USER_ADMIN_TARGET = adminUser({
  id: "sub-user-admin",
  email: "alex@example.test",
  name: "Alex Admin",
  role: "ADMIN",
});

/** A peer FACILITATOR row — likewise off limits to a FACILITATOR. */
export const USER_FACILITATOR_PEER = adminUser({
  id: "sub-user-facilitator",
  email: "frankie@example.test",
  name: "Frankie Facilitator",
  role: "FACILITATOR",
});

/** A profile-only row (no Cognito account): explains rather than offers. */
export const USER_NO_ACCOUNT = adminUser({
  id: "sub-user-profile-only",
  email: "noaccount@example.test",
  name: "Nora NoAccount",
  role: "PARTICIPANT",
  hasAccount: false,
});

/** The caller's own row. */
export function selfUser(identity: SpecIdentity): AdminUserFixture {
  return adminUser({
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role: identity.role,
    isSelf: true,
  });
}

/** The `admin.listUsers` response shape. */
export function listUsersFixture(users: AdminUserFixture[]) {
  return { users, nextCursor: undefined, truncated: false };
}

/** `auth.me`, queried by ProfileMenu on every authenticated screen. */
export function meFixture(identity: SpecIdentity) {
  return {
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role: identity.role,
    firstName: identity.name.split(" ")[0],
    lastName: identity.name.split(" ").slice(1).join(" "),
    organization: "Example Corp",
  };
}

/**
 * A successful `team.removeMember` response.
 *
 * `audited` defaults TRUE here, but the partial path (audited: false) is a distinct
 * assertion in the spec — the page reports it as "Done, with a gap" rather than a clean
 * success, and that difference is the point of ActionOutcome's four states.
 */
export function removeMemberResult(audited = true) {
  return { removed: true, audited };
}

/** A successful `admin.setUserAccess` response, mirroring the router's echo shape. */
export function setUserAccessResult(over: {
  userId: string;
  enabled: boolean;
  invitationsRevoked?: number;
  invitationsRevokeComplete?: boolean;
  audited?: boolean;
}) {
  return {
    userId: over.userId,
    enabled: over.enabled,
    invitationsRevoked: over.invitationsRevoked ?? 0,
    invitationsRevokeComplete: over.invitationsRevokeComplete ?? true,
    audited: over.audited ?? true,
  };
}
