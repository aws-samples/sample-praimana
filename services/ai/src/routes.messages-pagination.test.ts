import { describe, it, expect, beforeAll } from "vitest";
import { createAiRoutes } from "./routes.js";
import { IDENTITY_HEADERS, INTERNAL_TOKEN_HEADER } from "@praimana/service-shared";
import type { AiMessage, AiThread, MessageRepository, ThreadRepository, UsersReadModel } from "./domain.js";
import type { TeamAccess } from "./authz.js";

// ── GET /v1/ai/threads/:threadId/messages — THE THREE READ SHAPES ──────────────────────────────
//
// A multi-day workshop thread grows without bound, so the desktop stopped fetching the whole
// transcript on every open and every live poll. This route now also serves:
//   · ?since=<ISO>            incremental tail (live refresh appends only new rows)
//   · ?limit=<n>[&before=ISO] newest-first page for scroll-up pagination
//   · (no params)             the whole thread, unchanged — the compatibility path
//
// All three are bounded Queries on the (threadId, createdAt) key. These tests pin the route's
// contract; repository.dynamo.ts carries the real key-condition reads.

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
  createdById: "u1",
  createdAt: "2026-07-31T09:00:00.000Z",
  updatedAt: "2026-07-31T09:00:00.000Z",
};

/** A thread of `n` messages, createdAt = 2026-07-31T09:00:00.00{i}Z so order is obvious. */
function seed(n: number): AiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    threadId: "t1",
    id: `m${i}`,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message ${i}`,
    createdAt: `2026-07-31T09:00:00.${String(i).padStart(3, "0")}Z`,
  }));
}

// Faithful in-memory MessageRepository: the two bounded reads mirror the Dynamo range semantics.
class FakeMessages implements MessageRepository {
  constructor(readonly items: AiMessage[] = []) {}
  async listByThread(threadId: string) {
    return this.items
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async listByThreadSince(threadId: string, since: string) {
    return (await this.listByThread(threadId)).filter((m) => m.createdAt > since);
  }
  async listByThreadPage(threadId: string, opts: { limit: number; before?: string }) {
    const all = await this.listByThread(threadId);
    const older = opts.before ? all.filter((m) => m.createdAt < opts.before!) : all;
    const messages = older.slice(Math.max(0, older.length - opts.limit));
    const nextBefore = older.length > opts.limit && messages.length > 0 ? messages[0].createdAt : null;
    return { messages, nextBefore };
  }
  async put(m: AiMessage) {
    return m;
  }
}

const allowAll: TeamAccess = {
  canRead: async () => true,
  canWrite: async () => true,
  canReadContent: async () => true,
  canWriteContent: async () => true,
};

const noUsers: UsersReadModel = { get: async () => null, upsert: async () => {}, delete: async () => {} };

function build(messages: FakeMessages) {
  const threads: ThreadRepository = {
    get: async (teamId, id) => (teamId === thread.teamId && id === thread.id ? thread : null),
    getById: async (id) => (id === thread.id ? thread : null),
    listByTeam: async () => [thread],
    put: async (t) => t,
    touch: async () => {},
  };
  return createAiRoutes({
    threads,
    messages,
    users: noUsers,
    teamAccess: allowAll,
    events: { publish: async () => {} },
  });
}

const GET = (q = "") => ["/v1/ai/threads/t1/messages" + q, { headers: asUser("u1") }] as const;

describe("no params — the whole thread, unchanged", () => {
  it("returns every message, ascending", async () => {
    const app = build(new FakeMessages(seed(7)));
    const res = await app.request(...GET());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.map((m: AiMessage) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
  });
});

describe("?since — the incremental tail for live refresh", () => {
  it("returns only messages newer than `since`, ascending", async () => {
    const app = build(new FakeMessages(seed(7)));
    const res = await app.request(...GET("?since=2026-07-31T09:00:00.003Z"));
    const body = await res.json();
    // Strictly greater than m3's createdAt → m4, m5, m6.
    expect(body.messages.map((m: AiMessage) => m.id)).toEqual(["m4", "m5", "m6"]);
  });

  it("returns an empty tail when nothing is newer — the common poll case", async () => {
    const app = build(new FakeMessages(seed(3)));
    const res = await app.request(...GET("?since=2026-07-31T09:00:00.002Z"));
    const body = await res.json();
    expect(body.messages).toEqual([]);
  });
});

describe("?limit — newest-first pages for scroll-up", () => {
  it("returns the NEWEST page first, in reading (ascending) order, with a cursor", async () => {
    const app = build(new FakeMessages(seed(7))); // m0..m6
    const res = await app.request(...GET("?limit=5"));
    const body = await res.json();
    // Newest 5 are m2..m6, returned ascending so the client can render top-to-bottom.
    expect(body.messages.map((m: AiMessage) => m.id)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
    // More remains above → cursor is the oldest in the page (m2's time).
    expect(body.nextBefore).toBe("2026-07-31T09:00:00.002Z");
  });

  it("walks older pages via the cursor and reports the start of the thread with null", async () => {
    const app = build(new FakeMessages(seed(7)));
    const res = await app.request(...GET("?limit=5&before=2026-07-31T09:00:00.002Z"));
    const body = await res.json();
    // Older than m2 → m0, m1 (only two left), so no more above.
    expect(body.messages.map((m: AiMessage) => m.id)).toEqual(["m0", "m1"]);
    expect(body.nextBefore).toBeNull();
  });

  it("null cursor when the first page already covers the whole thread", async () => {
    const app = build(new FakeMessages(seed(3)));
    const res = await app.request(...GET("?limit=5"));
    const body = await res.json();
    expect(body.messages.map((m: AiMessage) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(body.nextBefore).toBeNull();
  });

  it("rejects a non-integer, zero, or over-cap limit with 400", async () => {
    const app = build(new FakeMessages(seed(3)));
    for (const bad of ["0", "-1", "abc", "101"]) {
      const res = await app.request(...GET(`?limit=${bad}`));
      expect(res.status, `limit=${bad}`).toBe(400);
    }
  });

  it("since wins when both since and limit are supplied", async () => {
    const app = build(new FakeMessages(seed(7)));
    const res = await app.request(...GET("?since=2026-07-31T09:00:00.005Z&limit=2"));
    const body = await res.json();
    // Treated as a since-tail (m6), and a tail has no pagination cursor.
    expect(body.messages.map((m: AiMessage) => m.id)).toEqual(["m6"]);
    expect(body.nextBefore).toBeUndefined();
  });
});
