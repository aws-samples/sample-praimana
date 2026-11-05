import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { MemberActivity, ActivityReadModel } from "./domain.js";

/**
 * THE regression test for this service.
 *
 * This Lambda has two unrelated invocation sources — API Gateway and EventBridge —
 * and `handle(app)` is an HTTP adapter. An EventBridge payload carries no
 * `requestContext`/`rawPath`, so feeding it to Hono matched no route and returned
 * 404. A 404 is a *successful* Lambda invocation, so EventBridge never retried and
 * the DLQ stayed empty: the activity read-model was silently never written and
 * `/teams/:id/ratings` reported zero contribution for everyone, for the entire life
 * of the deployment.
 *
 * These tests pin the discrimination itself (an event that looks like EventBridge
 * MUST reach applyActivityEvent, and an HTTP event MUST reach Hono) and the
 * throw-on-failure contract that makes retry/DLQ work at all.
 *
 * The composition root is mocked because it constructs a live DynamoDB client and
 * an EventBridge publisher at import time. The mock also gives us a read-model we
 * can assert against.
 */

/** Records every counter bump instead of writing DynamoDB. */
class SpyActivity implements ActivityReadModel {
  increments: Array<{ teamId: string; userId: string; counter: string; by?: number ; eventId?: string }> = [];
  /** When set, `increment` rejects — simulating a throttled/failed projection write. */
  failWith: Error | null = null;

  async get(): Promise<MemberActivity | null> {
    return null;
  }
  async listByTeam(): Promise<MemberActivity[]> {
    return [];
  }
  async upsert(): Promise<void> {}
  async increment(
    teamId: string,
    userId: string,
    counter: keyof Omit<MemberActivity, "teamId" | "userId" | "updatedAt">,
    by?: number,
    eventId?: string
  ): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.increments.push({ teamId, userId, counter, by, eventId });
  }
}

const spyActivity = new SpyActivity();

/** Stands in for the real composition root: a trivially routable Hono app plus the
 *  shared activity read-model both entry points write through. */
vi.mock("./app.js", () => {
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", service: "evaluation" }));
  app.post("/echo", async (c) => c.json({ received: await c.req.json() }));
  return { default: app, activityReadModel: spyActivity };
});

const { handler } = await import("./handler.js");

beforeEach(() => {
  spyActivity.increments = [];
  spyActivity.failWith = null;
});

/** An EventBridge invocation as it actually arrives (trimmed to the fields that matter). */
const eventBridgeEvent = (detailType: string, detail: unknown) => ({
  version: "0",
  id: "5f1d2a8e-0000-0000-0000-000000000000",
  "detail-type": detailType,
  source: "collaboration-service",
  account: "123456789012",
  time: "2026-07-31T00:00:00Z",
  region: "us-east-1",
  resources: [],
  detail,
});

/** An API Gateway HTTP API (payload format 2.0) invocation. */
const httpEvent = (method: string, path: string) => ({
  version: "2.0",
  routeKey: `${method} ${path}`,
  rawPath: path,
  rawQueryString: "",
  headers: { "content-type": "application/json" },
  requestContext: {
    http: { method, path, protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "test" },
  },
  isBase64Encoded: false,
});

describe("EventBridge branch", () => {
  it("routes an EventBridge payload to the activity projection, NOT to Hono", async () => {
    // The exact bug: this used to fall through to the HTTP adapter and 404.
    const result = await handler(
      eventBridgeEvent("task.created", { teamId: "t1", userId: "u1" }),
      {}
    );

    expect(spyActivity.increments).toEqual([
      {
        teamId: "t1",
        userId: "u1",
        counter: "tasksCreated",
        by: 1,
        // EventBridge's OWN id, forwarded from the envelope. It used to be dropped here,
        // which left the store with nothing to deduplicate against — so an at-least-once
        // redelivery of one completed task counted twice, permanently.
        eventId: "5f1d2a8e-0000-0000-0000-000000000000",
      },
    ]);
    // No HTTP response object — an event invocation returns nothing.
    expect(result).toBeUndefined();
  });

  it("maps detail-type onto the internal event type", async () => {
    // EventBridge's wire field is `detail-type`; the internal DomainEvent field is
    // `type`. Getting this mapping wrong makes every event hit the switch's default
    // and silently do nothing.
    await handler(
      eventBridgeEvent("task.status-changed", { teamId: "t1", userId: "u1", status: "DONE" }),
      {}
    );
    expect(spyActivity.increments.map((i) => i.counter)).toEqual(["tasksCompleted"]);
  });

  it("tolerates an EventBridge payload with no detail at all", async () => {
    // `detail` is optional on the wire; the handler defaults it to {} so the
    // projection just can't attribute the event and skips it.
    await expect(
      handler({ "detail-type": "task.created", source: "collaboration-service" }, {})
    ).resolves.toBeUndefined();
    expect(spyActivity.increments).toHaveLength(0);
  });

  it("THROWS when the projection write fails, so EventBridge retries and then DLQs", async () => {
    // The deliberate asymmetry with publishing: a dropped projection update is
    // permanent data loss (there is no reconciliation pass), so swallowing the error
    // here would recreate the original silent-zeros failure with extra steps.
    spyActivity.failWith = new Error("ProvisionedThroughputExceededException");

    await expect(
      handler(eventBridgeEvent("task.created", { teamId: "t1", userId: "u1" }), {})
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });
});

describe("HTTP branch", () => {
  it("routes an API Gateway payload to Hono", async () => {
    const result = (await handler(httpEvent("GET", "/health"), {})) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ service: "evaluation" });
    expect(spyActivity.increments).toHaveLength(0);
  });

  it("does not divert an HTTP request that happens to carry a `source` field", async () => {
    // An HTTP event with a body containing `source` must still be HTTP. The
    // discriminator requires BOTH `detail-type` and `source` at the TOP level, which
    // is what keeps a request body from steering the branch.
    const event = {
      ...httpEvent("POST", "/echo"),
      body: JSON.stringify({ source: "collaboration-service", "detail-type": "task.created" }),
    };

    const result = (await handler(event, {})) as { statusCode: number; body: string };
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).received).toMatchObject({
      source: "collaboration-service",
    });
    expect(spyActivity.increments).toHaveLength(0);
  });
});

describe("isEventBridgeEvent discrimination (via the handler's observable branch)", () => {
  /** Payloads that must NOT be treated as EventBridge. */
  const notEventBridge: Array<[string, unknown]> = [
    ["missing detail-type", { source: "collaboration-service" }],
    ["missing source", { "detail-type": "task.created" }],
    ["non-string detail-type", { "detail-type": 42, source: "collaboration-service" }],
    ["non-string source", { "detail-type": "task.created", source: { name: "x" } }],
    ["nested rather than top-level", { detail: { "detail-type": "x", source: "y" } }],
  ];

  for (const [name, payload] of notEventBridge) {
    it(`treats a payload with ${name} as HTTP, not as an event`, async () => {
      // These fall through to the HTTP adapter. What they return is Hono's business
      // (very likely a 404); what matters is that the projection was NOT touched, so
      // a malformed event can never be mistaken for a successful projection.
      await handler({ ...httpEvent("GET", "/health"), ...(payload as object) }, {}).catch(
        () => undefined
      );
      expect(spyActivity.increments).toHaveLength(0);
    });
  }

  it("does not treat null or a primitive as an EventBridge event", async () => {
    // `typeof null === "object"`, so the explicit null guard is load-bearing: without
    // it this throws on property access instead of falling through.
    for (const payload of [null, undefined, 42, "task.created", true]) {
      await handler(payload, {}).catch(() => undefined);
    }
    expect(spyActivity.increments).toHaveLength(0);
  });
});

// ── ⚠ A RE-PUBLISHED TURN MUST NOT BE COUNTED TWICE ──────────────────────────────────────
//
// EventBridge's `id` dedups a REDELIVERY of one publish. It cannot dedup a re-PUBLISH, and that gap
// became reachable when the desktop grew a per-message "retry sync" button: a retried turn converges its
// MESSAGES (the AI service derives `sync-<clientTurnId>-<i>` ids) and then publishes a fresh
// `ai.response-generated` with a brand-new EventBridge id. The transcript stayed correct while `aiTurns`
// — a counter that feeds a model-written assessment of a named person — went up once per press.
//
// So a publisher that can identify its own work sends `dedupeKey`, and that wins here.

describe("⚠ the publisher's dedupeKey outranks EventBridge's delivery id", () => {
  const turn = (dedupeKey?: string) => ({
    ...eventBridgeEvent("ai.response-generated", {
      teamId: "t1",
      userId: "u1",
      aiTurns: 1,
      ...(dedupeKey ? { dedupeKey } : {}),
    }),
    // A DIFFERENT delivery id each time — which is exactly what a re-publish looks like.
    id: `delivery-${Math.abs(dedupeKey ? 1 : 2)}-${spyActivity.increments.length}`,
  });

  beforeEach(() => {
    spyActivity.increments.length = 0;
    spyActivity.failWith = null;
  });

  it("keys the claim on dedupeKey when the publisher supplies one", async () => {
    await handler(turn("ai-turn-thread1-row9"), {});

    expect(spyActivity.increments).toHaveLength(1);
    // ⚠ The publisher's key, NOT the delivery id — this is what makes a retry converge.
    expect(spyActivity.increments[0].eventId).toBe("ai-turn-thread1-row9");
  });

  it("sends the SAME key for a re-publish of the same turn, so the claim collides", async () => {
    // Two publishes, two different EventBridge ids, one turn. Before the fix these carried two
    // different claim keys and the counter was bumped twice.
    await handler(turn("ai-turn-thread1-row9"), {});
    await handler(turn("ai-turn-thread1-row9"), {});

    const keys = spyActivity.increments.map((i) => i.eventId);
    expect(keys).toEqual(["ai-turn-thread1-row9", "ai-turn-thread1-row9"]);
    /**
     * ⚠ THE HANDLER DOES NOT SWALLOW THE SECOND CALL, and it must not: the claim is enforced at the
     * STORE, by a conditional Put on `userId = "dedup#<eventId>"` in the same partition as the counter.
     * What this test pins is that both attempts present the same key — which is the only thing that lets
     * that condition refuse the second one. Deduping here instead would put the guarantee in a Lambda's
     * memory, where a cold start loses it.
     */
  });

  /**
   * ⚠ EVERY EXISTING PUBLISHER IS UNCHANGED. None of them sets a `dedupeKey`, so they must keep using
   * EventBridge's delivery id — the redelivery protection that was added after `tasksCompleted` was
   * incremented twice for one completed task.
   */
  it("falls back to the delivery id when there is no dedupeKey", async () => {
    await handler(eventBridgeEvent("task.created", { teamId: "t1", userId: "u1" }), {});

    expect(spyActivity.increments[0].eventId).toBe("5f1d2a8e-0000-0000-0000-000000000000");
  });

  it("ignores a non-string dedupeKey rather than keying on nonsense", async () => {
    // A malformed key must degrade to the delivery id, not to `undefined` — which would disable
    // dedup entirely for that event.
    await handler(
      eventBridgeEvent("ai.response-generated", {
        teamId: "t1",
        userId: "u1",
        aiTurns: 1,
        dedupeKey: { not: "a string" },
      }),
      {}
    );

    expect(spyActivity.increments[0].eventId).toBe("5f1d2a8e-0000-0000-0000-000000000000");
  });
});
