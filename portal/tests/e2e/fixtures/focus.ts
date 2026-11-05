/**
 * WHERE IS FOCUS, actually — read from `document.activeElement` in the live document.
 *
 * ── WHY NOT `expect(locator).toBeFocused()` ──
 * Playwright's assertion answers "is THIS element focused", which can only confirm a
 * hypothesis you already hold. The defect these specs hunt is the opposite shape: focus has
 * gone somewhere nobody intended, and the overwhelmingly common somewhere is `<body>`. To
 * assert "focus is NOT on body" and to REPORT what it landed on instead, the spec has to
 * read the active element and describe it. `toBeFocused()` on a guessed element would fail
 * with "expected focused" and leave the reader no wiser about where focus actually went.
 *
 * The description below is deliberately rich (tag, role, accessible-ish name, disabled
 * state) because a focus failure's whole diagnostic value is in the answer to "then where?".
 */

import { expect, type Page } from "@playwright/test";

export interface ActiveElement {
  tag: string;
  /** Lowercased tag, or "body" — the sentinel value that means focus was lost. */
  isBody: boolean;
  role: string | null;
  ariaLabel: string | null;
  text: string;
  id: string;
  disabled: boolean;
  /** True when the element is inside an element with role="dialog". */
  insideDialog: boolean;
  /** A one-line form for assertion messages. */
  describe: string;
}

/** Read the currently focused element. */
export async function activeElement(page: Page): Promise<ActiveElement> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) {
      return {
        tag: "none",
        isBody: true,
        role: null,
        ariaLabel: null,
        text: "",
        id: "",
        disabled: false,
        insideDialog: false,
        describe: "<no activeElement at all>",
      };
    }
    const tag = el.tagName.toLowerCase();
    const ariaLabel = el.getAttribute("aria-label");
    const role = el.getAttribute("role");
    // Trimmed and clipped: a focused panel's textContent is the entire dialog.
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const disabled =
      el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
    const insideDialog = !!el.closest('[role="dialog"]');
    const id = el.id ?? "";
    const describe =
      `<${tag}` +
      (id ? ` id="${id}"` : "") +
      (role ? ` role="${role}"` : "") +
      (ariaLabel ? ` aria-label="${ariaLabel}"` : "") +
      (disabled ? " disabled" : "") +
      `>${ariaLabel ? "" : ` "${text}"`}` +
      (insideDialog ? " [inside dialog]" : " [OUTSIDE dialog]");
    return { tag, isBody: tag === "body", role, ariaLabel, text, id, disabled, insideDialog, describe };
  });
}

/**
 * THE assertion this harness exists for: focus is not stranded on `<body>`.
 *
 * `<body>` is where the browser puts focus when the element holding it is removed or
 * disabled, and it is functionally a dead end — Tab restarts from the top of the document,
 * and any keydown handler attached to a panel (Escape, the focus trap) never fires. So this
 * is not a style preference: focus on body during a modal means the operator is locked out
 * of a dialog that is still on screen, mid-destructive-action.
 *
 * `why` is required so a failure states the CONTRACT that was broken, not just the fact.
 */
export async function expectFocusNotLost(page: Page, why: string): Promise<ActiveElement> {
  const active = await activeElement(page);
  expect(
    active.isBody,
    `Focus was lost to <body>. ${why}\n` +
      `A keyboard operator is now stranded: Tab restarts from the top of the document and ` +
      `any handler bound to the panel (Escape, the focus trap) cannot fire.`
  ).toBe(false);
  return active;
}

/** Assert focus is inside the modal, and report where it actually is when it is not. */
export async function expectFocusInsideDialog(page: Page, why: string): Promise<ActiveElement> {
  const active = await expectFocusNotLost(page, why);
  expect(
    active.insideDialog,
    `Focus escaped the modal. ${why}\nFocus is on ${active.describe}, which is OUTSIDE ` +
      `[role="dialog"] — i.e. on a control behind the backdrop that the operator cannot see.`
  ).toBe(true);
  return active;
}

/**
 * Assert focus is on the element with this accessible name, reporting the actual holder.
 *
 * Matches on `aria-label` first and visible text second, in that order, because every
 * control these specs care about carries a deliberate `aria-label` (the designer wrote
 * "Remove Priya Patel from this team" precisely so it could be addressed this way).
 */
export async function expectFocusOn(
  page: Page,
  expected: string | RegExp,
  why: string
): Promise<ActiveElement> {
  const active = await expectFocusNotLost(page, why);
  const candidates = [active.ariaLabel, active.text].filter(Boolean) as string[];
  const matched = candidates.some((c) =>
    typeof expected === "string" ? c === expected || c.includes(expected) : expected.test(c)
  );
  expect(
    matched,
    `Focus is not where the contract says it should be. ${why}\n` +
      `Expected an element matching ${expected}, but focus is on ${active.describe}.`
  ).toBe(true);
  return active;
}

/**
 * The focusable elements INSIDE the dialog, in document order, as the trap sees them.
 *
 * Uses the implementation's OWN selector (ConfirmActionDialog.tsx's FOCUSABLE constant),
 * copied verbatim, because the property under test is that `:not([disabled])` makes the
 * confirm button leave the tab order the moment it goes pending. A different selector here
 * would test a different set than the trap walks.
 */
export const DIALOG_FOCUSABLE = "button:not([disabled]), textarea:not([disabled]), [href]";

/**
 * The outcome notice, addressed WITHOUT colliding with Next's route announcer.
 *
 * `ActionOutcome` renders `role="alert"` for failed/unknown and `role="status"` for
 * confirmed/partial. But Next.js injects its own permanent, always-empty
 * `<div role="alert" aria-live="assertive" id="__next-route-announcer__">` into every page,
 * so a bare `getByRole("alert")` is a strict-mode violation that resolves to two elements —
 * observed, not theorised. Excluding the announcer by id is what makes the assertion
 * address the notice the operator actually reads.
 *
 * Deliberately still matched by ROLE rather than by class: the role IS part of the contract
 * (a failure must interrupt, a success must not), so asserting through it tests the
 * accessibility tree rather than merely reading text off the page.
 */
export const OUTCOME_NOTICE = '[role="alert"]:not(#__next-route-announcer__), [role="status"]';

/** The assertive half only — failed and unknown outcomes, which must interrupt. */
export const ASSERTIVE_NOTICE = '[role="alert"]:not(#__next-route-announcer__)';

/** The polite half only — confirmed and partial outcomes, which must not interrupt. */
export const POLITE_NOTICE = '[role="status"]';

export async function dialogFocusables(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const root = document.querySelector('[role="dialog"]');
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).map(
      (el) =>
        el.getAttribute("aria-label") ??
        (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40)
    );
  }, DIALOG_FOCUSABLE);
}
