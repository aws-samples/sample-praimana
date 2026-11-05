import type { Context } from "hono";
import { requireIdentity } from "@praimana/service-shared";

/**
 * AUTHORIZATION for the Collaboration service (authN already happened at the gateway).
 *
 * IMPORTANT boundary note: "is this user a MEMBER of this team?" is owned by the
 * TEAM service (it owns teamMembers), NOT by the Collaboration service. In a fully
 * decomposed world the Collaboration service answers that question one of two ways:
 *
 *   (a) call the Team service's `/teams/:id/access` endpoint (synchronous), or
 *   (b) keep a team-membership read-model fed by Team's `member.joined`/`member.left`
 *       events (asynchronous, no hot-path call).
 *
 * Both are injected via an interface so the route code doesn't care which. This
 * file defines that interface + a simple read-only-role check the Collaboration
 * service CAN decide on its own (it knows the caller's role from the edge identity).
 */

/** Roles that may read but not write. Mirrors the monolith's READ_ONLY_ROLES;
 *  in the real cutover this comes from @praimana/shared. */
const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);

/**
 * Team-access decisions the Collaboration service must ASK the Team context for.
 * Injected (DIP) so it can be an HTTP client or an event-fed read-model.
 *
 * FOUR METHODS, TWO PAIRS, mirroring GET /v1/teams/:teamId/access exactly:
 *
 *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
 *                                    workshop, or ADMIN.
 *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
 *
 * EVERY ROUTE IN THIS SERVICE IS A CONTENT ROUTE — tasks are the team's board and
 * messages are the team's chat — so the content pair is what routes.ts uses. The
 * administration pair stays on the interface because the WebSocket layer and any future
 * non-content surface need the vocabulary, and because dropping it would silently make
 * `requireTeamRead` mean something new rather than making its call sites choose.
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

// ─── TEAM CONTENT: member-only ───────────────────────────────────

/**
 * Guard: caller must be a MEMBER of the team to read its CONTENT.
 *
 * Distinct from requireTeamRead, which an ADMIN and a workshop-owning FACILITATOR both
 * pass. A team's board and chat are the team's own work and this service's routes are all
 * content routes, so this is the guard they use.
 *
 * FAIL-CLOSED IS INHERITED, not re-implemented: HttpTeamAccess reads a non-2xx, a timeout,
 * a connect error, a non-JSON body and an ABSENT FIELD all as false. So a Team service
 * that is down, slow, or older than this consumer 403s a content read — never 200s it.
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

/**
 * ── COLLABORATION WRITE: chat and the board, where an EXECUTIVE MAY take part ─────────────
 *
 * An executive may take part in the team's chat on the portal, scoped to **chat and the task
 * board** and nothing else.
 *
 * ⚠ WHY A DEDICATED GUARD RATHER THAN REMOVING EXECUTIVE FROM `READ_ONLY_ROLES` — the same
 * reasoning `ai/src/authz.ts` already recorded when it faced this exact wall for AI insights, and
 * it was measured before choosing:
 *
 * That constant gates ~34 write routes across SEVEN services. Widening it would also hand
 * executives `POST /submissions/:id/scores` (JUDGING SCORES), `POST /teams/:id/submissions`,
 * `POST /teams/:id/ratings`, the docs upload routes and `POST /teams/:id/commits`. An executive
 * writing judging scores is a competition-integrity problem, not a permissions convenience — so the
 * grant is made HERE, at the three routes that are actually conversation and planning, and nowhere
 * else. `READ_ONLY_ROLES` is untouched and every other service still refuses them.
 *
 * ⚠ MEMBERSHIP IS STILL REQUIRED, AND IS THE WHOLE PROTECTION. `canReadContent` is pure membership
 * of THIS team — no role branch — so "executive" is not a licence to post into an arbitrary team's
 * chat, only into one they belong to. A platform ADMIN or FACILITATOR still has no path here at all,
 * and that is deliberate: they are the roles this codebase deliberately excludes from
 * team content.
 *
 * ⚠ WHAT THIS DOES COST, STATED PLAINLY: EXECUTIVE is no longer a purely read-only role. An
 * executive can now alter the team's BOARD — create and move tasks — which is a change to the team's
 * working state, not just an added voice. That was an explicit choice over chat-only. The
 * team's work PRODUCT (submissions, scores, docs, commits) remains beyond them.
 */
export async function requireTeamCollaborationWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  /**
   * Deliberately NOT `canWriteContent` — that predicate folds in the read-only refusal, which is
   * precisely the part being relaxed here. Membership is checked with the READ predicate and the
   * role rule is applied locally, so the two decisions stay separable and legible.
   */
  const isMember = await teamAccess.canReadContent(teamId, id, role, c);
  if (!isMember) return c.json({ error: "Forbidden" }, 403);

  // Every read-only role EXCEPT executive is still refused, so adding another read-only role later
  // does not silently inherit this grant.
  if (isReadOnlyRole(role) && role !== "EXECUTIVE") {
    return c.json({ error: "Read-only role" }, 403);
  }

  return null;
}
