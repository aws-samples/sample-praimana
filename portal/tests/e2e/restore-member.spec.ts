/**
 * FORMER MEMBERS AND THE RESTORE CONTROL — the browser-only contract.
 *
 * The inverse of `remove-member.spec.ts`, in the same file's structure and with the same four
 * "priority" behaviours, because it is the same `ConfirmActionDialog` and `ActionOutcome` pair
 * driving the opposite direction on the same screen
 * (src/app/w/[workshopId]/t/[teamId]/team/page.tsx).
 *
 * ── WHY PRIORITY 4 MATTERS MORE HERE THAN ON THE REMOVAL ──
 * A duplicate removal answers "not a member" and writes a second MEMBER_REMOVED entry — bad,
 * and legible. A duplicate RESTORE answers 200 with `audited: false`, because reactivation is
 * idempotent by intent and writes one entry per real flip (routers/team.ts:429-441). That is
 * BYTE-IDENTICAL to an unrecorded real restoration. So a double-click does not merely repeat an
 * action: it manufactures a false incident report, and sends an operator chasing an audit gap
 * they created by clicking twice. The page says exactly this at team/page.tsx:1519-1523.
 *
 * ── THE SEAM ──
 * `serveTrpc` — the browser-level seam — because everything under test here is in the PAGE.
 * `listFormerMembers` passes its rows through UNMAPPED and says so (routers/team.ts:517-519),
 * precisely so no layer can turn one of the documented nulls into an empty string. So putting
 * those nulls in at this seam is putting them in exactly where a service would.
 *
 * (Contrast roster-status.spec.ts, which must NOT use this seam: the filter it tests lives in
 * the router, so replacing the router would mock away the thing under test.)
 *
 * ── NO SLEEPS ──
 * The pending state is made observable by HOLDING the mutation open with `deferred()`, never by
 * racing a fast one. Every wait is a web-first assertion or `deferred`'s call-count poll.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readNextAuthSecret, missingSecretMessage } from "./fixtures/env";
import { signInAs, type SpecIdentity } from "./fixtures/session";
import {
  serveTrpc,
  countTrpcCalls,
  deferred,
  TrpcFault,
  type ProcedureHandler,
  type TrpcCallLog,
} from "./fixtures/trpc";
import {
  ADMIN_SELF,
  EXECUTIVE_SELF,
  TEAM_ID,
  TEAM_NAME,
  WORKSHOP_ID,
  meFixture,
  selfMember,
  teamFixture,
  type TeamMemberFixture,
} from "./fixtures/data";
import {
  activeElement,
  dialogFocusables,
  expectFocusInsideDialog,
  expectFocusNotLost,
  expectFocusOn,
  ASSERTIVE_NOTICE,
  POLITE_NOTICE,
} from "./fixtures/focus";

const { secret, whereLooked } = readNextAuthSecret();

const TEAM_URL = `/w/${WORKSHOP_ID}/t/${TEAM_ID}/team`;

/** What `listFormerMembers` returns per row — every nullable field is genuinely nullable. */
interface FormerMemberFixture {
  userId: string;
  name: string | null;
  email: string | null;
  removedAt: string;
  removedByName: string | null;
  removedByRole: string;
  reason: string | null;
  joinedAt: string | null;
}

/** Fixed instants: a fixture with `new Date()` in it is a fixture that can flake. */
const REMOVED_AT = "2026-08-01T14:30:00.000Z";
const JOINED_AT = "2026-07-01T09:05:00.000Z";

function formerMember(over: Partial<FormerMemberFixture> & { userId: string }): FormerMemberFixture {
  return {
    name: "Removed Robin",
    email: "robin@example.test",
    removedAt: REMOVED_AT,
    removedByName: "Ada Admin",
    removedByRole: "ADMIN",
    reason: null,
    joinedAt: JOINED_AT,
    ...over,
  };
}

/** The person every restore spec acts on. */
const FORMER_ROBIN = formerMember({ userId: "sub-former-robin" });

/** The accessible name the implementation builds (team/page.tsx:1287). */
function restoreName(label: string) {
  return `Restore access to ${TEAM_NAME} for ${label}`;
}
const RESTORE_ROBIN = restoreName("Removed Robin");

/** The reactivate response shape, mirroring the router's echo (routers/team.ts:414-442). */
function reactivateResult(over: { role?: string; audited?: boolean } = {}) {
  return {
    reactivated: true as const,
    role: over.role ?? "BUILDER",
    audited: over.audited ?? true,
  };
}

async function openTeamPage(
  page: Page,
  context: BrowserContext,
  identity: SpecIdentity,
  former: FormerMemberFixture[],
  extra: Record<string, ProcedureHandler> = {},
  {
    members = [selfMember(identity)],
    truncated = false,
    formerError,
  }: { members?: TeamMemberFixture[]; truncated?: boolean; formerError?: TrpcFault } = {}
): Promise<{ calls: TrpcCallLog; former: { current: FormerMemberFixture[] } }> {
  await signInAs(context, identity, secret!);
  const formerState = { current: former };
  const calls = countTrpcCalls(page);

  await serveTrpc(page, {
    "auth.me": () => meFixture(identity),
    "team.getById": () => teamFixture(members),
    "team.listInvitations": () => [],
    // Re-read on every call, so an invalidate-driven refetch sees the post-restore list
    // exactly as it would against a real service. A fixture whose list never shrinks would
    // never unmount the row, and the focus assertions would pass for the wrong reason.
    "team.listFormerMembers": () => {
      if (formerError) throw formerError;
      return { formerMembers: formerState.current, truncated };
    },
    ...extra,
  });

  await page.goto(TEAM_URL);
  await expect(page.getByRole("heading", { name: /^Members/ })).toBeVisible();
  return { calls, former: formerState };
}

/** The Former members disclosure toggle. */
function formerToggle(page: Page) {
  return page.locator("#former-members-heading").getByRole("button");
}

/** Expand the collapsed Former members section and wait for its panel. */
async function expandFormer(page: Page, how: "click" | "keyboard" = "click") {
  const toggle = formerToggle(page);
  await expect(toggle).toBeVisible();
  if (how === "click") {
    await toggle.click();
  } else {
    await toggle.focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.locator("#former-members-panel")).toBeVisible();
}

/** Open the restore confirmation for a former member. */
async function openRestoreDialog(page: Page, accessibleName: string, how: "click" | "keyboard") {
  const trigger = page.getByRole("button", { name: accessibleName });
  await expect(trigger).toBeVisible();
  if (how === "click") {
    await trigger.click();
  } else {
    await trigger.focus();
    await page.keyboard.press("Enter");
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The CONFIRM button inside the dialog.
 *
 * Scoped to the dialog and matched EXACTLY, because Playwright's `name` is a substring match by
 * default and the row's trigger carries the aria-label "Restore access to Team Peregrine for
 * …" — which contains "Restore access". An unscoped locator resolves to two elements and the
 * spec dies on a strict-mode violation instead of asserting. Observed, not theorised.
 */
function confirmButton(page: Page) {
  return page.getByRole("dialog").getByRole("button", { name: "Restore access", exact: true });
}

test.describe("Former members and the Restore control", () => {
  test.beforeEach(() => {
    test.skip(!secret, missingSecretMessage(whereLooked));
  });

  /**
   * ── SCENARIO 8 ── COLLAPSED BY DEFAULT, `aria-expanded` CORRECT, KEYBOARD-OPERABLE.
   *
   * The default is the one place this page disagrees with its two other lists, deliberately:
   * this is history, and history opened by default would push the live roster off the first
   * screen and give a removal list the same visual weight as the people actually on the team
   * (team/page.tsx:521-526). The COUNT is in the heading so a closed panel still answers "has
   * anyone been removed" without a click.
   *
   * `aria-expanded` is asserted in both states because it is the whole contract for a screen
   * reader: a panel that opens without updating it is a panel the operator is told is still
   * shut.
   */
  test("scenario 8: Former members is collapsed by default, reports aria-expanded, and is keyboard-operable", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN]);

    const toggle = formerToggle(page);
    await expect(toggle).toBeVisible();

    // COLLAPSED, and saying so.
    await expect(
      toggle,
      "Former members starts CLOSED — team/page.tsx:527. History must not outweigh the live roster."
    ).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#former-members-panel")).toHaveCount(0);
    // The count still answers the at-a-glance question while shut.
    await expect(toggle).toContainText("Former members (1)");
    // And the row itself is genuinely not rendered — not merely hidden, so its Restore button
    // is neither focusable nor clickable (the reason Disclosure unmounts, Disclosure.tsx:98).
    await expect(page.getByRole("button", { name: RESTORE_ROBIN })).toHaveCount(0);

    // ── KEYBOARD: Enter opens it. ──
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#former-members-panel")).toBeVisible();
    await expect(page.getByRole("button", { name: RESTORE_ROBIN })).toBeVisible();
    // aria-controls points at the panel it actually controls.
    await expect(toggle).toHaveAttribute("aria-controls", "former-members-panel");

    // ── KEYBOARD: Space closes it again. ──
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#former-members-panel")).toHaveCount(0);
  });

  test("scenario 8: with no history and no outcome, the section does not render at all", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, ADMIN_SELF, []);
    await expect(page.getByRole("heading", { name: /^Members/ })).toBeVisible();
    await expect(
      formerToggle(page),
      "A team that has never removed anyone must not be asked to display a section about " +
        "removals — team/page.tsx:1060-1062. An empty bordered panel on a healthy team is noise."
    ).toHaveCount(0);
  });

  /**
   * ── SCENARIO 9 ── THE FOUR NULLABLE FIELDS RENDER AS FACTS, NEVER AS BLANKS.
   *
   * Each null on this row means something different, and the wording for each is load-bearing.
   * All four are asserted in one test because they appear on ONE row and the failure being
   * guarded against is a row that renders a blank where a fact belongs — which is only
   * observable by reading the whole row.
   */
  test("scenario 9: a suppressed removedByName renders the role and says the name is withheld", async ({
    page,
    context,
  }) => {
    // removedByName null + removedByRole present: the deliberate visibility suppression a
    // FACILITATOR gets when reading a removal an ADMIN performed (routers/team.ts:486-496).
    await openTeamPage(page, context, ADMIN_SELF, [
      formerMember({
        userId: "sub-suppressed",
        name: "Suppressed Subject",
        removedByName: null,
        removedByRole: "FACILITATOR",
      }),
    ]);
    await expandFormer(page);

    /* ⚠ THE ROW IS A LIST ITEM, NOT AN ELEMENT WITH A BORDER CLASS. This located rows as
       `div.rounded-lg.border`, which broke when the lists became one bordered PANEL of divided
       rows: the border moved to the `<ul>`, so no row carries it any more. Matching on structure
       instead of on a styling class is what makes the locator survive a design change — and the
       same coupling has now broken three separate specs during this redesign. */
    const row = page.locator("#former-members-panel li").first();
    await expect(
      row.getByText("Removed by a Facilitator, name not shown"),
      "A null removedByName is a SUPPRESSION or a deleted actor, and the ROLE is disclosed " +
        "either way. A row that says a removal happened and then refuses to say by whom in any " +
        "form is not a trail — team/page.tsx:50-66. Never a blank."
    ).toBeVisible();
    // The article agrees: "a Facilitator", not "an Facilitator".
    await expect(row.getByText("Removed by an Facilitator")).toHaveCount(0);

    // The line must not be empty, and must not read as an unnamed nobody when a role exists.
    await expect(row.getByText("Removed by someone whose name is not shown")).toHaveCount(0);
  });

  test('scenario 9: removedByRole ADMIN takes the article "an"', async ({ page, context }) => {
    await openTeamPage(page, context, ADMIN_SELF, [
      formerMember({ userId: "s1", removedByName: null, removedByRole: "ADMIN" }),
    ]);
    await expandFormer(page);
    await expect(page.getByText("Removed by an Admin, name not shown")).toBeVisible();
  });

  test("scenario 9: joinedAt null renders 'join date unknown' and NEVER 'never joined'", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, ADMIN_SELF, [
      formerMember({ userId: "sub-nojoin", name: "No Join Date", joinedAt: null }),
    ]);
    await expandFormer(page);

    const row = page.locator("#former-members-panel li").first();
    await expect(
      row.getByText("join date unknown"),
      "joinedAt null only means the removal predates the field being denormalised — the audit " +
        "entry itself PROVES this person was a member. team/page.tsx:1138-1146."
    ).toBeVisible();
    await expect(
      row.getByText("never joined"),
      '"Never joined" would be this screen asserting a FALSEHOOD about a person, on the one ' +
        "surface whose purpose is to be an accurate record — routers/team.ts:510."
    ).toHaveCount(0);
    // The removal date is still rendered, so the row is not degraded wholesale.
    await expect(row.getByText(/Removed 01 Aug 2026 14:30 UTC/)).toBeVisible();
    // And no "Invalid Date" anywhere.
    await expect(row.getByText("Invalid Date")).toHaveCount(0);
  });

  test("scenario 9: name null falls back to the email, with no (name unknown) marker", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, ADMIN_SELF, [
      formerMember({ userId: "sub-noname", name: null, email: "only-email@example.test" }),
    ]);
    await expandFormer(page);

    const row = page.locator("#former-members-panel li").first();
    await expect(row.getByText("only-email@example.test").first()).toBeVisible();
    // The accessible name of the Restore button carries the same label — one resolved value
    // used by the row, the button, the dialog and the outcome (team/page.tsx:1109-1122).
    await expect(page.getByRole("button", { name: restoreName("only-email@example.test") })).toBeVisible();
    // The email IS the label here, so the marker must not fire: something was resolved.
    await expect(
      row.getByText("(name unknown)"),
      "The email resolved, so this is not an unknown identity — the marker would be noise."
    ).toHaveCount(0);
  });

  test("scenario 9: name AND email both null fall back to the userId, marked (name unknown)", async ({
    page,
    context,
  }) => {
    const userId = "8f14e45f-ceea-467a-9a3c-a3d1f5b7c9e2";
    await openTeamPage(page, context, ADMIN_SELF, [
      formerMember({ userId, name: null, email: null }),
    ]);
    await expandFormer(page);

    const row = page.locator("#former-members-panel li").first();
    // NEVER BLANK: the id is what we know for certain.
    await expect(row.getByText(userId, { exact: false }).first()).toBeVisible();
    await expect(
      row.getByText("(name unknown)"),
      "Without this marker the sub above reads like a name nobody can pronounce. With it, the " +
        "row reads as a removal whose subject could not be resolved — which is the truth. " +
        "team/page.tsx:1185-1194."
    ).toBeVisible();
    // The Restore button carries the id in full, so no hover is needed to identify the row.
    await expect(page.getByRole("button", { name: restoreName(userId) })).toBeVisible();
    // And nothing renders the string "null" or "undefined" at the operator.
    const text = await row.innerText();
    expect(text, `The row must never print "undefined". Rendered: ${text}`).not.toContain("undefined");
    expect(text, `The row must never print a bare "null". Rendered: ${text}`).not.toMatch(/\bnull\b/);
  });

  test("scenario 9: a null reason renders no quote line at all", async ({ page, context }) => {
    await openTeamPage(page, context, ADMIN_SELF, [
      formerMember({ userId: "s1", reason: null }),
      formerMember({ userId: "s2", name: "With Reason", reason: "Left the programme" }),
    ]);
    await expandFormer(page);

    // The row WITH a reason shows it in quotes.
    await expect(page.getByText("Left the programme")).toBeVisible();
    // An absent line beats a line saying "unknown" — team/page.tsx:1249-1253.
    await expect(page.getByText("No reason recorded")).toHaveCount(0);
  });

  /**
   * ── SCENARIO 10 ── THE TRUNCATION NOTICE IS VISIBLE WHILE THE SECTION IS COLLAPSED.
   *
   * This is the whole reason the notice sits OUTSIDE the panel (team/page.tsx:1082-1086):
   * collapsed, the heading reads "Former members (50)", which is a number an operator will take
   * as complete. A notice inside the panel would be hidden at exactly the moment the misleading
   * number is the only thing on screen.
   */
  test("scenario 10: the truncation notice is visible WHILE the section is collapsed", async ({
    page,
    context,
  }) => {
    const fifty = Array.from({ length: 50 }, (_, i) =>
      formerMember({ userId: `sub-bulk-${i}`, name: `Person ${i}` })
    );
    await openTeamPage(page, context, ADMIN_SELF, fifty, {}, { truncated: true });

    // Still collapsed...
    await expect(formerToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#former-members-panel")).toHaveCount(0);
    await expect(formerToggle(page)).toContainText("Former members (50)");

    // ...and the notice is on screen anyway. This is the assertion.
    const notice = page.getByText("This list is capped at the 50 most recently removed people");
    await expect(
      notice,
      'Collapsed, the heading reads "Former members (50)" — a number an operator takes as ' +
        "complete. The notice MUST sit outside the panel (team/page.tsx:1082) or the one render " +
        "where it matters is the one where it is hidden."
    ).toBeVisible();
    await expect(notice).toContainText("There are more removals than are shown here");

    // And it stays visible once expanded, rather than being replaced.
    await expandFormer(page);
    await expect(notice).toBeVisible();
  });

  test("scenario 10: an untruncated list renders no cap notice", async ({ page, context }) => {
    await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {}, { truncated: false });
    await expect(
      page.getByText("This list is capped at the 50 most recently removed people")
    ).toHaveCount(0);
  });

  /**
   * A FAILED HISTORY LOOKUP IS SAID OUT LOUD.
   *
   * The alternative is a page that silently omits the section and therefore states, by its
   * absence, that nobody has ever been removed from this team — indistinguishable from the
   * truth (team/page.tsx:1039-1046). Same class of defect as scenario 6's empty directory.
   */
  test("a failed listFormerMembers renders a notice, never a silently absent section", async ({
    page,
    context,
  }) => {
    await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [],
      {},
      { formerError: new TrpcFault("Audit store unavailable", "INTERNAL_SERVER_ERROR", 503) }
    );

    await expect(
      page.getByText("The removal history for this team could not be loaded"),
      "A swallowed failure renders a page that says, by the absence of the section, that nobody " +
        "was ever removed from this team — team/page.tsx:1039."
    ).toBeVisible();
    await expect(page.getByText("Reload the page to try again.")).toBeVisible();
    // And the roster itself is unharmed: this read is separate from getById's.
    await expect(page.getByRole("heading", { name: /^Members/ })).toBeVisible();
  });

  /**
   * ── PRIORITY #1 ──
   * FOCUS IS NOT STRANDED ON <body> AFTER A SUCCESSFUL RESTORE.
   *
   * The same "doomed but still mounted" trigger as the removal's: the former-members list
   * shrinks only when the invalidated query refetches, several ticks after the dialog unmounts
   * (the service omits anyone who is a member again). So a cleanup that merely checks
   * `isConnected` finds the Restore button alive, focuses it, and focus drops to <body> when the
   * row unmounts a moment later. `returnToFallback` exists to prevent exactly that
   * (team/page.tsx:1497) and this asserts it works — by reading where focus ACTUALLY is once the
   * list has visibly shrunk, i.e. after the moment a naive implementation has already failed.
   */
  test("priority 1: focus is not stranded on <body> after a successful restore", async ({
    page,
    context,
  }) => {
    const restore = deferred<ReturnType<typeof reactivateResult>>();
    const { former } = await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [FORMER_ROBIN, formerMember({ userId: "sub-former-sam", name: "Sam Stays" })],
      { "team.reactivateMember": restore.handler }
    );

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "keyboard");
    await confirmButton(page).click();
    await restore.waitUntilCalled(page);

    // The restore now genuinely takes effect, so the refetch really does unmount the row.
    former.current = [formerMember({ userId: "sub-former-sam", name: "Sam Stays" })];
    restore.release(reactivateResult());

    // Synchronise on the list having actually shrunk — the moment AFTER which a
    // focus-the-doomed-trigger implementation has already failed.
    await expect(page.getByRole("button", { name: RESTORE_ROBIN })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const active = await expectFocusNotLost(
      page,
      "After a successful restore the Restore button that opened the dialog is unmounted with " +
        "its row (the service omits anyone who is a member again), so the dialog's cleanup must " +
        "use `returnToFallback` (team/page.tsx:1497) and send focus to the fallback — the " +
        "Former members disclosure heading button — instead of the doomed trigger."
    );
    expect(
      active.text.includes("Former members"),
      `Focus should be on the Former members disclosure heading button, the documented ` +
        `fallbackFocus (team/page.tsx:1492-1496). It is on ${active.describe}.`
    ).toBe(true);
    expect(
      active.tag,
      "The fallback must be a focusable BUTTON — the disclosure's own toggle, from which Tab " +
        "walks back into the remaining rows."
    ).toBe("button");
  });

  /**
   * ── PRIORITY #2 ──
   * FOCUS IS NOT LOST WHEN CONFIRM DISABLES ITSELF, AND ESCAPE STILL DISMISSES IN FLIGHT.
   *
   * Confirm is activated with the KEYBOARD, so focus is ON the button when `pending` flips true.
   * A disabled element cannot hold focus, so the browser drops it to <body> — at which point
   * Escape is dead (the handler is on the panel) and the operator is trapped in a modal
   * mid-action. The implementation moves focus to the dismiss button, which is deliberately the
   * control that stays live while pending (ConfirmActionDialog.tsx:148-157).
   *
   * Both halves are asserted, and the second is the one that matters: proving focus moved is
   * good, proving the escape hatch WORKS from there is the actual operator guarantee.
   */
  test("priority 2: keyboard-activated Confirm keeps focus in the dialog, and Escape still dismisses in flight", async ({
    page,
    context,
  }) => {
    const restore = deferred<ReturnType<typeof reactivateResult>>();
    await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": restore.handler,
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "keyboard");

    // ACTIVATE WITH THE KEYBOARD. The whole point: focus must be ON the confirm button at the
    // instant it becomes disabled. A .click() would leave focus elsewhere and the defect would
    // not reproduce.
    const confirm = confirmButton(page);
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");

    await restore.waitUntilCalled(page);
    await expect(page.getByRole("dialog").getByRole("button", { name: "Restoring…" })).toBeDisabled();

    await expectFocusInsideDialog(
      page,
      "The confirm button disabled itself while holding focus. A disabled element cannot hold " +
        "focus, so ConfirmActionDialog's `pending` effect (line 225) must move focus to the " +
        "dismiss button — the one control that stays live while a request is in flight."
    );
    await expectFocusOn(
      page,
      "Close",
      "While pending the dismiss button relabels to 'Close' and is the documented landing place " +
        "for focus, because it is the escape hatch."
    );

    // THE HALF THAT PROVES IT MATTERS. If focus had fallen to <body>, this keypress would reach
    // nothing and the operator would be trapped in a modal mid-action.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Dismissed mid-flight is UNKNOWN, not failure — the request was sent and nobody saw the
    // answer. Asserted via the ASSERTIVE role, because an unknown outcome must interrupt.
    const notice = page.locator(ASSERTIVE_NOTICE);
    await expect(notice).toContainText("Outcome unknown");
    await expect(notice).toContainText(
      "The request to restore Removed Robin was sent but the result was never seen."
    );
    await expect(
      notice,
      "On THIS direction the ambiguity is sharper than on a removal: a restoration that DID " +
        "land looks identical to one that never happened on a list that has not refetched, so " +
        "the notice must say to reload BEFORE trying again — team/page.tsx:1516-1528."
    ).toContainText("Reload the page to check whether they are a member again");

    restore.release(reactivateResult());
  });

  /**
   * ── PRIORITY #3 ──
   * THE FOCUS TRAP HOLDS IN BOTH DIRECTIONS, INCLUDING WHILE THE FOCUSABLE SET CHANGES.
   *
   * `aria-modal` tells a screen reader the rest of the page is inert; it does NOT stop Tab. So
   * without the trap a keyboard operator walks out of a dialog that is still on screen and
   * starts operating controls behind the backdrop.
   *
   * The interesting half is the second: the confirm button leaves the tab order when it goes
   * disabled (the selector is `:not([disabled])`), so the "last focusable" the trap wraps from
   * CHANGES mid-interaction. The implementation rebuilds the list per keypress
   * (ConfirmActionDialog.tsx:319) and this proves that rather than assuming it.
   */
  test("priority 3: the focus trap holds forwards and backwards, and after the focusable set shrinks", async ({
    page,
    context,
  }) => {
    const restore = deferred<ReturnType<typeof reactivateResult>>();
    await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": restore.handler,
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "keyboard");

    // Focus opens on the PANEL, not a button — nothing is pre-armed.
    const opened = await activeElement(page);
    expect(
      opened.role,
      `On open, focus must land on the dialog panel itself so the question and every consequence ` +
        `are announced and no action is pre-armed. Focus is on ${opened.describe}.`
    ).toBe("dialog");

    // BACKWARDS FROM THE BOUNDARY: Shift+Tab from the panel (which counts as the start) must
    // wrap to the LAST control, not escape to the page behind.
    await page.keyboard.press("Shift+Tab");
    await expectFocusInsideDialog(
      page,
      "Shift+Tab from the dialog's initial focus target must wrap to the last control inside " +
        "the dialog, not walk backwards into the page behind the backdrop."
    );
    await expectFocusOn(
      page,
      "Restore access",
      "Wrapping backwards from the start lands on the last focusable, the confirm button."
    );

    // FORWARDS FROM THE BOUNDARY: Tab on the last element must wrap to the first, which is the
    // reason TEXTAREA — querySelectorAll returns DOCUMENT order regardless of how the selectors
    // are written, and the textarea sits above the button footer. Read from the live list below
    // rather than assumed.
    await page.keyboard.press("Tab");
    await expectFocusInsideDialog(
      page,
      "Tab on the last control inside the dialog must wrap to the first, not escape the modal."
    );
    const wrapped = await activeElement(page);
    expect(
      wrapped.tag,
      `Wrapping forwards from the last focusable must land on the FIRST in document order, the ` +
        `reason textarea. Focus is on ${wrapped.describe}.`
    ).toBe("textarea");

    const before = await dialogFocusables(page);
    expect(
      before,
      `The trap's focusable list, in document order. Saw: ${JSON.stringify(before)}`
    ).toEqual(["", "Cancel", "Restore access"]);

    // Walk the whole ring forwards; every stop stays inside. Bounded, so a broken trap fails
    // rather than looping forever.
    for (let i = 0; i < before.length + 2; i++) {
      await page.keyboard.press("Tab");
      await expectFocusInsideDialog(
        page,
        `Tab #${i + 1} of a full walk around the trap escaped the dialog.`
      );
    }

    // ── NOW CHANGE THE FOCUSABLE SET ── submit, so Confirm goes disabled and drops OUT of the
    // tab order. The trap's "last element" becomes the dismiss button.
    const confirm = confirmButton(page);
    await confirm.focus();
    await page.keyboard.press("Enter");
    await restore.waitUntilCalled(page);
    await expect(page.getByRole("dialog").getByRole("button", { name: "Restoring…" })).toBeDisabled();

    const during = await dialogFocusables(page);
    expect(
      during,
      `While pending, the confirm button is disabled and must LEAVE the focusable set — the ` +
        `trap's selector is 'button:not([disabled]), textarea:not([disabled]), [href]'. The set ` +
        `should shrink from 3 to 2 and the dismiss button should relabel to "Close". Saw: ` +
        `${JSON.stringify(during)}`
    ).toEqual(["", "Close"]);
    expect(
      during.some((n) => n.includes("Restoring")),
      "The disabled confirm button must not be reachable by Tab while its request is in flight."
    ).toBe(false);

    // The trap must still hold with the SHRUNKEN set, in BOTH directions.
    for (let i = 0; i < during.length + 2; i++) {
      await page.keyboard.press("Tab");
      await expectFocusInsideDialog(
        page,
        `Tab #${i + 1} escaped the dialog AFTER the focusable set shrank (confirm went ` +
          `disabled). The trap rebuilds its list per keypress; a cached list's stale "last " +
          "element" would be a disabled button and the wrap would never fire.`
      );
    }
    for (let i = 0; i < during.length + 2; i++) {
      await page.keyboard.press("Shift+Tab");
      await expectFocusInsideDialog(
        page,
        `Shift+Tab #${i + 1} escaped the dialog after the focusable set shrank.`
      );
    }

    restore.release(reactivateResult());
  });

  /**
   * ── PRIORITY #4 ── THE ONE THAT MATTERS MOST ON THIS DIRECTION.
   *
   * `disabled` GENUINELY PREVENTS A SECOND SUBMIT — counted ON THE WIRE.
   *
   * A duplicate restore answers 200 with `audited: false`, which is INDISTINGUISHABLE from an
   * unrecorded real restoration (routers/team.ts:429-441). So a double-click does not merely
   * repeat an action — it manufactures a false incident report and sends an operator chasing an
   * audit gap they created by clicking twice (team/page.tsx:1519-1523).
   *
   * The count comes from `page.on("request")`, which observes requests the browser actually
   * emitted, so this cannot be satisfied by a mock that was merely called once.
   *
   * `dispatchEvent` is used for the second attempt, not `.click()`: Playwright's click refuses a
   * disabled element (it would hang on an actionability check and the spec would time out rather
   * than assert), while a dispatched event is precisely what a real double-click's second event
   * is. If the handler were still live, it would fire.
   */
  test("priority 4: a double-submit issues exactly ONE reactivateMember request", async ({
    page,
    context,
  }) => {
    const restore = deferred<ReturnType<typeof reactivateResult>>();
    const { calls } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": restore.handler,
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "click");

    // First submit, then hammer the same element while its request is in flight.
    await confirmButton(page).click();
    await restore.waitUntilCalled(page);

    const disabledConfirm = page.getByRole("dialog").getByRole("button", { name: "Restoring…" });
    await expect(disabledConfirm).toBeDisabled();
    for (let i = 0; i < 5; i++) await disabledConfirm.dispatchEvent("click");
    // The keyboard equivalents of a double-submit.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");

    expect(
      restore.calls(),
      `The confirm button is disabled the instant it is pressed, so five further clicks plus ` +
        `Enter and Space must produce NO additional mutation. A duplicate restore answers 200 ` +
        `with audited:false, which is indistinguishable from an unrecorded real restoration — so ` +
        `a double-click manufactures a false incident report the operator then chases.`
    ).toBe(1);
    expect(
      calls.countOf("team.reactivateMember"),
      `Counted on the wire via page.on("request"): exactly one team.reactivateMember operation ` +
        `must have left the browser. Saw ${calls.countOf("team.reactivateMember")} (all tRPC ops ` +
        `this run: ${JSON.stringify(calls.paths)}).`
    ).toBe(1);

    restore.release(reactivateResult());
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  /** The happy path, asserted by the outcome notice's text, including the preserved role. */
  test("happy path: a restore reports a confirmed outcome naming the person, the team and the preserved role", async ({
    page,
    context,
  }) => {
    const { former } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": (input) => {
        const { userId, teamId } = input as { userId: string; teamId: string };
        expect(userId, "The mutation must carry the userId of the row that was clicked.").toBe(
          FORMER_ROBIN.userId
        );
        expect(teamId).toBe(TEAM_ID);
        former.current = [];
        return reactivateResult({ role: "LEAD" });
      },
    });

    await expandFormer(page);
    const dialog = await openRestoreDialog(page, RESTORE_ROBIN, "click");

    // The dialog names the target AND their email — the mis-click this dialog exists to catch.
    await expect(dialog).toContainText(`Restore Removed Robin's access to ${TEAM_NAME}?`);
    await expect(dialog).toContainText("robin@example.test");
    await expect(
      dialog,
      "NEUTRAL, not destructive: this is the recovery direction and takes nothing away."
    ).toContainText("Reversible: you can remove them from this team again");
    // The asymmetry with the removal is stated rather than implied.
    await expect(dialog).toContainText("This restores team membership only");
    await expect(dialog).toContainText("Any invitation withdrawn when they were removed stays withdrawn");

    await confirmButton(page).click();

    // `role="status"` for a clean success — announced politely, not as an interruption.
    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done." });
    await expect(notice).toContainText(`Removed Robin is a member of ${TEAM_NAME} again.`);
    await expect(
      notice,
      "The preserved team role is THE reassuring detail and the whole point of the membership " +
        "row surviving a removal: a Lead comes back a Lead — team/page.tsx:411-420."
      // ⚠ "Lead", NOT "Team Lead". This read "Team Lead" and failed against the real label:
      // teamRoleLabel() resolves through TEAM_ROLES, and shared/constants/roles.ts:475-476 maps
      // LEAD → "Lead". The unit test at src/lib/reactivate-member.test.ts:297 already pins the
      // same string; only this e2e expectation was left behind. Hardcoding the label here at all
      // is the reason it could drift — the assertion is about the SENTENCE, and the label is
      // data — but it stays literal so a silent label change is caught rather than absorbed.
    ).toContainText("Their team role is unchanged: Lead.");
  });

  /**
   * ── SCENARIO 12 ── `audited: false` RENDERS THE PARTIAL, WHOSE WORDING IS TRUE UNDER BOTH
   * READINGS AND ASSERTS NEITHER CAUSE.
   *
   * `audited: false` means EITHER a real restoration that went unrecorded OR a harmless no-op on
   * somebody who already had access, and the two are not distinguishable from this layer
   * (team/page.tsx:429-451). So the message must state the fact true in both readings, name the
   * gap true in both, and claim neither cause. Guessing "they already had access" would talk an
   * operator out of reporting the serious case; asserting "unrecorded restoration" would send
   * them chasing an incident that may not exist.
   *
   * Asserted in both directions: the both-readings wording is PRESENT, and neither
   * cause-asserting phrasing appears.
   */
  test("scenario 12: audited:false renders a partial whose wording is true under both readings", async ({
    page,
    context,
  }) => {
    const { former } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": () => {
        former.current = [];
        return reactivateResult({ audited: false, role: "BUILDER" });
      },
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "click");
    await confirmButton(page).click();

    // PARTIAL, not confirmed — and `role="status"`, because a retry cannot write the missing
    // entry and would only repeat a request that already achieved its intent.
    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done, with a gap." });
    await expect(notice).toBeVisible();
    // The fact that is true in BOTH readings.
    await expect(notice).toContainText(`Removed Robin has access to ${TEAM_NAME}.`);
    // The gap that is true in BOTH readings.
    await expect(notice).toContainText("No audit entry was written for this action");
    await expect(notice).toContainText("there is no record of who restored it");
    // AND THE AMBIGUITY IS NAMED rather than resolved. This is the assertion.
    await expect(
      notice,
      "The message must claim NEITHER cause. Naming the ambiguity is what stops an operator " +
        "either dismissing a real audit gap or chasing an incident that may not exist — " +
        "team/page.tsx:437-451."
    ).toContainText("this is also what a repeat request on someone who already had access looks like");
    await expect(notice).toContainText("the two cannot be told apart from here");
    await expect(notice).toContainText("Report it.");

    // It must NOT be reported as a clean success.
    await expect(page.locator(POLITE_NOTICE).filter({ hasText: "Done." })).toHaveCount(0);
    // Nor as a failure: a retry would not fix the audit entry.
    await expect(page.locator(ASSERTIVE_NOTICE).filter({ hasText: "Not done." })).toHaveCount(0);
  });

  /**
   * ── SCENARIO 12b ── `role: ""` PRODUCES NO ROLE CLAUSE, AND NEVER THE STRING "undefined".
   *
   * A service version that does not send `role` yields `""` (routers/team.ts:428), and in that
   * case the sentence must say NOTHING about role rather than "restored as undefined"
   * (team/page.tsx:411-420). The whole notice is read back as text and searched, because
   * "undefined" leaking into an operator-facing sentence is the kind of thing a targeted
   * assertion misses by looking in the wrong clause.
   */
  test('scenario 12: role "" renders no role clause and never the string "undefined"', async ({
    page,
    context,
  }) => {
    const { former } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": () => {
        former.current = [];
        return reactivateResult({ role: "", audited: true });
      },
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "click");
    await confirmButton(page).click();

    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done." });
    await expect(notice).toContainText(`Removed Robin is a member of ${TEAM_NAME} again.`);

    const text = await notice.innerText();
    expect(
      text,
      `An empty role must produce NO role clause. The notice read: ${JSON.stringify(text)}`
    ).not.toContain("Their team role is unchanged");
    expect(
      text,
      `"undefined" must never reach an operator-facing sentence — routers/team.ts:426 chooses ` +
        `"" over inventing a value for exactly this reason. The notice read: ${JSON.stringify(text)}`
    ).not.toContain("undefined");

    // And nowhere else on the page either.
    const body = await page.locator("body").innerText();
    expect(body, 'The page must not render the string "undefined" anywhere.').not.toContain(
      "undefined"
    );
  });

  /**
   * ── SCENARIO 13 ── THE OUTCOME NOTICE SURVIVES THE REFETCH THAT DESTROYS THE ROW IT NAMES,
   * AND NAMES THE RIGHT PERSON.
   *
   * Restoring the LAST former member empties the list. A section that unmounted on `length === 0`
   * would take the notice reporting that very restoration down with it — which is why the render
   * condition is `formerMembers.length > 0 || restoreOutcome` (team/page.tsx:1054-1063) and why
   * the notice sits outside the panel.
   *
   * The naming half is asserted with TWO rows present and the OTHER one restored, so a notice
   * that had latched the wrong label would be caught. A single-row fixture would pass either way.
   */
  test("scenario 13: the outcome notice outlives the row it names, and names the right person", async ({
    page,
    context,
  }) => {
    const robin = FORMER_ROBIN;
    const sam = formerMember({ userId: "sub-former-sam", name: "Sam Second", email: "sam@example.test" });
    const { former } = await openTeamPage(page, context, ADMIN_SELF, [robin, sam], {
      "team.reactivateMember": (input) => {
        const { userId } = input as { userId: string };
        // Only the restored person leaves the list.
        former.current = former.current.filter((f) => f.userId !== userId);
        return reactivateResult({ role: "BUILDER" });
      },
    });

    await expandFormer(page);
    // Restore the SECOND row, so a mis-keyed label would name Robin instead of Sam.
    await openRestoreDialog(page, restoreName("Sam Second"), "click");
    await confirmButton(page).click();

    // The row it names is GONE...
    await expect(page.getByRole("button", { name: restoreName("Sam Second") })).toHaveCount(0);
    // ...and the notice is still on screen, naming the right person.
    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done." });
    await expect(
      notice,
      "The notice is deliberately built to outlive the row it refers to (ActionOutcome's header " +
        "note), so it must name the person — the row that named them is gone."
    ).toContainText(`Sam Second is a member of ${TEAM_NAME} again.`);
    await expect(
      notice,
      "Naming the WRONG person is worse than saying nothing: it reports ACCESS GRANTED to " +
        "someone it is not true of — team/page.tsx:352-367."
    ).not.toContainText("Removed Robin");

    // Robin's row survives, because nothing happened to Robin.
    await expect(page.getByRole("button", { name: RESTORE_ROBIN })).toBeVisible();
  });

  test("scenario 13: restoring the LAST former member keeps the section alive for its own notice", async ({
    page,
    context,
  }) => {
    const { former } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": () => {
        former.current = [];
        return reactivateResult();
      },
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "click");
    await confirmButton(page).click();

    await expect(page.getByRole("button", { name: RESTORE_ROBIN })).toHaveCount(0);
    // The section MUST still be rendered, because it is carrying the notice.
    await expect(
      page.locator(POLITE_NOTICE).filter({ hasText: "Done." }),
      "Restoring the last former member empties this list. A section that unmounted on " +
        "`length === 0` would take the notice reporting that very restoration with it — " +
        "team/page.tsx:1054-1058."
    ).toContainText(`Removed Robin is a member of ${TEAM_NAME} again.`);
    await expect(formerToggle(page)).toContainText("Former members (0)");
    // The panel's own empty line, which is only reachable with an outcome on screen.
    await expect(page.getByText("Nobody is currently listed as removed from this team.")).toBeVisible();
  });

  /** A refused restore surfaces the SERVICE's own message and reports that nothing changed. */
  test("a 403 surfaces the service's message as a failure, and the row survives", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": () => {
        throw new TrpcFault(
          "Forbidden: a Judge cannot hold team membership",
          "FORBIDDEN",
          403
        );
      },
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "click");
    await confirmButton(page).click();

    // `role="alert"` for a failure — this one needs answering now.
    const notice = page.locator(ASSERTIVE_NOTICE);
    await expect(notice).toContainText("Not done.");
    await expect(
      notice,
      "The service's own message names the rule that actually fired, and three of its refusals " +
        "are specific enough to act on — team/page.tsx:483-488."
    ).toContainText("Forbidden: a Judge cannot hold team membership");
    // The row survives, because nothing happened.
    await expect(page.getByRole("button", { name: RESTORE_ROBIN })).toBeVisible();
  });

  /** Escape and a backdrop click both dismiss WITHOUT acting — the fail-safe direction. */
  test("Escape and a backdrop click dismiss without issuing a request", async ({
    page,
    context,
  }) => {
    const { calls } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": () => {
        throw new Error("e2e: reactivateMember must NOT be called by a dismissal");
      },
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "keyboard");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Focus returns to the trigger, which survives because nothing was restored.
    await expectFocusOn(
      page,
      RESTORE_ROBIN,
      "A dismissal restores nobody, so the trigger survives and focus must return to it."
    );

    // Backdrop click: a pointer that misses Confirm and lands on the backdrop must CANCEL.
    await openRestoreDialog(page, RESTORE_ROBIN, "click");
    await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(
      calls.countOf("team.reactivateMember"),
      "Neither Escape nor a backdrop click may issue a mutation."
    ).toBe(0);
    await expect(page.locator(POLITE_NOTICE).filter({ hasText: "Done" })).toHaveCount(0);
  });

  /**
   * A READ-ONLY EXECUTIVE IS OFFERED NO RESTORE CONTROL.
   *
   * Gated on the SAME predicate as Remove, with no new rule invented for it: the service's guard
   * on reactivate is `requireTeamWrite`, byte-for-byte the guard on the DELETE it reverses
   * (team/page.tsx:1265-1273). So a screen that offered Remove but hid Restore would make every
   * mistaken removal permanent for the person who made it — and the converse must hold too.
   */
  test("a read-only EXECUTIVE reads the history but is offered no Restore control", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, EXECUTIVE_SELF, [FORMER_ROBIN]);
    await expandFormer(page);

    // The history still renders — an executive reads the team, they just cannot write it.
    await expect(page.locator("#former-members-panel").getByText("Removed Robin")).toBeVisible();
    await expect(
      page.getByRole("button", { name: RESTORE_ROBIN }),
      "Hiding this from a read-only EXECUTIVE is a courtesy; requireTeamWrite refuses the " +
        "request regardless. But the control must not be offered."
    ).toHaveCount(0);
  });

  /**
   * THE REASON FIELD IS CAPPED AT THE INPUT, AND A BLANK ONE TRAVELS AS `undefined`.
   *
   * The boundary matrix on the one free-text input this dialog has, plus the superjson
   * distinction: whitespace-only must collapse to `undefined` rather than travel as `""`
   * (team/page.tsx:1511-1513). Readable here only because the fixture deserializes the request
   * with real superjson — see the header note in fixtures/trpc.ts on why reading `.json`
   * directly would misreport `undefined` as `null`.
   */
  test("the reason is capped at 200 code points, and a whitespace-only reason travels as undefined", async ({
    page,
    context,
  }) => {
    let submitted: Record<string, unknown> = {};
    let sawReason = true;
    const { former } = await openTeamPage(page, context, ADMIN_SELF, [FORMER_ROBIN], {
      "team.reactivateMember": (input) => {
        submitted = input as Record<string, unknown>;
        sawReason = (input as { reason?: unknown }).reason !== undefined;
        former.current = [];
        return reactivateResult();
      },
    });

    await expandFormer(page);
    await openRestoreDialog(page, RESTORE_ROBIN, "click");
    const reason = page.getByRole("textbox", { name: /Reason/ });

    // AT the limit.
    await reason.fill("a".repeat(200));
    await expect(page.getByText("0 characters left")).toBeVisible();

    // LIMIT + 1: maxLength must refuse the 201st rather than accept and truncate.
    await reason.fill("b".repeat(200));
    await reason.press("End");
    await reason.pressSequentially("XYZ");
    const held = await reason.inputValue();
    expect(
      [...held].length,
      `The textarea's maxLength is AUDIT_REASON_MAX, so typing past it must not be accepted. ` +
        `Held ${[...held].length} characters.`
    ).toBe(200);

    // Astral characters count as ONE, because the counter uses [...reason].length rather than
    // `.length` — a counter using `.length` would disagree with both the operator's eyes and
    // the service's own cap.
    await reason.fill("👍👍👍");
    await expect(page.getByText("197 characters left")).toBeVisible();

    // WHITESPACE ONLY → undefined.
    await reason.fill("   \t  ");
    await confirmButton(page).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      sawReason,
      `A whitespace-only reason must collapse to undefined rather than travel as "". Received ` +
        `input: ${JSON.stringify(submitted)}`
    ).toBe(false);
  });
});
