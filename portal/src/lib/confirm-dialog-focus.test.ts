import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WHERE KEYBOARD FOCUS GOES around ConfirmActionDialog, the focus trap, the pending-state
 * rescue, and the two return paths on close.
 *
 * ⚠ READ THIS BEFORE TRUSTING ANY RESULT IN THIS FILE.
 *
 * Focus is a DOM concept and this suite has no DOM. `vitest.config.mts` sets
 * `environment: "node"` and `include: ["src/**\/*.test.ts"]`, and there is no jsdom, no
 * happy-dom and no @testing-library anywhere in the dependency tree (checked in
 * package.json, the root package.json and the installed tree). Adding one is
 * out of scope for this verification.
 *
 * So the following are NOT verified here and CANNOT be, and each is listed in the report as
 * needing a browser:
 *   · that a browser moves focus to <body> when the focused element is disabled;
 *   · that React's unmount cleanup runs after the parent's state update has committed,
 *     which is the whole premise of the `returnToFallback` ref;
 *   · that `.focus()` on a detached or doomed node is a no-op;
 *   · that Escape reaches the panel's handler from wherever focus actually is.
 *
 * WHAT IS VERIFIED HERE is the part that is decidable without a DOM, and it is not nothing:
 * the trap's WRAP ARITHMETIC over a focusable set, including the set CHANGING mid-flight
 * when Confirm disables itself, which is the specific staleness question, plus the
 * ordering and shape of the code that the DOM behaviour depends on. The arithmetic is
 * mirrored from the component's own `onKeyDown`; the shape is pinned against the source so
 * the mirror cannot quietly stop describing it.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const DIALOG = "../components/ConfirmActionDialog.tsx";
const TEAM_PAGE = "../app/w/[workshopId]/t/[teamId]/team/page.tsx";
const ADMIN_PAGE = "../app/admin/page.tsx";

// ─── The focus trap's arithmetic ────────────────────────────────────────────────

/**
 * The focusable elements inside the panel, in DOCUMENT order, which is what
 * `querySelectorAll` returns, regardless of the order the selectors are written in.
 *
 * Derived from the component's JSX: the textarea comes first, then the footer's dismiss
 * button, then the confirm button. The selector is
 * `button:not([disabled]), textarea:not([disabled]), [href]`, so a DISABLED element is
 * absent from the set rather than present-and-skipped, which is why `pending` changes the
 * set's length and its `last` member.
 *
 * `hasReasonField` is the SECOND thing that changes the set. The reason field is rendered only
 * when the caller passes `reasonHint`, because an action whose mutation records no reason must
 * not offer a textarea whose contents are silently discarded, the ratings publish route is
 * exactly that case. So the dialog now has a configuration with only two focusable controls,
 * and one with only ONE while pending.
 */
function focusableSet(pending: boolean, hasReasonField = true): string[] {
  return [
    ...(hasReasonField ? ["textarea"] : []),
    "dismiss",
    ...(pending ? [] : ["confirm"]),
  ];
}

/** Mirrors the Tab branch of ConfirmActionDialog's `onKeyDown`. */
function tabTarget(
  active: string,
  shiftKey: boolean,
  pending: boolean,
  hasReasonField = true
): { prevented: boolean; focus: string | null } {
  const focusable = focusableSet(pending, hasReasonField);
  if (focusable.length === 0) return { prevented: true, focus: null };

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  // "root" is the panel itself, which holds focus on open (tabIndex={-1}).
  if (shiftKey && (active === first || active === "root")) {
    return { prevented: true, focus: last };
  }
  if (!shiftKey && active === last) {
    return { prevented: true, focus: first };
  }
  // Not a wrap point: the browser's own sequential navigation applies.
  return { prevented: false, focus: null };
}

describe("the focus trap wraps in both directions", () => {
  it("wraps Shift+Tab from the FIRST element to the last", () => {
    // Without this a keyboard operator reverses out of the top of a dialog that is still on
    // screen and lands on the page behind the backdrop, which aria-modal does not prevent -
    // it tells a screen reader the rest is inert, it does not stop Tab.
    expect(tabTarget("textarea", true, false)).toEqual({
      prevented: true,
      focus: "confirm",
    });
  });

  it("wraps Tab from the LAST element to the first", () => {
    expect(tabTarget("confirm", false, false)).toEqual({
      prevented: true,
      focus: "textarea",
    });
  });

  it("treats Shift+Tab from the PANEL ITSELF as wrapping from the start", () => {
    // Focus lands on the panel on open (deliberately, focusing Confirm would arm the
    // destructive action on the next Enter). Shift+Tab from there must land on the last
    // control rather than escaping the dialog immediately after it opened.
    expect(tabTarget("root", true, false)).toEqual({
      prevented: true,
      focus: "confirm",
    });
  });

  it("leaves interior moves to the browser", () => {
    // The trap must intervene only at the two boundaries. Calling preventDefault on every
    // Tab and hand-rolling the whole sequence is how a dialog stops honouring the platform's
    // own focus order.
    expect(tabTarget("textarea", false, false).prevented).toBe(false);
    expect(tabTarget("dismiss", false, false).prevented).toBe(false);
    expect(tabTarget("dismiss", true, false).prevented).toBe(false);
    expect(tabTarget("confirm", true, false).prevented).toBe(false);
  });
});

describe("the focusable set CHANGES when Confirm disables itself", () => {
  it("drops the confirm button from the set while pending", () => {
    // `:not([disabled])` in the selector, the disabled confirm button is not in the set at
    // all. This is the mid-flight change the trap has to cope with.
    expect(focusableSet(false)).toEqual(["textarea", "dismiss", "confirm"]);
    expect(focusableSet(true)).toEqual(["textarea", "dismiss"]);
  });

  it("moves the wrap boundary to the DISMISS button while pending", () => {
    // The consequence that matters: `last` is no longer the confirm button, so Tab from the
    // dismiss button must wrap to the textarea. A trap holding a cached element list would
    // still think `last` is the confirm button, and since a disabled element cannot take
    // focus, `last.focus()` would be a silent no-op and focus would stay put or escape.
    expect(tabTarget("dismiss", true, true)).toEqual({
      prevented: false,
      focus: null,
    });
    expect(tabTarget("dismiss", false, true)).toEqual({
      prevented: true,
      focus: "textarea",
    });
  });

  it("still wraps Shift+Tab from the textarea, now to the dismiss button", () => {
    expect(tabTarget("textarea", true, true)).toEqual({
      prevented: true,
      focus: "dismiss",
    });
  });

  it("never routes focus to the confirm button while it is disabled", () => {
    // The invariant behind the two cases above, checked over every combination rather than
    // by example: while pending, no Tab or Shift+Tab from anywhere may target the disabled
    // control. `.focus()` on it is a no-op, so any such target strands the operator.
    for (const active of ["root", "textarea", "dismiss", "confirm"]) {
      for (const shiftKey of [true, false]) {
        const { focus } = tabTarget(active, shiftKey, true);
        expect(focus, `${active} shift=${shiftKey}`).not.toBe("confirm");
      }
    }
  });

  it("recomputes the set on every keypress rather than caching it", () => {
    // THE STALENESS QUESTION, answered against the source rather than by the mirror: the
    // querySelectorAll lives INSIDE onKeyDown, so the set is rebuilt per keystroke and the
    // pending transition cannot leave it stale. If this were hoisted into a ref or a
    // useMemo keyed on anything other than `pending`, the arithmetic above would be
    // correct and the component would still be broken.
    const source = readCode(DIALOG);
    const handler = source.slice(
      source.indexOf("function onKeyDown("),
      source.indexOf("const remaining =")
    );
    expect(handler).toContain("root.querySelectorAll<HTMLElement>(FOCUSABLE)");
    expect(source).not.toContain("useMemo");
    // And the selector must keep excluding disabled elements, or the set would include a
    // control that cannot hold focus.
    expect(source).toContain("button:not([disabled])");
    expect(source).toContain("textarea:not([disabled])");
  });

  it("handles an EMPTY focusable set by swallowing the Tab", () => {
    // Not reachable through the current JSX (the dismiss button is always enabled), but the
    // guard is the difference between a contained dialog and one that lets Tab walk into the
    // page behind it if the markup ever changes.
    const source = readCode(DIALOG);
    expect(source).toContain("if (focusable.length === 0)");
  });
});

describe("the dialog with NO reason field, the ratings publish configuration", () => {
  // `reasonHint` is optional, and omitting it removes the textarea entirely. That is not a
  // convenience: the publish route accepts only a generationId, so a reason box there would
  // collect an explanation the system discards while the operator believes it was recorded.
  //
  // The consequence for FOCUS is that the trap's wrap boundaries move again, and while pending
  // the dialog is down to a SINGLE focusable control.

  it("renders the field only when the caller passes a hint", () => {
    const source = readCode(DIALOG);
    expect(source).toContain("reasonHint?: string;");
    expect(source).toContain("{reasonHint !== undefined && (");
    // The textarea is inside that conditional, not outside it.
    const guarded = source.slice(source.indexOf("{reasonHint !== undefined && ("));
    expect(guarded.slice(0, guarded.indexOf("</div>"))).toContain("<textarea");
  });

  it("wraps between the two buttons when there is no textarea", () => {
    expect(focusableSet(false, false)).toEqual(["dismiss", "confirm"]);
    expect(tabTarget("confirm", false, false, false)).toEqual({
      prevented: true,
      focus: "dismiss",
    });
    expect(tabTarget("dismiss", true, false, false)).toEqual({
      prevented: true,
      focus: "confirm",
    });
  });

  it("keeps focus on the ONE remaining control when pending with no textarea", () => {
    // The narrowest configuration this component can reach: confirm is disabled and there is no
    // reason field, so the dismiss button is simultaneously `first` and `last`. Tab in either
    // direction must be swallowed and land back on it, anything else walks a keyboard operator
    // out of a modal that is still on screen, mid-disclosure.
    expect(focusableSet(true, false)).toEqual(["dismiss"]);
    expect(tabTarget("dismiss", false, true, false)).toEqual({
      prevented: true,
      focus: "dismiss",
    });
    expect(tabTarget("dismiss", true, true, false)).toEqual({
      prevented: true,
      focus: "dismiss",
    });
    // And from the panel itself, which holds focus on open.
    expect(tabTarget("root", true, true, false)).toEqual({
      prevented: true,
      focus: "dismiss",
    });
  });

  it("never targets the disabled confirm button in this configuration either", () => {
    for (const active of ["root", "dismiss", "confirm"]) {
      for (const shiftKey of [true, false]) {
        const { focus } = tabTarget(active, shiftKey, true, false);
        expect(focus, `${active} shift=${shiftKey}`).not.toBe("confirm");
      }
    }
  });

  it("keeps the reason CAP tied to the shared constant when the field IS rendered", () => {
    // Making the field conditional must not have loosened the cap for the callers that do use
    // it, two numbers for one rule is how a form starts accepting text the audit row truncates.
    const source = readCode(DIALOG);
    expect(source).toContain("maxLength={AUDIT_REASON_MAX}");
    expect(source).not.toMatch(/maxLength=\{\d+\}/);
  });
});

// ─── The pending-state rescue (area 1b) ─────────────────────────────────────────

describe("focus is rescued when the confirm button disables itself", () => {
  // ⚠ The BEHAVIOUR here is not executable without a DOM, see the file header. What is
  // asserted is that the code which produces it is present, correctly ordered, and aimed at
  // the one control that stays live while pending.

  it("runs an effect keyed on `pending` alone", () => {
    // Keyed on `pending` and nothing else: an effect that re-ran on every render would
    // re-steal focus from the textarea the operator is typing a reason into.
    const source = readCode(DIALOG);
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(!pending\) return;/);
    expect(source).toContain("}, [pending]);");
  });

  it("moves focus to the DISMISS button, which is the control that stays live", () => {
    // Not the panel and not the textarea. The dismiss button is deliberately the one
    // control that remains enabled while a request is in flight (backendFetch passes no
    // AbortSignal, so locking the dialog could trap an operator in a modal indefinitely),
    // so it is the correct landing place: the escape hatch is where focus lands.
    const source = readCode(DIALOG);
    const effect = source.slice(
      source.indexOf("if (!pending) return;"),
      source.indexOf("}, [pending]);")
    );
    expect(effect).toContain("dismissRef.current?.focus()");
  });

  it("only acts when focus has actually LEFT the dialog", () => {
    // The guard that keeps this from being its own bug: an operator who clicked with a
    // pointer and then tabbed into the textarea must not have focus yanked to the dismiss
    // button when the response is slow.
    const source = readCode(DIALOG);
    const effect = source.slice(
      source.indexOf("if (!pending) return;"),
      source.indexOf("}, [pending]);")
    );
    expect(effect).toContain("if (root.contains(document.activeElement)) return;");
  });

  it("keeps the dismiss path live while pending, so Escape has something to do", () => {
    // Escape, Cancel and a backdrop click are ONE path, `onDismiss(pending)`, and none of
    // them is gated on `!pending`. If dismissal were disabled during the request, the
    // rescue above would be moving focus onto a dead control.
    const source = readCode(DIALOG);
    expect(source).toContain('if (event.key === "Escape")');
    expect(source).toContain("onDismiss(pending);");
    // The dismiss button carries no `disabled` attribute at all.
    const footer = source.slice(source.indexOf("ref={dismissRef}"), source.length);
    const dismissButton = footer.slice(0, footer.indexOf("</button>"));
    expect(dismissButton).not.toContain("disabled");
    // Only the confirm button is disabled.
    expect(source).toContain("disabled={pending}");
  });

  it("stops Escape from also reaching a listener on the page behind", () => {
    // Closing this dialog and a panel underneath it on one keypress would leave the
    // operator somewhere they did not navigate to.
    const source = readCode(DIALOG);
    expect(source).toContain("event.stopPropagation();");
  });

  it("tells the caller the dismissal happened MID-FLIGHT, so it can record UNKNOWN", () => {
    // The honest half: the request was sent, no answer was seen, and the effect may still
    // land. Both callers turn this into an "unknown" outcome that says reload rather than
    // retry.
    const source = readCode(DIALOG);
    expect(source).toContain("onDismiss: (wasPending: boolean) => void;");
    expect(readCode(TEAM_PAGE)).toContain("if (wasPending) {");
    expect(readCode(ADMIN_PAGE)).toContain("if (wasPending) {");
  });
});

// ─── The doomed-trigger return path (area 1a) ───────────────────────────────────

describe("the close-time focus return", () => {
  it("consults returnToFallback BEFORE deciding to focus the opener", () => {
    // Ordering is the whole fix. `isConnected` alone catches a trigger already unmounted;
    // it does NOT catch the team page's case, where the Remove button is still in the
    // document at close time and is unmounted a few ticks later by the invalidated query's
    // refetch. Focusing it then is a no-op that lands on <body> once the row goes.
    const source = readCode(DIALOG);
    const cleanup = source.slice(
      source.indexOf("return () => {"),
      source.indexOf("}, []);")
    );
    expect(cleanup).toContain("const doomed = returnToFallbackRef.current?.() ?? false;");
    expect(cleanup).toContain("if (!doomed && opener instanceof HTMLElement && opener.isConnected)");
    // Both conditions, not one.
    expect(cleanup).toContain("fallbackRef.current?.()?.focus();");
    // And `doomed` must be read before the branch that uses it.
    expect(cleanup.indexOf("const doomed")).toBeLessThan(cleanup.indexOf("if (!doomed"));
  });

  it("reads the callback and the fallback through REFS refreshed every render", () => {
    // A closure captured by an effect with `[]` deps would freeze the FIRST render's props,
    // so the cleanup would consult a stale callback. Refs assigned during render are read
    // at cleanup time, which is what makes the timing work.
    const source = readCode(DIALOG);
    expect(source).toContain("returnToFallbackRef.current = returnToFallback;");
    expect(source).toContain("fallbackRef.current = fallbackFocus;");
  });

  it("is a CALLBACK in the prop contract, not a boolean", () => {
    // ⚠ The REASON this must be a callback is a React batching claim, the caller's mutation
    // callback learns the outcome and closes the dialog in the same batch, so no re-render
    // carries a new prop value down before the unmount cleanup runs. That claim requires
    // React to verify and is NOT verified here; it is listed as a gap.
    //
    // What IS verified: the contract is a function, so the value is read at cleanup time
    // rather than captured at render time.
    const source = readCode(DIALOG);
    expect(source).toContain("returnToFallback?: () => boolean;");
    expect(source).not.toMatch(/returnToFallback\?: boolean/);
  });

  it("is backed by a REF on the team page, and that ref is set BEFORE the dialog closes", () => {
    // The ordering the callback depends on, and the one part of the batching story that is
    // decidable from the source: within onSuccess, `removalSucceededRef.current = true`
    // must precede `setPendingRemoval(null)`. Reversed, the ref would still be false when
    // the cleanup read it and focus would go to a doomed Remove button.
    const source = readCode(TEAM_PAGE);
    expect(source).toContain("const removalSucceededRef = useRef(false);");
    expect(source).toContain("returnToFallback={() => removalSucceededRef.current}");

    const onSuccess = source.slice(
      source.indexOf("onSuccess: (result, variables) => {"),
      source.indexOf("onError: (err, variables) => {")
    );
    // Both are now guarded on `isCurrent`, only the answering request may claim the focus
    // contract or close the dialog, but the ORDER between them is unchanged and still
    // load-bearing for the same reason.
    expect(onSuccess).toContain("if (isCurrent) removalSucceededRef.current = true;");
    expect(onSuccess.indexOf("removalSucceededRef.current = true;")).toBeLessThan(
      onSuccess.indexOf("setPendingRemoval(null);")
    );
    // NOT state, state would not have propagated to the child before its cleanup runs.
    expect(source).not.toContain("useState(false); // removalSucceeded");
  });

  it("resets the ref when the NEXT dialog opens, not when one closes", () => {
    // Reset on open is the only moment that is unambiguously before the next request. Reset
    // on close would race the cleanup that reads it, the very read it exists to serve.
    const source = readCode(TEAM_PAGE);
    const onClick = source.slice(
      source.indexOf("onClick={() => {"),
      source.indexOf("setPendingRemoval({ userId: member.userId")
    );
    expect(onClick).toContain("removalSucceededRef.current = false;");
  });

  it("points the team page's fallback at a control that SURVIVES the removal", () => {
    // The Members heading button: outside the panel, so it exists whether the roster is
    // collapsed or not, and Tab from it walks back into the remaining rows. Verified to
    // exist, Disclosure renders `id={`${id}-heading`}` around a real <button>, and the
    // members Disclosure is `id="members"`.
    const source = readCode(TEAM_PAGE);
    expect(source).toContain('getElementById("members-heading")');
    expect(source).toContain('querySelector<HTMLButtonElement>("button")');
    expect(source).toContain('id="members"');

    const disclosure = readCode("../components/Disclosure.tsx");
    expect(disclosure).toContain("id={`${id}-heading`}");
    expect(disclosure).toContain('<button');
    // The heading sits OUTSIDE the collapsible panel, so a collapsed roster still has it.
    expect(disclosure.indexOf("id={`${id}-heading`}")).toBeLessThan(
      disclosure.indexOf("{open && (")
    );
  });

  it("does NOT pass returnToFallback on the Administration screen, where the row survives", () => {
    // Correct asymmetry, and worth pinning because "add it in both places" is the reflex. A
    // disable flips the row's badge and swaps its button's label, the trigger is the same
    // element, still mounted, so returning focus to it is right and lets the operator undo
    // immediately. The fallback covers only a row that has left the list entirely.
    const source = readCode(ADMIN_PAGE);
    expect(source).not.toContain("returnToFallback");
    expect(source).toContain('document.getElementById("user-search")');
  });

  it("points the admin fallback at an element that actually exists", () => {
    // A getElementById against a typo'd id returns null and the fallback silently does
    // nothing, the exact stranding it was added to prevent, with no error to notice.
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain('id="user-search"');
  });
});

// ─── What the dialog must not do ────────────────────────────────────────────────

describe("the dialog's structural safety properties", () => {
  it("is not a <form>, so Enter cannot reach the destructive button from the textarea", () => {
    // In a form, Enter outside a textarea activates the default submit button, which here
    // would be the destructive one. A destructive action must not be reachable by Enter
    // from a routine input.
    const source = readCode(DIALOG);
    expect(source).not.toContain("<form");
  });

  it("focuses the PANEL on open, not either button", () => {
    // Focusing Confirm would arm the destructive action on the very next Enter; focusing
    // Cancel reads out the wrong half of the choice first.
    const source = readCode(DIALOG);
    expect(source).toContain("panelRef.current?.focus();");
    const mount = source.slice(
      source.indexOf("openerRef.current = document.activeElement;"),
      source.indexOf("return () => {")
    );
    expect(mount).not.toContain("dismissRef.current?.focus()");
  });

  it("dismisses on a backdrop click only when the backdrop ITSELF was hit", () => {
    // A click inside the panel must not bubble out and close the dialog mid-sentence.
    // Backdrop-dismisses-rather-than-acts is the fail-safe direction for a confirmation.
    const source = readCode(DIALOG);
    expect(source).toContain("if (event.target === event.currentTarget) onDismiss(pending);");
  });

  it("announces the target, the consequences AND the reversibility", () => {
    // Focus lands on the panel, so this is the one announcement a screen-reader operator
    // gets before deciding. Omitting the reversibility line would leave the most
    // decision-relevant sentence to be discovered by arrowing around afterwards.
    const source = readCode(DIALOG);
    expect(source).toContain(
      "aria-describedby={`${targetId} ${consequencesId} ${reversibilityId}`}"
    );
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('role="dialog"');
    expect(source).toContain("aria-labelledby={headingId}");
  });

  it("caps the reason at the SHARED constant the services truncate at", () => {
    // Two numbers for one rule is how a form starts accepting text the audit row silently
    // truncates. Capped at the input, not only validated on submit.
    const source = readCode(DIALOG);
    expect(source).toContain("maxLength={AUDIT_REASON_MAX}");
    expect(source).toContain('from "@praimana/shared"');
    expect(source).not.toMatch(/maxLength=\{\d+\}/);
  });

  it("counts the reason by CODE POINTS, so an emoji costs one character", () => {
    // `[...reason].length`, not `reason.length`. An operator typing an emoji or a combining
    // accent would otherwise watch the counter drop by two and hit the cap early.
    const source = readCode(DIALOG);
    expect(source).toContain("AUDIT_REASON_MAX - [...reason].length");
  });
});

describe("the reason counter's arithmetic", () => {
  // Extractable and worth extracting: the counter is the only feedback on a field that is
  // hard-capped, and a wrong count on a surrogate pair is invisible until someone types one.
  const AUDIT_REASON_MAX = 200;
  const remaining = (reason: string) => AUDIT_REASON_MAX - [...reason].length;

  it("counts an empty reason as the full budget", () => {
    expect(remaining("")).toBe(200);
  });

  it("counts an ASCII string one per character", () => {
    expect(remaining("left the programme")).toBe(200 - 18);
  });

  it("counts an EMOJI as one, not two", () => {
    // A surrogate pair is length 2 by `.length` and 1 by code point. The maxLength attribute
    // counts UTF-16 units, so the two disagree, but the counter must not claim the operator
    // has spent two characters on one glyph.
    expect(remaining("🚀")).toBe(199);
    expect("🚀".length).toBe(2);
  });

  it("does not go negative on a string at the cap", () => {
    expect(remaining("x".repeat(200))).toBe(0);
  });

  it("counts whitespace, which the services then strip", () => {
    // Deliberate: the field shows what is in the box. The trim happens at submit
    // (`reason.trim() || undefined`), so a whitespace-only reason sends nothing at all.
    expect(remaining("   ")).toBe(197);
    expect("   ".trim() || undefined).toBeUndefined();
  });
});
