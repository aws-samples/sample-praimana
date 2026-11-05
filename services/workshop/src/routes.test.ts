import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createWorkshopRoutes } from "./routes.js";
import {
  NoWorkshopMembership,
  type TeamAccess,
  type TeamWorkshop,
  type WorkshopMembership,
  type WorkshopEntitlements,
  type UserRoles,
} from "./authz.js";
import {
  ZeroWorkshopStats,
  type Format,
  type FormatRepository,
  type Phase,
  type PhaseRepository,
  type TeamPhase,
  type TeamPhaseRepository,
  type Workshop,
  type WorkshopRepository,
  type WorkshopStats,
} from "./domain.js";

/**
 * Route-level tests for the Workshop service. Every repository is injected, so
 * nothing here touches DynamoDB.
 *
 * Authentication uses the trusted-internal-hop path (x-internal-token +
 * x-identity-*), the same edgeIdentityMiddleware the deployed service runs.
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

// ─── In-memory fakes ────────────────────────────────────────────────────────

/**
 * Entitlements source under test control. `calls` exists so a test can assert the hop
 * was NOT made — ADMIN and FACILITATOR must answer locally,
 * and "it happened to return the right thing" is not the same as "it never asked".
 */
class FakeEntitlements implements WorkshopEntitlements {
  calls = 0;
  constructor(
    private readonly result:
      | { workshopIds: string[]; truncated: boolean }
      | "unavailable" = { workshopIds: [], truncated: false }
  ) {}
  async listEntitledWorkshopIds() {
    this.calls++;
    return this.result;
  }
}

/**
 * The Identity role lookup, three-valued like the real port. `answer` is what Identity says: a role
 * string, `null` for a determined absence, or `"unavailable"` for "did not answer".
 */
class FakeUserRoles implements UserRoles {
  calls: string[] = [];
  constructor(private readonly answer: string | null | "unavailable") {}
  async roleOf(userId: string) {
    this.calls.push(userId);
    return this.answer;
  }
}

class FakeWorkshops implements WorkshopRepository {
  /** Every (ownerId, id) pair `update` was called with — the key assertion target
   *  for the "update the REAL owner's item" rule. */
  updates: Array<{ ownerId: string; id: string; patch: Partial<Workshop> }> = [];

  constructor(readonly rows: Workshop[] = []) {}

  async listByOwner(ownerId: string) {
    return this.rows.filter((w) => w.ownerId === ownerId);
  }
  async getById(id: string) {
    return this.rows.find((w) => w.id === id) ?? null;
  }
  /**
   * Mirrors DynamoWorkshopRepository.listAllForCatalogue: id+name only, ALPHABETICAL, and
   * `truncated` decided by asking for one more row than the cap. Every owner's rows, which is
   * the whole point of the catalogue.
   */
  catalogueCalls: number[] = [];
  async listAllForCatalogue(limit: number) {
    this.catalogueCalls.push(limit);
    const all = this.rows
      .filter((w) => !!w.id && !!w.name)
      .map((w) => ({ id: w.id, name: w.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { workshops: all.slice(0, limit), truncated: all.length > limit };
  }
  /** Mirrors DynamoWorkshopRepository: deduped, dangling ids dropped, newest first. */
  async listByIds(ids: string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    return unique
      .map((id) => this.rows.find((w) => w.id === id))
      .filter((w): w is Workshop => !!w)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  /**
   * Mirrors DynamoWorkshopRepository.transferOwner: the row MOVES to the new owner, and a
   * destination that already exists or a source that has gone is a `"conflict"` rather than a
   * silent overwrite. Modelled here because the real one is a TransactWriteItems whose atomicity a
   * fake cannot reproduce — what it CAN reproduce is the outcome the route branches on.
   */
  transfers: Array<{ id: string; from: string; to: string }> = [];
  transferConflict = false;
  async transferOwner(workshop: Workshop, toOwnerId: string) {
    if (this.transferConflict) return "conflict" as const;
    const at = this.rows.findIndex(
      (w) => w.ownerId === workshop.ownerId && w.id === workshop.id
    );
    if (at === -1) return "conflict" as const;
    if (this.rows.some((w) => w.ownerId === toOwnerId && w.id === workshop.id)) {
      return "conflict" as const;
    }
    this.rows[at] = { ...this.rows[at], ownerId: toOwnerId };
    this.transfers.push({ id: workshop.id, from: workshop.ownerId, to: toOwnerId });
    return "transferred" as const;
  }

  async put(workshop: Workshop) {
    this.rows.push(workshop);
    return workshop;
  }
  async update(ownerId: string, id: string, patch: Partial<Workshop>) {
    this.updates.push({ ownerId, id, patch });
    const row = this.rows.find((w) => w.ownerId === ownerId && w.id === id);
    if (row) Object.assign(row, patch);
  }
}

class FakePhases implements PhaseRepository {
  constructor(readonly rows: Phase[] = []) {}
  async listByWorkshop(workshopId: string) {
    return this.rows.filter((p) => p.workshopId === workshopId);
  }
  async put(phase: Phase) {
    this.rows.push(phase);
    return phase;
  }
}

class FakeTeamPhases implements TeamPhaseRepository {
  constructor(readonly rows: TeamPhase[] = []) {}
  async listByTeam(teamId: string) {
    return this.rows.filter((tp) => tp.teamId === teamId);
  }
  async put(teamPhase: TeamPhase) {
    this.rows.push(teamPhase);
    return teamPhase;
  }
}

class FakeFormats implements FormatRepository {
  constructor(private readonly rows: Format[] = []) {}
  async listByCategory() {
    return this.rows;
  }
}

/**
 * Stands in for the Team service's /teams/:id/access answer. Team MEMBERSHIP is
 * owned by the Team context, so the per-team phase routes ask rather than read —
 * this fake is that answer, and `calls` proves the routes actually consult it with
 * the caller's own identity.
 */
/**
 * The Team context's answer for the PER-TEAM PHASE routes.
 *
 * Those routes use the CONTENT pair (a team's phase notes are what the team
 * wrote), so `calls` records the content predicates and `wideCalls` records the wide ones.
 * `wideCalls` staying EMPTY is the drift assertion: it is what catches a phase route left on
 * the administration predicate, which a status-code-only test could not see because in most
 * cases both pairs agree.
 *
 * The content flags default to the wide pair's values so every pre-existing test keeps its
 * original meaning.
 */
class FakeTeamAccess implements TeamAccess {
  calls: Array<{ op: "read" | "write"; teamId: string; userId: string; role: string }> = [];
  wideCalls: Array<{ op: "read" | "write"; teamId: string }> = [];
  constructor(
    private readonly reads = true,
    private readonly writes = true,
    private readonly contentReads = reads,
    private readonly contentWrites = writes
  ) {}
  async canRead(teamId: string) {
    this.wideCalls.push({ op: "read", teamId });
    return this.reads;
  }
  async canWrite(teamId: string) {
    this.wideCalls.push({ op: "write", teamId });
    return this.writes;
  }
  async canReadContent(teamId: string, userId: string, role: string) {
    this.calls.push({ op: "read", teamId, userId, role });
    return this.contentReads;
  }
  async canWriteContent(teamId: string, userId: string, role: string) {
    this.calls.push({ op: "write", teamId, userId, role });
    return this.contentWrites;
  }
}

/**
 * Stands in for the Team service's answer to "is this caller on any team in this
 * workshop?" — the membership branch of the workshop READ gate.
 *
 * `calls` is the load-bearing part: the ADMIN and owner branches MUST resolve before
 * this is consulted, because the Team service's ownsWorkshop probe reaches those
 * routes and a hop from here would close a Team → Workshop → Team cycle. A test that
 * only checked the status code would pass while the cycle existed.
 */
class FakeMembership implements WorkshopMembership {
  calls: Array<{ workshopId: string; userId: string; role: string }> = [];
  constructor(private readonly answer: boolean | "unavailable" = false) {}
  async isMember(workshopId: string, userId: string, role: string) {
    this.calls.push({ workshopId, userId, role });
    return this.answer;
  }
}

// ─── Builders ───────────────────────────────────────────────────────────────

const workshop = (over: Partial<Workshop> = {}): Workshop => ({
  ownerId: "owner-1",
  id: "w1",
  name: "Workshop One",
  description: null,
  format: "WORKSHOP",
  status: "DRAFT",
  maxTeamSize: 6,
  minTeamSize: 3,
  aiModel: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  aiEnabled: true,
  enabledAssistants: ["claude"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const phase = (over: Partial<Phase> = {}): Phase => ({
  workshopId: "w1",
  order: 1,
  id: "p1",
  name: "Discover",
  description: "",
  durationMinutes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/**
 * Answers "which experience is this team in?" — the port the per-team phase WRITE consults so it can
 * check the path's `phaseId` against that experience's phase template.
 *
 * ⚠ PERMISSIVE BY DEFAULT, AND ONLY BECAUSE THE ROUTE FAILS CLOSED WITHOUT IT. `deps.teamWorkshop` is
 * optional and its absence is a 503, so a fake that answered `null` or `"unavailable"` by default
 * would make every pre-existing phase-write test assert a refusal and say nothing about what it was
 * written to check. Tests that care set the answer explicitly.
 */
class FakeTeamWorkshop implements TeamWorkshop {
  /** Every call, so a test can assert the route asked — and asked about the right team. */
  readonly calls: string[] = [];
  constructor(private readonly answer: string | null | "unavailable" = "w1") {}
  async workshopIdOf(teamId: string): Promise<string | null | "unavailable"> {
    this.calls.push(teamId);
    return this.answer;
  }
}

function build(
  over: Partial<{
    /** `null` means the port is NOT WIRED — distinct from "not overridden". The route 503s. */
    teamWorkshop: FakeTeamWorkshop | null;
    workshops: FakeWorkshops;
    phases: FakePhases;
    teamPhases: FakeTeamPhases;
    formats: FakeFormats;
    stats: WorkshopStats;
    events: InMemoryPublisher;
    teamAccess: FakeTeamAccess;
    membership: WorkshopMembership;
    entitlements: WorkshopEntitlements;
    userRoles: UserRoles;
  }> = {}
) {
  const deps = {
    workshops: over.workshops ?? new FakeWorkshops([workshop()]),
    phases: over.phases ?? new FakePhases([]),
    ...(over.teamWorkshop === null
      ? {}
      : { teamWorkshop: over.teamWorkshop ?? new FakeTeamWorkshop() }),
    teamPhases: over.teamPhases ?? new FakeTeamPhases([]),
    formats: over.formats ?? new FakeFormats([]),
    stats: over.stats ?? new ZeroWorkshopStats(),
    events: over.events ?? new InMemoryPublisher(),
    teamAccess: over.teamAccess ?? new FakeTeamAccess(true, true),
    // Defaults to "nobody is a member", so a read test must say explicitly who it
    // expects to get in. A default of `true` would make the gate invisible: every
    // existing test would keep passing whether or not the branch worked.
    membership: over.membership ?? new NoWorkshopMembership(),
    // Defaults to a DEFINITE empty set, not "unavailable": a default of unavailable
    // would 503 every pre-existing list test and hide which ones actually exercise
    // the branch.
    entitlements: over.entitlements ?? new FakeEntitlements(),
    /**
     * ⚠ DEFAULTS TO UNDEFINED, MATCHING A DEPLOYMENT THAT HAS NOT WIRED IT. So the transfer route
     * answers 501 unless a test says otherwise — which is the polarity the route documents, and
     * means no pre-existing test can accidentally transfer anything.
     */
    userRoles: over.userRoles,
  };
  return { app: createWorkshopRoutes(deps), deps };
}

// ─── Ownership guard (the rule shared by every mutating route) ───────────────

describe("owner-or-ADMIN write guard", () => {
  const mutations: Array<{ name: string; method: string; path: string; body: unknown }> = [
    { name: "PATCH /workshops/:id", method: "PATCH", path: "/v1/workshops/w1", body: { name: "Renamed" } },
    { name: "PATCH /workshops/:id/status", method: "PATCH", path: "/v1/workshops/w1/status", body: { status: "ACTIVE" } },
    { name: "PUT /workshops/:id/phases", method: "PUT", path: "/v1/workshops/w1/phases", body: { phases: [{ name: "P" }] } },
    { name: "PATCH /workshops/:id/current-phase", method: "PATCH", path: "/v1/workshops/w1/current-phase", body: { currentPhaseOrder: 2 } },
  ];

  for (const m of mutations) {
    it(`${m.name} lets the owner through`, async () => {
      const { app } = build();
      const res = await app.request(m.path, {
        method: m.method,
        headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
        body: JSON.stringify(m.body),
      });
      expect(res.status).toBeLessThan(300);
    });

    it(`${m.name} rejects a non-owner with 403`, async () => {
      const { app, deps } = build();
      const res = await app.request(m.path, {
        method: m.method,
        headers: asUser({ id: "stranger", email: "s@b.c", role: "FACILITATOR" }),
        body: JSON.stringify(m.body),
      });
      expect(res.status).toBe(403);
      // …and nothing was written.
      expect(deps.workshops.updates).toHaveLength(0);
    });

    /**
     * ⚠ WAS "lets a global ADMIN through". THE RULE: an admin sees no other experiences, scores or
     * anything else they do not own — and a role that cannot READ another owner's experience must
     * not be able to rename it, move its lifecycle, rewrite its phases or change its assistants.
     *
     * The pair below is the rule: an admin who OWNS it still writes (that is "if admin creates
     * experience yes"); one who does not is refused.
     */
    it(`${m.name} REFUSES an ADMIN who does not own the experience`, async () => {
      const { app } = build();
      const res = await app.request(m.path, {
        method: m.method,
        headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
        body: JSON.stringify(m.body),
      });
      expect(res.status).toBe(403);
    });

    it(`${m.name} lets an ADMIN who OWNS the experience through`, async () => {
      // The fixture's workshop is owned by `owner-1`; an ADMIN carrying that id created it.
      const { app } = build();
      const res = await app.request(m.path, {
        method: m.method,
        headers: asUser({ id: "owner-1", email: "a@b.c", role: "ADMIN" }),
        body: JSON.stringify(m.body),
      });
      expect(res.status).toBeLessThan(300);
    });

    it(`${m.name} 404s an unknown workshop`, async () => {
      const { app } = build({ workshops: new FakeWorkshops([]) });
      const res = await app.request(m.path, {
        method: m.method,
        headers: asUser({ id: "owner-1", email: "o@b.c", role: "ADMIN" }),
        body: JSON.stringify(m.body),
      });
      expect(res.status).toBe(404);
    });

    it(`${m.name} requires authentication`, async () => {
      const { app } = build();
      const res = await app.request(m.path, {
        method: m.method,
        body: JSON.stringify(m.body),
      });
      expect(res.status).toBe(401);
    });
  }
});

// ─── WHO MAY CREATE A WORKSHOP ───────────────────────────────────────────────

/**
 * THE ROLE GATE ON POST /v1/workshops, and the escalation its absence allowed.
 *
 * This route had NO role check — only requireIdentity — while all four mutating routes
 * above ran isOwnerOrAdmin. The rule ("only ADMIN and FACILITATOR may create") lived
 * solely in the portal's tRPC router, and that is a BFF rather than a boundary:
 * /v1/workshops is mapped `Method: ANY` behind an authorizer with no
 * AuthorizationScopes, and the browser holds its own ID token, so the route is reachable
 * directly with a participant's own credentials.
 *
 * WHY IT WAS AN ESCALATION AND NOT MERELY AN UNGUARDED WRITE. The row it creates names
 * the caller as `ownerId` — precisely what isOwnerOrAdmin accepts. So a PARTICIPANT
 * could create a workshop and thereby earn write access to all four routes above, plus
 * team creation, since the Team service's `ownsWorkshop` probe also decides on ownerId
 * alone. That probe's own comment asserts the case "is never true for
 * EXECUTIVE/JUDGE/PARTICIPANT, since they cannot create workshops at all" — the
 * invariant this route was falsifying.
 *
 * The route previously had NO tests at all: the string "POST" did not appear once in
 * this file, which is how a missing gate on the one route that manufactures ownership
 * went unnoticed while its four dependents were covered by a shared truth table.
 */
describe("POST /v1/workshops — the create role gate", () => {
  const create = (
    role: string,
    body: unknown = { name: "New Experience", description: "d" }
  ) => ({
    method: "POST",
    headers: asUser({ id: "caller-1", email: "c@b.c", role }),
    body: JSON.stringify(body),
  });

  // Derived from the two-role set rather than written out, so adding a creator role to
  // the service means changing the table and not hunting these cases.
  const ALLOWED = ["ADMIN", "FACILITATOR"];
  const REFUSED = ["EXECUTIVE", "JUDGE", "PARTICIPANT"];

  for (const role of ALLOWED) {
    it(`lets a ${role} create one`, async () => {
      const { app, deps } = build({ workshops: new FakeWorkshops([]) });
      const res = await app.request("/v1/workshops", create(role));

      expect(res.status).toBe(201);
      expect(deps.workshops.rows).toHaveLength(1);
      // The caller owns what they created — the property every downstream gate reads.
      expect(deps.workshops.rows[0].ownerId).toBe("caller-1");
    });
  }

  for (const role of REFUSED) {
    it(`REFUSES a ${role} with 403 and writes NOTHING`, async () => {
      const { app, deps } = build({ workshops: new FakeWorkshops([]) });
      const res = await app.request("/v1/workshops", create(role));

      expect(res.status).toBe(403);
      // The whole point: no row means no ownerId, so none of the four routes above
      // becomes reachable. Asserting the status alone would pass against a gate that
      // refused only AFTER persisting.
      expect(deps.workshops.rows).toHaveLength(0);
    });

    it(`publishes no workshop.created event for a ${role}`, async () => {
      // A refused create must not reach the five read-models either. An event with no row
      // behind it is worse than the row: it is unfalsifiable from the workshop table.
      const { app, deps } = build({ workshops: new FakeWorkshops([]) });
      await app.request("/v1/workshops", create(role));

      expect(deps.events.published).toHaveLength(0);
    });
  }

  it("refuses a role the service does not model — fails CLOSED", async () => {
    // A token carrying a group this service has never heard of must not create anything.
    // An allowlist gives this for free; a denylist of the three refused roles would not.
    // Note the CASE-SENSITIVITY cases: "admin" and "Facilitator" are refused, which is
    // deliberate — the only producer of this value collapses a Cognito group claim to one
    // of five upper-case literals, so a differently-cased value did not come from there.
    const { app, deps } = build({ workshops: new FakeWorkshops([]) });
    for (const role of ["OWNER", "SUPERUSER", "admin", "Facilitator"]) {
      const res = await app.request("/v1/workshops", create(role));
      expect(res.status, role).toBe(403);
    }
    expect(deps.workshops.rows).toHaveLength(0);
  });

  it("401s an EMPTY role rather than 403 — there is no caller to judge", async () => {
    // Not the gate firing: edgeIdentityMiddleware resolves no identity from a blank role
    // header, so the request is unauthenticated. Pinned because it looks like an
    // inconsistency and is not — 403 would imply a principal was evaluated.
    const { app, deps } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request("/v1/workshops", create(""));
    expect(res.status).toBe(401);
    expect(deps.workshops.rows).toHaveLength(0);
  });

  it("requires authentication", async () => {
    const { app } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request("/v1/workshops", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("checks the ROLE before reading the body, so a refusal cannot be probed with a bad one", async () => {
    // Ordering matters for the error the caller sees: a body-parse 400 arriving before the
    // 403 would tell an unauthorized caller their payload shape was the problem, which is
    // both misleading and a hint about what the route wants.
    const { app } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request("/v1/workshops", {
      method: "POST",
      headers: asUser({ id: "p", email: "p@b.c", role: "PARTICIPANT" }),
      body: "{ not json",
    });
    expect(res.status).toBe(403);
  });

  it("400s a malformed body from an ALLOWED role, rather than 500ing", async () => {
    // The handler used to call c.req.json() unguarded, so a malformed body threw and
    // surfaced as a 500 on a route the caller had merely called wrongly.
    const { app } = build({ workshops: new FakeWorkshops([]) });
    for (const body of ["{ not json", "[]", '"a string"', "null"]) {
      const res = await app.request("/v1/workshops", {
        method: "POST",
        headers: asUser({ id: "a", email: "a@b.c", role: "ADMIN" }),
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it("requires a non-blank name", async () => {
    // A nameless workshop renders as an unclickable blank row in every list that shows
    // one. The store has no schema to refuse it and the tRPC layer's min(1) is not the
    // boundary.
    const { app, deps } = build({ workshops: new FakeWorkshops([]) });
    for (const name of [undefined, "", "   ", 42, null]) {
      const res = await app.request("/v1/workshops", create("ADMIN", { name }));
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    expect(deps.workshops.rows).toHaveLength(0);
  });

  it("REFUSES a non-numeric maxTeamSize rather than silently defaulting it", async () => {
    /**
     * ⚠ THIS RULE CHANGED, and the old behaviour was the defect.
     *
     * `maxTeamSize: "9"` used to go through `num(body.maxTeamSize, 6)` and be persisted as 6 —
     * with a 201, so the caller was told the workshop was created exactly as asked while the
     * value they sent was thrown away. Two silent failures in one: a wrong cap, and a
     * successful-looking response. The field also had no range check at all, so 999 was stored
     * verbatim.
     *
     * Now it is a 400. A cap is an authorization-adjacent limit — it decides how many people
     * can join a team — so guessing at it is worse than refusing.
     *
     * `minTeamSize: null` still coerces to its default: that field has no enforcement hanging
     * off it, so the old lenient treatment is left exactly as it was rather than widened by
     * association.
     */
    const { app, deps } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request(
      "/v1/workshops",
      create("ADMIN", { name: "N", maxTeamSize: "9", minTeamSize: null })
    );

    expect(res.status).toBe(400);
    expect(deps.workshops.rows, "nothing persisted").toHaveLength(0);
  });

  it("still coerces minTeamSize, which carries no enforcement", async () => {
    const { app, deps } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request(
      "/v1/workshops",
      create("ADMIN", { name: "N", minTeamSize: null })
    );

    expect(res.status).toBe(201);
    expect(deps.workshops.rows[0].minTeamSize).toBe(3);
    // And the cap defaults when ABSENT — absent is not the same as malformed.
    expect(deps.workshops.rows[0].maxTeamSize).toBe(6);
  });

  it("trims the name and keeps DRAFT as the created status", async () => {
    const { app, deps } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request("/v1/workshops", create("FACILITATOR", { name: "  Padded  " }));

    expect(res.status).toBe(201);
    expect(deps.workshops.rows[0].name).toBe("Padded");
    // A create that produced anything other than DRAFT would skip the lifecycle the
    // status route exists to drive.
    expect(deps.workshops.rows[0].status).toBe("DRAFT");
  });
});

// ─── The phantom-row bug this ownership resolution exists to prevent ─────────

describe("updates target the REAL (ownerId, id), never the caller's id", () => {
    /**
     * ⚠ THE CALLER IS NOW AN ADMIN WHO OWNS THE EXPERIENCE. It used to be a NON-owning admin, which
     * this route now refuses — so the phantom-row scenario below is no longer reachable
     * THROUGH the route at all: only the owner can write, and for them caller id and `ownerId` coincide.
     *
     * The assertion is kept because the property it guards is still the one that matters — the write is
     * keyed on the workshop's STORED `ownerId` and not on whatever the caller happens to be — and a
     * future re-widening (an admin override, a transfer flow) would make the two diverge again with no
     * test watching. That non-owners cannot reach this at all is enforced by the write-guard specs above.
     */
  it("PATCH /status as ADMIN writes against the owner's key", async () => {
    // The workshops table is keyed by (ownerId, id) and `update` is an upsert.
    // Keying the write on the CALLER's id would silently create a phantom workshop
    // row owned by the admin instead of updating the real one — a write that
    // "succeeds" while changing nothing the owner can see.
    const workshops = new FakeWorkshops([workshop({ ownerId: "owner-1", id: "w1" })]);
    const { app } = build({ workshops });

    const res = await app.request("/v1/workshops/w1/status", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ status: "ACTIVE" }),
    });

    expect(res.status).toBe(200);
    expect(workshops.updates).toEqual([
      { ownerId: "owner-1", id: "w1", patch: expect.objectContaining({ status: "ACTIVE" }) },
    ]);
    expect(workshops.rows).toHaveLength(1);
    expect(workshops.rows[0].status).toBe("ACTIVE");
  });

    /**
     * ⚠ THE CALLER IS NOW AN ADMIN WHO OWNS THE EXPERIENCE. It used to be a NON-owning admin, which
     * this route now refuses — so the phantom-row scenario below is no longer reachable
     * THROUGH the route at all: only the owner can write, and for them caller id and `ownerId` coincide.
     *
     * The assertion is kept because the property it guards is still the one that matters — the write is
     * keyed on the workshop's STORED `ownerId` and not on whatever the caller happens to be — and a
     * future re-widening (an admin override, a transfer flow) would make the two diverge again with no
     * test watching. That non-owners cannot reach this at all is enforced by the write-guard specs above.
     */
  it("PATCH /workshops/:id as ADMIN writes against the owner's key", async () => {
    const workshops = new FakeWorkshops([workshop({ ownerId: "owner-1", id: "w1" })]);
    const { app } = build({ workshops });

    await app.request("/v1/workshops/w1", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ name: "Renamed" }),
    });

    expect(workshops.updates[0].ownerId).toBe("owner-1");
  });

    /**
     * ⚠ THE CALLER IS NOW AN ADMIN WHO OWNS THE EXPERIENCE. It used to be a NON-owning admin, which
     * this route now refuses — so the phantom-row scenario below is no longer reachable
     * THROUGH the route at all: only the owner can write, and for them caller id and `ownerId` coincide.
     *
     * The assertion is kept because the property it guards is still the one that matters — the write is
     * keyed on the workshop's STORED `ownerId` and not on whatever the caller happens to be — and a
     * future re-widening (an admin override, a transfer flow) would make the two diverge again with no
     * test watching. That non-owners cannot reach this at all is enforced by the write-guard specs above.
     */
  it("PATCH /current-phase as ADMIN writes against the owner's key", async () => {
    const workshops = new FakeWorkshops([workshop({ ownerId: "owner-1", id: "w1" })]);
    const { app } = build({ workshops });

    await app.request("/v1/workshops/w1/current-phase", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ currentPhaseOrder: 3 }),
    });

    expect(workshops.updates[0].ownerId).toBe("owner-1");
  });
});

// ─── Status validation ──────────────────────────────────────────────────────

describe("PATCH /v1/workshops/:id/status", () => {
  it("accepts every declared lifecycle status", async () => {
    for (const status of ["DRAFT", "REGISTRATION", "ACTIVE", "JUDGING", "COMPLETED", "ARCHIVED"]) {
      const { app } = build();
      const res = await app.request("/v1/workshops/w1/status", {
        method: "PATCH",
        headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("rejects an unknown status with 400", async () => {
    const { app, deps } = build();
    const res = await app.request("/v1/workshops/w1/status", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ status: "PARTY_TIME" }),
    });
    expect(res.status).toBe(400);
    expect(deps.workshops.updates).toHaveLength(0);
  });

  it("rejects a lower-cased status (the check is exact-match)", async () => {
    const { app } = build();
    const res = await app.request("/v1/workshops/w1/status", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(400);
  });

  it("validates the status BEFORE looking the workshop up", async () => {
    // Cheap check first: a bad status is a 400 even for an unknown workshop.
    const { app } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request("/v1/workshops/nope/status", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "ADMIN" }),
      body: JSON.stringify({ status: "PARTY_TIME" }),
    });
    expect(res.status).toBe(400);
  });

    /**
     * ⚠ THE CALLER IS NOW AN ADMIN WHO OWNS THE EXPERIENCE. It used to be a NON-owning admin, which
     * this route now refuses — so the phantom-row scenario below is no longer reachable
     * THROUGH the route at all: only the owner can write, and for them caller id and `ownerId` coincide.
     *
     * The assertion is kept because the property it guards is still the one that matters — the write is
     * keyed on the workshop's STORED `ownerId` and not on whatever the caller happens to be — and a
     * future re-widening (an admin override, a transfer flow) would make the two diverge again with no
     * test watching. That non-owners cannot reach this at all is enforced by the write-guard specs above.
     */
  it("publishes workshop.status-changed carrying the OWNER's id", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    await app.request("/v1/workshops/w1/status", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "a@b.c", role: "ADMIN" }),
      body: JSON.stringify({ status: "JUDGING" }),
    });

    expect(events.published).toEqual([
      {
        source: "workshop-service",
        type: "workshop.status-changed",
        detail: { workshopId: "w1", ownerId: "owner-1", status: "JUDGING" },
      },
    ]);
  });

  it("publishes nothing when the status is rejected", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });
    await app.request("/v1/workshops/w1/status", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ status: "NOPE" }),
    });
    expect(events.published).toHaveLength(0);
  });
});

// ─── PATCH /workshops/:id field allow-list ──────────────────────────────────

describe("PATCH /v1/workshops/:id", () => {
  it("copies only allow-listed fields into the patch", async () => {
    // `status` is deliberately NOT in the allow-list — it has its own validated
    // route. `ownerId` and `id` are likewise excluded, so this route can never be
    // used to re-home a workshop or change its key.
    const workshops = new FakeWorkshops([workshop()]);
    const { app } = build({ workshops });

    await app.request("/v1/workshops/w1", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({
        name: "Renamed",
        maxTeamSize: 8,
        status: "ARCHIVED",
        ownerId: "attacker",
        id: "other",
      }),
    });

    const { patch } = workshops.updates[0];
    expect(patch.name).toBe("Renamed");
    expect(patch.maxTeamSize).toBe(8);
    expect(patch).not.toHaveProperty("status");
    expect(patch).not.toHaveProperty("ownerId");
    expect(patch).not.toHaveProperty("id");
  });

  it("omits fields the caller didn't send, rather than nulling them", async () => {
    const workshops = new FakeWorkshops([workshop()]);
    const { app } = build({ workshops });

    await app.request("/v1/workshops/w1", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ name: "Only the name" }),
    });

    expect(Object.keys(workshops.updates[0].patch).sort()).toEqual(["name", "updatedAt"]);
  });

  it("sanitizes enabledAssistants so a workshop is never left with an empty list", async () => {
    const workshops = new FakeWorkshops([workshop()]);
    const { app } = build({ workshops });

    await app.request("/v1/workshops/w1", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ enabledAssistants: ["bogus"] }),
    });

    expect(workshops.updates[0].patch.enabledAssistants).toEqual(["claude", "kiro", "codex"]);
  });

  it("always stamps updatedAt", async () => {
    const workshops = new FakeWorkshops([workshop()]);
    const { app } = build({ workshops });

    await app.request("/v1/workshops/w1", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({}),
    });

    expect(workshops.updates[0].patch.updatedAt).toEqual(expect.any(String));
  });
});

// ─── PATCH /current-phase validation ────────────────────────────────────────

describe("PATCH /v1/workshops/:id/current-phase", () => {
  it("rejects a negative or non-numeric order with 400", async () => {
    for (const currentPhaseOrder of [-1, "2", null, undefined, {}]) {
      const { app, deps } = build();
      const res = await app.request("/v1/workshops/w1/current-phase", {
        method: "PATCH",
        headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
        body: JSON.stringify({ currentPhaseOrder }),
      });
      expect(res.status).toBe(400);
      expect(deps.workshops.updates).toHaveLength(0);
    }
  });

  it("accepts 0 (a non-negative number: 'no phase started yet')", async () => {
    // `!currentPhaseOrder` would wrongly reject 0; the check is an explicit `< 0`.
    const { app } = build();
    const res = await app.request("/v1/workshops/w1/current-phase", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ currentPhaseOrder: 0 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, currentPhaseOrder: 0 });
  });

  it("publishes ONE workshop-level phase-advanced event, not a per-team fan-out", async () => {
    // Teams are owned by the TEAM service, so this service must not enumerate them.
    // It publishes a single workshop-scoped event and lets Team fan it out.
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    await app.request("/v1/workshops/w1/current-phase", {
      method: "PATCH",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ currentPhaseOrder: 2 }),
    });

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      source: "workshop-service",
      type: "workshop.phase-advanced",
      detail: { workshopId: "w1", currentPhaseOrder: 2 },
    });
  });
});

// ─── PUT /phases (destructive bulk replace) ─────────────────────────────────

describe("PUT /v1/workshops/:workshopId/phases", () => {
  it("authorizes BEFORE deleting anything", async () => {
    // This route deletes and recreates every phase. If the ownership check ran
    // after the delete loop, an unauthorized request would wipe a workshop's phases
    // and then return 403 — destructive work behind a rejected call.
    const phases = new FakePhases([phase({ order: 1 }), phase({ order: 2, id: "p2" })]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "stranger", email: "s@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ phases: [{ name: "New" }] }),
    });

    expect(res.status).toBe(403);
    expect(phases.rows.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("rejects an empty or missing phases array before deleting anything", async () => {
    for (const body of [{ phases: [] }, {}, { phases: "nope" }]) {
      const phases = new FakePhases([phase()]);
      const { app } = build({ phases });
      const res = await app.request("/v1/workshops/w1/phases", {
        method: "PUT",
        headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(phases.rows).toHaveLength(1);
    }
  });

  /**
   * ── ⚠ THIS BLOCK REPLACED A TEST NAMED "replaces the existing set and renumbers order from 1" ──
   *
   * That test passed, and it asserted a capability that has been REMOVED BY REQUEST: "make sure no one
   * can edit rename or delete the current 3 phases". It is recorded here rather than deleted quietly,
   * because a reader finding the new 409 needs to know the old behaviour was intentional-and-withdrawn
   * rather than never-implemented.
   *
   * The replace was silent data loss, not an edit. Phase ids key every team's NOTES
   * (`praimana-team-phases`) and appear in released submission SNAPSHOTS, and the route minted
   * fresh ULIDs — so a rename orphaned every note with nothing reporting an error.
   */
  it("CREATES the phases when a workshop has none — the only write path left", async () => {
    const phases = new FakePhases([]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({
        phases: [{ name: "First" }, { name: "Second", durationMinutes: 30 }],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { phases: Phase[] };
    expect(body.phases.map((p) => [p.order, p.name, p.durationMinutes])).toEqual([
      [1, "First", null],
      [2, "Second", 30],
    ]);
  });

  it("⚠ REFUSES to rename an existing phase, and DELETES NOTHING", async () => {
    const phases = new FakePhases([
      phase({ order: 1, id: "p1", name: "Ideation" }),
      phase({ order: 2, id: "p2", name: "Build" }),
      phase({ order: 3, id: "p3", name: "Demo" }),
    ]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({
        phases: [{ name: "Ideation" }, { name: "Building" }, { name: "Demo" }],
      }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PHASES_IMMUTABLE");
    // The assertion that matters most: the refusal happens BEFORE the delete loop. The original code
    // deleted first and asked questions never.
    expect(phases.rows.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("⚠ REFUSES to delete a phase (a shorter list)", async () => {
    const phases = new FakePhases([
      phase({ order: 1, id: "p1", name: "Ideation" }),
      phase({ order: 2, id: "p2", name: "Build" }),
      phase({ order: 3, id: "p3", name: "Demo" }),
    ]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ phases: [{ name: "Ideation" }, { name: "Build" }] }),
    });

    expect(res.status).toBe(409);
    expect(phases.rows.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("⚠ REFUSES a REORDER, which a name-set comparison would have missed", async () => {
    // Swapping two names is the case an unordered "same names?" check waves through, and it is a real
    // edit: `currentPhaseOrder` and the pipeline a participant walks would both change meaning.
    const phases = new FakePhases([
      phase({ order: 1, id: "p1", name: "Ideation" }),
      phase({ order: 2, id: "p2", name: "Build" }),
    ]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ phases: [{ name: "Build" }, { name: "Ideation" }] }),
    });

    expect(res.status).toBe(409);
    // The stored order is untouched, which is the claim — not merely that a status came back.
    expect(phases.rows.map((p) => [p.order, p.name])).toEqual([
      [1, "Ideation"],
      [2, "Build"],
    ]);
  });

  it("⚠ REFUSES a description-only edit, because 'edit' is not just 'rename'", async () => {
    const phases = new FakePhases([
      phase({ order: 1, id: "p1", name: "Ideation", description: "Diverge" }),
    ]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ phases: [{ name: "Ideation", description: "Diverge widely" }] }),
    });

    expect(res.status).toBe(409);
  });

  it("is IDEMPOTENT for an identical submission — a retry must not read as a failure", async () => {
    /**
     * The create page calls this immediately after creating the workshop. A network blip AFTER a
     * successful write would otherwise leave an operator staring at an error on an experience that is
     * perfectly fine. Returns 200 (not 201) and writes nothing.
     */
    const phases = new FakePhases([
      phase({ order: 1, id: "p1", name: "Ideation", description: "Diverge" }),
      phase({ order: 2, id: "p2", name: "Build", durationMinutes: 90 }),
    ]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({
        phases: [
          { name: "Ideation", description: "Diverge" },
          { name: "Build", durationMinutes: 90 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { phases: Phase[] };
    // The ORIGINAL ids, which is the point — a fresh set would have orphaned every note.
    expect(body.phases.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(phases.rows.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("treats an omitted description/duration as the stored empty form on a retry", async () => {
    // The store normalises with `|| ""` and `|| null`, so a client that omits them entirely is sending
    // the same thing. Failing that comparison would make a retry 409 on an unchanged pipeline.
    const phases = new FakePhases([phase({ order: 1, id: "p1", name: "Ideation" })]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ phases: [{ name: "Ideation" }] }),
    });

    expect(res.status).toBe(200);
  });

  it("still refuses a NON-OWNER before looking at the phases at all", async () => {
    const phases = new FakePhases([phase()]);
    const { app } = build({ phases });

    const res = await app.request("/v1/workshops/w1/phases", {
      method: "PUT",
      headers: asUser({ id: "stranger", email: "s@b.c", role: "FACILITATOR" }),
      body: JSON.stringify({ phases: [{ name: "Whatever" }] }),
    });

    expect(res.status).toBe(403);
  });
});

// ─── Read routes ────────────────────────────────────────────────────────────

/**
 * The ENTITLED list — the fix for a bug where an EXECUTIVE signed
 * in, landed on /workshops (correctly — EXECUTIVE is staff), and saw NO experiences,
 * because this route was listByOwner() for every role and an executive owns nothing.
 *
 * The invariant worth stating once: an UNDETERMINED entitlement must never be rendered
 * as "you have none". That is the same lie as the 403 which said "not the owner" when a
 * probe had timed out, and here it would look identical to the bug being fixed.
 */
describe("GET /v1/workshops — the entitled list (non-owner roles)", () => {
  for (const role of ["EXECUTIVE", "JUDGE", "PARTICIPANT"]) {
    it(`returns E(self) ∩ membership for a ${role}, who owns no workshop`, async () => {
      // ⚠ RE-POINTED (NEW-2). This asserted that ENTITLEMENT ALONE put a workshop in the
      // list. It no longer does: the list is now intersected with membership so it matches
      // what `requireWorkshopRead` will actually open — an entitled non-member used to get
      // 200 here and 403 on every click. `FakeMembership(true)` supplies the membership half
      // that the entitled-but-not-member spec below deliberately withholds.
      const workshops = new FakeWorkshops([
        workshop({ ownerId: "someone-else", id: "entitled-1" }),
        workshop({ ownerId: "someone-else", id: "not-entitled" }),
      ]);
      const entitlements = new FakeEntitlements({
        workshopIds: ["entitled-1"],
        truncated: false,
      });
      const { app } = build({
        workshops,
        entitlements,
        membership: new FakeMembership(true),
      });

      const res = await app.request("/v1/workshops", {
        headers: asUser({ id: "exec-1", email: "e@b.c", role }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { workshops: Workshop[] };
      // The workshop they are entitled to — owned by someone else, which is the
      // whole point: ownership is not the only way to see an experience.
      expect(body.workshops.map((w) => w.id)).toEqual(["entitled-1"]);
    });
  }

  it("503s — never an empty list — when entitlements cannot be determined", async () => {
    // THE CORE REGRESSION GUARD. Answering 200 {workshops: []} here would be
    // indistinguishable from that bug, and would tell a user their access had
    // changed when in fact a hop failed.
    const entitlements = new FakeEntitlements("unavailable");
    const { app } = build({ entitlements });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    const body = (await res.json()) as { code?: string };
    // A machine-readable code so a client can render "retry", not "no access".
    expect(body.code).toBe("ENTITLEMENTS_UNAVAILABLE");
  });

  it("returns a DETERMINED empty list as 200, not 503", async () => {
    // "You genuinely have none" and "we could not tell" must be different answers.
    const entitlements = new FakeEntitlements({ workshopIds: [], truncated: false });
    const { app } = build({ entitlements });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ workshops: [] });
  });

  it("NEVER consults entitlements for ADMIN or FACILITATOR", async () => {
    // These roles answer locally so a Team brownout cannot break
    // the one list that already worked. Asserted on the CALL COUNT, because returning
    // the right rows by luck is not the same as never having asked.
    for (const role of ["ADMIN", "FACILITATOR"]) {
      const entitlements = new FakeEntitlements("unavailable");
      const workshops = new FakeWorkshops([workshop({ ownerId: "me", id: "mine" })]);
      const { app } = build({ workshops, entitlements });

      const res = await app.request("/v1/workshops", {
        headers: asUser({ id: "me", email: "m@b.c", role }),
      });

      // Would be a 503 if the hop had been consulted, since it reports unavailable.
      expect(res.status).toBe(200);
      expect(entitlements.calls).toBe(0);
    }
  });

  it("gives an unmodelled role an empty list, without a hop", async () => {
    // Fails closed on a role we do not model, and does not spend a round trip finding
    // out. A token whose groups we don't understand gets nothing.
    const entitlements = new FakeEntitlements("unavailable");
    const { app } = build({ entitlements });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "who", email: "w@b.c", role: "SOMETHING_NEW" }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ workshops: [] });
    expect(entitlements.calls).toBe(0);
  });

  it("drops a dangling entitlement instead of failing", async () => {
    // An invitation can name a workshop that has since been deleted. That is not an
    // error and must not 500 the whole list — the other entitlements still resolve.
    const workshops = new FakeWorkshops([workshop({ ownerId: "x", id: "alive" })]);
    const entitlements = new FakeEntitlements({
      workshopIds: ["alive", "deleted-long-ago"],
      truncated: false,
    });
    // Membership supplied: this spec is about a DANGLING id, not about the NEW-2
    // narrowing, so it must not fail for the unrelated reason that the fake defaults to
    // "not a member".
    const { app } = build({
      workshops,
      entitlements,
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { workshops: Workshop[] };
    expect(body.workshops.map((w) => w.id)).toEqual(["alive"]);
  });

  it("dedupes an id entitled by BOTH an invitation and team membership", async () => {
    // An executive invited to a workshop AND on a team in it is entitled once. A
    // duplicate would render the same experience card twice.
    const workshops = new FakeWorkshops([workshop({ ownerId: "x", id: "w9" })]);
    const entitlements = new FakeEntitlements({
      workshopIds: ["w9", "w9"],
      truncated: false,
    });
    // Membership supplied — see the note on the dangling-entitlement spec above.
    const { app } = build({
      workshops,
      entitlements,
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    const body = (await res.json()) as { workshops: Workshop[] };
    expect(body.workshops.map((w) => w.id)).toEqual(["w9"]);
  });

  it("surfaces `truncated` so a capped list is not presented as complete", async () => {
    const workshops = new FakeWorkshops([workshop({ ownerId: "x", id: "w1" })]);
    const entitlements = new FakeEntitlements({
      workshopIds: ["w1"],
      truncated: true,
    });
    // Membership supplied — see the note on the dangling-entitlement spec above.
    const { app } = build({
      workshops,
      entitlements,
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    expect((await res.json()) as { truncated?: boolean }).toMatchObject({
      truncated: true,
    });
  });

  it("still folds team counts in under ?withCounts=1 on the entitled path", async () => {
    // The entitled path must not lose a feature the owned path has, or an executive's
    // cards would render differently from a facilitator's for no reason.
    const workshops = new FakeWorkshops([workshop({ ownerId: "x", id: "w1" })]);
    const entitlements = new FakeEntitlements({
      workshopIds: ["w1"],
      truncated: false,
    });
    const stats: WorkshopStats = {
      async teamCounts(ids) {
        return Object.fromEntries(ids.map((id) => [id, 4]));
      },
    };
    // Membership supplied — see the note on the dangling-entitlement spec above.
    const { app } = build({
      workshops,
      entitlements,
      stats,
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops?withCounts=1", {
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
    });

    const body = (await res.json()) as {
      workshops: Array<Workshop & { _count?: { teams: number } }>;
    };
    expect(body.workshops[0]._count).toEqual({ teams: 4 });
  });
});

describe("PATCH /v1/workshops/:id/owner — ownership transfer (orphan recovery)", () => {
  /**
   * ── ⚠ WHY THIS ROUTE EXISTS AT ALL ───────────────────────────────────────────────────────────
   *
   * Scoping ADMIN to the experiences it owns created a state with no way out: an
   * experience whose owner is DEACTIVATED is administrable by NOBODY, because every gate on it is
   * `workshop.ownerId === caller` and no living person satisfies it. This is the way back.
   *
   * The obvious alternative, "an admin can invite a facilitator into the experience",
   * does nothing today — `WORKSHOP_POLICY` forbids a facilitator invitation naming a workshop, and
   * the read gate's entitlement branch is narrowed to JUDGE. Transfer changes one field instead of
   * inventing a second class of experience staff and re-deciding every owner-only rule for them.
   */
  const orphan = () =>
    new FakeWorkshops([workshop({ ownerId: "gone-user", id: "w1", name: "Orphaned Sprint" })]);

  const asAdmin = { id: "admin-1", email: "a@b.c", role: "ADMIN" };

  const transfer = (app: ReturnType<typeof build>["app"], body: unknown, identity = asAdmin) =>
    app.request("/v1/workshops/w1/owner", {
      method: "PATCH",
      headers: asUser(identity),
      body: JSON.stringify(body),
    });

  it("moves the experience to an eligible new owner", async () => {
    const workshops = orphan();
    const { app } = build({ workshops, userRoles: new FakeUserRoles("FACILITATOR") });

    const res = await transfer(app, { ownerId: "fac-2" });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { transferred: boolean }).transferred).toBe(true);
    expect(workshops.transfers).toEqual([{ id: "w1", from: "gone-user", to: "fac-2" }]);
    // And the row actually moved, which is what makes the experience reachable again.
    expect((await workshops.getById("w1"))?.ownerId).toBe("fac-2");
  });

  /**
   * ⚠ THE ESCALATION THIS ROUTE WOULD OTHERWISE BE. `isOwnerOrAdmin` — the gate on every mutating
   * workshop route — is PURE OWNERSHIP with no role check, so an experience handed to a PARTICIPANT
   * would let them rename it, set its phases and reopen its submissions. `canCreateWorkshops` gates
   * who may CREATE one and says nothing about who may come to own one.
   */
  it("⚠ REFUSES A TARGET WHO MAY NOT OWN AN EXPERIENCE", async () => {
    for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
      const workshops = orphan();
      const { app } = build({ workshops, userRoles: new FakeUserRoles(role) });

      const res = await transfer(app, { ownerId: "someone" });

      expect(res.status, role).toBe(400);
      expect(((await res.json()) as { code: string }).code, role).toBe("TRANSFER_TARGET_INELIGIBLE");
      expect(workshops.transfers, role).toEqual([]);
    }
  });

  it("accepts an ADMIN as the new owner as well as a FACILITATOR", async () => {
    // Both can own an experience (WORKSHOP_CREATOR_ROLES), so both are valid recovery targets.
    const workshops = orphan();
    const { app } = build({ workshops, userRoles: new FakeUserRoles("ADMIN") });

    expect((await transfer(app, { ownerId: "admin-2" })).status).toBe(200);
    expect(workshops.transfers).toHaveLength(1);
  });

  it("is ADMIN-only — a FACILITATOR cannot transfer, even the current owner", async () => {
    // Platform administration, not an experience power: an orphan has no owner to ask.
    const workshops = new FakeWorkshops([workshop({ ownerId: "fac-1", id: "w1" })]);
    const { app } = build({ workshops, userRoles: new FakeUserRoles("FACILITATOR") });

    const res = await transfer(app, { ownerId: "fac-2" }, { id: "fac-1", email: "f@b.c", role: "FACILITATOR" });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("TRANSFER_ADMIN_ONLY");
    expect(workshops.transfers).toEqual([]);
  });

  it("⚠ REFUSES RATHER THAN SKIPPING THE CHECK when the directory is not wired", async () => {
    // The fail-open shape this codebase already shipped once (an empty COGNITO_CLIENT_ID silently
    // disabled audience validation). An absent dependency must never mean "skip the gate".
    const workshops = orphan();
    const { app } = build({ workshops }); // no userRoles

    const res = await transfer(app, { ownerId: "fac-2" });

    expect(res.status).toBe(501);
    expect(((await res.json()) as { code: string }).code).toBe("TRANSFER_UNAVAILABLE");
    expect(workshops.transfers).toEqual([]);
  });

  it("⚠ 503s when the role cannot be determined — never 'no such user'", async () => {
    // Telling an operator mid-recovery that the user does not exist sends them hunting
    // for a typo; the truth is "ask again in a moment".
    const workshops = orphan();
    const { app } = build({ workshops, userRoles: new FakeUserRoles("unavailable") });

    const res = await transfer(app, { ownerId: "fac-2" });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { code: string }).code).toBe("USER_LOOKUP_UNAVAILABLE");
    expect(workshops.transfers).toEqual([]);
  });

  it("400s a target Identity does not know", async () => {
    const workshops = orphan();
    const { app } = build({ workshops, userRoles: new FakeUserRoles(null) });

    const res = await transfer(app, { ownerId: "ghost" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("TRANSFER_TARGET_UNKNOWN");
  });

  it("is IDEMPOTENT when the target already owns it — no lookup, no write", async () => {
    // Re-running a recovery that already succeeded should read as "yes, that is the owner", not as
    // an error an operator has to interpret at the worst moment.
    const workshops = new FakeWorkshops([workshop({ ownerId: "fac-2", id: "w1" })]);
    const userRoles = new FakeUserRoles("FACILITATOR");
    const { app } = build({ workshops, userRoles });

    const res = await transfer(app, { ownerId: "fac-2" });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { transferred: boolean }).transferred).toBe(false);
    expect(workshops.transfers).toEqual([]);
    expect(userRoles.calls, "no need to ask about a user who already owns it").toEqual([]);
  });

  it("409s a concurrent transfer rather than reporting a move that did not happen", async () => {
    const workshops = orphan();
    workshops.transferConflict = true;
    const { app } = build({ workshops, userRoles: new FakeUserRoles("FACILITATOR") });

    const res = await transfer(app, { ownerId: "fac-2" });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("TRANSFER_CONFLICT");
  });

  it("404s an experience that does not exist, and 400s a missing ownerId", async () => {
    const { app } = build({ workshops: orphan(), userRoles: new FakeUserRoles("FACILITATOR") });

    const missing = await app.request("/v1/workshops/nope/owner", {
      method: "PATCH",
      headers: asUser(asAdmin),
      body: JSON.stringify({ ownerId: "fac-2" }),
    });
    expect(missing.status).toBe(404);

    for (const body of [{}, { ownerId: "" }, { ownerId: "   " }, { ownerId: 7 }]) {
      expect((await transfer(app, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("puts the move on the event bus, with who did it", async () => {
    // A recovery that leaves no trace is the wrong shape for a privileged action. The actor is the
    // ADMIN who ran it, not the new owner.
    const events = new InMemoryPublisher();
    const { app } = build({ workshops: orphan(), userRoles: new FakeUserRoles("FACILITATOR"), events });

    await transfer(app, { ownerId: "fac-2" });

    expect(events.published).toEqual([
      {
        source: "workshop-service",
        type: "workshop.owner_transferred",
        detail: { workshopId: "w1", fromOwnerId: "gone-user", toOwnerId: "fac-2", actorId: "admin-1" },
      },
    ]);
  });

  it("⚠ AND THE TRANSFER SURVIVES A FAILED PUBLISH — it has already committed", async () => {
    // Failing the response after the write would tell an operator the recovery did not happen when
    // it did, which is the worst possible answer during a recovery.
    class BrokenEvents extends InMemoryPublisher {
      async publish(): Promise<void> {
        throw new Error("event bus down");
      }
    }
    const workshops = orphan();
    const { app } = build({
      workshops,
      userRoles: new FakeUserRoles("FACILITATOR"),
      events: new BrokenEvents(),
    });

    const res = await transfer(app, { ownerId: "fac-2" });

    expect(res.status).toBe(200);
    expect(workshops.transfers).toHaveLength(1);
  });
});

describe("GET /v1/workshops/catalogue — the ADMIN experience catalogue", () => {
  const threeOwners = () =>
    new FakeWorkshops([
      workshop({ ownerId: "owner-1", id: "w1", name: "Zeta Sprint" }),
      workshop({ ownerId: "owner-2", id: "w2", name: "Alpha Hack" }),
      workshop({ ownerId: "owner-3", id: "w3", name: "Mid Jam" }),
    ]);

  it("REACHES ITS OWN HANDLER rather than being swallowed by /workshops/:id", async () => {
    /**
     * ⚠ THE FAILURE MODE THIS PINS IS INDISTINGUISHABLE FROM AN EMPTY CATALOGUE, which is why it
     * is asserted first and separately. Hono matches in REGISTRATION ORDER and `:id` matches
     * exactly one segment, so declaring this route after `/workshops/:id` makes it unreachable:
     * every request lands in the by-id handler, which looks up a workshop literally named
     * "catalogue" and 404s. A reader seeing that 404 concludes the catalogue is empty or the
     * route is missing, not that two routes are fighting over one path.
     *
     * So: a 404 here means the registration order regressed, NOT that there are no experiences.
     */
    const { app } = build({ workshops: threeOwners() });

    const res = await app.request("/v1/workshops/catalogue", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("Workshop not found");
  });

  it("lists EVERY owner's experiences, alphabetically, with id and name ONLY", async () => {
    // The capability: an admin can invite any user to any experience from the Administration
    // tab, as a facilitator does. None of these three is owned by
    // the caller — that is the point, and it is the one thing `GET /workshops` will not do.
    const { app } = build({ workshops: threeOwners() });

    const res = await app.request("/v1/workshops/catalogue", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workshops: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(body.workshops.map((w) => w.name)).toEqual(["Alpha Hack", "Mid Jam", "Zeta Sprint"]);
    expect(body.truncated).toBe(false);

    /**
     * ⚠ THE KEY SET IS ASSERTED EXACTLY, AND IT IS THE AUTHORIZATION BOUNDARY. This route is a
     * deliberate, narrow exception to "an admin sees no other experiences, scores or
     * anything": it may disclose that an experience EXISTS and what it is CALLED, so an admin can
     * name it in the invite picker. Anything else — ownerId, status, dates, maxTeamSize,
     * setupConfig — would be the scoping quietly coming undone one field at a time, which is why
     * this is `toEqual` on the keys rather than a spot-check of two of them.
     */
    for (const row of body.workshops) {
      expect(Object.keys(row).sort()).toEqual(["id", "name"]);
    }
  });

  it("403s a FACILITATOR — one facilitator must not enumerate another's experiences", async () => {
    // Deliberately NOT `isStaffRole`. "facilitors should see the workshops they
    // created not other facilitators created", and `GET /workshops` already gives them theirs.
    const workshops = threeOwners();
    const { app } = build({ workshops });

    const res = await app.request("/v1/workshops/catalogue", {
      headers: asUser({ id: "owner-1", email: "f@b.c", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CATALOGUE_ADMIN_ONLY");
    // Refused BEFORE the Scan — a role check that still pays for the read is a role check that
    // has already loaded every experience on the platform into this process.
    expect(workshops.catalogueCalls).toEqual([]);
  });

  it("403s every other role, and 401s an anonymous caller", async () => {
    for (const role of ["JUDGE", "EXECUTIVE", "PARTICIPANT", "SOMETHING_NEW"]) {
      const { app } = build({ workshops: threeOwners() });
      const res = await app.request("/v1/workshops/catalogue", {
        headers: asUser({ id: "u1", email: "u@b.c", role }),
      });
      expect(res.status, role).toBe(403);
    }

    const { app } = build({ workshops: threeOwners() });
    expect((await app.request("/v1/workshops/catalogue")).status).toBe(401);
  });

  it("BOUNDS the scan and REPORTS the truncation rather than returning a short list quietly", async () => {
    // A Scan's cost is set by the TABLE, not by the request, and this one is reachable from a page
    // render — so the cap exists whether or not the platform will ever hold 200 experiences.
    // `truncated` is what stops a short picker reading as "that experience does not exist".
    const many = new FakeWorkshops(
      Array.from({ length: 250 }, (_, i) =>
        workshop({ ownerId: `o${i}`, id: `w${i}`, name: `W${String(i).padStart(3, "0")}` })
      )
    );
    const { app } = build({ workshops: many });

    const res = await app.request("/v1/workshops/catalogue", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    const body = (await res.json()) as { workshops: unknown[]; truncated: boolean };
    expect(body.workshops).toHaveLength(200);
    expect(body.truncated).toBe(true);
    // The cap reached the repository rather than being applied after the read.
    expect(many.catalogueCalls).toEqual([200]);
  });
});

describe("GET /v1/workshops", () => {
  it("lists only the caller's own workshops", async () => {
    const workshops = new FakeWorkshops([
      workshop({ ownerId: "owner-1", id: "mine" }),
      workshop({ ownerId: "someone-else", id: "theirs" }),
    ]);
    const { app } = build({ workshops });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
    });

    const body = (await res.json()) as { workshops: Workshop[] };
    expect(body.workshops.map((w) => w.id)).toEqual(["mine"]);
  });

  it("folds team counts in under ?withCounts=1, from the injected stats source", async () => {
    // The count comes from WorkshopStats (a Team-service client or read-model),
    // never a read of the foreign teams table.
    const stats: WorkshopStats = {
      async teamCounts(ids) {
        return Object.fromEntries(ids.map((id) => [id, 7]));
      },
    };
    const { app } = build({ stats });

    const res = await app.request("/v1/workshops?withCounts=1", {
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
    });

    const body = (await res.json()) as { workshops: Array<{ _count: { teams: number } }> };
    expect(body.workshops[0]._count).toEqual({ teams: 7 });
  });

  it("OMITS _count when the count is unknown — never a stated zero", async () => {
    // Inverted deliberately. This asserted `{ teams: 0 }`, and that default is what made
    // the experiences list report "0 teams" for workshops that had teams: the placeholder
    // stats source returned nothing, the route turned that into a confident zero, and the
    // UI printed it as fact. Unknown must stay unknown so the UI can render "—".
    const stats: WorkshopStats = { async teamCounts() { return {}; } };
    const { app } = build({ stats });

    const res = await app.request("/v1/workshops?withCounts=1", {
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
    });

    const body = (await res.json()) as { workshops: Array<Record<string, unknown>> };
    expect(body.workshops[0]).not.toHaveProperty("_count");
  });

  it("omits _count entirely without the query flag", async () => {
    const { app } = build();
    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
    });
    const body = (await res.json()) as { workshops: Array<Record<string, unknown>> };
    expect(body.workshops[0]).not.toHaveProperty("_count");
  });
});

describe("GET /v1/workshops/:id/assistants", () => {
  it("sanitizes a stored list so an older workshop never reports zero assistants", async () => {
    // Workshops created before enabledAssistants existed have no field at all. They
    // must read back as "all enabled", not as an empty list that locks the desktop
    // app out of every assistant.
    const workshops = new FakeWorkshops([
      workshop({ enabledAssistants: undefined as unknown as string[] }),
    ]);
    // The caller is the participant the desktop app runs as, entitled via team
    // membership — this route is now gated, so the sanitizer can only be exercised
    // through a caller who is actually allowed in.
    const { app } = build({ workshops, membership: new FakeMembership(true) });

    const res = await app.request("/v1/workshops/w1/assistants", {
      headers: asUser({ id: "anyone", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({ enabledAssistants: ["claude", "kiro", "codex"] });
  });

  it("passes a valid stored list through untouched", async () => {
    const workshops = new FakeWorkshops([workshop({ enabledAssistants: ["kiro"] })]);
    const { app } = build({ workshops, membership: new FakeMembership(true) });

    const res = await app.request("/v1/workshops/w1/assistants", {
      headers: asUser({ id: "anyone", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(await res.json()).toEqual({ enabledAssistants: ["kiro"] });
  });

  it("404s an unknown workshop", async () => {
    const { app } = build({ workshops: new FakeWorkshops([]) });
    const res = await app.request("/v1/workshops/nope/assistants", {
      headers: asUser({ id: "anyone", email: "a@b.c", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── The workshop READ gate (P0-1, P1-3) ────────────────────────────────────
//
// GET /workshops/:id, /:id/assistants and /:workshopId/phases had NO authorization:
// any signed-in caller who could name an id read the workshop's name, description,
// setupConfig (free-text setup instructions), aiModel and status. All three are gated TOGETHER,
// because gating only /:id moves the hole rather than closing it.
//
// The truth table these tests pin, identically on all three routes:
//
//   caller                      | outcome | membership hop consulted?
//   ----------------------------|---------|--------------------------
//   unauthenticated             | 401     | no (never reaches handler)
//   ADMIN                       | 200     | NO — short-circuits
//   owner                       | 200     | NO — short-circuits
//   member of a team in W       | 200     | yes
//   non-owner, non-member       | 403     | yes
//   hop cannot answer           | 503     | yes
//   unknown workshop            | 404     | no

describe("workshop read gate", () => {
  /** The three routes that expose one workshop, and must therefore agree exactly. */
  const readRoutes = [
    { name: "GET /workshops/:id", path: "/v1/workshops/w1" },
    { name: "GET /workshops/:id/assistants", path: "/v1/workshops/w1/assistants" },
    { name: "GET /workshops/:workshopId/phases", path: "/v1/workshops/w1/phases" },
  ];

  const OWNER = { id: "owner-1", email: "o@b.c", role: "FACILITATOR" };
  const STRANGER = { id: "stranger", email: "s@b.c", role: "PARTICIPANT" };

  for (const r of readRoutes) {
    it(`${r.name} requires authentication`, async () => {
      const { app } = build();
      const res = await app.request(r.path);
      expect(res.status).toBe(401);
    });

    it(`${r.name} 403s a signed-in non-owner who is on no team in the workshop`, async () => {
      // The hole, closed. This returned 200 with the workshop's full record —
      // including setupConfig's setup instructions — to anyone who could name an id.
      const membership = new FakeMembership(false);
      const { app } = build({ membership });

      const res = await app.request(r.path, { headers: asUser(STRANGER) });

      expect(res.status).toBe(403);
      // Nothing about the workshop leaks through the denial body.
      expect(await res.text()).not.toContain("Workshop One");
    });

    it(`${r.name} REFUSES a global ADMIN, still without consulting the membership hop`, async () => {
      // Not an optimisation — a correctness invariant. The Team service resolves
      // workshop ownership by calling GET /v1/workshops/:id, so if that route hopped
      // back into Team you get Team → Workshop → Team on one Lambda pool: it deadlocks
      // concurrency under load instead of degrading. `calls` is the assertion that
      // matters here; the 200 alone would pass with the cycle in place.
      const membership = new FakeMembership(false);
      const { app } = build({ membership });

      const res = await app.request(r.path, {
        headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      });

      /**
       * ⚠ REFUSED NOW, AND THE INVARIANT THIS TEST EXISTS FOR IS UNCHANGED. THE RULE:
       * an admin reads only the experiences they own. `membership.calls` is still the assertion that
       * matters — the admin branch resolves LOCALLY in both directions, so the
       * Team → Workshop → Team cycle still cannot form. A fall-through to the hop would satisfy the
       * 403 and reintroduce the deadlock, which is exactly why the hop count is asserted and not
       * merely the status.
       */
      expect(res.status).toBe(403);
      expect(membership.calls).toHaveLength(0);
    });

    it(`${r.name} lets the OWNER through WITHOUT consulting the membership hop`, async () => {
      // Same invariant, and the branch the ownership probe itself lands on: this is
      // the exact call HttpWorkshopAccess.ownsWorkshop makes, so it must terminate
      // locally.
      const membership = new FakeMembership(false);
      const { app } = build({ membership });

      const res = await app.request(r.path, { headers: asUser(OWNER) });

      expect(res.status).toBe(200);
      expect(membership.calls).toHaveLength(0);
    });

    it(`${r.name} lets a MEMBER of a team in the workshop through`, async () => {
      // The branch that keeps participants — and the desktop app — working. Without
      // it, a bare owner-or-ADMIN rule would 403 every participant.
      const membership = new FakeMembership(true);
      const { app } = build({ membership });

      const res = await app.request(r.path, { headers: asUser(STRANGER) });

      expect(res.status).toBe(200);
    });

    it(`${r.name} asks the membership hop about the CALLER's own identity`, async () => {
      const membership = new FakeMembership(true);
      const { app } = build({ membership });

      await app.request(r.path, { headers: asUser(STRANGER) });

      expect(membership.calls).toEqual([
        { workshopId: "w1", userId: "stranger", role: "PARTICIPANT" },
      ]);
    });

    it(`${r.name} returns 503 (NOT 403) when the membership hop cannot answer`, async () => {
      // A dependency that timed out has told us nothing. Answering 403 would say "you
      // don't have access" — a lie that generates a support ticket and trains
      // operators to ignore permission complaints. Both are fail-closed; only one is
      // honest.
      const membership = new FakeMembership("unavailable");
      const { app } = build({ membership });

      const res = await app.request(r.path, { headers: asUser(STRANGER) });

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: "MEMBERSHIP_UNAVAILABLE" });
      // Retry-After lets a client back off instead of hammering a degraded callee.
      expect(res.headers.get("retry-after")).toBe("2");
    });

    it(`${r.name} 404s an unknown workshop`, async () => {
      const { app } = build({ workshops: new FakeWorkshops([]) });
      const res = await app.request(r.path.replace("w1", "nope"), {
        headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
      });
      expect(res.status).toBe(404);
    });

    it(`${r.name} does not let an EMPTY stored ownerId grant the owner branch`, async () => {
      // A workshop row missing its ownerId must not hand ownership to anyone. The
      // guard's `workshop.ownerId && ...` is what stops two absent values reading as a
      // match; this falls through to the membership branch instead of allowing.
      const workshops = new FakeWorkshops([workshop({ ownerId: "" })]);
      const membership = new FakeMembership(false);
      const { app } = build({ workshops, membership });

      const res = await app.request(r.path, { headers: asUser(STRANGER) });

      expect(res.status).toBe(403);
      expect(membership.calls).toHaveLength(1);
    });

    it(`${r.name} rejects a caller with a BLANK identity at 401, before the gate`, async () => {
      // The complementary half: a blank caller id never reaches the guard at all —
      // edgeIdentityMiddleware requires a non-empty id AND role on the internal-hop
      // path, so the pair (ownerId: "", callerId: "") that would otherwise be the
      // dangerous comparison is unreachable. Pinned because the guard's non-empty check
      // and this 401 are two independent reasons the same hole stays shut, and a change
      // to either must not silently rely on the other.
      const workshops = new FakeWorkshops([workshop({ ownerId: "" })]);
      const { app } = build({ workshops, membership: new FakeMembership(false) });

      const res = await app.request(r.path, {
        headers: asUser({ id: "", email: "x@b.c", role: "PARTICIPANT" }),
      });

      expect(res.status).toBe(401);
    });
  }

  it("gates all three routes identically — no route is more permissive than the others", async () => {
    // Gating only /:id would move the hole rather than close it. This asserts the SET,
    // so adding a fourth workshop-exposing read without a gate shows up here.
    const statuses = await Promise.all(
      readRoutes.map(async (r) => {
        const { app } = build({ membership: new FakeMembership(false) });
        const res = await app.request(r.path, { headers: asUser(STRANGER) });
        return [r.name, res.status] as const;
      })
    );

    expect(statuses).toEqual(readRoutes.map((r) => [r.name, 403]));
  });

  it("does not read a workshop's phases before authorizing", async () => {
    // The phases route previously didn't load the workshop at all. It must now resolve
    // and authorize BEFORE listing, so a forbidden caller's request costs no phase read
    // and can't leak through a partially-built response.
    const phases = new FakePhases([phase({ name: "Discover" })]);
    const { app } = build({ phases, membership: new FakeMembership(false) });

    const res = await app.request("/v1/workshops/w1/phases", {
      headers: asUser(STRANGER),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("Discover");
  });

  it("still serves phases to an entitled caller", async () => {
    const phases = new FakePhases([phase({ order: 1, name: "Discover" })]);
    const { app } = build({ phases, membership: new FakeMembership(true) });

    const res = await app.request("/v1/workshops/w1/phases", {
      headers: asUser(STRANGER),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { phases: Phase[] };
    expect(body.phases.map((p) => p.name)).toEqual(["Discover"]);
  });

  it("leaves the MUTATION gates untouched — they stay owner-or-ADMIN with no hop", async () => {
    // The mutation rule was already correct. A membership grant must NOT become a
    // write grant: a participant on a team in the workshop still cannot edit it.
    const membership = new FakeMembership(true);
    const { app, deps } = build({ membership });

    const res = await app.request("/v1/workshops/w1", {
      method: "PATCH",
      headers: asUser(STRANGER),
      body: JSON.stringify({ name: "Renamed by a participant" }),
    });

    expect(res.status).toBe(403);
    expect(deps.workshops.updates).toHaveLength(0);
    // …and the write path never consulted membership at all.
    expect(membership.calls).toHaveLength(0);
  });
});

// ─── The desktop app's three call sites ─────────────────────────────────────
//
// The desktop app reads these routes as a PARTICIPANT, entitled via team membership.
// It cannot be run from this test suite, so these pin its exact requests: if the
// membership branch regresses, a participant's whole desktop setup flow 403s and this
// is what says so.
//
//   main/handlers/framework.ts fetchSetupConfig → GET /v1/workshops/:id  (setupConfig)
//   renderer/components/SelectAssistantView:87 → GET /v1/workshops/:id
//   main/handlers/ai.ts:387                    → GET /v1/workshops/:id/assistants
//   renderer/components/PhasesView.tsx:52      → GET /v1/workshops/:id

describe("desktop app call sites keep working for a PARTICIPANT", () => {
  const DESKTOP_USER = { id: "participant-1", email: "p@b.c", role: "PARTICIPANT" };

  it("reads setupConfig from GET /workshops/:id (framework.ts fetchSetupConfig)", async () => {
    const workshops = new FakeWorkshops([
      workshop({ setupConfig: { instructions: "Install dependencies and verify the build." } }),
    ]);
    const { app } = build({ workshops, membership: new FakeMembership(true) });

    const res = await app.request("/v1/workshops/w1", { headers: asUser(DESKTOP_USER) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { workshop: Workshop };
    expect(body.workshop.setupConfig).toEqual({
      instructions: "Install dependencies and verify the build.",
    });
  });

  it("reads the assistant list from GET /workshops/:id/assistants (ai.ts:387)", async () => {
    const workshops = new FakeWorkshops([workshop({ enabledAssistants: ["claude", "kiro"] })]);
    const { app } = build({ workshops, membership: new FakeMembership(true) });

    const res = await app.request("/v1/workshops/w1/assistants", {
      headers: asUser(DESKTOP_USER),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabledAssistants: ["claude", "kiro"] });
  });

  it("reads currentPhaseOrder from GET /workshops/:id (PhasesView.tsx:52)", async () => {
    const workshops = new FakeWorkshops([workshop({ currentPhaseOrder: 2 })]);
    const { app } = build({ workshops, membership: new FakeMembership(true) });

    const res = await app.request("/v1/workshops/w1", { headers: asUser(DESKTOP_USER) });

    expect(res.status).toBe(200);
    expect((await res.json()).workshop.currentPhaseOrder).toBe(2);
  });

  it("sees a 503 rather than a 403 when the Team service is degraded", async () => {
    // What the desktop app does with 503 is unknown (it was not reviewed), but the
    // distinction has to exist for it to ever do the right thing — and a retryable
    // status is the one that can be handled correctly later.
    const { app } = build({ membership: new FakeMembership("unavailable") });
    const res = await app.request("/v1/workshops/w1", { headers: asUser(DESKTOP_USER) });
    expect(res.status).toBe(503);
  });
});

// ─── GET /v1/lookup/formats ─────────────────────────────────────────────────

describe("GET /v1/lookup/formats", () => {
  it("requires authentication", async () => {
    // Defence in depth: the route is unmapped in the gateway today, so this is about
    // it not becoming anonymous the day someone maps it.
    const { app } = build();
    const res = await app.request("/v1/lookup/formats");
    expect(res.status).toBe(401);
  });

  it("serves the format list to any authenticated role", async () => {
    // Reference data, identical for everyone — deliberately NOT role-gated, since
    // every role that can reach the create form needs these options.
    const formats = new FakeFormats([{ name: "Workshop", value: "WORKSHOP" }]);
    for (const role of ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
      const { app } = build({ formats });
      const res = await app.request("/v1/lookup/formats", {
        headers: asUser({ id: "u1", email: "u@b.c", role }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ formats: [{ name: "Workshop", value: "WORKSHOP" }] });
    }
  });
});

describe("GET /v1/workshops/teams/:teamId/phases", () => {
  it("403s a caller the Team service says cannot read the team", async () => {
    // teamId is an unvalidated path param, so without this guard a guessed id dumps
    // another team's phase content — the notes the whole workshop is written into.
    const teamPhases = new FakeTeamPhases([
      {
        teamId: "t1",
        phaseId: "p1",
        content: "someone else's notes",
        aiGenerated: false,
        editedById: "u9",
        editedByName: null,
        editedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({ teamPhases, teamAccess: new FakeTeamAccess(false, false) });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w1", {
      headers: asUser({ id: "outsider", email: "o@b.c", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("someone else's notes");
  });

  it("asks the Team service with the CALLER's identity, not the service's own", async () => {
    const teamAccess = new FakeTeamAccess(true, true);
    const { app } = build({ teamAccess });

    await app.request("/v1/workshops/teams/t1/phases?workshopId=w1", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    expect(teamAccess.calls).toEqual([
      { op: "read", teamId: "t1", userId: "u1", role: "PARTICIPANT" },
    ]);
  });

  it("authorizes BEFORE validating the query param", async () => {
    // A forbidden caller must not learn the difference between "bad request" and
    // "wrong team" — both are the same 403 to them.
    const { app } = build({ teamAccess: new FakeTeamAccess(false, false) });
    const res = await app.request("/v1/workshops/teams/t1/phases", {
      headers: asUser({ id: "outsider", email: "o@b.c", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
  });

  it("400s without the workshopId query param", async () => {
    const { app } = build();
    const res = await app.request("/v1/workshops/teams/t1/phases", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(400);
  });

  it("merges phase definitions with the team's saved content, defaulting the gaps", async () => {
    // A phase the team hasn't touched must come back with empty content rather than
    // being dropped — the UI renders one card per workshop phase either way.
    const phases = new FakePhases([
      phase({ order: 1, id: "p1", name: "Discover" }),
      phase({ order: 2, id: "p2", name: "Build" }),
    ]);
    const teamPhases = new FakeTeamPhases([
      {
        teamId: "t1",
        phaseId: "p2",
        content: "our notes",
        aiGenerated: true,
        editedById: "u1",
        editedByName: "Ada",
        editedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    // Membership must now be declared explicitly: this route gained a WORKSHOP read gate
    // (the query-string workshopId was previously unchecked — see the IDOR block below),
    // and `build()` defaults to "nobody is a member" on purpose so a read test has to say
    // who it expects to get in. The ASSERTION below is unchanged; only the precondition
    // this caller always implicitly relied on is now stated.
    const { app } = build({
      phases,
      teamPhases,
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w1", {
      headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      phases: Array<{ id: string; content: string; aiGenerated: boolean; editedAt: string | null }>;
    };
    expect(body.phases).toEqual([
      expect.objectContaining({ id: "p1", content: "", aiGenerated: false, editedAt: null }),
      expect.objectContaining({ id: "p2", content: "our notes", aiGenerated: true }),
    ]);
  });
});

/**
 * THE IDOR ON THE QUERY-STRING workshopId.
 *
 * This route authorized `teamId` — a path param, correctly delegated to the Team service —
 * and then took `workshopId` from the QUERY STRING and passed it straight to
 * listByWorkshop with no check that the team belonged to it. So a member of ANY team could
 * name a FOREIGN workshop and read its phase definitions, bypassing
 * GET /workshops/:workshopId/phases, which gates precisely that with requireWorkshopRead.
 *
 * WHY THE EXISTING TESTS COULD NOT CATCH IT: all five cases above use the single literal
 * `?workshopId=w1`, matching the fixture's own workshop, so FakePhases.listByWorkshop was
 * never called with a mismatched pair. The gate's absence was invisible because nothing
 * ever asked for a workshop the caller had no claim to.
 *
 * Workshop ids are not a control — this service already records that determination above
 * requireWorkshopRead: they leak legitimately through /invitations/mine, the admin filter
 * and desktop settings. So "the attacker would have to know the id" is not a defence.
 */
describe("GET /v1/workshops/teams/:teamId/phases — the foreign-workshop gate", () => {
  /** A caller who genuinely belongs to team t1, in workshop w1. */
  const member = asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" });

  /** Two workshops; the caller has a claim to neither by ownership. */
  const twoWorkshops = () =>
    new FakeWorkshops([
      workshop({ id: "w1", ownerId: "owner-1", name: "Theirs" }),
      workshop({ id: "w2", ownerId: "owner-2", name: "Somebody else's" }),
    ]);

  const bothPhases = () =>
    new FakePhases([
      phase({ workshopId: "w1", order: 1, id: "p1", name: "Our Discover" }),
      phase({ workshopId: "w2", order: 1, id: "p9", name: "Their Secret Kickoff" }),
    ]);

  it("REFUSES a foreign workshopId even though the caller owns the team", async () => {
    // The exploit, exactly: authorized on t1, asking for w2's phases.
    const { app } = build({
      workshops: twoWorkshops(),
      phases: bothPhases(),
      // Member of the team, but NOT of workshop w2 — the distinction the bug erased.
      membership: new FakeMembership(false),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w2", {
      headers: member,
    });

    expect(res.status).toBe(403);
    // Nothing about w2 may appear in the body, not even its phase names.
    expect(await res.text()).not.toContain("Their Secret Kickoff");
  });

  it("still serves the caller's OWN workshop", async () => {
    // The fix must not break the legitimate call — a gate that refuses everything would
    // pass the test above and be useless.
    const { app } = build({
      workshops: twoWorkshops(),
      phases: bothPhases(),
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w1", {
      headers: member,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { phases: Array<{ name: string }> };
    expect(body.phases.map((p) => p.name)).toEqual(["Our Discover"]);
  });

  it("checks the TEAM first, so a non-member learns nothing about the workshop", async () => {
    // Ordering is observable and worth pinning: a caller with no claim to the team must be
    // refused on that basis, without the workshop lookup running at all. Otherwise the
    // route's response would distinguish "workshop does not exist" from "you may not read
    // it" for someone with no standing to ask either question.
    const workshops = twoWorkshops();
    const { app } = build({
      workshops,
      phases: bothPhases(),
      teamAccess: new FakeTeamAccess(false, false),
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w2", {
      headers: member,
    });

    expect(res.status).toBe(403);
  });

  it("404s an unknown workshopId rather than answering with an empty list", async () => {
    // Previously an unknown id produced `{"phases":[]}` — a workshop-existence oracle, and
    // indistinguishable from a real workshop with no phases yet.
    const { app } = build({
      workshops: twoWorkshops(),
      phases: bothPhases(),
      membership: new FakeMembership(true),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=nope", {
      headers: member,
    });

    expect(res.status).toBe(404);
  });

  it("lets the workshop OWNER through without a membership hop", async () => {
    // requireWorkshopRead resolves ownership locally. Asserting the hop count matters:
    // this route is reachable while the Team service is degraded, and an owner's read must
    // not depend on a service that may be the one asking.
    const membership = new FakeMembership(false);
    const { app } = build({
      workshops: twoWorkshops(),
      phases: bothPhases(),
      membership,
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w1", {
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(membership.calls).toHaveLength(0);
  });

  /**
   * ⚠ WAS "lets a global ADMIN through without a membership hop". The hop invariant is unchanged and
   * still asserted — an admin resolves LOCALLY, now to a refusal when they do not own the experience.
   * A fall-through to the hop would satisfy the 403 and reintroduce Team → Workshop → Team.
   */
  it("REFUSES a global ADMIN a foreign workshop's phases, still without a membership hop", async () => {
    const membership = new FakeMembership(false);
    const { app } = build({
      workshops: twoWorkshops(),
      phases: bothPhases(),
      membership,
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w2", {
      headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
    });

    // ⚠ REFUSED LOCALLY. The hop count is the assertion that matters: an admin resolves from the row
    // in both directions, so Team → Workshop → Team still cannot form.
    expect(res.status).toBe(403);
    expect(membership.calls).toHaveLength(0);
  });

  it("503s — never a false 403 — when membership cannot be determined", async () => {
    // The failure semantics this service insists on: "I could not check" must not render as
    // "you may not read this", which is the lie that produced the original access bug.
    const { app } = build({
      workshops: twoWorkshops(),
      phases: bothPhases(),
      membership: new FakeMembership("unavailable"),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases?workshopId=w1", {
      headers: member,
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
  });
});

describe("PUT /v1/workshops/teams/:teamId/phases/:phaseId", () => {
  /**
   * ⚠ EVERY CASE HERE SEEDS THE EXPERIENCE'S PHASE TEMPLATE. The route now checks the
   * path's `phaseId` against the phases of the team's experience, so a build with no template 404s
   * before reaching whatever the test is actually about. `build`'s default stays EMPTY on purpose —
   * seeding it globally makes `PUT /workshops/:id/phases` 409 ("phases are already set"), which is a
   * real refusal that test relies on.
   */
  it("403s a non-member and persists NOTHING", async () => {
    const teamPhases = new FakeTeamPhases([]);
    /**
     * ⚠ `contentReads: false` IS NOW THE THING THAT MAKES THIS A NON-MEMBER. The guard changed from
     * `canWriteContent` to `canReadContent` + a local role rule (see `requireTeamPhaseWrite`), so a
     * fake that answered "content read yes, content write no" describes an ALLOWED member under the
     * new rule. Membership is still the whole protection; this states it in the terms the guard asks.
     */
    const { app } = build({ phases: new FakePhases([phase()]), teamPhases, teamAccess: new FakeTeamAccess(true, false, false, false) });

    const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
      method: "PUT",
      headers: asUser({ id: "outsider", email: "o@b.c", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: "vandalism" }),
    });

    expect(res.status).toBe(403);
    expect(teamPhases.rows).toHaveLength(0);
  });

  /**
   * ── ⚠ THIS ASSERTION IS REVERSED ──────────────────────
   *
   * It used to read "403s a read-only EXECUTIVE without even asking the Team service", and it was
   * correct: an executive could watch a team's phases and never overwrite them. That was a bug —
   * a user holding the EXECUTIVE role could not update their team's ideation phase — and the rule
   * is that every team member must be able to add and update phases, and add and edit board tasks.
   *
   * The board half was already granted (`requireTeamCollaborationWrite`); phases were
   * the outlier. A test describing a deliberate decision must change when the decision changes — and
   * what must NOT change is membership, which the next two cases pin.
   */
  it("lets an EXECUTIVE MEMBER update the team's phase", async () => {
    const teamAccess = new FakeTeamAccess(true, true);
    const teamPhases = new FakeTeamPhases([]);
    const { app } = build({ phases: new FakePhases([phase()]), teamPhases, teamAccess });

    const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
      method: "PUT",
      headers: asUser({ id: "exec-1", email: "e@b.c", role: "EXECUTIVE" }),
      body: JSON.stringify({ content: "# our ideation" }),
    });

    expect(res.status).toBe(200);
    expect(teamPhases.rows).toHaveLength(1);
    // And the edit is ATTRIBUTED — the grant is auditable, not anonymous.
    expect(teamPhases.rows[0]).toMatchObject({ editedById: "exec-1" });
  });

  /**
   * ⚠ THE GRANT IS NOT A LICENCE TO EDIT ANY TEAM. `canReadContent` is pure membership with no role
   * branch, so an executive who does not belong to this team is still refused — which is the property
   * that makes relaxing the role rule safe at all.
   */
  it("still 403s an EXECUTIVE who is not a member of the team", async () => {
    const teamPhases = new FakeTeamPhases([]);
    const { app } = build({ phases: new FakePhases([phase()]),
      teamPhases,
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
      method: "PUT",
      headers: asUser({ id: "exec-2", email: "e2@b.c", role: "EXECUTIVE" }),
      body: JSON.stringify({ content: "not my team" }),
    });

    expect(res.status).toBe(403);
    expect(teamPhases.rows).toHaveLength(0);
  });

  /**
   * ⚠ NOT TESTED HERE, AND THE REASON IS WORTH RECORDING: the guard refuses every read-only role
   * EXCEPT executive, but EXECUTIVE is the only member of `READ_ONLY_ROLES` today, so that branch is
   * unreachable through a route. My first attempt at covering it asserted
   * `expect([200, 403]).toContain(status)` — which accepts either outcome and therefore asserts
   * nothing. A non-assertion that looks like coverage is worse than an acknowledged gap.
   *
   * The branch exists so a read-only role added LATER does not silently inherit this grant, and
   * `authz.test.ts` covers the predicate directly.
   */

  /**
   * ⚠ IT ASKS THE CONTENT **READ** PREDICATE NOW, AND THAT IS THE DESIGN. `canWriteContent` folds the
   * read-only refusal into the membership answer, which is precisely the part being relaxed — so the
   * guard asks pure membership and applies the role rule locally, keeping the two decisions separable.
   * Identical to how `requireTeamCollaborationWrite` does it for chat and the board.
   */
  it("asks the content READ predicate with the caller's identity", async () => {
    const teamAccess = new FakeTeamAccess(true, true);
    const { app } = build({ phases: new FakePhases([phase()]), teamAccess });

    await app.request("/v1/workshops/teams/t1/phases/p1", {
      method: "PUT",
      headers: asUser({ id: "editor-1", email: "e@b.c", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: "ok" }),
    });

    expect(teamAccess.calls).toEqual([
      { op: "read", teamId: "t1", userId: "editor-1", role: "PARTICIPANT" },
    ]);
  });

  it("records the editor's id and coerces a non-string body to empty content", async () => {
    const teamPhases = new FakeTeamPhases([]);
    const { app } = build({ phases: new FakePhases([phase()]), teamPhases });

    const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
      method: "PUT",
      headers: asUser({ id: "editor-1", email: "e@b.c", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: { not: "a string" } }),
    });

    expect(res.status).toBe(200);
    expect(teamPhases.rows[0]).toMatchObject({
      teamId: "t1",
      phaseId: "p1",
      content: "",
      aiGenerated: false,
      editedById: "editor-1",
      // Left null on purpose: names belong to the Identity context and would come
      // from a local users read-model, never a cross-service read.
      editedByName: null,
    });
  });

  it("stores a string body verbatim", async () => {
    const teamPhases = new FakeTeamPhases([]);
    const { app } = build({ phases: new FakePhases([phase()]), teamPhases });

    await app.request("/v1/workshops/teams/t1/phases/p1", {
      method: "PUT",
      headers: asUser({ id: "editor-1", email: "e@b.c", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: "# Heading" }),
    });

    expect(teamPhases.rows[0].content).toBe("# Heading");
  });

  /**
   * ── ⚠ BOUNDS ON THE KEY AND THE CONTENT ────────────────────────────
   *
   * This route stored `content` with only a type check and accepted any `phaseId` from the path, so
   * an authorized member could write unbounded free text, and could write it under a phase id that
   * does not exist — an orphan row the merged read (which iterates the WORKSHOP'S phases) never
   * surfaces.
   *
   * Phase content is COPIED INLINE into the release snapshot, so an unbounded note also risked
   * pushing the submission item past DynamoDB's 400 KB item limit and making RELEASE fail for a team
   * that had done nothing wrong at release time.
   */
  describe("bounds", () => {
    const editor = asUser({ id: "editor-1", email: "e@b.c", role: "PARTICIPANT" });

    it("REFUSES content past the cap and persists nothing", async () => {
      const teamPhases = new FakeTeamPhases([]);
      const { app } = build({ phases: new FakePhases([phase()]), teamPhases });

      const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
        method: "PUT",
        headers: editor,
        body: JSON.stringify({ content: "x".repeat(40_001) }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("PHASE_CONTENT_TOO_LONG");
      // REFUSED, NOT TRUNCATED: a member must not be told their notes saved when they did not.
      expect(teamPhases.rows).toHaveLength(0);
    });

    it("accepts content exactly at the cap", async () => {
      const teamPhases = new FakeTeamPhases([]);
      const { app } = build({ phases: new FakePhases([phase()]), teamPhases });

      const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
        method: "PUT",
        headers: editor,
        body: JSON.stringify({ content: "x".repeat(40_000) }),
      });

      expect(res.status).toBe(200);
      expect(teamPhases.rows[0].content).toHaveLength(40_000);
    });

    it("REFUSES an absurd phaseId rather than keying a row on it", async () => {
      const teamPhases = new FakeTeamPhases([]);
      const { app } = build({ phases: new FakePhases([phase()]), teamPhases });

      const res = await app.request(
        `/v1/workshops/teams/t1/phases/${"p".repeat(200)}`,
        {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes" }),
        }
      );

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("PHASE_ID_INVALID");
      expect(teamPhases.rows).toHaveLength(0);
    });

    /**
     * ── ⚠ THE HALF LOCAL BOUNDS COULD NOT REACH ──────────────────────────
     *
     * The length bound above stops an ABSURD phase id; it cannot tell whether the id MEANS anything.
     * Without this check a member could save notes under an id that names no phase, and the merged
     * read — which iterates the experience's phases and looks each one up — never surfaces them.
     * Work somebody believes they saved, that nobody can ever see.
     *
     * The phase TEMPLATE is this service's own data; the missing link was teamId → workshopId, which
     * only Team can answer. `TeamWorkshop` asks it over Team's own API with the CALLER's token.
     */
    describe("the phaseId must name a phase of the team's experience", () => {
      it("REFUSES a phaseId that is not in the experience's template", async () => {
        const teamPhases = new FakeTeamPhases([]);
        const { app } = build({
          teamPhases,
          phases: new FakePhases([phase({ id: "p1" }), phase({ id: "p2", order: 2 })]),
        });

        const res = await app.request("/v1/workshops/teams/t1/phases/not-a-phase", {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes nobody will ever see" }),
        });

        expect(res.status).toBe(404);
        expect((await res.json()).code).toBe("PHASE_NOT_FOUND");
        // ⚠ THE ORPHAN ROW, which is the actual finding: nothing may be written.
        expect(teamPhases.rows).toHaveLength(0);
      });

      it("asks about the RIGHT team, and accepts every phase the template names", async () => {
        const teamWorkshop = new FakeTeamWorkshop("w1");
        const { app } = build({
          teamWorkshop,
          phases: new FakePhases([phase({ id: "p1" }), phase({ id: "p2", order: 2 })]),
        });

        for (const phaseId of ["p1", "p2"]) {
          const res = await app.request(`/v1/workshops/teams/t1/phases/${phaseId}`, {
            method: "PUT",
            headers: editor,
            body: JSON.stringify({ content: "real notes" }),
          });
          expect(res.status, phaseId).toBe(200);
        }

        expect(teamWorkshop.calls).toEqual(["t1", "t1"]);
      });

      it("REFUSES a phase belonging to a DIFFERENT experience", async () => {
        // The template is read for the TEAM'S experience, not for whichever one holds the phase. A
        // lookup keyed on the phase instead of the team would let a member write notes against
        // another experience's phase ids.
        const teamPhases = new FakeTeamPhases([]);
        const { app } = build({
          teamPhases,
          teamWorkshop: new FakeTeamWorkshop("w1"),
          phases: new FakePhases([phase({ workshopId: "w2", id: "foreign" })]),
        });

        const res = await app.request("/v1/workshops/teams/t1/phases/foreign", {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes" }),
        });

        expect(res.status).toBe(404);
        expect(teamPhases.rows).toHaveLength(0);
      });

      it("503s rather than refusing when the team's experience cannot be resolved", async () => {
        // ⚠ `"unavailable"` IS NOT AN ABSENCE. Telling a member their phase does not
        // exist because Team was slow would send them arguing with a rule that will fix itself, and
        // Retry-After is the truthful answer for something transient.
        const teamPhases = new FakeTeamPhases([]);
        const { app } = build({
          teamPhases,
          teamWorkshop: new FakeTeamWorkshop("unavailable"),
          phases: new FakePhases([phase()]),
        });

        const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes" }),
        });

        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe("PHASE_TEMPLATE_UNAVAILABLE");
        expect(res.headers.get("Retry-After")).toBe("2");
        expect(teamPhases.rows).toHaveLength(0);
      });

      it("REFUSES when the team belongs to no experience at all", async () => {
        // A DETERMINED absence — the orphan-team case the team service's `canRead` documents. There
        // is no phase template, so no id can be valid; answered rather than written into.
        const teamPhases = new FakeTeamPhases([]);
        const { app } = build({
          teamPhases,
          teamWorkshop: new FakeTeamWorkshop(null),
          phases: new FakePhases([phase()]),
        });

        const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes" }),
        });

        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe("PHASE_NOT_IN_EXPERIENCE");
        expect(teamPhases.rows).toHaveLength(0);
      });

      it("FAILS CLOSED when no teamWorkshop port is wired at all", async () => {
        // ⚠ THE POLARITY THAT KEEPS THE FIX FIXED. The port is optional so the service still
        // composes where it is not wired — and if that absence meant "skip the check", every
        // un-updated deployment would silently restore the defect this closes.
        const teamPhases = new FakeTeamPhases([]);
        const { app } = build({
          teamPhases,
          teamWorkshop: null,
          phases: new FakePhases([phase()]),
        });

        const res = await app.request("/v1/workshops/teams/t1/phases/p1", {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes" }),
        });

        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe("PHASE_TEMPLATE_UNAVAILABLE");
        expect(teamPhases.rows).toHaveLength(0);
      });

      it("does not pay for the hop when a local check already refused", async () => {
        // Cheapest-first: the phase-id bound and the content cap are local, so an obviously-wrong
        // request must not cost an east-west call.
        const teamWorkshop = new FakeTeamWorkshop("w1");
        const { app } = build({ teamWorkshop, phases: new FakePhases([phase()]) });

        await app.request(`/v1/workshops/teams/t1/phases/${"p".repeat(200)}`, {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "notes" }),
        });
        await app.request("/v1/workshops/teams/t1/phases/p1", {
          method: "PUT",
          headers: editor,
          body: JSON.stringify({ content: "y".repeat(40_001) }),
        });

        expect(teamWorkshop.calls).toEqual([]);
      });
    });

    it("refuses the oversized body BEFORE writing, even for a legitimate phase", async () => {
      // Ordering matters: a bound applied after the write would leave the row it exists to prevent.
      const teamPhases = new FakeTeamPhases([
        {
          teamId: "t1",
          phaseId: "p1",
          content: "the real notes",
          aiGenerated: false,
          editedById: "editor-1",
          editedByName: null,
          editedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      const { app } = build({ phases: new FakePhases([phase()]), teamPhases });

      await app.request("/v1/workshops/teams/t1/phases/p1", {
        method: "PUT",
        headers: editor,
        body: JSON.stringify({ content: "y".repeat(40_001) }),
      });

      // The existing row is untouched — a refused write must not damage what was there.
      expect(teamPhases.rows).toHaveLength(1);
      expect(teamPhases.rows[0].content).toBe("the real notes");
    });
  });
});

// ─── per-team PHASE CONTENT is member-only ─────────────────────────

describe("per-team phase content is MEMBER-ONLY", () => {
  /**
   * A team's phase notes are what THEY wrote in response to each phase — the same kind of
   * material as the board and the chat, stored in teamPhases keyed by teamId. These
   * two routes are in scope, so they moved from the WIDE predicate (member
   * OR staff who owns the workshop OR ADMIN) to the CONTENT one.
   *
   * THE DELIBERATE CONSEQUENCE, stated rather than smoothed over: a workshop-owning
   * FACILITATOR no longer reads their teams' phase notes. The phase DEFINITIONS they own are
   * a different thing from the teams' answers to them, and those stay readable through
   * GET /workshops/:workshopId/phases — which is unchanged and gated on requireWorkshopRead.
   */
  const PHASE_ROUTES = [
    {
      name: "GET /workshops/teams/:teamId/phases",
      method: "GET",
      path: "/v1/workshops/teams/t1/phases?workshopId=w1",
      op: "read" as const,
    },
    {
      name: "PUT /workshops/teams/:teamId/phases/:phaseId",
      method: "PUT",
      path: "/v1/workshops/teams/t1/phases/p1",
      /**
       * ⚠ "read", NOT "write", SINCE THE PHASE GRANT. The route asks the content READ
       * predicate and applies the role rule locally — see `requireTeamPhaseWrite`. What this test is
       * really guarding is unchanged and is the line below: it must never ask the WIDE predicate,
       * which would let a workshop owner who is not a member edit a team's notes.
       */
      op: "read" as const,
      body: { content: "# ours" },
    },
  ];

  for (const r of PHASE_ROUTES) {
    it(`${r.name} asks the CONTENT predicate, never the wide one`, async () => {
      // THE DRIFT ASSERTION. With both pairs agreeing, a route left on the wide predicate
      // returns the same status — `wideCalls` staying empty is the only thing that sees it.
      const teamAccess = new FakeTeamAccess(true, true);
      const { app } = build({ teamAccess });

      await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(teamAccess.calls).toHaveLength(1);
      expect(teamAccess.calls[0].op).toBe(r.op);
      expect(teamAccess.wideCalls).toEqual([]);
    });

    it(`${r.name} 403s a non-member ADMIN, and writes nothing`, async () => {
      // Wide true, content false — what the Team service answers for a non-member ADMIN or a
      // workshop-owning FACILITATOR.
      const teamPhases = new FakeTeamPhases([
        {
          teamId: "t1",
          phaseId: "p1",
          content: "our private notes",
          aiGenerated: false,
          editedById: "u9",
          editedByName: null,
          editedAt: "2026-02-01T00:00:00.000Z",
        },
      ]);
      const { app } = build({
        teamPhases,
        teamAccess: new FakeTeamAccess(true, true, false, false),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "admin", email: "a@b.c", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
      // The notes stayed behind, and the write did not land.
      expect(await res.text()).not.toContain("our private notes");
      expect(teamPhases.rows).toHaveLength(1);
      expect(teamPhases.rows[0].content).toBe("our private notes");
    });

    it(`${r.name} 403s a workshop-owning FACILITATOR — the deliberate consequence`, async () => {
      // Named explicitly rather than folded into the ADMIN case above, because this is the
      // behaviour change an operator is most likely to report as a bug. It is the decision.
      const { app } = build({
        teamAccess: new FakeTeamAccess(true, true, false, false),
        membership: new FakeMembership(true),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "owner", email: "o@b.c", role: "FACILITATOR" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
    });

    it(`${r.name} 403s when the Team service cannot answer (fail-closed)`, async () => {
      const { app } = build({ teamAccess: new FakeTeamAccess(false, false, false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", email: "a@b.c", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });

    it(`${r.name} 403s a forged x-identity-role: ADMIN with no membership`, async () => {
      // A compromised internal caller asserting its own role gains nothing: this service has
      // no role branch for the content decision, only a membership question it must ask.
      const { app } = build({ teamAccess: new FakeTeamAccess(true, true, false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "attacker", email: "x@b.c", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });

    it(`${r.name} still lets a MEMBER through`, async () => {
      // `FakeMembership(true)` is required for the GET, not incidental: that route has a
      // SECOND gate (requireWorkshopRead on the `?workshopId=` query param) which exists so
      // a member of ANY team cannot read a FOREIGN workshop's phase definitions. A team
      // member is also a workshop member, so this fixture is the realistic combination — and
      // it is what proves the team gate was narrowed without disturbing that one.
      const { app } = build({
        teamAccess: new FakeTeamAccess(true, true),
        membership: new FakeMembership(true),
        // ⚠ SEEDED: the phase WRITE now checks the path's `phaseId` against the
        // experience's phase template, so an empty template 404s before the gate under test is
        // reached — and this loop covers the write as well as the read.
        phases: new FakePhases([phase()]),
      });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "member", email: "m@b.c", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBeLessThan(300);
    });
  }

  it("leaves the workshop-level PHASE DEFINITIONS readable by their owner", async () => {
    // The other half of the decision, and the reason narrowing the per-team routes does not
    // lock a facilitator out of their own workshop: the definitions are workshop data, gated
    // on requireWorkshopRead, and are untouched by the member-only change.
    const phases = new FakePhases([phase({ order: 1, id: "p1", name: "Discover" })]);
    const { app } = build({
      phases,
      // Owns nothing per the team gate, and the workshop gate resolves locally for the owner.
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/workshops/w1/phases", {
      headers: asUser({ id: "owner-1", email: "o@b.c", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Discover");
  });
});
