// ── WHICH SHARED THREADS THE TEAM LIST SHOWS ─────────────────────────────────────────────────
//
// The AI service returns EVERY chat shared with the team, including ones the current account shared.
// The Team Chats list is for reading what OTHER people are doing — your own shared chat is already
// under "Chats", so echoing it back in the team list is noise. This drops the caller's own rows.
//
// Pure and tiny on purpose: the "is this mine" rule is the thing worth asserting, and the IPC handler
// that uses it (`share:getSharedThreads`) is not unit-testable without an Electron harness. See
// active-account.ts / pane-pin.ts for the same "name the pure decision, test it directly" shape.

/** A shared-thread row as far as this filter cares: it may carry the id of whoever shared it. */
interface MaybeOwned {
  sharedById?: unknown;
}

/**
 * Return only the threads NOT shared by `me`.
 *
 * @param threads  the server's shared-thread rows for the team.
 * @param me        the active local account's user id (the Cognito sub), or null when signed out.
 *
 * ⚠ A NULL `me` FILTERS NOTHING. Signed out, or an id we cannot determine, means we cannot say which
 * rows are "mine" — so every row is shown rather than guessing one belongs to the caller and hiding
 * it. The alternative (hide everything, or hide rows with no `sharedById`) would drop legitimate
 * teammates' chats.
 *
 * ⚠ A ROW WITH NO STRING `sharedById` IS KEPT. Legacy rows shared before the field was written carry
 * no sharer id; they are other people's chats far more often than the caller's, and there is no
 * identity to match them against, so they stay in the list.
 */
export function excludeOwnThreads<T extends MaybeOwned>(threads: T[], me: string | null): T[] {
  if (me == null) return threads;
  return threads.filter(
    (t) => !(typeof t.sharedById === "string" && t.sharedById === me)
  );
}
