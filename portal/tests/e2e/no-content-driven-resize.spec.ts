/**
 * ⚠ THE CONTAINER MUST NOT RESIZE ITSELF TO ITS CONTENT ─────────────────────────────────────
 *
 * REPORTED: switching to a tab with no content moved the whole tab box toward the centre, and
 * switching back resized it again.
 *
 * The cause is a CSS rule that is easy to write and hard to see: `mx-auto` on a FLEX ITEM beats
 * the default `align-self: stretch`, so the element is sized to fit its content rather than to
 * its `max-w-*` track. An empty tab therefore produced a narrower `<main>`, which `mx-auto` then
 * re-centred — so the tab bar inside it both moved and shrank.
 *
 * Measured with the fix reverted: the tab bar went from x=268/width=976 to x=415/width=681.
 *
 * ⚠ THIS IS THE THIRD TIME THIS EXACT BUG HAS BEEN FOUND in this codebase — first on the
 * /experiences heading (which slid ~340px right when the list was empty), then here. 25 centred
 * containers across 17 files had the same shape and are all fixed; this test is the one that
 * fails if any of them regresses, because the symptom is invisible until content happens to be
 * short.
 */
import { test, expect } from "@playwright/test";
import { readNextAuthSecret } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc } from "./fixtures/trpc";
import { ADMIN_SELF, meFixture } from "./fixtures/data";
const { secret } = readNextAuthSecret();

const users = Array.from({ length: 12 }, (_, i) => ({
  id: `u${i}`, name: `Person ${i}`, email: `p${i}@example.test`, role: "PARTICIPANT",
  organization: "Acme", status: "ACTIVE", invitedBy: null, isSelf: false, hasAccount: true,
}));

test("the tab bar does not move between a populated tab and an empty one", async ({ page, context }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, {
    "auth.me": () => meFixture(ADMIN_SELF),
    "admin.listUsers": () => ({ users, nextCursor: null, scopeTruncated: false }),
    "workshop.list": () => [],
    "team.listDirectory": () => ({ teams: [], nextCursor: null }),
    "admin.feedback": () => ({ items: [], nextCursor: null }),
    "admin.listFeedback": () => ({ items: [], nextCursor: null }),
  });

  const tablist = page.locator('[role="tablist"]');

  await page.goto("/admin?tab=users");
  await expect(page.getByText("Person 0")).toBeVisible();
  const populated = (await tablist.boundingBox())!;

  await page.getByRole("tab", { name: /Feedback/ }).click();
  await page.waitForTimeout(400);
  const empty = (await tablist.boundingBox())!;

  console.log(`tablist x/width  populated: ${populated.x}/${populated.width}  empty: ${empty.x}/${empty.width}`);
  expect(empty.x, "the tab bar must not shift horizontally").toBe(populated.x);
  expect(empty.width, "and must not resize").toBe(populated.width);
  await page.screenshot({ path: "test-results/shift-feedback.png" });
});
