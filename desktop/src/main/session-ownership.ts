/**
 * ── ⚠ DOES THIS CHAT BELONG TO THE ACCOUNT THAT IS ASKING? ────────────────────────────────────
 *
 * `chat_messages` carries no account of its own — the SESSION owns the account — so every operation
 * keyed on a caller-supplied `sessionId` has to reach through `chat_sessions` to find out who it
 * belongs to. Three handlers in handlers/db.ts learned that already (`db:getMessages`,
 * `db:deleteSession`, `db:setSessionShared`) and each spells the predicate out inline. The channels
 * that WRITE, and the one that replays a transcript into an agent prompt, did not — so the same
 * predicate had to be written a fourth, fifth and sixth time, which is exactly how the seventh gets
 * forgotten.
 *
 * ⚠ SO IT LIVES HERE AND IS GREPPABLE, for the reason active-account.ts gives about `activeUserId`:
 * a new session-keyed handler that does not name this function is visible as such in review, and an
 * inlined expression is not.
 *
 * ── ⚠ THIS IS AUTHORIZATION. `assertSafeRowId` IS NOT ──
 *
 * The two are easy to confuse because they sit on the same arguments. `isSafeRowId` (row-id.ts) asks
 * whether a string could be a legitimate id — a URL-safety and storage-correctness check, and
 * handlers/db.ts says so explicitly where it applies both. It answers nothing about WHOSE row it is.
 * Multi-account switching on one profile is a first-class feature here, so "this is a well-formed
 * UUID" and "this is your chat" are entirely different questions and both have to be asked.
 *
 * ⚠ `user_id IS ?` RATHER THAN `= ?`, matching every sibling. A session written before the column
 * existed carries NULL and `NULL = NULL` is never true in SQL, so `=` would make the oldest chats
 * permanently unusable — which reads as "the app forgot my conversations", not as a security control.
 *
 * ⚠ AND NULL MATCHES NULL DELIBERATELY: signed out, nothing is owned by anybody, and a legacy chat is
 * still that machine's own. This is not a permission to read another ACCOUNT's row, because a
 * signed-in account has a real `user_id` and will not match a NULL one.
 */

import { getDb } from "./database";
import { activeUserId } from "./active-account";
import { isSafeRowId } from "./row-id";

/**
 * True when `sessionId` names a chat the active local account owns.
 *
 * ⚠ FALSE FOR AN ABSENT ROW AS WELL AS A FOREIGN ONE, and callers must not tell the two apart in what
 * they return. A channel that answered "wrong owner" separately from "no such chat" would be a probe
 * for which session ids exist under other accounts on this machine — the reasoning `share:shareSession`
 * already writes out for its single "Chat not found".
 *
 * ⚠ THE SHAPE CHECK IS HERE TOO, so a caller cannot reach the query with something that is not an id
 * at all. It is a cheap refusal, not the authorization — see the note at the top of this file.
 */
export function isSessionOwnedByActiveAccount(sessionId: unknown): sessionId is string {
  if (!isSafeRowId(sessionId)) return false;
  try {
    const row = getDb()
      .prepare("SELECT 1 AS ok FROM chat_sessions WHERE id = ? AND user_id IS ?")
      .get(sessionId, activeUserId()) as { ok?: number } | undefined;
    return !!row;
  } catch {
    /**
     * ⚠ A FAILED LOOKUP IS A REFUSAL, NEVER A PASS. If the query itself cannot run — no database yet,
     * a migration mid-flight — the honest answer is "this is not established", and the alternative
     * (treating an error as ownership) would turn every transient fault into the hole this closes.
     */
    return false;
  }
}
