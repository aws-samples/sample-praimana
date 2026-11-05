/**
 * ⚠ THE REGRESSION THAT SHIPPED TO DEV — a removed member rendering in TWO lists at once.
 *
 * Fixed in 81bc473. Pinned until now only by unit tests (`src/lib/trpc-team-queries.test.ts`),
 * which run under `environment: "node"` with no DOM and therefore assert on the shape the
 * mapper RETURNS. They cannot observe what the browser paints, and "the same person is in
 * both lists" is a statement about the painted page.
 *
 * ── WHY THIS FILE USES THE GATEWAY STUB AND NOT serveTrpc ──
 *
 * This is the load-bearing decision in this file, and getting it wrong would have produced a
 * confidently-wrong defect report. The filter is in the ROUTER:
 *
 *     src/lib/trpc/routers/team.ts:83-89
 *     .filter((m: any) => String(m?.status ?? "").trim().toUpperCase() !== "INACTIVE")
 *
 * The PAGE has no filter and never did — team/page.tsx:928 renders `team.members.map(...)`
 * over whatever it is handed. So `serveTrpc`, which replaces the router, would let a spec
 * hand the page an unfiltered roster and then "discover" that the INACTIVE person renders in
 * Members. That assertion would FAIL AGAINST CORRECT PRODUCTION CODE. It would be a defect
 * manufactured by the harness.
 *
 * So this file stubs the far side of `backendFetch` instead (fixtures/gateway.ts) — the
 * gateway on :8080 that `.env` already points BACKEND_URL at. The real router
 * runs, the real filter runs, the real layout derives `isMember` from the real filtered
 * array, and the browser paints the real result. That is the only configuration in which
 * these four assertions mean anything.
 *
 * ── ONE FILE, ONE WORKER, ONE PORT ──
 *
 * :8080 binds once, so every spec here shares one stub started in `beforeAll`, and the file
 * pins `workers: 1`.
 *
 * ⚠ BOTH `mode: "serial"` AND `workers: 1` ARE REQUIRED, and the second was added after a real
 * flake — worth writing down, because "serial" reads as though it should have been enough.
 *
 * A single run passed 8/8. `--repeat-each=10` reported `8 passed, 63 did not run` with:
 *
 *     Error: e2e gateway stub could not bind :8080 — something is already listening.
 *
 * The first diagnosis (a `close()` racing the next `beforeAll` within one process) was WRONG,
 * and making the fixture a per-process singleton did not fix it. The actual cause, from
 * Playwright's own first line of output: `Running 80 tests using 5 workers`. `--repeat-each`
 * parallelises repetitions across WORKER PROCESSES, and a per-process singleton cannot
 * de-duplicate a port across five processes. Four of them lost the race.
 *
 * `mode: "serial"` orders tests WITHIN a worker; it says nothing about how many workers exist.
 * `workers: 1` is the declaration that this file owns a real, singular OS resource.
 *
 * Kept as a documented constraint rather than by making the stub pick a free port: the port is
 * not the harness's choice. `.env` sets BACKEND_URL="http://localhost:8080", and a
 * stub on a random port would require editing that file — i.e. changing configuration the
 * application reads, to make a test pass. The constraint is real, so it is stated.
 *
 * ── REPEATING THIS FILE ──
 *
 * `--workers=1` must be passed alongside `--repeat-each`. Playwright offers no per-file worker
 * pin (`describe.configure` takes `mode` and `retries`, not `workers`), and this suite's
 * `playwright.config.ts` deliberately sets no global `workers` — capping it there would slow
 * every other spec file to serialise one. So it is a property of the COMMAND:
 *
 *     pnpm exec playwright test roster-status --repeat-each=10 --workers=1     ✅
 *     pnpm exec playwright test roster-status --repeat-each=10                 ❌ port race
 *
 * `beforeAll` fails loudly with the bind error rather than degrading, so getting this wrong is
 * one legible line — never a silent pass against an unknown backend.
 *
 * ── NO SLEEPS ──
 * Every wait is a Playwright web-first assertion polling a condition. The two negative
 * assertions (`toHaveCount(0)`) are ordered AFTER a positive one that proves the list
 * rendered, so "absent" can never be satisfied by "nothing has loaded yet" — the failure mode
 * that makes an exclusion test pass for free.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readNextAuthSecret, missingSecretMessage } from "./fixtures/env";
import { signInAs, type SpecIdentity } from "./fixtures/session";
import { ADMIN_SELF } from "./fixtures/data";
import {
  startGateway,
  type GatewayHandle,
  type ServiceMemberRow,
  type ServiceFormerMemberRow,
} from "./fixtures/gateway";

const { secret, whereLooked } = readNextAuthSecret();

const WORKSHOP_ID = "wksp-e2e-0001";
const TEAM_ID = "team-e2e-0001";
const TEAM_NAME = "Team Peregrine";
const TEAM_URL = `/w/${WORKSHOP_ID}/t/${TEAM_ID}/team`;

/** The person who is still on the team. Must always be in Members. */
const ACTIVE_ROW: ServiceMemberRow = {
  userId: "sub-active-1",
  role: "BUILDER",
  status: "ACTIVE",
  user: { id: "sub-active-1", name: "Active Alice", email: "alice@example.test" },
};

/** The person who was removed. The membership row survives, marked INACTIVE. */
function removedRow(status: string): ServiceMemberRow {
  return {
    userId: "sub-removed-1",
    role: "BUILDER",
    status,
    user: { id: "sub-removed-1", name: "Removed Robin", email: "robin@example.test" },
  };
}

/** The SAME person as an audit-derived former-members row — both lists name them. */
const REMOVED_FORMER: ServiceFormerMemberRow = {
  userId: "sub-removed-1",
  name: "Removed Robin",
  email: "robin@example.test",
  removedAt: "2026-08-01T14:30:00.000Z",
  removedByName: "Ada Admin",
  removedByRole: "ADMIN",
  reason: null,
  joinedAt: "2026-07-01T09:00:00.000Z",
};

let gateway: GatewayHandle;

// SERIAL, so the tests in this file cannot interleave on the shared stub's mutable state.
// NOT sufficient on its own for repetitions — see the ⚠ note in the header and REPEATING THIS
// FILE below.
test.describe.configure({ mode: "serial" });


test.describe("the live roster excludes removed members (regression 81bc473)", () => {
  test.beforeAll(async () => {
    test.skip(!secret, missingSecretMessage(whereLooked));
    gateway = await startGateway({
      teamId: TEAM_ID,
      teamName: TEAM_NAME,
      workshopId: WORKSHOP_ID,
      me: { ...ADMIN_SELF },
    });
  });

  test.afterAll(async () => {
    await gateway?.close();
  });

  test.beforeEach(() => {
    test.skip(!secret, missingSecretMessage(whereLooked));
    // Reset the shared stub, so one test's roster cannot leak into the next.
    gateway.state.members = [];
    gateway.state.formerMembers = [];
    gateway.state.formerMembersTruncated = false;
    gateway.state.formerMembersStatus = null;
    gateway.state.requests.length = 0;
  });

  /** Sign in and land on the team page, with the roster already rendered. */
  async function openTeamPage(
    page: Page,
    context: BrowserContext,
    identity: SpecIdentity = ADMIN_SELF
  ) {
    gateway.state.me = { ...identity };
    await signInAs(context, identity, secret!);
    await page.goto(TEAM_URL);
    // Proves the page rendered AND `getById` resolved — one condition covering both, so no
    // later "absent" assertion can be satisfied by an unloaded page.
    await expect(page.getByRole("heading", { name: /^Members/ })).toBeVisible();
  }

  /** The Members panel only. Scoped so a name in Former members cannot satisfy it. */
  function membersPanel(page: Page) {
    return page.locator("#members-panel");
  }

  /** The Former members panel only. */
  function formerPanel(page: Page) {
    return page.locator("#former-members-panel");
  }

  /**
   * ── SCENARIO 14 — THE REPORTED DEFECT ──
   *
   * One ACTIVE row and one INACTIVE row, and the same person also present in the
   * audit-derived former-members list. The INACTIVE person must appear in Former members and
   * NOWHERE in Members.
   *
   * The two negative assertions are deliberately scoped to `#members-panel` rather than to
   * the page: "Removed Robin" IS on this page — correctly, under Former members — so a
   * page-wide `toHaveCount(0)` would fail against correct code, and a page-wide
   * `toBeVisible()` would pass against the defect. The defect is specifically that ONE person
   * is in TWO lists, so the assertion has to be able to tell the lists apart.
   */
  test("scenario 14: an INACTIVE member renders under Former members and NOT in Members", async ({
    page,
    context,
  }) => {
    gateway.state.members = [ACTIVE_ROW, removedRow("INACTIVE")];
    gateway.state.formerMembers = [REMOVED_FORMER];

    await openTeamPage(page, context);

    // FIRST the positive: the roster genuinely rendered its live member. Without this, every
    // assertion below could be satisfied by an empty page.
    await expect(membersPanel(page).getByText("Active Alice")).toBeVisible();

    // The count in the heading is the filtered count. Asserted because it is the one number
    // an operator reads when the panel is collapsed, and a filter applied to the list but not
    // to the count would leave the heading claiming a member who is not shown.
    await expect(page.getByRole("button", { name: /^▶?Members \(1\)/ })).toBeVisible();

    // ── THE DEFECT ── the removed person must not be in the live roster.
    await expect(
      membersPanel(page).getByText("Removed Robin"),
      "REGRESSION 81bc473: an INACTIVE membership row rendered in the Members list. The same " +
        "person is then shown as both current and former, which says the relationship both " +
        "ended and did not. The exclusion is at routers/team.ts:84 and must survive."
    ).toHaveCount(0);
    await expect(
      membersPanel(page).getByRole("button", {
        name: `Remove Removed Robin from ${TEAM_NAME}`,
      }),
      "A removed person must not carry a live Remove control on the roster."
    ).toHaveCount(0);

    // And they ARE in the other list, which is the half that proves the row was not simply
    // dropped everywhere. Expand it — it is collapsed by default.
    await page.getByRole("button", { name: /Former members/ }).click();
    await expect(formerPanel(page).getByText("Removed Robin")).toBeVisible();
    await expect(
      formerPanel(page).getByRole("button", {
        name: `Restore access to ${TEAM_NAME} for Removed Robin`,
      })
    ).toBeVisible();

    // The live member must NOT have leaked into the history list either — the inverse
    // mistake, and just as wrong.
    await expect(formerPanel(page).getByText("Active Alice")).toHaveCount(0);
  });

  /**
   * ── SCENARIO 15 — THE LEGACY ROW. THE DANGEROUS DIRECTION. ──
   *
   * A membership row with NO `status` field at all must still render in Members, because
   * absent means ACTIVE. This is the assertion that catches the tempting "tidy-up" refactor
   * from `!== "INACTIVE"` to `=== "ACTIVE"`.
   *
   * That refactor is not merely cosmetic. `team.getById`'s members array is ALSO what the
   * workspace layout derives `isMember` from (layout.tsx:74-77), and `isMember` decides which
   * tabs exist (layout.tsx:139, 306). So the strict form would empty every legacy team's
   * roster AND hide six navigation tabs from every member of those teams — a platform-wide
   * lockout dressed as a tidy-up.
   *
   * Both halves are asserted here, and the tabs half is the one that makes this spec worth
   * more than the unit test beside it: the unit test can check the array, but only a browser
   * can observe that the navigation bar still has its tabs in it.
   */
  test("scenario 15: a member row with NO status field still renders, and keeps the workspace tabs", async ({
    page,
    context,
  }) => {
    // NO `status` key at all — a row written before the field existed.
    const legacyRow: ServiceMemberRow = {
      userId: ADMIN_SELF.id,
      role: "LEAD",
      user: { id: ADMIN_SELF.id, name: ADMIN_SELF.name, email: ADMIN_SELF.email },
    };
    const legacyPeer: ServiceMemberRow = {
      userId: "sub-legacy-peer",
      role: "BUILDER",
      user: { id: "sub-legacy-peer", name: "Legacy Lee", email: "lee@example.test" },
    };
    gateway.state.members = [legacyRow, legacyPeer];

    // Signed in AS the legacy member, so `isMember` is about this caller's own row — which is
    // what makes the tab assertion below a real consequence rather than a coincidence.
    await openTeamPage(page, context, ADMIN_SELF);

    await expect(
      membersPanel(page).getByText("Legacy Lee"),
      "A membership row with NO `status` attribute must render: absent means ACTIVE. A filter " +
        "written as `status === \"ACTIVE\"` would empty every legacy team's roster — see the " +
        "polarity note at routers/team.ts:72-81."
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^▶?Members \(2\)/ })).toBeVisible();

    // ── THE SECOND-ORDER CONSEQUENCE ── the workspace tabs are derived from this same array.
    const nav = page.getByRole("navigation", { name: "Team sections" });
    // ⚠ "Submit", NOT "Code". This list previously read "Code" and failed on a tab that no
    // longer exists: `PhaseArtifacts.tsx:13` records it being dissolved — "It used to be: a
    // top-level 'Code' tab with three sub-tabs (Docs, Commits, Contributors)". The list is
    // deliberately the six `gated: true` entries in layout.tsx:211-220, and nothing else, because
    // the point of the loop is that MEMBERSHIP-GATED tabs survive an unstatused row. Ungated
    // "Team" is excluded for the same reason: it proves nothing here.
    for (const label of ["Phases", "Board", "Team Chat", "AI Chats", "Insights", "Submit"]) {
      await expect(
        nav.getByRole("link", { name: new RegExp(label) }),
        `The workspace tab "${label}" is gated on \`isMember\`, which layout.tsx:74 derives ` +
          `from the SAME filtered members array. A strict \`=== "ACTIVE"\` filter would hide ` +
          `all six tabs from every member of every legacy team — a platform-wide lockout.`
      ).toBeVisible();
    }
    // And the "you are not a member" explanation must NOT be on screen.
    await expect(
      page.getByText("You are not a member of this team"),
      "A legacy member IS a member. This sentence appearing would mean `isMember` went false."
    ).toHaveCount(0);
  });

  /**
   * ── SCENARIO 16 — CASE AND WHITESPACE TOLERANCE ──
   *
   * `"inactive"` and `" INACTIVE "` must be excluded exactly as `"INACTIVE"` is. The reason is
   * given at routers/team.ts:79 — the constant is copied across bundles, and a casing
   * difference must not be what decides whether a removed person still appears on a roster.
   *
   * Run as a loop over the variants rather than three near-identical tests, because the
   * variants are the boundary matrix for one field and a reader should see them as one set.
   * `"ACTIVE "` (trailing space, the ALLOW value) is included as the control: it must be
   * INCLUDED, which proves the trim is not simply excluding anything it cannot parse.
   */
  for (const { label, status, excluded } of [
    { label: "lowercase", status: "inactive", excluded: true },
    { label: "padded uppercase", status: " INACTIVE ", excluded: true },
    { label: "mixed case", status: "InAcTiVe", excluded: true },
    { label: "padded ALLOW value (control — must be INCLUDED)", status: " ACTIVE ", excluded: false },
  ]) {
    test(`scenario 16: status ${JSON.stringify(status)} (${label}) is ${
      excluded ? "excluded from" : "kept in"
    } the roster`, async ({ page, context }) => {
      gateway.state.members = [ACTIVE_ROW, removedRow(status)];
      gateway.state.formerMembers = excluded ? [REMOVED_FORMER] : [];

      await openTeamPage(page, context);
      await expect(membersPanel(page).getByText("Active Alice")).toBeVisible();

      if (excluded) {
        await expect(
          membersPanel(page).getByText("Removed Robin"),
          `status ${JSON.stringify(status)} must be excluded. The comparison at ` +
            `routers/team.ts:84 upper-cases and trims for exactly this reason: the constant is ` +
            `copied across bundles and a casing difference must not decide whether a removed ` +
            `person still has a place on the roster.`
        ).toHaveCount(0);
        await expect(page.getByRole("button", { name: /^▶?Members \(1\)/ })).toBeVisible();
      } else {
        await expect(
          membersPanel(page).getByText("Removed Robin"),
          `status ${JSON.stringify(status)} is the ALLOW value with padding and must be KEPT. ` +
            `A filter that excluded it would be excluding on failure-to-match rather than on ` +
            `the DENY value, which is the legacy-lockout defect in a different disguise.`
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /^▶?Members \(2\)/ })).toBeVisible();
      }
    });
  }

  /**
   * THE WHOLE ROSTER INACTIVE — the empty-list edge of the same filter.
   *
   * Worth its own test because "no members yet. Share the invite code above to add members."
   * is a specific and reassuring sentence, and it is the correct one here: everybody was
   * removed. What must NOT happen is the roster rendering the removed people because the list
   * would otherwise be empty.
   *
   * It also pins the second-order consequence in the opposite direction from scenario 15: an
   * INACTIVE row must not satisfy `isMember`, so the gated tabs must be GONE. A removed person
   * silently keeping their workspace shell is what the 81bc473 message calls out at
   * team.ts:67-70.
   */
  test("an all-INACTIVE roster renders empty, and does not re-grant the workspace tabs", async ({
    page,
    context,
  }) => {
    gateway.state.members = [
      { ...removedRow("INACTIVE"), userId: ADMIN_SELF.id, user: { id: ADMIN_SELF.id, name: ADMIN_SELF.name } },
    ];
    gateway.state.formerMembers = [{ ...REMOVED_FORMER, userId: ADMIN_SELF.id, name: ADMIN_SELF.name }];

    await openTeamPage(page, context, ADMIN_SELF);

    await expect(page.getByText("No members yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^▶?Members \(0\)/ })).toBeVisible();

    // The caller's own INACTIVE row must not read as membership.
    const nav = page.getByRole("navigation", { name: "Team sections" });
    await expect(
      nav.getByRole("link", { name: /Board/ }),
      "An INACTIVE membership row must not satisfy `isMember`. Counting one would silently " +
        "re-grant a removed person the whole workspace shell — team.ts:67-70."
    ).toHaveCount(0);
    await expect(page.getByText("You are not a member of this team")).toBeVisible();
  });

  /**
   * THE ROUTER GENUINELY WENT TO THE SERVICE for the unfiltered roster.
   *
   * A guard on this harness rather than on the product, and it earns its place: if a future
   * change made `getById` stop calling `/members` (a cache, a merged endpoint), every
   * exclusion assertion above would pass trivially against a roster that was never fetched.
   * This asserts the stub was actually asked, so those tests cannot silently become vacuous.
   */
  test("harness guard: the router fetched the unfiltered roster from the service", async ({
    page,
    context,
  }) => {
    gateway.state.members = [ACTIVE_ROW, removedRow("INACTIVE")];
    await openTeamPage(page, context);
    await expect(membersPanel(page).getByText("Active Alice")).toBeVisible();

    expect(
      gateway.countOf(`/v1/teams/${TEAM_ID}/members`),
      `The router must have called GET /v1/teams/:id/members — that is where the INACTIVE ` +
        `rows come from, and the filter under test operates on its response. Paths seen: ` +
        `${JSON.stringify(gateway.state.requests)}`
    ).toBeGreaterThanOrEqual(1);
  });
});
