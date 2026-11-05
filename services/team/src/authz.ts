import type { Context } from "hono";
import { requireIdentity } from "@praimana/service-shared";
import type { TeamMemberRepository } from "./domain.js";

/**
 * AUTHORIZATION for the Team service (authN already happened at the gateway).
 *
 * The Team service OWNS team membership (it owns teamMembers), so unlike the AI
 * service it answers "is this user a member?" from its own data. What it does NOT
 * own is "does this user own the workshop this team belongs to?" — that is the
 * WORKSHOP context's data. So workshop-ownership is injected via a narrow
 * WorkshopAccess interface (DIP), backed by an HTTP call to the Workshop service.
 *
 * ── TWO PREDICATE FAMILIES, AND THE SPLIT IS THE WHOLE POINT ──
 *
 * ADMINISTRATION — canRead / canWrite / requireTeamRead / requireTeamWrite:
 *   canRead  = member OF the team  OR  owns the workshop (staff)  OR  ADMIN
 *   canWrite = canRead  AND  the caller's role is not read-only (EXECUTIVE)
 *
 * CONTENT — canReadTeamContent / canWriteTeamContent / requireTeamContent{Read,Write}:
 *   canReadTeamContent  = member OF the team. Full stop. No role branch, no hop.
 *   canWriteTeamContent = content read  AND  the caller's role is not read-only.
 *
 * ADDITIVE, not a narrowing of the existing pair — see the note on canReadTeamContent
 * for why narrowing canRead in place would have made member REMOVAL unreachable for
 * everyone and taken the audited MEMBER_REMOVED path with it.
 */

// Roles that may access teams they don't belong to — but only within workshops
// they own (the admin/facilitator views). Mirrors the monolith's STAFF_ROLES.
const STAFF_ROLES = new Set(["ADMIN", "FACILITATOR"]);

// Roles that may read a team workspace but must never mutate it. Mirrors the
// monolith's READ_ONLY_ROLES; in the real cutover this comes from
// @praimana/shared.
const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);

/** Workshop-ownership decisions the Team service must ASK the Workshop context
 *  for. Injected (DIP) so it can be an HTTP client or an event-fed read-model. */
export interface WorkshopAccess {
  /** True if the user owns the workshop that this team belongs to. */
  ownsTeamWorkshop(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean>;
  /**
   * True if the user owns the workshop named directly.
   *
   * Needed where there is no team to resolve the workshop THROUGH — creating the
   * first team in a workshop being the case that matters, since the team whose
   * membership would otherwise answer "may you touch this workshop?" is the very
   * thing being created. Same fail-closed contract as ownsTeamWorkshop.
   */
  ownsWorkshop(
    workshopId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean>;
  /**
   * THE WORKSHOP'S `maxTeamSize` — the TEMPLATE a new team's `seatCap` is seeded from.
   * Read ONCE, at team CREATION, and never again.
   *
   * ── WHY THIS IS ON *THIS* INTERFACE, AND WHY IT IS NOT A BOOLEAN ──
   *
   * It is the SAME east-west hop the other two methods make — `GET /workshops/:id`, same
   * client, same base URL, same re-presented caller token — and it is asked on the same
   * WRITE path that already calls `ownsWorkshop`. So the implementation is one extra field
   * read from a response this class was already parsing and discarding
   * (workshop-access.http.ts kept only `ownerId`).
   *
   * It is deliberately NOT modelled like the two booleans, because a fail-closed boolean is
   * the wrong shape for a NUMBER: there is no safe default. Falling back to the platform
   * ceiling on a failed hop would make an unreadable template silently produce the WIDEST
   * possible cap, which is the fail-closed rule violated exactly — `"unavailable"` must never
   * become a permissive value. So the three outcomes are distinguished:
   *
   *   number         the template was read and is usable.
   *   "unavailable"  the hop could not be COMPLETED (timeout, non-2xx, unparseable body).
   *                  TRANSIENT — a retry changes the answer — so the caller answers 503 with
   *                  Retry-After and writes NO TEAM ROW.
   *   "invalid"      the hop COMPLETED and the stored value is unusable: absent, not a
   *                  number, not an integer, or outside [2, MAX_TEAM_MEMBERS]. PERMANENT
   *                  until somebody patches the workshop, so a 503 + Retry-After would be a
   *                  lie — the same distinction the reactivation route draws between an
   *                  unresolvable address and a definite absent row.
   *
   * ⚠ THIS IS NOT A HOT-PATH READ AND MUST NOT BECOME ONE. Neither
   * JOIN path may consult the workshop, and that is a STRUCTURAL constraint rather than a
   * latency preference: `requireWorkshopRead` (workshop/src/authz.ts) resolves a
   * non-owner/non-admin caller by asking Team whether they are a member of a team in that
   * workshop — so a JOINER, who is not yet a member of any team in it, is 403'd. The first
   * join into a workshop could never read its own cap. Both callers of THIS method are
   * staff (ADMIN, or the owning FACILITATOR), both of whom `requireWorkshopRead` admits
   * locally without recursing back into Team.
   */
  teamSeatTemplate(
    workshopId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<number | "unavailable" | "invalid">;
}

/**
 * The Hono Context an east-west implementation needs in order to re-present the
 * CALLER's own Bearer token (see forwardedIdentityHeaders). Optional on the
 * interface so in-memory/read-model implementations — and tests — can ignore it.
 */
export type AuthContext = Context;

/** One workshop, as much of it as the teams directory needs. */
export interface WorkshopRef {
  id: string;
  name: string;
}

/**
 * WORKSHOP CONTEXT reads the TEAMS DIRECTORY needs, and which the Team context cannot
 * answer from its own tables — `Team.workshopId` is all it stores.
 *
 * A SEPARATE INTERFACE FROM WorkshopAccess above, not two more methods on it, and the split
 * is by QUESTION rather than by convenience. WorkshopAccess answers a per-resource
 * authorization question ("does this caller own workshop W?") for which the answer is a
 * fail-closed boolean. Neither method here is that shape: one enumerates a SET and must
 * report "unavailable" rather than fail closed, and the other is pure DISPLAY. Folding them
 * in would put a display lookup on the interface that gates every team read.
 *
 * ── THE TWO METHODS HAVE DELIBERATELY DIFFERENT FAILURE SEMANTICS ──
 *
 * `listOwnedWorkshops` is AUTHORIZATION: it is the FACILITATOR's directory scope, so a
 * failure is "undetermined" and the route MUST answer 503 rather than an empty list. The same
 * fail-closed rule — "could not determine" returned as "you have none" is the defect class
 * to avoid: a fail-closed catch reporting an infrastructure fault as an authorization
 * answer. An empty directory would look exactly like a working one.
 *
 * `resolveWorkshopNames` is DISPLAY: a name that cannot be resolved is simply absent from the
 * map, the row renders with a null workshop name, and the page still lists the teams. It must
 * never fail a directory an operator opened during an incident.
 */
export interface WorkshopDirectory {
  /**
   * The workshops this caller OWNS — the FACILITATOR's directory scope
   * (facilitators should see the workshops they created, not those other facilitators created).
   *
   * ⚠ NO RECURSION, BY CONSTRUCTION OF THE CALL SITE. The HTTP implementation asks the
   * Workshop service's `GET /v1/workshops`, which branches on role: ADMIN and FACILITATOR are
   * answered by `listByOwner` with NO hop, while JUDGE/EXECUTIVE/PARTICIPANT are answered by
   * calling back into Team for `E(self)`. The directory route therefore calls this ONLY for a
   * FACILITATOR — an ADMIN needs no scope at all — so the Team → Workshop
   *
   * Returns the workshop's NAME as well as its id because the caller needs both and the
   * single hop already carries them: the scope for a FACILITATOR doubles as their name map,
   * so their directory page makes no second east-west call.
   *
   * "unavailable" for a timeout, a non-2xx, or an unrecognised body. NEVER an empty array for
   * those — see the interface note.
   */
  listOwnedWorkshops(
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<WorkshopRef[] | "unavailable">;
  /**
   * Names for a KNOWN set of workshop ids — BEST-EFFORT, for display only.
   *
   * The ADMIN branch's name map: an ADMIN's directory spans workshops they do not own, so
   * their names cannot come from `listOwnedWorkshops`. Ids that cannot be resolved (the
   * workshop was deleted, the hop failed, the caller is refused it) are ABSENT from the
   * result rather than an error — callers must handle a short map, and MUST NOT treat an
   * absent name as an authorization signal. Never throws.
   *
   * `userId`/`role` are taken for the same reason every method on WorkshopAccess takes them
   * and are NOT an authorization input here: `forwardedIdentityHeaders` falls back to the
   * internal-hop headers when there is no caller token to re-present, and those headers ARE
   * the identity the callee authorizes on. Passing empty strings would make every local /
   * EKS-shaped deployment resolve names as a role-less caller and get nothing back.
   */
  resolveWorkshopNames(
    ids: readonly string[],
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<Record<string, string>>;
}

export function isReadOnlyRole(role: string): boolean {
  return READ_ONLY_ROLES.has(role);
}

/**
 * Roles that may reach a team they don't belong to, in a workshop they own.
 *
 * Exported because the roster route needs the SAME predicate before it probes
 * workshop ownership: restricting that probe to the only roles that can own a
 * workshop is what keeps a participant's roster read hop-free, and what stops the
 * ownership probe from being reachable on a path that could recurse back into this
 * service. One copy, so the two cannot drift into disagreeing about who is staff.
 */
export function isStaffRole(role: string): boolean {
  return STAFF_ROLES.has(role);
}

/**
 * Platform roles that may NEVER hold a team-membership row — the member-only requirement (b).
 *
 * A deliberate COPY of PLATFORM_SCOPED_ROLES in shared/constants/roles.ts
 * — bundled Lambdas take no dep on that package, the same idiom as ROLE_GRANTS in
 * routes.ts. That constant already says these three roles are invited to the PLATFORM and
 * not to a team; this is the enforcement of it on the membership WRITE paths.
 *
 * WHY STRUCTURAL AND NOT MERELY POLICY. Since team content became member-only, a
 * membership row is the ONLY thing that grants content access — so a facilitator who
 * acquires one (by accepting a team-scoped invitation at first sign-in, which was the
 * unguarded front door) silently regains exactly the ambient access, and
 * regains it in a form no role check can see: `members.get` returns a row and every
 * content predicate says yes. Read-model FILTERING is not an acceptable substitute for
 * the same reason — the row survives, so any reader that forgets the filter is a hole.
 */
const TEAM_MEMBERSHIP_DENIED_ROLES = new Set(["ADMIN", "FACILITATOR", "JUDGE"]);

/**
 * True if this platform role may hold a team-membership row at all.
 *
 * Takes `string | undefined` and fails CLOSED on absent — but note the direction is the
 * opposite of the grant matrices: this is a DENY-list, so an UNKNOWN role may hold
 * membership. That is deliberate and is the only reading that does not break the
 * platform: PARTICIPANT and EXECUTIVE are the team-scoped roles today, and a deny-list
 * means adding a sixth team-shaped role does not require editing this file before anyone
 * can join a team. An absent role is refused because a membership write keyed on no
 * verified role at all has no business succeeding.
 *
 * ALWAYS called with `requireIdentity(c).role` — the VERIFIED token role — and never with
 * `invitation.platformRole`. A stored value is a record of what someone was offered, not
 * an authorization source: an invitation row can predate a role change, and it is written
 * by a different actor than the one presenting at the door.
 */
export function mayHoldTeamMembership(platformRole: string | undefined): boolean {
  if (!platformRole) return false;
  return !TEAM_MEMBERSHIP_DENIED_ROLES.has(platformRole);
}

/**
 * ── ADMINISTRATION READ ──
 *
 * canRead = member OF the team OR (staff AND owns the team's workshop). Membership is
 * decided from THIS service's teamMembers table; workshop ownership is delegated to the
 * injected WorkshopAccess.
 *
 * ⚠ THE UNCONDITIONAL `role === "ADMIN"` SHORT-CIRCUIT WAS REMOVED. An ADMIN
 * is now scoped to the experiences they OWN (see ROLES.md), so they reach this predicate
 * through the SAME staff-and-owns branch as a FACILITATOR — `isStaffRole` admits both. An
 * admin who owns the team's experience is answered exactly as before; one who does not is
 * refused, which is the whole point of the change.
 *
 * ⚠ IT NOW COSTS AN ADMIN ONE EAST-WEST HOP where it previously cost none, and that hop is
 * cycle-safe for a specific reason rather than by luck: `ownsTeamWorkshop` reaches the
 * Workshop service's `GET /v1/workshops/:id`, which resolves ADMIN and owner from its OWN
 * row before consulting any entitlement, so it never asks us back about membership. If that
 * local resolution is ever removed, this becomes Team → Workshop → Team on one Lambda pool.
 *
 * ⚠ AND ONE ORPHAN CASE IS NOW UNREACHABLE, stated rather than discovered later: a team whose
 * `workshopId` has been CLEARED has no owner to resolve, so `ownsTeamWorkshop` returns false
 * for everyone and only the team's own members can be read. Nobody can administer such a team.
 * That is the same recovery gap as an experience whose owner is deactivated, and it wants the
 * same fix — an explicit, audited recovery path rather than an ambient admin override.
 *
 * THIS IS THE ADMINISTRATION PREDICATE, and it is deliberately UNCHANGED by the member-only rule.
 * It answers "may you administer the person↔team RELATIONSHIP and the invitations
 * around it?" — the roster, the workshop roster, member removal, invitations,
 * submissions and scores. It does NOT answer "may you read what the team WROTE"; that
 * is canReadTeamContent below.
 *
 * Narrowing it in place was considered and rejected: it gates
 * DELETE /teams/:teamId/members/:userId, so a member-only version would 403 an ADMIN
 * there, and combined with requirement (b) (staff cannot be members) NOBODY could
 * remove anyone from a team — taking the audited MEMBER_REMOVED path with it.
 */
export async function canRead(
  members: TeamMemberRepository,
  workshops: WorkshopAccess,
  teamId: string,
  userId: string,
  role: string,
  auth?: AuthContext
): Promise<boolean> {
  if (await members.get(teamId, userId)) return true;
  if (
    isStaffRole(role) &&
    (await workshops.ownsTeamWorkshop(teamId, userId, role, auth))
  ) {
    return true;
  }
  return false;
}

/**
 * ── ADMINISTRATION WRITE ──
 *
 * canWrite = canRead AND the caller's role is not read-only (EXECUTIVE). Same
 * administration scope as canRead above; see that note for what it is NOT.
 */
export async function canWrite(
  members: TeamMemberRepository,
  workshops: WorkshopAccess,
  teamId: string,
  userId: string,
  role: string,
  auth?: AuthContext
): Promise<boolean> {
  if (isReadOnlyRole(role)) return false;
  return canRead(members, workshops, teamId, userId, role, auth);
}

// ─── TEAM CONTENT: member-only ──────────────────────────────────────────────

/**
 * ── CONTENT READ ── May the caller read what this team AUTHORED?
 *
 * `!!(await members.get(teamId, userId))` and nothing else. A team's board, chat, AI
 * conversations, code, phase notes and the insights derived from them are the team's own
 * work, and the rule is that only the team sees them: not an ADMIN, not a
 * FACILITATOR, not a JUDGE, not a non-member EXECUTIVE.
 *
 * ── THE SIGNATURE IS THE DESIGN, NOT AN OVERSIGHT ──
 *
 * It takes NO WorkshopAccess and NO Context. Both omissions are load-bearing:
 *
 *   - no WorkshopAccess ⇒ a content decision CANNOT make an east-west call, even by a
 *     later accident. There is no dependency in scope to call. That makes the "content
 *     reads are hop-free" property structural rather than a thing every future editor has
 *     to remember, and it closes the Team → Workshop → Team cycle for this whole family by
 *     construction. authz.test.ts asserts the injected WorkshopAccess is never called.
 *   - no Context ⇒ nothing here can read a header. The decision is a function of the
 *     (teamId, userId) pair the caller already resolved from verified claims.
 *
 * `role` IS taken, and is deliberately UNUSED for the read decision, so that adding a
 * role branch here is a visible edit to a documented rule rather than a widening that
 * slips in with a new parameter. It is used by canWriteTeamContent below.
 *
 * A NON-MEMBER ADMIN GETS FALSE, and that is the change. THERE IS NO EXCEPTION — an audited
 * break-glass route was built and then removed, so an admin has no
 * content path at all. An investigation is an EXECUTIVE's job: a read-only role that CAN hold
 * a membership row, so it passes here for the one team it belongs to and is refused write by
 * canWriteTeamContent below. The member-only rule removed the ambient admin override; an
 * explicit, audited recovery path replaces it.
 */
export async function canReadTeamContent(
  members: TeamMemberRepository,
  teamId: string,
  userId: string,
  role: string
): Promise<boolean> {
  // Accepted and deliberately not consulted — see the note above. `void` rather than a
  // lint suppression or a `_role` rename: the same idiom as ws-server.ts's `void actorId`,
  // and it keeps the parameter name honest for every caller and for canWriteTeamContent.
  void role;
  return !!(await members.get(teamId, userId));
}

/**
 * ── CONTENT WRITE ── content read AND not a read-only role (EXECUTIVE).
 *
 * Order matters for the same reason it does in canWrite: the role check is local and free,
 * so an EXECUTIVE is refused without a store read. The asymmetry an EXECUTIVE member has
 * — reads their team's content, writes none of it — survives here exactly as it does on
 * the administration pair.
 */
export async function canWriteTeamContent(
  members: TeamMemberRepository,
  teamId: string,
  userId: string,
  role: string
): Promise<boolean> {
  if (isReadOnlyRole(role)) return false;
  return canReadTeamContent(members, teamId, userId, role);
}

/**
 * Guard: caller must be a MEMBER to read this team's content. Returns a Response to
 * short-circuit with, or null to proceed.
 *
 * The 403 body deliberately says the same thing requireTeamRead's does — "not a member of
 * this team" — because for a content route that is now literally the rule, and a distinct
 * message would tell a caller which of two predicates refused them.
 */
export async function requireTeamContentRead(
  c: Context,
  members: TeamMemberRepository,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const ok = await canReadTeamContent(members, teamId, id, role);
  return ok ? null : c.json({ error: "Forbidden: not a member of this team" }, 403);
}

/** Guard: caller must be a MEMBER and not a read-only role to write this team's content. */
export async function requireTeamContentWrite(
  c: Context,
  members: TeamMemberRepository,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) {
    return c.json({ error: "Forbidden: your role has read-only access" }, 403);
  }
  const ok = await canReadTeamContent(members, teamId, id, role);
  return ok ? null : c.json({ error: "Forbidden: not a member of this team" }, 403);
}

/** Guard: caller must be able to read the team. Returns a Response to
 *  short-circuit with, or null to proceed. */
export async function requireTeamRead(
  c: Context,
  members: TeamMemberRepository,
  workshops: WorkshopAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const ok = await canRead(members, workshops, teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden: not a member of this team" }, 403);
}

/** Guard: caller must be able to write the team (readable AND not a read-only role). */
export async function requireTeamWrite(
  c: Context,
  members: TeamMemberRepository,
  workshops: WorkshopAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) {
    return c.json({ error: "Forbidden: your role has read-only access" }, 403);
  }
  const ok = await canRead(members, workshops, teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden: not a member of this team" }, 403);
}

/**
 * ── ROSTER ADMINISTRATION: STAFF-AND-OWNS ONLY, NO MEMBER BRANCH ──────────────
 *
 * Guard: the caller must be STAFF *and* own the team's workshop. Membership of the team
 * grants NOTHING here — which is the entire difference from `requireTeamWrite`, and the
 * reason this exists as a third guard rather than as an edit to `canRead`.
 *
 * ── WHY IT WAS NEEDED ──
 *
 * `DELETE /teams/:teamId/members/:userId` and its reactivate sibling were
 * gated on `requireTeamWrite`, whose route headers claim it means "an ADMIN, or a FACILITATOR
 * who owns the workshop, and NOT a read-only EXECUTIVE". It does not: `canWrite` is
 * `!isReadOnlyRole(role) && canRead(...)`, `canRead`'s FIRST branch is an unconditional
 * `members.get(teamId, userId)`, and `READ_ONLY_ROLES` holds only EXECUTIVE. So EVERY ordinary
 * PARTICIPANT on the team satisfied it, and could remove — or reactivate — any teammate.
 * ROLES.md:126 grants that act to ADMIN and FACILITATOR only, with an explicit ✗ for
 * PARTICIPANT, so the implementation contradicted both the documented matrix and its own
 * header.
 *
 * Removal is not cosmetic: the membership row is the WHOLE of team-content
 * authorization, and the handler also flips the victim's invitation to REVOKED, which
 * withdraws their workshop entitlement (`GET /v1/entitlements/workshops`) and makes re-joining
 * refuse as a spent invitation.
 *
 * ── WHY A NEW GUARD AND NOT A NARROWED `canRead` ──
 *
 * `canRead`'s own note explains that narrowing it in place was considered and rejected,
 * because it also gates the routes that genuinely intend to admit members (e.g.
 * `PATCH /teams/:teamId`, whose header explicitly accepts a member raising the seat cap).
 * This guard takes the SECOND branch of `canRead` — staff AND ownership — and nothing else,
 * so the narrowing lands only where roster administration happens.
 *
 * ⚠ NO `isReadOnlyRole` CHECK IS NEEDED, and its absence is not an oversight: EXECUTIVE is not
 * in STAFF_ROLES, so `isStaffRole` already refuses every read-only role. Adding one would be
 * dead code that reads as though it were load-bearing.
 *
 * ⚠ FAIL-CLOSED COMES FROM `ownsTeamWorkshop`, per the WorkshopAccess contract: an
 * unanswerable hop is `false`, so an unreachable Workshop service refuses roster
 * administration rather than granting it. It also means the ORPHAN CASE `canRead` documents
 * applies here in full — a team whose `workshopId` has been cleared has no owner to resolve
 * and so cannot have its roster administered by anyone. That is the same recovery gap
 * `canRead` names, unchanged by this guard rather than introduced by it.
 */
export async function requireTeamAdministration(
  c: Context,
  workshops: WorkshopAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  // Role FIRST, because it is local: a refused PARTICIPANT costs no east-west hop. Same
  // local-check-first ordering as evaluation/src/authz.ts's scoring guard.
  if (!isStaffRole(role)) {
    return c.json(
      {
        error: "Forbidden: only an admin or the workshop's facilitator may change a team's roster",
        code: "ROSTER_ADMINISTRATION_FORBIDDEN",
      },
      403
    );
  }
  if (!(await workshops.ownsTeamWorkshop(teamId, id, role, c))) {
    return c.json(
      {
        error: "Forbidden: you do not own this team's workshop",
        code: "ROSTER_ADMINISTRATION_FORBIDDEN",
      },
      403
    );
  }
  return null;
}
