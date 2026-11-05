import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The BFF procedure behind the FIRST-SIGN-IN INVITATION FLIP.
 *
 * WHY THIS FILE EXISTS. Registration became admin-provisioned, which silently removed
 * the only thing that ever marked an invitation accepted, the old self-signup flow did
 * it as part of registering. Confirmed live: a FACILITATOR completed the whole journey
 * (Cognito CONFIRMED, group assigned, profile row written) and the invitation row still
 * read `status: PENDING`, `acceptedAt: null`.
 *
 * The fix has two halves, and this covers the BFF half. What it asserts is not "does the
 * backend accept invitations" (the team service's own suite does that, including
 * idempotency and the PLATFORM sentinel) but the things only this layer can get wrong:
 *
 *   1. It calls the RIGHT endpoint with the RIGHT method. A GET, or a path typo, is a
 *      mistake that type-checks and lints and would leave the defect exactly as
 *      reported, the flip simply never happening.
 *   2. It sends NO INPUT. The whole safety story of the endpoint is that it keys on the
 *      verified token's email claim, so it can only ever reach the caller's own rows.
 *      A procedure that accepted and forwarded an email would hand it a parameter to
 *      tamper with.
 *   3. It forwards the caller's bearer token, or the gateway 401s it.
 *
 * The component-level behaviour, that a failure here does NOT block the sign-in, is
 * asserted where it lives, in AuthFlow's catch. This portal suite runs in the `node`
 * environment with no DOM, so that component cannot be rendered here; see the note at
 * the end of this file.
 */

const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({
  backendFetch,
  // Imported by trpc.ts for its error-mapping middleware. The real class is not needed
  // here, but the export must exist or the module fails to load.
  BackendError: class BackendError extends Error {
    status = 500;
  },
}));

import { teamRouter } from "@/lib/trpc/routers/team";

/**
 * A caller with a SIGNED-IN context.
 *
 * `protectedProcedure` requires BOTH `session.user.id` and `accessToken`, and its auth
 * middleware runs before anything else, so a context that is merely close enough would
 * make every assertion below pass or fail for the wrong reason (UNAUTHORIZED rather than
 * the behaviour under test).
 */
function caller() {
  return teamRouter.createCaller({
    accessToken: "test-token",
    session: {
      user: { id: "sub-1", email: "u@example.com", role: "FACILITATOR" },
    },
  } as never);
}

beforeEach(() => {
  backendFetch.mockReset();
  backendFetch.mockResolvedValue({ accepted: 1, alreadyAccepted: 0, failed: 0 });
});

describe("team.acceptMyInvitations", () => {
  it("POSTs to the team service's own-invitations accept route", async () => {
    // The path and the method are the contract with the gateway: HttpApi routes are
    // per-method, so a GET here would 404 before the Lambda ran, and the invitation
    // would stay PENDING with nothing in the UI to explain why.
    await caller().acceptMyInvitations();

    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe("/v1/invitations/mine/accept");
    expect(init.method).toBe("POST");
  });

  it("sends NO body and NO query, the backend keys on the verified token", async () => {
    // This is the endpoint's entire authorization story: with no input there is nothing
    // to tamper with, so it can only ever reach the caller's own rows. A body carrying
    // an email would turn a self-service reconcile into a route that needs its own
    // per-target authorization.
    await caller().acceptMyInvitations();

    const [path, init] = backendFetch.mock.calls[0];
    expect(path).not.toContain("?");
    expect(init.body).toBeUndefined();
  });

  it("forwards the caller's bearer token", async () => {
    // Every non-public route sits behind the Cognito JWT authorizer; a tokenless call is
    // 401'd at the gateway before the service runs.
    await caller().acceptMyInvitations();

    expect(backendFetch.mock.calls[0][1].token).toBe("test-token");
  });

  it("returns the service's counts unchanged", async () => {
    // Passed straight through rather than reduced to a boolean: `failed` is how a
    // partial failure is visible at all, since the service answers 200 (it must never
    // fail a sign-in) and reports the problem in the body instead of the status.
    backendFetch.mockResolvedValue({ accepted: 0, alreadyAccepted: 2, failed: 1 });

    expect(await caller().acceptMyInvitations()).toEqual({
      accepted: 0,
      alreadyAccepted: 2,
      failed: 1,
    });
  });

  it("rejects for an anonymous caller, without touching the backend", async () => {
    const anonymous = teamRouter.createCaller({} as never);

    const err = await anonymous.acceptMyInvitations().then(
      () => null,
      (e: unknown) => e
    );

    expect((err as { code?: string })?.code).toBe("UNAUTHORIZED");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("propagates a backend failure to its CALLER, which is what absorbs it", async () => {
    // Deliberately NOT swallowed in the router. The decision "a failed accept must not
    // block the sign-in" belongs at the call site, where the sign-in actually is
    // (AuthFlow.markInvitationsAccepted), not in a data-access layer that would then hide
    // the failure from any future caller with a different tolerance for it.
    backendFetch.mockRejectedValue(new Error("service unavailable"));

    await expect(caller().acceptMyInvitations()).rejects.toThrow();
  });
});

/**
 * NOT COVERED HERE, stated rather than implied: that AuthFlow calls this on BOTH landing
 * paths (a fresh sign-in and a resumed Amplify session) and swallows its failure. Both
 * live in a React component, and this suite runs in the `node` environment with no DOM -
 * see the header comment on vitest.config.mts, which scopes it to pure logic
 * and leaves component integration to e2e. The code is arranged so there is ONE function
 * (`onSessionEstablished`) that both paths call, which is the same technique the profile
 * step uses for the same reason: one definition, so one path cannot skip it.
 */
