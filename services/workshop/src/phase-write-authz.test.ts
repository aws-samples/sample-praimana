// ── ⚠ WHO MAY EDIT A TEAM'S PHASE NOTES ──────────────────────────────────────────────────
//
// A user holding the EXECUTIVE role could not update their team's ideation
// phase. The rule is that every team member must be able to add and update phases, and to
// add and edit tasks on the board. This route refused executives BY DESIGN, which is what changed.
//
// The board half of that rule was already granted (`requireTeamCollaborationWrite` in the
// collaboration service). Phases were the outlier, so `requireTeamPhaseWrite` mirrors that guard.
//
// ⚠ WHY A DEDICATED GUARD RATHER THAN RELAXING `requireTeamContentWrite`, measured rather than assumed:
// that predicate gates TWELVE routes across four services — six in `ai`, two in `evaluation`, two in
// `source`, two here. Relaxing it would also hand executives the evaluation writes (submissions and
// SCORES) and the source/repository writes. An executive writing judging scores is a competition
// integrity problem, not a permissions convenience.
//
// These tests drive the predicate directly, because the route tests cannot reach one of its branches.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { isReadOnlyRole, requireTeamPhaseWrite, type TeamAccess } from "./authz";

/** Records which predicate was asked, so "membership, not role" is observable. */
class RecordingTeamAccess implements TeamAccess {
  calls: Array<{ op: string; teamId: string; userId: string; role: string }> = [];
  constructor(private readonly memberOfTeam: boolean) {}
  async canRead() {
    this.calls.push({ op: "wide-read", teamId: "?", userId: "?", role: "?" });
    return true;
  }
  async canWrite() {
    this.calls.push({ op: "wide-write", teamId: "?", userId: "?", role: "?" });
    return true;
  }
  async canReadContent(teamId: string, userId: string, role: string) {
    this.calls.push({ op: "content-read", teamId, userId, role });
    return this.memberOfTeam;
  }
  async canWriteContent(teamId: string, userId: string, role: string) {
    this.calls.push({ op: "content-write", teamId, userId, role });
    return this.memberOfTeam;
  }
}

/**
 * Drive the guard through a real Hono context.
 *
 * ⚠ THE IDENTITY IS SET AS A CONTEXT VARIABLE, NOT AS HEADERS. `requireIdentity` reads
 * `c.get("identity")` and THROWS if it is absent ("edgeIdentityMiddleware must run before
 * requireIdentity") — my first version passed `x-identity-*` headers and every case returned 500,
 * which is what the real edge middleware would have translated. Setting the variable is what the
 * middleware does, so this exercises the guard rather than the middleware.
 */
async function callGuard(role: string, access: TeamAccess) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("identity", { id: "user-1", email: "u@b.c", role });
    await next();
  });
  app.get("/t/:teamId", async (c) => {
    const denied = await requireTeamPhaseWrite(c, access, c.req.param("teamId"));
    return denied ?? c.json({ allowed: true });
  });
  return app.request("/t/team-1");
}

describe("⚠ requireTeamPhaseWrite: membership decides, not role", () => {
  it("allows an EXECUTIVE who is a member — the case that was wrongly refused", async () => {
    const access = new RecordingTeamAccess(true);
    const res = await callGuard("EXECUTIVE", access);
    expect(res.status).toBe(200);
  });

  it("allows an ordinary PARTICIPANT member", async () => {
    const res = await callGuard("PARTICIPANT", new RecordingTeamAccess(true));
    expect(res.status).toBe(200);
  });

  /**
   * ⚠ THE PROPERTY THAT MAKES THE RELAXATION SAFE. `canReadContent` is pure membership with no role
   * branch, so "executive" is not a licence to edit an arbitrary team's notes.
   */
  it("refuses a non-member, whatever their role", async () => {
    for (const role of ["EXECUTIVE", "PARTICIPANT", "ADMIN", "FACILITATOR"]) {
      const res = await callGuard(role, new RecordingTeamAccess(false));
      expect(res.status, `${role} non-member`).toBe(403);
    }
  });

  /**
   * ⚠ IT MUST ASK THE CONTENT PREDICATE, NEVER THE WIDE ONE. The wide pair admits a workshop OWNER who
   * is not a member — staff are excluded from team content, and using it here would let a
   * facilitator rewrite a team's notes.
   */
  it("asks content membership and never the wide predicate", async () => {
    const access = new RecordingTeamAccess(true);
    await callGuard("EXECUTIVE", access);

    expect(access.calls).toEqual([
      { op: "content-read", teamId: "team-1", userId: "user-1", role: "EXECUTIVE" },
    ]);
  });

  /**
   * ⚠ AND IT ASKS **READ**, NOT WRITE. `canWriteContent` folds the read-only refusal into the
   * membership answer, which is exactly the part being relaxed — asking it would reinstate the bug
   * from inside the Team service.
   */
  it("does not ask canWriteContent, which would fold the refusal back in", async () => {
    const access = new RecordingTeamAccess(true);
    await callGuard("EXECUTIVE", access);
    expect(access.calls.map((c) => c.op)).not.toContain("content-write");
  });
});

describe("⚠ the grant is EXECUTIVE-specific, and this is how that stays true", () => {
  /**
   * The guard refuses every read-only role EXCEPT executive. That branch is UNREACHABLE today because
   * EXECUTIVE is the only read-only role — which is precisely when a future addition would slip
   * through unnoticed.
   *
   * So the SET is pinned instead. If someone adds a read-only role, this fails and names the two
   * guards that grant EXECUTIVE explicitly, forcing the question "should the new role get this too?"
   * to be answered rather than inherited.
   */
  it("EXECUTIVE is the only read-only role — if that changes, review the phase and board guards", () => {
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE", "PARTICIPANT"]) {
      expect(isReadOnlyRole(role), `${role} must not be read-only`).toBe(false);
    }
  });
});
