import { assertActivityActor } from "@praimana/service-shared";
import { describe, it, expect, beforeAll } from "vitest";
import { MAX_TEAM_MESSAGE_CHARS } from "@praimana/shared";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createCollaborationRoutes } from "./routes.js";
import { subscribeTeamEvents, type TeamEvent } from "./live-bus.js";
import type { TeamAccess } from "./authz.js";
import { TaskAlreadyExistsError } from "./domain.js";
import type {
  Message,
  MessageRepository,
  Task,
  TaskRepository,
  UserView,
  UsersReadModel,
} from "./domain.js";

/**
 * Route tests for tasks + messaging. Every dependency is injected, so there is no
 * DynamoDB and no call to the Team service.
 *
 * Authentication goes through the real edgeIdentityMiddleware via the trusted
 * internal hop (x-internal-token + x-identity-*) — the same path HttpTeamAccess and
 * the gateway use — so these tests exercise the production middleware, not a stub.
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

class FakeTasks implements TaskRepository {
  constructor(readonly rows: Task[] = []) {}

  async get(teamId: string, id: string) {
    return this.rows.find((t) => t.teamId === teamId && t.id === id) ?? null;
  }
  async listByTeam(teamId: string) {
    return this.rows.filter((t) => t.teamId === teamId);
  }
  /**
   * ⚠ CONDITIONAL, like the store's `attribute_not_exists(teamId)`. A fake that appended
   * unconditionally would model the REPORTED BUG — a caller-supplied id silently replacing an
   * existing card and reassigning its creator — and let a route that never handles the conflict
   * pass every test.
   */
  async create(task: Task) {
    const clash = this.rows.some(
      (t) => t.teamId === task.teamId && t.id === task.id
    );
    if (clash) throw new TaskAlreadyExistsError(task.teamId, task.id);
    this.rows.push(task);
    return task;
  }
  async update(teamId: string, id: string, patch: Partial<Task>) {
    const row = this.rows.find((t) => t.teamId === teamId && t.id === id);
    if (!row) return null;
    // Mirror the DynamoDB impl: undefined fields in the patch are skipped, not
    // written as undefined.
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v;
    }
    return row;
  }
}

class FakeMessages implements MessageRepository {
  /** Records the (limit, before) the route resolved, to pin pagination parsing. */
  queries: Array<{ teamId: string; limit: number; before?: string }> = [];

  constructor(readonly rows: Message[] = []) {}

  async listByTeam(teamId: string, limit: number, before?: string) {
    this.queries.push({ teamId, limit, before });
    return this.rows.filter((m) => m.teamId === teamId);
  }
  async put(message: Message) {
    this.rows.push(message);
    return message;
  }
}

class FakeUsers implements UsersReadModel {
  private readonly rows = new Map<string, UserView>();
  /** Lookup count, so a test can prove names are resolved per DISTINCT id, not per row. */
  getCalls = 0;
  constructor(views: UserView[] = []) {
    for (const v of views) this.rows.set(v.id, v);
  }
  async get(id: string) {
    this.getCalls++;
    return this.rows.get(id) ?? null;
  }
  async upsert(view: UserView) {
    this.rows.set(view.id, view);
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

/**
 * TeamAccess stub — the Team context's answer, injected rather than fetched.
 *
 * FOUR FLAGS, and `contentReads`/`contentWrites` DEFAULT TO THE VALUE OF
 * THE WIDE PAIR so that every pre-existing test keeps its original meaning: a test that
 * said "the Team context allows this" still allows it, and a test that said "it refuses"
 * still refuses. The defaults are what make the diff reviewable — the outcome changes are
 * the tests that pass the pairs SEPARATELY, below.
 *
 * `calls` records WHICH predicate each route asked for. That is the drift test's whole
 * mechanism: a content route wired to the wide predicate by mistake would still return 200
 * in a test where both pairs agree, and the only way to catch it is to assert which
 * question was asked.
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

const task = (over: Partial<Task> = {}): Task => ({
  teamId: "t1",
  id: "task-1",
  title: "Existing task",
  description: null,
  status: "TODO",
  priority: "MEDIUM",
  order: 0,
  creatorId: "u1",
  aiGenerated: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  teamId: "t1",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "m1",
  type: "TEXT",
  content: "hello",
  metadata: null,
  senderId: "u1",
  parentId: null,
  ...over,
});

function build(
  over: Partial<{
    tasks: FakeTasks;
    messages: FakeMessages;
    teamAccess: TeamAccess;
    users: FakeUsers;
    events: InMemoryPublisher;
  }> = {}
) {
  const deps = {
    tasks: over.tasks ?? new FakeTasks([]),
    messages: over.messages ?? new FakeMessages([]),
    teamAccess: over.teamAccess ?? new FakeTeamAccess(true, true),
    users: over.users ?? new FakeUsers([]),
    events: over.events ?? new InMemoryPublisher(),
  };
  return { app: createCollaborationRoutes(deps), deps };
}

/** Collects live-bus events for a team over the duration of `fn`. */
async function captureLive(teamId: string, fn: () => Promise<void>) {
  const seen: TeamEvent[] = [];
  const unsub = subscribeTeamEvents(teamId, (e) => seen.push(e));
  try {
    await fn();
  } finally {
    unsub();
  }
  return seen;
}

// ─── Authorization: every route is guarded ──────────────────────────────────

describe("authorization coverage", () => {
  const readRoutes = [
    { name: "GET tasks", method: "GET", path: "/v1/teams/t1/tasks" },
    { name: "GET messages", method: "GET", path: "/v1/teams/t1/messages" },
  ];
  const writeRoutes = [
    { name: "POST tasks", method: "POST", path: "/v1/teams/t1/tasks", body: { title: "x" } },
    { name: "PATCH task", method: "PATCH", path: "/v1/teams/t1/tasks/task-1", body: { title: "x" } },
    { name: "POST messages", method: "POST", path: "/v1/teams/t1/messages", body: { content: "hi" } },
  ];

  for (const r of [...readRoutes, ...writeRoutes]) {
    it(`${r.name} requires authentication`, async () => {
      const { app } = build();
      const res = await app.request(r.path, {
        method: r.method,
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(401);
    });

    it(`${r.name} rejects a caller the Team context refuses`, async () => {
      const { app } = build({ teamAccess: new FakeTeamAccess(false, false) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "outsider", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status).toBe(403);
    });
  }

  /**
   * ── ⚠ AN EXECUTIVE WHO IS A MEMBER MAY NOW CHAT AND USE THE BOARD ────────────────────────
   *
   * These three tests previously asserted the OPPOSITE — that a read-only EXECUTIVE was refused —
   * and they were correct until executives were allowed to take part in the team's chat, scoped
   * to chat AND the task board.
   *
   * ⚠ THE SCOPE WAS MEASURED BEFORE IT WAS WIDENED. Removing EXECUTIVE from `READ_ONLY_ROLES`
   * would have granted ~34 write routes across seven services, including
   * `POST /submissions/:id/scores` — judging scores. So the grant lives in a dedicated guard on
   * these three routes only; `READ_ONLY_ROLES` is untouched and every other service still refuses
   * them. `authz.executive.test.ts` pins that boundary.
   */
  for (const r of writeRoutes) {
    it(`${r.name} ALLOWS an EXECUTIVE who is a member of the team`, async () => {
      const tasks = new FakeTasks([task()]);
      const messages = new FakeMessages([]);
      const events = new InMemoryPublisher();
      const { app } = build({
        tasks,
        messages,
        events,
        teamAccess: new FakeTeamAccess(true, true),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify(r.body),
      });

      expect(res.status).toBeLessThan(300);
    });

    it(`${r.name} still refuses an EXECUTIVE who is NOT a member`, async () => {
      /**
       * ⚠ MEMBERSHIP IS THE WHOLE PROTECTION. "Executive" is not a licence to post into an
       * arbitrary team's chat — only into one they belong to. `canReadContent` is pure membership
       * with no role branch, which is why the grant cannot leak across teams.
       */
      const tasks = new FakeTasks([task()]);
      const messages = new FakeMessages([]);
      const events = new InMemoryPublisher();
      const { app } = build({
        tasks,
        messages,
        events,
        teamAccess: new FakeTeamAccess(false, false),
      });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
        body: JSON.stringify(r.body),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
      // …and nothing was created, mutated, or announced: the one seeded task is
      // untouched, no message exists, no domain event fired. Kept from the original test
      // because a 403 that still wrote something would pass a status-only assertion.
      expect(tasks.rows).toHaveLength(1);
      expect(tasks.rows[0].title).toBe("Existing task");
      expect(messages.rows).toHaveLength(0);
      expect(events.published).toHaveLength(0);
    });
  }

  for (const r of readRoutes) {
    it(`${r.name} allows a read-only EXECUTIVE`, async () => {
      const { app } = build();
      const res = await app.request(r.path, {
        headers: asUser({ id: "exec", role: "EXECUTIVE" }),
      });
      expect(res.status).toBe(200);
    });
  }

  // ── THE BOARD AND THE CHAT ARE MEMBER-ONLY ──────────────────────
  //
  // These routes used to be gated on the WIDE predicate, so an ADMIN and a
  // workshop-owning FACILITATOR read (and wrote) any team's board and chat. They are now
  // gated on the CONTENT predicate — membership of this team — and the tests below are the
  // DRIFT TEST for this consumer: they assert WHICH question each route asks, not merely
  // that a refusal produces a 403. A route wired to the wide predicate by mistake would
  // pass every test above, because in those the two pairs agree.

  const allRoutes = [...readRoutes, ...writeRoutes];

  for (const r of allRoutes) {
    it(`${r.name} asks the CONTENT predicate, not the administration one`, async () => {
      const teamAccess = new FakeTeamAccess(true, true);
      const { app } = build({ teamAccess });

      await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      // Exactly one question, and it is a *Content one. `canRead`/`canWrite` appearing here
      // is the regression: it would mean this route is still deciding on the wide rule.
      expect(teamAccess.calls).toHaveLength(1);
      expect(teamAccess.calls[0]).toMatch(/^can(Read|Write)Content$/);
    });

    it(`${r.name} 403s a caller the CONTENT predicate refuses but the WIDE one allows`, async () => {
      // ── THE ADMIN/FACILITATOR CASE, EXPRESSED WITHOUT NAMING A ROLE ──
      //
      // This is exactly the shape the Team service answers for a non-member ADMIN or a
      // workshop-owning FACILITATOR: wide pair TRUE, content pair FALSE. Driving it through
      // the flags rather than through a role header is deliberate — this service does not
      // know the role matrix and must not start depending on one, so the property being
      // asserted is "it honours the narrow field", which is what actually protects the data.
      const teamAccess = new FakeTeamAccess(true, true, false, false);
      const tasks = new FakeTasks([task()]);
      const messages = new FakeMessages([]);
      const events = new InMemoryPublisher();
      const { app } = build({ teamAccess, tasks, messages, events });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "admin", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
      // Nothing read out, nothing written, nothing announced.
      expect(await res.text()).not.toContain("Existing task");
      expect(tasks.rows).toHaveLength(1);
      expect(tasks.rows[0].title).toBe("Existing task");
      expect(messages.rows).toHaveLength(0);
      expect(events.published).toHaveLength(0);
    });

    it(`${r.name} 403s when the Team service cannot answer (fail-closed)`, async () => {
      // "Undetermined" must never render as "allowed". HttpTeamAccess maps a 500, a
      // timeout, a connect error, a non-JSON body AND AN ABSENT FIELD to false — the last
      // being the rolling-deploy case where Team is older than this consumer. Asserted here
      // at the route level so the property is pinned end to end, not only in the client.
      const unavailable: TeamAccess = {
        canRead: async () => false,
        canWrite: async () => false,
        canReadContent: async () => false,
        canWriteContent: async () => false,
      };
      const { app } = build({ teamAccess: unavailable });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
    });

    it(`${r.name} 403s a forged x-identity-role: ADMIN with no membership`, async () => {
      // A COMPROMISED INTERNAL CALLER. The trusted-internal hop lets a caller assert its
      // own role, so this service must never grant content access ON THE STRENGTH OF A
      // ROLE — and it does not, because it asks about MEMBERSHIP and has no role branch of
      // its own for the content decision. Membership is a fact in the Team service's table
      // that no header can fabricate.
      const teamAccess = new FakeTeamAccess(true, true, false, false);
      const { app } = build({ teamAccess });

      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "attacker", role: "ADMIN" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });

      expect(res.status).toBe(403);
    });
  }

  it("still lets a MEMBER through on every route", async () => {
    // The half that must not break: a member passes both pairs, which is what the Team
    // service answers for a real member.
    for (const r of allRoutes) {
      const { app } = build({ tasks: new FakeTasks([task()]) });
      const res = await app.request(r.path, {
        method: r.method,
        headers: asUser({ id: "member", role: "PARTICIPANT" }),
        body: "body" in r ? JSON.stringify(r.body) : undefined,
      });
      expect(res.status, r.name).toBeLessThan(300);
    }
  });
});

// ─── Tasks ──────────────────────────────────────────────────────────────────

describe("GET /v1/teams/:teamId/tasks", () => {
  it("returns only the requested team's tasks", async () => {
    const tasks = new FakeTasks([
      task({ teamId: "t1", id: "mine" }),
      task({ teamId: "t2", id: "theirs" }),
    ]);
    const { app } = build({ tasks });

    const res = await app.request("/v1/teams/t1/tasks", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { tasks: Task[] };
    expect(body.tasks.map((t) => t.id)).toEqual(["mine"]);
  });
});

describe("POST /v1/teams/:teamId/tasks", () => {
  it("stamps the creator from the identity, ignoring any creatorId in the body", async () => {
    // Otherwise a client could attribute its task to someone else — and the
    // Evaluation service's contribution scoring counts tasks by creatorId.
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "real-user", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Do it", creatorId: "someone-else" }),
    });

    expect(tasks.rows[0].creatorId).toBe("real-user");
  });

  it("keys the task to the teamId in the URL, not one from the body", async () => {
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Do it", teamId: "t-other" }),
    });

    // The guard authorized t1; writing to t-other would place a row in a team the
    // caller was never checked against.
    expect(tasks.rows[0].teamId).toBe("t1");
  });

  it("applies the documented defaults for an otherwise bare body", async () => {
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    const res = await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Do it" }),
    });

    expect(res.status).toBe(201);
    expect(tasks.rows[0]).toMatchObject({
      status: "TODO",
      priority: "MEDIUM",
      order: 0,
      description: null,
      aiGenerated: false,
    });
    // assigneeId is OMITTED rather than set to undefined: the assigneeId-index GSI
    // key attribute cannot take a null, so an unassigned task must have no
    // attribute at all.
    expect(tasks.rows[0]).not.toHaveProperty("assigneeId");
  });

  it("includes assigneeId only when one was supplied", async () => {
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Do it", assigneeId: "u2" }),
    });

    expect(tasks.rows[0].assigneeId).toBe("u2");
  });

  it("generates an id when none is given and honours a client-supplied one", async () => {
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Generated" }),
    });
    await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Explicit", id: "client-id" }),
    });

    expect(tasks.rows[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(tasks.rows[1].id).toBe("client-id");
  });

  it("publishes task.created and pushes a live 'created' event", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    const live = await captureLive("t1", async () => {
      await app.request("/v1/teams/t1/tasks", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ title: "Do it", aiGenerated: true }),
      });
    });

    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      source: "collaboration-service",
      type: "task.created",
      detail: { teamId: "t1", title: "Do it", aiGenerated: true },
    });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      kind: "task",
      action: "created",
      teamId: "t1",
      actorId: "u1",
      status: "TODO",
    });
  });
});

describe("PATCH /v1/teams/:teamId/tasks/:taskId", () => {
  it("publishes task.status-changed only when the status actually changes", async () => {
    // Evaluation counts DONE transitions from this event. Re-emitting it on a
    // no-op save (a drag that lands in the same column, a title edit) would inflate
    // every participant's contribution score.
    const tasks = new FakeTasks([task({ status: "TODO" })]);
    const events = new InMemoryPublisher();
    const { app } = build({ tasks, events });

    const headers = asUser({ id: "u1", role: "PARTICIPANT" });

    // Same status → no event.
    await app.request("/v1/teams/t1/tasks/task-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "TODO" }),
    });
    expect(events.published).toHaveLength(0);

    // Status omitted entirely → no event.
    await app.request("/v1/teams/t1/tasks/task-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(events.published).toHaveLength(0);

    // A real change → exactly one event.
    await app.request("/v1/teams/t1/tasks/task-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "DONE" }),
    });
    // ⚠ `userId` ADDED, and its ABSENCE here is what pinned a live bug in place. An exact
    // `toEqual` on this shape asserted that the event carried NO ACTOR — which is exactly why
    // evaluation's projection dropped it and `tasksCompleted` stayed 0 for every member on
    // every team. The strict comparison is kept (it is the right assertion for "exactly one
    // event, exactly this shape"); the shape is now the correct one.
    expect(events.published).toEqual([
      {
        source: "collaboration-service",
        type: "task.status-changed",
        detail: {
          taskId: "task-1",
          teamId: "t1",
          status: "DONE",
          // The COMPLETER — the caller who moved the card.
          userId: "u1",
        },
      },
    ]);
  });

  /**
   * ── ⚠ THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT IS THE POINT ────────────────────────
   *
   * It read "treats a first-ever status on an unknown task as a change" and pinned a 200 with a
   * published task.status-changed, describing it as "the current, deliberate behaviour rather
   * than a silent surprise". Pinned, note — the comment claimed it was deliberate but never gave
   * a reason it should be so, and there was none.
   *
   * SECURITY FINDING (Low — "Task PATCH has no existence precondition: the
   * unconditional DynamoDB Update upserts unattributed phantom tasks and mints tasksCompleted
   * activity credit"). Two effects, and the test only ever saw one of them:
   *
   *   1. DynamoDB's UpdateItem is an UPSERT, so the PATCH CREATED the row it could not find —
   *      teamId, id, the patched attributes and updatedAt, with no creatorId or createdAt.
   *   2. `prior` is null for a missing row, so `statusChanged` is true for any supplied status:
   *      the event published with the caller's userId and evaluation's projection incremented
   *      tasksCompleted for them. Fabricated credit in a scored, published ranking.
   *
   * ⚠ AND EFFECT 1 WAS INVISIBLE HERE BECAUSE `FakeTasks.update` NEVER UPSERTED. The fake was
   * stricter than DynamoDB, so the phantom row could not appear in a test — a reminder that a
   * fake which is kinder than the real store hides exactly the behaviour worth testing. The
   * repository now carries attribute_exists, which is what makes the fake's behaviour correct
   * rather than merely convenient.
   */
  it("REFUSES a PATCH on an unknown task, and publishes nothing", async () => {
    const events = new InMemoryPublisher();
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks, events });

    const res = await app.request("/v1/teams/t1/tasks/ghost", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ status: "DONE" }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found: no such task", code: "TASK_NOT_FOUND" });
    // The half that mattered: no event, so no tasksCompleted credit for a task nobody created.
    expect(events.published).toHaveLength(0);
    // And nothing was written under the id that was probed.
    expect(tasks.rows).toHaveLength(0);
  });

  it("pushes a live 'updated' event carrying the post-update title and status", async () => {
    const tasks = new FakeTasks([task({ status: "TODO", title: "Before" })]);
    const { app } = build({ tasks });

    const live = await captureLive("t1", async () => {
      await app.request("/v1/teams/t1/tasks/task-1", {
        method: "PATCH",
        headers: asUser({ id: "u2", role: "PARTICIPANT" }),
        body: JSON.stringify({ title: "After", status: "IN_PROGRESS" }),
      });
    });

    expect(live[0]).toMatchObject({
      kind: "task",
      action: "updated",
      actorId: "u2",
      taskId: "task-1",
      title: "After",
      status: "IN_PROGRESS",
    });
  });

  it("leaves fields the caller omitted untouched", async () => {
    const tasks = new FakeTasks([task({ title: "Keep me", priority: "HIGH" })]);
    const { app } = build({ tasks });

    await app.request("/v1/teams/t1/tasks/task-1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ status: "DONE" }),
    });

    expect(tasks.rows[0]).toMatchObject({
      title: "Keep me",
      priority: "HIGH",
      status: "DONE",
    });
  });

  it("always advances updatedAt", async () => {
    const tasks = new FakeTasks([task({ updatedAt: "2020-01-01T00:00:00.000Z" })]);
    const { app } = build({ tasks });

    await app.request("/v1/teams/t1/tasks/task-1", {
      method: "PATCH",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({}),
    });

    expect(tasks.rows[0].updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

// ─── Messaging ──────────────────────────────────────────────────────────────

describe("GET /v1/teams/:teamId/messages", () => {
  it("resolves sender names from the LOCAL users read-model", async () => {
    const messages = new FakeMessages([message({ senderId: "u1" })]);
    const users = new FakeUsers([{ id: "u1", name: "Ada Lovelace" }]);
    const { app } = build({ messages, users });

    const res = await app.request("/v1/teams/t1/messages", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { messages: Array<{ userId: string; userName: string }> };
    expect(body.messages[0]).toMatchObject({ userId: "u1", userName: "Ada Lovelace" });
  });

  it("falls back to 'Unknown' when the read-model hasn't caught up", async () => {
    // The read-model is fed asynchronously by Identity's user.* events, so a brand
    // new user's name can legitimately be absent. That must render as "Unknown",
    // never as a 500 or a blank author.
    const messages = new FakeMessages([message({ senderId: "brand-new" })]);
    const { app } = build({ messages, users: new FakeUsers([]) });

    const res = await app.request("/v1/teams/t1/messages", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { messages: Array<{ userName: string }> };
    expect(res.status).toBe(200);
    expect(body.messages[0].userName).toBe("Unknown");
  });

  it("defaults the page size to 50 and passes ?before= through", async () => {
    const messages = new FakeMessages([]);
    const { app } = build({ messages });
    const headers = asUser({ id: "u1", role: "PARTICIPANT" });

    await app.request("/v1/teams/t1/messages", { headers });
    await app.request("/v1/teams/t1/messages?limit=10&before=2026-01-01", { headers });

    expect(messages.queries).toEqual([
      { teamId: "t1", limit: 50, before: undefined },
      { teamId: "t1", limit: 10, before: "2026-01-01" },
    ]);
  });

  it("preserves the original message fields alongside the enriched ones", async () => {
    const messages = new FakeMessages([message({ content: "hi", type: "TEXT" })]);
    const { app } = build({ messages, users: new FakeUsers([{ id: "u1", name: "Ada" }]) });

    const res = await app.request("/v1/teams/t1/messages", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });

    const body = (await res.json()) as { messages: Array<Record<string, unknown>> };
    expect(body.messages[0]).toMatchObject({
      id: "m1",
      content: "hi",
      type: "TEXT",
      senderId: "u1",
      userId: "u1",
    });
  });
});

describe("POST /v1/teams/:teamId/messages", () => {
  it("stamps the sender from the identity, ignoring a senderId in the body", async () => {
    const messages = new FakeMessages([]);
    const { app } = build({ messages });

    await app.request("/v1/teams/t1/messages", {
      method: "POST",
      headers: asUser({ id: "real-user", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: "hi", senderId: "someone-else" }),
    });

    // Impersonating an author in a team chat is the obvious abuse here.
    expect(messages.rows[0].senderId).toBe("real-user");
  });

  it("defaults type to TEXT and metadata/parentId to null", async () => {
    const messages = new FakeMessages([]);
    const { app } = build({ messages });

    const res = await app.request("/v1/teams/t1/messages", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: "hi" }),
    });

    expect(res.status).toBe(201);
    expect(messages.rows[0]).toMatchObject({
      type: "TEXT",
      metadata: null,
      parentId: null,
      teamId: "t1",
    });
  });

  /**
   * ⚠ `type` HERE WAS "SYSTEM", which no producer sends and no client renders — it was an
   * arbitrary string, and it passed only because the route accepted any. That is the
   * unconstrained passthrough a security review flagged; the route now enumerates the two types
   * the portal's shared write schema already enumerates. Switched to a real one because this test
   * is about the live event, not about what `type` may be — the enum has its own cases below.
   */
  it("pushes the live event AND publishes message.sent", async () => {
    const events = new InMemoryPublisher();
    const messages = new FakeMessages([]);
    const { app } = build({ events, messages });

    const live = await captureLive("t1", async () => {
      await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "hi", type: "CODE_SNIPPET" }),
      });
    });

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      kind: "message",
      teamId: "t1",
      actorId: "u1",
      content: "hi",
      type: "CODE_SNIPPET",
    });
    expect(events.published).toHaveLength(1);
    expect(events.published[0]).toMatchObject({
      source: "collaboration-service",
      type: "message.sent",
      detail: { teamId: "t1", senderId: "u1", type: "CODE_SNIPPET" },
    });
  });

  it("uses the same id for the stored row, the live event and the domain event", async () => {
    // Clients de-duplicate an optimistic bubble against the live event by id, so a
    // mismatch shows every message twice.
    const events = new InMemoryPublisher();
    const messages = new FakeMessages([]);
    const { app } = build({ events, messages });

    const live = await captureLive("t1", async () => {
      await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "hi" }),
      });
    });

    const stored = messages.rows[0].id;
    expect((live[0] as { id: string }).id).toBe(stored);
    expect((events.published[0].detail as { messageId: string }).messageId).toBe(stored);
  });

  it("does not push a live event to another team's subscribers", async () => {
    const { app } = build();
    const other = await captureLive("t2", async () => {
      await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "secret" }),
      });
    });
    expect(other).toHaveLength(0);
  });

  /**
   * ── ⚠ THE WRITE PATH IS THE BOUNDARY, NOT THE PORTAL ────────────────────────────────────────
   *
   * SECURITY FINDING (Medium — "Team chat write path applies no server-side schema or
   * size bound, letting one member render a team's chat history unreadable").
   *
   * Nothing was validated after the membership guard: content went verbatim into the item, type
   * was anything, metadata was an arbitrary object and c.req.json() had no catch. The only
   * ceiling was the portal's Zod schema — and the portal's own code says so: "chat-limits.ts
   * records that this schema is the ONLY length bound in the whole system, the service applying
   * none". The browser holds its own Cognito token, so a member calls this route directly and
   * skips it; rows then store up to DynamoDB's 400 KB and are spread to every reader on the poll.
   */
  describe("input bounds", () => {
    it("refuses content over the ceiling, and stores nothing", async () => {
      const messages = new FakeMessages([]);
      const { app } = build({ messages });

      const res = await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "x".repeat(MAX_TEAM_MESSAGE_CHARS + 1) }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: "CONTENT_TOO_LONG",
        cap: MAX_TEAM_MESSAGE_CHARS,
      });
      expect(messages.rows).toHaveLength(0);
    });

    it("accepts content exactly at the ceiling — the bound is inclusive, like the portal's", async () => {
      // Off-by-one in the other direction is its own bug: a composer that counts to the ceiling and
      // a server that refuses AT it would reject the message the UI said was fine.
      //
      // ⚠ DERIVED FROM THE CONSTANT, NOT FROM A LITERAL. These read 4000/4001 until the constant
      // was promoted into @praimana/shared; a test carrying its own copy of the number is the
      // same duplication the promotion removed, and it would keep passing against a boundary that
      // had moved.
      const messages = new FakeMessages([]);
      const { app } = build({ messages });

      const res = await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "x".repeat(MAX_TEAM_MESSAGE_CHARS) }),
      });

      expect(res.status).toBe(201);
      expect(messages.rows).toHaveLength(1);
    });

    it("refuses a missing, empty or non-string content", async () => {
      const messages = new FakeMessages([]);
      const { app } = build({ messages });

      for (const content of [undefined, "", 42, null, { nested: true }, ["a"]]) {
        const res = await app.request("/v1/teams/t1/messages", {
          method: "POST",
          headers: asUser({ id: "u1", role: "PARTICIPANT" }),
          body: JSON.stringify(content === undefined ? {} : { content }),
        });
        expect(res.status, `content=${JSON.stringify(content)}`).toBe(400);
      }
      expect(messages.rows).toHaveLength(0);
    });

    it("refuses an off-enum type but allows an absent one", async () => {
      const messages = new FakeMessages([]);
      const { app } = build({ messages });

      const bad = await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "hi", type: "SYSTEM" }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ code: "INVALID_MESSAGE_TYPE" });

      // Absent means TEXT, matching the portal schema's .default("TEXT").
      const ok = await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "hi" }),
      });
      expect(ok.status).toBe(201);
      expect(messages.rows[0].type).toBe("TEXT");
    });

    it("does not persist caller-supplied metadata — the way round the content cap", async () => {
      const messages = new FakeMessages([]);
      const { app } = build({ messages });

      const res = await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: JSON.stringify({ content: "hi", metadata: { blob: "y".repeat(50_000) } }),
      });

      // Accepted, because metadata is not part of the contract and a refusal would break no
      // caller — but DROPPED, so it cannot be used to sidestep the ceiling above.
      expect(res.status).toBe(201);
      expect(messages.rows[0].metadata).toBeNull();
    });

    it("400s on a malformed JSON body instead of 500ing", async () => {
      // c.req.json() REJECTS on bad input; unhandled that is a 500 for a client error.
      const { app } = build({});
      const res = await app.request("/v1/teams/t1/messages", {
        method: "POST",
        headers: asUser({ id: "u1", role: "PARTICIPANT" }),
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID_BODY" });
    });
  });

});

describe("THE ACTIVITY EVENT CONTRACT — every event carries the actor the projection reads", () => {
  /**
   * THE OUTAGE THIS PINS, and it was silent for the entire life of the split services.
   *
   * Evaluation's activity projection reads `detail.userId` and skips anything without it. These
   * publishers sent `senderId`, or `authorId`, or `sharedById`, or NO ACTOR AT ALL — so every
   * event was dropped and `praimana-evaluation-activity-readmodel` stayed permanently
   * empty for every team. Proved live: 16 real chat messages on the platform, zero counter rows
   * and zero dedup claims. Downstream, the AI ratings route answered 409 NO_ACTIVITY for ever.
   *
   * ── WHY THE EXISTING TESTS PASSED THROUGHOUT ──
   *
   * The sibling assertions here use `toMatchObject`, which passes when a field is ABSENT, and
   * evaluation's own tests hand-build `detail: { teamId: "t1", userId: "u1" }` — a shape no
   * publisher emits. Each side asserted its own assumption. `assertActivityActor` is imported
   * from service-shared so the field name lives in ONE place both sides read, and it is asserted
   * here against the object this service REALLY emits rather than a literal written by hand.
   */
  it("task.created carries teamId and userId — it previously carried NEITHER actor", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    await app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ title: "Do it" }),
    });

    const detail = events.published[0].detail as Record<string, unknown>;
    expect(() => assertActivityActor(detail, "task.created")).not.toThrow();
    expect(detail.userId).toBe("u1");
    // The domain-meaningful name is kept alongside: additive, never a rename, so no existing
    // reader breaks and old/new shapes coexist during a rolling deploy.
    expect(detail.creatorId).toBe("u1");
  });

  it("task.status-changed credits the COMPLETER, not the assignee", async () => {
    /**
     * The rule, and the two are genuinely different people: `userId` is the
     * authenticated caller who moved the card — the act being counted — while `assigneeId` is
     * who it was allocated to and may be absent, stale, or someone who never touched it.
     *
     * This event carried no actor at all, so `tasksCompleted` could never be attributed. It is
     * 25% of the insights score, which therefore read as "nobody completed anything".
     */
    const events = new InMemoryPublisher();
    const tasks = new FakeTasks([
      {
        teamId: "t1",
        id: "task-1",
        title: "T",
        description: null,
        status: "TODO",
        priority: "MEDIUM",
        order: 0,
        creatorId: "u1",
        assigneeId: "assignee-not-the-completer",
        aiGenerated: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { app } = build({ events, tasks });

    await app.request("/v1/teams/t1/tasks/task-1", {
      method: "PATCH",
      headers: asUser({ id: "completer", role: "PARTICIPANT" }),
      body: JSON.stringify({ status: "DONE" }),
    });

    const ev = events.published.find((e) => e.type === "task.status-changed");
    expect(ev, "a status change must publish").toBeTruthy();
    const detail = ev!.detail as Record<string, unknown>;
    expect(() => assertActivityActor(detail, "task.status-changed")).not.toThrow();
    expect(detail.userId, "the completer").toBe("completer");
    expect(detail.userId, "NOT the assignee").not.toBe("assignee-not-the-completer");
  });

  it("message.sent carries userId beside senderId", async () => {
    const events = new InMemoryPublisher();
    const { app } = build({ events });

    await app.request("/v1/teams/t1/messages", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: JSON.stringify({ content: "hello" }),
    });

    const detail = events.published[0].detail as Record<string, unknown>;
    expect(() => assertActivityActor(detail, "message.sent")).not.toThrow();
    expect(detail.userId).toBe("u1");
    expect(detail.senderId, "kept for existing readers").toBe("u1");
  });

  it("REFUSES an event with a domain-specific actor name but no userId", async () => {
    // The exact shape that was live. A test that accepted `senderId` alone is what let this
    // ship, so the guard is asserted to REJECT it rather than merely to accept the fix.
    expect(() =>
      assertActivityActor({ teamId: "t1", senderId: "u1" }, "message.sent")
    ).toThrow(/detail\.userId is required/);
    expect(() =>
      assertActivityActor({ teamId: "t1", authorId: "u1" }, "commit.pushed")
    ).toThrow(/not a substitute/);
    // And a missing teamId is refused too — the projection keys on it.
    expect(() => assertActivityActor({ userId: "u1" }, "x")).toThrow(/teamId is required/);
  });
});

describe("GET tasks resolves ASSIGNEE NAMES — the board's '?' avatars", () => {
  /**
   * REPORTED: the Codex board showed "?" for every assigned user.
   *
   * The board renders `task.assigneeName?.[0] || "?"` as an avatar initial and this route never
   * sent that field, so the fallback fired on every card. The data was present the whole time —
   * this context's users read-model had 13 rows — the response simply omitted it.
   *
   * The messages route in this same file has always enriched `userName` from the same read-model.
   * Two routes over one projection disagreeing about whether a name is available is the actual
   * defect; this pins them together.
   */
  const taskWith = (over: Partial<Task>): Task => ({
    teamId: "t1",
    id: `task-${Math.random().toString(36).slice(2)}`,
    title: "T",
    description: null,
    status: "TODO",
    priority: "MEDIUM",
    order: 0,
    creatorId: "u1",
    aiGenerated: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  const fetchTasks = async (rows: Task[], users: FakeUsers) => {
    const { app } = build({ tasks: new FakeTasks(rows), users });
    const res = await app.request("/v1/teams/t1/tasks", {
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
    // Both enriched fields are OPTIONAL in the type, deliberately: the route omits each rather than
    // sending null, and a test asserting their absence must be able to say so.
    return (await res.json()).tasks as Array<
      Task & { assigneeName?: string; creatorName?: string }
    >;
  };

  it("sends assigneeName for an assigned task", async () => {
    const users = new FakeUsers([{ id: "alice", name: "Alice Smith" }]);
    const tasks = await fetchTasks([taskWith({ assigneeId: "alice" })], users);
    expect(tasks[0].assigneeName).toBe("Alice Smith");
  });

  it("OMITS assigneeName entirely when nobody is assigned", async () => {
    /**
     * The distinction that stops the fix creating a new bug. "No assignee" and "an assignee whose
     * name we could not resolve" are different facts: the board draws an avatar for the second and
     * nothing for the first, so defaulting both to "Unknown" would put a bubble on every
     * unassigned card.
     */
    const tasks = await fetchTasks([taskWith({})], new FakeUsers([]));
    expect(tasks[0]).not.toHaveProperty("assigneeName");
  });

  it('reports "Unknown" for an assignee missing from the read-model', async () => {
    // A real state: the projection is event-fed, so a brand-new user can be assigned a task before
    // their row arrives. Naming the gap beats rendering "?" with no explanation.
    const tasks = await fetchTasks(
      [taskWith({ assigneeId: "ghost" })],
      new FakeUsers([])
    );
    expect(tasks[0].assigneeName).toBe("Unknown");
  });

  it("looks each PERSON up once, not once per task", async () => {
    /**
     * A board where one person owns twelve cards must cost one Get, not twelve.
     *
     * TWO lookups here, not one, and that is the assertion: the twelve rows involve two distinct
     * people — alice is the assignee, u1 the creator of every row (see taskWith) — and creators are
     * resolved as well, for the task detail panel. So the bound is "per distinct person", and the
     * fixture proves both halves at once: twelve tasks, two people, two Gets.
     */
    const users = new FakeUsers([
      { id: "alice", name: "Alice Smith" },
      { id: "u1", name: "Uma One" },
    ]);
    const rows = Array.from({ length: 12 }, () => taskWith({ assigneeId: "alice" }));

    const tasks = await fetchTasks(rows, users);

    expect(tasks.every((t) => t.assigneeName === "Alice Smith")).toBe(true);
    expect(tasks.every((t) => t.creatorName === "Uma One")).toBe(true);
    expect(users.getCalls, "one lookup per DISTINCT person, not per task").toBe(2);
  });

  it("resolves the CREATOR's name — the detail panel asks who raised the task", async () => {
    /**
     * `creatorId` is a Cognito sub, which means nothing to a reader, and the task detail dialog has
     * a "Created by" row. Same read-model and the same lookup as the assignee, so a task whose
     * creator is also its assignee costs one Get rather than two.
     */
    const users = new FakeUsers([{ id: "alice", name: "Alice Smith" }]);

    const tasks = await fetchTasks(
      [taskWith({ creatorId: "alice", assigneeId: "alice" })],
      users
    );

    expect(tasks[0].creatorName).toBe("Alice Smith");
    expect(tasks[0].assigneeName).toBe("Alice Smith");
    expect(users.getCalls, "one person, one lookup").toBe(1);
  });

  it('reports "Unknown" for a creator missing from the read-model', async () => {
    // Same reasoning as the assignee: a raw sub must not leak into the UI, and an AI-generated
    // task's creator is whoever triggered the analysis — who may since have been removed.
    const tasks = await fetchTasks(
      [taskWith({ creatorId: "vanished" })],
      new FakeUsers([])
    );
    expect(tasks[0].creatorName).toBe("Unknown");
  });
});

// ─── Create integrity, and the message page bound ───────────────────────────

/**
 * ── ⚠ A CALLER-SUPPLIED ID MUST NOT REWRITE AN EXISTING CARD ──────────────────────────────
 *
 * `const taskId = body.id || ulid()` followed by a bare full-item `put`, so re-posting an
 * existing id did not fail and did not merge — it REPLACED the row, resetting `creatorId` to the
 * caller and `createdAt` to now. Whoever re-posted a teammate's card became its author, and
 * evaluation's contribution scoring counts tasks by `creatorId`.
 *
 * The AI service had the identical defect on its thread create and hardened it after a full-item
 * create destroyed a real share; this follows that precedent, including answering 200 with the
 * existing row rather than a 409.
 */
describe("POST /v1/teams/:teamId/tasks — a create cannot clobber", () => {
  const member = asUser({ id: "u1", role: "PARTICIPANT" });

  function post(app: ReturnType<typeof build>["app"], body: unknown, who = member) {
    return app.request("/v1/teams/t1/tasks", {
      method: "POST",
      headers: { ...who, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("LEAVES an existing task alone and reports it, rather than replacing it", async () => {
    const tasks = new FakeTasks([
      task({
        id: "card-1",
        title: "the original",
        creatorId: "original-author",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const { app } = build({ tasks });

    const res = await post(
      app,
      { id: "card-1", title: "hijacked", description: "mine now" },
      asUser({ id: "attacker", role: "PARTICIPANT" })
    );

    // 200, not 201 — nothing was created. And deliberately not 409: the caller's intent ("there
    // should be a task with this id") already holds, so a retrying client must not see a failure.
    expect(res.status).toBe(200);

    // ⚠ THE ROW, which is the actual finding. Attribution and creation time are untouched, and the
    // hijacker's fields were not written.
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0]).toMatchObject({
      title: "the original",
      creatorId: "original-author",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(tasks.rows[0].description).toBeNull();
  });

  it("returns the EXISTING task in the body, so a retry is genuinely idempotent", async () => {
    const tasks = new FakeTasks([task({ id: "card-1", title: "the original" })]);
    const { app } = build({ tasks });

    const res = await post(app, { id: "card-1", title: "second attempt" });

    const body = (await res.json()) as { task: Task };
    expect(body.task.title).toBe("the original");
  });

  it("still creates normally when the id is free", async () => {
    // The regression guard: refusing to clobber must not refuse to create.
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    const res = await post(app, { id: "brand-new", title: "a real card" });

    expect(res.status).toBe(201);
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0]).toMatchObject({ id: "brand-new", creatorId: "u1" });
  });

  it("mints an id when the body supplies none", async () => {
    const tasks = new FakeTasks([]);
    const { app } = build({ tasks });

    const res = await post(app, { title: "no id given" });

    expect(res.status).toBe(201);
    expect(tasks.rows[0].id).toBeTruthy();
  });
});

describe("GET /v1/teams/:teamId/messages — the limit reaches DynamoDB validated", () => {
  const member = asUser({ id: "u1", role: "PARTICIPANT" });

  /** Records the limit the route passed to the store. */
  class RecordingMessages extends FakeMessages {
    limits: number[] = [];
    async listByTeam(teamId: string, limit: number, before?: string) {
      this.limits.push(limit);
      return super.listByTeam(teamId, limit, before);
    }
  }

  it("clamps or defaults every hostile value instead of passing it through", async () => {
    // `parseInt("abc")` is NaN and "-1" was accepted; DynamoDB rejects both with a
    // ValidationException nothing catches, so each of these was a 500 produced from a URL.
    for (const raw of ["abc", "-1", "0", "", "NaN", "1e999", "99999"]) {
      const messages = new RecordingMessages([]);
      const { app } = build({ messages });

      const res = await app.request(
        `/v1/teams/t1/messages?limit=${encodeURIComponent(raw)}`,
        { headers: member }
      );

      expect(res.status, `limit=${raw}`).toBe(200);
      const passed = messages.limits[0];
      expect(Number.isInteger(passed), `limit=${raw} must be an integer`).toBe(true);
      expect(passed, `limit=${raw} must be positive`).toBeGreaterThan(0);
      expect(passed, `limit=${raw} must be capped`).toBeLessThanOrEqual(200);
    }
  });

  it("honours a sensible explicit limit", async () => {
    const messages = new RecordingMessages([]);
    const { app } = build({ messages });

    await app.request("/v1/teams/t1/messages?limit=25", { headers: member });

    expect(messages.limits[0]).toBe(25);
  });
});
