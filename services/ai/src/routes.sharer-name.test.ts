// ── WHO SHARED THIS CHAT? ────────────────────────────────────────────────────
//
// REPORTED: shared chats in the desktop's Team Chats list showed "Shared" with no name, so a
// reader could not tell who had shared "Quick question" or "Fix the build".
//
// ⚠ THE CAUSE WAS HISTORICAL, NOT A BROKEN LOOKUP — worth stating because it changes the fix.
// `sharedByName` is stamped at share time and every one of those sharers IS present in the users
// read-model with a name. But threads shared BEFORE that field was written, so their rows carry `sharedById` and no name. Stamping at write
// time is correct; it simply cannot retrofit rows already stored.
//
// So the list route resolves the name on READ when the stored one is missing. These tests pin that,
// and — more importantly — pin that it degrades rather than fails: a missing name is a cosmetic gap,
// an errored list is an empty panel.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { createAiRoutes } from "./routes.js";
import { IDENTITY_HEADERS, INTERNAL_TOKEN_HEADER } from "@praimana/service-shared";
import type { AiThread, ThreadRepository, UsersReadModel } from "./domain.js";

const TEAM = "team-1";
const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

/**
 * An authenticated participant on the team.
 *
 * ⚠ THE INTERNAL TOKEN IS REQUIRED — `x-identity-*` alone is never honoured, which is the guard
 * that stops a caller from asserting their own identity. My first version of this file omitted it
 * and every request 401'd.
 */
const HEADERS = {
  "content-type": "application/json",
  [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
  [IDENTITY_HEADERS.id]: "reader-1",
  [IDENTITY_HEADERS.email]: "reader@example.com",
  [IDENTITY_HEADERS.role]: "PARTICIPANT",
};

function thread(over: Partial<AiThread> = {}): AiThread {
  return {
    teamId: TEAM,
    id: "t1",
    title: "Quick question",
    phaseContext: null,
    aiProvider: "claude",
    createdById: "sharer-1",
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    shared: true,
    sharedAt: "2026-08-09T10:32:00.000Z",
    sharedById: "sharer-1",
    ...over,
  } as AiThread;
}

/** Records every id looked up, so a test can assert the fan-out is deduplicated and bounded. */
function usersFor(
  names: Record<string, string>,
  opts: { throws?: boolean; hangs?: boolean } = {}
) {
  const lookups: string[] = [];
  const users: UsersReadModel = {
    get: async (id: string) => {
      lookups.push(id);
      if (opts.throws) throw new Error("read-model unavailable");
      // Never settles — a throttled or partitioned read-model, not a rejection.
      if (opts.hangs) return new Promise(() => {}) as never;
      return names[id] ? ({ id, name: names[id] } as never) : null;
    },
    upsert: async () => {},
    delete: async () => {},
  };
  return { users, lookups };
}

function build(threads: AiThread[], users: UsersReadModel) {
  const repo: ThreadRepository = {
    get: async () => null,
    getById: async () => null,
    listByTeam: async () => threads,
    put: async (t) => t,
    // `touch` moves the thread's updatedAt when messages are synced. A no-op here: these
    // fakes assert on routes, not on the timestamp, and the sync route awaits it.
    touch: async () => {},
  };
  return createAiRoutes({
    threads: repo,
    messages: { listByThread: async () => [], put: async (m: unknown) => m } as never,
    users,
    teamAccess: {
      canRead: async () => true,
      canWrite: async () => true,
      canReadContent: async () => true,
      canWriteContent: async () => true,
    } as never,
    events: { publish: async () => {} },
  });
}

async function list(app: ReturnType<typeof build>) {
  const res = await app.request(`/v1/ai/teams/${TEAM}/threads?shared=true`, { headers: HEADERS });
  expect(res.status).toBe(200);
  return (await res.json()) as { threads: AiThread[] };
}

describe("the shared-chat list names who shared it", () => {
  it("resolves the sharer's name for a row stored before sharedByName existed", async () => {
    const { users } = usersFor({ "sharer-1": "Participant Five" });
    const body = await list(build([thread()], users));

    expect(body.threads[0].sharedByName).toBe("Participant Five");
  });

  it("leaves an already-stored name alone", async () => {
    /**
     * The stored value is authoritative: it was the sharer's name AT THE MOMENT OF SHARING, which
     * is what the list is reporting. Overwriting it from the read-model would silently rewrite
     * history if someone were renamed.
     */
    const { users, lookups } = usersFor({ "sharer-1": "Renamed Since" });
    const body = await list(
      build([thread({ sharedByName: "Participant Five" } as Partial<AiThread>)], users)
    );

    expect(body.threads[0].sharedByName).toBe("Participant Five");
    expect(lookups, "no lookup needed when the name is already stored").toEqual([]);
  });

  /**
   * ⚠ ONE LOOKUP PER PERSON, NOT PER THREAD. A typical case is several threads shared by one person;
   * without deduplication a single sharer would cost four round-trips against another table on
   * every render of the panel.
   */
  it("deduplicates lookups across threads shared by the same person", async () => {
    const { users, lookups } = usersFor({ "sharer-1": "Participant Five" });
    const threads = [
      thread({ id: "t1", title: "Quick question" }),
      thread({ id: "t2", title: "Fix the build" }),
      thread({ id: "t3", title: "Pagination helper" }),
    ];

    const body = await list(build(threads, users));

    expect(lookups).toEqual(["sharer-1"]);
    expect(body.threads.map((t) => t.sharedByName)).toEqual([
      "Participant Five",
      "Participant Five",
      "Participant Five",
    ]);
  });

  it("looks up each distinct sharer once", async () => {
    const { users, lookups } = usersFor({ "a": "Executive One", "b": "Participant Six" });
    const body = await list(
      build([thread({ id: "t1", sharedById: "a" }), thread({ id: "t2", sharedById: "b" })], users)
    );

    expect(new Set(lookups)).toEqual(new Set(["a", "b"]));
    expect(body.threads.map((t) => t.sharedByName)).toEqual(["Executive One", "Participant Six"]);
  });
});

describe("⚠ it degrades rather than fails", () => {
  /**
   * THE ASSERTION THAT MATTERS MOST. A missing name is a cosmetic gap — the UI falls back to
   * "Shared". A thrown lookup taking the whole list down would empty the panel, which is a strictly
   * worse answer to "who shared this?" than not knowing.
   */
  it("still returns the list when the read-model throws", async () => {
    const { users } = usersFor({}, { throws: true });
    const body = await list(build([thread()], users));

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].title).toBe("Quick question");
    expect(body.threads[0].sharedByName).toBeUndefined();
  });

  it("still returns the list when the sharer is not in the read-model", async () => {
    // A participant removed from the platform, or a read-model that has not caught up yet.
    const { users } = usersFor({});
    const body = await list(build([thread()], users));

    expect(body.threads).toHaveLength(1);
    expect(body.threads[0].sharedByName).toBeUndefined();
  });

  it("does not look anybody up for a thread that was never shared", async () => {
    const { users, lookups } = usersFor({ "sharer-1": "Participant Five" });
    const body = await list(
      build([thread({ shared: false, sharedAt: undefined, sharedById: undefined } as never)], users)
    );

    expect(lookups).toEqual([]);
    expect(body.threads).toHaveLength(1);
  });

  /**
   * ⚠ BOUNDED. A team's shared list is small, but this is a per-request fan-out against another
   * table and must not scale with a list someone could grow. Past the cap the remaining rows show
   * "Shared" — the pre-existing behaviour, not a failure.
   */
  /**
   * ⚠ THE ASSERTION THE SHARED CLIENT MAKES NECESSARY. `createDocClient` sets no requestTimeout, so
   * a hung read-model would otherwise hold this list open for the SDK's whole retry ladder — the
   * reader waits, then sees nothing, because names they did not ask for could not be fetched. Fake
   * timers, so the test does not actually spend the budget.
   */
  it("abandons the lookups and returns the list when the read-model hangs", async () => {
    vi.useFakeTimers();
    try {
      const { users } = usersFor({ "sharer-1": "Participant Five" }, { hangs: true });
      const app = build([thread()], users);

      const pending = app.request(`/v1/ai/teams/${TEAM}/threads?shared=true`, { headers: HEADERS });
      await vi.advanceTimersByTimeAsync(1_000);
      const res = await pending;

      expect(res.status).toBe(200);
      const body = (await res.json()) as { threads: AiThread[] };
      expect(body.threads, "the list is the answer; the names are decoration").toHaveLength(1);
      expect(body.threads[0].sharedByName).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the number of lookups per request", async () => {
    const names: Record<string, string> = {};
    const threads: AiThread[] = [];
    for (let i = 0; i < 40; i++) {
      names[`s${i}`] = `Person ${i}`;
      threads.push(thread({ id: `t${i}`, sharedById: `s${i}` }));
    }
    const { users, lookups } = usersFor(names);

    await list(build(threads, users));

    expect(lookups.length).toBeLessThanOrEqual(25);
    expect(lookups.length).toBeGreaterThan(0);
  });
});
