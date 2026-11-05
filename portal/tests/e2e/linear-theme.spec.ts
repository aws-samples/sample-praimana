/**
 * THE LINEAR REBRAND PILOT — the browser-only contract.
 *
 * ── WHY THIS CANNOT BE A UNIT TEST ──
 * `vitest.config.mts` runs `environment: "node"` with no DOM and no CSS engine, so a unit test
 * can assert that `page.tsx` contains the string `bg-canvas` and nothing more. That assertion is
 * worthless here, because every way this change can break lives in the cascade rather than in the
 * markup:
 *
 *   1. `bg-canvas` compiles to `background-color: var(--canvas)`, which is TRANSPARENT if
 *      Tailwind never emitted the utility or the variable never resolved. A class-name check
 *      passes just as happily against a page rendering on white.
 *   2. Bare `border-b` / `border-t` (the footer, several page headers) resolve through the base
 *      layer's `*` rule, not through a class on the element. That rule read a SEPARATE legacy HSL
 *      variable for most of this work, so the page was ruled in the wrong grey — in the dark
 *      variant, light grey on near-black, which is exactly what the first cut shipped. It now
 *      reads `--hairline` directly, and these assertions are what proves it.
 *   3. The canvas had two sources of truth for one colour: hex-exact `--canvas` for every utility
 *      and an HSL approximation for `body`. They differed by one unit per channel in the dark
 *      palette. Asserting the computed background of `body` against the exact value is what
 *      caught that.
 *
 * All three are properties of resolved CSS, so all three are asserted here as `getComputedStyle`
 * values against the exact hex in DESIGN.md — never as class names, and never as a screenshot
 * diff, which would fail on font rendering long before it caught a token regression.
 *
 * ── NO SLEEPS ──
 * Every wait is a Playwright web-first assertion.
 */

import { test, expect, type Page } from "@playwright/test";
import { readNextAuthSecret, missingSecretMessage } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc, deferred } from "./fixtures/trpc";
import { ADMIN_SELF, EXECUTIVE_SELF, meFixture } from "./fixtures/data";

const { secret, whereLooked } = readNextAuthSecret();

/**
 * The palette, as the assertions read it: DESIGN.md's hex converted to the `rgb(r, g, b)` form
 * `getComputedStyle` returns. Written out rather than computed from the CSS so that a spec failure
 * names the colour that was expected — a test that derives its expectation from the file under
 * test proves only that the file agrees with itself.
 */
const LINEAR = {
  canvas: "rgb(255, 255, 255)", //  #ffffff
  surface1: "rgb(245, 246, 246)", // #f5f6f6
  surface2: "rgb(235, 237, 240)", // #ebedf0
  ink: "rgb(28, 29, 33)", //         #1c1d21
  inkSubtle: "rgb(92, 97, 105)", //  #5c6169
  hairline: "rgb(230, 231, 233)", // #e6e7e9
  brand: "rgb(94, 106, 210)", //     #5e6ad2  (the fill; unchanged across both modes)
  statusActive: "rgb(26, 127, 55)", //  #1a7f37
  statusPending: "rgb(168, 110, 0)", // #a86e00
  statusIdle: "rgb(139, 145, 153)", //  #8b9199
} as const;

/** The dark variant, still shipped and opted into with `data-theme="linear-dark"`. */
const LINEAR_DARK = {
  canvas: "rgb(1, 1, 2)", //        #010102
  surface1: "rgb(15, 16, 17)", //   #0f1011
  ink: "rgb(247, 248, 248)", //     #f7f8f8
  hairline: "rgb(35, 37, 42)", //   #23252a
  inkTertiary: "rgb(124, 130, 139)", // #7c828b — was #62666d, which failed AA at 3.62:1
  statusIdle: "rgb(97, 101, 108)", //   #61656c — was #3e3e44, invisible at 1.96:1
} as const;

/**
 * Four workshops covering all three status TONES plus the one that used to be mis-toned.
 *
 * ⚠ `COMPLETED`, NOT `COMPLETE`. The first version of this fixture invented `COMPLETE`, which
 * is not a value the services emit — the real lifecycle is DRAFT / REGISTRATION / ACTIVE /
 * JUDGING / COMPLETED / ARCHIVED. A fixture with a fake enum would have passed against a
 * portal that mishandled every real one, so it is pinned to the actual union here.
 *
 * ⚠ JUDGING IS IN THE SET DELIBERATELY. The list's original three-branch ternary painted it
 * with the "idle" grey reserved for finished events; teams are actively being scored in it.
 * Row 4 is the regression guard for that.
 *
 * Team counts are deliberately different digit-lengths (6, 12, 4, 9) — that is what makes the
 * `tabular-nums` column-alignment assertion meaningful.
 */
const WORKSHOPS = [
  {
    id: "wksp-active",
    name: "Frontier Agents Accelerator",
    description: "Six teams building agentic workflows against a live retail dataset.",
    format: "IN_PERSON",
    status: "ACTIVE",
    createdAt: new Date("2026-08-01T09:00:00Z"),
    _count: { teams: 6 },
  },
  {
    id: "wksp-registration",
    name: "Bedrock Foundations",
    description: "Introductory track for first-time participants.",
    format: "VIRTUAL",
    status: "REGISTRATION",
    createdAt: new Date("2026-08-20T09:00:00Z"),
    _count: { teams: 12 },
  },
  {
    id: "wksp-completed",
    name: "Q2 Executive Briefing",
    description: "Archived for reference and scoring review.",
    format: "HYBRID",
    status: "COMPLETED",
    createdAt: new Date("2026-05-14T09:00:00Z"),
    _count: { teams: 4 },
  },
  {
    id: "wksp-judging",
    name: "Supply Chain Optimisation Sprint",
    description: "Submissions closed, judges scoring now.",
    format: "IN_PERSON",
    status: "JUDGING",
    createdAt: new Date("2026-07-02T09:00:00Z"),
    _count: { teams: 9 },
  },
];

const cssOf = (page: Page, selector: string, property: string) =>
  page.evaluate(
    ([sel, prop]) => {
      const el = document.querySelector(sel as string);
      if (!el) throw new Error(`no element matched ${sel}`);
      return getComputedStyle(el).getPropertyValue(prop as string).trim();
    },
    [selector, property]
  );

test.describe("Linear rebrand pilot on /experiences", () => {
  test.skip(!secret, missingSecretMessage(whereLooked));

  test("renders the Linear palette as resolved CSS, not as class names", async ({
    page,
    context,
  }) => {
    await signInAs(context, ADMIN_SELF, secret!);
    await serveTrpc(page, {
      "auth.me": () => meFixture(ADMIN_SELF),
      "workshop.list": () => WORKSHOPS,
    });

    await page.goto("/experiences");
    await expect(page.getByRole("heading", { name: "Experiences", level: 2 })).toBeVisible();

    // (1) The palette resolved. ⚠ NO `[data-theme]` ANY MORE: while the rebrand was a pilot the
    // Linear values were scoped to an attribute per screen; every screen speaks in tokens now, so
    // the block was promoted to `:root` and the attributes deleted. The assertion moves to `body`,
    // which is where the canvas is painted.
    await expect(page.locator("[data-theme]")).toHaveCount(0);
    expect(await cssOf(page, "body", "background-color")).toBe(LINEAR.canvas);
    expect(await cssOf(page, "h2", "color")).toBe(LINEAR.ink);

    // (2) THE REGRESSION THIS SPEC EXISTS FOR. Both of these borders are written as bare
    // `border-b` / `border-t`, so they resolve through the OLD `--border` hsl token rather than
    // through `--hairline`. If the bridging block in globals.css is ever dropped, these are the
    // assertions that fail — and they now catch a 2-value difference (#e6e7e9 vs the stock
    // #e5e7eb), which is exactly the kind of drift no one spots by eye.
    expect(await cssOf(page, "header", "border-bottom-color")).toBe(LINEAR.hairline);
    expect(await cssOf(page, "footer", "border-top-color")).toBe(LINEAR.hairline);

    // (3) Rows are transparent until hovered, separated by hairline dividers rather than by
    // nine bordered card panels. The list itself carries the rules.
    const list = page.getByRole("list").filter({ has: page.getByRole("link") }).first();
    const rows = list.getByRole("listitem");
    await expect(rows).toHaveCount(4);
    const firstRow = page.getByRole("link", { name: /Frontier Agents Accelerator/ });
    await expect(firstRow).toBeVisible();
    expect(await firstRow.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)"
    );
    expect(
      await rows.nth(1).evaluate((el) => getComputedStyle(el).borderTopColor)
    ).toBe(LINEAR.hairline);

    // Hover lifts one surface step. Asserted because it replaced `hover:shadow-sm`, which was
    // invisible on this canvas — so "the hover does something" is not self-evident here.
    await firstRow.hover();
    await expect
      .poll(() => firstRow.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(LINEAR.surface1);

    // (4) The status vocabulary. Four rows, and JUDGING must read as LIVE, not finished.
    const dots = page.locator("main li span.rounded-full");
    await expect(dots).toHaveCount(4);
    expect(
      await dots.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))
    ).toEqual([
      LINEAR.statusActive, // ACTIVE
      LINEAR.statusPending, // REGISTRATION
      LINEAR.statusIdle, // COMPLETED
      LINEAR.statusActive, // ⚠ JUDGING — was painted with the idle grey before this change
    ]);

    // (5) No transport enum reaches the screen. `IN_PERSON` and `REGISTRATION` were rendered
    // raw; a SHOUTING_SNAKE_CASE string on screen is the assertion, not the specific wording.
    const mainText = await page.locator("main").innerText();
    expect(mainText).not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);
    expect(mainText).toContain("In person");
    expect(mainText).toContain("Registration open");
    expect(mainText).toContain("Judging");

    // (6) THE ALIGNMENT PROPERTY, which is the whole reason the card grid was replaced. Team
    // counts of 6 / 12 / 4 / 9 have different digit widths, so with proportional figures and
    // per-card `justify-between` they landed at four different x-positions. Right-aligned in a
    // fixed track with tabular figures, their right edges must agree exactly.
    const teamCells = page.locator("main li span", { hasText: /^\d+ teams?$/ });
    await expect(teamCells).toHaveCount(4);
    const rightEdges = await teamCells.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().right))
    );
    expect(new Set(rightEdges).size).toBe(1);
    expect(
      await teamCells.first().evaluate((el) => getComputedStyle(el).fontVariantNumeric)
    ).toContain("tabular-nums");

    // (7) Dates name their month, so no reader has to guess day/month order.
    expect(mainText).toContain("1 Aug 2026");
    expect(mainText).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);

    await page.screenshot({ path: "test-results/linear-experiences-list.png", fullPage: true });
  });

  /**
   * The skeleton has to land on the SAME grid the real rows use, because a placeholder that
   * differs in geometry is just a different layout jump. Both render from the one `ROW_GRID`
   * constant; this proves that constant is actually shared rather than duplicated and drifted.
   */
  test("the loading skeleton occupies the same layout as the loaded list", async ({
    page,
    context,
  }) => {
    await signInAs(context, ADMIN_SELF, secret!);

    // Hold the list query open so the skeleton is the stable rendered state, rather than
    // racing a fast response with a sleep.
    const gate = deferred<typeof WORKSHOPS>();
    await serveTrpc(page, {
      "auth.me": () => meFixture(ADMIN_SELF),
      "workshop.list": gate.handler,
    });

    await page.goto("/experiences");

    // The chrome and the heading are already present — that is the point of the skeleton.
    await expect(page.getByRole("heading", { name: "Experiences", level: 2 })).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Loading experiences");

    const skeletonRows = page.locator("main ul[aria-hidden='true'] > li");
    await expect(skeletonRows).toHaveCount(3);
    const skeletonHeadingX = (await page
      .getByRole("heading", { name: "Experiences", level: 2 })
      .boundingBox())!.x;

    await page.screenshot({ path: "test-results/linear-experiences-loading.png", fullPage: true });

    gate.release(WORKSHOPS);

    // Once resolved, the heading has not moved: no layout jump on load.
    await expect(page.getByRole("link", { name: /Frontier Agents/ })).toBeVisible();
    const loadedHeadingX = (await page
      .getByRole("heading", { name: "Experiences", level: 2 })
      .boundingBox())!.x;
    expect(loadedHeadingX).toBe(skeletonHeadingX);
  });

  /**
   * `prefers-reduced-motion` is an accessibility setting, not a theme preference, so the rule
   * is global rather than scoped to the pilot. Playwright can emulate it, which makes this
   * cheap to pin — and it is the kind of rule that gets silently dropped in a refactor.
   */
  test("honours prefers-reduced-motion", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signInAs(context, ADMIN_SELF, secret!);
    await serveTrpc(page, {
      "auth.me": () => meFixture(ADMIN_SELF),
      "workshop.list": () => WORKSHOPS,
    });

    await page.goto("/experiences");
    const row = page.getByRole("link", { name: /Frontier Agents Accelerator/ });
    await expect(row).toBeVisible();

    // Near-zero rather than exactly zero: a true 0s duration stops some browsers firing
    // `transitionend`, so the rule uses 0.01ms deliberately.
    const duration = await row.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(duration)).toBeLessThan(0.001);
  });

  test("empty state spends the accent on the single next action", async ({ page, context }) => {
    await signInAs(context, ADMIN_SELF, secret!);
    await serveTrpc(page, {
      "auth.me": () => meFixture(ADMIN_SELF),
      "workshop.list": () => [],
    });

    await page.goto("/experiences");

    const cta = page.getByRole("link", { name: "Create Experience" });
    await expect(cta).toBeVisible();
    // The one branded fill on the screen. `text-brand-ink` over `bg-brand` is the pairing
    // DESIGN.md specifies for button-primary.
    expect(await cta.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(LINEAR.brand);
    expect(await cta.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");

    // The empty panel needs its own surface to be visible on a near-black canvas at all.
    const panel = page.locator("main div.border-dashed");
    expect(await panel.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      LINEAR.surface1
    );

    await page.screenshot({ path: "test-results/linear-experiences-empty.png", fullPage: true });
  });

  /**
   * ⚠ A LAYOUT ASSERTION IN A THEME SPEC, ON PURPOSE — it was found by looking at the two
   * screenshots side by side, and nothing else in the suite would have caught it.
   *
   * <main> carries `mx-auto`, which as a flex item beats the default `align-self: stretch`,
   * so before `w-full` it was sized to its CONTENT: the heading sat at the left margin when
   * the list had rows and jumped ~340px right when it did not. Comparing the two positions is
   * the only cheap way to pin that, because either state alone looks perfectly correct.
   */
  test("the heading holds its position whether or not the list has rows", async ({
    page,
    context,
  }) => {
    const headingX = async (rows: typeof WORKSHOPS | []) => {
      await signInAs(context, ADMIN_SELF, secret!);
      await serveTrpc(page, {
        "auth.me": () => meFixture(ADMIN_SELF),
        "workshop.list": () => rows,
      });
      await page.goto("/experiences");
      const heading = page.getByRole("heading", { name: "Experiences", level: 2 });
      await expect(heading).toBeVisible();
      const box = await heading.boundingBox();
      if (!box) throw new Error("heading has no box");
      return box.x;
    };

    const withRows = await headingX(WORKSHOPS);
    const empty = await headingX([]);
    expect(empty).toBe(withRows);
  });

  test("the tokenized DesktopAppCard follows the theme it is dropped into", async ({
    page,
    context,
  }) => {
    // EXECUTIVE rather than ADMIN because `canSignInToDesktopApp` is what gates this card,
    // and an admin is deliberately not offered it.
    await signInAs(context, EXECUTIVE_SELF, secret!);
    await serveTrpc(page, {
      "auth.me": () => meFixture(EXECUTIVE_SELF),
      "workshop.list": () => WORKSHOPS,
      "desktop.releases": () => [],
      "desktop.connectLink": () => null,
    });

    await page.goto("/experiences");

    const card = page.locator("section", { hasText: "Get the desktop app" });
    await expect(card).toBeVisible();

    // ⚠ THE BORDER IS THE DISCRIMINATING CHECK IN LIGHT MODE, NOT THE BACKGROUND. `--surface-3`
    // is #ffffff in the Linear light palette AND #ffffff in the stock defaults, so asserting the
    // card's background proves nothing about whether the rewrite is token-driven — it passes
    // equally against the hardcoded `bg-white` this replaced. `--hairline` does discriminate:
    // #e6e7e9 here versus the stock #e5e7eb that `border-gray-200` used to give.
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
      LINEAR.hairline
    );

    // And the background IS proven token-driven by swapping the palette: a hardcoded white
    // would not move, whereas `bg-surface-3` follows to #18191a.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "linear-dark"));
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      "rgb(24, 25, 26)"
    );
    expect(await card.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
      LINEAR_DARK.hairline
    );
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

    await page.screenshot({ path: "test-results/linear-experiences-executive.png", fullPage: true });
  });
});

/**
 * ── EVERY THEMED SCREEN, NOT JUST THE FIRST ONE ─────────────────────────────────────────────
 *
 * The pilot has grown from one route to the whole entry funnel, and the failure mode changes
 * with it: the risk is no longer "does the theme work" but "did screen five get the attribute
 * and screen six not". That is invisible in review (both palettes are light, and the stock
 * greys are within two points of the Linear ones) and obvious in a computed-style check.
 *
 * Driven as a table so adding a screen is one line. `auth.me` is served for all of them because
 * every authenticated screen renders ProfileMenu.
 */
const THEMED_SCREENS = [
  { path: "/", name: "landing", auth: false },
  { path: "/login", name: "login", auth: false },
  { path: "/how-it-works", name: "how-it-works", auth: true },
  { path: "/experiences", name: "experiences", auth: true },
  { path: "/welcome", name: "welcome", auth: true },
] as const;

test.describe("the Linear palette resolves on every themed screen", () => {
  test.skip(!secret, missingSecretMessage(whereLooked));

  for (const screen of THEMED_SCREENS) {
    test(`${screen.name} carries the theme and resolves --ink`, async ({ page, context }) => {
      if (screen.auth) {
        await signInAs(context, ADMIN_SELF, secret!);
        // One handler map for every screen in the table: a missing procedure is served as a
        // tRPC error, which would leave the page in a state that renders no footer and fails
        // the visibility wait below with a confusing message rather than a clear one.
        await serveTrpc(page, {
          "auth.me": () => meFixture(ADMIN_SELF),
          "workshop.list": () => WORKSHOPS,
          "team.listMyInvitations": () => [],
          "desktop.releases": () => [],
          "desktop.connectLink": () => null,
        });
      }
      await page.goto(screen.path);
      await expect(page.locator("footer")).toBeVisible();

      // ⚠ NO SCREEN CARRIES A THEME ATTRIBUTE NOW. The palette is on `:root`, so a stray
      // `data-theme` would mean somebody re-introduced per-screen scoping — which is how the two
      // halves of the app drifted apart the first time.
      await expect(page.locator("[data-theme]")).toHaveCount(0);

      // ⚠ `--ink` IS THE DISCRIMINATING TOKEN. rgb(28 29 33) (Linear) vs rgb(17 24 39) (stock) —
      // indistinguishable on screen, which is exactly why it is asserted rather than eyeballed.
      // A screen that forgot the attribute renders stock and fails here.
      //
      // ⚠ ASSERTED AS A RESOLVED COLOUR, NOT AS THE VARIABLE'S TEXT. An earlier version compared
      // `--ink` to the string "#1c1d21", which broke the moment the tokens moved from hex to bare
      // RGB channels (the format Tailwind needs to compose `/50` opacity modifiers) — even though
      // nothing rendered any differently. Reading the computed colour off a real element tests the
      // thing that matters and survives the next change of token format.
      const inkColour = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.className = "text-ink";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(inkColour).toBe("rgb(28, 29, 33)");
      const brandColour = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.className = "bg-brand";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      });
      expect(brandColour).toBe("rgb(94, 106, 210)");

      // No transport enum and no emoji anywhere in the rendered body. The landing page opened
      // its three pillars with 🎯 🤖 👥, which are OS-font glyphs a brand cannot control and
      // which screen readers announce as "direct hit", "robot face", "busts in silhouette".
      const body = await page.locator("body").innerText();
      expect(body, "raw SHOUTING_SNAKE_CASE enum on screen").not.toMatch(/[A-Z]{2,}_[A-Z]{2,}/);

      // ⚠ PICTOGRAPHS ONLY (U+1F300–1FAFF). The first version of this assertion also spanned
      // U+2600–27BF, which is the Dingbats block — and that swept in `✓` and `✕`, which
      // `ActionOutcome` uses deliberately as functional status glyphs. A test that fails on the
      // design system's own iconography is a broken test, not a finding. The narrower range
      // still catches everything this rule is actually about: 🎯 🤖 👥 on the landing page and
      // the 🎉 that sat next to the reader's name on /welcome.
      expect(body, "emoji used as iconography or tone").not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);

      // ⚠ NO EM-DASHES IN VISIBLE COPY. A house rule, and the reason it needs a test rather
      // than a style note is that it is invisible in review: an em-dash reads fine to whoever
      // wrote it and there were 27 of them across these screens before anyone counted. A comma,
      // colon or full stop carries the same pause and reads as prose rather than as dictation.
      //
      // ⚠ EN-DASHES IN NUMERIC RANGES ARE DELIBERATELY ALLOWED. "5–15 words" is correct
      // typography, not the pattern being banned, so the class here is the em-dash alone plus a
      // standalone en-dash used as punctuation between words — never one sitting between digits.
      const emDashes = body.split("\n").filter((l) => /—|(?<!\d)\s–\s(?!\d)/.test(l));
      expect(emDashes, `em-dash in visible copy on ${screen.path}`).toEqual([]);
    });
  }
});

/**
 * ── THE DARK VARIANT ──
 * `data-theme="linear-dark"` is still shipped, so it is still tested — CSS that nothing
 * exercises is CSS that silently rots. Driven by setting the attribute on the live page rather
 * than by adding a route, because the token layer is the unit under test, not the page.
 *
 * The two values checked here are the ones that were WRONG in the dark palette until it was
 * measured: both are re-asserted so a well-meaning "restore DESIGN.md's exact values" edit has
 * to argue with a failing test.
 */
test.describe("the dark variant still resolves", () => {
  test.skip(!secret, missingSecretMessage(whereLooked));

  test("swapping the attribute swaps the whole palette, with the contrast fixes intact", async ({
    page,
    context,
  }) => {
    await signInAs(context, ADMIN_SELF, secret!);
    await serveTrpc(page, {
      "auth.me": () => meFixture(ADMIN_SELF),
      "workshop.list": () => WORKSHOPS,
    });

    await page.goto("/experiences");
    await expect(page.getByRole("link", { name: /Frontier Agents/ })).toBeVisible();

    // Light first, so the swap below is demonstrably a change rather than a coincidence.
    expect(await cssOf(page, "body", "background-color")).toBe(LINEAR.canvas);

    // ⚠ SET ON <html>, because no page carries the attribute any longer — the light palette is
    // `:root` and `linear-dark` is the one remaining opt-in. This is exactly how a consumer would
    // enable it, so the test enables it the same way.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "linear-dark"));

    expect(await cssOf(page, "body", "background-color")).toBe(LINEAR_DARK.canvas);
    expect(await cssOf(page, "h2", "color")).toBe(LINEAR_DARK.ink);
    expect(await cssOf(page, "footer", "border-top-color")).toBe(LINEAR_DARK.hairline);

    // ⚠ The two measured fixes. `--ink-tertiary` carries the 12px dates and team counts and was
    // #62666d (3.62:1 — an AA failure); `--status-idle` was #3e3e44 (1.96:1 — the completed dot
    // was all but invisible).
    const dateCell = page.locator("main li span", { hasText: /^\d{1,2} \w{3} \d{4}$/ }).first();
    expect(await dateCell.evaluate((el) => getComputedStyle(el).color)).toBe(
      LINEAR_DARK.inkTertiary
    );
    const idleDot = page.locator("main li span.rounded-full").nth(2); // COMPLETED
    expect(await idleDot.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      LINEAR_DARK.statusIdle
    );

    await page.screenshot({ path: "test-results/linear-dark-variant.png", fullPage: true });
  });
});

/**
 * ── ⚠ THE CONTAINMENT TEST IS GONE, ON PURPOSE ─────────────────────────────────────────────
 *
 * It used to load /profile as a control and assert it still rendered the STOCK greys, proving the
 * pilot's `[data-theme]` scope held. That assertion is now false by design: every screen is
 * tokenised, the Linear block was promoted to `:root`, and /profile is meant to look like the rest
 * of the product.
 *
 * What replaced it is the table above, which walks every themed route and asserts the palette
 * RESOLVES on each — the same defect ("this screen did not get the rebrand") caught from the other
 * direction, and now without a control screen that has to be deliberately left behind.
 */
