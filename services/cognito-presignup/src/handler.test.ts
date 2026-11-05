import { describe, it, expect } from "vitest";
import { isExpired, isAccepted, isRevoked } from "./handler.js";

/**
 * THE REGISTRATION GATE'S TWO PREDICATES.
 *
 * This trigger is the one place the invite-only rule is unbypassable: it runs BEFORE the
 * Cognito user is created and throws if the email has no live, unredeemed invitation. So
 * these two functions decide who may hold an account on the platform.
 *
 * THE BYPASS `isAccepted` CLOSES. `status` was declared on the row type and never read, so an
 * ACCEPTED invitation kept admitting NEW registrations indefinitely:
 *
 *   1. Someone registers. The row flips to ACCEPTED and is KEPT — it is the audit record of
 *      who granted them access, which is why the revoke route refuses to delete it.
 *   2. Their Cognito account is later deleted (in the console, or it never existed — the
 *      `sub || ulid()` fallback creates profile rows with no account behind them).
 *   3. The ACCEPTED row is still there and still inside its expiry window. Measured against
 *      the dev table when this was found: 7 of 8 rows were in exactly that state.
 *   4. They register again and get a BRAND-NEW Cognito sub — so every record keyed on the
 *      old sub, including a deactivation flag, no longer applies to them.
 *
 * An accepted invitation means the person ALREADY registered, so it can never legitimately
 * authorise a second registration. Re-admitting someone is an explicit act: an admin issues a
 * fresh invitation, which writes a new PENDING row.
 *
 * BOTH PREDICATES FAIL OPEN ON AN ABSENT VALUE, and that is the same deliberate asymmetry in
 * both: rows predating a field must stay redeemable. Testing for the DENY value means the old
 * and new row shapes agree and no backfill is needed. The alternative refuses every legacy
 * invitation — a lockout, not a leak.
 */

describe("isAccepted — the redeemed-invitation gate", () => {
  it("refuses a row that has already been redeemed", () => {
    expect(isAccepted("ACCEPTED")).toBe(true);
  });

  it("is case-insensitive, because the string is a cross-service contract", () => {
    // This handler bundles standalone and cannot import the Team service's constants, so
    // "ACCEPTED" is written in two places. A casing difference must not silently reopen the
    // bypass — matching loosely here is the cheap insurance against that.
    for (const v of ["accepted", "Accepted", "AcCePtEd", " ACCEPTED "]) {
      expect(isAccepted(v)).toBe(true);
    }
  });

  it("treats an ABSENT status as redeemable", () => {
    // Rows written before `status` existed have no attribute. Treating those as accepted
    // would refuse every legacy invitation — a lockout, which is worse than the leak.
    expect(isAccepted(undefined)).toBe(false);
    expect(isAccepted("")).toBe(false);
    expect(isAccepted("   ")).toBe(false);
  });

  it("treats PENDING and any unrecognised value as redeemable", () => {
    // PENDING is the normal case: a fresh invitation admits exactly one registration.
    for (const v of ["PENDING", "REVOKED", "EXPIRED", "unknown"]) {
      expect(isAccepted(v)).toBe(false);
    }
  });
});

describe("isExpired — the 24h link window", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");

  it("refuses a lapsed invitation", () => {
    expect(isExpired("2026-08-03T11:59:59.000Z", now)).toBe(true);
  });

  it("admits one still inside its window", () => {
    expect(isExpired("2026-08-03T12:00:01.000Z", now)).toBe(false);
  });

  it("treats an ABSENT expiry as live", () => {
    // Same asymmetry as isAccepted, for the same reason: invitations minted before expiry
    // existed must stay redeemable.
    expect(isExpired(undefined, now)).toBe(false);
  });

  it("treats an UNPARSEABLE expiry as expired — corruption fails CLOSED", () => {
    // The one place these two predicates differ in direction, and deliberately: a garbled
    // timestamp is evidence something is wrong with the row, and the safe reading of a
    // damaged credential is to refuse it. An absent field is not damage; it is an older
    // shape.
    expect(isExpired("not a date", now)).toBe(true);
  });

  it("treats the exact expiry instant as expired", () => {
    // `<=`, not `<`: a 24h window that lets the 24-hour mark through is a 24h+1ms window,
    // and boundary-inclusive is the honest reading of "expires at".
    expect(isExpired("2026-08-03T12:00:00.000Z", now)).toBe(true);
  });
});

describe("the combined gate — live, unredeemed AND not withdrawn", () => {
  // Mirrors the `rows.some(...)` predicate in isInvited. ALL THREE conditions must hold, and
  // the table below is the whole decision surface.
  //
  // The third was added with the Team service's removal-driven revocation: a REVOKED row
  // SURVIVES (it is the provenance of who invited someone and when they accepted), so
  // `!isAccepted` alone would have kept admitting a withdrawn grant.
  const admits = (status: string | undefined, expiresAt: string | undefined, now: number) =>
    !isExpired(expiresAt, now) && !isAccepted(status) && !isRevoked(status);

  const now = Date.parse("2026-08-03T12:00:00.000Z");
  const future = "2026-08-04T12:00:00.000Z";
  const past = "2026-08-02T12:00:00.000Z";

  it("admits ONLY a live, unredeemed invitation", () => {
    expect(admits("PENDING", future, now)).toBe(true);
  });

  it("refuses live-but-redeemed — the bypass this closes", () => {
    // The shape 7 of 8 rows in the dev table were in.
    expect(admits("ACCEPTED", future, now)).toBe(false);
  });

  it("refuses redeemed-with-no-expiry — the shape that admitted forever", () => {
    // Worst case before the fix: no expiry to lapse and a status nobody read.
    expect(admits("ACCEPTED", undefined, now)).toBe(false);
  });

  it("refuses expired-but-unredeemed", () => {
    expect(admits("PENDING", past, now)).toBe(false);
  });

  it("still admits a LEGACY row with neither field set", () => {
    // The migration case. If this ever fails, every invitation written before these fields
    // existed has been locked out.
    expect(admits(undefined, undefined, now)).toBe(true);
  });

  it("refuses live-but-WITHDRAWN — the bypass the removal fix would otherwise open", () => {
    // The Team service now flips a removed member's invitation to REVOKED rather than
    // deleting it, so this row shape is one the gate genuinely sees. Without isRevoked it
    // would admit a BRAND-NEW registration through steps 2-4 of the bypass documented on
    // isInvited: the removed person's Cognito account is deleted, this row is still inside
    // its expiry window, they register again under a NEW sub, and every record keyed on the
    // old sub — the removal included — no longer applies to them.
    expect(admits("REVOKED", future, now)).toBe(false);
  });

  it("refuses withdrawn-with-no-expiry — the shape that would admit forever", () => {
    expect(admits("REVOKED", undefined, now)).toBe(false);
  });
});

describe("isRevoked — the withdrawn-grant gate", () => {
  it("refuses a grant that was taken away", () => {
    expect(isRevoked("REVOKED")).toBe(true);
  });

  it("is case-insensitive, because the string is a cross-service contract", () => {
    // Written in four places (this handler, cognito-postconfirmation, user-access, and the
    // Team service's domain), because each of the first three bundles standalone. A casing
    // difference must not silently reopen the bypass.
    for (const v of ["revoked", "Revoked", "ReVoKeD", " REVOKED "]) {
      expect(isRevoked(v), v).toBe(true);
    }
  });

  it("treats an ABSENT status as NOT revoked", () => {
    // Same fail-open-on-absence polarity as isAccepted and isExpired, for the same reason:
    // rows predating the field must stay redeemable, and the alternative is a lockout.
    expect(isRevoked(undefined)).toBe(false);
    expect(isRevoked("")).toBe(false);
    expect(isRevoked("   ")).toBe(false);
  });

  it("treats PENDING, ACCEPTED and any unrecognised value as NOT revoked", () => {
    // ACCEPTED is refused by isAccepted, not by this — the two predicates are separate
    // because the row states are separate facts, and conflating them would make either one
    // impossible to reason about at a call site.
    for (const v of ["PENDING", "ACCEPTED", "EXPIRED", "unknown"]) {
      expect(isRevoked(v), v).toBe(false);
    }
  });
});
