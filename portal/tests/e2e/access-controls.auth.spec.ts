/**
 * THE REAL JOURNEY — sign in through the pool's actual TOTP challenge, against the real
 * services, and drive both controls end to end.
 *
 * ── WHY THIS FILE IS SEPARATE FROM THE OTHER TWO ──
 * remove-member.spec.ts and user-access.spec.ts test the BROWSER's behaviour: focus, tab
 * order, and requests leaving the socket. They mint a session and serve their own tRPC
 * responses so those behaviours are deterministic and repeatable.
 *
 * This file tests the INTEGRATION: that a real operator can sign in past MFA and that the two
 * controls work against the live stack. It has no seam of any kind. If it passes, the journey
 * works; if it is skipped, nothing about the journey has been verified and the report must say
 * so rather than borrow confidence from the other two files.
 *
 * ── WHAT IT NEEDS, AND WHY IT SKIPS RATHER THAN FAILS WITHOUT IT ──
 * A purpose-made test account whose TOTP secret is in the environment, plus the microservices
 * and the local gateway running. See tests/e2e/README.md. Absent any of that, the spec skips
 * with a message naming exactly what is missing — never a confusing selector timeout, and
 * never a silent pass.
 *
 * ── THIS SPEC MUTATES REAL DATA ──
 * Removing a member and disabling an account are real writes against the dev stack. So the
 * fixtures are addressed by ENVIRONMENT variables too: the spec will not guess at a team or a
 * victim account, because a guess here removes a real person from a real team. Everything it
 * touches must be named deliberately, and it restores what it can.
 */

import { test, expect } from "@playwright/test";
import { readAccount, missingAccountMessage } from "./fixtures/env";
import { signInForReal } from "./fixtures/login";
import { POLITE_NOTICE, expectFocusNotLost } from "./fixtures/focus";

/**
 * The operator this spec signs in as. Must be an ADMIN or FACILITATOR — anyone else is
 * redirected away from /admin by middleware, and a PARTICIPANT never reaches a team page's
 * management controls.
 */
const { account: operator, missing: operatorMissing } = readAccount("E2E_ADMIN");

/**
 * WHICH team and WHICH member to remove. Named explicitly, never discovered, because
 * "the first member in the list" is how a spec removes a real person from a real team.
 */
const TEAM_URL = process.env.E2E_TEAM_URL?.trim();
const VICTIM_NAME = process.env.E2E_REMOVABLE_MEMBER_NAME?.trim();

/** WHICH account to disable and restore. Likewise named, never discovered. */
const DISABLE_TARGET = process.env.E2E_DISABLE_TARGET_NAME?.trim();

test.describe("Real sign-in through MFA, then the access controls against the live stack", () => {
  test.describe.configure({
    // The TOTP journey plus a possible 30s wait for a fresh code window needs more than the
    // 30s default. Not a workaround: `freshTotp`'s wait is a deliberate, bounded pause.
    timeout: 120_000,
  });

  test.beforeEach(() => {
    test.skip(!operator, missingAccountMessage("E2E_ADMIN", operatorMissing));
  });

  /**
   * THE AUTHENTICATION PROOF. This is the only test in the harness that exercises the pool's
   * TOTP challenge, so it is the only evidence that the journey works.
   */
  test("an operator signs in with a password and a real TOTP code", async ({ page }) => {
    const { landedOn, waitedForCodeMs } = await signInForReal(page, operator!);

    // Landing is role-derived (landingPathForRole), and this account must be staff.
    expect(
      landedOn,
      `An ADMIN or FACILITATOR lands on /workshops. Landing on /welcome means the account's ` +
        `collapsed role is PARTICIPANT — check its Cognito group membership. ` +
        `(Waited ${waitedForCodeMs}ms for a fresh TOTP window.)`
    ).toMatch(/^\/workshops/);

    // The session is real: a protected screen renders rather than redirecting.
    await page.goto("/admin?tab=users");
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  });

  /**
   * A WRONG TOTP CODE IS REFUSED, and says so.
   *
   * The negative half of the authentication proof. Without it, "sign-in works" could mean the
   * challenge accepts anything. Uses a deterministic wrong code rather than a random one, so
   * a failure is replayable.
   */
  test("a wrong TOTP code is refused with a legible message", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(operator!.email);
    await page.getByLabel("Password").fill(operator!.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible({
      timeout: 20_000,
    });

    // "000000" is a valid SHAPE and an almost-certainly wrong VALUE. On the ~1-in-a-million
    // run where it is the real code, this test would fail rather than pass — which is the
    // correct direction for a negative test to be wrong in.
    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();

    // Still on the challenge, and told why. Never signed in.
    await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
    await expect(page).not.toHaveURL(/\/workshops/);
  });

  /**
   * REMOVING A MEMBER, FOR REAL.
   *
   * Skipped unless a team URL and a member name are both supplied, because this is a HARD
   * DELETE against the live stack: the membership row is destroyed and the audit entry is the
   * only remaining record. A spec that picked its own victim would be a spec that removes
   * someone's real teammate.
   */
  test("removing a member works against the live stack", async ({ page }) => {
    test.skip(
      !TEAM_URL || !VICTIM_NAME,
      "SKIPPED — set E2E_TEAM_URL (e.g. /w/<workshopId>/t/<teamId>/team) and " +
        "E2E_REMOVABLE_MEMBER_NAME to the display name of a DISPOSABLE test member. " +
        "This test HARD-DELETES that membership row against the live stack, so it will not " +
        "choose a target for you. See tests/e2e/README.md."
    );

    await signInForReal(page, operator!);
    await page.goto(TEAM_URL!);
    await expect(page.getByRole("heading", { name: /^Members/ })).toBeVisible();

    // The team's own name is needed to build the accessible name, and it comes from the page
    // rather than from a guess — a hardcoded team name would silently address the wrong row.
    const trigger = page
      .getByRole("button", { name: new RegExp(`^Remove ${escapeRegex(VICTIM_NAME!)} from `) })
      .first();
    await expect(
      trigger,
      `No Remove control for "${VICTIM_NAME}" on ${TEAM_URL}. Either they are not on this team, ` +
        `or the signed-in operator is read-only, or the name does not match the roster exactly.`
    ).toBeVisible();

    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`Remove ${VICTIM_NAME} from`);
    await page
      .getByRole("textbox", { name: /Reason/ })
      .fill("Automated E2E verification — see tests/e2e/access-controls.auth.spec.ts");
    await page.getByRole("button", { name: "Remove from team" }).click();

    // Either a clean success or an honest partial (audited: false). Both are PASSES for this
    // test — the removal happened — but they are reported differently, and a partial is worth
    // seeing in the output rather than swallowed.
    const notice = page.locator(POLITE_NOTICE).filter({ hasText: /^(✓)?Done/ });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    const text = (await notice.textContent()) ?? "";
    if (text.includes("with a gap")) {
      console.warn(`[partial] the removal succeeded but was NOT audited: ${text.trim()}`);
    }
    expect(text).toContain(VICTIM_NAME!);

    // The row is gone, and focus is not stranded.
    await expect(
      page.getByRole("button", { name: new RegExp(`^Remove ${escapeRegex(VICTIM_NAME!)} from `) })
    ).toHaveCount(0);
    await expectFocusNotLost(
      page,
      "After a real removal the trigger is unmounted with its row, so focus must land on the " +
        "documented fallback (the Members disclosure heading) rather than on <body>."
    );
  });

  /**
   * DISABLING AND THEN RESTORING ACCESS, FOR REAL — in that order, in one test, deliberately.
   *
   * Two separate tests would leave the account disabled if the second one failed, which is a
   * suite that locks a real account out and walks away. One test with the restore in the same
   * body means the recovery runs on the same path as the damage, and `finally` guarantees the
   * attempt even if an assertion throws.
   */
  test("disabling and restoring access works against the live stack", async ({ page }) => {
    test.skip(
      !DISABLE_TARGET,
      "SKIPPED — set E2E_DISABLE_TARGET_NAME to the display name of a DISPOSABLE test " +
        "account. This test calls Cognito AdminDisableUser against the live pool and DESTROYS " +
        "that account's pending invitations (irreversibly), so it will not choose a target " +
        "for you. See tests/e2e/README.md."
    );

    await signInForReal(page, operator!);
    await page.goto("/admin?tab=users");
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();

    // Find the row by searching, so the target does not have to be on the first page.
    await page.getByRole("searchbox", { name: /Search users/ }).fill(DISABLE_TARGET!);
    const disableTrigger = page.getByRole("button", {
      name: `Disable sign-in access for ${DISABLE_TARGET}`,
    });
    await expect(
      disableTrigger,
      `No Disable control for "${DISABLE_TARGET}". Either the account does not exist, or the ` +
        `operator's role may not administer it (USER_ADMIN_GRANTS), or it is already disabled, ` +
        `or it is the operator's own row.`
    ).toBeVisible({ timeout: 20_000 });

    let disabled = false;
    try {
      await disableTrigger.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page
        .getByRole("textbox", { name: /Reason/ })
        .fill("Automated E2E verification — restored immediately");
      await page.getByRole("button", { name: "Disable access" }).click();

      const notice = page.locator(POLITE_NOTICE).filter({ hasText: /^(✓|!)?Done/ });
      await expect(notice).toBeVisible({ timeout: 20_000 });
      const text = (await notice.textContent()) ?? "";
      expect(text).toContain(DISABLE_TARGET!);
      expect(text).toContain("can no longer sign in");
      disabled = true;

      // The row's visual state must now be unmistakable, from the real `status` mirror.
      await expect(
        page.getByRole("button", { name: `Restore sign-in access for ${DISABLE_TARGET}` })
      ).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("No access", { exact: true })).toBeVisible();
    } finally {
      // RESTORE, whatever happened above. A suite that leaves a real account locked out is a
      // suite that caused an incident.
      if (disabled) {
        const restoreTrigger = page.getByRole("button", {
          name: `Restore sign-in access for ${DISABLE_TARGET}`,
        });
        if (await restoreTrigger.isVisible().catch(() => false)) {
          await restoreTrigger.click();
          await page.getByRole("button", { name: "Restore access" }).click();
          await expect(
            page.getByRole("button", { name: `Disable sign-in access for ${DISABLE_TARGET}` })
          ).toBeVisible({ timeout: 20_000 });
          console.log(`[restored] access restored for ${DISABLE_TARGET}`);
        } else {
          console.error(
            `[NOT RESTORED] ${DISABLE_TARGET} may still be DISABLED — the Restore control was ` +
              `not reachable. Restore it by hand from /admin?tab=users.`
          );
        }
      }
    }
  });

  /**
   * A FACILITATOR is offered no access control on an ADMIN row — against the LIVE role matrix.
   *
   * The browser-level version of this is in user-access.spec.ts with fixtures. This one proves
   * the same rule holds when the roles come from real Cognito groups and the rows come from the
   * identity service, which is where a drift between the client matrix and the server's would
   * show up.
   */
  test("a real FACILITATOR is offered no Disable control on an ADMIN row", async ({ page }) => {
    const { account: facilitator, missing } = readAccount("E2E_FACILITATOR");
    test.skip(!facilitator, missingAccountMessage("E2E_FACILITATOR", missing));
    const adminRowName = process.env.E2E_ADMIN_ROW_NAME?.trim();
    test.skip(
      !adminRowName,
      "SKIPPED — set E2E_ADMIN_ROW_NAME to the display name of an ADMIN account other than " +
        "the facilitator's own, so the lateral-attack case has a target to assert against."
    );

    await signInForReal(page, facilitator!);
    await page.goto("/admin?tab=users");
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await page.getByRole("searchbox", { name: /Search users/ }).fill(adminRowName!);

    // NOTE ON WHAT THIS CAN AND CANNOT PROVE. The identity service does not return ADMIN rows
    // to a FACILITATOR at all, so the strongest available assertion is that no control exists
    // for that person — whether because the row is absent or because it is gated. Both are
    // correct outcomes; a control WOULD be the defect.
    await expect(
      page.getByRole("button", { name: `Disable sign-in access for ${adminRowName}` }),
      "A FACILITATOR must never be offered an access control on an ADMIN. USER_ADMIN_GRANTS " +
        "gives FACILITATOR only ['JUDGE','EXECUTIVE','PARTICIPANT']."
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Restore sign-in access for ${adminRowName}` })
    ).toHaveCount(0);
  });
});

/** Escape a display name for use inside a RegExp — names can contain regex metacharacters. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
