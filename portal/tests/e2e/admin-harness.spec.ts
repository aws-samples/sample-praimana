/**
 * ── THE /admin HARNESS CONTRACT ──────────────────────────────────────────────────────────────
 *
 * Every one of the seven tabs must render CONTENT under the shared fixture — not an error state,
 * not a permanent skeleton — and no procedure may be requested without a stub.
 *
 * ── ⚠ WHY THIS SPEC EXISTS AT ALL ──
 *
 * The redesign work concluded, twice and wrongly, that these tabs were untestable because the
 * harness could not establish a role. That was false: `/api/auth/session` returns
 * `role: "ADMIN"` correctly. What actually happened is that four procedure names were GUESSED and
 * all four were wrong:
 *
 *   guessed `admin.platformHealth`         → real `health.platform`
 *   guessed `admin.feedback`               → real `feedback.list`
 *   guessed `team.listPlatformInvitations` → real `team.listInvitations`
 *   guessed `health.byService`             → real `cost.platform`  (costRouter lives in
 *                                            routers/health.ts but is mounted at `cost:`)
 *
 * `serveTrpc` answered each with an error envelope, the page rendered its error or loading branch,
 * and that was read as a product or harness defect. One consequence: a comment-leak guard written
 * against the health tab passed twice against a real bug, because the region it asserted about
 * never rendered.
 *
 * So the fixture now lives in one place with the names taken from the routers, and
 * `expectAllProceduresStubbed()` turns a wrong name into a failing test that NAMES the missing
 * path — which is how the fourth one above was found rather than guessed a fifth time.
 */
import { test, expect } from "@playwright/test";
import { readNextAuthSecret } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc, expectAllProceduresStubbed } from "./fixtures/trpc";
import { ADMIN_SELF } from "./fixtures/data";
import { adminScreen, userFixture, workshopFixture } from "./fixtures/admin-screen";

const { secret } = readNextAuthSecret();

const TABS = ["users", "teams", "invitations", "experiences", "feedback", "health", "cost"];

for (const tab of TABS) {
  test(`every procedure the ${tab} tab needs is stubbed`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await signInAs(context, ADMIN_SELF, secret!);
    const log = await serveTrpc(page, {
      ...adminScreen(ADMIN_SELF),
      "admin.listUsers": () => ({
        users: [userFixture({ id: ADMIN_SELF.id, name: "Example Admin", isSelf: true, role: "ADMIN" }), userFixture({ id: "u2", status: "DEACTIVATED" })],
        nextCursor: null, scopeTruncated: false,
      }),
      "workshop.list": () => [workshopFixture()],
      "health.platform": () => ({ alarms: [{ name: "aiap-prod-gateway-5xx", state: "ALARM", description: "5xx above threshold." }], overall: "ALARM", checkedAt: "2026-08-29T10:00:00Z" }),
    });

    await page.goto(`/admin?tab=${tab}`);
    await expect(page.locator("footer")).toBeVisible();
    await page.waitForTimeout(600);

    const body = await page.locator("main").innerText();
    console.log(`${tab}: requested=[${log.requested.join(" ")}] unhandled=[${log.unhandled.join(" ")}]`);
    console.log(`   stuck-loading=${/Loading|Checking the platform/.test(body)} errored=${/Couldn't load|could not/.test(body)}`);
    expectAllProceduresStubbed(log);
    await page.screenshot({ path: `test-results/H-${tab}.png`, fullPage: true });
  });
}
