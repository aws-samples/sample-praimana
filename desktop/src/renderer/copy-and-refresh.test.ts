// ── ⚠ ICONS WITH TOOLTIPS, AND NOTHING THAT COSTS A ROW ──────────────────────────────────
//
// ⚠ THEN WITHDRAWN FOR THE USER'S OWN MESSAGES. Copy now
// exists ONLY on assistant replies; the corner keeps sync alone. The tooltip and the 24×24 target survive
// intact on the controls that remain, which is why those cases below are unchanged.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (...p: string[]) => strip(readFileSync(join(__dirname, ...p), "utf8"));

const copy = read("components", "CopyButton.tsx");
const chatView = read("components", "AssistantChatView.tsx");
const kiro = read("components", "KiroChatView.tsx");

describe("⚠ copy is an icon, always there", () => {
  /** The visible word was the whole reason a one-line message had a footer as tall as its content. */
  it("renders no visible label", () => {
    expect(copy, "the word Copy must not be drawn").not.toMatch(/aria-hidden="true">\{copied \? "Copied"/);
    expect(copy).not.toContain('"Failed"');
    /* One glyph, and it still changes to report the outcome. */
    expect(copy).toMatch(/aria-hidden="true">\{copied \? "✓" : failed \? "!" : "⧉"\}/);
  });

  /**
   * ⚠ THE OUTCOME MUST STILL REACH A SCREEN READER. With the visible word gone, `aria-label` is the only
   * thing carrying "Copied" — dropping it would make the confirmation sight-only.
   */
  it("keeps the outcome in the accessible name and the tooltip", () => {
    expect(copy).toMatch(/aria-label=\{copied \? "Copied to clipboard"/);
    expect(copy).toMatch(/title=\{copied \? "Copied"/);
  });

  /**
   * ⚠ ALWAYS VISIBLE, which also removes an accessibility trap: the old `opacity-0` reveal kept the control
   * in the tab order while invisible, which is why it needed `group-focus-within` bolted on.
   */
  it("is no longer hidden until hover", () => {
    expect(copy).not.toContain("opacity-0");
    expect(copy).not.toContain("group-hover:opacity-100");
  });

  /** A single glyph must not inherit a full text line-height, or it costs the row it was meant to save. */
  it("does not occupy a text line", () => {
    expect(copy).toContain("leading-none");
  });
});

describe("⚠ the participant's own message has no footer left", () => {
  /**
   * This is the actual fix for the reported height. Moving copy into the corner only helps if the row it
   * used to live in STOPS BEING RENDERED — an empty flex row still costs its top margin.
   */
  it("renders the codex bubble's footer only for the assistant", () => {
    expect(chatView).toMatch(/\{msg\.role !== "user" && \([\s\S]{0,200}?<CopyButton/);
  });

  it("renders the user box's footer only when there is a timestamp", () => {
    expect(chatView).toMatch(/\{sentAt && \(\s*<div className="mt-0\.5 flex items-center gap-2">/);
  });

  /**
   * ── ⚠ THE USER'S OWN MESSAGE HAS NO COPY AT ALL NOW ──
   *
   * That icon had been moved INTO the corner so it would stop costing a footer row, then asked to move to the
   * bottom-left to match the assistant's — which brings the row straight back. Removing it ends the loop, and
   * it is the one action here nobody needed: the participant wrote the text.
   *
   * ⚠ ASSERTED AS AN ABSENCE INSIDE THE USER'S OWN ELEMENT, never as a file-wide count. Both views still
   * render copy for the ASSISTANT, so `not.toContain("<CopyButton")` on the whole file would fail on correct
   * code — and a count would PASS while the user's icon came back.
   *
   * ⚠ AND THE WINDOW IS THE ELEMENT, not N characters. A fixed slice silently stops proving anything when the
   * markup around it shifts; sliced to its own closing tag, this cannot drift past the control it is about.
   */
  it("gives the participant's own message sync only, no copy", () => {
    for (const [name, src] of [["AssistantChatView", chatView], ["KiroChatView", kiro]] as const) {
      const at = src.indexOf("absolute right-1.5 top-1.5");
      expect(at, `${name} must still position the badge in a corner`).toBeGreaterThan(-1);
      const corner = src.slice(at, src.indexOf("</span>", at));
      expect(corner, `${name} corner keeps sync`).toContain("<SyncBadge");
      expect(corner, `${name} corner must NOT hold copy`).not.toContain("<CopyButton");
    }
    /* The timeline user box: `inline-block` and possibly one character wide, so its controls sit BESIDE it. */
    const at = chatView.indexOf("mt-1 flex flex-shrink-0 items-center");
    expect(at, "the box's control row must exist").toBeGreaterThan(-1);
    const beside = chatView.slice(at, chatView.indexOf("</span>", at));
    expect(beside, "sync stays beside the box").toContain("<SyncBadge");
    expect(beside, "copy must not be beside it any more").not.toContain("<CopyButton");
  });

  /**
   * ⚠ THE ASSISTANT KEEPS ITS COPY IN THE FOOTER, deliberately: the copy icon on AI messages
   * stays as it is. Its row exists for the token counts anyway, so moving it would save nothing.
   */
  it("leaves the assistant's copy in the timeline footer", () => {
    expect(chatView).toMatch(/<CopyButton text=\{msg\.content\} label="Copy reply" \/>/);
  });
});

describe("⚠ refresh is offered twice, and re-reads rather than re-pushes", () => {
  /**
   * ⚠ POSITIONAL, NOT A CHARACTER WINDOW. My first version allowed 400 characters between "Chat History" and
   * the button and failed on correct code — a single conditional `className` in this file is longer than that.
   * Ordering is what the requirement actually is: the refresh sits in the panel's header, before its close.
   */
  it("appears in the conversation list's header, before the close button", () => {
    const header = chatView.indexOf("Chat History");
    const refresh = chatView.indexOf('"Refreshing conversations"', header);
    const close = chatView.indexOf('"Hide chat history"', header);

    expect(header, "the panel header").toBeGreaterThan(-1);
    expect(refresh, "a refresh control in that header").toBeGreaterThan(header);
    expect(refresh, "ahead of the close").toBeLessThan(close);
  });

  it("appears inside an open conversation", () => {
    expect(chatView).toMatch(/aria-label=\{refreshing \? "Refreshing this conversation"/);
  });

  /** Icon plus tooltip, never a label — the header is 40px and already carries three controls. */
  it("is an icon with a tooltip and no visible word", () => {
    expect(chatView).toMatch(/title="Refresh"/);
    expect(chatView).toMatch(/<RefreshIcon spinning=\{refreshing\} \/>/);
    expect(chatView, "no visible caption").not.toMatch(/<RefreshIcon[^>]*\/>\s*Refresh</);
  });

  /**
   * ⚠ IT MUST NOT RE-PUSH. A refresh that also retried a sync would be a heavier action wearing a familiar
   * icon; the per-message badge is the control for that.
   */
  it("re-reads the local rows and syncs nothing", () => {
    const fn = chatView.slice(chatView.indexOf("async function refreshConversations"), chatView.indexOf("async function loadSharedThreads"));

    expect(fn).toContain("api.getSessions");
    expect(fn).toContain("loadMessages(activeId)");
    expect(fn, "must not push").not.toMatch(/retryMessageSync|syncCliTurn|sweep/i);
  });

  /** One at a time: a double click must not queue two reads, and the control says it is busy. */
  it("guards against overlapping refreshes", () => {
    const fn = chatView.slice(chatView.indexOf("async function refreshConversations"), chatView.indexOf("async function loadSharedThreads"));

    expect(fn).toMatch(/if \(refreshing\) return;/);
    expect(fn).toMatch(/finally \{\s*setRefreshing\(false\)/);
  });

  /**
   * ⚠ THE SPIN RESPECTS `prefers-reduced-motion`. A continuously rotating element is exactly what that
   * setting exists to suppress, and the disabled state already conveys "in flight".
   */
  it("does not spin for a reader who asked for less motion", () => {
    expect(chatView).toMatch(/motion-safe:animate-spin/);
  });
});

// ── ⚠ THE TOOLTIP HAD TO STOP BEING THE BROWSER'S ────────────────────────────────────────
//
// The controls carried `title`, and it was not reaching people. Two structural reasons:
//
//   1. The target was ~7×11px, and Chromium shows a `title` only after the pointer RESTS on the element for
//      about a second. A box that small gets crossed, not settled on.
//   2. It would have been clipped anyway — the transcript is `overflow-y-auto`, which clips absolutely
//      positioned descendants.
describe("⚠ a tooltip that actually appears", () => {
  const tooltip = read("components", "IconTooltip.tsx");

  /**
   * ⚠ `fixed` VIA A PORTAL, which is the only shape that survives a scrolling ancestor. Rendered in place it
   * would be cut off at the pane edge or extend the scroll area.
   */
  it("escapes the scrolling transcript", () => {
    expect(tooltip).toContain("createPortal");
    expect(tooltip).toContain("document.body");
    expect(tooltip).toMatch(/\bfixed\b/);
  });

  /** ⚠ FOCUS AS WELL AS HOVER — the thing a native `title` never did for keyboard users at all. */
  it("shows on focus, not only on hover", () => {
    expect(tooltip).toContain("onMouseEnter");
    /* CAPTURE, because focus on a descendant button does not bubble to a span as `onFocus`. */
    expect(tooltip).toContain("onFocusCapture");
    expect(tooltip).toContain("onBlurCapture");
  });

  /**
   * ⚠ MEASURED WHEN SHOWN, NEVER CACHED. The transcript scrolls and streams, so a position captured earlier
   * would place the bubble somewhere the message no longer is.
   */
  it("measures at the moment of showing", () => {
    expect(tooltip).toContain("getBoundingClientRect");
    expect(tooltip, "and hides on scroll, or a fixed bubble hangs over unrelated content").toMatch(
      /addEventListener\("scroll", hide, true\)/
    );
  });

  /** Escape dismisses it — a tooltip with no way out is a tooltip stuck over the content you wanted to read. */
  it("dismisses on Escape", () => {
    expect(tooltip).toMatch(/e\.key === "Escape"/);
  });

  /**
   * ⚠ THE BUBBLE IS `aria-hidden`, and that is not an oversight. The control already carries `aria-label` with
   * the same words; announcing both reads the sentence twice. This was a VISUAL gap, not an accessible-name one.
   */
  it("does not announce itself twice", () => {
    expect(tooltip).toMatch(/aria-hidden="true"/);
    expect(tooltip, "and cannot swallow the click it sits under").toContain("pointer-events-none");
  });

  /** Every icon-only control gets one — a bare glyph nobody can identify is the whole complaint. */
  it("wraps copy, sync and both refresh buttons", () => {
    expect(read("components", "CopyButton.tsx"), "copy").toContain("<IconTooltip");
    expect(read("components", "SyncBadge.tsx"), "sync").toContain("<IconTooltip");
    expect([...chatView.matchAll(/<IconTooltip/g)].length, "both refresh buttons").toBeGreaterThanOrEqual(2);
  });

  /**
   * ⚠ THE TOOLTIP DOES NOT DEPEND ON THE ICON'S SIZE, and that is worth pinning because the size has now
   * changed twice. It went up to fix the native `title` never firing, then back down — and the
   * tooltip kept working, because `IconTooltip` fires on `mouseenter` rather than waiting for the pointer to
   * rest. An assertion on the size would fail the next time somebody adjusts it for a layout reason.
   */
  it("works at whatever size the icon is", () => {
    const copy = read("components", "CopyButton.tsx");

    expect(copy, "the tooltip is what makes it discoverable").toContain("<IconTooltip");
    /* The target is a 24×24 box around an 11px glyph — see `sync-icon.test.ts` for why those differ. */
    expect(copy, "a full-size target, whatever the glyph").toMatch(/\bh-6 w-6\b/);
    expect(copy, "and a visibly larger glyph inside it").toMatch(/text-\[1[5-9]px\]/);
  });
});
