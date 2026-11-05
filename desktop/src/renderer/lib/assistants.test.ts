import { describe, it, expect } from "vitest";
import { assistantIdOf, assistantLabel, canSendInSession } from "./assistants.js";

/**
 * WHICH ASSISTANT A CHAT BELONGS TO.
 *
 * ── ⚠ THREE REPORTED BUGS, ONE CAUSE ──
 *
 * The app has TWO VOCABULARIES for naming an assistant and compared them directly:
 *
 *     `ai_command`  (current setting)   "claude" | "kiro-cli" | "codex"
 *     `ai_provider` (stored on a chat)  "claude" | "kiro"     | "codex"
 *
 * `"kiro" !== "kiro-cli"`, so every comparison was wrong for Kiro and right for the other two. Symptoms:
 *
 *   1. After switching from Codex to Claude, Claude chats became read-only while Codex chats accepted
 *      input — the read-only test was `ai_provider !== currentCli`, and it also treated the legacy value
 *      `"cli"` as a wildcard matching every assistant.
 *   2. After switching to Kiro, every chat in the history showed the Kiro icon — TWO faults: the caller
 *      passed `ai_provider || currentCli`, so an untagged chat adopted whatever was selected; and KiroChatView
 *      hardcoded its own icon on every row and merely greyed out the others.
 *
 * Everything now normalises through `assistantIdOf`, which is what these tests exercise.
 */

describe("assistantIdOf — one id from either vocabulary", () => {
  it("⚠ MAPS BOTH SPELLINGS OF KIRO TO THE SAME ID", () => {
    /**
     * THE ROOT CAUSE, ASSERTED DIRECTLY. `ai_command` is "kiro-cli" and a session's `ai_provider` is "kiro" —
     * two names for one assistant, compared with `!==` in three places.
     */
    expect(assistantIdOf("kiro")).toBe("kiro");
    expect(assistantIdOf("kiro-cli")).toBe("kiro");
  });

  it("maps claude and codex", () => {
    expect(assistantIdOf("claude")).toBe("claude");
    expect(assistantIdOf("codex")).toBe("codex");
  });

  it("is case-insensitive and tolerates arguments in the value", () => {
    /**
     * ⚠ SUBSTRING MATCHING IS DELIBERATE HERE, unlike everywhere else in this codebase where it is a bug (see
     * the phase-name tests, which must NOT match "Demo Prep"). The values in the wild include a command with
     * flags — `kiro-cli --trust-all-tools` appears in at least one settings file — so an exact-match table would
     * have to enumerate spellings it cannot know in advance.
     */
    expect(assistantIdOf("KIRO-CLI")).toBe("kiro");
    expect(assistantIdOf("kiro-cli --trust-all-tools")).toBe("kiro");
    expect(assistantIdOf("/Users/x/.toolbox/bin/claude")).toBe("claude");
  });

  it("⚠ RETURNS NULL FOR UNKNOWN, rather than defaulting to claude", () => {
    /**
     * THE DISTINCTION THAT FIXES THE ICON BUG. "This chat was made by Claude" and "we do not know what made this
     * chat" need different renderings, and the old resolver ended in `: claudeIcon` — collapsing them. Legacy
     * rows really do carry `"cli"`, from before the field was reliable.
     */
    expect(assistantIdOf("cli")).toBeNull();
    expect(assistantIdOf("")).toBeNull();
    expect(assistantIdOf(null)).toBeNull();
    expect(assistantIdOf(undefined)).toBeNull();
    expect(assistantIdOf("gemini")).toBeNull();
  });
});

describe("⚠ canSendInSession — the read-only inversion", () => {
  it("REPRODUCES THE REPORTED CASE: switching to Claude must not lock Claude chats", () => {
    /**
     * The literal report. Under the old predicate a Claude chat opened while Claude was selected could still
     * come out read-only, because the two sides were compared as raw strings from different vocabularies.
     */
    expect(canSendInSession("claude", "claude"), "a Claude chat under Claude").toBe(true);
  });

  it("REPRODUCES THE OTHER HALF: a Codex chat must be locked under Claude", () => {
    // Codex chats accepted input — the inverse of the above, and the more dangerous half: a message
    // typed there would have gone to the wrong assistant.
    expect(canSendInSession("codex", "claude")).toBe(false);
  });

  it("⚠ A KIRO CHAT IS SENDABLE UNDER kiro-cli", () => {
    /**
     * THE CASE THE OLD CODE COULD NEVER GET RIGHT. `"kiro" !== "kiro-cli"` meant a Kiro chat was permanently
     * "another assistant's" — read-only in its own view.
     */
    expect(canSendInSession("kiro", "kiro-cli")).toBe(true);
    expect(canSendInSession("kiro-cli", "kiro-cli")).toBe(true);
  });

  it("locks every genuine mismatch", () => {
    for (const [session, current] of [
      ["claude", "codex"],
      ["claude", "kiro-cli"],
      ["codex", "kiro-cli"],
      ["kiro", "claude"],
      ["kiro", "codex"],
    ] as const) {
      expect(canSendInSession(session, current), `${session} under ${current}`).toBe(false);
    }
  });

  it("⚠ AN UNKNOWN PROVIDER IS EDITABLE — a deliberate choice, not an oversight", () => {
    /**
     * These are legacy rows from before `ai_provider` was reliable, and `"cli"` is the value they carry. Locking
     * someone out of their own history on a GUESS is worse than letting them continue a chat with the wrong
     * assistant — which is visible in the transcript, recoverable, and something they chose to do.
     *
     * Note this is NOT the old behaviour dressed up: the old code special-cased `"cli"` as a wildcard that
     * matched every assistant, which also made a correctly-tagged chat editable when it should not have been.
     */
    for (const legacy of ["cli", "", null, undefined, "gemini"]) {
      expect(canSendInSession(legacy, "claude"), `${legacy} should stay editable`).toBe(true);
    }
  });

  it("an unrecognised CURRENT command locks nothing", () => {
    // A misconfigured `ai_command` is not the chat's fault, and locking the whole history over it would leave no
    // way to recover from inside the app.
    expect(canSendInSession("claude", "something-else")).toBe(true);
    expect(canSendInSession("claude", null)).toBe(true);
  });
});

describe("assistantLabel", () => {
  it("names each assistant from either vocabulary", () => {
    expect(assistantLabel("kiro")).toBe("Kiro");
    expect(assistantLabel("kiro-cli")).toBe("Kiro");
    expect(assistantLabel("codex")).toBe("Codex");
    expect(assistantLabel("claude")).toBe("Claude");
  });

  it("shows the RAW value for something unrecognised", () => {
    // More useful than "Unknown": it is the string a support conversation would quote, and it makes a
    // misconfiguration visible rather than uniform.
    expect(assistantLabel("gemini")).toBe("gemini");
  });

  it("falls back to a generic word only when there is nothing at all", () => {
    expect(assistantLabel(null)).toBe("Assistant");
    expect(assistantLabel("")).toBe("Assistant");
  });
});
