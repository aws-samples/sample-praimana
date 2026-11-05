// ── REPORTING PROGRESS INTO THE AUDIT ROW ────────────────────────────────────────────────
//
// The row is what the facilitator can actually see, so the properties that matter are: does the
// report reach the right batch, does it name the failures in an actionable way, and — most
// importantly — can a problem writing it ever damage work that already succeeded.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setLambdaClient } from "@praimana/service-shared";
import { reportProgress, failuresFromReport } from "./progress";
import type { ApplyReport } from "./apply";

const target = {
  batchId: "01KZVWVPC5SAKCZ0A02QD5B5RF",
  workshopId: "01KZVC9WVW4MBZS362BE6EPR0E",
  requestedBy: {
    id: "a4683438-a081-70bd-8a95-5ad84797afc8",
    email: "fac@example.com",
    role: "FACILITATOR",
  },
};

function stubLambda(statusCode = 200, body: unknown = { ok: true }) {
  const send = vi.fn(async () => ({
    Payload: Buffer.from(JSON.stringify({ statusCode, body: JSON.stringify(body) })),
  }));
  setLambdaClient({ send } as never);
  return send;
}

function stubLambdaThrowing(err: Error) {
  const send = vi.fn(async () => {
    throw err;
  });
  setLambdaClient({ send } as never);
  return send;
}

const sentEvent = (send: ReturnType<typeof stubLambda>, call = 0) => {
  const input = (send.mock.calls[call] as unknown as [{ input: { Payload: Uint8Array } }])[0].input;
  return JSON.parse(Buffer.from(input.Payload).toString("utf8"));
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLambdaClient(undefined);
  vi.restoreAllMocks();
});

describe("the report reaches the right batch", () => {
  it("PATCHes the batch's own route on the Team service", async () => {
    const send = stubLambda();

    await reportProgress(target, { status: "processing", startedAt: "2026-08-12T21:08:11Z" });

    const event = sentEvent(send);
    expect(event.requestContext.http.method).toBe("PATCH");
    expect(event.rawPath).toBe(
      `/v1/workshops/${target.workshopId}/bulk-provision/batches/${target.batchId}`
    );
    expect(JSON.parse(event.body)).toEqual({
      status: "processing",
      startedAt: "2026-08-12T21:08:11Z",
    });
  });

  /**
   * ⚠ IT ACTS AS THE UPLOADING FACILITATOR, NOT AS ITSELF. The Team route gates this write on workshop
   * ownership — the same gate as the upload — so the worker has to assert the requester's identity.
   * There is deliberately no "internal" exemption for it to use instead.
   */
  it("asserts the requesting facilitator's identity", async () => {
    const send = stubLambda();

    await reportProgress(target, { status: "completed" });

    const claims = sentEvent(send).requestContext.authorizer.jwt.claims;
    expect(claims.sub).toBe(target.requestedBy.id);
    expect(claims["cognito:groups"]).toEqual(["FACILITATOR"]);
  });
});

describe("⚠ a failure to record must never damage work that succeeded", () => {
  /**
   * THE ORDERING OF HARMS, AND IT IS NOT CLOSE. By the time the terminal report is written the teams
   * exist and the invitations are sent. Throwing here would make EventBridge retry the whole job and
   * re-attempt real invitations for people who already have one — re-minting their tokens and
   * invalidating the links already in their inboxes. A row that is briefly wrong is a visibility
   * problem; a re-run is a correctness one.
   */
  it("returns false instead of throwing when the Team service refuses", async () => {
    stubLambda(404, { error: "No such batch." });

    await expect(reportProgress(target, { status: "completed" })).resolves.toBe(false);
  });

  it("returns false instead of throwing when the invocation itself fails", async () => {
    stubLambdaThrowing(
      Object.assign(new Error("not authorized to perform: lambda:InvokeFunction"), {
        name: "AccessDeniedException",
      })
    );

    await expect(reportProgress(target, { status: "completed" })).resolves.toBe(false);
  });

  /**
   * ⚠ THE LOUD LOG IS THE ENTIRE ERROR HANDLING, so it has to actually happen. Somebody is now looking
   * at a row that does not reflect reality — most likely one stuck on `processing` that the portal will
   * show as stalled — and this line is the only thing that lets a human find out why.
   */
  it("logs the batch id and the status it failed to write", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubLambdaThrowing(new Error("boom"));

    await reportProgress(target, { status: "completed_with_errors" });

    const logged = error.mock.calls.find((c) => String(c[0]).includes("batch audit row"));
    expect(logged).toBeDefined();
    expect(logged![1]).toMatchObject({
      batchId: target.batchId,
      status: "completed_with_errors",
    });
  });

  it("reports success when the write is accepted", async () => {
    stubLambda(200, { batchId: target.batchId, status: "completed" });
    await expect(reportProgress(target, { status: "completed" })).resolves.toBe(true);
  });
});

// ─── THE FAILURE LIST ────────────────────────────────────────────────────────────────

const base: ApplyReport = {
  teamsCreated: 1,
  teamsMatched: 0,
  invited: 1,
  skipped: 0,
  failed: 0,
  teams: [],
};

describe("⚠ the named failures are what the operator has to act on", () => {
  /**
   * A TEAM THAT WAS NEVER CREATED IS A DIFFERENT KIND OF FAILURE from one rejected address: nobody on
   * it was invited, and the remedy is a human decision about the name. Flattening the two into one
   * undifferentiated list would hide the worse one.
   */
  it("records a whole-team failure with no address", async () => {
    const failures = failuresFromReport({
      ...base,
      failed: 1,
      teams: [
        {
          teamName: "Wakanda",
          disposition: "failed",
          members: [],
          error: 'More than one existing team is called "Wakanda"',
        },
      ],
    });

    expect(failures).toEqual([
      { teamName: "Wakanda", reason: 'More than one existing team is called "Wakanda"' },
    ]);
    // No `email` key at all — an empty string would read as "an address failed".
    expect("email" in failures[0]).toBe(false);
  });

  it("records each failed address with its team and its reason", async () => {
    const failures = failuresFromReport({
      ...base,
      failed: 1,
      teams: [
        {
          teamName: "Jarvis",
          disposition: "created",
          teamId: "t1",
          members: [
            { email: "ok@example.com", status: "invited" },
            {
              email: "unsent@example.com",
              status: "failed",
              reason: "the account was created but the email did not send — re-invite this address",
            },
          ],
        },
      ],
    });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({
      teamName: "Jarvis",
      email: "unsent@example.com",
      // The reason travels WITH the address: correcting a rejected address and re-inviting an unsent
      // one are different actions, so "3 failed" would not be actionable.
      reason: "the account was created but the email did not send — re-invite this address",
    });
  });

  it("does not record the addresses that succeeded", async () => {
    const failures = failuresFromReport({
      ...base,
      teams: [
        {
          teamName: "Jarvis",
          disposition: "created",
          teamId: "t1",
          members: [
            { email: "ok@example.com", status: "invited" },
            { email: "skipped@example.com", status: "skipped" },
          ],
        },
      ],
    } as ApplyReport);

    expect(failures).toEqual([]);
  });

  /**
   * ⚠ BOUNDED, because a file may name 80 members and every one of them can fail. The Team route
   * truncates to its own ceiling and records that it did; this bound keeps 80 addresses out of a
   * Lambda payload and both services' logs on the way there.
   */
  it("caps the list rather than sending every failure", async () => {
    const failures = failuresFromReport({
      ...base,
      failed: 80,
      teams: [
        {
          teamName: "Big",
          disposition: "created",
          teamId: "t",
          members: Array.from({ length: 80 }, (_, i) => ({
            email: `p${i}@example.com`,
            status: "failed" as const,
            reason: "nope",
          })),
        },
      ],
    });

    expect(failures.length).toBeLessThan(80);
    expect(failures.length).toBe(40);
  });
});
