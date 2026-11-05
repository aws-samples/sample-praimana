import type { TeamRole } from "../types/team";
import type { UserRole } from "../types/user";

export interface RoleDefinition {
  role: TeamRole;
  label: string;
  description: string;
}

export interface PlatformRoleDefinition {
  role: UserRole;
  label: string;
  description: string;
}

// Platform (account) roles that can be assigned when inviting someone to a team.
// PARTICIPANT is the default — most invitees are participants and only they take
// a team role (Lead/Builder/…). ADMIN is present but grantable ONLY by an existing
// ADMIN (see ROLE_GRANTS); the very first admin still comes from the seeded
// bootstrap invitation, not from this dropdown.
//
// ORDER = DEFAULT ORDER, NOT DISPLAY ORDER, and the distinction is load-bearing.
// Every invite form derives its PRE-SELECTED role from the FIRST element of
// invitableRolesFor() — see the derived `platformRole` in app/admin/page.tsx and in
// the team page — so this array decides what an operator sends when they submit
// without touching the dropdown. Re-sorting it to change how a dropdown READS would
// silently change what a dropdown DOES: on the team page the default would move from
// Participant to Admin. Alphabetical display order is a separate decision, applied to
// a COPY at the render site by platformRolesByLabel() below.
export const INVITABLE_PLATFORM_ROLES: PlatformRoleDefinition[] = [
  {
    role: "PARTICIPANT",
    label: "Participant",
    description: "Builds on a team — takes a team role and uses the desktop app",
  },
  {
    role: "JUDGE",
    label: "Judge",
    description: "Evaluates teams and submissions; sees all teams",
  },
  {
    role: "EXECUTIVE",
    label: "Executive",
    description: "Read-only observer of the team(s) they belong to",
  },
  {
    role: "FACILITATOR",
    label: "Facilitator",
    description: "Runs the workshop; can create workshops and see all teams",
  },
  {
    role: "ADMIN",
    label: "Admin",
    description: "Full platform access — only another admin can grant this",
  },
];

/**
 * The `teamId` written on an invitation that grants a PLATFORM role and no team.
 *
 * Inviting an admin, facilitator or judge is not a team action — there is no team
 * they belong to — but the invitations table's PARTITION KEY is `teamId`
 * (defined in the infrastructure CloudFormation template), and DynamoDB rejects a PutItem whose
 * partition key is absent or empty. A team-less invitation row is therefore not
 * representable: the choice is not "team or no team", it is which teamId value
 * means "none". This sentinel is that value.
 *
 * A sentinel rather than a schema change because both Cognito triggers are
 * deliberately scope-BLIND — pre-signup reads only `email` + `expiresAt` and
 * post-confirmation reads only `platformRole` + `expiresAt`, neither dereferences
 * `teamId` — so platform invitations flow through the invite-only gate and the
 * group assignment with no trigger change, no IAM change and no stack update. The
 * cost is that anything listing rows by team must know this key is not a team;
 * `invitationScope()` below is how it should ask, rather than by comparing strings.
 *
 * Not a ULID (every real teamId is), so it can never collide with a team, and it is
 * recognisable in a table dump.
 */
export const PLATFORM_INVITATION_TEAM_ID = "PLATFORM";

/** What an invitation is scoped to: a specific team, or the platform at large. */
export type InvitationScope = "TEAM" | "PLATFORM";

/**
 * The scope of an invitation, from its teamId. Rows written before platform
 * invitations existed have a real teamId and read as TEAM, which is correct — there
 * is no migration to run.
 */
export function invitationScope(
  teamId: string | null | undefined
): InvitationScope {
  return teamId === PLATFORM_INVITATION_TEAM_ID ? "PLATFORM" : "TEAM";
}

/**
 * Platform roles that are NOT tied to a team, and so are invited platform-scoped.
 *
 * ADMIN and FACILITATOR run the platform; a JUDGE evaluates across teams (see the
 * comment on judging authorization in the evaluation service — scoring is role-based
 * and deliberately not team- or workshop-scoped, so asking which teams a judge
 * belongs to would be asking a question nothing enforces).
 *
 * EXECUTIVE and PARTICIPANT are the team-scoped roles: an executive observes a
 * specific team and a participant builds on one, so both need a team chosen at
 * invite time.
 */
export const PLATFORM_SCOPED_ROLES: readonly UserRole[] = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
];

/** True if inviting to `role` needs no team chosen. */
export function isPlatformScopedRole(role: string | null | undefined): boolean {
  return !!role && (PLATFORM_SCOPED_ROLES as readonly string[]).includes(role);
}

/**
 * WHICH PLATFORM ROLES A ROLE MAY GRANT BY INVITATION.
 *
 * This is a privilege-escalation boundary, not a UI convenience. An invitation row
 * is the authoritative source the Cognito **pre-signup** trigger consults to admit
 * a signup and the **post-confirmation** trigger consults to assign the Cognito
 * group — so whoever can write `platformRole` decides who becomes an admin. Before
 * this matrix existed, `POST /v1/teams/:teamId/invitations` took `platformRole`
 * straight from the request body with no check at all, which let ANY authenticated
 * user (a PARTICIPANT included) mint themselves an `ADMIN` invitation and register
 * a second, fully privileged account.
 *
 * Read as: key = the inviter's role, value = the roles they may hand out.
 *
 *   ADMIN       → anything, including another ADMIN.
 *   FACILITATOR → everything EXCEPT ADMIN. A facilitator runs workshops and staffs
 *                 them, but must not be able to manufacture a peer with full
 *                 platform access.
 *   EXECUTIVE   → PARTICIPANT only. A sponsor may bring in their own builders, but
 *                 NOT fellow observers: an executive minting another executive is
 *                 lateral growth of a read-only role nobody staffed deliberately.
 *   JUDGE       → NOTHING. Judges used to be able to recruit fellow judges; that was
 *                 withdrawn. Judging is an assignment,
 *                 not a club that grows itself — and see the note below on why this
 *                 matters more now than it did.
 *   PARTICIPANT → NOTHING. A participant cannot invite, not even another
 *                 participant. An empty list is the closed case and is why the
 *                 backend must treat "no entry" and "empty entry" identically.
 *
 * WHY THE TWO WITHDRAWALS MATTER MORE THAN THEY LOOK. Since registration became
 * admin-provisioned (AllowAdminCreateUserOnly: true), sending an invitation no longer merely
 * records a permission: it CREATES A COGNITO ACCOUNT. So every entry in this table is
 * now an account-creation grant, which is a materially bigger thing to hand out than
 * it was when the invitee still had to register themselves. Staffing is consequently
 * ADMIN and FACILITATOR work, with the single exception of an executive bringing in
 * their own participants.
 *
 * Kept next to INVITABLE_PLATFORM_ROLES so the dropdown and the authorization
 * check are derived from ONE table. The Team service holds a deliberate copy
 * (routes.ts) because bundled Lambdas don't depend on this package; the two must
 * agree, and team's routes.test.ts asserts the full matrix to keep them honest.
 */
export const ROLE_GRANTS: Readonly<Record<UserRole, readonly UserRole[]>> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: ["PARTICIPANT"],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * A role's row from ONE of the three grant matrices, or [] — and the ONE place any of
 * them is read.
 *
 * ⚠ `Object.prototype.hasOwnProperty.call`, NEVER a plain index. A plain index walks the
 * PROTOTYPE CHAIN, so for EVERY matrix in this file `table["constructor"]` and
 * `table["toString"]` are FUNCTIONS, `table["__proto__"]` is an object, and
 * `table["hasOwnProperty"]` is a function — all TRUTHY. That defeated the guards each of
 * these predicates already had, in two different ways depending on the shape of the check:
 *
 *   `!!row && row.length > 0`      → a FUNCTION has a `length` (its arity), so
 *                                    `canInvite("constructor")` and
 *                                    `canManageUsers("hasOwnProperty")` returned TRUE.
 *                                    Both are gates on privilege boundaries: the first
 *                                    admits a role to the invitation route, which decides
 *                                    who can mint an ADMIN account; the second admits it
 *                                    to the Administration area.
 *   `row.includes(target)`         → a function has no `.includes`, so `canGrantRole`,
 *                                    `canAdministerUser` and `canSeeUser` THREW
 *                                    `TypeError: … is not a function` — a 500 out of an
 *                                    authorization predicate rather than a refusal.
 *   `?? []`                        → never fired, because a prototype hit is not nullish.
 *
 * Measured, not theorised: `canInvite("constructor") === true` and
 * `canManageUsers("hasOwnProperty") === true` before this change.
 *
 * NOT REACHABLE from any live call site today, and that is worth stating precisely rather
 * than leaning on: every role reaching these predicates comes from `collapseGroupsToRole`,
 * which can only emit the five declared roles. So this is defence in depth for a future
 * caller that passes a role straight from a token claim, a header or a query parameter —
 * which is what eventually happens to a shared authz helper. The failure direction is what
 * makes it worth closing anyway: two of the five FAILED OPEN.
 *
 * `Array.isArray` as well, so an own property whose value is somehow not an array still
 * yields the closed case instead of reaching a caller that will call `.includes` on it.
 */
function grantRow(
  table: Readonly<Record<string, readonly UserRole[]>>,
  role: string | null | undefined
): readonly UserRole[] {
  if (!role) return [];
  if (!Object.prototype.hasOwnProperty.call(table, role)) return [];
  const row = table[role];
  return Array.isArray(row) ? row : [];
}

/**
 * True if `inviterRole` may grant `targetRole`. Fails CLOSED: an absent,
 * unrecognised, or empty role grants nothing, so a token whose groups we don't
 * understand can never invite.
 *
 * "Unrecognised" includes every INHERITED key — see grantRow, where this used to throw.
 */
export function canGrantRole(
  inviterRole: string | null | undefined,
  targetRole: string | null | undefined
): boolean {
  if (!inviterRole || !targetRole) return false;
  return grantRow(ROLE_GRANTS, inviterRole).includes(targetRole as UserRole);
}

/**
 * True if the role may issue invitations at all (i.e. can grant ≥1 role).
 *
 * ⚠ This is a PRIVILEGE-ESCALATION GATE, not a UI convenience: it admits a caller to the
 * route that writes `platformRole` on an invitation, and since registration became
 * admin-provisioned an invitation CREATES a Cognito account. It returned TRUE for
 * `"constructor"` before grantRow, because a function's `length` is its arity — see the
 * note there.
 */
export function canInvite(role: string | null | undefined): boolean {
  return grantRow(ROLE_GRANTS, role).length > 0;
}

/**
 * The roles this inviter may offer, in INVITABLE_PLATFORM_ROLES order — i.e. with the
 * DEFAULT first. Callers that render a dropdown should sort a copy for display with
 * platformRolesByLabel() and take the default from THIS list's `[0]`.
 */
export function invitableRolesFor(
  role: string | null | undefined
): PlatformRoleDefinition[] {
  return INVITABLE_PLATFORM_ROLES.filter((r) => canGrantRole(role, r.role));
}

/**
 * ── ⚠ ADMIN ONLY — NARROWER THAN THE ADMINISTRATION AREA ITSELF ────────────────────────────
 *
 * The spend panel is for ADMINs only: it shows the estimated daily and overall platform spend.
 *
 * ⚠ THIS IS NOT `canManageUsers`, AND THE DIFFERENCE IS THE WHOLE POINT. That predicate admits ADMIN **and
 * FACILITATOR** — it gates the /admin route and every tab on it. A facilitator runs an experience; what the
 * platform costs to run is the platform operator's business, not theirs. So this is the first thing inside
 * Administration that its own page gate is too WIDE for.
 *
 * ⚠ AND IT IS A NAMED PREDICATE RATHER THAN `role === "ADMIN"` AT THREE CALL SITES. The tab that offers it,
 * the BFF, and the service route all have to agree; three inline string comparisons is how one of them ends
 * up checking `"admin"` in the wrong case, or how a new role silently inherits the answer. The service's
 * check is the one that counts — the UI check only decides whether the tab is offered.
 */
export function canSeePlatformSpend(role: string | null | undefined): boolean {
  return role === "ADMIN";
}

/**
 * How a platform role is WRITTEN for a person — "Participant", not "PARTICIPANT".
 *
 * Part of the rule that all labels are in initial caps. Screens that render a stored role were
 * shouting the enum value at the reader; a feedback card reading "someone@example.com · PARTICIPANT" is
 * three words of which one is typography.
 *
 * ⚠ DERIVED FROM `INVITABLE_PLATFORM_ROLES`, NOT A SECOND MAP. Those labels are already the words the invite
 * forms use, so a role renders identically wherever it appears, and a re-wording is one edit. A parallel
 * `Record<UserRole, string>` here is how "Executive" in one dropdown becomes "Exec" in a table.
 *
 * The fallback returns the raw value rather than "Unknown": an unrecognised role is something an operator
 * needs to SEE, and swallowing it would hide a bad row behind a friendly word.
 */
export function platformRoleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return INVITABLE_PLATFORM_ROLES.find((r) => r.role === role)?.label ?? role;
}

/**
 * The same roles sorted A→Z BY LABEL, for a dropdown an operator has to scan.
 *
 * WHY A SEPARATE FUNCTION RATHER THAN RE-ORDERING THE SOURCE ARRAY. A dropdown answers
 * two different questions at once: "where is the option I want" (scanning, which
 * alphabetical order serves) and "what happens if I just submit" (the default, which
 * every call site reads as `invitableRolesFor(role)[0]`). Those two wants are in direct
 * conflict — alphabetically, ADMIN sorts first, so re-ordering INVITABLE_PLATFORM_ROLES
 * would quietly make Admin the pre-selected role on the team page's invite form. That is
 * a privilege default changed by a cosmetic edit, which is exactly the class of mistake
 * this codebase's grant matrix exists to prevent. So order-for-humans is applied here,
 * to a COPY, and order-for-defaults stays in the source array.
 *
 * Sorted on `label` (what is actually on screen) and not on `role` (the wire code),
 * because a list that reads out of order to the person looking at it has not been
 * sorted. The two happen to agree today; a label like "Team admin" would part them.
 *
 * localeCompare, so accented and non-ASCII labels sort the way the reader's language
 * does rather than by code point. Copies first — Array.prototype.sort mutates, and
 * mutating the array a caller passed in (or the module-level constant behind it) is how
 * the default silently moves anyway.
 *
 * ONE CAVEAT, since these dropdowns render in client components that are prerendered on
 * the server and hydrated in the browser: localeCompare consults the RUNTIME's default
 * locale, so in principle the two could order the options differently and React would
 * report a hydration mismatch. It cannot happen for the labels that exist today — they
 * are plain ASCII words with distinct first letters, which every locale orders
 * identically. If a label is ever added that collides on accent or case ("Éditeur" vs
 * "Editeur"), pass an explicit locale here rather than trusting the ambient one.
 */
export function platformRolesByLabel(
  roles: readonly PlatformRoleDefinition[]
): PlatformRoleDefinition[] {
  return [...roles].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * WHICH ROLES MAY ADMINISTER AN EXISTING USER'S ACCOUNT.
 *
 * Deliberately SEPARATE from ROLE_GRANTS, not derived from it. The two answer
 * different questions and the difference is not cosmetic:
 *
 *   ROLE_GRANTS answers "whom may I INVITE?" — a forward-looking offer to someone
 *   with no account yet. Granting a PEER there is harmless: a facilitator staffing
 *   a workshop with a second facilitator takes nothing away from anyone.
 *
 *   This table answers "whose EXISTING access may I change or revoke?" — which
 *   reaches into an account that is already in use. Acting on a peer here is a
 *   lateral attack: one facilitator could disable another mid-workshop, or demote
 *   them to PARTICIPANT and take over their workshops. So a FACILITATOR may act
 *   only on STRICTLY LOWER roles — never an ADMIN, and never another FACILITATOR.
 *
 * ADMIN may act on any role, peers included: the top of the tree has to be able to
 * revoke a compromised or departed admin. Two guards make that safe and BOTH must
 * be enforced by the caller, because they need state this pure function cannot see:
 *   - never allow a self-action (an admin must not demote or lock out themselves),
 *   - never allow the LAST enabled ADMIN to be demoted or disabled (that would
 *     leave the platform with no one able to administer it).
 *
 * EXECUTIVE, JUDGE and PARTICIPANT administer nobody. An empty list is the closed
 * case, so "no entry" and "empty entry" must behave identically.
 */
export const USER_ADMIN_GRANTS: Readonly<Record<UserRole, readonly UserRole[]>> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: [],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * True if `actorRole` may administer a user whose current role is `targetRole` —
 * i.e. change their role or revoke their account access.
 *
 * Fails CLOSED on an absent or unrecognised role on EITHER side. An unknown TARGET
 * role matters as much as an unknown actor: if a new, more privileged role is added
 * to the platform and this table is not updated, nobody may touch those accounts
 * until someone makes a deliberate decision here.
 *
 * This is only the ROLE half of the check. Callers MUST also refuse self-actions
 * and refuse to remove the last enabled ADMIN — see USER_ADMIN_GRANTS.
 */
export function canAdministerUser(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined
): boolean {
  if (!actorRole || !targetRole) return false;
  return grantRow(USER_ADMIN_GRANTS, actorRole).includes(targetRole as UserRole);
}

/**
 * True if the role may reach the Administration area at all (i.e. may administer
 * ≥1 role). ADMIN and FACILITATOR only — used to gate the /admin route and hide
 * the nav entry. What they may do to an INDIVIDUAL user is still decided per row
 * by canAdministerUser.
 */
export function canManageUsers(role: string | null | undefined): boolean {
  // Via grantRow, so an INHERITED key is unrecognised. This returned TRUE for
  // `"hasOwnProperty"` and `"constructor"` before that, admitting them to the
  // Administration area — a function's `length` is its arity, which is > 0.
  return grantRow(USER_ADMIN_GRANTS, role).length > 0;
}

/**
 * WHICH ROLES A ROLE MAY SEE IN THE USER DIRECTORY.
 *
 * A THIRD matrix, and the one most likely to be mistaken for a duplicate of
 * USER_ADMIN_GRANTS. It is not: that table answers "whom may I ACT on", this one
 * answers "whom may I KNOW ABOUT". Deriving visibility from it would hide a
 * facilitator's OWN row and every peer facilitator's — the directory would show a
 * facilitator only their juniors, which is not what anyone asked for and would make
 * the screen useless for the ordinary "who is on this workshop" question.
 *
 *   ADMIN       → every role. An admin is accountable for the whole platform and
 *                 cannot be accountable for accounts they cannot see.
 *   FACILITATOR → everything EXCEPT ADMIN. Admins are deliberately INVISIBLE here:
 *                 a facilitator has no business enumerating who holds full platform
 *                 access. Knowing WHICH accounts are the valuable ones to phish or
 *                 socially engineer is itself the reconnaissance step, and it is
 *                 information a facilitator never needs to run a workshop.
 *   everyone else → nobody. They cannot reach the directory at all (canManageUsers),
 *                 so an empty list here is belt-and-braces rather than a live rule.
 *
 * Enforced SERVER-SIDE in the identity service, not by hiding rows in the client:
 * filtering in the UI would still ship every admin's name, email and organisation
 * to the browser of anyone who opened the network tab.
 */
export const USER_VISIBILITY_GRANTS: Readonly<
  Record<UserRole, readonly UserRole[]>
> = {
  ADMIN: ["ADMIN", "FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  FACILITATOR: ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"],
  EXECUTIVE: [],
  JUDGE: [],
  PARTICIPANT: [],
};

/**
 * True if `actorRole` may see a user whose role is `targetRole` in the directory.
 *
 * Fails CLOSED on either side being absent or unrecognised, which for a VISIBILITY
 * rule means a row of an unknown role is hidden rather than shown. That is the right
 * default: if a new, more privileged role is added and this table is not updated, it
 * stays out of every directory until someone decides otherwise — the opposite
 * default would silently expose it the day it was created.
 *
 * "Unrecognised" now includes every INHERITED key — see grantRow. Before that, a
 * `constructor`/`toString`/`__proto__` actorRole threw a TypeError out of this predicate
 * instead of returning false.
 */
export function canSeeUser(
  actorRole: string | null | undefined,
  targetRole: string | null | undefined
): boolean {
  if (!actorRole || !targetRole) return false;
  return grantRow(USER_VISIBILITY_GRANTS, actorRole).includes(
    targetRole as UserRole
  );
}

/**
 * The roles this actor may see, as a list to push into a store-level query.
 *
 * Returns [] for an absent or unrecognised role — the closed case. Callers must
 * treat an empty result as "return no users" and NOT as "no filter to apply", which
 * is the one mistake that would invert the whole rule.
 *
 * ALWAYS AN ARRAY, for every possible input. That is not a restatement of the return
 * type: it used to return a function for an inherited key like `constructor` (see
 * grantRow), which type-checked and would have failed only at the call site.
 *
 * LIVE AND LOAD-BEARING — this is the visibility filter behind
 * `GET /v1/admin/users` (identity/src/routes.ts), pushed into the store query so the
 * directory cannot enumerate a role the caller may not see. It is not a spare helper.
 */
export function visibleRolesFor(
  actorRole: string | null | undefined
): readonly UserRole[] {
  return grantRow(USER_VISIBILITY_GRANTS, actorRole);
}

export const TEAM_ROLES: RoleDefinition[] = [
  {
    role: "LEAD",
    label: "Lead",
    description: "Coordinates the team, makes final decisions, ensures delivery",
  },
  {
    role: "BUILDER",
    label: "Builder",
    description: "Implements the technical solution, writes code, configures services",
  },
  {
    role: "PRODUCT",
    label: "Product",
    description: "Defines requirements, validates against business needs, owns the demo narrative",
  },
  {
    role: "DESIGNER",
    label: "Designer",
    description: "Shapes the user experience, creates mockups, ensures usability",
  },
  // Added because an executive invited to a team was showing as "Builder", because
  // the invite form defaulted the dropdown to BUILDER and nobody had changed it. These
  // two give the non-building participants of a team an honest label.
  {
    role: "EXECUTIVE",
    label: "Executive",
    description: "Observes progress and outcomes; does not build",
  },
  {
    role: "COACH",
    label: "Coach",
    description: "Guides and unblocks the team; advises rather than delivers",
  },
];
