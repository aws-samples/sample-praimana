import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createSourceRoutes } from "./routes.js";
import { CommitAlreadyExistsError } from "./domain.js";
import type {
  GitCommit,
  GitFile,
  CommitRepository,
  FileRepository,
  UserView,
  UsersReadModel,
} from "./domain.js";
import type { TeamAccess } from "./authz.js";

/**
 * AUTHORIZATION for the Source service — the FIRST tests this service has had.
 *
 * It is one of the four surfaces made MEMBER-ONLY: a team's commits, commit
 * messages and per-file contribution counts are their work product, so an ADMIN, a
 * workshop-owning FACILITATOR and a JUDGE all lose the ambient access they used to have.
 *
 * Written now rather than later because this service had NO test file at all, which meant
 * the narrowing here would otherwise have shipped on the strength of reading the diff. The
 * four routes are the whole surface, and every one of them is a content route.
 *
 * Authentication uses the trusted-internal-hop path (x-internal-token + x-identity-*), the
 * same edgeIdentityMiddleware the deployed service runs, so no Cognito JWKS fetch is needed.
 */
const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(identity: { id: string; role: string }) {
  return {
    "content-type": "application/json",
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
  };
}

// ─── In-memory fakes ────────────────────────────────────────────────────────

class FakeCommits implements CommitRepository {
  constructor(readonly rows: GitCommit[] = []) {}
  async listByTeam(teamId: string, limit: number) {
    return this.rows.filter((c) => c.teamId === teamId).slice(0, limit);
  }
  async getBySha(teamId: string, sha: string) {
    return this.rows.find((c) => c.teamId === teamId && c.sha === sha) ?? null;
  }
  /**
   * ⚠ CONDITIONAL, like the store's `attribute_not_exists(teamId)`. A fake that appended
   * unconditionally would model the REPORTED BUG — a caller-supplied sort key silently replacing
   * an existing commit — and let a route that never handles the conflict pass every test.
   */
  async create(commit: GitCommit) {
    const clash = this.rows.some(
      (c) => c.teamId === commit.teamId && c.date === commit.date
    );
    if (clash) throw new CommitAlreadyExistsError(commit.teamId, commit.date);
    this.rows.push(commit);
    return commit;
  }
}

class FakeFiles implements FileRepository {
  constructor(readonly rows: GitFile[] = []) {}
  async listByTeam(teamId: string) {
    return this.rows.filter((f) => f.teamId === teamId);
  }
  async getByPath(teamId: string, path: string) {
    return this.rows.find((f) => f.teamId === teamId && f.path === path) ?? null;
  }
  /**
   * ⚠ ACCUMULATES, like the store's `ADD`. The bug this replaced was a full-item Put that threw
   * away the rolled-up counters on every commit, so a fake that pushed a new row (or replaced one)
   * would model exactly the behaviour the fix removes.
   */
  async accumulate(delta: GitFile) {
    const existing = this.rows.find(
      (f) => f.teamId === delta.teamId && f.path === delta.path
    );
    if (!existing) {
      // An UpdateCommand upserts: the first commit to touch a path creates its row.
      this.rows.push({ ...delta });
      return { ...delta };
    }
    existing.additions += delta.additions;
    existing.deletions += delta.deletions;
    existing.commits += delta.commits;
    existing.lastAuthor = delta.lastAuthor;
    existing.updatedAt = delta.updatedAt;
    return existing;
  }
}

class FakeUsers implements UsersReadModel {
  constructor(private readonly rows: UserView[] = []) {}
  async get(id: string) {
    return this.rows.find((u) => u.id === id) ?? null;
  }
  async upsert() {}
  async delete() {}
}

/**
 * The Team context's answer, injected rather than fetched.
 *
 * `calls` records WHICH predicate each route asked for. That is the drift test's whole
 * mechanism: with both pairs agreeing, a route wired to the wide predicate returns exactly
 * the same status, so the only way to see the mistake is to assert the question.
 *
 * The content flags default to the wide pair's values, matching the other four consumers'
 * fakes so the five read the same way.
 */
class FakeTeamAccess implements TeamAccess {
  readonly calls: Array<
    "canRead" | "canWrite" | "canReadContent" | "canWriteContent"
  > = [];
  constructor(
    private readonly reads = true,
    private readonly writes = true,
    private readonly contentReads = reads,
    private readonly contentWrites = writes
  ) {}
  async canRead() {
    this.calls.push("canRead");
    return this.reads;
  }
  async canWrite() {
    this.calls.push("canWrite");
    return this.writes;
  }
  async canReadContent() {
    this.calls.push("canReadContent");
    return this.contentReads;
  }
  async canWriteContent() {
    this.calls.push("canWriteContent");
    return this.contentWrites;
  }
}

// ─── Builders ───────────────────────────────────────────────────────────────

const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
  teamId: "t1",
  date: "2026-02-01T10:00:00.000Z",
  sha: "abc123",
  message: "our secret approach to the problem",
  author: "Ada",
  additions: 10,
  deletions: 2,
  createdAt: "2026-02-01T10:00:00.000Z",
  ...over,
});

const file = (over: Partial<GitFile> = {}): GitFile => ({
  teamId: "t1",
  path: "src/secret-plan.ts",
  additions: 10,
  deletions: 2,
  commits: 1,
  lastAuthor: "Ada",
  updatedAt: "2026-02-01T10:00:00.000Z",
  ...over,
});

function build(
  over: Partial<{
    commits: FakeCommits;
    files: FakeFiles;
    users: FakeUsers;
    teamAccess: TeamAccess;
    events: InMemoryPublisher;
  }> = {}
) {
  const deps = {
    commits: over.commits ?? new FakeCommits([commit()]),
    files: over.files ?? new FakeFiles([file()]),
    users: over.users ?? new FakeUsers([]),
    teamAccess: over.teamAccess ?? new FakeTeamAccess(true, true),
    events: over.events ?? new InMemoryPublisher(),
  };
  return { app: createSourceRoutes(deps), deps };
}

/** Every route this service exposes, and the predicate each must consult. */
const ROUTES = [
  {
    name: "GET commits",
    method: "GET",
    path: "/v1/teams/t1/commits",
    predicate: "canReadContent" as const,
  },
  {
    name: "POST commits",
    method: "POST",
    path: "/v1/teams/t1/commits",
    predicate: "canWriteContent" as const,
    body: { sha: "def456", message: "wip", files: [{ path: "a.ts" }] },
  },
  {
    name: "GET commit detail",
    method: "GET",
    path: "/v1/teams/t1/commits/abc123",
    predicate: "canReadContent" as const,
  },
  {
    name: "GET files",
    method: "GET",
    path: "/v1/teams/t1/files",
    predicate: "canReadContent" as const,
  },
];

describe("every Source route is gated, and gated on the CONTENT predicate", () => {
  for (const r of ROUTES) {
    it(`${r.name} requires authentication`, async () => {
      const { app } = build();
      const res = await app.request(r.path, {
        method: r.method,
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(401);
    });

    it(`${r.name} asks ${r.predicate} and nothing else`, async () => {
      // THE DRIFT ASSERTION for this consumer.
      const teamAccess = new FakeTeamAccess(true, true);
      const { app } = build({ teamAccess });

      await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(teamAccess.calls).toEqual([r.predicate]);
    });

    it(`${r.name} 403s a caller the CONTENT predicate refuses but the WIDE one allows`, async () => {
      // Wide true, content false — exactly what the Team service answers for a non-member
      // ADMIN or a workshop-owning FACILITATOR. Driven through the flags rather than a role
      // header because this service does not know the role matrix and must not start
      // depending on one.
      const commits = new FakeCommits([commit()]);
      const files = new FakeFiles([file()]);
      const events = new InMemoryPublisher();
      const { app } = build({
        commits,
        files,
        events,
        teamAccess: new FakeTeamAccess(true, true, false, false),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "admin", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
      // The work product stayed behind, and no write landed.
      const text = await res.text();
      expect(text).not.toContain("our secret approach to the problem");
      expect(text).not.toContain("src/secret-plan.ts");
      expect(commits.rows).toHaveLength(1);
      expect(files.rows).toHaveLength(1);
      expect(events.published).toHaveLength(0);
    });

    it(`${r.name} 403s when the Team service cannot answer (fail-closed)`, async () => {
      // "Undetermined" must never render as "allowed". HttpTeamAccess maps a 5xx, a timeout,
      // a connect error and an ABSENT FIELD — the rolling-deploy case, where Team is older
      // than this consumer — all to false.
      const { app } = build({ teamAccess: new FakeTeamAccess(false, false, false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });

    it(`${r.name} 403s a forged x-identity-role: ADMIN with no membership`, async () => {
      // A COMPROMISED INTERNAL CALLER. The trusted-internal hop lets a caller assert its own
      // role, so this service must never grant content access on the strength of a role — and
      // it does not, because it asks about MEMBERSHIP, a fact in the Team service's table
      // that no header can fabricate.
      const { app } = build({ teamAccess: new FakeTeamAccess(true, true, false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "attacker", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });

    it(`${r.name} still lets a MEMBER through`, async () => {
      // The half that must not break.
      const { app } = build();
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "member", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBeLessThan(300);
    });
  }

  for (const r of ROUTES.filter((x) => x.predicate === "canWriteContent")) {
    it(`${r.name} 403s a read-only EXECUTIVE WITHOUT an east-west hop`, async () => {
      // The local role check short-circuits first, so a read-only role can never be granted
      // write by a Team service that is buggy, stale or lying — and the distinct message is
      // what the UI renders as different copy.
      const teamAccess = new FakeTeamAccess(true, true);
      const commits = new FakeCommits([]);
      const { app } = build({ teamAccess, commits });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify(r.body),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Read-only role" });
      expect(teamAccess.calls).toHaveLength(0);
      expect(commits.rows).toHaveLength(0);
    });
  }

  for (const r of ROUTES.filter((x) => x.predicate === "canReadContent")) {
    it(`${r.name} allows a read-only EXECUTIVE member (read-only is not no-access)`, async () => {
      const { app } = build();
      const res = await app.request(r.path, {
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
      });
      expect(res.status).toBe(200);
    });
  }

  it("authorizes the commit-detail route BEFORE looking the commit up", async () => {
    // A refused caller must not learn whether a sha exists: 403, never a 404 that confirms
    // the id is real for a team they cannot see.
    const { app } = build({
      commits: new FakeCommits([]),
      teamAccess: new FakeTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/teams/t1/commits/does-not-exist", {
      headers: asUser({ id: "admin", role: "ADMIN" }),
    });

    expect(res.status).toBe(403);
  });
});

// ─── Bounds and write integrity on the commit routes ────────────────────────

/**
 * ── ⚠ TWO FINDINGS, ONE ROUTE ───────────────────────────────────────────────────────────────
 *
 * POST /teams/:teamId/commits took its collection size, its record's SORT KEY and its ATTRIBUTION
 * straight from the request body, and GET took its DynamoDB `Limit` straight from the query string:
 *
 *   · unbounded `files[]`  one sequential write per element — a write amplifier against the table
 *                          and the function timeout, leaving a half-written result.
 *   · unclamped `limit`    `parseInt("abc")` is NaN and a negative passes; both reach DynamoDB as
 *                          a ValidationException nothing catches, so a URL yields a 500.
 *   · caller-supplied key  `date` is the sort key, written with a bare Put, so replaying an
 *                          existing row's date REPLACED that commit. There is no update route.
 *   · spoofable author     `body.author` was honoured, so a member could attribute a commit — and
 *                          a path's `lastAuthor` — to a teammate.
 *   · replaced counters    per-path rows are a ROLLUP, and a full-item Put discarded it on every
 *                          commit.
 *
 * The caller is an authorized member throughout, so the stakes are intra-team integrity and the
 * team's own contribution record — which an executive reads as fact — rather than cross-tenant
 * access. That is why these are asserted on OUTCOMES (what is stored, what is refused) rather than
 * on status codes alone.
 */
describe("POST /teams/:teamId/commits — bounds and write integrity", () => {
  const member = asUser({ id: "u1", role: "PARTICIPANT" });

  function post(app: ReturnType<typeof build>["app"], body: unknown) {
    return app.request("/v1/teams/t1/commits", {
      method: "POST",
      headers: { ...member, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("REFUSES an oversized files[] rather than issuing a write per element", async () => {
    const files = new FakeFiles([]);
    const { app } = build({ commits: new FakeCommits([]), files });

    const res = await post(app, {
      date: "2026-03-01T00:00:00.000Z",
      files: Array.from({ length: 5_000 }, (_, i) => ({ path: `src/f${i}.ts` })),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_FILES");
    // ⚠ REFUSED, NOT TRUNCATED: no partial write may be left behind.
    expect(files.rows).toHaveLength(0);
  });

  it("accepts a large-but-legal commit and writes every path once", async () => {
    const files = new FakeFiles([]);
    const { app } = build({ commits: new FakeCommits([]), files });

    const res = await post(app, {
      date: "2026-03-01T00:00:00.000Z",
      files: Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts`, additions: 1 })),
    });

    expect(res.status).toBe(201);
    expect(files.rows).toHaveLength(200);
  });

  it("ACCUMULATES per-path counters instead of replacing them", async () => {
    // ⚠ THE DATA-LOSS BUG. Two commits touching the same path must sum: the row is documented as
    // "rolled-up contribution stats", and a full-item Put left the second commit's numbers
    // standing in for the file's whole history.
    const files = new FakeFiles([]);
    const { app } = build({ commits: new FakeCommits([]), files });

    await post(app, {
      date: "2026-03-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", additions: 10, deletions: 1, commits: 1 }],
    });
    await post(app, {
      date: "2026-03-02T00:00:00.000Z",
      files: [{ path: "src/a.ts", additions: 5, deletions: 2, commits: 1 }],
    });

    const row = files.rows.find((f) => f.path === "src/a.ts")!;
    expect(row.additions).toBe(15);
    expect(row.deletions).toBe(3);
    expect(row.commits).toBe(2);
  });

  it("REFUSES to overwrite an existing commit at the same timestamp", async () => {
    // Replaying a date used to replace the row — message, stats and author — with no update route
    // in the service that could have done it on purpose.
    const commits = new FakeCommits([]);
    const { app } = build({ commits, files: new FakeFiles([]) });

    const first = await post(app, {
      date: "2026-03-01T00:00:00.000Z",
      sha: "aaa",
      message: "the real commit",
      additions: 10,
    });
    expect(first.status).toBe(201);

    const replay = await post(app, {
      date: "2026-03-01T00:00:00.000Z",
      sha: "bbb",
      message: "history rewritten",
      additions: 0,
    });

    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe("COMMIT_ALREADY_EXISTS");
    // The original survives, unmodified.
    expect(commits.rows).toHaveLength(1);
    expect(commits.rows[0]).toMatchObject({ sha: "aaa", message: "the real commit" });
  });

  it("IGNORES body.author and attributes the commit to the caller", async () => {
    // A member could otherwise put a teammate's name on their commit — and on the per-path
    // `lastAuthor` that the contribution view reports.
    const commits = new FakeCommits([]);
    const files = new FakeFiles([]);
    const { app } = build({
      commits,
      files,
      users: new FakeUsers([{ id: "u1", name: "Ada" }]),
    });

    await post(app, {
      date: "2026-03-01T00:00:00.000Z",
      author: "Grace (a teammate)",
      files: [{ path: "src/a.ts" }],
    });

    expect(commits.rows[0].author).toBe("Ada");
    expect(files.rows[0].lastAuthor).toBe("Ada");
  });

  it("falls back to the caller's id when the read-model has no name yet", async () => {
    // The read-model is event-fed and can lag. An id is a poor display name and a correct
    // attribution; a teammate's name would be neither.
    const commits = new FakeCommits([]);
    const { app } = build({
      commits,
      files: new FakeFiles([]),
      users: new FakeUsers([]),
    });

    await post(app, { date: "2026-03-01T00:00:00.000Z", author: "Grace" });

    expect(commits.rows[0].author).toBe("u1");
  });
});

describe("GET /teams/:teamId/commits — the limit reaches DynamoDB validated", () => {
  const member = asUser({ id: "u1", role: "PARTICIPANT" });

  /** Records the limit the route passed to the store. */
  class RecordingCommits extends FakeCommits {
    limits: number[] = [];
    async listByTeam(teamId: string, limit: number) {
      this.limits.push(limit);
      return super.listByTeam(teamId, limit);
    }
  }

  it("clamps or defaults every hostile value instead of passing it through", async () => {
    // `parseInt` produced NaN for "abc" and accepted "-1"; DynamoDB rejects both with a
    // ValidationException that no handler catches, so each of these was a 500 from a URL.
    for (const raw of ["abc", "-1", "0", "", "1e999", "NaN", "99999"]) {
      const commits = new RecordingCommits([]);
      const { app } = build({ commits });

      const res = await app.request(
        `/v1/teams/t1/commits?limit=${encodeURIComponent(raw)}`,
        { headers: member }
      );

      expect(res.status, `limit=${raw}`).toBe(200);
      const passed = commits.limits[0];
      expect(Number.isInteger(passed), `limit=${raw} must be an integer`).toBe(true);
      expect(passed, `limit=${raw} must be positive`).toBeGreaterThan(0);
      expect(passed, `limit=${raw} must be capped`).toBeLessThanOrEqual(200);
    }
  });

  it("honours a sensible explicit limit", async () => {
    const commits = new RecordingCommits([]);
    const { app } = build({ commits });

    await app.request("/v1/teams/t1/commits?limit=25", { headers: member });

    expect(commits.limits[0]).toBe(25);
  });
});
