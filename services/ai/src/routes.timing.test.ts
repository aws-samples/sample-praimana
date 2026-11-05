import { assertActivityActor } from "@praimana/service-shared";
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

/**
 * TIMING CAPTURE — now driven through the CLI SYNC route, because that is the only place turns
 * come from.
 *
 * ── WHY THIS FILE WAS REWRITTEN RATHER THAN TRIMMED ──
 *
 * It used to drive `POST /threads/:threadId/messages`, which invoked Bedrock and stamped the
 * assistant reply after `complete()` resolved. That invoke has been REMOVED: team-member chats
 * never needed to call Bedrock — the desktop app
 * drives the participant's OWN local CLI and POSTs the finished transcript to `/sync`. Six tests
 * here asserted the behaviour of that invoke, so they were exercising a path that no longer exists.
 *
 * ⚠ THE INVARIANT THEY PROTECTED IS STILL REAL, AND IT MOVED. The rollup needs the assistant row's
 * `latencyMs` to be the measured generation time, or the same seconds get counted as both AI time
 * and user time (see timing.ts). Under `/sync` the CLIENT measures it, so what must be asserted
 * changes shape: not "the service stamps it correctly after the call" but "the service PRESERVES
 * what the client measured and REFUSES what it cannot trust".
 *
 * So the assertions moved with the invariant rather than being deleted. Two of them — the activity
 * contract's `teamId`/`userId`, which my own mutation testing once found unasserted — are carried
 * over verbatim in meaning, because the event they guard is published by BOTH routes and only one
 * route went away. The rollup's arithmetic is untouched and still covered by timing.test.ts.
 */

class FakeMessages implements MessageRepository {
  readonly items: AiMessage[] = [];
  async listByThread(threadId: string): Promise<AiMessage[]> {
    return this.items.filter((m) => m.threadId === threadId);
  }
  async listByThreadSince(threadId: string, since: string): Promise<AiMessage[]> {
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
  async put(message: AiMessage): Promise<AiMessage> {
    this.items.push(message);
    return message;
  }
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

/**
 * getById MUST resolve the thread: the thread-keyed routes authorize by looking up the thread's
 * TEAM, so an empty repository 404s every request here — the right behaviour for an unknown thread
 * (asserted in routes.authz.test.ts) but it would silently gut these assertions.
 */
const oneThread: ThreadRepository = {
  get: async (teamId, id) =>
    teamId === thread.teamId && id === thread.id ? thread : null,
  getById: async (id) => (id === thread.id ? thread : null),
  listByTeam: async () => [thread],
  put: async (t) => t,
  // `touch` moves the thread's updatedAt when messages are synced. A no-op here: these
  // fakes assert on routes, not on the timestamp, and the sync route awaits it.
  touch: async () => {},
};

const noUsers: UsersReadModel = {
  get: async () => null,
  upsert: async () => {},
  delete: async () => {},
};

/**
 * Note what is ABSENT: a `model` port. The service no longer has one, so these tests cannot
 * accidentally exercise a billable call — the dependency does not exist to inject, which is a
 * stronger guarantee than a fake that throws.
 */
function deps(messages = new FakeMessages()) {
  const published: unknown[] = [];
  return {
    messages,
    published,
    all: {
      threads: oneThread,
      messages,
      users: noUsers,
      // All four true: this file is about TIMING, so authorization gets out of the way. The
      // actual authorization behaviour is asserted in routes.authz.test.ts.
      teamAccess: {
        canRead: async () => true,
        canWrite: async () => true,
        canReadContent: async () => true,
        canWriteContent: async () => true,
      },
      events: {
        publish: async (e: unknown) => {
          published.push(e);
        },
      },
    },
  };
}

const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

const AUTH = {
  [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
  [IDENTITY_HEADERS.id]: "u1",
  [IDENTITY_HEADERS.email]: "u1@example.com",
  [IDENTITY_HEADERS.role]: "PARTICIPANT",
};

const sync = (app: ReturnType<typeof createAiRoutes>, messages: unknown[]) =>
  app.request("/v1/ai/threads/t1/sync", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({ messages }),
  });

describe("POST /threads/:threadId/sync — timing from a CLI turn", () => {
  it("PRESERVES the client's measured latencyMs on the assistant row", async () => {
    /**
     * The value the rollup sums. The platform never saw the invoke, so its job is to store the
     * measurement faithfully rather than derive it — dropping the field would make every AI-time
     * figure on the insights page zero.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    const res = await sync(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "an answer", latencyMs: 4_000 },
    ]);

    expect(res.status).toBe(200);
    const assistant = d.messages.items.find((m) => m.role === "assistant");
    expect(assistant?.latencyMs).toBe(4_000);
  });

  it("keeps the rows IN ORDER, so an interval is computable", async () => {
    // The rollup pairs each assistant row with the user row before it. Storing them out of order
    // would invert every gap it measures.
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "an answer", latencyMs: 1_000 },
    ]);

    expect(d.messages.items.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("REFUSES a latencyMs it cannot trust, rather than clamping it", async () => {
    /**
     * A 40-hour turn is a bug or a bad clock. Clamping to the 6-hour ceiling would launder an
     * absurd value into a plausible one and distort every average it appears in — so the FIELD is
     * dropped and the message is still stored. The transcript is real even when its stopwatch is
     * not.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [
      { role: "assistant", content: "an answer", latencyMs: 40 * 60 * 60 * 1000 },
    ]);

    const assistant = d.messages.items.find((m) => m.role === "assistant");
    expect(assistant, "the message is stored").toBeTruthy();
    expect(assistant?.latencyMs, "but the absurd duration is not").toBeUndefined();
  });

  it("OMITS latencyMs rather than storing 0 when the client reports none", async () => {
    // Carried over from the removed suite. Zero is a measurement; absent is "not measured", and
    // averaging a fabricated zero drags every figure down.
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [{ role: "assistant", content: "an answer" }]);

    const assistant = d.messages.items.find((m) => m.role === "assistant");
    expect("latencyMs" in (assistant as object)).toBe(false);
  });

  it("ignores latencyMs on a USER row — only generation has a duration", async () => {
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [{ role: "user", content: "hello", latencyMs: 5_000 }]);

    expect(d.messages.items[0].latencyMs).toBeUndefined();
  });
});

describe("the activity event still carries what the projection needs", () => {
  it("carries teamId and userId, or the projection cannot attribute the turn", async () => {
    /**
     * ⚠ CARRIED OVER FROM THE REMOVED SUITE, WHERE MY OWN MUTATION TESTING FOUND IT MISSING.
     * Removing `teamId` from this event broke nothing at the time, yet the activity projection keys
     * counters on (teamId, userId) and skips anything missing either — so the turn would be silently
     * dropped. That is the class of defect that left the whole read-model empty after the service
     * split, and the event is published by this route too, so the assertion belongs here.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "an answer", latencyMs: 1_000 },
    ]);

    const event = d.published[0] as {
      type: string;
      detail: { teamId: string; userId: string; aiTurns: number };
    };
    expect(event.type).toBe("ai.response-generated");
    expect(event.detail.teamId).toBe("team-1");
    expect(event.detail.userId).toBe("u1");
    // The SHARED assertion, so this cannot drift from the contract the consumer reads.
    assertActivityActor(event.detail);
  });

  it("counts ONE turn per assistant message", async () => {
    // A batched backlog is several turns in one request; the consumer increments by the stated
    // amount rather than by one per event.
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [
      { role: "user", content: "a" },
      { role: "assistant", content: "1", latencyMs: 100 },
      { role: "user", content: "b" },
      { role: "assistant", content: "2", latencyMs: 100 },
    ]);

    expect((d.published[0] as { detail: { aiTurns: number } }).detail.aiTurns).toBe(2);
  });

  it("publishes NOTHING when a batch carries no assistant turn", async () => {
    // A user message alone is not AI activity; publishing it would credit a turn that never
    // happened.
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [{ role: "user", content: "hello" }]);

    expect(d.published).toHaveLength(0);
  });
});

describe("POST /threads/:threadId/messages is GONE, and says so", () => {
  it("answers 410 and invokes nothing", async () => {
    /**
     * ⚠ THE ASSERTION THAT REPLACES SIX. That route called Bedrock with the FULL thread history on
     * every request, with no timeout and no history cap, reachable by any team member with a token
     * — and no shipped client ever posted to it.
     *
     * 410 rather than a deleted handler: dropping the handler would let the greedy
     * `ANY /v1/ai/{proxy+}` gateway mapping deliver POSTs here and produce Hono's bare 404,
     * indistinguishable from a typo. That is exactly how the board's dead "Analyze Chat" button hid
     * for months.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    const res = await app.request("/v1/ai/threads/t1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ content: "hello" }),
    });

    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("AI_CHAT_WITHDRAWN");
    expect(d.messages.items, "stores nothing").toHaveLength(0);
    expect(d.published, "publishes no activity").toHaveLength(0);
  });

  it("still READS the thread — the GET is untouched", async () => {
    // Transcripts recorded by /sync must stay readable; only the write-that-invoked-a-model went.
    const d = deps();
    const app = createAiRoutes(d.all);
    await sync(app, [{ role: "user", content: "hello" }]);

    const res = await app.request("/v1/ai/threads/t1/messages", { headers: AUTH });

    expect(res.status).toBe(200);
    expect((await res.json()).messages).toHaveLength(1);
  });
});

describe("a CLI's own failure output never reaches the portal, or the counters", () => {
  /**
   * REPORTED: a raw IAM refusal — account id, role ARN, action name — rendered to an executive on
   * the portal's /ai page. It was not our Bedrock call failing: the participant's LOCAL CLI failed,
   * printed the error as its reply, and the desktop synced that text as an assistant message.
   *
   * Filtered at this boundary rather than hidden in the UI for three reasons, the third deciding it:
   * the portal is not the only reader; the disclosure would otherwise stay in the table; and a
   * stored failure counts as an assistant turn, so it INFLATES the `aiTurns` counter that feeds a
   * model-written assessment of how well someone works with an assistant. The worse their tooling,
   * the better they would score.
   */
  const IAM_FAILURE =
    'Failed to authenticate. API Error: 403 {"Message":"User: arn:aws:sts::111122223333:assumed-role/ExampleFederatedRole/example-user is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1:111122223333:inference-profile/global.anthropic.claude-opus-5"}';

  it("REPLACES the content, disclosing no account, ARN or action", async () => {
    const d = deps();
    const app = createAiRoutes(d.all);

    const res = await sync(app, [
      { role: "user", content: "why is this failing?" },
      { role: "assistant", content: IAM_FAILURE, latencyMs: 800 },
    ]);
    expect(res.status).toBe(200);

    const assistant = d.messages.items.find((m) => m.role === "assistant");
    expect(assistant, "the turn is STORED, not dropped").toBeTruthy();
    for (const leak of ["111122223333", "arn:aws:sts", "assumed-role", "bedrock:Invoke"]) {
      expect(assistant!.content, `must not contain ${leak}`).not.toContain(leak);
    }
    expect(assistant!.content.toLowerCase()).toContain("client error");
  });

  it("⚠ does NOT credit it as an AI turn", async () => {
    /**
     * THE HALF THAT IS NOT ABOUT DISCLOSURE. One user message and one failed reply is ZERO turns, so
     * no activity event is published at all — a failure is not usage.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [
      { role: "user", content: "why is this failing?" },
      { role: "assistant", content: IAM_FAILURE, latencyMs: 800 },
    ]);

    expect(d.published, "no turn happened, so no event").toHaveLength(0);
  });

  it("counts only the REAL turns in a mixed batch", async () => {
    // A retry after fixing credentials: one failure, one genuine reply. Exactly one turn.
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [
      { role: "user", content: "try again" },
      { role: "assistant", content: IAM_FAILURE, latencyMs: 100 },
      { role: "user", content: "and now?" },
      { role: "assistant", content: "Here is the fix you asked for.", latencyMs: 2_000 },
    ]);

    expect((d.published[0] as { detail: { aiTurns: number } }).detail.aiTurns).toBe(1);
  });

  it("drops the latency of a failed turn — time spent failing is not AI time", async () => {
    // Leaving it would put the duration of a crash into a figure people read as productivity.
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [{ role: "assistant", content: IAM_FAILURE, latencyMs: 9_000 }]);

    expect(d.messages.items[0].latencyMs).toBeUndefined();
  });

  it("does NOT refuse the batch — the user's own message is legitimate", async () => {
    /**
     * A 400 would discard the participant's question along with the tool's error, losing real
     * content to protect against a disclosure. Store both; fix the one that is wrong.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    const res = await sync(app, [
      { role: "user", content: "why is this failing?" },
      { role: "assistant", content: IAM_FAILURE },
    ]);

    expect(res.status).toBe(200);
    expect(d.messages.items).toHaveLength(2);
    expect(d.messages.items[0].content).toBe("why is this failing?");
  });

  it("NEVER filters a USER message, even one pasting the same error", async () => {
    /**
     * ⚠ THE ASYMMETRY IS DELIBERATE. A participant pasting an IAM error to ask about it is exactly
     * the conversation this platform hosts — rewriting their words would be both a data loss and an
     * insult. Only an "assistant reply" that is really tool output is replaced.
     */
    const d = deps();
    const app = createAiRoutes(d.all);

    await sync(app, [{ role: "user", content: IAM_FAILURE }]);

    expect(d.messages.items[0].content, "the user's words survive verbatim").toBe(IAM_FAILURE);
  });

  it("leaves a genuine assistant answer about IAM untouched", async () => {
    // The false positive that would matter most: the assistant doing its job.
    const d = deps();
    const app = createAiRoutes(d.all);
    const answer =
      'That means your role lacks the permission. The phrase "is not authorized to perform" names the action; add an identity-based policy allowing it.';

    await sync(app, [{ role: "assistant", content: answer, latencyMs: 1_500 }]);

    expect(d.messages.items[0].content).toBe(answer);
    expect(d.messages.items[0].latencyMs, "and keeps its measured time").toBe(1_500);
    expect((d.published[0] as { detail: { aiTurns: number } }).detail.aiTurns).toBe(1);
  });
});
