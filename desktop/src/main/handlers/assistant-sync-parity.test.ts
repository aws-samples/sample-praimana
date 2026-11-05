// ── ⚠ EVERY ASSISTANT PATH SYNCS THROUGH `cli-sync`, AND NONE KEEPS ITS OWN COPY ──────────
//
// There are three assistant transports, and they are genuinely different: the Claude Agent SDK
// (`claude-code.ts`), a spawned CLI reading stream-json (`cli-assistant.ts`, which serves Codex), and
// an ACP JSON-RPC client (`kiro-acp.ts`). What they must NOT differ in is how a completed turn is
// recorded.
//
// ⚠ THIS IS THE ROOT CAUSE OF FOUR SEPARATE REPORTS, all on the same evening. `kiro-acp.ts` carried a
// private 115-line `syncToServer` that "mirrored" the shared one. It mirrored an older version:
//
//   · it never wrote the local sync status, so Kiro turns pushed successfully and kept a "not synced"
//     badge forever (backlog 8a);
//   · it sent no `createdAt`, so the server stamped arrival (8b);
//   · it created the thread on a 200-with-zero-messages as well as a 404 — the condition that once
//     destroyed a real share.
//
// Codex and Claude were unaffected, because they already called the shared helper. The lesson is not
// "fix Kiro" — it is that a second implementation of one idea always becomes the stale one, and it
// does so silently here because the transcripts still arrive.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The three transports. Each owns a different protocol and the SAME recording rule. */
const HANDLERS = ["claude-code", "cli-assistant", "kiro-acp"] as const;

const code = (name: string) => strip(readFileSync(join(__dirname, `${name}.ts`), "utf8"));

describe("⚠ all three assistant transports record turns the same way", () => {
  it.each(HANDLERS)("%s.ts calls the shared syncCliTurn", (name) => {
    const src = code(name);
    expect(src).toMatch(/import \{ syncCliTurn \} from "\.\/cli-sync"/);
    expect(src).toMatch(/syncCliTurn\(\{/);
  });

  /**
   * ⚠ THE MARKING IS WHAT THE BADGE READS, and it only happens for rows whose ids are passed. Kiro
   * discarded the USER's id at `saveMessage`, so even after the rewiring the participant's own message
   * would have stayed unmarked.
   */
  it.each(HANDLERS)("%s.ts stamps the user's row, not only the assistant's", (name) => {
    const src = code(name);
    /**
     * ⚠ THE VALUE, NOT THE KEY. A first version matched `/userMessageId/` anywhere, which the OBJECT
     * KEY satisfies even when the value has become `undefined` — the mutation that stopped threading
     * the id through passed the suite. What matters is that the id comes from somewhere real: either
     * the handler's own param (`userMessageId: params.userMessageId`) or a local of that name passed
     * by shorthand, which is the form kiro-acp uses after capturing `saveMessage`'s return.
     */
    const threaded =
      /userMessageId: params\.userMessageId/.test(src) || /\n\s*userMessageId,/.test(src);
    expect(threaded, `${name}.ts must pass a real user row id, not a placeholder`).toBe(true);
    expect(src, `${name}.ts passes an explicit undefined`).not.toMatch(/userMessageId: undefined/);
  });

  /**
   * ⚠ NO HANDLER MAY SPEAK HTTP TO THE TRANSCRIPT ITSELF. This is the check that would have caught the
   * Kiro copy: it had `fetch`, a bounded `syncFetch`, a `checkedFetch` and its own failure toast, all
   * duplicating `cli-sync`. `claude-code.ts` is exempt only because the Agent SDK is its transport —
   * and it is asserted below that its HTTP is not a transcript push.
   */
  it.each(HANDLERS)("%s.ts keeps no private sync implementation", (name) => {
    const src = code(name);
    for (const forbidden of [
      /function syncToServer/,
      /function checkedFetch/,
      /function syncFetch/,
      /function notifySyncFailed/,
    ]) {
      expect(src, `${name}.ts reintroduced ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it.each(HANDLERS)("%s.ts posts nothing to the sync route by hand", (name) => {
    expect(code(name), `${name}.ts talks to /sync directly`).not.toMatch(/\/sync["`']/);
  });
});
