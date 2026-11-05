import type { InvitedBy } from "@/lib/trpc/routers/admin";

/**
 * "Invited by <name>", the provenance line for an invitation or an account.
 *
 * LIFTED OUT OF admin/page.tsx (where it was a private function) so the team view can
 * use it too. Owner, Test 4: "In the team invitations its not showing who invited for
 * workshop/team/team invites". The tRPC layer was already resolving the field -
 * `team.listInvitations` calls `withInviters`, the same helper the Users tab uses, so
 * the data had been arriving and simply had nothing rendering it.
 *
 * WHY THE FIELD IS NOT JUST A NAME. The invitation row stores `invitedBy` as a bare
 * Cognito SUB, which must never reach a browser: a 36-character UUID is worse than
 * showing nothing. `withInviters` does the sub → name hop server-side and honours
 * USER_VISIBILITY_GRANTS, so a FACILITATOR still cannot learn about an ADMIN account
 * through this field, that is what `hidden` means below. Each state is therefore a
 * real, different fact and none of them is "unknown":
 *
 *   hidden               the inviter exists but this viewer may not see who they are
 *   name === null        the account has since been removed
 *   scope === PLATFORM   the grant was a platform role, not a team invitation
 *   basis === EARLIEST_INVITE
 *                        this person never accepted an invitation, so this is the
 *                        earliest one sent to their address rather than the one they
 *                        actually used, flagged because it is an inference
 *
 * Renders NOTHING when there is no `invitedBy` at all: an absent provenance line is
 * better than a line that says "unknown", which reads as data loss.
 */
export function InvitedByNote({ invitedBy }: { invitedBy?: InvitedBy }) {
  if (!invitedBy) return null;

  const who = invitedBy.hidden ? "Not shown" : (invitedBy.name ?? "account removed");

  return (
    <p className="text-xs text-ink-subtle truncate">
      Invited by {who}
      {invitedBy.scope === "PLATFORM" && " · platform role"}
      {invitedBy.basis === "EARLIEST_INVITE" && (
        <span
          title="This person has no accepted invitation, so this is the earliest invitation sent to their address rather than a record of the one they used."
          className="ml-1 border-b border-dotted border-field-border"
        >
          (earliest invite)
        </span>
      )}
    </p>
  );
}
