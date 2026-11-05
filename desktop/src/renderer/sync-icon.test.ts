// ── ⚠ A STATE ICON, NOT A LABEL ───────────────────────────────────────────────────────────
//
// The words cost a whole row inside every bubble — on a one-character message like "2" the footer was as tall
// as the content. These tests guard the two things that could go wrong in trading text for colour: losing the
// meaning for anyone who cannot see the hue, and putting a colour on a surface where it cannot be seen at all.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hex } from "./palette.testkit";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const badge = strip(readFileSync(join(__dirname, "components", "SyncBadge.tsx"), "utf8"));

describe("⚠ one sync glyph, three colours — and what still carries the meaning", () => {
  /**
   * ⚠ THE SHAPE CUE WAS REMOVED ON REQUEST, and this test changed with it rather than being deleted.
   *
   * The first version used a distinct glyph per state (✓ / ↻ / !) so the meaning did not rest on hue. The
   * design now uses a single sync icon differing only in colour (green, yellow, red) rather than a tick mark.
   * What these assertions now protect is the
   * cost of that decision being paid down as far as it can be: the state must still be READABLE in words.
   */
  it("uses the same sync glyph for every state it still draws", () => {
    /*
      ⚠ "EVERY STATE" NOW MEANS THE THREE THAT REMAIN. `synced` renders nothing at all — sync is shown
      only when messages are not synced — so the glyph is asserted on what is left rather than on a
      state that no longer exists.
    */
    /*
      ⚠ MATCHED ON THE GLYPH ITSELF, not on `">↻</span>`. That older pattern only ever matched the SYNCED
      branch's one-line span; the surviving control wraps the character across lines for the spin animation,
      so the tighter string quietly stopped describing any code that still exists.
    */
    expect(badge, "one glyph for pending, failed and untracked").toMatch(
      /aria-hidden="true"[^>]*>\s*↻\s*<\/span>/
    );
    expect(badge, "and no state introduces a different shape").not.toMatch(/glyph=/);
    expect(badge).not.toContain('">✓</span>');
  });

  /**
   * ⚠ THESE TWO ARE NOW THE ONLY NON-COLOUR CUES, so removing either would leave the state conveyed by hue
   * alone — unreadable to a screen reader and ambiguous to anyone who cannot separate green from amber from
   * red. The tooltip is for the pointer; the `sr-only` sentence is for everyone else.
   */
  it("names the state in words, for the pointer and for a screen reader", () => {
    /*
      ⚠ THE SYNCED CASES ARE GONE BECAUSE THE STATE IS. It needed a tooltip and an `sr-only` sentence while it
      drew a green glyph that meant something; a state that renders nothing needs no accessible name, and
      asserting one would have forced the noise back in.
    */
    expect(badge, "the action states' tooltip").toMatch(/title=\{title\}/);
    expect(badge, "the action states' text").toMatch(/className="sr-only">\{busy \? "Syncing now" : title\}/);
  });

  /**
   * Each remaining state's words must actually differ, or the sentence conveys no more than the colour does.
   *
   * ⚠ AND "Not synced" MUST STILL BE RESERVED FOR A REAL FAILURE. The untracked state says "Sync" because
   * nothing recorded that it failed — the same restraint `lib/sync-summary.ts` applies to the header count.
   */
  it("gives the remaining states different wording", () => {
    expect(badge, "the server refused it").toContain("Not synced — retry");
    expect(badge, "and the untracked row says so without claiming failure").toContain(
      "Not tracked — push"
    );
    expect(badge, "and synced says nothing, because it draws nothing").not.toContain(
      "Synced with your team"
    );
  });

  /**
   * The words were the original complaint — they must not reappear as VISIBLE text.
   *
   * ⚠ THIS CASE WAS OVER-BROAD AND HAD TO BE FIXED, NOT WORKED AROUND. It forbade the STRINGS `"Not synced"`
   * and `"Syncing…"` anywhere in the file, which conflates two different things: a word rendered on screen
   * (the actual complaint — it cost a whole row) and a word in a TOOLTIP or an accessible name, which is how
   * the state is conveyed at all now that the glyph is identical for every state.
   *
   * Trimming the tooltips tripped it on correct code. So it now asserts the RENDERING SITE: visible text
   * lives in the `aria-hidden` span beside the `sr-only` sentence, and that span must contain the glyph and
   * nothing else. A label may say anything; the badge may not draw it.
   */
  it("does not render the status as visible words", () => {
    const visible = [...badge.matchAll(/aria-hidden="true"[^>]*>([\s\S]*?)<\/span>/g)].map((m) =>
      m[1].trim()
    );
    expect(visible.length, "there is a visible glyph span").toBeGreaterThan(0);
    for (const text of visible) {
      expect(text, `visible text must be the glyph alone, got "${text}"`).toBe("↻");
    }
  });
});

describe("⚠ the colours are legal on the surfaces they land on", () => {
  /**
   * ⚠ THE KEY MAY BE QUOTED, and missing that made this test fail on correct code: the config writes
   * `"error-text": "#f48771"` (a hyphen is not a bare identifier) while the others are bare. Reading only the
   * bare form returned "" and the ratio came out `NaN`.
   */
  /* Values live in index.css now; `palette.testkit` reads them and knows both modes. */

  /**
   * ⚠ SCOPED TO ITS OWN BLOCK, because `strong` exists twice — `claude.strong` and `kiro.strong`. A
   * file-wide search happened to hit the right one first, which is luck rather than a test.
   */


  const relative = (hex: string) => {
    const parts = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = parts.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [relative(a), relative(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };



  /**
   * The surfaces a message bubble can present. An icon is held to 1.4.11's 3:1.
   *
   * ⚠ NOW BOTH MODES. These state colours were measured against the dark palette because that was the only
   * one; the light theme has its own values for `tool-*` (a green that works on white is not the green that
   * works on near-black), so each has to clear the floor on its own surfaces.
   */
  const MODES = ["dark", "light"] as const;
  const SURFACES = ["bg", "panel", "raised"] as const;
  const CASES = MODES.flatMap((mode) => SURFACES.map((surface) => [mode, surface] as const));

  it.each(CASES)("every state colour clears 3:1 on surface-%s (%s)", (mode, surface) => {
    const target = hex(`surface-${surface}`, mode);

    for (const ink of ["ok", "warning", "error-text"]) {
      const inkHex = hex(`tool-${ink}`, mode);
      expect(inkHex, `tool-${ink} must exist in the ${mode} palette`).toMatch(/^#/);
      expect(
        ratio(inkHex, target),
        `tool-${ink} on surface-${surface} in ${mode}`
      ).toBeGreaterThanOrEqual(3);
    }
  });

  /**
   * ⚠ AND THIS IS WHY THE LIGHT VARIANT IS MONOCHROME. Against `claude-strong` (#a8432c) — the Claude user
   * bubble — the palette measures ok 3.00, warning 3.46 and error-text **2.44**, so the RED is below the 3:1
   * floor. It is also the state that matters most. White measures 5.99 there, so the light variant uses white
   * for every state and leans on the glyph and the tooltip: better a monochrome cue that can be seen than a
   * colour-coded one that cannot.
   */
  it("proves the red is illegal on the terracotta bubble, and uses white instead", () => {
    const bubble = hex("claude-strong", "dark");
    const red = hex("tool-error-text", "dark");

    expect(bubble, "the claude bubble colour must be found").toMatch(/^#/);
    expect(red, "the error ink must be found").toMatch(/^#/);

    expect(ratio(red, bubble), "this is the measurement the decision rests on").toBeLessThan(3);
    expect(ratio("#ffffff", bubble), "white is legal there").toBeGreaterThanOrEqual(3);
    /**
     * ⚠ SCOPED TO THE ACTION BRANCH, WHICH IS NOW THE ONLY BRANCH. A file-wide
     * `/onLight\s*\?\s*"text-white"/` used to be satisfied by the SYNCED branch alone, so a mutation that
     * dropped the white from the ACTION branch — leaving the 2.44:1 red on the terracotta bubble for a FAILED
     * message — passed the suite. Two states were chosen in two places and only one was checked.
     *
     * ⚠ HIDING `synced` REMOVED THAT HAZARD RATHER THAN FIXING IT: there is no second branch left to satisfy
     * the match by accident. The scoping is kept anyway, because it is what makes the assertion say what it
     * means, and because the state it protects is the one that matters — the message that did not arrive.
     */
    const tone = badge.slice(badge.indexOf("tone={"), badge.indexOf("title={", badge.indexOf("tone={")));

    expect(tone, "every action state uses white on the terracotta bubble").toMatch(
      /^tone=\{\s*onLight\s*\?\s*"text-white"/
    );
  });
});

describe("⚠ the control is still pressable", () => {
  /**
   * An 11px glyph is a ~7px click target. This is the control someone reaches for precisely when the app has
   * already failed them once, so the padding and the focus ring are not decoration.
   */
  /**
   * ⚠ THE SIZE WENT UP AND CAME BACK DOWN. It was briefly 14px in a 22px box because a ~7×11px
   * target is why the NATIVE `title` never fired; `IconTooltip` made that irrelevant, since it fires on
   * `mouseenter` whatever the size. So this asserts SOME padding and a focus ring — the properties that make it
   * pressable at all — rather than a specific size that has now changed twice.
   */
  /**
   * ⚠ 24×24, WHICH IS WCAG 2.2 SC 2.5.8's MINIMUM POINTER TARGET (AA) — requested as "ok keep 24 24px".
   *
   * The GLYPH is still 11px; the two are different boxes. `h-6 w-6` sizes the button, the glyph is centred in
   * it, and `-my-1.5` lets that box overhang its row rather than growing it — without which a 24px control in a
   * ~14px text row adds 10px to every message footer, undoing the height fix this thread began with.
   */
  it("gives the control a 24x24 target without growing the row", () => {
    const action = badge.slice(badge.indexOf("function SyncAction"));

    expect(action, "24x24 — SC 2.5.8").toMatch(/\bh-6 w-6\b/);
    expect(action, "a visibly larger glyph").toMatch(/text-\[1[5-9]px\]/);
    expect(action, "overhangs the row instead of expanding it").toMatch(/-my-1\.5/);
    expect(action).toMatch(/focus:ring-1/);
    expect(action, "and it is a real button").toMatch(/<button/);
  });
});

// ── ⚠ THE ICON IS BESIDE THE MESSAGE, NOT UNDER IT ───────────────────────────────────────
//
// A one-character message like "2" had a footer as tall as its content.
describe("⚠ placement", () => {
  const chatView = strip(readFileSync(join(__dirname, "components", "AssistantChatView.tsx"), "utf8"));
  const kiro = strip(readFileSync(join(__dirname, "components", "KiroChatView.tsx"), "utf8"));

  /**
   * ⚠ IN THE BUBBLE'S CORNER, WITH ROOM RESERVED. `absolute` alone would drop the icon onto the last word;
   * the padding is what makes the corner free.
   */
  it("puts it in the corner of both bubble styles, with padding reserved", () => {
    for (const [name, src] of [["AssistantChatView", chatView], ["KiroChatView", kiro]] as const) {
      expect(src, `${name} bubble must be a positioning context`).toMatch(/relative[^"`]*rounded-(lg|xl)/);
      /**
       * ⚠ READ OFF THE POSITIONED BUBBLE, NOT THE FILE'S MAXIMUM. My earlier version took `Math.max` of every
       * `pr-*` in the file, so ANY unrelated padding elsewhere satisfied it — it would have passed with the
       * bubble's reservation deleted outright, as long as some other element had a big one.
       *
       * ⚠ AND THE NUMBER CAME DOWN, which is the substantive change here: one 24×24 target (WCAG 2.2 SC
       * 2.5.8) plus the 6px inset is 30px, so `pr-9` (36px). It was `pr-16` while copy shared the corner, and
       * copy is gone from the user's own message — see copy-and-refresh.test.ts.
       */
      const bubble = src.match(/relative[^{}]*?pr-(\d+)/);
      expect(bubble, `${name}'s positioned bubble must reserve a right column`).not.toBeNull();
      expect(
        Number(bubble![1]),
        `${name} must reserve room for a 24px target beside the text`
      ).toBeGreaterThanOrEqual(9);
      /**
       * ⚠ THE CORNER HOLDS SYNC ALONE. Copy was removed from the participant's own message; the
       * absence is asserted in copy-and-refresh.test.ts, and here only so this case cannot be read as still
       * expecting a pair.
       */
      const at = src.indexOf("absolute right-1.5 top-1.5");
      const corner = src.slice(at, src.indexOf("</span>", at));
      expect(corner, `${name} must position the badge in the corner`).toContain("<SyncBadge");
      expect(corner, `${name} corner is sync only now`).not.toContain("<CopyButton");
    }
  });

  /**
   * ⚠ BESIDE, NOT INSIDE, FOR THE USER'S INPUT-STYLE BOX. That box is `inline-block` and hugs its text, so it
   * can be one character wide — an absolute corner icon would sit on top of the content.
   */
  it("puts it beside the user's box, aligned to the first line", () => {
    const row = chatView.slice(chatView.indexOf('<div className="flex items-start gap-1.5">'));

    expect(row.slice(0, 600), "the box and the badge share a row").toMatch(
      /inline-block[\s\S]{0,400}?<SyncBadge/
    );
    expect(row.slice(0, 100), "top-aligned, so a long message keeps the icon on line one").toContain(
      "items-start"
    );
  });

  /**
   * ⚠ AND IT MUST BE OUT OF THE FOOTERS, or the row it was costing is still there. The assistant's timeline
   * footer is the deliberate exception: full-width prose with no box to tuck a corner into, and the row exists
   * for "Copy reply" regardless.
   */
  it("no longer sits in the bubble footers", () => {
    const codexFooter = chatView.slice(
      chatView.indexOf('<div className="mt-1 flex items-center gap-2">'),
      chatView.indexOf('<div className="mt-1 flex items-center gap-2">') + 400
    );
    expect(codexFooter, "the codex bubble's footer is copy + tokens only").not.toContain("<SyncBadge");

    const kiroFooter = kiro.slice(
      kiro.indexOf('<div className="mt-1 flex items-center gap-2">'),
      kiro.indexOf('<div className="mt-1 flex items-center gap-2">') + 300
    );
    expect(kiroFooter).not.toContain("<SyncBadge");
  });
});

// ── ⚠ TOKENS PER MESSAGE AND PER CONVERSATION ────────────────────────────────────────────
describe("⚠ token displays are wired and silent when uncounted", () => {
  const chatView = strip(readFileSync(join(__dirname, "components", "AssistantChatView.tsx"), "utf8"));
  const perMessage = strip(readFileSync(join(__dirname, "components", "MessageTokens.tsx"), "utf8"));

  it("shows a per-message count from the row's own columns", () => {
    expect(chatView).toMatch(/<MessageTokens\s+input=\{msg\.input_tokens\}/);
    expect(chatView).toMatch(/output=\{msg\.output_tokens\}/);
  });

  /** Derived from the loaded rows, so it survives a restart and cannot double-count on a reload. */
  it("totals the conversation from the messages, not from an accumulator", () => {
    expect(chatView).toMatch(/const sessionTokens = totalTokens\(messages\)/);
    expect(chatView, "and it is shown in the header").toMatch(
      /sessionTokens\.counted > 0 &&[\s\S]{0,600}?formatTokens\(sessionTokens\.input\)/
    );
  });

  /**
   * ⚠ NOTHING IS RENDERED WHEN NOTHING WAS COUNTED. Almost every existing row has no counts, and a confident
   * "0" on a real reply would be worse than silence.
   */
  it("renders nothing for an uncounted row or an uncounted conversation", () => {
    expect(perMessage).toMatch(/if \(!hasTokens\(\{[\s\S]{0,80}?\}\)\) return null;/);
    expect(chatView).toMatch(/sessionTokens\.counted > 0 &&/);
  });

  /** A partial total is a floor and must say so, exactly as the portal's strip does. */
  it("marks a partial conversation total as a minimum", () => {
    expect(chatView).toMatch(/sessionTokens\.partial &&[\s\S]{0,120}?\(min\)/);
  });

  /** "ctx", not "in" — the count is the whole prompt, not what the participant typed. */
  it("labels the input as context", () => {
    expect(perMessage).toContain("ctx");
    expect(perMessage).not.toMatch(/\bin<\/span>|\$\{formatTokens\(input\)\} in\b/);
  });
});
