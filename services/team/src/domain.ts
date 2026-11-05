/**
 * TEAM bounded context — domain types + repository interfaces.
 *
 * The Team service owns exactly three tables: teams, teamMembers and invitations.
 * It owns NO other context's data (Single Responsibility). In particular it must
 * NEVER read the Identity service's users table — where it needs a member's name
 * or email it reads a local users READ-MODEL synced from `user.*` events (see
 * UsersReadModel below).
 */
import type { ReadModel } from "@praimana/service-shared";

export interface Team {
  workshopId: string;
  id: string;
  name: string;
  description: string | null;
  inviteCode: string;
  repoUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * THE TEAM'S OWN SEAT LIMIT — how many ACTIVE members it may hold.
   *
   * SEEDED AT CREATION from the workshop's `maxTeamSize` and THEREAFTER THIS CONTEXT'S
   * OWN DATA. `Workshop.maxTeamSize` is redefined as *the template applied to
   * new teams*, not a value read on the join path — a per-join east-west
   * lookup is structurally impossible rather than merely slow (`requireWorkshopRead` 403s
   * the joiner, who is not yet a member of any team in the workshop, so the FIRST join
   * into a workshop could never read its own cap).
   *
   * Bounded above by MAX_TEAM_MEMBERS at every write. `PATCH /teams/:teamId` additionally
   * refuses to lower it below the live `memberCount`, so an over-cap team cannot come
   * into existence and no migration ever removes anybody.
   *
   * OPTIONAL ONLY FOR ROWS THAT PREDATE IT. Absent means the row was written before the
   * seat cap shipped; `admit()` lazily initialises both this and `memberCount` from a strongly
   * consistent roster count. A new team always carries it — creation REFUSES (503) rather
   * than defaulting when the workshop template cannot be read, per the fail-closed rule that
   * `"unavailable"` never becomes a permissive number.
   */
  seatCap?: number;
  /**
   * THE SEAT LEDGER — the count of ACTIVE membership rows for this team.
   *
   * ⚠ NOT A CACHE of an authoritative count. It IS the authority, and the membership rows
   * are its detail: it only ever moves inside the same `TransactWriteItems` as the row it
   * counts (`admit`/`deactivate`/`reactivate`), so it cannot drift from the rows by any
   * interleaving. The drift metric on the roster read exists to catch a FUTURE WRITER THAT
   * BYPASSES THE REPOSITORY, not to repair expected divergence.
   *
   * This attribute is what makes the cap linearizable: the `teams` item is the
   * serialization point, so two concurrent admits at 9/10 both target it and exactly one
   * commits.
   *
   * ⚠ ABSENT IS NOT ZERO, and the difference is a platform-wide lockout. DynamoDB
   * evaluates `memberCount < :cap` as FALSE when the attribute is absent, so arming the
   * cap without the lazy initialisation in `admit()` would refuse EVERY join to EVERY
   * existing team. And the naive `if_not_exists(memberCount, 0) + 1` fix is worse: a
   * 4-member legacy team would initialise to 1 and could then reach 14. See the seat-cap
   * Residual risk section — the lazy init and the one-time backfill are BOTH required.
   */
  memberCount?: number;
}

export interface TeamMember {
  teamId: string;
  userId: string;
  /**
   * The TEAM role — NOT the platform role.
   *
   * ⚠ SIX VALUES, and this comment previously listed FOUR: LEAD, BUILDER, PRODUCT, DESIGNER,
   * EXECUTIVE, COACH. `TeamRole` in shared/types/team.ts is the source of truth and the
   * invite form offers all six.
   *
   * The stale list was not harmless: the bulk-upload validator was built from THIS comment rather
   * than from the type, so it rejected PRODUCT and DESIGNER — telling a facilitator their file was
   * wrong when the validator was. Prefer the type; a list in prose goes stale silently.
   *
   * PRESERVED ACROSS A REMOVAL, which is what makes reactivation restore the person to
   * what they were: a reactivated LEAD returns as LEAD. That is only true because the
   * removal keeps the row (see `status` below); the previous hard delete destroyed this
   * field, so a re-added member came back as whatever their next invitation said.
   */
  role: string;
  joinedAt: string;
  /**
   * ACTIVE / INACTIVE — see the two constants below and `isInactiveMembership`.
   *
   * ABSENT ON EVERY ROW WRITTEN BEFORE THIS FIELD EXISTED, and absent counts as ACTIVE.
   * The polarity is FORCED, not chosen: every membership row in the table today carries no
   * status attribute, so reading absence as INACTIVE would revoke the whole platform's team
   * access on deploy. Same fail-open-on-absence rule as isSpentInvitation and isExpired —
   * a lockout is worse than the leak it would prevent, and there is no leak here because
   * nothing has been deactivated yet.
   *
   * The ENFORCEMENT is not this field, it is the repository: `get()`/`listByTeam()` never
   * return an inactive row at all. See the note on TeamMemberRepository.
   */
  status?: string;
  /** When the membership was deactivated, and by whom. Written only on an INACTIVE row. */
  removedAt?: string;
  /** The sub of the operator who performed the removal. */
  removedBy?: string;
  /**
   * The removing operator's PLATFORM ROLE AT THE TIME.
   *
   * On the ROW as well as in the audit entry, and the duplication is deliberate: the roster
   * has to render "Removed by a Facilitator" for every inactive member, and the visibility
   * gate that decides whether the NAME may be shown is keyed on this role. Correlating each
   * inactive member back to their MEMBER_REMOVED entry would turn one Query into a fan-out
   * across the audit trail on a route a whole team loads.
   *
   * A historical fact, so it is stored rather than re-derived — the same reasoning as
   * AuditEntryWrite.actorRole. There is deliberately no matching `reactivatedByRole`: no
   * surface renders it, and the trail already carries the actor's role for that action.
   */
  removedByRole?: string;
  /**
   * When the membership was last RESTORED, and by whom. The row's own breadcrumb, exactly
   * like Invitation.revokedAt/revokedBy — the audit trail remains the authoritative record
   * (MEMBER_RESTORED carries the actor's role and the operator's reason), this is what makes
   * a table dump readable during an incident.
   *
   * NOT cleared on a later removal, so a row can carry both: it says "restored then removed
   * again", which is true. `status` is the only field that says what holds NOW.
   */
  reactivatedAt?: string;
  /** The sub of the operator who performed the reactivation. */
  reactivatedBy?: string;
}

/**
 * THE OUTCOME OF AN ADMISSION ATTEMPT. Three states, deliberately NOT a
 * boolean, because the two failures need DIFFERENT HTTP answers:
 *
 *   "admitted"       the seat was taken and the row written. 200/201.
 *   "already-member" a membership row already exists. 200 — IDEMPOTENT, nothing granted.
 *   "full"           the team is at its `seatCap`. 409 TEAM_FULL.
 *
 * A boolean would force the caller to guess which, and the guess named explicitly
 * is the wrong one: telling somebody who is already on the team that it is full.
 */
export type AdmitOutcome = "admitted" | "already-member" | "full";

/**
 * THE MEMBERSHIP LIFECYCLE, as two statuses.
 *
 *   ACTIVE    the person is on the team. Grants every team read and write they are entitled
 *             to, which is the WHOLE of team-content authorization.
 *   INACTIVE  they were REMOVED but the row is kept — for audit, and so the removal can be
 *             reversed. Grants NOTHING.
 *
 * Constants rather than literals because the string crosses a service boundary: the Docs
 * Lambda reads this table DIRECTLY (it runs in a private subnet with no route to the Team
 * API — see services/docs/src/authz.ts) and carries its own copy, exactly as the
 * invitation statuses are copied into the Cognito pre-signup trigger. A casing or spelling
 * difference between the copies would silently GRANT a removed person access to that
 * surface rather than failing loudly, which is why both sides compare case-insensitively
 * and both test for the DENY value.
 */
export const MEMBERSHIP_ACTIVE = "ACTIVE";
export const MEMBERSHIP_INACTIVE = "INACTIVE";

/**
 * True when a membership row has been DEACTIVATED — the person was removed from the team.
 *
 * ABSENT STATUS IS NOT INACTIVE, and the polarity is forced rather than preferred; see
 * TeamMember.status for why (every existing row has no attribute, so the other reading is a
 * platform-wide lockout on deploy). So this tests for the DENY value, the same shape as
 * isSpentInvitation and as the two predicates in the pre-signup trigger.
 *
 * Compared case-INSENSITIVELY because the constant is copied into another service's bundle
 * and a casing difference must not be the thing that decides whether a removed person still
 * has access.
 */
export function isInactiveMembership(status: string | undefined): boolean {
  return normalizeStatus(status) === MEMBERSHIP_INACTIVE;
}

/**
 * THE INVITATION LIFECYCLE, as a closed set of statuses.
 *
 *   PENDING   the grant is live and unredeemed. One registration, one join.
 *   ACCEPTED  redeemed. The person took it up; the row survives as the record of who
 *             granted them access and when they accepted.
 *   REVOKED   withdrawn. Written when a member is REMOVED from the team, because the
 *             row that admitted them is otherwise a standing permission to return.
 *
 * ACCEPTED and REVOKED are both TERMINAL — see isSpentInvitation. Written as constants
 * rather than literals because the strings are a cross-service contract: the Cognito
 * pre-signup trigger and the user-access service each carry their own copy (both are
 * bundled Lambdas that take no dep on a workspace package), and a casing or spelling
 * difference between the copies silently reopens a bypass rather than failing loudly.
 */
export const INVITATION_PENDING = "PENDING";
export const INVITATION_ACCEPTED = "ACCEPTED";
export const INVITATION_REVOKED = "REVOKED";

/**
 * True when an invitation has been REVOKED — withdrawn after it was granted.
 *
 * Produced by the member-removal route (see routes.ts): removing someone deletes their
 * membership row, and unless the invitation that admits them is also withdrawn they can
 * simply re-present the team's invite code and put themselves back. VERIFIED
 * EXPLOITABLE against the deployed stack before this existed — HTTP 200, membership
 * re-created, and no record of the rejoin.
 *
 * The row is FLIPPED rather than deleted, deliberately: it is also the record of who
 * invited them and when they accepted, and the former-members view derives `joinedAt`
 * from that `acceptedAt`. Deleting would erase history to fix an access bug.
 */
export function isRevokedInvitation(status: string | undefined): boolean {
  return normalizeStatus(status) === INVITATION_REVOKED;
}

/** True when an invitation has already been redeemed. */
export function isAcceptedInvitation(status: string | undefined): boolean {
  return normalizeStatus(status) === INVITATION_ACCEPTED;
}

/**
 * True when an invitation is SPENT — it can never legitimately admit anyone again.
 *
 * ACCEPTED or REVOKED. The reasoning for ACCEPTED transfers VERBATIM from the identical
 * hole already closed for REGISTRATION in
 * services/cognito-presignup/src/handler.ts — read the `isAccepted` note there: an
 * invitation is a ONE-SHOT grant, so a redeemed row can never authorise a second
 * redemption, and re-admitting someone is an explicit act (a fresh invitation, which
 * writes a new PENDING row).
 *
 * ABSENT STATUS IS NOT SPENT, and the polarity is forced rather than chosen — the same
 * fail-open-on-absence rule as isExpired in invite-token.ts and as the two predicates in
 * the pre-signup trigger. Rows written before `status` existed carry no attribute, and
 * treating those as spent would refuse every legacy invitation: a lockout, which is worse
 * than the leak. So this tests for the DENY values.
 *
 * Compared case-INSENSITIVELY for the same reason the pre-signup copy is: the string
 * crosses a service boundary in three separate bundles, and a casing difference must not
 * be the thing that decides whether a removed person can rejoin.
 */
export function isSpentInvitation(status: string | undefined): boolean {
  const normalized = normalizeStatus(status);
  return (
    normalized === INVITATION_ACCEPTED || normalized === INVITATION_REVOKED
  );
}

/** Trimmed and upper-cased, or "" for a non-string. Never throws on a foreign value. */
function normalizeStatus(status: string | undefined): string {
  return typeof status === "string" ? status.trim().toUpperCase() : "";
}

export interface Invitation {
  /**
   * The team this invitation is for — or PLATFORM_INVITATION_TEAM_ID when the
   * invitation grants a platform role and no team (see routes.ts). This is the
   * table's PARTITION KEY, so it is never absent or empty: DynamoDB would reject
   * the write. Use invitationScope()/`scope` below rather than comparing this to a
   * magic string.
   */
  teamId: string;
  email: string;
  /**
   * TEAM or PLATFORM — written explicitly rather than left to be inferred from
   * `teamId`. The inference is possible (and `invitationScope()` does exactly that
   * for the rows written before this field existed), but a row that says what it is
   * survives a reader who doesn't know the sentinel, and it is what makes a table
   * dump readable during an incident. Absent means TEAM.
   */
  scope?: string;
  /**
   * PENDING / ACCEPTED / REVOKED — see the three constants above. ABSENT on rows
   * written before the field existed, which counts as PENDING (isSpentInvitation
   * explains why the polarity is forced that way).
   */
  status: string;
  invitedBy: string;
  sentAt: string;
  acceptedAt?: string;
  /**
   * When the grant was WITHDRAWN, and by whom. Written only on a REVOKED row.
   *
   * Present so the invitation itself says why it no longer admits anyone, without a
   * reader having to correlate it against the audit trail. The trail remains the
   * authoritative record of the removal (MEMBER_REMOVED carries the actor's role at the
   * time and the operator's reason); these two are the row's own breadcrumb.
   */
  revokedAt?: string;
  /** The sub of whoever performed the revocation — the removing operator. */
  revokedBy?: string;
  /**
   * The sub of whoever PERFORMED the acceptance — normally the invitee themselves at
   * first sign-in, or the staff member who reconciled it on their behalf via
   * PATCH /invitations/:email/accept. Absent on rows accepted before this was
   * recorded, and on every PENDING row.
   */
  acceptedBy?: string;
  /**
   * When the WORKSHOP ENTITLEMENT on this row was withdrawn, and by whom — written by
   * `clearWorkshop` in the SAME update that removes `workshopId`.
   *
   * The row's own breadcrumb, exactly like `revokedAt`/`revokedBy` above and
   * `removedBy`/`reactivatedBy` on a membership row. It is what keeps the operator's
   * identity recoverable when the audit write fails (UnauditedAccessChangeAlarm's runbook
   * step 3 names this field), and it is the ONLY record for a row whose entitlement was
   * withdrawn before its holder ever redeemed it — a PENDING invitation has no `acceptedBy`,
   * so there is no user partition to key an audit entry on. See the route.
   *
   * NOT cleared by a later re-invitation: `put` REPLACES the row whole, so a fresh
   * invitation carries neither field. Present here means "this row's grant was withdrawn",
   * and the ABSENCE of `workshopId` is what says it holds now.
   */
  workshopRevokedAt?: string;
  /** The sub of the operator who withdrew the workshop entitlement. */
  workshopRevokedBy?: string;
  // Platform (account) role the inviter chose for this person, e.g. PARTICIPANT,
  // JUDGE. Recorded for display/audit; account roles are assigned by Identity at
  // registration. Optional so pre-existing invitations still parse.
  platformRole?: string;
  /**
   * The WORKSHOP this invitation grants access to, when the role is one that gets a
   * workshop at all. See the per-role table on POST /teams/:teamId/invitations —
   * REQUIRED for a JUDGE, server-DERIVED from the team for a PARTICIPANT/EXECUTIVE,
   * and FORBIDDEN for an ADMIN or FACILITATOR (platform-wide, and facilitators see
   * what they created).
   *
   * STORED, not derived at read time, and that is a rule rather than a preference.
   * The drift objection that would
   * normally argue for deriving is structurally impossible here: `Team.workshopId` is
   * the teams table's PARTITION KEY, and DynamoDB cannot update a partition key in
   * place, so a team can never move between workshops. Deriving would instead cost one
   * teams.getById per invitation on every read.
   *
   * ABSENT MEANS "NO WORKSHOP GRANT", never "every workshop". Every row written before
   * this field existed has no value, and rows for the forbidden roles never will, so a
   * reader that treated absence as a wildcard would hand every legacy judge invitation
   * the whole platform.
   */
  workshopId?: string;
  // Team role applied when a PARTICIPANT accepts (LEAD/BUILDER/…). Only meaningful
  // for participants; defaults to BUILDER on join when absent.
  teamRole?: string;
  // SHA-256 of the invite link's token. The RAW token is emailed and never stored,
  // so a table dump yields no usable links. Indexed by tokenHash-index so /join
  // can resolve a link without the visitor supplying an email. Optional: rows
  // created before invite links carry no token.
  tokenHash?: string;
  // ISO-8601 instant the invite link lapses (24h after sending by default).
  // Enforced on the invitation ROW by the Cognito pre-signup trigger, not by the
  // link — the Hosted UI cannot forward the token to that trigger. Absent means
  // "never expires" (pre-existing invitations); see invite-token.ts:isExpired.
  expiresAt?: string;
}

/**
 * Repository interfaces — routes depend on THESE, not on DynamoDB (DIP). Narrow by
 * aggregate (Interface Segregation). Swapping the DynamoDB impl for an
 * HTTP/event-backed one later does not touch the routes.
 */
/** One page of teams, plus an opaque cursor for the next. Mirrors identity's UserPage. */
export interface TeamPage {
  teams: Team[];
  /**
   * Opaque continuation token, absent on the last page. Callers MUST treat this as an
   * opaque string and pass it back unmodified — it encodes a DynamoDB LastEvaluatedKey and
   * there is no guarantee it stays that shape.
   */
  nextCursor?: string;
}

export interface TeamRepository {
  /** Resolve a team by its id alone (via the id-index GSI). */
  getById(id: string): Promise<Team | null>;
  getByInviteCode(inviteCode: string): Promise<Team | null>;
  listByWorkshop(workshopId: string): Promise<Team[]>;
  put(team: Team): Promise<Team>;
  /**
   * SET a team's `seatCap` — the ONLY way it changes after creation.
   *
   * CONDITIONAL AT THE STORE on `memberCount <= :cap`, so lowering the cap below the live
   * roster is refused by DynamoDB rather than by a read-before-write. That matters because
   * the alternative loses the race it appears to win: a route that reads `memberCount` and
   * then writes `seatCap` can be interleaved with an `admit()` that fills the seat it just
   * decided was spare, leaving `memberCount > seatCap` — the invariant broken, with no
   * writer having done anything wrong.
   *
   * Returns FALSE when the condition refused — i.e. the new cap is below the current
   * member count. The caller answers 409 NAMING THE COUNT, because "you have 6 members"
   * is the fact that makes the refusal actionable and the operator cannot see it from the
   * cap alone.
   *
   * ⚠ TAKES THE FULL KEY (workshopId, id). `teams` is keyed (workshopId HASH, id RANGE) and
   * an Update needs both — resolving one from the other costs a Query on `id-index`, which
   * is why the caller passes the row it already read.
   *
   * THROWS on a real store failure: this route's entire purpose is the write, so a caller
   * told the cap changed when it did not has been misinformed about the only thing they
   * asked for.
   */
  setSeatCap(
    workshopId: string,
    id: string,
    seatCap: number
  ): Promise<boolean>;
  /**
   * EVERY team on the platform, one page at a time — the TEAMS DIRECTORY read.
   *
   * Backs GET /v1/teams/directory, which is the only caller that legitimately enumerates
   * teams ACROSS workshops. Every other list here is scoped: `listByWorkshop` is one
   * partition, and `/teams/mine` is the caller's own memberships.
   *
   * ── `workshopIds` IS THE AUTHORIZATION RESTRICTION, AND IT BELONGS HERE ──
   *
   * Following identity's stated reasoning for `visibleRoles`
   * (identity/src/domain.ts:206-232): *"the only method able to enumerate users is also the
   * one that applies the restriction — a route-level filter is one a future route can
   * forget."* Same rule, same place. A FACILITATOR sees only teams in workshops they OWN,
   * and that is expressed as a `workshopId IN (...)` restriction ANDed with
   * the search filter — so search can never widen what the scope allows.
   *
   * OMIT for no restriction (the ADMIN branch). An EMPTY ARRAY means "may see nothing" and
   * MUST return no teams — building `IN ()` is a syntax error and, far worse, omitting the
   * filter for an empty list turns "sees nothing" into "sees everything".
   *
   * `search` is a case-insensitive substring match on the TEAM NAME, applied in the STORE so
   * it matches across the whole table rather than only the page in hand. See the
   * implementation for the case-sensitivity workaround DynamoDB forces, and for why the
   * WORKSHOP name is deliberately not searchable.
   *
   * Paginated rather than "return everything" because the underlying store has no index that
   * can enumerate teams — see the implementation's note on why this is a Scan and what
   * bounds it.
   */
  listDirectory(opts?: {
    limit?: number;
    cursor?: string;
    search?: string;
    workshopIds?: readonly string[];
  }): Promise<TeamPage>;
}

/**
 * ── THE INVERTED DEFAULT IS THE DESIGN. DO NOT "SIMPLIFY" `get()`. ──
 *
 * Removal used to be a HARD DELETE, chosen deliberately over a soft-delete flag on the
 * grounds that a flag "needs every reader to filter it, and missing one silently restores
 * access". That objection was correct and it is answered STRUCTURALLY here rather than
 * abandoned: the row now survives, and the DEFAULT READS REFUSE TO RETURN IT.
 *
 *   get()         returns NULL for an inactive row.
 *   listByTeam()  omits inactive rows entirely.
 *
 * Every authorization path on the platform already treats "no row" as "not a member" —
 * canRead, canReadTeamContent, canWriteTeamContent, the join gate's idempotency check, the
 * six content surfaces behind `/teams/:id/access`. So an INACTIVE membership grants nothing,
 * at every one of those call sites, WITH NO CHANGE TO ANY OF THEM. Forgetting to handle
 * inactive DENIES rather than grants, which is the only polarity worth having: the failure
 * mode of an omission is a lockout somebody reports, not a leak nobody notices.
 *
 * THAT IS WHY THERE IS NO `status` FILTER IN THE CALLERS. If a future reader "cleans this
 * up" by having `get()` return the raw row and pushing the check out to the callers, every
 * one of those sites silently re-grants a removed person full access — including
 * services/docs/src/authz.ts, which does not go through this interface at all and could
 * not be fixed from here. repository.dynamo.test.ts and routes.test.ts pin the polarity;
 * make it fail before you believe a simplification is safe.
 *
 * The TWO reads that need history are NAMED for the danger they carry — `getIncludingInactive`
 * / `listByTeamIncludingInactive`. A call site reading either one is visibly asking for rows
 * that may grant nothing, so a reviewer can see the question being asked.
 *
 * ── AND THERE IS NO `put`. THE WRITE SURFACE IS THE THREE TRANSITIONS. ──
 *
 * `put` was REMOVED with the seat-cap change, not merely bypassed. It is the same structural argument
 * that keeps a hard delete off this interface: `memberCount` on the team row is the SEAT
 * LEDGER, and it only stays correct because every membership transition moves it inside the
 * same transaction as the row. An unconditional `put` is a way to add a member WITHOUT
 * touching the counter — so it would corrupt the ledger silently, and the drift metric
 * would be the only thing that ever said so.
 *
 * So the write surface is exactly three verbs, one per transition, all transactional:
 * `admit` (+1, capped), `deactivate` (-1), `reactivate` (+1, capped). Adding a fourth
 * write path means deciding what it does to the counter, which is the question `put` let a
 * caller skip.
 */
export interface TeamMemberRepository {
  /**
   * An ACTIVE membership, or null.
   *
   * NULL FOR AN INACTIVE ROW — see the note above. This is the authorization read: it backs
   * canRead/canReadTeamContent and therefore every content surface, so "no row" and
   * "deactivated row" MUST be indistinguishable to a caller. They are the same answer.
   */
  get(teamId: string, userId: string): Promise<TeamMember | null>;
  /**
   * A membership row REGARDLESS of status, or null when there is none at all.
   *
   * ⚠ NEVER AN AUTHORIZATION SOURCE. A row from here may be INACTIVE, so `if (await
   * getIncludingInactive(...))` as a membership test GRANTS A REMOVED PERSON ACCESS. Two
   * legitimate callers, both of which need to know a deactivated row EXISTS:
   *
   *   - the reactivation route, whose whole job is to find one and flip it (and which must
   *     404 rather than silently create when there is no row at all — re-admitting a
   *     never-member is an invitation, not a reactivation);
   *   - the removal route, so removing an already-inactive member is idempotent instead of
   *     re-stamping `removedAt` and writing a second audit entry.
   */
  getIncludingInactive(
    teamId: string,
    userId: string
  ): Promise<TeamMember | null>;
  /**
   * The team's ACTIVE roster.
   *
   * INACTIVE ROWS ARE OMITTED, which is what keeps every existing caller correct with no
   * edit: member counts, the workshop roster's `_count.members`, the directory's user-id
   * resolution and the `?withMembers=1` fan-out all mean the LIVE team, and a removed person
   * appearing in any of them would be a regression of the hard delete's one good property.
   */
  listByTeam(teamId: string): Promise<TeamMember[]>;
  /**
   * The team's roster INCLUDING deactivated members — the "show he was joined but later
   * removed" read.
   *
   * ⚠ Rows here may be INACTIVE. The ONE caller is GET /teams/:teamId/members, which renders
   * `status` per member so the UI can show a Reactivate action. Anything counting members or
   * deciding access wants `listByTeam` above.
   */
  listByTeamIncludingInactive(teamId: string): Promise<TeamMember[]>;
  /**
   * Every membership for a user. ACTIVE ONLY, for the same reason `get` is: it backs
   * `/teams/mine`, the workshop entitlement union and the roster intersection, all of which
   * are "teams this person is on". A team they were removed from is not one of them.
   */
  listByUser(userId: string): Promise<TeamMember[]>;
  /**
   * ADMIT a member, ENFORCING THE SEAT CAP — the ONLY way a membership row is created.
   * Replaces `put` on both join paths.
   *
   * ── WHY THE CAP IS ENFORCED HERE AND NOT IN THE ROUTES ──
   *
   * The reason this file already gives about `get()`, applied to a write: *a rule enforced
   * at two of four call sites is a rule the other two break* — and `deactivate`/`reactivate`
   * are the other two. Both move the same counter, so all three transitions have to be
   * transactional or the ledger drifts. A route-level "count the roster, then write"
   * additionally loses the race it appears to win: two joiners at 9/10 both read 9, both
   * decide there is a seat, and both write.
   *
   * ONE `TransactWriteItems`, which makes the `teams` item the serialization point and the
   * whole admission linearizable on it:
   *
   *   Put    team-members  ConditionExpression: attribute_not_exists(userId)
   *   Update teams         SET memberCount = memberCount + :one
   *                        ConditionExpression: memberCount < seatCap
   *
   * ── THE THREE OUTCOMES ARE DISTINGUISHED BY *WHICH* CONDITION FAILED ──
   *
   *   "admitted"       the transaction committed. The row exists and the seat is taken.
   *   "already-member" the MEMBER item's condition failed — a row already exists for this
   *                    (teamId, userId). The caller answers 200: idempotent, nothing
   *                    granted, nothing to do.
   *   "full"           the TEAM item's condition failed — no seat left. 409 TEAM_FULL.
   *
   * ⚠ CONFLATING THE LAST TWO IS THE DEFECT §C CALLS OUT BY NAME: reporting "this team is
   * full" to somebody who is ALREADY ON THE TEAM. Both arrive as one
   * `TransactionCanceledException`, so the implementation reads
   * `CancellationReasons[i].Code === "ConditionalCheckFailed"` positionally. Do not
   * "simplify" that to a single catch.
   *
   * ⚠ `attribute_not_exists(userId)` MEANS AN *INACTIVE* ROW ALSO REPORTS "already-member",
   * and that is correct rather than a gap: re-admitting a removed person through a join
   * path would REPLACE the row whole and destroy the preserved `role` and `joinedAt` that
   * the soft delete exists to protect (a LEAD would come back a BUILDER). Restoring them is
   * `reactivate()`, which is audited, cap-checked, and keeps the row. The route logs the
   * distinction; the caller sees an idempotent 200 either way, which is honest — they have
   * no access in either case and the remedy is an operator action, not a retry.
   *
   * IDEMPOTENT UNDER RETRY at the store as well as by condition: the transaction carries a
   * `ClientRequestToken` derived from (teamId, userId), so a client retry inside DynamoDB's
   * 10-minute idempotency window is the same call rather than a second increment.
   *
   * LAZILY INITIALISES A LEGACY ROW. A team with no `memberCount` gets one from a
   * STRONGLY CONSISTENT roster count first, guarded by `attribute_not_exists(memberCount)`
   * so two concurrent initialisers cannot both win. Required, not optional: DynamoDB
   * evaluates `memberCount < :cap` as FALSE for an absent attribute, so without it every
   * join to every pre-existing team is refused.
   *
   * THROWS on a real store failure — anything that is not one of the two modelled condition
   * failures. A join that silently failed would tell somebody they are on a team they cannot
   * open.
   */
  admit(member: TeamMember, workshopId: string): Promise<AdmitOutcome>;
  /**
   * DEACTIVATE a membership — the removal, which KEEPS THE ROW.
   *
   * Named `deactivate` rather than left as `delete` deliberately: a method called `delete`
   * that does not delete is a trap for the next reader, and the rename makes every call site
   * state which it means. There is NO hard-delete method on this interface at all, so a
   * removal cannot destroy the audit-bearing row by accident.
   *
   * CONDITIONAL AT THE STORE on the row existing and not already being INACTIVE, exactly
   * like the invitation flips: `removedAt` records the FIRST removal and never moves, which
   * matters because operators retry (a double-click, a client retry, uncertainty about
   * whether the first attempt landed) and the timestamp is evidence of when access was
   * withdrawn.
   *
   * Returns TRUE only when THIS call performed the flip. FALSE means there was nothing to do
   * — no row, or already INACTIVE — so a repeated removal is idempotent without a
   * read-before-write, and the route can skip a second audit entry.
   *
   * THROWS on a real store failure (throttle, timeout, permissions). Never swallowed: a
   * deactivation that silently fails leaves a person with full access while the operator is
   * told they were removed, which is the one outcome this whole path exists to prevent.
   *
   * ── AND IT DECREMENTS THE SEAT LEDGER, IN THE SAME TRANSACTION ──
   *
   * The status flip and `memberCount = memberCount - 1` are ONE `TransactWriteItems`. They
   * have to be: a removal that flipped the row without freeing the seat would leave a team
   * permanently unable to replace the person it just removed, and there is no reconciliation
   * pass that would ever notice.
   *
   * `workshopId` is REQUIRED for that second item — `teams` is keyed (workshopId HASH, id
   * RANGE) so the Update needs both halves. Callers already hold the team row.
   *
   * ⚠ THE DECREMENT IS FLOORED AT ZERO by its own condition (`memberCount > :zero`), and a
   * team row with NO `memberCount` decrements nothing rather than initialising. Both are
   * deliberate: this path must never fail a removal an operator asked for, so an
   * unrepresentable ledger state costs a drift-metric mismatch rather than the withdrawal.
   * The access change is what matters and it happens either way.
   */
  deactivate(
    teamId: string,
    userId: string,
    removedBy: string,
    removedByRole: string,
    workshopId: string
  ): Promise<boolean>;
  
  reactivate(
    teamId: string,
    userId: string,
    reactivatedBy: string,
    workshopId: string
  ): Promise<AdmitOutcome>;
}

export interface InvitationRepository {
  get(teamId: string, email: string): Promise<Invitation | null>;
  /**
   * Every invitation for an email across all teams (via the email-index GSI).
   * Backs the invite-only signup gate: registration is allowed only when the
   * email has at least one invitation. Newest/highest-privilege wins upstream.
   */
  listByEmail(email: string): Promise<Invitation[]>;
  /**
   * The invitation an invite LINK points at, resolved by the token's SHA-256 (via
   * the tokenHash-index GSI). Returns null when no row matches — possession of the
   * token is the only way in, so the caller need not supply an email.
   */
  getByTokenHash(tokenHash: string): Promise<Invitation | null>;
  listByTeam(teamId: string): Promise<Invitation[]>;
  put(invitation: Invitation): Promise<Invitation>;
  /**
   * Mark an invitation ACCEPTED, ONCE.
   *
   * IDEMPOTENT BY CONTRACT, not by the caller remembering to check. It runs on every
   * sign-in (see POST /invitations/mine/accept), so a plain SET would re-stamp
   * `acceptedAt` on each visit and destroy the one fact the field exists to record:
   * WHEN the person first took up the grant. Implementations MUST make the write
   * conditional on the row not already being ACCEPTED.
   *
   * Returns TRUE only when THIS call performed the flip. False means there was
   * nothing to do — no row for that email, or it was already ACCEPTED — so a caller
   * can tell "first acceptance" from "already accepted" without a read-before-write.
   *
   * THROWS on a real store failure (throttle, timeout, permissions). Deliberately not
   * swallowed: an accept that silently fails is precisely how a row stays PENDING
   * after the person has signed in, which is the defect this contract was tightened
   * for. Callers on a path that must not fail (a join, a sign-in) catch and log it;
   * the operation is safely retried on the next sign-in.
   */
  accept(teamId: string, email: string, acceptedBy?: string): Promise<boolean>;
  /**
   * REVOKE an un-redeemed invitation, deleting the row outright.
   *
   * Deleting is the point, not a shortcut: an invitation row IS the permission to
   * register (the Cognito pre-signup trigger admits any email with a live row, and
   * post-confirmation reads platformRole off it), so flipping a status field would
   * leave the grant intact unless every one of those readers learned the new
   * status. While the row exists, the grant exists.
   *
   * Returns false when there was nothing to revoke, so the caller can 404 rather
   * than reporting success for a no-op. Callers MUST refuse to revoke an ACCEPTED
   * invitation — that row is the audit record of a redeemed grant, and the user's
   * access by then lives in Cognito, not here.
   */
  revoke(teamId: string, email: string): Promise<boolean>;
  /**
   * Flip an invitation to the TERMINAL `REVOKED` status, KEEPING THE ROW.
   *
   * THE OTHER REVOKE, and the distinction is the whole reason there are two methods:
   *
   *   revoke()      DELETES an un-redeemed row. The row IS the permission to REGISTER
   *                 (the Cognito pre-signup trigger admits any email holding a live
   *                 one), and for a PENDING row there is no history worth keeping —
   *                 nobody redeemed it. Refused for an ACCEPTED row by its callers.
   *   markRevoked() FLIPS an ACCEPTED row. The person DID redeem it, so the row is the
   *                 record of who invited them and when they accepted — and the
   *                 former-members view derives `joinedAt` from that `acceptedAt`.
   *                 Deleting it would erase history to fix an access bug.
   *
   * Written when a member is REMOVED from a team. Without it the invitation survives as
   * a standing permission to return: POST /teams/join found a row for the caller's
   * email and admitted them, VERIFIED EXPLOITABLE against the deployed stack —
   * membership re-created as BUILDER with no record of the rejoin.
   *
   * IDEMPOTENT BY CONTRACT, conditional AT THE STORE on the row not already being
   * REVOKED, so `revokedAt` records the FIRST revocation and never moves. Removal is
   * retried by operators (a double-click, a client retry) and the timestamp is evidence.
   *
   * Returns TRUE only when THIS call performed the flip. FALSE means there was nothing to
   * do — no row for that email on that team, or it was already REVOKED — which is the
   * normal case for a member who joined before invitations were required, so a caller
   * must NOT treat false as a failure.
   *
   * THROWS on a real store failure (throttle, timeout, permissions), for the same reason
   * accept() does: a revocation that silently fails is how a removed person keeps a live
   * way back in. The removal route catches, reports it in the response, and logs loudly.
   */
  markRevoked(
    teamId: string,
    email: string,
    revokedBy: string
  ): Promise<boolean>;
  /**
   * CLEAR the WORKSHOP ENTITLEMENT on an invitation, KEEPING THE ROW AND ITS STATUS.
   *
   * THE THIRD REVOKE, and the reason there are three is that each one destroys a different
   * amount and the amounts are not interchangeable:
   *
   *   revoke()         DELETES an un-redeemed row. Refused for a terminal row by its callers.
   *   markRevoked()    FLIPS status to REVOKED, keeping the row. Withdraws the WHOLE grant.
   *   clearWorkshop()  REMOVES ONE ATTRIBUTE. Withdraws only the workshop entitlement; the
   *                    row, its `status`, its `acceptedAt` and its provenance all survive.
   *
   * WHY IT HAS TO EXIST. A JUDGE's workshop access lives ENTIRELY in
   * this attribute — WORKSHOP_POLICY.JUDGE is "REQUIRED", they are never a team member, and
   * `GET /v1/entitlements/workshops` reads `inv.workshopId` off the row. Until this method
   * there was no way to withdraw a REGISTERED judge's workshop access at all: `revoke()` is
   * refused on a terminal row (that row IS the audit record) and `markRevoked()` would kill
   * the whole invitation, which is a heavier act than the operator asked for and is what the
   * removal path does to a team member. The row-preserving reasoning that makes DELETE's
   * refusal right is exactly what makes THIS safe: clearing one attribute destroys no history.
   *
   * IDEMPOTENT BY CONTRACT, conditional AT THE STORE on the attribute still being there, so
   * `workshopRevokedAt` records the FIRST withdrawal and never moves — operators retry (a
   * double-click, a client retry) and that timestamp is evidence of when the entitlement was
   * withdrawn. Not a read-then-write, which would race two concurrent calls into two
   * timestamps and two audit entries.
   *
   * `workshopRevokedBy` is written in the SAME update as the removal, so the operator's
   * identity survives an audit write that fails — the property UnauditedAccessChangeAlarm's
   * runbook calls "recoverable from the row". Implementations MUST NOT split the two.
   *
   * Returns TRUE only when THIS call cleared it. FALSE means there was nothing to do — no row
   * for that address on that team, or the row carries no `workshopId` (already cleared, or a
   * role for which a workshop is FORBIDDEN). The caller MUST disambiguate "no row" from
   * "nothing to clear" with a read, because those are a 404 and a 200.
   *
   * THROWS on a real store failure (throttle, timeout, permissions), for the same reason
   * `markRevoked` does: an entitlement withdrawal that silently failed would leave a judge
   * reading a workshop while the operator was told the access was gone.
   */
  clearWorkshop(
    teamId: string,
    email: string,
    revokedBy: string
  ): Promise<boolean>;
}

/** Minimal projection of a user this service needs (name + email for display).
 *  Populated from Identity's `user.created`/`user.updated` events — this is how we
 *  avoid reading the users table across a service boundary. */
export interface UserView {
  id: string;
  name: string;
  email?: string;
}
export type UsersReadModel = ReadModel<UserView, string>;

/**
 * ONE AUDIT ENTRY — who did what to whom, for the access-affecting actions.
 *
 * A LOCAL COPY of the AuditEntry shape in shared/types/audit.ts, for the same
 * reason as ROLE_GRANTS and PLATFORM_INVITATION_TEAM_ID above: bundled Lambdas take no
 * dependency on that package. The shared copy is what the portal renders; this one is what
 * gets written. Keep the two in step — a field written here and absent there simply never
 * appears in the UI, which is a silent loss on a trail whose whole point is completeness.
 */
export interface AuditEntryWrite {
  /**
   * WHO the action was about — the table's partition key, and ALWAYS a user id.
   *
   * It was briefly widened to admit a TEAM id, for the break-glass content access removed
   * from routes.ts. Narrowed back with that route: every remaining action is about a person,
   * so `GET /audit/users/:userId` reaching every entry in a subject's partition is true again
   * rather than true-except-for-one-action.
   */
  subjectId: string;
  /**
   * MEMBER_RESTORED is the FOURTH member, and it was added against a real bar — a previous
   * fourth action (TEAM_CONTENT_ACCESSED) was deleted for being unnecessary, so "do we need
   * one?" is a question with a known answer of "usually no".
   *
   * IT IS NEEDED, because MEMBER_REMOVED CANNOT EXPRESS A RESTORATION. The trail is
   * append-only by IAM (no UpdateItem, no DeleteItem — see AuditRepository), so a
   * reactivation cannot amend the removal entry it reverses; and an audit entry is a
   * historical record of an act, not a piece of mutable state, so there is nothing about the
   * MEMBER_REMOVED row that could be flipped even if the store allowed it. Without a fourth
   * action, restoring someone's access is the ONE access-affecting act on this platform that
   * leaves no record of who did it — which is precisely the gap the trail exists to
   * close (attributing every access-affecting act), and it would be worse here than for a removal because
   * granting access back is the direction that adds privilege.
   *
   * Named for the ACCESS_DISABLED/ACCESS_ENABLED pair: same subject noun as the action it
   * reverses, past participle, reversal second.
   *
   * ENTITLEMENT_REVOKED is the FIFTH, added with the route that withdraws a
   * JUDGE's WORKSHOP access. It clears the same bar the fourth had to:
   * NO EXISTING ACTION CAN EXPRESS IT. MEMBER_REMOVED is about a team roster and a judge is
   * never on one; the platform ACCESS_* pair is about signing in at all, which this does not
   * touch. Without it, withdrawing a registered judge's read access to a workshop — the only
   * remaining un-revocable grant on the platform — would leave no record of who did it.
   *
   * ⚠ ITS `subjectId` IS THE INVITATION'S `acceptedBy`, which is the best sub this context can
   * resolve from an EMAIL-keyed row (this service has no email → sub lookup, and reading
   * Identity's users table is forbidden to it). Normally that IS the invitee; on a
   * staff-reconciled row it is the reconciler. The route reports
   * `auditSubjectResolved: false` and emits no alarm datapoint when the field is absent
   * altogether — read the note at the call site before relying on this partition.
   *
   * NOT MIRRORED in shared/types/audit.ts yet — see the header note on keeping
   * the two in step. Nothing renders the trail's action label today (no consumer of
   * AUDIT_ACTION_LABELS anywhere in the portal or desktop), so the consequence is
   * confined to a future UI showing this action unlabelled rather than any loss here.
   */
  action:
    | "MEMBER_REMOVED"
    | "MEMBER_RESTORED"
    | "ACCESS_DISABLED"
    | "ACCESS_ENABLED"
    | "ENTITLEMENT_REVOKED";
  actorId: string;
  actorRole: string;
  teamId?: string;
  teamName?: string;
  reason?: string;
  /**
   * WHEN THE REMOVED PERSON HAD JOINED — read off the membership row and denormalised here.
   *
   * STILL WRITTEN NOW THAT THE ROW SURVIVES, and that is a deliberate keep rather than an
   * oversight. It was originally here because the removal HARD-DELETED the row and this entry
   * became the only place `joinedAt` existed; the row now keeps it, so this copy is no longer
   * the sole record. It stays for two reasons:
   *
   *   1. Pre-ship removals were hard-deleted and their rows are GONE. Those entries are the
   *      only surviving evidence of those memberships, and former-members reads them.
   *   2. It pins `joinedAt` AS AT THIS REMOVAL. A person removed, re-invited and removed again
   *      has one row whose `joinedAt` is the LATEST join — so the row cannot answer "when had
   *      they joined, the time they were removed in March?" while each entry can.
   *
   * The invitation's `acceptedAt` remains deliberately NOT a substitute: one invitation row
   * carries one acceptedAt while a person can be removed and re-added several times, so
   * attributing it to a particular removal would be a guess presented as a fact.
   *
   * ABSENT on MEMBER_REMOVED entries written BEFORE this field existed, and the table is
   * append-only so there is no backfill. A reader must render absence as "join date
   * unknown" and NEVER as "never joined" — the entry itself proves they were a member.
   * Absent on the platform-access actions, which are not about a team at all.
   *
   * WRITTEN ON MEMBER_RESTORED TOO, where it is the joinedAt of the membership being
   * restored — so a restoration entry says which relationship it revived rather than only
   * that one was revived.
   */
  joinedAt?: string;
}

/**
 * ONE AUDIT ENTRY AS READ BACK — the write shape plus the two fields the store adds.
 *
 * A separate type from AuditEntryWrite rather than making those fields optional on it:
 * `record()` MUST NOT accept them (the store owns the clock and the key, and a caller
 * supplying `occurredAt` could backdate an append-only entry), while every reader NEEDS
 * them. Two types is what makes both true at the type level.
 *
 * Mirrors AuditEntry in shared/types/audit.ts, which is what the portal
 * renders — bundled Lambdas take no dep on that package, the same local-copy idiom as
 * AuditEntryWrite above.
 */
export interface AuditEntryRead extends AuditEntryWrite {
  /** `<ISO-8601>#<ulid>` — the sort key. The ULID suffix keeps same-millisecond
   *  actions from colliding and silently overwriting one another. */
  at: string;
  /** The ISO instant alone, denormalised so a reader need not parse the composite key. */
  occurredAt: string;
}

/**
 * APPEND-ONLY store for audit entries.
 *
 * Deliberately has NO update and NO delete, and that is the interface doing the enforcing
 * rather than a comment asking for restraint: there is no method by which a caller in this
 * service could rewrite history, so a bug on the write path cannot silently alter a trail.
 * The IAM grant matches (PutItem + Query, never UpdateItem or DeleteItem), so the same rule
 * holds even for a caller that bypasses this interface.
 *
 * `record` MUST NOT THROW into its caller's happy path. An audit write that fails is a real
 * problem, but failing the removal it was recording would be worse: the operator would
 * retry, the row is already gone, and the second attempt reports "not a member" — leaving
 * them unsure whether anything happened. The implementation logs and swallows; the route
 * reports what it knows via a flag.
 */
export interface AuditRepository {
  record(entry: AuditEntryWrite): Promise<boolean>;
  /** Newest first. Backs the "who removed this person?" view. */
  listBySubject(subjectId: string, limit?: number): Promise<AuditEntryRead[]>;
  /**
   * Every entry recorded against ONE TEAM, newest first — the FORMER MEMBERS read.
   *
   * The other direction the trail runs in. `listBySubject` answers "what happened to this
   * person" from the table's own partition key; this answers "who was removed from this
   * team", which needs a `teamId` index because the base table cannot answer it without a
   * Scan. See the TeamAuditIndex GSI in the infrastructure CloudFormation template.
   *
   * Returns EVERY action for the team, not only MEMBER_REMOVED, and the FILTERING IS THE
   * CALLER'S. Two reasons, both deliberate: `teamId` is absent on the platform-access
   * actions so the index holds only team-scoped entries anyway, and a store-side
   * FilterExpression is applied AFTER the Limit — so filtering here would silently return
   * fewer rows than asked for and read as "there were no more removals".
   *
   * BOUNDED by `limit`, clamped in the implementation. A former-members list is a roster
   * view, not a paginated log.
   */
  listByTeam(teamId: string, limit?: number): Promise<AuditEntryRead[]>;
}
