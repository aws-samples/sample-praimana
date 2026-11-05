import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import type { DocClient } from "@praimana/service-shared";
import { createTeamRoutes } from "./routes.js";
import { DynamoTeamRepository } from "./repository.dynamo.js";
import { HttpWorkshopDirectory } from "./workshop-directory.http.js";
import type { AuthContext } from "./authz.js";
import type { Invitation, Team, TeamMember } from "./domain.js";

/**
 * THE DEPLOY-GATING FIXES from a pre-deploy security review —
 * conditions 1, 2, 3, 6 and 7, plus the FOURTH write layer on the reactivation route.
 *
 * A SEPARATE FILE from the three suites already here, deliberately, and the split is by WHY a
 * test exists rather than by which file it covers:
 *
 *   routes.test.ts            the CONTRACT of each route.
 *   authz-attack.test.ts      the ATTACKER. Six of its tests are named DEFECT and assert the
 *                             BROKEN behaviour as observed, so the review report cannot drift
 *                             from the code. Fixing those defects FAILS those tests BY DESIGN —
 *                             they are re-pointed by QA, never deleted or weakened.
 *   directory-security.test.ts the store boundary — injection, forged cursors, hostile limits.
 *   THIS FILE                 one test per CONDITION, named for the condition it discharges, so a
 *                             reader can check the decisions against the suite line by line and a
 *                             regression names the decision it broke rather than a symptom.
 *
 * Every test here asserts a property that did NOT hold before this change. Each one fails
 * against the previous implementation — that is the bar for being in this file.
 */

const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function asUser(identity: { id: string; email?: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
    ...(identity.email ? { "x-identity-email": identity.email } : {}),
  };
}

const team = (over: Partial<Team> = {}): Team => ({
  workshopId: "w1",
  id: "t1",
  name: "Team One",
  description: null,
  inviteCode: "CODE1234",
  repoUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const invitation = (over: Partial<Invitation> = {}): Invitation => ({
  teamId: "t1",
  email: "victim@example.com",
  status: "PENDING",
  invitedBy: "admin",
  sentAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const REMOVED = (over: Partial<TeamMember> = {}): TeamMember => ({
  teamId: "t1",
  userId: "victim",
  role: "LEAD",
  joinedAt: "2026-08-02T09:00:00.000Z",
  status: "INACTIVE",
  removedAt: "2026-08-04T10:00:00.000Z",
  removedBy: "fac",
  removedByRole: "FACILITATOR",
  ...over,
});

/**
 * A fake DocClient that Scans an in-memory array with DynamoDB's ORDER OF OPERATIONS — read up
 * to Limit rows from the ExclusiveStartKey, THEN drop what the filter rejects, and report
 * LastEvaluatedKey whenever the scan stopped on Limit rather than on running out of rows.
 *
 * A third copy of the fake in repository.dynamo.test.ts and directory-security.test.ts, and the
 * duplication is deliberate for the same reason theirs is: this one additionally REJECTS AN
 * ExclusiveStartKey THAT IS NOT EXACTLY THE TABLE'S KEY SCHEMA, the way the real service does
 * with a ValidationException. Without that, the wrong-shape-cursor fix cannot be proven end to
 * end — a tolerant fake reports a 200 for an implementation that would 500 against the real store.
 */
function fakeScanDb(rows: Team[]) {
  const calls: Array<{ limit?: number; startKey?: string; filter?: string }> = [];

  const db = {
    async send(cmd: {
      input: {
        Limit?: number;
        ExclusiveStartKey?: Record<string, unknown>;
        FilterExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }) {
      const { Limit, ExclusiveStartKey, FilterExpression, ExpressionAttributeValues } =
        cmd.input;

      if (ExclusiveStartKey) {
        // What DynamoDB actually does: a start key must be precisely (workshopId, id).
        const keys = Object.keys(ExclusiveStartKey).sort();
        if (
          keys.length !== 2 ||
          keys[0] !== "id" ||
          keys[1] !== "workshopId" ||
          typeof ExclusiveStartKey.workshopId !== "string" ||
          typeof ExclusiveStartKey.id !== "string"
        ) {
          throw Object.assign(
            new Error("The provided starting key is invalid"),
            { name: "ValidationException" }
          );
        }
      }

      calls.push({
        limit: Limit,
        startKey: ExclusiveStartKey?.id as string | undefined,
        filter: FilterExpression,
      });

      const from = ExclusiveStartKey
        ? rows.findIndex(
            (r) =>
              r.workshopId === ExclusiveStartKey.workshopId && r.id === ExclusiveStartKey.id
          ) + 1
        : 0;
      // Rows READ — before any filtering. This is the crux of the behaviour.
      const window = rows.slice(from, from + (Limit ?? rows.length));
      const lastRead = window[window.length - 1];

      let items = window;
      if (FilterExpression) {
        const vals = ExpressionAttributeValues ?? {};
        const scope = Object.entries(vals)
          .filter(([k]) => k.startsWith(":w"))
          .map(([, v]) => v as string);
        const needles = Object.entries(vals)
          .filter(([k]) => k.startsWith(":q"))
          .map(([, v]) => v as string);
        items = items.filter(
          (r) =>
            (scope.length === 0 || scope.includes(r.workshopId)) &&
            // CASE-SENSITIVE, exactly like DynamoDB's own `contains`.
            (needles.length === 0 || needles.some((n) => r.name.includes(n)))
        );
      }

      const stoppedOnLimit = from + window.length < rows.length;
      return {
        Items: items,
        LastEvaluatedKey:
          stoppedOnLimit && lastRead
            ? { workshopId: lastRead.workshopId, id: lastRead.id }
            : undefined,
      };
    },
  };

  return { db: db as unknown as DocClient, calls };
}

/** Records exactly what reached the SDK, without modelling a scan. */
function recordingDb() {
  const sent: Array<{ ExclusiveStartKey?: Record<string, unknown> }> = [];
  const db = {
    async send(cmd: { input: (typeof sent)[number] }) {
      sent.push(cmd.input);
      return { Items: [], LastEvaluatedKey: undefined };
    },
  } as unknown as DocClient;
  return { db, sent };
}

/**
 * Route dependencies, with the TEAMS repository INJECTABLE so the cursor condition can be driven
 * through the real HTTP surface against the REAL DynamoTeamRepository. Every other dependency is
 * the minimum this file's routes touch.
 */
function build(over: {
  teams?: unknown;
  teamRows?: Team[];
  invitationRows?: Invitation[];
  memberRows?: TeamMember[];
  scope?: { id: string; name: string }[] | "unavailable";
  listByEmail?: (email: string) => Promise<Invitation[]>;
} = {}) {
  const teamRows = over.teamRows ?? [team()];
  const invitationRows = over.invitationRows ?? [];
  const memberRows = over.memberRows ?? [];
  const directoryCalls: Array<{ workshopIds?: readonly string[] }> = [];
  const auditEntries: Array<{ action: string }> = [];

  const fallbackTeams = {
    async getById(id: string) {
      return teamRows.find((t) => t.id === id) ?? null;
    },
    async getByInviteCode() {
      return null;
    },
    async listByWorkshop(workshopId: string) {
      return teamRows.filter((t) => t.workshopId === workshopId);
    },
    async put(t: Team) {
      teamRows.push(t);
      return t;
    },
    async listDirectory(opts: { limit?: number; workshopIds?: readonly string[] }) {
      directoryCalls.push(opts);
      const scoped = opts.workshopIds
        ? teamRows.filter((t) => opts.workshopIds!.includes(t.workshopId))
        : teamRows;
      return { teams: scoped.slice(0, opts.limit ?? 50) };
    },
  };

  const deps = {
    teams: over.teams ?? fallbackTeams,
    members: {
      rows: memberRows,
      async getIncludingInactive(teamId: string, userId: string) {
        return memberRows.find((m) => m.teamId === teamId && m.userId === userId) ?? null;
      },
      async get(teamId: string, userId: string) {
        const row = memberRows.find((m) => m.teamId === teamId && m.userId === userId);
        return row && row.status === "INACTIVE" ? null : (row ?? null);
      },
      async listByTeam() {
        return memberRows.filter((m) => m.status !== "INACTIVE");
      },
      async listByTeamIncludingInactive() {
        return memberRows;
      },
      async listByUser(userId: string) {
        return memberRows.filter((m) => m.userId === userId && m.status !== "INACTIVE");
      },
      async put(m: TeamMember) {
        memberRows.push(m);
        return m;
      },
      async deactivate() {
        return false;
      },
      async reactivate(teamId: string, userId: string) {
        const row = memberRows.find((m) => m.teamId === teamId && m.userId === userId);
        if (!row || row.status !== "INACTIVE") return false;
        row.status = "ACTIVE";
        return true;
      },
    },
    invitations: {
      rows: invitationRows,
      async get(teamId: string, email: string) {
        return (
          invitationRows.find(
            (i) => i.teamId === teamId && i.email === email.toLowerCase()
          ) ?? null
        );
      },
      async listByEmail(email: string) {
        if (over.listByEmail) return over.listByEmail(email);
        return invitationRows.filter((i) => i.email === email.toLowerCase());
      },
      async getByTokenHash() {
        return null;
      },
      async listByTeam() {
        return invitationRows;
      },
      async put(i: Invitation) {
        invitationRows.push(i);
        return i;
      },
      async accept() {
        return false;
      },
      async markRevoked() {
        return false;
      },
      async revoke() {
        return false;
      },
    },
    users: {
      async get(id: string) {
        return id === "victim"
          ? { id, name: "A Victim", email: "victim@example.com" }
          : { id, name: "Facilitator One", email: "f@example.com" };
      },
    },
    // Owns every workshop, so the write guard is never what refuses — a refusal below is
    // provably the rule under test.
    workshops: {
      async ownsWorkshop() {
        return true;
      },
      async ownsTeamWorkshop() {
        return true;
      },
    },
    events: new InMemoryPublisher(),
    audit: {
      entries: auditEntries,
      async record(entry: { action: string }) {
        auditEntries.push(entry);
        return true;
      },
      async listBySubject() {
        return [];
      },
      async listByTeam() {
        return [];
      },
    },
    workshopDirectory: {
      async listOwnedWorkshops() {
        return over.scope ?? [];
      },
      async resolveWorkshopNames() {
        return {};
      },
    },
  };

  // Cast because `teams` is injectable here (a test may pass the REAL DynamoTeamRepository or
  // the fallback fake), so the object's inferred type is a union rather than TeamDeps. The
  // compile-time check that matters — the ROUTES against their real dependencies — is made by
  // the production composition root in app.ts.
  return {
    app: createTeamRoutes(deps as unknown as Parameters<typeof createTeamRoutes>[0]),
    deps,
    directoryCalls,
    auditEntries,
  };
}

// ═══ CONDITION 1 — `hasMore = found.length > limit || !exhausted` ════════════════════

describe("condition 1: a partial page with the table UNEXHAUSTED reports a live cursor", () => {
  it("a FACILITATOR with 3 teams in a 10,000-row table gets a LIVE cursor, not a dead Next", async () => {
    // THE FAILURE THIS FIXES, in the shape it was found. `limit=50` means each of the 5 trips
    // evaluates 51 rows; the scope filter matches one of them. The loop exits on the trip cap
    // with LastEvaluatedKey still set, so `found.length` is 1 — and the old
    // `… || (!exhausted && found.length >= limit)` evaluated `1 >= 50` false and answered
    // `hasMore: false`. The facilitator saw one of their three teams with "Next" dead and no
    // error. Same for any search whose match rate is below limit/255.
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      team({
        workshopId: i % 3000 === 0 ? "mine" : `w${i}`,
        id: `t${String(i).padStart(5, "0")}`,
      })
    );
    const { db } = fakeScanDb(rows);

    const page = await new DynamoTeamRepository(db).listDirectory({
      limit: 50,
      workshopIds: ["mine"],
    });

    // Short — the trip cap truncated it — and that is exactly when the cursor must be live.
    expect(page.teams.length).toBeGreaterThan(0);
    expect(page.teams.length).toBeLessThan(50);
    expect(page.nextCursor).toBeDefined();
  });

  it("PAGES to COMPLETION over that table: every matching team once, and it TERMINATES", async () => {
    // The other half of the condition, and the one that catches an over-eager fix: a `hasMore`
    // that is always true is not a fix, it is an infinite "Next". Asserted on all three
    // properties at once — completeness, no duplicates, and a cursor that eventually clears.
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      team({
        workshopId: i % 3000 === 0 ? "mine" : `w${i}`,
        id: `t${String(i).padStart(5, "0")}`,
      })
    );
    const repo = new DynamoTeamRepository(fakeScanDb(rows).db);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repo.listDirectory({ limit: 50, workshopIds: ["mine"], cursor });
      seen.push(...page.teams.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 500);

    expect(cursor).toBeUndefined();
    expect(seen).toEqual(rows.filter((r) => r.workshopId === "mine").map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("the FIVE-TRIPS-ZERO-MATCHES page carries the FALLBACK cursor, so the needle stays reachable", async () => {
    // The state a last-returned-row cursor CANNOT express: no rows returned means no row to
    // derive a key from, so `lastKey` — the scan's own LastEvaluatedKey — is carried instead.
    // Without it, `hasMore` is true and the cursor absent, which a client reads as "no more
    // results" while the match sits further down the table. That was recorded as a KNOWN GAP;
    // it is now closed, and the assertion is that the needle is REACHED rather than merely that
    // a cursor exists.
    const rows = Array.from({ length: 5000 }, (_, i) =>
      team({ id: `t${String(i).padStart(4, "0")}`, name: i === 4999 ? "needle team" : "Team" })
    );
    const repo = new DynamoTeamRepository(fakeScanDb(rows).db);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await repo.listDirectory({ limit: 10, search: "needle", cursor });
      seen.push(...page.teams.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 200);

    expect(seen).toEqual(["t4999"]);
    expect(cursor).toBeUndefined();
  });

  it("still gives NO cursor when the table IS exhausted — `!exhausted` did not become 'always more'", async () => {
    // The polarity that must not regress with the fix. DynamoDB sets LastEvaluatedKey whenever a
    // Scan stops on Limit, INCLUDING on the last matching row, so a cursor here would be a
    // "Next" onto an empty page.
    const { db } = fakeScanDb([team({ id: "t1" }), team({ id: "t2" })]);

    const page = await new DynamoTeamRepository(db).listDirectory({ limit: 2 });

    expect(page.teams).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });
});

// ═══ CONDITION 2 — the cursor is validated for SHAPE, and restarts at page one ════════

describe("condition 2: a WELL-FORMED-JSON WRONG-SHAPE cursor is page one, not a 500", () => {
  it("?cursor=eyJmb28iOjF9 answers 200 through the ROUTE, against the REAL repository", async () => {
    // THE CONDITION AS WRITTEN, end to end. `eyJmb28iOjF9` is `{"foo":1}`: JSON.parse SUCCEEDS,
    // so the old try/catch (which caught only DECODE failures) let it through and `{foo:1}` was
    // spread into ExclusiveStartKey — a ValidationException, i.e. a 500 on an authenticated
    // route. Driven against the real DynamoTeamRepository over a fake that rejects a wrong-shape
    // start key the way the service does, because a tolerant fake would report this as fixed
    // whether it is or not.
    const { db } = fakeScanDb([team({ id: "t1" }), team({ id: "t2" })]);
    // `scope` names the fixture's workshop because an ADMIN is now scoped to what they OWN
    // — without it this admin owns nothing, the page is legitimately empty, and
    // the test would report a cursor defect that isn't there. The subject is the CURSOR.
    const { app } = build({ teams: new DynamoTeamRepository(db), scope: [{ id: "w1", name: "W1" }] });

    const res = await app.request("/v1/teams/directory?cursor=eyJmb28iOjF9", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    // Page ONE, which is the specified behaviour — not a 400, because the cursor travels through a
    // URL where a copy-paste truncates it and a 400 strands a stale bookmark.
    expect((await res.json()).teams.map((t: { id: string }) => t.id)).toEqual(["t1", "t2"]);
  });

  it("EVERY wrong shape restarts at page one and sends NO ExclusiveStartKey at all", async () => {
    // The whole boundary in one table, because each of these parses successfully and only the
    // SHAPE check refuses them. `null` is the sharp one: `typeof null === "object"`, so a plain
    // truthiness-free object test would let it through.
    const cases: Array<[string, string]> = [
      ['{"foo":1}', "an unrelated object — the condition's own example"],
      ["null", "bnVsbA — parses to null"],
      ['"abc"', "ImFiYyI — parses to a string"],
      ["5", "a number"],
      ["true", "a boolean"],
      ["[]", "an array"],
      ['{"workshopId":"w1","id":"t1","injected":{"S":"x"}}', "EXTRA attribute — attacker-chosen"],
      ['{"workshopId":"w1"}', "the range key missing"],
      ['{"id":"t1"}', "the hash key missing"],
      ['{"workshopId":"","id":"t1"}', "an EMPTY hash key — not a key DynamoDB accepts"],
      ['{"workshopId":"w1","id":""}', "an EMPTY range key"],
      ['{"workshopId":1,"id":2}', "right keys, wrong types"],
    ];

    for (const [raw, why] of cases) {
      const { db, sent } = recordingDb();

      await new DynamoTeamRepository(db).listDirectory({
        cursor: Buffer.from(raw).toString("base64url"),
      });

      // Absent, not sanitised: page one is the specified answer, and an ExclusiveStartKey we cannot
      // vouch for must never reach the SDK.
      expect(sent[0].ExclusiveStartKey, why).toBeUndefined();
    }
  });

  it("a VALID cursor still reaches the SDK verbatim — the check did not break pagination", async () => {
    const { db, sent } = recordingDb();

    await new DynamoTeamRepository(db).listDirectory({
      cursor: Buffer.from(JSON.stringify({ workshopId: "w1", id: "t1" })).toString(
        "base64url"
      ),
    });

    expect(sent[0].ExclusiveStartKey).toEqual({ workshopId: "w1", id: "t1" });
  });

  it("the malformed-cursor log names NEITHER the cursor NOR its values", async () => {
    // The cursor is caller-controlled content arriving in a URL. It is diagnosable from the KEY
    // NAMES; logging the value would put attacker-chosen text into the log stream, and a real
    // cursor's values are a workshop id and a team id.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = recordingDb();

    await new DynamoTeamRepository(db).listDirectory({
      cursor: Buffer.from('{"secretish":"value-not-to-log","other":1}').toString("base64url"),
    });

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("value-not-to-log");
  });
});

// ═══ CONDITION 3 — the scope is capped at 50 ids, and the truncation is REPORTED ══════

describe("condition 3: the FACILITATOR scope is BOUNDED and the cap is reported", () => {
  const owned = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `01J${String(i).padStart(23, "0")}`, name: `W${i}` }));

  it("a 120-workshop FACILITATOR gets 200 with scopeTruncated: true, not a 500", async () => {
    // THE CONDITION AS WRITTEN. DynamoDB accepts at most 100 `IN` operands and caps the whole
    // expression at 4KB, and directory-security.test.ts measures the real threshold at 91 owned
    // workshops with a search needle and 98 without — so an uncapped scope was a permanent
    // ValidationException for the platform's most senior users, and the search made it worse.
    const { app, directoryCalls } = build({
      teamRows: [team({ workshopId: "01J00000000000000000000000", id: "t1" })],
      scope: owned(120),
    });

    const res = await app.request("/v1/teams/directory?search=phoenix", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    expect(directoryCalls[0].workshopIds).toHaveLength(50);
    expect((await res.json()).scopeTruncated).toBe(true);
  });

  it("the CAPPED scope keeps the store expression well inside DynamoDB's 4KB limit", async () => {
    // The cap is only a fix if the capped expression FITS. Measured the same way the DEFECT test
    // measures the unbounded one — expression text plus bound values, with a full-length needle,
    // over 26-character ULIDs.
    const { db, sent } = recordingDb();

    await new DynamoTeamRepository(db).listDirectory({
      workshopIds: owned(50).map((w) => w.id),
      search: "x".repeat(100),
    });

    const bytes =
      Buffer.byteLength(
        (sent[0] as unknown as { FilterExpression: string }).FilterExpression,
        "utf8"
      ) +
      Buffer.byteLength(
        JSON.stringify(
          (sent[0] as unknown as { ExpressionAttributeValues: unknown })  // nosemgrep: no-stringify-keys
            .ExpressionAttributeValues
        ),
        "utf8"
      );
    expect(bytes).toBeLessThan(4096);
  });

  it("EXACTLY 50 is not truncated — the cap is inclusive, so no facilitator is short by one", async () => {
    const { app, directoryCalls } = build({
      teamRows: [team({ workshopId: "01J00000000000000000000000", id: "t1" })],
      scope: owned(50),
    });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(directoryCalls[0].workshopIds).toHaveLength(50);
    expect((await res.json()).scopeTruncated).toBe(false);
  });

  it("an ADMIN is capped and TRUNCATION-REPORTED like anyone else — the unrestricted scope is gone", async () => {
    // ⚠ INVERTED. This previously asserted `workshopIds` UNDEFINED and
    // `scopeTruncated: false`, on the reasoning in its own title: "an unrestricted scope is
    // not a list to cap". Correct reasoning, obsolete premise — an admin no longer HAS an
    // unrestricted scope, so there is now a list, and it is capped exactly like a
    // facilitator's 120.
    //
    // ⚠ THE NARROWING IS REPORTED RATHER THAN SILENT, which is the part worth pinning: an
    // admin who owns more than the cap gets a SHORT page where they used to get every team
    // on the platform, and `scopeTruncated` is the only thing that distinguishes that from a
    // complete one.
    const { app, directoryCalls } = build({ scope: owned(120) });

    const res = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "a1", email: "a@example.com", role: "ADMIN" }),
    });

    expect(directoryCalls[0].workshopIds).toHaveLength(50);
    expect((await res.json()).scopeTruncated).toBe(true);
  });

  it("a DETERMINED EMPTY scope stays a 200 with nothing, and an UNAVAILABLE one stays a 503", async () => {
    // The two answers the cap must not disturb: "you own no workshops" is a truth, "we could not
    // ask" is a 503, and neither is a truncation.
    const emptyScope = build({ scope: [] });
    const empty = await emptyScope.app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(empty.status).toBe(200);
    expect(emptyScope.directoryCalls[0].workshopIds).toEqual([]);
    expect((await empty.json()).scopeTruncated).toBe(false);

    const { app } = build({ scope: "unavailable" });
    const unavailable = await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).code).toBe("DIRECTORY_SCOPE_UNAVAILABLE");
  });

  it("the truncation WARN carries COUNTS and ids, never the workshop ids themselves", async () => {
    // No workshopId/userId as a metric dimension. Counts are what an
    // operator alarms on.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = build({ scope: owned(120) });

    await app.request("/v1/teams/directory", {
      headers: asUser({ id: "f1", email: "f@example.com", role: "FACILITATOR" }),
    });

    const hit = warn.mock.calls.find((c) => String(c[0]).includes("scope TRUNCATED"));
    expect(hit).toBeDefined();
    expect(hit![1]).toMatchObject({ userId: "f1", role: "FACILITATOR", owned: 120, scoped: 50 });
  });
});

// ═══ CONDITION 6 — all-rows-unreadable is "unavailable", not a determined empty scope ═

describe("condition 6: listOwnedWorkshops logs dropped rows and refuses to read them as empty", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const auth = () =>
    ({
      req: {
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? "Bearer header.payload.sig" : undefined,
      },
    }) as unknown as AuthContext;
  const call = () =>
    new HttpWorkshopDirectory("http://workshop.test/v1").listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      auth()
    );

  it("a NON-EMPTY array yielding ZERO usable rows is 'unavailable' and logs the dropped count", async () => {
    // THE ONLY PATH from 503-semantics back to a plausible-but-empty page, and it is a SCHEMA
    // CHANGE rather than an outage: rename `id` on the Workshop side and every row fails
    // validation, the method returns [], and [] is the one value that legitimately means "you
    // own no workshops" — so the route answers 200 with an empty directory. Exactly the defect
    // the fail-closed "unavailable" semantics were written to prevent, through the one door left open.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ workshops: [{ workshopId: "w1", name: "One" }, { workshopId: "w2", name: "Two" }] })
      )
    );

    expect(await call()).toBe("unavailable");
    const hit = warn.mock.calls.find((c) => String(c[0]).includes("EVERY row was unreadable"));
    expect(hit).toBeDefined();
    expect(hit![1]).toMatchObject({ userId: "f1", role: "FACILITATOR", received: 2, dropped: 2 });
  });

  it("a genuinely EMPTY list is STILL a determined empty scope — the boundary is preserved", async () => {
    // There was nothing to drop, so nothing was dropped. This is the one shape that means "you
    // own no workshops", and turning it into a 503 would make an honest answer unreachable.
    vi.stubGlobal("fetch", vi.fn(async () => json({ workshops: [] })));

    expect(await call()).toEqual([]);
  });

  it("dropping SOME rows still succeeds, and the partial drop is logged", async () => {
    // Unchanged behaviour, asserted so the fix above cannot creep into it: the answer arrived
    // and was well-shaped, and one bad row is not a reason to 503 a facilitator out of their own
    // directory. The log is what turns "a workshop is missing" into a diagnosis.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          workshops: [
            { id: "w1", name: "Workshop One" },
            { id: "", name: "no id" },
            null,
            "nonsense",
            { id: "w2" },
          ],
        })
      )
    );

    expect(await call()).toEqual([
      { id: "w1", name: "Workshop One" },
      { id: "w2", name: "" },
    ]);
    const hit = warn.mock.calls.find((c) => String(c[0]).includes("were DROPPED"));
    expect(hit![1]).toMatchObject({ received: 5, dropped: 3 });
  });

  it("logs NOTHING when every row is usable — a clean read is not a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ workshops: [{ id: "w1", name: "One" }] })));

    expect(await call()).toEqual([{ id: "w1", name: "One" }]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ═══ THE FOURTH WRITE LAYER, which was DEAD CODE ═════════════════════════════════════

describe("the reactivation subject-role gate actually fires", () => {
  const post = (app: ReturnType<typeof build>["app"]) =>
    app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

  it("403s a subject whose staff invitation is at PLATFORM scope — the ONLY shape that can exist", async () => {
    // WHY THE GATE WAS DEAD. It resolved the subject's role with
    // `invitations.get(teamId, subjectEmail)` — keyed on the TEAM — but the invitation route
    // REFUSES to write a team-scoped invitation for ADMIN/FACILITATOR/JUDGE (400), and `teamId`
    // is the invitations partition key. So those rows exist ONLY at "PLATFORM", the lookup always
    // returned null, `|| "PARTICIPANT"` was applied, and reactivating a staff subject answered
    // 200 and wrote MEMBER_RESTORED where the rule requires 403. That membership
    // row IS team-content authorization, including in `services/docs`, which reads the table
    // directly and cannot be corrected from this service.
    for (const subjectRole of ["FACILITATOR", "JUDGE", "ADMIN"]) {
      const memberRows = [REMOVED()];
      const { app, auditEntries } = build({
        memberRows,
        invitationRows: [
          invitation({ teamId: "PLATFORM", platformRole: subjectRole, status: "ACCEPTED" }),
        ],
      });

      const res = await post(app);

      expect(res.status, subjectRole).toBe(403);
      // A refusal that had already flipped the row would be the whole bug.
      expect(memberRows[0].status, subjectRole).toBe("INACTIVE");
      expect(auditEntries, subjectRole).toHaveLength(0);
    }
  });

  it("403s on a REVOKED staff row — a status filter would make this gate dead AGAIN", async () => {
    // ⚠ THE MOST MISREADABLE PROPERTY IN THE FIX, pinned so it cannot be "aligned" with
    // `resolveRoleFromInvitations`, which drops REVOKED rows because it decides a GRANT. This
    // gate decides a REFUSAL, so the safe direction INVERTS: a revoked FACILITATOR invitation is
    // still evidence the subject is staff. And critically — THE REMOVAL ROUTE ITSELF FLIPS THE
    // SUBJECT'S ROW TO REVOKED, so every subject this route serves has one, and a status filter
    // would blind the gate to exactly the population it exists to protect against.
    const memberRows = [REMOVED()];
    const { app } = build({
      memberRows,
      invitationRows: [
        invitation({ teamId: "PLATFORM", platformRole: "FACILITATOR", status: "REVOKED" }),
      ],
    });

    expect((await post(app)).status).toBe(403);
    expect(memberRows[0].status).toBe("INACTIVE");
  });

  it("403s on an EXPIRED staff row — invitations lapse in 24h and removals are reversed weeks later", async () => {
    const memberRows = [REMOVED()];
    const { app } = build({
      memberRows,
      invitationRows: [
        invitation({
          teamId: "PLATFORM",
          platformRole: "JUDGE",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ],
    });

    expect((await post(app)).status).toBe(403);
  });

  it("403s a LEGACY VIOLATING ROW at a THIRD teamId — which a two-scope `get` would miss", async () => {
    // Why the fix is `listByEmail` and not "get the team scope AND the platform scope": a
    // legacy violating row may exist, and a gate that covers the two scopes we happen
    // to know about is the same class of bug as the one being fixed.
    const memberRows = [REMOVED()];
    const { app } = build({
      memberRows,
      invitationRows: [invitation({ teamId: "some-other-team", platformRole: "FACILITATOR" })],
    });

    expect((await post(app)).status).toBe(403);
    expect(memberRows[0].status).toBe("INACTIVE");
  });

  it("HIGHEST PRIVILEGE WINS: a PARTICIPANT team row cannot outvote a PLATFORM facilitator row", async () => {
    // PLATFORM_ROLE_PRECEDENCE, never newest-wins. A subject holding both rows IS staff, and the
    // refusal has to see the more privileged of the two — otherwise the gate is evadable by
    // holding one extra ordinary invitation.
    const memberRows = [REMOVED()];
    const { app } = build({
      memberRows,
      invitationRows: [
        invitation({ teamId: "t1", platformRole: "PARTICIPANT" }),
        invitation({ teamId: "PLATFORM", platformRole: "FACILITATOR" }),
      ],
    });

    expect((await post(app)).status).toBe(403);
    expect(memberRows[0].status).toBe("INACTIVE");
  });

  it("still ALLOWS the two team-scoped roles and an ABSENT platformRole", async () => {
    // The other half, so the refusal cannot pass by refusing everybody — and the absent case
    // matters: every invitation written before `platformRole` existed carries none, and refusing
    // those would make every legacy member permanently unrestorable.
    for (const subjectRole of ["PARTICIPANT", "EXECUTIVE", undefined]) {
      const memberRows = [REMOVED()];
      const { app } = build({
        memberRows,
        invitationRows: [invitation(subjectRole ? { platformRole: subjectRole } : {})],
      });

      const res = await post(app);

      expect(res.status, String(subjectRole)).toBe(200);
      expect(memberRows[0].status, String(subjectRole)).toBe("ACTIVE");
    }
  });

  it("503s SUBJECT_UNAVAILABLE when the invitation READ FAILS — never a 200", async () => {
    // A store failure is not evidence that the subject is a participant. TRANSIENT, so 503 with
    // Retry-After is truthful: the lookup could not be PERFORMED and a retry changes the answer.
    const memberRows = [REMOVED()];
    const { app, auditEntries } = build({
      memberRows,
      listByEmail: async () => {
        throw new Error("ProvisionedThroughputExceededException");
      },
    });

    const res = await post(app);

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SUBJECT_UNAVAILABLE");
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(memberRows[0].status).toBe("INACTIVE");
    expect(auditEntries).toHaveLength(0);
  });

  it("503s on OVERFLOW rather than weighing a TRUNCATED set of evidence", async () => {
    // Truncating a refusal gate's evidence can drop the one row that would have refused, so
    // "more rows than we will weigh" must never resolve to "nothing found". 51 refuses; 50 — the
    // bound itself — is weighed normally, so the cap is not off by one against a real subject.
    const many = Array.from({ length: 51 }, (_, i) =>
      invitation({ teamId: `t${i}`, platformRole: "PARTICIPANT" })
    );

    const overflowRows = [REMOVED()];
    const overflow = build({ memberRows: overflowRows, invitationRows: many });
    const res = await post(overflow.app);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SUBJECT_UNAVAILABLE");
    expect(overflowRows[0].status).toBe("INACTIVE");

    const atBoundRows = [REMOVED()];
    const atBound = build({ memberRows: atBoundRows, invitationRows: many.slice(0, 50) });
    expect((await post(atBound.app)).status).toBe(200);
    expect(atBoundRows[0].status).toBe("ACTIVE");
  });
});

// ═══ NO INVITATION AT ANY SCOPE — still a 200, and now COUNTABLE ══════════════════════

describe("the no-evidence reactivation stays a 200 and emits a named counter", () => {
  const post = (app: ReturnType<typeof build>["app"]) =>
    app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

  it("200s with NO invitation anywhere — refusing here was considered and REJECTED", async () => {
    // Not an oversight, a deliberate choice. A refusal detects almost nothing (every membership row was
    // written through a path that already checked the VERIFIED TOKEN ROLE, and there is no
    // role-change route on the platform) while its fallback is worse: re-inviting goes through
    // `members.put`, which REPLACES THE ROW WHOLE and destroys the preserved team role the soft
    // delete exists to protect — and it needs the SUBJECT to sign in, so an operator cannot do
    // it on their behalf during an incident.
    const memberRows = [REMOVED({ role: "LEAD" })];
    const { app } = build({ memberRows, invitationRows: [] });

    const res = await post(app);

    expect(res.status).toBe(200);
    expect(memberRows[0].status).toBe("ACTIVE");
    // The preserved role is the thing the refusal's fallback would have destroyed.
    expect((await res.json()).role).toBe("LEAD");
  });

  it("emits ReactivateSubjectRoleUnevidenced with IDS ONLY — no email, no unbounded dimension", async () => {
    // The uncovered case is an OUT-OF-BAND promotion (Cognito console, `create-admin.mjs
    // --force`), which writes no invitation row; its remedy is hand-deletion,
    // and this counter is what makes one findable. No email or unbounded dimension in the fields.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = build({ memberRows: [REMOVED()], invitationRows: [] });

    await post(app);

    const hit = warn.mock.calls.find(
      (c) => (c[1] as { metric?: string })?.metric === "ReactivateSubjectRoleUnevidenced"
    );
    expect(hit).toBeDefined();
    expect(hit![1]).toEqual({
      metric: "ReactivateSubjectRoleUnevidenced",
      teamId: "t1",
      subjectId: "victim",
      actorId: "fac",
    });
    // The subject's ADDRESS is resolved on this path and must not travel into the log line.
    expect(JSON.stringify(hit![1])).not.toContain("@");  // nosemgrep: no-stringify-keys
  });

  it("does NOT emit the counter when evidence exists — it counts the uncovered case only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = build({
      memberRows: [REMOVED()],
      invitationRows: [invitation({ platformRole: "PARTICIPANT" })],
    });

    await post(app);

    expect(
      warn.mock.calls.some(
        (c) => (c[1] as { metric?: string })?.metric === "ReactivateSubjectRoleUnevidenced"
      )
    ).toBe(false);
  });

  it("an unresolvable ADDRESS is STILL a 503 — a lookup that could not be PERFORMED", async () => {
    // The contrast that justifies the asymmetry, asserted rather than described. An unresolvable
    // address is TRANSIENT (a lagging read-model projection), so a retry changes the answer and
    // Retry-After is truthful. An ABSENT ROW is a lookup that COMPLETED with a definite
    // negative — a 503 there would be permanent and Retry-After would be a lie.
    const memberRows = [REMOVED()];
    const noEmail = build({ memberRows });
    // No read-model row for the subject at all — the lagging-projection case.
    (noEmail.deps as unknown as { users: { get: (id: string) => Promise<unknown> } }).users.get =
      async () => null;

    const res = await noEmail.app.request("/v1/teams/t1/members/victim/reactivate", {
      method: "POST",
      headers: asUser({ id: "fac", email: "f@example.com", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SUBJECT_UNAVAILABLE");
    expect(memberRows[0].status).toBe("INACTIVE");
  });
});
