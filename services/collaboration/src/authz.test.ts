import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { edgeIdentityMiddleware } from "@praimana/service-shared";
import {
  isReadOnlyRole,
  requireTeamRead,
  requireTeamWrite,
  requireTeamContentRead,
  requireTeamContentWrite,
  type TeamAccess,
} from "./authz.js";

/**
 * Collaboration does NOT own team membership — the Team service does. These guards
 * are the whole of Collaboration's authorization: one thing it can decide locally
 * (the read-only role, known from the edge identity) and one thing it must ask the
 * Team context for (membership, via the injected TeamAccess).
 *
 * The guards are exercised through a real Hono app behind the real
 * edgeIdentityMiddleware, using the trusted internal hop, so the identity the
 * guards read is the same identity the deployed service would see.
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
 * TeamAccess stub that records exactly which questions were asked.
 *
 * The FOUR call lists are kept separate because "which predicate did the guard consult" is
 * the assertion that catches a content guard wired to the wide rule — a shared counter
 * would make the two indistinguishable.
 */
class FakeTeamAccess implements TeamAccess {
  readCalls: Array<[string, string, string]> = [];
  writeCalls: Array<[string, string, string]> = [];
  contentReadCalls: Array<[string, string, string]> = [];
  contentWriteCalls: Array<[string, string, string]> = [];

  constructor(
    private readonly reads = true,
    private readonly writes = true,
    // Default to the wide pair's values so every pre-existing test keeps its meaning.
    private readonly contentReads = reads,
    private readonly contentWrites = writes
  ) {}

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

/** Minimal app whose only job is to report which branch a guard took. */
function guardApp(
  guard: (c: never, ta: TeamAccess, teamId: string) => Promise<Response | null>,
  teamAccess: TeamAccess
) {
  const app = new Hono();
  app.use("*", edgeIdentityMiddleware());
  app.get("/teams/:teamId/probe", async (c) => {
    const denied = await guard(
      c as never,
      teamAccess,
      c.req.param("teamId")
    );
    if (denied) return denied;
    return c.json({ allowed: true });
  });
  return app;
}

describe("isReadOnlyRole", () => {
  it("treats EXECUTIVE as read-only and no other role", () => {
    // This set is duplicated in three services (team, collaboration, evaluation).
    // If they ever disagree, a role gains write access in one service and not the
    // others — pinning each copy is how the drift gets caught.
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
    for (const role of ["ADMIN", "FACILITATOR", "PARTICIPANT", "JUDGE"]) {
      expect(isReadOnlyRole(role)).toBe(false);
    }
  });

  it("does not treat an unknown role as read-only", () => {
    // Read-only is a list of RESTRICTED roles, not a default. An unrecognised role
    // is stopped by the membership check, not by this one.
    expect(isReadOnlyRole("SOMETHING_NEW")).toBe(false);
    expect(isReadOnlyRole("")).toBe(false);
  });
});

describe("requireTeamRead", () => {
  it("returns null (proceed) when the Team context allows the read", async () => {
    const ta = new FakeTeamAccess(true, true);
    const res = await guardApp(requireTeamRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true });
  });

  it("403s with an { error } body when the Team context refuses", async () => {
    const ta = new FakeTeamAccess(false, false);
    const res = await guardApp(requireTeamRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "outsider", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("asks about the team in the URL, with the identity from the verified hop", async () => {
    // The teamId must come from the path and the userId/role from the identity —
    // never from the request body, or a caller could ask about a team they picked.
    const ta = new FakeTeamAccess(true, true);
    await guardApp(requireTeamRead, ta).request("/teams/t-42/probe", {
      headers: asUser({ id: "u9", role: "JUDGE" }),
    });
    expect(ta.readCalls).toEqual([["t-42", "u9", "JUDGE"]]);
  });

  it("lets an EXECUTIVE read (read-only is not no-access)", async () => {
    const ta = new FakeTeamAccess(true, false);
    const res = await guardApp(requireTeamRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("requireTeamWrite", () => {
  it("returns null (proceed) for a member with a write role", async () => {
    const ta = new FakeTeamAccess(true, true);
    const res = await guardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
  });

  it("403s an EXECUTIVE with a DISTINCT 'Read-only role' body", async () => {
    // Two different 403s on purpose: "Forbidden" means "not your team", "Read-only
    // role" means "your team, but you may not write". The UI shows different copy,
    // so collapsing them is a user-visible regression.
    const ta = new FakeTeamAccess(true, true);
    const res = await guardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Read-only role" });
  });

  it("refuses an EXECUTIVE WITHOUT calling the Team service at all", async () => {
    // The local role check short-circuits first. That is both the rule and a real
    // property: a read-only role can never be granted write by a Team service that
    // is buggy, stale, or lying.
    const ta = new FakeTeamAccess(true, true);
    await guardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(ta.writeCalls).toHaveLength(0);
  });

  it("403s 'Forbidden' when the Team context refuses the write", async () => {
    const ta = new FakeTeamAccess(true, false);
    const res = await guardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("uses canWrite, not canRead, for the decision", async () => {
    // A TeamAccess that says read-yes/write-no must produce a denial. Calling
    // canRead here would silently grant write to every reader.
    const ta = new FakeTeamAccess(true, false);
    await guardApp(requireTeamWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(ta.writeCalls).toEqual([["t1", "u1", "PARTICIPANT"]]);
    expect(ta.readCalls).toHaveLength(0);
  });
});

// ─── TEAM CONTENT guards: member-only ─────────────────────────────

describe("requireTeamContentRead", () => {
  it("proceeds when the Team context allows the CONTENT read", async () => {
    const ta = new FakeTeamAccess(true, true);
    const res = await guardApp(requireTeamContentRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
  });

  it("asks canReadContent and NOT canRead — the drift assertion", async () => {
    // ── THE ONE THAT CATCHES A GUARD WIRED TO THE WIDE RULE ──
    //
    // If this guard called canRead, every test that sets both pairs the same would still
    // pass and an ADMIN would keep ambient content access. Asserting WHICH question is
    // asked is the only way to see it.
    const ta = new FakeTeamAccess(true, true);
    await guardApp(requireTeamContentRead, ta).request("/teams/t-42/probe", {
      headers: asUser({ id: "u9", role: "ADMIN" }),
    });
    expect(ta.contentReadCalls).toEqual([["t-42", "u9", "ADMIN"]]);
    expect(ta.readCalls).toHaveLength(0);
    expect(ta.writeCalls).toHaveLength(0);
  });

  it("403s when the CONTENT predicate refuses but the WIDE one allows", async () => {
    // The non-member ADMIN / workshop-owning FACILITATOR shape, exactly as the Team service
    // reports it: wide true, content false.
    const ta = new FakeTeamAccess(true, true, false, false);
    const res = await guardApp(requireTeamContentRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("lets an EXECUTIVE MEMBER read (read-only is not no-access)", async () => {
    const ta = new FakeTeamAccess(true, false, true, false);
    const res = await guardApp(requireTeamContentRead, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("requireTeamContentWrite", () => {
  it("proceeds for a member with a write role", async () => {
    const ta = new FakeTeamAccess(true, true);
    const res = await guardApp(requireTeamContentWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
  });

  it("asks canWriteContent and NOTHING else", async () => {
    const ta = new FakeTeamAccess(true, true);
    await guardApp(requireTeamContentWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(ta.contentWriteCalls).toEqual([["t1", "u1", "PARTICIPANT"]]);
    expect(ta.contentReadCalls).toHaveLength(0);
    expect(ta.readCalls).toHaveLength(0);
    expect(ta.writeCalls).toHaveLength(0);
  });

  it("403s an EXECUTIVE with the DISTINCT 'Read-only role' body, WITHOUT any hop", async () => {
    // The local role check short-circuits first, exactly as on the wide guard: a read-only
    // role can never be granted write by a Team service that is buggy, stale or lying — and
    // the distinct message is what the UI renders as different copy.
    const ta = new FakeTeamAccess(true, true);
    const res = await guardApp(requireTeamContentWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Read-only role" });
    expect(ta.contentWriteCalls).toHaveLength(0);
  });

  it("403s when the CONTENT write predicate refuses", async () => {
    const ta = new FakeTeamAccess(true, true, true, false);
    const res = await guardApp(requireTeamContentWrite, ta).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });
});
