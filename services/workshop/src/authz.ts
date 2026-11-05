import type { Context } from "hono";
import { requireIdentity } from "@praimana/service-shared";
import type { Workshop } from "./domain.js";

/**
 * AUTHORIZATION for the Workshop service.
 *
 * Three DIFFERENT questions live in this service, and only one of them is its own:
 *
 *   1. "Do you own this workshop?" — the Workshop service owns the workshops table,
 *      so it answers that itself (see isOwnerOrAdmin in routes.ts).
 *   2. "Are you a MEMBER of this team?" — owned by the TEAM service (teamMembers).
 *      The per-team phase routes need it, so it is delegated through the narrow
 *      TeamAccess interface below (DIP), backed by an HTTP call to the Team
 *      service's own /teams/:id/access endpoint or an event-fed read-model.
 *   3. "Are you a member of ANY team in this workshop?" — also Team-owned, and the
 *      branch that lets a PARTICIPANT read the workshop they are building in. Same
 *      treatment: the narrow WorkshopMembership interface below.
 *
 * This mirrors ai/collaboration/evaluation/source, deliberately: five services now
 * ask the same question the same way, and a sixth copy is cheaper than a shared
 * package the bundled Lambdas would have to depend on.
 *
 * WorkshopMembership lives HERE rather than beside WorkshopStats in domain.ts even
 * though both are the same ask-don't-read seam, because this one is an AUTHORIZATION
 * dependency: a reader auditing what decides access should find every such
 * dependency in this file, next to TeamAccess, not split across two.
 */

/** Roles that may read but not write. Mirrors the monolith's READ_ONLY_ROLES. */
const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);

/** Team-access decisions the Workshop service must ASK the Team context for.
 *  Injected (DIP) so it can be an HTTP client or an event-fed read-model. */
/**
 * FOUR METHODS, TWO PAIRS, mirroring GET /v1/teams/:teamId/access exactly:
 *
 *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
 *                                    workshop, or ADMIN.
 *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
 *
 * The PER-TEAM PHASE routes are content routes — a team's phase notes are what they wrote
 * into the workshop — so they use the content pair. The workshop-level routes are not
 * team-scoped at all and use requireWorkshopRead further down this file.
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
 * ── WHICH EXPERIENCE A TEAM BELONGS TO — asked of the TEAM context, never read from its table ──
 *
 * Added to close the half of the phase-write finding that local bounds could not reach.
 * `PUT /workshops/teams/:teamId/phases/:phaseId` took `phaseId` from the path and wrote a row under
 * it with no validation, so a member could store notes under an id that names no phase. The merged
 * read iterates the WORKSHOP'S phases and looks each one up, so those rows are invisible to every
 * reader — work a member believes they saved and nobody can ever see.
 *
 * The phase TEMPLATE is this service's own data (`phases`, read locally). The missing link was
 * teamId → workshopId, which only Team can answer because it owns the `teams` table.
 *
 * ⚠ A SEPARATE PORT FROM `TeamAccess`, deliberately. That one answers four ACCESS questions and is
 * fail-CLOSED to a boolean: every failure is `false`, which is correct for "may you?" and useless
 * here, because "we could not find out which experience this is" must not be indistinguishable from
 * "it belongs to none". This port is three-valued for exactly that reason.
 *
 * ⚠ NO Team → Workshop → Team CYCLE, and this is not luck. The only caller is the phase WRITE, whose
 * guard (`requireTeamPhaseWrite`) already established the caller is a MEMBER of the team — and Team's
 * `/access` resolves a member from its own `teamMembers` row before it ever consults workshop
 * ownership, so it cannot ask us back. Staff can never reach this route at all: the member-only
 * requirement forbids them a membership row, so the branch that would hop into Workshop is unreachable here.
 */
export interface TeamWorkshop {
  /**
   * The id of the experience this team belongs to.
   *
   *   string         the team belongs to this experience.
   *   null           DETERMINED absence — the team is unknown to Team, or its `workshopId` has been
   *                  cleared. There is no phase template to validate against, so the caller refuses.
   *   "unavailable"  the hop could not be COMPLETED, or the callee is older than the `workshopId`
   *                  field. TRANSIENT, so the caller answers 503 + Retry-After rather than refusing a
   *                  legitimate save on the strength of an outage.
   */
  workshopIdOf(
    teamId: string,
    auth?: AuthContext
  ): Promise<string | null | "unavailable">;
}

/**
 * The Hono Context an east-west implementation needs in order to re-present the
 * CALLER's own Bearer token (see forwardedIdentityHeaders). Optional on the
 * interface so in-memory/read-model implementations — and tests — can ignore it.
 */
export type AuthContext = Context;

/**
 * "What platform role does this user hold?" — asked of the Identity service, which owns users.
 *
 * ⚠ ONE CALLER, AND IT IS AN ESCALATION GATE: ownership transfer. `isOwnerOrAdmin` is pure
 * ownership with no role check, so an experience transferred to a PARTICIPANT would make that
 * participant able to rename it, set its phases and reopen its submissions. This port is what
 * stops the recovery route being an escalation primitive. See `user-roles.http.ts`.
 *
 * THREE-VALUED: a role, `null` for a determined absence, `"unavailable"` when Identity
 * did not answer. The route maps the third to 503, never to a refusal.
 */
export interface UserRoles {
  roleOf(userId: string, auth?: AuthContext): Promise<string | null | "unavailable">;
}

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

/**
 * ── PHASE WRITE: the team's own planning notes, where an EXECUTIVE MAY take part ───────────
 *
 * A user holding the EXECUTIVE role could not update their team's ideation phase. The
 * requirement is that every team member must be able to add and update
 * phases, and to add and edit tasks on the board — so role alone must not gate a phase write.
 *
 * ⚠ THE BOARD HALF WAS ALREADY DONE. `collaboration/src/authz.ts`'s `requireTeamCollaborationWrite`
 * made exactly this grant for chat and tasks. Phases were the outlier, so this mirrors
 * that guard rather than inventing a second shape for the same decision.
 *
 * ⚠ WHY NOT SIMPLY RELAX `requireTeamContentWrite` ABOVE — measured before choosing, and it is the
 * whole reason this function exists. That predicate gates twelve routes across FOUR services:
 * six in `ai`, two in `evaluation`, two in `source` and two here. Relaxing it would also hand
 * executives the evaluation writes (submissions and SCORES) and the source/repository writes. An
 * executive writing judging scores is a competition-integrity problem, not a permissions
 * convenience. So the grant is made HERE, at the one route that is a team's own planning notes, and
 * nowhere else. `isReadOnlyRole` is untouched and every other service still refuses them.
 *
 * ⚠ MEMBERSHIP IS STILL THE WHOLE PROTECTION. `canReadContent` is pure membership of THIS team with
 * no role branch, so "executive" is not a licence to edit an arbitrary team's phases — only one they
 * belong to. A platform ADMIN or FACILITATOR still has no path here; they own the
 * workshop's phase TEMPLATE via `PUT /workshops/:workshopId/phases`, which remains owner-or-ADMIN.
 *
 * ⚠ WHAT IT COSTS, STATED PLAINLY: an executive can now overwrite what a team wrote about its own
 * work, and `editedById` records who did. That is a change to the team's working state, not just an
 * added voice — the same cost the board grant already accepted. The work PRODUCT (submissions,
 * scores, docs, commits) remains beyond them.
 */
export async function requireTeamPhaseWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  /**
   * Deliberately NOT `canWriteContent` — that predicate folds in the read-only refusal, which is
   * precisely the part being relaxed. Membership is checked with the READ predicate and the role rule
   * applied locally, so the two decisions stay separable and legible.
   */
  const isMember = await teamAccess.canReadContent(teamId, id, role, c);
  if (!isMember) return c.json({ error: "Forbidden" }, 403);

  // Every read-only role EXCEPT executive is still refused, so a read-only role added later does not
  // silently inherit this grant.
  if (isReadOnlyRole(role) && role !== "EXECUTIVE") {
    return c.json({ error: "Read-only role" }, 403);
  }

  return null;
}

// ─── Workshop READ authorization (P0-1, P1-3) ───────────────────────────────

/**
 * "Is this user a member of any team in this workshop?" — asked of the TEAM context,
 * which owns teamMembers, never answered by reading a foreign table.
 *
 * Injected (DIP) exactly like TeamAccess and WorkshopStats, so the composition root
 * can swap the HTTP client for an event-fed read-model — or, when the entitlement
 * store of the entitlement subsystem lands, so an entitlement lookup can be composed in front of
 * it — without any route changing.
 *
 * THREE-VALUED ON PURPOSE. `"unavailable"` is not the same as `false`, and collapsing
 * them is the mistake this interface exists to prevent: a dependency that timed out
 * has told us NOTHING, and reporting that as "you are not a member" produces a 403
 * that says "you don't have access" — a lie, and one that generates a support ticket
 * and trains operators to ignore permission complaints. Both are fail-closed; only
 * one is honest. See requireWorkshopRead, which maps it to 503.
 */
export interface WorkshopMembership {
  isMember(
    workshopId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean | "unavailable">;
}

/**
 * Convenience no-op membership source: nobody is a member, and it says so
 * definitively rather than reporting "unavailable".
 *
 * `false` and not `"unavailable"` because this is a CONFIGURATION choice, not a
 * failure: wiring it means "this deployment has no membership source", which is a
 * definite (if restrictive) answer. Reporting "unavailable" would 503 every
 * participant read and look like an incident forever. Mirrors ZeroWorkshopStats in
 * documenting the boundary rather than silently reading the teams table.
 */
export class NoWorkshopMembership implements WorkshopMembership {
  async isMember(): Promise<boolean | "unavailable"> {
    return false;
  }
}

export interface WorkshopEntitlements {
  listEntitledWorkshopIds(
    role: string,
    auth?: AuthContext
  ): Promise<{ workshopIds: string[]; truncated: boolean } | "unavailable">;
}

/**
 * No-op entitlement source: nobody is entitled to anything, said DEFINITIVELY.
 *
 * `{ workshopIds: [] }` and not `"unavailable"` for the same reason as
 * NoWorkshopMembership: wiring this is a CONFIGURATION choice ("this deployment has
 * no entitlement source"), which is a definite if restrictive answer. Reporting
 * "unavailable" would 503 every non-owner's workshop list forever and look like a
 * permanent incident.
 */
export class NoWorkshopEntitlements implements WorkshopEntitlements {
  async listEntitledWorkshopIds(): Promise<{
    workshopIds: string[];
    truncated: boolean;
  }> {
    return { workshopIds: [], truncated: false };
  }
}

/**
 * Guard for the workshop READ routes — the fix for P0-1 and P1-3.
 *
 * Until now GET /workshops/:id, /:id/assistants and /:workshopId/phases had NO
 * authorization: any signed-in caller who could name an id read the workshop's name,
 * description, `setupConfig` (repo + guide URLs), `aiModel` and status. Ids are not a
 * control — they leak through /invitations/mine, the admin filter and desktop
 * settings. All three routes are gated together, because gating only `/:id` moves the
 * hole rather than closing it: `/assistants` and `/phases` expose the same workshop
 * to the same caller.
 *
 * The predicate, and the ORDER IS THE DESIGN — every cheap local branch precedes the
 * one hop:
 *
 *   1. role === "ADMIN"            → allow IFF they own it. Decided from the row, never a hop.
 *   2. workshop.ownerId === caller → allow. Decided from the row already fetched.
 *   3. member of a team in W       → allow. ONE bounded hop, only when 1 and 2 miss.
 *   4. otherwise                   → 403.
 *
 * WHY 1 AND 2 MUST SHORT-CIRCUIT BEFORE THE HOP — this is a correctness constraint,
 * not a latency one. The Team service's HttpWorkshopAccess.ownsWorkshop resolves
 * workshop ownership by calling GET /v1/workshops/:id, i.e. THIS route. If this route
 * hopped into Team for a caller Team is currently asking about, you get
 * Team → Workshop → Team on one Lambda pool: self-amplifying under load, deadlocking
 * concurrency rather than degrading. Two things close it, and both are required:
 * ownsWorkshop only ever probes for ADMIN/FACILITATOR (the roles that can own a
 * workshop), and ADMIN and owner resolve here before any hop — so the ownership probe
 * cannot reach step 3. routes.test.ts asserts the injected dependency is NOT called
 * for either, so the invariant cannot regress silently.
 *
 * 503, NOT 403, when the hop cannot answer. See WorkshopMembership above. The body
 * carries `code: "MEMBERSHIP_UNAVAILABLE"` and a Retry-After so a client can tell a
 * denial from a brownout without string-matching the message.
 */
export async function requireWorkshopRead(
  c: Context,
  membership: WorkshopMembership,
  workshop: Workshop,
  entitlements: WorkshopEntitlements
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  // 1 + 2 — both local. No I/O beyond the row the caller already loaded.
  /**
   * ── ⚠ AN ADMIN READS THE EXPERIENCES THEY OWN, AND NO OTHERS ────────────────────────────────
   *
   * THE RULE: an admin sees no other experiences, scores or anything else they do not own. This was
   * `if (role === "ADMIN") return null` — a blanket allow on any experience by id, which also made this
   * route more generous than the LIST that leads to it: `GET /v1/workshops` has always sent an ADMIN
   * down `listByOwner(id)`, so an admin could never SEE another owner's experience in a list but could
   * open one by naming its id.
   *
   * ⚠ IT STILL RESOLVES LOCALLY IN BOTH DIRECTIONS, AND THAT IS A CORRECTNESS CONSTRAINT RATHER THAN AN
   * OPTIMISATION. Read the note above: Team's `HttpWorkshopAccess.ownsWorkshop` resolves ownership by
   * calling THIS route, so if an ADMIN fell through to step 3 the shape becomes
   * Team → Workshop → Team on one Lambda pool — "self-amplifying under load, deadlocking concurrency
   * rather than degrading". The invariant the note states is "ADMIN and owner resolve here before any
   * hop", and it is preserved exactly: an admin is now ALLOWED or REFUSED from the row already fetched.
   * Never a hop either way, so the cycle still cannot form.
   *
   * ⚠ 403 AND NOT 404. The row was found; the caller may not read it. A 404 would also leak less, but
   * this service already answers 403 for the owner-miss case below and two different answers for one
   * situation is how a client comes to depend on the distinction.
   */
  if (role === "ADMIN") {
    return workshop.ownerId === id ? null : c.json({ error: "Forbidden" }, 403);
  }
  if (workshop.ownerId && workshop.ownerId === id) return null;

  /**
   * ── ⚠ 3a — A JUDGE IS ENTITLED, NEVER A MEMBER: ENTITLEMENT REPLACES THE MEMBERSHIP HOP ────
   *
   * This is the "allow iff entitled" rule for the by-id read, which the matrix has promised all
   * along. It was rejected once for a specific reason — "it adds a second east-west hop to a route the
   * desktop calls three times during setup, with no circuit breaker anywhere in this repo" — and that
   * reason DOES NOT APPLY to a judge, which is why this lands narrowed to one role rather than opened
   * for the whole branch.
   *
   * ⚠ IT IS NOT A SECOND HOP. IT IS THE SAME HOP, ASKED OF SOMEONE WHO CAN ANSWER. `team/src/routes.ts`
   * enforces that "an ADMIN, FACILITATOR or JUDGE may NEVER hold a team-membership row" — a 400 on all
   * three write paths — so `membership.isMember` is guaranteed FALSE for a judge by invariant. The
   * previous code spent an east-west call to learn a foregone conclusion and then 403'd. This spends the
   * same one call on the question that decides the answer. Load is unchanged on this route and strictly
   * REDUCED on the list, where the probe ran once per candidate workshop.
   *
   * ⚠ THE SYMPTOM THIS FIXES. A JUDGE with an ACCEPTED invitation naming an experience saw an empty
   * list, and 403 on every route into it — so they could not reach the submissions they exist to score.
   *
   * ⚠ UNDETERMINED IS STILL A 503, NEVER A 403. Same rule the membership branch below applies and the
   * same reason: a probe that could not answer must not be reported as "you may not". A 403 here would
   * be the fail-closed-as-authorization-answer defect the failure semantics exist to prevent.
   *
   * ⚠ EXECUTIVE AND PARTICIPANT ARE DELIBERATELY NOT INCLUDED. They are `DERIVED` roles whose
   * entitlement comes THROUGH team membership, so for them the membership probe IS the real question and
   * this would be the extra hop the objection was about.
   */
  if (role === "JUDGE") {
    const entitled = await entitlements.listEntitledWorkshopIds(role, c);
    if (entitled === "unavailable") {
      c.header("Retry-After", "2");
      return c.json(
        {
          error: "Cannot verify workshop access right now — please retry",
          code: "ENTITLEMENTS_UNAVAILABLE",
        },
        503
      );
    }
    return entitled.workshopIds.includes(workshop.id)
      ? null
      : c.json({ error: "Forbidden" }, 403);
  }

  // 3b — the one hop, reached only on a miss above.
  const isMember = await membership.isMember(workshop.id, id, role, c);

  if (isMember === "unavailable") {
    // Retry-After is 2s to match the east-west deadline plus headroom: long enough
    // that a retry lands after a transient blip rather than adding to it.
    c.header("Retry-After", "2");
    return c.json(
      {
        error: "Cannot verify workshop access right now — please retry",
        code: "MEMBERSHIP_UNAVAILABLE",
      },
      503
    );
  }

  return isMember ? null : c.json({ error: "Forbidden" }, 403);
}
