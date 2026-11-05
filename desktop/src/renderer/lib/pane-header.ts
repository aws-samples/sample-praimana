// ── ⚠ ONE HEADER HEIGHT, BECAUSE THE PANES SIT SIDE BY SIDE ──────────────────────────────
//
// ⚠ THOSE ARE THE SAME BUG. Pinning puts two panes in one row, so their header bars become a single visual
// line across the window — and they were four different heights, set independently wherever each pane
// happened to be written:
//
//   AssistantChatView        py-2    (~34px)
//   TeamChatView    py-2.5  (~37px)
//   BoardView       py-3    (~42px)
//   FileEditorView  py-1.5  (~29px)   ← and still LIGHT-THEMED: bg-gray-50 on a dark app
//
// Side by side, the seam between two panes reads as a mistake rather than as a division: the titles sit at
// different heights and the bottom rules do not meet the divider at the same point. Nothing was "not
// separated"; the separation was drawn crooked.
//
// ⚠ SO THE HEIGHT IS FIXED HERE RATHER THAN PADDED PER PANE. `h-10` with `items-center` gives every header
// the same 40px regardless of what it contains — a title alone, a title with buttons, a title with a
// segmented control. Padding cannot do that: `py-2` around a 20px button and `py-2` around a 14px label are
// two different heights, which is exactly how the four above drifted apart.

/**
 * The shared header bar for every pane.
 *
 * Use as the ONLY source of the bar's height and rule. A pane may add its own background and its own layout
 * inside, but must not restate the height — `h-10` is what makes two pinned panes line up.
 */
export const PANE_HEADER =
  "flex h-10 flex-shrink-0 items-center gap-2 border-b border-surface-line px-4";

/**
 * The pane's own name, inside its header.
 *
 * ⚠ THE HEIGHTS MATCHING WAS NOT ENOUGH. With four bars at one height the titles were still `text-lg
 * font-bold` (Board, Phases), `text-sm font-medium` (chat) and `text-sm font-semibold` (Team Chat) — so two
 * pinned panes still read as different kinds of thing, which is the other half of "title bar height not good".
 * One size and one weight for every pane name.
 */
export const PANE_TITLE = "truncate text-sm font-semibold text-surface-text";

/**
 * The divider between two panes in the same row.
 *
 * ⚠ A DEDICATED COLOUR, NOT `surface-line`, because this boundary carries INFORMATION. `surface-line`
 * (#374151) measures 1.72:1 against the page — right for a hairline inside a panel where nothing depends on
 * seeing it, and far too faint when it is the thing saying "these are two panes".
 *
 * ⚠ AND NOT `surface-raised` EITHER, WHICH WAS MY FIRST ATTEMPT. `raised` and `line` are the SAME HEX, so
 * that change was two pixels of the identical colour while its comment claimed a lighter one. Only measuring
 * the pair found it, which is why the figure below is computed in `pane-chrome.test.ts` rather than asserted
 * in prose.
 *
 * `surface-edge` (#6b7280) measures 3.67:1 on `bg` and 3.04:1 on `panel`, clearing WCAG 1.4.11's 3:1 on
 * either surface a pane may present. It is still not the ONLY cue — each pane carries its own header and
 * title — so this is reinforcement rather than the sole signal.
 */
export const PANE_DIVIDER = "border-l-2 border-surface-edge";
