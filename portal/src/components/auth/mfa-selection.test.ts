// ── ⚠ THE MFA CHOICES COME FROM COGNITO, NOT FROM A HARDCODED PAIR ───────────────────────
//
// REPORTED, with a screenshot of the portal: "Choose a verification method, Authenticator app /
// Text message, Send a code to your phone".
//
// ⚠ THAT SECOND BUTTON COULD NEVER WORK, and it was offered at the worst possible moment. The pool
// enables SOFTWARE_TOKEN_MFA and EMAIL_OTP and does NOT enable SMS_MFA; not one of the 30 users has
// a `phone_number` attribute; and the pool's SNS caller role had been DELETED (`NoSuchEntity`),
// which is separately why the Cognito console could not save this pool's MFA page at all. So a
// participant locked out of their authenticator would pick "Text message", the only other option
//, and fail. Meanwhile Email, which does work, was not on the screen.
//
// The fix is not to swap one hardcoded pair for another: it is to render `nextStep.allowedMFATypes`,
// which is Cognito telling us what it will accept. These tests pin that, because the hardcoded form
// looks perfectly reasonable in review.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments describe what the code must not do, so absence checks must not read them. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const flow = strip(readFileSync(join(__dirname, "AuthFlow.tsx"), "utf8"));

describe("⚠ the selection screen renders what Cognito offered", () => {
  it("maps over the allowed factors instead of listing buttons by hand", () => {
    expect(flow, "the offered list is stored").toMatch(/setAllowedMfa\(/);
    expect(flow, "and rendered by iteration").toMatch(/allowedMfa\.map\(/);
  });

  it("takes the list from the step Cognito returned", () => {
    expect(flow).toMatch(/allowedMFATypes/);
    expect(flow, "filtered to names we can actually send").toMatch(
      /allowedMFATypes\.filter\(isMfaChoice\)/
    );
  });

  /**
   * ⚠ THE ACTUAL REGRESSION, NAMED. A literal `chooseMfa("SMS")` call site is exactly what was
   * there, and it is what a future tidy-up would restore.
   */
  it("has no hardcoded SMS button", () => {
    expect(flow).not.toMatch(/chooseMfa\("SMS"\)/);
    expect(flow, "nor a hand-written label for it").not.toMatch(/>Text message</);
  });

  it("has no hardcoded TOTP button either, the point is the data, not the factor", () => {
    expect(flow).not.toMatch(/chooseMfa\("TOTP"\)/);
  });

  /**
   * SMS stays in the TYPE while absent from the pool: the union describes what Cognito can ask
   * for, and the screen shows what it does ask for. Trimming the union is how the UI becomes
   * unable to render a factor someone enables later.
   */
  it("can still describe SMS if the pool ever enables it", () => {
    expect(flow).toMatch(/MFA_CHOICES = \["TOTP", "EMAIL", "SMS"\]/);
    for (const factor of ["TOTP", "EMAIL", "SMS"]) {
      expect(flow, `${factor} needs a label`).toMatch(new RegExp(`${factor}: \\{`));
    }
  });

  /**
   * ⚠ DEFAULTS TO TOTP ALONE, NOT TO EVERYTHING. If a selection screen is somehow reached without
   * Cognito having said what it accepts, showing a button that cannot work is worse than showing
   * one that can, which is the whole bug this file is about.
   */
  it("defaults to the factor this pool has always had", () => {
    expect(flow).toMatch(/useState<readonly MfaChoice\[\]>\(\["TOTP"\]\)/);
  });
});

describe("⚠ both selection steps still render, despite being split apart", () => {
  /**
   * ⚠ THE SPLIT COULD HAVE STRANDED ONE OF THEM. `CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION` was
   * separated from `MFA_SELECTION` so the DESKTOP could defer setup while handling the challenge -
   * but the portal completes both, so a screen check for only `mfaSelection` would leave the setup
   * case rendering nothing: a signed-out user stuck on a blank screen at first sign-in.
   */
  it("renders the setup selection as well as the use-now one", () => {
    expect(flow).toMatch(/screen === "mfaSelection" \|\| screen === "mfaSetupSelection"/);
  });
});

describe("⚠ email enrolment does not stall", () => {
  /**
   * `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP` asks WHERE to send codes, and the only address Cognito
   * accepts is the account's own, which the user typed on the sign-in form seconds earlier. It is
   * answered directly rather than with a form whose one correct value is already known.
   */
  it("answers the setup step with the address already in hand", () => {
    expect(flow).toMatch(/CONTINUE_SIGN_IN_WITH_EMAIL_SETUP/);
    expect(flow).toMatch(/submitEmailSetup\(email\)/);
  });

  /**
   * ⚠ AND THE SETUP SCREEN STILL RENDERS SOMETHING. If that auto-answer ever routes back to
   * `emailSetup` instead of onward, a user must see a code field rather than a spinner that never
   * resolves, the dead end this whole state machine exists to prevent.
   */
  it("renders a code field for emailSetup as well as emailChallenge", () => {
    expect(flow).toMatch(/screen === "emailChallenge" \|\| screen === "emailSetup"/);
  });

  it("tells the user which address the code went to", () => {
    expect(flow).toMatch(/Enter the code we sent to \$\{email\}/);
  });
});
