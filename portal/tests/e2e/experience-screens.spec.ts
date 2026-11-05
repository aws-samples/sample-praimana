/**
 * ── THE EXPERIENCE SUB-PAGES AND THE REMAINING SCREENS ──────────────────────────────────────
 *
 * Nine routes, each asserted to render with the shared fixture, to request no unstubbed procedure,
 * and to carry EXACTLY ONE `<h1>`.
 *
 * ⚠ THE `h1` COUNT IS NOT DECORATION. Three screens in this product shipped a second level-one
 * heading under a layout that already owned one — the experience Settings page, the team page, and
 * four of the experience sub-pages. Each duplicated the same string ~60px apart and broke the
 * document outline a screen-reader user navigates by. Counting them is one line and catches the
 * whole class.
 */
import { test, expect } from "@playwright/test";
import { readNextAuthSecret } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc, expectAllProceduresStubbed } from "./fixtures/trpc";
import { ADMIN_SELF, WORKSHOP_ID } from "./fixtures/data";
import {
  experienceScreen,
  welcomeScreen,
  profileScreen,
  newExperienceScreen,
} from "./fixtures/experience-screen";

const { secret } = readNextAuthSecret();

const EXP = `/experiences/${WORKSHOP_ID}`;

const CASES: [string, string, () => Record<string, import("./fixtures/trpc").ProcedureHandler>][] = [
  ["overview", EXP, () => experienceScreen(ADMIN_SELF)],
  ["activity", `${EXP}/activity`, () => experienceScreen(ADMIN_SELF)],
  ["results", `${EXP}/results`, () => experienceScreen(ADMIN_SELF)],
  ["submissions", `${EXP}/submissions`, () => experienceScreen(ADMIN_SELF)],
  ["settings", `${EXP}/settings`, () => experienceScreen(ADMIN_SELF)],
  ["welcome", "/welcome", () => welcomeScreen(ADMIN_SELF)],
  ["profile", "/profile", () => profileScreen(ADMIN_SELF)],
  ["new", "/experiences/new", () => newExperienceScreen(ADMIN_SELF)],
  ["desktop", "/desktop", () => profileScreen(ADMIN_SELF)],
];

for (const [name, path, handlers] of CASES) {
  test(`${name} renders with every procedure stubbed`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await signInAs(context, ADMIN_SELF, secret!);
    const log = await serveTrpc(page, handlers());
    await page.goto(path);
    await expect(page.locator("footer")).toBeVisible();
    let seen = -1;
    await expect.poll(() => { const s = log.requested.length === seen && seen > 0; seen = log.requested.length; return s; }, { timeout: 10_000 }).toBe(true);
    const body = await page.locator("body").innerText();
    const h1s = await page.locator("h1").count();
    console.log(`${name}: unhandled=[${log.unhandled.join(" ")}] stuck=${/Loading|Checking/.test(body)} h1s=${h1s}`);
    expectAllProceduresStubbed(log);
    expect(h1s, `${name} must have exactly one <h1>`).toBe(1);
    expect(body, "no raw transport enum on screen").not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
    expect(body, "no 'undefined' rendered into copy").not.toContain("undefined");
    await page.screenshot({ path: `test-results/B4-${name}.png`, fullPage: true });
  });
}
