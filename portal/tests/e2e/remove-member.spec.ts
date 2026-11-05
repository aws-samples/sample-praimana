/**
 * REMOVING A MEMBER FROM A TEAM — the browser-only contract.
 *
 * ── WHAT THIS SPEC IS FOR, AND WHAT IT IS NOT DUPLICATING ──
 * The portal's vitest suite is `environment: "node"` with no DOM (vitest.config.mts),
 * so it can and does cover the gating predicate, the outcome message text and the
 * request-correlation logic as pure functions. What it structurally CANNOT observe is
 * anything that requires a real focus model, a real tab order and a real network stack:
 *
 *   1. where `document.activeElement` ends up after a successful removal;
 *   2. whether focus survives the confirm button disabling itself under the keyboard,
 *      and whether Escape still works afterwards;
 *   3. whether the focus trap holds in both directions while the focusable set changes;
 *   4. whether `disabled` genuinely prevents a second submit ON THE WIRE.
 *
 * Those four are the whole reason this file exists. Everything else here is context needed
 * to reach them.
 *
 * ── NO SLEEPS, ANYWHERE ──
 * Every wait in this file is either a Playwright web-first assertion (which polls a
 * condition) or `deferred()`'s call-count poll. The pending state is made observable by
 * HOLDING the mutation open rather than by racing a fast one, so these are not
 * timing-sensitive tests dressed up as deterministic ones — the state is stable while the
 * assertion runs. See fixtures/trpc.ts's note on `deferred`.
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
  MEMBER_PRIYA,
  MEMBER_SAM,
  TEAM_ID,
  TEAM_NAME,
  WORKSHOP_ID,
  meFixture,
  removeMemberResult,
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

/** The accessible name the implementation builds: `Remove ${label} from ${team.name}`. */
const REMOVE_PRIYA = `Remove ${MEMBER_PRIYA.user.name} from ${TEAM_NAME}`;
const REMOVE_SAM = `Remove ${MEMBER_SAM.user.name} from ${TEAM_NAME}`;

/**
 * Put a signed-in operator on the team page with a controlled roster.
 *
 * Returns the call log and the roster mutator, so a spec can make the removal actually take
 * effect on the next refetch — which is what reproduces the "doomed but still mounted"
 * trigger the focus contract is about. A fixture whose roster never shrinks would never
 * unmount the button, and priority #1 would pass for the wrong reason.
 */
async function openTeamPage(
  page: Page,
  context: BrowserContext,
  identity: SpecIdentity,
  members: TeamMemberFixture[],
  extra: Record<string, ProcedureHandler> = {}
): Promise<{ calls: TrpcCallLog; roster: { current: TeamMemberFixture[] } }> {
  await signInAs(context, identity, secret!);
  const roster = { current: members };
  const calls = countTrpcCalls(page);

  await serveTrpc(page, {
    "auth.me": () => meFixture(identity),
    // Re-read from `roster.current` on every call, so an invalidate-driven refetch sees the
    // post-removal roster exactly as it would against a real service.
    "team.getById": () => teamFixture(roster.current),
    "team.listInvitations": () => [],
    ...extra,
  });

  await page.goto(TEAM_URL);
  // The heading proves the page rendered AND the roster query resolved — a single condition
  // that covers both, rather than waiting on a load event that says nothing about content.
  await expect(page.getByRole("heading", { name: /^Members/ })).toBeVisible();
  return { calls, roster };
}

/** Open the confirmation dialog for a member by activating their Remove button. */
async function openConfirmDialog(page: Page, accessibleName: string, how: "click" | "keyboard") {
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

test.describe("Remove a member from a team", () => {
  test.beforeEach(() => {
    // Skipped, never silently passed, and the message names the variable. See fixtures/env.ts.
    test.skip(!secret, missingSecretMessage(whereLooked));
  });

  /**
   * ── PRIORITY #1 ──
   * FOCUS DOES NOT LAND ON <body> AFTER A SUCCESSFUL REMOVAL.
   *
   * The trigger is "doomed but still mounted": the roster shrinks only when the invalidated
   * query refetches, several ticks after the dialog unmounts. So a cleanup that merely
   * checks `isConnected` finds the Remove button alive, focuses it, and focus drops to
   * <body> when the row unmounts a moment later. `returnToFallback` exists to prevent
   * exactly that, and this asserts it works — by reading where focus ACTUALLY is once the
   * roster has visibly shrunk, i.e. after the moment the naive implementation would fail.
   */
  test("priority 1: focus is not stranded on <body> after a successful removal", async ({
    page,
    context,
  }) => {
    const remove = deferred<ReturnType<typeof removeMemberResult>>();
    const { roster } = await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [selfMember(ADMIN_SELF), MEMBER_PRIYA, MEMBER_SAM],
      { "team.removeMember": remove.handler }
    );

    await openConfirmDialog(page, REMOVE_PRIYA, "keyboard");
    await page.getByRole("button", { name: "Remove from team" }).click();
    await remove.waitUntilCalled(page);

    // The removal now genuinely takes effect, so the refetch really does unmount the row.
    roster.current = [selfMember(ADMIN_SELF), MEMBER_SAM];
    remove.release(removeMemberResult(true));

    // Synchronise on the roster having actually shrunk — the moment AFTER which a
    // focus-the-doomed-trigger implementation has already failed.
    await expect(page.getByRole("button", { name: REMOVE_PRIYA })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const active = await expectFocusNotLost(
      page,
      "After a successful removal the Remove button that opened the dialog is unmounted " +
        "with its row, so ConfirmActionDialog's cleanup must use `returnToFallback` and send " +
        "focus to the fallback (the Members disclosure heading button) instead of the doomed trigger."
    );
    // The contract names the landing place explicitly, so assert it rather than merely
    // "not body" — landing somewhere arbitrary would also be a defect.
    //
    // Matched on "Members" as a substring because the button's text also contains the
    // decorative "▶" twisty and the live count ("▶Members (2)"), neither of which is a
    // stable thing to assert on: the count changes with the roster, which is the point.
    expect(
      active.text.includes("Members"),
      `Focus should be on the Members disclosure heading button (the documented fallback ` +
        `passed as fallbackFocus), but it is on ${active.describe}.`
    ).toBe(true);
    expect(
      active.tag,
      "The fallback must be a focusable BUTTON — the disclosure's own toggle, from which " +
        "Tab walks back into the remaining roster rows."
    ).toBe("button");
  });

  /**
   * ── PRIORITY #2 ──
   * FOCUS IS NOT LOST WHEN CONFIRM DISABLES ITSELF, AND ESCAPE STILL WORKS.
   *
   * Confirm is activated with the KEYBOARD, so focus is ON the button when `pending` flips
   * true. A disabled element cannot hold focus, so the browser drops it to <body> — at which
   * point Escape is dead (the handler is on the panel) and the operator is trapped in a modal
   * mid-destructive-action. The implementation is supposed to move focus to the dismiss
   * button, which is deliberately the control that stays live while pending.
   *
   * Both halves are asserted, and the second is the one that matters: proving focus moved is
   * good, proving the escape hatch WORKS from there is the actual operator guarantee.
   */
  test("priority 2: keyboard-activated Confirm keeps focus in the dialog, and Escape still dismisses in flight", async ({
    page,
    context,
  }) => {
    const remove = deferred<ReturnType<typeof removeMemberResult>>();
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA], {
      "team.removeMember": remove.handler,
    });

    await openConfirmDialog(page, REMOVE_PRIYA, "keyboard");

    // ACTIVATE WITH THE KEYBOARD. This is the whole point: focus must be ON the confirm
    // button at the instant it becomes disabled. A .click() would leave focus elsewhere and
    // the defect would not reproduce.
    const confirm = page.getByRole("button", { name: "Remove from team" });
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");

    // The pending state is now stable because the mutation is held open.
    await remove.waitUntilCalled(page);
    await expect(page.getByRole("button", { name: "Removing…" })).toBeDisabled();

    await expectFocusInsideDialog(
      page,
      "The confirm button disabled itself while holding focus. A disabled element cannot " +
        "hold focus, so ConfirmActionDialog's `pending` effect must move focus to the dismiss " +
        "button — the one control that stays live while a request is in flight."
    );
    await expectFocusOn(
      page,
      "Close",
      "While pending, the dismiss button relabels to 'Close' and is the documented landing " +
        "place for focus, because it is the escape hatch."
    );

    // THE HALF THAT PROVES IT MATTERS. If focus had fallen to <body>, this keypress would
    // reach nothing and the operator would be trapped.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Dismissed mid-flight is UNKNOWN, not failure — the request was sent and nobody saw
    // the answer. Asserted by its text, because that is what the operator reads, and via
    // the ASSERTIVE role, because an unknown outcome must interrupt rather than announce
    // politely. (See ASSERTIVE_NOTICE on why role="alert" alone is ambiguous here.)
    const notice = page.locator(ASSERTIVE_NOTICE);
    await expect(notice).toContainText("Outcome unknown");
    await expect(notice).toContainText(
      `The request to remove ${MEMBER_PRIYA.user.name} was sent but the result was never seen.`
    );

    remove.release(removeMemberResult(true));
  });

  /**
   * ── PRIORITY #3 ──
   * THE FOCUS TRAP HOLDS IN BOTH DIRECTIONS, INCLUDING WHILE THE FOCUSABLE SET CHANGES.
   *
   * `aria-modal` tells a screen reader the rest of the page is inert; it does NOT stop Tab.
   * So without the trap a keyboard operator walks out of a dialog that is still on screen and
   * starts operating controls behind the backdrop.
   *
   * The interesting half is the second: the confirm button leaves the tab order when it goes
   * disabled (the selector is `:not([disabled])`), so the "last focusable" the trap wraps
   * from CHANGES mid-interaction. The implementation rebuilds the list per keypress, and this
   * proves that rather than assuming it.
   */
  test("priority 3: the focus trap holds forwards and backwards, and after the focusable set shrinks", async ({
    page,
    context,
  }) => {
    const remove = deferred<ReturnType<typeof removeMemberResult>>();
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA], {
      "team.removeMember": remove.handler,
    });

    await openConfirmDialog(page, REMOVE_PRIYA, "keyboard");

    // Focus opens on the PANEL, not a button — nothing is pre-armed.
    const opened = await activeElement(page);
    expect(
      opened.role,
      `On open, focus must land on the dialog panel itself so the question and every ` +
        `consequence are announced and no destructive action is pre-armed. Focus is on ${opened.describe}.`
    ).toBe("dialog");

    // BACKWARDS FROM THE BOUNDARY. Shift+Tab from the panel (which counts as the start)
    // must wrap to the LAST control, not escape to the page behind.
    await page.keyboard.press("Shift+Tab");
    await expectFocusInsideDialog(
      page,
      "Shift+Tab from the dialog's initial focus target must wrap to the last control " +
        "inside the dialog, not walk backwards into the page behind the backdrop."
    );
    await expectFocusOn(
      page,
      "Remove from team",
      "Wrapping backwards from the start lands on the last focusable, which is the confirm button."
    );

    // FORWARDS FROM THE BOUNDARY. Tab on the last element must wrap to the first.
    //
    // THE FIRST FOCUSABLE IS THE REASON TEXTAREA, not Cancel — and that is worth stating
    // because it is easy to assume otherwise. The trap builds its list with
    // querySelectorAll, which returns DOCUMENT order regardless of the order the selectors
    // are written in, and the textarea sits above the button footer in the markup. Verified
    // by reading the live list rather than assumed: [textarea, Cancel, Remove from team].
    await page.keyboard.press("Tab");
    await expectFocusInsideDialog(
      page,
      "Tab on the last control inside the dialog must wrap to the first, not escape the modal."
    );
    const wrapped = await activeElement(page);
    expect(
      wrapped.tag,
      `Wrapping forwards from the last focusable must land on the FIRST in document order, ` +
        `which is the reason textarea. Focus is on ${wrapped.describe}.`
    ).toBe("textarea");

    // The list the trap actually walks, read from the DOM with the implementation's own
    // selector. Asserted so a future markup reorder that changes the boundaries is caught
    // here rather than silently changing which element the wrap lands on.
    const before = await dialogFocusables(page);
    expect(
      before,
      `The trap's focusable list, in document order. Saw: ${JSON.stringify(before)}`
    ).toEqual(["", "Cancel", "Remove from team"]);

    // Walk the whole ring forwards and confirm every stop stays inside. Bounded by the
    // number of focusables + 2, so a broken trap fails rather than looping forever.
    for (let i = 0; i < before.length + 2; i++) {
      await page.keyboard.press("Tab");
      await expectFocusInsideDialog(
        page,
        `Tab #${i + 1} of a full walk around the trap escaped the dialog.`
      );
    }

    // ── NOW CHANGE THE FOCUSABLE SET ── submit, so Confirm goes disabled and drops OUT of
    // the tab order. The trap's "last element" becomes the dismiss button.
    const confirm = page.getByRole("button", { name: "Remove from team" });
    await confirm.focus();
    await page.keyboard.press("Enter");
    await remove.waitUntilCalled(page);
    await expect(page.getByRole("button", { name: "Removing…" })).toBeDisabled();

    const during = await dialogFocusables(page);
    expect(
      during,
      `While pending, the confirm button is disabled and must LEAVE the focusable set — the ` +
        `trap's selector is 'button:not([disabled]), textarea:not([disabled]), [href]'. The ` +
        `set should shrink from 3 to 2 and the dismiss button should relabel to "Close". ` +
        `Saw: ${JSON.stringify(during)}`
    ).toEqual(["", "Close"]);
    expect(
      during.some((n) => n.includes("Removing")),
      "The disabled confirm button must not be reachable by Tab while its request is in flight."
    ).toBe(false);

    // The trap must still hold with the SHRUNKEN set, in both directions.
    for (let i = 0; i < during.length + 2; i++) {
      await page.keyboard.press("Tab");
      await expectFocusInsideDialog(
        page,
        `Tab #${i + 1} escaped the dialog AFTER the focusable set shrank (confirm went disabled). ` +
          `The trap rebuilds its list per keypress; if it cached the list, the stale 'last ` +
          `element' would be a disabled button and the wrap would never fire.`
      );
    }
    for (let i = 0; i < during.length + 2; i++) {
      await page.keyboard.press("Shift+Tab");
      await expectFocusInsideDialog(
        page,
        `Shift+Tab #${i + 1} escaped the dialog after the focusable set shrank.`
      );
    }

    remove.release(removeMemberResult(true));
  });

  /**
   * ── PRIORITY #4 ──
   * `disabled` GENUINELY PREVENTS A SECOND SUBMIT — counted ON THE WIRE.
   *
   * The service's delete is unconditional and writes a MEMBER_REMOVED entry every call, so a
   * duplicate is a real second effect, not a harmless retry. The count comes from
   * `page.on("request")`, which observes requests the browser actually emitted — so this
   * cannot be satisfied by a mock that was merely called once.
   *
   * `dispatchEvent` is used for the second attempt, not `.click()`: Playwright's click
   * refuses a disabled element (it would hang on an actionability check and the spec would
   * time out rather than assert), while a dispatched event is precisely what a real
   * double-click's second event is. If the handler were still live, it would fire.
   */
  test("priority 4: a double-submit issues exactly ONE removeMember request", async ({
    page,
    context,
  }) => {
    const remove = deferred<ReturnType<typeof removeMemberResult>>();
    const { calls } = await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [selfMember(ADMIN_SELF), MEMBER_PRIYA],
      { "team.removeMember": remove.handler }
    );

    await openConfirmDialog(page, REMOVE_PRIYA, "click");
    const confirm = page.getByRole("button", { name: "Remove from team" });

    // First submit, then hammer the same element while its request is in flight.
    await confirm.click();
    await remove.waitUntilCalled(page);

    const disabledConfirm = page.getByRole("button", { name: "Removing…" });
    await expect(disabledConfirm).toBeDisabled();
    for (let i = 0; i < 5; i++) {
      await disabledConfirm.dispatchEvent("click");
    }
    // Also press Enter and Space on it, the keyboard equivalents of a double-submit.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");

    expect(
      remove.calls(),
      `The confirm button is disabled the instant it is pressed, so five further clicks plus ` +
        `Enter and Space must produce NO additional mutation. A second removal writes a ` +
        `second MEMBER_REMOVED audit entry and answers "not a member", which an operator ` +
        `cannot distinguish from a first attempt that failed.`
    ).toBe(1);
    expect(
      calls.countOf("team.removeMember"),
      `Counted on the wire via page.on("request"): exactly one team.removeMember operation ` +
        `must have left the browser. Saw ${calls.countOf("team.removeMember")} ` +
        `(all tRPC ops this run: ${JSON.stringify(calls.paths)}).`
    ).toBe(1);

    remove.release(removeMemberResult(true));
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  /** The happy path, end to end, asserted by the outcome notice's text. */
  test("happy path: removing a member reports a confirmed outcome naming the person and the team", async ({
    page,
    context,
  }) => {
    const { roster } = await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [selfMember(ADMIN_SELF), MEMBER_PRIYA, MEMBER_SAM],
      {
        "team.removeMember": (input) => {
          const { userId } = input as { userId: string };
          expect(
            userId,
            "The mutation must carry the userId of the row that was clicked."
          ).toBe(MEMBER_PRIYA.userId);
          roster.current = [selfMember(ADMIN_SELF), MEMBER_SAM];
          return removeMemberResult(true);
        },
      }
    );

    await openConfirmDialog(page, REMOVE_PRIYA, "click");

    // The dialog names the target AND their email — the mis-click this dialog exists to catch.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Remove ${MEMBER_PRIYA.user.name} from ${TEAM_NAME}?`);
    await expect(dialog).toContainText(MEMBER_PRIYA.user.email!);
    await expect(dialog).toContainText("This cannot be undone.");

    await page.getByRole("button", { name: "Remove from team" }).click();

    // `role="status"` for a clean success — announced politely, not as an interruption.
    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done." });
    await expect(notice).toContainText(
      `${MEMBER_PRIYA.user.name} is no longer a member of ${TEAM_NAME}.`
    );
    await expect(page.getByRole("button", { name: REMOVE_PRIYA })).toHaveCount(0);
    await expect(page.getByRole("button", { name: REMOVE_SAM })).toBeVisible();
  });

  /**
   * `audited: false` is a PARTIAL, not a success.
   *
   * The membership row is hard-deleted, so the audit entry is the only remaining evidence the
   * person was ever on the team. Reporting an unaudited removal as clean would hide the one
   * fact worth an alarm.
   */
  test("an unaudited removal is reported as a partial, not a clean success", async ({
    page,
    context,
  }) => {
    const { roster } = await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [selfMember(ADMIN_SELF), MEMBER_PRIYA],
      {
        "team.removeMember": () => {
          roster.current = [selfMember(ADMIN_SELF)];
          return removeMemberResult(false);
        },
      }
    );

    await openConfirmDialog(page, REMOVE_PRIYA, "click");
    await page.getByRole("button", { name: "Remove from team" }).click();

    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done, with a gap." });
    await expect(notice).toContainText("could not be written to the audit trail");
    await expect(notice).toContainText("there is no record of who made this change");
  });

  /** A refused removal surfaces the SERVICE's own message, and reports nothing changed. */
  test("a 403 surfaces the service's message as a failure, not a success", async ({
    page,
    context,
  }) => {
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA], {
      "team.removeMember": () => {
        throw new TrpcFault("Forbidden: your role has read-only access", "FORBIDDEN", 403);
      },
    });

    await openConfirmDialog(page, REMOVE_PRIYA, "click");
    await page.getByRole("button", { name: "Remove from team" }).click();

    // `role="alert"` for a failure — this one needs answering now.
    const notice = page.locator(ASSERTIVE_NOTICE);
    await expect(notice).toContainText("Not done.");
    await expect(notice).toContainText("Forbidden: your role has read-only access");
    // The row survives, because nothing happened.
    await expect(page.getByRole("button", { name: REMOVE_PRIYA })).toBeVisible();
  });

  /** Escape and a backdrop click both dismiss WITHOUT acting — the fail-safe direction. */
  test("Escape and a backdrop click dismiss without issuing a request", async ({
    page,
    context,
  }) => {
    const { calls } = await openTeamPage(
      page,
      context,
      ADMIN_SELF,
      [selfMember(ADMIN_SELF), MEMBER_PRIYA],
      {
        "team.removeMember": () => {
          throw new Error("e2e: removeMember must NOT be called by a dismissal");
        },
      }
    );

    await openConfirmDialog(page, REMOVE_PRIYA, "keyboard");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Focus returns to the trigger, which is still mounted because nothing was removed.
    await expectFocusOn(
      page,
      REMOVE_PRIYA,
      "A dismissal removes nobody, so the trigger survives and focus must return to it."
    );

    // Backdrop click: a pointer that misses Confirm and lands on the backdrop must CANCEL.
    await openConfirmDialog(page, REMOVE_PRIYA, "click");
    // The backdrop is the dialog's parent; click its top-left corner, well clear of the panel.
    await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(
      calls.countOf("team.removeMember"),
      "Neither Escape nor a backdrop click may issue a mutation."
    ).toBe(0);
    // No outcome notice at all: nothing happened, so there is nothing to report.
    await expect(page.locator(POLITE_NOTICE).filter({ hasText: "Done" })).toHaveCount(0);
  });

  /** The caller's own row is never offered a Remove button. */
  test("the caller's own row carries no Remove control", async ({ page, context }) => {
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA]);

    await expect(
      page.getByRole("button", { name: `Remove ${ADMIN_SELF.name} from ${TEAM_NAME}` })
    ).toHaveCount(0);
    // And the absence is EXPLAINED, so it reads as a rule rather than a missing control.
    await expect(page.getByText("(you)")).toBeVisible();
    await expect(page.getByRole("button", { name: REMOVE_PRIYA })).toBeVisible();
  });

  /** A read-only EXECUTIVE is offered no Remove control on anyone. */
  test("a read-only EXECUTIVE is offered no Remove control at all", async ({ page, context }) => {
    await openTeamPage(page, context, EXECUTIVE_SELF, [
      selfMember(EXECUTIVE_SELF),
      MEMBER_PRIYA,
      MEMBER_SAM,
    ]);

    // The roster still renders — an executive reads the team, they just cannot write it.
    await expect(page.getByText(MEMBER_PRIYA.user.name)).toBeVisible();
    await expect(page.getByRole("button", { name: REMOVE_PRIYA })).toHaveCount(0);
    await expect(page.getByRole("button", { name: REMOVE_SAM })).toHaveCount(0);
  });

  /**
   * THE REASON FIELD IS CAPPED AT THE INPUT, and the cap is the shared AUDIT_REASON_MAX.
   *
   * Boundary matrix on the one free-text input this dialog has: at the limit, past the limit,
   * and with astral-plane characters where a naive `.length` disagrees with `[...s].length`.
   */
  test("the reason field caps at 200 characters, counted by code point", async ({
    page,
    context,
  }) => {
    let submittedReason: unknown = "unset";
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA], {
      "team.removeMember": (input) => {
        submittedReason = (input as { reason?: string }).reason;
        return removeMemberResult(true);
      },
    });

    await openConfirmDialog(page, REMOVE_PRIYA, "click");
    const reason = page.getByRole("textbox", { name: /Reason/ });

    // AT the limit.
    await reason.fill("a".repeat(200));
    await expect(page.getByText("0 characters left")).toBeVisible();

    // LIMIT + 1: maxLength must refuse the 201st character rather than accept and truncate.
    await reason.fill("b".repeat(200));
    await reason.press("End");
    await reason.pressSequentially("XYZ");
    const held = await reason.inputValue();
    expect(
      [...held].length,
      `The textarea's maxLength is AUDIT_REASON_MAX, so typing past it must not be accepted. ` +
        `Held ${[...held].length} characters.`
    ).toBe(200);

    // Emoji: the counter uses [...reason].length, so an astral character counts as ONE
    // rather than as the two UTF-16 units `.length` would report. A counter using `.length`
    // would disagree with both the operator's eyes and the service's own cap.
    await reason.fill("👍👍👍");
    await expect(page.getByText("197 characters left")).toBeVisible();

    await reason.fill("  Left the programme  ");
    await page.getByRole("button", { name: "Remove from team" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(
      submittedReason,
      "A reason is trimmed before it is sent; whitespace-only collapses to undefined."
    ).toBe("Left the programme");
  });

  /**
   * ── DEFECT-1 REGRESSION TEST ── ⚠ CURRENTLY FAILING. This is a real defect, not a flaky test.
   *
   * DISMISSING THE DIALOG WHILE THE REQUEST IS IN FLIGHT STRANDS FOCUS ON <body>.
   *
   * The flow is explicitly supported — ConfirmActionDialog's `onDismiss` documents that
   * dismissal "REMAINS AVAILABLE WHILE PENDING, deliberately", because `backendFetch` passes
   * no AbortSignal and a hung request must not trap the operator in a modal. Both callers
   * implement the UNKNOWN outcome for it. So this is a first-class path, not an edge case.
   *
   * MECHANISM, established by direct observation rather than inference. While a removal is in
   * flight the trigger renders `disabled` (`disabled={isRemoving}`, team page ~line 707) and
   * reads "Removing…". The dialog's unmount cleanup is:
   *
   *     const doomed = returnToFallbackRef.current?.() ?? false;
   *     if (!doomed && opener instanceof HTMLElement && opener.isConnected) {
   *       opener.focus();            // ← silent no-op on a DISABLED element
   *       return;                    // ← returns, so the fallback is never tried
   *     }
   *     fallbackRef.current?.()?.focus();
   *
   * At dismiss time `doomed` is false (no success yet) and `isConnected` is TRUE (the row is
   * still on the roster), so the guard takes the opener branch — but the opener is disabled
   * and cannot hold focus. `.focus()` does nothing, `return` skips the fallback, and focus
   * stays on <body>. Probed directly: the trigger reports
   * `{text:"Removing…", isConnected:true, disabled:true, focusable:false}`.
   *
   * WHY IT MATTERS. This is the same stranding the component's own comments are written to
   * prevent, arriving through the one door the guard does not check. The operator has just
   * dismissed a destructive action whose outcome is UNKNOWN — the moment they most need to
   * read the notice and act — and their keyboard is now at the top of the document.
   *
   * THE FIX IS IN PRODUCTION CODE and is not made here: the cleanup guard at
   * ConfirmActionDialog.tsx:248 needs to treat a disabled opener as unfocusable, the same way
   * it already treats a detached one. Route to senior-developer.
   */
  test("DEFECT-1: dismissing while the request is in flight must not strand focus on <body>", async ({
    page,
    context,
  }) => {
    const remove = deferred<ReturnType<typeof removeMemberResult>>();
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA], {
      "team.removeMember": remove.handler,
    });

    await openConfirmDialog(page, REMOVE_PRIYA, "keyboard");
    await page.getByRole("button", { name: "Remove from team" }).click();
    await remove.waitUntilCalled(page);

    // Confirm the precondition rather than assuming it: the trigger is still mounted AND
    // disabled, which is the exact combination the cleanup guard mishandles.
    const trigger = page.getByRole("button", { name: REMOVE_PRIYA });
    await expect(trigger).toBeDisabled();

    // Dismiss mid-flight — the supported path. The dialog closes and cleanup runs.
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The outcome IS reported correctly; the notice is not the defect.
    await expect(page.locator(ASSERTIVE_NOTICE)).toContainText("Outcome unknown");

    await expectFocusNotLost(
      page,
      "The operator dismissed a destructive action whose outcome is UNKNOWN — the moment they " +
        "most need to read the notice and act on it. The dialog's cleanup guard " +
        "(ConfirmActionDialog.tsx:248) checks `opener.isConnected` but not whether the opener " +
        "can actually TAKE focus. While the request is in flight the trigger is `disabled`, so " +
        "`opener.focus()` is a silent no-op and the `return` skips the fallback entirely."
    );

    remove.release(removeMemberResult(true));
  });

  /** A blank reason is sent as `undefined`, never as an empty string. */
  test("a whitespace-only reason is sent as undefined, not an empty string", async ({
    page,
    context,
  }) => {
    let sawReasonKey = true;
    let submitted: Record<string, unknown> = {};
    await openTeamPage(page, context, ADMIN_SELF, [selfMember(ADMIN_SELF), MEMBER_PRIYA], {
      "team.removeMember": (input) => {
        submitted = input as Record<string, unknown>;
        sawReasonKey = (input as { reason?: unknown }).reason !== undefined;
        return removeMemberResult(true);
      },
    });

    await openConfirmDialog(page, REMOVE_PRIYA, "click");
    await page.getByRole("textbox", { name: /Reason/ }).fill("   \t  ");
    await page.getByRole("button", { name: "Remove from team" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(
      sawReasonKey,
      `A whitespace-only reason must collapse to undefined rather than travel as "". ` +
        `Received input: ${JSON.stringify(submitted)}`
    ).toBe(false);
  });
});
