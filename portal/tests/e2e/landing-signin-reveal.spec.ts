/**
 * THE LANDING PAGE'S INLINE SIGN-IN REVEAL — the browser-only contract.
 *
 * "Get started" slides the hero left and brings the sign-in card in from the right rather than
 * navigating. Almost nothing about that is assertable off a DOM snapshot, because the whole
 * point is a set of behaviours the enhancement must NOT take away from the user:
 *
 *   1. It is still an `<a href="/login">`. With JS off, on a modified click, or below the `lg`
 *      breakpoint, the browser must navigate as it always did.
 *   2. Collapsed, the form must not be in the tab order or the accessibility tree — a
 *      translated-but-present sign-in form would put five focusable controls on a page that
 *      appears to have one button.
 *   3. The URL must track the state, or Back leaves the site from what looks like a page and a
 *      refresh discards a half-typed form.
 *   4. Reduced motion must still REVEAL. A rule that removed the animation by removing the
 *      end state would hide the form from the users who need it most.
 *   5. The panel must not reintroduce the page scroll the landing layout was tuned to avoid,
 *      even on the tallest step of the journey.
 *
 * Each of those is a test below. No sleeps except where a 500ms transition has to settle before
 * a computed style is read, which is unavoidable and marked.
 */

import { test, expect } from "@playwright/test";

test("collapsed: the form is not in the a11y tree or the tab order", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  // `hidden lg:block` + aria-hidden means the panel exists in the DOM but is not reachable.
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden();
  await expect(page.getByRole("textbox", { name: /email/i })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/r-1-closed.png" });
});

test("below lg the CTA navigates instead of revealing", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await page.waitForURL("**/login");
  /* ⚠ A REAL NAVIGATION, ASSERTED BY THE FORM RATHER THAN BY A HEADING. This used to look for
     the standalone shell's `<h1>Sign in</h1>`; that shell is gone — /login now renders the same
     split layout, where the card's "Sign in" heading is `sr-only` and the page `<h1>` is the
     brand mark. The durable assertion is that a navigation happened and the form is usable. */
  await expect(page.getByRole("textbox", { name: /email/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.screenshot({ path: "test-results/r-4-mobile-nav.png" });
});

test("with JS disabled the CTA is still a working link", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  const href = await page.getByRole("link", { name: "Get started" }).getAttribute("href");
  expect(href).toBe("/login");
  await ctx.close();
});

test("reduced motion still reveals, just without the slide", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const d = await page.locator("#signin-panel").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(d)).toBeLessThan(0.001);
  await expect(page.locator("#signin-panel")).toHaveCSS("opacity", "1");
});

test("Escape closes and restores the URL", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.keyboard.press("Escape");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeHidden();
});

test("the trigger is removed on open, without moving anything else", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  const cta = page.getByRole("link", { name: "Get started" });
  await expect(cta).toBeVisible();

  // The pillars' position before and after is the assertion that matters: `invisible` rather
  // than unmounting is what stops the vertically-centred hero re-centring and dragging them up.
  const pillarsBefore = (await page.getByRole("list").first().boundingBox())!;

  await cta.click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.waitForTimeout(700); // the 500ms transition has to settle before measuring

  await expect(cta).toBeHidden();
  const pillarsAfter = (await page.getByRole("list").first().boundingBox())!;
  expect(pillarsAfter.y, "the pillars must not jump when the CTA goes").toBe(pillarsBefore.y);

  await page.screenshot({ path: "test-results/r-2-open.png" });
});

test("the card leads with the brand mark instead of Sign in / Welcome back.", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();

  const panel = page.locator("#signin-panel");
  await expect(panel.getByRole("img", { name: /Praimana/i }).or(
    panel.getByText("Praimana")
  ).first()).toBeVisible();

  // The visible strings are gone; the heading is not — it is `sr-only`, so the card still has
  // an entry in the document outline and the form's purpose is still announced.
  await expect(panel.getByText("Welcome back.")).toBeHidden();
  await expect(panel.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const clip = await panel
    .getByRole("heading", { name: "Sign in" })
    .evaluate((el) => getComputedStyle(el).position);
  expect(clip, "the heading is visually hidden, not styled away").toBe("absolute");
});

test("no Back control under the card, but Escape still dismisses", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await expect(page.locator("#signin-panel").getByRole("button", { name: "Back" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByRole("link", { name: "Get started" })).toBeVisible();
});


/**
 * ⚠ THE TALL-STEP GUARANTEE, SIMULATED BECAUSE THE REAL STEP NEEDS COGNITO.
 *
 * The journey behind the panel has twelve screens and TOTP enrolment is roughly twice the
 * height of sign-in: a QR code, a copyable secret and recovery text. Reaching it for real needs
 * a live pool and an authenticator, so the property under test — "however tall the panel's
 * content gets, the PAGE does not scroll, the panel does" — is exercised by injecting a tall
 * block into the panel instead.
 *
 * This is testing the container's contract, not the auth flow, and the container is the thing
 * that would break. Without the `max-h` + `overflow-y-auto`, this assertion fails.
 */
test("a tall step scrolls the panel, never the page", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  const before = await page.evaluate(() => document.documentElement.scrollHeight);

  // 1200px of content is comfortably taller than any real step.
  await page.evaluate(() => {
    const scroller = document.querySelector("#signin-panel > div");
    const tall = document.createElement("div");
    tall.style.height = "1200px";
    tall.setAttribute("data-test-tall", "");
    scroller!.appendChild(tall);
  });

  const after = await page.evaluate(() => ({
    doc: document.documentElement.scrollHeight,
    inner: window.innerHeight,
    panelScrolls: (() => {
      const el = document.querySelector("#signin-panel > div") as HTMLElement;
      return el.scrollHeight > el.clientHeight;
    })(),
  }));

  expect(after.panelScrolls, "the panel takes the overflow").toBe(true);
  expect(after.doc, "the document height is unchanged").toBe(before);
  expect(after.doc).toBeLessThanOrEqual(after.inner);
});

/**
 * ── ⚠ THE HEADING IS CENTRED ON EVERY STEP, THE FORM ON NONE OF THEM ──────────────────────
 *
 * Two assertions in one test because they are the same decision seen from both sides. Centring
 * a card's title is a design choice; centring the labels beneath it is a defect, because it
 * destroys the left edge the eye tracks down a field list. This pins the boundary.
 *
 * "Reset your password" is checked specifically rather than only the first step: the request
 * that prompted this named it, and it is reached by a real click through the panel, so it also
 * proves the centring survives a step change rather than being hard-coded on the entry screen.
 */
test("every step centres its heading and no step centres its fields", async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 890 });
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // ⚠ THE TRANSITION HAS TO SETTLE FIRST. Without this the card and the row inside it get
  // sampled at different points of the 500ms slide, so their centres differ by however far the
  // panel travelled between the two measurements — a ~9px "failure" that is purely the clock.
  await page.waitForTimeout(700);

  const card = page.locator("#signin-panel div.bg-surface-3");
  const cardMid = async () => {
    const b = (await card.boundingBox())!;
    return b.x + b.width / 2;
  };

  // Step 1 — the brand mark stands in for the title, and must be centred as a GROUP (logo plus
  // wordmark), which is why the flex wrapper exists: `text-center` alone does not move an
  // inline-flex row.
  const markRow = page.locator("#signin-panel div.bg-surface-3 div.flex.justify-center").first();
  const mb = (await markRow.boundingBox())!;
  expect(Math.abs((await cardMid()) - (mb.x + mb.width / 2))).toBeLessThan(2);

  // Step 2 — a real click through to another step.
  await page.getByRole("button", { name: /forgot password/i }).click();
  const heading = page.getByRole("heading", { name: "Reset your password" });
  await expect(heading).toBeVisible();
  const hb = (await heading.boundingBox())!;
  expect(Math.abs((await cardMid()) - (hb.x + hb.width / 2))).toBeLessThan(2);

  // ...and the field beneath it is still left-aligned.
  const label = page.locator("#signin-panel label").first();
  expect(await label.evaluate((el) => getComputedStyle(el).textAlign)).not.toBe("center");
});
