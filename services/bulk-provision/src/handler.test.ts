// ── THE WORKER'S GUARDS ──────────────────────────────────────────────────────────────────
//
// The body is not written yet, so what these tests pin is the thing most likely
// to be got wrong while it is: for an ASYNC invocation, returning normally marks the event DELIVERED
// and it is gone. A stub that logged and returned would silently consume a facilitator's whole
// upload — eighteen people never invited, no error anywhere, nothing in a DLQ to notice, and the
// facilitator already told their file was accepted.
//
// So "it must THROW while unimplemented" is the assertion, and it is a real one.
//
// ⚠ SQS WAS DROPPED: EventBridge retries a Lambda target for up to 24h
// and DLQs, so Lambda's async invocation IS the durable queue. That deleted the partial-batch-failure
// machinery these tests used to cover — with one event per invocation a poison message cannot affect
// its neighbours by construction, which is better than covering it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Mocked so these tests cover the handler's CONTRACT, not the orchestration (see apply.test.ts). */
const applyPlan = vi.fn();
vi.mock("./apply", () => ({ applyPlan: (...a: unknown[]) => applyPlan(...a) }));

/**
 * ⚠ MOCKED SO THE LIFECYCLE IS OBSERVABLE, and it needs to be. `reportProgress` swallows every failure
 * by design (a failed status write must never re-run a batch that already sent invitations) — which
 * means without this mock these tests would pass whether the handler reported anything at all. That is
 * exactly how the missing report email survived: a function that cannot fail is a function whose
 * absence nothing notices.
 */
const reportProgress = vi.fn();
vi.mock("./progress", async () => {
  const actual = await vi.importActual<typeof import("./progress")>("./progress");
  return {
    ...actual,
    reportProgress: (...a: unknown[]) => reportProgress(...a),
  };
});

const { handler, parseMessage } = await import("./handler");

/** The progress reports the handler made, in order. */
const statuses = () => reportProgress.mock.calls.map((c) => (c[1] as { status: string }).status);

const report = {
  teamsCreated: 1, teamsMatched: 0, invited: 1, skipped: 0, failed: 0,
  teams: [{ teamName: "Aurora", disposition: "created" as const, teamId: "t1", members: [] }],
};

const validMessage = {
  batchId: "01KZBATCH",
  workshopId: "01KZWORKSHOP",
  plan: {
    teams: [{ teamKey: "aurora", teamName: "Aurora", memberCount: 1 }],
    members: [
      { line: 2, teamName: "Aurora", teamKey: "aurora", email: "a@example.com", platformRole: "PARTICIPANT" },
    ],
  },
  requestedBy: { id: "u-fac", email: "fac@example.com", role: "FACILITATOR" },
};

/** The EventBridge envelope the rule delivers. */
const event = (detail: unknown, id = "e1") => ({
  id,
  "detail-type": "bulk-provision.requested",
  detail,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  applyPlan.mockReset();
  applyPlan.mockResolvedValue(report);
  reportProgress.mockReset();
  reportProgress.mockResolvedValue(true);
  process.env.APP_URL = "https://portal.example.com";
});

afterEach(() => {
  delete process.env.APP_URL;
});

describe("⚠ THROW, or the event is gone", () => {
  /**
   * THE FAILURE CONTRACT, and the whole reason this handler has no catch-and-return.
   *
   * For an async invocation, returning normally marks the event DELIVERED and unrecoverable. A
   * catch-and-log-and-return would look tidier and would silently consume a facilitator's entire
   * upload — eighteen people never invited, nothing in a DLQ, and they were already told the file was
   * accepted.
   *
   * These tests previously asserted NOT_IMPLEMENTED, as a tripwire while the body was unwritten. It
   * fired when the body landed, which is what it was for; this is the rewrite.
   */
  it("rethrows when the run cannot start, rather than resolving", async () => {
    applyPlan.mockRejectedValue(new Error("Could not read this experience's teams"));
    await expect(handler(event(validMessage))).rejects.toThrow(/could not read/i);
  });

  it("resolves when the batch applied", async () => {
    await expect(handler(event(validMessage))).resolves.toBeUndefined();
    expect(applyPlan).toHaveBeenCalledOnce();
  });

  /**
   * ⚠ A PARTLY-FAILED BATCH MUST *NOT* THROW. Throwing would make EventBridge retry a batch that
   * mostly succeeded, re-attempting invitations for people it already invited. Per-address failure is
   * DATA, not an exception.
   */
  it("does NOT throw when the report contains failures", async () => {
    applyPlan.mockResolvedValue({ ...report, invited: 0, failed: 3 });
    await expect(handler(event(validMessage))).resolves.toBeUndefined();
  });

  /**
   * ⚠ REFUSES BEFORE CREATING ANYTHING when APP_URL is missing or local: every invite link would be
   * unopenable, the invitations are REAL, and each token is single-use, so recovery means revoking and
   * re-inviting everybody. The guard lives in applyPlan; this pins that the handler surfaces it.
   */
  it("rethrows the APP_URL guard", async () => {
    applyPlan.mockRejectedValue(new Error("APP_URL is unset or local (empty)"));
    await expect(handler(event(validMessage))).rejects.toThrow(/APP_URL/);
  });
});

describe("what it hands the orchestration", () => {
  it("passes the workshop, plan, identity and APP_URL", async () => {
    await handler(event(validMessage));

    const [workshopId, plan, identity, appUrl] = applyPlan.mock.calls[0];
    expect(workshopId).toBe("01KZWORKSHOP");
    expect(plan.members).toHaveLength(1);
    // ⚠ The IDENTITY the worker will assert — no token anywhere near it.
    expect(identity).toEqual({ id: "u-fac", email: "fac@example.com", role: "FACILITATOR" });
    expect(appUrl).toBe("https://portal.example.com");
  });
});

describe("parsing and bounds", () => {
  it("reads the payload from the EventBridge `detail` envelope", async () => {
    await handler(event(validMessage));
    expect(applyPlan).toHaveBeenCalledOnce();
  });

  it("also accepts a BARE payload, so a hand-replayed event works", async () => {
    // Replaying from the DLQ by hand is a real operator action; requiring the envelope would make it
    // fail for a reason that has nothing to do with the job.
    await handler(validMessage as never);
    expect(applyPlan).toHaveBeenCalledOnce();
  });

  /**
   * ⚠ MALFORMED IS MARKED `PERMANENT` so an operator reading the DLQ can tell whether replaying it
   * could ever work. With the rule's retry policy pinned at 2 it costs three invocations either way.
   */
  it.each([
    ["nothing at all", undefined],
    ["no batchId", { ...validMessage, batchId: "" }],
    ["no workshopId", { ...validMessage, workshopId: "" }],
    ["no plan", { ...validMessage, plan: undefined }],
    ["teams not an array", { ...validMessage, plan: { teams: "x", members: [] } }],
    ["an empty plan", { ...validMessage, plan: { teams: [], members: [] } }],
  ])("rejects %s as PERMANENT", (_label, detail) => {
    expect(() => parseMessage(detail)).toThrow(/PERMANENT/);
  });

  /**
   * ⚠ THE CEILINGS ARE CHECKED A THIRD TIME HERE — the BFF, the Team route, and now the worker. Not
   * redundant: this Lambda is bundled alone and is reachable by a DLQ REPLAY that passed through
   * neither. A bound enforced only upstream is not a bound, and the thing downstream of it creates
   * Cognito accounts.
   */
  it("rejects a plan over the row ceiling", () => {
    const big = {
      ...validMessage,
      plan: { teams: validMessage.plan.teams, members: Array(81).fill(validMessage.plan.members[0]) },
    };
    expect(() => parseMessage(big)).toThrow(/PERMANENT.*80/);
  });

  it("rejects a plan over the team ceiling", () => {
    const big = {
      ...validMessage,
      plan: { teams: Array(21).fill(validMessage.plan.teams[0]), members: validMessage.plan.members },
    };
    expect(() => parseMessage(big)).toThrow(/PERMANENT/);
  });

  /**
   * ⚠ NO IDENTITY MEANS NO WORK. The worker acts with the facilitator's authority via x-identity-*
   * headers; without one there is nothing to assert, and it must NOT fall back to anything wider.
   */
  it.each([
    ["no requestedBy at all", { ...validMessage, requestedBy: undefined }],
    ["no id", { ...validMessage, requestedBy: { email: "e@example.com", role: "FACILITATOR" } }],
    ["no role", { ...validMessage, requestedBy: { id: "u", email: "e@example.com" } }],
  ])("rejects %s", (_label, detail) => {
    expect(() => parseMessage(detail)).toThrow(/PERMANENT.*requestedBy/);
  });

  it("accepts a plan exactly at both ceilings", () => {
    const atCap = {
      ...validMessage,
      plan: {
        teams: Array(20).fill(validMessage.plan.teams[0]),
        members: Array(80).fill(validMessage.plan.members[0]),
      },
    };
    expect(() => parseMessage(atCap)).not.toThrow();
  });
});

/**
 * ⚠ THE "POISON MESSAGE" SECTION WAS DELETED WITH SQS, and that is the point rather than a loss of
 * coverage. With one event per invocation, a broken job cannot drag its neighbours through repeated
 * side effects — the property holds by construction instead of by careful per-message reporting, so
 * there is nothing left to assert.
 */

describe("⚠ no address reaches the logs", () => {
  /**
   * Addresses are the PII on this path, and every other service in the platform logs at most an email
   * DOMAIN. A worker that dumped the plan on failure would put eighteen addresses in CloudWatch on
   * every retry.
   */
  it("logs the failure without any email address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    applyPlan.mockRejectedValue(new Error("boom"));
    await handler(event(validMessage)).catch(() => {});

    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("a@example.com");
    expect(logged).not.toContain("fac@example.com");
    // The batch id IS logged — it is the correlation handle and carries no personal data.
    expect(logged).toContain("01KZBATCH");
  });
});

// ── THE AUDIT ROW'S LIFECYCLE ────────────────────────────────────────────────────────────
//
// ⚠ WHY THIS SECTION EXISTS. The first real batch left the operator with the word "Accepted" and
// nothing else, forever: every team was refused by a broken east-west hop, the requester's email was
// empty so no report could be sent, and the only trace was one line in a Lambda log group. The row
// this handler advances is the fix — so the transitions are a contract, not an implementation detail.

describe("⚠ the batch says what is happening to it", () => {
  /**
   * ANNOUNCED BEFORE THE WORK, NOT AFTER. A batch that dies mid-run — OOM, the 300s ceiling, a
   * poisoned row — would otherwise leave the row on `queued`, which is indistinguishable from an
   * event that never arrived. Those two have opposite fixes (replay the event vs. investigate the
   * worker), so the row must record that a worker DID pick it up even if that worker then vanished.
   */
  it("reports processing BEFORE applying the plan", async () => {
    let statusWhenApplied: string | undefined;
    applyPlan.mockImplementation(async () => {
      statusWhenApplied = statuses().at(-1);
      return report;
    });

    await handler(event(validMessage));

    expect(statusWhenApplied).toBe("processing");
  });

  it("stamps startedAt when it picks the batch up", async () => {
    await handler(event(validMessage));

    const first = reportProgress.mock.calls[0][1] as { status: string; startedAt?: string };
    expect(first.status).toBe("processing");
    expect(first.startedAt).toBeTruthy();
  });

  it("reports completed with the counts when nothing failed", async () => {
    await handler(event(validMessage));

    expect(statuses()).toEqual(["processing", "completed"]);
    const terminal = reportProgress.mock.calls.at(-1)![1] as {
      counts: Record<string, number>;
      completedAt: string;
    };
    expect(terminal.counts).toEqual({
      teamsCreated: 1,
      teamsMatched: 0,
      invited: 1,
      skipped: 0,
      failed: 0,
    });
    expect(terminal.completedAt).toBeTruthy();
  });

  /**
   * ⚠ `completed_with_errors` IS A SEPARATE STATE FROM `completed` because they demand different
   * actions: one is finished, the other needs a human to look at named addresses. Collapsing them
   * into "done" would bury exactly the information the operator needs.
   */
  it("reports completed_with_errors, and names the failures", async () => {
    applyPlan.mockResolvedValue({
      teamsCreated: 1,
      teamsMatched: 0,
      invited: 1,
      skipped: 0,
      failed: 2,
      teams: [
        {
          teamName: "Jarvis",
          disposition: "created",
          teamId: "t1",
          members: [
            { email: "ok@example.com", status: "invited" },
            { email: "bad@example.com", status: "failed", reason: "the account could not be created" },
          ],
        },
        { teamName: "Wakanda", disposition: "failed", members: [], error: "ambiguous name" },
      ],
    });

    await handler(event(validMessage));

    expect(statuses().at(-1)).toBe("completed_with_errors");
    const failures = (reportProgress.mock.calls.at(-1)![1] as {
      failures: Array<{ teamName: string; email?: string; reason: string }>;
    }).failures;

    // The team that was never created — nobody on it was invited, so it is the worst case.
    expect(failures).toContainEqual({ teamName: "Wakanda", reason: "ambiguous name" });
    expect(failures).toContainEqual({
      teamName: "Jarvis",
      email: "bad@example.com",
      reason: "the account could not be created",
    });
  });

  /**
   * ⚠ `skipped` MUST NOT PUSH A BATCH INTO `completed_with_errors`. Those people already held a live
   * invitation and were deliberately left alone; re-inviting them would have invalidated the link
   * already in their inbox. Reporting that as a problem would invite an operator to "fix" it by
   * re-uploading, which is the one action that could actually break it.
   */
  it("treats skipped as a success, not an error", async () => {
    applyPlan.mockResolvedValue({ ...report, invited: 0, skipped: 3, failed: 0 });

    await handler(event(validMessage));

    expect(statuses().at(-1)).toBe("completed");
  });

  /**
   * ⚠ `reportSent` MUST BE THE TRUTH, NOT AN INTENTION. A terminal row claiming the report was sent
   * when it was not is worse than no claim at all: it is the flag an operator would use to decide
   * nobody needs telling. This is the exact case that occurred — an empty requester email.
   */
  it("records that no report was sent when there is no requester email", async () => {
    await handler(event({ ...validMessage, requestedBy: { ...validMessage.requestedBy, email: "" } }));

    expect((reportProgress.mock.calls.at(-1)![1] as { reportSent: boolean }).reportSent).toBe(false);
  });
});

describe("⚠ a batch that could not run says so, and STILL throws", () => {
  /**
   * BOTH, IN THAT ORDER. Recording matters because a run that could not START would otherwise leave
   * the row on `processing` and the operator waiting on a job that is already dead.
   *
   * Rethrowing matters more: a throw is the ENTIRE failure contract for an async invocation. Now that
   * the failure is written down it would look tidier to swallow it — and that would mark the event
   * delivered and silently consume a facilitator's whole upload.
   */
  it("reports failed with the reason, then rethrows", async () => {
    applyPlan.mockRejectedValue(new Error("APP_URL is not configured"));

    await expect(handler(event(validMessage))).rejects.toThrow(/APP_URL/);

    expect(statuses()).toEqual(["processing", "failed"]);
    const terminal = reportProgress.mock.calls.at(-1)![1] as { error: string; completedAt: string };
    expect(terminal.error).toMatch(/APP_URL/);
    expect(terminal.completedAt).toBeTruthy();
  });

  /**
   * ⚠ A FAILURE TO RECORD MUST NOT BECOME A DIFFERENT FAILURE. If the status write itself fails, the
   * ORIGINAL error is what has to reach EventBridge — swallowing it would lose the retry, and
   * replacing it would send an operator chasing the wrong fault.
   */
  it("rethrows the original error even when the status write also fails", async () => {
    applyPlan.mockRejectedValue(new Error("the team list was unreadable"));
    reportProgress.mockRejectedValue(new Error("dynamo is down"));

    await expect(handler(event(validMessage))).rejects.toThrow(/team list was unreadable/);
  });

  /**
   * A MALFORMED EVENT HAS NO ROW TO UPDATE — there is no batchId to trust. It must still throw, and
   * must not invent a batch to mark failed.
   */
  it("does not try to record anything for an unparseable event", async () => {
    await expect(handler(event({ batchId: "x" }))).rejects.toThrow(/PERMANENT/);
    expect(reportProgress).not.toHaveBeenCalled();
  });
});
