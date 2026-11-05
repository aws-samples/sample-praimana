import { describe, it, expect, beforeAll } from "vitest";
import { createAiRoutes } from "./routes.js";
import {
  IDENTITY_HEADERS,
  INTERNAL_TOKEN_HEADER,
  assertActivityActor,
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
 * POST /v1/ai/threads/:threadId/sync — recording a turn that already happened.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * This route was in the monolith (`apps/backend/src/ai/routes.ts:218`) and was LOST
 * when apps/backend was deleted during the
 * microservices split. Nothing replaced it, but both desktop CLI callers kept
 * POSTing to it, so every Claude Code / Kiro / Codex transcript went into a 404 for
 * a week. It surfaced as "executives cannot see AI chats in the portal" — the thread
 * rows existed, the messages table was empty, and the portal was faithfully
 * rendering nothing.
 *
 * A route can be deleted silently exactly once. These tests are what make the second
 * time impossible, so the first test asserts the plain fact that it responds at all.
 *
 * They also cover the three things the monolith's version got wrong and that a
 * straight restore would have reintroduced: unbounded batches, non-idempotent retries,
 * and unvalidated roles.
 */

const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

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
  teamId: "team-1",
  id: "t1",
  title: null,
  phaseContext: null,
  aiProvider: null,
  createdById: "insider",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T09:00:00.000Z",
};

/** Keyed by (threadId, id) so a repeated id OVERWRITES, as DynamoDB's Put does. */
class FakeMessages implements MessageRepository {
  readonly byKey = new Map<string, AiMessage>();
  get items(): AiMessage[] {
    return [...this.byKey.values()];
  }
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
    this.byKey.set(`${message.threadId}#${message.id}`, message);
    return message;
  }
}

/**
 * ⚠ `member` IS THE KNOB THAT MATTERS NOW, and `canReadContent` used to be hardcoded `true`.
 *
 * `requireAiConversationWrite` asks pure MEMBERSHIP and applies the role rule locally, so
 * a fake whose only lever was `canWriteContent` could no longer express a forbidden caller at all — both
 * authorization tests below passed 200 and asserted nothing about authorization.
 */
class Access implements TeamAccess {
  constructor(
    private readonly member = true,
    private readonly contentWrite = true
  ) {}
  async canRead() {
    return true;
  }
  async canWrite() {
    return true;
  }
  async canReadContent() {
    return this.member;
  }
  async canWriteContent() {
    return this.member && this.contentWrite;
  }
}

const noUsers: UsersReadModel = {
  get: async () => null,
  upsert: async () => {},
  delete: async () => {},
};

function build(opts: { member?: boolean; contentWrite?: boolean; threadExists?: boolean } = {}) {
  const messages = new FakeMessages();
  const published: unknown[] = [];
  /** Every `touch` the route made, so a test can assert the thread's clock moved. */
  const touched: Array<{ teamId: string; id: string; at: string }> = [];
  const threads: ThreadRepository = {
    get: async () => (opts.threadExists === false ? null : thread),
    getById: async (id) =>
      opts.threadExists === false ? null : id === thread.id ? thread : null,
    listByTeam: async () => [thread],
    put: async (t) => t,
    touch: async (teamId, id, at) => {
      touched.push({ teamId, id, at });
    },
  };
  const app = createAiRoutes({
    threads,
    messages,
    users: noUsers,
    teamAccess: new Access(opts.member ?? true, opts.contentWrite ?? true),
    events: {
      publish: async (e: unknown) => {
        published.push(e);
      },
    },
  });
  return { app, messages, published, touched };
}

const TURN = {
  messages: [
    { role: "user", content: "add a health check" },
    { role: "assistant", content: "done — see health.ts" },
  ],
};

function sync(app: ReturnType<typeof build>["app"], body: unknown, who = asUser("member")) {
  return app.request("/v1/ai/threads/t1/sync", {
    method: "POST",
    headers: who,
    body: JSON.stringify(body),
  });
}

describe("POST /threads/:threadId/sync — the route that went missing", () => {
  it("EXISTS and stores the turn (the regression this file guards)", async () => {
    // If the route is ever deleted again, Hono 404s and this fails immediately.
    const { app, messages } = build();

    const res = await sync(app, TURN);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: 2 });
    expect(messages.items).toHaveLength(2);
    expect(messages.items.map((m) => m.content)).toEqual([
      "add a health check",
      "done — see health.ts",
    ]);
  });

  it("does NOT invoke a model — the turn already happened", async () => {
    /**
     * ⚠ THIS USED TO BE PROVEN BY A THROWING FAKE, and it is now proven by the type system.
     *
     * `build()` injected a ModelClient whose `complete` threw, so reaching a 200 demonstrated the
     * route never called it. The conversational model port has since been REMOVED from AiDeps
     * entirely — this service has no way to invoke a chat model, so the guarantee is structural
     * rather than observed. Restoring one would be a deliberate change to the dependency
     * interface, not an accident this test could catch.
     *
     * Kept as a NAMED statement of the invariant, because "a sync must never bill" is the reason
     * this route exists: the turn already happened on the participant's own machine, at their own
     * cost, and the platform is only recording it.
     */
    const { app } = build();
    expect((await sync(app, TURN)).status).toBe(200);
  });

  it("publishes a COUNT, and no invented latency — the rule that changed", async () => {
    /**
     * ⚠ THIS ASSERTION WAS `expect(published).toEqual([])`, and it was half right.
     *
     * The reasoning it carried — "a CLI turn has no trustworthy latency or token counts, and a
     * human is judged by that rating, so silence beats a fabricated number" — is still correct
     * about the METRICS and is still enforced below.
     *
     * What it got wrong was extending that to the whole event. Publishing nothing made CLI work
     * invisible to every activity figure, so a team using Claude Code exactly as the platform
     * recommends counted ZERO AI usage. "This turn happened" is a real observation, not an
     * estimate — the desktop ran the CLI and we are storing what it produced.
     */
    const { app, published } = build();

    await sync(app, TURN);

    const events = published as Array<{ type: string; detail: Record<string, unknown> }>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ai.response-generated");
    expect(events[0].detail.aiTurns, "the count, which is observed").toBe(1);
    // The half of the original rule that still holds, asserted rather than assumed.
    for (const invented of ["latencyMs", "firstTokenMs", "inputTokens", "outputTokens"]) {
      expect(events[0].detail, `must not fabricate ${invented}`).not.toHaveProperty(invented);
    }
  });

  it("stamps userId on the USER message only, from the verified identity", async () => {
    const { app, messages } = build();

    await sync(app, TURN, asUser("real-caller"));

    const user = messages.items.find((m) => m.role === "user");
    const assistant = messages.items.find((m) => m.role === "assistant");
    expect(user?.userId).toBe("real-caller");
    expect(assistant?.userId).toBeUndefined();
  });

  it("IGNORES a userId in the body — attribution is not the caller's to choose", async () => {
    const { app, messages } = build();

    await sync(
      app,
      {
        messages: [{ role: "user", content: "hi", userId: "someone-else" }],
      },
      asUser("real-caller")
    );

    expect(messages.items[0].userId).toBe("real-caller");
  });

  it("orders messages within the batch so the transcript reads in sequence", async () => {
    // The table is keyed (threadId, createdAt), so equal stamps would make the
    // order arbitrary — an assistant reply could render above its own question.
    const { app, messages } = build();

    await sync(app, TURN);

    const [first, second] = messages.items;
    expect(new Date(second.createdAt).getTime()).toBeGreaterThan(
      new Date(first.createdAt).getTime()
    );
  });
});

describe("idempotency — a retry must not duplicate the turn", () => {
  it("with clientTurnId, syncing TWICE stores the turn ONCE", async () => {
    // The monolith minted a fresh ulid() per message per call, so at-least-once
    // delivery duplicated every retried turn in the reader's view. This is the fix.
    const { app, messages } = build();
    const body = { ...TURN, clientTurnId: "turn-abc" };

    await sync(app, body);
    await sync(app, body);

    expect(messages.items).toHaveLength(2);
  });

  /**
   * ── ⚠ THE MESSAGES CONVERGED AND THE COUNTER DID NOT ──────────────────────────────────
   *
   * The test above proved the STORE is idempotent, and the note on the publish call used to say the
   * event was not: "a client retrying a sync ... adds the turns twice". That was accepted as a
   * documented cost while nothing retried automatically.
   *
   * Then the desktop grew a per-message "retry sync" button, so a participant can now re-push a turn
   * with one click — and every press inflated `aiTurns`, a counter that feeds a model-written
   * assessment of a named person shown to a judge. The transcript stayed perfect while the number
   * quietly climbed, which is the worst shape a metric bug can take.
   *
   * `dedupeKey` closes it: derived from `clientTurnId`, it is stable across every retry of THIS turn
   * and unique across turns, so the projection claims it once. Asserted on the EVENT here; that the
   * projection prefers it over EventBridge's delivery id is asserted in evaluation/handler.test.ts.
   */
  it("publishes the SAME dedupeKey for a retried turn, so the count cannot inflate", async () => {
    const { app, published } = build();
    const body = { ...TURN, clientTurnId: "turn-abc" };

    await sync(app, body);
    await sync(app, body);

    const keys = (published as Array<{ detail: Record<string, unknown> }>).map(
      (e) => e.detail.dedupeKey
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain("turn-abc");
  });

  it("gives DISTINCT turns distinct dedupe keys, so real work still counts", async () => {
    // The other half: a key that collided across turns would silently stop counting genuine usage,
    // which is a worse failure than over-counting because nothing looks wrong.
    const { app, published } = build();

    await sync(app, { ...TURN, clientTurnId: "turn-1" });
    await sync(app, { ...TURN, clientTurnId: "turn-2" });

    const keys = (published as Array<{ detail: Record<string, unknown> }>).map(
      (e) => e.detail.dedupeKey
    );
    expect(new Set(keys).size).toBe(2);
  });

  /**
   * ⚠ OMITTED WITHOUT A `clientTurnId`. There is nothing stable to key on, and a key invented from the
   * content or the clock would either collapse two distinct turns into one claim or fail to match the
   * retry it exists for. Those callers keep the at-least-once behaviour the publish note documents.
   */
  it("omits dedupeKey when the caller identifies no turn", async () => {
    const { app, published } = build();

    await sync(app, TURN);

    const detail = (published as Array<{ detail: Record<string, unknown> }>)[0].detail;
    expect(detail).not.toHaveProperty("dedupeKey");
  });

  it("derives ids from (clientTurnId, index), so distinct turns stay distinct", async () => {
    const { app, messages } = build();

    await sync(app, { ...TURN, clientTurnId: "turn-1" });
    await sync(app, { ...TURN, clientTurnId: "turn-2" });

    expect(messages.items).toHaveLength(4);
    expect(new Set(messages.items.map((m) => m.id)).size).toBe(4);
  });

  it("WITHOUT clientTurnId it still appends — the current desktop keeps working", async () => {
    // Back-compat is deliberate: the shipped desktop does not send the field yet, and
    // a release that rejected it would break sync for everyone who had not updated.
    const { app, messages } = build();

    await sync(app, TURN);
    await sync(app, TURN);

    expect(messages.items).toHaveLength(4);
  });
});

describe("bounds — rejected, never silently truncated", () => {
  it("refuses a batch over the message ceiling", async () => {
    const { app, messages } = build();

    const res = await sync(app, {
      messages: Array.from({ length: 51 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `m${i}`,
      })),
    });

    expect(res.status).toBe(400);
    // Nothing stored: a half-written transcript is a wrong answer that looks right.
    expect(messages.items).toHaveLength(0);
  });

  it("accepts exactly the ceiling", async () => {
    const { app } = build();

    const res = await sync(app, {
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `m${i}`,
      })),
    });

    expect(res.status).toBe(200);
  });

  it("refuses over-long content and stores NOTHING from that batch", async () => {
    const { app, messages } = build();

    const res = await sync(app, {
      messages: [
        { role: "user", content: "fine" },
        { role: "assistant", content: "x".repeat(100_001) },
      ],
    });

    expect(res.status).toBe(400);
    // The valid first message must not have been written before the bad one failed —
    // validation runs over the whole batch first, on purpose.
    expect(messages.items).toHaveLength(0);
  });
});

describe("validation", () => {
  it.each([
    ["missing messages", {}],
    ["empty array", { messages: [] }],
    ["not an array", { messages: "nope" }],
    ["bad role", { messages: [{ role: "system", content: "x" }] }],
    ["missing role", { messages: [{ content: "x" }] }],
    ["empty content", { messages: [{ role: "user", content: "   " }] }],
    ["non-string content", { messages: [{ role: "user", content: 42 }] }],
  ])("400s on %s", async (_label, body) => {
    const { app, messages } = build();
    expect((await sync(app, body)).status).toBe(400);
    expect(messages.items).toHaveLength(0);
  });

  it("400s on a malformed JSON body rather than throwing", async () => {
    const { app } = build();
    const res = await app.request("/v1/ai/threads/t1/sync", {
      method: "POST",
      headers: asUser("member"),
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("authorization — the same member-only gate as every other route", () => {
  it("403s a caller who is not a member of the thread's team", async () => {
    // Membership is the whole protection now — see `requireAiConversationWrite`.
    const { app, messages } = build({ member: false });

    expect((await sync(app, TURN)).status).toBe(403);
    expect(messages.items).toHaveLength(0);
  });

  /**
   * ── ⚠ REVERSED, ON EVIDENCE FROM A REAL FAILURE ──────────────────────────────────────────
   *
   * This asserted "403s an EXECUTIVE — read-only roles write nothing, including transcripts", with the
   * reasoning "an executive reading their team's chats is the point; writing them is not". Correct as
   * policy, and it meant SILENT DATA LOSS in practice — from the desktop's own log:
   *
   *     [cli-assistant] sync failed (ai-chat): thread create failed: HTTP 403 —
   *     {"error":"Read-only role"}   … content length: 6522
   *
   * The conversation was answered locally and then had nowhere to go. A transcript of one's own chat is
   * not the team's work product, so it syncs; submissions, scores, docs and commits remain closed.
   */
  it("lets an EXECUTIVE MEMBER sync their own transcript", async () => {
    const { app, messages } = build();

    const res = await sync(app, TURN, asUser("exec", "EXECUTIVE"));

    expect(res.status).toBe(200);
    expect(messages.items.length, "the transcript is stored, not dropped").toBeGreaterThan(0);
  });

  it("still 403s an EXECUTIVE who is not a member of the thread's team", async () => {
    const { app, messages } = build({ member: false });

    const res = await sync(app, TURN, asUser("exec", "EXECUTIVE"));

    expect(res.status).toBe(403);
    expect(messages.items).toHaveLength(0);
  });

  it("404s an unknown thread without storing anything", async () => {
    const { app, messages } = build({ threadExists: false });

    expect((await sync(app, TURN)).status).toBe(404);
    expect(messages.items).toHaveLength(0);
  });

  it("rejects a request with no internal-service token", async () => {
    // x-identity-* alone is never honoured — the edge must have vouched for it.
    const { app } = build();
    const res = await app.request("/v1/ai/threads/t1/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [IDENTITY_HEADERS.id]: "spoofed",
        [IDENTITY_HEADERS.role]: "PARTICIPANT",
      },
      body: JSON.stringify(TURN),
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe("measured AI time — the figure the timing rollup depends on", () => {
  it("stores a latencyMs supplied for an assistant message", async () => {
    // The desktop spawns the CLI, so it is the only party that can observe how long the
    // turn took. Without this, timing.ts reports ZERO AI time for every CLI thread while
    // still showing the user's gaps — which reads as the participant being idle when the
    // assistant was in fact working.
    const { app, messages } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: "done", latencyMs: 42_000 },
      ],
    });

    const assistant = messages.items.find((m) => m.role === "assistant");
    expect(assistant?.latencyMs).toBe(42_000);
  });

  it("IGNORES latencyMs on a USER message", async () => {
    // A user message has no generation time; accepting one would let a client inflate a
    // thread's AI total by attributing time to the wrong role.
    const { app, messages } = build();

    await sync(app, {
      messages: [{ role: "user", content: "hi", latencyMs: 999_999 }],
    });

    expect(messages.items[0].latencyMs).toBeUndefined();
  });

  it.each([
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "5000"],
    ["null", null],
    ["over the 6h ceiling", 6 * 60 * 60 * 1000 + 1],
  ])("DROPS an implausible latency (%s) rather than recording it", async (_label, value) => {
    // Dropped, not clamped: a 40-hour turn is a bug or a bad clock, and silently recording
    // six hours would launder it into something that looks plausible in an average.
    const { app, messages } = build();

    await sync(app, {
      messages: [{ role: "assistant", content: "x", latencyMs: value }],
    });

    const assistant = messages.items.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant!.latencyMs).toBeUndefined();
  });

  it("accepts EXACTLY the ceiling", async () => {
    const { app, messages } = build();
    await sync(app, {
      messages: [{ role: "assistant", content: "x", latencyMs: 6 * 60 * 60 * 1000 }],
    });
    expect(messages.items[0].latencyMs).toBe(6 * 60 * 60 * 1000);
  });

  it("rounds a fractional millisecond", async () => {
    const { app, messages } = build();
    await sync(app, { messages: [{ role: "assistant", content: "x", latencyMs: 1234.7 }] });
    expect(messages.items[0].latencyMs).toBe(1235);
  });

  it("omits latencyMs entirely when none is sent — absent, not zero", async () => {
    // Zero would mean "the assistant answered instantly", which is a wrong answer that
    // looks like data. timing.ts counts these as unmeasured instead.
    const { app, messages } = build();
    await sync(app, TURN);
    for (const m of messages.items) expect(m.latencyMs).toBeUndefined();
  });
});

describe("synced: true — so fabricated timestamps are not read as human pauses", () => {
  it("marks every synced message", async () => {
    // These rows are written with `now + i` millisecond spacing, so the gaps between them
    // describe a for-loop. timing.ts keys on this flag to refuse inferring compose time
    // across them (timing.ts:222). The monolith set it; the restore dropped it, which
    // would have made a two-message turn look like a user who read and replied in 1ms and
    // dragged every average toward zero.
    const { app, messages } = build();

    await sync(app, TURN);

    expect(messages.items).toHaveLength(2);
    for (const m of messages.items) expect(m.synced).toBe(true);
  });
});

describe("THE ACTIVITY EVENT CONTRACT — ai.thread-shared carries the actor", () => {
  /**
   * `ai.thread-shared` was published with `{teamId, threadId, sharedById}` and NO `userId`.
   * Evaluation's activity projection reads `detail.userId` and skips anything without it, so
   * `aiThreadsShared` never moved for anybody — and no test in this service asserted this
   * event's payload at all, which is how it went unnoticed.
   *
   * The same defect existed on all five activity publishers, leaving
   * `praimana-evaluation-activity-readmodel` permanently empty for every team. Proved
   * live: 16 real chat messages on the platform, zero counter rows, zero dedup claims.
   */
  it("publishes userId beside sharedById", async () => {
    const { app, published } = build();

    const res = await app.request("/v1/ai/teams/team-1/threads/t1/share", {
      method: "POST",
      headers: asUser("sharer"),
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const ev = published.find(
      (e) => (e as { type?: string }).type === "ai.thread-shared"
    ) as { detail: Record<string, unknown> } | undefined;
    expect(ev, "sharing must publish the event").toBeTruthy();
    expect(() => assertActivityActor(ev!.detail, "ai.thread-shared")).not.toThrow();
    expect(ev!.detail.userId).toBe("sharer");
    // Additive: the domain-meaningful name stays for readers that already use it.
    expect(ev!.detail.sharedById).toBe("sharer");
  });
});

describe("CLI TURNS ARE COUNTED — count only, no fabricated metrics", () => {
  /**
   * THE GAP THIS CLOSES. The sync route deliberately published NO event, reasoning that
   * `ai.response-generated` carries latency and token counts a CLI turn cannot honestly supply.
   * That half was right and is still honoured. The conclusion was too broad: omitting the event
   * made CLI work invisible to every activity figure, so a team using Claude Code exactly as the
   * platform recommends counted ZERO AI usage while an in-app team counted every turn.
   *
   * Tolerable as a rough retrospective signal; it SELECTS THE WRONG WINNER in a judged
   * cross-team comparison, which is what made it worth fixing.
   */
  it("publishes ONE turn per ASSISTANT reply, not per message", async () => {
    // A user+assistant exchange is ONE turn, matching what the Bedrock path publishes per
    // invoke. Counting messages would score the CLI path double per exchange.
    const { app, published } = build();

    await sync(app, TURN);

    const ev = published.find(
      (e) => (e as { type?: string }).type === "ai.response-generated"
    ) as { detail: Record<string, unknown> } | undefined;
    expect(ev, "a synced turn must be counted").toBeTruthy();
    expect(ev!.detail.aiTurns).toBe(1);
    // teamId is required — the activity projection keys counters on (teamId, userId), so without
    // it the event would be dropped by the same guard that discarded every other activity event.
    expect(() => assertActivityActor(ev!.detail, "ai.response-generated")).not.toThrow();
  });

  it("counts a MULTI-TURN batch by its assistant replies", async () => {
    const { app, published } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "first" },
        { role: "user", content: "two" },
        { role: "assistant", content: "second" },
        { role: "user", content: "three" },
        { role: "assistant", content: "third" },
      ],
    });

    const ev = published.find((e) => (e as { type?: string }).type === "ai.response-generated") as
      | { detail: Record<string, unknown> }
      | undefined;
    expect(ev!.detail.aiTurns).toBe(3);
  });

  it("sends NO latency or token fields — inventing them was the real objection", async () => {
    /**
     * The one thing the original "publish nothing" reasoning was right about. These feed
     * responsiveness stats and a rating a human is judged by, and a CLI turn has no
     * server-measured value for any of them.
     *
     * Note `latencyMs` IS accepted on the message itself when the desktop measured it — that is
     * a real observation and timing.ts uses it. What must not travel is a FABRICATED metric on
     * the activity event.
     */
    const { app, published } = build();

    await sync(app, TURN);

    const ev = published.find((e) => (e as { type?: string }).type === "ai.response-generated") as
      | { detail: Record<string, unknown> }
      | undefined;
    for (const field of ["latencyMs", "firstTokenMs", "inputTokens", "outputTokens"]) {
      expect(ev!.detail, `must not fabricate ${field}`).not.toHaveProperty(field);
    }
  });

  it("publishes NOTHING when the sync carries no assistant reply", async () => {
    // A user-only sync has no turn to count, and `aiTurns: 0` would burn a Lambda invoke to
    // increment nothing.
    const { app, published } = build();

    await sync(app, { messages: [{ role: "user", content: "just me" }] });

    expect(
      published.filter((e) => (e as { type?: string }).type === "ai.response-generated")
    ).toHaveLength(0);
  });

  it("attributes the turns to the VERIFIED caller, never the body", async () => {
    const { app, published } = build();

    await sync(app, { ...TURN, userId: "impostor" }, asUser("real-member"));

    const ev = published.find((e) => (e as { type?: string }).type === "ai.response-generated") as
      | { detail: Record<string, unknown> }
      | undefined;
    expect(ev!.detail.userId).toBe("real-member");
    expect(ev!.detail.userId).not.toBe("impostor");
  });
});

// ── ⚠ CREATE MUST NOT CLOBBER, AND A REAL TIMESTAMP MUST BE HONOURED ─────────────────────
//
// Both fixes came from real deployment data.

describe("⚠ POST /threads leaves an existing thread alone", () => {
  /**
   * THE CONFIRMED DATA LOSS. `threads.put` is a full-item write and this route called it
   * unconditionally, so a second create REPLACED the row — dropping `shared`, `sharedAt`, `sharedById`
   * and `sharedByName`, resetting `createdAt`, and renaming the thread to the caller's latest prompt.
   *
   * Thread `4392b109`: the desktop recorded `shared_at = 11:47:01` locally (which it only does after a
   * 2xx from the share route) and the server row later read `createdAt = updatedAt = 12:48:42` with
   * every share field gone. The chat showed as shared on their machine and was invisible in Team Chats
   * to everyone, including them.
   */
  it("does not overwrite a thread that already exists", async () => {
    const puts: unknown[] = [];
    const shared = {
      teamId: "team-1",
      id: "thread-1",
      title: "Research on current software",
      createdById: "u-1",
      createdAt: "2026-08-13T10:00:00.000Z",
      updatedAt: "2026-08-13T11:47:01.000Z",
      shared: true,
      sharedAt: "2026-08-13T11:47:01.000Z",
      sharedById: "u-1",
      sharedByName: "Xavier",
    };
    /**
     * Built explicitly rather than through `build()`: the point of this test is a thread fake that
     * reports an ALREADY-SHARED row, so any write is observable as a `put`.
     */
    const app = createAiRoutes({
      threads: {
        get: async () => shared as never,
        getById: async () => shared as never,
        listByTeam: async () => [shared as never],
        put: async (t: unknown) => {
          puts.push(t);
          return t as never;
        },
      },
      messages: new FakeMessages(),
      users: noUsers,
      teamAccess: new Access(true),
      events: { publish: async () => {} },
    } as never);

    const res = await app.request("/v1/ai/teams/team-1/threads", {
      method: "POST",
      headers: asUser("member"),
      // Exactly what the desktop sends: the same id, and a title taken from the latest prompt.
      body: JSON.stringify({ id: "thread-1", title: "Inference gateways", aiProvider: "claude" }),
    });

    // ⚠ NOTHING WRITTEN. A merge would also have been wrong here — this route knows nothing about
    // sharing, so anything it writes is a guess about fields it does not own.
    expect(puts).toEqual([]);
    // 200, not 201: nothing was created. Not a 409 either — the caller's intent is satisfied, and an
    // error would make the desktop report a failure for a perfectly correct state.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.thread.shared).toBe(true);
    expect(body.thread.sharedByName).toBe("Xavier");
    expect(body.thread.title).toBe("Research on current software");
  });

  it("still creates when the thread genuinely does not exist", async () => {
    // The other half: refusing to clobber must not mean refusing to create.
    const { app } = build({ threadExists: false });

    const res = await app.request("/v1/ai/teams/team-1/threads", {
      method: "POST",
      headers: asUser("member"),
      body: JSON.stringify({ id: "brand-new", title: "First chat" }),
    });

    expect(res.status).toBe(201);
  });
});

describe("⚠ a real client timestamp is honoured, and a bad one is dropped", () => {
  const at = (iso: string) => ({
    messages: [{ role: "user", content: "why is the build red?", createdAt: iso }],
  });

  /**
   * THE SYMPTOM: team time showed 0s and gaps went uncounted. This route fabricated `now + i`
   * and flagged the row `synced`, and `timing.ts` refuses to infer a user gap across a synced row —
   * correctly, since 1ms spacing describes a for-loop. The desktop has the real times and now sends
   * them, so the refusal is no longer needed for those rows.
   */
  it("stores the client's time and does NOT flag the row synced", async () => {
    const { app, messages } = build();
    /**
     * ⚠ RELATIVE, NOT A LITERAL, AND THAT IS THE BUG THIS LINE ONCE WAS. It read
     * "2026-08-13T11:45:59.000Z" — correct when written, and it silently became wrong about
     * 30 days later, when the calendar carried it past MAX_TIMESTAMP_AGE_MS (30 days, routes.ts:168).
     * The route then DROPPED the stamp as implausible and fell back to its own, so the assertion
     * below compared a real timestamp against `now` and failed. Nothing in the code changed; the
     * date did. It surfaced by failing the services publish pipeline, five days after it broke.
     *
     * Two days is inside the window with a month of margin, and the neighbouring cases in this
     * block already derive their stamps from `Date.now()` for the same reason — this one was the
     * odd literal out.
     */
    const real = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    await sync(app, at(real));

    expect(messages.items[0].createdAt).toBe(real);
    // ⚠ THE FLAG IS THE WHOLE POINT. Keeping it on a row whose time is genuine is what made the panel
    // report 0s while the data to measure had already arrived.
    expect(messages.items[0].synced).toBeUndefined();
  });

  it("falls back to its own stamp, and flags synced, when no time is sent", async () => {
    const { app, messages } = build();

    await sync(app, { messages: [{ role: "user", content: "hello" }] });

    expect(messages.items[0].synced).toBe(true);
  });

  /**
   * ⚠ UNTRUSTED INPUT ON A PATH THAT FEEDS THE COUNTERS RANKING PEOPLE. A far-future stamp would
   * invent an enormous idle gap for whoever messages next; a far-past one would drag the thread's
   * apparent start backwards. Both are DROPPED rather than clamped — clamping launders a bad clock into
   * a plausible number.
   */
  it.each([
    ["an hour in the future", new Date(Date.now() + 60 * 60 * 1000).toISOString()],
    ["a year ago", new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()],
    ["unparseable", "last Tuesday"],
  ])("drops %s and falls back to its own stamp", async (_label, iso) => {
    const { app, messages } = build();

    const res = await sync(app, at(iso));

    // ⚠ THE BATCH IS NOT REFUSED. The message itself is legitimate content; losing a real transcript
    // over a bad clock would be the worse trade.
    expect(res.status).toBe(200);
    expect(messages.items[0].createdAt).not.toBe(iso);
    expect(messages.items[0].synced).toBe(true);
  });

  it("accepts a small clock skew, which every real laptop has", async () => {
    const { app, messages } = build();
    const slightlyAhead = new Date(Date.now() + 30 * 1000).toISOString();

    await sync(app, at(slightlyAhead));

    expect(messages.items[0].createdAt).toBe(slightlyAhead);
  });
});

/**
 * ── ⚠ CONTEXT FULLNESS, ON THE SAME TERMS AS EVERY OTHER CLIENT-REPORTED FIGURE ──────────
 *
 * THE SYMPTOM: the portal showed no context-usage percentage for Kiro chats. The desktop had the reading
 * and no payload carried it; this is the boundary where it now enters, and it is UNTRUSTED input feeding a
 * number a participant acts on ("should I compact this chat?").
 *
 * Its bound is 0..100 rather than `MAX_SYNC_TOKENS`, because it is a PERCENTAGE and not a quantity —
 * reusing the token ceiling would accept 4,000,000 as a context percentage and the portal would draw it.
 */
describe("context fullness — a percentage, bounded as one", () => {
  it("stores a reading supplied for an assistant message", async () => {
    const { app, messages } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "do it" },
        { role: "assistant", content: "done", contextUsagePercent: 62 },
      ],
    });

    expect(messages.items.find((m) => m.role === "assistant")?.contextUsagePercent).toBe(62);
  });

  it("rounds a fractional reading, as the probe's own value required", async () => {
    // The live `_kiro.dev/metadata` frame returned 10.665900230407715 — sixteen significant figures for a
    // progress reading.
    const { app, messages } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "y", contextUsagePercent: 10.665900230407715 },
      ],
    });

    expect(messages.items.find((m) => m.role === "assistant")?.contextUsagePercent).toBe(11);
  });

  /**
   * ⚠ IGNORED ON A USER MESSAGE. The reading describes the state after the agent replied; on a prompt there
   * is nothing it could be a measurement of, and accepting one would let a client put a figure on a row the
   * rollup then reads as authoritative.
   */
  it("IGNORES a reading on a USER message", async () => {
    const { app, messages } = build();

    await sync(app, { messages: [{ role: "user", content: "hi", contextUsagePercent: 80 }] });

    expect(messages.items[0].contextUsagePercent).toBeUndefined();
  });

  /**
   * ⚠ DROPPED, NOT CLAMPED — the same rule as the cache figure and the latency. Clamping 140 to 100 would
   * state "this conversation is full" on evidence already known to be wrong, and a participant would compact
   * a chat that did not need it. Absent is honest; a fabricated maximum is not.
   */
  it.each([
    ["above 100", 140],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "62"],
    ["null", null],
    ["a token-sized number", 4_000_000],
  ])("DROPS an out-of-range reading (%s) rather than clamping it", async (_label, value) => {
    const { app, messages } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "y", contextUsagePercent: value },
      ],
    });

    const assistant = messages.items.find((m) => m.role === "assistant");
    expect(assistant?.contextUsagePercent).toBeUndefined();
  });

  /** 0 and 100 are both real readings — an empty window and a full one — and must survive. */
  it.each([0, 100])("accepts the boundary value %i", async (value) => {
    const { app, messages } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "y", contextUsagePercent: value },
      ],
    });

    expect(messages.items.find((m) => m.role === "assistant")?.contextUsagePercent).toBe(value);
  });

  /**
   * ⚠ ABSENT STAYS ABSENT, NEVER 0. Claude and Codex report nothing, so the overwhelming majority of turns
   * carry no reading — and "nobody measured how full this was" must not become "this conversation is empty".
   */
  it("omits the field entirely when the client sends none", async () => {
    const { app, messages } = build();

    await sync(app, TURN);

    for (const m of messages.items) {
      expect(m).not.toHaveProperty("contextUsagePercent");
    }
  });
});

/**
 * ── ⚠ THE THREAD'S CLOCK MOVES WHEN MESSAGES ARRIVE ─────────────────────────────────────────
 *
 * THE SYMPTOM: a chat updated today still showed its creation date. `updatedAt` was
 * written by CREATE and SHARE and by nothing else, so every thread reported its creation time forever.
 * The portal's conversation list SORTS by `updatedAt || createdAt`, so a stale value put an active chat
 * at the top of the list wearing the wrong date, and `ai.tokenUsage`'s `at` was wrong identically.
 *
 * These assert the WRITE, not the rendering — that a sync which stored turns also moved the clock, and
 * that one which stored nothing did not.
 */
describe("the thread's updatedAt tracks its messages", () => {
  it("touches the thread after storing turns", async () => {
    const { app, touched } = build();

    const res = await sync(app, TURN);

    expect(res.status).toBe(200);
    expect(touched).toHaveLength(1);
  });

  it("touches the thread's OWN team and id, not the caller's claim about them", async () => {
    // The route resolves both from the STORED record. A touch keyed on anything else would move the
    // wrong row — or create one, which is why the repository's update is conditional.
    const { app, touched } = build();

    await sync(app, TURN);

    expect(touched[0]).toMatchObject({ teamId: thread.teamId, id: thread.id });
  });

  it("stamps a parseable instant, and the SERVER's clock rather than the client's", async () => {
    // Deliberately unlike the messages, which honour `msg.createdAt`. A list orders by "when did the
    // server last hear about this thread", so a device with a skewed clock must not be able to pin its
    // thread to the top of a facilitator's list, nor bury it.
    const { app, touched } = build();

    await sync(app, {
      messages: [
        { role: "user", content: "hello", createdAt: "2001-01-01T00:00:00.000Z" },
      ],
    });

    expect(Number.isNaN(Date.parse(touched[0].at))).toBe(false);
    expect(touched[0].at).not.toBe("2001-01-01T00:00:00.000Z");
  });

  it("does NOT touch the thread when the sync stored nothing", async () => {
    // An empty sync is not activity. Touching here would let a client bump its thread to the top of
    // every list without recording a single turn.
    const { app, touched } = build();

    await sync(app, { messages: [] });

    expect(touched).toHaveLength(0);
  });
});
