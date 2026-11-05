import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createEvaluationRoutes } from "./routes.js";
import type { TeamAccess, WorkshopEntitlements } from "./authz.js";
import { isReservedId } from "./domain.js";
import type {
  CreateUniqueOutcome,
  DocsCatalog,
  PatchOutcome,
  PhaseNotes,
  SnapshotArtifact,
  SnapshotPhase,
  SubmissionPatch,
  TeamDirectory,
  WorkshopDirectory,
  WorkshopResults,
  WorkshopResultsRepository,
  ActivityReadModel,
  MemberActivity,
  MemberRating,
  MemberRatingRepository,
  Score,
  ScoreRepository,
  Submission,
  SubmissionRepository,
  UserView,
  UsersReadModel,
} from "./domain.js";

/**
 * RECONNAISSANCE SPECS from a security audit of this service's authorization.
 *
 * ── THESE SPECS HAVE BEEN RE-POINTED, AND THE HISTORY IS THE POINT OF KEEPING THEM ──
 *
 * As originally written they ASSERTED THE DEFECTS: a foreign judge got 201, the injected
 * `teamAccess` port recorded zero predicate calls, `Submission.workshopId` came from the
 * request body, and a null-scoped row scored like any other. Fixing P0-3
 * flipped every one of those four specs to failing — the intended
 * signal that the defect they documented is gone.
 *
 * Each is now pointed at the FIX and still names what it used to assert, because the
 * defect is the reason the assertion exists and a spec that only states today's behaviour
 * cannot tell a future reader which line is load-bearing. Nothing was deleted or weakened:
 * every original expectation is either inverted deliberately (201 → 403) or kept verbatim
 * (the write did not land, no event was published).
 *
 * The `submission.getById` existence half was already fixed when these were written and
 * its spec is UNCHANGED below — it was passing then and passes now.
 *
 * They drive the real Hono app with a judge's identity headers rather than reasoning about
 * the guard, which is why they caught what a unit test of `requireScoringRole` could not.
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
 * ── ⚠ THIS FAKE MODELS THE POINTER, THE TRANSACTION AND PUT'S OVERWRITE ──────────────────
 *
 * `put` UPSERTS on (teamId, id) because `DynamoSubmissionRepository.put` issues a `PutCommand`, which
 * replaces the item at that key. It used to `push`, which grew a duplicate no real table would hold.
 *
 * `createUnique` models the outcome of the two-item `TransactWriteItems`, not its wire form: a team
 * with a pointer LOSES, and so does a re-sent explicit id. The wire form — the conditions, the
 * positional disambiguation, the reserved-id filter on `listByTeam` — is asserted against the real
 * repository in `repository.dynamo.test.ts`, which is the only place it can be.
 *
 * ⚠ A SEEDED FIXTURE HAS NO POINTER, ON PURPOSE. That is exactly a row created before this change, so
 * tests inherit the legacy case rather than a tidied-up one.
 */
class FakeSubmissions implements SubmissionRepository {
  /** teamId → the team's one submission id. Empty for seeded (pre-pointer) fixtures. */
  readonly pointers = new Map<string, string>();
  constructor(readonly rows: Submission[] = []) {}
  async get(teamId: string, id: string) {
    return this.rows.find((s) => s.teamId === teamId && s.id === id) ?? null;
  }
  async getById(id: string) {
    return this.rows.find((s) => s.id === id) ?? null;
  }
  async listByTeam(teamId: string) {
    // The reserved filter is applied here too, so a test that seeds a pointer-shaped row sees the
    // same exclusion production applies.
    return this.rows.filter((s) => s.teamId === teamId && !isReservedId(s.id));
  }
  async put(submission: Submission) {
    const at = this.rows.findIndex(
      (s) => s.teamId === submission.teamId && s.id === submission.id
    );
    if (at === -1) this.rows.push(submission);
    else this.rows[at] = submission;
    return submission;
  }
  /**
   * ⚠ THE RELEASED-ONLY AND RESERVED FILTERS ARE BOTH APPLIED HERE TOO, matching the real query's
   * belt-and-braces. A fake that returned everything would let the released-only list test pass while production leaked
   * drafts, and one that relied on the sparse index would not model the filter at all.
   */
  async listReleasedByWorkshop(workshopId: string, limit = 200) {
    const all = this.rows
      .filter(
        (s) => s.workshopId === workshopId && s.status === "SUBMITTED" && !isReservedId(s.id)
      )
      // Newest release first, as `ScanIndexForward: false` on the byWorkshop GSI gives.
      .sort((a, b) => String(b.releasedAt ?? "").localeCompare(String(a.releasedAt ?? "")));
    return { submissions: all.slice(0, limit), truncated: all.length > limit };
  }
  async pointer(teamId: string) {
    return this.pointers.get(teamId) ?? null;
  }
  async createUnique(submission: Submission): Promise<CreateUniqueOutcome> {
    const held = this.pointers.get(submission.teamId);
    if (held) return { outcome: "exists", submissionId: held };
    // The submission item's own `attribute_not_exists(id)` — a re-sent explicit id.
    if (this.rows.some((s) => s.teamId === submission.teamId && s.id === submission.id)) {
      return { outcome: "exists", submissionId: submission.id };
    }
    this.rows.push(submission);
    this.pointers.set(submission.teamId, submission.id);
    return { outcome: "created", submission };
  }
  async patch(teamId: string, id: string, fields: SubmissionPatch): Promise<PatchOutcome> {
    const at = this.rows.findIndex((s) => s.teamId === teamId && s.id === id);
    if (at === -1) return { outcome: "not-found" };
    // The condition is `attribute_exists(id) AND #status = :draft`, so a released row is refused
    // without being touched.
    if (this.rows[at].status !== "DRAFT") return { outcome: "not-draft" };
    const updated: Submission = {
      ...this.rows[at],
      ...fields,
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    this.rows[at] = updated;
    return { outcome: "patched", submission: updated };
  }
}

/**
 * The Docs context's answer, faked. ⚠ `"unavailable"` IS A DISTINCT STATE, not an empty list — the
 * whole of the failed-hop 503 turns on the difference, so the fake must be able to express it.
 */
class FakeDocs implements DocsCatalog {
  calls: string[] = [];
  constructor(
    private readonly answer: SnapshotArtifact[] | "unavailable" = [
    {
      path: "README.md",
      versionId: "v1",
      lastAuthorName: "Ada",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
  ]) {}
  async listByTeam(teamId: string) {
    this.calls.push(teamId);
    return this.answer;
  }
}

/** The Workshop context's answer, faked. Same three-valued shape as FakeDocs. */
class FakePhases implements PhaseNotes {
  calls: Array<{ teamId: string; workshopId: string }> = [];
  constructor(private readonly answer: SnapshotPhase[] | "unavailable" = [
    {
      phaseId: "p1",
      order: 1,
      name: "Inception",
      content: "what we built",
      aiGenerated: false,
      editedByName: "Ada",
      editedAt: "2026-01-02T00:00:00.000Z",
    },
  ]) {}
  async listByTeam(teamId: string, workshopId: string) {
    this.calls.push({ teamId, workshopId });
    return this.answer;
  }
}

/** The team's display NAME, pinned at release. `null` is a real answer here, never a failure. */
class FakeTeams implements TeamDirectory {
  calls: Array<{ teamId: string; workshopId: string }> = [];
  constructor(private readonly name: string | null = "Code Vibranium") {}
  async nameOf(teamId: string, workshopId: string) {
    this.calls.push({ teamId, workshopId });
    return this.name;
  }
  /** The experience's teams. `"unavailable"` is a distinct state from an empty experience. */
  teamsOfCalls: string[] = [];
  teamsAnswer:
    | Array<{ id: string; name: string | null; memberCount: number | null }>
    | "unavailable" = [{ id: "t1", name: "Code Vibranium", memberCount: 3 }];
  async teamsOf(workshopId: string) {
    this.teamsOfCalls.push(workshopId);
    return this.teamsAnswer;
  }
}

/** The experience. Three outcomes: the row, `null` (no such experience), `"unavailable"`. */
class FakeWorkshops implements WorkshopDirectory {
  calls: string[] = [];
  constructor(
    private readonly answer:
      | { id: string; ownerId: string | null; status: string }
      | null
      | "unavailable" = { id: "w1", ownerId: "owner-1", status: "ACTIVE" }
  ) {}
  async get(workshopId: string) {
    this.calls.push(workshopId);
    return this.answer;
  }
  /** Records the transition and reports whether it "landed", so the publish route's tolerance of a
   *  failed transition can be tested without pretending it succeeded. */
  statusCalls: Array<{ workshopId: string; status: string }> = [];
  transitions: boolean = true;
  async setStatus(workshopId: string, status: string) {
    this.statusCalls.push({ workshopId, status });
    return this.transitions;
  }
}

/**
 * The published ranking. ⚠ `create` REFUSES A SECOND PUBLISH, modelling the real
 * `attribute_not_exists(workshopId)` condition rather than the read-then-write it replaces.
 */
class FakeResults implements WorkshopResultsRepository {
  readonly rows = new Map<string, WorkshopResults>();
  constructor(seed: WorkshopResults[] = []) {
    for (const r of seed) this.rows.set(r.workshopId, r);
  }
  async get(workshopId: string) {
    return this.rows.get(workshopId) ?? null;
  }
  async create(results: WorkshopResults) {
    if (this.rows.has(results.workshopId)) return "already-published" as const;
    this.rows.set(results.workshopId, results);
    return "created" as const;
  }
  /** Reopen withdraws a published ranking — see `WorkshopResultsRepository.clear`. */
  async clear(workshopId: string) {
    this.rows.delete(workshopId);
  }
}

class FakeScores implements ScoreRepository {
  constructor(readonly rows: Score[] = []) {}
  async listBySubmission(submissionId: string) {
    return this.rows.filter((s) => s.submissionId === submissionId);
  }
  /** Upserts on (submissionId, judgeId) — the live table's key. See the note in `routes.test.ts`. */
  /**
   * ⚠ CONDITIONAL CREATE, MATCHED TO THE LIVE KEY SCHEMA — `submissionId` HASH + `judgeId` RANGE on
   * `praimana-scores`, verified against the deployed table rather than inferred from documentation.
   *
   * This fake used to `put` and UPSERT, faithfully mirroring the production write at the time. The
   * production write is now `attribute_not_exists(submissionId)`, so a second score from the same judge
   * is REFUSED rather than replacing the first — see the note on `ScoreRepository.create`, and the
   * note on the re-scoring test in routes.test.ts for what that supersedes.
   */
  async create(score: Score) {
    const clash = this.rows.some(
      (s) => s.submissionId === score.submissionId && s.judgeId === score.judgeId
    );
    if (clash) return "already-scored" as const;
    this.rows.push(score);
    return "created" as const;
  }
}

class FakeRatings implements MemberRatingRepository {
  constructor(readonly rows: MemberRating[] = []) {}
  async listByTeam(teamId: string) {
    return this.rows.filter((r) => r.teamId === teamId);
  }
  /** Conditional on the row key, mirroring the store — see the note on the fake in routes.test.ts. */
  async create(rating: MemberRating): Promise<"created" | "already-rated"> {
    const clash = this.rows.some(
      (r) => r.teamId === rating.teamId && r.id === rating.id
    );
    if (clash) return "already-rated";
    this.rows.push(rating);
    return "created";
  }
}

class FakeActivity implements ActivityReadModel {
  constructor(readonly rows: MemberActivity[] = []) {}
  async get() {
    return null;
  }
  async listByTeam(teamId: string) {
    return this.rows.filter((a) => a.teamId === teamId);
  }
  async upsert(activity: MemberActivity) {
    this.rows.push(activity);
  }
  async increment() {}
}

class FakeUsers implements UsersReadModel {
  private readonly rows = new Map<string, UserView>();
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async upsert(view: UserView) {
    this.rows.set(view.id, view);
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

class FakeTeamAccess implements TeamAccess {
  /**
   * Every predicate consulted, in order.
   *
   * ORIGINALLY the assertion target for "the scoring path asked nothing about scope" —
   * `expect(teamAccess.predicates).toEqual([])` was the proof that the P0-3 decision
   * consulted NOTHING. It stays exactly that assertion, and it still holds after the fix:
   * the scope now comes from the SEPARATE entitlements port, so the scoring path asks this
   * one nothing by design. What changed is that the request is refused.
   */
  predicates: Array<
    "canRead" | "canWrite" | "canReadContent" | "canWriteContent" | "writeScope"
  > = [];
  constructor(
    private readonly reads = true,
    private readonly writes = true,
    /** What `writeScope` reports as the team's workshop. */
    private readonly scope: string | null | "unavailable" = "w1"
  ) {}
  async canRead() {
    this.predicates.push("canRead");
    return this.reads;
  }
  async canWrite() {
    this.predicates.push("canWrite");
    return this.writes;
  }
  async canReadContent() {
    this.predicates.push("canReadContent");
    return this.reads;
  }
  async canWriteContent() {
    this.predicates.push("canWriteContent");
    return this.writes;
  }
  async writeScope() {
    this.predicates.push("writeScope");
    if (this.scope === "unavailable") return "unavailable" as const;
    return { canWrite: this.writes, workshopId: this.scope };
  }
}

/** The entitlement source the scoping guard reads. */
class FakeEntitlements implements WorkshopEntitlements {
  calls: string[] = [];
  constructor(private readonly workshopIds: string[] | "unavailable" = []) {}
  async listEntitledWorkshopIds(role: string) {
    this.calls.push(role);
    if (this.workshopIds === "unavailable") return "unavailable" as const;
    return { workshopIds: this.workshopIds, truncated: false };
  }
}

/** A complete, valid set of the five criteria — every criterion is required. */
const validScores = (over: Record<string, unknown> = {}) => ({
  innovation: 8,
  execution: 7,
  aiUsage: 9,
  impact: 6,
  presentation: 5,
  ...over,
});

/**
 * ⚠ DEFAULTS TO `SUBMITTED`, UNLIKE THE BUILDER IN `routes.test.ts`, AND THE DIFFERENCE IS THE POINT.
 *
 * Every submission in this file exists to be SCORED — these are the P0-3/P0-4 scope recons. Since
 * the rule refuses a score on an unreleased submission, a `DRAFT` fixture here would make
 * every test in the file pass or fail on the status check instead of on the authorization decision
 * it is actually recon-ing. Released by default keeps each test about its own guard.
 */
const submission = (over: Partial<Submission> = {}): Submission => ({
  teamId: "t1",
  id: "s1",
  workshopId: "w1",
  status: "SUBMITTED",
  title: "Our project",
  summary: null,
  problemStatement: null,
  solution: null,
  demoUrl: null,
  videoUrl: null,
  repoUrl: null,
  slidesUrl: null,
  aiUsageSummary: null,
  submittedAt: null,
  createdById: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  releasedById: null,
  releasedAt: null,
  reopenedById: null,
  reopenedAt: null,
  reopenReason: null,
  snapshot: null,
  ...over,
});

function build(
  over: Partial<{
    submissions: FakeSubmissions;
    docs: FakeDocs;
    phases: FakePhases;
    teams: FakeTeams;
    workshops: FakeWorkshops;
    results: FakeResults;
    scores: FakeScores;
    ratings: FakeRatings;
    activity: FakeActivity;
    users: FakeUsers;
    teamAccess: TeamAccess;
    entitlements: WorkshopEntitlements;
    events: InMemoryPublisher;
  }> = {}
) {
  const deps = {
    submissions: over.submissions ?? new FakeSubmissions([]),
    docs: over.docs ?? new FakeDocs(),
    phases: over.phases ?? new FakePhases(),
    teams: over.teams ?? new FakeTeams(),
    workshops: over.workshops ?? new FakeWorkshops(),
    results: over.results ?? new FakeResults(),
    scores: over.scores ?? new FakeScores([]),
    ratings: over.ratings ?? new FakeRatings([]),
    activity: over.activity ?? new FakeActivity([]),
    users: over.users ?? new FakeUsers(),
    teamAccess: over.teamAccess ?? new FakeTeamAccess(true, true),
    // Entitled to NOTHING by default in this file, unlike routes.test.ts. These specs are
    // about the foreign judge, so the default caller is the one with no entitlement — a spec
    // that means "an entitled judge" says so explicitly.
    entitlements: over.entitlements ?? new FakeEntitlements([]),
    events: over.events ?? new InMemoryPublisher(),
  };
  return { app: createEvaluationRoutes(deps), deps };
}

// ════════════════════════════════════════════════════════════════════════════
// P0-3 — "any JUDGE can score any submission in any workshop".
// The ORPHAN half shipped first; the SCOPE half shipped after it.
// BOTH are now closed and pinned below.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON P0-3: POST /v1/submissions/:submissionId/scores", () => {
  it("FIXED (half): a nonexistent submission is a 404 and writes NO orphan Score row", async () => {
    // The register's second sentence: "the route also never loads the submission, so it
    // writes orphan Score rows for non-existent submission ids." That half is closed —
    // routes.ts:179-180 now resolves the submission before the write.
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    const { app } = build({ submissions: new FakeSubmissions([]), scores, events });

    const res = await app.request("/v1/submissions/never-existed/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(404);
    expect(scores.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("FIXED: a JUDGE is REFUSED a submission in a workshop they have no connection to", async () => {
    // ── THE REGISTER'S FIRST SENTENCE, NOW FALSE. RE-POINTED. ──
    //
    // AS WRITTEN, this spec asserted the DEFECT: `expect(res.status).toBe(201)`, the row
    // landed, and `submission.scored` was published. `requireScoringRole` was the whole
    // gate — role-only, no submission, no workshop, no entitlement.
    //
    // The fixture is UNCHANGED, deliberately, because it is the exact attack: the
    // submission names workshop `w-foreign`; the judge is invited to nothing, is on no
    // team, and the Team context refuses them everything. Only the expectations moved.
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    const teamAccess = new FakeTeamAccess(false, false);
    const entitlements = new FakeEntitlements([]); // invited to nothing
    const { app } = build({
      submissions: new FakeSubmissions([
        submission({ id: "s-foreign", teamId: "t-foreign", workshopId: "w-foreign" }),
      ]),
      scores,
      events,
      teamAccess,
      entitlements,
    });

    const res = await app.request("/v1/submissions/s-foreign/scores", {
      method: "POST",
      headers: asUser({ id: "judge-of-another-workshop", role: "JUDGE" }),
      body: JSON.stringify(validScores({ comment: "not my workshop" })),
    });

    expect(res.status).toBe(403);
    // Distinguishable from the other two refusals: this is an
    // authorization answer, not a data problem and not a brownout.
    expect(await res.json()).toEqual({
      error: "Forbidden: you are not judging this workshop",
      code: "WORKSHOP_NOT_ENTITLED",
    });
    // KEPT VERBATIM FROM THE DEFECT SPEC, inverted: no row against a foreign workshop's
    // deliverable, and no event for downstream consumers to act on.
    expect(scores.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
    // The scope decision DID consult something this time — the entitlement port, once,
    // with the caller's verified role and no subject parameter.
    expect(entitlements.calls).toEqual(["JUDGE"]);
    // And still nothing on the TEAM port: scoring is not membership, so the original
    // `toEqual([])` assertion survives the fix unchanged. It now proves the scope came
    // from the entitlement set rather than from a team predicate reused by accident.
    expect(teamAccess.predicates).toEqual([]);
  });

  it("FIXED: an ENTITLED judge still scores, and that is the other half of the fix", async () => {
    // The control for the spec above. Without it, "403" would be satisfied by a guard that
    // refuses everyone — which would pass the security assertion and break judging.
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    const entitlements = new FakeEntitlements(["w-mine"]);
    const { app } = build({
      submissions: new FakeSubmissions([
        submission({ id: "s-mine", teamId: "t-theirs", workshopId: "w-mine" }),
      ]),
      scores,
      events,
      // The Team context still refuses them everything — a judge is never a member of the
      // teams they judge, and that must not be what decides scoping.
      teamAccess: new FakeTeamAccess(false, false),
      entitlements,
    });

    const res = await app.request("/v1/submissions/s-mine/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(201);
    expect(scores.rows).toHaveLength(1);
    expect(events.published.map((e) => e.type)).toEqual(["submission.scored"]);
  });

  it("FIXED: Submission.workshopId is SERVER-DERIVED, and body.workshopId is IGNORED", async () => {
    // ── RE-POINTED. ──
    //
    // AS WRITTEN this asserted the DEFECT — `expect(submissions.rows[0].workshopId).toBe(
    // "w-i-picked-this")` — i.e. the caller wrote the field an authorization decision now
    // rests on (`workshopId: body.workshopId || null`, routes.ts:122). The server-derived-scope rule
    // requires it server-derived with `body.workshopId` ignored, and that rule's own words
    // are "a test posts a mismatched value and asserts the stored one came from the team".
    // That is this test, with the assertion inverted.
    const submissions = new FakeSubmissions([]);
    // The team the URL names belongs to w-from-the-team, whatever the body claims.
    const teamAccess = new FakeTeamAccess(true, true, "w-from-the-team");
    const { app } = build({ submissions, teamAccess });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      // Executive-only — see requireSubmissionDraftWrite. The rule under test
      // (workshopId is SERVER-DERIVED, body.workshopId ignored) is unchanged by who may call it.
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "Ours", workshopId: "w-i-picked-this" }),
    });

    expect(res.status).toBe(201);
    expect(submissions.rows[0].workshopId).toBe("w-from-the-team");
    // Not merely "different from the body" — the body value must appear NOWHERE on the row,
    // including in a field a future change might copy it into.
    expect(JSON.stringify(submissions.rows[0])).not.toContain("w-i-picked-this");  // nosemgrep: no-stringify-keys
  });

  it("FIXED: an UNSCOPED submission (workshopId null) is refused with SUBMISSION_SCOPE_UNKNOWN", async () => {
    // ── RE-POINTED. ──
    //
    // AS WRITTEN this asserted the DEFECT: 201, no such code anywhere, and the row scored
    // like any other. The scoping rule requires a DISTINCT code for a legacy null-scoped row
    // "so an operator can tell a data problem from an access problem at 3am".
    //
    // Such rows exist IN PRINCIPLE rather than in fact — the field was client-supplied and
    // defaulted to null until the server-derived scope landed, and the live table holds zero rows — which is
    // exactly why this is pinned: nothing in production will remind anyone.
    const scores = new FakeScores([]);
    const entitlements = new FakeEntitlements(["w1"]);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s-null", workshopId: null })]),
      scores,
      entitlements,
    });

    const res = await app.request("/v1/submissions/s-null/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "SUBMISSION_SCOPE_UNKNOWN",
    });
    expect(scores.rows).toHaveLength(0);
    // AND WITHOUT SPENDING THE HOP. A row with no workshop cannot be in anyone's
    // entitlement set, so asking would burn an east-west call to reach a foregone
    // conclusion — and would report the answer as WORKSHOP_NOT_ENTITLED, hiding a data
    // defect behind a permission message.
    expect(entitlements.calls).toEqual([]);
  });

  it("an ADMIN is REFUSED before the hop — the escape hatch was removed, not moved", async () => {
    // ⚠ THIS TEST'S OUTCOME WAS INVERTED, AND IT CONTRADICTS A DOCUMENTED CONDITION
    // ON PURPOSE. It used to assert 201, citing the original condition 2 verbatim: "ADMIN and
    // owner short-circuit before any hop, asserted by a test that fails if the injected
    // entitlement is called for either", and describing the admin as "the operator escape
    // hatch".
    //
    // The platform's rule changed underneath that condition: an ADMIN is now scoped to the
    // experiences they OWN, and scoring belongs to invited judges alone (SCORING_ROLES). The
    // submission below is deliberately in `w-not-theirs` — under the old condition an admin
    // wrote a score into a stranger's experience, which is exactly the cross-experience reach
    // the scoping change removed everywhere else. ⚠ THE ORIGINAL CONDITION 2 IS THEREFORE WRONG
    // AS WRITTEN for the scoring path, the same kind of superseded rule as re-scoring overwriting
    // a score. Annotated here rather than quietly diverged from.
    //
    // WHAT SURVIVES IS THE PART THAT WAS ACTUALLY ABOUT COST: the decision is still made
    // BEFORE any east-west call. The entitlement source would answer "unavailable" if asked,
    // so a non-empty `calls` array fails this test — the refusal is local, from the token
    // alone, and a Team brownout cannot turn it into a 503.
    const scores = new FakeScores([]);
    const entitlements = new FakeEntitlements("unavailable");
    const { app } = build({
      submissions: new FakeSubmissions([
        submission({ id: "s-any", workshopId: "w-not-theirs" }),
      ]),
      scores,
      teamAccess: new FakeTeamAccess(false, false),
      entitlements,
    });

    const res = await app.request("/v1/submissions/s-any/scores", {
      method: "POST",
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({ error: "Judge role required" });
    // NOTHING WRITTEN, and no hop spent finding that out.
    expect(scores.rows).toHaveLength(0);
    expect(entitlements.calls).toEqual([]);
  });

  it("FIXED: the entitlement hop FAILING is a 503, never a pass and never a 403", async () => {
    // The central rule, applied to the scoring path: "could not determine" must not
    // be returned as an answer. A judge told "not your workshop" mid-judging when the truth
    // is "Team is briefly unreachable" is the same defect as a 403 that says "not the
    // owner" when a probe has merely timed out.
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1", workshopId: "w1" })]),
      scores,
      events,
      entitlements: new FakeEntitlements("unavailable"),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "ENTITLEMENTS_UNAVAILABLE",
    });
    expect(res.headers.get("Retry-After")).toBe("2");
    // NOT A PASS: the score did not land and no consumer was told it did.
    expect(scores.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0-4 — the unauthorized score READ.
// ════════════════════════════════════════════════════════════════════════════

describe("RECON P0-4: GET /v1/submissions/:submissionId/scores", () => {
  it("FIXED: comments and numbers no longer reach a caller the Team context refuses", async () => {
    // The register's payload, named: "every judge's numeric scores and free-text
    // comments". Assert on the RAW body so a nested field cannot carry it through.
    const scores = new FakeScores([
      {
        submissionId: "s1",
        judgeId: "judge-1",
        innovation: 3,
        execution: 4,
        aiUsage: 5,
        impact: 2,
        presentation: 1,
        comment: "weakest entry in the room",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      scores,
      teamAccess: new FakeTeamAccess(false, false),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "stranger", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("weakest entry");
  });

  it("FIXED: it authorizes against the SUBMISSION's OWN team, not a caller-named one", async () => {
    // The rule that stops a guessed submission id resolving to a team the caller picked.
    const teamAccess = new FakeTeamAccess(true, true);
    const { app } = build({
      submissions: new FakeSubmissions([
        submission({ id: "s1", teamId: "the-real-team" }),
      ]),
      teamAccess,
    });

    const res = await app.request("/v1/submissions/s1/scores?teamId=my-own-team", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    /**
     * ⚠ 403 NOW, WAS 200 — AND THE PROPERTY THIS TEST GUARDS IS UNTOUCHED. It exists to prove the route
     * resolves the team from the STORED submission (`the-real-team`) and not from the caller's
     * `?teamId=my-own-team`, which is asserted by the predicate call below and still holds.
     *
     * The status changed because `/scores` now applies a payload rule AFTER the gate: judges' scores go
     * to ADMIN/FACILITATOR, a judge sees their own row, and a team member is refused. A PARTICIPANT
     * therefore passes team resolution and is then refused the body — which, if anything, makes the
     * caller-named-team attack even less interesting.
     */
    expect(res.status).toBe(403);
    // The ADMINISTRATION predicate, asked once — on the SUBMISSION's own team.
    expect(teamAccess.predicates).toEqual(["canRead"]);
  });

  it("FIXED: the judge who scored CAN now read the submission and the result", async () => {
    // ── RE-POINTED. THE SPEC PREDICTED ITS OWN FAILURE. ──
    //
    // AS WRITTEN this pinned the asymmetry as the CURRENT answer: a judge could POST a score
    // and got 403 on BOTH reads, because `requireTeamRead` refuses a judge on every team
    // (they are never members). Its own comment said "the read-widening rule requires both reads must widen to
    // `(team read) OR (scoring role AND entitled)` — undone work, not a regression, and this
    // spec fails when it lands." It landed; the two 403s are now 200s.
    //
    // The Team context STILL refuses this judge everything — that is the point. The read is
    // admitted by the entitlement branch, not by a loosened team predicate.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1", workshopId: "w-mine" })]),
      scores,
      teamAccess: new FakeTeamAccess(false, false),
      entitlements: new FakeEntitlements(["w-mine"]),
    });
    const judge = asUser({ id: "judge-1", role: "JUDGE" });

    const wrote = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: judge,
      body: JSON.stringify(validScores({ innovation: 7 })),
    });
    expect(wrote.status).toBe(201);

    const read = await app.request("/v1/submissions/s1/scores", { headers: judge });
    expect(read.status).toBe(200);
    // They can read the score they just wrote — the whole point of the widening.
    expect((await read.json()) as { scores: Score[] }).toMatchObject({
      scores: [{ judgeId: "judge-1", innovation: 7 }],
    });

    // And the submission they were meant to score is readable too.
    const detail = await app.request("/v1/submissions/s1", { headers: judge });
    expect(detail.status).toBe(200);
  });

  it("FIXED: the widening is bounded by ENTITLEMENT, not by role — a foreign judge still 403s", async () => {
    // The other half of the widening, and the reason it could not ship earlier: widening on a
    // SCORING ROLE ALONE would let any JUDGE read any workshop's deliberations, which is
    // the neighbouring P0-3 reopened on the read side. Same judge role, same refusing Team
    // context, different workshop — and the deliberations must not leak.
    const scores = new FakeScores([
      {
        submissionId: "s-foreign",
        judgeId: "their-judge",
        innovation: 2,
        execution: 2,
        aiUsage: 2,
        impact: 2,
        presentation: 2,
        comment: "weakest entry in the room",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({
      submissions: new FakeSubmissions([
        submission({ id: "s-foreign", workshopId: "w-theirs" }),
      ]),
      scores,
      teamAccess: new FakeTeamAccess(false, false),
      entitlements: new FakeEntitlements(["w-mine"]),
    });
    const judge = asUser({ id: "outside-judge", role: "JUDGE" });

    const read = await app.request("/v1/submissions/s-foreign/scores", { headers: judge });
    expect(read.status).toBe(403);
    // Assert on the RAW body: a nested field must not carry the comment through.
    expect(await read.text()).not.toContain("weakest entry");

    const detail = await app.request("/v1/submissions/s-foreign", { headers: judge });
    expect(detail.status).toBe(403);
  });
});
