import { useSession } from "next-auth/react";
import {
  canAdministerUser,
  canGrantRole,
  canInvite,
  canManageUsers,
  canManageWorkshopSettings,
  invitableRolesFor,
  isReadOnlyRole,
  type PlatformRoleDefinition,
  type UserRole,
} from "@praimana/shared";

/** The current user's platform role, or undefined while the session loads. */
export function useRole(): UserRole | undefined {
  const { data: session } = useSession();
  return session?.user?.role;
}

/**
 * The platform roles the current user may GRANT by invitation, in display order.
 *
 * Empty for a PARTICIPANT (who may not invite at all), callers should hide the
 * invite UI entirely rather than render an empty dropdown. This narrows what is
 * OFFERED; the Team service independently decides what is ALLOWED (see ROLE_GRANTS
 * there), so a tampered client gains nothing.
 */
export function useInvitableRoles(): PlatformRoleDefinition[] {
  return invitableRolesFor(useRole());
}

/** True if the current user may send invitations at all. */
export function useCanInvite(): boolean {
  return canInvite(useRole());
}

/**
 * True for read-only roles that may view a team workspace but must not mutate
 * anything (EXECUTIVE). Use to hide write controls (analyze, invite, etc.).
 * UI gating only, the server enforces the same rule as the security boundary.
 */
export function useIsReadOnly(): boolean {
  return isReadOnlyRole(useRole());
}

/**
 * A predicate for "may the current user REVOKE an invitation that granted this
 * role", the same matrix as granting, because withdrawing a grant is as
 * consequential as making one (cancelling a senior person's onboarding is its own
 * harm, so a FACILITATOR must not be able to revoke an ADMIN invite).
 *
 * Returns a function rather than a boolean because a list renders rows of DIFFERENT
 * roles and each needs its own answer. Hides the control only; the Team service's
 * DELETE route re-checks against the STORED role, which is the copy that counts.
 */
export function useCanRevokeRole(): (grantedRole: string | undefined) => boolean {
  const role = useRole();
  return (grantedRole) => canGrantRole(role, grantedRole || "PARTICIPANT");
}

/**
 * True if the current user may reach the Administration area (user management) at
 * all, ADMIN and FACILITATOR. Use to show the nav entry.
 *
 * NARROWER than useCanAccessStaffScreens: a JUDGE scores and an EXECUTIVE observes,
 * and neither manages accounts. The route is independently gated in middleware.ts
 * and the identity service gates the API, so this only decides what is OFFERED.
 */
export function useCanManageUsers(): boolean {
  return canManageUsers(useRole());
}

/**
 * True if the current user's ROLE may configure experiences, create one, rename one,
 * move it through its lifecycle, choose its AI assistants. ADMIN and FACILITATOR.
 *
 * The role half ONLY. A facilitator may configure experiences in general but the
 * Workshop service still requires ownership (or ADMIN) on each individual write, so a
 * per-workshop control must ALSO check `ownerId === session.user.id`, see the
 * canOpenSettings note in app/experiences/[id]/page.tsx. Use this bare predicate for
 * role-level entry points (the Experiences tab, the Create button); combine it with
 * ownership for anything that acts on one specific experience.
 *
 * The route is independently gated in middleware.ts (via lib/route-gates), so this
 * only decides what is OFFERED.
 */
export function useCanManageWorkshopSettings(): boolean {
  return canManageWorkshopSettings(useRole());
}

/**
 * A predicate for "may the current user change or revoke the access of a user who
 * currently holds this role".
 *
 * Distinct from useCanRevokeRole, which is about withdrawing an INVITATION that has
 * not been redeemed. This is about an account already in use, where acting on a peer
 * is a lateral attack, so a FACILITATOR may act only on strictly lower roles, never
 * on another facilitator. See USER_ADMIN_GRANTS.
 *
 * Returns a function because a list renders rows of different roles. The row's own
 * `isSelf`/`hasAccount` flags are separate conditions the caller must also check;
 * this answers the ROLE question only.
 */
export function useCanAdministerUser(): (targetRole: string | undefined) => boolean {
  const role = useRole();
  return (targetRole) => canAdministerUser(role, targetRole);
}
