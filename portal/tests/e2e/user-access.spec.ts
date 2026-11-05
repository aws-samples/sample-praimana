/**
 * DISABLING AND RESTORING PLATFORM ACCESS — the browser-only contract.
 *
 * Same division of labour as remove-member.spec.ts: the node suite covers the gating
 * predicate and the outcome-message construction as pure functions, and this file covers
 * what only a browser can answer — real focus, a real tab order, a real accessibility tree,
 * and requests genuinely leaving the browser.
 *
 * ── THE ONE STRUCTURAL DIFFERENCE FROM A TEAM REMOVAL, AND WHY IT MATTERS HERE ──
 * A disabled row SURVIVES its action. It flips its badge and swaps the button's label from
 * "Disable" to "Restore" — same element, still mounted — so `returnToFallback` is
 * deliberately NOT passed on this screen and focus is supposed to return to the trigger. That
 * is the opposite of the team page's contract, from the same component, and it is exactly the
 * kind of asymmetry that a shared component quietly gets wrong. So it is asserted directly.
 *
 * ── THE GATING CASE THAT MATTERS MOST ──
 * A FACILITATOR must be offered NO control on an ADMIN row or on another FACILITATOR row.
 * That is the lateral-attack case USER_ADMIN_GRANTS exists to close: one facilitator
 * disabling another mid-workshop, or reaching an admin. Asserted through the accessibility
 * tree (the button's `aria-label` names the person and the direction), because a control that
 * is invisible to a sighted operator but present in the tree is still a reachable control.
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
  FACILITATOR_SELF,
  USER_ADMIN_TARGET,
  USER_DISABLED,
  USER_FACILITATOR_PEER,
  USER_NO_ACCOUNT,
  USER_PARTICIPANT,
  listUsersFixture,
  meFixture,
  selfUser,
  setUserAccessResult,
  type AdminUserFixture,
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

const ADMIN_URL = "/admin?tab=users";

/** The accessible names the implementation builds, per direction. */
const disableName = (u: AdminUserFixture) => `Disable sign-in access for ${u.name}`;
const restoreName = (u: AdminUserFixture) => `Restore sign-in access for ${u.name}`;

async function openAdminUsers(
  page: Page,
  context: BrowserContext,
  identity: SpecIdentity,
  users: AdminUserFixture[],
  extra: Record<string, ProcedureHandler> = {}
): Promise<{ calls: TrpcCallLog; directory: { current: AdminUserFixture[] } }> {
  await signInAs(context, identity, secret!);
  const directory = { current: users };
  const calls = countTrpcCalls(page);

  await serveTrpc(page, {
    "auth.me": () => meFixture(identity),
    // Re-read per call so an invalidate-driven refetch observes the post-change directory,
    // which is what makes the badge flip and the label swap real rather than assumed.
    "admin.listUsers": () => listUsersFixture(directory.current),
    "admin.filterScopes": () => ({ scopes: [] }),
    /* The admin tab bar reads the unread report count on every tab, so this is needed even by a
       spec that never opens Feedback. Absent, `serveTrpc` now warns loudly about an unstubbed
       procedure — which is the point of that warning, and this is it doing its job. */
    "feedback.list": () => ({ items: [], nextCursor: null, unreadCount: 0 }),
    ...extra,
  });

  await page.goto(ADMIN_URL);
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  return { calls, directory };
}

async function openAccessDialog(page: Page, accessibleName: string, how: "click" | "keyboard") {
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

test.describe("Disable and restore platform access", () => {
  test.beforeEach(() => {
    test.skip(!secret, missingSecretMessage(whereLooked));
  });

  /**
   * ── PRIORITY #1, THE OTHER DIRECTION ──
   * The row SURVIVES a disable, so focus must return to the TRIGGER — and the trigger has
   * relabelled itself from "Disable" to "Restore" underneath the focus.
   *
   * This is the case where the team page's contract would be WRONG. Asserting it here is
   * what stops a future "fix" from adding `returnToFallback` to both callers and silently
   * sending an admin's focus to the search box after every disable.
   */
  test("priority 1: focus returns to the surviving trigger after a disable, not to <body>", async ({
    page,
    context,
  }) => {
    const { directory } = await openAdminUsers(
      page,
      context,
      ADMIN_SELF,
      [selfUser(ADMIN_SELF), USER_PARTICIPANT],
      {
        "admin.setUserAccess": (input) => {
          const { userId, enabled } = input as { userId: string; enabled: boolean };
          // The row survives and flips to DEACTIVATED — the real post-disable state.
          directory.current = directory.current.map((u) =>
            u.id === userId ? { ...u, status: enabled ? "ACTIVE" : "DEACTIVATED" } : u
          );
          return setUserAccessResult({ userId, enabled, invitationsRevoked: 0 });
        },
      }
    );

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "keyboard");
    await page.getByRole("button", { name: "Disable access" }).click();

    // Synchronise on the row having actually flipped: the label swap IS the post-refetch state.
    await expect(page.getByRole("button", { name: restoreName(USER_PARTICIPANT) })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await expectFocusNotLost(
      page,
      "This row SURVIVES a disable — it flips its badge and relabels its button from " +
        "'Disable' to 'Restore'. The trigger is the same element and is still mounted, so " +
        "ConfirmActionDialog's cleanup must return focus to it. (No returnToFallback is " +
        "passed on this screen, deliberately, unlike the team page's removal.)"
    );
    await expectFocusOn(
      page,
      restoreName(USER_PARTICIPANT),
      "Focus must land on the same button the operator opened the dialog from — now reading " +
        "'Restore', so an immediate undo costs no navigation."
    );
  });

  /**
   * ── PRIORITY #2 ──
   * Keyboard-activated Confirm keeps focus in the dialog, and Escape still dismisses.
   */
  test("priority 2: keyboard-activated Confirm keeps focus in the dialog, and Escape still dismisses in flight", async ({
    page,
    context,
  }) => {
    const access = deferred<ReturnType<typeof setUserAccessResult>>();
    await openAdminUsers(page, context, ADMIN_SELF, [selfUser(ADMIN_SELF), USER_PARTICIPANT], {
      "admin.setUserAccess": access.handler,
    });

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "keyboard");

    const confirm = page.getByRole("button", { name: "Disable access" });
    await confirm.focus();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");

    await access.waitUntilCalled(page);
    await expect(page.getByRole("button", { name: "Disabling…" })).toBeDisabled();

    await expectFocusInsideDialog(
      page,
      "The confirm button disabled itself while holding focus. A disabled element cannot " +
        "hold focus, so focus must move to the dismiss button rather than dropping to <body>."
    );
    await expectFocusOn(
      page,
      "Close",
      "The dismiss button stays live while pending precisely so it can receive focus here."
    );

    // Proves the handler is alive: if focus had fallen to <body>, the panel's keydown
    // listener would never see this and the operator would be trapped mid-disable.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const notice = page.locator(ASSERTIVE_NOTICE);
    await expect(notice).toContainText("Outcome unknown");
    await expect(notice).toContainText(
      `The request to disable access for ${USER_PARTICIPANT.name} was sent but the result was never seen.`
    );

    access.release(
      setUserAccessResult({ userId: USER_PARTICIPANT.id, enabled: false })
    );
  });

  /** ── PRIORITY #3 ── the trap holds in both directions, and across the set shrinking. */
  test("priority 3: the focus trap holds forwards and backwards, and after the focusable set shrinks", async ({
    page,
    context,
  }) => {
    const access = deferred<ReturnType<typeof setUserAccessResult>>();
    await openAdminUsers(page, context, ADMIN_SELF, [selfUser(ADMIN_SELF), USER_PARTICIPANT], {
      "admin.setUserAccess": access.handler,
    });

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "keyboard");

    const opened = await activeElement(page);
    expect(
      opened.role,
      `Focus must open on the panel so the question and all three consequences are announced ` +
        `and neither button is pre-armed. Focus is on ${opened.describe}.`
    ).toBe("dialog");

    // Backwards from the boundary: must wrap to the LAST control, not escape.
    await page.keyboard.press("Shift+Tab");
    await expectFocusOn(
      page,
      "Disable access",
      "Shift+Tab from the panel (which counts as the start) must wrap to the last focusable."
    );

    // Forwards from the boundary: must wrap to the FIRST, which is the reason textarea
    // (document order — see the note in remove-member.spec.ts).
    await page.keyboard.press("Tab");
    const wrapped = await expectFocusInsideDialog(
      page,
      "Tab on the last control must wrap to the first, not escape the modal."
    );
    expect(wrapped.tag, `Expected the reason textarea; focus is on ${wrapped.describe}.`).toBe(
      "textarea"
    );

    const before = await dialogFocusables(page);
    expect(before, `The trap's list in document order. Saw ${JSON.stringify(before)}`).toEqual([
      "",
      "Cancel",
      "Disable access",
    ]);

    for (let i = 0; i < before.length + 2; i++) {
      await page.keyboard.press("Tab");
      await expectFocusInsideDialog(page, `Tab #${i + 1} of a full ring walk escaped the dialog.`);
    }

    // Shrink the set: submit so Confirm goes disabled and leaves the tab order.
    await page.getByRole("button", { name: "Disable access" }).focus();
    await page.keyboard.press("Enter");
    await access.waitUntilCalled(page);
    await expect(page.getByRole("button", { name: "Disabling…" })).toBeDisabled();

    const during = await dialogFocusables(page);
    expect(
      during,
      `The disabled confirm button must leave the focusable set. Saw ${JSON.stringify(during)}`
    ).toEqual(["", "Close"]);

    for (let i = 0; i < during.length + 2; i++) {
      await page.keyboard.press("Tab");
      await expectFocusInsideDialog(
        page,
        `Tab #${i + 1} escaped the dialog AFTER the focusable set shrank. The trap rebuilds ` +
          `its list per keypress; a cached list would hold a stale disabled 'last element' ` +
          `and the wrap would never fire.`
      );
    }
    for (let i = 0; i < during.length + 2; i++) {
      await page.keyboard.press("Shift+Tab");
      await expectFocusInsideDialog(
        page,
        `Shift+Tab #${i + 1} escaped the dialog after the focusable set shrank.`
      );
    }

    access.release(setUserAccessResult({ userId: USER_PARTICIPANT.id, enabled: false }));
  });

  /**
   * ── PRIORITY #4 ──
   * Exactly ONE setUserAccess request, counted on the wire.
   *
   * The stakes are higher here than on a team removal: a second disable re-revokes
   * invitations and writes a second ACCESS_DISABLED audit entry.
   */
  test("priority 4: a double-submit issues exactly ONE setUserAccess request", async ({
    page,
    context,
  }) => {
    const access = deferred<ReturnType<typeof setUserAccessResult>>();
    const { calls } = await openAdminUsers(
      page,
      context,
      ADMIN_SELF,
      [selfUser(ADMIN_SELF), USER_PARTICIPANT],
      { "admin.setUserAccess": access.handler }
    );

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "click");
    await page.getByRole("button", { name: "Disable access" }).click();
    await access.waitUntilCalled(page);

    const pendingConfirm = page.getByRole("button", { name: "Disabling…" });
    await expect(pendingConfirm).toBeDisabled();
    for (let i = 0; i < 5; i++) {
      await pendingConfirm.dispatchEvent("click");
    }
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");

    expect(
      access.calls(),
      "A second disable re-revokes invitations and writes a second ACCESS_DISABLED audit " +
        "entry, so `disabled` must genuinely prevent it."
    ).toBe(1);
    expect(
      calls.countOf("admin.setUserAccess"),
      `Counted on the wire: exactly one admin.setUserAccess operation must have left the ` +
        `browser. Saw ${calls.countOf("admin.setUserAccess")} ` +
        `(all ops: ${JSON.stringify(calls.paths)}).`
    ).toBe(1);

    access.release(setUserAccessResult({ userId: USER_PARTICIPANT.id, enabled: false }));
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  /** The happy path for a disable, asserted by the outcome notice's text. */
  test("happy path: disabling reports a confirmed outcome and names the destroyed invitations", async ({
    page,
    context,
  }) => {
    const { directory } = await openAdminUsers(
      page,
      context,
      ADMIN_SELF,
      [selfUser(ADMIN_SELF), USER_PARTICIPANT],
      {
        "admin.setUserAccess": (input) => {
          const { userId, enabled } = input as { userId: string; enabled: boolean };
          expect(enabled, "Disabling must send enabled:false — the direction is not a default.").toBe(
            false
          );
          directory.current = directory.current.map((u) =>
            u.id === userId ? { ...u, status: "DEACTIVATED" } : u
          );
          return setUserAccessResult({ userId, enabled, invitationsRevoked: 2 });
        },
      }
    );

    const dialog = await openAccessDialog(page, disableName(USER_PARTICIPANT), "click");
    // The consequences are stated per direction, with the real email in them.
    await expect(dialog).toContainText(`Disable sign-in access for ${USER_PARTICIPANT.name}?`);
    await expect(dialog).toContainText(USER_PARTICIPANT.email);
    await expect(dialog).toContainText(
      `Every pending invitation for ${USER_PARTICIPANT.email} is destroyed`
    );
    await expect(dialog).toContainText("The destroyed invitations cannot");

    await page.getByRole("button", { name: "Disable access" }).click();

    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done." });
    await expect(notice).toContainText(`${USER_PARTICIPANT.name} can no longer sign in.`);
    // The count is REPORTED, not hidden: re-enabling does not bring these back.
    await expect(notice).toContainText("2 pending invitations destroyed");
  });

  /** Restoring is the NEUTRAL direction and says so — not dressed in a disable's red. */
  test("happy path: restoring access reports a confirmed outcome and warns invitations are not restored", async ({
    page,
    context,
  }) => {
    const { directory } = await openAdminUsers(
      page,
      context,
      ADMIN_SELF,
      [selfUser(ADMIN_SELF), USER_DISABLED],
      {
        "admin.setUserAccess": (input) => {
          const { userId, enabled } = input as { userId: string; enabled: boolean };
          expect(enabled, "Restoring must send enabled:true.").toBe(true);
          directory.current = directory.current.map((u) =>
            u.id === userId ? { ...u, status: "ACTIVE" } : u
          );
          return setUserAccessResult({ userId, enabled });
        },
      }
    );

    const dialog = await openAccessDialog(page, restoreName(USER_DISABLED), "click");
    await expect(dialog).toContainText(`Restore sign-in access for ${USER_DISABLED.name}?`);
    await expect(dialog).toContainText("Reversible");
    await expect(dialog).toContainText("they need a fresh invitation");

    await page.getByRole("button", { name: "Restore access" }).click();

    await expect(page.locator(POLITE_NOTICE).filter({ hasText: "Done." })).toContainText(
      `${USER_DISABLED.name} can sign in again.`
    );
    // The badge is gone and the control has flipped back.
    await expect(page.getByRole("button", { name: disableName(USER_DISABLED) })).toBeVisible();
  });

  /**
   * A SURVIVING INVITATION IS THE MOST SERIOUS THING THIS SCREEN CAN REPORT.
   *
   * An unredeemed invitation is a live credential: the person just locked out can still
   * register, minting a BRAND-NEW Cognito sub, so the disable — keyed on the old one — stops
   * applying. The lockout silently undoes itself. So `invitationsRevokeComplete: false` must
   * never render as a clean success, however many it managed to revoke.
   */
  test("an incomplete invitation revocation is a partial, never a clean success", async ({
    page,
    context,
  }) => {
    await openAdminUsers(page, context, ADMIN_SELF, [selfUser(ADMIN_SELF), USER_PARTICIPANT], {
      "admin.setUserAccess": (input) => {
        const { userId, enabled } = input as { userId: string; enabled: boolean };
        return setUserAccessResult({
          userId,
          enabled,
          invitationsRevoked: 3,
          invitationsRevokeComplete: false,
        });
      },
    });

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "click");
    await page.getByRole("button", { name: "Disable access" }).click();

    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done, with a gap." });
    await expect(notice).toContainText("3 pending invitations destroyed");
    await expect(notice).toContainText("at least one pending invitation could NOT be revoked");
    await expect(notice).toContainText("they can re-register under a new account");
    // And it is NOT reported as a clean success.
    await expect(page.locator(POLITE_NOTICE).filter({ hasText: "Done." })).toHaveCount(0);
  });

  /** Both gaps at once — a surviving invitation AND no audit entry — are both reported. */
  test("a surviving invitation and a missing audit entry are BOTH reported", async ({
    page,
    context,
  }) => {
    await openAdminUsers(page, context, ADMIN_SELF, [selfUser(ADMIN_SELF), USER_PARTICIPANT], {
      "admin.setUserAccess": (input) => {
        const { userId, enabled } = input as { userId: string; enabled: boolean };
        return setUserAccessResult({
          userId,
          enabled,
          invitationsRevoked: 1,
          invitationsRevokeComplete: false,
          audited: false,
        });
      },
    });

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "click");
    await page.getByRole("button", { name: "Disable access" }).click();

    const notice = page.locator(POLITE_NOTICE).filter({ hasText: "Done, with a gap." });
    // The surviving invitation is named FIRST, because it is the more serious of the two.
    await expect(notice).toContainText("at least one pending invitation could NOT be revoked");
    await expect(notice).toContainText("could not be written to the audit trail");
  });

  /** The service's own refusal is surfaced verbatim, because it names the rule that fired. */
  test("the last-admin refusal is surfaced verbatim as a failure", async ({ page, context }) => {
    await openAdminUsers(page, context, ADMIN_SELF, [selfUser(ADMIN_SELF), USER_ADMIN_TARGET], {
      "admin.setUserAccess": () => {
        throw new TrpcFault(
          "Cannot disable the last enabled admin — grant another admin first",
          "FORBIDDEN",
          403
        );
      },
    });

    await openAccessDialog(page, disableName(USER_ADMIN_TARGET), "click");
    await page.getByRole("button", { name: "Disable access" }).click();

    const notice = page.locator(ASSERTIVE_NOTICE);
    await expect(notice).toContainText("Not done.");
    await expect(notice).toContainText(
      "Cannot disable the last enabled admin — grant another admin first"
    );
    // The row is untouched: no badge, and the control still offers "Disable".
    await expect(page.getByRole("button", { name: disableName(USER_ADMIN_TARGET) })).toBeVisible();
  });

  /**
   * ── THE LATERAL-ATTACK GATING CASE ──
   * A FACILITATOR is offered NO control on an ADMIN row or on a peer FACILITATOR row, and IS
   * offered one on a PARTICIPANT row.
   *
   * Asserted through the accessibility tree rather than by looking for a visually hidden
   * button, because a control present in the tree is reachable by a screen reader and by
   * keyboard regardless of how it looks. And the ABSENCE is asserted to be EXPLAINED, so it
   * reads to the operator as a rule rather than as a broken screen — which is the confusion
   * that produced this work in the first place.
   */
  test("a FACILITATOR is offered no access control on an ADMIN or peer FACILITATOR row, but is on a PARTICIPANT", async ({
    page,
    context,
  }) => {
    await openAdminUsers(page, context, FACILITATOR_SELF, [
      selfUser(FACILITATOR_SELF),
      USER_ADMIN_TARGET,
      USER_FACILITATOR_PEER,
      USER_PARTICIPANT,
      USER_NO_ACCOUNT,
    ]);

    // NEVER on an ADMIN — the top of the tree is off limits to a facilitator.
    await expect(
      page.getByRole("button", { name: disableName(USER_ADMIN_TARGET) }),
      "USER_ADMIN_GRANTS gives FACILITATOR ['JUDGE','EXECUTIVE','PARTICIPANT'] — never ADMIN. " +
        "A facilitator reaching an admin account is a privilege escalation."
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: restoreName(USER_ADMIN_TARGET) })
    ).toHaveCount(0);

    // NEVER on a PEER facilitator — this is the lateral attack the matrix exists to close.
    await expect(
      page.getByRole("button", { name: disableName(USER_FACILITATOR_PEER) }),
      "A FACILITATOR may act only on STRICTLY LOWER roles. Acting on a peer would let one " +
        "facilitator disable another mid-workshop."
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: restoreName(USER_FACILITATOR_PEER) })
    ).toHaveCount(0);

    // Never on their OWN row.
    await expect(
      page.getByRole("button", { name: disableName(selfUser(FACILITATOR_SELF)) })
    ).toHaveCount(0);

    // Never on a row with no Cognito account behind it — there is nothing to disable.
    await expect(
      page.getByRole("button", { name: disableName(USER_NO_ACCOUNT) })
    ).toHaveCount(0);

    // BUT YES on a PARTICIPANT. The negative assertions above would all pass on a screen
    // that renders no buttons at all, so this is what proves they mean something.
    await expect(
      page.getByRole("button", { name: disableName(USER_PARTICIPANT) }),
      "A FACILITATOR may administer a PARTICIPANT, so the control must be offered — a " +
        "missing control is exactly the failure this guards against."
    ).toBeVisible();

    // Each inactionable row EXPLAINS itself, so its lack of a control reads as a rule.
    await expect(page.getByText(`Your role cannot manage a Admin`)).toBeVisible();
    /* ⚠ THE COPY LOST ITS EM-DASH, not its meaning. Em-dashes were removed from every visible
       string in the product on request; this assertion pinned the punctuation. */
    await expect(page.getByText("No sign-in account, profile record only")).toBeVisible();
    await expect(
      page.getByText("This is you, so you cannot change your own access")
    ).toBeVisible();
  });

  /**
   * A DISABLED ROW'S VISUAL STATE IS UNMISTAKABLE.
   *
   * The state is carried FOUR ways because an operator scanning a directory for who is locked
   * out must find them without reading every row: a "No access" badge in words, a
   * strikethrough on the name, a red left edge and a tinted surface. The badge and the
   * strikethrough are the two that survive greyscale and a colour-vision deficiency, so those
   * are asserted as text/DOM rather than by screenshot.
   *
   * And the badge is asserted ABSENT on an active row — a matching "Active" badge on every
   * row would be noise that makes the one row that matters harder to find.
   */
  test("a disabled row is unmistakable: 'No access' badge, struck-through name, and no badge on active rows", async ({
    page,
    context,
  }) => {
    await openAdminUsers(page, context, ADMIN_SELF, [
      selfUser(ADMIN_SELF),
      USER_PARTICIPANT,
      USER_DISABLED,
    ]);

    // Exactly ONE "No access" badge, on exactly the disabled row.
    const badges = page.getByText("No access", { exact: true });
    await expect(
      badges,
      "The badge is rendered only when access is withdrawn — there is deliberately no " +
        "matching 'Active' badge on every other row."
    ).toHaveCount(1);

    // The badge belongs to the disabled user's row, and the ACTIVE user's row has none.
    const rowState = await page.evaluate(
      ({ disabledName, activeName }) => {
        function rowFor(name: string) {
          const nameEl = Array.from(document.querySelectorAll("span")).find(
            (s) => s.textContent?.trim() === name
          );
          /* ⚠ WALKS UP TO THE `<li>`, NOT TO A CLASS NAME. This looked for an ancestor whose
             className contained "border-l-", which stopped finding anything twice over: the
             palette migration renamed `border-l-red-500`, and then the marker stopped being a
             border at all. Both times the helper returned `document.body` and every assertion
             below reported the OPPOSITE of the truth rather than failing to locate the row.

             The row is a list item. That is structural, it is what the redesign made it, and it
             cannot drift with a class rename. */
          let el: HTMLElement | null = nameEl as HTMLElement | null;
          while (el && el.tagName !== "LI") el = el.parentElement;
          return { nameEl: nameEl as HTMLElement | null, row: el };
        }
        const disabled = rowFor(disabledName);
        const active = rowFor(activeName);
        return {
          disabledHasBadge: !!disabled.row?.textContent?.includes("No access"),
          disabledStruck: !!disabled.nameEl?.className.includes("line-through"),
          /* ⚠ THE EDGE IS AN INSET SHADOW NOW, NOT A BORDER, and the reason is worth carrying:
             `divide-hairline` sets `border-color` on all four sides at specificity (0,3,0), which
             beat the row's own `border-l-transparent` (0,1,0) — so every row below the first grew
             a 4px hairline left edge. A shadow cannot be overridden by a border-colour rule and
             costs no layout, which delivers the "no sideways shift" guarantee below more
             completely than the transparent border did. */
          disabledRedEdge: getComputedStyle(disabled.row!).boxShadow.includes("inset"),
          activeHasBadge: !!active.row?.textContent?.includes("No access"),
          activeStruck: !!active.nameEl?.className.includes("line-through"),
          /* The same guarantee, asserted directly instead of through the mechanism that used to
             provide it: an active row carries NO marker, and — because the marker is a shadow —
             the two rows' content still starts at the same x. */
          activeTransparentEdge: !getComputedStyle(active.row!).boxShadow.includes("inset"),
          disabledContentX: Math.round(
            (disabled.row!.children[0] as HTMLElement).getBoundingClientRect().left
          ),
          activeContentX: Math.round(
            (active.row!.children[0] as HTMLElement).getBoundingClientRect().left
          ),
        };
      },
      { disabledName: USER_DISABLED.name, activeName: USER_PARTICIPANT.name }
    );

    expect(rowState.disabledHasBadge, "The disabled row must carry the 'No access' badge.").toBe(
      true
    );
    expect(
      rowState.disabledStruck,
      "The disabled account's NAME must be struck through, so the state is legible in " +
        "greyscale, in a screenshot and to a colour-blind operator."
    ).toBe(true);
    expect(rowState.disabledRedEdge, "The disabled row carries a red left edge.").toBe(true);
    expect(rowState.activeHasBadge, "An active row must carry no access badge.").toBe(false);
    expect(rowState.activeStruck, "An active account's name must not be struck through.").toBe(
      false
    );
    expect(
      rowState.activeTransparentEdge,
      "An active row carries a TRANSPARENT left edge of the same width, so changing state " +
        "does not shift the row's contents sideways."
    ).toBe(true);

    // And the control on the disabled row offers the RECOVERY direction.
    await expect(page.getByRole("button", { name: restoreName(USER_DISABLED) })).toBeVisible();
  });

  /** Escape and a backdrop click dismiss without acting. */
  test("Escape and a backdrop click dismiss without issuing a request", async ({
    page,
    context,
  }) => {
    const { calls } = await openAdminUsers(
      page,
      context,
      ADMIN_SELF,
      [selfUser(ADMIN_SELF), USER_PARTICIPANT],
      {
        "admin.setUserAccess": () => {
          throw new Error("e2e: setUserAccess must NOT be called by a dismissal");
        },
      }
    );

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "keyboard");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectFocusOn(
      page,
      disableName(USER_PARTICIPANT),
      "A dismissal changes nothing, so focus returns to the trigger it was opened from."
    );

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "click");
    await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(
      calls.countOf("admin.setUserAccess"),
      "Neither Escape nor a backdrop click may issue a mutation."
    ).toBe(0);
  });

  /**
   * A row that LEAVES the list while the dialog is open falls back to the search box.
   *
   * This is the case `fallbackFocus` covers on this screen, and it is not hypothetical: a
   * search or a filter applied while the dialog is open re-queries the directory, and the row
   * the dialog was opened from may not come back.
   *
   * ⚠ CURRENTLY FAILING — DEFECT-2, see tests/e2e/README.md. Focus is stranded on <body>.
   *
   * NOT this screen's `fallbackFocus`, which is correct and was verified working: the
   * `#user-search` box is present, enabled and focusable both before and after the action.
   * The fallback is simply never CALLED.
   *
   * MECHANISM, from a recorded focus-event trace rather than inference. The final focus event
   * of the whole interaction is `focusin` on the trigger itself — so cleanup took the OPENER
   * branch at ConfirmActionDialog.tsx:248 and returned. At that instant the trigger was
   * genuinely mounted and genuinely enabled, so the guard's test was correct; the row then
   * unmounted on the refetch a few ticks later and took focus to <body> with it.
   *
   * This is the SAME class as DEFECT-1 but NOT the same trigger condition, and the distinction
   * matters for the fix: DEFECT-1 is an opener that cannot take focus NOW (disabled), which a
   * `disabled` check in the guard resolves. DEFECT-2 is an opener that takes focus
   * successfully and LOSES it moments later — the very case `returnToFallback` exists for,
   * except that this screen deliberately does not pass one, on the reasoning that its row
   * survives a disable. That reasoning holds for the ordinary case and fails here, because the
   * row can also leave the list entirely.
   *
   * Verified: adding a `disabled` check alone fixes DEFECT-1 and does NOT fix this. Left
   * FAILING rather than skipped or weakened — it is the regression test for the real fix.
   */
  test("when the row leaves the list mid-action, focus falls back to the search box", async ({
    page,
    context,
  }) => {
    const { directory } = await openAdminUsers(
      page,
      context,
      ADMIN_SELF,
      [selfUser(ADMIN_SELF), USER_PARTICIPANT],
      {
        "admin.setUserAccess": (input) => {
          const { userId, enabled } = input as { userId: string; enabled: boolean };
          // The row vanishes from the next refetch entirely — as it would if a filter had
          // been applied, or the directory re-paged.
          directory.current = [selfUser(ADMIN_SELF)];
          return setUserAccessResult({ userId, enabled });
        },
      }
    );

    await openAccessDialog(page, disableName(USER_PARTICIPANT), "keyboard");
    await page.getByRole("button", { name: "Disable access" }).click();

    await expect(page.getByRole("button", { name: disableName(USER_PARTICIPANT) })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const active = await expectFocusNotLost(
      page,
      "The row this dialog was opened from is no longer in the list, so its trigger is " +
        "unmounted and `.focus()` on it would be a silent no-op. fallbackFocus must catch " +
        "this and send focus to the search box."
    );
    expect(
      active.id,
      `Expected the user-search box (the documented fallback), but focus is on ${active.describe}.`
    ).toBe("user-search");
  });
});
