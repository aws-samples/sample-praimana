/**
 * ── TRIMMING AN OVERSIZED ASSISTANT REPLY FOR THE SYNC PAYLOAD ─────────────────────────────────
 *
 * ⚠ WHAT THIS FIXES IS SILENT LOSS, NOT SIZE. The AI service REJECTS a sync whose message exceeds
 * `MAX_SYNC_CONTENT` (100,000 chars) — `ai/src/routes.ts` answers 400 "message too long" and says so
 * deliberately: "rejected rather than truncated", because a server quietly altering a participant's
 * transcript is worse than refusing it. The consequence on this side is that a long agentic turn never
 * reached DynamoDB at all. The turn was fine, the local transcript was fine, and the platform simply
 * had no record of it — so facilitator dashboards under-counted exactly the longest pieces of work.
 *
 * Trimming here is the client deciding what it can honestly send. The server keeps refusing anything
 * over its ceiling, which is the right division: the server does not mutate, the client chooses.
 *
 * ⚠ THE LOCAL TRANSCRIPT IS NEVER TRIMMED. `chat_messages` in SQLite keeps the full reply; this runs
 * only on the payload built in cli-sync.ts. A participant scrolling their own chat sees everything.
 * That is why the marker below names where the full text is — someone reading the trimmed copy in the
 * portal needs to know it exists somewhere rather than assuming it was lost.
 *
 * ⚠ FIRST AND LAST, NOT THE FIRST N CHARACTERS. A truncated-at-the-front reply keeps the preamble and
 * loses the conclusion, which is usually the part that matters — the summary, the final diff, the
 * answer. Keeping both ends preserves what a reader actually uses and makes the omission obvious.
 */

/**
 * Ceiling for a synced message, in characters.
 *
 * ⚠ DELIBERATELY BELOW THE SERVER'S 100,000, NOT EQUAL TO IT. `services/collaboration/src/routes.ts`
 * records the failure this margin avoids: "a client truncating at 4,096 against a server refusing at
 * 4,000 is precisely the failure that module's header warns about". Two independently-maintained
 * numbers that are supposed to be identical eventually are not, and the boundary case is the one that
 * breaks. Trimming to 90,000 means a drift of up to 10,000 characters still syncs.
 *
 * ⚠ IT IS STILL A DUPLICATED CONSTANT, and that is worth stating rather than hiding. The canonical fix
 * is a single `MAX_SYNC_MESSAGE_CHARS` in `shared/constants/chat-limits.ts`, imported by this file and
 * by the service's rejection — the treatment `MAX_TEAM_MESSAGE_CHARS` already got. That was not done
 * here because `shared/` is vendored into three repos with a build-time drift assertion, so promoting a
 * constant is a four-repo change. The margin above is what makes this safe in the meantime.
 */
export const MAX_SYNCED_MESSAGE_CHARS = 90_000;

/** Lines kept from the start of an over-long reply. */
export const TRIM_HEAD_LINES = 40;

/** Lines kept from the end. Larger than the head because the conclusion is usually the payload. */
export const TRIM_TAIL_LINES = 60;

/**
 * Trim `content` for syncing, keeping its first and last lines with a marker in between.
 *
 * Returns the original string unchanged when it is within the ceiling, so the common case is
 * byte-identical and callers need no condition of their own.
 */
export function trimForSync(
  content: string,
  limit: number = MAX_SYNCED_MESSAGE_CHARS
): { content: string; trimmed: boolean; removedChars: number; removedLines: number } {
  if (typeof content !== "string" || content.length <= limit) {
    return { content, trimmed: false, removedChars: 0, removedLines: 0 };
  }

  const lines = content.split("\n");

  /**
   * ⚠ A SINGLE ENORMOUS LINE HAS TO BE HANDLED, and it is the case a line-based trim quietly gets
   * wrong. Minified output, a base64 blob or a one-line JSON dump is one "line" of 200,000 characters:
   * keeping 40 head lines and 60 tail lines would keep the whole thing and return something still over
   * the limit, so the sync would fail exactly as before while reporting success here. When the line
   * count cannot help, fall back to slicing characters from each end.
   */
  if (lines.length <= TRIM_HEAD_LINES + TRIM_TAIL_LINES) {
    return { ...sliceEnds(content, limit, 0), trimmed: true };
  }

  const head = lines.slice(0, TRIM_HEAD_LINES);
  const tail = lines.slice(-TRIM_TAIL_LINES);
  const removedLines = lines.length - head.length - tail.length;
  const kept = head.join("\n").length + tail.join("\n").length;
  const removedChars = content.length - kept;

  const out = head.join("\n") + trimMarker(removedChars, removedLines) + tail.join("\n");

  /**
   * ⚠ THE LINE TRIM CAN STILL COME OUT OVER THE LIMIT — 100 kept lines are not necessarily short. The
   * character fallback then applies to the already-trimmed text, so the return value is guaranteed to
   * satisfy the ceiling rather than merely usually satisfying it. A function that promises a bound has
   * to hold it for every input, not the expected ones.
   */
  if (out.length > limit) {
    return { ...sliceEnds(content, limit, removedLines), trimmed: true };
  }

  return { content: out, trimmed: true, removedChars, removedLines };
}

/**
 * Character-level fallback: keep both ends and guarantee the result fits.
 *
 * ⚠ THE BUDGET IS COMPUTED FROM THE ACTUAL MARKER, not from a guessed reserve. The first version
 * reserved 200 characters for it, the marker is ~350, and the function returned 90,135 against a
 * 90,000 ceiling — over the limit while reporting success, which is the whole failure it exists to
 * prevent. The marker is built first and the halves are sized from what is left.
 */
function sliceEnds(
  content: string,
  limit: number,
  removedLines: number
): { content: string; removedChars: number; removedLines: number } {
  // Built once to measure it. The counts inside it shift by a few characters when the slice changes,
  // so `budget` subtracts a small allowance rather than assuming the length is final.
  const probe = trimMarker(content.length, removedLines);
  const budget = Math.max(0, limit - probe.length - 32);
  const half = Math.floor(budget / 2);

  const head = content.slice(0, half);
  const tail = half > 0 ? content.slice(content.length - half) : "";
  const removedChars = content.length - head.length - tail.length;

  const out = head + trimMarker(removedChars, removedLines) + tail;
  /* Belt and braces: if the rebuilt marker still pushed it over, hard-cut to the ceiling. */
  return {
    content: out.length > limit ? out.slice(0, limit) : out,
    removedChars,
    removedLines,
  };
}

/**
 * The inserted notice.
 *
 * Says what was removed AND where the whole thing still is. "[trimmed]" alone would leave a reader
 * unable to tell a shortened reply from a reply that was genuinely that short, or from data loss.
 */
function trimMarker(removedChars: number, removedLines: number): string {
  const what =
    removedLines > 0
      ? `${removedLines.toLocaleString()} lines (${removedChars.toLocaleString()} characters)`
      : `${removedChars.toLocaleString()} characters`;
  return (
    `\n\n─────── ⚠ ${what} trimmed for sync ───────\n` +
    `The full response is kept in the participant's local transcript on their machine.\n` +
    `Only this shortened copy was sent to the platform, because the original exceeded the\n` +
    `sync size limit and would otherwise not have been recorded at all.\n` +
    `───────────────────────────────────────────\n\n`
  );
}
