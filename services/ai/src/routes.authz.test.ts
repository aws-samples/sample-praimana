import { describe, it, expect, beforeAll } from "vitest";
import { createAiRoutes } from "./routes.js";
import {
  IDENTITY_HEADERS,
  INTERNAL_TOKEN_HEADER,
} from "@praimana/service-shared";
import type {
  AiMessage,
  AiThread,
  MessageRepository,
  ThreadRepository,
  UsersReadModel,
} from "./domain.js";
import type { TeamAccess } from "./authz.js";

/**
 * AUTHORIZATION tests for the three THREAD-KEYED routes.
 *
 * These routes take no teamId — only `/threads/:threadId/...` — so they cannot
 * reuse their `/teams/:teamId/*` siblings' guard directly. They resolve the thread
 * by id (aiThreads `id-index`) and authorize against the team that OWNS it. Before
 * that resolution existed, any authenticated user who knew or guessed a thread id
 * could read another team's whole conversation, post into it, and read its timing
 * rollup. Every case below is one of those three doors.
 */

const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

/** Authenticate as a trusted internal hop (x-identity-* alone is never honoured). */
function asUser(id: string, role = "PARTICIPANT") {
  return {
    "content-type": "application/json",
    [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
    [IDENTITY_HEADERS.id]: id,
    [IDENTITY_HEADERS.email]: `${id}@example.com`,
    [IDENTITY_HEADERS.role]: role,
  };
}

const thread: AiThread = {
  teamId: "team-owning-the-thread",
  id: "t1",
  title: null,
  phaseContext: null,
  aiProvider: null,
  createdById: "insider",
  createdAt: "2026-07-31T09:00:00.000Z",
  updatedAt: "2026-07-31T09:00:00.000Z",
};

class FakeMessages implements MessageRepository {
  readonly items: AiMessage[] = [];
  async listByThread(threadId: string) {
    return this.items.filter((m) => m.threadId === threadId);
  }
  async listByThreadSince(threadId: string, since: string) {
    return (await this.listByThread(threadId)).filter((m) => m.createdAt > since);
  }
  async listByThreadPage(threadId: string, opts: { limit: number; before?: string }) {
    const all = await this.listByThread(threadId);
    const older = opts.before ? all.filter((m) => m.createdAt < opts.before!) : all;
    const sorted = [...older].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const messages = sorted.slice(Math.max(0, sorted.length - opts.limit));
    const nextBefore = sorted.length > opts.limit && messages.length > 0 ? messages[0].createdAt : null;
    return { messages, nextBefore };
  }
  async put(message: AiMessage) {
    this.items.push(message);
    return message;
  }
}

/**
 * Records which team each access question was asked about — the whole point is that it is
 * the THREAD's team, never anything the caller supplied.
 *
 * Every route here uses the CONTENT pair, so `asked` records `op: "read"` /
 * `"write"` for the CONTENT predicates and the wide pair is recorded separately as
 * `wideAsked`. Keeping the existing `op` spelling is deliberate: the pre-existing assertions
 * are about WHICH TEAM was asked about, and that property is unchanged — while `wideAsked`
 * staying empty is the new assertion that the narrow predicate is the one consulted.
 *
 * `contentReads`/`contentWrites` default to the wide pair's values so every pre-existing
 * test keeps its original meaning.
 */
class RecordingTeamAccess implements TeamAccess {
  asked: Array<{ op: "read" | "write"; teamId: string; userId: string; role: string }> =
    [];
  wideAsked: Array<{ op: "read" | "write"; teamId: string }> = [];
  constructor(
    private readonly reads = true,
    private readonly writes = true,
    private readonly contentReads = reads,
    private readonly contentWrites = writes
  ) {}
  async canRead(teamId: string) {
    this.wideAsked.push({ op: "read", teamId });
    return this.reads;
  }
  async canWrite(teamId: string) {
    this.wideAsked.push({ op: "write", teamId });
    return this.writes;
  }
  async canReadContent(teamId: string, userId: string, role: string) {
    this.asked.push({ op: "read", teamId, userId, role });
    return this.contentReads;
  }
  async canWriteContent(teamId: string, userId: string, role: string) {
    this.asked.push({ op: "write", teamId, userId, role });
    return this.contentWrites;
  }
}

const noUsers: UsersReadModel = {
  get: async () => null,
  upsert: async () => {},
  delete: async () => {},
};

function build(
  over: {
    teamAccess?: RecordingTeamAccess;
    threads?: ThreadRepository;
    messages?: FakeMessages;
  } = {}
) {
  const messages = over.messages ?? new FakeMessages();
  const teamAccess = over.teamAccess ?? new RecordingTeamAccess(true, true);
  const threads: ThreadRepository =
    over.threads ?? {
      get: async (teamId, id) =>
        teamId === thread.teamId && id === thread.id ? thread : null,
      getById: async (id) => (id === thread.id ? thread : null),
      listByTeam: async () => [thread],
      put: async (t) => t,
      // `touch` moves the thread's updatedAt when messages are synced. A no-op here: these
      // fakes assert on routes, not on the timestamp, and the sync route awaits it.
      touch: async () => {},
    };
  const published: unknown[] = [];
  const app = createAiRoutes({
    threads,
    messages,
    users: noUsers,
    teamAccess,
    events: {
      publish: async (e: unknown) => {
        published.push(e);
      },
    },
  });
  return { app, messages, teamAccess, published };
}

/**
 * One route under test: how to call it, and what an AUTHORIZED caller should get.
 *
 * `okStatus` is declared on the TYPE rather than on the one entry that needs it, so both route
 * tables share a shape and `ALL_ROUTES` is not a union the compiler has to reconcile.
 */
interface AuthzRoute {
  name: string;
  /**
   * Which CONTENT predicate the route asks.
   *
   * ⚠ A WRITE ROUTE NOW ASKS "read", AND THAT IS THE DESIGN. `requireAiConversationWrite`
   * asks pure membership and applies the role rule locally, because `canWriteContent` folds in the
   * read-only refusal — which is exactly the part relaxed so an EXECUTIVE's own AI chat can sync. What
   * these tests still guard is that it asks the CONTENT family and never the WIDE one.
   */
  mode: "read" | "write";
  request: () => readonly [string, RequestInit];
  /** Expected status for an authorized caller. Absent means "any 2xx". */
  okStatus?: number;
}

/** The three routes that receive only a threadId, and how each one is exercised. */
const THREAD_ROUTES: AuthzRoute[] = [
  {
    name: "GET /threads/:threadId/messages",
    mode: "read" as const,
    request: () => ["/v1/ai/threads/t1/messages", { method: "GET" }] as const,
  },
  {
    name: "POST /threads/:threadId/messages",
    mode: "read" as const, // write route, content-READ predicate — see the type's note

    request: () =>
      [
        "/v1/ai/threads/t1/messages",
        { method: "POST", body: JSON.stringify({ content: "hello" }) },
      ] as const,
    /**
     * WITHDRAWN, so an AUTHORIZED caller now gets 410 rather than a 2xx — and it stays in this
     * table on purpose.
     *
     * The route no longer invokes a model (see routes.ts), but its AUTHORIZATION must not have
     * softened along with it: a non-member must still get 403, and must still get it BEFORE
     * learning the feature is gone. Dropping the entry would stop asserting the 403 half, which is
     * the security-relevant half and the reason this table exists.
     *
     * So only the success expectation changes. 410 is "authorized, and the thing is gone".
     */
    okStatus: 410,
  },
  {
    name: "GET /threads/:threadId/timing",
    mode: "read" as const,
    request: () => ["/v1/ai/threads/t1/timing", { method: "GET" }] as const,
  },
];

describe("thread-keyed routes authorize against the THREAD's team", () => {
  for (const route of THREAD_ROUTES) {
    it(`${route.name} 401s an unauthenticated caller`, async () => {
      const { app } = build();
      const [path, init] = route.request();
      const res = await app.request(path, {
        ...init,
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    it(`${route.name} 404s a thread that does not exist`, async () => {
      const empty: ThreadRepository = {
        get: async () => null,
        getById: async () => null,
        listByTeam: async () => [],
        put: async (t) => t,
        // `touch` moves the thread's updatedAt when messages are synced. A no-op here: these
        // fakes assert on routes, not on the timestamp, and the sync route awaits it.
        touch: async () => {},
      };
      const { app, teamAccess } = build({ threads: empty });
      const [path, init] = route.request();
      const res = await app.request(path, { ...init, headers: asUser("anyone") });

      expect(res.status).toBe(404);
      // Nothing to authorize against, so the Team service is never asked.
      expect(teamAccess.asked).toHaveLength(0);
    });

    it(`${route.name} 403s a caller who cannot access the thread's team`, async () => {
      // Both content answers false: under the new guard, "not a member" is what denies a write, and
      // a fake that allowed the content READ would describe an ALLOWED member.
      const teamAccess = new RecordingTeamAccess(false, false, false, false);
      const { app } = build({ teamAccess });
      const [path, init] = route.request();
      const res = await app.request(path, { ...init, headers: asUser("outsider") });

      expect(res.status).toBe(403);
      // It asked about the THREAD's team — the caller never named a team at all.
      expect(teamAccess.asked).toEqual([
        {
          op: route.mode,
          teamId: "team-owning-the-thread",
          userId: "outsider",
          role: "PARTICIPANT",
        },
      ]);
    });

    it(`${route.name} lets a caller with access through`, async () => {
      const { app } = build();
      const [path, init] = route.request();
      const res = await app.request(path, { ...init, headers: asUser("insider") });
      // A withdrawn route answers 410 to an AUTHORIZED caller; everything else answers 2xx. Either
      // way the point is the same: the guard let them past. See okStatus on the route entry.
      if (route.okStatus) expect(res.status).toBe(route.okStatus);
      else expect(res.status).toBeLessThan(300);
    });
  }
});

describe("POST /threads/:threadId/messages — the guard runs before the withdrawal notice", () => {
  /**
   * ⚠ WHAT THESE TWO TESTS NOW PROVE, AND WHY THEY DID NOT SIMPLY GO AWAY.
   *
   * They used to inject a `vi.fn()` model and assert it was never called for a refused caller —
   * "the guard runs before any billable side effect". The model port has been REMOVED from this
   * service entirely, so that assertion is now structural: there is no dependency to call and no
   * fake to spy on. A test cannot assert the absence of something that cannot exist.
   *
   * The half that IS still falsifiable, and still matters, is the ORDER of the two refusals. The
   * route answers 410 to an authorized caller, and an unauthorized one must get their 403 INSTEAD
   * — never the withdrawal notice. Two reasons that is not pedantry:
   *
   *   · a 410 tells a stranger the route exists and that they got past authorization, which is a
   *     small disclosure they are not entitled to;
   *   · if the withdrawal ever became a live route again, an authorization check placed after it
   *     would already be wrong, and this is the test that would fail.
   *
   * So the spy assertions are replaced by store/event assertions, which are the observable
   * side effects that remain.
   */
  it("403s a forbidden caller INSTEAD of the withdrawal notice", async () => {
    /**
     * ⚠ THE FAKE HAD TO CHANGE FOR THE PREMISE TO HOLD. It denied only the content WRITE, which the
     * new guard never asks — so the caller became authorized and the route answered its 410, and the
     * ORDERING property (authz outranks the withdrawal notice) stopped being tested. Denying membership
     * is how a forbidden caller is now expressed.
     */
    const { app, messages, published } = build({
      teamAccess: new RecordingTeamAccess(true, false, false, false),
    });

    const res = await app.request("/v1/ai/threads/t1/messages", {
      method: "POST",
      headers: asUser("outsider"),
      body: JSON.stringify({ content: "inject" }),
    });

    expect(res.status, "authorization outranks the 410").toBe(403);
    expect(messages.items, "and nothing is written").toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  /**
   * ── ⚠ REVERSED, ON EVIDENCE FROM THE DESKTOP'S OWN LOG ───────────────────────────────────
   *
   *     [cli-assistant] sync failed (ai-chat): thread create failed: HTTP 403 —
   *     {"error":"Read-only role"}
   *
   * This test asserted that refusal, and it was correct policy — but it was SILENT DATA LOSS: an
   * executive could hold a 6,522-character conversation with the assistant, see it answered, and have
   * every push to the server refused. The transcript lived on one laptop and the portal showed nothing.
   *
   * An executive's own conversation is not the team's work product, so the guard now permits it. What
   * must not change is membership, which the next case pins.
   */
  it("lets an EXECUTIVE MEMBER write to their own thread", async () => {
    const teamAccess = new RecordingTeamAccess(true, true);
    const { app } = build({ teamAccess });

    const res = await app.request("/v1/ai/threads/t1/messages", {
      method: "POST",
      headers: asUser("exec-1", "EXECUTIVE"),
      body: JSON.stringify({ content: "my own notes" }),
    });

    // 410 is this route's withdrawal notice — reaching it means authorization PASSED, which is what
    // this asserts. A 403 would be the old refusal.
    expect(res.status).not.toBe(403);
    // Membership was checked, and with the CONTENT predicate.
    expect(teamAccess.asked).toEqual([
      { op: "read", teamId: "team-owning-the-thread", userId: "exec-1", role: "EXECUTIVE" },
    ]);
    expect(teamAccess.wideAsked, "never the wide predicate").toEqual([]);
  });

  it("still 403s an EXECUTIVE who is not a member of the thread's team", async () => {
    const teamAccess = new RecordingTeamAccess(true, true, false, false);
    const { app, messages } = build({ teamAccess });

    const res = await app.request("/v1/ai/threads/t1/messages", {
      method: "POST",
      headers: asUser("exec-2", "EXECUTIVE"),
      body: JSON.stringify({ content: "not my team" }),
    });

    expect(res.status).toBe(403);
    expect(messages.items).toHaveLength(0);
  });
});

// ─── AI conversations are MEMBER-ONLY ──────────────────────────────

describe("every AI route is gated on the CONTENT predicate", () => {
  /**
   * A team's AI conversations are the most revealing thing the platform stores about how they
   * think and work, so these routes moved from the WIDE predicate (member OR staff who owns
   * the workshop OR ADMIN) to the CONTENT one (member of this team, full stop).
   *
   * The THREAD-KEYED routes are the ones that matter most here: they take no teamId, so
   * leaving them on the wide predicate would let an ADMIN read any team's whole conversation
   * by naming a THREAD instead of a team — the same disclosure through a different door.
   */
  const TEAM_ROUTES: AuthzRoute[] = [
    {
      name: "GET /teams/:teamId/threads",
      mode: "read" as const,
      request: () => ["/v1/ai/teams/team-owning-the-thread/threads", { method: "GET" }] as const,
    },
    {
      name: "POST /teams/:teamId/threads",
      mode: "read" as const, // write route, content-READ predicate — see the type's note

      request: () =>
        [
          "/v1/ai/teams/team-owning-the-thread/threads",
          { method: "POST", body: JSON.stringify({ title: "x" }) },
        ] as const,
    },
    {
      name: "POST /teams/:teamId/threads/:threadId/share",
      mode: "read" as const, // write route, content-READ predicate — see the type's note

      request: () =>
        [
          "/v1/ai/teams/team-owning-the-thread/threads/t1/share",
          { method: "POST", body: JSON.stringify({}) },
        ] as const,
    },
  ];

  const ALL_ROUTES = [...TEAM_ROUTES, ...THREAD_ROUTES];

  for (const route of ALL_ROUTES) {
    it(`${route.name} asks the CONTENT predicate, never the wide one`, async () => {
      // THE DRIFT ASSERTION. With both pairs agreeing (the default), a route wired to the
      // wide predicate returns exactly the same status — so the only way to see the mistake
      // is to assert WHICH question was asked. `wideAsked` must stay empty.
      const teamAccess = new RecordingTeamAccess(true, true);
      const { app } = build({ teamAccess });
      const [path, init] = route.request();

      await app.request(path, { ...init, headers: asUser("member") });

      expect(teamAccess.asked).toHaveLength(1);
      expect(teamAccess.asked[0].op).toBe(route.mode);
      expect(teamAccess.wideAsked).toEqual([]);
    });

    it(`${route.name} 403s a caller the CONTENT predicate refuses but the WIDE one allows`, async () => {
      // Exactly the shape the Team service answers for a non-member ADMIN or a
      // workshop-owning FACILITATOR: wide true, content false. Driven through the flags
      // rather than a role header because this service does not know the role matrix and
      // must not start depending on one.
      const teamAccess = new RecordingTeamAccess(true, true, false, false);
      const { app, messages, published } = build({ teamAccess });
      const [path, init] = route.request();

      const res = await app.request(path, { ...init, headers: asUser("admin", "ADMIN") });

      expect(res.status).toBe(403);
      // Nothing written and nothing announced, on the write routes.
      expect(messages.items).toHaveLength(0);
      expect(published).toHaveLength(0);
    });

    it(`${route.name} 403s when the Team service cannot answer (fail-closed)`, async () => {
      // "Undetermined" must never render as "allowed". HttpTeamAccess maps a 5xx, a timeout,
      // a connect error and an ABSENT FIELD — the rolling-deploy case — all to false.
      const teamAccess = new RecordingTeamAccess(false, false, false, false);
      const { app } = build({ teamAccess });
      const [path, init] = route.request();

      const res = await app.request(path, { ...init, headers: asUser("u1") });

      expect(res.status).toBe(403);
    });

    it(`${route.name} 403s a forged x-identity-role: ADMIN with no membership`, async () => {
      // A COMPROMISED INTERNAL CALLER asserting its own role. This service has no role
      // branch for the content decision at all — it asks about MEMBERSHIP, which is a fact
      // in the Team service's table that no header can fabricate.
      const teamAccess = new RecordingTeamAccess(true, true, false, false);
      const { app } = build({ teamAccess });
      const [path, init] = route.request();

      const res = await app.request(path, { ...init, headers: asUser("attacker", "ADMIN") });

      expect(res.status).toBe(403);
    });

    it(`${route.name} still lets a MEMBER through`, async () => {
      // The half that must not break.
      const { app } = build({ teamAccess: new RecordingTeamAccess(true, true) });
      const [path, init] = route.request();

      const res = await app.request(path, { ...init, headers: asUser("member") });

      // Same reasoning as above: 410 for the withdrawn route, 2xx for the rest. The half that must
      // not break is that a MEMBER is not refused by the authorization guard.
      if (route.okStatus) expect(res.status).toBe(route.okStatus);
      else expect(res.status).toBeLessThan(300);
    });
  }

  it("does not leak a thread's MESSAGES to a non-member ADMIN", async () => {
    // The disclosure in its concrete form, since a status code alone does not prove the
    // content stayed behind.
    const messages = new FakeMessages();
    messages.items.push({
      threadId: "t1",
      id: "m1",
      role: "user",
      content: "our secret strategy",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const { app } = build({
      messages,
      teamAccess: new RecordingTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/ai/threads/t1/messages", {
      headers: asUser("admin", "ADMIN"),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("our secret strategy");
  });

  it("does not leak the TIMING ROLLUP to a non-member ADMIN either", async () => {
    // The rollup is derived from those messages — how long a team deliberated and how much
    // they leaned on the model — so leaving it open would leak the conversation's shape.
    const { app } = build({
      teamAccess: new RecordingTeamAccess(true, true, false, false),
    });

    const res = await app.request("/v1/ai/threads/t1/timing", {
      headers: asUser("admin", "ADMIN"),
    });

    expect(res.status).toBe(403);
  });
});

describe("GET /threads/:threadId/messages — the leak that authz closes", () => {
  it("returns no message content to a forbidden caller", async () => {
    const messages = new FakeMessages();
    messages.items.push({
      threadId: "t1",
      id: "m1",
      role: "user",
      content: "our secret strategy",
      createdAt: "2026-07-31T10:00:00.000Z",
    });
    const { app } = build({
      messages,
      teamAccess: new RecordingTeamAccess(false, false),
    });

    const res = await app.request("/v1/ai/threads/t1/messages", {
      headers: asUser("outsider"),
    });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("our secret strategy");
  });
});
