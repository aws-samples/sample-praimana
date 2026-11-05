import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createTeamRoutes } from "./routes.js";
import type {
  AdmitOutcome,
  AuditEntryRead,
  AuditEntryWrite,
  AuditRepository,
  Team,
  TeamMember,
  TeamMemberRepository,
  TeamRepository,
  Invitation,
  InvitationRepository,
  UserView,
  UsersReadModel,
} from "./domain.js";
import type { WorkshopAccess, WorkshopRef } from "./authz.js";

/**
 * ── INDEPENDENT ATTACK PASS ON `actorId` DISCLOSURE, GET /v1/audit/users/:userId ──
 *
 * A SECOND, ADVERSARIAL harness rather than an addition to routes.test.ts, deliberately: the
 * developer's own tests hand-pick the roles they drive (ADMIN caller / FACILITATOR caller, ADMIN
 * actor / FACILITATOR actor / one unknown string). The claim under test is stronger than that —
 * "canSeeUser fails closed for EVERY stored actorRole value, including ones no test enumerates" —
 * and a hand-picked list cannot refute a claim quantified over all values.
 *
 * So the matrix here is GENERATED: the caller axis and the actor axis are the SAME declared role
 * universe crossed with each other, plus a hostile axis of every shape a stored attribute can
 * actually take on a schemaless DynamoDB row. The expectation for each cell is computed from a
 * SEPARATE, INDEPENDENTLY WRITTEN copy of the visibility rule (see EXPECTED_VISIBLE), not from
 * the route's own table — a test that asks the implementation what the answer should be proves
 * only that the implementation is self-consistent.
 *
 * NO RANDOMNESS AND NO SLEEPS. Every case is a fixed literal, the matrix order is deterministic,
 * and FakeAudit's clock is a counter — so a failure is replayable from the test name alone.
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

/**
 * THE DECLARED ROLE UNIVERSE — ROLE_PRECEDENCE in apps/services/shared/src/edge-identity.ts:73,
 * which is the exhaustive set `collapseGroupsToRole` can ever produce from a verified token. Any
 * role outside this list reaches a route only over the trusted-internal-hop path, which is the
 * hostile axis below.
 */
const ALL_ROLES = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
  "EXECUTIVE",
  "PARTICIPANT",
] as const;

/**
 * AN INDEPENDENT RESTATEMENT of USER_VISIBILITY_GRANTS (routes.ts:230), written from the ADR-level
 * rule and not copied from the source: an ADMIN may know about everyone, a FACILITATOR about
 * everyone EXCEPT an ADMIN, and nobody else about anyone. If the route's table is edited, this
 * disagrees and the matrix fails — which is the point of not sharing the constant.
 */
const EXPECTED_VISIBLE: Record<string, readonly string[]> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: [],
  JUDGE: [],
  PARTICIPANT: [],
};

/** The roles `canReadDirectory` (routes.ts:199) admits to the route at all. */
const DIRECTORY_ROLES = ["ADMIN", "FACILITATOR"];

/**
 * EVERY SHAPE A STORED `actorRole` CAN TAKE THAT IS NOT ONE OF THE FIVE.
 *
 * The audit table is schemaless and APPEND-ONLY, so none of these can be excluded by argument
 * from the write path: a row written by an older deploy, a role retired since, a hand-written
 * row, or a marshalled attribute of the wrong type is permanent once stored. Each must withhold
 * the sub, and the DIRECTION of that default is the assertion.
 *
 * The `__proto__`/`constructor`/`toString` group is here because USER_VISIBILITY_GRANTS is a
 * bare object literal, so a lookup by one of those keys does NOT miss — it reaches
 * Object.prototype. That is the one family where "unrecognised" and "absent from the table" are
 * different things, and it is exactly the kind of value no hand-picked test enumerates.
 */
const HOSTILE_ROLE_VALUES: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ["absent (key never written)", Symbol.for("OMIT")],
  ["undefined", undefined],
  ["null", null],
  ["empty string", ""],
  ["single space", " "],
  ["wrong case: admin", "admin"],
  ["wrong case: Admin", "Admin"],
  ["wrong case: aDmIn", "aDmIn"],
  ["leading space: ' ADMIN'", " ADMIN"],
  ["trailing space: 'ADMIN '", "ADMIN "],
  ["padded: '  ADMIN  '", "  ADMIN  "],
  ["tab-padded: '\\tADMIN'", "\tADMIN"],
  ["newline-suffixed: 'ADMIN\\n'", "ADMIN\n"],
  ["NUL-suffixed: 'ADMIN\\0'", "ADMIN\u0000"],
  ["unknown string", "SUPERUSER_FROM_THE_FUTURE"],
  ["retired role: TEAM_CONTENT_VIEWER", "TEAM_CONTENT_VIEWER"],
  ["retired role: OWNER", "OWNER"],
  ["substring of a real role", "ADMI"],
  ["superstring of a real role", "ADMINISTRATOR"],
  ["role list as string", "[ADMIN PARTICIPANT]"],
  ["comma list", "ADMIN,FACILITATOR"],
  ["prototype key: __proto__", "__proto__"],
  ["prototype key: constructor", "constructor"],
  ["prototype key: toString", "toString"],
  ["prototype key: hasOwnProperty", "hasOwnProperty"],
  ["prototype key: valueOf", "valueOf"],
  ["prototype key: prototype", "prototype"],
  ["number 0", 0],
  ["number 1", 1],
  ["boolean true", true],
  ["boolean false", false],
  ["array of a real role", ["ADMIN"]],
  ["object", { role: "ADMIN" }],
  ["empty object", {}],
  ["NaN", Number.NaN],
];

const OMIT = Symbol.for("OMIT");

/** THE SUB UNDER ATTACK. A distinctive literal so a raw-text scan cannot match by accident. */
const ADMIN_SUB = "cognito-sub-of-the-only-admin-a1b2c3";

// ─── Fakes (mirroring routes.test.ts, so behaviour is comparable) ────────────

class FakeAudit implements AuditRepository {
  readonly entries: AuditEntryRead[] = [];
  private tick = 0;
  async record(entry: AuditEntryWrite) {
    const occurredAt = new Date(Date.UTC(2026, 7, 4, 0, 0, ++this.tick)).toISOString();
    this.entries.push({ ...entry, occurredAt, at: `${occurredAt}#${this.tick}` });
    return true;
  }
  async listBySubject(subjectId: string, limit = 50) {
    return this.entries
      .filter((e) => e.subjectId === subjectId)
      .reverse()
      .slice(0, limit);
  }
  async listByTeam(teamId: string, limit = 50) {
    return this.entries
      .filter((e) => e.teamId === teamId)
      .reverse()
      .slice(0, limit);
  }
}

/**
 * WRITES THE ROW DIRECTLY, bypassing `record`'s typing.
 *
 * Necessary and not a cheat: the attack surface is what the STORE can hand the route, and a
 * DynamoDB item is not constrained by AuditEntryWrite. `actorRole` absent entirely (rather than
 * present-and-undefined) is only expressible this way, and it is the case for every row written
 * before the field existed.
 */
function storeRawEntry(
  audit: FakeAudit,
  over: Record<string, unknown>,
  tick: number
): void {
  const occurredAt = new Date(Date.UTC(2026, 7, 4, 0, 0, tick)).toISOString();
  audit.entries.push({
    subjectId: "victim",
    action: "MEMBER_REMOVED",
    actorId: ADMIN_SUB,
    /**
     * ⚠ `teamId` IS PART OF THE BASE SHAPE SO THESE ROWS SURVIVE THE OWNERSHIP SCOPE. The trail is now
     * scoped per entry, and a row with no resolvable team is withheld — so a hostile row written
     * without one would vanish before the projection ever ran, and every assertion here about how the
     * projection HANDLES it would pass vacuously against an empty response. `over` can still override
     * it to exercise the unscopeable case deliberately.
     */
    teamId: "t1",
    occurredAt,
    at: `${occurredAt}#${tick}`,
    ...over,
  } as unknown as AuditEntryRead);
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
    const row = this.rows.find(
      (m) => m.teamId === teamId && m.userId === userId && m.status !== "INACTIVE"
    );
    return row ?? null;
  }
  async getIncludingInactive(teamId: string, userId: string) {
    return this.rows.find((m) => m.teamId === teamId && m.userId === userId) ?? null;
  }
  async listByTeam(teamId: string) {
    return this.rows.filter((m) => m.teamId === teamId && m.status !== "INACTIVE");
  }
  async listByTeamIncludingInactive(teamId: string) {
    return this.rows.filter((m) => m.teamId === teamId);
  }
  async listByUser(userId: string) {
    return this.rows.filter((m) => m.userId === userId && m.status !== "INACTIVE");
  }
  async put(member: TeamMember) {
    this.rows.push(member);
    return member;
  }
  async remove() {
    return true;
  }
  async deactivate() {
    return true;
  }
  async reactivate(): Promise<AdmitOutcome> {
    return "admitted";
  }
}

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
  async getByInviteCode(code: string) {
    return this.rows.find((t) => t.inviteCode === code) ?? null;
  }
  async listByWorkshop(workshopId: string) {
    return this.rows.filter((t) => t.workshopId === workshopId);
  }
  async put(team: Team) {
    this.rows.push(team);
    return team;
  }
  async listDirectory() {
    return { teams: [] as Team[] };
  }
}

class FakeInvitations implements InvitationRepository {
  constructor(readonly rows: Invitation[] = []) {}
  async get() {
    return null;
  }
  async getByTokenHash() {
    return null;
  }
  async listByEmail() {
    return [];
  }
  async listByTeam() {
    return [];
  }
  async put(inv: Invitation) {
    this.rows.push(inv);
    return inv;
  }
  async markAccepted() {
    return true;
  }
  async accept() {
    return true;
  }
  async revoke() {
    return true;
  }
  async markRevoked() {
    return true;
  }
  /** Unreached here — no test in this file drives the entitlement-withdrawal route. */
  async clearWorkshop() {
    return true;
  }
  async delete() {
    return true;
  }
}

class FakeUsers implements UsersReadModel {
  /**
   * COUNTS EVERY LOOKUP. Load-bearing for the "no read-model fan-out" assertion: an empty fake
   * would pass even if the route DID resolve names, because every lookup would answer null.
   */
  gets = 0;
  constructor(readonly rows: UserView[] = []) {}
  async get(id: string) {
    this.gets += 1;
    return this.rows.find((u) => u.id === id) ?? null;
  }
  async upsert(item: UserView) {
    this.rows.push(item);
  }
  async delete(id: string) {
    const i = this.rows.findIndex((u) => u.id === id);
    if (i >= 0) this.rows.splice(i, 1);
  }
}

class FakeWorkshops implements WorkshopAccess {
  /** The workshop's team-size template. Not exercised by this file. */
  async teamSeatTemplate(): Promise<number | "unavailable" | "invalid"> {
    return 10;
  }
  /**
   * TRUE, matching this harness's stated premise that the caller OWNS w1 (see build below).
   *
   * ⚠ IT HAD TO BECOME TRUE ON 2026-08-23, when member removal stopped being gated on
   * `requireTeamWrite` and became `requireTeamAdministration` — staff AND workshop ownership,
   * with no membership branch. The corpus case below drives the shipped DELETE route to
   * exercise the reason normaliser, and it previously passed the guard through its
   * FACILITATOR's MEMBERSHIP ROW, which requirement (b) says staff may never hold in
   * the first place. Ownership is the honest way for that caller to get in.
   */
  async ownsTeamWorkshop() {
    return true;
  }
  async ownsWorkshop() {
    return false;
  }
  async listOwnedWorkshopIds(): Promise<readonly string[]> {
    return [];
  }
  async getWorkshop(): Promise<WorkshopRef | null> {
    return null;
  }
}

/**
 * ⚠ THE CALLER OWNS w1, AND THE HARNESS NOW HAS A TEAM IN IT — REQUIRED SINCE THE TRAIL BECAME
 * OWNERSHIP-SCOPED.
 *
 * Every entry this file records is `teamId: "t1"` (a MEMBER_REMOVED), and the route now returns a
 * team-scoped entry only when the caller owns that team's experience. Without a resolvable team AND an
 * owned workshop, every cell of the matrix below would receive an EMPTY trail — and the `sub WITHHELD`
 * half of the matrix WOULD STILL PASS, vacuously, because a sub that was never returned is trivially
 * absent. The `sub DISCLOSED` half is what fails loudly, which is how this was caught.
 *
 * ⚠ AND THE OLD STUB WAS MISNAMED, WHICH `as never` HID. It defined `listOwnedWorkshopIds`; the port's
 * method is `listOwnedWorkshops`. The cast meant TypeScript never checked the shape, so the object
 * satisfied nothing and the route saw `undefined` for the method it calls. Named correctly here, and
 * returning `WorkshopRef[]` as the real port does.
 */
function build(over: { audit?: AuditRepository; users?: FakeUsers; members?: FakeMembers } = {}) {
  const deps = {
    teams: new FakeTeams([
      { id: "t1", workshopId: "w1", name: "Team One", inviteCode: "CODE1234" } as Team,
    ]),
    members: over.members ?? new FakeMembers([]),
    invitations: new FakeInvitations([]),
    users: over.users ?? new FakeUsers([]),
    workshops: new FakeWorkshops(),
    events: new InMemoryPublisher(),
    audit: over.audit ?? new FakeAudit(),
    workshopDirectory: {
      async listOwnedWorkshops(): Promise<WorkshopRef[]> {
        return [{ id: "w1", name: "Workshop One" }];
      },
    },
  };
  return { app: createTeamRoutes(deps as never), deps };
}

// ─── 1. THE GENERATED CALLER × ACTOR MATRIX ─────────────────────────────────

describe("ATTACK: the full caller x actor visibility matrix on GET /v1/audit/users/:userId", () => {
  /**
   * EVERY DECLARED ROLE AS CALLER, CROSSED WITH EVERY DECLARED ROLE AS THE STORED actorRole.
   *
   * 25 cells, none hand-picked. Each asserts BOTH directions, because over-suppression is also a
   * defect: a fix that hid `actorId` from everyone would break the trail's whole purpose, and a
   * test that only checked "the facilitator cannot see it" would pass against that.
   *
   * The three non-directory roles are refused at the gate before the projection runs, and their
   * cells assert 403 WITH NO BODY DISCLOSURE — a 403 that leaked the sub in an error string
   * would be the same defect wearing a different status code.
   */
  for (const callerRole of ALL_ROLES) {
    for (const actorRole of ALL_ROLES) {
      const admitted = DIRECTORY_ROLES.includes(callerRole);
      const shouldSee =
        admitted && (EXPECTED_VISIBLE[callerRole] ?? []).includes(actorRole);

      it(`caller ${callerRole} / actor ${actorRole}: ${
        !admitted ? "403 at the gate" : shouldSee ? "sub DISCLOSED" : "sub WITHHELD"
      }`, async () => {
        const audit = new FakeAudit();
        await audit.record({
          subjectId: "victim",
          action: "MEMBER_REMOVED",
          actorId: ADMIN_SUB,
          actorRole,
          teamId: "t1",
        });
        const { app } = build({ audit });

        const res = await app.request("/v1/audit/users/victim", {
          headers: asUser({ id: "caller", email: "c@example.com", role: callerRole }),
        });

        if (!admitted) {
          expect(res.status).toBe(403);
          // The refusal must not disclose what it refused.
          expect(await res.text()).not.toContain(ADMIN_SUB);
          return;
        }

        expect(res.status).toBe(200);
        // RAW TEXT FIRST: the sub must not appear under ANY key or nesting. `entry.actorId ===
        // undefined` would pass even if the value were echoed somewhere else in the payload.
        const text = await res.clone().text();
        const entries = (await res.json()).entries as Array<Record<string, unknown>>;

        if (shouldSee) {
          expect(text).toContain(ADMIN_SUB);
          expect(entries[0].actorId).toBe(ADMIN_SUB);
        } else {
          expect(text).not.toContain(ADMIN_SUB);
          // ABSENT KEY, not present-and-undefined. Three independent probes, because a
          // present-but-undefined key serialises away yet still discloses that something is
          // being withheld — and `=== undefined` cannot tell the two apart.
          expect("actorId" in entries[0]).toBe(false);
          expect(Object.keys(entries[0])).not.toContain("actorId");
          expect(Object.prototype.hasOwnProperty.call(entries[0], "actorId")).toBe(false);
        }

        // NEVER GATED, in either branch: "performed by an Admin" names no account, and an entry
        // that refuses to say by whom in any form is not a trail.
        expect(entries[0].actorRole).toBe(actorRole);
      });
    }
  }
});

// ─── 2. HOSTILE STORED actorRole — THE DEFAULT'S DIRECTION ──────────────────

describe("ATTACK: an unrecognised stored actorRole must WITHHOLD, for every caller", () => {
  /**
   * THE CLAIM UNDER REFUTATION: `canSeeUser` fails closed for every stored `actorRole`, including
   * values no test enumerates. Driven for BOTH admitted callers, because the direction of the
   * default is the property — not who is asking. An ADMIN sees every DECLARED role, so if the
   * default leaked, the ADMIN row is where it would look correct.
   */
  for (const [label, value] of HOSTILE_ROLE_VALUES) {
    for (const callerRole of DIRECTORY_ROLES) {
      it(`caller ${callerRole} / stored actorRole = ${label}: sub WITHHELD`, async () => {
        const audit = new FakeAudit();
        storeRawEntry(
          audit,
          value === OMIT ? { teamId: "t1" } : { actorRole: value, teamId: "t1" },
          1
        );
        const { app } = build({ audit });

        const res = await app.request("/v1/audit/users/victim", {
          headers: asUser({ id: "caller", email: "c@example.com", role: callerRole }),
        });

        // A 500 would ALSO withhold, but it is not the contract: the trail must remain readable
        // when one row is malformed, or a single bad row denies the whole investigation.
        expect(res.status, label).toBe(200);

        const text = await res.clone().text();
        expect(text, label).not.toContain(ADMIN_SUB);

        const entries = (await res.json()).entries as Array<Record<string, unknown>>;
        expect(entries, label).toHaveLength(1);
        expect("actorId" in entries[0], label).toBe(false);
        expect(Object.keys(entries[0]), label).not.toContain("actorId");
      });
    }
  }
});

// ─── 3. HOSTILE CALLER ROLE ─────────────────────────────────────────────────

describe("ATTACK: an unrecognised CALLER role cannot reach the projection at all", () => {
  /**
   * THE OTHER AXIS OF THE SAME CLAIM. `canReadDirectory` is a `Set.has` on exact strings, so
   * every one of these is refused BEFORE `canSeeUser` is consulted — which is what makes the
   * prototype-key family unreachable on THIS route. Pinned so that widening the gate (or
   * replacing the Set with a looser check) fails here rather than in production.
   *
   * A hostile role is only presentable over the trusted-internal-hop path in the first place
   * (`collapseGroupsToRole` can only ever emit one of the five), so this is defence in depth on
   * top of a control that already holds. Pinned anyway: that is what defence in depth is.
   */
  const HOSTILE_CALLERS = [
    "admin",
    "Admin",
    "aDmIn",
    "ADMINISTRATOR",
    "ADMI",
    "[ADMIN]",
    "ADMIN,FACILITATOR",
    "ADMIN FACILITATOR",
    "SUPERUSER_FROM_THE_FUTURE",
    "TEAM_CONTENT_VIEWER",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "prototype",
    "propertyIsEnumerable",
    "isPrototypeOf",
    "0",
    "true",
    /**
     * REACHABLE non-ASCII padding. U+00A0 NBSP and U+00E9 are <= U+00FF so they encode into a
     * header ByteString fine, and unlike ASCII whitespace they are NOT trimmed — so these DO
     * arrive at the gate as distinct strings and must be refused. Measured, not assumed: the
     * arriving code points are 41 44 4d 49 4e a0, i.e. "ADMIN" plus an NBSP.
     */
    "ADMIN\u00A0",
    "\u00A0ADMIN",
    "ADMIN\u00E9",
  ];

  for (const role of HOSTILE_CALLERS) {
    it(`caller role ${JSON.stringify(role)} is refused 403 and discloses nothing`, async () => {
      const audit = new FakeAudit();
      await audit.record({
        subjectId: "victim",
        action: "MEMBER_REMOVED",
        actorId: ADMIN_SUB,
        actorRole: "ADMIN",
        teamId: "t1",
      });
      const { app } = build({ audit });

      const res = await app.request("/v1/audit/users/victim", {
        headers: asUser({ id: "caller", email: "c@example.com", role }),
      });

      // 403, NOT 500: the gate refuses before anything can throw on a prototype-chain lookup.
      expect(res.status, JSON.stringify(role)).toBe(403);
      expect(await res.text(), JSON.stringify(role)).not.toContain(ADMIN_SUB);
    });
  }

  /**
   * ── WHY ASCII-WHITESPACE-PADDED ROLES ARE ABSENT FROM THE LIST ABOVE ──
   *
   * MEASURED, NOT ASSUMED, and it cost four false failures on the first run of this file. An
   * HTTP header VALUE is trimmed of leading/trailing ASCII whitespace by the transport itself
   * (per RFC 9110 field-value parsing; `Headers` implements it), so `" ADMIN"`, `"ADMIN "`,
   * `"\tADMIN"` and `"ADMIN\n"` all ARRIVE at the route as exactly `"ADMIN"`. They are not a
   * bypass — the caller genuinely IS an ADMIN by the time any code sees the value, and asserting
   * 403 for them would be asserting a behaviour the stack cannot produce.
   *
   * A NUL-suffixed value is refused by `Headers.append` outright and never becomes a request, and
   * anything above U+00FF cannot be encoded into a header ByteString — see the unreachable-values
   * test below. U+00A0 NBSP is the interesting middle case: it DOES encode and is NOT trimmed, so
   * it reaches the gate and is refused there, which is why it sits in HOSTILE_CALLERS above.
   *
   * This test asserts the normalisation directly so the reasoning is checkable rather than a
   * comment nobody can verify.
   */
  it("ASCII-whitespace padding is normalised by the TRANSPORT, so it is a real ADMIN", async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      actorId: ADMIN_SUB, actorRole: "ADMIN", teamId: "t1",
    });
    const { app } = build({ audit });

    for (const padded of [" ADMIN", "ADMIN ", "  ADMIN  ", "\tADMIN", "ADMIN\n", "ADMIN\r\n"]) {
      const res = await app.request("/v1/audit/users/victim", {
        headers: asUser({ id: "caller", email: "c@example.com", role: padded }),
      });
      // 200 because the value arrived as "ADMIN" — the gate saw no padding at all.
      expect(res.status, JSON.stringify(padded)).toBe(200);
      const entries = (await res.json()).entries as Array<Record<string, unknown>>;
      // And an ADMIN legitimately sees an ADMIN actor's sub, so this is not a leak.
      expect(entries[0].actorId, JSON.stringify(padded)).toBe(ADMIN_SUB);
    }
  });

  /**
   * ── VALUES THAT CANNOT BE EXPRESSED AS A HEADER AT ALL ──
   *
   * A NUL is an invalid header value, and any code point ABOVE U+00FF cannot be encoded into a
   * header's ByteString. Both are refused SYNCHRONOUSLY by the transport, before any routing, so a
   * test asserting 403 for them would assert a response the stack never produces.
   *
   * THE BOUND IS EXACTLY U+00FF, and that is why NBSP is in the 403 matrix above and a zero-width
   * space is here: U+00A0 encodes and arrives untrimmed (refused by the gate, correctly), while
   * U+200B cannot be expressed at all. Measured on this runtime, not reasoned about.
   *
   * Pinned as a THROW rather than dropped from the matrix, because "unreachable" is a claim about
   * the TRANSPORT that should fail loudly if a future transport stops enforcing it — at which point
   * these values become reachable and belong in HOSTILE_CALLERS above.
   */
  it("NUL and non-Latin-1 role values cannot be expressed as a header at all", () => {
    const { app } = build();
    for (const unreachable of [
      "ADMIN\u0000", // invalid header value
      "ADMIN\u200B", // > U+00FF, not encodable as a ByteString
      "ADMIN\u{1F600}",
    ]) {
      expect(
        () =>
          app.request("/v1/audit/users/victim", {
            headers: asUser({ id: "caller", email: "c@example.com", role: unreachable }),
          }),
        JSON.stringify(unreachable)
      ).toThrow(TypeError);
    }
  });
});

// ─── 4. GATE-BYPASS ATTEMPTS ────────────────────────────────────────────────

describe("ATTACK: recovering the withheld sub by another route on the same surface", () => {
  const seedAdminActed = async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      teamId: "t1",
      actorId: ADMIN_SUB,
      actorRole: "ADMIN",
      reason: "left the programme",
    });
    return audit;
  };

  const facilitator = asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" });

  /**
   * EVERY `limit` VALUE AT AND AROUND THE BOUND, including the ones that are not numbers.
   *
   * The route coerces with `Number()` and passes the value through only when `Number.isFinite`,
   * so `NaN`/`Infinity`/absent fall through to the store's own default and everything else is
   * clamped into [1, 100] by clampAuditLimit. None of that is a disclosure path — but a
   * pagination bound is where an off-by-one turns into "the row you were not shown", so the
   * suppression is asserted at each one rather than assumed to be limit-independent.
   */
  const LIMITS = [
    "", "?limit=0", "?limit=-1", "?limit=1", "?limit=NaN", "?limit=1e9",
    "?limit=100", "?limit=101", "?limit=", "?limit=Infinity", "?limit=-Infinity",
    "?limit=1.5", "?limit=0x64", "?limit=9007199254740993", "?limit=-0",
    "?limit=1&limit=500", "?limit=500&limit=1", "?LIMIT=500", "?limit[]=5",
    "?limit=100&offset=0", "?limit=abc",
  ];

  for (const q of LIMITS) {
    it(`limit ${q || "<absent>"} does not restore the withheld sub`, async () => {
      const audit = await seedAdminActed();
      const { app } = build({ audit });
      const res = await app.request(`/v1/audit/users/victim${q}`, { headers: facilitator });
      expect(res.status, q).toBe(200);
      const text = await res.clone().text();
      expect(text, q).not.toContain(ADMIN_SUB);
      const entries = (await res.json()).entries as Array<Record<string, unknown>>;
      for (const e of entries) expect("actorId" in e, q).toBe(false);
    });
  }

  it("a subject who is THEMSELVES the operator does not disclose that operator's sub", async () => {
    // The obvious sweep: ask for the trail OF an admin rather than the trail of a victim an
    // admin acted on. `subjectId` is disclosed unconditionally (it is the key the caller
    // already supplied), so this is only an escalation if the ACTOR side leaks too.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: ADMIN_SUB,
      action: "MEMBER_REMOVED",
      teamId: "t1",
      actorId: "another-admin-sub-d4e5f6",
      actorRole: "ADMIN",
    });
    const { app } = build({ audit });

    const res = await app.request(`/v1/audit/users/${ADMIN_SUB}`, { headers: facilitator });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    // The subject id round-trips — the caller supplied it, so it discloses nothing new.
    expect(text).toContain(ADMIN_SUB);
    // The ACTOR's sub does not.
    expect(text).not.toContain("another-admin-sub-d4e5f6");
    const entries = (await res.json()).entries as Array<Record<string, unknown>>;
    expect("actorId" in entries[0]).toBe(false);
  });

  it("querying one's OWN trail does not disclose the admin who acted on you", async () => {
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "fac",
      action: "MEMBER_REMOVED",
      teamId: "t1",
      actorId: ADMIN_SUB,
      actorRole: "ADMIN",
    });
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/fac", { headers: facilitator });
    expect(res.status).toBe(200);
    expect(await res.clone().text()).not.toContain(ADMIN_SUB);
  });

  it("a percent-encoded subject id does not change the projection", async () => {
    // Path-encoded ids reach a DIFFERENT param value; the projection must not depend on how the
    // key was spelled. Asserted for both an id that decodes to the seeded subject and one that
    // does not (which must be an empty trail, never a 500).
    const audit = await seedAdminActed();
    const { app } = build({ audit });
    for (const path of ["/v1/audit/users/victim", "/v1/audit/users/%76ictim", "/v1/audit/users/vic%74im"]) {
      const res = await app.request(path, { headers: facilitator });
      expect(res.status, path).toBe(200);
      expect(await res.clone().text(), path).not.toContain(ADMIN_SUB);
    }
  });

  it("an unknown subject yields an EMPTY trail, not an error naming anything", async () => {
    const audit = await seedAdminActed();
    const { app } = build({ audit });
    for (const id of ["nobody", "", "..", "%2e%2e", "*", "victim'", '{"$ne":null}']) {
      const res = await app.request(`/v1/audit/users/${encodeURIComponent(id) || "x"}`, {
        headers: facilitator,
      });
      expect([200, 404], JSON.stringify(id)).toContain(res.status);
      expect(await res.text(), JSON.stringify(id)).not.toContain(ADMIN_SUB);
    }
  });

  it("headers cannot re-open the gate: no override header promotes a FACILITATOR", async () => {
    // The identity is read from the VERIFIED hop only. Pinned so a future convenience header
    // (an impersonation switch, a debug flag) cannot silently become a disclosure path.
    const audit = await seedAdminActed();
    const { app } = build({ audit });
    // Typed as a uniform Record so the union of literal shapes does not collapse to `undefined`
    // members, which is what TS infers from a heterogeneous array of object literals.
    const overrides: ReadonlyArray<Record<string, string>> = [
      { "x-identity-role-override": "ADMIN" },
      { "x-admin": "true" },
      { "x-debug": "1" },
      { "x-forwarded-role": "ADMIN" },
      { "x-include-actor-id": "true" },
      { "x-fields": "actorId" },
      { accept: "application/json; fields=actorId" },
    ];
    for (const extra of overrides) {
      const res = await app.request("/v1/audit/users/victim", {
        headers: { ...facilitator, ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(200);
      expect(await res.text(), JSON.stringify(extra)).not.toContain(ADMIN_SUB);
    }
  });

  it("a DUPLICATED x-identity-role header cannot smuggle ADMIN past the gate", async () => {
    // Hono joins repeated headers with ", ", so the role becomes "FACILITATOR, ADMIN" — which is
    // not in the directory Set at all. Asserted as a 403 rather than as a disclosure.
    const audit = await seedAdminActed();
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/victim", {
      headers: [
        ["x-internal-token", INTERNAL_TOKEN],
        ["x-identity-id", "fac"],
        ["x-identity-role", "FACILITATOR"],
        ["x-identity-role", "ADMIN"],
      ],
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(ADMIN_SUB);
  });

  it("NO read-model lookup is made, so the sub cannot leak as a resolved NAME", async () => {
    // The route resolves no names by design. A COUNTING read-model, because an empty one would
    // pass even if the route did fan out. If a future edit adds resolution without adding the
    // visibility gate, the admin's NAME becomes the disclosure instead of their sub.
    const audit = await seedAdminActed();
    const users = new FakeUsers([
      { id: ADMIN_SUB, name: "The Only Admin", email: "admin@example.com" },
      { id: "victim", name: "A Victim", email: "v@example.com" },
    ]);
    const { app } = build({ audit, users });
    const res = await app.request("/v1/audit/users/victim", { headers: facilitator });
    expect(res.status).toBe(200);
    expect(users.gets).toBe(0);
    const text = await res.text();
    expect(text).not.toContain("The Only Admin");
    expect(text).not.toContain("admin@example.com");
    expect(text).not.toContain(ADMIN_SUB);
  });

  it("a stored attribute nobody enumerated cannot ride out on the response", async () => {
    // The row is built field by field precisely so this fails. Two extra attributes: a
    // plausible future field, and a SECOND copy of the actor's sub under another name — which is
    // how the suppression would be defeated in practice if the projection ever went back to a
    // spread.
    const audit = new FakeAudit();
    storeRawEntry(audit, {
      actorRole: "ADMIN",
      actorSub: ADMIN_SUB,
      actorEmail: "admin@example.com",
      performedBy: ADMIN_SUB,
      ipAddress: "10.0.0.1",
    }, 1);
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/victim", { headers: facilitator });
    const text = await res.clone().text();
    expect(text).not.toContain(ADMIN_SUB);
    expect(text).not.toContain("admin@example.com");
    expect(text).not.toContain("10.0.0.1");
    const keys = Object.keys((await res.json()).entries[0]);
    // `teamId` is present because `storeRawEntry` now writes one — required for the row to survive the
    // ownership scope at all (see its note). The point of THIS assertion is unchanged and is the rest
    // of the list: `actorSub`, `actorEmail`, `performedBy` and `ipAddress` were all stored on the row
    // and NONE of them reaches the response, because the projection enumerates its fields.
    expect(keys.sort()).toEqual([
      "action", "actorRole", "at", "occurredAt", "subjectId", "teamId",
    ]);
  });

  it("ONE hostile row does not suppress a LEGITIMATELY VISIBLE row in the same response", async () => {
    // OVER-SUPPRESSION IS A DEFECT TOO. The gate is per-entry, so a malformed row must not take
    // the rest of the trail down with it — an investigation reading a mixed page needs the rows
    // it is entitled to.
    const audit = new FakeAudit();
    storeRawEntry(audit, { actorRole: "__proto__" }, 1);
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: "fac-sub-visible",
      actorRole: "FACILITATOR",
      teamId: "t1",
    });
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/victim", { headers: facilitator });
    expect(res.status).toBe(200);
    const entries = (await res.json()).entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    // Newest first: the FACILITATOR row, which this caller MAY see.
    expect(entries[0].actorId).toBe("fac-sub-visible");
    expect("actorId" in entries[1]).toBe(false);
  });
});

// ─── 5. OVER-SUPPRESSION ────────────────────────────────────────────────────

describe("ATTACK: over-suppression — the trail must stay usable", () => {
  it("an ADMIN reading an ADMIN's action still gets the sub", async () => {
    // If this fails, the fix broke the audit trail: correlating which operator acted is the
    // whole reason the field is stored.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      teamId: "t1",
      actorId: ADMIN_SUB,
      actorRole: "ADMIN",
    });
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "admin2", email: "a@example.com", role: "ADMIN" }),
    });
    const entries = (await res.json()).entries as Array<Record<string, unknown>>;
    expect(entries[0].actorId).toBe(ADMIN_SUB);
    expect(entries[0].actorRole).toBe("ADMIN");
  });

  it("actorRole is disclosed for EVERY declared role and EVERY admitted caller", async () => {
    // `actorRole` must never be gated — 10 cells, asserted independently of the actorId matrix
    // so a fix that suppressed the role as collateral fails HERE with a clear name.
    for (const callerRole of DIRECTORY_ROLES) {
      for (const actorRole of ALL_ROLES) {
        const audit = new FakeAudit();
        await audit.record({
          subjectId: "victim",
          action: "MEMBER_REMOVED",
          actorId: ADMIN_SUB,
          actorRole,
          teamId: "t1",
        });
        const { app } = build({ audit });
        const res = await app.request("/v1/audit/users/victim", {
          headers: asUser({ id: "caller", email: "c@example.com", role: callerRole }),
        });
        const entries = (await res.json()).entries as Array<Record<string, unknown>>;
        expect(entries[0].actorRole, `${callerRole}/${actorRole}`).toBe(actorRole);
      }
    }
  });

  it("the non-identity fields survive the projection unchanged", async () => {
    // A suppression, not a mangling: every other field an investigation reads must be intact and
    // byte-equal to what was stored.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim",
      action: "MEMBER_REMOVED",
      actorId: ADMIN_SUB,
      actorRole: "ADMIN",
      teamId: "t1",
      teamName: "5 Stars",
      reason: "left the programme",
      joinedAt: "2026-08-02T00:00:00.000Z",
    });
    const stored = (audit as FakeAudit).entries[0];
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });
    const entry = (await res.json()).entries[0] as Record<string, unknown>;
    expect(entry).toEqual({
      subjectId: "victim",
      at: stored.at,
      occurredAt: stored.occurredAt,
      action: "MEMBER_REMOVED",
      actorRole: "ADMIN",
      teamId: "t1",
      teamName: "5 Stars",
      reason: "left the programme",
      joinedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  it("repeated identical requests are byte-stable — the gate has no per-call state", async () => {
    // The projection is pure, but the regex it shares module scope with carries the `g` flag; a
    // stateful helper would make the SECOND read of the same trail differ from the first. Ten
    // iterations, deterministic, no sleeps.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      actorId: ADMIN_SUB, actorRole: "ADMIN", reason: "one\ntwo", teamId: "t1",
    });
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      actorId: "fac-sub", actorRole: "FACILITATOR", teamId: "t1",
    });
    const { app } = build({ audit });
    const bodies: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request("/v1/audit/users/victim", {
        headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
      });
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain(ADMIN_SUB);
  });

  it("CONCURRENT reads by an ADMIN and a FACILITATOR do not cross-contaminate", async () => {
    // The two callers share the module-scoped grants table and the same route closure. Issued as
    // one interleaved batch, resolved together: the ADMIN must get the sub and the FACILITATOR
    // must not, in the same tick. Fixed interleaving, no randomness.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      teamId: "t1",
      actorId: ADMIN_SUB, actorRole: "ADMIN",
    });
    const { app } = build({ audit });
    const calls = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0
        ? { role: "ADMIN", expect: true }
        : { role: "FACILITATOR", expect: false }
    );
    const results = await Promise.all(
      calls.map(async (call) => {
        const res = await app.request("/v1/audit/users/victim", {
          headers: asUser({ id: "caller", email: "c@example.com", role: call.role }),
        });
        return { call, text: await res.text() };
      })
    );
    for (const { call, text } of results) {
      expect(text.includes(ADMIN_SUB), call.role).toBe(call.expect);
    }
  });
});

// ─── 5b. TRUE ABSENCE, ASSERTED WHERE IT IS ACTUALLY OBSERVABLE ─────────────

describe("ATTACK: omitted vs present-but-undefined — the distinction JSON hides", () => {
  /**
   * ── A VACUOUS ASSERTION CLASS, IDENTIFIED BY MUTATION TESTING ──
   *
   * MUTATION M4 replaced the spread-or-omit with:
   *
   *     actorId: canSeeUser(callerRole, entry.actorRole) ? entry.actorId : undefined,
   *
   * ...and EVERY `"actorId" in entry === false` assertion still passed — mine and the developer's
   * alike, including one asserted three separate ways (`in`, `Object.keys`, `hasOwnProperty`).
   *
   * WHY. All of them read the body back through JSON, and `JSON.stringify` DROPS an
   * undefined-valued key. The route's ONLY egress is a JSON response, so the omitted shape and the
   * present-but-undefined shape are BYTE-IDENTICAL on the wire. Measured, not reasoned about — see
   * the proof test below.
   *
   * THE HONEST CONCLUSION: M4 is an EQUIVALENT MUTANT at this seam. It is not a live defect and not
   * a reachable disclosure — the distinction is destroyed by the route's own serialisation before
   * anything downstream (including the portal's superjson transformer, which WOULD have preserved
   * an undefined key had one ever reached it) can observe it. Killing M4 would require exporting
   * the projection function purely to let a test see the in-process object, which is a production
   * change in service of a test and is not worth it.
   *
   * WHAT IS WORTH RECORDING is that the `in`/`Object.keys`/`hasOwnProperty` triple is VACUOUS for
   * the property it appears to assert. It cannot distinguish omit from present-undefined, so it
   * buys nothing over `=== undefined` at this boundary. It is not wrong — absence IS what the
   * contract requires and absence IS what is observed — but the strength it implies is not there.
   *
   * The assertion that DOES carry weight is on the RAW BYTES: the token `actorId` must not appear
   * in the response text at all. That is what a client receives, and it is what is asserted below.
   */

  it("the WIRE FORM carries no actorId key at all for a withheld entry", async () => {
    // The strongest assertion available at this seam: parse the raw text and inspect the key set
    // the CLIENT receives. Unlike `"actorId" in await res.json()`, this fails under M4 only if
    // the key survives serialisation — so it is asserted TOGETHER with the transport pin below,
    // which is what makes the pair complete.
    const audit = new FakeAudit();
    await audit.record({
      subjectId: "victim", action: "MEMBER_REMOVED",
      teamId: "t1",
      actorId: ADMIN_SUB, actorRole: "ADMIN",
    });
    const { app } = build({ audit });
    const res = await app.request("/v1/audit/users/victim", {
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    const raw = await res.text();
    // The literal token must not appear in the BYTES, under any key name or spelling.
    expect(raw).not.toContain("actorId");
    expect(raw).not.toContain(ADMIN_SUB);
    const entry = JSON.parse(raw).entries[0] as Record<string, unknown>;
    // `teamId` is in the set because this fixture is a TEAM-SCOPED entry, which it has to be: the
    // trail became ownership-scoped, and an account-level entry is no longer returned to a FACILITATOR
    // at all — so the withheld-actorId case can only be exercised on a team-scoped row. The route
    // ENUMERATES its fields, so this list is the contract and `actorId` is still absent from it.
    expect(Object.keys(entry).sort()).toEqual([
      "action", "actorRole", "at", "occurredAt", "subjectId", "teamId",
    ]);
  });

  /**
   * THE TRANSPORT FACT THAT MAKES THE WEAKER ASSERTION VACUOUS, pinned as an executable
   * demonstration rather than left as a comment.
   *
   * This does NOT test the route. It tests the claim "`\"actorId\" in await res.json()` is a
   * sufficient check", and proves it FALSE. Kept so that anyone who deletes the wire-form
   * assertion above, believing the parsed-body one covers it, is contradicted by a green test
   * that says otherwise.
   */
  it("PROOF the parsed-body check is insufficient: JSON drops an undefined-valued key", () => {
    const omitted: Record<string, unknown> = { subjectId: "v", actorRole: "ADMIN" };
    const presentUndefined: Record<string, unknown> = {
      subjectId: "v", actorRole: "ADMIN", actorId: undefined,
    };

    // IN PROCESS the two are different, and `in` can tell them apart...
    expect("actorId" in omitted).toBe(false);
    expect("actorId" in presentUndefined).toBe(true);

    // ...but ACROSS JSON they are the SAME BYTES, so a test reading res.json() cannot.
    expect(JSON.stringify(omitted)).toBe(JSON.stringify(presentUndefined));
    expect("actorId" in JSON.parse(JSON.stringify(presentUndefined))).toBe(false);

    // Which is precisely why the assertion above is made on the RAW TEXT's key set instead.
  });
});

// ─── 6. CONVERGENCE OF THE TWO normalizeAuditReason COPIES ──────────────────

describe("CONVERGENCE: the two normalizeAuditReason copies must not drift", () => {
  /**
   * THE TWO COPIES CANNOT BE IMPORTED INTO ONE TEST.
   *
   * The team service's copy is MODULE-PRIVATE (routes.ts:496 — not exported, deliberately, since
   * nothing outside the route file may normalise a reason), and the two live in different
   * workspaces which take no dependency on each other. So a behavioural test cannot drive both
   * functions from one process.
   *
   * What CAN be compared is the SOURCE. This reads both files and asserts the function bodies
   * and the two constants they depend on are byte-identical — which is the property the
   * convergence claim actually rests on, and it fails on an edit to EITHER copy rather than
   * only on a behavioural difference someone thought to test for. The behavioural corpus is
   * pinned separately on each side (see reasonCorpus below and its twin in
   * apps/services/user-access/src/domain.test.ts).
   *
   * Reading a sibling package's source from a test is a TEST-ONLY seam and touches no
   * production code. It is deterministic (no network, no clock) and self-cleaning (no writes).
   */
  const here = fileURLToPath(new URL(".", import.meta.url));
  const TEAM_SRC = `${here}routes.ts`;
  const USER_ACCESS_SRC = `${here}../../user-access/src/domain.ts`;

  /** The brace-matched body of a named function declaration, comments and all. */
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`function ${name}`);
    if (start === -1) throw new Error(`no function ${name}`);
    const open = source.indexOf("{", source.indexOf(")", start));
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error(`unbalanced body for ${name}`);
  }

  it("the two function BODIES are byte-identical", () => {
    const team = functionBody(readFileSync(TEAM_SRC, "utf8"), "normalizeAuditReason");
    const userAccess = functionBody(
      readFileSync(USER_ACCESS_SRC, "utf8"),
      "normalizeAuditReason"
    );
    // Asserted as an equality of the bodies, so the failure message SHOWS the drift.
    expect(team).toBe(userAccess);
    // And the body actually does the sanitising — an assertion that both copies are identically
    // BROKEN would otherwise satisfy the line above.
    expect(team).toContain("replace(AUDIT_REASON_CONTROL_RUN");
    expect(team.indexOf("replace(AUDIT_REASON_CONTROL_RUN")).toBeLessThan(team.indexOf(".trim()"));
  });

  it("the two CONSTANTS they depend on are identical", () => {
    const team = readFileSync(TEAM_SRC, "utf8");
    const userAccess = readFileSync(USER_ACCESS_SRC, "utf8");
    const pattern = (s: string) => /const AUDIT_REASON_CONTROL_RUN = (.+);/.exec(s)?.[1];
    const max = (s: string) => /AUDIT_REASON_MAX = (\d+)/.exec(s)?.[1];
    expect(pattern(team)).toBe("/\\p{C}+/gu");
    expect(pattern(team)).toBe(pattern(userAccess));
    expect(max(team)).toBe("200");
    expect(max(team)).toBe(max(userAccess));
  });
});

/**
 * THE SHARED BEHAVIOURAL CORPUS, driven here through the TEAM service's copy (via the route that
 * writes a reason) and pinned against the SAME table in the user-access package's own tests.
 *
 * This is the fallback the cross-package import problem forces, and it is worth having on top of
 * the source comparison: the source check would pass if both copies were edited together into
 * something wrong, and this one would not.
 */
export const reasonCorpus: ReadonlyArray<readonly [input: string, expected: string | undefined]> = [
  ["plain", "plain"],
  ["a\nb", "a b"],
  ["a\r\n\t\tb", "a b"],
  ["a b", "a b"],
  ["left  the   programme", "left  the   programme"],
  ["  ", undefined],
  ["   ", undefined],
  ["", undefined],
  ["\u200B", undefined],
  ["\u202E\n", undefined],
  ["a" + "\n".repeat(200) + "b", "a b"],
  ["\u0000".repeat(400) + "the real reason", "the real reason"],
  ["\u202E".repeat(400) + "the real reason", "the real reason"],
  ["\u0000".repeat(400) + "a".repeat(200), "a".repeat(200)],
  ["\u0000".repeat(400) + "a".repeat(201), "a".repeat(200)],
  ["a".repeat(201), "a".repeat(200)],
  ["disabled\u202E after\u0000 review", "disabled  after  review"],
  ["\u{1F469}\u200D\u{1F4BB}", "\u{1F469} \u{1F4BB}"],
  ["ok \u2764\uFE0F", "ok \u2764\uFE0F"],
  ["ok \u{1F44D}\u{1F3FF}", "ok \u{1F44D}\u{1F3FF}"],
  ["ok \u{1F1EC}\u{1F1E7}", "ok \u{1F1EC}\u{1F1E7}"],
  ["ok e\u0301", "ok e\u0301"],
  ["\uD800 lone high surrogate", "lone high surrogate"],
  ["\uDFFF lone low surrogate", "lone low surrogate"],
  ["\u{10FFFF} unassigned code point", "unassigned code point"],
];

describe("CONVERGENCE: the shared corpus through the TEAM service's copy", () => {
  it("every corpus case stores the expected reason on the trail", async () => {
    // Driven through DELETE /v1/teams/:teamId/members/:userId, which is where the team copy is
    // actually called — so this exercises the SHIPPED call path and not a re-implementation.
    for (const [input, expected] of reasonCorpus) {
      const audit = new FakeAudit();
      const members = new FakeMembers([
        {
          teamId: "t1", userId: "victim", role: "BUILDER",
          joinedAt: "2026-08-02T00:00:00.000Z", status: "ACTIVE",
        },
        // ⚠ NO MEMBERSHIP ROW FOR "fac". It had one, and that row is how this case used to
        // pass the removal guard — but requirement (b) forbids a FACILITATOR from
        // holding one at all, so the fixture was describing an impossible account. The
        // caller now gets in the way the real one does: workshop ownership.
      ]);
      const { app } = build({ audit, members });
      const res = await app.request("/v1/teams/t1/members/victim", {
        method: "DELETE",
        headers: {
          ...asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: input }),
      });
      expect(res.status, JSON.stringify(input)).toBe(200);
      expect(audit.entries, JSON.stringify(input)).toHaveLength(1);
      expect(audit.entries[0].reason, JSON.stringify(input)).toBe(expected);
      // No stored reason may carry a category-C code point, whatever the input was.
      if (audit.entries[0].reason !== undefined) {
        expect(audit.entries[0].reason, JSON.stringify(input)).not.toMatch(/\p{C}/u);
      }
    }
  });
});
