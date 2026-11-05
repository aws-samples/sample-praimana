import { describe, it, expect } from "vitest";
import {
  formatHistoryPreamble,
  REPLAY_MAX_MESSAGES,
  REPLAY_MAX_CHARS,
} from "./acp-history";

describe("formatHistoryPreamble (Kiro ACP resume)", () => {
  it("returns empty string when there is no history", () => {
    expect(formatHistoryPreamble([])).toBe("");
  });

  it("includes prior user and assistant turns labeled", () => {
    const out = formatHistoryPreamble([
      { role: "user", content: "build a todo app" },
      { role: "assistant", content: "Approve — start the workflow" },
    ]);
    expect(out).toContain("User: build a todo app");
    expect(out).toContain("Assistant: Approve — start the workflow");
    // Framed as resumed context, not a fresh request.
    expect(out).toContain("Context resumed from a previous session");
    expect(out).toContain("The user's new message follows");
  });

  it("keeps only the most recent REPLAY_MAX_MESSAGES", () => {
    const rows = Array.from({ length: REPLAY_MAX_MESSAGES + 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const out = formatHistoryPreamble(rows);
    // Oldest dropped, newest kept.
    expect(out).not.toContain("m0\n");
    expect(out).toContain(`m${rows.length - 1}`);
    // Exactly the cap number of transcript lines.
    const lines = out.split("\n").filter((l) => /^(User|Assistant): /.test(l));
    expect(lines).toHaveLength(REPLAY_MAX_MESSAGES);
  });

  it("trims oldest messages to stay within the char cap", () => {
    const big = "x".repeat(10_000);
    const rows = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big }, // 30k total > 24k cap
    ];
    const out = formatHistoryPreamble(rows);
    const transcriptLines = out.split("\n\n").filter((l) => l.startsWith("User:") || l.startsWith("Assistant:"));
    // The oldest was dropped to fit under the cap.
    expect(transcriptLines.length).toBeLessThan(rows.length);
    expect(out.length).toBeLessThan(REPLAY_MAX_CHARS + 2000); // preamble framing overhead
  });

  it("always keeps at least the single most recent message even if oversized", () => {
    const huge = "y".repeat(REPLAY_MAX_CHARS * 2);
    const out = formatHistoryPreamble([{ role: "user", content: huge }]);
    expect(out).toContain("User: " + huge);
  });
});
