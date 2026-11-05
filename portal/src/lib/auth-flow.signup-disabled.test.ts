import { describe, it, expect } from "vitest";
import { authErrorMessage } from "./auth-flow";

/**
 * REGRESSION REPRO: an invited JUDGE (user+judge-1@example.com)
 * opened a valid /join/<token> link, saw "You're signing up as ...", submitted the
 * sign-up form, and was told "Incorrect email or password."
 *
 * The user pool had self-service sign-up DISABLED
 * (AdminCreateUserConfig.AllowAdminCreateUserOnly = true, set on the live pool
 * us-east-1_EXAMPLE01 by an automated mitigation, while
 * the infrastructure CloudFormation template still declares `false`).
 *
 * Cognito answers the SignUp API with, verbatim from the wire:
 *
 *   HTTP/2 400
 *   {"__type":"NotAuthorizedException",
 *    "message":"SignUp is not permitted for this user pool"}
 *
 * Amplify v6 lifts `__type` straight onto `error.name`
 * (@aws-amplify/core/dist/esm/clients/serde/json.mjs, parseJsonError), so
 * AuthFlow.tsx:348 hands authErrorMessage an error named NotAuthorizedException -
 * a name the mapping treats as a SIGN-IN credential failure
 * (lib/auth-flow.ts:120-125).
 *
 * The invariant these tests pin: a rejection that is NOT about the credentials the
 * user supplied must never be reported as if it were. Telling an invited user their
 * email or password is wrong, when the email is locked read-only and server-issued
 * and the account cannot be created at all, sends them into an unbounded retry loop
 * against a pool that will refuse every attempt.
 */
describe("sign-up rejected because the pool forbids self-service sign-up", () => {
  // The exact payload observed on the wire against us-east-1_EXAMPLE01.
  const signUpDisabled = {
    name: "NotAuthorizedException",
    message: "SignUp is not permitted for this user pool",
  };

  it("does not blame the user's email or password", () => {
    expect(authErrorMessage(signUpDisabled)).not.toBe("Incorrect email or password.");
  });

  it("does not claim anything about credentials at all", () => {
    // The email on this screen is locked and server-issued, and the password was
    // just typed twice-over into a fresh form. Neither can be the fault.
    expect(authErrorMessage(signUpDisabled)).not.toMatch(/password|incorrect email/i);
  });

  it("says registration is unavailable, so the user stops retrying", () => {
    // Actionable copy must point AWAY from the form: retrying cannot succeed until
    // the pool is changed. Naming the escalation path is the whole value here.
    expect(authErrorMessage(signUpDisabled)).toMatch(
      /registration|sign-?up|not available|unavailable|administrator|facilitator/i
    );
  });

  it("still reports a genuine wrong-password sign-in as a credential failure", () => {
    // The guard above must not swallow the case the message was written for: a real
    // NotAuthorizedException from signIn() carries Cognito's own credential text.
    expect(
      authErrorMessage({
        name: "NotAuthorizedException",
        message: "Incorrect username or password.",
      })
    ).toBe("Incorrect email or password.");
  });
});
