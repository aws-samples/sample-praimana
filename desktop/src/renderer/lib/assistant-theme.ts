// ── ⚠ ONE VIEW, THREE ASSISTANTS, THREE ACCENTS ──────────────────────────────────────────
//
// `AssistantChatView` renders Claude AND Codex (only kiro/kiro-cli route to `KiroChatView`), and every accent in
// it was hardcoded `claude-accent` / `claude-strong`. So Codex wore Claude's terracotta on its composer
// ring, its send button, its caret and its model box — the accent said nothing about which assistant was
// answering, which is the same fault Kiro's view had before it got its own tokens.
//
// ⚠ WHY A MODULE RATHER THAN A TERNARY AT EACH SITE. There are sixteen accent sites in that file. Sixteen
// inline `cli === "codex" ? … : …` expressions is sixteen chances to miss one, and a missed one is
// invisible unless you happen to be using that assistant. Here the decision is made once, the mapping is
// data, and `assistant-theme.test.ts` can assert every assistant has every field.
//
// ── WHAT IS DELIBERATELY NOT HERE ──
//
// ⚠ NO SURFACES. Only accents. The backgrounds stay `surface-*` for every assistant, because the app's
// chrome is one product — the same rule applied to Kiro (keep the desktop theme's colours). An
// assistant that repainted the pane would read as a different application.

import { assistantIdOf } from "./assistants";

export interface AssistantTheme {
  /** Accent ink for glyphs, active tabs and indicators. Legal as TEXT on every surface. */
  ink: string;
  /**
   * The same accent, scoped to inline code spans inside a markdown reply.
   *
   * ── ⚠ WHY THIS IS A LITERAL AND NOT DERIVED FROM `ink` ────────────────────────────────────
   *
   * It is exactly `ink` with a `prose-code:` prefix, so deriving it with a string replace is the obvious
   * move — and it does not work. Tailwind generates a class only if it can SEE that class as literal text
   * when it scans the source; a name assembled at runtime is invisible to it and the rule is simply never
   * emitted, so the code spans lose their colour with no error anywhere.
   *
   * ⚠ THAT VERSION APPEARED TO WORK, WHICH IS THE TRAP. A derived build passed every test and the three
   * rules were present in the compiled CSS — because the strings happened to appear in nearby COMMENTS,
   * and Tailwind scans comments too. The feature was one comment edit away from silently breaking.
   *
   * Written out per assistant so the scanner sees all three, and so this file remains the single place
   * that answers "what colour is this assistant".
   */
  proseCode: string;
  /** Border colour class for the composer card's focus ring. */
  ring: string;
  /** Fill for the streaming caret. */
  caret: string;
  /**
   * The primary button's full colour classes — send, and "Allow" on the permission card.
   *
   * ⚠ CODEX INVERTS, AND THAT IS WHY THIS IS A WHOLE CLASS STRING RATHER THAN A COLOUR. Claude and Kiro
   * put WHITE text on a saturated fill. Nothing neutral can do that (white on #d1d5db is 1.27:1, and any
   * grey dark enough for white text measures under 1.4.11's 3:1 as a shape on this background), so Codex
   * uses a LIGHT pill with a dark glyph — 12.04:1 in both directions. Expressing that as two tokens would
   * have required a `codex.strong` that lies about what text it can carry.
   */
  primaryButton: string;
  /**
   * The participant's own message bubble.
   *
   * Codex is neutral here too: `surface-raised` rather than a brand fill, which is how the reference
   * screenshot draws it — the turn is distinguished by alignment and inset, not by colour.
   */
  userBubble: string;
}

const CLAUDE: AssistantTheme = {
  ink: "text-claude-accent",
  proseCode: "prose-code:text-claude-accent",
  ring: "focus-within:border-claude-accent",
  caret: "bg-claude-accent",
  // `strong` and not `accent` behind white words: accent is the indicator token (see tailwind.config).
  primaryButton: "bg-claude-strong text-white hover:bg-claude-accent hover:text-surface-bg",
  userBubble: "bg-claude-strong text-white",
};

const KIRO: AssistantTheme = {
  ink: "text-kiro-accent",
  proseCode: "prose-code:text-kiro-accent",
  ring: "focus-within:border-kiro-accent",
  caret: "bg-kiro-accent",
  primaryButton: "bg-kiro-strong text-white hover:bg-kiro-accent hover:text-surface-bg",
  userBubble: "bg-kiro-bubble text-surface-text",
};

const CODEX: AssistantTheme = {
  ink: "text-codex-accent",
  proseCode: "prose-code:text-codex-accent",
  ring: "focus-within:border-codex-accent",
  caret: "bg-codex-accent",
  // The inversion described on `primaryButton` above.
  primaryButton: "bg-codex-accent text-surface-bg hover:bg-surface-text",
  userBubble: "bg-surface-raised text-surface-text",
};

/**
 * The accents for whichever assistant is answering.
 *
 * ⚠ NORMALISED THROUGH `assistantIdOf`, never compared literally. `ai_command` is "kiro-cli" while a
 * session's `ai_provider` is "kiro" — two vocabularies for one assistant, and comparing the raw string is
 * exactly what produced the read-only inversion and the wrong-icon bugs in this same view.
 *
 * Falls back to CLAUDE for an unknown value rather than to a neutral theme: this view's default assistant
 * is Claude, and a missing `ai_command` on a fresh install must not render as though a third assistant
 * were selected.
 */
export function assistantTheme(cli: string | null | undefined): AssistantTheme {
  switch (assistantIdOf(cli)) {
    case "codex":
      return CODEX;
    case "kiro":
      return KIRO;
    default:
      return CLAUDE;
  }
}
