// ── KIRO'S TRANSCRIPT, LAID OUT LIKE KIRO'S OWN ASSISTANT ─────────────────────────────────
//
// ⚠ THE INSTRUCTION HAS TWO HALVES THAT PULL AGAINST EACH OTHER, and the split is what these tests pin.
// Kiro's IDE sits on a navy background; this app is `gray-900` everywhere and keeps the
// desktop theme. So what is adopted is the LAYOUT (full-width turns, ruled separators, a header band on
// tables, a Working bar) and the ACCENT (blue, not Claude's terracotta). What is NOT adopted is the
// chrome — no navy surfaces, and none of the Kiro IDE controls we have no feature behind.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const kiro = strip(readFileSync(join(__dirname, "components", "KiroChatView.tsx"), "utf8"));
const config = readFileSync(join(__dirname, "..", "..", "tailwind.config.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));

describe("⚠ Kiro wears its own accent, not Claude's", () => {
  /**
   * Fifteen `claude-accent` / `claude-strong` references lived in this file, so the assistant that is
   * NOT Claude was presented entirely in Claude's brand colour — the accent said nothing about which
   * assistant you were talking to.
   */
  it("has no Claude brand token left in it", () => {
    expect(kiro).not.toMatch(/claude-accent|claude-strong/);
  });

  it("defines the kiro tokens it uses", () => {
    for (const token of ["accent", "strong", "bubble"]) {
      expect(config, `kiro.${token} must exist`).toMatch(
        new RegExp(`kiro:\\s*\\{[^}]*${token}:`, "s")  // nosemgrep: missing-template-string-indicator
      );
    }
  });

  /**
   * ⚠ THE SURFACES MUST NOT FOLLOW THE IMAGES. A navy chat pane beside a gray-900 sidebar is the exact
   * mismatch an earlier re-theme was raised to fix, and the instruction here was explicitly to keep the
   * desktop's colour. So the view may only paint itself with `surface-*` fills.
   */
  it("paints its surfaces from the app's palette, not the images'", () => {
    /**
     * ⚠ THE BRACKET FORM IS THE WHOLE POINT OF THIS REGEX. A first version matched only
     * `/bg-([a-z0-9-]+)/`, so Tailwind's arbitrary-value syntax — `bg-[#0a1628]`, i.e. EXACTLY how
     * someone would paste a colour straight off the reference screenshot — was invisible to it. The
     * mutation that painted the pane navy passed the suite. A palette guard that cannot see a raw hex
     * is guarding nothing.
     */
    const backgrounds = [...kiro.matchAll(/\bbg-(\[[^\]]+\]|[a-z0-9/-]+)/g)].map((m) => m[1]);
    const allowed = /^(surface-|kiro-strong|kiro-bubble|kiro-accent|transparent|black|white|tool-)/;
    const foreign = [...new Set(backgrounds.filter((b) => !allowed.test(b)))];
    expect(foreign, `unexpected fills: ${foreign.join(", ")}`).toEqual([]);
  });
});

describe("⚠ the assistant's turn is full width, and authorship survives it", () => {
  /**
   * The avatar gutter cost ~44px on EVERY line of every reply, and this view holds the widest content
   * in the app — findings tables, fenced code, paths. In a pinned half-width pane that was the
   * difference between a table fitting and scrolling.
   */
  it("no longer indents every reply behind an avatar column", () => {
    expect(kiro, "the icon gutter is gone").not.toMatch(
      /return \(\s*<div className="flex gap-3">\s*\{?\s*<div className="mt-0\.5">/
    );
  });

  /**
   * ⚠ AND THIS IS THE PART THAT COULD REGRESS SILENTLY. The icon WAS the authorship cue. Removing the
   * gutter without replacing the cue would leave two turns distinguished by alignment alone.
   */
  it("replaces the avatar cue with a rule and a named author", () => {
    expect(kiro, "a hairline above each turn, suppressed on the first").toContain(
      "border-t border-surface-line pt-3 first:border-t-0"
    );
    expect(kiro, "and the assistant is NAMED, not only drawn").toMatch(
      /assistantLabel\(provider \?\? "kiro"\)/
    );
  });

  /** The shared helper, not a second copy of the same four-way switch. */
  it("takes the name from lib/assistants", () => {
    expect(kiro).toMatch(/import \{[^}]*assistantLabel[^}]*\} from "\.\.\/lib\/assistants"/);
  });

  /** The participant's own turn stays an inset box — the contrast that makes the two readable apart. */
  it("keeps the user's turn as an inset box in the image's muted fill", () => {
    expect(kiro).toMatch(/justify-end/);
    expect(kiro).toContain("bg-kiro-bubble");
    expect(kiro, "text at full contrast on that fill").toContain("text-surface-text");
  });
});

describe("⚠ tables render at all, which they did not", () => {
  /**
   * ⚠ THE CENTREPIECE OF THE REFERENCE IMAGE COULD NOT RENDER. `react-markdown` ships CommonMark, and
   * CommonMark has no tables — so this file's own `table` / `th` / `td` components were DEAD CODE and a
   * pipe table arrived as literal `| Finding | Effort |` text. Styling them would have been styling
   * something that never appeared.
   */
  it("has the GFM plugin as a real dependency", () => {
    expect(pkg.dependencies?.["remark-gfm"] ?? pkg.devDependencies?.["remark-gfm"]).toBeTruthy();
  });

  it("passes it to ReactMarkdown", () => {
    expect(kiro).toContain('import remarkGfm from "remark-gfm"');
    expect(kiro, "imported but not passed renders nothing differently").toMatch(
      /remarkPlugins=\{\[remarkGfm\]\}/
    );
  });

  it("styles them as the image draws them — a header band, ruled and striped", () => {
    expect(kiro, "header band").toMatch(/thead className="bg-surface-raised"/);
    expect(kiro, "striped body rows").toMatch(/even:bg-surface-panel/);
    expect(kiro, "ruled cells").toMatch(/border-t border-surface-line[^"]*px-3/);
  });

  /**
   * A findings table is read cell by cell, and the body was `surface-muted` — a 2.54:1 dimming applied
   * to the densest text in the view. Muted is for labels ABOUT content, not content.
   */
  it("does not dim the densest text in the view", () => {
    const td = /td className="([^"]*)"/.exec(kiro);
    expect(td).not.toBeNull();
    expect(td![1]).not.toContain("text-surface-muted");
    expect(td![1]).toContain("text-surface-text");
  });
});

describe("⚠ the Working bar states what is happening, and offers the way out", () => {
  it("replaces the bouncing dots with the image's bar", () => {
    expect(kiro, "three decorative dots are gone").not.toMatch(/animate-bounce/);
    expect(kiro).toContain("Working…");
  });

  /**
   * ⚠ THE DOTS TOLD A SCREEN-READER USER NOTHING. A CSS animation is not an announcement, so a turn in
   * flight was invisible to anyone not watching it. Polite rather than assertive so it waits for a
   * pause instead of cutting across the reply being read out.
   */
  it("announces itself to assistive tech", () => {
    expect(kiro).toMatch(/role="status"/);
    expect(kiro).toMatch(/aria-live="polite"/);
  });

  /**
   * Two Cancel affordances, ONE handler. The bar is where the reference image puts it and where someone
   * looks; the composer's Stop is where a Claude user's hand already is. Two behaviours would be a bug.
   */
  it("wires cancel to the existing handler rather than a second path", () => {
    const cancels = [...kiro.matchAll(/onClick=\{handleCancel\}/g)].length;
    expect(cancels, "the bar and the composer both, same function").toBe(2);
    expect(kiro).not.toMatch(/function handleCancel2|cancelTurn2/);
  });
});
