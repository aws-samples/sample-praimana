/**
 * ── Vendored shared code — exactly the modules THE DESKTOP needs ───────────────────────────
 *
 * One of three peer copies of the shared sources (`desktop/shared`, `portal/shared`,
 * `services/shared`); there is no upstream. See `desktop/README.md` for why this is
 * a copy rather than a dependency, and for the drift check that keeps it honest.
 *
 * ⚠ THE SET WAS DERIVED, THEN VERIFIED BY THE TYPE CHECKER — not hand-picked. Mapping every
 * `@praimana/shared` import in `src/` to its defining module gave 8 modules; `pnpm type-check` then
 * found a 9th, because `src/renderer/lib/instants.ts` uses `export { … } from "@praimana/shared"` and a
 * scan for `import` statements does not see a RE-EXPORT. The type checker is the only authority on this
 * question; it now passes, which is what makes the set provably closed.
 *
 * ⚠ AND IT IS DELIBERATELY LARGER THAN THE THREE-WAY INTERSECTION. An earlier pass vendored only what all of
 * desktop, portal and services share (phase-progress, support, types/user). That is the right set for a
 * package everyone depends on and the wrong one for a copy: the desktop alone also needs phase-links,
 * desktop-link, message-time, auth-flow, chat-limits and cognito-pool. Vendoring is per-consumer by
 * definition — the portal's and the services' copies will each be a different shape.
 */
export * from "./constants/auth-flow";
export * from "./constants/chat-limits";
export * from "./constants/cognito-pool";
export * from "./constants/desktop-link";
export * from "./constants/message-time";
export * from "./constants/phase-links";
export * from "./constants/phase-progress";
export * from "./constants/support";
export * from "./types/user";
