/**
 * ── @praimana/shared — ONLY what desktop, portal AND services all use ────────────────
 *
 * One of three peer copies of the shared sources (`desktop/shared`, `portal/shared`,
 * `services/shared`); there is no upstream. This copy is deliberately the smallest: it holds the
 * THREE-WAY INTERSECTION, not everything that was ever called "shared".
 *
 * ⚠ THAT WAS 3 MODULES OUT OF 25 — FOUR NOW, see `chat-limits` below. The other shared modules serve one or two consumers, not all three:
 *
 *   desktop + portal only   — desktop-link, phase-links
 *   portal + services only  — profile, roles, scoring
 *   portal only             — assistants, message-time, phases, types/audit
 *   desktop only            — auth-flow, cognito-pool
 *   nothing (unreferenced)  — constants/teams, and types/{message,phase,socket-events,submission,task,
 *                             team,workshop} — imported internally or by no consumer at all
 *
 * Measured by mapping every exported symbol to the files that import it across the desktop, portal
 * and service source trees, not by reading names and guessing. Every import in those
 * trees is a NAMED import, so the mapping is exact.
 *
 * ⚠ WHY THE INTERSECTION, because it is the useful finding rather than a curiosity: a single
 * "shared" package consumed by all three would carry, for most of its contents, code that only one of them
 * needs — and every consumer would then rebuild and re-release on changes that cannot affect it. The
 * groupings above are the natural seams if this is ever divided further.
 *
 * ── WHAT IS HERE ──
 *
 *   phase-progress — the first-phase word gate (MIN_FIRST_PHASE_WORDS, countWords, isPhaseNotesUnlocked).
 *                    Shared because the desktop enforces it, the portal documents it, and the identity
 *                    service reuses `countWords` for report bounds — one definition of "how many words is
 *                    that" for all three.
 *   support        — reporting a bug or giving feedback: the labels, the two kinds, and the word/character
 *                    bounds both forms and the service validate against.
 *   types/user     — the platform roles and the predicates over them (canManageUsers lives in `roles`, but
 *                    the role TYPE and the desktop/staff-screen gates are here).
 *
 * ⚠ THIS BARREL IS TRIMMED TO MATCH. A barrel re-exporting all 25 modules would reference files that are
 * deliberately absent here and fail to resolve on the first import.
 */
/**
 * ── ⚠ PROMOTED FROM "desktop only" TO THE INTERSECTION ──────────────────────────────────────
 *
 * `chat-limits` was classified above as serving the desktop alone, and that was correct when the
 * classification was made: the portal enforced `MAX_TEAM_MESSAGE_CHARS` in its zod schema, the
 * desktop counted against it in its composer, and the collaboration service enforced NOTHING —
 * that file's own comment said so ("ENFORCED IN tRPC, NOT IN THE SERVICE… Backlog 8d").
 *
 * The service now enforces it (the team-chat write path previously applied no server-side schema or
 * size bound), so all three consumers need the number and this is a genuine
 * three-way constant. It arrived here as a LITERAL 4000 in the collaboration route, with a comment
 * admitting the duplication and pointing at this barrel — this replaces that.
 *
 * ⚠ AND THE DUPLICATION WAS NEWLY DANGEROUS RATHER THAN MERELY UNTIDY. While only the portal
 * enforced the limit, a client copy that drifted upward was harmless. With the server refusing at
 * 4,000, a client truncating at 4,096 is the exact failure this module's header warns about.
 */
export * from "./constants/chat-limits";
export * from "./constants/phase-progress";
export * from "./constants/support";
export * from "./types/user";
