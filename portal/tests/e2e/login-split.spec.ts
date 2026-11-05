/**
 * /login RENDERS THE SAME SPLIT AS THE LANDING PAGE — the browser-only contract.
 *
 * Sign-in used to have two designs depending on how you arrived: the landing page's split layout
 * if you pressed "Get started", a standalone centred card if you opened /login directly. Both
 * routes now render `LandingSplit` over the same `landing-content`, differing only in `mode`.
 *
 * ⚠ THE REGRESSION THAT PROMPTED THIS WAS REACHABLE MID-TASK, not merely cosmetic. The reveal
 * pushes /login into history, so refreshing — or following the link in an invitation email, or
 * being bounced here by middleware — swapped the design out from under a reader who had already
 * started typing. The "reveal then refresh" test below is that exact path.
 *
 * The two cases worth spelling out:
 *   - DESKTOP: hero and form side by side, indistinguishable from the revealed state.
 *   - MOBILE: the hero stands DOWN. Overlay mode hides the panel below `lg` (the CTA navigates
 *     instead); doing that here would leave someone opening /login on a phone looking at a
 *     marketing hero with no form, which is the opposite of what the route is for.
 */
import { test, expect } from "@playwright/test";

test("direct /login desktop", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Build solutions together/ })).toBeVisible();
  console.log("scroll/inner:", await page.evaluate(() => `${document.documentElement.scrollHeight}/${window.innerHeight}`));
  console.log("focused on load:", await page.evaluate(() => document.activeElement?.tagName));
  await page.screenshot({ path: "test-results/L-desktop.png" });
});

test("direct /login mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  // The hero must stand down: a phone opening /login needs the form, not marketing.
  await expect(page.getByRole("heading", { name: /Build solutions together/ })).toBeHidden();
  console.log("h-scroll:", await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await page.screenshot({ path: "test-results/L-mobile.png", fullPage: true });
});

test("?error= still surfaces", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/login?error=AccessDenied");
  // ⚠ SCOPED TO THE CARD. A bare `getByRole("alert")` also matches Next's own
  // `#__next-route-announcer__`, an empty framework element present on every page, so the
  // unscoped selector fails strict mode for a reason that has nothing to do with this feature.
  await expect(page.locator("#signin-panel").getByRole("alert")).toContainText(
    /role assigned yet/
  );
  await page.screenshot({ path: "test-results/L-error.png" });
});

test("reveal then refresh keeps the same design", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.reload();
  // The regression that prompted this: refresh used to land on the standalone card.
  await expect(page.getByRole("heading", { name: /Build solutions together/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("Escape on /login goes to the landing page", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByRole("link", { name: "Get started" })).toBeVisible();
});

/**
 * ── ⚠ THE PANEL IS CENTRED, NOT THE CARD ────────────────────────────────────────────────────
 *
 * The card is ~340px against a ~590px left column, so `top-0` left it visibly high and the two
 * sides read as unrelated blocks rather than one composition.
 *
 * What is centred is the whole right-hand BLOCK — the card plus the "Accounts are created by
 * invitation" footnote that belongs to it. Measured against the card alone the centring is ~34px
 * out, which is exactly half the footnote's height, and that is correct rather than a rounding
 * error: excluding a line that is visually part of the group would leave the composite looking
 * bottom-heavy. This test therefore measures the panel, and says so, because the obvious "fix"
 * on reading a 34px delta is to compensate for it and make the result worse.
 *
 * Checked at two viewport heights so a value tuned to one laptop cannot pass by luck.
 */
for (const [name, w, h] of [
  ["MacBook 14", 1512, 890],
  ["MacBook 13", 1440, 810],
] as [string, number, number][]) {
  test(`the sign-in panel is vertically centred against the hero column on ${name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.waitForTimeout(700); // the slide has to settle before geometry is meaningful

    const m = await page.evaluate(() => {
      const panel = document.querySelector("#signin-panel") as HTMLElement;
      const column = panel.parentElement!.querySelector(
        "div.transition-transform"
      ) as HTMLElement;
      // The panel is stretched to the column (`inset-y-0`), so its own box is not the thing to
      // measure — the content it centres is. First and last child span card..footnote.
      const kids = Array.from(panel.querySelectorAll(":scope > div")) as HTMLElement[];
      const boxes = kids.map((k) => k.getBoundingClientRect());
      const top = Math.min(...boxes.map((b) => b.top));
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      const c = column.getBoundingClientRect();
      return { columnMid: c.top + c.height / 2, blockMid: (top + bottom) / 2 };
    });

    expect(Math.abs(m.columnMid - m.blockMid)).toBeLessThan(4);
  });
}

/**
 * ⚠ AND THE CENTRING MUST NOT PUSH A TALL STEP UNDER THE HEADER. This is why the panel is
 * stretched-and-centred with `max-h-full` rather than `top-1/2 -translate-y-1/2`: the latter
 * centres a midpoint, so content taller than the column grows symmetrically and escapes upward.
 */
test("a tall step stays inside the column rather than escaping upward", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  const columnTop = await page.evaluate(() => {
    const col = (document.querySelector("#signin-panel") as HTMLElement).parentElement!
      .querySelector("div.transition-transform") as HTMLElement;
    return col.getBoundingClientRect().top;
  });

  await page.evaluate(() => {
    const scroller = document.querySelector("#signin-panel > div") as HTMLElement;
    const tall = document.createElement("div");
    tall.style.height = "1400px";
    scroller.appendChild(tall);
  });

  const after = await page.evaluate(() => {
    const scroller = document.querySelector("#signin-panel > div") as HTMLElement;
    return {
      top: scroller.getBoundingClientRect().top,
      scrolls: scroller.scrollHeight > scroller.clientHeight,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
    };
  });

  expect(after.scrolls, "the panel absorbs the overflow").toBe(true);
  expect(after.top, "and never rises above the column it sits beside").toBeGreaterThanOrEqual(
    columnTop - 1
  );
  expect(after.pageScrolls).toBe(false);
});
