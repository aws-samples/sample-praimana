/**
 * The auth journey's STATE MACHINE and error copy, kept out of the React
 * components so both are testable without a DOM.
 *
 * ── ⚠ SHARED BY THE PORTAL AND THE DESKTOP. DO NOT FORK IT. ──
 *
 * Drift here is a SECURITY EVENT. `authErrorMessage`'s collapsing of `UserNotFoundException` and
 * `NotAuthorizedException` into one string is an ACCOUNT-ENUMERATION CONTROL, and two
 * copies is how one of them regresses silently — someone "improves" the desktop's error
 * message to be more helpful, and it starts telling an attacker which addresses are
 * registered.
 *
 * It is transport-free and dependency-free (zero imports) precisely so it can be shared:
 * no React, no Next, no `next-auth`, no Amplify SDK, no IPC. Keep it that way — an import
 * here is what would force a fork later.
 *
 * ⚠ THE DESKTOP RENDERS FEWER SCREENS THAN THE PORTAL, and that is a UI decision, not a
 * reason to trim this map. Reaching the desktop's form requires a completed portal login,
 * so TOTP is enrolled and any forced password change is done — but Cognito still decides
 * which step comes back. An admin resetting a password mid-workshop makes
 * `NEW_PASSWORD_REQUIRED` appear for a user who signed in on the web yesterday. The
 * desktop routes those steps to "finish this on the website" rather than dead-ending,
 * which only works if every step is still NAMED here.
 *
 * Amplify's `signIn`/`confirmSignIn` don't return "signed in" or "failed" — they
 * return a `nextStep.signInStep` naming what the user must do next, and the caller
 * is responsible for driving the rest. There are fourteen possible steps. Handling
 * them ad-hoc inside a component is how a custom auth UI ends up with a dead end:
 * some real branch (a forced password change, an MFA choice) leaves the user
 * staring at a spinner with no way forward. Mapping every step explicitly, in one
 * place, is what prevents that.
 */

/**
 * The screen the UI should show.
 *
 * NOTE there is no "signUp". Self-service sign-up is disabled on the pool
 * (`AllowAdminCreateUserOnly: true`), so Cognito refuses the SignUp API and a sign-up
 * screen could never succeed — accounts are admin-created at invite time and the
 * invited person's first action is a sign-in with a temporary password.
 *
 * "completeProfile" is where the three mandatory fields (first name, last name,
 * organisation) are now collected: they used to be Cognito user attributes submitted
 * with the sign-up form, and with that form gone they are asked for once at first
 * login and saved through the identity service's PATCH /me.
 */
export type AuthScreen =
  | "signIn"
  | "confirmSignUp"
  | "totpSetup"
  | "totpChallenge"
  | "smsChallenge"
  /**
   * ── EMAIL AS A SECOND FACTOR ──────────────────────────────────────────────────────────
   *
   * Added when EMAIL_OTP was enabled on the pool, because a lost authenticator was an
   * UNRECOVERABLE LOCKOUT: Cognito has no API to delete a user's TOTP secret, so an admin
   * cannot reset it, and the account is finished. Email is the second factor that gives a
   * way back in.
   *
   * "emailSetup" is the enrolment step (Cognito asks which address to send codes to);
   * "emailChallenge" is the per-sign-in code entry.
   */
  | "emailSetup"
  | "emailChallenge"
  | "newPasswordRequired"
  | "mfaSelection"
  /**
   * ⚠ SPLIT FROM `mfaSelection`, AND THE DISTINCTION IS THE DESKTOP'S WHOLE RULE. Cognito has two
   * selection steps and they differ on the one axis that decides who handles them:
   *
   *   MFA_SELECTION        — which enrolled factor to use NOW. A challenge.
   *   MFA_SETUP_SELECTION  — which factor to ENROL. Setup, and every branch out of it leads to
   *                          enrolment (a TOTP QR, or an email address to register).
   *
   * They mapped to one screen, so a caller could not tell them apart. The portal renders both the
   * same way and does not care. The desktop handles challenges and defers setup — and offering a
   * setup choice it cannot complete would be a TWO-STEP dead end: pick a factor, then be told to
   * go to the website anyway.
   */
  | "mfaSetupSelection"
  | "completeProfile"
  | "forgotPassword"
  | "resetPassword"
  | "done";

/**
 * Amplify's `signInStep` strings we act on. Typed as a plain string union rather
 * than imported from Amplify so this module (and its tests) don't need the SDK.
 */
export type SignInStep = string;

export interface StepResolution {
  screen: AuthScreen;
  /** Shown above the form; null when the screen's own copy is enough. */
  message: string | null;
}

/**
 * Map an Amplify `nextStep.signInStep` to the screen to render.
 *
 * The default case is the important one: an UNRECOGNISED step must not silently
 * render the sign-in form as though nothing happened (the user would type their
 * password again and again, succeeding every time and never getting in). It
 * surfaces as an explicit message instead.
 */
export function screenForSignInStep(step: SignInStep): StepResolution {
  switch (step) {
    case "DONE":
      return { screen: "done", message: null };

    case "CONFIRM_SIGN_UP":
      return {
        screen: "confirmSignUp",
        message: "Your email isn't confirmed yet. Enter the code we sent you.",
      };

    // MFA is mandatory on this pool (MfaConfiguration: ON), so a first sign-in
    // lands here: the user must enrol an authenticator app before they can finish.
    case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP":
      return { screen: "totpSetup", message: null };

    case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
      return { screen: "totpChallenge", message: null };

    case "CONFIRM_SIGN_IN_WITH_SMS_CODE":
      return { screen: "smsChallenge", message: null };

    /**
     * ⚠ THESE TWO USED TO FALL THROUGH TO THE DEFAULT, which told the user their account
     * "needs a sign-in step we don't support yet". That was TRUE and is no longer: EMAIL_OTP
     * is enabled on the pool, so both steps are now reachable on a normal sign-in and a user
     * who picked Email would have been dead-ended by the very branch written to prevent
     * dead ends.
     */
    case "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP":
      return { screen: "emailSetup", message: null };

    case "CONFIRM_SIGN_IN_WITH_EMAIL_CODE":
      return { screen: "emailChallenge", message: null };

    // An admin-created user, or one whose password was reset by an admin, must set
    // a new password before the session is issued.
    case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED":
      return {
        screen: "newPasswordRequired",
        message: "Choose a new password to finish signing in.",
      };

    /**
     * Cognito can ask the user to pick a factor. Both steps take the same answer shape — the
     * factor name — and `_SETUP_SELECTION` is the "you must configure MFA before you can sign
     * in" case, i.e. choosing which factor to ENROL rather than which to use.
     *
     * ⚠ THE ANSWER SET IS NOT HARDCODED BY THE CALLER ANY MORE. The pool enables
     * SOFTWARE_TOKEN_MFA and EMAIL_OTP and does NOT enable SMS — but the UI offered
     * "Text message", which could only ever fail: no user has a phone number and this pool's
     * SMS role was deleted. The screen now renders `nextStep.allowedMFATypes`, so it shows
     * what Cognito will actually accept.
     */
    case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION":
      return { screen: "mfaSelection", message: null };

    // Choosing what to ENROL, not what to use. See `mfaSetupSelection` above.
    case "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION":
      return { screen: "mfaSetupSelection", message: null };

    case "RESET_PASSWORD":
      return {
        screen: "forgotPassword",
        message: "Your password needs to be reset before you can sign in.",
      };

    default:
      // Now covers only the PASSWORDLESS first-factor steps (WebAuthn, and email/SMS used as
      // a first factor rather than a second), which this pool does not enable. Email OTP as a
      // SECOND factor is handled above. Naming the step keeps a misconfiguration diagnosable
      // instead of mysterious.
      return {
        screen: "signIn",
        message: `This account needs a sign-in step we don't support yet (${step}). Please contact your facilitator.`,
      };
  }
}

/**
 * Turn an Amplify/Cognito error into copy a user can act on.
 *
 * Cognito's raw messages range from usable to actively misleading — a wrong TOTP
 * code arrives as "Invalid session for the user", which tells the user nothing
 * about the six digits they just typed. The `name` field is the stable contract
 * (the message text is not), so the mapping keys on it.
 */
export function authErrorMessage(error: unknown): string {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  const raw =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : "";

  switch (name) {
    case "UserNotFoundException":
    case "NotAuthorizedException":
      // NotAuthorizedException is heavily OVERLOADED by Cognito: a wrong password, a
      // deactivated user, a disabled auth flow, and a pool with self-service sign-up
      // turned off all arrive under this one name. Collapsing them all into the
      // credential message once made a pool-level lockdown look like user error — an
      // invited user was told their email or password was wrong on a screen where the
      // email is locked and server-issued, so no retry could ever succeed. Branch on
      // the raw text FIRST, then fall through to the credential message.
      //
      // Safe against account enumeration, which is what the message below protects:
      // this response is identical for every address (the pool is shut to all of
      // them), so it discloses nothing about who is registered.
      if (/SignUp is not permitted/i.test(raw)) {
        return "Registration isn't available right now. Please contact your facilitator or an administrator.";
      }
      // Deliberately the SAME message for the remaining cases: distinguishing "no
      // such user" from "wrong password" tells an attacker which addresses are
      // registered. The account-enumeration protection is only worth having if the
      // UI honours it.
      return "Incorrect email or password.";

    case "UserNotConfirmedException":
      return "Your email isn't confirmed yet. Check your inbox for the code.";

    case "PasswordResetRequiredException":
      return "Your password needs to be reset. Use “Forgot password”.";

    case "CodeMismatchException":
      return "That code isn't right. Check the six digits and try again.";

    case "ExpiredCodeException":
      return "That code has expired. Request a new one.";

    case "EnableSoftwareTokenMFAException":
      // What a wrong code during TOTP ENROLMENT looks like. Worth its own copy: the
      // usual cause is a clock-skewed device, which the user can actually fix.
      return "That code wasn't accepted. Make sure your authenticator's clock is correct, then try the current code.";

    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "Too many attempts. Please wait a few minutes and try again.";

    case "InvalidPasswordException":
      // Cognito's own text here names the specific unmet rule, so it beats ours.
      return raw || "That password doesn't meet the requirements.";

    case "UsernameExistsException":
      return "An account with that email already exists. Try signing in instead.";

    case "InvalidParameterException":
      return raw || "Something in that form wasn't valid.";

    case "UserLambdaValidationException":
      // The PRE-SIGNUP trigger raises this to enforce invite-only signup, and its
      // message is the actual reason, prefixed by Cognito with noise.
      return cleanLambdaValidationMessage(raw);

    case "SignInException":
      return raw || "Sign-in couldn't be completed. Please start again.";

    default:
      return raw || "Something went wrong. Please try again.";
  }
}

/**
 * Strip Cognito's wrapper from a Lambda-trigger error so the trigger's own message
 * reaches the user.
 *
 * Cognito reports a thrown trigger error as e.g.
 *   "PreSignUp failed with error This email has not been invited.."
 * The prefix is noise to a user, and the invite-only rule is exactly the case where
 * a clear explanation matters most — that message is why they can't sign up.
 */
export function cleanLambdaValidationMessage(raw: string): string {
  const match = raw.match(/failed with error\s+(.*?)\.?\.?$/i);
  const inner = match?.[1]?.trim();
  if (inner) return inner.endsWith(".") ? inner : `${inner}.`;
  return raw || "Sign-up was rejected.";
}

/**
 * The `otpauth://` URI for the authenticator QR code.
 *
 * Kept here (rather than only calling Amplify's `getSetupUri`) so the issuer label
 * is one constant: it becomes the account name the user sees in their authenticator
 * app forever, and it must not vary between screens or environments.
 */
export const TOTP_ISSUER = "Praimana";
