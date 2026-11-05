// ── ⚠ A RESUMED THREAD THAT NO LONGER EXISTS MUST NOT KILL THE CHAT ───────────────────────────
//
//     [cli-assistant] STDERR: thread/resume: thread/resume failed:
//       no rollout found for thread id 04f001d5-8ecd-40c5-8e74-a9a95e5fafd0 (code -32600)
//
// and the turn died. The chat row kept an id that can never resolve again, so every retry failed
// identically and the participant's only option was to abandon the conversation.
//
// ⚠ THIS IS A NORMAL CONDITION, NOT ONLY THE SYMPTOM OF THE BUG THAT CAUSED IT. Codex prunes
// ~/.codex/sessions, participants move machine or clear that directory, and a chat can simply
// outlive its rollout. So the detector is tested on its own rather than only through the one
// message that prompted it.
//
// The strings below are pasted from the real failure, not paraphrased.
import { describe, it, expect } from "vitest";
import { isStaleThreadError } from "./cli-assistant";

describe("⚠ stale CLI thread detection", () => {
  it("recognises the error captured from the real failure", () => {
    expect(
      isStaleThreadError(
        "thread/resume: thread/resume failed: no rollout found for thread id " +
          "04f001d5-8ecd-40c5-8e74-a9a95e5fafd0 (code -32600)"
      )
    ).toBe(true);
  });

  it("recognises either half, so an upstream rewording of one does not blind it", () => {
    expect(isStaleThreadError("no rollout found for thread id abc")).toBe(true);
    expect(isStaleThreadError("thread/resume failed: something else entirely")).toBe(true);
  });

  it("is case-insensitive and tolerates surrounding log noise", () => {
    expect(isStaleThreadError("Error: \nNO ROLLOUT FOUND FOR THREAD id x\n  at foo()")).toBe(true);
  });

  /**
   * ⚠ THE ASSERTION THAT KEEPS THIS HONEST. Clearing the stored thread id loses the assistant's
   * memory of the conversation, so it must happen ONLY for this condition. Matching too broadly
   * would silently drop continuity on any unrelated stderr line — a worse bug, and a quieter one.
   */
  it("does NOT fire on unrelated stderr", () => {
    for (const other of [
      "All tools are now trusted",
      "stream disconnected before completion",
      "Reconnecting... 1/5 (unexpected status 500)",
      "unexpected status 404 Not Found: The model does not exist",
      "workspace has not been trusted",
      "thread started",
      "rollout written to ~/.codex/sessions/2026/09/30/rollout-x.jsonl",
      "",
    ]) {
      expect(isStaleThreadError(other), `must not fire on: ${other}`).toBe(false);
    }
  });
});
