/**
 * ADMIN'S ALIGNED ROWS — the browser-only contract.
 *
 * The admin tabs were redesigned from stacks of self-laying-out cards into aligned column grids,
 * so the property worth pinning is the alignment itself, and it can only be measured on a rendered
 * page.
 *
 * ⚠ THE FIRST VERSION OF THIS TEST PASSED AGAINST THE BUG. It gave all three fixture rows the same
 * action-column text, so their columns lined up by coincidence while an `auto` track was already
 * making width depend on per-row content. The rows below deliberately DIFFER in that column, and
 * the `isSelf` row is the one that exposed it in production: its explanation ("This is you, so you
 * cannot change your own access") is far longer than any other row's, so its `auto` column grew,
 * squeezed the flexible name column, and pushed its role badge ~100px left of the rest.
 *
 * ⚠ AND IT MEASURES A GRID CELL BY POSITION, NOT BY TEXT. `children[1]` is the role column
 * whatever that row happens to hold, so the assertion cannot be satisfied by matching a string
 * that only some rows have.
 */
import { test, expect } from "@playwright/test";
import { readNextAuthSecret } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc } from "./fixtures/trpc";
import { ADMIN_SELF } from "./fixtures/data";
import { adminScreen } from "./fixtures/admin-screen";
const { secret } = readNextAuthSecret();

/**
 * ⚠ THE ROWS MUST DIFFER IN THEIR LAST COLUMN. The previous alignment test gave all three rows the
 * same action-column content, so they lined up by accident and passed against an `auto` track that
 * was already broken. `isSelf` is the row that exposed it in production: its explanation is much
 * longer than any other row's.
 */
const users = [
  { id: ADMIN_SELF.id, name: "Example Admin", email: "admin@example.com", role: "ADMIN", organization: "AWS", status: "ACTIVE", invitedBy: null, isSelf: true, hasAccount: true },
  { id: "u2", name: "Priya Raman", email: "priya@example.test", role: "FACILITATOR", organization: "Acme", status: "ACTIVE", invitedBy: null, isSelf: false, hasAccount: true },
  { id: "u3", name: "Tomas Nowak", email: "tomas@example.test", role: "PARTICIPANT", organization: null, status: "DEACTIVATED", invitedBy: null, isSelf: false, hasAccount: true },
];

test("role badges form one column even when the action column differs per row", async ({ page, context }) => {
  await page.setViewportSize({ width: 1512, height: 950 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, {
    ...adminScreen(ADMIN_SELF),
    "admin.listUsers": () => ({ users, nextCursor: null, scopeTruncated: false }),
  });
  await page.goto("/admin?tab=users");
  await expect(page.getByText("Example Admin")).toBeVisible();

  const rows = page.locator("main ul > li");
  await expect(rows).toHaveCount(3);

  // Measure the SECOND grid cell of each row — the role column — not a text match, so the
  // assertion holds whatever each row happens to contain.
  const lefts = await rows.evaluateAll((els) =>
    els.map((li) => Math.round((li.children[1] as HTMLElement).getBoundingClientRect().left))
  );
  console.log("role column left edges:", JSON.stringify(lefts), "distinct:", new Set(lefts).size);
  expect(new Set(lefts).size, "every row's role column must start at the same x").toBe(1);

  await page.screenshot({ path: "test-results/A-align.png", fullPage: true });
});

/**
 * ── ⚠ THE LIST IS A BORDERED PANEL, AND THE ROWS ARE NOT BORDERED BOXES ─────────────────────
 *
 * REPORTED: rows had "a thick border on the left but no right border, and the top row is missing
 * both". True, and a design gap rather than a rendering bug — the list drew only `border-y` plus
 * dividers, so there were no vertical edges at all, which left the user row's 4px `border-l`
 * STATUS marker as the only vertical border on screen. It read as a half-drawn box.
 *
 * The fix is deliberately NOT a border on all four sides of every row: that is a stack of forty
 * cards, the exact treatment these lists were converted away from. Bordering the COLLECTION gives
 * each row a left and right edge, the first row a top and the last a bottom, one hairline between
 * any two, and puts the status marker back inside a frame where it reads as a status.
 *
 * `overflow-hidden` is asserted alongside the radius because without it a row's own background — a
 * hover, or a deactivated account's tinted surface — squares off the corners the panel rounded.
 */
test("the list is a bordered panel on all four sides", async ({ page, context }) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, {
    ...adminScreen(ADMIN_SELF),
    "admin.listUsers": () => ({ users, nextCursor: null, scopeTruncated: false }),
  });
  await page.goto("/admin?tab=users");
  await expect(page.getByText("Example Admin")).toBeVisible();

  const panel = page.locator("main ul").first();
  const w = await panel.evaluate((el) => {
    const c = getComputedStyle(el);
    return { t: c.borderTopWidth, r: c.borderRightWidth, b: c.borderBottomWidth, l: c.borderLeftWidth, radius: c.borderTopLeftRadius, overflow: c.overflow };
  });
  console.log("panel borders:", JSON.stringify(w));
  for (const side of ["t", "r", "b", "l"] as const) {
    expect(parseFloat(w[side]), `the panel must have a ${side} border`).toBeGreaterThan(0);
  }
  expect(parseFloat(w.radius), "rounded").toBeGreaterThan(0);
  expect(w.overflow, "overflow-hidden so a row background cannot square the corners").toBe("hidden");

  await page.screenshot({ path: "test-results/panel-users.png", fullPage: true });
});

/**
 * ── ⚠ `divide-*` OVERRIDES SINGLE-SIDE BORDER COLOURS, AND THAT SHIPPED ─────────────────────
 *
 * REPORTED: "from the second row the left side border is a big thick" — with the CSS quoted.
 *
 * `divide-hairline` compiles to `.divide-hairline > :not([hidden]) ~ :not([hidden])`, which sets
 * `border-color` on ALL FOUR SIDES at specificity (0,3,0): one class plus two `:not([hidden])`,
 * each counting as an attribute selector. A single-side colour utility like
 * `.border-l-transparent` is (0,1,0) and loses.
 *
 * So the user row's status marker — `border-l-4` plus `border-l-transparent` on active rows, to
 * reserve the width in both states — kept its 4px width but had its colour replaced with the
 * hairline from the second row down. Row one was untouched because the sibling combinator never
 * matches the first child, which is exactly why it presented as "every row but the top one".
 *
 * Measured before: row 1 `4px rgba(0,0,0,0)`, rows 2+ `4px rgb(230,231,233)`.
 *
 * The marker is now an inset box-shadow: immune to border-colour rules, and drawn inside the
 * padding box so it costs no layout — a stronger version of the guarantee the transparent border
 * was there to provide.
 *
 * ⚠ THIS TEST READS EVERY ROW, not the first. A guard that checked one row would have passed
 * against the bug, because the first row was the one that was correct.
 */
test("no row carries a stray side border, and the status marker still renders", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1512, height: 900 });
  await signInAs(context, ADMIN_SELF, secret!);
  await serveTrpc(page, {
    ...adminScreen(ADMIN_SELF),
    "admin.listUsers": () => ({ users, nextCursor: null, scopeTruncated: false }),
  });
  await page.goto("/admin?tab=users");
  await expect(page.getByText("Example Admin")).toBeVisible();

  const rows = page.locator("main ul > li");
  const sides = await rows.evaluateAll((els) =>
    els.map((e) => {
      const c = getComputedStyle(e);
      return {
        left: parseFloat(c.borderLeftWidth),
        right: parseFloat(c.borderRightWidth),
        shadow: c.boxShadow,
      };
    })
  );
  for (const [i, s] of sides.entries()) {
    expect(s.left, `row ${i + 1} must have no left border`).toBe(0);
    expect(s.right, `row ${i + 1} must have no right border`).toBe(0);
  }

  // The deactivated row is the third fixture row, and its marker must survive the change.
  expect(sides[2].shadow, "the no-access row keeps its inset edge").toContain("inset");
  expect(sides[0].shadow, "an active row carries no marker").not.toContain("inset");
});
