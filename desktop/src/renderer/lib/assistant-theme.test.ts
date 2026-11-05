// ── ⚠ THREE ASSISTANTS IN ONE VIEW, AND NONE MAY WEAR ANOTHER'S COLOUR ───────────────────
//
// `AssistantChatView` renders Claude AND Codex — only kiro/kiro-cli route to the Kiro view — and all sixteen
// of its accents were hardcoded `claude-accent` / `claude-strong`.
//
// These tests own two things the old parity test used to: that every assistant has a COMPLETE theme, and
// the CONTRAST RULE behind Claude's pair — white text belongs on `strong`, never on `accent`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assistantTheme, type AssistantTheme } from "./assistant-theme";

const FIELDS: (keyof AssistantTheme)[] = [
  "ink",
  "proseCode",
  "ring",
  "caret",
  "primaryButton",
  "userBubble",
];

/** Every spelling that reaches this function in the wild. `ai_command` and `ai_provider` disagree. */
const SPELLINGS: Record<string, string[]> = {
  claude: ["claude", "claude-code"],
  codex: ["codex"],
  kiro: ["kiro", "kiro-cli"],
};

describe("⚠ every assistant has a complete theme", () => {
  it.each(Object.values(SPELLINGS).flat())("%s resolves every field", (cli) => {
    const theme = assistantTheme(cli);
    for (const f of FIELDS) {
      expect(theme[f], `${cli}.${f}`).toBeTruthy();
    }
  });

  /**
   * ⚠ NORMALISED, NEVER COMPARED LITERALLY. `ai_command` is "kiro-cli" while a session's `ai_provider` is
   * "kiro" — two vocabularies for one assistant, and comparing the raw string is what produced the
   * read-only inversion and the wrong-icon bugs in this same view.
   */
  it.each(Object.entries(SPELLINGS))("every spelling of %s gets the same theme", (_id, spellings) => {
    const themes = spellings.map((s) => JSON.stringify(assistantTheme(s)));
    expect(new Set(themes).size, `spellings disagreed: ${spellings.join(", ")}`).toBe(1);
  });

  it("gives the three assistants visibly different accents", () => {
    const inks = ["claude", "codex", "kiro"].map((c) => assistantTheme(c).ink);
    expect(new Set(inks).size, "each assistant must be distinguishable").toBe(3);
  });

  /** An unknown or missing value is Claude — this view's default — not a fourth, neutral theme. */
  it.each([null, undefined, "", "something-else"])("falls back to Claude for %s", (cli) => {
    expect(assistantTheme(cli as string).ink).toBe(assistantTheme("claude").ink);
  });
});

describe("⚠ the contrast rule that used to live in vscode-parity.test.ts", () => {
  /**
   * `claude-strong` (#a8432c) carries white at 5.99:1. `claude-accent` (#d97757) is 3.12:1 — legal for a
   * GLYPH under 1.4.11, illegal behind words. Putting white on `accent` is the one mistake the pair
   * exists to prevent, so it is asserted rather than remembered.
   */
  it("Claude puts white text on `strong`, never on `accent`", () => {
    const { primaryButton } = assistantTheme("claude");
    expect(primaryButton).toContain("bg-claude-strong");
    expect(primaryButton).toContain("text-white");
    expect(primaryButton).not.toMatch(/bg-claude-accent[^-]*text-white/);
  });

  it("Kiro does the same with its own pair", () => {
    const { primaryButton } = assistantTheme("kiro");
    expect(primaryButton).toContain("bg-kiro-strong");
    expect(primaryButton).toContain("text-white");
  });

  /**
   * ⚠ CODEX INVERTS, AND THAT IS THE INTERESTING CASE. It has no `strong`, because nothing NEUTRAL can
   * carry white text: white on #d1d5db is 1.27:1, and every grey dark enough for white measures under
   * 1.4.11's 3:1 as a SHAPE on this background (gray-600 is 2.35:1). So its button is a light pill with a
   * DARK glyph — 12.04:1 both ways. A `codex.strong` would have been a token that lies about its own use.
   */
  it("Codex uses a light fill with dark ink, and never white text", () => {
    const { primaryButton } = assistantTheme("codex");
    expect(primaryButton).toContain("bg-codex-accent");
    expect(primaryButton).toContain("text-surface-bg");
    expect(primaryButton, "white on a neutral fill is 1.27:1").not.toContain("text-white");
  });

  /** Codex's own UI has no brand hue; its user bubble is neutral rather than a coloured block. */
  it("Codex's message bubble is neutral, as its own UI draws it", () => {
    expect(assistantTheme("codex").userBubble).toBe("bg-surface-raised text-surface-text");
    expect(assistantTheme("codex").userBubble).not.toMatch(/claude|kiro/);
  });
});

/**
 * ── ⚠ TAILWIND ONLY GENERATES CLASSES IT CAN SEE ──────────────────────────────────────────
 *
 * `proseCode` is `ink` with a `prose-code:` prefix, so building it with a string replace at runtime is the
 * obvious implementation. It silently does not work: Tailwind scans source text for literal class names, so
 * an assembled name is never emitted and the code spans render with no colour — no error, no warning.
 *
 * ⚠ AND THE BROKEN VERSION LOOKED CORRECT. It passed every test and all three rules WERE in the compiled
 * CSS — because the strings appeared in neighbouring comments, which Tailwind also scans. The feature was
 * one comment tidy-up away from breaking.
 *
 * So this asserts the two properties that keep it working: the value is a literal here, and it agrees with
 * `ink`. The second half is what stops the literals drifting apart now that they are written twice.
 */
describe("proseCode is a scanner-visible literal", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./assistant-theme.ts", import.meta.url)),
    "utf8"
  );

  for (const cli of ["claude", "kiro-cli", "codex"]) {
    it(`${cli}'s prose ink is written out, not derived`, () => {
      const theme = assistantTheme(cli);

      // It must agree with `ink`, so the two cannot drift.
      expect(theme.proseCode).toBe(`prose-code:${theme.ink}`);

      // And it must appear VERBATIM in the source, which is the only thing Tailwind acts on.
      expect(source, `${theme.proseCode} must be a literal for Tailwind to emit it`).toContain(
        `proseCode: "${theme.proseCode}"`
      );
    });
  }

  it("⚠ builds no class name at runtime", () => {
    /**
     * The specific shape that fails. A `.replace(...)` producing a `prose-code:` name would satisfy the
     * agreement check above while emitting nothing, so the absence of string surgery is asserted directly.
     */
    expect(source, "a derived class name is invisible to Tailwind").not.toMatch(
      /replace\([^)]*prose-code/
    );
  });
});
