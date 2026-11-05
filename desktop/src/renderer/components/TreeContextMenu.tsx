import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { clampMenuPosition } from "../lib/file-tree-ops";

/**
 * The file tree's context menu and its delete confirmation.
 *
 * ── WHY THIS IS HAND-BUILT ──
 *
 * No menu library, by instruction. That is not a hardship: the whole surface is one popup with a
 * roving focus index, and the parts a library would give us for free are the parts that have to be
 * right anyway (focus return, Escape, outside-click, staying on screen). Written out, they are
 * auditable.
 *
 * ── WHAT MAKES IT SAFE ──
 *
 *  * Focus goes INTO the popup on open and back to the exact row on close. A menu that leaves focus
 *    on `document.body` strands a keyboard user at the top of the tab order.
 *  * Escape closes without acting, at every depth, including from inside the delete confirmation.
 *  * The popup closes on scroll and resize. It is `position: fixed` against a scrolling sidebar, so
 *    if it stayed open it would sit next to a row that is no longer the row it acts on — a menu
 *    pointing at the wrong file is worse than no menu.
 *  * Disabled items stay FOCUSABLE and state their reason as text. A greyed item a keyboard user
 *    cannot reach, whose reason only appears on hover, is information they cannot get at all.
 *  * Position is computed from numbers passed in, never measured after paint, so the first painted
 *    frame is already in its final place — no read-after-write, no visible correction jump.
 */

/**
 * Height estimates used ONLY to decide whether the popup flips above the pointer.
 *
 * Derived from the classes below, and deliberately rounded UP: `py-1` + `text-xs` is 4+16+4 = 24px,
 * called 26 here. Over-estimating flips slightly early, which is harmless; under-estimating puts the
 * last item off-screen. The `max-h`/`overflow-y-auto` on the popup is the backstop for the case
 * where the estimate is wrong anyway (a filename that wraps).
 */
const ITEM_HEIGHT = 26;
/** `my-1 h-px` = 4 + 1 + 4. */
const SEPARATOR_HEIGHT = 9;
/** A disabled item's reason line: `mt-0.5` + `leading-3`, allowing for one wrap. */
const DISABLED_REASON_HEIGHT = 26;
/** The popup's own `py-1`. */
const MENU_PADDING = 8;
/**
 * FIXED width, not `min-w` + content sizing.
 *
 * The labels change as state changes ("Paste" becomes "Paste notes.md into src"), and a
 * content-sized menu would be a different width every time it opened — so the item a user reaches
 * for by muscle memory would be in a different place. A fixed width with truncation keeps every
 * item at the same x and the same width, always.
 */
const MENU_WIDTH = 232;

export interface MenuAction {
  id: string;
  label: string;
  /** Keyboard equivalent, shown right-aligned. Never the only way to discover the action. */
  hint?: string;
  /**
   * Set to disable. The string is rendered IN the item — a disabled control that does not say why
   * is a dead end, and `title` is invisible to keyboard and touch.
   */
  disabledReason?: string;
  /** Destructive: separated, differently coloured, and marked with a glyph as well as colour. */
  danger?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuAction | { separator: true; id: string };

function isSeparator(e: MenuEntry): e is { separator: true; id: string } {
  return (e as { separator?: true }).separator === true;
}

/**
 * Shared popup shell: fixed position, clamped on screen, focus-trapped, Escape-closable, and it
 * puts focus back where it came from on the way out.
 */
function Popover({
  x,
  y,
  estimatedHeight,
  label,
  describedById,
  restoreFocusTo,
  onClose,
  children,
  role = "menu",
}: {
  x: number;
  y: number;
  estimatedHeight: number;
  label: string;
  /** For the confirmation: the id of the sentence stating the consequence, so it is announced. */
  describedById?: string;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  role?: "menu" | "alertdialog";
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Viewport read ONCE, at open, before anything is written. Nothing below reads layout again.
  const [pos] = useState(() =>  // nosemgrep: react-props-in-state
    clampMenuPosition(
      x,
      y,
      MENU_WIDTH,
      estimatedHeight,
      window.innerWidth,
      window.innerHeight
    )
  );

  /**
   * Return focus on unmount — not in the close handler.
   *
   * Every close path (Escape, outside click, scroll, choosing an item, the parent unmounting the
   * tree) funnels through unmount, so this is the one place that cannot be forgotten. The guard
   * matters: if the row was removed by the very operation just performed (delete, or a rename that
   * re-keyed it) the node is detached and focusing it would silently drop focus to `body`, so the
   * tree container is the fallback.
   */
  useEffect(() => {
    return () => {
      const target = restoreFocusTo.current;
      if (target && target.isConnected) target.focus();
    };
  }, [restoreFocusTo]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    }
    // `true` = capture: close before the click reaches a tree row underneath, so an outside click
    // dismisses the menu rather than also toggling a folder.
    window.addEventListener("pointerdown", onPointerDown, true);
    // Capture on scroll as well — scroll events from the sidebar's own overflow container do not
    // bubble to window, and that container is exactly the one that moves rows out from under us.
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={boxRef}
      role={role}
      aria-label={label}
      aria-describedby={describedById}
      /**
       * `aria-modal` ONLY on the confirmation, and NOT on the menu.
       *
       * On a `role="menu"` it would be a lie — the menu does not trap the rest of the page, and
       * claiming otherwise makes a screen reader hide content the user can still reach. On the
       * confirmation it is true: focus is held between two buttons and Escape is the only way past.
       */
      aria-modal={role === "alertdialog" ? true : undefined}
      /**
       * `border-surface-edge`, not `-600`: the popup's edge is the only thing separating it from the
       * sidebar behind it, which makes it a non-text UI indicator needing 3:1. `-600` on `gray-900`
       * measures 2.35:1 and fails; `-500` is 4.22:1.
       *
       * `max-h-[80vh] overflow-y-auto` is the backstop for the height ESTIMATE being wrong. The
       * estimate drives the flip decision, but the confirmation's height depends on how many lines a
       * long filename wraps to — a 200-character name would otherwise push the confirm button off
       * the bottom of the screen, on the one panel that must stay reachable. Scrolling is the honest
       * fallback; truncating the name is not, because the name is how the user checks they are
       * deleting the right thing.
       */
      className="fixed z-50 max-h-[80vh] overflow-y-auto rounded-md border border-surface-edge bg-surface-panel py-1 shadow-xl"
      style={{ left: pos.left, top: pos.top, width: MENU_WIDTH }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        if (e.key !== "Tab") return;
        if (role === "menu") {
          // Menu pattern: Tab dismisses and lets focus continue past it, rather than leaving an
          // open menu behind the user. `onClose` restores focus to the row on unmount.
          e.preventDefault();
          onClose();
          return;
        }
        /**
         * The confirmation TRAPS Tab between its two buttons.
         *
         * Without this, Tab from "Move to Trash" would land somewhere in the app behind an open
         * confirmation — and the next Enter would activate whatever it found. The trap is why
         * `aria-modal` above is a true statement rather than a decoration.
         */
        const focusables = Array.from(
          boxRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  );
}

/** Roving-focus keyboard handling shared by the menu and the confirmation's two buttons. */
function useRovingFocus(count: number, initialIndex = 0) {
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * Focus the intended item on open, in the SAME commit that mounted it.
   *
   * A layout effect, not `useEffect`: with `useEffect` there is a painted frame where the popup is
   * visible but focus is still on the row behind it, and a keystroke in that window goes to the row
   * — which for a fast keyboard user means Shift+F10 then ArrowDown navigating the tree instead of
   * the menu. The refs are populated during this same commit, so the node exists.
   */
  useLayoutEffect(() => {
    itemRefs.current[initialIndex]?.focus();
  }, [initialIndex]);

  function focusAt(next: number) {
    const n = count;
    if (n === 0) return;
    // Wraps both directions, per the WAI-ARIA menu pattern: ArrowDown on the last item goes to the
    // first, ArrowUp on the first goes to the last.
    const wrapped = ((next % n) + n) % n;
    itemRefs.current[wrapped]?.focus();
  }

  function onKeyDown(e: ReactKeyboardEvent, ownIndex: number) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusAt(ownIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(ownIndex - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(count - 1);
        break;
      default:
        break;
    }
  }

  return { itemRefs, onKeyDown };
}

export function TreeContextMenu({
  x,
  y,
  label,
  entries,
  restoreFocusTo,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  entries: MenuEntry[];
  restoreFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const actions = entries.filter((e): e is MenuAction => !isSeparator(e));
  // A disabled item is taller: its reason occupies a second, wrapping line.
  const estimatedHeight =
    actions.reduce(
      (h, a) => h + (a.disabledReason ? ITEM_HEIGHT + DISABLED_REASON_HEIGHT : ITEM_HEIGHT),
      0
    ) +
    (entries.length - actions.length) * SEPARATOR_HEIGHT +
    MENU_PADDING;

  // Arrow keys walk ACTIONS only, in visual order; separators are skipped because they are not
  // stops. Disabled actions are still stops — see the header note.
  const { itemRefs, onKeyDown } = useRovingFocus(actions.length, 0);

  let actionIndex = -1;

  return (
    <Popover
      x={x}
      y={y}
      estimatedHeight={estimatedHeight}
      label={label}
      restoreFocusTo={restoreFocusTo}
      onClose={onClose}
    >
      {entries.map((entry) => {
        if (isSeparator(entry)) {
          return (
            <div key={entry.id} role="separator" className="my-1 h-px bg-surface-raised" />
          );
        }
        actionIndex += 1;
        const i = actionIndex;
        const disabled = Boolean(entry.disabledReason);
        return (
          <button
            key={entry.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-disabled={disabled || undefined}
            onKeyDown={(e) => onKeyDown(e, i)}
            onClick={() => {
              // Focusable-but-inert rather than `disabled`: the reason has to be reachable.
              if (disabled) return;
              onClose();
              entry.onSelect();
            }}
            className={[
              "block w-full px-3 py-1 text-left text-xs",
              "focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-blue-300",
              disabled
                ? "cursor-default"
                : entry.danger
                  ? "hover:bg-rose-900/50 focus:bg-rose-900/50"
                  : "hover:bg-surface-raised focus:bg-surface-raised",
            ].join(" ")}
          >
            <span className="flex items-baseline gap-2">
              {/* Destructive items carry a glyph as well as a colour — the red is not doing this
                  job on its own. */}
              {entry.danger && (
                <span aria-hidden="true" className="flex-shrink-0 text-[10px]">
                  ⚠
                </span>
              )}
              <span
                className={`flex-1 truncate ${
                  disabled ? "text-surface-muted" : entry.danger ? "text-rose-200" : "text-surface-text"
                }`}
              >
                {entry.label}
              </span>
              {/* gray-400, not -500: the hint carries information (which key does this) and -500 on
                  gray-800 measures 3.04:1, under AA. -400 is 5.79:1. */}
              {!disabled && entry.hint && (
                <span className="flex-shrink-0 font-mono text-[10px] text-surface-muted">
                  {entry.hint}
                </span>
              )}
            </span>
            {/*
              The reason goes on ITS OWN LINE and is allowed to wrap, not squeezed onto the label's
              line where it would truncate. "cannot paste a folder into itself" does not fit beside a
              label in 232px, and a half-shown reason is the same dead end as no reason at all. The
              taller item is accounted for in the height estimate above.
            */}
            {disabled && (
              <span className="mt-0.5 block text-[10px] leading-3 text-surface-muted">
                {entry.disabledReason}
              </span>
            )}
          </button>
        );
      })}
    </Popover>
  );
}

/**
 * DELETE CONFIRMATION — a popover, deliberately not a modal.
 *
 * ── THE REASONING ──
 *
 * The operation is `shell.trashItem`: the item goes to the OS Trash and Finder/Explorer already
 * provide the undo. Friction should scale to consequence, and the consequence here is "one drag out
 * of the Trash", not "gone". A blocking modal for that would train users to dismiss modals without
 * reading, which is precisely the habit that makes the *next*, genuinely irreversible dialog
 * dangerous. So: no modal.
 *
 * But it is not one click either, because the click that starts it is a menu item next to seven
 * routine ones and a slip is easy. Four things stand between a slip and a deleted file:
 *
 *  1. The menu is REPLACED by this panel — the mouse does not travel toward a "Delete" button that
 *     is already under the cursor. The confirming button sits well below where the "Delete" item
 *     was, so the second click cannot be the tail of a double-click on the first.
 *  2. Focus lands on CANCEL, not on the destructive button. Enter and Space — the two keys a user
 *     hits reflexively — cancel.
 *  3. The panel names the exact item and its kind, so "did I right-click the right row" is
 *     answered without going back.
 *  4. It says where the item goes, in words: recoverable from the Trash. A user who reads only one
 *     line reads the one that tells them the stakes.
 *
 * A folder gets a firmer sentence than a file, because "contents included" is the part people are
 * surprised by. We do not state a child count: `readDirectory` is not recursive, so any number we
 * printed would be a guess, and a wrong number is worse than no number.
 */
export function TrashConfirmPopover({
  x,
  y,
  name,
  kind,
  restoreFocusTo,
  onConfirm,
  onClose,
}: {
  x: number;
  y: number;
  name: string;
  kind: "file" | "dir";
  restoreFocusTo: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // Focus starts on Cancel (index 0). Deliberate: the destructive button must never be the default.
  const { itemRefs, onKeyDown } = useRovingFocus(2, 0);
  const titleId = "tree-trash-confirm-title";

  return (
    <Popover
      x={x}
      y={y}
      estimatedHeight={140}
      /**
       * `alertdialog`, not `dialog`: it interrupts to confirm a consequential action, and the role
       * is what makes a screen reader announce the description immediately rather than waiting to
       * be asked. `aria-describedby` points at the sentence naming the item and where it goes, so
       * the stakes are spoken before focus lands on Cancel.
       */
      role="alertdialog"
      label="Confirm move to Trash"
      describedById={titleId}
      restoreFocusTo={restoreFocusTo}
      onClose={onClose}
    >
      <div className="px-3 py-2">
        <p id={titleId} className="text-xs text-surface-text">
          Move {kind === "dir" ? "folder" : "file"}{" "}
          <span className="break-all font-mono text-surface-text">{name}</span> to the Trash?
        </p>
        <p className="mt-1.5 text-[11px] leading-4 text-surface-muted">
          {kind === "dir"
            ? "The folder and everything inside it go to the Trash. You can put them back from there."
            : "It goes to the Trash, so you can put it back from there."}
        </p>

        {/* Cancel FIRST and focused; the destructive button is separated from it and from the
            position the "Delete" menu item occupied. */}
        <div className="mt-3 flex items-center gap-2">
          <button
            ref={(el) => {
              itemRefs.current[0] = el;
            }}
            type="button"
            onKeyDown={(e) => onKeyDown(e, 0)}
            onClick={onClose}
            className="rounded border border-surface-edge px-2.5 py-1 text-[11px] text-surface-text hover:bg-surface-raised focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-blue-300"
          >
            Cancel
          </button>
          <span className="flex-1" />
          <button
            ref={(el) => {
              itemRefs.current[1] = el;
            }}
            type="button"
            onKeyDown={(e) => onKeyDown(e, 1)}
            onClick={() => {
              onClose();
              onConfirm();
            }}
            className="flex items-center gap-1 rounded bg-rose-700 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-rose-600 focus:outline focus:outline-2 focus:-outline-offset-2 focus:outline-blue-300"
          >
            <span aria-hidden="true">⚠</span> Move to Trash
          </button>
        </div>
      </div>
    </Popover>
  );
}
