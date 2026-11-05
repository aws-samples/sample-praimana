/**
 * SIGN IN FOR REAL — password, then the pool's mandatory TOTP challenge.
 *
 * No seam, no bypass, no cookie forgery. This drives the same screens a person drives, and
 * answers the TOTP challenge by computing a code from the test account's enrolment secret —
 * which is legitimate, because a TOTP code is a pure function of (secret, time). See the
 * header of tests/e2e/totp.ts for why MFA stays ON rather than being disabled for tests.
 *
 * ── freshTotp, NOT totp ──
 * `freshTotp` is used deliberately. A code generated 200ms before its window closes is valid
 * when computed and expired by the time Cognito checks it — an authentication failure that
 * reproduces a few times an hour and looks like a broken selector. Waiting for the next
 * window costs at most 30s and removes the whole class of flake.
 */

import { expect, type Page } from "@playwright/test";
import { freshTotp } from "../totp";
import type { TestAccount } from "./env";

/**
 * Complete a full sign-in and return the landing path.
 *
 * Every wait is a web-first assertion on a heading, never a sleep — the AuthFlow state
 * machine is observable through its own `<h1>` (see AuthShell), so the spec synchronises on
 * the screen it is actually waiting for.
 */
export async function signInForReal(
  page: Page,
  account: TestAccount,
  { expectLanding }: { expectLanding?: RegExp } = {}
): Promise<{ waitedForCodeMs: number; landedOn: string }> {
  await page.goto("/login");

  // The sign-in screen. Addressed by heading and by label, so a rename of either is caught
  // here rather than surfacing as a mystery timeout in a spec that only cares about a roster.
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // ── THE FORK THAT MUST BE REPORTED, NOT SILENTLY HANDLED ──
  // A pool with MfaConfiguration: ON answers a FIRST-EVER sign-in with MFA_SETUP (enrolment)
  // rather than a challenge. A harness that quietly enrolled would be minting a second factor
  // it then owns; and an account in that state means the configured secret is stale. So both
  // wrong-turns fail LOUDLY with the reason, instead of timing out on a code field.
  const challenge = page.getByRole("heading", { name: "Two-factor authentication" });
  const enrolment = page.getByRole("heading", { name: "Set up two-factor authentication" });
  const newPassword = page.getByRole("heading", { name: "Choose your password" });
  const profile = page.getByRole("heading", { name: "Tell us who you are" });

  await expect(
    challenge.or(enrolment).or(newPassword).or(profile),
    `Sign-in did not reach a recognised next screen. The pool is MfaConfiguration: ON, so a ` +
      `password submit must continue into a TOTP challenge. Check ${account.label}_EMAIL and ` +
      `${account.label}_PASSWORD, and the portal's Cognito configuration in .env.`
  ).toBeVisible({ timeout: 20_000 });

  if (await enrolment.isVisible()) {
    throw new Error(
      `${account.label} has NO TOTP factor enrolled — Cognito answered MFA_SETUP instead of a ` +
        `challenge. This harness deliberately does NOT enrol one: doing so would mint a second ` +
        `factor that CI then owns, which is the account-takeover step described in ` +
        `tests/e2e/totp.ts. Enrol the account by hand, once, and put its secret in ` +
        `${account.label}_TOTP_SECRET.`
    );
  }
  if (await newPassword.isVisible()) {
    throw new Error(
      `${account.label} is still on its TEMPORARY password — Cognito demanded a password change. ` +
        `Sign in by hand once, set a permanent password, and put it in ${account.label}_PASSWORD.`
    );
  }
  if (await profile.isVisible()) {
    throw new Error(
      `${account.label} has not completed its mandatory profile (first name, last name, ` +
        `organisation). Sign in by hand once and complete it, so specs start from a steady state.`
    );
  }

  // The TOTP challenge. `freshTotp` guarantees the code has life left in it.
  const { code, waitedMs } = await freshTotp(account.totpSecret);
  if (waitedMs > 0) {
    // Logged so a deliberate pause does not read as a hang.
    console.log(
      `[totp] waited ${waitedMs}ms for a fresh code window before answering the challenge`
    );
  }
  await page.getByLabel("Verification code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();

  // Landing is decided server-side by landingPathForRole, so assert on the URL rather than on
  // a screen — a role change would otherwise silently pass here and fail later.
  const target = expectLanding ?? /\/(workshops|welcome)/;
  await expect(
    page,
    `Sign-in completed but did not land on an expected path. A TOTP code was rejected, or the ` +
      `account's role is not one that may hold a session (see canSignInToWebApp). Check the ` +
      `clock skew on this machine if the code was rejected: TOTP is time-based.`
  ).toHaveURL(target, { timeout: 20_000 });

  return { waitedForCodeMs: waitedMs, landedOn: new URL(page.url()).pathname };
}
