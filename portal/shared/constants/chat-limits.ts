// ── HOW LONG A MESSAGE MAY BE ─────────────────────────────────────────────────────────────
//
// ⚠ ONE TEXT, THREE COPIES, BYTE-IDENTICAL. This module is copied verbatim into
// `desktop/shared/`, `portal/shared/` and `services/shared/`, the same way `constants/support.ts`
// and `constants/phase-progress.ts` are — those two are byte-identical across all three copies
// today and this one now is too. `index.ts` differs per copy, because each exports the subset it
// uses; the constant modules do not. If you edit this file, edit all three.
//
// ⚠ THE SERVER-SIDE BOUND IS ALWAYS THE REAL ONE. A `maxLength` on a textarea is a courtesy that
// stops someone pasting a file into a chat box; it is not a control, because the desktop and any
// other client can simply not honour it. These constants exist so the courtesy and the rule are the
// SAME NUMBER, not so the client can be trusted.

/**
 * 4,000 characters for a TEAM chat message.
 *
 * Not raised while making it visible: this is team CHAT, and the platform already has better homes
 * for anything longer — a doc, a task description, an AI thread. A limit somebody bumps because one
 * message hit it is how a chat table starts holding documents.
 *
 * ── ⚠ NOW ENFORCED IN THE SERVICE TOO, WHICH IS WHY THIS FILE IS HERE ─────────────────────────
 *
 * This comment used to read "ENFORCED IN tRPC, NOT IN THE SERVICE… that service still stores
 * `content: body.content` with no length check. Backlog 8d. Until that lands, this constant makes
 * the desktop WELL-BEHAVED rather than CONSTRAINED." Backlog 8d has landed: the collaboration
 * service's POST /v1/teams/:teamId/messages now refuses a non-string, an empty string, and anything
 * over this ceiling — the team-chat write path previously applied no server-side schema or size bound.
 *
 * ⚠ AND THAT IS WHAT MAKES DRIFT DANGEROUS FOR THE FIRST TIME. While only the portal enforced it, a
 * client that raised its own copy was merely generous — nothing disagreed. Now a client that
 * truncates at 4,096 talks to a server that refuses at 4,000, which is the exact failure the header
 * of this file warns about. The service imports this constant rather than carrying its own literal,
 * so there is one number and not three.
 */
export const MAX_TEAM_MESSAGE_CHARS = 4000;

/**
 * 100,000 characters for an AI PROMPT.
 *
 * ⚠ THIS NUMBER IS NOT CHOSEN — IT MIRRORS THE SERVER'S. `MAX_SYNC_CONTENT` in the ai service's
 * `routes.ts` is a per-message ceiling of 100_000, and the AI service REJECTS rather than truncates
 * a turn that exceeds it. So a prompt longer than this is one the participant can type, send, watch
 * the assistant answer, and then lose from the transcript — the failure is invisible at the moment
 * it happens and discovered later, which is the worst shape available.
 *
 * Matching it exactly means the composer refuses precisely what the server would refuse. A smaller
 * client cap would forbid prompts the platform can store; a larger one would allow prompts it
 * cannot. `chat-limits.drift.test.ts` asserts the two stay equal, because they are two numbers that
 * must agree and nothing else makes them.
 *
 * ⚠ AND IT IS DELIBERATELY NOT 4,000. An AI prompt is not a chat message: pasting a stack trace, a
 * diff or a config file into an assistant is the normal use of one, and the AI service's own comment
 * says as much ("a CLI turn can legitimately be long — a pasted diff, a stack trace"). Sharing the
 * team-chat limit would have crippled the assistant to keep one constant.
 */
export const MAX_AI_PROMPT_CHARS = 100_000;

/**
 * When to start showing the remaining count.
 *
 * ⚠ NOT ALWAYS VISIBLE. A permanent counter on every message box tells the 99% of messages that are
 * one line long that they are being measured. It appears only once the limit is close enough to
 * matter, which is the only moment the number is information rather than noise.
 *
 * The same threshold serves both limits: 200 characters is about two lines of typing either way, so
 * the warning arrives with the same amount of runway whether the ceiling is 4,000 or 100,000.
 */
export const SHOW_REMAINING_WITHIN = 200;
