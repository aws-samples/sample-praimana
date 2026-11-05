/**
 * ── THE TEAM WORKSPACE HARNESS CONTRACT ──────────────────────────────────────────────────────
 *
 * Nine routes share one layout. Every one must render with the shared fixture and request no
 * procedure that is not stubbed — the same guarantee `admin-harness.spec.ts` gives /admin, for the
 * same reason: an unstubbed procedure renders an error or loading state that is indistinguishable
 * from a product bug.
 *
 * ⚠ IT EARNED ITS KEEP IMMEDIATELY. `submission.ensure` is a MUTATION the submit page fires on
 * mount to create the team's draft, so reading the page for `useQuery` calls misses it entirely.
 * `expectAllProceduresStubbed()` named it rather than leaving the submit page in a broken state
 * that would have been diagnosed as something else.
 */
import { test, expect } from "@playwright/test";
import { readNextAuthSecret } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc, expectAllProceduresStubbed } from "./fixtures/trpc";
import { ADMIN_SELF, WORKSHOP_ID, TEAM_ID, selfMember } from "./fixtures/data";
import { teamWorkspace } from "./fixtures/team-workspace";

const { secret } = readNextAuthSecret();

const BASE = `/w/${WORKSHOP_ID}/t/${TEAM_ID}`;
const ROUTES = ["", "/phases", "/board", "/chat", "/team", "/submit", "/ai", "/insights"];
for (const r of ROUTES) {
  test(`workspace${r || "/(index)"} renders with every procedure stubbed`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await signInAs(context, ADMIN_SELF, secret!);
    const log = await serveTrpc(page, teamWorkspace(ADMIN_SELF, [selfMember(ADMIN_SELF)]));
    await page.goto(BASE + r);
    await expect(page.locator("header").first()).toBeVisible();

    /* ⚠ WAIT FOR THE REQUEST LIST TO SETTLE, NOT FOR `networkidle`. This used
       `waitForLoadState("networkidle")`, which passed alone and flaked in the full parallel suite:
       under load it resolved before the route's queries had gone out, so the assertion below ran
       against an empty request list and reported success for a page that had not fetched anything.
       Polling until the count stops changing is deterministic at any worker count, and it is the
       condition this assertion actually depends on. */
    let seen = -1;
    await expect
      .poll(
        () => {
          const settled = log.requested.length === seen && seen > 0;
          seen = log.requested.length;
          return settled;
        },
        { timeout: 10_000 }
      )
      .toBe(true);

    const body = await page.locator("body").innerText();
    console.log(`${r || "/(index)"}: unhandled=[${log.unhandled.join(" ")}] stuck=${/Loading|Checking/.test(body)}`);
    expectAllProceduresStubbed(log);
    await page.screenshot({ path: `test-results/W${(r || "-index").replace(/\//g, "-")}.png`, fullPage: true });
  });
}

/**
 * ── ⚠ THE FOOTER, AND THE MAGIC NUMBER THAT HAD TO GO FIRST ─────────────────────────────────
 *
 * REPORTED: the footer was missing on every tab in the team workspace. It was — this layout never
 * rendered one, unlike `experiences/[id]/layout.tsx`.
 *
 * Adding it was not a one-liner. Five pages under this shell sized themselves with
 * `h-[calc(100vh-12rem)]`, where `12rem` was a hand-measured stand-in for "the header plus the
 * nav". A footer makes that arithmetic wrong by exactly the footer's height, and because `main`
 * carries `overflow-hidden` the excess would have been CLIPPED rather than scrolled — the chat
 * composer, the board columns and the AI transcript pushed silently out of view.
 *
 * `main` is a flex column now and those pages use `flex-1 min-h-0`, so nothing encodes the
 * chrome's height. The assertion below is therefore not "a footer exists" but "the footer is
 * inside the viewport", which is what would have failed under the old arithmetic.
 */
for (const r of ["/team", "/board", "/chat", "/insights", "/phases"]) {
  test(`footer is present on ${r}`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 850 });
    await signInAs(context, ADMIN_SELF, secret!);
    await serveTrpc(page, teamWorkspace(ADMIN_SELF, [selfMember(ADMIN_SELF)]));
    await page.goto(BASE + r);
    const footer = page.locator("footer");
    await expect(footer).toBeVisible();
    const box = (await footer.boundingBox())!;
    const vh = await page.evaluate(() => window.innerHeight);
    console.log(`${r}: footer bottom ${Math.round(box.y + box.height)} / viewport ${vh}`);
    expect(box.y + box.height, "the footer must be inside the viewport, not clipped below it").toBeLessThanOrEqual(vh + 1);
  });
}

test("chat transcript and composer share one centred measure", async ({ page, context }) => {
  await page.setViewportSize({ width: 1512, height: 850 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, teamWorkspace(ADMIN_SELF, [selfMember(ADMIN_SELF)]));
  await page.goto(BASE + "/chat");
  const composer = page.getByRole("textbox", { name: /message your team/i });
  await expect(composer).toBeVisible();
  const m = await page.evaluate(() => {
    const ta = document.querySelector("textarea")!;
    const box = ta.closest("div")!.getBoundingClientRect();
    const empty = document.querySelector("main p")!.closest("div")!.getBoundingClientRect();
    return { boxL: Math.round(box.left), boxR: Math.round(box.right), boxW: Math.round(box.width), vw: window.innerWidth, emptyMid: Math.round(empty.left + empty.width / 2) };
  });
  console.log(`composer ${m.boxL}..${m.boxR} (w ${m.boxW}) in viewport ${m.vw}`);
  expect(m.boxW, "the composer must be narrower than the window").toBeLessThan(m.vw * 0.65);
  expect(Math.abs(m.boxL - (m.vw - m.boxR)), "and centred").toBeLessThan(6);
  await page.screenshot({ path: "test-results/W2-chat.png" });
});

/**
 * ── THE SHELL SCROLLS, NOT THE WINDOW ────────────────────────────────────────────────────────
 *
 * The workspace layout was `min-h-screen`, and `min-height` is a FLOOR, not a ceiling: a busy chat
 * grew the flex column past the viewport and the DOCUMENT scrolled, measured at 2231px. Everything
 * the operator needs fixed — the header, the experience bar, the tab bar, the footer, and the chat
 * composer — scrolled away with it, so sending a message meant scrolling to find the box first.
 *
 * `h-dvh` + `overflow-hidden` gives the shell a definite height (`dvh`, not `vh`, so mobile browser
 * chrome is excluded), which is the precondition for `flex-1 min-h-0` to bound anything at all.
 *
 * Two properties must hold TOGETHER, because satisfying either alone breaks the page:
 *
 *   - THE WINDOW NEVER SCROLLS, which is what keeps the chrome in place.
 *   - NOTHING IS UNREACHABLE. `main` was `overflow-hidden`; against a fixed-height shell that would
 *     have satisfied the first property by CLIPPING the document-like pages — content simply gone,
 *     no scrollbar to reveal it. `overflow-y-auto` is what makes them scroll instead.
 */

/** 60 messages: comfortably taller than any viewport this suite uses. */
const manyMessages = Array.from({ length: 60 }, (_, i) => ({
  id: `m${i}`,
  teamId: TEAM_ID,
  userId: ADMIN_SELF.id,
  user: { id: ADMIN_SELF.id, name: "Ada Admin", email: ADMIN_SELF.email },
  content: `Message number ${i}, long enough to occupy a full line so the transcript genuinely overflows.`,
  createdAt: new Date(Date.UTC(2026, 7, 29, 9, 0, i)).toISOString(),
}));

test("the chat composer stays on screen and the transcript scrolls instead", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, {
    ...teamWorkspace(ADMIN_SELF, [selfMember(ADMIN_SELF)]),
    "message.list": () => ({ messages: manyMessages, nextCursor: null }),
  });
  await page.goto(`${BASE}/chat`);
  await expect(page.getByText("Message number 59")).toBeAttached();

  const m = await page.evaluate(() => {
    const composer = document.querySelector("textarea")!.getBoundingClientRect();
    return {
      windowScrollable: document.documentElement.scrollHeight - window.innerHeight,
      composerVisible: composer.bottom <= window.innerHeight && composer.top >= 0,
    };
  });
  expect(m.windowScrollable, "the window must not scroll").toBe(0);
  expect(m.composerVisible, "the composer must be on screen without scrolling").toBe(true);

  /* And the 2231px has to have gone SOMEWHERE reachable, not been clipped away. */
  const t = await page.evaluate(async () => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => d.scrollHeight > d.clientHeight + 50 && getComputedStyle(d).overflowY === "auto"
    )!;
    el.scrollTop = el.scrollHeight;
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    return { scrollable: el.scrollHeight - el.clientHeight, after: el.scrollTop };
  });
  expect(t.scrollable, "the transcript must be the scroll container").toBeGreaterThan(100);
  expect(t.after, "and must scroll to the newest message").toBeGreaterThan(100);
});

test("a long roster scrolls inside main rather than being clipped", async ({ page, context }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await signInAs(context, ADMIN_SELF, secret!);
  const roster = Array.from({ length: 25 }, (_, i) => ({
    id: `mem${i}`,
    userId: `u${i}`,
    role: i === 0 ? "LEAD" : "MEMBER",
    user: { id: `u${i}`, name: `Person ${i}`, email: `p${i}@example.test` },
  }));
  await serveTrpc(page, teamWorkspace(ADMIN_SELF, roster));
  await page.goto(`${BASE}/team`);
  await expect(page.getByText("Person 24")).toBeAttached();

  const r = await page.evaluate(() => {
    const main = document.querySelector("main")!;
    return {
      mainScrollable: main.scrollHeight - main.clientHeight,
      windowScrollable: document.documentElement.scrollHeight - window.innerHeight,
    };
  });
  expect(r.mainScrollable, "a 25-member roster must be scrollable inside main").toBeGreaterThan(100);
  expect(r.windowScrollable, "and the window still must not scroll").toBe(0);
  await expect(page.locator("footer")).toBeVisible();
});

/* ⚠ THE INDEX IS NOT A SCREEN. `page.tsx` at the workspace root is a bare `redirect()` to `/team`,
   so measuring it raced the navigation and destroyed the evaluation context ~1 run in 3. It gets an
   explicit redirect assertion instead of a layout one, and `/team` is measured on its own below. */
test("the workspace index redirects to the team tab", async ({ page, context }) => {
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, teamWorkspace(ADMIN_SELF, [selfMember(ADMIN_SELF)]));
  await page.goto(BASE);
  await page.waitForURL(`**${BASE}/team`);
});

for (const r of ROUTES.filter((route) => route !== "")) {
  test(`workspace${r} keeps the chrome fixed and its content reachable`, async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 640 });
    await signInAs(context, ADMIN_SELF, secret!);
    await serveTrpc(page, {
      ...teamWorkspace(ADMIN_SELF, [selfMember(ADMIN_SELF)]),
      "message.list": () => ({ messages: manyMessages, nextCursor: null }),
    });
    await page.goto(BASE + r);
    await expect(page.locator("footer")).toBeVisible();

    const m = await page.evaluate(() => {
      const overflowing = [...document.querySelectorAll<HTMLElement>("main, main *")].filter(
        (el) => el.scrollHeight > el.clientHeight + 8
      );
      return {
        windowScrollable: document.documentElement.scrollHeight - window.innerHeight,
        overflowing: overflowing.length,
        scrollable: overflowing.filter((el) => /auto|scroll/.test(getComputedStyle(el).overflowY)).length,
      };
    });
    expect(m.windowScrollable, "the window must never scroll under this shell").toBe(0);
    if (m.overflowing > 0) {
      expect(m.scrollable, "overflowing content must sit in a scrollable box, not be clipped")
        .toBeGreaterThan(0);
    }
  });
}
