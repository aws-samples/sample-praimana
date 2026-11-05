import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createWorkshopRoutes } from "./routes.js";
import {
  NoWorkshopMembership,
  type TeamAccess,
  type WorkshopMembership,
  type WorkshopEntitlements,
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
 * RECONNAISSANCE SPECS for the by-ID workshop gate's missing entitlement branch.
 *
 * routes.test.ts already pins the P0-1/P1-3 gate thoroughly. What it does NOT pin is
 * what happens to a role that the LIST route admits and the BY-ID gate does not model:
 * the gate is ADMIN → owner → membership, with no entitlement branch, while
 * GET /v1/workshops resolves E(self) for JUDGE/EXECUTIVE/PARTICIPANT. That divergence
 * is the finding these specs exist to record, and it is not in the register.
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

class FakeWorkshops implements WorkshopRepository {
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

class FakeTeamAccess implements TeamAccess {
  constructor(
    private readonly reads = true,
    private readonly writes = true
  ) {}
  async canRead() {
    return this.reads;
  }
  async canWrite() {
    return this.writes;
  }
  async canReadContent() {
    return this.reads;
  }
  async canWriteContent() {
    return this.writes;
  }
}

class FakeMembership implements WorkshopMembership {
  calls: Array<{ workshopId: string; userId: string; role: string }> = [];
  constructor(private readonly answer: boolean | "unavailable" = false) {}
  async isMember(workshopId: string, userId: string, role: string) {
    this.calls.push({ workshopId, userId, role });
    return this.answer;
  }
}

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
  enabledAssistants: [],
  setupConfig: { repoUrl: "https://git.example/repo", guideUrl: "https://g" },
  startsAt: null,
  endsAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

function build(
  over: Partial<{
    workshops: FakeWorkshops;
    phases: FakePhases;
    teamPhases: FakeTeamPhases;
    formats: FakeFormats;
    stats: WorkshopStats;
    events: InMemoryPublisher;
    teamAccess: FakeTeamAccess;
    membership: WorkshopMembership;
    entitlements: WorkshopEntitlements;
  }> = {}
) {
  const deps = {
    workshops: over.workshops ?? new FakeWorkshops([workshop()]),
    phases: over.phases ?? new FakePhases([]),
    teamPhases: over.teamPhases ?? new FakeTeamPhases([]),
    formats: over.formats ?? new FakeFormats([]),
    stats: over.stats ?? new ZeroWorkshopStats(),
    events: over.events ?? new InMemoryPublisher(),
    teamAccess: over.teamAccess ?? new FakeTeamAccess(true, true),
    membership: over.membership ?? new NoWorkshopMembership(),
    entitlements: over.entitlements ?? new FakeEntitlements(),
  };
  return { app: createWorkshopRoutes(deps), deps };
}

// ════════════════════════════════════════════════════════════════════════════
// P0-1 / P1-3 — re-verified as FIXED, then the divergence nobody registered.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON P0-1/P1-3: the by-id gate is real, and NARROWER than the list", () => {
  const READ_ROUTES = [
    "/v1/workshops/w1",
    "/v1/workshops/w1/assistants",
    "/v1/workshops/w1/phases",
  ];

  it("FIXED: setupConfig no longer reaches a signed-in stranger on any of the three", async () => {
    // The P0-1 payload, named field by field: an unauthorized caller must see neither
    // the repo URL nor the guide URL nor the model id.
    for (const path of READ_ROUTES) {
      const { app } = build({ membership: new FakeMembership(false) });
      const res = await app.request(path, {
        headers: asUser({ id: "stranger", email: "s@example.com", role: "PARTICIPANT" }),
      });
      const raw = await res.text();
      expect(res.status, path).toBe(403);
      expect(raw, path).not.toContain("git.example");
      expect(raw, path).not.toContain("Workshop One");
      expect(raw, path).not.toContain("claude-sonnet");
    }
  });

  it("CLOSED (NEW-2): the LIST and the DETAIL route now AGREE for an entitled non-member", async () => {
    // ── WHAT THIS USED TO ASSERT ──
    //
    // Named "OPEN GAP: the LIST hands a JUDGE a workshop that the DETAIL route 403s", and it
    // passed: the list resolved E(self) while `requireWorkshopRead` gated
    // ADMIN → owner → MEMBERSHIP with no entitlement branch, so the list was WIDER than the
    // detail for exactly the role whose only route into a workshop is an invitation. Never a
    // leak (fail-closed), but a functional dead end — the workshop appeared in the list and
    // every click on it was Forbidden.
    //
    // ── WHY THE LIST MOVED AND NOT THE GATE ──
    //
    // The read matrix says "allow iff entitled" for BY ID, which would mean an entitlement branch
    // in the gate. That was REJECTED for now: it adds a second east-west hop to a route
    // the desktop calls three times during setup, with no circuit breaker anywhere in this
    // repo (an accepted-but-unmitigated risk). So the list is intersected with
    // membership instead, and the matrix is annotated as not-yet-implemented rather than
    // silently diverged from.
    //
    // ⚠ FLIPPED, EXACTLY AS THE NOTE BELOW INSTRUCTED. This spec used to assert the COST
    // of the narrowing — that an entitled non-member saw an EMPTY list — and said: "When a breaker
    // lands, add the gate branch and DELETE the list filter, not this spec: it should then flip back
    // to expecting `["w1"]` in BOTH places." It now expects `["w1"]` in both places.
    //
    // ⚠ AND IT LANDED WITHOUT A BREAKER, because the objection turned out not to apply to a JUDGE.
    // `team/src/routes.ts` enforces that a JUDGE may NEVER hold a team-membership row (400 on all
    // three write paths), so `isMember` was a guaranteed FALSE — the old code spent an east-west call
    // to learn a foregone conclusion, then 403'd. The entitlement branch SUBSTITUTES that hop rather
    // than adding one, and on the list it removes one call PER CANDIDATE WORKSHOP. Strictly less load.
    //
    // ⚠ NARROWED TO JUDGE. The filter still stands for EXECUTIVE and PARTICIPANT, whose entitlement
    // comes THROUGH membership — for them the probe is the real question and would be an extra hop.
    const workshops = new FakeWorkshops([workshop({ id: "w1", ownerId: "owner-1" })]);
    const entitlements = new FakeEntitlements({
      workshopIds: ["w1"],
      truncated: false,
    });
    // A JUDGE is never a team member, so the membership branch answers a definite false.
    const membership = new FakeMembership(false);
    const { app } = build({ workshops, entitlements, membership });

    const judge = asUser({ id: "judge-1", email: "j@example.com", role: "JUDGE" });

    // The workshop their invitation NAMED, listed — this is the bug's fix.
    const list = await app.request("/v1/workshops", { headers: judge });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { workshops: Workshop[] }).workshops.map((w) => w.id)
    ).toEqual(["w1"]);

    // And every read route OPENS. The agreement between list and detail is still the property this
    // spec exists to hold — it now holds at "both allow" instead of at "both refuse", which is the
    // only version of it that lets a judge do their job.
    for (const path of READ_ROUTES) {
      const res = await app.request(path, { headers: judge });
      expect(res.status, `${path} for an ENTITLED non-member judge`).toBe(200);
    }
  });

  it("a MEMBER still gets the workshop in BOTH the list and the detail — not narrowed to nothing", async () => {
    // The companion that stops the NEW-2 fix being "return an empty list always", which would
    // satisfy the agreement assertion above and break the product. Same entitlement, same
    // role, membership now TRUE.
    const workshops = new FakeWorkshops([workshop({ id: "w1", ownerId: "owner-1" })]);
    const entitlements = new FakeEntitlements({ workshopIds: ["w1"], truncated: false });
    const { app } = build({
      workshops,
      entitlements,
      membership: new FakeMembership(true),
    });

    const judge = asUser({ id: "judge-1", email: "j@example.com", role: "JUDGE" });

    const list = await app.request("/v1/workshops", { headers: judge });
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { workshops: Workshop[] }).workshops.map((w) => w.id)
    ).toEqual(["w1"]);

    for (const path of READ_ROUTES) {
      const res = await app.request(path, { headers: judge });
      expect(res.status, `${path} for a MEMBER judge`).toBe(200);
    }
  });

  /**
   * The central rule: "could not determine" must never be rendered as "you have none".
   *
   * ⚠ FOR A JUDGE THE UNDETERMINED SOURCE MOVED. This asserted a 503 from an unavailable MEMBERSHIP
   * probe, because the list used to filter judges on membership. It no longer probes membership for a
   * judge at all — the answer was a foregone false — so the hop that can now fail to answer is the
   * ENTITLEMENT one, and that is where the 503 must come from. The rule is unchanged; only which
   * dependency can be undetermined has.
   *
   * The membership case still matters for EXECUTIVE and PARTICIPANT and is asserted below.
   */
  it("an UNDETERMINED ENTITLEMENT probe is 503 for a judge, never a silently short list", async () => {
    const workshops = new FakeWorkshops([workshop({ id: "w1", ownerId: "owner-1" })]);
    const { app } = build({
      workshops,
      entitlements: new FakeEntitlements("unavailable"),
      membership: new FakeMembership(false),
    });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "judge-1", email: "j@example.com", role: "JUDGE" }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "ENTITLEMENTS_UNAVAILABLE",
    });
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  it("an UNDETERMINED membership probe is still 503 for an EXECUTIVE — the filter stands for them", async () => {
    // The narrowing was JUDGE-only. A DERIVED role's entitlement comes through membership, so an
    // unanswerable probe is still the thing that must not become an empty list.
    const workshops = new FakeWorkshops([workshop({ id: "w1", ownerId: "owner-1" })]);
    const { app } = build({
      workshops,
      entitlements: new FakeEntitlements({ workshopIds: ["w1"], truncated: false }),
      membership: new FakeMembership("unavailable"),
    });

    const res = await app.request("/v1/workshops", {
      headers: asUser({ id: "exec-1", email: "e@example.com", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "MEMBERSHIP_UNAVAILABLE",
    });
  });

  /**
   * ⚠ INVERTED. This asserted "the gate consults NO entitlement dependency — the branch does
   * not exist yet", proving the gap by absence at the seam. The branch now exists (the
   * "allow iff entitled" for the by-id read), so the same seam proves the opposite.
   */
  it("the gate CONSULTS the entitlement dependency for a judge — the branch exists", async () => {
    const entitlements = new FakeEntitlements({ workshopIds: ["w1"], truncated: false });
    const { app } = build({ entitlements, membership: new FakeMembership(false) });

    for (const path of READ_ROUTES) {
      await app.request(path, {
        headers: asUser({ id: "judge-1", email: "j@example.com", role: "JUDGE" }),
      });
    }

    expect(entitlements.calls).toBeGreaterThan(0);
  });

  it("the gate does NOT consult entitlements for an EXECUTIVE — membership is still their question", async () => {
    // The other half of "narrowed to JUDGE": for a DERIVED role this must remain one hop, not two.
    // If this ever starts calling entitlements, the extra-hop objection the JUDGE branch sidestepped
    // has quietly come true for everyone else.
    const entitlements = new FakeEntitlements({ workshopIds: ["w1"], truncated: false });
    const { app } = build({ entitlements, membership: new FakeMembership(false) });

    for (const path of READ_ROUTES) {
      await app.request(path, {
        headers: asUser({ id: "exec-1", email: "e@example.com", role: "EXECUTIVE" }),
      });
    }

    expect(entitlements.calls).toBe(0);
  });
});
