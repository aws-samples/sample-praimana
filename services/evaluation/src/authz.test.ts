import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { edgeIdentityMiddleware } from "@praimana/service-shared";
import {
  isReadOnlyRole,
  isScoringRole,
  requireScoringRole,
  requireTeamRead,
  requireTeamWrite,
  requireTeamContentRead,
  requireTeamContentWrite,
  type TeamAccess,
} from "./authz.js";

/**
 * Evaluation's authorization has one shape the other services don't: judging is
 * ROLE-scoped, not team-scoped. A judge scores submissions across teams they are not
 * a member of, so requireScoringRole deliberately performs no membership check at
 * all. That makes the role list itself the entire boundary — hence these tests.
 */
const INTERNAL_TOKEN = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;

function asUser(identity: { id: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
  };
}

/**
 * The four call lists are kept SEPARATE because "which predicate did the guard consult" is
 * the assertion that catches a content guard wired to the wide rule — a shared
 * counter would make the two indistinguishable. The content flags default to the wide pair's
 * values so every pre-existing test in this file keeps its original meaning.
 */
class FakeTeamAccess implements TeamAccess {
  readCalls: Array<[string, string, string]> = [];
  writeCalls: Array<[string, string, string]> = [];
  contentReadCalls: Array<[string, string, string]> = [];
  contentWriteCalls: Array<[string, string, string]> = [];
  /** `writeScope` calls — a FIFTH list for the same reason the other four are separate:
   *  "which question did the guard ask" is the assertion, and a shared counter would make
   *  the write decision and the write-decision-plus-scope indistinguishable. */
  writeScopeCalls: Array<[string, string, string]> = [];
  constructor(
    private readonly reads = true,
    private readonly writes = true,
    private readonly contentReads = reads,
    private readonly contentWrites = writes,
    private readonly scope: string | null | "unavailable" = "w1"
  ) {}
  async writeScope(teamId: string, userId: string, role: string) {
    this.writeScopeCalls.push([teamId, userId, role]);
    if (this.scope === "unavailable") return "unavailable" as const;
    return { canWrite: this.writes, workshopId: this.scope };
  }
  async canRead(teamId: string, userId: string, role: string) {
    this.readCalls.push([teamId, userId, role]);
    return this.reads;
  }
  async canWrite(teamId: string, userId: string, role: string) {
    this.writeCalls.push([teamId, userId, role]);
    return this.writes;
  }
  async canReadContent(teamId: string, userId: string, role: string) {
    this.contentReadCalls.push([teamId, userId, role]);
    return this.contentReads;
  }
  async canWriteContent(teamId: string, userId: string, role: string) {
    this.contentWriteCalls.push([teamId, userId, role]);
    return this.contentWrites;
  }
}

function teamGuardApp(
  guard: (c: never, ta: TeamAccess, teamId: string) => Promise<Response | null>,
  teamAccess: TeamAccess
) {
  const app = new Hono();
  app.use("*", edgeIdentityMiddleware());
  app.get("/teams/:teamId/probe", async (c) => {
    const denied = await guard(c as never, teamAccess, c.req.param("teamId"));
    return denied ?? c.json({ allowed: true });
  });
  return app;
}

function scoringGuardApp() {
  const app = new Hono();
  app.use("*", edgeIdentityMiddleware());
  app.get("/probe", (c) => requireScoringRole(c) ?? c.json({ allowed: true }));
  return app;
}

describe("role predicates", () => {
  it("marks EXECUTIVE read-only and nothing else", () => {
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
    for (const role of ["ADMIN", "FACILITATOR", "PARTICIPANT", "JUDGE", "UNKNOWN", ""]) {
      expect(isReadOnlyRole(role)).toBe(false);
    }
  });

  it("allows scoring for JUDGE and NOBODY else — ADMIN included", () => {
    // FACILITATOR is deliberately excluded: running the event is not the same
    // authority as judging its results.
    //
    // ⚠ AND SO IS ADMIN. It used to be in this set, which meant the
    // same sentence above was FALSE for one of the two owner roles — an owner who was a
    // facilitator could not score their own experience while an owner who was an admin
    // could. It also was not ownership-scoped, so an admin could score a submission in
    // an experience belonging to someone else. Asserted explicitly rather than folded
    // into the loop below, because this line is the rule change.
    expect(isScoringRole("JUDGE")).toBe(true);
    expect(isScoringRole("ADMIN")).toBe(false);
    for (const role of ["FACILITATOR", "PARTICIPANT", "EXECUTIVE", "UNKNOWN", ""]) {
      expect(isScoringRole(role)).toBe(false);
    }
  });

  it("is case-sensitive on role names", () => {
    // Roles come from Cognito groups, which are upper-case by convention. A
    // lower-cased value must NOT match — a case-insensitive comparison would let a
    // mis-provisioned group name grant judging.
    expect(isScoringRole("judge")).toBe(false);
    expect(isReadOnlyRole("executive")).toBe(false);
  });
});

describe("requireScoringRole", () => {
  it("lets a JUDGE through", async () => {
    const res = await scoringGuardApp().request("/probe", {
      headers: asUser({ id: "u1", role: "JUDGE" }),
    });
    expect(res.status).toBe(200);
  });

  it("403s every other role with a role-specific message — ADMIN AMONG THEM", async () => {
    // ADMIN is FIRST in this list on purpose: it is the one that was removed from the set,
    // and it is the one a future reader is most likely to assume belongs in the test
    // above. The message narrowed with the set — "Judge or admin role required" would now
    // name a role that is refused, which is worse than unhelpful on a 403.
    for (const role of ["ADMIN", "PARTICIPANT", "FACILITATOR", "EXECUTIVE"]) {
      const res = await scoringGuardApp().request("/probe", {
        headers: asUser({ id: "u1", role }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Judge role required" });
    }
  });

  it("requires an authenticated identity", async () => {
    const res = await scoringGuardApp().request("/probe");
    expect(res.status).toBe(401);
  });
});

describe("requireTeamRead / requireTeamWrite", () => {
  it("proceeds on an allowed read and 403s a refused one", async () => {
    const allow = await teamGuardApp(requireTeamRead, new FakeTeamAccess(true)).request(
      "/teams/t1/probe",
      { headers: asUser({ id: "u1", role: "PARTICIPANT" }) }
    );
    expect(allow.status).toBe(200);

    const deny = await teamGuardApp(requireTeamRead, new FakeTeamAccess(false)).request(
      "/teams/t1/probe",
      { headers: asUser({ id: "u1", role: "PARTICIPANT" }) }
    );
    expect(deny.status).toBe(403);
    expect(await deny.json()).toEqual({ error: "Forbidden" });
  });

  it("asks the Team context about the path's team as the verified caller", async () => {
    const ta = new FakeTeamAccess(true);
    await teamGuardApp(requireTeamRead, ta).request("/teams/t-9/probe", {
      headers: asUser({ id: "u-5", role: "JUDGE" }),
    });
    expect(ta.readCalls).toEqual([["t-9", "u-5", "JUDGE"]]);
  });

  it("blocks an EXECUTIVE write locally, without asking the Team context", async () => {
    // Same asymmetry as the other services: read-only beats whatever Team answers,
    // and it short-circuits so a Team-service bug can never grant it.
    const ta = new FakeTeamAccess(true, true);
    const res = await teamGuardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Read-only role" });
    expect(ta.writeCalls).toHaveLength(0);
  });

  it("does not grant a write on the strength of read permission", async () => {
    const ta = new FakeTeamAccess(true, false);
    const res = await teamGuardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(ta.readCalls).toHaveLength(0);
    expect(ta.writeCalls).toHaveLength(1);
  });

  it("does NOT give a JUDGE team access just because they may score", async () => {
    // The two authorities are orthogonal. Scoring is role-based; reading a team's
    // board/ratings still requires the Team context's blessing.
    const ta = new FakeTeamAccess(false, false);
    const res = await teamGuardApp(requireTeamRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "judge", role: "JUDGE" }),
    });
    expect(res.status).toBe(403);
  });
});

// ─── TEAM CONTENT guards: member-only ─────────────────────────────

describe("requireTeamContentRead / requireTeamContentWrite", () => {
  it("asks the CONTENT predicate and NEVER the wide one — the drift assertion", async () => {
    // If a content guard called canRead, every test where both pairs agree would still pass
    // and an ADMIN would keep ambient access to a team's insights. Asserting WHICH question
    // is asked is the only way to see it.
    const ta = new FakeTeamAccess(true, true);
    await teamGuardApp(requireTeamContentRead, ta).request("/teams/t-42/probe", {
      headers: asUser({ id: "u9", role: "ADMIN" }),
    });
    expect(ta.contentReadCalls).toEqual([["t-42", "u9", "ADMIN"]]);
    expect(ta.readCalls).toHaveLength(0);
    expect(ta.writeCalls).toHaveLength(0);

    const tw = new FakeTeamAccess(true, true);
    await teamGuardApp(requireTeamContentWrite, tw).request("/teams/t-42/probe", {
      headers: asUser({ id: "u9", role: "PARTICIPANT" }),
    });
    expect(tw.contentWriteCalls).toEqual([["t-42", "u9", "PARTICIPANT"]]);
    expect(tw.contentReadCalls).toHaveLength(0);
    expect(tw.readCalls).toHaveLength(0);
    expect(tw.writeCalls).toHaveLength(0);
  });

  it("403s when the CONTENT predicate refuses but the WIDE one allows", async () => {
    // The non-member ADMIN / workshop-owning FACILITATOR shape, exactly as the Team service
    // reports it: wide true, content false.
    for (const guard of [requireTeamContentRead, requireTeamContentWrite]) {
      const ta = new FakeTeamAccess(true, true, false, false);
      const res = await teamGuardApp(guard, ta).request("/teams/t1/probe", {
        headers: asUser({ id: "admin", role: "ADMIN" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("allows a member, and an EXECUTIVE member on the read side only", async () => {
    const member = new FakeTeamAccess(true, true);
    const allowed = await teamGuardApp(requireTeamContentWrite, member).request(
      "/teams/t1/probe",
      { headers: asUser({ id: "u1", role: "PARTICIPANT" }) }
    );
    expect(allowed.status).toBe(200);

    const exec = new FakeTeamAccess(true, false, true, false);
    const canRead = await teamGuardApp(requireTeamContentRead, exec).request(
      "/teams/t1/probe",
      { headers: asUser({ id: "exec", role: "EXECUTIVE" }) }
    );
    expect(canRead.status).toBe(200);
  });

  it("refuses an EXECUTIVE write WITHOUT a hop, with the DISTINCT read-only body", async () => {
    const ta = new FakeTeamAccess(true, true);
    const res = await teamGuardApp(requireTeamContentWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Read-only role" });
    expect(ta.contentWriteCalls).toHaveLength(0);
  });
});
