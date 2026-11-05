"use client";

import { useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  INVITABLE_PLATFORM_ROLES,
  TEAM_ROLES,
  platformRolesByLabel,
} from "@praimana/shared";
import { trpc } from "@/lib/trpc/client";
import {
  INVITE_BLOCKED_MESSAGE,
  inviteBlockedReason,
  submittedPlatformRole,
} from "@/lib/invite-form";
import { formatInstantUtc } from "@/lib/format-datetime";
import { EmailChipsInput } from "@/components/EmailChipsInput";
import { SentAt } from "@/components/SentAt";
import { InvitedByNote } from "@/components/InvitedByNote";
import { Disclosure } from "@/components/Disclosure";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import {
  ActionOutcome,
  type ActionOutcomeState,
} from "@/components/ActionOutcome";
import {
  useCanInvite,
  useCanRevokeRole,
  useInvitableRoles,
  useIsReadOnly,
} from "@/lib/useRole";

/**
 * "Lead" from the stored team-role code, for the ONE sentence that reports a
 * restored role back to the operator.
 *
 * Separate from `roleLabel` below rather than a call to it, because that function's job is
 * to render a PLATFORM role with an optional team role hanging off it, passing a team
 * role alone would produce "Participant · Lead" and assert a platform role the
 * reactivate response never said anything about.
 *
 * Falls back to the raw code rather than to a guess: an unrecognised code is still a fact,
 * and "restored as LEAD" is readable where "restored as undefined" is a defect.
 */
function teamRoleLabel(teamRole: string): string {
  return TEAM_ROLES.find((r) => r.role === teamRole)?.label ?? teamRole;
}

/**
 * WHO REMOVED A FORMER MEMBER, the provenance line on a former-members row, and the one
 * place on this screen where a null is a DELIBERATE SUPPRESSION rather than missing data.
 *
 * `removedByName: null` means "not shown to YOU": a FACILITATOR reading a removal an ADMIN
 * performed gets null, because learning which accounts hold full platform access is itself
 * the reconnaissance step USER_VISIBILITY_GRANTS exists to stop (the same rule identity's
 * /admin/user-names honours by reporting `hidden: true`). It can also be null because the
 * actor's read-model row is gone, a staff account deleted since, and the two are NOT
 * distinguishable from this layer, which is why the wording below claims neither.
 *
 * `removedByRole` is ALWAYS present, so the role is rendered either way. That is what makes
 * "Removed by a Facilitator" possible, and it is the whole reason a blank is never
 * acceptable here: a row that says a removal happened and then refuses to say by whom in
 * any form is not a trail. The words "name not shown" are borrowed from InvitedByNote's
 * "Not shown" on purpose, an operator who has learnt to read a suppressed inviter should
 * read a suppressed remover the same way.
 */
function removedByLabel(
  removedByName: string | null,
  removedByRole: string
): string {
  // `roleLabel` with one argument gives the platform label ("Facilitator", "Admin"), and
  // falls back to the raw code for one it does not recognise. An EMPTY role is not in the
  // frozen contract, but it costs one branch to render it as an unnamed someone rather
  // than as "Removed by a " with nothing after it.
  const role = removedByRole ? roleLabel(removedByRole) : "";
  // "an Admin" / "an Executive" vs "a Facilitator". Cheap, and a mis-agreeing article on a
  // line an operator reads all shift is the kind of thing that makes a screen feel wrong.
  const article = /^[AEIOU]/i.test(role) ? "an" : "a";

  if (removedByName) {
    // The role stays alongside the name: it is the role AT THE TIME of the removal, which
    // is what the audit entry recorded and is not answerable from today's directory.
    return role
      ? `Removed by ${removedByName} (${role})`
      : `Removed by ${removedByName}`;
  }

  return role
    ? `Removed by ${article} ${role}, name not shown`
    : "Removed by someone whose name is not shown";
}

// Human-readable "Participant · Builder" (or just "Judge") from stored role codes.
function roleLabel(platformRole?: string, teamRole?: string): string {
  const platform =
    INVITABLE_PLATFORM_ROLES.find((r) => r.role === platformRole)?.label ??
    platformRole ??
    "Participant";
  const team = teamRole
    ? TEAM_ROLES.find((r) => r.role === teamRole)?.label ?? teamRole
    : undefined;
  return team ? `${platform} · ${team}` : platform;
}

export default function TeamPage() {
  const params = useParams();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;

  // Which platform roles THIS user may hand out, and whether they may invite at
  // all. An EXECUTIVE is read-only for team CONTENT yet may still invite fellow
  // executives and participants, so this section keys on canInvite rather than on
  // isReadOnly, see ROLE_GRANTS in @praimana/shared.
  const invitableRoles = useInvitableRoles();
  const canSendInvites = useCanInvite();
  const canRevokeRole = useCanRevokeRole();

  /**
   * MAY THIS CALLER REMOVE A MEMBER, the same question `requireTeamWrite` answers in the
   * Team service, asked the only way this screen can ask it.
   *
   * The backend's rule is `canRead AND NOT read-only`, where canRead is membership OR
   * workshop ownership OR ADMIN. This screen cannot evaluate the membership half: it is a
   * server-side fact about tables the browser never sees, and the roster in hand does not
   * settle it (a facilitator who owns the workshop may write a team they are not a member
   * of). What it CAN evaluate is the half that actually differs between the roles who
   * reach this page, the read-only exclusion, which is the clause that 403s an EXECUTIVE.
   *
   * So this is the read-only half, and it is deliberately the LOOSER of the two. Being
   * loose in this direction is the correct failure: a caller who is offered the control
   * and cannot use it gets the service's own 403 rendered in the outcome notice, which is
   * a legible refusal. Being loose in the other direction, hiding the control from
   * someone entitled to it, is the bug that has already happened once, and it is invisible.
   *
   * Everyone reaching this page has already passed `canRead` (getById would have failed
   * otherwise), so in practice the remaining gap is narrow.
   */
  const isReadOnly = useIsReadOnly();
  const canRemoveMembers = !isReadOnly;

  /**
   * The caller's own id, so their row is never offered a Remove button.
   *
   * Compared against `member.userId`, which is the Cognito sub the membership row is keyed
   * on, the same value NextAuth puts on `session.user.id` (see the jwt callback in
   * lib/auth.ts). Leaving the platform via a roster is not this screen's job, and an
   * operator who removes themselves loses the page they are standing on.
   */
  const { data: session } = useSession();
  const myUserId = session?.user?.id;

  const { data: team, isLoading } = trpc.team.getById.useQuery({ teamId, workshopId });

  /**
   * Invitations are FETCHED ON DEMAND, not on mount.
   *
   * They used to load with the page even though the section is now collapsed by default,
   * so every visit paid for a list nobody had asked to see, and for a participant, who
   * cannot invite at all, the request was pure waste. `enabled` ties the query to the
   * disclosure: the first expand issues it, and React Query caches it from then on, so
   * collapsing and reopening does not refetch.
   *
   * `showInvitations` is declared further down with the other disclosure state; hoisting
   * the whole block up here would separate it from the sibling `showMembers` it belongs
   * beside, so the query reads it instead.
   */
  const [showInvitations, setShowInvitations] = useState(false);
  const invitationsQuery = trpc.team.listInvitations.useQuery(
    { teamId },
    { enabled: showInvitations }
  );
  const sentInvitations = invitationsQuery.data ?? [];
  const refetchInvitations = invitationsQuery.refetch;
  /**
   * Whether the count in the collapsed heading can be TRUSTED yet.
   *
   * Deferring the fetch introduced a small lie: `sentInvitations` defaults to `[]`, so the
   * heading read "Invitations (0)" before anything had been requested, a stated zero for
   * data we had not loaded. The same mistake as the "0 teams" placeholder fixed earlier
   * today, at a smaller scale. Until the query has actually returned, the count is passed
   * as `undefined` and Disclosure omits it entirely (it renders only on
   * `typeof count === "number"`), so the heading says "Invitations" and claims nothing.
   */
  const invitationCount = invitationsQuery.isSuccess ? sentInvitations.length : undefined;

  // Revoking withdraws the permission to register, so the row goes away rather
  // than changing colour, refetch instead of patching local state, and surface the
  // backend's message when it refuses (e.g. an already-accepted invite).
  const [revokeError, setRevokeError] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);
  const revokeInvitation = trpc.team.revokeInvitation.useMutation({
    onSuccess: () => {
      setRevokeError("");
      refetchInvitations();
    },
    onError: (err) => setRevokeError(err.message || "Failed to revoke the invitation"),
    onSettled: () => setRevoking(null),
  });

  const utils = trpc.useUtils();

  /**
   * REMOVING A MEMBER: the control that selects a team member and removes them from the team or
   * makes them inactive.
   *
   * ── STATE LIVES HERE, NOT IN THE ROW ──
   * Three pieces, and all three are held at page level for the same reason the revoke
   * error is: the row is the thing being destroyed. `removing` keyed on the userId is the
   * local precedent (`revoking === inv.email`) and it survives the roster reordering
   * because a sub is stable where an array index is not. The outcome carries the member's
   * NAME because by the time it renders, the row that named them is gone.
   */
  const [pendingRemoval, setPendingRemoval] = useState<{
    userId: string;
    name: string;
  } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeOutcome, setRemoveOutcome] = useState<ActionOutcomeState | null>(null);

  /**
   * WHO each in-flight removal is about, keyed by userId, for the outcome message to name.
   *
   * A MAP AND NOT A SINGLE SLOT, and that is the whole correctness story here. Dismissing
   * the dialog mid-request is supported and does NOT cancel the request (no AbortSignal),
   * so a second removal can be confirmed while the first is still unanswered, one mutation
   * instance, two live requests. A single slot is overwritten by the second submit, so the
   * FIRST response then renders under the SECOND person's name: "Bob is no longer a member"
   * when Alice was the one removed. Since this notice is deliberately built to outlive the
   * row it refers to (see ActionOutcome), naming the wrong person is worse than saying
   * nothing, nobody learns Alice was removed, and Bob is reported gone before he is.
   *
   * Still a ref rather than the mutation input: the contract is `{ teamId, userId, reason? }`
   * and a display name has no business travelling to a service that would ignore it. Keyed
   * by the one field that IS in the input, so `variables.userId` on the response is enough
   * to recover the right label. Entries are deleted as each request settles.
   */
  const removalLabelsRef = useRef<Map<string, string>>(new Map());

  /**
   * The userId of the MOST RECENTLY submitted removal, i.e. the one the dialog on screen
   * and the row guards belong to.
   *
   * Every response is correlated against this before it is allowed to touch shared UI
   * state. An earlier request's answer may still report ITS OWN outcome (the operator is
   * owed that), but it must not close a dialog it does not own, release another row's
   * duplicate-submit guard, or set the focus ref, each of which is a different way for one
   * request's answer to act on a different request's interaction.
   */
  const currentRemovalRef = useRef<string | null>(null);

  /**
   * True once a removal has SUCCEEDED, so focus does not return to a Remove button that is
   * still on screen but about to be unmounted by the pending refetch.
   *
   * A ref, not state, and that is forced: the dialog reads this in its unmount cleanup,
   * which runs in the same commit as the state update that closes it, a state value would
   * not have propagated down yet. Reset when the next dialog opens.
   */
  const removalSucceededRef = useRef(false);

  const removeMember = trpc.team.removeMember.useMutation({
    onSuccess: (result, variables) => {
      // WHOSE ANSWER IS THIS. `variables` is the resolved input for THIS request, so it is
      // the only trustworthy identity available here, every piece of shared state has
      // already been overwritten if a second removal was confirmed in the meantime.
      const isCurrent = variables.userId === currentRemovalRef.current;
      const name = removalLabelsRef.current.get(variables.userId) ?? "The member";
      const where = team?.name ?? "this team";

      // Only the CURRENT request may claim the dialog's focus contract. Set from a stale
      // response, this would make the open dialog treat its trigger as doomed and send
      // focus to the Members heading, even though that row is still on the roster with a
      // live Remove button focus should have returned to.
      if (isCurrent) removalSucceededRef.current = true;
      // `audited: false` is not a success worth reporting as clean. The membership row is
      // hard-deleted, so the audit entry is the ONLY remaining evidence the person was
      // ever on this team, an unaudited removal has erased them with no record of who did
      // it, which the team service itself flags as worth an alarm.
      setRemoveOutcome(
        result.audited
          ? {
              kind: "confirmed",
              message: `${name} is no longer a member of ${where}.`,
            }
          : {
              kind: "partial",
              message: `${name} was removed from ${where}, but the action could not be written to the audit trail, so there is no record of who made this change. Report it.`,
            }
      );
      // Closing the dialog is the CURRENT request's business only. Unconditionally, a stale
      // answer tears an open confirmation out from under the operator, and pairs it with a
      // green "removed" notice while that person's own DELETE is still unanswered and may
      // yet 403.
      if (isCurrent) setPendingRemoval(null);
      // The roster is server state and one member shorter. Invalidated rather than patched
      // locally: the response says nothing about the rest of the team, and a hand-spliced
      // list would drift from the count in the Disclosure heading. Runs for a stale response
      // too, that member really is gone, so the roster really is stale.
      utils.team.getById.invalidate({ teamId, workshopId });
      // AND THE FORMER-MEMBERS LIST, which this removal has just added a row to. The only
      // edit to the existing removal flow, and it is required by the new section rather
      // than optional: the removal is now a soft delete, so the person leaves the roster
      // and appears in Former members in the same act. Refreshing one and not the other
      // leaves the two lists disagreeing about where that person is, they vanish from the
      // screen entirely until something else happens to refetch.
      utils.team.listFormerMembers.invalidate({ teamId });
    },
    onError: (err, variables) => {
      const isCurrent = variables.userId === currentRemovalRef.current;
      const name = removalLabelsRef.current.get(variables.userId) ?? "The member";
      // The service's own message first, because it names the rule that actually fired
      // ("Forbidden: your role has read-only access", "not a member of this team"). The
      // fallback covers a transport failure that produced no message at all, and says
      // which direction it failed in, nothing changed, so a retry is a safe next step.
      setRemoveOutcome({
        kind: "failed",
        message:
          err.message ||
          `${name} was not removed and their access is unchanged. Try again, and reload the page if it keeps failing.`,
      });
      if (isCurrent) setPendingRemoval(null);
    },
    onSettled: (_data, _err, variables) => {
      // THE GUARD THAT MATTERS. `removing` is the only thing between the operator and a
      // second DELETE, and the service's delete is unconditional, it records a
      // MEMBER_REMOVED entry every call. Released unconditionally, an earlier request
      // settling re-arms a button whose own request is still in flight, so a duplicate
      // becomes reachable with no deliberate retry at all.
      if (variables.userId === currentRemovalRef.current) {
        setRemoving(null);
        currentRemovalRef.current = null;
      }
      removalLabelsRef.current.delete(variables.userId);
    },
  });

  /**
   * ── FORMER MEMBERS, AND RESTORING ONE ─────────────────────────────────────────────
   *
   * THE REQUIREMENT: a removed team member is kept, in an inactive state, for audit, and can be made
   * active again later. Removal is now a SOFT
   * DELETE, the membership row survives marked inactive and keeps the team role, so a
   * removal is reversible, and this screen is where it gets reversed.
   *
   * The list itself is DERIVED FROM THE AUDIT TRAIL rather than from inactive rows (see the
   * route's own note): removals performed before the soft delete shipped hard-deleted their
   * rows, and the trail is the only place that history survives. So this list answers "who
   * was removed from this team, by whom, and why", which is a different question from the
   * roster's "who is on this team now".
   *
   * THE ERROR IS DESTRUCTURED, not discarded. `requireTeamRead` can refuse this (it is a
   * separate call from the roster's), and the read is best-effort against an audit store, so
   * a failure is possible on a page whose roster loaded perfectly. Swallowing it would render
   * a page that says, by the absence of the section, that nobody was ever removed from this
   * team, which is indistinguishable from the truth and is exactly the "quietly short list"
   * failure the BFF's `truncated` flag exists to prevent, in a worse form.
   */
  const { data: formerMembersData, error: formerMembersError } =
    trpc.team.listFormerMembers.useQuery({ teamId });
  const formerMembers = formerMembersData?.formerMembers ?? [];

  /**
   * RESTORING ACCESS, the inverse of the removal above, and DELIBERATELY ITS OWN STATE.
   *
   * Not shared with the removal flow, and that is not tidiness: the two mutations can be in
   * flight at the same time (nothing on either path cancels the other), and one `submitting`
   * slot or one outcome would let a removal's answer release a restore's button guard or
   * overwrite its notice. Two independent actions, two independent sets of guards.
   *
   * Every piece mirrors the removal's reasoning one-for-one, and each is commented at its
   * own declaration for the reason it is needed here rather than by reference.
   */
  const [pendingRestore, setPendingRestore] = useState<{
    userId: string;
    name: string;
    /** The address, for the dialog's target line. Null when the read-model has no row. */
    email: string | null;
  } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreOutcome, setRestoreOutcome] = useState<ActionOutcomeState | null>(null);

  /**
   * WHO each in-flight restoration is about, keyed by userId, for the outcome to name.
   *
   * A MAP AND NOT A SINGLE SLOT, for exactly the reason the removal's is. Dismissing the
   * dialog mid-request is supported and does NOT cancel the request (no AbortSignal), so a
   * second restoration can be confirmed while the first is unanswered, one mutation
   * instance, two live requests. A single slot is overwritten by the second submit and the
   * FIRST response then renders under the SECOND person's name: "Bob has access again" when
   * Alice was the one restored. On this direction that misnaming is worse than losing the
   * notice, because it reports ACCESS GRANTED to someone it is not true of, and the
   * operator has no reason to look again.
   *
   * A ref rather than the mutation input: the contract is `{ teamId, userId, reason? }` and
   * a display name has no business travelling to a service that would ignore it. Keyed by
   * the one field that IS in the input, so `variables.userId` recovers the label. Entries
   * deleted as each request settles.
   */
  const restoreLabelsRef = useRef<Map<string, string>>(new Map());

  /**
   * The userId of the MOST RECENTLY submitted restoration, the one the dialog on screen and
   * the row guards belong to.
   *
   * Every response is correlated against this before it touches shared UI state. An earlier
   * request's answer may still report ITS OWN outcome (the operator is owed that, a
   * restoration they asked for either happened or did not), but it must not close a dialog
   * it does not own or release another row's duplicate-submit guard.
   */
  const currentRestoreRef = useRef<string | null>(null);

  /**
   * True once a restoration has SUCCEEDED, so focus does not return to a Restore button that
   * is still on screen but about to be unmounted by the pending refetch.
   *
   * A ref and not state, for the timing reason ConfirmActionDialog's `returnToFallback`
   * documents: the dialog reads this in its unmount cleanup, which runs in the same commit
   * as the state update that closes it, so a state value would not have propagated down yet.
   * It applies here for the same reason it applies to the removal, a restored person LEAVES
   * the former-members list (the service omits anyone who is a member again), so the row
   * carrying the trigger is doomed the moment the request succeeds. Reset when the next
   * dialog opens.
   */
  const restoreSucceededRef = useRef(false);

  const reactivateMember = trpc.team.reactivateMember.useMutation({
    onSuccess: (result, variables) => {
      // WHOSE ANSWER IS THIS. `variables` is the resolved input for THIS request and the only
      // trustworthy identity here, every piece of shared state has already been overwritten
      // if a second restoration was confirmed in the meantime.
      const isCurrent = variables.userId === currentRestoreRef.current;
      const name = restoreLabelsRef.current.get(variables.userId) ?? "That person";
      const where = team?.name ?? "this team";

      // Only the CURRENT request may claim the dialog's focus contract. Set from a stale
      // response, this would make the open dialog treat its trigger as doomed and send focus
      // to the Former members heading, even though that row is still listed with a live
      // Restore button focus should have returned to.
      if (isCurrent) restoreSucceededRef.current = true;

      /**
       * THE PRESERVED TEAM ROLE, reported when the service sent one.
       *
       * This is the reassuring detail and the whole point of the row surviving the removal:
       * a LEAD comes back a LEAD, where the old hard delete destroyed the role and a re-added
       * member returned as whatever their next invitation happened to say. `role` may be `""`
       * from a service version that does not send it, and in that case the sentence says
       * NOTHING about role rather than "restored as undefined".
       */
      const asRole = result.role ? ` Their team role is unchanged: ${teamRoleLabel(result.role)}.` : "";

      setRestoreOutcome(
        result.audited
          ? {
              kind: "confirmed",
              message: `${name} is a member of ${where} again.${asRole}`,
            }
          : {
              /**
               * `audited: false` IS A PARTIAL, NOT A CONFIRMED, and the wording has to be
               * true under TWO readings at once.
               *
               * The service writes ONE audit entry per real flip, and reactivation is
               * IDEMPOTENT BY INTENT: an already-active member answers 200 with
               * `audited: false` and writes no second entry, because the caller's intent
               * ("this person should have access") already held. So `audited: false` means
               * EITHER a real restoration that went unrecorded OR a harmless no-op on
               * somebody who already had access, and the BFF states plainly that the two
               * are not distinguishable from this layer.
               *
               * So the message claims NEITHER. It states the fact that is true in both
               * readings (they have access now), names the gap that is true in both (no
               * audit entry was written for THIS action), and asks for it to be reported -
               * because in the reading where it was a real flip, access was GRANTED with no
               * record of who granted it, and that is the direction that ADDS privilege.
               * Guessing "they already had access" would talk an operator out of reporting
               * the serious case; asserting "unrecorded restoration" would send them
               * chasing an incident that may not exist.
               *
               * NOT a `failed`, deliberately: a retry cannot write the missing entry and
               * would only repeat a request that already achieved its intent.
               */
              kind: "partial",
              message: `${name} has access to ${where}.${asRole} No audit entry was written for this action, so there is no record of who restored it; this is also what a repeat request on someone who already had access looks like, and the two cannot be told apart from here. Report it.`,
            }
      );

      // Closing the dialog is the CURRENT request's business only. Unconditionally, a stale
      // answer tears an open confirmation out from under the operator, and pairs it with a
      // green "restored" notice while that person's own request is still unanswered and may
      // yet 403 (the service refuses a subject whose role may not hold team membership) or
      // 404 (no membership row at all, that person needs an invitation, not a restore).
      if (isCurrent) setPendingRestore(null);

      /**
       * INVALIDATE BOTH LISTS, never patch either.
       *
       * This one action moves a person BETWEEN two server-owned lists: they leave Former
       * members (the route omits anyone who is a member again) and join the roster. Splicing
       * either by hand would let the two drift, the same person visible in both, which says
       * the relationship both ended and did not, or in neither, which loses them entirely.
       * Both counts in the Disclosure headings come from the same responses for free.
       *
       * Runs for a STALE response too: that person really is a member again, so both lists
       * really are stale regardless of which request answered.
       */
      utils.team.getById.invalidate({ teamId, workshopId });
      utils.team.listFormerMembers.invalidate({ teamId });
    },
    onError: (err, variables) => {
      const isCurrent = variables.userId === currentRestoreRef.current;
      const name = restoreLabelsRef.current.get(variables.userId) ?? "That person";
      // The service's own message first, because it names the rule that actually fired, and
      // three of its refusals are specific enough to act on: the read-only 403 from
      // requireTeamWrite, the 404 that says to invite them instead of restoring, and the
      // 403 that says their role is platform-wide and cannot hold team membership. The
      // fallback covers a transport failure that produced no message at all, and says which
      // direction it failed in, nothing was granted, so a retry is a safe next step.
      setRestoreOutcome({
        kind: "failed",
        message:
          err.message ||
          `${name} was not restored and still has no access to this team. Try again, and reload the page if it keeps failing.`,
      });
      if (isCurrent) setPendingRestore(null);
    },
    onSettled: (_data, _err, variables) => {
      // THE GUARD THAT MATTERS. `restoring` is the only thing between the operator and a
      // second request. Released unconditionally, an earlier request settling re-arms a
      // button whose own request is still in flight, so a duplicate becomes reachable with no
      // deliberate retry at all, and a duplicate here answers 200 with `audited: false`,
      // which is indistinguishable from an unrecorded real restoration and would have the
      // operator report an incident they caused by clicking twice.
      if (variables.userId === currentRestoreRef.current) {
        setRestoring(null);
        currentRestoreRef.current = null;
      }
      restoreLabelsRef.current.delete(variables.userId);
    },
  });

  // MEMBERS start open; INVITATIONS start closed. This used to be "both rosters open",
  // and the half of that reasoning which still holds is the members half: a collapsed
  // roster shows a team page that looks like it has no members, which is the false alarm
  // this screen spent a day removing.
  //
  // Invitations are different in kind. They are an administrative record rather than the
  // team itself, they are empty for most teams, and a PARTICIPANT may grant no roles at
  // all, so for many viewers the section was an always-expanded list of nothing, above
  // the roster they came for. Closed by default, and its query is deferred with it
  // (declared above), so the request is not paid for until someone asks.
  //
  // Neither state is persisted: a fresh navigation always shows the roster, and
  // collapsing stays an in-session scanning aid.
  const [showMembers, setShowMembers] = useState(true);
  // The invite form, behind the header button. Closed on arrival for the same reason the
  // invitations list is: it is an action someone chooses, not information they need.
  const [showInvitePanel, setShowInvitePanel] = useState(false);

  // FORMER MEMBERS STARTS CLOSED, and that is the one place this page disagrees with the two
  // lists above. They are the reason the page exists; this is history, and history opened by
  // default would push the live roster off the first screen and put a removal list at the
  // same visual weight as the people actually on the team. The COUNT is in the heading, so a
  // closed panel still answers "has anyone been removed from this team" without a click -
  // which is the only question it needs to answer at a glance.
  const [showFormerMembers, setShowFormerMembers] = useState(false);

  const [copied, setCopied] = useState(false);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  // NO DEFAULT ROLE. This was useState("BUILDER"), which is how an EXECUTIVE invited to
  // a team ended up tagged "Builder", the field was pre-filled and nobody had reason to
  // touch it. "" renders the mandatory "Select a role…" placeholder below, so a team
  // role is something the inviter CHOSE rather than something they failed to change.
  const [teamRole, setTeamRole] = useState("");

  // The role actually submitted, and NO DEFAULT, `""` until the inviter picks one.
  //
  // This used to fall back to `invitableRoles[0]?.role ?? "PARTICIPANT"`, and the note
  // here explained why the source array's order had to stay put: alphabetically "Admin"
  // sorts first, so re-ordering it for display would have made ADMIN the pre-selected
  // role. Removing the default outright is strictly safer, no array order can escalate
  // a default that does not exist, and a mandatory explicit choice is the intended behaviour.
  // INVITABLE_PLATFORM_ROLES itself is untouched; other screens and the authz tests
  // still depend on its order.
  //
  // Still DERIVED rather than seeded into useState, because the session (and so
  // invitableRoles) is empty on the first render and a useState initializer would latch
  // that. Shared with the Administration invite form (lib/invite-form.ts) so the two
  // cannot drift on what "nothing chosen" means or on when a selection is still valid.
  const platformRole = submittedPlatformRole(selectedRole, invitableRoles);

  // WHICH PLATFORM ROLES GET A TEAM-ROLE PICKER.
  //
  // Was `platformRole === "PARTICIPANT"` only. That was right when every team role was a
  // BUILDING role, a judge tagged BUILDER is simply false, but EXECUTIVE and COACH were
  // then added to TEAM_ROLES precisely so a non-builder can hold an honest team role, and
  // this gate then contradicted them: selecting EXECUTIVE made the Team role
  // dropdown vanish. The team service made the same change (it dropped teamRole for any
  // non-participant), so both halves move together.
  //
  // A JUDGE still gets no picker: they evaluate a workshop rather than sitting in one
  // team, their invitation is workshop-scoped, and a team role on that row would be a
  // grant nothing reads. ADMIN/FACILITATOR likewise, platform-wide, no team seat.
  //
  // Still copes with "nothing chosen yet" for free and in the right direction: `""`
  // matches neither, so the sub-dropdown stays hidden until a platform role is actually
  // picked. Showing a Team role question before anyone has said who the invitee IS would
  // be asking something that may not apply.
  const takesTeamRole =
    platformRole === "PARTICIPANT" || platformRole === "EXECUTIVE";

  // Blocked on BOTH inputs. A role is now a required choice, so an email list alone is
  // not a sendable invite.
  //
  // THE WORKSHOP is passed as the third argument, and this page needs NO picker for it:
  // a JUDGE must name a workshop, and the only workshop this screen can mean is the one
  // in its own route, the workshop the team being viewed belongs to. Offering a choice
  // here would let an operator invite a judge to a workshop they are not looking at,
  // which is a different action wearing this form's clothes. The Administration screen
  // is where a judge is invited to an arbitrary workshop, and it has the picker.
  //
  // For every other role the guard ignores this value (see requiresWorkshop), so passing
  // it unconditionally cannot start demanding one where the backend forbids it.
  const inviteBlocked = inviteBlockedReason(
    platformRole,
    inviteEmails.length,
    workshopId
  );

  // The dropdown's OPTIONS, alphabetical by label so the person scanning them does not
  // have to know the prominence order the constant is written in. Still a SEPARATE list
  // from `invitableRoles` and still built with platformRolesByLabel(), because that
  // array's order remains load-bearing elsewhere, this form simply no longer reads
  // `[0]`.
  const roleOptions = platformRolesByLabel(invitableRoles);

  function copyInviteCode() {
    if (!team?.inviteCode) return;
    navigator.clipboard.writeText(team.inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-ink-tertiary">Loading team...</div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-ink-subtle">Team not found</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto px-6 py-8">
      {/* Team name, with Invite on the RIGHT of the same row.
          The invite form used to be a permanently-expanded 170-line panel ABOVE the
          roster, so the first thing anyone saw on a team page was a form for an action
          most of them cannot perform, a participant may grant no roles at all and never
          sees it. It is now a popover behind this button: present for whoever may invite,
          out of the way until asked for. */}
      {/* ── ⚠ THE TEAM NAME IS NOT REPEATED HERE ────────────────────────────────────────────
          This was `<h2 className="text-xl font-bold">{team.name}</h2>`, directly under the
          workspace bar in `layout.tsx` which already renders `<h1>{team.name}</h1>`. The same
          string twice, ~60px apart, and the same duplication the experience Settings page had.

          The bar keeps the `<h1>`, because it is present on all nine routes and is what a
          screen-reader user navigates by. Only the Invite control lives here now, so the row is
          `justify-end` rather than `justify-between`. */}
      <div className="flex items-start justify-end gap-4 mb-6">
        {canSendInvites && (
          <button
            type="button"
            onClick={() => setShowInvitePanel((v) => !v)}
            aria-expanded={showInvitePanel}
            aria-controls="invite-panel"
            className="shrink-0 rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover transition-colors"
          >
            {showInvitePanel ? "Close" : "Invite"}
          </button>
        )}
      </div>

      {/* The invite panel, revealed by the button above. Kept in the document rather than
          rendered into a floating layer: it contains a multi-field form with role selects,
          and a popover that can be dismissed by an outside click is a poor host for
          half-entered input. */}
      {showInvitePanel && (
        <div id="invite-panel">
      {/* Invite Section, shown to anyone who may grant at least one role. A
          PARTICIPANT may grant none, so they never see it (nor the invite CODE,
          which is equivalent to an invitation). An EXECUTIVE does see it, despite
          being read-only for team content, because they may invite fellow
          executives and participants. */}
      {canSendInvites && (
      <section className="mb-8 rounded-lg border p-5 bg-surface-1">
        <h3 className="font-semibold mb-2">Invite Members</h3>
        <p className="text-sm text-ink-subtle mb-4">
          Share the invite code or send an email invitation to join this team.
        </p>

        {/* Invite Code */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex-1 rounded-md border bg-surface-3 px-4 py-2.5 font-mono text-lg tracking-widest text-center">
            {team.inviteCode}
          </div>
          <button
            onClick={copyInviteCode}
            className="rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-ink hover:bg-brand-hover transition-colors"
          >
            {copied ? "Copied!" : "Copy Code"}
          </button>
        </div>

        {/* Email Invitation */}
        <div className="border-t pt-4">
          <h4 className="text-sm font-medium mb-2">Send Email Invitation</h4>

          {/* Role selection: platform role first; team role cascades in for
              participants only. */}
          <div className="flex flex-wrap gap-3 mb-3">
            <div className="flex-1 min-w-[160px]">
              <label
                htmlFor="invite-platform-role"
                className="block text-xs font-medium text-ink-subtle mb-1"
              >
                Platform role <span aria-hidden="true">*</span>
              </label>
              <select
                id="invite-platform-role"
                value={platformRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                required
                aria-required="true"
                className="w-full rounded-md border border-field-border px-3 py-2 text-sm bg-surface-3 focus:border-brand focus:ring-1 focus:ring-brand outline-none"
              >
                {/* The placeholder: `disabled` so it can't be chosen back, `value=""` so
                    "nothing chosen" is a real state the submit guard can refuse. No role
                    is pre-selected, see the note on `platformRole` above. */}
                <option value="" disabled>
                  Select a role…
                </option>
                {/* Only the roles this user may GRANT, a facilitator sees no
                    "Admin" option, a judge sees only "Judge". The Team service
                    re-checks the same matrix, so this is convenience, not the
                    security boundary. Rendered from the alphabetised copy, which now
                    affects only how the list READS. */}
                {roleOptions.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            {/* PARTICIPANT and EXECUTIVE only, and therefore never before a platform
                role has been chosen, `""` matches neither. */}
            {takesTeamRole && (
              <div className="flex-1 min-w-[160px]">
                <label
                  htmlFor="invite-team-role"
                  className="block text-xs font-medium text-ink-subtle mb-1"
                >
                  Team role
                </label>
                <select
                  id="invite-team-role"
                  value={teamRole}
                  onChange={(e) => setTeamRole(e.target.value)}
                  required
                  className="w-full rounded-md border border-field-border px-3 py-2 text-sm bg-surface-3 focus:border-brand focus:ring-2 focus:ring-brand outline-none"
                >
                  {/* Unselectable placeholder: it can be the INITIAL value but cannot be
                      chosen back once a real role is picked, and `required` refuses a
                      submit while it is still selected. */}
                  <option value="" disabled>
                    Select a role…
                  </option>
                  {TEAM_ROLES.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="mb-3">
            <EmailChipsInput
              id="email-input"
              emails={inviteEmails}
              onChange={setInviteEmails}
              disabled={inviteSending}
            />
          </div>
          <button
            type="button"
            onClick={async () => {
              // The guard SAYS something. A bare `return` on an empty list was invisible -
              // the button looked broken rather than blocked, and a missing role is the
              // less obvious of the two now that nothing is pre-selected. Same predicate
              // as the button's `disabled`, so the two cannot disagree.
              setInviteSuccess("");
              if (inviteBlocked) {
                setInviteError(INVITE_BLOCKED_MESSAGE[inviteBlocked]);
                return;
              }
              setInviteSending(true);
              setInviteError("");
              try {
                const res = await fetch("/api/invite", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    emails: inviteEmails,
                    teamId,
                    teamName: team.name,
                    inviteCode: team.inviteCode,
                    workshopId,
                    platformRole,
                    // Sent only for the roles that take one (PARTICIPANT, EXECUTIVE) -
                    // the same predicate that decides whether the picker is shown, so the
                    // form cannot send a value the operator was never asked for. The team
                    // service applies the same rule again and drops a stray one.
                    teamRole: takesTeamRole ? teamRole : undefined,
                  }),
                });
                if (!res.ok) {
                  const data = await res.json();
                  setInviteError(data.error || "Failed to send invitations");
                } else {
                  setInviteSuccess(`Invitations sent to ${inviteEmails.length} recipient${inviteEmails.length > 1 ? "s" : ""}`);
                  setInviteEmails([]);
                  refetchInvitations();
                }
              } catch {
                setInviteError("Failed to send invitations");
              }
              setInviteSending(false);
            }}
            disabled={inviteSending || !!inviteBlocked}
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {inviteSending ? "Sending..." : `Send Invite${inviteEmails.length > 1 ? "s" : ""} (${inviteEmails.length})`}
          </button>
          {/* WHY the button is dead, said next to it, a form with no visible default
              looks complete, so "you haven't picked a role" is not guessable. Not an
              error style: nothing has gone wrong yet. */}
          {!inviteSending && inviteBlocked && (
            <p className="mt-2 text-xs text-ink-subtle">
              {INVITE_BLOCKED_MESSAGE[inviteBlocked]}
            </p>
          )}
          {inviteSuccess && (
            <p className="mt-2 text-sm text-success-text">{inviteSuccess}</p>
          )}
          {inviteError && (
            <p className="mt-2 text-sm text-danger-text-strong">{inviteError}</p>
          )}
        </div>
      </section>
      )}        </div>
      )}


      {/* Members List */}
      <Disclosure
        id="members"
        title="Members"
        count={team.members?.length || 0}
        open={showMembers}
        onToggle={() => setShowMembers(!showMembers)}
        /* Outside the panel, for the reason the Invitations notice above is: the row this
           outcome is about has just been DELETED, and collapsing the roster must not take
           the only report of it with it. */
        notice={
          <ActionOutcome
            outcome={removeOutcome}
            onDismiss={() => setRemoveOutcome(null)}
            className="mt-2"
          />
        }
      >
        {team.members?.length ? (
          /* One bordered panel of divided rows rather than a stack of cards, the treatment used
             by every list in the product now (see components/ui/DataRows.tsx for why: card
             elevation claims a hierarchy homogeneous rows do not have, and the gaps cost rows per
             screen). `overflow-hidden` so a row background cannot square the rounded corners. */
          <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
            {team.members.map((member) => {
              // The name this member is KNOWN BY on this screen, resolved once so the row,
              // the button's accessible name, the confirmation and the outcome notice all
              // say the same thing. The userId fallback is the roster's own (see the tRPC
              // mapper's `name: "Unknown"`); an operator must never be asked to confirm
              // removing "undefined".
              const label = member.user?.name || member.user?.email || member.userId;
              const isSelf = !!myUserId && member.userId === myUserId;
              const isRemoving = removing === member.userId;

              return (
                /* items-start and min-w-0 for the same reason as the invitation rows: a
                   long name or a long email truncates instead of pushing the role badge
                   off the row, and a row that grows to two lines grows downward. */
                <li
                  key={member.id || member.userId}
                  className="flex items-start justify-between gap-3 px-4 py-3"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      aria-hidden="true"
                      className="w-9 h-9 shrink-0 rounded-full bg-brand-subtle flex items-center justify-center text-sm font-medium text-brand-text"
                    >
                      {(member.user?.name || member.userId || "?")[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {member.user?.name || member.userId}
                        {/* Marks the row that has no Remove button, so its absence reads
                            as a rule rather than as a missing control, the same reasoning
                            the Administration screen applies to its inactionable rows. */}
                        {isSelf && (
                          <span className="ml-2 text-xs font-normal text-ink-tertiary">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-ink-subtle truncate">
                        {member.user?.email || ""}
                      </p>
                    </div>
                  </div>
                  {/* The badge and the action share this group so the badge stays put
                      whether or not a button follows it, a roster where the role column
                      shifts left on the caller's own row is a column that cannot be
                      scanned. */}
                  <div className="flex shrink-0 items-center gap-2">
                    {/* ⚠ `teamRoleLabel`, NOT THE RAW ENUM. This printed `{member.role}`, so the
                        roster read "LEAD" and "MEMBER" in transport SHOUTING_CAPS. The mapper is
                        defined at the top of this very file and was already used by the removal
                        and restore notices, the roster was the one place that skipped it. */}
                    <span className="rounded-full bg-surface-2 px-2 py-1 text-xs font-medium text-ink-muted">
                      {teamRoleLabel(member.role)}
                    </span>
                    {/* Deliberately the SAME control as Revoke above, same size, same
                        quiet border, same red-on-hover, because it is the same kind of
                        act on the same kind of row, and an operator who has learnt one
                        should not have to learn the other. Never on the caller's own row.

                        Hiding it from a read-only EXECUTIVE is a COURTESY, not the
                        control: requireTeamWrite in the team service refuses the request
                        regardless, and its refusal renders in the notice above. */}
                    {canRemoveMembers && !isSelf && (
                      <button
                        type="button"
                        disabled={isRemoving}
                        // The row gives sighted operators the context; an accessible name
                        // must carry it on its own, because a screen-reader user tabbing
                        // the roster hears nothing but a stack of identical "Remove"s.
                        aria-label={`Remove ${label} from ${team.name}`}
                        onClick={() => {
                          // Reset here rather than on close: this is the one moment that is
                          // unambiguously BEFORE the next request, so a previous success
                          // cannot send the next dialog's focus to the fallback.
                          removalSucceededRef.current = false;
                          setPendingRemoval({ userId: member.userId, name: label });
                        }}
                        /* Matches Revoke exactly except for the DISABLED treatment, and that
                           one difference is deliberate. `disabled:opacity-50`, Revoke's
                           choice, and the reflex, fades gray-500 to roughly 2.3:1 against
                           white, which fails AA on the one string that tells the operator
                           their click was received ("Removing…"). Since disabled here means
                           pending and nothing else, the pending state is rendered as
                           ENGAGED (darker, tinted) rather than faded: red-800 on red-50 is
                           7.8:1, unambiguous, and visibly not clickable via the cursor. */
                        className="text-xs font-medium px-2 py-1 rounded-md border transition-colors disabled:cursor-default border-hairline text-ink-subtle hover:border-danger-field-border hover:bg-danger-bg hover:text-danger-text-strong disabled:border-danger-field-border disabled:bg-danger-bg disabled:text-danger-text"
                      >
                        {isRemoving ? "Removing…" : "Remove"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-hairline-strong bg-surface-1 py-8 text-center">
            <p className="text-ink-subtle">No members yet.</p>
            <p className="text-sm text-ink-tertiary mt-1">
              Share the invite code above to add members.
            </p>
          </div>
        )}
      </Disclosure>

      {/* ── FORMER MEMBERS ─────────────────────────────────────────────────────────────
          BELOW the Members list and COLLAPSED by default. Secondary information: this is
          the team's removal history, and it must not compete with the roster of people who
          are actually on the team.

          The position is also what makes the query's arrival safe. This section mounts when
          `listFormerMembers` resolves, and it is the LAST thing on the page, so it appends
          below every existing control rather than pushing one sideways or downwards while a
          pointer is travelling towards it. Nothing above it moves. */}

      {/* ── SENT INVITATIONS ───────────────────────────────────────────────────────────
          RENDERED WHENEVER THE VIEWER MAY INVITE, not only when invitations exist.
          It used to be gated on `sentInvitations.length > 0`, which worked while the query
          ran on mount, but deferring that query made the gate self-defeating: nothing is
          fetched until the section is expanded, and the section could not be expanded
          because the gate hid it. The heading disappeared entirely. A deferred fetch and a
          presence gate on the deferred data cannot both be true.
          `canSendInvites` is the right condition anyway: the section is about an action, so
          it belongs to whoever can perform it, and an empty invitations list is a fact
          worth stating ("none sent yet") rather than a reason to hide the heading. */}
      {canSendInvites && (
        <Disclosure
          id="invitations"
          title="Invitations"
          count={invitationCount}
          open={showInvitations}
          onToggle={() => setShowInvitations(!showInvitations)}
          className="mb-8"
          /* Outside the panel: a revoke that FAILED must not be silenced by collapsing
             the list the revoke happened in. */
          notice={
            revokeError ? (
              <p className="mt-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-text">
                {revokeError}
              </p>
            ) : null
          }
        >
          {/* THREE STATES, said apart. The section now renders before its data exists, so
              "loading" and "none sent" must not both look like an empty list, the first is
              a request in flight, the second is a fact about the team. */}
          {invitationsQuery.isLoading ? (
            <p className="text-sm text-ink-subtle">Loading invitations…</p>
          ) : invitationsQuery.error ? (
            /* Said out loud rather than rendered as emptiness: silently showing "none sent"
               when the lookup FAILED would tell an operator their invites vanished. */
            <p role="alert" className="text-sm text-danger-text">
              Could not load invitations. {invitationsQuery.error.message}
            </p>
          ) : sentInvitations.length === 0 ? (
            <p className="text-sm text-ink-subtle">
              No invitations sent yet. Use <span className="font-medium">Invite</span> above
              to send one.
            </p>
          ) : (
          /* One bordered panel of divided rows, matching the roster above and every other list
             in the product. A BARE block comment, because this sits in a ternary's expression slot
             where `{…}` would be read as an object literal rather than a comment. */
          <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
            {sentInvitations.map((inv: (typeof sentInvitations)[number], i: number) => (
              /* items-start, not items-center: an invitation row is about to grow a
                 second line ("Invited by …"), and centring would then float the status
                 badge into the middle of a two-line block. Anchored to the top, the row
                 grows downward and the badge stays where the eye already is. */
              <li
                key={`${inv.email}-${i}`}
                className="flex items-start justify-between gap-3 rounded-lg border px-4 py-3"
              >
                <div className="flex items-start gap-3 min-w-0">
                  {/* Decorative: the initial repeats the email beside it, and the tint
                      repeats the status badge. Hidden so a screen reader reads neither
                      twice. Status is never colour-only, the badge spells it out. */}
                  <div
                    aria-hidden="true"
                    className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-sm font-medium ${
                      inv.status === "Accepted"
                        ? "bg-success-bg text-success-text"
                        : "bg-warn-bg text-warn-text"
                    }`}
                  >
                    {inv.email[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{inv.email}</p>
                    <p className="text-xs text-ink-tertiary">
                      {roleLabel(inv.platformRole, inv.teamRole)}
                      {/* Same raw-ISO defect the admin screen had, fixed with the same
                          component so "sent" reads identically wherever an invitation
                          is listed. Renders nothing at all when sentAt is empty or
                          unparseable. */}
                      <SentAt sentAt={inv.sentAt} />
                    </p>
                    {/* WHO INVITED THIS PERSON. The data was already arriving -
                        team.listInvitations calls the same `withInviters` helper the
                        Users tab uses, and nothing rendered it. Same component as the admin screen so provenance
                        reads identically wherever an invitation is listed, and it
                        renders nothing when there is no inviter rather than saying
                        "unknown". */}
                    <InvitedByNote invitedBy={inv.invitedBy} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-1 rounded-full border ${
                    inv.status === "Accepted"
                      ? "bg-success-bg text-success-text border-success-border"
                      : "bg-warn-bg text-warn-text border-warn-border"
                  }`}>
                    {inv.status}
                  </span>
                  {/* Offered only for a PENDING row whose granted role this user
                      could have handed out themselves. An Accepted row is the audit
                      record of a redeemed grant and the backend refuses to delete
                      it, so showing the control there would only produce a 409. */}
                  {canSendInvites &&
                    inv.status === "Pending" &&
                    canRevokeRole(inv.platformRole) && (
                      <button
                        type="button"
                        disabled={revoking === inv.email}
                        onClick={() => {
                          // Irreversible: the link dies and the address can no
                          // longer register until re-invited. Worth one confirm.
                          if (
                            !window.confirm(
                              `Revoke the invitation for ${inv.email}?\n\nTheir invite link stops working immediately and they will not be able to register until you invite them again.`
                            )
                          )
                            return;
                          setRevoking(inv.email);
                          revokeInvitation.mutate({ teamId, email: inv.email });
                        }}
                        className="text-xs font-medium px-2 py-1 rounded-md border border-hairline text-ink-subtle hover:border-danger-field-border hover:bg-danger-bg hover:text-danger-text-strong disabled:opacity-50 transition-colors"
                      >
                        {revoking === inv.email ? "Revoking…" : "Revoke"}
                      </button>
                    )}
                </div>
              </li>
            ))}
          </ul>
          )}
        </Disclosure>
      )}

      {/* A FAILED HISTORY LOOKUP IS SAID OUT LOUD, because the alternative is a page that
          silently omits the section and therefore states, by its absence, that nobody has
          ever been removed from this team. That is the one wrong answer this list exists to
          prevent, and it is indistinguishable from a healthy team.

          Not an ActionOutcome: nothing was attempted and there is nothing to acknowledge.
          Not a live region either, it is present on first paint, and ActionOutcome is
          already the one announcing surface on this screen. */}
      {formerMembersError && (
        <p className="mt-8 rounded-md border border-warn-border bg-warn-bg px-4 py-2 text-sm text-warn-text">
          The removal history for this team could not be loaded, so this page cannot say
          whether anyone has been removed. Reload the page to try again.
        </p>
      )}

      {/* RENDERED WHEN THERE IS HISTORY *OR* AN OUTCOME TO REPORT, and the second half of
          that condition is not defensive padding. Restoring the LAST former member empties
          this list, and a section that unmounted on `length === 0` would take the notice
          reporting that very restoration down with it, the exact failure that puts
          ActionOutcome outside the row in the first place, one level up.

          When there is genuinely nothing to show, NOTHING renders: an empty bordered panel
          on a healthy team is noise, and a team that has never removed anyone should not be
          asked to display a section about removals. */}
      {(formerMembers.length > 0 || restoreOutcome) && (
        <Disclosure
          id="former-members"
          title="Former members"
          count={formerMembers.length}
          open={showFormerMembers}
          onToggle={() => setShowFormerMembers(!showFormerMembers)}
          className="mt-8"
          notice={
            <>
              {/* Directly under the heading, OUTSIDE the panel, for the reason the two
                  notices above are outside theirs: the row this outcome is about has just
                  left the list (the service omits anyone who is a member again), and
                  collapsing the panel must not take the only report of it away either. */}
              <ActionOutcome
                outcome={restoreOutcome}
                onDismiss={() => setRestoreOutcome(null)}
                className="mt-2"
              />
              {/* TRUNCATION IS SURFACED, and it has to sit out here rather than inside the
                  panel: collapsed, the heading reads "Former members (50)", which is a
                  number an operator will take as complete. The bound is the service's
                  MAX_FORMER_MEMBERS and the full per-person history lives in the audit
                  trail, so this says where the rest is rather than implying there is none. */}
              {formerMembersData?.truncated && (
                <p className="mt-2 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-xs text-warn-text">
                  This list is capped at the 50 most recently removed people, and that cap
                  was reached. There are more removals than are shown here. The complete
                  history for one person is in their audit trail.
                </p>
              )}
            </>
          }
        >
          {formerMembers.length === 0 ? (
            /* One quiet line, not an empty bordered panel. Only reachable with an outcome on
               screen (see the render condition above), i.e. straight after the last former
               member was restored, so it is an answer to "what happened to the list", not
               a permanent fixture. */
            <p className="text-sm text-ink-subtle">
              Nobody is currently listed as removed from this team.
            </p>
          ) : (
            /* Same panel treatment as the roster and the invitations list above. Bare comment:
               expression slot. */
            <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
              {formerMembers.map((fm) => {
                /**
                 * THE NAME THIS PERSON IS KNOWN BY on this screen, resolved once so the row,
                 * the button's accessible name, the confirmation and the outcome notice all
                 * say the same thing.
                 *
                 * `name` and `email` null mean UNKNOWN, the users read-model has no row for
                 * them, and NOT suppressed: the removal is the fact and the name is
                 * decoration on it, which is why the service keeps a removal it cannot name
                 * rather than dropping it. So this falls back through the other field to the
                 * userId, exactly as the Members list above does for a member the read-model
                 * could not resolve. Never blank, and never a coerced "": a blank cell here
                 * reads as a data problem, and an operator cannot be asked to confirm
                 * restoring "undefined".
                 */
                const label = fm.name || fm.email || fm.userId;
                // TRUE when neither field resolved, i.e. `label` is a bare id. Marked in the
                // row below so a 36-character sub is not read as somebody's name, the id is
                // legible AS an unknown only if it is labelled one.
                const nameUnknown = !fm.name && !fm.email;
                const isRestoring = restoring === fm.userId;

                // Rendered rather than the raw ISO string, through the module every other
                // instant on this screen goes through, same fixed-width UTC format, so a
                // column of these does not shift as the values differ.
                //
                // `removedAt` is always present in the contract, but an UNPARSEABLE value
                // degrades to "" here (see formatInstantUtc), and "Removed" followed by
                // nothing is the blank this row must never render.
                const removedAtText = formatInstantUtc(fm.removedAt);
                /**
                 * `joinedAt: null` RENDERS AS "join date unknown" AND NEVER AS "never
                 * joined".
                 *
                 * The audit entry itself proves this person WAS a member of this team; null
                 * only means the removal predates the field being denormalised onto the
                 * entry (the trail is append-only, so there is no backfill). "Never joined"
                 * would be this screen asserting a falsehood about a person on the one
                 * surface whose purpose is to be an accurate record.
                 */
                const joinedAtText = formatInstantUtc(fm.joinedAt);

                return (
                  /* Same row shell as the Members list, items-start, min-w-0, one border -
                     so a long name truncates instead of pushing the Restore button off the
                     row, and a row that grows to four lines grows downward. */
                  <li
                    key={fm.userId}
                    className="flex items-start justify-between gap-3 rounded-lg border px-4 py-3"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {/* Decorative, and GRAY rather than the roster's primary tint: the same
                          shape in a drained colour reads as "not currently one of them".
                          Hidden from assistive technology because the initial repeats the
                          name beside it, and the state is carried in words on every row
                          ("Removed …") rather than by this tint. */}
                      <div
                        aria-hidden="true"
                        /* gray-600 on gray-100 measures 6.87:1. The roster's equivalent
                           (primary-700 on primary-200) is 4.71:1, and there was no reason to
                           reproduce the weaker of the two on a new element. */
                        className="w-9 h-9 shrink-0 rounded-full bg-surface-2 flex items-center justify-center text-sm font-medium text-ink-subtle"
                      >
                        {/* `|| "?"` for the same reason the Members list carries it: an
                            all-empty identity makes `label` `""`, and `""[0]` is undefined,
                            which throws on `.toUpperCase()` and takes the whole page down
                            over a decorative initial. */}
                        {(label || "?")[0].toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        {/* `title` on the truncating line, which the roster's equivalent does
                            not need and this one does: when both name and email are null the
                            visible text is a 36-character sub, and `truncate` clips exactly
                            the tail that distinguishes one from another. Never the ONLY way to
                            get the value, the Restore button's accessible name carries it in
                            full, so a keyboard or screen-reader operator needs no hover. */}
                        <p className="text-sm font-medium truncate" title={label}>
                          {label}
                          {/* Says WHICH kind of gap this is. Without it the id above looks
                              like a name nobody can pronounce; with it, the row reads as a
                              removal whose subject could not be resolved, which is the
                              truth, and is not the operator's problem to solve before
                              restoring access. */}
                          {nameUnknown && (
                            <span className="ml-2 text-xs font-normal text-ink-subtle">
                              (name unknown)
                            </span>
                          )}
                        </p>
                        {/* Only when it adds something. `label` already IS the email when
                            the name is missing, and repeating it would be a second identical
                            line. An absent address renders no line at all rather than an
                            empty one. */}
                        {fm.email && fm.email !== label && (
                          <p className="text-xs text-ink-subtle truncate">{fm.email}</p>
                        )}
                        <p className="text-xs text-ink-subtle">
                          {removedAtText ? (
                            <>
                              Removed{" "}
                              {/* Full precision stays recoverable for machines and for a
                                  pointer, while the rendered text already carries the date,
                                  the time and the zone, so nothing here needs a hover. */}
                              <time dateTime={fm.removedAt} title={fm.removedAt}>
                                {removedAtText}
                              </time>
                            </>
                          ) : (
                            // The date was unusable. The REMOVAL still happened, so the row
                            // says so and reports the date as unknown instead of printing
                            // "Invalid Date" next to a real person.
                            "Removed, date unknown"
                          )}
                          {" · "}
                          {joinedAtText ? (
                            <>
                              joined{" "}
                              <time dateTime={fm.joinedAt ?? undefined} title={fm.joinedAt ?? undefined}>
                                {joinedAtText}
                              </time>
                            </>
                          ) : (
                            "join date unknown"
                          )}
                        </p>
                        {/* WHO REMOVED THEM. Never blank: a null name is either a deliberate
                            visibility suppression or an actor whose account is gone, and the
                            ROLE is disclosed either way, see removedByLabel for why the
                            wording claims neither. Same voice as InvitedByNote's "Not
                            shown".

                            WRAPS rather than truncating, unlike the identity lines above it.
                            Those two truncate an email or a name, where the head of the string
                            still identifies the row; this one is a SENTENCE whose meaning sits
                            at the END, "Removed by a Facilitator, name not shown" clipped
                            mid-way becomes "Removed by a Facilit…", which loses the one clause
                            that says the name was withheld rather than missing. Wrapping costs
                            nothing here: the row is already variable-height because of the
                            reason line below, and it grows downward. */}
                        <p className="text-xs text-ink-subtle break-words">
                          {removedByLabel(fm.removedByName, fm.removedByRole)}
                        </p>
                        {/* The operator's note, when one was written. A null reason means
                            nobody wrote one, so nothing renders, a "No reason recorded"
                            line on every row would be noise on the common case, and the
                            InvitedByNote precedent is that an absent line beats a line
                            saying "unknown". */}
                        {fm.reason && (
                          <p className="mt-1 text-xs text-ink-subtle break-words">
                            &ldquo;{fm.reason}&rdquo;
                          </p>
                        )}
                      </div>
                    </div>
                    {/* The action sits in its own shrink-0 group, in the SAME position as the
                        roster's Remove button, one column, one place to look, whichever list
                        the eye is in. */}
                    <div className="flex shrink-0 items-center gap-2">
                      {/* GATED ON THE SAME PREDICATE AS REMOVE, deliberately and with no new
                          rule invented for it. The service's guard on reactivate is
                          `requireTeamWrite`, byte-for-byte the guard on the DELETE this
                          reverses, so the two controls answer to one capability, and a
                          screen that offered Remove but hid Restore would make every
                          mistaken removal permanent for the person who made it. The looseness
                          of this predicate fails in the right direction for the same reason
                          it does on Remove: an unentitled caller gets the service's own
                          legible 403 in the notice above.

                          NO self-check, unlike Remove. Appearing in your own team's
                          former-members list requires having been removed from it, which
                          costs you the read access that loads this page, so the case is not
                          reachable, and a guard for it would be a rule with no situation. */}
                      {canRemoveMembers && (
                        <button
                          type="button"
                          disabled={isRestoring}
                          // "Restore access" repeated down a list is ambiguous the moment
                          // there are two rows: a screen-reader operator tabbing this list
                          // would hear a stack of identical buttons with nothing to choose
                          // between. The name carries the person and the team.
                          aria-label={`Restore access to ${team.name} for ${label}`}
                          onClick={() => {
                            // Reset here rather than on close: this is the one moment that is
                            // unambiguously BEFORE the next request, so a previous success
                            // cannot send the next dialog's focus to the fallback.
                            restoreSucceededRef.current = false;
                            setPendingRestore({
                              userId: fm.userId,
                              name: label,
                              // Passed as-is, null included. The dialog decides what to do
                              // with an absent address; coercing it here would put an empty
                              // separator in the target line.
                              email: fm.email,
                            });
                          }}
                          /* The same control as Remove, same size, same quiet border, same
                             engaged-not-faded pending state, in the PRIMARY hue rather than
                             red, because this is the recovery direction and it takes nothing
                             away. Dressing it in red would make red meaningless on the one
                             screen where it has to carry weight.

                             Pending is rendered as ENGAGED for the reason Remove's is:
                             `disabled:opacity-50` fades gray-500 to about 2.3:1 on white and
                             fails AA on the one string that tells the operator their click
                             was received ("Restoring…"). primary-800 on primary-50 measures
                             8.01:1 instead, and primary-700 on primary-50 (the hover state)
                             6.16:1, so the pending LABEL, which is the part that has to be
                             read, carries the state on its own. The primary-300 border is
                             reinforcement rather than the indicator (1.66:1 against the tint,
                             exactly as Remove's red-300 is), which is why the word changes
                             too. */
                          className="text-xs font-medium px-2 py-1 rounded-md border transition-colors disabled:cursor-default border-hairline text-ink-subtle hover:border-brand-border hover:bg-brand-subtle hover:text-brand-text-strong disabled:border-brand-border disabled:bg-brand-subtle disabled:text-brand-text-strong"
                        >
                          {isRestoring ? "Restoring…" : "Restore access"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Disclosure>
      )}

      {/* Rendered at the PAGE level rather than inside the row, and that placement is
          load-bearing twice over: the row unmounts on success (a dialog inside it would be
          torn out mid-transition), and the Members panel can be collapsed while a request
          is in flight (Disclosure unmounts its children, see the note there on why). */}
      {pendingRemoval && (
        <ConfirmActionDialog
          title={`Remove ${pendingRemoval.name} from ${team.name}?`}
          target={
            <>
              {pendingRemoval.name}
              {/* The email is what distinguishes two people with the same display name,
                  which is the mis-click this dialog exists to catch. Only rendered when
                  the roster actually supplied one. */}
              {(() => {
                const email = team.members?.find(
                  (m) => m.userId === pendingRemoval.userId
                )?.user?.email;
                return email ? ` · ${email}` : null;
              })()}
            </>
          }
          consequences={[
            <>They lose access to {team.name}&apos;s board, documents and AI threads.</>,
            <>
              Their platform account is <strong>not</strong> disabled, so they can still sign
              in, and any other team they belong to is unaffected.
            </>,
            <>
              Their team membership is deleted outright. The only remaining record is the
              audit trail entry naming you.
            </>,
          ]}
          reversibility={
            <>
              This cannot be undone. To put them back you will need to invite them again or
              give them the team&apos;s join code.
            </>
          }
          confirmLabel="Remove from team"
          pendingLabel="Removing…"
          tone="destructive"
          pending={removing === pendingRemoval.userId}
          reasonHint="Recorded in the permanent audit trail alongside your name. For a hard-deleted membership this is the only place a why can live."
          // On success the Remove button that opened this is gone with its row, so focus
          // has nowhere to return to. The Members heading is the nearest surviving control
          // and it is the right landing place: it is directly above the roster the operator
          // was working in, and Tab from it walks back into the remaining rows.
          fallbackFocus={() =>
            document
              .getElementById("members-heading")
              ?.querySelector<HTMLButtonElement>("button")
          }
          returnToFallback={() => removalSucceededRef.current}
          onConfirm={(reason) => {
            // Both refs are set BEFORE mutate, so a response cannot arrive to find itself
            // unidentifiable. The label goes in the map keyed by userId (an earlier request
            // may still be in flight and still owns its own entry); `currentRemovalRef`
            // moves to this request, which is what makes every earlier answer stale.
            removalLabelsRef.current.set(pendingRemoval.userId, pendingRemoval.name);
            currentRemovalRef.current = pendingRemoval.userId;
            setRemoving(pendingRemoval.userId);
            // Cleared so a previous action's notice cannot be read as this one's result.
            setRemoveOutcome(null);
            removeMember.mutate({
              teamId,
              userId: pendingRemoval.userId,
              // Undefined rather than "": the services collapse whitespace to no attribute
              // anyway, and sending an empty string asks them to do work to ignore it.
              reason: reason.trim() || undefined,
            });
          }}
          onDismiss={(wasPending) => {
            // CLOSED WHILE A REQUEST WAS IN FLIGHT. The request was sent, the answer was
            // not seen, and the row may or may not be gone, so say exactly that instead of
            // letting a silent close imply nothing happened. Reload is the instruction
            // because a retry on an already-removed member answers "not a member", which
            // reads like a failure and is not one.
            if (wasPending) {
              setRemoveOutcome({
                kind: "unknown",
                message: `The request to remove ${pendingRemoval.name} was sent but the result was never seen. Reload the page to check whether they are still a member before trying again.`,
              });
            }
            setPendingRemoval(null);
          }}
        />
      )}

      {/* THE RESTORE CONFIRMATION, at the PAGE level, for both of the reasons the removal's
          is: the row unmounts on success (the service omits anyone who is a member again), and
          the Former members panel can be collapsed while a request is in flight, which
          unmounts its children.

          Every access-affecting action on this platform is confirmed. This one is confirmed
          not because it is dangerous but because it is CONSEQUENTIAL, it hands somebody back
          access to a team's work, and because the roster and this list are adjacent, so a
          mis-aimed click deserves a target line naming the person before anything happens. */}
      {pendingRestore && (
        <ConfirmActionDialog
          title={`Restore ${pendingRestore.name}'s access to ${team.name}?`}
          target={
            <>
              {pendingRestore.name}
              {/* The address is what distinguishes two people with the same display name,
                  which is the mis-click this dialog exists to catch. Null means the
                  read-model had no row for them, rendered as an explicit unknown rather
                  than a dangling separator, because on THIS dialog the target line is the
                  operator's only chance to notice they are about to grant access to the
                  wrong person. Silence there would read as "no more to say". */}
              {pendingRestore.email ? ` · ${pendingRestore.email}` : " · email unknown"}
            </>
          }
          /* THE CONSEQUENCES ARE NOT THE REMOVAL'S INVERTED, and the asymmetry is the point.
             Restoring grants team access and gives back the preserved role; it does NOT touch
             platform sign-in, and it does NOT reinstate the invitation the removal withdrew.
             Claiming a symmetry that does not exist is how a dialog teaches an operator to
             skip reading it. */
          consequences={[
            <>
              They regain access to {team.name}&apos;s board, documents and AI threads
              immediately.
            </>,
            <>
              {/* THE REASSURING DETAIL, and the reason the membership row survives a removal
                  at all: the role was preserved, so a Lead comes back a Lead rather than as
                  whatever their next invitation happened to say. Not named here because the
                  response is the authority on it, this dialog would have to guess, and the
                  outcome notice reports the actual value the service returned. */}
              Their previous team role is restored unchanged; this does not re-assign them.
            </>,
            <>
              This restores <strong>team membership only</strong>. Their platform sign-in is a
              separate control on the Administration screen, and this does not enable a
              disabled account.
            </>,
            <>
              Any invitation withdrawn when they were removed stays withdrawn. They do not
              need it: the membership itself is what grants access.
            </>,
          ]}
          reversibility={
            <>
              Reversible: you can remove them from this team again on this screen at any
              time.
            </>
          }
          confirmLabel="Restore access"
          pendingLabel="Restoring…"
          /* NEUTRAL, NOT DESTRUCTIVE. This is the recovery action and it takes nothing away;
             the Administration screen's restore makes the same call for the same stated
             reason, dressing a restore in the same red as a removal would make red
             meaningless on the one screen where it has to carry weight. */
          tone="neutral"
          pending={restoring === pendingRestore.userId}
          reasonHint="Recorded in the permanent audit trail alongside your name, e.g. why they are being let back onto the team."
          // On success the Restore button that opened this is gone with its row (a restored
          // person leaves this list), so focus has nowhere to return to. The Former members
          // heading is the nearest surviving control and the right landing place: it is
          // directly above the list the operator was working in, and Tab from it walks back
          // into the remaining rows.
          fallbackFocus={() =>
            document
              .getElementById("former-members-heading")
              ?.querySelector<HTMLButtonElement>("button")
          }
          returnToFallback={() => restoreSucceededRef.current}
          onConfirm={(reason) => {
            // Both refs are set BEFORE mutate, so a response cannot arrive to find itself
            // unidentifiable. The label goes in the map keyed by userId (an earlier request
            // may still be in flight and still owns its own entry); `currentRestoreRef` moves
            // to this request, which is what makes every earlier answer stale.
            restoreLabelsRef.current.set(pendingRestore.userId, pendingRestore.name);
            currentRestoreRef.current = pendingRestore.userId;
            setRestoring(pendingRestore.userId);
            // Cleared so a previous action's notice cannot be read as this one's result.
            setRestoreOutcome(null);
            reactivateMember.mutate({
              teamId,
              userId: pendingRestore.userId,
              // Undefined rather than "": the service collapses whitespace to no attribute
              // anyway, and sending an empty string asks it to do work to ignore it.
              reason: reason.trim() || undefined,
            });
          }}
          onDismiss={(wasPending) => {
            // CLOSED WHILE A REQUEST WAS IN FLIGHT. Sent, unanswered, outcome genuinely
            // unknown, and on THIS direction the ambiguity is sharper than on the removal's:
            // a restoration that DID land looks identical to one that never happened on a
            // list that has not refetched, so an operator who assumes the latter clicks again.
            // A second click is not harmless in its reporting: it answers 200 with
            // `audited: false`, which is indistinguishable from an unrecorded real
            // restoration and would send them chasing an incident they created.
            if (wasPending) {
              setRestoreOutcome({
                kind: "unknown",
                message: `The request to restore ${pendingRestore.name} was sent but the result was never seen. Reload the page to check whether they are a member again before trying once more.`,
              });
            }
            setPendingRestore(null);
          }}
        />
      )}
    </div>
  );
}
