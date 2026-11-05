import type { PlatformRoleDefinition } from "@praimana/shared";

/**
 * The two rules every invite form shares: which role it will SUBMIT, and whether it may
 * submit at all.
 *
 * There are two invite forms, Administration → Invitations (staff, platform-scoped
 * roles) and the team workspace (team-scoped roles), and they had two copies of this
 * derivation. That is how one of them keeps a default the other has dropped, or how the
 * "must choose a role" guard lands on one screen and not the other. Same reasoning as
 * EmailChipsInput and SentAt: the behaviour that drifts between copies gets one
 * definition.
 *
 * Pure, and in lib/ rather than in a component, so the guard that decides whether a
 * platform role can be granted is unit-testable without a DOM (see invite-form.test.ts).
 */

/**
 * "No role chosen", the value the placeholder `<option>` carries and the value a
 * form holds until the operator picks something.
 *
 * The empty string specifically, because that is what a `<select>` whose selected option
 * has `value=""` reports. Named so the guard below and the render sites cannot disagree
 * about what "unchosen" looks like.
 */
export const NO_ROLE_SELECTED = "";

/**
 * The platform role an invite form will submit, or NO_ROLE_SELECTED.
 *
 * THERE IS DELIBERATELY NO DEFAULT. Both forms used to fall back to the first element of
 * `invitableRolesFor()`, Judge on the staff form, Participant on the team form, and the
 * order of INVITABLE_PLATFORM_ROLES was load-bearing precisely because alphabetising it
 * would have made ADMIN the pre-selected role on the one form that can mint another
 * platform administrator. Removing the default is strictly safer than choosing the
 * least-privileged one: granting a platform role is now always an explicit act, and no
 * ordering of any array can escalate a default that does not exist.
 *
 * `offered` is re-checked on every render rather than trusted once, so a selection that
 * stops being grantable (a session whose role narrowed, a tampered `<option>`) collapses
 * back to "nothing chosen" instead of being posted for the backend to refuse. That check
 * is convenience, not the boundary, the Team service re-applies ROLE_GRANTS against the
 * caller's token.
 */
export function submittedPlatformRole(
  selectedRole: string | null | undefined,
  offered: readonly PlatformRoleDefinition[]
): string {
  if (!selectedRole) return NO_ROLE_SELECTED;
  return offered.some((r) => r.role === selectedRole)
    ? selectedRole
    : NO_ROLE_SELECTED;
}

/**
 * Platform roles whose invitation MUST name a workshop before it can be sent.
 *
 * A deliberately narrow mirror of the `REQUIRED` row of WORKSHOP_POLICY in the Team
 * service (the team service's `routes.ts`), the copy that ENFORCES it. This one only
 * decides whether the form offers a picker and blocks the button; the service refuses
 * the request regardless, which is why this is a convenience and not the boundary.
 *
 * A Set of the roles rather than the whole three-valued policy table, because the form
 * has exactly one question to answer: does the operator still owe us a workshop? DERIVED
 * roles take theirs from the team the form already knows, and FORBIDDEN roles must not be
 * SHOWN a picker at all, which is the same answer as "not required" for the guard's
 * purposes, and reads correctly if a role is ever moved between those two.
 */
const ROLES_REQUIRING_WORKSHOP = new Set(["JUDGE"]);

/** True when an invitation granting this role cannot be sent without a workshop. */
export function requiresWorkshop(platformRole: string | null | undefined): boolean {
  return !!platformRole && ROLES_REQUIRING_WORKSHOP.has(platformRole);
}

/** Why an invitation cannot be sent yet, or `null` when it can. */
export type InviteBlockedReason =
  | "NO_ROLE"
  | "NO_EMAILS"
  | "NO_ROLE_OR_EMAILS"
  | "NO_WORKSHOP"
  | "SELF_INVITE";

/**
 * What is stopping this invitation, checked in a fixed order so the message is stable.
 *
 * Returns a REASON rather than a boolean because a disabled button with no explanation is
 * a support question, and the missing role is the non-obvious half, a form with no
 * visible default looks complete. The role is named first when both are missing: it is the
 * field with no placeholder text of its own to hint at it.
 *
 * THE WORKSHOP IS CHECKED AFTER THE ROLE, NECESSARILY: whether a workshop is owed is a
 * FUNCTION of the role, so there is nothing to ask for until one is chosen. It is checked
 * BEFORE the emails, because a judge invitation with no workshop is a real dead
 * end: the person registers, gets the JUDGE group, and can see no
 * workshop and score nothing, whereas "no addresses yet" is an obviously incomplete form.
 *
 * `workshopId` is deliberately a THIRD parameter with a default rather than an options
 * object: the two existing call sites pass two arguments and the team form has no
 * workshop to choose (it derives one), so this stays a two-argument call there and cannot
 * accidentally start demanding a workshop it has no picker for.
 */
export function inviteBlockedReason(
  platformRole: string,
  emailCount: number,
  workshopId: string | null | undefined = undefined,
  /**
   * Does the recipient list contain the CALLER'S OWN address?
   *
   * A FOURTH PARAMETER WITH A DEFAULT, for the same reason `workshopId` was the third: both
   * existing call sites pass fewer arguments and must keep working unchanged. Passed as a
   * decided boolean rather than as the caller's email plus the list, so the comparison rule
   * (lower-cased, trimmed) lives at the one call site that knows the session, and this
   * function stays pure and total over its inputs.
   */
  includesSelf = false
): InviteBlockedReason | null {
  const noRole = !platformRole;
  // Defensive against a NaN/negative length reaching here from a caller's own state:
  // "not a positive count" is "no emails", never "fine to send".
  const noEmails = !(emailCount > 0);

  if (noRole && noEmails) return "NO_ROLE_OR_EMAILS";
  if (noRole) return "NO_ROLE";
  /**
   * ⚠ CHECKED BEFORE THE WORKSHOP AND BEFORE THE EMAIL COUNT, which is a deliberate ordering
   * rather than an accident of where the line was added. A self-invitation is refused by the
   * Team service with 403 `SELF_INVITATION_REFUSED` (gate 3) NO MATTER WHAT ELSE IS FILLED IN,
   * so telling an operator to choose an experience first would send them to fix the one thing
   * that was not the problem, and they would then hit the same refusal from the backend.
   *
   * It is a COURTESY, not the boundary: the service refuses the request regardless, and it is
   * the only copy that matters. This exists so an admin who adds themselves to the list learns
   * why immediately, instead of filling in a whole form to receive a 403.
   */
  if (includesSelf) return "SELF_INVITE";
  // Trimmed, so a whitespace-only value from a caller's state is "not chosen" and can
  // never be posted for the backend to refuse.
  if (requiresWorkshop(platformRole) && !workshopId?.trim()) return "NO_WORKSHOP";
  if (noEmails) return "NO_EMAILS";
  return null;
}

/**
 * Is the caller's own address among the recipients? Lower-cased and trimmed on both sides.
 *
 * SEPARATE FROM THE GUARD so the comparison rule has one definition and matches the Team
 * service's gate exactly (`inv.email.trim().toLowerCase() === callerEmail.trim().toLowerCase()`).
 * A form that compared raw strings would let "admin@example.com" through the button and straight
 * into a 403.
 *
 * ⚠ NO CALLER EMAIL MEANS NO CLAIM. An absent session email returns false, "we cannot tell"
 * must not render as "you are inviting yourself", and the SERVICE is the thing that actually
 * refuses. The same reasoning as the service's own `callerEmail &&` guard.
 */
export function recipientsIncludeSelf(
  emails: readonly string[],
  callerEmail: string | null | undefined
): boolean {
  const self = callerEmail?.trim().toLowerCase();
  if (!self) return false;
  return emails.some((e) => e.trim().toLowerCase() === self);
}

/**
 * The operator-facing text for each blocked reason. One wording, both forms.
 *
 * A total Record rather than a lookup with a fallback: a reason with no message would
 * render an empty explanation under a dead button, and the compiler is the right place to
 * catch that when a reason is added.
 */
export const INVITE_BLOCKED_MESSAGE: Record<InviteBlockedReason, string> = {
  NO_ROLE_OR_EMAILS:
    "Choose a platform role and add at least one email address.",
  NO_ROLE: "Choose a platform role to send this invitation.",
  // Says what to do instead, because the refusal is absolute, there is no combination of role
  // and experience that makes a self-invitation send, so an operator needs the way forward
  // rather than a restatement of the rule.
  SELF_INVITE:
    "Remove your own address, nobody can invite themselves into an experience. Ask another administrator to invite you.",
  // Says WHY rather than just what is missing. "Choose a workshop" alone reads as
  // bureaucracy; a judge with no workshop genuinely cannot do the job they were invited
  // for, and an operator who knows that will not go looking for a way around it.
  NO_WORKSHOP:
    "Choose the experience this judge will evaluate, a judge with no experience can't see or score anything.",
  NO_EMAILS: "Add at least one email address.",
};
