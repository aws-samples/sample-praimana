import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "./root";

export const trpc = createTRPCReact<AppRouter>();

/**
 * What each procedure RETURNS, derived from the router rather than restated.
 *
 * A component that renders `workshop.getById`'s result needs a name for that shape when it
 * passes a slice of it to a child. Before the backend responses were typed there was nothing to
 * name, the procedures' outputs were `any` all the way from `res.json()`, so ~30 props across
 * the workspace and experience screens were annotated `any`, which is most of what
 * `eslint.config.mjs` downgraded `no-explicit-any` to `warn` for.
 *
 * ⚠ DERIVED, NEVER HAND-WRITTEN. `RouterOutputs["workshop"]["getById"]` IS the procedure's return
 * type: change what the router returns and every consumer's type changes with it, so a field
 * removed in the BFF is a compile error in the page rather than an `undefined` at runtime. A
 * hand-maintained interface beside it would be a second source of truth that drifts silently -
 * exactly the failure the vendored `shared/` copies have a whole README section about.
 *
 * Usage: `type Workshop = RouterOutputs["workshop"]["getById"]`, then index into it for nested
 * shapes, `Workshop["teams"][number]` for one row of the teams list.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;
