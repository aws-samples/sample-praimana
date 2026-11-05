import { describe, it, expect } from "vitest";
import {
  INVITATION_ACCEPTED,
  INVITATION_PENDING,
  INVITATION_REVOKED,
  isAcceptedInvitation,
  isRevokedInvitation,
  isSpentInvitation,
} from "./domain.js";

/**
 * THE INVITATION LIFECYCLE PREDICATES — the gate that stops a removed member rejoining.
 *
 * `isSpentInvitation` is what POST /teams/join consults, and before it existed the route
 * checked only that an invitation ROW EXISTED. VERIFIED EXPLOITABLE against the deployed
 * stack: a facilitator removed a participant (membership deleted, MEMBER_REMOVED audited),
 * the ACCEPTED invitation survived, and POST /teams/join with the team's real invite code
 * answered HTTP 200 and re-created the membership — with nothing recording the rejoin.
 *
 * The reasoning is not new: the IDENTICAL hole was already closed for REGISTRATION in
 * cognito-presignup's `isAccepted`. An invitation is a ONE-SHOT grant.
 *
 * BOTH PREDICATES FAIL OPEN ON AN ABSENT VALUE, and that asymmetry is deliberate in the same
 * way it is for isExpired: rows written before `status` existed carry no attribute, and
 * treating those as spent would refuse every legacy invitation — a LOCKOUT, which is worse
 * than the leak. Testing for the DENY value means the old and new row shapes agree and no
 * backfill is needed.
 */

describe("isSpentInvitation — the one-shot-grant gate", () => {
  it("refuses a REDEEMED invitation", () => {
    // The state the verified exploit ran against, and the state a redeemed row is normally
    // in.
    expect(isSpentInvitation(INVITATION_ACCEPTED)).toBe(true);
  });

  it("refuses a WITHDRAWN invitation — the status a removal writes", () => {
    expect(isSpentInvitation(INVITATION_REVOKED)).toBe(true);
  });

  it("ADMITS a PENDING invitation — the legitimate first join", () => {
    // THE HALF THAT MUST NOT BREAK. A predicate that answered true for everything would pass
    // every exploit test and break onboarding for every participant on the platform.
    expect(isSpentInvitation(INVITATION_PENDING)).toBe(false);
  });

  it("ADMITS a row whose status is ABSENT or blank", () => {
    // Fail OPEN on absence. Rows predating the field must stay joinable; the alternative is a
    // lockout. Same polarity as isExpired and as the pre-signup trigger's predicates.
    expect(isSpentInvitation(undefined)).toBe(false);
    expect(isSpentInvitation("")).toBe(false);
    expect(isSpentInvitation("   ")).toBe(false);
  });

  it("ADMITS an unrecognised status rather than guessing it is terminal", () => {
    // Consistent with the absent case: only the two KNOWN terminal values refuse. A future
    // status must be added to this predicate deliberately rather than inheriting a refusal.
    for (const v of ["EXPIRED", "SENT", "unknown", "ACCEPT", "REVOKE"]) {
      expect(isSpentInvitation(v), v).toBe(false);
    }
  });

  it("is case-INSENSITIVE and trims — the string crosses three bundles", () => {
    // cognito-presignup and user-access each carry their own copy of these literals because
    // they bundle standalone. A casing difference must not be the thing that decides whether
    // a removed person can rejoin, so the comparison normalises rather than trusting three
    // copies to be spelt identically.
    for (const v of [
      "accepted",
      "Accepted",
      "AcCePtEd",
      " ACCEPTED ",
      "revoked",
      "Revoked",
      "\tREVOKED\n",
    ]) {
      expect(isSpentInvitation(v), v).toBe(true);
    }
  });

  it("tolerates a non-string without throwing", () => {
    // The value comes off a DynamoDB item, so a corrupt row must produce a refusal-or-admit
    // decision rather than a 500 on a join.
    for (const v of [null, 42, {}, []] as unknown as (string | undefined)[]) {
      expect(() => isSpentInvitation(v)).not.toThrow();
      expect(isSpentInvitation(v)).toBe(false);
    }
  });
});

describe("isRevokedInvitation / isAcceptedInvitation — distinguishing the two terminals", () => {
  it("tells a WITHDRAWN grant from a REDEEMED one", () => {
    // The two are NOT interchangeable at the call sites. POST /invitations/mine/accept counts
    // them separately, because reporting a revocation as `alreadyAccepted` would misdescribe
    // a withdrawn grant as an acceptance in the one number an operator reads. The revoke
    // route's 409 likewise gives a different remedy for each.
    expect(isRevokedInvitation(INVITATION_REVOKED)).toBe(true);
    expect(isRevokedInvitation(INVITATION_ACCEPTED)).toBe(false);

    expect(isAcceptedInvitation(INVITATION_ACCEPTED)).toBe(true);
    expect(isAcceptedInvitation(INVITATION_REVOKED)).toBe(false);
  });

  it("both fail OPEN on absence, matching isSpentInvitation", () => {
    expect(isRevokedInvitation(undefined)).toBe(false);
    expect(isAcceptedInvitation(undefined)).toBe(false);
  });

  it("both normalise case, so the sign-in skip cannot be bypassed by spelling", () => {
    expect(isRevokedInvitation(" revoked ")).toBe(true);
    expect(isAcceptedInvitation(" accepted ")).toBe(true);
  });

  it("isSpentInvitation is exactly the union of the two", () => {
    // Asserted as a property rather than trusted, so a future third terminal status added to
    // one and not the other is a failure here rather than a hole at a call site.
    for (const v of [
      INVITATION_PENDING,
      INVITATION_ACCEPTED,
      INVITATION_REVOKED,
      undefined,
      "unknown",
    ]) {
      expect(isSpentInvitation(v), String(v)).toBe(
        isAcceptedInvitation(v) || isRevokedInvitation(v)
      );
    }
  });
});
