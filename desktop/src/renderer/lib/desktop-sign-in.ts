// ── THE DESKTOP'S SIGN-IN CONVERSATION ──────────────────────────────────────────
//
// Amplify's `signIn`/`confirmSignIn` do not return "signed in" or "failed" — they return a
// `nextStep` naming what the user must do next, and the caller drives the rest. This module is
// that driver, kept out of the component so it is testable without a DOM.
//
// ── ⚠ THE DESKTOP HANDLES TWO STEPS, NOT SEVEN ──
//
// Reaching the desktop at all requires a completed portal sign-in: `/welcome` is not in the
// portal's `PUBLIC_PATHS`, and "Open desktop app" lives there. So by construction the user has
// already confirmed their email, enrolled TOTP, and cleared any forced password change.
//
//   HANDLED    password → TOTP code. That is the whole happy path.
//   DEFERRED   TOTP setup, new-password-required, confirm-sign-up, reset-password.
//
// ⚠ DEFERRED IS NOT THE SAME AS IMPOSSIBLE, which is why they are handled at all. Cognito
// decides which step comes back, not us: an admin resetting someone's password mid-workshop
// makes `NEW_PASSWORD_REQUIRED` appear for a user who signed in on the web yesterday. Those
// steps route to "finish this on the website" — one branch, no extra screens. Falling through
// to a dead end there would present as the app being broken.
//
// This is also why `screenForSignInStep` is imported WHOLE from the shared package rather than
// trimmed to two cases: it already names every step, and the mapping is where
// drift is a security event.
//
// ── ⚠ NO AUTO-RESUME. THE PORTAL HAS ONE; THIS MUST NOT. ──
//
// `AuthFlow.tsx:255-293` calls `fetchAuthSession()` on mount and signs the user straight in if
// Amplify still holds a session. A governing security condition forbids porting it, and the reason
// is concrete: it would be a SECOND session authority racing main's, and on a shared machine it
// would silently sign in whoever used the app last — colliding with `switchAccount`. Entry here
// is always the form.

import {
  signIn as amplifySignIn,
  confirmSignIn as amplifyConfirmSignIn,
  signOut as amplifySignOut,
  fetchAuthSession,
} from "aws-amplify/auth";
import { screenForSignInStep, authErrorMessage } from "@praimana/shared";

/**
 * The factor names Cognito accepts as a challenge response.
 *
 * SMS is included though this pool enables no SMS factor: the union describes what COGNITO can
 * ask for, and the screen renders only what it does ask for. Trimming it is how the UI becomes
 * unable to render a factor someone enables later.
 */
export const FACTOR_CHOICES = ["TOTP", "EMAIL", "SMS"] as const;
export type FactorChoice = (typeof FACTOR_CHOICES)[number];

const isFactorChoice = (v: string): v is FactorChoice =>
  (FACTOR_CHOICES as readonly string[]).includes(v);

/** What the caller should do next. */
export type SignInOutcome =
  /**
   * Tokens in hand. BOTH must be handed to main immediately — see `clearRendererTokens`.
   *
   * ⚠ THE REFRESH TOKEN IS WHY THIS CARRIES TWO. Amplify holds it in the renderer's IN-MEMORY
   * store (`localStorage` in Electron is unencrypted LevelDB), so it dies with
   * the window. Without passing it to main, a session would last the ID token's ~30 minutes and
   * then end with no way to renew.
   *
   * `refreshToken` is optional because Cognito is not obliged to return one, and a sign-in that
   * succeeded must not be rejected for its absence — main degrades to a 30-minute session
   * rather than failing outright.
   */
  | { status: "done"; idToken: string; refreshToken?: string }
  /** Show the six-digit field for an authenticator app. */
  | { status: "totp" }
  /**
   * Show the six-digit field for a code sent by EMAIL.
   *
   * ⚠ A SEPARATE STATUS FROM `totp`, THOUGH THE FIELD IS IDENTICAL. The copy is the whole point:
   * "enter the code from your authenticator" sends someone hunting for an app when the code is
   * sitting in their inbox. Collapsing the two would save a line here and cost the user the one
   * piece of information they need.
   */
  | { status: "emailCode" }
  /**
   * Cognito wants to know WHICH enrolled factor to use. `options` is what it will accept, in the
   * order it gave them.
   *
   * ⚠ THE LIST IS NOT INVENTED HERE. It is `nextStep.allowedMFATypes`, filtered to the names this
   * app can actually submit. The portal shipped a hardcoded "Authenticator app / Text message"
   * pair and the SMS half could never work — no user has a phone number and the pool enables no
   * SMS factor — so the one screen a locked-out user reaches offered them a dead button. Rendering
   * what Cognito named is the fix, and it is worth not repeating.
   */
  | { status: "chooseFactor"; options: FactorChoice[] }
  /**
   * Cognito needs a step the desktop deliberately does not implement. `message` names it in
   * terms of what the user should do, and `onWebsite` tells the UI to offer a link out.
   */
  | { status: "useWebsite"; message: string }
  /** Something failed. `message` is already user-facing (`authErrorMessage`). */
  | { status: "error"; message: string };

/**
 * The Amplify steps the desktop routes to the website.
 *
 * Keyed on the SCREEN the shared state machine resolves to, not on the raw step string: the
 * screen names are ours and stable, while Cognito's step vocabulary is theirs and can grow.
 * A new step we have never seen resolves to `signIn` with an explanatory message, which the
 * `default` branch below turns into a `useWebsite` outcome rather than a silent retry loop.
 */
const WEBSITE_SCREENS = new Set([
  "totpSetup",
  /**
   * ⚠ EMAIL *SETUP* IS DEFERRED WHILE EMAIL *CHALLENGE* IS HANDLED. Choosing which address
   * receives codes is enrolment, and enrolment belongs where the account was created — the same
   * call this file already makes for `totpSetup`. Reaching the desktop requires a completed
   * portal sign-in, so a user arriving here with MFA still unenrolled is the exception, not the
   * path.
   */
  "emailSetup",
  "newPasswordRequired",
  "confirmSignUp",
  "forgotPassword",
  "resetPassword",
  /**
   * ⚠ `mfaSelection` IS NO LONGER HERE — it is handled above. `mfaSetupSelection` replaces it:
   * every branch out of a SETUP choice ends in enrolment, so offering the choice here would be a
   * two-step dead end (pick a factor, then be sent to the website anyway).
   */
  "mfaSetupSelection",
  "smsChallenge",
  "completeProfile",
]);

/** Copy for the deferred steps, in terms of what the user should DO. */
const WEBSITE_MESSAGES: Record<string, string> = {
  totpSetup:
    "Your account still needs an authenticator app. Set it up on the website, then sign in here.",
  newPasswordRequired:
    "Your password needs changing before you can sign in. Do that on the website, then come back.",
  confirmSignUp: "Your email isn't confirmed yet. Finish that on the website, then sign in here.",
  forgotPassword: "Reset your password on the website, then sign in here.",
  resetPassword: "Reset your password on the website, then sign in here.",
  mfaSetupSelection:
    "This account still needs a sign-in method set up. Choose one on the website, then sign in here.",
  emailSetup:
    "Your account still needs email verification set up. Do that on the website, then sign in here.",
  smsChallenge: "This account uses SMS codes, which the desktop app doesn't support yet.",
  completeProfile: "Finish setting up your profile on the website, then sign in here.",
};

/** Amplify's `nextStep`, structurally — so this module needs no SDK types. */
interface NextStepLike {
  signInStep?: string;
  /** Present on the selection steps; Cognito's own list of what it will accept. */
  allowedMFATypes?: readonly string[];
}

/**
 * Turn a `nextStep` into an outcome.
 *
 * Exported for the tests, which drive every branch without the SDK. That is the point of
 * keeping it separate: the mapping is the part that must not silently gain a dead end.
 */
export function outcomeForStep(
  nextStep: NextStepLike,
  tokens: { idToken: string | null; refreshToken?: string }
): SignInOutcome {
  const step = nextStep?.signInStep ?? "";
  const { screen, message } = screenForSignInStep(step);

  if (screen === "done") {
    const idToken = tokens?.idToken ?? null;
    if (!idToken) {
      // Cognito said DONE but no token materialised. Reported rather than treated as success:
      // a "signed in" state with no bearer fails at the first API call, far from the cause.
      return { status: "error", message: "Signed in, but no session was returned. Please retry." };
    }
    return { status: "done", idToken, refreshToken: tokens?.refreshToken };
  }

  if (screen === "totpChallenge") return { status: "totp" };

  /**
   * ⚠ HANDLED HERE, NOT DEFERRED — and the split follows this file's existing rule: a CHALLENGE
   * is handled, ENROLMENT goes to the website. An email code is a challenge, exactly like a TOTP
   * code, so sending the user to a browser to type six digits would be gratuitous.
   *
   * It is reachable because EMAIL_OTP is enabled on the pool, which is needed
   * because a lost authenticator was otherwise an unrecoverable lockout — Cognito has no API to
   * delete a TOTP secret. Before that, this step fell to the default branch below and told the
   * user their account "needs a sign-in step the desktop app doesn't support", i.e. the one factor
   * added to rescue locked-out users would have locked them out of the desktop.
   */
  if (screen === "emailChallenge") return { status: "emailCode" };

  /**
   * ⚠ HANDLED, WHILE `mfaSetupSelection` IS STILL DEFERRED. Choosing which ENROLLED factor to use
   * is a challenge, so it belongs here; choosing which to ENROL leads to a QR code or an address
   * to register, which this app does not render.
   *
   * It is a routine step because EMAIL_OTP is enabled — a user with both factors
   * and no stated preference is asked every time. Before this it routed to the website, so
   * enrolling a second factor made the desktop STOP WORKING for that user.
   *
   * An empty or unrecognised list falls through to `useWebsite` rather than rendering a screen
   * with no buttons: a dead end with an explanation beats one without.
   */
  if (screen === "mfaSelection") {
    const options = (nextStep?.allowedMFATypes ?? []).filter(isFactorChoice);
    if (options.length > 0) return { status: "chooseFactor", options };
  }

  if (WEBSITE_SCREENS.has(screen)) {
    return { status: "useWebsite", message: WEBSITE_MESSAGES[screen] ?? message ?? "" };
  }

  /**
   * An UNRECOGNISED step. It must never fall back to re-showing the password form: the user
   * would type a correct password repeatedly, succeed every time, and never get in — the exact
   * dead end the shared state machine's own `default` branch exists to prevent. Surfaced with
   * the step named, so a pool misconfiguration is diagnosable rather than mysterious.
   */
  return {
    status: "useWebsite",
    message: message || `This account needs a sign-in step the desktop app doesn't support (${step}).`,
  };
}

/**
 * Read the tokens Amplify is holding.
 *
 * ⚠ THE REFRESH TOKEN IS NOT ON `session.tokens`. Amplify v6 exposes only the ID and access
 * tokens there, so it is read from the in-memory key-value store Amplify was configured with —
 * the same store `clearRendererTokens` wipes. The key format is
 * `CognitoIdentityServiceProvider.<clientId>.<username>.refreshToken`, so it is found by suffix
 * rather than by reconstructing a username we would have to guess.
 */
async function currentTokens(): Promise<{ idToken: string | null; refreshToken?: string }> {
  try {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString() ?? null;
    const refreshToken = await readRefreshTokenFromStore();
    return { idToken, refreshToken };
  } catch {
    return { idToken: null };
  }
}

/**
 * Pull the refresh token out of the in-memory store.
 *
 * Deliberately tolerant: if Amplify's key format changes, this returns undefined and the session
 * degrades to 30 minutes rather than the sign-in failing. A hard dependency on an SDK-internal
 * key shape is not worth a broken login.
 */
async function readRefreshTokenFromStore(): Promise<string | undefined> {
  try {
    const { amplifyTokenStorage } = await import("./amplify-memory-storage");
    for (const key of amplifyTokenStorage.keys()) {
      if (key.endsWith(".refreshToken")) {
        const value = await amplifyTokenStorage.getItem(key);
        if (value) return value;
      }
    }
  } catch {
    /* Fall through — a 30-minute session is better than a failed sign-in. */
  }
  return undefined;
}

/**
 * Step 1: email + password.
 *
 * ⚠ CLEARS ANY LINGERING AMPLIFY SESSION FIRST. With tokens still held, `signIn()` throws
 * `UserAlreadyAuthenticatedException` and NOTHING the user types can succeed — the portal hit
 * this and documents it (`AuthFlow.tsx:514-525`). It is more likely here: main owns the real
 * session, so the renderer's copy is routinely stale after a sign-out or a platform change.
 * Clearing up front turns a dead end into an ordinary sign-in.
 */
export async function submitPassword(email: string, password: string): Promise<SignInOutcome> {
  try {
    // Best-effort: there is usually nothing to sign out of, and failing to clear a session that
    // does not exist must not block the sign-in that follows.
    await amplifySignOut().catch(() => {});

    const { nextStep } = await amplifySignIn({ username: email.trim(), password });
    return outcomeForStep(nextStep, await currentTokens());
  } catch (err) {
    return { status: "error", message: authErrorMessage(err) };
  }
}

/**
 * Step 2: the six-digit code — from an authenticator app OR from an email.
 *
 * ⚠ RENAMED FROM `submitTotp`, because it never was TOTP-specific: `confirmSignIn` takes whatever
 * the current challenge expects, and Cognito decides which that is. The old name would have had
 * the email path calling a function whose name says otherwise, which is how someone later "fixes"
 * it by adding a second, identical function.
 *
 * Cognito can return a FURTHER step here (it does not, for this pool, but it is allowed to), so
 * the result goes through the same mapping rather than being assumed to be `done`.
 */
export async function submitChallengeCode(code: string): Promise<SignInOutcome> {
  try {
    const { nextStep } = await amplifyConfirmSignIn({ challengeResponse: code.trim() });
    return outcomeForStep(nextStep, await currentTokens());
  } catch (err) {
    return { status: "error", message: authErrorMessage(err) };
  }
}

/**
 * Answer a factor-selection challenge with the chosen factor.
 *
 * ⚠ THE ANSWER IS THE FACTOR NAME, NOT A CODE — `confirmSignIn` takes whatever the CURRENT
 * challenge expects, and here that is "TOTP" / "EMAIL" / "SMS". Cognito's reply is the next step (a
 * code prompt), so it goes back through `outcomeForStep` exactly like any other answer.
 *
 * Choosing EMAIL is also what makes Cognito SEND the message, so a failure here has to surface
 * rather than leave someone waiting for mail that was never triggered.
 */
export async function submitFactorChoice(choice: FactorChoice): Promise<SignInOutcome> {
  try {
    const { nextStep } = await amplifyConfirmSignIn({ challengeResponse: choice });
    return outcomeForStep(nextStep, await currentTokens());
  } catch (err) {
    return { status: "error", message: authErrorMessage(err) };
  }
}

/**
 * Abandon a half-finished sign-in.
 *
 * Called when the user backs out of the TOTP screen. Without it, Amplify keeps the challenge
 * state and the next attempt throws `UserAlreadyAuthenticatedException` — the same trap
 * `submitPassword` guards against, reached from the other direction.
 */
export async function abandonSignIn(): Promise<void> {
  await amplifySignOut().catch(() => {});
}
