// ── ⚠ THE TWO DEFECTS THAT MADE ONE ADDRESS UNREPAIRABLE ─────────────────────────────────
//
// The 18th of 18 addresses in a real upload failed with "the account could not be
// created (No live invitation for that address)". Its invitation row existed, was PENDING, and was
// perfectly valid. Two separate defects combined:
//
//   1. `POST /v1/user-access/provision` resolves the invitee's role from their invitation via
//      `listByEmail`, which queries the `email-index` **GSI**. A GSI is eventually consistent and does
//      not support `ConsistentRead` at all. This code writes the row and calls provision milliseconds
//      later — row written 22:13:03.670, batch finished 22:13:03.720. Seventeen won that race; one did
//      not.
//
//   2. The failure left the row PENDING. That made the address "already invited", so the skip rule
//      removed it from every future upload — the one mechanism meant to repair it — AND it held a seat,
//      so the team read 5 members + 1 orphan against a cap of 6 and even a manual re-invite was refused
//      as full. Repairing it took five calls by hand.
//
// The email report meanwhile told the operator that "uploading the same file again retries ONLY the
// failures", which for this address was false.
//
// These tests pin the retry, the compensating withdrawal, and the reason text that tells the operator
// which of the two happened — because that changes what they have to do.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLambdaClient } from "@praimana/service-shared";
import { applyPlan } from "./apply";

const identity = { id: "u-fac", email: "fac@example.com", role: "FACILITATOR" };
const APP_URL = "https://ai.example.com";

const plan = {
  teams: [{ teamKey: "stark stack", teamName: "Stark Stack", memberCount: 1 }],
  members: [
    {
      line: 2,
      teamName: "Stark Stack",
      teamKey: "stark stack",
      email: "happy@example.com",
      platformRole: "PARTICIPANT",
      teamRole: "COACH",
    },
  ],
};

interface Call {
  fn: string;
  method: string;
  path: string;
  body: unknown;
}

/** A proxy-shaped reply, which is what `callService` unwraps. */
const reply = (statusCode: number, body: unknown) => ({
  Payload: Buffer.from(JSON.stringify({ statusCode, body: JSON.stringify(body) })),
});

/**
 * Routes each invocation on (function, method, path) so a test can script one step's behaviour and
 * leave the rest working. Records every call, which is how the ordering assertions are made.
 */
function harness(script: {
  provision: (attempt: number) => { status: number; body: unknown };
  withdrawFails?: boolean;
}) {
  const calls: Call[] = [];
  let provisionAttempts = 0;

  const send = vi.fn(async (cmd: { input: { FunctionName: string; Payload: Uint8Array } }) => {
    const event = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
    const method = event.requestContext.http.method as string;
    const path = event.rawPath as string;
    const fn = cmd.input.FunctionName;
    calls.push({ fn, method, path, body: event.body ? JSON.parse(event.body) : undefined });

    // The workshop's existing teams — none, so the plan's team is created.
    if (method === "GET" && /\/teams$/.test(path)) return reply(200, { teams: [] });
    if (method === "POST" && /\/teams$/.test(path)) {
      return reply(201, { team: { id: "t-stark", name: "Stark Stack" } });
    }
    // Nobody already invited on this team.
    if (method === "GET" && /\/invitations$/.test(path)) return reply(200, { invitations: [] });
    // The row, with the raw token that is returned exactly once.
    if (method === "POST" && /\/invitations$/.test(path)) {
      return reply(201, {
        invitations: [{ email: "happy@example.com", token: "PB-tok", status: "PENDING" }],
      });
    }
    if (method === "DELETE" && /\/invitations\//.test(path)) {
      if (script.withdrawFails) return reply(500, { error: "dynamo is unavailable" });
      return reply(200, { revoked: true });
    }
    if (method === "POST" && path === "/v1/user-access/provision") {
      const r = script.provision(provisionAttempts++);
      return reply(r.status, r.body);
    }
    if (method === "POST" && path === "/v1/notify/team-invite") return reply(200, { sent: 1 });

    return reply(404, { error: `unrouted ${method} ${path}` });
  });

  setLambdaClient({ send } as never);
  return {
    calls,
    provisionCount: () => provisionAttempts,
    of: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path)),
  };
}

const STALE = { status: 409, body: { error: "No live invitation for that address — invite them first" } };
const OK = { status: 200, body: { temporaryPassword: "Temp-1234", alreadyExisted: false } };

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLambdaClient(undefined);
  vi.restoreAllMocks();
});

// ─── 1. THE STALE-INDEX RETRY ────────────────────────────────────────────────────────

describe("⚠ a stale invitation index is retried, not reported as a failure", () => {
  /**
   * THE EXACT PRODUCTION FAILURE. The row exists; the GSI has not caught up. Before the retry this
   * address was reported "the account could not be created" and left unrepairable.
   */
  it("recovers when the first provision attempt loses the race", async () => {
    const h = harness({ provision: (n) => (n === 0 ? STALE : OK) });

    const report = await applyPlan("w1", plan, identity, APP_URL);

    expect(h.provisionCount()).toBe(2);
    expect(report.invited).toBe(1);
    expect(report.failed).toBe(0);
    // And the invitation must NOT have been withdrawn — it was needed and it worked.
    expect(h.of("DELETE", /invitations/)).toHaveLength(0);
  });

  it("recovers on the last allowed attempt", async () => {
    // Two backoffs are configured, so attempt 3 is the last that can succeed. The boundary must work
    // or the documented budget is a lie by one.
    const h = harness({ provision: (n) => (n < 2 ? STALE : OK) });

    const report = await applyPlan("w1", plan, identity, APP_URL);

    expect(h.provisionCount()).toBe(3);
    expect(report.invited).toBe(1);
  });

  it("gives up after the budget rather than retrying for ever", async () => {
    // An address that is genuinely not invited must not spin: this runs inside a 300s worker that also
    // has 79 other people to get through.
    const h = harness({ provision: () => STALE });

    const report = await applyPlan("w1", plan, identity, APP_URL);

    expect(h.provisionCount()).toBe(3);
    expect(report.failed).toBe(1);
  });

  /**
   * ⚠ NARROW ON PURPOSE. Provision CREATES ACCOUNTS. A blanket retry on a 5xx or a throttle is how you
   * mint duplicates, and only the stale-index 409 is known to be a lie.
   */
  it.each([
    ["a different 409", { status: 409, body: { error: "That address is already an active member" } }],
    ["a 400", { status: 400, body: { error: "That email is not valid" } }],
    ["a 500", { status: 500, body: { error: "Cognito is unavailable" } }],
    ["a 503", { status: 503, body: { error: "Could not verify the invitation" } }],
  ])("does NOT retry %s", async (_label, failure) => {
    const h = harness({ provision: () => failure });

    const report = await applyPlan("w1", plan, identity, APP_URL);

    expect(h.provisionCount()).toBe(1);
    expect(report.failed).toBe(1);
  });

  it("logs each retry, so worsening index lag is visible before it starts failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    harness({ provision: (n) => (n === 0 ? STALE : OK) });

    await applyPlan("w1", plan, identity, APP_URL);

    const logged = warn.mock.calls.find((c) => String(c[0]).includes("index was stale"));
    expect(logged).toBeDefined();
    // ⚠ THE DOMAIN ONLY. Addresses are the PII on this path and every other service logs at most a
    // domain; a retry loop would otherwise put them in CloudWatch repeatedly.
    expect(JSON.stringify(logged![1])).not.toContain("happy@");  // nosemgrep: no-stringify-keys
    expect(JSON.stringify(logged![1])).toContain("@example.com");  // nosemgrep: no-stringify-keys
  });
});

// ─── 2. THE COMPENSATING WITHDRAWAL ──────────────────────────────────────────────────

describe("⚠ an invitation that cannot be completed is withdrawn, not left as an orphan", () => {
  /**
   * THE DEFECT THAT MADE THE FAILURE PERMANENT. The row grants nothing — no email was sent (that happens
   * after provisioning) and the raw token is already gone, stored only as a hash. But while it exists
   * the address looks "already invited", so the skip rule hides it from every future upload, and it
   * holds a seat that blocked even a manual re-invite.
   */
  it("withdraws the row it just created when provisioning fails", async () => {
    const h = harness({ provision: () => STALE });

    const report = await applyPlan("w1", plan, identity, APP_URL);

    const deletes = h.of("DELETE", /invitations/);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toContain(encodeURIComponent("happy@example.com"));
    expect(deletes[0].path).toContain("t-stark");
    expect(report.failed).toBe(1);
  });

  /**
   * ⚠ THE REASON MUST SAY WHICH HAPPENED, because the remedy differs: a withdrawn row is fixed by
   * re-uploading, an orphan needs a human. "Failed" alone is what sent somebody to CloudWatch.
   */
  it("tells the operator a re-upload will now retry this address", async () => {
    harness({ provision: () => STALE });

    const report = await applyPlan("w1", plan, identity, APP_URL);
    const member = report.teams[0].members[0];

    expect(member.status).toBe("failed");
    expect("reason" in member && member.reason).toMatch(/invitation was withdrawn/i);
    expect("reason" in member && member.reason).toMatch(/uploading the same file again/i);
  });

  it("says a human is needed when the withdrawal ALSO fails", async () => {
    // Now the orphan really does exist, and saying "just re-upload" would be false.
    harness({ provision: () => STALE, withdrawFails: true });

    const report = await applyPlan("w1", plan, identity, APP_URL);
    const member = report.teams[0].members[0];

    expect("reason" in member && member.reason).toMatch(/could NOT be withdrawn/);
    expect("reason" in member && member.reason).toMatch(/re-invite this address/);
  });

  it("does not withdraw anything when provisioning succeeds", async () => {
    // The obvious catastrophe: revoking a live invitation for somebody who was successfully invited.
    const h = harness({ provision: () => OK });

    const report = await applyPlan("w1", plan, identity, APP_URL);

    expect(h.of("DELETE", /invitations/)).toHaveLength(0);
    expect(report.invited).toBe(1);
  });

  /**
   * ⚠ AND IT MUST NOT WITHDRAW A PRE-EXISTING INVITATION — that might be somebody's live link. Only
   * rows created in THIS run are eligible, which is why the caller draws from `fresh` and never `seen`.
   */
  it("skips an already-invited address entirely, withdrawing nothing", async () => {
    const calls: Call[] = [];
    const send = vi.fn(async (cmd: { input: { FunctionName: string; Payload: Uint8Array } }) => {
      const event = JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8"));
      const method = event.requestContext.http.method as string;
      const path = event.rawPath as string;
      calls.push({ fn: cmd.input.FunctionName, method, path, body: undefined });

      if (method === "GET" && /\/teams$/.test(path)) return reply(200, { teams: [] });
      if (method === "POST" && /\/teams$/.test(path)) {
        return reply(201, { team: { id: "t-stark", name: "Stark Stack" } });
      }
      // ALREADY holds a live invitation.
      if (method === "GET" && /\/invitations$/.test(path)) {
        return reply(200, { invitations: [{ email: "happy@example.com", status: "PENDING" }] });
      }
      return reply(404, { error: `unrouted ${method} ${path}` });
    });
    setLambdaClient({ send } as never);

    const report = await applyPlan("w1", plan, identity, APP_URL);

    expect(report.skipped).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    // Nor was a fresh row minted over theirs, which would have invalidated the link in their inbox.
    expect(calls.filter((c) => c.method === "POST" && /invitations$/.test(c.path))).toHaveLength(0);
  });
});
