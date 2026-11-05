import { ACTIVITY_EVENT_TYPES } from "@praimana/service-shared";
// ⚠ `@praimana/service-shared`, NOT `@praimana/shared`, AND THE DISTINCTION IS WHY THIS
// TEST WAS TESTING NOTHING. This repo's `shared` carries only the three-way intersection
// (phase-progress, support, types/user) — so importing this symbol from `@praimana/shared` resolved to
// `undefined` and the assertion degraded silently instead of erroring. The ROUTE imports it from
// `service-shared`, so the test must
// read the same source: a test asserting a limit from a different copy than the route enforces is a
// test that cannot fail when they disagree.
import { MAX_SCORE_COMMENT_CHARS } from "@praimana/service-shared";
import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createEvaluationRoutes, applyActivityEvent } from "./routes.js";
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
  TeamRoster,
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
 * Route + projection tests for the Evaluation service. Every repository, read-model
 * and the TeamAccess client are injected, so nothing here touches DynamoDB or the
 * Team service.
 *
 * Authentication runs through the real edgeIdentityMiddleware on the trusted internal
 * hop (x-internal-token + x-identity-*).
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
      | "unavailable" = { id: HOME_WORKSHOP, ownerId: "owner-1", status: "ACTIVE" }
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
  /**
   * ⚠ CONDITIONAL CREATE, MATCHED TO THE LIVE KEY SCHEMA — `submissionId` HASH + `judgeId` RANGE on
   * `praimana-scores`, verified against the deployed table rather than inferred from documentation.
   *
   * This fake used to `put` and UPSERT, faithfully mirroring the production write at the time. The
   * production write is now `attribute_not_exists(submissionId)`, so a second score from the same judge
   * is REFUSED rather than replacing the first — see the note on `ScoreRepository.create`, and the
   * note on the re-scoring test below for what that supersedes.
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
  /**
   * ⚠ CONDITIONAL ON THE ROW'S KEY, and the refusal is a VALUE — mirroring the store's
   * `attribute_not_exists` and `ScoreRepository.create`. A fake that pushed unconditionally would
   * model the ORIGINAL BUG (a fresh id per call, so a rater could write without limit) and let a
   * route that never handles the conflict pass every test.
   */
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
  increments: Array<{
    teamId: string;
    userId: string;
    counter: string;
    by?: number;
    /** Recorded so a test can prove the bus's event id REACHES the store — that id is the
     *  only thing standing between an at-least-once redelivery and a double count. */
    eventId?: string;
  }> = [];
  constructor(readonly rows: MemberActivity[] = []) {}
  async get(teamId: string, userId: string) {
    return this.rows.find((a) => a.teamId === teamId && a.userId === userId) ?? null;
  }
  async listByTeam(teamId: string) {
    return this.rows.filter((a) => a.teamId === teamId);
  }
  async upsert(activity: MemberActivity) {
    this.rows.push(activity);
  }
  async increment(
    teamId: string,
    userId: string,
    counter: keyof Omit<MemberActivity, "teamId" | "userId" | "updatedAt">,
    by?: number,
    eventId?: string
  ) {
    this.increments.push({ teamId, userId, counter, by, eventId });
  }
}

class FakeUsers implements UsersReadModel {
  private readonly rows = new Map<string, UserView>();
  constructor(views: UserView[] = []) {
    for (const v of views) this.rows.set(v.id, v);
  }
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

/** The default workshop every `submission()` below belongs to, and the one the default
 *  FakeEntitlements grants. Named so a test that means "a DIFFERENT workshop" says so. */
const HOME_WORKSHOP = "w1";

class FakeTeamAccess implements TeamAccess {
  /** Which team was asked about, with whose identity — the assertion target for
   *  "authorize against the SUBMISSION's own team", which is the rule that stops a
   *  guessed submission id from resolving to a team the caller picked. */
  calls: Array<{ teamId: string; userId: string; role: string }> = [];
  /**
   * WHICH PREDICATE each route asked for, in order — the drift assertion for the ONE
   * service that deliberately uses BOTH: submissions and scores stay on the wide
   * pair (a deliverable is judged by non-members), ratings/insights move to the content pair
   * (they are derived from the board, chat, AI threads and commits). A test that only checked
   * status codes could not tell the two apart, because in most cases both pairs agree.
   *
   * `writeScope` joined the union with BACKLOG P0-3. It IS the wide write pair — it returns
   * Team's `canWrite` — plus the team's workshop from the same hop, so a
   * route asking it is still on the administration side of the content/administration split, not the
   * content side. Recorded distinctly so the drift assertion can tell "asked for the write
   * decision AND the scope" from "asked for the write decision twice".
   */
  predicates: Array<
    "canRead" | "canWrite" | "canReadContent" | "canWriteContent" | "writeScope"
  > = [];
  constructor(
    private readonly reads = true,
    private readonly writes = true,
    // Default to the wide pair so every pre-existing test keeps its original meaning.
    private readonly contentReads = reads,
    private readonly contentWrites = writes,
    /**
     * What `writeScope` answers on top of the write decision. Defaults to the home
     * workshop so every pre-existing POST-submissions test keeps its original meaning:
     * before P0-3 the field was `body.workshopId || null`, and those tests were about
     * status/DRAFT/createdById, not about the scope.
     *
     * `"unavailable"` here is the Team-brownout case; `null` is "the team has no workshop".
     */
    private readonly scope: string | null | "unavailable" = HOME_WORKSHOP
  ) {}
  async canRead(teamId: string, userId: string, role: string) {
    this.calls.push({ teamId, userId, role });
    this.predicates.push("canRead");
    return this.reads;
  }
  async canWrite(teamId: string, userId: string, role: string) {
    this.calls.push({ teamId, userId, role });
    this.predicates.push("canWrite");
    return this.writes;
  }
  async canReadContent(teamId: string, userId: string, role: string) {
    this.calls.push({ teamId, userId, role });
    this.predicates.push("canReadContent");
    return this.contentReads;
  }
  async canWriteContent(teamId: string, userId: string, role: string) {
    this.calls.push({ teamId, userId, role });
    this.predicates.push("canWriteContent");
    return this.contentWrites;
  }
  async writeScope(teamId: string, userId: string, role: string) {
    this.calls.push({ teamId, userId, role });
    this.predicates.push("writeScope");
    if (this.scope === "unavailable") return "unavailable" as const;
    return { canWrite: this.writes, workshopId: this.scope };
  }
}

/**
 * The judge-scoping entitlement source (BACKLOG P0-3).
 *
 * COUNTS ITS CALLS, because two of the required properties are about the ABSENCE of a call:
 * an ADMIN must short-circuit before the hop, and a null-scoped
 * submission must be refused without spending one. A test asserting only status codes cannot
 * see either.
 */
class FakeEntitlements implements WorkshopEntitlements {
  calls: string[] = [];
  constructor(
    private readonly workshopIds: string[] | "unavailable" = [HOME_WORKSHOP],
    private readonly truncated = false
  ) {}
  async listEntitledWorkshopIds(role: string) {
    this.calls.push(role);
    if (this.workshopIds === "unavailable") return "unavailable" as const;
    return { workshopIds: this.workshopIds, truncated: this.truncated };
  }
}

// ─── Builders ───────────────────────────────────────────────────────────────

const submission = (over: Partial<Submission> = {}): Submission => ({
  teamId: "t1",
  id: "s1",
  workshopId: "w1",
  status: "DRAFT",
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

/**
 * A RELEASED submission — the only kind that can be scored.
 *
 * ⚠ THE DEFAULT BUILDER ABOVE IS `DRAFT`, AND STAYS THAT WAY, because a freshly created submission
 * IS a draft and most tests are about that. Scoring tests must opt in to a released one, which is
 * the point: a test that forgets now gets a 409 rather than silently scoring an unreleased draft.
 */
const released = (over: Partial<Submission> = {}): Submission =>
  submission({ status: "SUBMITTED", ...over });

/**
 * A complete, valid set of the five criteria.
 *
 * ⚠ EVERY CRITERION IS NOW REQUIRED, so bodies that used to send `{ innovation: 5 }` alone are a
 * `400 SCORE_OUT_OF_RANGE` naming the other four. Tests that care about authorization rather than
 * validation spread this so they exercise the gate they are actually about.
 */
/** A stored `Score` row, for tests about who may READ scores rather than how they are written. */
const scoreRow = (over: Partial<Score> = {}): Score => ({
  submissionId: "s1",
  judgeId: "judge-1",
  innovation: 8,
  execution: 7,
  aiUsage: 9,
  impact: 6,
  presentation: 5,
  comment: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/**
 * A valid scoring body. FOUR criteria since `aiUsage` was dropped — it had become a
 * criterion with nothing to judge from, because the narrative it scored had come off the submission
 * form.
 */
const validScores = (over: Record<string, unknown> = {}) => ({
  innovation: 8,
  execution: 7,
  impact: 6,
  presentation: 5,
  ...over,
});

const activityRow = (over: Partial<MemberActivity> = {}): MemberActivity => ({
  teamId: "t1",
  userId: "u1",
  tasksCreated: 0,
  tasksCompleted: 0,
  messagesSent: 0,
  commitsPushed: 0,
  aiThreadsShared: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/**
 * Answers "is this person on the team?" — the roster port the rating route consults.
 *
 * ⚠ PERMISSIVE BY DEFAULT, AND ONLY BECAUSE THE ROUTE FAILS CLOSED WITHOUT IT. `deps.roster` is
 * optional and its absence is a 503, so a fake that defaulted to refusing would make every
 * pre-existing rating test assert a refusal and say nothing about what it was written to check
 * (clamping, attribution, events). Tests that care about the roster set `members` explicitly.
 */
class FakeRoster implements TeamRoster {
  /** Every isActiveMember call, so a test can assert the route asked at all. */
  readonly calls: Array<{ teamId: string; userId: string }> = [];
  constructor(
    private readonly members: readonly string[] | "all" = "all",
    private readonly failing = false
  ) {}
  async isActiveMember(
    teamId: string,
    userId: string
  ): Promise<boolean | "unavailable"> {
    this.calls.push({ teamId, userId });
    if (this.failing) return "unavailable";
    return this.members === "all" ? true : this.members.includes(userId);
  }
}

function build(
  over: Partial<{
    /**
     * ⚠ `null` MEANS "NOT WIRED", which is a distinct case from "not overridden". The route FAILS
     * CLOSED without the port, and `undefined` cannot express that here because it is what
     * "use the default" already means.
     */
    roster: FakeRoster | null;
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
    ...(over.roster === null ? {} : { roster: over.roster ?? new FakeRoster() }),
    workshops: over.workshops ?? new FakeWorkshops(),
    results: over.results ?? new FakeResults(),
    scores: over.scores ?? new FakeScores([]),
    ratings: over.ratings ?? new FakeRatings([]),
    activity: over.activity ?? new FakeActivity([]),
    users: over.users ?? new FakeUsers([]),
    teamAccess: over.teamAccess ?? new FakeTeamAccess(true, true),
    // Entitled to the home workshop by default, so a pre-existing test about a JUDGE
    // scoring `submission()` (which is in w1) keeps meaning what it meant.
    entitlements: over.entitlements ?? new FakeEntitlements([HOME_WORKSHOP]),
    events: over.events ?? new InMemoryPublisher(),
  };
  return { app: createEvaluationRoutes(deps), deps };
}

// ─── Authorization coverage ─────────────────────────────────────────────────

describe("authorization coverage", () => {
  const teamRoutes = [
    { name: "GET submissions", method: "GET", path: "/v1/teams/t1/submissions", write: false },
    /**
     * ⚠ `executiveOnly` MARKS THE INVERSION (only executives submit).
     * This route used to be in the read-only-EXECUTIVE table below like every other write. It is now the
     * opposite: an executive is the ONLY role that may call it, and a PARTICIPANT is refused. It is
     * excluded from that loop and covered by its own describe — see "the draft is executive-only".
     */
    { name: "POST submissions", method: "POST", path: "/v1/teams/t1/submissions", write: true, executiveOnly: true, body: {} },
    { name: "GET ratings", method: "GET", path: "/v1/teams/t1/ratings", write: false },
    { name: "POST ratings", method: "POST", path: "/v1/teams/t1/ratings", write: true, body: { ratedUserId: "u2" } },
  ];

  for (const r of teamRoutes) {
    it(`${r.name} requires authentication`, async () => {
      const { app } = build();
      const res = await app.request(r.path, {
        method: r.method,
        body: r.body ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(401);
    });

    it(`${r.name} 403s a caller the Team context refuses`, async () => {
      const { app } = build({ teamAccess: new FakeTeamAccess(false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        // The executive-only write is refused for its ROLE before membership is even asked, so it is
        // exercised as an executive here — the point of this loop is "a refused caller gets 403",
        // and for that route the refusal being tested is the membership one.
        headers: asUser({
          id: "outsider",
          role: "executiveOnly" in r ? "EXECUTIVE" : "PARTICIPANT",
        }),
        body: r.body ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });
  }

  for (const r of teamRoutes.filter((x) => x.write && !("executiveOnly" in x))) {
    it(`${r.name} 403s a read-only EXECUTIVE and writes nothing`, async () => {
      const submissions = new FakeSubmissions([]);
      const ratings = new FakeRatings([]);
      const events = new InMemoryPublisher();
      const { app } = build({ submissions, ratings, events });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify(r.body),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Read-only role" });
      expect(submissions.rows).toHaveLength(0);
      expect(ratings.rows).toHaveLength(0);
      expect(events.published).toHaveLength(0);
    });
  }

  // ── THE SPLIT, AND THIS SERVICE IS THE ONE THAT USES BOTH ───────
  //
  // SUBMISSIONS AND SCORES STAY WIDE. A submission is a DELIVERABLE — the team hands it over
  // to be judged, and the people who judge it are by definition not members. Narrowing these
  // would 403 the workshop owner out of the deliverables of the workshop they are running,
  // which is not what "team content is private" means.
  //
  // RATINGS/INSIGHTS MOVE NARROW, because they are not a deliverable: contributionScore is
  // computed from messagesSent, aiThreadsShared, tasksCompleted, tasksCreated and
  // commitsPushed, so leaving them wide would publish a NUMERIC SHADOW of the chat and board
  // that were just made private — per named person. peerRatings is worse still: teammates'
  // free-text opinions of each other.
  //
  // The predicate a route ASKS FOR is asserted, not just the status it returns, because in
  // most cases both pairs agree and a mis-wired route would look identical.

  // ⚠ POST submissions ASKS `writeScope` SINCE BACKLOG P0-3, NOT `canWrite`, and this
  // table was updated rather than the guard relaxed. `writeScope` IS the wide write
  // predicate — it returns Team's own `canWrite` — plus the team's workshop from the SAME
  // east-west hop, which is what makes `Submission.workshopId` server-derived at no extra
  // hop. So the route is still on the ADMINISTRATION side of the content/administration
  // split, which is the property this block exists to pin; what it asks for is strictly
  // MORE than before, never the content pair. The `toEqual` below is exact, so a route that
  // asked BOTH canWrite and writeScope (a doubled hop) would still fail here.
  const WIDE_ROUTES = [
    { name: "GET submissions", method: "GET", path: "/v1/teams/t1/submissions", predicate: "canRead" },
    /**
     * ⚠ TWO PREDICATES NOW, IN ORDER, and that is not a doubled hop by accident. Since the write became
     * executive-only, `requireSubmissionDraftWrite` asks `writeScope` FIRST — it is the only predicate that
     * can answer "unavailable", so it is what preserves the 503 on a Team brownout (and it supplies the
     * team's WORKSHOP, stored on the row) — and THEN `canReadContent` for membership, which `writeScope`'s
     * `canWrite` cannot answer (it conflates membership with the read-only rule and is false for an
     * executive either way).
     *
     * ⚠ THE ORDER IS THE ASSERTION. Asking membership first would make a brownout look like
     * "you are not a member of this team" — see the guard's own note. The exact `toEqual` also stops a
     * third hop creeping in.
     */
    { name: "POST submissions", method: "POST", path: "/v1/teams/t1/submissions", predicate: ["writeScope", "canReadContent"], role: "EXECUTIVE", body: {} },
  ];
  const CONTENT_ROUTES = [
    { name: "GET ratings", method: "GET", path: "/v1/teams/t1/ratings", predicate: "canReadContent" },
    { name: "POST ratings", method: "POST", path: "/v1/teams/t1/ratings", predicate: "canWriteContent", body: { ratedUserId: "u2" } },
  ];

  for (const r of [...WIDE_ROUTES, ...CONTENT_ROUTES]) {
    const expected = Array.isArray(r.predicate) ? r.predicate : [r.predicate];
    it(`${r.name} asks ${expected.join(" then ")} and nothing else`, async () => {
      const teamAccess = new FakeTeamAccess(true, true);
      const { app } = build({ teamAccess });

      await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", role: "role" in r ? (r.role as string) : "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(teamAccess.predicates).toEqual(expected);
    });
  }

  for (const r of CONTENT_ROUTES) {
    it(`${r.name} 403s a non-member ADMIN — the insights are derived from private content`, async () => {
      // Wide true, content false: exactly what the Team service answers for a non-member
      // ADMIN or a workshop-owning FACILITATOR.
      const ratings = new FakeRatings([]);
      const events = new InMemoryPublisher();
      const { app } = build({
        ratings,
        events,
        teamAccess: new FakeTeamAccess(true, true, false, false),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "admin", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
      expect(ratings.rows).toHaveLength(0);
      expect(events.published).toHaveLength(0);
    });

    it(`${r.name} 403s when the Team service cannot answer (fail-closed)`, async () => {
      const { app } = build({ teamAccess: new FakeTeamAccess(false, false, false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });
  }

  /**
   * ⚠ THE READS ONLY, SINCE THE WRITE BECAME EXECUTIVE-ONLY.
   *
   * "a deliverable is not private content" is still exactly right for READING one: a workshop owner must
   * see the submissions of the workshop they run, and narrowing that would lock them out. But an ADMIN
   * may no longer CREATE a team's draft — only executives submit — so POST is
   * excluded here and its refusal is asserted in "the draft is executive-only" instead.
   *
   * ⚠ Filtered by `predicate`-is-a-read rather than by name, so a future wide READ route joins this loop
   * automatically and a future wide WRITE cannot be swept in by accident.
   */
  for (const r of WIDE_ROUTES.filter((x) => x.method === "GET")) {
    it(`${r.name} STILL SERVES a non-member ADMIN — a deliverable is not private content`, async () => {
      // The half that must not narrow. If this ever 403s, the workshop owner has been locked
      // out of the submissions of the workshop they are running.
      const submissions = new FakeSubmissions([submission()]);
      const { app } = build({
        submissions,
        teamAccess: new FakeTeamAccess(true, true, false, false),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "admin", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBeLessThan(300);
    });
  }

  it("GET /submissions/:id and its /scores sibling stay WIDE", async () => {
    // Both resolve the team from the stored record and then apply the ADMINISTRATION
    // predicate. A JUDGE is unaffected either way: canRead already returned false for them on
    // every team before this change, which is the asymmetry documented at the scores route —
    // the content/administration split does not touch judging.
    const submissions = new FakeSubmissions([submission({ id: "s1" })]);
    const teamAccess = new FakeTeamAccess(true, true, false, false);
    const { app } = build({ submissions, teamAccess });

    const detail = await app.request("/v1/submissions/s1", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });
    const scores = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    /**
     * ⚠ THE TWO SIBLINGS NO LONGER AGREE, AND THAT IS THE POINT OF THE OWNERSHIP RULE. The bare
     * submission read stays WIDE — an admin passing `canRead` gets it. `/scores` is now narrower than
     * its sibling: judges' deliberations go to the experience's OWNER, and this admin does not own
     * `w1` (the directory fake answers `ownerId: "owner-1"`).
     *
     * The GATE is unchanged and is what this test is really about — both routes still resolve the team
     * from the stored record and apply the ADMINISTRATION predicate, asserted below.
     */
    expect(detail.status).toBe(200);
    expect(scores.status).toBe(403);
    expect(teamAccess.predicates).toEqual(["canRead", "canRead"]);
  });

  it("does not leak a contribution SCORE or a peer rating to a non-member ADMIN", async () => {
    // The disclosure in its concrete form: a status code alone does not prove the numbers
    // stayed behind.
    const activity = new FakeActivity([
      activityRow({ userId: "u1", messagesSent: 42, aiThreadsShared: 7 }),
    ]);
    const ratings = new FakeRatings([
      {
        teamId: "t1",
        id: "r1",
        raterId: "u1",
        ratedUserId: "u2",
        score: 30,
        comment: "carried by the others",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({
      activity,
      ratings,
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("42");
    expect(text).not.toContain("carried by the others");
  });

  it("GET /submissions/:id authorizes against the SUBMISSION's own team", async () => {
    // The teamId is resolved from the stored record, never taken from the request.
    // A submission id is guessable/shareable, so this is the only thing standing
    // between an outsider and another team's full write-up.
    const submissions = new FakeSubmissions([submission({ teamId: "t-secret", id: "s1" })]);
    const { app } = build({ submissions, teamAccess: new FakeTeamAccess(false, false) });

    const res = await app.request("/v1/submissions/s1", {
      headers: asUser({ id: "outsider", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
  });

  it("GET /submissions/:id 404s an unknown id BEFORE any access check", async () => {
    // Order matters only in that a missing submission has no team to check; the
    // response is the same 404 whether or not the caller would have been allowed.
    const { app } = build({ teamAccess: new FakeTeamAccess(false, false) });
    const res = await app.request("/v1/submissions/nope", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET /submissions/:id returns the record to an authorized reader", async () => {
    const submissions = new FakeSubmissions([submission({ id: "s1", title: "Ours" })]);
    const { app } = build({ submissions });
    const res = await app.request("/v1/submissions/s1", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { submission: Submission }).toMatchObject({
      submission: { id: "s1", title: "Ours" },
    });
  });

  it("POST /submissions/:id/scores is role-gated, not team-gated", async () => {
    // A judge is not a member of the teams they score, so a TeamAccess that refuses
    // everything must NOT block scoring.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
      teamAccess: new FakeTeamAccess(false, false),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(201);
    expect(scores.rows).toHaveLength(1);
  });

  it("POST /submissions/:id/scores 403s a PARTICIPANT even on their own team", async () => {
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      scores,
      teamAccess: new FakeTeamAccess(true, true),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ innovation: 5 }),
    });

    // Self-scoring is the obvious abuse this guard exists for.
    expect(res.status).toBe(403);
    expect(scores.rows).toHaveLength(0);
  });

  // ── GET /submissions/:id/scores — P0-4, no authorization at all ───────────

  it("GET /submissions/:id/scores 403s a caller the Team context refuses", async () => {
    // The hole: this route had NO authorization whatsoever. Any signed-in user could
    // read every judge's numeric scores AND free-text comments for any submission id,
    // including mid-judging — the deliberations, not just the outcome. Its sibling at
    // GET /submissions/:id was already gated; this one was missed.
    const submissions = new FakeSubmissions([submission({ teamId: "t-secret", id: "s1" })]);
    const scores = new FakeScores([
      {
        submissionId: "s1",
        judgeId: "judge-1",
        innovation: 3,
        execution: 3,
        aiUsage: 3,
        impact: 3,
        presentation: 3,
        comment: "weakest of the cohort, would not fund",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({ submissions, scores, teamAccess: new FakeTeamAccess(false, false) });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "outsider", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    // The comment is the most damaging part of the payload — assert on the raw body so
    // no future response shape can smuggle it through a field this test doesn't read.
    expect(await res.text()).not.toContain("would not fund");
  });

  it("GET /submissions/:id/scores requires authentication", async () => {
    const { app } = build({ submissions: new FakeSubmissions([submission({ id: "s1" })]) });
    const res = await app.request("/v1/submissions/s1/scores");
    expect(res.status).toBe(401);
  });

  it("GET /submissions/:id/scores authorizes against the SUBMISSION's own team", async () => {
    // The teamId comes from the stored record, never from the request — a submission id
    // is guessable and shareable, so the record's own team is the only sound basis.
    const teamAccess = new FakeTeamAccess(true, true);
    const submissions = new FakeSubmissions([submission({ teamId: "t-owning", id: "s1" })]);
    const { app } = build({ submissions, teamAccess });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    // ⚠ 403 NOW, WAS 200. The GATE still runs and is still what this test is about — the assertions
    // below on which predicate was consulted are unchanged. What changed is the PAYLOAD rule after
    // it: judges' scores go to ADMIN/FACILITATOR, a judge sees only their own row, and a team
    // member is refused. See the note on the route.
    expect(res.status).toBe(403);
    expect(teamAccess.calls).toEqual([{ teamId: "t-owning", userId: "u1", role: "PARTICIPANT" }]);
  });

  it("GET /submissions/:id/scores 404s an unknown submission", async () => {
    const { app } = build({ teamAccess: new FakeTeamAccess(false, false) });
    const res = await app.request("/v1/submissions/nope/scores", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * ⚠ WAS "returns the scores to an authorized team reader", asserting a PARTICIPANT received every
   * judge's row INCLUDING the comment. That is the subject of an assessment reading its assessors'
   * private deliberations, and it is what the judging LIST route already refuses — reducing to the
   * caller's own row because "mid-judging disclosure is the P0-4 defect". The detail read handed over
   * what the list withheld.
   *
   * THE RULE: ADMIN/FACILITATOR see every judge's scores; a JUDGE sees only their own;
   * anyone else is refused. All three are asserted here.
   */
  it("GET /submissions/:id/scores refuses a team member outright", async () => {
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const scores = new FakeScores([
      {
        submissionId: "s1",
        judgeId: "judge-1",
        innovation: 8,
        execution: 7,
        aiUsage: 9,
        impact: 6,
        presentation: 5,
        comment: "strong demo",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({ submissions, scores });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SCORES_NOT_VISIBLE");
  });

  it("GET /submissions/:id/scores gives the experience's OWNER every judge's row", async () => {
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const scores = new FakeScores([
      scoreRow({ judgeId: "judge-1", comment: "strong demo" }),
      scoreRow({ judgeId: "judge-2", comment: "weak on impact" }),
    ]);
    const { app } = build({
      submissions,
      scores,
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scores: Score[] };
    expect(body.scores.map((s) => s.judgeId)).toEqual(["judge-1", "judge-2"]);
  });

  /**
   * ⚠ BY OWNERSHIP, NOT BY ROLE — the pair below is the whole rule. Only the experience's
   * owner sees all judges' scores; an ADMIN who created the experience is its owner, and an ADMIN sees
   * no other experiences, scores or data. A role check showed every judge's private comments to any facilitator on
   * the platform, and to an admin with nothing to do with the experience.
   */
  it("GET /submissions/:id/scores refuses a FACILITATOR who does not own the experience", async () => {
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const { app } = build({
      submissions,
      scores: new FakeScores([scoreRow({ judgeId: "judge-1", comment: "strong demo" })]),
      workshops: new FakeWorkshops({
        id: HOME_WORKSHOP,
        ownerId: "someone-else",
        status: "ACTIVE",
      }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SCORES_NOT_VISIBLE");
  });

  /**
   * ── ⚠ THE TEAM'S EXECUTIVE ──────────────────────────────────────────────────────────────────
   *
   * THE RULE: of the team, only its EXECUTIVE reads the judges' scoring. It closes a gap the
   * ownership narrowing created and nobody had decided: with the team-read branch removed, **a team
   * had no route to judge feedback at all** — the comments were written about them and they could not
   * read a word.
   *
   * The four tests below are one rule, and the last two are the ones that keep it honest.
   */
  it("GET /submissions/:id/scores gives the team's EXECUTIVE the scores and comments", async () => {
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const scores = new FakeScores([
      scoreRow({ judgeId: "judge-1", comment: "strong demo" }),
      scoreRow({ judgeId: "judge-2", comment: "thin on testing" }),
    ]);
    // `canRead` true = a member of t1, which for an EXECUTIVE is the only way `canRead` says yes.
    const { app } = build({
      submissions,
      scores,
      teamAccess: new FakeTeamAccess(true, false),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "exec-1", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scores: Array<Record<string, unknown>> };
    expect(body.scores).toHaveLength(2);
    // The feedback itself arrives — that is the entire point of the grant.
    expect(body.scores.map((r) => r.comment)).toEqual(["strong demo", "thin on testing"]);
  });

  it("⚠ STRIPS judgeId FOR THE EXECUTIVE — feedback, not attribution", async () => {
    // WHICH judge said what is not feedback, it is attribution. Handing a team the mapping turns the
    // judged into judges of the judges, and on an experience with a handful of judges an executive
    // could deanonymise every comment against the invitation list they can already see. Asserted on
    // the key set, so a future field that reintroduces the link fails here.
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]),
      scores: new FakeScores([scoreRow({ judgeId: "judge-1", comment: "strong demo" })]),
      teamAccess: new FakeTeamAccess(true, false),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "exec-1", role: "EXECUTIVE" }),
    });

    const [row] = ((await res.json()) as { scores: Array<Record<string, unknown>> }).scores;
    expect(Object.keys(row)).not.toContain("judgeId");
    expect(row.comment).toBe("strong demo");
    // And the scoring numbers survive — stripping attribution must not strip the substance.
    expect(row.innovation).toBeDefined();
  });

  it("⚠ REFUSES AN EXECUTIVE WHO IS NOT ON THE TEAM — at the gate, before this branch", async () => {
    /**
     * THE TEST THAT MAKES THE BRANCH SAFE. The handler does NOT re-check membership: it relies on
     * `requireSubmissionRead` having already run `teamAccess.canRead(submission.teamId, …)`, which for
     * an EXECUTIVE is membership alone. That is a real dependency between two functions, so it is
     * pinned from the outside — if the gate ever admits an executive on some other basis, this fails
     * rather than the grant silently widening to every executive on the platform.
     */
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]),
      scores: new FakeScores([scoreRow({ judgeId: "judge-1", comment: "strong demo" })]),
      // Not a member, and not entitled either.
      teamAccess: new FakeTeamAccess(false, false),
      entitlements: new FakeEntitlements([]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "exec-9", role: "EXECUTIVE" }),
    });

    expect(res.status).toBe(403);
  });

  it("⚠ STILL REFUSES A PARTICIPANT ON THE SAME TEAM — \"only executive\" is the rule", async () => {
    // The narrowness is the decision. A participant is on the team, passes the same `canRead` gate,
    // and gets nothing — so the grant cannot be read as "the team can see its feedback".
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]),
      scores: new FakeScores([scoreRow({ judgeId: "judge-1", comment: "strong demo" })]),
      teamAccess: new FakeTeamAccess(true, false),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "p-1", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("SCORES_NOT_VISIBLE");
  });

  it("GET /submissions/:id/scores gives an ADMIN every row when they OWN the experience", async () => {
    // An ADMIN who created the experience owns it, and is running it.
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const { app } = build({
      submissions,
      scores: new FakeScores([scoreRow({ judgeId: "judge-1" })]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "admin-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { scores: Score[] }).scores).toHaveLength(1);
  });

  it("GET /submissions/:id/scores refuses an ADMIN who does not own the experience", async () => {
    // An ADMIN sees no experiences, scores or data other than their own — the platform role is not a
    // licence to read another owner's deliberations.
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const { app } = build({
      submissions,
      scores: new FakeScores([scoreRow({ judgeId: "judge-1", comment: "strong demo" })]),
      workshops: new FakeWorkshops({
        id: HOME_WORKSHOP,
        ownerId: "someone-else",
        status: "ACTIVE",
      }),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json()), "no comment leaks in the refusal").not.toContain(
      "strong demo"
    );
  });

  it("GET /submissions/:id/scores is 503, never 403, when the experience cannot be resolved", async () => {
    // A directory that could not answer must not be reported as "you may not".
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const { app } = build({
      submissions,
      scores: new FakeScores([scoreRow({ judgeId: "judge-1" })]),
      workshops: new FakeWorkshops("unavailable"),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("WORKSHOP_UNAVAILABLE");
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  it("GET /submissions/:id/scores gives a JUDGE their OWN row and no other", async () => {
    // The panel reads this to show a judge what they submitted. One row is all it needs, and all they
    // are entitled to: another judge's numbers and comments are deliberations, not their business.
    const submissions = new FakeSubmissions([submission({ id: "s1", teamId: "t1" })]);
    const scores = new FakeScores([
      scoreRow({ judgeId: "judge-1", comment: "mine" }),
      scoreRow({ judgeId: "judge-2", comment: "someone else's" }),
    ]);
    const { app } = build({ submissions, scores });

    const res = await app.request("/v1/submissions/s1/scores", {
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scores: Score[] };
    expect(body.scores.map((s) => s.judgeId)).toEqual(["judge-1"]);
    expect(JSON.stringify(body), "no trace of another judge's comment").not.toContain(
      "someone else's"
    );
  });
});

// ─── Submissions ────────────────────────────────────────────────────────────

describe("POST /v1/teams/:teamId/submissions", () => {
  it("forces status DRAFT and submittedAt null regardless of the body", async () => {
    // Submitting is a separate transition. If a client could POST
    // status: "SUBMITTED" it would bypass whatever gating the submit flow applies.
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ status: "SUBMITTED", submittedAt: "2026-01-01T00:00:00.000Z" }),
    });

    expect(submissions.rows[0]).toMatchObject({ status: "DRAFT", submittedAt: null });
  });

  it("stamps createdById from the identity and teamId from the URL", async () => {
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "real-user", role: "EXECUTIVE" }),
      body: JSON.stringify({ createdById: "someone-else", teamId: "t-other" }),
    });

    expect(submissions.rows[0]).toMatchObject({ createdById: "real-user", teamId: "t1" });
  });

  it("normalises every absent optional field to null, not undefined", async () => {
    // These rows go straight into DynamoDB; an explicit null is a stored attribute,
    // whereas undefined is dropped by removeUndefinedValues and the field then reads
    // back as missing. The API contract is "present and null".
    //
    // ⚠ `workshopId` WAS IN THIS LIST AND WAS REMOVED FROM IT BY BACKLOG P0-3, deliberately.
    // It is no longer an optional field the body may omit — it is SERVER-DERIVED from the
    // team, so on this route it is always a real workshop id and never
    // null. The route cannot even reach the write with a null scope: an unresolvable team
    // is a 404 and an unanswerable hop is a 503, both asserted below, precisely so that a
    // null-scoped (permanently unscoreable) row cannot be created. Asserting `null` here
    // would now be asserting the defect the server-derived scope closed.
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({}),
    });

    const row = submissions.rows[0] as unknown as Record<string, unknown>;
    for (const field of [
      "title",
      "summary",
      "problemStatement",
      "solution",
      "demoUrl",
      "videoUrl",
      "repoUrl",
      "slidesUrl",
      "aiUsageSummary",
    ]) {
      expect(row[field]).toBeNull();
    }
    // The field that left the list is still asserted, in the opposite direction: PRESENT
    // and derived, so removing it from the loop cannot silently drop it from coverage.
    expect(row.workshopId).toBe(HOME_WORKSHOP);
  });

  it("publishes submission.created", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ id: "s-explicit" }),
    });

    expect(res.status).toBe(201);
    expect(events.published).toEqual([
      {
        source: "evaluation-service",
        type: "submission.created",
        detail: { teamId: "t1", submissionId: "s-explicit", createdById: "u1" },
      },
    ]);
  });

  // ─── One submission per team ──────────────────────

  it("a second create returns the EXISTING submission with 200, not a new one", async () => {
    const submissions = new FakeSubmissions([]);
    const events = new InMemoryPublisher();
    const { app } = build({ submissions, events });

    const first = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "First" }),
    });
    expect(first.status).toBe(201);
    const created = ((await first.json()) as { submission: Submission }).submission;

    // A DIFFERENT teammate ensuring a draft exists — the case the desktop and the portal both hit.
    const second = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u2", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "Second" }),
    });

    // ⚠ 200, NOT 201 AND NOT 409. The caller's intent ("this team should have a draft") is
    // satisfied; the status carries the difference for anyone who cares.
    expect(second.status).toBe(200);
    const returned = ((await second.json()) as { submission: Submission }).submission;
    expect(returned.id, "the loser is told the WINNER's id").toBe(created.id);
    expect(returned.title, "and the winner's content — not the loser's body").toBe("First");

    expect(submissions.rows, "exactly one submission for the team").toHaveLength(1);
    expect(await submissions.pointer("t1")).toBe(created.id);

    // ⚠ ONE EVENT, NOT TWO. `submission.created` fires per SUBMISSION, not per attempt — a
    // consumer counting them would over-count every re-ensure.
    expect(events.published).toHaveLength(1);
  });

  it("refuses a caller-supplied reserved id", async () => {
    // `#pointer` shares the team's partition, and `byId` is HASH-on-id read with Limit 1 — a
    // submission carrying that id would make `getById` return an arbitrary team's record, which
    // every authorization decision here reads.
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ id: "#pointer" }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("RESERVED_ID");
    expect(submissions.rows).toHaveLength(0);
  });

  it("refuses ANY id in the reserved namespace, not just the one sentinel", async () => {
    const { app } = build({ submissions: new FakeSubmissions([]) });
    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ id: "#anything-else" }),
    });
    expect(res.status).toBe(400);
  });

  it("the team's list never contains the pointer row", async () => {
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({}),
    });

    const res = await app.request("/v1/teams/t1/submissions", {
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
    });
    const listed = ((await res.json()) as { submissions: Submission[] }).submissions;

    expect(listed).toHaveLength(1);
    expect(listed.some((s) => s.id.startsWith("#"))).toBe(false);
  });
});

// ─── Release ──────────────────────────────────────────────

describe("POST /v1/teams/:teamId/submissions/:id/release", () => {
  /** A draft that satisfies P4, so each test spoils exactly one precondition. */
  const releasable = (over: Partial<Submission> = {}) =>
    submission({ id: "s1", demoUrl: "https://demo.example/team", ...over });

  const exec = { id: "exec-1", role: "EXECUTIVE" };

  it("a PARTICIPANT gets 403 EXECUTIVE_ONLY, and NO east-west hop is made", async () => {
    const teamAccess = new FakeTeamAccess(true, true);
    const docs = new FakeDocs();
    const phases = new FakePhases();
    const submissions = new FakeSubmissions([releasable()]);
    const { app } = build({ submissions, teamAccess, docs, phases });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("EXECUTIVE_ONLY");
    // ⚠ THE ORDERING IS THE ASSERTION. Local role check first: no membership probe, and neither
    // content hop.
    expect(teamAccess.predicates).toEqual([]);
    expect(docs.calls).toEqual([]);
    expect(phases.calls).toEqual([]);
    expect(submissions.rows[0].status).toBe("DRAFT");
  });

  it("an ADMIN is refused too — there is no break-glass release", async () => {
    const { app } = build({ submissions: new FakeSubmissions([releasable()]) });
    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("EXECUTIVE_ONLY");
  });

  it("an EXECUTIVE who is not a member gets 403 NOT_A_TEAM_MEMBER", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const { app } = build({
      submissions,
      // Content predicate false — releasing publishes team content, so membership is the gate.
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_A_TEAM_MEMBER");
    expect(submissions.rows[0].status).toBe("DRAFT");
  });

  it("zero artifacts is NO_ARTIFACTS, distinguishable from a missing demo URL", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const { app } = build({ submissions, docs: new FakeDocs([]) });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("NO_ARTIFACTS");
    // Documents carry no phase attribution, so the copy must not claim a build check.
    expect(body.error).toMatch(/desktop app/i);
    expect(body.error).not.toMatch(/build phase/i);
    expect(submissions.rows[0].status).toBe("DRAFT");
  });

  it("artifacts but no demo URL is NO_DEMO_URL", async () => {
    const submissions = new FakeSubmissions([releasable({ demoUrl: null })]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("NO_DEMO_URL");
  });

  it("http://, javascript: and non-URLs all fail P4", async () => {
    for (const demoUrl of [
      "http://demo.example",
      "javascript:alert(1)",
      "coming soon",
      "ftp://files.example/demo",
      "",
    ]) {
      const submissions = new FakeSubmissions([releasable({ demoUrl })]);
      const { app } = build({ submissions });

      const res = await app.request("/v1/teams/t1/submissions/s1/release", {
        method: "POST",
        headers: asUser(exec),
      });

      expect(res.status, `demoUrl ${JSON.stringify(demoUrl)} must not release`).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("NO_DEMO_URL");
      expect(submissions.rows[0].status).toBe("DRAFT");
    }
  });

  /**
   * ── ⚠ P4b: THE OTHER THREE LINKS, FOR LEGACY ROWS ───────────────────────────────────────────
   *
   * `demoUrl` has been gated here from the start; `videoUrl`, `repoUrl` and `slidesUrl` were gated
   * NOWHERE. Both writers now reject a non-https link, so no new row can carry one — but rows created
   * before that fix can, and release is the moment they reach a judge. Refused rather than sanitised,
   * with the field named, because a team can fix its own link through PATCH.
   */
  it.each(["videoUrl", "repoUrl", "slidesUrl"])(
    "refuses to release a legacy row whose %s is not https",
    async (field) => {
      const submissions = new FakeSubmissions([
        releasable({ [field]: "javascript:alert(document.cookie)" } as Partial<Submission>),
      ]);
      const { app } = build({ submissions });

      const res = await app.request("/v1/teams/t1/submissions/s1/release", {
        method: "POST",
        headers: asUser(exec),
      });

      expect(res.status, field).toBe(403);
      const body = (await res.json()) as { code: string; field: string };
      // A DISTINCT code from NO_DEMO_URL: a different remedy, so the two must stay distinguishable.
      expect(body.code, field).toBe("LINK_INVALID");
      expect(body.field, field).toBe(field);
      expect(submissions.rows[0].status, field).toBe("DRAFT");
    }
  );

  it.each(["videoUrl", "repoUrl", "slidesUrl"])(
    "an EMPTY or absent %s does not block release — these three are optional",
    async (field) => {
      // The regression this guards: reusing `isReleasableDemoUrl` here would make all three
      // MANDATORY, since it refuses an empty value by contract.
      for (const value of [null, "", "   "]) {
        const submissions = new FakeSubmissions([
          releasable({ [field]: value } as Partial<Submission>),
        ]);
        const { app } = build({ submissions });

        const res = await app.request("/v1/teams/t1/submissions/s1/release", {
          method: "POST",
          headers: asUser(exec),
        });

        expect(res.status, `${field}=${JSON.stringify(value)}`).toBe(200);
      }
    }
  );

  it("accepts an uppercase HTTPS scheme — the check parses rather than pattern-matches", async () => {
    const submissions = new FakeSubmissions([releasable({ demoUrl: "HTTPS://demo.example" })]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(200);
  });

  it("a failed docs hop is 503 with Retry-After, and the submission stays DRAFT", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const events = new InMemoryPublisher();
    const { app } = build({ submissions, docs: new FakeDocs("unavailable"), events });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { code: string }).code).toBe("SNAPSHOT_SOURCE_UNAVAILABLE");
    // ⚠ NEVER RELEASED ON AN UNANSWERED PRECONDITION.
    expect(submissions.rows[0].status).toBe("DRAFT");
    expect(submissions.rows[0].snapshot).toBeNull();
    expect(events.published).toHaveLength(0);
  });

  it("a failed PHASES hop is equally a 503 — not a release with empty phases", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const { app } = build({ submissions, phases: new FakePhases("unavailable") });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(503);
    expect(submissions.rows[0].snapshot).toBeNull();
  });

  it("⚠ an unavailable hop WINS over 'no artifacts' — the two must not be confused", async () => {
    // "could not determine" must never be reported as an answer. Telling an executive
    // their team uploaded nothing, when Docs simply did not reply, is a wrong and actionable lie.
    const { app } = build({
      submissions: new FakeSubmissions([releasable()]),
      docs: new FakeDocs("unavailable"),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).not.toBe("NO_ARTIFACTS");
  });

  it("writes a snapshot of the phases and artifact versions at that instant", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const docs = new FakeDocs([
      { path: "README.md", versionId: "v-README-1", lastAuthorName: "Ada", updatedAt: "2026-01-02T00:00:00.000Z" },
      { path: "src/app.ts", versionId: "v-app-7", lastAuthorName: "Grace", updatedAt: "2026-01-02T01:00:00.000Z" },
    ]);
    const { app } = build({ submissions, docs });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(200);
    const stored = submissions.rows[0];
    expect(stored.status).toBe("SUBMITTED");
    expect(stored.releasedById).toBe("exec-1");
    expect(stored.releasedAt).toEqual(expect.any(String));
    // `submittedAt` is kept equal for API compatibility — two names, one instant.
    expect(stored.submittedAt).toBe(stored.releasedAt);

    expect(stored.snapshot?.artifacts.map((a) => [a.path, a.versionId])).toEqual([
      ["README.md", "v-README-1"],
      ["src/app.ts", "v-app-7"],
    ]);
    expect(stored.snapshot?.phases[0]).toMatchObject({ phaseId: "p1", content: "what we built" });
    expect(stored.snapshot?.takenAt).toBe(stored.releasedAt);
  });

  it("a LATER team edit does not alter the snapshot", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });
    const pinned = JSON.parse(JSON.stringify(submissions.rows[0].snapshot));  // nosemgrep: no-stringify-keys

    // The team tries to edit after release. `patch` refuses a non-DRAFT row, so this is a 409 —
    // but the assertion that matters is that what judges read did not move.
    const edit = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "rewritten after release" }),
    });

    expect(edit.status).toBe(409);
    expect(submissions.rows[0].snapshot).toEqual(pinned);
  });

  it("releasing twice is 409 ALREADY_RELEASED, and the first release is untouched", async () => {
    const submissions = new FakeSubmissions([releasable()]);
    const events = new InMemoryPublisher();
    const docs = new FakeDocs();
    const { app } = build({ submissions, events, docs });

    const first = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });
    expect(first.status).toBe(200);
    const firstReleasedAt = submissions.rows[0].releasedAt;

    const second = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser({ id: "exec-2", role: "EXECUTIVE" }),
    });

    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("ALREADY_RELEASED");
    expect(submissions.rows[0].releasedById, "the first releaser stands").toBe("exec-1");
    expect(submissions.rows[0].releasedAt).toBe(firstReleasedAt);
    // ⚠ P5 IS CHECKED BEFORE THE HOPS, so a second release costs no east-west calls.
    expect(docs.calls).toHaveLength(1);
    // One event per release, not per attempt.
    expect(events.published).toHaveLength(1);
  });

  it("404s a submission that does not exist", async () => {
    const { app } = build({ submissions: new FakeSubmissions([]) });
    const res = await app.request("/v1/teams/t1/submissions/nope/release", {
      method: "POST",
      headers: asUser(exec),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a submission with no workshop — it could never be judged", async () => {
    // The scoring guard refuses a null scope with SUBMISSION_SCOPE_UNKNOWN and cannot do otherwise,
    // so releasing one would produce a submission judges can read and never score.
    const submissions = new FakeSubmissions([releasable({ workshopId: null })]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("SUBMISSION_SCOPE_UNKNOWN");
    expect(submissions.rows[0].status).toBe("DRAFT");
  });

  it("asks the phases source for the SERVER-DERIVED workshop, not a caller-supplied one", async () => {
    const phases = new FakePhases();
    const { app } = build({
      submissions: new FakeSubmissions([releasable({ workshopId: "w-stored" })]),
      phases,
    });

    await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
      body: JSON.stringify({ workshopId: "w-attacker" }),
    });

    expect(phases.calls).toEqual([{ teamId: "t1", workshopId: "w-stored" }]);
  });

  it("publishes submission.submitted with the workshop and the releaser", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions: new FakeSubmissions([releasable({ workshopId: "w1" })]),
      events,
    });

    await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      source: "evaluation-service",
      type: "submission.submitted",
      detail: { teamId: "t1", submissionId: "s1", workshopId: "w1", releasedById: "exec-1" },
    });
  });

  it("a released submission can then be scored — the two halves meet", async () => {
    // A DRAFT cannot be scored; this proves release is what unlocks it, end to end.
    const submissions = new FakeSubmissions([releasable()]);
    const scores = new FakeScores([]);
    const { app } = build({ submissions, scores });

    const before = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });
    expect(before.status).toBe(409);

    await app.request("/v1/teams/t1/submissions/s1/release", {
      method: "POST",
      headers: asUser(exec),
    });

    const after = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });
    expect(after.status).toBe(201);
    expect(scores.rows).toHaveLength(1);
  });
});

// ─── PATCH a draft ───────────────────────────────────────────────

describe("PATCH /v1/teams/:teamId/submissions/:id", () => {
  it("a second teammate's edit leaves createdById and createdAt UNCHANGED", async () => {
    /**
     * ⚠ THE DEFECT THIS ROUTE EXISTS FOR. The only write path used to be the POST, whose `put`
     * rewrote both fields from the current caller — so a teammate saving a draft silently
     * reassigned authorship, and re-posting reset `status` to DRAFT.
     */
    const submissions = new FakeSubmissions([
      submission({ id: "s1", createdById: "author", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "teammate", role: "EXECUTIVE" }),
      body: JSON.stringify({ demoUrl: "https://demo.example" }),
    });

    expect(res.status).toBe(200);
    const patched = ((await res.json()) as { submission: Submission }).submission;
    expect(patched.demoUrl).toBe("https://demo.example");
    expect(patched.createdById).toBe("author");
    expect(patched.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(patched.status, "and it is still a draft").toBe("DRAFT");
  });

  it("clears a field when sent an explicit null", async () => {
    const submissions = new FakeSubmissions([
      submission({ id: "s1", demoUrl: "https://old.example" }),
    ]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ demoUrl: null }),
    });

    expect(((await res.json()) as { submission: Submission }).submission.demoUrl).toBeNull();
  });

  it("leaves an ABSENT field alone rather than nulling it", async () => {
    const submissions = new FakeSubmissions([
      submission({ id: "s1", demoUrl: "https://keep.example", title: "Keep" }),
    ]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "Changed" }),
    });

    expect(submissions.rows[0].demoUrl).toBe("https://keep.example");
    expect(submissions.rows[0].title).toBe("Changed");
  });

  it("IGNORES a field that is not the team's to edit", async () => {
    // The allowlist is the protection, so a request naming a server-owned field must not reach it.
    const submissions = new FakeSubmissions([
      submission({ id: "s1", workshopId: "w1", createdById: "author" }),
    ]);
    const { app } = build({ submissions });

    await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "attacker", role: "EXECUTIVE" }),
      body: JSON.stringify({
        status: "SUBMITTED",
        workshopId: "w-foreign",
        createdById: "attacker",
        snapshot: { takenAt: "now", phases: [], artifacts: [] },
        releasedById: "attacker",
      }),
    });

    const row = submissions.rows[0];
    expect(row.status, "a participant cannot release by PATCH").toBe("DRAFT");
    expect(row.workshopId, "nor choose which panel of judges is entitled").toBe("w1");
    expect(row.createdById).toBe("author");
    expect(row.snapshot).toBeNull();
    expect(row.releasedById).toBeNull();
  });

  it("409 ALREADY_RELEASED on a released submission — distinguishable from a 404", async () => {
    const submissions = new FakeSubmissions([released({ id: "s1", title: "Final" })]);
    const { app } = build({ submissions });

    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "Sneaky edit" }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("ALREADY_RELEASED");
    expect(submissions.rows[0].title, "and nothing was written").toBe("Final");
  });

  it("404s a submission that does not exist", async () => {
    const { app } = build({ submissions: new FakeSubmissions([]) });
    const res = await app.request("/v1/teams/t1/submissions/nope", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * ── ⚠ A DEMO LINK REQUIRES FILES FIRST ─────────────────────────────────────────────────────
   *
   * THE RULE: a demo URL may be recorded only once the team's build files have been uploaded.
   * Release already refuses on both counts, but only at the end. This moves the ordering
   * forward: the demo link is the claim "there is something to look at".
   *
   * The two tests that matter most are the ones about what must STILL work — clearing the field with no
   * files, and every other field costing no hop.
   */
  describe("the demo link needs at least one uploaded file", () => {
    const patchDemo = (
      app: ReturnType<typeof build>["app"],
      demoUrl: string | null
    ) =>
      app.request("/v1/teams/t1/submissions/s1", {
        method: "PATCH",
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify({ demoUrl }),
      });

    it("409 ARTIFACTS_REQUIRED when the team has uploaded nothing, and stores nothing", async () => {
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const { app } = build({ submissions, docs: new FakeDocs([]) });

      const res = await patchDemo(app, "https://demo.example");

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("ARTIFACTS_REQUIRED");
      expect(submissions.rows[0].demoUrl).toBeNull();
    });

    it("saves the link once a file exists", async () => {
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const { app } = build({ submissions });

      const res = await patchDemo(app, "https://demo.example");

      expect(res.status).toBe(200);
      expect(submissions.rows[0].demoUrl).toBe("https://demo.example");
    });

    it("⚠ STILL ALLOWS CLEARING IT with no files — otherwise a bad link is a trap", async () => {
      // A team that uploaded nothing must be able to remove a value typed by mistake. Gating the clear
      // would leave them stuck with a wrong link and no way to delete it.
      const submissions = new FakeSubmissions([
        submission({ id: "s1", demoUrl: "https://wrong.example" }),
      ]);
      const docs = new FakeDocs([]);
      const { app } = build({ submissions, docs });

      expect((await patchDemo(app, null)).status).toBe(200);
      expect(submissions.rows[0].demoUrl).toBeNull();
      // And it did not even ask — clearing is unconditional.
      expect(docs.calls).toEqual([]);
    });

    it("treats an empty or whitespace string as clearing, not as setting", async () => {
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const docs = new FakeDocs([]);
      const { app } = build({ submissions, docs });

      expect((await patchDemo(app, "   ")).status).toBe(200);
      expect(docs.calls).toEqual([]);
    });

    it("⚠ 503s rather than claiming the team has no files, when docs cannot answer", async () => {
      /**
       * The unavailable-not-an-answer rule matters more here than at release: this refusal is read by a person mid-typing.
       * A docs brownout must not accuse them of having done no work — and the code is distinct from
       * release's `SNAPSHOT_SOURCE_UNAVAILABLE`, because nothing is being snapshotted.
       */
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const { app } = build({ submissions, docs: new FakeDocs("unavailable") });

      const res = await patchDemo(app, "https://demo.example");

      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("ARTIFACTS_UNAVAILABLE");
      expect(res.headers.get("Retry-After")).toBe("2");
      expect(submissions.rows[0].demoUrl).toBeNull();
    });

    it("⚠ COSTS NO DOCS HOP for a field that is not the demo link", async () => {
      // Editing a title or the repo link must not pay for a cross-service read. The gate is on the one
      // field whose meaning depends on the files existing.
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const docs = new FakeDocs([]);
      const { app } = build({ submissions, docs });

      const res = await app.request("/v1/teams/t1/submissions/s1", {
        method: "PATCH",
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify({ title: "Ours", repoUrl: "https://github.example/x" }),
      });

      expect(res.status).toBe(200);
      expect(docs.calls).toEqual([]);
    });

    it("does NOT gate videoUrl — only the link release depends on", async () => {
      /**
       * ⚠ DELIBERATELY NARROW. `demoUrl` is the field release precondition P4 reads, so it is the one
       * that carries the claim. Blocking a team from recording a recording link early would be an extra
       * restriction with no rule behind it.
       */
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const docs = new FakeDocs([]);
      const { app } = build({ submissions, docs });

      const res = await app.request("/v1/teams/t1/submissions/s1", {
        method: "PATCH",
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify({ videoUrl: "https://watch.example" }),
      });

      expect(res.status).toBe(200);
      expect(docs.calls).toEqual([]);
    });
  });

  it("403s a NON-EXECUTIVE LOCALLY, with no east-west hop", async () => {
    /**
     * ⚠ INVERTED FROM "403s a read-only role LOCALLY" (only executives submit).
     * It used to assert that an EXECUTIVE edits nothing; the executive is now the only role
     * that may. What survives unchanged is the ORDERING property this test was really about: the refusal
     * is local, so a caller who cannot edit costs no east-west hop.
     */
    const teamAccess = new FakeTeamAccess(true, true);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      teamAccess,
    });

    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "x" }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
    expect(teamAccess.predicates).toEqual([]);
  });

  it("403s a caller the Team context refuses", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      teamAccess: new FakeTeamAccess(false, false),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "outsider", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "x" }),
    });

    expect(res.status).toBe(403);
  });

  it("503s with Retry-After when team scope is unavailable — never a guess", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      // `scope` is the FIFTH parameter — the two content flags sit between. "unavailable" is the
      // Team-brownout case, distinct from `null` ("the team has no workshop").
      teamAccess: new FakeTeamAccess(true, true, true, true, "unavailable"),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "x" }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { code: string }).code).toBe("TEAM_SCOPE_UNAVAILABLE");
  });

  it("400s a field sent as a non-string", async () => {
    const { app } = build({ submissions: new FakeSubmissions([submission({ id: "s1" })]) });
    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ demoUrl: 42 }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string; field: string }).field).toBe("demoUrl");
  });

  it("400s a malformed JSON body rather than 500ing", async () => {
    const { app } = build({ submissions: new FakeSubmissions([submission({ id: "s1" })]) });
    const res = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });
});

// ─── What a judge may read ──────────────────────────

describe("GET /v1/workshops/:workshopId/submissions — the judging worklist", () => {
  const judge = { id: "judge-1", role: "JUDGE" };
  const releasedIn = (workshopId: string, over: Partial<Submission> = {}) =>
    released({
      workshopId,
      releasedAt: "2026-01-05T10:00:00.000Z",
      snapshot: {
        takenAt: "2026-01-05T10:00:00.000Z",
        teamName: "Code Vibranium",
        phases: [],
        artifacts: [
          { path: "README.md", versionId: "v1", lastAuthorName: "Ada", updatedAt: "x" },
          { path: "src/a.ts", versionId: "v2", lastAuthorName: "Ada", updatedAt: "x" },
        ],
      },
      ...over,
    });

  it("lists RELEASED teams only — a draft is absent, not a 403", async () => {
    const submissions = new FakeSubmissions([
      releasedIn(HOME_WORKSHOP, { id: "s-released", teamId: "t-released" }),
      // Same workshop, still a draft.
      submission({ id: "s-draft", teamId: "t-draft", workshopId: HOME_WORKSHOP }),
    ]);
    const { app } = build({ submissions });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser(judge),
    });

    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { submissions: Array<{ submissionId: string }> })
      .submissions;
    expect(rows.map((r) => r.submissionId)).toEqual(["s-released"]);
  });

  it("a judge entitled to another workshop gets 403 WORKSHOP_NOT_ENTITLED", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([releasedIn("w-foreign", { id: "s-foreign" })]),
      entitlements: new FakeEntitlements([HOME_WORKSHOP]),
    });

    const res = await app.request("/v1/workshops/w-foreign/submissions", {
      headers: asUser(judge),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("WORKSHOP_NOT_ENTITLED");
  });

  it("REFUSES an ADMIN who does not own the experience — and the entitlement path does not rescue them", async () => {
    /**
     * ⚠ NEW, AND IT COVERS A GRANT THAT NO TEST TOUCHED. Two ADMIN short-circuits
     * used to admit this caller, either of which alone was sufficient:
     *
     *   · this route's `allowed = role === "ADMIN" || workshop.ownerId === callerId`, and
     *   · `decideSubmissionScope`'s step 1, `if (role === "ADMIN") return "allow"`.
     *
     * Both are gone. ⚠ REMOVING EITHER ONE ALONE WOULD HAVE BEEN INERT — the route falls through
     * to `requireScoringScope`, i.e. to the scope predicate, so an admin refused by the owner
     * check would have been allowed by the predicate one line later. That is why this test asserts
     * the OUTCOME through the route rather than trusting either predicate in isolation.
     *
     * The submission is `w-foreign` and the workshop row is owned by `owner-1`, so this admin owns
     * nothing here. `FakeEntitlements([])` is the honest fixture: entitlements are built from
     * invitations and memberships, and a platform-scoped admin holds neither.
     */
    const workshops = new FakeWorkshops({ id: "w-foreign", ownerId: "owner-1", status: "ACTIVE" });
    const { app } = build({
      submissions: new FakeSubmissions([releasedIn("w-foreign", { id: "s-foreign" })]),
      entitlements: new FakeEntitlements([]),
      workshops,
    });

    const res = await app.request("/v1/workshops/w-foreign/submissions", {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("WORKSHOP_NOT_ENTITLED");
    // The ownership question WAS asked — a refusal that skipped the read would refuse the owner too.
    expect(workshops.calls).toEqual(["w-foreign"]);
  });

  it("SERVES an ADMIN who owns the experience", async () => {
    // The positive half, which did not need stating while the role was a blanket pass. Same
    // fixture as above with one field changed: the workshop's ownerId is this caller.
    const { app } = build({
      submissions: new FakeSubmissions([releasedIn("w-mine", { id: "s-mine" })]),
      entitlements: new FakeEntitlements([]),
      workshops: new FakeWorkshops({ id: "w-mine", ownerId: "admin-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/workshops/w-mine/submissions", {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { submissions: Array<{ submissionId: string }> })
      .submissions;
    expect(rows.map((r) => r.submissionId)).toEqual(["s-mine"]);
  });

  it("503s rather than 403s when entitlements cannot be determined", async () => {
    const { app } = build({ entitlements: new FakeEntitlements("unavailable") });
    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser(judge),
    });
    expect(res.status).toBe(503);
  });

  it("reports only THIS judge's own score, never another judge's", async () => {
    const submissions = new FakeSubmissions([releasedIn(HOME_WORKSHOP, { id: "s1" })]);
    const scores = new FakeScores([
      {
        submissionId: "s1",
        judgeId: "judge-1",
        innovation: 8,
        execution: 7,
        // ⚠ KEPT ON THE FIXTURE ON PURPOSE: this models a row written BEFORE `aiUsage` was dropped,
        // which is what most stored rows are. It proves the derived total IGNORES it rather than
        // throwing on it — a historical row has to stay readable.
        aiUsage: 9,
        impact: 6,
        presentation: 5,
        comment: "mine",
        createdAt: "x",
      },
      {
        submissionId: "s1",
        judgeId: "judge-2",
        innovation: 1,
        execution: 1,
        aiUsage: 1,
        impact: 1,
        presentation: 1,
        comment: "someone else's",
        createdAt: "x",
      },
    ]);
    const { app } = build({ submissions, scores });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser(judge),
    });

    const row = ((await res.json()) as { submissions: Array<Record<string, unknown>> })
      .submissions[0];
    expect(row.scoredByMe).toBe(true);
    // ⚠ 26, NOT 35. `aiUsage` was dropped from SCORE_CRITERIA and the total is
    // DERIVED over that list, so the same stored row now sums four criteria out of 40. Stated here
    // because this number moving is the visible face of that decision, not a defect.
    expect(row.myScoreTotal, "8+7+6+5").toBe(26);
    // ⚠ AND THE MAXIMUM MOVED WITH IT — 40, not 50. It is derived from SCORE_CRITERIA, so the total
    // and the "out of" can never disagree; a stored total of 26 out of a stale 50 would understate
    // every team by a fifth on the one screen a judge works from.
    expect(row.maxScore).toBe(40);
    // ⚠ NOTHING ABOUT judge-2 — not their total, not their comment. Mid-judging disclosure of another
    // judge's numbers is the P0-4 defect; a list must not reintroduce it.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("someone else");
    expect(serialised).not.toContain("judge-2");
  });

  it("reports an unscored team as unscored rather than as zero", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([releasedIn(HOME_WORKSHOP, { id: "s1" })]),
      scores: new FakeScores([]),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser(judge),
    });
    const row = ((await res.json()) as { submissions: Array<Record<string, unknown>> })
      .submissions[0];

    expect(row.scoredByMe).toBe(false);
    // ⚠ NULL, NOT 0. A zero total is a judgement; "not scored" is the absence of one.
    expect(row.myScoreTotal).toBeNull();
  });

  it("carries the PINNED team name, and the artifact count from the snapshot", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([releasedIn(HOME_WORKSHOP, { id: "s1", teamId: "t1" })]),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser(judge),
    });
    const row = ((await res.json()) as { submissions: Array<Record<string, unknown>> })
      .submissions[0];

    expect(row.teamName).toBe("Code Vibranium");
    expect(row.artifactCount).toBe(2);
    expect(row.teamId).toBe("t1");
  });

  it("admits the experience OWNER, whom the entitlement probe cannot serve", async () => {
    // A facilitator who owns the experience may have neither an invitation nor a membership, so
    // `GET /entitlements/workshops` returns them nothing. The ownership hop is what admits them.
    const { app } = build({
      submissions: new FakeSubmissions([releasedIn(HOME_WORKSHOP, { id: "s1" })]),
      entitlements: new FakeEntitlements([]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
  });

  it("refuses a FACILITATOR who does not own the experience", async () => {
    const { app } = build({
      entitlements: new FakeEntitlements([]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "someone-else", status: "ACTIVE" }),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(403);
  });

  it("costs a JUDGE no workshop hop — the owner branch is staff-only", async () => {
    const workshops = new FakeWorkshops();
    const { app } = build({ workshops });

    await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, { headers: asUser(judge) });

    expect(workshops.calls, "a judge could never be admitted by ownership").toEqual([]);
  });

  it("503s when the experience itself cannot be read, rather than guessing at ownership", async () => {
    const { app } = build({ workshops: new FakeWorkshops("unavailable") });
    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });
    expect(res.status).toBe(503);
  });

  /**
   * ── ⚠ ENTITLEMENT IS NOT A JUDGING CREDENTIAL ───────────────────────────────────────────────
   *
   * This route was gated on `requireScoringScope` ALONE. Scope and role are two functions on purpose
   * — `decideSubmissionScope` has no role branch and its comment says the role half lives in
   * `requireScoringRole` — and this handler never called the role half. `requireScoringRole`'s only
   * call site was the score write.
   *
   * ⚠ WHY THAT WAS EXPLOITABLE AND NOT MERELY UNTIDY: Team's `GET /entitlements/workshops` unions
   * invitation workshopIds with EVERY workshop reached through team membership. So a PARTICIPANT or
   * EXECUTIVE on ANY team in workshop W is entitled to W, and a 200 handed them every team's released
   * submission in that experience — including competing teams' `demoUrl`, before results were
   * published. The `FakeEntitlements` default models exactly that: entitled to HOME_WORKSHOP.
   *
   * The sibling id-addressed read (`requireSubmissionRead`) had the role check all along, so these
   * assertions also pin the two paths back into agreement.
   */
  describe("the JUDGE role gate", () => {
    for (const role of ["PARTICIPANT", "EXECUTIVE"]) {
      it(`REFUSES a ${role} who is entitled through team membership`, async () => {
        const submissions = new FakeSubmissions([
          releasedIn(HOME_WORKSHOP, { id: "s-theirs", teamId: "t-other" }),
        ]);
        // Entitled — the pre-fix condition for a 200.
        const entitlements = new FakeEntitlements([HOME_WORKSHOP]);
        const { app } = build({ submissions, entitlements });

        const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
          headers: asUser({ id: "u-1", role }),
        });

        expect(res.status, role).toBe(403);
        // Not a leak of the list under a 403, and not an empty 200 either.
        expect(await res.text(), role).not.toContain("s-theirs");
      });

      it(`refuses a ${role} LOCALLY — no entitlement hop, no submission read`, async () => {
        /**
         * The order matters as much as the check. A refusal that first asked Team for entitlements
         * would spend an east-west hop on a caller who can never be admitted, and would let a
         * non-judge distinguish "workshop exists" from "not entitled" by timing or status.
         */
        const submissions = new FakeSubmissions([releasedIn(HOME_WORKSHOP, { id: "s1" })]);
        const entitlements = new FakeEntitlements([HOME_WORKSHOP]);
        const workshops = new FakeWorkshops();
        const { app } = build({ submissions, entitlements, workshops });

        await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
          headers: asUser({ id: "u-1", role }),
        });

        expect(entitlements.calls, `${role}: entitlements must not be consulted`).toEqual([]);
        expect(workshops.calls, `${role}: the owner branch is staff-only`).toEqual([]);
      });
    }

    it("still SERVES a JUDGE — the gate admits the role it is for", async () => {
      // NOT VACUOUS: without this the refusals above would pass on a route that refuses everyone.
      const submissions = new FakeSubmissions([releasedIn(HOME_WORKSHOP, { id: "s-ok" })]);
      const { app } = build({ submissions });

      const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/submissions`, {
        headers: asUser(judge),
      });

      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { submissions: Array<{ submissionId: string }> })
        .submissions;
      expect(rows.map((r) => r.submissionId)).toEqual(["s-ok"]);
    });

    it("REFUSES a staff member entitled by membership to an experience they do not own", async () => {
      /**
       * ⚠ THE NARROWER CASE THE ENTITLEMENT FALL-THROUGH LEFT OPEN. A FACILITATOR who is a MEMBER of
       * a team in another owner's experience is entitled to that workshop by the membership union, so
       * a fix that merely let staff fall through to `requireScoringScope` would have admitted them.
       *
       * The refusal keeps the WORKSHOP_NOT_ENTITLED shape rather than "Judge role required": an
       * admin is never going to hold JUDGE, so that message would be a misleading answer, and the
       * portal already distinguishes this code.
       */
      const { app } = build({
        submissions: new FakeSubmissions([releasedIn("w-foreign", { id: "s-foreign" })]),
        entitlements: new FakeEntitlements(["w-foreign"]),
        workshops: new FakeWorkshops({ id: "w-foreign", ownerId: "someone-else", status: "ACTIVE" }),
      });

      const res = await app.request("/v1/workshops/w-foreign/submissions", {
        headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
      });

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("WORKSHOP_NOT_ENTITLED");
    });

    it("still SERVES the staff OWNER, who never reaches the role gate", async () => {
      const { app } = build({
        submissions: new FakeSubmissions([releasedIn("w-mine", { id: "s-mine" })]),
        entitlements: new FakeEntitlements([]),
        workshops: new FakeWorkshops({ id: "w-mine", ownerId: "fac-1", status: "ACTIVE" }),
      });

      const res = await app.request("/v1/workshops/w-mine/submissions", {
        headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
      });

      expect(res.status).toBe(200);
    });
  });
});

describe("GET /v1/submissions/:submissionId/snapshot", () => {
  const pinned = {
    takenAt: "2026-01-05T10:00:00.000Z",
    teamName: "Code Vibranium",
    phases: [
      {
        phaseId: "p1",
        order: 1,
        name: "Inception",
        content: "as released",
        aiGenerated: false,
        editedByName: "Ada",
        editedAt: "x",
      },
    ],
    artifacts: [{ path: "README.md", versionId: "v1", lastAuthorName: "Ada", updatedAt: "x" }],
  };

  it("returns the pinned phases and manifest, with releasedAt for the banner", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([
        released({ id: "s1", releasedAt: "2026-01-05T10:00:00.000Z", snapshot: pinned }),
      ]),
    });

    const res = await app.request("/v1/submissions/s1/snapshot", {
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: typeof pinned; releasedAt: string };
    expect(body.snapshot.phases[0].content).toBe("as released");
    expect(body.releasedAt).toBe("2026-01-05T10:00:00.000Z");
  });

  it("a judge entitled elsewhere gets 403", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([
        released({ id: "s1", workshopId: "w-foreign", snapshot: pinned }),
      ]),
      teamAccess: new FakeTeamAccess(false, false),
      entitlements: new FakeEntitlements([HOME_WORKSHOP]),
    });

    const res = await app.request("/v1/submissions/s1/snapshot", {
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
    });

    expect(res.status).toBe(403);
  });

  it("409s a DRAFT rather than returning an empty snapshot", async () => {
    // An empty snapshot renders as "this team submitted nothing" — a statement about the TEAM.
    // "Not released yet" is a statement about the SUBMISSION, and it is the true one.
    const { app } = build({ submissions: new FakeSubmissions([submission({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/snapshot", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_RELEASED");
  });
});

/**
 * ── ⚠ THE ARTIFACT-CONTENT TESTS WERE REMOVED WITH THE ROUTE ───────────────────────────
 *
 * `GET /v1/submissions/:id/artifacts/content` and its eleven tests are gone, because the route could
 * only ever answer 503: it depended on `INTERNAL_SERVICE_TOKEN`, which is set on NO function
 * deliberately (the template records it being removed as "no security and strictly worse"). The earlier
 * design's "east-west, x-internal-token (the established path)" described a path that does not exist.
 *
 * Recorded here rather than deleted silently, because the RULES those tests protected are the part
 * worth keeping if a judge ever reads files in-portal again:
 *
 *   * a `(path, versionId)` PAIR must match the released manifest — path alone would serve the
 *     CURRENT version of a file edited since release, the moving target the snapshot exists to remove
 *   * a path outside the manifest is 403, NOT 404, so the manifest cannot be probed for which files
 *     a team has
 *   * an UNPINNED entry (`versionId: null`) is refused rather than served at "latest"
 *   * a failed fetch is 503, never an empty body — a blank file reads as "the team submitted nothing"
 *     and a judge might score it
 *
 * What a judge still has, and why it was judged enough: the phase notes (copied INLINE into the
 * snapshot, needing no hop), the artifact MANIFEST — path, author, timestamp, count — the demo link
 * and the repository link. Code is read where code lives.
 */

describe("⚠ the exception's BOUNDARY — a judge gains nothing beyond the submission", () => {
  /**
   * "A release discloses the team's WORK, not its WORKING." Chat, the board and AI
   * threads live in other services and are member-only there. The two surfaces THIS service owns —
   * peer ratings and the member-contribution insights derived from chat/board/commit counters — are
   * the ones it must keep closed, and they are the ones a widening here would most plausibly leak.
   */
  const releasedWithSnapshot = () =>
    released({
      id: "s1",
      snapshot: { takenAt: "x", teamName: "T", phases: [], artifacts: [] },
    });

  it("a judge who CAN read the released submission still gets 403 on peer ratings", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([releasedWithSnapshot()]),
      // The Team context refuses a judge every CONTENT predicate — they are not a member.
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const readable = await app.request("/v1/submissions/s1/snapshot", {
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
    });
    expect(readable.status, "the submission itself is readable").toBe(200);

    const ratings = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
    });
    expect(ratings.status, "the team's peer ratings are NOT").toBe(403);
  });

  it("and 403 on writing a peer rating about a member of a team they judge", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([releasedWithSnapshot()]),
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/teams/t1/ratings", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify({ ratedUserId: "u1", score: 10 }),
    });

    expect(res.status).toBe(403);
  });
});

// ─── Experience activity: the facilitator's and admin's view ─────────────────

describe("GET /v1/workshops/:workshopId/activity", () => {
  const owner = { id: "owner-1", role: "FACILITATOR" };
  const ownedWorkshop = () =>
    new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "owner-1", status: "ACTIVE" });

  const activityRowFor = (teamId: string, userId: string, over: Partial<MemberActivity> = {}) =>
    activityRow({ teamId, userId, ...over });

  it("returns per-team totals for the experience OWNER", async () => {
    const teams = new FakeTeams();
    teams.teamsAnswer = [
      { id: "t1", name: "Code Vibranium", memberCount: 3 },
      { id: "t2", name: "Stark Stack", memberCount: 2 },
    ];
    const { app } = build({
      teams,
      workshops: ownedWorkshop(),
      activity: new FakeActivity([
        activityRowFor("t1", "u1", { messagesSent: 10, commitsPushed: 2, updatedAt: "2026-01-05T09:00:00.000Z" }),
        activityRowFor("t1", "u2", { messagesSent: 5, tasksCompleted: 3, updatedAt: "2026-01-05T11:00:00.000Z" }),
        activityRowFor("t2", "u3", { messagesSent: 1, updatedAt: "2026-01-04T08:00:00.000Z" }),
      ]),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser(owner),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: Array<Record<string, unknown>>; teamCount: number };
    expect(body.teamCount).toBe(2);

    const t1 = body.teams.find((t) => t.teamId === "t1")!;
    expect(t1.teamName).toBe("Code Vibranium");
    expect(t1.messagesSent, "summed across the team's members").toBe(15);
    expect(t1.commitsPushed).toBe(2);
    expect(t1.tasksCompleted).toBe(3);
    expect(t1.membersWithActivity).toBe(2);
    expect(t1.lastActivityAt, "the most recent activity anywhere in the team").toBe(
      "2026-01-05T11:00:00.000Z"
    );
  });

  it("⚠ DISCLOSES NO PER-PERSON DATA — the aggregate is the product, not a convenience", async () => {
    /**
     * The read-model is keyed (teamId, userId), so a per-person breakdown is one `map` away and is
     * deliberately not offered. Capability, not surveillance.
     */
    const teams = new FakeTeams();
    teams.teamsAnswer = [{ id: "t1", name: "T", memberCount: 2 }];
    const { app } = build({
      teams,
      workshops: ownedWorkshop(),
      activity: new FakeActivity([
        activityRowFor("t1", "quiet-person", { messagesSent: 0 }),
        activityRowFor("t1", "busy-person", { messagesSent: 99 }),
      ]),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser(owner),
    });

    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("quiet-person");
    expect(raw).not.toContain("busy-person");
    expect(raw).not.toContain("userId");
  });

  it("⚠ aiTurns is NULL when nothing measured it, never 0", async () => {
    // Rows predating v0.3.2 carry no `aiTurns`. Reporting 0 would state "this team used no
    // assistant" about a period nobody was measuring.
    const teams = new FakeTeams();
    teams.teamsAnswer = [
      { id: "t-unmeasured", name: "A", memberCount: 1 },
      { id: "t-measured", name: "B", memberCount: 1 },
    ];
    const { app } = build({
      teams,
      workshops: ownedWorkshop(),
      activity: new FakeActivity([
        activityRowFor("t-unmeasured", "u1"),
        activityRowFor("t-measured", "u2", { aiTurns: 12 }),
      ]),
    });

    const body = (await (
      await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, { headers: asUser(owner) })
    ).json()) as { teams: Array<Record<string, unknown>> };

    const unmeasured = body.teams.find((t) => t.teamId === "t-unmeasured")!;
    const measured = body.teams.find((t) => t.teamId === "t-measured")!;
    expect(unmeasured.aiTurns).toBeNull();
    expect(unmeasured.aiTurnsMeasuredFor).toBe(0);
    expect(measured.aiTurns).toBe(12);
    expect(measured.aiTurnsMeasuredFor).toBe(1);
  });

  it("a team with NO activity reports zeros and a null lastActivityAt, not an absent row", async () => {
    // The quiet team is the whole point of this route — it must appear.
    const teams = new FakeTeams();
    teams.teamsAnswer = [{ id: "t-silent", name: "Silent", memberCount: 4 }];
    const { app } = build({ teams, workshops: ownedWorkshop(), activity: new FakeActivity([]) });

    const body = (await (
      await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, { headers: asUser(owner) })
    ).json()) as { teams: Array<Record<string, unknown>> };

    expect(body.teams).toHaveLength(1);
    expect(body.teams[0]).toMatchObject({
      teamId: "t-silent",
      messagesSent: 0,
      membersWithActivity: 0,
      lastActivityAt: null,
      memberCount: 4,
    });
  });

  it("reports whether each team has released, and how many have", async () => {
    const teams = new FakeTeams();
    teams.teamsAnswer = [
      { id: "t1", name: "A", memberCount: 1 },
      { id: "t2", name: "B", memberCount: 1 },
    ];
    const { app } = build({
      teams,
      workshops: ownedWorkshop(),
      submissions: new FakeSubmissions([
        released({
          id: "s1",
          teamId: "t1",
          workshopId: HOME_WORKSHOP,
          releasedAt: "2026-01-06T00:00:00.000Z",
        }),
      ]),
    });

    const body = (await (
      await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, { headers: asUser(owner) })
    ).json()) as { teams: Array<Record<string, unknown>>; releasedCount: number };

    expect(body.releasedCount).toBe(1);
    expect(body.teams.find((t) => t.teamId === "t1")).toMatchObject({ released: true });
    expect(body.teams.find((t) => t.teamId === "t2")).toMatchObject({
      released: false,
      releasedAt: null,
    });
  });

  /**
   * ⚠ WAS "an ADMIN sees any experience". THE RULE: an ADMIN sees only the experiences they own — no
   * other experiences, scores or data. The pair below is the replacement — an admin who OWNS the
   * experience sees it, one who does not is refused exactly like a non-owning facilitator (the test
   * immediately after this one).
   */
  it("an ADMIN who OWNS the experience sees it", async () => {
    const { app } = build({
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "admin-1", status: "ACTIVE" }),
    });
    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });
    expect(res.status).toBe(200);
  });

  it("an ADMIN who does not own the experience is refused", async () => {
    const { app } = build({
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "someone-else", status: "ACTIVE" }),
      entitlements: new FakeEntitlements([]),
    });
    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });
    expect(res.status).toBe(403);
  });

  it("a FACILITATOR who does not own the experience is refused", async () => {
    const { app } = build({
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "someone-else", status: "ACTIVE" }),
    });
    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser(owner),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_THE_OWNER");
  });

  it("a JUDGE, a PARTICIPANT and an EXECUTIVE are all refused", async () => {
    // This is the operational view of RUNNING the room, not a participant surface.
    for (const role of ["JUDGE", "PARTICIPANT", "EXECUTIVE"]) {
      const { app } = build({ workshops: ownedWorkshop() });
      const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
        headers: asUser({ id: "someone", role }),
      });
      expect(res.status, role).toBe(403);
    }
  });

  it("⚠ 503s when the team list is unavailable — never reports an experience as empty", async () => {
    // "Could not read the teams" and "this experience has no teams" are different facts, and the
    // second would send a facilitator looking for a provisioning bug that does not exist.
    const teams = new FakeTeams();
    teams.teamsAnswer = "unavailable";
    const { app } = build({ teams, workshops: ownedWorkshop() });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser(owner),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(((await res.json()) as { code: string }).code).toBe("TEAMS_UNAVAILABLE");
  });

  it("an experience with genuinely no teams is 200 with an empty list", async () => {
    const teams = new FakeTeams();
    teams.teamsAnswer = [];
    const { app } = build({ teams, workshops: ownedWorkshop() });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/activity`, {
      headers: asUser(owner),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: unknown[]; teamCount: number };
    expect(body.teams).toEqual([]);
    expect(body.teamCount).toBe(0);
  });
});

// ─── Reopen and places ───────────────────────────

describe("POST /v1/teams/:teamId/submissions/:id/reopen", () => {
  const owner = { id: "owner-1", role: "FACILITATOR" };
  const liveRelease = (over: Partial<Submission> = {}) =>
    released({
      id: "s1",
      releasedById: "exec-1",
      releasedAt: "2026-01-05T00:00:00.000Z",
      snapshot: { takenAt: "2026-01-05T00:00:00.000Z", teamName: "T", phases: [], artifacts: [] },
      ...over,
    });

  it("an EXECUTIVE is refused — release is theirs, reopening is not", async () => {
    const submissions = new FakeSubmissions([liveRelease()]);
    const workshops = new FakeWorkshops();
    const { app } = build({ submissions, workshops });

    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser({ id: "exec-1", role: "EXECUTIVE" }),
      body: JSON.stringify({ reason: "let them fix the demo link" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("OWNER_ONLY");
    expect(submissions.rows[0].status, "still released").toBe("SUBMITTED");
    // ⚠ LOCAL FIRST: refused with no store read and no workshop hop.
    expect(workshops.calls).toEqual([]);
  });

  it("a PARTICIPANT is refused", async () => {
    const { app } = build({ submissions: new FakeSubmissions([liveRelease()]) });
    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ reason: "please" }),
    });
    expect(res.status).toBe(403);
  });

  it("the OWNER succeeds and the audit fields are set", async () => {
    const submissions = new FakeSubmissions([liveRelease()]);
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions,
      events,
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "owner-1", status: "JUDGING" }),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ reason: "demo link was wrong" }),
    });

    expect(res.status).toBe(200);
    const row = submissions.rows[0];
    expect(row.status).toBe("DRAFT");
    expect(row.reopenedById).toBe("owner-1");
    expect(row.reopenedAt).toEqual(expect.any(String));
    expect(row.reopenReason).toBe("demo link was wrong");
    expect(events.published[0]).toMatchObject({ type: "submission.reopened" });
  });

  it("the snapshot and the release audit SURVIVE the reopen", async () => {
    // The snapshot is what already-cast scores were cast against; deleting it would make them
    // unexplainable.
    const submissions = new FakeSubmissions([liveRelease()]);
    const { app } = build({
      submissions,
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "owner-1", status: "JUDGING" }),
    });

    await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ reason: "r" }),
    });

    const row = submissions.rows[0];
    expect(row.snapshot).not.toBeNull();
    expect(row.releasedById, "who released it is still recorded").toBe("exec-1");
    expect(row.releasedAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("after a reopen the team can PATCH again", async () => {
    const submissions = new FakeSubmissions([liveRelease()]);
    const { app } = build({
      submissions,
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "owner-1", status: "JUDGING" }),
    });

    const blocked = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ demoUrl: "https://new.example" }),
    });
    expect(blocked.status, "released, so refused").toBe(409);

    await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ reason: "r" }),
    });

    const allowed = await app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      // ⚠ AN EXECUTIVE, because only executives submit. The AC is about
      // the REOPEN restoring editability, not about which role edits — and the role that edits is now
      // the same one that will release it again.
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ demoUrl: "https://new.example" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("requires a reason — this is an audited reversal of someone else's decision", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([liveRelease()]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "owner-1", status: "JUDGING" }),
    });

    for (const body of [{}, { reason: "" }, { reason: "   " }]) {
      const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
        method: "POST",
        headers: asUser(owner),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("REASON_REQUIRED");
    }
  });

  it("refuses a FACILITATOR who does not own the experience", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([liveRelease()]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "someone-else", status: "JUDGING" }),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ reason: "r" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_THE_OWNER");
  });

  it("409s a submission that is already a draft", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "owner-1", status: "ACTIVE" }),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser(owner),
      body: JSON.stringify({ reason: "r" }),
    });

    expect(res.status).toBe(409);
  });
});

describe("results — publish, read and preview", () => {
  const owner = { id: "owner-1", role: "FACILITATOR" };
  const ownedWorkshop = new FakeWorkshops({
    id: HOME_WORKSHOP,
    ownerId: "owner-1",
    status: "JUDGING",
  });

  const scoredRelease = (id: string, over: Partial<Submission> = {}) =>
    released({
      id,
      teamId: `team-${id}`,
      workshopId: HOME_WORKSHOP,
      releasedAt: "2026-01-05T00:00:00.000Z",
      snapshot: {
        takenAt: "2026-01-05T00:00:00.000Z",
        teamName: `Team ${id}`,
        phases: [],
        artifacts: [],
      },
      ...over,
    });

  const scoreFor = (submissionId: string, judgeId: string, n: number) => ({
    submissionId,
    judgeId,
    innovation: n,
    execution: n,
    aiUsage: n,
    impact: n,
    presentation: n,
    comment: null,
    createdAt: "2026-01-06T00:00:00.000Z",
  });

  it("a JUDGE cannot publish — only the owner", async () => {
    const results = new FakeResults();
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1")]),
      scores: new FakeScores([scoreFor("s1", "j1", 8)]),
      results,
      workshops: ownedWorkshop,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser({ id: "j1", role: "JUDGE" }),
    });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("OWNER_ONLY");
    expect(results.rows.size, "nothing published").toBe(0);
  });

  it("GET results is 404 before publication", async () => {
    const { app } = build({ workshops: ownedWorkshop, results: new FakeResults() });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser(owner),
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_PUBLISHED");
  });

  it("not even the OWNER gets a ranking from the results route before publishing", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1")]),
      scores: new FakeScores([scoreFor("s1", "j1", 9)]),
      workshops: ownedWorkshop,
      results: new FakeResults(),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser(owner),
    });

    expect(res.status).toBe(404);
    // ⚠ NO PLACES ANYWHERE IN THE BODY. "Never render a partial ranking".
    expect(JSON.stringify(await res.json())).not.toContain("place");
  });

  it("the owner's PREVIEW is a separate route and says it is unpublished", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1"), scoredRelease("s2")]),
      scores: new FakeScores([scoreFor("s1", "j1", 9), scoreFor("s2", "j1", 4)]),
      workshops: ownedWorkshop,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/preview`, {
      headers: asUser(owner),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { published: boolean; places: Array<{ place: number }> };
    expect(body.published, "carried in the payload, not only the URL").toBe(false);
    expect(body.places.map((p) => p.place)).toEqual([1, 2]);
  });

  it("publish is refused below quorum, with per-team coverage", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1"), scoredRelease("s2")]),
      // s2 has no scores.
      scores: new FakeScores([scoreFor("s1", "j1", 8)]),
      workshops: ownedWorkshop,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      coverage: Array<{ submissionId: string; judgeCount: number }>;
    };
    expect(body.code).toBe("RESULTS_QUORUM_NOT_MET");
    expect(body.coverage.find((c) => c.submissionId === "s2")?.judgeCount).toBe(0);
  });

  it("publish is refused on UNEVEN coverage, distinctly from scarcity", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1"), scoredRelease("s2")]),
      scores: new FakeScores([
        scoreFor("s1", "j1", 8),
        scoreFor("s2", "j1", 4),
        scoreFor("s2", "j2", 5),
      ]),
      workshops: ownedWorkshop,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESULTS_COVERAGE_UNEVEN");
  });

  it("an unresolved tie refuses; the owner's ordering resolves it and is recorded", async () => {
    const results = new FakeResults();
    const build2 = () =>
      build({
        submissions: new FakeSubmissions([scoredRelease("s-a"), scoredRelease("s-b")]),
        scores: new FakeScores([scoreFor("s-a", "j1", 7), scoreFor("s-b", "j1", 7)]),
        workshops: ownedWorkshop,
        results,
      });

    const refused = await build2().app.request(
      `/v1/workshops/${HOME_WORKSHOP}/results/publish`,
      { method: "POST", headers: asUser(owner) }
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("RESULTS_TIE_UNRESOLVED");

    const resolved = await build2().app.request(
      `/v1/workshops/${HOME_WORKSHOP}/results/publish`,
      {
        method: "POST",
        headers: asUser(owner),
        body: JSON.stringify({ tieOrder: ["s-b", "s-a"] }),
      }
    );
    expect(resolved.status).toBe(200);

    const stored = results.rows.get(HOME_WORKSHOP);
    expect(stored?.places.map((p) => [p.place, p.submissionId])).toEqual([
      [1, "s-b"],
      [2, "s-a"],
    ]);
    // ⚠ THE RECORD SAYS A HUMAN BROKE IT.
    expect(stored?.tieBrokenById).toBe("owner-1");
    expect(stored?.tieBrokenAt).toEqual(expect.any(String));
  });

  it("does NOT record a tie-break when there was no tie", async () => {
    const results = new FakeResults();
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1"), scoredRelease("s2")]),
      scores: new FakeScores([scoreFor("s1", "j1", 9), scoreFor("s2", "j1", 4)]),
      workshops: ownedWorkshop,
      results,
    });

    await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(results.rows.get(HOME_WORKSHOP)?.tieBrokenById).toBeNull();
  });

  it("a score predating the latest release blocks publication", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([
        scoredRelease("s1", { releasedAt: "2026-01-10T00:00:00.000Z" }),
      ]),
      // Cast on the 6th, released again on the 10th.
      scores: new FakeScores([scoreFor("s1", "j1", 8)]),
      workshops: ownedWorkshop,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESULTS_STALE_SCORES");
  });

  it("publishing records the ranking, moves the experience to COMPLETED and emits", async () => {
    const results = new FakeResults();
    const workshops = new FakeWorkshops({
      id: HOME_WORKSHOP,
      ownerId: "owner-1",
      status: "JUDGING",
    });
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1"), scoredRelease("s2")]),
      scores: new FakeScores([scoreFor("s1", "j1", 9), scoreFor("s2", "j1", 4)]),
      workshops,
      results,
      events,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { experienceCompleted: boolean }).experienceCompleted).toBe(true);
    expect(workshops.statusCalls).toEqual([
      { workshopId: HOME_WORKSHOP, status: "COMPLETED" },
    ]);
    expect(events.published.some((e) => e.type === "workshop.results-published")).toBe(true);

    const stored = results.rows.get(HOME_WORKSHOP);
    expect(stored?.publishedById).toBe("owner-1");
    // The quorum ACTUALLY APPLIED is recorded, not left to be re-derived later.
    expect(stored?.minScoresPerSubmission).toBe(1);
    expect(stored?.places.map((p) => p.teamName)).toEqual(["Team s1", "Team s2"]);
  });

  it("⚠ a failed COMPLETED transition does not undo or hide a successful publication", async () => {
    // The results row is the authoritative fact and is already written. Throwing here would turn a
    // succeeded publication into a 500 and invite the owner to publish again — which the store would
    // then refuse, leaving them convinced nothing happened.
    const results = new FakeResults();
    const workshops = new FakeWorkshops({
      id: HOME_WORKSHOP,
      ownerId: "owner-1",
      status: "JUDGING",
    });
    workshops.transitions = false;
    const { app } = build({
      submissions: new FakeSubmissions([scoredRelease("s1")]),
      scores: new FakeScores([scoreFor("s1", "j1", 8)]),
      workshops,
      results,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(res.status).toBe(200);
    // ⚠ AND IT SAYS SO, rather than reporting a clean success.
    expect(((await res.json()) as { experienceCompleted: boolean }).experienceCompleted).toBe(false);
    expect(results.rows.size, "the ranking IS published").toBe(1);
  });

  it("refuses a SECOND publish and returns what was already published", async () => {
    const results = new FakeResults();
    const make = () =>
      build({
        submissions: new FakeSubmissions([scoredRelease("s1")]),
        scores: new FakeScores([scoreFor("s1", "j1", 8)]),
        workshops: ownedWorkshop,
        results,
      });

    const first = await make().app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });
    expect(first.status).toBe(200);

    /**
     * ⚠ THE SECOND ATTEMPT IS THE OWNER, NOT A NON-OWNING ADMIN. It used to be the latter, which is now
     * refused 403 by the owner gate before it can reach the already-published check — so
     * the test would have passed on the wrong refusal and stopped covering the 409 it exists for.
     */
    const second = await make().app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; results: { publishedById: string } };
    expect(body.code).toBe("ALREADY_PUBLISHED");
    // The FIRST publisher stands — a declared result does not change under the people who declared it.
    expect(body.results.publishedById).toBe("owner-1");
  });

  it("refuses to publish an experience with no released teams", async () => {
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s-draft", workshopId: HOME_WORKSHOP })]),
      workshops: ownedWorkshop,
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results/publish`, {
      method: "POST",
      headers: asUser(owner),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESULTS_NOTHING_RELEASED");
  });

  it("a published result is readable by an ENTITLED non-owner, and refused to an outsider", async () => {
    const published: WorkshopResults = {
      workshopId: HOME_WORKSHOP,
      publishedById: "owner-1",
      publishedAt: "2026-01-07T00:00:00.000Z",
      minScoresPerSubmission: 1,
      places: [
        {
          place: 1,
          teamId: "t1",
          submissionId: "s1",
          teamName: "Team s1",
          average: 9,
          judgeCount: 1,
        },
      ],
      tieBrokenById: null,
      tieBrokenAt: null,
    };

    const entitled = build({
      results: new FakeResults([published]),
      entitlements: new FakeEntitlements([HOME_WORKSHOP]),
    });
    const asJudge = await entitled.app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser({ id: "j1", role: "JUDGE" }),
    });
    expect(asJudge.status).toBe(200);

    const outsider = build({
      results: new FakeResults([published]),
      entitlements: new FakeEntitlements(["w-other"]),
    });
    const asStranger = await outsider.app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser({ id: "nobody", role: "PARTICIPANT" }),
    });
    expect(asStranger.status).toBe(403);
  });
});

// ─── Scoring ────────────────────────────────────────────────────────────────

describe("POST /v1/submissions/:submissionId/scores", () => {
  it("keys the score to the judge's identity, ignoring a judgeId in the body", async () => {
    // The (submissionId, judgeId) key is what makes re-scoring an overwrite rather
    // than a second vote. Accepting a body judgeId would let one judge stuff the
    // ballot under other judges' names.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
    });

    await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ judgeId: "judge-2" })),
    });

    expect(scores.rows[0]).toMatchObject({ submissionId: "s1", judgeId: "judge-1" });
  });

  /**
   * ── ⚠ THREE TESTS WERE REMOVED FROM HERE, AND THEY PINNED THE DEFECT ────────────────────
   *
   * This is the one case where deleting an assertion is not weakening the suite, so it is recorded
   * rather than done quietly. The three were:
   *
   *   1. "coerces every criterion to a number, defaulting junk to 0"
   *   2. "turns 0 and NaN-ish values into 0 rather than leaving them falsy-undefined"
   *   3. "does NOT clamp criteria to a range (a known gap, pinned deliberately)"
   *
   * All three asserted the behaviour of `Number(body.x) || 0`, and #3 says outright that it was
   * pinning a KNOWN GAP so that closing it would be "a conscious, visible change rather than an
   * accident". This is that change, made deliberately and visibly: the score-validation tests below
   * replace the gap with a rule, so the tests that guarded the gap are replaced by tests that guard the rule.
   *
   * ⚠ WHAT THE OLD TESTS WERE RIGHT ABOUT is kept below: a stored criterion must never be a string
   * or a NaN, because every downstream average depends on it. The difference is that the value is now
   * REFUSED at the door instead of being converted into a plausible-looking 0.
   */
  it("refuses a criterion above the scale, and NAMES it — nothing is stored", async () => {
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
      events,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 999 })),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; fields: string[] };
    expect(body.code).toBe("SCORE_OUT_OF_RANGE");
    expect(body.fields, "the refusal must name the field so a form can mark it").toEqual([
      "innovation",
    ]);
    // ⚠ NOTHING PARTIAL. A refused score must not land, and must not tell consumers it did.
    expect(scores.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("refuses a non-numeric string rather than storing it as 0", async () => {
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ execution: "not a number" })),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(["execution"]);
    expect(scores.rows, "a typo must not become a real score of 0").toHaveLength(0);
  });

  it("refuses 0 (the scale starts at 1) and accepts 10", async () => {
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
    });

    const zero = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 0 })),
    });
    expect(zero.status).toBe(400);

    const ten = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 10 })),
    });
    expect(ten.status).toBe(201);
    expect(scores.rows[0].innovation).toBe(10);
  });

  it("refuses a non-integer", async () => {
    const { app } = build({ submissions: new FakeSubmissions([released({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ presentation: 7.5 })),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(["presentation"]);
  });

  it("refuses a MISSING criterion instead of defaulting it", async () => {
    const body = validScores() as Record<string, unknown>;
    delete body.presentation;
    const { app } = build({ submissions: new FakeSubmissions([released({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { fields: string[] }).fields).toEqual(["presentation"]);
  });

  it("names EVERY offending field, not just the first", async () => {
    const { app } = build({ submissions: new FakeSubmissions([released({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 0, execution: 99, presentation: "x" })),
    });

    expect(((await res.json()) as { fields: string[] }).fields).toEqual([
      "innovation",
      "execution",
      "presentation",
    ]);
  });

  it("stores the four criteria as the integers they were sent as", async () => {
    // What the deleted coercion tests were RIGHT about: nothing stored may be a string or NaN,
    // because every downstream average depends on these being numbers.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
    });

    await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(scores.rows[0]).toMatchObject({
      innovation: 8,
      execution: 7,
      impact: 6,
      presentation: 5,
    });
    for (const criterion of ["innovation", "execution", "impact", "presentation"]) {
      expect(typeof (scores.rows[0] as unknown as Record<string, unknown>)[criterion]).toBe(
        "number"
      );
    }
    // ⚠ AND `aiUsage` IS NOT WRITTEN AT ALL ANY MORE. A new row carrying it would mean the route
    // still reads a criterion nothing scores — the shape that let this drift for three days.
    expect(scores.rows[0]).not.toHaveProperty("aiUsage");
  });

  it("refuses to score a DRAFT submission — 409 NOT_RELEASED", async () => {
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    // The DEFAULT builder, i.e. a draft — the case this route accepted until now.
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      scores,
      events,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_RELEASED");
    expect(scores.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("checks NOT_RELEASED before it inspects the scores", async () => {
    // Ordering, not decoration: a judge must not be able to learn whether their numbers were
    // well-formed by probing an unreleased draft.
    const { app } = build({ submissions: new FakeSubmissions([submission({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 999 })),
    });

    expect(res.status, "the DRAFT refusal wins over the invalid-score refusal").toBe(409);
  });

  /**
   * ── ⚠ THE ORIGINAL RE-SCORING RULE IS SUPERSEDED, AND THIS TEST NOW ASSERTS THE REPLACEMENT ─────
   *
   * The original rule read "re-scoring overwrites and does not create a second". Its PURPOSE was
   * anti-ballot-stuffing: a second submission must not become a second vote. That purpose still holds
   * here, and by a stronger mechanism — the second submission is REFUSED outright.
   *
   * ⚠ THE CHANGE IS A PRODUCT DECISION, NOT A BUG FIX: "a score is final once submitted", so the
   * overwrite the original rule permitted is gone. Recorded here rather than diverged from silently —
   * the same treatment the workshop service gives its own superseded authorization matrix, which it
   * annotates as "now wrong". services/ROLES.md records the same decision.
   */
  it("supersedes the overwrite rule: a second score from the same judge is REFUSED, not applied", async () => {
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
    });

    const first = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 4 })),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ innovation: 9 })),
    });

    // ⚠ 409, NOT 201 — this is where the behaviour changed. See the note above the test name.
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("ALREADY_SCORED");

    // The anti-ballot-stuffing property the overwrite rule existed for STILL HOLDS, and by a stronger mechanism:
    // one row per judge, and the FIRST score is the one that stands.
    expect(scores.rows, "keyed (submissionId, judgeId) — one row per judge").toHaveLength(1);
    expect(scores.rows[0].innovation, "the first score stands; the second is refused").toBe(4);
  });

  it("accepts a comment at the cap and refuses one over it", async () => {
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      scores,
    });

    const atCap = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ comment: "x".repeat(MAX_SCORE_COMMENT_CHARS) })),
    });
    expect(atCap.status).toBe(201);

    const overCap = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ comment: "x".repeat(MAX_SCORE_COMMENT_CHARS + 1) })),
    });
    expect(overCap.status).toBe(400);
    expect(((await overCap.json()) as { code: string }).code).toBe("COMMENT_TOO_LONG");

    // ⚠ REFUSED, NOT TRUNCATED — the stored comment is still the one that fit.
    expect(scores.rows[0].comment).toHaveLength(MAX_SCORE_COMMENT_CHARS);
  });

  it("refuses a non-string comment", async () => {
    const { app } = build({ submissions: new FakeSubmissions([released({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({ comment: { nested: true } })),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("COMMENT_INVALID");
  });

  it("a malformed JSON body is a 400, not a 500", async () => {
    const { app } = build({ submissions: new FakeSubmissions([released({ id: "s1" })]) });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: "{not json",
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
  });

  it("404s a submission that does not exist, and writes NO orphan score row", async () => {
    // The route never loaded the submission, so a typo in a judge's URL "succeeded"
    // with a 201 and persisted a Score keyed to an id that was never created. No read
    // path can ever surface such a row (every score read starts from a submission), so
    // it is invisible while quietly inflating any future aggregate.
    const scores = new FakeScores([]);
    const events = new InMemoryPublisher();
    const { app } = build({ submissions: new FakeSubmissions([]), scores, events });

    const res = await app.request("/v1/submissions/typo-id/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify({ innovation: 5 }),
    });

    expect(res.status).toBe(404);
    expect(scores.rows).toHaveLength(0);
    // No event either — a scored event for a nonexistent submission would drive
    // consumers off a record that isn't there.
    expect(events.published).toHaveLength(0);
  });

  it("checks the ROLE before it looks the submission up", async () => {
    // Cheap local check first. It also means a non-judge cannot use the 404-vs-201
    // difference to probe which submission ids exist.
    const { app } = build({ submissions: new FakeSubmissions([]) });

    const res = await app.request("/v1/submissions/does-not-exist/scores", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ innovation: 5 }),
    });

    expect(res.status).toBe(403);
  });

  it("still scores a submission the judge is not a team member of", async () => {
    // The existence check must not become a membership check by accident: a judge is never
    // on the teams they score. STILL TRUE AFTER BACKLOG P0-3, and it is the property that
    // distinguishes the two gates: the scope is decided by ENTITLEMENT to the submission's
    // workshop, NOT by team access. The Team context refuses this caller everything and the
    // score lands anyway, because they are entitled to w1 (the default fixture's workshop).
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1", teamId: "t-not-mine" })]),
      scores,
      teamAccess: new FakeTeamAccess(false, false),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(201);
    expect(scores.rows).toHaveLength(1);
  });

  it("publishes submission.scored", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      events,
    });

    // JUDGE and not ADMIN: this used to score as an admin, which is no longer possible
    // (SCORING_ROLES). The actor id was already "judge-1", so the old header was
    // describing a judge and asserting an admin — the change makes the test say what it meant.
    await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(events.published).toEqual([
      {
        source: "evaluation-service",
        type: "submission.scored",
        detail: { submissionId: "s1", judgeId: "judge-1" },
      },
    ]);
  });
});

// ─── P0-3: judge scoping is WORKSHOP-SCOPED ───────────────────
//
// The last P0 on this platform. Before this, any JUDGE scored any submission in ANY
// workshop: role was the whole gate. The recon suite in backlog1-recon.test.ts pins the
// headline attack end-to-end; this block pins the surrounding matrix — the ordering
// properties, the body-ignoring, and the failure ladder on the CREATE path — because the
// recon file is a record of specific defects and this one is the route's contract.

describe("POST /v1/submissions/:submissionId/scores — workshop scope", () => {
  it("asks the entitlement port ONCE, with the verified role and NO subject parameter", async () => {
    // An entitlement probe that takes a subject is an enumeration oracle for "who can see
    // which workshop". The interface has no userId/email
    // parameter at all, so this asserts the shape that keeps it that way — and asserts ONE
    // call, so a guard that probed per-criterion or re-probed on the read would show up.
    const entitlements = new FakeEntitlements(["w1"]);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1", workshopId: "w1" })]),
      entitlements,
    });

    await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", email: "j@example.com", role: "JUDGE" }),
      body: JSON.stringify({ innovation: 5 }),
    });

    expect(entitlements.calls).toEqual(["JUDGE"]);
  });

  it("checks the ROLE before the entitlement hop — a PARTICIPANT costs no hop", async () => {
    // The order is the design: the local branch first, so a non-judge is refused from the
    // token alone. It also means the 403/404/201 differences cannot be used by a
    // participant to probe which submission ids exist or which workshop one belongs to.
    const entitlements = new FakeEntitlements(["w1"]);
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      entitlements,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ innovation: 5 }),
    });

    expect(res.status).toBe(403);
    expect(entitlements.calls).toEqual([]);
  });

  it("404s a nonexistent submission BEFORE the entitlement hop", async () => {
    // Integrity first: a scope check on a submission that does not exist has nothing to
    // decide about, and spending an east-west call to discover that is waste. The 404 also
    // predates the scope decision, so it cannot leak whether a judge WOULD have been
    // entitled to an id that does not exist.
    const entitlements = new FakeEntitlements(["w1"]);
    const { app } = build({ submissions: new FakeSubmissions([]), entitlements });

    const res = await app.request("/v1/submissions/ghost/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify({ innovation: 5 }),
    });

    expect(res.status).toBe(404);
    expect(entitlements.calls).toEqual([]);
  });

  it("decides on the SUBMISSION's stored workshop, not on a caller-supplied one", async () => {
    // The rule that makes the whole guard sound. A judge entitled to w-mine names a
    // submission in w-theirs and additionally CLAIMS w-mine in the body and the query
    // string. Both are ignored; the stored value decides.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([
        submission({ id: "s-theirs", workshopId: "w-theirs" }),
      ]),
      scores,
      entitlements: new FakeEntitlements(["w-mine"]),
    });

    const res = await app.request("/v1/submissions/s-theirs/scores?workshopId=w-mine", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify({ innovation: 9, workshopId: "w-mine" }),
    });

    expect(res.status).toBe(403);
    expect(scores.rows).toHaveLength(0);
  });

  it("admits a judge entitled to one of SEVERAL workshops (grants accumulate)", async () => {
    // THE RULE: a judge invited to two workshops sees both. The entitlement set is a set, and membership in it is what grants.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1", workshopId: "w-second" })]),
      scores,
      entitlements: new FakeEntitlements(["w-first", "w-second", "w-third"]),
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores()),
    });

    expect(res.status).toBe(201);
    expect(scores.rows).toHaveLength(1);
  });
});

describe("POST /v1/teams/:teamId/submissions — the workshop is SERVER-DERIVED", () => {
  it("stores the workshop the TEAM belongs to, whatever the body says", async () => {
    // The server-derived-scope rule: "a test posts a mismatched value and asserts the stored one
    // came from the team". The rule exists because the stored value is what the
    // scoring guard above decides on — a scope a participant can name is not a scope.
    const submissions = new FakeSubmissions([]);
    const { app } = build({
      submissions,
      teamAccess: new FakeTeamAccess(true, true, true, true, "w-authoritative"),
    });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ workshopId: "w-attacker-chose" }),
    });

    expect(res.status).toBe(201);
    expect(submissions.rows[0].workshopId).toBe("w-authoritative");
    expect(JSON.stringify(submissions.rows[0])).not.toContain("w-attacker-chose");  // nosemgrep: no-stringify-keys
  });

  it("503s and writes NOTHING when the team scope cannot be determined", async () => {
    // THE RULE THAT PROTECTS THE DATA, not just the request. A row stored with
    // `workshopId: null` is PERMANENTLY unscoreable — the scoring guard refuses null scopes
    // with SUBMISSION_SCOPE_UNKNOWN and cannot do otherwise — so degrading a Team brownout
    // into a null-scoped write would turn a two-second outage into a data-repair task.
    const submissions = new FakeSubmissions([]);
    const events = new InMemoryPublisher();
    const { app } = build({
      submissions,
      events,
      teamAccess: new FakeTeamAccess(true, true, true, true, "unavailable"),
    });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "Ours" }),
    });

    expect(res.status).toBe(503);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "TEAM_SCOPE_UNAVAILABLE",
    });
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(submissions.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("404s and writes NOTHING when the team resolves to no workshop", async () => {
    // A DETERMINED "this team has no workshop" — distinct from the 503 above. In practice
    // it means no such team, because `workshopId` is the teams table's PARTITION KEY so no
    // real row can lack it. Either way it must not become a null-scoped row.
    const submissions = new FakeSubmissions([]);
    const { app } = build({
      submissions,
      teamAccess: new FakeTeamAccess(true, true, true, true, null),
    });

    const res = await app.request("/v1/teams/t-ghost/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "EXECUTIVE" }),
      body: JSON.stringify({ title: "Ours" }),
    });

    expect(res.status).toBe(404);
    expect(submissions.rows).toHaveLength(0);
  });

  /**
   * ── ⚠ THESE TWO TESTS ARE THE INVERSE OF THE PAIR THEY REPLACED ───────────────────────────
   *
   * They used to assert "a member may create, a read-only EXECUTIVE is refused with `Read-only role` and
   * no hop". The rule is now that only executives submit, so both answers flip.
   * Recorded rather than quietly rewritten, because a reader finding `EXECUTIVE_ONLY` on a CREATE route
   * needs to know the old rule was deliberate-and-withdrawn, not never-implemented.
   *
   * The REASON the old rule could not stand: the earlier design itself notes that the Submit tab is a staff
   * screen a PARTICIPANT cannot reach, and that an executive is "the only role that can both reach the tab
   * and hold a membership row". So the only person able to open the form was the one role forbidden from
   * using it — no draft could be created, no demoUrl set, and release precondition P4 was unsatisfiable.
   */
  it("403s a NON-EXECUTIVE member LOCALLY, without asking Team at all", async () => {
    // The role branch is local and first, so a refused participant costs no east-west hop.
    // Asserted on the CALL LIST, not just the status.
    const teamAccess = new FakeTeamAccess(true, true, true, true, "w1");
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions, teamAccess });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
    expect(teamAccess.predicates).toEqual([]);
    expect(submissions.rows).toHaveLength(0);
  });

  it("403s an EXECUTIVE who is not on this team — executive AND member, both", async () => {
    // "Executive" is not a licence over an arbitrary team's submission, exactly as release has it.
    const submissions = new FakeSubmissions([]);
    const { app } = build({
      submissions,
      teamAccess: new FakeTeamAccess(false, false, false, false, "w1"),
    });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "outsider", role: "EXECUTIVE" }),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_A_TEAM_MEMBER");
    expect(submissions.rows).toHaveLength(0);
  });

  it("CREATES for an executive ON the team — the path that was previously impossible", async () => {
    const submissions = new FakeSubmissions([]);
    const { app } = build({ submissions, teamAccess: new FakeTeamAccess(true, true, true, true, "w1") });

    const res = await app.request("/v1/teams/t1/submissions", {
      method: "POST",
      headers: asUser({ id: "exec", role: "EXECUTIVE" }),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(201);
    expect(submissions.rows).toHaveLength(1);
    expect(submissions.rows[0]).toMatchObject({ createdById: "exec", workshopId: "w1" });
  });
});

describe("the submission READ routes — read widening", () => {
  const READ_PATHS = ["/v1/submissions/s1", "/v1/submissions/s1/scores"];

  for (const path of READ_PATHS) {
    it(`${path} asks the TEAM predicate FIRST and skips the entitlement hop on a hit`, async () => {
      // What makes the widening INERT for everyone who already had access: a caller Team
      // admits is answered exactly as before — one hop, same predicate, no entitlement
      // call. The second hop exists only on the path that used to be a 403.
      const teamAccess = new FakeTeamAccess(true, true);
      const entitlements = new FakeEntitlements(["w1"]);
      const { app } = build({
        submissions: new FakeSubmissions([submission({ id: "s1" })]),
        teamAccess,
        entitlements,
      });

      const res = await app.request(path, {
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      });

      /**
       * ⚠ THE GATE IS WHAT THIS TEST IS ABOUT, AND THE GATE IS UNCHANGED — `canRead` first, no
       * entitlement hop on a hit. Both are still asserted below.
       *
       * Only the STATUS differs by path now: `/scores` applies a payload rule AFTER the gate (judges'
       * scores go to ADMIN/FACILITATOR, a judge sees their own row, a team member is refused), so a
       * PARTICIPANT passes the gate and is then refused the body. The bare submission read is
       * unaffected — a team may read its own submission.
       */
      expect(res.status).toBe(path.endsWith("/scores") ? 403 : 200);
      expect(teamAccess.predicates).toEqual(["canRead"]);
      expect(entitlements.calls).toEqual([]);
    });

    it(`${path} 403s a NON-scoring role with no entitlement hop`, async () => {
      // The widening is for scoring roles only. A participant Team refuses gets today's
      // 403 from the local role check, without a second hop — so the change cannot have
      // widened anything for them.
      const entitlements = new FakeEntitlements(["w1"]);
      const { app } = build({
        submissions: new FakeSubmissions([submission({ id: "s1" })]),
        teamAccess: new FakeTeamAccess(false, false),
        entitlements,
      });

      const res = await app.request(path, {
        headers: asUser({ id: "stranger", role: "PARTICIPANT" }),
      });

      expect(res.status).toBe(403);
      expect(entitlements.calls).toEqual([]);
    });

    it(`${path} 503s a judge when the entitlement hop cannot answer`, async () => {
      // Undetermined is not a denial on the read path either. A judge shown "Forbidden"
      // during a Team brownout would reasonably conclude their invitation was revoked.
      const { app } = build({
        submissions: new FakeSubmissions([submission({ id: "s1" })]),
        teamAccess: new FakeTeamAccess(false, false),
        entitlements: new FakeEntitlements("unavailable"),
      });

      const res = await app.request(path, {
        headers: asUser({ id: "judge-1", role: "JUDGE" }),
      });

      expect(res.status).toBe(503);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "ENTITLEMENTS_UNAVAILABLE",
      });
    });

    it(`${path} refuses a judge a NULL-SCOPED submission with SUBMISSION_SCOPE_UNKNOWN`, async () => {
      // The read path shares the write path's predicate, so it shares its data-problem
      // code. A legacy row is not readable by a judge on the entitlement branch either —
      // there is no workshop to be entitled to.
      const entitlements = new FakeEntitlements(["w1"]);
      const { app } = build({
        submissions: new FakeSubmissions([submission({ id: "s1", workshopId: null })]),
        teamAccess: new FakeTeamAccess(false, false),
        entitlements,
      });

      const res = await app.request(path, {
        headers: asUser({ id: "judge-1", role: "JUDGE" }),
      });

      expect(res.status).toBe(403);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: "SUBMISSION_SCOPE_UNKNOWN",
      });
      expect(entitlements.calls).toEqual([]);
    });

    it(`${path} refuses an ADMIN whom Team refuses — the short-circuit is gone`, async () => {
      /**
       * ⚠ THIS PREVIOUSLY ASSERTED 200, AND THE INVERSION IS THE RULE CHANGE. The old
       * comment called it "the operator escape hatch surviving a brownout, per the original
       * condition 2": a non-member ADMIN was admitted to the submission read by the SCORING
       * branch of the predicate, with no hop, even with Team unreachable.
       *
       * Two things removed it. `SCORING_ROLES` no longer contains ADMIN, so branch 2 cannot
       * admit them at all; and Team's `canRead` no longer answers wide for an admin, so
       * branch 1 refuses one who does not own the team's experience. ⚠ The original condition 2
       * is wrong as written for both paths and needs amending — recorded, not smoothed over.
       *
       * ⚠ 403 AND NOT 503, WHICH IS THE PART THAT WOULD BE EASY TO GET WRONG. The entitlement
       * source here is deliberately "unavailable", so a predicate that consulted it would owe
       * a 503 under the unavailable-not-an-answer rule. This refusal does not depend on it: the caller's ROLE settles
       * the question locally, and `calls` stays empty. Undetermined is still never denied —
       * there is simply nothing undetermined on this path.
       */
      const entitlements = new FakeEntitlements("unavailable");
      const { app } = build({
        submissions: new FakeSubmissions([submission({ id: "s1" })]),
        teamAccess: new FakeTeamAccess(false, false),
        entitlements,
      });

      const res = await app.request(path, {
        headers: asUser({ id: "admin-1", role: "ADMIN" }),
      });

      expect(res.status).toBe(403);
      expect(entitlements.calls).toEqual([]);
    });
  }
});

// ─── Ratings ────────────────────────────────────────────────────────────────

describe("POST /v1/teams/:teamId/ratings", () => {
  it("400s without ratedUserId and stores nothing", async () => {
    // Without a subject the row is unattributable, and (teamId, id) would still make
    // it a valid-looking row that no aggregation could ever use.
    const ratings = new FakeRatings([]);
    const events = new InMemoryPublisher();
    const { app } = build({ ratings, events });

    const res = await app.request("/v1/teams/t1/ratings", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ score: 80 }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "ratedUserId is required" });
    expect(ratings.rows).toHaveLength(0);
    expect(events.published).toHaveLength(0);
  });

  it("clamps the score into 0..100", async () => {
    const ratings = new FakeRatings([]);
    const { app } = build({ ratings });
    const headers = asUser({ id: "u1", role: "PARTICIPANT" });

    // ⚠ A DISTINCT SUBJECT PER ITERATION. These all named "u2", which worked only
    // while a rater could rate the same teammate without limit — the unbounded-rows defect. One
    // rating per (rater, rated) is now enforced at the store, so re-rating "u2" would answer 409
    // and this loop would assert against the FIRST row five times.
    for (const [given, expected, subject] of [
      [150, 100, "u2"],
      [-20, 0, "u3"],
      [55, 55, "u4"],
      [0, 0, "u5"],
      [100, 100, "u6"],
    ] as const) {
      await app.request("/v1/teams/t1/ratings", {
        method: "POST",
        headers,
        body: JSON.stringify({ ratedUserId: subject, score: given }),
      });
      expect(ratings.rows.at(-1)?.score).toBe(expected);
    }
  });

  it("defaults an unparseable score to 0 rather than storing NaN", async () => {
    const ratings = new FakeRatings([]);
    const { app } = build({ ratings });

    await app.request("/v1/teams/t1/ratings", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ ratedUserId: "u2", score: "excellent" }),
    });

    // A NaN would be rejected outright by DynamoDB's number type.
    expect(ratings.rows[0].score).toBe(0);
  });

  it("stamps raterId from the identity, ignoring a raterId in the body", async () => {
    const ratings = new FakeRatings([]);
    const { app } = build({ ratings });

    await app.request("/v1/teams/t1/ratings", {
      method: "POST",
      headers: asUser({ id: "real-rater", role: "PARTICIPANT" }),
      body: JSON.stringify({ ratedUserId: "u2", raterId: "someone-else", score: 50 }),
    });

    expect(ratings.rows[0].raterId).toBe("real-rater");
  });

  it("publishes member.rated", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    await app.request("/v1/teams/t1/ratings", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ ratedUserId: "u2", score: 50 }),
    });

    expect(events.published).toEqual([
      {
        source: "evaluation-service",
        type: "member.rated",
        detail: { teamId: "t1", raterId: "u1", ratedUserId: "u2" },
      },
    ]);
  });

  /**
   * ── ⚠ BOUNDS ON A PEER RATING ─────────────────────────────────────────────────────────────
   *
   * The route minted a fresh `ulid()` per call with no per-(rater, rated) uniqueness, stored
   * `body.comment` with no length cap, and never checked `ratedUserId` against anything —
   * self-rating included. So an authorized member could:
   *
   *   · rate the same teammate without limit, every row stored and every row returned by
   *     `listByTeam`, drowning out their teammates' opinions in the team's own ratings view;
   *   · store an unbounded comment on a row that is COPIED INLINE into the release snapshot, so an
   *     oversized one also risked pushing the submission item past DynamoDB's 400 KB limit and
   *     making release itself fail;
   *   · award themselves a score in the list an executive reads.
   */
  describe("bounds", () => {
    const rater = asUser({ id: "u1", role: "PARTICIPANT" });

    function rate(app: ReturnType<typeof build>["app"], body: unknown, who = rater) {
      return app.request("/v1/teams/t1/ratings", {
        method: "POST",
        headers: who,
        body: JSON.stringify(body),
      });
    }

    it("REFUSES a second rating of the same teammate", async () => {
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings });

      const first = await rate(app, { ratedUserId: "u2", score: 90, comment: "great" });
      expect(first.status).toBe(201);

      const second = await rate(app, { ratedUserId: "u2", score: 10, comment: "revised" });

      expect(second.status).toBe(409);
      expect((await second.json()).code).toBe("ALREADY_RATED");
      // ⚠ THE FIRST OPINION STANDS, unmodified — and there is exactly ONE row, which is the
      // unbounded-storage half of the finding.
      expect(ratings.rows).toHaveLength(1);
      expect(ratings.rows[0]).toMatchObject({ score: 90, comment: "great" });
    });

    it("still lets a DIFFERENT rater rate the same teammate", async () => {
      // ⚠ THE PROPERTY THE TABLE'S KEY DESIGN PROTECTS. Keying on ratedUserId alone would make a
      // person's rating single-valued per team, so a second rater would overwrite the first —
      // "wrong for peer rating by construction". The rater is in the row id precisely so this works.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings });

      await rate(app, { ratedUserId: "u2", score: 90 });
      const other = await rate(app, { ratedUserId: "u2", score: 40 }, asUser({ id: "u9", role: "PARTICIPANT" }));

      expect(other.status).toBe(201);
      expect(ratings.rows).toHaveLength(2);
      expect(ratings.rows.map((r) => r.raterId).sort()).toEqual(["u1", "u9"]);
    });

    it("still lets one rater rate SEVERAL teammates", async () => {
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings });

      for (const subject of ["u2", "u3", "u4"]) {
        expect((await rate(app, { ratedUserId: subject, score: 50 })).status).toBe(201);
      }
      expect(ratings.rows).toHaveLength(3);
    });

    it("REFUSES a self-rating", async () => {
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings });

      const res = await rate(app, { ratedUserId: "u1", score: 100 });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("SELF_RATING_REFUSED");
      expect(ratings.rows).toHaveLength(0);
    });

    it("REFUSES an oversized comment", async () => {
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings });

      const res = await rate(app, {
        ratedUserId: "u2",
        score: 50,
        comment: "x".repeat(MAX_SCORE_COMMENT_CHARS + 1),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("COMMENT_TOO_LONG");
      expect(ratings.rows).toHaveLength(0);
    });

    it("accepts a comment exactly at the limit", async () => {
      // The boundary, so the cap is off-by-one-proof in the direction that would silently refuse
      // a legitimate comment.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings });

      const res = await rate(app, {
        ratedUserId: "u2",
        score: 50,
        comment: "x".repeat(MAX_SCORE_COMMENT_CHARS),
      });

      expect(res.status).toBe(201);
    });

    it("REFUSES a ratedUserId that is not a usable id", async () => {
      // `if (!body.ratedUserId)` was the only check, so any truthy value became key material.
      for (const value of [
        { ratedUserId: 12345 },
        { ratedUserId: {} },
        { ratedUserId: [] },
        { ratedUserId: "   " },
        { ratedUserId: "x".repeat(200) },
        // `#` is the separator in the derived row key, so admitting it would let two different
        // pairs collide on one row.
        { ratedUserId: "u2#u3" },
      ]) {
        const ratings = new FakeRatings([]);
        const { app } = build({ ratings });

        const res = await rate(app, { ...value, score: 50 });

        expect(res.status, JSON.stringify(value)).toBe(400);
        expect(ratings.rows, JSON.stringify(value)).toHaveLength(0);
      }
    });

    /**
     * ── ⚠ THE HALF LOCAL BOUNDS COULD NOT REACH ────────────────────────────────────────
     *
     * The length, charset, self-rating and one-row-per-pair rules above all bound the SHAPE of
     * `ratedUserId`. None of them bounds its MEANING: only the Team context knows who is on a team.
     * Without this check a member could file a rating for any id at all — and because the pair's
     * second half was unbounded, the per-pair uniqueness rule did not cap the row count either. A
     * rater could mint a fresh row per invented id, forever.
     *
     * ⚠ ASKED, NEVER READ. The port re-presents the caller's own token against Team's roster route,
     * so this service gains no authority it could not exercise as that user — and only a BOOLEAN
     * crosses the port, so the emails on that response never enter this service.
     */
    it("REFUSES a rating for somebody who is not on the team", async () => {
      const ratings = new FakeRatings([]);
      const roster = new FakeRoster(["u1", "u2"]);
      const { app } = build({ ratings, roster });

      const res = await rate(app, { ratedUserId: "stranger", score: 50 });

      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("NOT_A_TEAM_MEMBER");
      expect(ratings.rows).toHaveLength(0);
      // It asked about the SUBJECT, not the caller — the whole point of the hop.
      expect(roster.calls).toEqual([{ teamId: "t1", userId: "stranger" }]);
    });

    it("caps the rows a single rater can create, which uniqueness alone did not", async () => {
      // ⚠ THE RESOURCE HALF OF THE FINDING. One row per (rater, rated) bounds nothing if the rated
      // half is arbitrary; the roster is what makes the bound finite.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings, roster: new FakeRoster(["u1", "u2"]) });

      for (let i = 0; i < 25; i += 1) {
        await rate(app, { ratedUserId: `invented-${i}`, score: 50 });
      }

      expect(ratings.rows).toHaveLength(0);
    });

    it("REFUSES a rating for a REMOVED member", async () => {
      // A removed member's row survives, but somebody who has lost access to see or
      // answer an opinion is not a person a teammate may still file a new one about. The port
      // reports active membership only.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings, roster: new FakeRoster(["u1"]) });

      const res = await rate(app, { ratedUserId: "removed-teammate", score: 10 });

      expect(res.status).toBe(404);
      expect(ratings.rows).toHaveLength(0);
    });

    it("503s rather than refusing when the roster cannot be read", async () => {
      // ⚠ `"unavailable"` IS NOT `false`. Reporting an unanswered hop as "that person is
      // not on your team" would send a member arguing with a rule that will fix itself, and a
      // Retry-After is the truthful answer for something transient.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings, roster: new FakeRoster("all", true) });

      const res = await rate(app, { ratedUserId: "u2", score: 50 });

      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("ROSTER_UNAVAILABLE");
      expect(res.headers.get("Retry-After")).toBe("2");
      expect(ratings.rows).toHaveLength(0);
    });

    it("FAILS CLOSED when no roster port is wired at all", async () => {
      // ⚠ THE POLARITY THAT KEEPS THE FIX FIXED. `roster` is optional so the service still composes
      // where it is not wired — and if that absence meant "skip the check", every un-updated
      // deployment would silently restore the defect this closes.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings, roster: null });

      const res = await rate(app, { ratedUserId: "u2", score: 50 });

      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("ROSTER_UNAVAILABLE");
      expect(ratings.rows).toHaveLength(0);
    });

    it("still accepts a rating for a genuine teammate", async () => {
      // The regression guard: the hop must not refuse the case it exists to permit.
      const ratings = new FakeRatings([]);
      const { app } = build({ ratings, roster: new FakeRoster(["u1", "u2"]) });

      const res = await rate(app, { ratedUserId: "u2", score: 70 });

      expect(res.status).toBe(201);
      expect(ratings.rows).toHaveLength(1);
    });

    it("does not publish member.rated for a refused rating", async () => {
      // A published event for a rating that was not stored would give the activity read-model a
      // fact the store disagrees with.
      const events = new InMemoryPublisher();
      const { app } = build({ events });

      await rate(app, { ratedUserId: "u1", score: 100 });

      expect(events.published).toEqual([]);
    });
  });
});

describe("GET /v1/teams/:teamId/ratings", () => {
  it("weights the activity counters into a contribution score", async () => {
    // The weighting IS the contract the leaderboard renders: completed tasks 10,
    // commits 5, AI threads 4, created tasks 3, messages 1.
    const activity = new FakeActivity([
      activityRow({
        userId: "u1",
        tasksCompleted: 2, // 20
        tasksCreated: 1, //  3
        commitsPushed: 1, //  5
        messagesSent: 4, //  4
        aiThreadsShared: 1, //  4
      }),
    ]);
    const { app } = build({ activity });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { contributions: Array<{ contributionScore: number }> };
    expect(body.contributions[0].contributionScore).toBe(36);
  });

  it("caps the contribution score at 100", async () => {
    // A busy participant trivially exceeds 100 raw points; the cap keeps it a
    // percentage the UI can render as a bar.
    const activity = new FakeActivity([activityRow({ tasksCompleted: 50 })]);
    const { app } = build({ activity });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { contributions: Array<{ contributionScore: number }> };
    expect(body.contributions[0].contributionScore).toBe(100);
  });

  it("scores an all-zero member as 0, not as an omission", async () => {
    const activity = new FakeActivity([activityRow({ userId: "quiet" })]);
    const { app } = build({ activity });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { contributions: Array<{ userId: string; contributionScore: number }> };
    expect(body.contributions).toEqual([expect.objectContaining({ userId: "quiet", contributionScore: 0 })]);
  });

  it("sorts contributions highest-first", async () => {
    const activity = new FakeActivity([
      activityRow({ userId: "low", messagesSent: 1 }),
      activityRow({ userId: "high", tasksCompleted: 3 }),
      activityRow({ userId: "mid", tasksCreated: 2 }),
    ]);
    const { app } = build({ activity });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { contributions: Array<{ userId: string }> };
    expect(body.contributions.map((c) => c.userId)).toEqual(["high", "mid", "low"]);
  });

  it("enriches names from the local users read-model, with null when unknown", async () => {
    // Names come from the event-fed projection, never from the Identity service's
    // users table. A member the projection hasn't caught up on must render as null
    // rather than failing the whole leaderboard.
    const activity = new FakeActivity([
      activityRow({ userId: "known" }),
      activityRow({ userId: "unknown" }),
    ]);
    const users = new FakeUsers([{ id: "known", name: "Ada" }]);
    const { app } = build({ activity, users });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { contributions: Array<{ userId: string; name: string | null }> };
    expect(new Map(body.contributions.map((c) => [c.userId, c.name]))).toEqual(
      new Map([
        ["known", "Ada"],
        ["unknown", null],
      ])
    );
  });

  it("returns only this team's activity and peer ratings", async () => {
    const activity = new FakeActivity([
      activityRow({ teamId: "t1", userId: "mine" }),
      activityRow({ teamId: "t2", userId: "theirs" }),
    ]);
    const ratings = new FakeRatings([
      {
        teamId: "t1",
        id: "r1",
        raterId: "u1",
        ratedUserId: "u2",
        score: 80,
        comment: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        teamId: "t2",
        id: "r2",
        raterId: "x",
        ratedUserId: "y",
        score: 10,
        comment: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({ activity, ratings });

    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as {
      contributions: Array<{ userId: string }>;
      peerRatings: Array<{ id: string }>;
    };
    expect(body.contributions.map((c) => c.userId)).toEqual(["mine"]);
    expect(body.peerRatings.map((r) => r.id)).toEqual(["r1"]);
  });

  it("returns empty collections for a team with no activity yet", async () => {
    const { app } = build();
    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(await res.json()).toEqual({ contributions: [], peerRatings: [] });
  });
});

// ─── The activity projection ────────────────────────────────────────────────

describe("applyActivityEvent", () => {
  it("maps each domain event onto its counter", async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["task.created", {}, "tasksCreated"],
      ["task.status-changed", { status: "DONE" }, "tasksCompleted"],
      ["message.sent", {}, "messagesSent"],
      ["commit.pushed", {}, "commitsPushed"],
      ["ai.thread-shared", {}, "aiThreadsShared"],
    ];

    for (const [type, extra, counter] of cases) {
      const activity = new FakeActivity([]);
      await applyActivityEvent(activity, {
        source: "test",
        type,
        detail: { teamId: "t1", userId: "u1", ...extra },
      });
      expect(activity.increments).toEqual([
        { teamId: "t1", userId: "u1", counter, by: 1, eventId: undefined },
      ]);
    }
  });

  it("counts a status change ONLY when the new status is DONE", async () => {
    // Every board drag emits task.status-changed. Counting them all would make
    // shuffling columns the fastest way to top the leaderboard.
    for (const status of ["TODO", "IN_PROGRESS", "BLOCKED", "done", undefined]) {
      const activity = new FakeActivity([]);
      await applyActivityEvent(activity, {
        source: "test",
        type: "task.status-changed",
        detail: { teamId: "t1", userId: "u1", status },
      });
      expect(activity.increments).toHaveLength(0);
    }
  });

  it("skips an event it cannot attribute to a (team, user)", async () => {
    // Both keys are required — the projection row is keyed on the pair, so a partial
    // event has nowhere to go. Skipping is correct here (unlike a write failure) and
    // must NOT throw, or an unattributable event would retry forever and then DLQ.
    const activity = new FakeActivity([]);
    for (const detail of [
      { userId: "u1" },
      { teamId: "t1" },
      {},
      { teamId: "", userId: "u1" },
      { teamId: "t1", userId: "" },
    ]) {
      await applyActivityEvent(activity, { source: "test", type: "task.created", detail });
    }
    expect(activity.increments).toHaveLength(0);
  });

  it("tolerates a missing detail entirely", async () => {
    const activity = new FakeActivity([]);
    await expect(
      applyActivityEvent(activity, { source: "test", type: "task.created" } as never)
    ).resolves.toBeUndefined();
    expect(activity.increments).toHaveLength(0);
  });

  it("ignores unknown event types instead of failing", async () => {
    // The EventBridge rule can be widened before this switch learns the new type;
    // an unrecognised event must be a no-op, not a throw that DLQs valid traffic.
    const activity = new FakeActivity([]);
    for (const type of ["user.created", "workshop.phase-advanced", "totally.new", ""]) {
      await applyActivityEvent(activity, {
        source: "test",
        type,
        detail: { teamId: "t1", userId: "u1" },
      });
    }
    expect(activity.increments).toHaveLength(0);
  });

  it("propagates a read-model failure to the caller", async () => {
    // handler.ts relies on this: the throw is what makes EventBridge retry and
    // eventually DLQ, because a dropped projection update is unrecoverable data loss.
    const activity = new FakeActivity([]);
    activity.increment = async () => {
      throw new Error("ConditionalCheckFailed");
    };
    await expect(
      applyActivityEvent(activity, {
        source: "test",
        type: "task.created",
        detail: { teamId: "t1", userId: "u1" },
      })
    ).rejects.toThrow("ConditionalCheckFailed");
  });
});

describe("CONTRACT: the projection accepts what the publishers ACTUALLY emit", () => {
  /**
   * THE TEST THAT WAS MISSING, and its absence let the activity read-model sit empty for the
   * entire life of the split services.
   *
   * Every other test in this describe-file hand-builds `detail: { teamId: "t1", userId: "u1" }`
   * — a shape NO publisher emitted. Meanwhile each publisher's own test used `toMatchObject`,
   * which passes when a field is ABSENT. Both sides asserted their own assumption and the
   * contract between them was asserted by nobody, so `applyActivityEvent`'s
   * "can't attribute — skip" guard dropped 100% of real traffic.
   *
   * The payloads below are COPIED FROM THE PUBLISHERS, verbatim, including the domain-specific
   * names they still carry. If a publisher changes its shape and forgets `userId` again, the
   * corresponding case here fails.
   *
   *   collaboration/src/routes.ts  task.created, task.status-changed, message.sent
   *   source/src/routes.ts         commit.pushed
   *   ai/src/routes.ts             ai.thread-shared
   */
  const REAL_PAYLOADS: Array<{
    type: string;
    source: string;
    detail: Record<string, unknown>;
    counter: string;
  }> = [
    {
      type: "task.created",
      source: "collaboration-service",
      detail: { taskId: "task-1", teamId: "t1", title: "T", aiGenerated: false, creatorId: "u1", userId: "u1" },
      counter: "tasksCreated",
    },
    {
      type: "task.status-changed",
      source: "collaboration-service",
      detail: { taskId: "task-1", teamId: "t1", status: "DONE", userId: "u1" },
      counter: "tasksCompleted",
    },
    {
      type: "message.sent",
      source: "collaboration-service",
      detail: { messageId: "m1", teamId: "t1", senderId: "u1", userId: "u1", type: "TEXT" },
      counter: "messagesSent",
    },
    {
      type: "commit.pushed",
      source: "source-service",
      detail: { teamId: "t1", sha: "abc123", authorId: "u1", userId: "u1", additions: 10 },
      counter: "commitsPushed",
    },
    {
      type: "ai.thread-shared",
      source: "ai-service",
      detail: { teamId: "t1", threadId: "th1", sharedById: "u1", userId: "u1" },
      counter: "aiThreadsShared",
    },
    {
      // The in-app Bedrock path: one turn per invoke, with its measured metrics alongside.
      type: "ai.response-generated",
      source: "ai-service",
      detail: {
        teamId: "t1",
        threadId: "th1",
        userId: "u1",
        aiTurns: 1,
        latencyMs: 1200,
        firstTokenMs: 300,
        inputTokens: 80,
        outputTokens: 40,
      },
      counter: "aiTurns",
    },
  ];

  for (const p of REAL_PAYLOADS) {
    it(`${p.type} increments ${p.counter} — this FAILED for all five before the fix`, async () => {
      const activity = new FakeActivity();

      await applyActivityEvent(activity, {
        source: p.source,
        type: p.type,
        detail: p.detail,
        id: `evt-${p.type}`,
      });

      // Asserted on the RECORDED INCREMENT, not on a materialised row: this fake records the
      // calls the projection made (it does not apply them), and the call is the contract —
      // "did the projection attribute this event, to whom, on which counter".
      expect(activity.increments, "the projection must have attributed this event").toHaveLength(1);
      expect(activity.increments[0]).toMatchObject({
        teamId: "t1",
        userId: "u1",
        counter: p.counter,
      });
      // The bus's event id must reach the store, or an at-least-once redelivery double-counts.
      expect(activity.increments[0].eventId).toBe(`evt-${p.type}`);
    });

    it(`${p.type} is DROPPED if userId is removed — the exact live shape`, async () => {
      // Asserted as a refusal, not just as a fix: the guard must keep skipping an
      // unattributable event rather than crediting it to a phantom member.
      const activity = new FakeActivity();
      const { userId: _dropped, ...withoutActor } = p.detail;

      await applyActivityEvent(activity, {
        source: p.source,
        type: p.type,
        detail: withoutActor,
        id: `evt-no-actor-${p.type}`,
      });

      expect(activity.increments, "nothing may be credited").toHaveLength(0);
    });
  }

  it("reads the TURN COUNT from the event rather than assuming 1", async () => {
    /**
     * Two producers, two amounts. The in-app Bedrock path sends `aiTurns: 1` per invoke; the
     * desktop CLI sync sends the number of assistant replies in a batch. A consumer that
     * hardcoded 1 would count a six-turn sync as one turn — under-counting the very path that
     * was previously invisible, which is the whole reason this event is now consumed.
     */
    const activity = new FakeActivity();

    await applyActivityEvent(activity, {
      source: "ai-service",
      type: "ai.response-generated",
      // No latency or token fields: a CLI turn has none, and inventing them is the one thing
      // the original "publish nothing" objection was right about.
      detail: { teamId: "t1", userId: "u1", threadId: "th1", aiTurns: 6 },
      id: "evt-cli-batch",
    });

    expect(activity.increments).toHaveLength(1);
    expect(activity.increments[0]).toMatchObject({ counter: "aiTurns", by: 6 });
  });

  for (const [label, aiTurns] of [
    ["absent", undefined],
    ["zero", 0],
    ["negative", -5],
    ["fractional", 2.5],
    ["absurd", 100_000],
    ["a string", "6"],
  ] as const) {
    it(`clamps a ${label} turn count to 1 rather than dropping or trusting it`, async () => {
      // This counter feeds a figure a person is judged by, so a producer bug or a hostile
      // client must not set it. Clamped to 1, NOT dropped: a turn demonstrably happened, so
      // counting it once is closer to the truth than zero — or than a thousand.
      const activity = new FakeActivity();

      await applyActivityEvent(activity, {
        source: "ai-service",
        type: "ai.response-generated",
        detail: { teamId: "t1", userId: "u1", ...(aiTurns === undefined ? {} : { aiTurns }) },
        id: `evt-bad-${label}`,
      });

      expect(activity.increments).toHaveLength(1);
      expect(activity.increments[0]).toMatchObject({ counter: "aiTurns", by: 1 });
    });
  }

  it("every ACTIVITY_EVENT_TYPES entry is covered here", () => {
    // So adding a sixth activity event to the shared contract cannot silently skip this file.
    expect([...ACTIVITY_EVENT_TYPES].sort()).toEqual(REAL_PAYLOADS.map((p) => p.type).sort());
  });
});

describe("aiTurns: 'not measured' is reported as null, never as zero", () => {
  /**
   * THE DISTINCTION A MUTATION FOUND UNTESTED. `?? 0` and `?? null` both compile and both look
   * reasonable, but they say opposite things about a member:
   *
   *   null → "we were not measuring assistant use during this period"
   *   0    → "this member used no assistant"
   *
   * The counter only began collecting when `ai.response-generated` was first consumed, so EVERY
   * row written before that has no value. Reporting those as 0 would state a falsehood about
   * every member who worked before the fix, and would drag any average built on it downward —
   * a change in MEASUREMENT reading as a change in BEHAVIOUR.
   */
  const base = {
    teamId: "t1",
    tasksCreated: 0,
    tasksCompleted: 0,
    messagesSent: 0,
    commitsPushed: 0,
    aiThreadsShared: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const ratingsFor = async (activityRows: MemberActivity[]) => {
    const { app } = build({ activity: new FakeActivity(activityRows) });
    const res = await app.request("/v1/teams/t1/ratings", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    return (await res.json()) as {
      contributions: Array<{ userId: string; aiTurns: number | null }>;
    };
  };

  it("reports NULL for a row that predates the counter", async () => {
    // `aiTurns` deliberately absent — exactly the shape of every historical row.
    const body = await ratingsFor([{ ...base, userId: "u1" } as MemberActivity]);
    expect(body.contributions[0].aiTurns).toBeNull();
    expect(body.contributions[0].aiTurns, "0 would claim they used no assistant").not.toBe(0);
  });

  it("reports a genuine ZERO as 0, which is a different fact", async () => {
    // A member measured across the period who really made no assistant turns. Both states must
    // be representable, or the null above would just be a synonym for zero.
    const body = await ratingsFor([
      { ...base, userId: "u1", aiTurns: 0 } as MemberActivity,
    ]);
    expect(body.contributions[0].aiTurns).toBe(0);
  });

  it("passes a real count through untouched", async () => {
    const body = await ratingsFor([
      { ...base, userId: "u1", aiTurns: 42 } as MemberActivity,
    ]);
    expect(body.contributions[0].aiTurns).toBe(42);
  });

  it("does NOT fold aiTurns into contributionScore", async () => {
    /**
     * Deliberate, and the safer error. The counter started collecting mid-life, so weighting it
     * now would make a member's score jump the moment data begins arriving, and would penalise
     * the platform's whole history for a counter that did not exist. It is reported ALONGSIDE
     * so a reader sees turns directly. Fold it in only once every live row has a value.
     */
    const withTurns = await ratingsFor([
      { ...base, userId: "u1", messagesSent: 4, aiTurns: 500 } as MemberActivity,
    ]);
    const withoutTurns = await ratingsFor([
      { ...base, userId: "u1", messagesSent: 4 } as MemberActivity,
    ]);
    const score = (b: { contributions: Array<{ contributionScore?: number }> }) =>
      (b.contributions[0] as { contributionScore: number }).contributionScore;
    expect(score(withTurns as never)).toBe(score(withoutTurns as never));
  });
});

/**
 * ── ⚠ PUBLICATION CLOSES SCORING, AND REOPEN WITHDRAWS THE RANKING ──────────────────────────
 *
 * `WorkshopResults`' own header explains why the places are STORED and not recomputed: "a ranking that
 * recomputed itself would change when a late score arrived — after the owner had declared the result and
 * teams had been told". The corollary was missing — nothing stopped the late score, so the stored
 * ranking could quietly stop matching the scores behind it.
 *
 * The pair below is one decision, not two. Refusing scores after publication would make a
 * post-publication reopen inert; clearing the ranking on reopen is what keeps reopen meaningful. The
 * cost — a published result IS retracted by a reopen — was chosen deliberately over a ranking that
 * disagrees with its own inputs.
 */
describe("scoring is closed once results are published", () => {
  const publishedFor = (workshopId: string): WorkshopResults => ({
    workshopId,
    publishedById: "owner-1",
    publishedAt: "2026-01-07T00:00:00.000Z",
    minScoresPerSubmission: 1,
    places: [
      {
        place: 1,
        teamId: "t1",
        submissionId: "s1",
        teamName: "Team s1",
        average: 9,
        judgeCount: 1,
      },
    ],
    // Nobody broke a tie here — this fixture exists to make the ranking EXIST, and the
    // publication gate reads nothing but its presence. Same two nulls as the fixture in
    // "publishing a ranking", which is the shape `WorkshopResults` has required since the
    // tie-break fields landed.
    tieBrokenById: null,
    tieBrokenAt: null,
  });

  it("refuses a score with RESULTS_PUBLISHED once the ranking exists", async () => {
    const results = new FakeResults();
    await results.create(publishedFor(HOME_WORKSHOP));
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      results,
      scores,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({})),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("RESULTS_PUBLISHED");
    expect(scores.rows, "nothing is written on a refusal").toHaveLength(0);
  });

  it("still accepts a score while the ranking is unpublished", async () => {
    // The guard must not be the whole gate: an unpublished experience is the normal judging state.
    const scores = new FakeScores([]);
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      results: new FakeResults(),
      scores,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({})),
    });

    expect(res.status).toBe(201);
    expect(scores.rows).toHaveLength(1);
  });

  it("reports NOT_RELEASED ahead of RESULTS_PUBLISHED — the narrower refusal wins", async () => {
    // "This submission is not released" is about the submission; "results are published" is about the
    // whole experience. A judge given the broader answer would go looking in the wrong place.
    const results = new FakeResults();
    await results.create(publishedFor(HOME_WORKSHOP));
    const { app } = build({
      submissions: new FakeSubmissions([submission({ id: "s1" })]),
      results,
    });

    const res = await app.request("/v1/submissions/s1/scores", {
      method: "POST",
      headers: asUser({ id: "judge-1", role: "JUDGE" }),
      body: JSON.stringify(validScores({})),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_RELEASED");
  });

  it("reopening WITHDRAWS the published ranking, so judging can resume", async () => {
    const results = new FakeResults();
    await results.create(publishedFor(HOME_WORKSHOP));
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      results,
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser({ id: "owner-1", role: "FACILITATOR" }),
      body: JSON.stringify({ reason: "the demo link was wrong and needs re-judging" }),
    });

    expect(res.status).toBe(200);
    expect(
      await results.get(HOME_WORKSHOP),
      "a ranking left standing would no longer match the scores behind it"
    ).toBeNull();
  });

  it("reopening an UNPUBLISHED experience is a no-op, not a failure", async () => {
    // `clear` is idempotent precisely so the common case — reopening before anyone published — works.
    const { app } = build({
      submissions: new FakeSubmissions([released({ id: "s1" })]),
      results: new FakeResults(),
    });

    const res = await app.request("/v1/teams/t1/submissions/s1/reopen", {
      method: "POST",
      headers: asUser({ id: "owner-1", role: "FACILITATOR" }),
      body: JSON.stringify({ reason: "reopening before any ranking was published" }),
    });

    expect(res.status).toBe(200);
  });
});

/**
 * ── ⚠ AN ADMIN READS THE RESULTS OF THE EXPERIENCES THEY OWN, AND NO OTHERS ──────────────────
 *
 * `requireExperienceReader` opened with a blanket `if (role === "ADMIN") return null`, so an admin could
 * read the published ranking, the activity feed and the places of an experience they had nothing to do
 * with. THE RULE: an ADMIN sees only the experiences they own — no other experiences, scores or data.
 *
 * ⚠ THIS BEHAVIOUR WAS UNTESTED IN BOTH DIRECTIONS. Removing the line broke nothing, and restoring it
 * broke nothing — verified by mutating it both ways. So the deletion alone would have been an
 * unverifiable change, and these are what make it real.
 */
describe("an ADMIN reads results only for experiences they own", () => {
  const published = (workshopId: string): WorkshopResults => ({
    workshopId,
    publishedById: "owner-1",
    publishedAt: "2026-01-07T00:00:00.000Z",
    minScoresPerSubmission: 1,
    places: [
      {
        place: 1,
        teamId: "t1",
        submissionId: "s1",
        teamName: "Team s1",
        average: 9,
        judgeCount: 1,
      },
    ],
    // No tie was broken: what these tests vary is WHO IS ASKING, never the ranking's content.
    tieBrokenById: null,
    tieBrokenAt: null,
  });

  it("serves an ADMIN who OWNS the experience", async () => {
    // An ADMIN who created the experience owns it, and is running it.
    const results = new FakeResults();
    await results.create(published(HOME_WORKSHOP));
    const { app } = build({
      results,
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "admin-1", status: "ACTIVE" }),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
  });

  it("refuses an ADMIN who does not own it, rather than falling back on the platform role", async () => {
    const results = new FakeResults();
    await results.create(published(HOME_WORKSHOP));
    const { app } = build({
      results,
      workshops: new FakeWorkshops({
        id: HOME_WORKSHOP,
        ownerId: "someone-else",
        status: "ACTIVE",
      }),
      // Not entitled either — an admin is not invited to experiences, so this is the real shape.
      entitlements: new FakeEntitlements([]),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(403);
  });

  it("still serves the OWNING FACILITATOR — the change was to the admin branch only", async () => {
    const results = new FakeResults();
    await results.create(published(HOME_WORKSHOP));
    const { app } = build({
      results,
      workshops: new FakeWorkshops({ id: HOME_WORKSHOP, ownerId: "fac-1", status: "ACTIVE" }),
    });

    const res = await app.request(`/v1/workshops/${HOME_WORKSHOP}/results`, {
      headers: asUser({ id: "fac-1", role: "FACILITATOR" }),
    });

    expect(res.status).toBe(200);
  });
});

/**
 * ── ⚠ URL FIELDS ARE SCHEME-CHECKED ON WRITE, ALL FOUR OF THEM ────────────────────────────────
 *
 * The PATCH loop validated string-or-null and nothing else. `isReleasableDemoUrl` was the service's
 * ONLY URL check, applied to `demoUrl` alone and only at RELEASE — so `videoUrl`, `repoUrl` and
 * `slidesUrl` were never validated at any point, and `repoUrl: "javascript:alert(1)"` persisted and
 * was served.
 *
 * The role direction is what makes it matter: the writer is an EXECUTIVE on the team, the readers are
 * the JUDGE scoring the submission and the experience owner. That is the judged influencing the judge.
 *
 * Validated in the SERVICE even though the renderer is the portal — "the services enforce; the UI
 * explains". Whether the portal sanitises an href is not a property this repo can assert or keep true.
 */
describe("submission URL fields must be https on write", () => {
  const patchField = (
    app: ReturnType<typeof build>["app"],
    field: string,
    value: string | null,
    role = "EXECUTIVE"
  ) =>
    app.request("/v1/teams/t1/submissions/s1", {
      method: "PATCH",
      headers: asUser({ id: "exec", role }),
      body: JSON.stringify({ [field]: value }),
    });

  const URL_FIELD_NAMES = ["demoUrl", "videoUrl", "repoUrl", "slidesUrl"];

  // Every field, every hostile scheme — a matrix, because the defect was one field being checked and
  // three not. A per-field loop is what stops a future URL field joining the unchecked three.
  const REFUSED = [
    "javascript:alert(document.cookie)",
    "http://plaintext.example/demo",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "not a url at all",
  ];

  for (const field of URL_FIELD_NAMES) {
    it.each(REFUSED)(`${field} REFUSES %s and stores nothing`, async (bad) => {
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const { app } = build({ submissions, docs: new FakeDocs([{ path: "f1", versionId: "v1", lastAuthorName: null, updatedAt: "2026-08-01T00:00:00.000Z" }]) });

      const res = await patchField(app, field, bad);

      expect(res.status, `${field}=${bad}`).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("URL_INVALID");
      // The important half: refused AND not written. Asserted on the STORED ROW, which is this
      // file's convention (see "409 ARTIFACTS_REQUIRED ... and stores nothing").
      expect(
        (submissions.rows[0] as unknown as Record<string, unknown>)[field],
        `${field}=${bad}`
      ).toBeNull();
    });

    it(`${field} ACCEPTS a plain https link`, async () => {
      // NOT VACUOUS: without this the matrix above would pass if the route refused everything.
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const { app } = build({ submissions, docs: new FakeDocs([{ path: "f1", versionId: "v1", lastAuthorName: null, updatedAt: "2026-08-01T00:00:00.000Z" }]) });

      const res = await patchField(app, field, "https://good.example/thing");

      expect(res.status, field).toBe(200);
    });

    it(`${field} still allows CLEARING with null, "" and whitespace`, async () => {
      // Clearing must never be gated: a team has to be able to delete a value typed by mistake, and
      // whitespace counts as clearing so this rule agrees with the demo-link ordering rule.
      for (const clearing of [null, "", "   "]) {
        const submissions = new FakeSubmissions([submission({ id: "s1" })]);
        const { app } = build({ submissions, docs: new FakeDocs([]) });
        const res = await patchField(app, field, clearing);
        expect(res.status, `${field}=${JSON.stringify(clearing)}`).toBe(200);
      }
    });
  }

  /**
   * ⚠ THE ROLE MATRIX ON THE WRITE ITSELF. The scheme check is a validation, not an authorization —
   * so it must sit BEHIND the existing EXECUTIVE_ONLY draft-write gate, not in front of it. If a
   * refused role received `URL_INVALID` instead of `EXECUTIVE_ONLY`, the route would be telling a
   * PARTICIPANT which of its inputs was malformed on a resource they may not write at all.
   */
  const DRAFT_WRITE_ROLES: Array<[role: string, expected: number, code: string]> = [
    ["EXECUTIVE", 400, "URL_INVALID"],
    ["PARTICIPANT", 403, "EXECUTIVE_ONLY"],
    ["JUDGE", 403, "EXECUTIVE_ONLY"],
    ["FACILITATOR", 403, "EXECUTIVE_ONLY"],
    ["ADMIN", 403, "EXECUTIVE_ONLY"],
  ];

  it.each(DRAFT_WRITE_ROLES)(
    "a %s sending a javascript: URL gets %s/%s",
    async (role, expected, code) => {
      const submissions = new FakeSubmissions([submission({ id: "s1" })]);
      const { app } = build({ submissions, docs: new FakeDocs([{ path: "f1", versionId: "v1", lastAuthorName: null, updatedAt: "2026-08-01T00:00:00.000Z" }]) });

      const res = await patchField(app, "repoUrl", "javascript:alert(1)", role);

      expect(res.status, role).toBe(expected);
      expect(((await res.json()) as { code: string }).code, role).toBe(code);
      expect(submissions.rows[0].repoUrl, role).toBeNull();
    }
  );

  it("⚠ REFUSES an over-long text field rather than truncating it", async () => {
    /**
     * The text fields had no length cap while a score `comment` has one — inconsistent, and one PATCH
     * could write an arbitrarily large row into a table every judge and the results page reads.
     * Refused with the field named, matching the comment's convention, so nobody loses the end of an
     * answer without being told.
     */
    const submissions = new FakeSubmissions([submission({ id: "s1" })]);
    const { app } = build({ submissions, docs: new FakeDocs([{ path: "f1", versionId: "v1", lastAuthorName: null, updatedAt: "2026-08-01T00:00:00.000Z" }]) });

    const res = await patchField(app, "problemStatement", "x".repeat(20_001));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("FIELD_TOO_LONG");
    expect(submissions.rows[0].problemStatement).toBeNull();
  });

  it("accepts a text field AT the cap — the bound is 20000, not 19999", async () => {
    const submissions = new FakeSubmissions([submission({ id: "s1" })]);
    const { app } = build({ submissions, docs: new FakeDocs([{ path: "f1", versionId: "v1", lastAuthorName: null, updatedAt: "2026-08-01T00:00:00.000Z" }]) });

    const res = await patchField(app, "problemStatement", "x".repeat(20_000));

    expect(res.status).toBe(200);
  });

  /**
   * ── ⚠ THE CREATE ROUTE ENFORCES THE SAME THREE RULES ────────────────────────────────────────
   *
   * Every assertion above was made through PATCH, and CREATE had NO validation at all: it copied nine
   * client-controlled fields into the stored row with only a `|| null` default. Both routes sit behind
   * the SAME guard (`requireSubmissionDraftWrite`), so a team wanting to store a `javascript:` link
   * did not need to defeat the PATCH checks — it could create instead of patching. The release gate
   * re-checked `demoUrl` alone, so a bad `videoUrl`/`repoUrl`/`slidesUrl` written at create time was
   * never validated on any path.
   *
   * These mirror the PATCH matrix field-for-field and code-for-code, because the point of the fix is
   * that the two writers cannot disagree — they now share one `rejectSubmissionField`.
   */
  describe("…and so does the CREATE route", () => {
    const createWith = (
      app: ReturnType<typeof build>["app"],
      body: Record<string, unknown>,
      role = "EXECUTIVE"
    ) =>
      app.request("/v1/teams/t1/submissions", {
        method: "POST",
        headers: asUser({ id: "exec", role }),
        body: JSON.stringify(body),
      });

    for (const field of URL_FIELD_NAMES) {
      it.each(REFUSED)(`${field} REFUSES %s at CREATE and stores nothing`, async (bad) => {
        const submissions = new FakeSubmissions([]);
        const { app } = build({ submissions });

        const res = await createWith(app, { [field]: bad });

        expect(res.status, `${field}=${bad}`).toBe(400);
        expect(((await res.json()) as { code: string }).code, `${field}=${bad}`).toBe("URL_INVALID");
        // The half that matters: refused AND no row created.
        expect(submissions.rows, `${field}=${bad}`).toEqual([]);
      });

      it(`${field} ACCEPTS a plain https link at CREATE`, async () => {
        // NOT VACUOUS: without this the matrix above would pass on a route that refused everything.
        const submissions = new FakeSubmissions([]);
        const { app } = build({ submissions });

        const res = await createWith(app, { [field]: "https://good.example/thing" });

        expect(res.status, field).toBe(201);
        expect(
          (submissions.rows[0] as unknown as Record<string, unknown>)[field],
          field
        ).toBe("https://good.example/thing");
      });
    }

    it("REFUSES a non-string field rather than storing type confusion", async () => {
      /**
       * `title: body.title || null` accepted ANY truthy value — an object, an array, a number — and
       * stored it verbatim into a row read by the judge's view, the release snapshot and the results
       * page. Every one of those readers assumes string-or-null.
       */
      for (const bad of [{ nope: true }, ["a"], 42, true]) {
        const submissions = new FakeSubmissions([]);
        const { app } = build({ submissions });

        const res = await createWith(app, { title: bad });

        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("FIELD_INVALID");
        expect(submissions.rows, JSON.stringify(bad)).toEqual([]);
      }
    });

    it("REFUSES an over-long text field at CREATE", async () => {
      const submissions = new FakeSubmissions([]);
      const { app } = build({ submissions });

      const res = await createWith(app, { problemStatement: "x".repeat(20_001) });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("FIELD_TOO_LONG");
      expect(submissions.rows).toEqual([]);
    });

    it("still creates a MINIMAL submission — absent fields are skipped, not refused", async () => {
      /**
       * ⚠ THE REGRESSION THIS GUARDS. Validating with `rejectSubmissionField` over every field
       * regardless of presence would refuse `{}` — the most common create of all — because an absent
       * field reads as `undefined`, which is neither a string nor null. The `in body` skip is what
       * keeps this working, and the empty create is the case that proves it.
       */
      const submissions = new FakeSubmissions([]);
      const { app } = build({ submissions });

      expect((await createWith(app, {})).status).toBe(201);
      expect(submissions.rows).toHaveLength(1);
    });

    it("still accepts an explicit null on every field — that is how a field is left empty", async () => {
      const submissions = new FakeSubmissions([]);
      const { app } = build({ submissions });

      const res = await createWith(app, {
        title: null,
        summary: null,
        problemStatement: null,
        solution: null,
        demoUrl: null,
        videoUrl: null,
        repoUrl: null,
        slidesUrl: null,
        aiUsageSummary: null,
      });

      expect(res.status).toBe(201);
    });

    it("keeps the validation BEHIND the draft-write gate, as PATCH does", async () => {
      // Same argument as the PATCH role matrix: a PARTICIPANT must hear EXECUTIVE_ONLY, not a
      // critique of a field on a resource they may not write at all.
      const submissions = new FakeSubmissions([]);
      const { app } = build({ submissions });

      const res = await createWith(app, { repoUrl: "javascript:alert(1)" }, "PARTICIPANT");

      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("EXECUTIVE_ONLY");
      expect(submissions.rows).toEqual([]);
    });
  });
});
