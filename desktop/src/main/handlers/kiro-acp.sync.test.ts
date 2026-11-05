// ── ⚠ KIRO SYNCS THROUGH `cli-sync`, AND KEEPS NO COPY OF ITS OWN ────────────────────────
//
// Backlog 8a and 8b, and they had ONE cause: `kiro-acp.ts` carried a second, hand-written
// `syncToServer` — 115 lines of timeout, thread probe, thread create, message push and failure toast,
// described in its own comment as "mirroring" the shared one. It mirrored an older version of it.
//
//   8a — it never wrote the local sync status. `saveMessage` stamps every row `pending` and only
//        `syncCliTurn` clears it, so a Kiro turn pushed SUCCESSFULLY and kept its "not synced" label
//        and retry icon forever. The badge reported the database honestly; the database was wrong.
//   8b — it sent no `createdAt`, so the server stamped arrival. Turns pushed after a reconnect all
//        landed in the same second, which is the "0s team time" class of wrongness.
//
// A third: the push was guarded on `assistantContent`, so a turn stopped
// before the first token synced NOTHING — the participant's question never reached the server either.
//
// ⚠ WHY THIS IS A SOURCE SCAN. The behaviour of `syncCliTurn` itself is driven for real in
// `cli-sync.auth.test.ts`, which mocks `markMessagesSynced` and asserts the marking, the empty-reply
// case and the failure path against the exported function. What CANNOT be reached that way is this
// file's `send` handler: it needs a spawned `kiro-cli` subprocess and a live ACP handshake before the
// sync line executes. So the functional half is covered there, and what is checked here is the
// DELEGATION plus the absence of a replacement copy — which is the property that actually broke.
//
// This is the same technique, for the same reason, as `claude-streaming.test.ts` beside it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/** Comments here describe what the code must NOT do, so absence checks must not read them. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const code = stripComments(readFileSync(join(__dirname, "kiro-acp.ts"), "utf8"));

describe("⚠ Kiro's turn sync is the shared one", () => {
  it("imports syncCliTurn from cli-sync and calls it", () => {
    expect(code).toMatch(/import \{ syncCliTurn \} from "\.\/cli-sync"/);
    expect(code).toMatch(/syncCliTurn\(\{/);
  });

  it("records the provider as kiro, so the transcript attributes the turn", () => {
    expect(code).toMatch(/aiProvider: "kiro"/);
  });

  /**
   * ⚠ 8a IN ONE ASSERTION. `syncCliTurn` can only clear a row it is given the id of. The assistant's
   * id was passed by accident — it was already needed as the idempotency key — while the user's was
   * DISCARDED at the `saveMessage` call, so the participant's own message stayed "not synced" no
   * matter how many times it reached the server.
   */
  it("passes BOTH row ids, so both halves of the turn can be marked", () => {
    expect(code, "the user's id must be captured, not discarded").toMatch(
      /const userMessageId = saveMessage\(params\.sessionId, "user", params\.message\)/
    );
    expect(code).toMatch(/userMessageId,/);
    expect(code).toMatch(/assistantMessageId: turnId/);
  });

  /**
   * ⚠ THE STOPPED TURN. `if (assistantContent)` around the push meant a turn cancelled before the
   * first token synced nothing at all — so the server transcript held no evidence the question had
   * been asked. `syncToServer` handles an empty reply by syncing the user's message alone.
   *
   * The regex works on brace proximity: `[^}]*` cannot cross the `}` that closes the
   * `if (assistantContent)` block, so a match means the call is INSIDE the guard.
   */
  it("is not guarded on there being a reply", () => {
    expect(code, "the sync must sit outside any assistantContent guard").not.toMatch(
      /if \(assistantContent\)[^}]*syncCliTurn/
    );
    // The guard itself is still correct for what it actually guards: saving the assistant row.
    expect(code).toMatch(/if \(assistantContent\)[^}]*saveMessage/);
  });
});

describe("⚠ and no second copy of it survives in this file", () => {
  /**
   * The deletion is the fix. Each of these is a piece of the copy that shipped both bugs, and a
   * re-introduction would be invisible at runtime — the transcripts still arrive, so nothing fails
   * loudly. This is the second time a sync fix missed this file (backlog 6c was the first), which is
   * why the absence is asserted rather than trusted.
   */
  it.each([
    ["HTTP of its own", /\bfetch\(/],
    ["a private syncToServer", /function syncToServer/],
    ["a private checkedFetch", /function checkedFetch/],
    ["a private syncFetch", /function syncFetch/],
    ["a private failure toast", /function notifySyncFailed/],
    ["a private sync timeout", /SYNC_TIMEOUT_MS/],
  ])("has no %s", (_what, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  /**
   * `BrowserWindow` existed in this file ONLY for the deleted toast. Left imported it would be the
   * loose end that makes re-adding a local `notifySyncFailed` look like the natural thing to do.
   */
  it("no longer reaches for BrowserWindow", () => {
    expect(code).not.toMatch(/BrowserWindow/);
  });

  /** The thread-create condition that once destroyed a real share now lives only in cli-sync. */
  it("no longer decides for itself when to create a thread", () => {
    expect(code).not.toMatch(/threads\b.*\bPOST|thread create/);
    expect(code).not.toMatch(/status === 404/);
  });
});
