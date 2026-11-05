import { describe, it, expect } from "vitest";
import { isUserDeactivated, USER_DEACTIVATED_CODE } from "@praimana/shared";

/**
 * The platform-wide deactivation predicate.
 *
 * Owner: "instead of remove its making an user inactive so the shouldnt be able to access
 * the workshop and team", then, having weighed the cost, "cant we just disable user login
 * and enable". The mechanism is Cognito AdminDisableUser/AdminEnableUser; see the field's
 * doc comment in shared/types/user.ts.
 *
 * Tested from the PORTAL rather than from the canonical `@praimana/shared` package, which has no test runner
 * (`type-check` and `lint` only). Adding vitest to that package to cover one predicate
 * would be a bigger change than the predicate, and the portal is a real consumer, so this
 * exercises the same import path the application uses.
 *
 * WHY THIS TINY FUNCTION IS WORTH TESTING AT ALL: getting the polarity wrong is not a
 * subtle bug, every account whose row predates the field would read as deactivated, and
 * the wrong version type-checks perfectly.
 *
 * NOTE THE SCOPE. `status` is a DISPLAY MIRROR; Cognito's AdminDisableUser is what actually
 * blocks access. So a bug here is a wrong badge on the Administration screen, not an access
 * bug, because nothing calls this to make an authorization decision, and nothing should.
 * See the field's doc comment in shared/types/user.ts.
 */
describe("isUserDeactivated", () => {
  it("is TRUE only when DEACTIVATED is positively asserted", () => {
    expect(isUserDeactivated({ status: "DEACTIVATED" })).toBe(true);
  });

  it("treats an ABSENT status as active, the whole rolling-deploy story", () => {
    // THE CRITICAL CASE. Every row written before this field existed has no `status`
    // attribute. A predicate written as `status !== "ACTIVE"` would deny every one of
    // them the moment this deploys, and would keep denying them through a rolling deploy
    // where version N and N+1 disagree about the shape. Testing for the DENY value means
    // the old and new shapes agree and no backfill is needed.
    expect(isUserDeactivated({})).toBe(false);
    expect(isUserDeactivated({ status: undefined })).toBe(false);
    expect(isUserDeactivated({ status: null })).toBe(false);
  });

  it("treats an explicit ACTIVE as active", () => {
    expect(isUserDeactivated({ status: "ACTIVE" })).toBe(false);
  });

  it("does NOT deny on an unrecognised status value", () => {
    // Fails OPEN on garbage, deliberately and with eyes open. A typo'd or
    // partially-written attribute ("DEACTIVATE", "deactivated", "") must not lock out an
    // account that nobody deliberately deactivated, the write path is a conditional
    // update precisely so these values cannot arise, and the blast radius of the opposite
    // choice is every user on the platform.
    //
    // Note the lowercase case: the comparison is case-SENSITIVE on purpose. The only
    // writer is the deactivate route, which writes the constant.
    for (const status of ["deactivated", "DEACTIVATE", "INACTIVE", "", "  ", "1", "true"]) {
      expect(isUserDeactivated({ status })).toBe(false);
    }
  });

  it("exposes a distinct code so a client can tell this 403 from every other", () => {
    // A deactivated user's 403 must render a TERMINAL "access removed" state. Rendering it
    // as "session expired" would send them round a sign-in they can no longer complete.
    expect(USER_DEACTIVATED_CODE).toBe("USER_DEACTIVATED");
  });
});
