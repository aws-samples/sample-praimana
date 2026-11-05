import { describe, it, expect } from "vitest";
import {
  authErrorMessage,
  cleanLambdaValidationMessage,
  screenForSignInStep,
  type AuthScreen,
} from "./auth-flow";

/**
 * The custom auth UI's whole risk is the dead end: a real Cognito branch the UI
 * doesn't handle, leaving a user who cannot sign in and cannot tell why. These
 * tests pin every step this pool can actually produce, plus the default.
 */

describe("screenForSignInStep", () => {
  it("routes a completed sign-in to done", () => {
    expect(screenForSignInStep("DONE").screen).toBe("done");
  });

  it("routes the MANDATORY TOTP enrolment step, which every first sign-in hits", () => {
    // The pool is MfaConfiguration: ON with TOTP enabled. If this step were
    // unhandled, no new user could ever complete a first sign-in.
    expect(screenForSignInStep("CONTINUE_SIGN_IN_WITH_TOTP_SETUP").screen).toBe(
      "totpSetup"
    );
  });

  it("routes the per-sign-in TOTP challenge", () => {
    expect(screenForSignInStep("CONFIRM_SIGN_IN_WITH_TOTP_CODE").screen).toBe(
      "totpChallenge"
    );
  });

  it.each([
    ["CONFIRM_SIGN_UP", "confirmSignUp"],
    ["CONFIRM_SIGN_IN_WITH_SMS_CODE", "smsChallenge"],
    ["CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED", "newPasswordRequired"],
    /**
     * ⚠ TWO SCREENS, NOT ONE, these used to both resolve to `mfaSelection`, and the split is
     * deliberate. Cognito's two selection steps differ on the axis that decides who can handle
     * them: choosing which ENROLLED factor to use is a challenge, while choosing which to ENROL
     * leads to a QR code or an address to register. The portal completes either and renders both
     * with the same UI; the DESKTOP handles only the first, and could not tell them apart while
     * they shared a screen name.
     */
    ["CONTINUE_SIGN_IN_WITH_MFA_SELECTION", "mfaSelection"],
    ["CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION", "mfaSetupSelection"],
    ["RESET_PASSWORD", "forgotPassword"],
  ])("routes %s to the %s screen", (step, screen) => {
    expect(screenForSignInStep(step).screen).toBe(screen);
  });

  it("explains an unknown step instead of silently redisplaying sign-in", () => {
    // Without a message the user would retype a correct password forever: the call
    // succeeds every time, and the UI just shows the same form again.
    //
    // ⚠ THE EXAMPLE USED TO BE `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP`, AND IT WENT STALE, email
    // OTP was enabled on the pool, that step became SUPPORTED, and this test failed while
    // testing nothing that had broken. A test for "unhandled steps are explained" must not
    // pick its example from the set of steps we might implement next, so it now uses a name
    // Cognito will never emit.
    const res = screenForSignInStep("CONFIRM_SIGN_IN_WITH_INTERPRETIVE_DANCE");
    expect(res.screen).toBe("signIn");
    expect(res.message).toContain("CONFIRM_SIGN_IN_WITH_INTERPRETIVE_DANCE");
  });

  /** The two email-OTP steps are handled now, so they must NOT fall to the default. */
  it.each([
    ["CONTINUE_SIGN_IN_WITH_EMAIL_SETUP", "emailSetup"],
    ["CONFIRM_SIGN_IN_WITH_EMAIL_CODE", "emailChallenge"],
  ])("routes %s to %s, because EMAIL_OTP is enabled on the pool", (step, expected) => {
    const res = screenForSignInStep(step);
    expect(res.screen).toBe(expected);
    // No message: the screens' own copy names the address the code went to.
    expect(res.message).toBeNull();
  });

  it("carries an explanatory message on steps the user won't otherwise understand", () => {
    expect(screenForSignInStep("CONFIRM_SIGN_UP").message).toBeTruthy();
    expect(screenForSignInStep("RESET_PASSWORD").message).toBeTruthy();
    // The TOTP screens speak for themselves.
    expect(screenForSignInStep("CONTINUE_SIGN_IN_WITH_TOTP_SETUP").message).toBeNull();
  });
});

describe("authErrorMessage", () => {
  const err = (name: string, message = "") => ({ name, message });

  it("gives the SAME answer for unknown-user and wrong-password", () => {
    // Account enumeration: if these differed, the form would confirm which email
    // addresses have accounts. Cognito's own enumeration protection is pointless if
    // the UI leaks the distinction back.
    const notFound = authErrorMessage(err("UserNotFoundException"));
    const notAuthorized = authErrorMessage(err("NotAuthorizedException"));
    expect(notFound).toBe(notAuthorized);
    expect(notFound).toBe("Incorrect email or password.");
  });

  it("explains a wrong verification code in terms of the code", () => {
    expect(authErrorMessage(err("CodeMismatchException"))).toMatch(/code/i);
    expect(authErrorMessage(err("ExpiredCodeException"))).toMatch(/expired/i);
  });

  it("points at clock skew for a rejected TOTP ENROLMENT code", () => {
    // The usual real cause, and the only one the user can fix themselves.
    expect(authErrorMessage(err("EnableSoftwareTokenMFAException"))).toMatch(
      /clock/i
    );
  });

  it("prefers Cognito's own text for a rejected password, which names the rule", () => {
    expect(
      authErrorMessage(
        err("InvalidPasswordException", "Password must have symbol characters")
      )
    ).toBe("Password must have symbol characters");
  });

  it("surfaces the invite-only rejection from the pre-signup trigger", () => {
    // This is the single most important error message in the product: it is why an
    // uninvited person cannot sign up, and Cognito buries it in wrapper text.
    const message = authErrorMessage(
      err(
        "UserLambdaValidationException",
        "PreSignUp failed with error This email has not been invited to the platform.."
      )
    );
    expect(message).toBe("This email has not been invited to the platform.");
    expect(message).not.toMatch(/PreSignUp|failed with error/);
  });

  it("suggests signing in when the account already exists", () => {
    expect(authErrorMessage(err("UsernameExistsException"))).toMatch(/sign(ing)? in/i);
  });

  it("asks the user to wait when Cognito is rate-limiting", () => {
    for (const name of [
      "LimitExceededException",
      "TooManyRequestsException",
      "TooManyFailedAttemptsException",
    ]) {
      expect(authErrorMessage(err(name)), name).toMatch(/wait/i);
    }
  });

  it("never returns an empty string, whatever it is handed", () => {
    for (const value of [undefined, null, {}, "a string", 42, new Error("")]) {
      expect(authErrorMessage(value)).toBeTruthy();
    }
  });

  it("never leaks a raw stack or object into the message", () => {
    expect(authErrorMessage(new TypeError("x is not a function"))).toBeTruthy();
    expect(authErrorMessage({})).not.toContain("[object");
  });
});

// ─── THE ADMIN-PROVISIONED JOURNEY ──────────────────────────────────────────
//
// Registration is now admin-provisioned: `AllowAdminCreateUserOnly: true` on the pool,
// so Cognito refuses the SignUp API and an invited person signs in with a temporary
// password instead. The chain that MUST work end to end is:
//
//   temporary password → CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED
//                      → CONTINUE_SIGN_IN_WITH_TOTP_SETUP  (MfaConfiguration: ON)
//                      → DONE → the profile step → landing
//
// Every one of those steps was already mapped, which is the point of this block: it
// asserts the chain rather than assuming it, because a single unmapped step in it would
// strand every invited user on their first sign-in with no way forward.
describe("the admin-provisioned first-sign-in chain", () => {
  it("maps the forced password change, which is now the FIRST step for every invitee", () => {
    // An admin-created account starts in FORCE_CHANGE_PASSWORD, so the temporary
    // password from the invitation email gets the user exactly this far. If this step
    // were unmapped, nobody invited could ever sign in.
    const res = screenForSignInStep("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED");
    expect(res.screen).toBe("newPasswordRequired");
  });

  it("continues into MANDATORY TOTP enrolment after the new password", () => {
    // MFA is ON and TOTP-only, so this always follows for a first sign-in. The account
    // is not usable until it is done.
    expect(screenForSignInStep("CONTINUE_SIGN_IN_WITH_TOTP_SETUP").screen).toBe(
      "totpSetup"
    );
  });

  it("reaches done, which is where the profile step is decided", () => {
    // The three mandatory profile fields used to be Cognito attributes on the sign-up
    // form. With no sign-up form they are collected after this point, from the profile
    // the server actually holds, see AuthFlow's needsProfileStep().
    expect(screenForSignInStep("DONE").screen).toBe("done");
  });

  it("has NO signUp screen, a sign-up form could never succeed", () => {
    // Not merely unused: Cognito refuses the SignUp API outright, so a screen offering
    // it would be a guaranteed dead end. This asserts the type/union no longer admits
    // one, so nothing can route to it by name.
    const screens: AuthScreen[] = [
      "signIn",
      "confirmSignUp",
      "totpSetup",
      "totpChallenge",
      "smsChallenge",
      "newPasswordRequired",
      "mfaSelection",
      "completeProfile",
      "forgotPassword",
      "resetPassword",
      "done",
    ];
    // @ts-expect-error "signUp" is deliberately NOT an AuthScreen any more.
    const removed: AuthScreen = "signUp";
    expect(screens).not.toContain(removed);
  });

  it("routes no Cognito step to the profile screen, it is OUR step, not Cognito's", () => {
    // completeProfile is reached from establishAppSession() after the session exists,
    // never from a signInStep. If some step mapped to it, a user would be sent to a form
    // whose save needs a session cookie they do not yet have.
    const cognitoSteps = [
      "DONE",
      "CONFIRM_SIGN_UP",
      "CONTINUE_SIGN_IN_WITH_TOTP_SETUP",
      "CONFIRM_SIGN_IN_WITH_TOTP_CODE",
      "CONFIRM_SIGN_IN_WITH_SMS_CODE",
      "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED",
      "CONTINUE_SIGN_IN_WITH_MFA_SELECTION",
      "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION",
      "RESET_PASSWORD",
      "SOMETHING_UNKNOWN",
    ];
    for (const step of cognitoSteps) {
      expect(screenForSignInStep(step).screen, step).not.toBe("completeProfile");
    }
  });

  it("still explains an unknown step rather than silently redisplaying sign-in", () => {
    // Re-asserted in this context because the invite path now ENTERS at the sign-in
    // screen: a silent fallback there would look identical to "wrong password" and the
    // invitee would retype a correct temporary password until it locked them out.
    // Same stale-example lesson as above: a step we may implement is a bad stand-in for one
    // we never will.
    const res = screenForSignInStep("CONFIRM_SIGN_IN_WITH_INTERPRETIVE_DANCE");
    expect(res.screen).toBe("signIn");
    expect(res.message).toContain("CONFIRM_SIGN_IN_WITH_INTERPRETIVE_DANCE");
  });
});

describe("cleanLambdaValidationMessage", () => {
  it("strips the wrapper and the doubled full stop", () => {
    expect(
      cleanLambdaValidationMessage("PreSignUp failed with error Not invited..")
    ).toBe("Not invited.");
  });

  it("handles the PostConfirmation wrapper too", () => {
    expect(
      cleanLambdaValidationMessage("PostConfirmation failed with error Nope.")
    ).toBe("Nope.");
  });

  it("adds a full stop when the trigger's message lacks one", () => {
    expect(
      cleanLambdaValidationMessage("PreSignUp failed with error Not invited")
    ).toBe("Not invited.");
  });

  it("falls back to the raw text when the wrapper isn't recognised", () => {
    expect(cleanLambdaValidationMessage("something else entirely")).toBe(
      "something else entirely"
    );
  });

  it("has a message even for empty input", () => {
    expect(cleanLambdaValidationMessage("")).toBeTruthy();
  });
});
