export type AuthProvider = "EMAIL" | "COGNITO";
export type UserRole = "ADMIN" | "FACILITATOR" | "EXECUTIVE" | "PARTICIPANT" | "JUDGE";

// Authentication is native Amazon Cognito and the platform ROLE lives in Cognito
// Groups (the `cognito:groups` claim). A user can be in more than one group, so we
// collapse to the single authoritative role by precedence (lower index wins).
// This MUST mirror the group Precedence in the infrastructure CloudFormation template
// and the backend collapse in `services/service-shared/src/edge-identity.ts` — one
// source of truth shared by both front-ends so authZ can never drift.
export const ROLE_PRECEDENCE: readonly UserRole[] = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
  "EXECUTIVE",
  "PARTICIPANT",
];

/**
 * Collapse a Cognito `cognito:groups` claim (an array of group names, or absent)
 * to the one authoritative platform role. Unknown/empty → PARTICIPANT (the least
 * privileged), so a missing claim can never grant elevated access (fail closed).
 */
export function collapseCognitoGroups(groups: unknown): UserRole {
  if (Array.isArray(groups) && groups.length > 0) {
    for (const role of ROLE_PRECEDENCE) {
      if (groups.includes(role)) return role;
    }
  }
  return "PARTICIPANT";
}

// Roles that may view a team workspace but must never mutate it. Kept here as
// the single source of truth so the UI, the admin BFF, and the backend all
// enforce the same read-only rule (defense-in-depth, not UI-only).
export const READ_ONLY_ROLES: readonly UserRole[] = ["EXECUTIVE"];

/** True if the role (if any) is read-only and must be denied write access. */
export function isReadOnlyRole(role: string | null | undefined): boolean {
  return !!role && (READ_ONLY_ROLES as readonly string[]).includes(role);
}

// Roles allowed to reach the web app's STAFF screens (workshops, team
// management, scoring). A PARTICIPANT is deliberately absent: they may sign in
// (see canSignInToWebApp) but only to reach the post-registration welcome page.
// Single source of truth so the route guard can't drift from the UI's
// assumptions (mirrors READ_ONLY_ROLES).
export const STAFF_APP_ROLES: readonly UserRole[] = [
  "ADMIN",
  "FACILITATOR",
  "EXECUTIVE",
  "JUDGE",
];

/** True if the role may reach the staff screens (everyone except PARTICIPANT). */
export function canAccessStaffScreens(role: string | null | undefined): boolean {
  return !!role && (STAFF_APP_ROLES as readonly string[]).includes(role);
}

/**
 * True if the role may sign in to the web app at all. EVERY invited person —
 * staff and participants — registers and signs in here: participants land on the
 * welcome page (team join code + desktop download), staff land on the workshop
 * list. Fails closed on an absent or unrecognised role, so a token whose groups
 * we don't understand mints no session.
 */
export function canSignInToWebApp(role: string | null | undefined): boolean {
  return !!role && (ROLE_PRECEDENCE as readonly string[]).includes(role);
}

/**
 * ── ⚠ WHO MAY SIGN IN TO THE *DESKTOP* APP ─────────────────────────────────────────────────
 *
 * The desktop app is only for executives and participants; no other role may sign in to it.
 *
 * The desktop is the working surface: it runs a participant's local AI CLI, syncs their repository files,
 * and carries the team workspace. An EXECUTIVE is on a team and releases its submission; a PARTICIPANT
 * does the work. Nobody else has anything to do there — an ADMIN, a FACILITATOR and a JUDGE all operate
 * from the portal, and offering them an app with no purpose for them is a support conversation waiting to
 * happen ("I installed it and it's empty").
 *
 * ⚠ THIS IS A PRODUCT RULE, NOT A SECURITY BOUNDARY, AND THE DIFFERENCE MATTERS. A facilitator who got
 * past it would gain NOTHING: the desktop calls the same API with the same token, and every team-scoped
 * write is checked against membership server-side. So it is enforced where the decision belongs — in the
 * desktop, at the end of sign-in, with a clear message — and NOT by a server check that would have to
 * invent a notion of "which app is calling" that the platform does not have and should not acquire.
 *
 * ⚠ AND IT IS DELIBERATELY NOT THE COMPLEMENT OF `canAccessStaffScreens`. An EXECUTIVE is BOTH staff (they
 * reach the portal's experience screens) and a desktop user. Writing this as `!canAccessStaffScreens(role)`
 * would have locked every executive out of the app they need most — the one where their team's work is.
 *
 * Fails closed on an absent or unrecognised role, like every other predicate here.
 */
export const DESKTOP_APP_ROLES: readonly UserRole[] = ["EXECUTIVE", "PARTICIPANT"];

export function canSignInToDesktopApp(role: string | null | undefined): boolean {
  return !!role && (DESKTOP_APP_ROLES as readonly string[]).includes(role);
}

// Where each role lands after sign-in. Participants get the onboarding page that
// hands them their join code and the desktop download; everyone else gets the
// experience list. Kept next to the role gate so the two can't disagree.
//
// ⚠ THIS IS A PORTAL ROUTE LIVING IN A SHARED PACKAGE, which is why it was missed when the route
// directory was renamed `/workshops` → `/experiences`: a sweep over `portal/src` does not reach
// it. `authz.test.ts` caught it — the test was updated with the rename and the constant was not, so
// the two disagreed and staff would have been redirected to a path that now 308s. Harmless because
// of the redirect, but a redirect on every single staff sign-in is a bug, not a design.
export const PARTICIPANT_LANDING_PATH = "/welcome";
export const STAFF_LANDING_PATH = "/experiences";

/** The post-sign-in landing path for a role. */
export function landingPathForRole(role: string | null | undefined): string {
  return canAccessStaffScreens(role) ? STAFF_LANDING_PATH : PARTICIPANT_LANDING_PATH;
}

// Roles allowed to create workshops. Only staff who run a workshop — ADMIN and
// FACILITATOR. EXECUTIVE (read-only observer) and JUDGE (evaluator) may view but
// never create. Single source of truth so the UI and the admin BFF agree.
export const WORKSHOP_CREATOR_ROLES: readonly UserRole[] = ["ADMIN", "FACILITATOR"];

/** True if the role may create workshops (ADMIN or FACILITATOR only). */
export function canCreateWorkshops(role: string | null | undefined): boolean {
  return !!role && (WORKSHOP_CREATOR_ROLES as readonly string[]).includes(role);
}

/**
 * True if the role may reach a workshop's SETTINGS — the configuration form behind
 * /workshops/<id>/settings, which renames an experience, moves it through its
 * lifecycle, and decides which AI assistants participants get.
 *
 * The same set as WORKSHOP_CREATOR_ROLES today, and deliberately its own function
 * rather than a second call to canCreateWorkshops at each call site: "who may make a
 * new experience" and "who may reconfigure an existing one" are two questions that
 * merely happen to share an answer right now. The day a role is allowed to run an
 * experience it did not create, forking them means editing this one function instead
 * of auditing every gate that guessed they were the same.
 *
 * This is the ROLE half only, and it is NOT the security boundary. The Workshop service
 * additionally requires OWNERSHIP on every write — `isOwnerOrAdmin` in
 * `services/workshop/src/routes.ts` — so a facilitator who reaches the form for somebody else's
 * workshop still cannot save it.
 *
 * ⚠ THAT FUNCTION'S NAME IS NOW A MISNOMER, AND THIS COMMENT USED TO REPEAT ITS CLAIM. It read
 * "requires OWNERSHIP (OR ADMIN)", which is no longer true: an ADMIN is scoped to
 * the experiences they OWN, so the function is `return workshop.ownerId === identity.id` and
 * admits nobody else. The name survives only because renaming it is a separate change; the
 * behaviour is ownership, full stop. See `services/ROLES.md` for the whole matrix.
 */
export function canManageWorkshopSettings(
  role: string | null | undefined
): boolean {
  return canCreateWorkshops(role);
}

export interface User {
  id: string;
  email: string;
  /**
   * Display name. DERIVED from firstName + lastName (see `displayName()` in
   * constants/profile.ts) and kept because several consumers read it — notably the
   * AI service's users read-model — so the parts could be introduced without
   * touching them. Write firstName/lastName; treat this as computed.
   */
  name: string;
  /** Mandatory, collected at sign-up. Source of truth for `name`. */
  firstName?: string;
  lastName?: string;
  /** Mandatory, collected at sign-up. Cognito `custom:organization`. */
  organization?: string;
  avatarUrl?: string;
  authProvider: AuthProvider;
  role?: UserRole;
  /**
   * Platform access, FOR DISPLAY ONLY. ABSENT MEANS ACTIVE — never test `!== "ACTIVE"`;
   * use isUserDeactivated(). See UserStatus below for why this is a mirror and not the
   * authority.
   */
  status?: UserStatus;
}

/**
 * Whether an account may be used at all — the platform-wide access switch.
 *
 * Removing a user's access makes the account inactive rather than deleting it, so they can no longer
 * reach the experience or team; it is a disable/enable switch on sign-in.
 *
 * ⚠ THIS FIELD IS A DISPLAY MIRROR, NOT THE AUTHORITY. COGNITO IS THE AUTHORITY.
 *
 * Enforcement is `AdminDisableUser` / `AdminEnableUser`: Cognito refuses to issue tokens
 * and refuses the refresh grant, which is what actually stops someone getting in. This
 * attribute exists for ONE reason — the identity service (which serves the Administration
 * directory) has no Cognito client and no Cognito IAM permissions, so without a mirrored
 * copy the screen could not show who is disabled or offer a way to reverse it.
 *
 * NEVER USE THIS AS AN AUTHORIZATION INPUT. Nothing calls isUserDeactivated() to decide
 * access, and nothing should start. That single rule is what stops a mirror from becoming
 * a second source of truth:
 *
 *   - If Cognito is disabled and this row failed to update, the person genuinely CANNOT
 *     sign in and the screen is briefly wrong. Visible, recoverable, no security impact.
 *   - If this row says DEACTIVATED and Cognito does not, the screen is wrong in the other
 *     direction — and STILL no security impact, precisely because nothing enforces on it.
 *
 * Make it an authz input and both of those become access bugs instead of display bugs.
 *
 * NO VERSION COUNTER, deliberately. An earlier design had `statusVersion` for optimistic
 * concurrency, which was right when the row was authoritative and two administrators could
 * race to own it. With Cognito authoritative the last writer wins there, and this row only
 * follows — a version counter on a cache is machinery with nothing to protect.
 *
 * RESIDUAL WINDOW, worth knowing and not fixable here: nothing stops an ALREADY-ISSUED
 * RS256 token at a native JWT authorizer, which validates signature/issuer/audience/expiry
 * offline and never consults Cognito or our data. So a disabled user keeps API access on an
 * unexpired token for up to its 30-minute lifetime (~60s in the portal, which revalidates
 * its session, and immediately for anything reading this row). Shortening that means
 * shortening `IdTokenValidity`, not adding a per-request check.
 */
export type UserStatus = "ACTIVE" | "DEACTIVATED";

/**
 * True only when DEACTIVATED is POSITIVELY ASSERTED.
 *
 * ABSENT STATUS MEANS ACTIVE, and the asymmetry is deliberate. Every user row written
 * before this field existed has no `status` attribute, so testing `status !== "ACTIVE"`
 * would deny every existing account the moment this deploys — and would keep denying them
 * through a rolling deploy where N and N+1 disagree. Testing for the deny value instead
 * means the old and new shapes agree, and no backfill is required.
 *
 * The cost of that choice, stated: a bug that STRIPS the attribute fails OPEN. That is the
 * right trade against a bug that locks out the whole platform, and it is why the write path
 * uses a conditional update rather than a blind put.
 */
export function isUserDeactivated(user: { status?: string | null }): boolean {
  return user.status === "DEACTIVATED";
}

/**
 * The machine-readable code a 403 carries when the caller's own account is deactivated.
 *
 * Distinct from every other 403 on the platform: the client must render a TERMINAL "your
 * access has been removed" state, not "session expired" and not a redirect back to sign-in
 * — which would loop a user through a login they can no longer complete.
 */
export const USER_DEACTIVATED_CODE = "USER_DEACTIVATED";
