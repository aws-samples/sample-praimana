import type { Context } from "hono";
import { requireIdentity } from "@praimana/service-shared";

/**
 * AUTHORIZATION for the Source service (authN already happened at the gateway).
 *
 * IMPORTANT boundary note: "is this user a MEMBER of this team?" is owned by the
 * TEAM service (it owns teamMembers), NOT by the Source service. In a fully
 * decomposed world the Source service answers that question one of two ways:
 *
 *   (a) call the Team service's `/teams/:id/access` endpoint (synchronous), or
 *   (b) keep a team-membership read-model fed by Team's `member.joined`/`member.left`
 *       events (asynchronous, no hot-path call).
 *
 * Both are injected via an interface so the route code doesn't care which. This
 * file defines that interface + a simple read-only-role check the Source service
 * CAN decide on its own (it knows the caller's role from the edge identity).
 */

/** Roles that may read but not write. Mirrors the monolith's READ_ONLY_ROLES;
 *  in the real cutover this comes from @praimana/shared. */
const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);

/** Team-access decisions the Source service must ASK the Team context for. Injected
 *  (DIP) so it can be an HTTP client or an event-fed read-model. */
/**
 * FOUR METHODS, TWO PAIRS, mirroring GET /v1/teams/:teamId/access exactly:
 *
 *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
 *                                    workshop, or ADMIN.
 *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
 *
 * EVERY ROUTE IN THIS SERVICE IS A CONTENT ROUTE: commits, commit detail and the
 * aggregated per-file contribution view are all the team's own work product, so the
 * content pair is what routes.ts uses.
 */
export interface TeamAccess {
  canRead(teamId: string, userId: string, role: string, auth?: AuthContext): Promise<boolean>;
  canWrite(teamId: string, userId: string, role: string, auth?: AuthContext): Promise<boolean>;
  /** May the caller read what this team AUTHORED? Membership only — no role branch. */
  canReadContent(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean>;
  /** Content read AND not a read-only role. */
  canWriteContent(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean>;
}

/**
 * The Hono Context an east-west implementation needs in order to re-present the
 * CALLER's own Bearer token (see forwardedIdentityHeaders). Optional on the
 * interface so in-memory/read-model implementations — and tests — can ignore it.
 */
export type AuthContext = Context;

export function isReadOnlyRole(role: string): boolean {
  return READ_ONLY_ROLES.has(role);
}

/** Guard: caller must be able to read the team (ADMINISTRATION scope). Returns a
 *  Response to short-circuit with, or null to proceed. */
export async function requireTeamRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const ok = await teamAccess.canRead(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

/** Guard: caller must be able to write the team (ADMINISTRATION scope: readable AND not
 *  a read-only role). */
export async function requireTeamWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) return c.json({ error: "Read-only role" }, 403);
  const ok = await teamAccess.canWrite(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

// ─── TEAM CONTENT: member-only ───────────────────────────────

/**
 * Guard: caller must be a MEMBER of the team to read its CONTENT.
 *
 * Distinct from requireTeamRead, which an ADMIN and a workshop-owning FACILITATOR both
 * pass. Team-authored content is the team's own, so a non-member gets 403 whatever their
 * platform role.
 *
 * FAIL-CLOSED IS INHERITED, not re-implemented: HttpTeamAccess reads a non-2xx, a timeout,
 * a connect error, a non-JSON body and an ABSENT FIELD all as false. So a Team service that
 * is down, slow, or older than this consumer 403s a content read — never 200s it.
 */
export async function requireTeamContentRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

/** Guard: caller must be a MEMBER and not a read-only role to write the team's CONTENT.
 *  The read-only check is local and first, so an EXECUTIVE costs no east-west hop. */
export async function requireTeamContentWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) return c.json({ error: "Read-only role" }, 403);
  const ok = await teamAccess.canWriteContent(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}
