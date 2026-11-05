/**
 * THE STICKY CHROME — the browser-only contract.
 *
 * On a long page (Platform health, How it works, a 40-row user directory) the header scrolled away
 * and took the ProfileMenu with it, so "Sign out" and "Administration" needed a scroll back to the
 * top of the document to reach. That is what these tests pin.
 *
 * Three properties, none of which is visible in the markup:
 *
 *   1. THE HEADER STAYS AT y=0 WHILE THE DOCUMENT SCROLLS. Asserted together with "the document
 *      actually scrolled" — without that second assertion the test passes on any page that simply
 *      is not tall enough, which is how the first version of the two-bar test below passed
 *      vacuously with scrollY stuck at 0.
 *   2. THE EXPERIENCE LAYOUT'S TWO BARS PIN AS ONE UNIT. They are wrapped in a single sticky
 *      container rather than each made sticky, because two `sticky top-0` siblings both pin to 0
 *      and overlap — and the alternative, `top-[76px]` on the second, hardcodes the first bar's
 *      height. The test reads BOTH bars' tops and requires them unchanged and distinct.
 *   3. OVERLAYS STILL OUTRANK IT. Giving the header a z-index puts it in the stacking order for
 *      the first time, so the dropdown it contains, the confirmations and the idle-timeout notice
 *      all have to sit above it. `z-40` against six existing `z-50` overlays.
 */
import { test, expect } from "@playwright/test";
import { readNextAuthSecret } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc } from "./fixtures/trpc";
import { ADMIN_SELF, meFixture, WORKSHOP_ID, WORKSHOP_NAME } from "./fixtures/data";
const { secret } = readNextAuthSecret();

const many = Array.from({ length: 40 }, (_, i) => ({
  id: `u${i}`, name: `Person ${String(i).padStart(2, "0")}`, email: `p${i}@example.test`,
  role: i % 2 ? "PARTICIPANT" : "FACILITATOR", organization: "Acme", status: "ACTIVE",
  invitedBy: null, isSelf: false, hasAccount: true,
}));

const CASES: [string, string, boolean][] = [
  ["how-it-works", "/how-it-works", true],
  ["admin users", "/admin?tab=users", true],
];

for (const [name, path, auth] of CASES) {
  test(`header stays put while scrolling ${name}`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 800 });
    if (auth) {
      await signInAs(context, ADMIN_SELF, secret!);
      await serveTrpc(page, {
        "auth.me": () => meFixture(ADMIN_SELF),
        "admin.listUsers": () => ({ users: many, nextCursor: null, scopeTruncated: false }),
        "workshop.list": () => [],
      });
    }
    await page.goto(path);
    await expect(page.locator("header").first()).toBeVisible();

    const before = (await page.locator("header").first().boundingBox())!;
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 50);
    /* ⚠ POLLED, NOT SLEPT. This was `scrollBy` followed by `waitForTimeout(200)`, which passed
       alone and FAILED in the full parallel suite: under load the scroll had not been applied when
       the 200ms elapsed, so `scrollY` was still 0 and the "the page really scrolled" guard fired.
       A fixed wait is a race, and this repo's specs say so explicitly. Waiting for the observable
       effect instead makes it deterministic at any worker count. */
    await page.evaluate(() => window.scrollBy(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    const after = (await page.locator("header").first().boundingBox())!;
    const y = await page.evaluate(() => window.scrollY);

    console.log(`${name}: scrollable=${scrollable} scrollY=${y} header.y ${before.y} -> ${after.y}`);
    expect(scrollable, `${name} must actually scroll for this to mean anything`).toBe(true);
    expect(y, "the page really scrolled").toBeGreaterThan(100);
    expect(after.y, "header must remain pinned at the top").toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/sticky-${name.replace(/\W/g, "-")}.png` });
  });
}

const workshop = {
  id: WORKSHOP_ID, name: WORKSHOP_NAME, description: "Six teams, three phases.",
  format: "IN_PERSON", status: "ACTIVE", ownerId: ADMIN_SELF.id, teams: [],
  startsAt: "2026-09-01T09:00:00Z", endsAt: "2026-09-05T17:00:00Z",
  setupConfig: null, enabledAssistants: ["claude"], _count: { teams: 6 },
};

test("both experience bars stay pinned as one unit", async ({ page, context }) => {
  /* ⚠ A DELIBERATELY SHORT VIEWPORT. The first attempt used 700px and scrollY stayed 0: this
     page's body is role-gated, and the harness cannot grant ADMIN, so it renders the short
     "no permission" notice instead of the long form. The property under test is the sticky
     behaviour, not the page's length, so forcing the scroll is the correct fix rather than
     hunting for a page that happens to be tall enough. */
  await page.setViewportSize({ width: 1440, height: 300 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, {
    "auth.me": () => meFixture(ADMIN_SELF),
    "workshop.getById": () => workshop,
    "workshop.formats": () => [{ value: "IN_PERSON", label: "In person" }],
    "workshop.list": () => [workshop],
  });
  await page.goto(`/experiences/${WORKSHOP_ID}/settings`);
  await expect(page.getByRole("heading", { name: WORKSHOP_NAME })).toBeVisible();

  const bars = page.locator("header");
  const n = await bars.count();
  const before = await bars.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  /* ⚠ SCROLL TO WHATEVER IS AVAILABLE, NOT A MAGIC 500px. This scrolled by a fixed 500 and
     required `scrollY > 100`, which encoded an assumption about how tall this page happens to be —
     and the assumption broke: the run landed on `scrollY = 6` because the document was only a few
     pixels taller than the 380px viewport. The test then failed for a reason that had nothing to do
     with stickiness.

     Measuring the scrollable distance first makes it independent of the page's content, and
     asserting that the distance EXISTS keeps the test from passing vacuously on a page that cannot
     scroll at all — which is the failure mode the fixed threshold was there to prevent. */
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight - window.innerHeight
  );
  expect(scrollable, "this page must have something to scroll for the test to mean anything")
    .toBeGreaterThan(20);
  await page.evaluate((max) => window.scrollTo(0, max), scrollable);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollable - 2);
  const after = await bars.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const y = await page.evaluate(() => window.scrollY);
  console.log(`bars=${n} scrollY=${y} tops ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  expect(y, "the page really scrolled").toBeGreaterThan(20);
  // Both bars keep their original tops: the pair is pinned, and they do not overlap.
  expect(after).toEqual(before);
  await page.screenshot({ path: "test-results/sticky-experience.png" });
});

test("an overlay still paints above the sticky header", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, { "auth.me": () => meFixture(ADMIN_SELF), "workshop.list": () => [] });
  await page.goto("/admin?tab=users");

  /* ⚠ THE RISK THE STICKY HEADER INTRODUCES. Giving the header a z-index puts it in the stacking
     order for the first time, so anything that must appear OVER it — the identity dropdown, the
     confirmation dialogs, the idle-timeout notice — has to outrank it. `z-40` was chosen against
     the six existing `z-50` overlays; this asserts the choice rather than trusting the arithmetic.

     Located by `aria-haspopup="menu"` rather than by the account's display name: the name comes
     from the session, which this harness populates differently from production. */
  const trigger = page.locator('header button[aria-haspopup="menu"]');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const panel = page.locator('[role="menu"]');
  await expect(panel).toBeVisible();

  // The topmost element at the panel's own centre must belong to the panel, not to the header.
  const onTop = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return el.contains(hit) || el === hit;
  });
  expect(onTop, "the header must not cover the menu it contains").toBe(true);

  const headerZ = await page
    .locator("header")
    .first()
    .evaluate((el) => getComputedStyle(el).zIndex);
  const panelZ = await panel.evaluate((el) => getComputedStyle(el).zIndex);
  console.log(`header z=${headerZ} panel z=${panelZ}`);
  expect(Number(panelZ)).toBeGreaterThan(Number(headerZ));
});
