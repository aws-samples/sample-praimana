// ── ⚠ THE BADGE MUST FOLLOW THE SYNC, NOT A SNAPSHOT TAKEN BEFORE IT ─────────────────────
//
// BOTH HALVES WERE TRUE, and the badge was reading a value that was correct at the moment it read it. The
// order in `cli-assistant.ts` is:
//
//     void syncCliTurn({...});                          // fire-and-forget, takes ~a second
//     event.sender.send("cli:response-complete", ...);   // fires immediately after
//
// The renderer reloads its message list on `cli:response-complete`, so it read `sync_status` BEFORE the push
// had written it — always `pending` — and nothing ever told it to look again. The badge therefore stayed on
// "not synced, retry" for the rest of the session, for a message already stored on the server. Switching
// chats fixed it, which is why it looked intermittent rather than broken.
//
// ⚠ NOT FIXED BY AWAITING THE SYNC BEFORE `cli:response-complete`. That would hold the reply behind a
// network round trip; the transcript is already saved locally, and fire-and-forget exists precisely so the
// user is not made to wait for the server.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const read = (...p: string[]) => strip(readFileSync(join(__dirname, ...p), "utf8"));

const sync = read("..", "main", "handlers", "cli-sync.ts");
const preload = read("..", "preload", "index.ts");
const VIEWS = ["AssistantChatView", "KiroChatView"] as const;

describe("⚠ main pushes the status when it writes it", () => {
  it("broadcasts sync:status", () => {
    expect(sync).toMatch(/webContents\.send\("sync:status"/);
  });

  /**
   * ⚠ AFTER THE WRITE, NEVER BEFORE. Broadcasting first would let the UI show a status the database
   * disagrees with — and if the write then failed, the badge would claim "synced" for a row still marked
   * pending, which is worse than the stale badge this replaces.
   */
  it("broadcasts only after the database write succeeds", () => {
    /**
     * ⚠ SCOPED TO `syncCliTurn`'S BODY. A first version compared `indexOf` over the whole file and failed:
     * it found `notifySyncStatus`'s DEFINITION (declared near the top) rather than its call site, so the
     * "after" check was comparing a declaration against a call. Ordering assertions have to read the block
     * that does the ordering.
     */
    /**
     * ⚠ MATCHED ON THE CALL, NOT ITS FULL ARGUMENT LIST. This pinned `markMessagesSynced(ids)` verbatim
     * and broke the moment the status write gained its account predicate (it could stamp another local
     * account's row), which made this a test of the argument list rather
     * than of the ORDERING it is named for.
     */
    const body = sync.slice(sync.indexOf("export async function syncCliTurn"));
    const marks = body.indexOf("markMessagesSynced(ids");
    const notify = body.indexOf("notifySyncStatus(ids");
    expect(marks, "the write must exist in the turn handler").toBeGreaterThan(-1);
    expect(notify, "as must the broadcast").toBeGreaterThan(-1);
    expect(notify, "and the broadcast must come after the write").toBeGreaterThan(marks);
  });

  /** An empty id list is not an event — the two rows are the whole payload. */
  it("says nothing when there are no ids", () => {
    expect(sync).toMatch(/if \(ids\.length === 0\) return;/);
  });

  it("exposes the event through the preload bridge, with a remover", () => {
    expect(preload).toMatch(/onSyncStatus:/);
    expect(preload).toMatch(/removeSyncStatusListeners: \(\) => ipcRenderer\.removeAllListeners\("sync:status"\)/);
  });
});

describe("⚠ BOTH chat views apply it", () => {
  /**
   * The parity rule this project keeps relearning: the sync badge, the copy button and the "Shared" label
   * were each built once, wired into AssistantChatView, and never into KiroChatView — three separate bug reports from
   * one habit. A listener added to one view only would be the fourth.
   */
  it.each(VIEWS)("%s subscribes to sync:status", (view) => {
    const src = read("components", `${view}.tsx`);
    expect(src).toMatch(/api\.onSyncStatus\?\.\(/);
    expect(src, "and cleans the listener up").toMatch(/removeSyncStatusListeners\?\.\(\)/);
  });

  /**
   * ⚠ PATCHES THE NAMED ROWS RATHER THAN RELOADING THE LIST. A reload mid-scroll moves the viewport, and
   * this fires on every turn; the event carries exactly the ids that changed, so there is nothing to re-read.
   */
  it.each(VIEWS)("%s patches state instead of re-reading the database", (view) => {
    const src = read("components", `${view}.tsx`);
    expect(src).toMatch(/sync_status: data\.status/);
    const handler = src.slice(src.indexOf("api.onSyncStatus"), src.indexOf("api.onSyncStatus") + 700);
    expect(handler, "no reload inside the handler").not.toMatch(/loadMessages\(/);
  });

  /**
   * ⚠ RETURNS THE SAME ARRAY WHEN NOTHING MATCHED. Every window receives every broadcast, so a view showing
   * a different session would otherwise build a new array on each event and re-render the whole transcript
   * for a message it is not displaying.
   */
  it.each(VIEWS)("%s does not re-render for a session it is not showing", (view) => {
    const src = read("components", `${view}.tsx`);
    expect(src).toMatch(/prev\.some\(\(m\) => changed\.has\(m\.id\)\)/);
  });
});
