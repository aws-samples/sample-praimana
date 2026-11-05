// Pure helpers for resuming a Kiro ACP conversation. ACP has no native resume:
// a freshly spawned client starts a brand-new conversation with zero history.
// After an app restart we replay the session's prior messages as a preamble to
// the first prompt so the agent regains context (e.g. a spec-driven workflow the
// team had underway). Kept dependency-free (no electron/db) so it's unit-testable.

export interface ReplayMessage {
  role: string;
  content: string;
}

// Cap how much prior conversation we replay so a long session doesn't blow the
// prompt. Most-recent messages matter most for resuming a workflow.
export const REPLAY_MAX_MESSAGES = 40;
export const REPLAY_MAX_CHARS = 24_000;

/**
 * Format a context preamble from prior messages (oldest→newest). Keeps the most
 * recent messages within both caps. Returns "" when there's nothing to replay.
 */
export function formatHistoryPreamble(rows: ReplayMessage[]): string {
  if (rows.length === 0) return "";

  // Keep the most recent messages within both caps.
  let recent = rows.slice(-REPLAY_MAX_MESSAGES);
  let total = recent.reduce((n, m) => n + m.content.length, 0);
  while (recent.length > 1 && total > REPLAY_MAX_CHARS) {
    total -= recent[0].content.length;
    recent = recent.slice(1);
  }

  const transcript = recent
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  return (
    "[Context resumed from a previous session — this is the prior conversation " +
    "transcript, not a new request. Use it to restore your state (including any " +
    "in-progress workflow) before responding to the new message that " +
    "follows.]\n\n" +
    transcript +
    "\n\n[End of resumed transcript. The user's new message follows:]\n\n"
  );
}
