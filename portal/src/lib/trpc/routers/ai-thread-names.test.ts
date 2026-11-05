// ── ⚠ WHO WROTE EACH TURN OF AN AI TRANSCRIPT, AND WHY IT SAID "User" FOR SO LONG ────────────
//
// The AI reading pane rendered `msg.user?.name`, but `GET /v1/ai/threads/:threadId/messages` returns the
// stored `AiMessage` rows verbatim, no read-model join, unlike the TEAM roster fan-out which does add
// `user`. So that property never existed on the payload, every user turn fell through to the literal
// "User" with a "U" avatar, and nothing failed loudly enough to notice. Declaring the response type is
// what exposed it; `ai.getThread` now resolves the names.
//
// What needs testing is not the map, it is everything around it, and each of these type-checks and lints
// perfectly in its broken form:
//
//   · A ROSTER FAILURE MUST NOT COST THE TRANSCRIPT. The names are decoration on a conversation; the
//     conversation is the point. Without the `.catch`, an unreadable roster rejects the whole
//     `Promise.all` and the pane shows a load error instead of the messages it already had.
//   · AN ASSISTANT TURN GETS NO `user` AT ALL. Not "Unknown", a name on the model's reply is a false
//     attribution, and the pane keys on `role` for that distinction, so the data must agree with it.
//   · AN UNRESOLVABLE AUTHOR IS "Unknown", NEVER THE RAW `userId`. A Cognito sub in a byline reads as
//     corruption, and it discloses an identifier that has no business on screen.
//   · THE MESSAGES ARE NOT REORDERED OR DROPPED by the enrichment.
//
// The router is exercised through a mocked `backendFetch`: this is a test about which requests are made
// and what happens when one fails, so the transport is exactly the thing to control.

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ⚠ `vi.hoisted`, AND THE SPY IS PASSED DIRECTLY, same trap as `feedback-names.test.ts`: `vi.mock` is
 * hoisted above this file's bindings, so the factory must close over something hoisted with it.
 */
const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({ backendFetch }));
// ⚠ THE ALIAS PATH, NOT "../trpc", a relative specifier does not intercept the one the router imports,
// even though both resolve to the same file.
vi.mock("@/lib/trpc/trpc", () => ({
  router: (routes: Record<string, unknown>) => routes,
  protectedProcedure: {
    input() {
      return this;
    },
    query(fn: unknown) {
      return { _call: fn };
    },
    mutation(fn: unknown) {
      return { _call: fn };
    },
  },
}));

const { aiRouter } = await import("@/lib/trpc/routers/ai");

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  userId?: string;
  user?: { id: string; name: string };
}
type Resolver = (opts: {
  ctx: { token: string };
  input: { threadId: string; teamId: string };
}) => Promise<{ messages: Turn[] }>;
const getThread = (aiRouter as unknown as { getThread: { _call: Resolver } }).getThread._call;

const call = () =>
  getThread({ ctx: { token: "test-token" }, input: { threadId: "th1", teamId: "t1" } });

/** Routes the two URLs this resolver reaches; `rosterFails` exercises the failure posture. */
const wire = (opts: {
  messages?: unknown[];
  members?: unknown[];
  rosterFails?: boolean;
}) => {
  backendFetch.mockImplementation(async (path: string) => {
    if (path.includes("/members")) {
      if (opts.rosterFails) throw new Error("roster unavailable");
      return { members: opts.members ?? [] };
    }
    return { messages: opts.messages ?? [] };
  });
};

beforeEach(() => {
  backendFetch.mockReset();
});

const roster = [
  { userId: "u1", role: "LEAD", user: { id: "u1", name: "Ada Lovelace" } },
  { userId: "u2", role: "BUILDER", user: { id: "u2", name: "Grace Hopper" } },
];

describe("ai.getThread, the author of each turn", () => {
  it("resolves a user turn's name from the team roster", async () => {
    wire({
      members: roster,
      messages: [{ id: "m1", role: "user", content: "hello", userId: "u1" }],
    });

    const { messages } = await call();

    expect(messages[0].user).toEqual({ id: "u1", name: "Ada Lovelace" });
  });

  it("resolves each author independently across a multi-person thread", async () => {
    // A shared thread is the case this feature exists for, two teammates in one transcript.
    wire({
      members: roster,
      messages: [
        { id: "m1", role: "user", content: "a", userId: "u1" },
        { id: "m2", role: "user", content: "b", userId: "u2" },
      ],
    });

    const { messages } = await call();

    expect(messages.map((m) => m.user?.name)).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  it("gives an ASSISTANT turn no user object at all", async () => {
    // ⚠ NOT "Unknown". A name on the model's reply is a false attribution, and the pane decides
    // author-vs-assistant from `role`, the payload must not contradict it.
    wire({
      members: roster,
      messages: [{ id: "m1", role: "assistant", content: "hi there" }],
    });

    const { messages } = await call();

    expect(messages[0].user).toBeUndefined();
    expect("user" in messages[0]).toBe(false);
  });

  it("reports an unresolvable author as Unknown, never as the raw userId", async () => {
    // A member removed since writing, or a roster that has not caught up. A 36-character sub in a
    // byline is worse than saying nothing.
    wire({
      members: roster,
      messages: [{ id: "m1", role: "user", content: "x", userId: "ghost-sub-0123" }],
    });

    const { messages } = await call();

    expect(messages[0].user).toEqual({ id: "ghost-sub-0123", name: "Unknown" });
    expect(messages[0].user?.name).not.toContain("ghost-sub");
  });

  it("keeps every message, in order, with its content intact", async () => {
    wire({
      members: roster,
      messages: [
        { id: "m1", role: "user", content: "first", userId: "u1" },
        { id: "m2", role: "assistant", content: "second" },
        { id: "m3", role: "user", content: "third", userId: "u2" },
      ],
    });

    const { messages } = await call();

    expect(messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });
});

describe("ai.getThread, a name lookup must never cost the transcript", () => {
  /**
   * ⚠ THE REGRESSION THIS PINS. Drop the `.catch` on the roster call and the whole `Promise.all`
   * rejects: a member whose roster read was throttled sees a load error in place of a conversation
   * they are entitled to and which had already been fetched successfully.
   */
  it("returns the messages when the roster read fails", async () => {
    wire({
      rosterFails: true,
      messages: [{ id: "m1", role: "user", content: "still here", userId: "u1" }],
    });

    const { messages } = await call();

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("still here");
  });

  it("names an unresolved author 'Unknown', the turn still HAS an author", async () => {
    /**
     * ⚠ "Unknown", NOT AN OMITTED `user`, AND THE CHOICE IS DELIBERATE. A user turn has an author
     * whatever the roster did; what failed is the LOOKUP. Omitting `user` would make the pane fall
     * back to its generic "User" label, which says "this is a person", true but less than we know.
     * "Unknown" says "this is a specific person we could not name", which is the honest report and
     * the same distinction `feedback-names.test.ts` draws: could-not-resolve is not does-not-exist.
     *
     * The `id` is retained either way, so nothing downstream loses the ability to key on the author.
     */
    wire({
      rosterFails: true,
      messages: [{ id: "m1", role: "user", content: "x", userId: "u1" }],
    });

    const { messages } = await call();

    expect(messages[0].user).toEqual({ id: "u1", name: "Unknown" });
  });
});

describe("ai.getThread, the requests it makes", () => {
  it("asks the thread's messages and the team's roster, each with the caller's token", async () => {
    // A typo in either path 404s at the gateway. The roster's would then be swallowed by the catch,
    // silently removing every name with no error anywhere, so both paths are pinned.
    wire({ members: roster, messages: [] });

    await call();

    expect(backendFetch).toHaveBeenCalledWith(
      "/v1/ai/threads/th1/messages",
      expect.objectContaining({ token: "test-token" })
    );
    expect(backendFetch).toHaveBeenCalledWith(
      "/v1/teams/t1/members",
      expect.objectContaining({ token: "test-token" })
    );
  });

  it("makes exactly two requests, the fan-out is not per message", async () => {
    // The name map is built once. A lookup per turn would put a request per message on every
    // thread selection, and a long transcript would be dozens.
    wire({
      members: roster,
      messages: [
        { id: "m1", role: "user", content: "a", userId: "u1" },
        { id: "m2", role: "user", content: "b", userId: "u2" },
        { id: "m3", role: "user", content: "c", userId: "u1" },
      ],
    });

    await call();

    expect(backendFetch).toHaveBeenCalledTimes(2);
  });

  it("survives a thread with no messages", async () => {
    wire({ members: roster, messages: [] });

    await expect(call()).resolves.toEqual({ messages: [] });
  });
});
