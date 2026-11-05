import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

/**
 * ── THE DESKTOP'S BRAND MUST NOT DRIFT ─────────────────────────────────────────────────────
 *
 * The sign-in and connect screens carry their own copies of the product name, the logo and the copyright
 * year, because they cannot import the portal's `BrandMark` — it depends on `next/image` and `next/link`.
 * Copies drift, so something has to check them.
 *
 * ── ⚠ THIS TEST USED TO READ THE PORTAL'S FILES, AND DELIBERATELY NO LONGER DOES ──
 *
 * It once compared these values against the portal's `BrandMark.tsx` and its `icon-192.png`, which was
 * the strongest form of this check. This repo must have NO link
 * to another repo, and a test that reads one is a link — whether it fails, or skips politely when the other
 * repo is absent.
 *
 * ⚠ WHAT WAS LOST, SAID PLAINLY RATHER THAN QUIETLY: nothing here can detect the PORTAL changing. Rename the
 * product or replace the logo over there and this suite stays green while the two apps diverge, until a
 * person notices. The constants below are pinned to the portal's values as of extraction, so
 * what remains is drift detection on the DESKTOP side — half the original guarantee.
 *
 * Restoring the other half needs one of: a brand package both repos depend on, a CI job that checks out both
 * and diffs them, or publishing the assets somewhere both consume. Until then these pins ARE the contract,
 * and changing one should reference the portal change that caused it.
 */

/**
 * Pinned to the portal at extraction. Change ONLY in response to a portal change.
 *
 * ⚠ REPINNED FOR THE RENAME TO "Praimana". This is the half of the contract this suite CANNOT check —
 * see the warning above. The portal must carry the same name, and nothing here will fail if it does not.
 */
const EXPECTED_PRODUCT_NAME = "Praimana";
const EXPECTED_BRAND_YEAR = "2026";
/** sha256 of the portal's `public/icon-192.png` — the desktop's logo must be that exact file. */
const EXPECTED_LOGO_SHA256 = "6d528c6be9a01722d11a2d3933919220e63337a6203c6c4740eccb31ed8f7bcf";

const DESKTOP_SIGN_IN = join(__dirname, "components", "SignInView.tsx");
const DESKTOP_CONNECT = join(__dirname, "components", "PlatformSetupView.tsx");
const DESKTOP_LOGO = join(__dirname, "assets", "logo.png");

const read = (p: string) => readFileSync(p, "utf8");  // nosemgrep: detect-non-literal-fs-filename

describe("the desktop's brand, pinned to the portal's", () => {
  it("all the files this comparison depends on exist", () => {
    // Without this a missing file makes every regex below return undefined and the suite passes vacuously.
    // The original test carried the same canary for the same reason.
    for (const p of [DESKTOP_SIGN_IN, DESKTOP_CONNECT, DESKTOP_LOGO]) {
      expect(existsSync(p), `missing: ${p}`).toBe(true);
    }
  });

  it("both screens name the product identically, and match the pin", () => {
    const signInName = read(DESKTOP_SIGN_IN).match(/const PRODUCT_NAME = "(.*?)"/)?.[1];
    const connectName = read(DESKTOP_CONNECT).match(/const PRODUCT_NAME = "(.*?)"/)?.[1];

    expect(signInName, "could not parse SignInView's PRODUCT_NAME").toBeTruthy();
    expect(connectName, "could not parse PlatformSetupView's PRODUCT_NAME").toBeTruthy();
    // The two screens agreeing is fully checkable here, and is the half that matters most day to day: they
    // are edited separately and a participant sees both inside one flow.
    expect(signInName).toBe(connectName);
    expect(signInName).toBe(EXPECTED_PRODUCT_NAME);
  });

  it("⚠ the LOGO IS the portal's file, by hash", () => {
    // Byte-identical, not "looks similar". A re-export at a different compression level is a different file
    // and looks the same, which is exactly how two apps end up with subtly different marks.
    const hash = createHash("sha256").update(readFileSync(DESKTOP_LOGO)).digest("hex");
    expect(hash, "the desktop logo no longer matches the portal's icon-192.png").toBe(
      EXPECTED_LOGO_SHA256
    );
  });

  it("both screens carry the same copyright year, and match the pin", () => {
    const signInYear = read(DESKTOP_SIGN_IN).match(/BRAND_YEAR = "(\d{4})"/)?.[1];
    const connectYear = read(DESKTOP_CONNECT).match(/BRAND_YEAR = "(\d{4})"/)?.[1];

    expect(signInYear, "could not parse SignInView's BRAND_YEAR").toBeTruthy();
    expect(signInYear).toBe(connectYear);
    expect(signInYear).toBe(EXPECTED_BRAND_YEAR);
  });
});

/**
 * ── THE SIGN-IN SCREEN, NOW A NATIVE FORM ──
 *
 * This block used to assert the OPPOSITE of what it asserts now: that the screen rendered no
 * input and called `api.login()` to launch a browser. Both were correct for the Hosted UI
 * design, and both are obsolete — the desktop does SRP itself, so it necessarily has an email
 * field, a password field, and a TOTP field.
 *
 * The concerns behind those assertions did not go away; they changed shape. What replaces them
 * is stricter, because a form that holds a password has obligations a button did not.
 */
describe("the native sign-in screen", () => {
  /**
   * Comments STRIPPED before asserting. This file's comments explain the very things being
   * forbidden ("not type=number", "nothing remembered"), so a raw-source match finds the
   * explanation and reports the opposite of the truth. Two assertions failed exactly that way
   * before this was added.
   */
  const view = read(DESKTOP_SIGN_IN)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  /**
   * ⚠ THE PASSWORD IS DROPPED FROM STATE AFTER USE. Keeping it would leave a plaintext
   * credential in a React component for as long as the view is mounted, reachable from anything
   * in the renderer bundle — which is where a malicious transitive dependency runs.
   */
  it("clears the password and the code from state after each attempt", () => {
    expect(view).toMatch(/setPassword\(""\)/);
    expect(view).toMatch(/setCode\(""\)/);
  });

  /**
   * ⚠ THE TOKEN IS HANDED TO MAIN AND THE RENDERER'S COPY CLEARED. The window in which a
   * credential is reachable from the renderer is the thing being minimised, and `finally` is
   * what stops an early return from skipping it.
   */
  it("hands the token to main and clears the renderer's copy in a finally", () => {
    expect(view).toMatch(/api\.completeSignIn\(/);
    expect(view).toMatch(/finally\s*\{[\s\S]*?clearRendererTokens\(\)/);
  });

  /**
   * ⚠ NO AUTO-RESUME. A renderer-side resume is a second session
   * authority racing main's, and on a shared machine it silently signs in whoever used the app
   * last. The portal has one deliberately; the desktop must not.
   */
  it("never resumes an existing Amplify session on mount", () => {
    expect(view).not.toMatch(/fetchAuthSession/);
  });

  /** ⚠ NOTHING REMEMBERED. Main owns the session; the form is not a second store. */
  it("offers no remember-me and stores no email", () => {
    expect(view).not.toMatch(/remember/i);
    expect(view).not.toMatch(/localStorage|sessionStorage/);
  });

  it("announces sign-in errors to a screen reader", () => {
    // The one screen where a silent failure leaves the user with no next step at all.
    expect(view).toMatch(/role="alert"/);
  });

  it("reserves the logo's box, so decoding it cannot shift the button", () => {
    // An unsized image reflows the card the moment it decodes, under a pointer already
    // travelling toward the button.
    expect(view).toMatch(/width=\{32\}/);
    expect(view).toMatch(/height=\{32\}/);
  });

  it("disables its controls while a request is in flight", () => {
    // Two submits would start two Cognito conversations and the second would fail with a
    // confusing already-authenticated error.
    expect(view).toMatch(/disabled=\{[^}]*busy/);
  });

  /**
   * The TOTP field is `type="text"` with a numeric input mode, NOT `type="number"`: a number
   * input strips leading zeros, and a code beginning 0 is perfectly ordinary.
   */
  it("does not use a number input for the TOTP code", () => {
    const totp = view.slice(view.indexOf('id="signin-totp"'));
    expect(totp).toMatch(/inputMode="numeric"/);
    expect(totp.slice(0, 400)).not.toMatch(/type="number"/);
    // And it caps the length, so a long paste is truncated rather than submitted.
    expect(totp.slice(0, 400)).toMatch(/maxLength=\{6\}/);
  });
});
