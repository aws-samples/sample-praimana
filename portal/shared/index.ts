/**
 * ── Vendored shared code — exactly the modules THE PORTAL needs ────────────────────────────
 *
 * One of three peer copies of the shared sources (`desktop/shared`, `portal/shared`,
 * `services/shared`); there is no upstream. See `portal/README.md` for why this
 * is a copy rather than a dependency, and for the drift check that keeps it honest.
 *
 * ⚠ THE SET WAS DERIVED, THEN VERIFIED BY THE TYPE CHECKER — not hand-picked. Every
 * `@praimana/shared` import in `src/` was mapped to its defining module (90 distinct symbols across
 * 13 modules), then closed transitively over those modules' own relative imports — which is what pulls in
 * `types/phase` and `types/team`, imported by nothing in `src/` directly and required all the same.
 *
 * ⚠ AND `constants/auth-flow` IS HERE BECAUSE OF A RE-EXPORT, NOT AN IMPORT. `src/lib/auth-flow.ts` is
 * `export * from "@praimana/shared"`, so a scan for `import` statements does not see the symbols
 * `AuthFlow.tsx` and `profile/page.tsx` reach through it. The desktop's copy hit the same trap on
 * `instants.ts`. The type checker is the only authority on this question; `pnpm type-check` passes, which
 * is what makes the set provably closed.
 *
 * ⚠ IT IS DELIBERATELY LARGER THAN BOTH THE THREE-WAY INTERSECTION AND THE DESKTOP'S COPY. Vendoring is
 * per-consumer by definition: the portal is the only consumer that renders the admin screens, the profile
 * form, the assistant catalog and the judging scale, so it is the only one that needs `roles`, `profile`,
 * `assistants`, `scoring`, `phases` and `types/audit`.
 *
 * ⚠ WHAT WAS LEFT OUT, AND WHY — so the absences are decisions rather than oversights:
 *   · `constants/cognito-pool` — the DESKTOP resolves its pool's endpoints from AWS discovery; the portal
 *     reads its pool from env vars (`NEXT_PUBLIC_COGNITO_*`) and never imports this.
 *   · `constants/teams`, `types/message`, `types/socket-events`, `types/submission`, `types/task`,
 *     `types/workshop` — no import in `src/` resolves to them. The portal's tRPC routers type these
 *     payloads locally.
 *   · `chat-limits.drift.test.ts` — the ONE test not copied with its module. It reads
 *     the AI service's `routes.ts` to prove `MAX_AI_PROMPT_CHARS` still equals the AI service's
 *     `MAX_SYNC_CONTENT`, so it lives beside that file, at `services/ai/src/chat-limits.drift.test.ts`,
 *     where both ends are visible — not here behind a relative path that cannot resolve.
 *     The desktop's copy omits it for the same reason.
 */
export * from "./constants/assistants";
// The auth state machine + error copy, shared by the portal's and the desktop's sign-in forms.
// ⚠ Drift here is a security event — `authErrorMessage` carries an account-enumeration control.
export * from "./constants/auth-flow";
export * from "./constants/chat-limits";
// The portal→desktop connect link (one-time code + the two URLs). The portal BUILDS it and the desktop
// PARSES it, so a drifting parameter name is a silent breakage between the two apps.
export * from "./constants/desktop-link";
// "Today 14:32" / "Yesterday 09:15" / "Fri 8 Aug 14:32" — the ONE rule both front-ends render a stored
// timestamp with. Consolidated from four divergent copies.
export * from "./constants/message-time";
// The Demo phase's two labelled URLs encoded into ONE stored `content` string. `isSafeHttpUrl` is a
// SECURITY control here, not a nicety: it is what stops a stored `javascript:` URL becoming an href.
export * from "./constants/phase-links";
// The first phase must be written up (MIN_FIRST_PHASE_WORDS) before a team can open the later ones. ⚠ A WORKFLOW GATE,
// NOT A SECURITY BOUNDARY — the module header explains why the service deliberately does not enforce it.
export * from "./constants/phase-progress";
export * from "./constants/phases";
export * from "./constants/profile";
// The platform roles, ROLE_GRANTS and the predicates behind every Administration gate in `src/app/admin`.
export * from "./constants/roles";
// The 1–10 judging scale, the four criteria, and the predicate a score must satisfy. Shared because the
// scoring FORM and the scoring ROUTE must refuse the same inputs.
export * from "./constants/scoring";
// "Report a bug" / "Give feedback" — the labels, kinds and word/character bounds behind the two
// profile-menu entry points. Reports are stored by the service, not composed as `mailto:` links.
export * from "./constants/support";
export * from "./types/audit";
export * from "./types/phase";
export * from "./types/team";
export * from "./types/user";
