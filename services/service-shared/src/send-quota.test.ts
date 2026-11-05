/**
 * ── ⚠ WHAT THESE TESTS ARE FOR, AND WHAT THEY CANNOT ESTABLISH ──────────────────────────────
 *
 * SECURITY FINDING (Medium — "Unmetered branded-email relay… There is no per-user rate
 * limit or send quota anywhere in the service").
 *
 * These assert the CONTRACT: one command per attempt, the condition that makes the increment
 * atomic, refusal on ConditionalCheckFailedException, fail-open on anything else, and per-window
 * keying. They assert it against a fake DocClient, so what they establish is that this module asks
 * DynamoDB the right question.
 *
 * ⚠ THEY DO NOT ESTABLISH THAT THE COUNTER IS RACE-FREE. That property belongs to DynamoDB's
 * evaluation of ConditionExpression during UpdateItem, not to this code, and no fake can
 * demonstrate it — a fake that "proves" atomicity is only proving its own implementation. What is
 * testable, and is the thing a future edit could break, is that the condition is PRESENT and
 * references the counter: drop it and the limiter still passes every functional test while
 * enforcing nothing under concurrency, which is exactly the failure mode the portal's in-memory
 * limiter documents. So the condition is asserted literally.
 */

import { describe, it, expect, vi } from "vitest";
import { createSendQuota } from "./send-quota.js";
import type { DocClient } from "./dynamo.js";

/** A DocClient that records commands and can be told to throw a named error. */
function fakeClient(throwName?: string) {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    send: vi.fn(async (cmd: { input: Record<string, unknown> }) => {
      sent.push(cmd.input);
      if (throwName) {
        const err = new Error(throwName) as Error & { name: string };
        err.name = throwName;
        throw err;
      }
      return {};
    }),
  };
  return { client: client as unknown as DocClient, sent };
}

const config = (client: DocClient) => ({
  client,
  tableName: "quota",
  maxPerWindow: 3,
  scope: "notify-send",
});

describe("createSendQuota", () => {
  it("allows a send and spends exactly one unit", async () => {
    const { client, sent } = fakeClient();
    const quota = createSendQuota(config(client));

    const verdict = await quota.consume("user-1");

    expect(verdict.allowed).toBe(true);
    expect(verdict.limit).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0].UpdateExpression).toBe("ADD #sends :one SET #expiresAt = :ttl");
    expect((sent[0].ExpressionAttributeValues as Record<string, unknown>)[":one"]).toBe(1);
  });

  /**
   * ⚠ THE ASSERTION THAT MATTERS MOST IN THIS FILE. Without this condition the ADD still
   * increments and every test above still passes, but two concurrent callers both succeed and the
   * ceiling becomes "however many requests arrive at once" — the precise defect the shared store
   * exists to avoid. Asserted on the string because that is what reaches DynamoDB.
   */
  it("makes the increment CONDITIONAL on the counter, which is what makes it atomic", async () => {
    const { client, sent } = fakeClient();
    await createSendQuota(config(client)).consume("user-1");

    expect(sent[0].ConditionExpression).toBe(
      "attribute_not_exists(#sends) OR #sends < :max"
    );
    expect((sent[0].ExpressionAttributeValues as Record<string, unknown>)[":max"]).toBe(3);
  });

  it("refuses when DynamoDB reports the condition failed", async () => {
    const { client } = fakeClient("ConditionalCheckFailedException");
    const verdict = await createSendQuota(config(client)).consume("user-1");

    expect(verdict.allowed).toBe(false);
    expect(verdict.limit).toBe(3);
    // Enough to populate Retry-After with something a client can act on.
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  /**
   * ⚠ FAIL OPEN, AND THE TEST SAYS WHY RATHER THAN JUST THAT. A quota store outage must not stop
   * invitation or password-reset mail — that turns a metering fault into an access outage — and the
   * role check in front of this is what decides who may send at all. The log line is asserted
   * because a silent fail-open is indistinguishable from a working limiter.
   */
  it("fails OPEN on any other error, and logs it", async () => {
    const { client } = fakeClient("ProvisionedThroughputExceededException");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const verdict = await createSendQuota(config(client)).consume("user-1");
      expect(verdict.allowed).toBe(true);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("ALLOWING the send unmetered"),
        expect.objectContaining({ scope: "notify-send" })
      );
    } finally {
      error.mockRestore();
    }
  });

  it("keys per subject, per scope and per window", async () => {
    const { client, sent } = fakeClient();
    const quota = createSendQuota(config(client));

    await quota.consume("user-1");
    await quota.consume("user-2");

    const keys = sent.map((i) => (i.Key as { id: string }).id);
    expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(key.startsWith("notify-send#")).toBe(true);

    // A different scope on the same subject must not share a counter, or notify's budget and
    // identity's budget would consume one another in the shared table.
    const other = createSendQuota({ ...config(client), scope: "feedback-report" });
    await other.consume("user-1");
    expect((sent[2].Key as { id: string }).id.startsWith("feedback-report#")).toBe(true);
  });

  /**
   * The window is part of the KEY, so expiry needs no boundary job and no read-modify-write. This
   * pins that: two calls an hour apart under a one-hour window must land on different items.
   */
  it("starts a new counter in a new window", async () => {
    const { client, sent } = fakeClient();
    const quota = createSendQuota({ ...config(client), windowSeconds: 3600 });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-07T10:30:00Z"));
      await quota.consume("user-1");
      vi.setSystemTime(new Date("2026-09-07T11:30:00Z"));
      await quota.consume("user-1");
    } finally {
      vi.useRealTimers();
    }

    expect((sent[0].Key as { id: string }).id).not.toBe((sent[1].Key as { id: string }).id);
  });

  it("sets a TTL past the window end, so a live counter cannot be deleted early", async () => {
    const { client, sent } = fakeClient();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-07T10:30:00Z"));
      await createSendQuota({ ...config(client), windowSeconds: 3600 }).consume("user-1");
    } finally {
      vi.useRealTimers();
    }

    const ttl = (sent[0].ExpressionAttributeValues as Record<string, number>)[":ttl"];
    const windowEnd = Math.floor(new Date("2026-09-07T11:00:00Z").getTime() / 1000);
    expect(ttl).toBeGreaterThan(windowEnd);
  });
});
