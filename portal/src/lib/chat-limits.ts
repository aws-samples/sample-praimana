/**
 * ⚠ MOVED TO `@praimana/shared`. This file is a RE-EXPORT, not an implementation.
 *
 * The desktop composers need the same ceilings, and two copies of a length limit is how a client
 * that truncates at 4,096 ends up talking to a server that refuses at 4,000. Kept as a re-export
 * rather than deleted so the portal's existing import sites stay valid; new code should import from
 * `@praimana/shared` directly.
 *
 * Same pattern, and the same reason, as `lib/auth-flow.ts`.
 */
export { MAX_TEAM_MESSAGE_CHARS, MAX_AI_PROMPT_CHARS, SHOW_REMAINING_WITHIN } from "@praimana/shared";
