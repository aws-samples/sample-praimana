/**
 * ── WHICH ASSISTANT A CHAT BELONGS TO ──
 *
 * ⚠ THREE REPORTED BUGS SHARE ONE CAUSE: the app has TWO VOCABULARIES for naming an assistant and compares
 * them directly.
 *
 *   `ai_command` (the current setting)  "claude" | "kiro-cli" | "codex"
 *   `ai_provider` (stored on a session) "claude" | "kiro"     | "codex"   ← KiroChatView writes "kiro"
 *
 * `"kiro" !== "kiro-cli"`, so every comparison between them is wrong for Kiro and right for the other two —
 * which is exactly the reported pattern:
 *
 *   1. After switching from Codex to Claude, Claude chats became read-only while Codex chats accepted
 *      input — the read-only test was `session.ai_provider !== currentCli`. It also treated the legacy
 *      value `"cli"` as a wildcard, so an old chat was editable under any assistant while a correctly-tagged
 *      one was not.
 *   2. After switching to Kiro, every chat in the history showed the Kiro icon — two faults at once.
 *      `AIIcon` falls back to `currentCli` when a session has no provider, so switching assistants relabelled
 *      every untagged chat; and KiroChatView hardcoded its own icon on every history row regardless.
 *
 * So the mapping lives here, once, and every caller goes through it. This package's vitest is node-only, so a
 * pure module is also the only version of this that can be tested.
 */

/** The assistants this app can drive. */
export type AssistantId = "claude" | "kiro" | "codex";

/**
 * Normalise EITHER vocabulary to one id.
 *
 * ⚠ SUBSTRING MATCHING IS DELIBERATE HERE, unlike everywhere else in this codebase where it is a bug. The
 * values in the wild are `kiro`, `kiro-cli`, and historically `kiro-cli --trust-all-tools` in at least one
 * settings file — so an exact-match table would have to enumerate spellings it cannot know in advance. The
 * three families are unambiguous enough that no real value contains two of them.
 *
 * `null` for an unrecognised or absent value — NOT a default of "claude". That distinction is what fixes the
 * icon bug: "this chat was made by Claude" and "we do not know what made this chat" need different renderings,
 * and collapsing them is what let a Kiro switch relabel every untagged chat.
 */
export function assistantIdOf(value: string | null | undefined): AssistantId | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("kiro")) return "kiro";
  if (v.includes("codex")) return "codex";
  if (v.includes("claude")) return "claude";
  return null;
}

/** Display name for a known assistant. */
export function assistantLabel(value: string | null | undefined): string {
  switch (assistantIdOf(value)) {
    case "kiro":
      return "Kiro";
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    default:
      // The raw value is more useful than "Unknown" — it is what a support conversation would quote.
      return value || "Assistant";
  }
}

/**
 * Can this chat accept a new message under the currently-selected assistant?
 *
 * ⚠ THE BUG THIS REPLACES compared the two vocabularies directly (`ai_provider !== currentCli`), so:
 *   - a Kiro chat was ALWAYS "another assistant's" (`"kiro" !== "kiro-cli"`), and
 *   - `ai_provider === "cli"` was treated as a wildcard that matched everything.
 *
 * Together those produced the reported inversion: switching to Claude locked the Claude chats (whose stored
 * provider was the legacy `"cli"`… or whose comparison went the other way) while leaving Codex chats editable.
 *
 * A chat with NO recognisable provider is EDITABLE. That is the deliberate choice for the ambiguous case: those
 * are legacy rows written before the field was reliable, and locking someone out of their own history on a
 * guess is worse than letting them continue a chat with the wrong assistant — which is visible, recoverable,
 * and something they chose to do.
 */
export function canSendInSession(
  sessionProvider: string | null | undefined,
  currentCommand: string | null | undefined
): boolean {
  const session = assistantIdOf(sessionProvider);
  if (session === null) return true;
  const current = assistantIdOf(currentCommand);
  // An unrecognised CURRENT command is a misconfiguration, not the chat's fault — so it does not lock anything.
  if (current === null) return true;
  return session === current;
}
