import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import {
  edgeIdentityMiddleware,
  type DocClient,
} from "@praimana/service-shared";
import {
  DynamoTeamMembership,
  isReadOnlyRole,
  requireTeamRead,
  requireTeamWrite,
  type TeamMembership,
} from "./authz.js";

/**
 * DOCS IS THE REFERENCE BEHAVIOUR FOR MEMBER-ONLY ACCESS, NOT AN OUTLIER — recorded as a test.
 *
 * Docs are the fifth team-content surface, and this service has ALWAYS been member-only:
 * `isMember` is a single GetItem on (teamId, userId) with NO ROLE BRANCH AT ALL — no ADMIN
 * short-circuit, no workshop-ownership fallback, none of the widening the other four
 * services carried. So an ADMIN, FACILITATOR or JUDGE already got 403 on every docs route,
 * and the member-only rule is the rest of the platform being brought into line with what this service
 * already did.
 *
 * ── WHY THIS FILE EXISTS, GIVEN NOTHING HERE CHANGED ──
 *
 * Precisely because nothing changed. "Docs needs no change" was a claim verified by reading
 * the source, and a claim verified by reading is one that a later edit can silently falsify:
 * adding an `if (role === "ADMIN") return null` here would re-widen the ONE surface that
 * never leaked, and no other test on the platform would notice. This is the first test file
 * this service has had.
 *
 * The guards are exercised through a real Hono app behind the real edgeIdentityMiddleware,
 * using the trusted internal hop, so the identity they read is the identity the deployed
 * service would see.
 *
 * ── AND THIS SERVICE *IS* AN OUTLIER, FOR A DIFFERENT REASON ──
 *
 * Everything above is about ROLES, and it still holds. But member removal stopped being a hard
 * delete: the membership row now survives as `status: INACTIVE` so the removal can be reversed.
 * Every other reader of that table goes through the Team service's repository, which returns
 * NULL for a deactivated row; THIS SERVICE READS THE TABLE ITSELF, so it is the one place that
 * has to know about `status` — and the one way a removed person could keep access to a team
 * surface. The last two describe blocks in this file are that test.
 */
const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(identity: { id: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
  };
}

/**
 * Membership over an explicit "teamId:userId" set, recording every question asked.
 *
 * `asked` is what pins the SHAPE of the question: this service must ask about a
 * (teamId, userId) PAIR and nothing else. A guard that started passing a role — or that
 * skipped the lookup for some role — would show up here as a missing or altered entry.
 */
class FakeMembership implements TeamMembership {
  readonly asked: Array<[string, string]> = [];
  constructor(private readonly rows: Array<[string, string]> = []) {}
  async isMember(teamId: string, userId: string) {
    this.asked.push([teamId, userId]);
    return this.rows.some(([t, u]) => t === teamId && u === userId);
  }
}

/** Minimal app whose only job is to report which branch a guard took. */
function guardApp(
  guard: (
    c: never,
    m: TeamMembership,
    teamId: string
  ) => Promise<Response | null>,
  membership: TeamMembership
) {
  const app = new Hono();
  app.use("*", edgeIdentityMiddleware());
  app.get("/teams/:teamId/probe", async (c) => {
    const denied = await guard(c as never, membership, c.req.param("teamId"));
    if (denied) return denied;
    return c.json({ allowed: true });
  });
  return app;
}

/** Every role that is NOT a team-scoped role — the three excluded from membership. */
const PLATFORM_WIDE_ROLES = ["ADMIN", "FACILITATOR", "JUDGE"];

describe("isReadOnlyRole", () => {
  it("treats EXECUTIVE as read-only and no other role", () => {
    // This set is duplicated across six services. If they ever disagree, a role gains write
    // access in one service and not the others — pinning each copy is how the drift is caught.
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
    for (const role of ["ADMIN", "FACILITATOR", "PARTICIPANT", "JUDGE"]) {
      expect(isReadOnlyRole(role)).toBe(false);
    }
  });

  it("does not treat an unknown role as read-only", () => {
    // Read-only is a list of RESTRICTED roles, not a default. An unrecognised role is stopped
    // by the membership check, not by this one.
    expect(isReadOnlyRole("SOMETHING_NEW")).toBe(false);
    expect(isReadOnlyRole("")).toBe(false);
  });
});

describe("requireTeamRead — membership and nothing else", () => {
  it("allows a member", async () => {
    const m = new FakeMembership([["t1", "u1"]]);
    const res = await guardApp(requireTeamRead, m).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
  });

  it("REFUSES a non-member", async () => {
    const m = new FakeMembership([["t1", "someone-else"]]);
    const res = await guardApp(requireTeamRead, m).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("REFUSES every platform-wide role with no membership row — ALREADY the rule", async () => {
    // ── THE ASSERTION THIS FILE EXISTS FOR ──
    //
    // No ADMIN short-circuit, no workshop-ownership fallback. This is what the other four
    // content services were changed to look like; here it is the behaviour that shipped
    // originally, so these expectations are UNCHANGED by the member-only rule rather than inverted.
    for (const role of PLATFORM_WIDE_ROLES) {
      const m = new FakeMembership([]);
      const res = await guardApp(requireTeamRead, m).request("/teams/t1/probe", {
        headers: asUser({ id: "staff", role }),
      });
      expect(res.status, role).toBe(403);
      // …and it did LOOK: the refusal comes from an absent row, not from a role branch that
      // never consulted the store.
      expect(m.asked, role).toEqual([["t1", "staff"]]);
    }
  });

  it("does not leak membership across teams", async () => {
    const m = new FakeMembership([["t1", "u1"]]);
    const res = await guardApp(requireTeamRead, m).request("/teams/t2/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
  });

  it("asks about the team in the URL and the identity from the verified hop", async () => {
    // The teamId must come from the path and the userId from the identity — never from the
    // request body, or a caller could ask about a pair they chose.
    const m = new FakeMembership([["t-42", "u9"]]);
    await guardApp(requireTeamRead, m).request("/teams/t-42/probe", {
      headers: asUser({ id: "u9", role: "PARTICIPANT" }),
    });
    expect(m.asked).toEqual([["t-42", "u9"]]);
  });

  it("allows a read-only EXECUTIVE MEMBER — read-only is not no-access", async () => {
    const m = new FakeMembership([["t1", "exec"]]);
    const res = await guardApp(requireTeamRead, m).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(200);
  });

  it("401s an unauthenticated caller without touching the store", async () => {
    const m = new FakeMembership([["t1", "u1"]]);
    const res = await guardApp(requireTeamRead, m).request("/teams/t1/probe");
    expect(res.status).toBe(401);
    expect(m.asked).toHaveLength(0);
  });
});

describe("requireTeamWrite — membership AND not read-only", () => {
  it("allows a member with a write role", async () => {
    const m = new FakeMembership([["t1", "u1"]]);
    const res = await guardApp(requireTeamWrite, m).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
  });

  it("403s an EXECUTIVE with a DISTINCT 'Read-only role' body, WITHOUT a store read", async () => {
    // Two different 403s on purpose: "Forbidden" means "not your team", "Read-only role"
    // means "your team, but you may not write". The UI shows different copy, so collapsing
    // them is a user-visible regression — and the local check must short-circuit first so a
    // read-only role can never be granted write by a lookup that says otherwise.
    const m = new FakeMembership([["t1", "exec"]]);
    const res = await guardApp(requireTeamWrite, m).request("/teams/t1/probe", {
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Read-only role" });
    expect(m.asked).toHaveLength(0);
  });

  it("REFUSES every platform-wide role with no membership row", async () => {
    for (const role of PLATFORM_WIDE_ROLES) {
      const m = new FakeMembership([]);
      const res = await guardApp(requireTeamWrite, m).request("/teams/t1/probe", {
        headers: asUser({ id: "staff", role }),
      });
      expect(res.status, role).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    }
  });

  it("REFUSES a non-member with a write role", async () => {
    const m = new FakeMembership([]);
    const res = await guardApp(requireTeamWrite, m).request("/teams/t1/probe", {
      headers: asUser({ id: "outsider", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
  });

  it("PROPAGATES a store failure rather than answering 'allowed'", async () => {
    // Fail-closed on the LOCAL path too. This service reads DynamoDB directly (no NAT route
    // to the Team API — see authz.ts), so a throttle or an AccessDenied surfaces here as a
    // rejection. It must not be swallowed into a permit: Hono turns the throw into a 500,
    // which is the correct answer for "we could not determine", and never a 200.
    const exploding: TeamMembership = {
      isMember: async () => {
        throw new Error("ProvisionedThroughputExceededException");
      },
    };
    const res = await guardApp(requireTeamWrite, exploding).request("/teams/t1/probe", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

/**
 * ── DOCS IS THE OUTLIER FOR MEMBERSHIP *STATUS*, AND THIS IS THE TEST THAT PINS IT ──
 *
 * The block above is about ROLES, where this service is the REFERENCE behaviour and needed no
 * change. This block is about a SECOND, independent question that arrived with reactivation:
 * member removal is no longer a hard delete. The membership row SURVIVES with
 * `status: INACTIVE` so the removal can be reversed and so the roster can show who was removed.
 *
 * EVERY OTHER READER of `praimana-team-members` goes through the Team service's
 * `TeamMemberRepository.get()`, which returns NULL for a deactivated row — so they need no
 * filter and got none. THIS SERVICE READS THE TABLE ITSELF, bypassing that repository entirely,
 * because the Docs Lambda has no route to the Team API (private subnet, no NAT — see authz.ts).
 *
 * SO IT IS THE ONE PLACE ON THE PLATFORM WHERE A REMOVAL COULD LEAK. `return !!res.Item` was
 * correct while the row was deleted — no row meant no access, with nothing to filter — and
 * became WRONG the moment the row started surviving: it would read a deactivated row as a live
 * membership and hand a removed person EVERY DOCS ROUTE.
 *
 * These tests exercise the REAL `DynamoTeamMembership` against a fake DocClient, not the
 * `FakeMembership` above, because the status check lives in that class and nowhere else.
 * Deleting it must fail a NAMED test rather than being found in production.
 */
describe("DynamoTeamMembership.isMember — a DEACTIVATED row is not a membership", () => {
  /** A fake DocClient returning a fixed Item, and recording what was asked. */
  function fakeDb(item?: unknown) {
    const sent: Array<{ TableName?: string; Key?: Record<string, unknown> }> = [];
    const db = {
      async send(cmd: { input: { TableName?: string; Key?: Record<string, unknown> } }) {
        sent.push(cmd.input);
        return { Item: item };
      },
    };
    return { db: db as unknown as DocClient, sent };
  }

  const ACTIVE_ROW = {
    teamId: "t1",
    userId: "u1",
    role: "BUILDER",
    joinedAt: "2026-08-01T00:00:00.000Z",
  };

  it("REFUSES a removed member whose row is INACTIVE", async () => {
    // ── THE ASSERTION THIS BLOCK EXISTS FOR ──
    //
    // Reverting the status check to `return !!res.Item` makes exactly this fail. Without it, a
    // person removed from a team keeps read and write on every one of that team's docs, and no
    // other test on the platform would notice — the Team service's tests all pass because its
    // repository filters correctly.
    const { db } = fakeDb({
      ...ACTIVE_ROW,
      status: "INACTIVE",
      removedAt: "2026-08-04T10:00:00.000Z",
      removedBy: "fac",
    });
    expect(await new DynamoTeamMembership(db).isMember("t1", "u1")).toBe(false);
  });

  it("ALLOWS an ACTIVE member — so the refusal above is about the STATUS", async () => {
    const { db } = fakeDb({ ...ACTIVE_ROW, status: "ACTIVE" });
    expect(await new DynamoTeamMembership(db).isMember("t1", "u1")).toBe(true);
  });

  it("ALLOWS a member whose row carries NO status — the FORCED polarity", async () => {
    // Every membership row in the table today carries no `status` attribute, so treating
    // absence as INACTIVE would 403 EVERY TEAM ON THE PLATFORM from every docs route the
    // moment this deploys. That is a lockout, which is worse than a leak that does not exist
    // yet because nothing has been deactivated. Same forced polarity as the Team service's
    // isInactiveMembership: test for the DENY value, never for equality with "ACTIVE".
    const { db } = fakeDb(ACTIVE_ROW);
    expect(await new DynamoTeamMembership(db).isMember("t1", "u1")).toBe(true);
  });

  it("REFUSES whatever CASING the status was written in", async () => {
    // ⚠ THE CROSS-SERVICE DRIFT THIS GUARDS. `MEMBERSHIP_INACTIVE` here is a deliberate LOCAL
    // COPY of the constant in the Team service's domain.ts — bundled Lambdas take no dependency
    // on a workspace package, and this service cannot call the Team service at all. If the two
    // copies ever disagree, THIS SURFACE SILENTLY GRANTS a removed person access rather than
    // failing loudly, which is why the comparison is case-insensitive on both sides.
    for (const status of ["INACTIVE", "inactive", "Inactive", " inactive "]) {
      const { db } = fakeDb({ ...ACTIVE_ROW, status });
      expect(await new DynamoTeamMembership(db).isMember("t1", "u1"), status).toBe(false);
    }
  });

  it("REFUSES when there is no row at all — the pre-existing behaviour, unchanged", async () => {
    const { db } = fakeDb(undefined);
    expect(await new DynamoTeamMembership(db).isMember("t1", "u1")).toBe(false);
  });

  it("tolerates a NON-STRING status rather than throwing", async () => {
    // A partially-written or foreign attribute must not 500 an authorization check. It reads as
    // "not the DENY value" and therefore as ACTIVE, consistent with an absent attribute — the
    // only writer of this field is the removal route, which writes the constant.
    for (const status of [null, 42, true, {}, []]) {
      const { db } = fakeDb({ ...ACTIVE_ROW, status });
      expect(await new DynamoTeamMembership(db).isMember("t1", "u1"), String(status)).toBe(
        true
      );
    }
  });

  it("asks about the (teamId, userId) PAIR on the team-members table", async () => {
    // The shape of the question, pinned for the same reason the FakeMembership above records
    // it: a lookup keyed on anything else would answer about a pair the caller chose.
    const { db, sent } = fakeDb(ACTIVE_ROW);
    await new DynamoTeamMembership(db).isMember("t-42", "u9");
    expect(sent[0].Key).toEqual({ teamId: "t-42", userId: "u9" });
    expect(sent[0].TableName).toBe("praimana-team-members");
  });

  it("PROPAGATES a store failure rather than answering 'member'", async () => {
    // Fail-closed on the real class too, not only through the guard's fake. A throttle or an
    // AccessDenied must not be swallowed into a permit.
    const db = {
      async send() {
        throw Object.assign(new Error("throttled"), {
          name: "ProvisionedThroughputExceededException",
        });
      },
    } as unknown as DocClient;
    await expect(new DynamoTeamMembership(db).isMember("t1", "u1")).rejects.toThrow(
      "throttled"
    );
  });
});

/**
 * AND THE GUARDS REFUSE A REMOVED MEMBER END TO END, through the real Hono app.
 *
 * The block above proves `isMember` answers false. This proves the guards then 403 — so the
 * refusal reaches an actual docs request rather than stopping at a boolean.
 */
describe("the docs guards refuse a REMOVED member", () => {
  function membershipReturning(item: unknown): TeamMembership {
    const db = {
      async send() {
        return { Item: item };
      },
    } as unknown as DocClient;
    return new DynamoTeamMembership(db);
  }

  const INACTIVE = {
    teamId: "t1",
    userId: "u1",
    role: "BUILDER",
    joinedAt: "2026-08-01T00:00:00.000Z",
    status: "INACTIVE",
  };

  it("403s a removed member on requireTeamRead", async () => {
    const res = await guardApp(requireTeamRead, membershipReturning(INACTIVE)).request(
      "/teams/t1/probe",
      { headers: asUser({ id: "u1", role: "PARTICIPANT" }) }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("403s a removed member on requireTeamWrite", async () => {
    const res = await guardApp(requireTeamWrite, membershipReturning(INACTIVE)).request(
      "/teams/t1/probe",
      { headers: asUser({ id: "u1", role: "PARTICIPANT" }) }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("still allows them once the membership is REACTIVATED", async () => {
    // The reverse direction, so the two tests above cannot pass by refusing everybody. A
    // reactivated row is ACTIVE, and this service needs no notion of reactivation to honour it —
    // it reads `status` and nothing else.
    const res = await guardApp(
      requireTeamRead,
      membershipReturning({ ...INACTIVE, status: "ACTIVE" })
    ).request("/teams/t1/probe", { headers: asUser({ id: "u1", role: "PARTICIPANT" }) });
    expect(res.status).toBe(200);
  });
});

