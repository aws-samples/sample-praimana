/**
 * THE ADMINISTRATION TEAMS DIRECTORY (`/admin?tab=teams`) — the browser-only contract.
 *
 * ── WHAT THE UNIT SUITE STRUCTURALLY CANNOT REACH ──
 * The portal's vitest runs `environment: "node"` with no DOM (vitest.config.mts), so
 * every assertion in this file is about something that suite cannot observe by construction:
 *
 *   - the `disabled` DOM PROPERTY genuinely preventing a click and a keypress. The
 *     implementation says this out loud at admin/page.tsx:1114-1121 — "`disabled={page === 0}`
 *     is the first line of defence and a DOM PROPERTY, which this suite (environment:"node",
 *     no jsonm) cannot exercise — so a refactor that drops it fails silently". This file is
 *     the test that stops it failing silently.
 *   - the `sr-only` text being IN THE ACCESSIBILITY TREE, asserted by an accessible-name query
 *     rather than by grepping the source. A source grep proves a string exists in a file; it
 *     proves nothing about what a screen reader would announce.
 *   - the 300ms debounce coalescing keystrokes into ONE request, counted on the wire.
 *   - `maxLength` refusing the 101st character at the input, before it reaches the wire.
 *   - the amber notice rendering ABOVE the list, i.e. document order, which is a DOM fact.
 *
 * ── THE SEAM, AND WHY IT IS serveTrpc HERE ──
 * Unlike roster-status.spec.ts, everything under test on this screen is in the PAGE
 * (admin/page.tsx's TeamsTab and TeamDirectoryRow). The router does nothing to these fields —
 * it passes them through UNMAPPED and says so at routers/team.ts:628. So the browser-level
 * seam is the correct one: it puts the two documented nulls into the page exactly as a service
 * would, and it lets `page.on("request")` count what genuinely left the browser.
 *
 * ── NO SLEEPS ──
 * Every wait is a web-first assertion or an explicit `waitForResponse`. The debounce test is
 * the one place a duration is unavoidable — the assertion is literally "requests stop arriving
 * after 300ms" — and it is handled by waiting for the SETTLED state (the response for the final
 * needle) and then counting, rather than by sleeping a guessed interval and hoping.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readNextAuthSecret, missingSecretMessage } from "./fixtures/env";
import { signInAs, type SpecIdentity } from "./fixtures/session";
import { ADMIN_SELF, meFixture } from "./fixtures/data";
import {
  serveTrpc,
  countTrpcCalls,
  TrpcFault,
  type ProcedureHandler,
  type TrpcCallLog,
} from "./fixtures/trpc";

const { secret, whereLooked } = readNextAuthSecret();

const TEAMS_URL = "/admin?tab=teams";
/** Fixed, never `new Date()` — a fixture that differs per run makes a failure un-replayable. */
const CREATED_AT = "2026-01-15T09:00:00.000Z";

interface DirectoryRow {
  id: string;
  name: string;
  workshopId: string;
  workshopName: string | null;
  memberCount: number | null;
  createdAt: string;
}

function row(over: Partial<DirectoryRow> & { id: string; name: string }): DirectoryRow {
  return {
    workshopId: "wksp-directory-0001",
    workshopName: "Autumn Accelerator",
    memberCount: 4,
    createdAt: CREATED_AT,
    ...over,
  };
}

function directoryPage(over: {
  teams: DirectoryRow[];
  nextCursor?: string;
  scopeTruncated?: boolean;
}) {
  return {
    teams: over.teams,
    nextCursor: over.nextCursor,
    scopeTruncated: over.scopeTruncated ?? false,
  };
}

/** Put a signed-in ADMIN on the Teams tab with a controlled directory response. */
/**
 * ⚠ PAGING BUTTONS ARE LOOKED UP INSIDE <main>, NEVER ON `page` DIRECTLY.
 *
 * `page.getByRole("button", { name: "Next" })` matches TWO elements when the portal is served
 * by a development build: the directory's own Next button, and React's injected
 * "Open Next.js Dev Tools" button, whose accessible name contains "Next". Playwright's strict
 * mode then fails with `resolved to 2 elements` — which reads exactly like a duplicated
 * control in the product and is not one. On a `next start` build of a production bundle the
 * dev-tools button is absent and the same spec passes, so this failure appears and disappears
 * with the serving mode rather than with the code under test.
 *
 * Scoping to the `main` landmark is the fix rather than `.first()`: the dev-tools button lives
 * outside `main`, `.first()` would silently pick whichever came first in the DOM, and the
 * assertion "there is no paging control" has to mean "none in the tab panel" — which is the
 * claim, and which `.first()` cannot express at all when the expected count is zero.
 */
async function openDirectory(
  page: Page,
  context: BrowserContext,
  handlers: Record<string, ProcedureHandler>,
  { url = TEAMS_URL, identity = ADMIN_SELF }: { url?: string; identity?: SpecIdentity } = {}
): Promise<TrpcCallLog> {
  await signInAs(context, identity, secret!);
  const calls = countTrpcCalls(page);
  await serveTrpc(page, {
    "auth.me": () => meFixture(identity),
    ...handlers,
  });
  await page.goto(url);
  return calls;
}

/** The Teams tab is selected and its heading has rendered. */
async function expectTeamsTabActive(page: Page) {
  await expect(page.getByRole("tab", { name: "Teams" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  await expect(page.getByRole("heading", { name: "Teams", level: 2 })).toBeVisible();
}

test.describe("Administration → Teams directory", () => {
  test.beforeEach(() => {
    test.skip(!secret, missingSecretMessage(whereLooked));
  });

  /**
   * ── SCENARIO 1 ── `?tab=teams` selects the tab; an unrecognised value falls back to Users.
   *
   * Asserted through `aria-selected` rather than a CSS class, because the class is the
   * presentation and `aria-selected` is the CONTRACT — it is what a screen-reader operator is
   * told about which tab they are on, and a class-only assertion would pass a change that made
   * the tab visually active and semantically silent.
   */
  test("scenario 1: ?tab=teams selects the Teams tab", async ({ page, context }) => {
    await openDirectory(page, context, {
      "team.listDirectory": () => directoryPage({ teams: [row({ id: "t1", name: "Alpha" })] }),
    });
    await expectTeamsTabActive(page);
    await expect(page.getByRole("link", { name: "Alpha" })).toBeVisible();
    // Exactly one tab is selected — a state where two read as active is its own defect.
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
  });

  test("scenario 1: an unrecognised ?tab= value falls back to Users, not to a blank panel", async ({
    page,
    context,
  }) => {
    await openDirectory(
      page,
      context,
      {
        "admin.listUsers": () => ({ users: [], nextCursor: undefined, truncated: false }),
        "workshop.list": () => [],
        "team.listDirectory": () => {
          throw new Error("e2e: listDirectory must NOT be queried when the tab is not teams");
        },
      },
      { url: "/admin?tab=not-a-real-tab" }
    );

    await expect(
      page.getByRole("tab", { name: "Users" }),
      "An unrecognised tab value must fall back to Users rather than rendering nothing — " +
        "admin/page.tsx:138. A blank panel is the failure mode this fallback exists to prevent."
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Teams" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    await expect(page.getByRole("heading", { name: "Teams", level: 2 })).toHaveCount(0);
  });

  /**
   * ── SCENARIO 2a ── `memberCount: null` renders "—", NEVER "0", and the sr-only phrase is in
   * the ACCESSIBILITY TREE.
   *
   * The BFF states the rendering in as many words (routers/team.ts:617-622: "Render null as
   * '—', never as zero") and the row repeats why (admin/page.tsx:1148-1151): 0 is a number an
   * operator acts on, and "empty team" is a reason to delete one.
   *
   * The accessibility half is asserted with `getByText` against the sr-only span — a real DOM
   * query against rendered text, which is what the brief asks for and what a source grep cannot
   * give. `sr-only` is a clip-rect utility, so the text IS in the tree and IS matched by a text
   * query while being invisible to the eye; that is exactly the property under test.
   */
  test("scenario 2: memberCount null renders an em dash, never 0, with the sr-only phrase announced", async ({
    page,
    context,
  }) => {
    await openDirectory(page, context, {
      "team.listDirectory": () =>
        directoryPage({
          teams: [
            row({ id: "t-null", name: "Count Unknown", memberCount: null }),
            row({ id: "t-zero", name: "Genuinely Empty", memberCount: 0 }),
            row({ id: "t-one", name: "Exactly One", memberCount: 1 }),
          ],
        }),
    });
    await expectTeamsTabActive(page);

    const nullRow = page.locator("li", { hasText: "Count Unknown" }).first();
    await expect(nullRow).toBeVisible();

    // THE EM DASH, for the eye.
    await expect(nullRow.getByText("— members")).toBeVisible();
    // AND NEVER ZERO. Scoped to the row, and matched exactly so "0" cannot be found inside
    // another number on the line (the created date carries digits).
    await expect(
      nullRow.getByText("0 members", { exact: true }),
      `A null member count must NEVER render as "0 members". The BFF says so at ` +
        `routers/team.ts:621 and the row repeats why at admin/page.tsx:1148 — "we could not ` +
        `count" and "nobody is on this team" are different facts, and 0 is the one an operator ` +
        `acts on by deleting the team.`
    ).toHaveCount(0);

    // THE ACCESSIBILITY TREE. Asserted via a text query against the rendered DOM, not a grep.
    await expect(
      nullRow.getByText("Member count unavailable, the roster could not be read"),
      `The sr-only phrase must be present in the accessibility tree, so this is never ` +
        `announced as a blank cell. The em dash beside it is aria-hidden, so without this ` +
        `phrase a screen-reader operator hears nothing at all where a count should be.`
    ).toBeAttached();

    // The CONTROL rows: a real 0 and a real 1 must render as numbers, with correct pluralisation.
    const zeroRow = page.locator("li", { hasText: "Genuinely Empty" }).first();
    await expect(
      zeroRow.getByText("0 members"),
      "A genuine 0 must still render as 0 — the null case is what must not, and a fallback " +
        "that hid both would make a real empty team unreportable."
    ).toBeVisible();
    const oneRow = page.locator("li", { hasText: "Exactly One" }).first();
    await expect(oneRow.getByText("1 member", { exact: false })).toBeVisible();
  });

  /**
   * ── SCENARIO 2b ── `workshopName` null / "" / " " all fall back to the workshopId, never blank.
   *
   * The three variants are one boundary matrix on one field, so they run as one parameterised
   * set. `" "` is the interesting one: it is TRUTHY, so it slips past a bare truthiness check
   * and renders a cell that LOOKS blank — the exact "data problem" reading the fallback exists
   * to prevent, and the hardest kind to report because there is nothing on screen to quote.
   * The implementation guards it with `?.trim()` at admin/page.tsx:1196.
   */
  for (const { label, workshopName } of [
    { label: "null", workshopName: null },
    { label: "empty string", workshopName: "" },
    { label: "whitespace only", workshopName: " " },
  ] as { label: string; workshopName: string | null }[]) {
    test(`scenario 2: workshopName ${label} falls back to the workshopId, never a blank cell`, async ({
      page,
      context,
    }) => {
      const workshopId = "wksp-fallback-9999";
      await openDirectory(page, context, {
        "team.listDirectory": () =>
          directoryPage({
            teams: [row({ id: "t-fb", name: "Nameless Workshop Team", workshopId, workshopName })],
          }),
      });
      await expectTeamsTabActive(page);

      const teamRow = page
        .locator("li", { hasText: "Nameless Workshop Team" })
        .first();
      await expect(teamRow).toBeVisible();

      // THE ID IS VISIBLE — not a blank, and not "no workshop".
      await expect(
        teamRow.getByText(workshopId),
        `workshopName ${label} must fall back to the workshop id. ${
          label === "whitespace only"
            ? 'A single space is TRUTHY and slips past a bare truthiness check, rendering an invisible cell — which is the "data problem" reading this fallback exists to prevent. The guard is `?.trim()` at admin/page.tsx:1196.'
            : "The id is the value an operator can quote in a ticket or paste into a URL."
        }`
      ).toBeVisible();

      // AND THE REASON IS ANNOUNCED, so the id is legible AS a fallback rather than read as a name.
      await expect(
        teamRow.getByText("Experience name unavailable, experience id"),
        "The sr-only prefix must be in the accessibility tree, or a screen-reader operator " +
          "hears a bare 36-character id with nothing saying it is not the workshop's name."
      ).toBeAttached();
    });
  }

  test("scenario 2: a real workshop name is rendered as-is and carries no fallback wording", async ({
    page,
    context,
  }) => {
    await openDirectory(page, context, {
      "team.listDirectory": () =>
        directoryPage({
          teams: [row({ id: "t-real", name: "Named Team", workshopName: "Autumn Accelerator" })],
        }),
    });
    await expectTeamsTabActive(page);
    const teamRow = page.locator("li", { hasText: "Named Team" }).first();
    await expect(teamRow.getByText("Autumn Accelerator")).toBeVisible();
    await expect(
      teamRow.getByText("Experience name unavailable, experience id"),
      "A row with a real name must not carry the fallback's sr-only wording — a warning that " +
        "fires on healthy data is a warning an operator learns to ignore."
    ).toHaveCount(0);
  });

  /**
   * ── SCENARIO 3 ── `scopeTruncated: true` renders the amber notice ABOVE the list, AND does so
   * simultaneously with an empty result set.
   *
   * The second half is the dangerous combination and the reason this is one test rather than
   * two: an empty list is indistinguishable from a correct one, so an empty directory with no
   * notice above it reads as authoritative. The operator searches for a team, gets nothing, and
   * concludes it does not exist — which routers/team.ts:634-648 identifies as a strictly worse
   * version of the failure the server-side search exists to prevent.
   *
   * "ABOVE the list" is asserted with `compareDocumentPosition`, which is the actual DOM fact.
   * A visual assertion (bounding boxes) would also pass for an absolutely-positioned element
   * that a screen reader encounters last, and reading order is the half that matters here.
   */
  test("scenario 3: scopeTruncated renders the Incomplete list notice ABOVE the list", async ({
    page,
    context,
  }) => {
    await openDirectory(page, context, {
      "team.listDirectory": () =>
        directoryPage({
          teams: [row({ id: "t1", name: "Visible Team" })],
          scopeTruncated: true,
        }),
    });
    await expectTeamsTabActive(page);

    const notice = page.getByText("Incomplete list.");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Paging will not reach those teams");
    await expect(notice).toContainText("A team missing from this list still exists");

    const listRow = page.getByRole("link", { name: "Visible Team" });
    await expect(listRow).toBeVisible();

    // DOCUMENT ORDER, read from the DOM.
    const noticeIsBefore = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("p, a"));
      const n = els.find((e) => e.textContent?.includes("Incomplete list."));
      const l = els.find((e) => e.textContent?.trim().startsWith("Visible Team"));
      if (!n || !l) return null;
      // DOCUMENT_POSITION_FOLLOWING === 4: the list follows the notice.
      return (n.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(
      noticeIsBefore,
      "The truncation notice must precede the list IN DOCUMENT ORDER, not merely appear above " +
        "it visually — admin/page.tsx:1044 states the placement deliberately. A screen-reader " +
        "operator who meets the list first has already read an incomplete directory as complete."
    ).toBe(true);
  });

  test("scenario 3: THE DANGEROUS COMBINATION — scopeTruncated with an EMPTY result set", async ({
    page,
    context,
  }) => {
    await openDirectory(page, context, {
      "team.listDirectory": () => directoryPage({ teams: [], scopeTruncated: true }),
    });
    await expectTeamsTabActive(page);

    // The empty state renders...
    await expect(page.getByText("No teams to show.")).toBeVisible();
    // ...and it must NOT be the only thing on screen. This is the whole assertion.
    await expect(
      page.getByText("Incomplete list."),
      "AN EMPTY LIST MUST NEVER LOOK AUTHORITATIVE. With the scope capped, 'No teams to show' " +
        "is not a statement about the platform — whole experiences are absent from every query " +
        "this screen makes. Rendering the empty state WITHOUT this notice tells the operator " +
        "the team does not exist, which is the trap routers/team.ts:641-648 exists to close."
    ).toBeVisible();
    await expect(page.getByText("0 teams · page 1")).toBeVisible();
  });

  test("scenario 3: a healthy response renders NO truncation notice", async ({ page, context }) => {
    await openDirectory(page, context, {
      "team.listDirectory": () =>
        directoryPage({ teams: [row({ id: "t1", name: "Alpha" })], scopeTruncated: false }),
    });
    await expectTeamsTabActive(page);
    await expect(page.getByRole("link", { name: "Alpha" })).toBeVisible();
    await expect(
      page.getByText("Incomplete list."),
      "A notice raised on healthy data is one an operator learns to ignore, which costs us the " +
        "one render where it matters — routers/team.ts:650."
    ).toHaveCount(0);
  });

  /**
   * ── SCENARIO 4 ── `disabled` GENUINELY PREVENTS THE UNDERFLOW, by click AND by keyboard.
   *
   * THE assertion this file exists for. admin/page.tsx:1114-1121 says the DOM property "is the
   * first line of defence and a DOM PROPERTY, which this suite (environment:"node", no jsdom)
   * cannot exercise — so a refactor that drops it fails silently". This is the test that makes
   * it fail loudly.
   *
   * The consequence, spelled out in that same comment: a bare `c.slice(0, -1)` on a one-element
   * stack yields `[]`, so `page` becomes -1, `cursors[-1]` is undefined, and the query refetches
   * page 1 while the count line reads "page 0".
   *
   * Both input paths are exercised because they fail differently. `disabled` stops a click at
   * the browser level; it also removes the button from the tab order, so the keyboard path
   * additionally proves the operator cannot reach it at all. `dispatchEvent` is used for the
   * click rather than `.click()`, for the reason remove-member.spec.ts's priority 4 gives:
   * Playwright's click refuses a disabled element (it would hang on actionability and the spec
   * would time out rather than assert), while a dispatched event is precisely what a real
   * click's event is — if the handler were live, it would fire.
   */
  test("scenario 4: on page 1 Previous is disabled and the underflow cannot be triggered by click or keyboard", async ({
    page,
    context,
  }) => {
    let directoryCalls = 0;
    const calls = await openDirectory(page, context, {
      "team.listDirectory": (input) => {
        directoryCalls += 1;
        const cursor = (input as { cursor?: string } | undefined)?.cursor;
        expect(
          cursor,
          `On page 1 the cursor must be undefined. A cursor of ${JSON.stringify(cursor)} means ` +
            `the stack underflowed and the query is paging a result set it does not own.`
        ).toBeUndefined();
        return directoryPage({
          teams: [row({ id: "t1", name: "Alpha" })],
          nextCursor: "cursor-page-2",
        });
      },
    });
    await expectTeamsTabActive(page);
    await expect(page.getByRole("link", { name: "Alpha" })).toBeVisible();

    const previous = page.getByRole("main").getByRole("button", { name: "Previous" });
    const next = page.getByRole("main").getByRole("button", { name: "Next" });
    await expect(previous).toBeVisible();

    // THE DOM PROPERTY. Not a class, not aria-disabled — the attribute the browser acts on.
    await expect(
      previous,
      "`disabled={page === 0}` is the first line of defence against the cursor-stack " +
        "underflow, and it is a DOM PROPERTY the node-environment unit suite cannot exercise " +
        "(admin/page.tsx:1116). If this assertion fails, that guard has been refactored away."
    ).toBeDisabled();
    await expect(next, "Next must be live: the response carried a nextCursor.").toBeEnabled();

    const before = directoryCalls;
    const countLine = page.getByText(/page \d+/);
    await expect(countLine).toContainText("page 1");

    // ── ATTEMPT 1: dispatched clicks, five of them. ──
    for (let i = 0; i < 5; i++) await previous.dispatchEvent("click");

    // ── ATTEMPT 2: the keyboard. A disabled button is out of the tab order, so focusing the
    // search box and tabbing must never arrive on it; pressing Enter/Space regardless must do
    // nothing.
    await page.locator("#team-search").focus();
    await previous.focus(); // a no-op on a disabled element — asserted below rather than assumed
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");

    const focusedIsPrevious = await page.evaluate(
      () => (document.activeElement?.textContent ?? "").trim() === "Previous"
    );
    expect(
      focusedIsPrevious,
      "A disabled button cannot take focus, so the keyboard cannot reach Previous on page 1."
    ).toBe(false);

    // ── THE COUNT LINE NEVER READS "page 0". ──
    await expect(
      countLine,
      `The underflow's visible symptom is the count line reading "page 0" while the query ` +
        `refetches page 1 — admin/page.tsx:1119. It must still read "page 1".`
    ).toContainText("page 1");
    await expect(page.getByText("page 0")).toHaveCount(0);

    // ── AND NO REQUEST FIRED. Counted on the wire and in the handler. ──
    expect(
      directoryCalls,
      `Five dispatched clicks plus Enter and Space on a disabled Previous must produce NO ` +
        `additional query. Handler entered ${directoryCalls}x, was ${before}x before.`
    ).toBe(before);
    expect(
      calls.countOf("team.listDirectory"),
      `Counted on the wire via page.on("request"). Saw ${calls.countOf(
        "team.listDirectory"
      )} listDirectory operations; all tRPC ops this run: ${JSON.stringify(calls.paths)}`
    ).toBe(before);
  });

  /**
   * PREVIOUS BECOMES LIVE ON PAGE 2 AND WALKS BACK BY THE CURSOR IT CAME BY.
   *
   * The positive half of scenario 4: proving `disabled` blocks the underflow is only half the
   * contract, because a Previous that is ALWAYS disabled would also pass that test. This one
   * proves the control works when it should, and that the stack — not arithmetic — is what
   * carries the operator back (the cursors are opaque and only ever move forward,
   * admin/page.tsx:914-916).
   */
  test("scenario 4 (inverse): on page 2 Previous is enabled and returns by the cursor it came by", async ({
    page,
    context,
  }) => {
    const cursorsSeen: (string | undefined)[] = [];
    await openDirectory(page, context, {
      "team.listDirectory": (input) => {
        const cursor = (input as { cursor?: string } | undefined)?.cursor;
        cursorsSeen.push(cursor);
        return cursor === "cursor-page-2"
          ? directoryPage({ teams: [row({ id: "t2", name: "Beta" })] })
          : directoryPage({
              teams: [row({ id: "t1", name: "Alpha" })],
              nextCursor: "cursor-page-2",
            });
      },
    });
    await expectTeamsTabActive(page);
    await expect(page.getByRole("link", { name: "Alpha" })).toBeVisible();

    await page.getByRole("main").getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("link", { name: "Beta" })).toBeVisible();
    await expect(page.getByText(/page 2/)).toBeVisible();

    const previous = page.getByRole("main").getByRole("button", { name: "Previous" });
    await expect(previous, "On page 2 Previous must be live.").toBeEnabled();
    // Next must now be dead: this page carried no nextCursor.
    await expect(page.getByRole("main").getByRole("button", { name: "Next" })).toBeDisabled();

    await previous.click();
    await expect(page.getByRole("link", { name: "Alpha" })).toBeVisible();
    await expect(page.getByText(/page 1/)).toBeVisible();
    await expect(previous).toBeDisabled();

    expect(
      cursorsSeen,
      `The cursor sequence must be undefined → "cursor-page-2" → undefined: forward by the ` +
        `server's cursor, back by the one already on the stack. Never a parsed or decremented ` +
        `cursor. Saw ${JSON.stringify(cursorsSeen)}`
    ).toEqual([undefined, "cursor-page-2", undefined]);
  });

  /**
   * ── SCENARIO 5a ── THE 300ms DEBOUNCE COALESCES TYPING INTO ONE REQUEST.
   *
   * Counted with `page.on("request")` — the priority-4 technique — so this observes HTTP
   * genuinely leaving the browser rather than a mock being called.
   *
   * ── HOW THIS AVOIDS BEING A SLEEP-BASED TEST ──
   * The assertion is "requests STOP", which is inherently about a duration. Rather than sleep
   * and hope, this synchronises on the OBSERVABLE END STATE: it waits for the response whose
   * input carries the FINAL needle, which can only arrive after the debounce has settled. Only
   * then does it count. If the debounce were removed, the intermediate requests would already
   * be on the wire by that point and the count would exceed the bound — so the test fails on
   * the defect rather than on timing.
   *
   * The bound is `<= 2`, not `=== 1`, and that is a deliberate, documented allowance rather
   * than a weakened assertion: admin/page.tsx:938-943 states that the reset-on-new-needle
   * effect costs "one wasted request" by design when typing while paged, and the initial
   * empty-needle mount is itself a legitimate query. Nine keystrokes must not produce nine
   * requests; that is the property under test. The per-needle assertion below is the sharp one:
   * NO intermediate prefix may ever reach the wire.
   */
  test("scenario 5: the 300ms debounce coalesces typing into a single request", async ({
    page,
    context,
  }) => {
    const needlesSeen: (string | undefined)[] = [];
    const calls = await openDirectory(page, context, {
      "team.listDirectory": (input) => {
        needlesSeen.push((input as { search?: string } | undefined)?.search);
        return directoryPage({ teams: [row({ id: "t1", name: "Peregrine" })] });
      },
    });
    await expectTeamsTabActive(page);
    await expect(page.getByRole("link", { name: "Peregrine" })).toBeVisible();

    const baseline = calls.countOf("team.listDirectory");
    const search = page.locator("#team-search");

    // Nine keystrokes, typed at a realistic pace. `pressSequentially` fires a real key event
    // per character, so the debounce is exercised by the same input path an operator uses —
    // `fill()` would set the value in one shot and prove nothing about coalescing.
    await search.pressSequentially("Peregrine", { delay: 20 });

    // SYNCHRONISE ON THE SETTLED STATE: the request carrying the full needle. This is the
    // condition the assertion depends on, so waiting for anything else would be guessing.
    await expect
      .poll(() => needlesSeen.includes("Peregrine"), {
        message: "the debounced request carrying the full needle never arrived",
        timeout: 5000,
      })
      .toBe(true);

    const issued = calls.countOf("team.listDirectory") - baseline;
    expect(
      issued,
      `Nine keystrokes must coalesce. The debounce is 300ms (admin/page.tsx:930) and the ` +
        `keystrokes were 20ms apart, so at most the settled needle plus the one wasted request ` +
        `the reset effect documents (admin/page.tsx:939) may fire. Saw ${issued} requests for ` +
        `9 keystrokes. Needles: ${JSON.stringify(needlesSeen)}`
    ).toBeLessThanOrEqual(2);

    // THE SHARP ASSERTION: no intermediate prefix may ever have reached the wire.
    const intermediates = needlesSeen.filter(
      (n) => n && n !== "Peregrine" && "Peregrine".startsWith(n)
    );
    expect(
      intermediates,
      `An un-debounced box fires one filtered store Scan PER KEYSTROKE. Intermediate prefixes ` +
        `on the wire are the proof it happened. Saw: ${JSON.stringify(intermediates)}`
    ).toEqual([]);
  });

  /**
   * ── SCENARIO 5b ── `maxLength=100` STOPS THE 101st CHARACTER REACHING THE WIRE.
   *
   * The cap is at the input rather than as a thrown error for the reason given at
   * admin/page.tsx:1014-1017: the procedure's `z.string().trim().max(100)` REJECTS a 101st
   * character, which would surface as a tRPC error mid-typing — an error message for a
   * keystroke, on a screen where every other error means something is actually wrong.
   *
   * Boundary matrix: at the limit (100), and limit+1 (101). The 101st must be refused by the
   * INPUT, not accepted and truncated later, and the needle on the wire must be exactly 100.
   */
  test("scenario 5: maxLength=100 refuses the 101st character and never sends it", async ({
    page,
    context,
  }) => {
    const needlesSeen: string[] = [];
    await openDirectory(page, context, {
      "team.listDirectory": (input) => {
        const s = (input as { search?: string } | undefined)?.search;
        if (s) needlesSeen.push(s);
        return directoryPage({ teams: [] });
      },
    });
    await expectTeamsTabActive(page);

    const search = page.locator("#team-search");
    await expect(search).toHaveAttribute("maxlength", "100");

    // AT the limit.
    await search.fill("a".repeat(100));
    expect([...(await search.inputValue())].length).toBe(100);

    // LIMIT + 1: type past it. maxLength must refuse, not truncate after the fact.
    await search.fill("b".repeat(100));
    await search.press("End");
    await search.pressSequentially("XYZ");
    const held = await search.inputValue();
    expect(
      held.length,
      `The box's maxLength is 100, so typing past it must not be accepted. Held ${held.length} ` +
        `characters. Accepting a 101st would surface the BFF's z.max(100) rejection as a tRPC ` +
        `error for a keystroke — admin/page.tsx:1014.`
    ).toBe(100);
    expect(held, "The refused characters must not have displaced the held ones.").toBe(
      "b".repeat(100)
    );

    await expect
      .poll(() => needlesSeen.some((n) => n.length === 100), { timeout: 5000 })
      .toBe(true);
    const overLong = needlesSeen.filter((n) => n.length > 100);
    expect(
      overLong.map((n) => n.length),
      `No needle longer than 100 characters may reach the wire. Saw lengths: ${JSON.stringify(
        overLong.map((n) => n.length)
      )}`
    ).toEqual([]);
  });

  /**
   * ── SCENARIO 5c ── A NEW NEEDLE RESETS THE CURSOR STACK.
   *
   * The cursors point into a DIFFERENT scan, so reusing them pages through the wrong result set
   * (admin/page.tsx:934-936). Asserted by paging forward first, then typing — the cursor on the
   * next request must be undefined and the count line must return to page 1.
   */
  test("scenario 5: a new needle resets the cursor stack back to page 1", async ({
    page,
    context,
  }) => {
    const seen: { cursor?: string; search?: string }[] = [];
    await openDirectory(page, context, {
      "team.listDirectory": (input) => {
        const i = (input as { cursor?: string; search?: string } | undefined) ?? {};
        seen.push({ cursor: i.cursor, search: i.search });
        if (i.search) return directoryPage({ teams: [row({ id: "t9", name: "Searched Team" })] });
        return i.cursor === "cursor-page-2"
          ? directoryPage({ teams: [row({ id: "t2", name: "Beta" })] })
          : directoryPage({
              teams: [row({ id: "t1", name: "Alpha" })],
              nextCursor: "cursor-page-2",
            });
      },
    });
    await expectTeamsTabActive(page);
    await expect(page.getByRole("link", { name: "Alpha" })).toBeVisible();

    // Page forward, so there is a cursor on the stack to reset.
    await page.getByRole("main").getByRole("button", { name: "Next" }).click();
    await expect(page.getByRole("link", { name: "Beta" })).toBeVisible();
    await expect(page.getByText(/page 2/)).toBeVisible();

    // Now type a needle.
    await page.locator("#team-search").pressSequentially("Searched", { delay: 20 });
    await expect(page.getByRole("link", { name: "Searched Team" })).toBeVisible();

    // BACK TO PAGE 1, and Previous is dead again.
    await expect(
      page.getByText(/page 1/),
      "A new needle is a new result set, so the cursor stack must reset to page 1 — " +
        "admin/page.tsx:934. Staying on page 2 would page through the wrong scan."
    ).toBeVisible();

    /**
     * THE PAGING BLOCK IS GONE ENTIRELY, and that is the correct assertion here rather than
     * "Previous is disabled".
     *
     * Worth writing down because the first version of this spec asserted `toBeDisabled()` and
     * FAILED — against correct code. The whole block is gated on `page > 0 || data?.nextCursor`
     * (admin/page.tsx:1109), so after the reset both halves are false (page back to 0, and this
     * one-page search result carries no cursor) and the controls unmount rather than render
     * dead. Its own comment says so: "these are never dead controls when they are rendered".
     *
     * Absence is therefore the STRONGER evidence of the reset: it can only hold if `page` really
     * did return to 0. A disabled-Previous assertion would have been asserting a state this
     * screen deliberately never renders.
     */
    await expect(
      page.getByRole("main").getByRole("button", { name: "Previous" }),
      "After a needle reset to a single-page result set, the paging block unmounts entirely — " +
        "admin/page.tsx:1109 gates it on `page > 0 || data?.nextCursor` and neither holds. Its " +
        "absence proves `page` returned to 0."
    ).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("button", { name: "Next" })).toHaveCount(0);

    /**
     * ⚠ THE CONTAMINATED REQUEST IS EXPECTED, AND ASSERTING IT AWAY WOULD HAVE BEEN A FALSE
     * DEFECT REPORT. Read this before "tightening" the assertion below.
     *
     * The first version of this spec asserted that NO request may carry the new needle together
     * with the stale cursor, and it failed. The observed sequence was:
     *
     *   {}                                              initial mount
     *   {cursor: "cursor-page-2"}                        after Next
     *   {cursor: "cursor-page-2", search: "Searched"}    ← the contaminated one
     *   {search: "Searched"}                             after the reset effect commits
     *
     * That third request is DOCUMENTED, DELIBERATE AND ACCEPTED, at admin/page.tsx:938-943: the
     * reset is an effect keyed on the debounced needle, matching UsersTab "byte for byte" rather
     * than folding the reset into the debounce timeout, and the note states the cost in as many
     * words — "The known cost is one wasted request: typing a needle while on page 3 renders once
     * with the new search and the old cursor before this commits." The reason given for accepting
     * it is that two directories that page differently is the more expensive defect.
     *
     * So the honest test is not "this request never happens" — that would assert a behaviour the
     * implementation deliberately does not have, and reporting it as a defect would be exactly
     * the confident wrong answer a harness must not produce. The test is the SAFETY CLAIM the
     * comment makes: "It cannot paint wrong rows — that query has no cached data, so the frame
     * shows the loading state and the key has moved on by the time anything resolves."
     *
     * That claim is what the two assertions below check, and they are the ones with teeth: the
     * operator must never see Beta (the stale page-2 row) under an active search, and the final
     * settled request must carry the needle with NO cursor.
     */
    const contaminated = seen.filter((s) => s.search && s.cursor);
    expect(
      contaminated.length,
      `At most ONE request may carry a needle alongside a stale cursor — the single wasted ` +
        `request admin/page.tsx:939 documents. More than one would mean the reset effect is not ` +
        `converging. Saw: ${JSON.stringify(contaminated)} (all: ${JSON.stringify(seen)})`
    ).toBeLessThanOrEqual(1);

    // THE SAFETY CLAIM, half 1: the settled request carries the needle and NO cursor.
    expect(
      seen[seen.length - 1],
      `The LAST request must be the reset one: the needle with no cursor. If the sequence ended ` +
        `on the contaminated request, the screen would be showing a page from the wrong scan. ` +
        `Saw: ${JSON.stringify(seen)}`
    ).toEqual({ cursor: undefined, search: "Searched" });

    // THE SAFETY CLAIM, half 2: no row from the previous scan is on screen under the new needle.
    await expect(
      page.getByRole("link", { name: "Beta" }),
      `"It cannot paint wrong rows" (admin/page.tsx:940) — the wasted request has no cached data, ` +
        `so the frame shows the loading state rather than page 2 of the unsearched scan. A row ` +
        `from the previous scan visible under an active search is the defect that comment claims ` +
        `is impossible.`
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Alpha" })).toHaveCount(0);

    // The count line switches to match language, and never claims a total it does not have.
    await expect(page.getByText("1 match · page 1")).toBeVisible();
  });

  /**
   * ── SCENARIO 6 ── A 503 RENDERS THE ERROR BOX AND NEVER AN EMPTY DIRECTORY.
   *
   * The central rule, restated at routers/team.ts:558-561 and admin/page.tsx:956-959: an
   * empty directory is indistinguishable from a correct one, so a swallowed failure renders a
   * plausible, wrong, empty page with no error anywhere on screen.
   *
   * Asserted in BOTH directions, which is what makes it a real test: the error box is present,
   * AND neither empty-state sentence is anywhere on the page. A spec that only checked for the
   * error box would pass an implementation that rendered both.
   */
  test("scenario 6: a 503 DIRECTORY_SCOPE_UNAVAILABLE renders the error, never an empty directory", async ({
    page,
    context,
  }) => {
    const message =
      "The set of experiences you can see could not be determined, so this directory cannot be shown. Try again shortly.";
    await openDirectory(page, context, {
      "team.listDirectory": () => {
        throw new TrpcFault(message, "INTERNAL_SERVER_ERROR", 503);
      },
    });
    await expectTeamsTabActive(page);

    // THE SERVICE'S OWN MESSAGE, surfaced verbatim.
    await expect(page.getByText(message)).toBeVisible();

    // AND NOT AN EMPTY DIRECTORY. This is the half that matters.
    await expect(
      page.getByText("No teams to show."),
      "A failed scope lookup must NEVER render as an empty directory. An empty list " +
        "is indistinguishable from a correct one, so the operator concludes the teams do not " +
        "exist — routers/team.ts:558-561."
    ).toHaveCount(0);
    await expect(page.getByText("No teams match your search.")).toHaveCount(0);
    // No paging controls either — there is nothing to page.
    await expect(page.getByRole("main").getByRole("button", { name: "Previous" })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("button", { name: "Next" })).toHaveCount(0);
    // And no row-shaped content at all.
    await expect(page.locator("li a")).toHaveCount(0);
  });

  /**
   * ── SCENARIO 7 ── THE ROW LINK POINTS AT THE ROSTER, AND THE ARROW IS NOT IN ITS NAME.
   *
   * The href is built through `teamTabHref` so it cannot drift from the destination the
   * workspace itself uses (lib/team-routes.ts). The arrow is `aria-hidden` because announced it
   * is "right arrow" fifty times down a directory (admin/page.tsx:1215-1218) — asserted through
   * the ACCESSIBLE NAME, which is the only place that distinction is observable.
   */
  test("scenario 7: the row link targets /w/<workshopId>/t/<teamId>/team and excludes the arrow from its name", async ({
    page,
    context,
  }) => {
    const workshopId = "wksp-link-0001";
    const teamId = "team-link-0001";
    await openDirectory(page, context, {
      "team.listDirectory": () =>
        directoryPage({ teams: [row({ id: teamId, name: "Peregrine", workshopId })] }),
    });
    await expectTeamsTabActive(page);

    const link = page.getByRole("link", { name: "Peregrine", exact: true });
    await expect(
      link,
      "The accessible name must be the team name ALONE. Matched with exact:true, so a name " +
        'that had absorbed the "→" glyph would not resolve here — which is precisely the ' +
        "regression admin/page.tsx:1215 guards against."
    ).toBeVisible();
    await expect(link).toHaveAttribute("href", `/w/${workshopId}/t/${teamId}/team`);

    // The glyph IS on screen for the eye, and IS hidden from the tree.
    const arrowHidden = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll("a")).find((el) =>
        el.textContent?.includes("Peregrine")
      );
      const span = a?.querySelector("span");
      return { text: span?.textContent?.trim(), hidden: span?.getAttribute("aria-hidden") };
    });
    expect(arrowHidden.text, "The decorative arrow is rendered for the eye.").toBe("→");
    expect(
      arrowHidden.hidden,
      'The arrow must be aria-hidden, or a screen-reader operator hears "right arrow" once per ' +
        "row down the whole directory."
    ).toBe("true");
  });
});
