// The step mapping is where a custom auth UI dead-ends: some real Cognito branch leaves the
// user staring at a form that succeeds every time and never gets them in.
//
// So the assertion that matters most here is the NEGATIVE one — no step, known or unknown, may
// resolve back to "type your password again". Everything the desktop does not implement must
// route somewhere with a next action.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The SDK is never exercised: `outcomeForStep` is pure, which is why it was split out. Mocked
// so importing the module under test does not pull Amplify into a node-only test run.
vi.mock("aws-amplify/auth", () => ({
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  signOut: vi.fn(),
  fetchAuthSession: vi.fn(),
}));

import { outcomeForStep } from "./desktop-sign-in";

const TOKEN = "an-id-token";

describe("outcomeForStep — the happy path", () => {
  it("resolves DONE with a token to a finished sign-in", () => {
    expect(outcomeForStep({ signInStep: "DONE" }, { idToken: TOKEN })).toEqual({
      status: "done",
      idToken: TOKEN,
      refreshToken: undefined,
    });
  });

  /**
   * ⚠ THE REFRESH TOKEN MUST BE CARRIED THROUGH. Amplify holds it in the renderer's in-memory
   * store, which dies with the window — so if this outcome dropped it, main would hold only a
   * ~30-minute ID token and every session would end with no way to renew.
   */
  it("carries the refresh token through to the outcome", () => {
    const result = outcomeForStep({ signInStep: "DONE" }, {
      idToken: TOKEN,
      refreshToken: "a-refresh-token",
    });
    expect(result).toEqual({ status: "done", idToken: TOKEN, refreshToken: "a-refresh-token" });
  });

  /**
   * A sign-in that SUCCEEDED must not be rejected because Cognito returned no refresh token —
   * main degrades to a 30-minute session rather than failing outright.
   */
  it("still succeeds without a refresh token", () => {
    expect(outcomeForStep({ signInStep: "DONE" }, { idToken: TOKEN }).status).toBe("done");
  });

  it("resolves the TOTP challenge to the six-digit screen", () => {
    // MFA is ON for this pool, so EVERY sign-in lands here. It is the only extra step the
    // desktop implements.
    expect(outcomeForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" }, { idToken: null })).toEqual({
      status: "totp",
    });
  });

  /**
   * ── ⚠ EMAIL CODES, AND WHY THE DESKTOP HANDLES THEM ────────────────────────────────────
   *
   * EMAIL_OTP is enabled on the pool because a lost authenticator was otherwise an
   * UNRECOVERABLE LOCKOUT: Cognito has no API to delete a user's TOTP secret, so an admin cannot
   * reset it and the account is finished.
   *
   * ⚠ BEFORE THIS, THE STEP FELL TO THE `useWebsite` DEFAULT — so the factor added specifically to
   * rescue locked-out users would have locked them out of the DESKTOP, telling them their account
   * "needs a sign-in step the desktop app doesn't support". That is the failure this pins.
   */
  it("resolves an EMAIL code challenge to the six-digit screen, not to the website", () => {
    expect(
      outcomeForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_EMAIL_CODE" }, { idToken: null })
    ).toEqual({ status: "emailCode" });
  });

  /**
   * ⚠ DISTINCT FROM `totp`, DELIBERATELY. The field is identical; the copy is not. "Open your
   * authenticator app" sends someone hunting for an app they may have just uninstalled — which is
   * the exact situation email exists to rescue.
   */
  it("distinguishes an email code from an authenticator code", () => {
    const email = outcomeForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_EMAIL_CODE" }, { idToken: null });
    const totp = outcomeForStep({ signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" }, { idToken: null });
    expect(email.status).not.toBe(totp.status);
  });

  /**
   * ── ⚠ CHOOSING WHICH ENROLLED FACTOR TO USE ────────────────────────────────────────────
   *
   * Routine as soon as a user has two factors and no stated preference — which EMAIL_OTP made
   * ordinary. Before this it routed to the website, so ENROLLING A SECOND FACTOR made the desktop
   * stop working for that user: the safety net became the trap.
   */
  it("offers the factors Cognito named, in its order", () => {
    const result = outcomeForStep(
      { signInStep: "CONTINUE_SIGN_IN_WITH_MFA_SELECTION", allowedMFATypes: ["EMAIL", "TOTP"] },
      { idToken: null }
    );
    expect(result).toEqual({ status: "chooseFactor", options: ["EMAIL", "TOTP"] });
  });

  /**
   * ⚠ NOT A HARDCODED PAIR. The portal shipped "Authenticator app / Text message" where SMS could
   * never work — the pool enables no SMS factor and no user has a phone_number — so the one screen
   * a locked-out participant reaches gave them a dead button. Only what Cognito names is offered.
   */
  it("offers only what Cognito named, dropping anything it cannot submit", () => {
    const result = outcomeForStep(
      { signInStep: "CONTINUE_SIGN_IN_WITH_MFA_SELECTION", allowedMFATypes: ["TOTP", "CARRIER_PIGEON"] },
      { idToken: null }
    );
    if (result.status !== "chooseFactor") throw new Error("unreachable");
    expect(result.options).toEqual(["TOTP"]);
  });

  /**
   * ⚠ AN EMPTY LIST MUST NOT RENDER AN EMPTY SCREEN. A chooser with no buttons is a dead end with
   * no explanation, which is strictly worse than being told to use the website.
   */
  it("falls back to the website rather than showing a chooser with nothing in it", () => {
    const result = outcomeForStep(
      { signInStep: "CONTINUE_SIGN_IN_WITH_MFA_SELECTION", allowedMFATypes: [] },
      { idToken: null }
    );
    expect(result.status).toBe("useWebsite");
  });

  /**
   * ⚠ THE SPLIT THAT MAKES THIS SAFE. Choosing which factor to ENROL leads to a QR code or an
   * address to register — neither of which this app renders. Offering that choice would be a
   * two-step dead end: pick a factor, then be sent to the website anyway.
   */
  it("still defers the SETUP selection, which it cannot complete", () => {
    const result = outcomeForStep(
      {
        signInStep: "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION",
        allowedMFATypes: ["EMAIL", "TOTP"],
      },
      { idToken: null }
    );
    expect(result.status).toBe("useWebsite");
    if (result.status !== "useWebsite") throw new Error("unreachable");
    expect(result.message).not.toMatch(/CONTINUE_SIGN_IN|SETUP_SELECTION/);
  });

  /**
   * ⚠ DONE WITHOUT A TOKEN IS AN ERROR, NOT A SUCCESS. Treating it as signed-in would produce
   * an app that says "welcome" and then fails at its first API call, far from the cause.
   */
  it("refuses DONE when no token materialised", () => {
    const result = outcomeForStep({ signInStep: "DONE" }, { idToken: null });
    expect(result.status).toBe("error");
  });
});

describe("outcomeForStep — steps the desktop defers to the website", () => {
  /**
   * Each of these is REACHABLE despite the user having signed in on the portal to get here.
   * `NEW_PASSWORD_REQUIRED` is the clearest case: an admin resetting a password mid-workshop
   * produces it for someone who signed in on the web yesterday.
   */
  it.each([
    "CONTINUE_SIGN_IN_WITH_TOTP_SETUP",
    "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED",
    "CONFIRM_SIGN_UP",
    "RESET_PASSWORD",
    /**
     * ⚠ `CONTINUE_SIGN_IN_WITH_MFA_SELECTION` WAS REMOVED FROM THIS LIST — it is handled in-app
     * now, and asserted above. Only the SETUP selection is still deferred.
     */
    "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION",
    "CONFIRM_SIGN_IN_WITH_SMS_CODE",
    /**
     * ⚠ EMAIL *SETUP* STAYS ON THE WEBSITE while email *challenge* is handled above. Choosing
     * which address receives codes is enrolment, and this file's rule is that enrolment happens
     * where the account was created. Handling one and not the other is the intended asymmetry, so
     * it is asserted on both sides rather than left to be inferred.
     */
    "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP",
  ])("routes %s to the website with an actionable message", (step) => {
    const result = outcomeForStep({ signInStep: step }, { idToken: null });
    expect(result.status).toBe("useWebsite");
    if (result.status !== "useWebsite") throw new Error("unreachable");
    // Not empty, and long enough to be a sentence rather than a label.
    expect(result.message.length).toBeGreaterThan(20);
  });

  /**
   * ⚠ EXPLICITLY DEFERRED, NOT MERELY FALLING THROUGH — and mutation testing is what found the
   * difference. Removing `emailSetup` from WEBSITE_SCREENS still yields a `useWebsite` outcome,
   * because the DEFAULT branch does too. The suite passed on both, so it was asserting nothing.
   *
   * The distinction is user-visible: the fallback message names the raw Cognito step, so a
   * participant would read "needs a sign-in step the desktop app doesn't support
   * (CONTINUE_SIGN_IN_WITH_EMAIL_SETUP)" instead of being told what to do.
   */
  it("gives email setup its own copy rather than the fallback that leaks the step name", () => {
    const result = outcomeForStep(
      { signInStep: "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP" },
      { idToken: null }
    );
    if (result.status !== "useWebsite") throw new Error("unreachable");
    expect(result.message).not.toMatch(/CONTINUE_SIGN_IN|EMAIL_SETUP|signInStep/);
    expect(result.message, "names the thing to do").toMatch(/website/i);
  });

  it("tells the user what to DO, not what Cognito called it", () => {
    const result = outcomeForStep({ signInStep: "CONTINUE_SIGN_IN_WITH_TOTP_SETUP" }, { idToken: null });
    if (result.status !== "useWebsite") throw new Error("unreachable");
    expect(result.message).toMatch(/website/i);
    // Cognito's own vocabulary must not leak into copy a participant reads.
    expect(result.message).not.toMatch(/CONTINUE_SIGN_IN|signInStep|TOTP_SETUP/);
  });
});

describe("outcomeForStep — ⚠ NO DEAD ENDS", () => {
  /**
   * THE ASSERTION THE WHOLE FILE EXISTS FOR.
   *
   * If an unrecognised step resolved to the password form, the user would type a correct
   * password over and over, succeed every time, and never get in — with no error to explain it.
   * Every step must produce an outcome that has a next action.
   */
  it.each([
    "",
    "SOME_FUTURE_STEP",
    "CONTINUE_SIGN_IN_WITH_EMAIL_OTP",
    "CONTINUE_SIGN_IN_WITH_PASSWORDLESS",
    "garbage",
  ])("never resolves %s to a silent retry", (step) => {
    const result = outcomeForStep({ signInStep: step }, { idToken: null });
    // Anything but a bare re-render of the form.
    expect(["useWebsite", "error", "totp", "done"]).toContain(result.status);
    if (result.status === "useWebsite" || result.status === "error") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("names an unknown step so a pool misconfiguration is diagnosable", () => {
    const result = outcomeForStep({ signInStep: "SOME_FUTURE_STEP" }, { idToken: null });
    if (result.status !== "useWebsite") throw new Error("unreachable");
    expect(result.message).toContain("SOME_FUTURE_STEP");
  });

  it("survives a missing or malformed nextStep", () => {
    // Defensive: this is SDK output, and an undefined `signInStep` must not throw inside a
    // click handler where the error would surface as a frozen button.
    expect(() => outcomeForStep({}, { idToken: null })).not.toThrow();
    expect(() => outcomeForStep({ signInStep: undefined }, { idToken: null })).not.toThrow();
    expect(outcomeForStep({}, { idToken: null }).status).toBe("useWebsite");
    // And a missing tokens object entirely — this is SDK-adjacent input.
    expect(() =>
      outcomeForStep({ signInStep: "DONE" }, undefined as unknown as { idToken: null })
    ).not.toThrow();
  });
});

describe("the module's shape", () => {
  // Comments stripped: this module's comments discuss `useEffect` and "resume" precisely to
  // explain why they are absent, so a raw match would find the explanation and fail.
  const src = readFileSync(
    fileURLToPath(new URL("./desktop-sign-in.ts", import.meta.url)),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /**
   * ⚠ NO AUTO-RESUME: a renderer-side resume is a SECOND session
   * authority racing main's, and on a shared machine it silently signs in whoever used the app
   * last — colliding with `switchAccount`. The portal has one deliberately; the desktop must
   * not.
   *
   * `fetchAuthSession` IS used, but only to read the token after a step completes — never on
   * mount to skip the form. The distinction is whether it appears in an effect, so this asserts
   * on the exported surface instead: there is no "resume" entry point to call.
   */
  it("exports no resume path", () => {
    expect(src).not.toMatch(/export .*\bresume\b/i);
    expect(src).not.toMatch(/useEffect/);
  });

  /**
   * ⚠ SIGN OUT BEFORE SIGN IN. Without it, a lingering Amplify session makes `signIn()` throw
   * `UserAlreadyAuthenticatedException` and nothing the user types can work. More likely in the
   * desktop than the portal: main owns the real session, so the renderer's copy is routinely
   * stale after a sign-out or a platform change.
   */
  it("clears any lingering session before attempting a password sign-in", () => {
    const submit = src.slice(src.indexOf("export async function submitPassword"));
    const signOutAt = submit.indexOf("amplifySignOut");
    const signInAt = submit.indexOf("amplifySignIn");
    expect(signOutAt).toBeGreaterThan(-1);
    expect(signInAt).toBeGreaterThan(signOutAt);
  });

  /** The state machine is imported, not reimplemented. */
  it("uses the SHARED state machine rather than its own step map", () => {
    expect(src).toMatch(/from "@praimana\/shared"/);
    expect(src).toContain("screenForSignInStep");
    expect(src).toContain("authErrorMessage");
  });
});
