// ── ⚠ EMAIL OTP DRAGS TWO OTHER SETTINGS WITH IT, AND COGNITO ENFORCES THAT ──────────────
//
// Enabling EMAIL_OTP on the user pool is not a one-line change. Cognito refuses it outright unless
// two unrelated-looking properties change at the same time, and each refusal only appears AFTER the
// previous one is fixed — so someone editing this template will hit them one at a time, at deploy:
//
//   1. `EmailConfiguration` must not be COGNITO_DEFAULT:
//        "Cannot set EmailMfaConfiguration when user pool EmailConfiguration contains an
//         EmailSendingAccount of COGNITO_DEFAULT."
//   2. `AccountRecoverySetting` must contain something other than verified_email:
//        "At least one recovery mechanism other than verified_email should be present."
//
// ⚠ WHY IT WAS ENABLED AT ALL: a real, unrecoverable lockout. Cognito has NO API to delete a user's
// TOTP secret — `AdminSetUserMFAPreference ... Enabled=false` returns SUCCESS and the user is still
// challenged, the empty-preference form is rejected ("No mfa settings given"), and with
// MfaConfiguration ON you cannot disable a user's only factor. A lost authenticator meant the account
// was finished, short of deleting and recreating the user, which mints a new `sub` and orphans every
// row keyed on it.
//
// These tests pin the COUPLING, not the values: all three properties must be gated on the same
// condition, so a deployment either has all of it or none of it. Half of it does not deploy.

import { describe, it, expect } from "vitest";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * ⚠ `infrastructureTemplateText()` RETURNS "" WHEN THE TEMPLATE IS ABSENT, NOT NULL, and the
 * difference decides whether this file loads. Module-scope helpers below derive values from
 * TEMPLATE during COLLECTION, before any `describe` runs, so a null would throw and the file would
 * FAIL rather than skip. `HAS_TEMPLATE` is what gates the assertions.
 */
const TEMPLATE = infrastructureTemplateText();
const HAS_TEMPLATE = hasInfrastructureTemplate();

/** The UserPool resource block, so a match elsewhere in a 4,000-line template cannot satisfy these. */
const POOL = (() => {
  // ⚠ NO-OP WITHOUT THE TEMPLATE — the `expect` below would fail the FILE rather than skip it.
  // Module scope runs during collection, before `describe.skipIf` can skip anything.
  if (!HAS_TEMPLATE) return "";
  const start = TEMPLATE.indexOf("  UserPool:");
  expect(start, "UserPool resource must exist").toBeGreaterThan(-1);
  // Ends at the next top-level (two-space) resource key.
  const rest = TEMPLATE.slice(start + 12);
  const end = rest.search(/\n {2}[A-Za-z][A-Za-z0-9]*:\n/);
  return rest.slice(0, end === -1 ? undefined : end);
})();

/**
 * ⚠ COMMENTS STRIPPED FOR ABSENCE CHECKS, and this file needed it twice on the first run. The
 * explanatory comments above these properties necessarily DISCUSS `SMS_MFA` and quote Cognito's
 * "AccountRecoverySetting must contain something other than verified_email" error — so a naive
 * `not.toMatch(/SMS_MFA/)` failed on the prose explaining why SMS is absent, and an `indexOf`
 * anchored on a property name found the comment mentioning it instead of the property itself.
 * An assertion its own documentation can satisfy (or break) is not an assertion.
 */
const CODE = POOL.replace(/^\s*#.*$/gm, "");

/** The line of an actual property at pool indentation, not a comment that mentions it. */
const propertyBlock = (name: string, chars = 400) => {
  const at = CODE.indexOf(`\n      ${name}:`);
  expect(at, `${name} must be declared as a property`).toBeGreaterThan(-1);
  return CODE.slice(at, at + chars);
};

describe.skipIf(!HAS_TEMPLATE)("⚠ EMAIL_OTP and the two settings Cognito ties to it", () => {
  it("offers EMAIL_OTP as a second factor when a verified sender exists", () => {
    expect(POOL).toMatch(/EnabledMfas: !If/);
    expect(POOL).toMatch(/\[SOFTWARE_TOKEN_MFA, EMAIL_OTP\]/);
  });

  /**
   * ⚠ AND FALLS BACK TO TOTP-ONLY WITHOUT ONE. EMAIL_OTP with COGNITO_DEFAULT is rejected, so an
   * unconditional list would break every deploy that leaves EmailFrom empty — including a fresh
   * environment brought up before its SES identity is verified.
   */
  it("falls back to TOTP-only when there is no sender, rather than failing the deploy", () => {
    expect(POOL).toMatch(/- \[SOFTWARE_TOKEN_MFA\]/);
  });

  it("sends through SES, because EMAIL_OTP cannot use Cognito's default sender", () => {
    expect(POOL).toMatch(/EmailSendingAccount: DEVELOPER/);
    expect(POOL, "and the identity is an SES one").toMatch(/:identity\/\$\{Domain\}/);
  });

  /**
   * The identity is DERIVED from EmailFrom's domain rather than taken as a second parameter. Two
   * values that must agree are two values that will eventually disagree.
   */
  it("derives the SES identity from EmailFrom instead of duplicating it", () => {
    expect(POOL).toMatch(/Domain: !Select \[1, !Split \["@", !Ref EmailFrom\]\]/);
    expect(CODE, "SesIdentityArn is for the CROSS-account case, not this one").not.toMatch(
      /SourceArn: !Ref SesIdentityArn/
    );
  });

  it("swaps recovery to admin_only, which is what unblocks EMAIL_OTP", () => {
    expect(POOL).toMatch(/Name: admin_only/);
    expect(POOL, "and keeps verified_email when email MFA is off").toMatch(/Name: verified_email/);
  });

  /**
   * ⚠ THE WHOLE POINT. All three must be gated on the SAME condition. If they drift apart, a deploy
   * can enable EMAIL_OTP while leaving COGNITO_DEFAULT or verified_email in place, and Cognito
   * rejects the stack update — after the change set has already started.
   */
  it("gates all three on the same condition, so they cannot ship apart", () => {
    for (const name of ["EnabledMfas", "EmailConfiguration", "AccountRecoverySetting"]) {
      expect(propertyBlock(name), `${name} must be gated on HasEmailFrom`).toMatch(/HasEmailFrom/);
    }
  });

  /** MFA stays REQUIRED — email is an additional way to satisfy it, not a way around it. */
  it("does not weaken MFA while adding a second factor", () => {
    expect(POOL).toMatch(/MfaConfiguration: "ON"/);
    expect(CODE).not.toMatch(/MfaConfiguration: "?OPTIONAL/);
    expect(CODE).not.toMatch(/MfaConfiguration: "?OFF/);
  });

  /**
   * ⚠ SMS MUST NOT COME BACK. It is not enabled, no user has a phone_number, and the pool's SNS
   * caller role was DELETED — which is separately why the Cognito console cannot save this pool's
   * MFA page at all. The portal offered a "Text message" button for exactly this reason and it could
   * never have worked; see mfa-selection.test.ts.
   */
  it("still enables no SMS factor", () => {
    expect(CODE).not.toMatch(/SMS_MFA/);
  });
});

/**
 * ⚠ ABSENT SIBLING REPO ⇒ A TODO, NEVER A SILENT PASS. Every assertion above is skipped when the
 * infrastructure repo is not checked out beside this one, so this reports the gap in the run summary
 * instead of leaving a low test count to be noticed by nobody. See `sibling-repo.ts`.
 */
if (!HAS_TEMPLATE) {
  describe("the infrastructure template", () => {
    it.todo(TEMPLATE_ABSENT_TODO);
  });
}
