// ── HANDING OFF, AND THE ONE THING THAT MUST NOT CROSS ───────────────────────────────────
//
// ⚠ THIS FILE HAS NOW BEEN REWRITTEN TWICE, AND BOTH REWRITES WERE THE DESIGN WORKING.
//
// v1 pinned `isBulkDispatchConfigured() === false` and a throwing dispatcher, as a TRIPWIRE while the
// seam had no implementation, so the route answered an honest 503 instead of promising an email
// nothing would send. It fired when the synchronous implementation landed.
// v2 pinned that synchronous implementation.
// v3 (this) pins the ENQUEUE, because the requirement is that nobody waits for the work.
//
// The constant across all three is the assertion below about credentials.

import { describe, it, expect, vi, beforeEach } from "vitest";

const backendFetch = vi.fn();
vi.mock("@/lib/backend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend")>("@/lib/backend");
  return { backendFetch: (...a: unknown[]) => backendFetch(...a), BackendError: actual.BackendError };
});

const { dispatchBulkProvision, isBulkDispatchConfigured } = await import("./dispatch");

const plan = {
  members: [
    {
      line: 2,
      teamName: "Team Aurora",
      teamKey: "team aurora",
      email: "a@example.com",
      platformRole: "PARTICIPANT" as const,
    },
  ],
  teams: [{ teamKey: "team aurora", teamName: "Team Aurora", memberCount: 1 }],
};

const request = {
  workshopId: "01KZ156Z8E95B9GC4SGBW6DA4D",
  plan,
  requestedBy: { id: "u1", email: "fac@example.com", name: "Fac", role: "FACILITATOR" },
  token: "the-callers-bearer",
};

beforeEach(() => {
  backendFetch.mockReset();
  backendFetch.mockResolvedValue({ batchId: "01KZBATCH", queued: true });
});

describe("the plan is handed to the Team service", () => {
  it("returns the batch id the service assigned", async () => {
    expect(await dispatchBulkProvision(request)).toEqual({ batchId: "01KZBATCH" });
  });

  it("POSTs the plan to the workshop's enqueue route", async () => {
    await dispatchBulkProvision(request);

    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe(`/v1/workshops/${request.workshopId}/bulk-provision`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).plan.members).toHaveLength(1);
  });

  /**
   * ⚠ THE BEARER AUTHENTICATES THIS HOP AND STOPS HERE. The gateway only accepts a re-presented caller
   * token, so it must be sent, but it must NOT end up in the request BODY, because the body becomes
   * the event that sits in an event bus and its DLQ. This was refused exactly for the temporary
   * password; a bearer is no better.
   */
  it("sends the bearer as the token, and never inside the body", async () => {
    await dispatchBulkProvision(request);

    const [, init] = backendFetch.mock.calls[0];
    expect(init.token).toBe("the-callers-bearer");
    expect(init.body).not.toContain("the-callers-bearer");
    expect(JSON.parse(init.body)).toEqual({ plan });
  });

  /**
   * ⚠ AND THE IDENTITY IS NOT SENT EITHER. The Team service derives it from the VERIFIED claims on
   * this call; accepting it from the body would let a caller name someone else as the requester, and
   * the worker acts with whatever identity the event carries.
   */
  it("does not send requestedBy, the service derives it from the token", async () => {
    await dispatchBulkProvision(request);
    expect(JSON.parse(backendFetch.mock.calls[0][1].body)).not.toHaveProperty("requestedBy");
  });

  it("bounds the hand-off, since it is one hop and not the work", async () => {
    await dispatchBulkProvision(request);
    expect(backendFetch.mock.calls[0][1].timeoutMs).toBeGreaterThan(0);
  });
});

describe("⚠ failures are surfaced, not smoothed over", () => {
  /**
   * A 2xx with no id means we cannot tell the operator which run is theirs, nor correlate logs. That
   * is a broken contract rather than a cosmetic gap, so it fails instead of returning "".
   */
  it("throws when the service accepts but returns no batch id", async () => {
    backendFetch.mockResolvedValue({ queued: true });
    await expect(dispatchBulkProvision(request)).rejects.toThrow(/no batch id/i);
  });

  it("propagates the service's error so the route can classify it", async () => {
    // A 404 in particular means "not deployed here", which the route reports differently from a fault.
    const { BackendError } = await import("@/lib/backend");
    backendFetch.mockRejectedValue(new BackendError(404, "Not Found"));

    const err = await dispatchBulkProvision(request).catch((e) => e);
    expect(err.status).toBe(404);
  });
});

describe("the availability question", () => {
  /**
   * ⚠ IT CANNOT BE ANSWERED FROM HERE, and the previous version pretending it could was the mistake.
   * Whether a worker exists depends on `EnableBulkProvision` in the deployed stack, which the BFF
   * cannot see. So the real answer comes from the attempt: an undeployed Team route answers 404 and the
   * route says "not enabled on this environment" rather than this function guessing.
   */
  it("reports available, leaving the truth to the enqueue attempt", () => {
    expect(isBulkDispatchConfigured()).toBe(true);
  });
});
