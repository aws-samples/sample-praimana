import { describe, it, expect, vi, beforeEach } from "vitest";
import { AUDIT_REASON_MAX } from "@praimana/shared";

/**
 * The two BFF mutations behind the ACCESS-AFFECTING actions: removing somebody from a
 * team, and disabling or re-enabling their platform access.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT ASSERT.
 *
 * It does NOT test authorization. Both gates live in the services, `requireTeamWrite`
 * in the team service, and the three-gate check (the USER_ADMIN_GRANTS matrix against
 * the target's Cognito-resolved role, the self-action refusal, and the last-enabled-ADMIN
 * refusal) in the user-access service, and those are asserted in their own suites,
 * against the HTTP surface that actually enforces them. A security review confirmed two
 * live vulnerabilities caused by trusting a portal-layer check: every service route is
 * mapped ANY behind a JWT authorizer that does NO role scoping, and the browser holds its
 * own ID token, so this layer is not on the only path to the service. Asserting a gate
 * here would document a boundary that does not exist.
 *
 * What it DOES test is the handful of things only this layer can get wrong, each of which
 * type-checks and lints perfectly in its broken form:
 *
 *   1. THE RIGHT ENDPOINT, METHOD AND BODY SHAPE. HttpApi routes are per-method, so a
 *      GET or a path typo 404s before the Lambda runs, and the operator sees a failure
 *      whose cause is invisible. A misspelled body key is worse: the request SUCCEEDS
 *      and the field is silently ignored.
 *   2. THE CALLER'S TOKEN IS FORWARDED, or the gateway 401s it.
 *   3. `audited` IS NOT ASSUMED TRUE. A false means an access change went into the system
 *      with no record of who made it. Defaulting it to true when the field is absent is
 *      how a missing audit trail goes unnoticed, and it is a one-character mistake.
 *   4. PATH SEGMENTS ARE ENCODED. An unencoded id carrying a slash changes which route
 *      the gateway matches.
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
import { adminRouter } from "@/lib/trpc/routers/admin";

/**
 * A caller with a SIGNED-IN context.
 *
 * `protectedProcedure` requires BOTH `session.user.id` and `accessToken`, and its auth
 * middleware runs before anything else, so a context that is merely close enough would
 * make every assertion below pass or fail for the wrong reason (UNAUTHORIZED rather than
 * the behaviour under test).
 */
function callers(role = "ADMIN") {
  const ctx = {
    accessToken: "test-token",
    session: { user: { id: "sub-1", email: "a@example.com", role } },
  } as never;
  return { team: teamRouter.createCaller(ctx), admin: adminRouter.createCaller(ctx) };
}

beforeEach(() => {
  backendFetch.mockReset();
});

// ─── team.removeMember ───────────────────────────────────────────────────────

describe("team.removeMember", () => {
  beforeEach(() => {
    backendFetch.mockResolvedValue({ success: true, audited: true });
  });

  it("DELETEs the member route with both ids in the path", async () => {
    await callers().team.removeMember({ teamId: "t1", userId: "u1" });

    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe("/v1/teams/t1/members/u1");
    // Per-method at the gateway: a POST or PATCH here 404s before the Lambda runs, and
    // the operator sees "removal failed" with no way to tell that the path was the fault.
    expect(init.method).toBe("DELETE");
  });

  it("ENCODES both path segments", async () => {
    // An id carrying a slash would otherwise change which route the gateway matches -
    // and a 404 from a mis-built path is indistinguishable from "no such member".
    await callers().team.removeMember({ teamId: "t/1", userId: "u 1#x" });

    expect(backendFetch.mock.calls[0][0]).toBe("/v1/teams/t%2F1/members/u%201%23x");
  });

  it("forwards the caller's bearer token", async () => {
    await callers().team.removeMember({ teamId: "t1", userId: "u1" });
    expect(backendFetch.mock.calls[0][1].token).toBe("test-token");
  });

  it("sends the reason in the BODY, never in the URL", async () => {
    // The reason is operator free text that may name a person. A query string lands in
    // gateway access logs and browser history; neither should hold it.
    await callers().team.removeMember({
      teamId: "t1",
      userId: "u1",
      reason: "left the programme",
    });

    const [path, init] = backendFetch.mock.calls[0];
    expect(path).not.toContain("?");
    expect(JSON.parse(init.body)).toEqual({ reason: "left the programme" });
  });

  it("trims the reason and rejects one over the audit cap", async () => {
    await callers().team.removeMember({
      teamId: "t1",
      userId: "u1",
      reason: "  spaced  ",
    });
    expect(JSON.parse(backendFetch.mock.calls[0][1].body).reason).toBe("spaced");

    // Capped at the same constant the audit row is capped at, so a reason that passes
    // the schema always fits the entry.
    await expect(
      callers().team.removeMember({
        teamId: "t1",
        userId: "u1",
        reason: "x".repeat(AUDIT_REASON_MAX + 1),
      })
    ).rejects.toThrow();
  });

  it("returns { removed: true, audited } and PASSES A FALSE THROUGH", async () => {
    // THE SIGNAL THAT MATTERS. The row is already gone by the time the service attempts
    // the audit, so it reports rather than throws, and a false means an access change
    // happened with nothing recording who made it. Swallowing it here would erase the
    // only way the screen can say so.
    backendFetch.mockResolvedValue({ success: true, audited: false });

    expect(await callers().team.removeMember({ teamId: "t1", userId: "u1" })).toEqual({
      removed: true,
      audited: false,
    });
  });

  it("treats an ABSENT audited field as FALSE, not as success", async () => {
    // An older service version that does not send the flag has not told us the entry was
    // written. Assuming success is how a missing audit trail goes unnoticed.
    backendFetch.mockResolvedValue({ success: true });

    expect(await callers().team.removeMember({ teamId: "t1", userId: "u1" })).toEqual({
      removed: true,
      audited: false,
    });
  });

  it("does not read `audited` loosely, only a real true is true", async () => {
    // A service answering the string "true" or 1 must not be reported as audited. The
    // strict comparison is what keeps this flag trustworthy.
    for (const value of ["true", 1, {}, "yes"]) {
      backendFetch.mockResolvedValue({ success: true, audited: value });
      const result = await callers().team.removeMember({ teamId: "t1", userId: "u1" });
      expect(result.audited, JSON.stringify(value)).toBe(false);
    }
  });

  it("rejects for an anonymous caller, without touching the backend", async () => {
    const anonymous = teamRouter.createCaller({} as never);

    const err = await anonymous
      .removeMember({ teamId: "t1", userId: "u1" })
      .then(() => null, (e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("UNAUTHORIZED");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("PROPAGATES a backend refusal rather than reporting a removal that did not happen", async () => {
    // The 403 from requireTeamWrite (which also refuses a read-only EXECUTIVE) is the
    // real gate. Absorbing it here would render "Removed" over a member who is still on
    // the team, the worst possible outcome for this control.
    backendFetch.mockRejectedValue(new Error("Forbidden"));

    await expect(
      callers("EXECUTIVE").team.removeMember({ teamId: "t1", userId: "u1" })
    ).rejects.toThrow();
  });
});

// ─── team.reactivateMember ───────────────────────────────────────────────────

describe("team.reactivateMember", () => {
  beforeEach(() => {
    backendFetch.mockResolvedValue({ reactivated: true, role: "LEAD", audited: true });
  });

  it("POSTs the reactivate route, the EXTRA path segment, which needs its own gateway mapping", async () => {
    // API Gateway matches a path parameter against ONE segment, so
    // /v1/teams/{teamId}/members/{userId} does NOT match this five-segment path. A typo here,
    // or a missing mapping, returns the gateway's 404, and the operator sees "restore failed"
    // with nothing to say the path was the fault. That exact trap made this route unreachable
    // in production once already.
    await callers().team.reactivateMember({ teamId: "t1", userId: "u1" });

    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe("/v1/teams/t1/members/u1/reactivate");
    // Per-method at the gateway, and this route is mapped POST-only: a PUT or PATCH 404s
    // before the Lambda runs.
    expect(init.method).toBe("POST");
  });

  it("ENCODES both path segments", async () => {
    await callers().team.reactivateMember({ teamId: "t/1", userId: "u 1#x" });

    expect(backendFetch.mock.calls[0][0]).toBe(
      "/v1/teams/t%2F1/members/u%201%23x/reactivate"
    );
  });

  it("forwards the caller's bearer token", async () => {
    await callers().team.reactivateMember({ teamId: "t1", userId: "u1" });
    expect(backendFetch.mock.calls[0][1].token).toBe("test-token");
  });

  it("sends the reason in the BODY, never in the URL", async () => {
    // Operator free text that may name a person. A query string lands in gateway access logs
    // and browser history; neither should hold it.
    await callers().team.reactivateMember({
      teamId: "t1",
      userId: "u1",
      reason: "removed by mistake",
    });

    const [path, init] = backendFetch.mock.calls[0];
    expect(path).not.toContain("?");
    expect(JSON.parse(init.body)).toEqual({ reason: "removed by mistake" });
  });

  it("trims the reason and caps it at the SAME constant the audit row is capped at", async () => {
    await callers().team.reactivateMember({ teamId: "t1", userId: "u1", reason: "  spaced  " });
    expect(JSON.parse(backendFetch.mock.calls[0][1].body).reason).toBe("spaced");

    await expect(
      callers().team.reactivateMember({
        teamId: "t1",
        userId: "u1",
        reason: "x".repeat(AUDIT_REASON_MAX + 1),
      })
    ).rejects.toThrow();

    await expect(
      callers().team.reactivateMember({
        teamId: "t1",
        userId: "u1",
        reason: "x".repeat(AUDIT_REASON_MAX),
      })
    ).resolves.toBeTruthy();
  });

  it("surfaces every contract field: reactivated, role and audited", async () => {
    expect(
      await callers().team.reactivateMember({ teamId: "t1", userId: "u1" })
    ).toEqual({ reactivated: true, role: "LEAD", audited: true });
  });

  it("PASSES A FALSE `audited` THROUGH", async () => {
    // The signal that matters, and it is the direction that ADDS privilege: a false after a
    // real flip means access was GRANTED with no record of who granted it. Swallowing it here
    // would erase the only way the screen can say so.
    backendFetch.mockResolvedValue({ reactivated: true, role: "BUILDER", audited: false });

    expect(
      await callers().team.reactivateMember({ teamId: "t1", userId: "u1" })
    ).toEqual({ reactivated: true, role: "BUILDER", audited: false });
  });

  it("treats an ABSENT audited field as FALSE, not as success", async () => {
    backendFetch.mockResolvedValue({ reactivated: true, role: "LEAD" });

    const result = await callers().team.reactivateMember({ teamId: "t1", userId: "u1" });

    expect(result.audited).toBe(false);
  });

  it("does not read `audited` loosely, only a real true is true", async () => {
    for (const value of ["true", 1, {}, "yes"]) {
      backendFetch.mockResolvedValue({ reactivated: true, role: "LEAD", audited: value });
      const result = await callers().team.reactivateMember({ teamId: "t1", userId: "u1" });
      expect(result.audited, JSON.stringify(value)).toBe(false);
    }
  });

  it("returns the PRESERVED team role, and \"\" rather than undefined when absent", async () => {
    // The role is what the surviving membership row exists to protect, a reactivated LEAD
    // comes back a LEAD. A screen printing "restored as undefined" is worse than one printing
    // nothing, so a non-string collapses to the empty string the caller can branch on.
    for (const value of [undefined, null, 42, {}]) {
      backendFetch.mockResolvedValue({ reactivated: true, role: value, audited: true });
      const result = await callers().team.reactivateMember({ teamId: "t1", userId: "u1" });
      expect(result.role, JSON.stringify(value)).toBe("");
    }
  });

  it("rejects for an anonymous caller, without touching the backend", async () => {
    const anonymous = teamRouter.createCaller({} as never);

    const err = await anonymous
      .reactivateMember({ teamId: "t1", userId: "u1" })
      .then(() => null, (e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("UNAUTHORIZED");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("PROPAGATES a backend refusal rather than reporting a restoration that did not happen", async () => {
    // Three real refusals the service issues, all of which this layer must NOT swallow: the
    // 403 from requireTeamWrite (which also refuses a read-only EXECUTIVE), the 403 for a
    // subject whose role may not hold team membership at all, and the 404 for a person with no
    // membership row, re-admitting a never-member is an INVITATION, not a reactivation.
    // Rendering any of them as success would show "Restored" over somebody with no access.
    backendFetch.mockRejectedValue(new Error("Forbidden"));

    await expect(
      callers("EXECUTIVE").team.reactivateMember({ teamId: "t1", userId: "u1" })
    ).rejects.toThrow();
  });

  it("does NOT gate on the caller's role in this layer", async () => {
    // ASSERTED AS AN INTENTION, not as a permission. The BFF is not a boundary, every service
    // route is mapped behind a JWT authorizer with no role scoping, and the browser holds its
    // own token, so a check here would be a fourth copy of a matrix that silently goes stale
    // and protects nothing. The service refuses this caller.
    await callers("PARTICIPANT").team.reactivateMember({ teamId: "t1", userId: "u1" });

    expect(backendFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── admin.setUserAccess ────────────────────────────────────────────────────

describe("admin.setUserAccess", () => {
  beforeEach(() => {
    backendFetch.mockResolvedValue({
      userId: "u1",
      enabled: false,
      invitationsRevoked: 2,
      invitationsRevokeComplete: true,
      audited: true,
    });
  });

  it("POSTs to the user-access service's access route", async () => {
    await callers().admin.setUserAccess({ userId: "u1", enabled: false });

    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    // The out-of-VPC service, which is the ONLY holder of the Cognito admin writes. The
    // identity service could not make this call at all, a cognito-idp request cannot
    // transit a VPC endpoint for a pool with a managed-login domain.
    expect(path).toBe("/v1/user-access/access");
    expect(init.method).toBe("POST");
  });

  it("sends userId, enabled and reason with EXACTLY those keys", async () => {
    // A misspelled key is the failure mode this catches: the request succeeds, the
    // service reads `undefined`, and `enabled` being absent is a 400 while a wrong
    // `reason` key is silently dropped from the audit entry. Both look like the feature
    // working.
    await callers().admin.setUserAccess({
      userId: "u1",
      enabled: false,
      reason: "left the programme",
    });

    expect(JSON.parse(backendFetch.mock.calls[0][1].body)).toEqual({
      userId: "u1",
      enabled: false,
      reason: "left the programme",
    });
  });

  it("sends `enabled` as a real boolean in BOTH directions", async () => {
    // The service requires a strict boolean and 400s anything else, deliberately: the two
    // directions are not interchangeable, so a request that does not say which it means
    // must be refused rather than defaulted.
    await callers().admin.setUserAccess({ userId: "u1", enabled: true });
    expect(JSON.parse(backendFetch.mock.calls[0][1].body).enabled).toBe(true);

    await callers().admin.setUserAccess({ userId: "u1", enabled: false });
    expect(JSON.parse(backendFetch.mock.calls[1][1].body).enabled).toBe(false);
  });

  it("requires `enabled`, there is no default direction", async () => {
    await expect(
      // @ts-expect-error deliberately omitting a required field: the schema is the guard,
      // and a default here would let a client bug become a silent disable.
      callers().admin.setUserAccess({ userId: "u1" })
    ).rejects.toThrow();
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("forwards the caller's bearer token", async () => {
    await callers().admin.setUserAccess({ userId: "u1", enabled: false });
    expect(backendFetch.mock.calls[0][1].token).toBe("test-token");
  });

  it("caps the reason at the SAME constant the audit row is capped at", async () => {
    // Two numbers for one rule is how a form starts accepting text the row silently
    // truncates.
    await expect(
      callers().admin.setUserAccess({
        userId: "u1",
        enabled: false,
        reason: "x".repeat(AUDIT_REASON_MAX + 1),
      })
    ).rejects.toThrow();

    await expect(
      callers().admin.setUserAccess({
        userId: "u1",
        enabled: false,
        reason: "x".repeat(AUDIT_REASON_MAX),
      })
    ).resolves.toBeTruthy();
  });

  it("returns the revoked count and the audited flag", async () => {
    // The count is a fact an operator withdrawing access reads carefully: it is how they
    // learn that live credentials were destroyed alongside the account being switched off.
    expect(
      await callers().admin.setUserAccess({ userId: "u1", enabled: false })
    ).toEqual({
      userId: "u1",
      enabled: false,
      invitationsRevoked: 2,
      invitationsRevokeComplete: true,
      audited: true,
    });
  });

  it("FORWARDS invitationsRevokeComplete, a surviving invitation must reach the screen", async () => {
    // The most serious thing this mutation can report, and a count cannot express it:
    // "2 revoked" reads identically whether a third survived or there were only two.
    //
    // A survivor matters because an unredeemed invitation is a live credential. The person
    // just locked out can still register through the invite-only gate, and doing so mints a
    // BRAND-NEW Cognito sub, so the disable, keyed on the old one, stops applying to them.
    // Dropping this field here is what would let that go unnoticed.
    backendFetch.mockResolvedValue({
      invitationsRevoked: 2,
      invitationsRevokeComplete: false,
      audited: true,
    });

    const result = await callers().admin.setUserAccess({ userId: "u1", enabled: false });

    expect(result.invitationsRevokeComplete).toBe(false);
  });

  it("treats an ABSENT invitationsRevokeComplete as FALSE", async () => {
    // Same fail-closed direction as `audited`, for the same reason: a service version that
    // does not send the field has not told us the revocation completed, and assuming it did
    // is how a surviving credential goes unreported. The truthy check is strict, so a
    // stringy "false" cannot read as success either.
    for (const value of [undefined, null, "false", "true", 1, {}]) {
      backendFetch.mockResolvedValue({
        audited: true,
        invitationsRevoked: 2,
        invitationsRevokeComplete: value,
      });
      const result = await callers().admin.setUserAccess({
        userId: "u1",
        enabled: false,
      });
      expect(result.invitationsRevokeComplete, JSON.stringify(value)).toBe(false);
    }
  });

  it("echoes userId and enabled from the INPUT, so the row can be correlated", async () => {
    // Deliberately not from the response: the caller needs to know which row it clicked
    // even if a future service version reshapes its body.
    backendFetch.mockResolvedValue({ audited: true });

    const result = await callers().admin.setUserAccess({
      userId: "clicked-row",
      enabled: true,
    });

    expect(result.userId).toBe("clicked-row");
    expect(result.enabled).toBe(true);
  });

  it("guards the count against a non-number, rather than rendering `undefined`", async () => {
    for (const value of [undefined, null, "2", {}]) {
      backendFetch.mockResolvedValue({ audited: true, invitationsRevoked: value });
      const result = await callers().admin.setUserAccess({
        userId: "u1",
        enabled: false,
      });
      expect(result.invitationsRevoked, JSON.stringify(value)).toBe(0);
    }
  });

  it("treats an ABSENT audited field as FALSE", async () => {
    backendFetch.mockResolvedValue({ userId: "u1", enabled: false });

    const result = await callers().admin.setUserAccess({ userId: "u1", enabled: false });

    expect(result.audited).toBe(false);
  });

  it("rejects for an anonymous caller, without touching the backend", async () => {
    const anonymous = adminRouter.createCaller({} as never);

    const err = await anonymous
      .setUserAccess({ userId: "u1", enabled: false })
      .then(() => null, (e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("UNAUTHORIZED");
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("PROPAGATES the service's refusal instead of absorbing it", async () => {
    // Every one of the three gates answers with a status this layer must NOT swallow: a
    // 403 from the role matrix, a 409 carrying SELF_ACTION_REFUSED or LAST_ADMIN_REFUSED.
    // Rendering any of them as a success would tell an operator that access was revoked
    // when it was not, and, for the last-admin case, would hide the one refusal that is
    // protecting them from an irreversible lockout.
    backendFetch.mockRejectedValue(new Error("Forbidden"));

    await expect(
      callers("FACILITATOR").admin.setUserAccess({ userId: "u1", enabled: false })
    ).rejects.toThrow();
  });

  it("does NOT gate on the caller's role in this layer", async () => {
    // ASSERTED AS AN INTENTION, not as a permission. The BFF is not a boundary, every
    // service route is mapped ANY behind a JWT authorizer with no role scoping, and the
    // browser holds its own token, so a check here would be a fourth copy of the matrix
    // that silently goes stale and protects nothing. The service refuses this caller; if
    // somebody later adds a role check here, this test should be deleted deliberately
    // rather than surviving as a false sense of a boundary.
    backendFetch.mockResolvedValue({ audited: true });

    await callers("PARTICIPANT").admin.setUserAccess({ userId: "u1", enabled: false });

    expect(backendFetch).toHaveBeenCalledTimes(1);
  });
});
