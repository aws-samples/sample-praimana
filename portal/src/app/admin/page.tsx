"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  INVITABLE_PLATFORM_ROLES,
  PLATFORM_INVITATION_TEAM_ID,
  isPlatformScopedRole,
  isUserDeactivated,
  canSeePlatformSpend,
  platformRoleLabel,
  platformRolesByLabel,
  surfaceLabel,
} from "@praimana/shared";
import {
  ROW_GRID,
  rowCols,
  SkeletonRows,
  StatusDot,
} from "@/components/ui/DataRows";
import {
  formatLabel,
  statusLabel,
  statusTone,
  teamCountLabel,
  workshopDate,
} from "@/lib/workshop-display";
import { trpc } from "@/lib/trpc/client";
import {
  INVITE_BLOCKED_MESSAGE,
  inviteBlockedReason,
  recipientsIncludeSelf,
  requiresWorkshop,
  submittedPlatformRole,
} from "@/lib/invite-form";
import { EmailChipsInput } from "@/components/EmailChipsInput";
import { ProfileMenu } from "@/components/ProfileMenu";
import { formatMessageInstant } from "@/lib/format-message-instant";
import { BrandMark } from "@/components/BrandMark";
import { SentAt } from "@/components/SentAt";
// Lifted to components/ so the team view can render the same provenance line.
import { InvitedByNote } from "@/components/InvitedByNote";
import { SiteFooter } from "@/components/SiteFooter";
// The same two components the team page's Remove control uses, so an access-affecting
// action is confirmed and reported identically on both screens.
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import {
  ActionOutcome,
  type ActionOutcomeState,
} from "@/components/ActionOutcome";
// formatInstantUtc for the teams directory's created date, the same fixed-width UTC
// rendering SentAt gives an invitation, called directly because a team's creation date is not
// an invitation field and should not follow SentAt's future changes.
import { formatInstantUtc, invitationStatusLabel } from "@/lib/format-datetime";
// The ONE place the roster path is spelled. Used by the teams directory so a row's link cannot
// drift from the destination the team workspace itself uses.
import { teamTabHref } from "@/lib/team-routes";
import {
  useCanAdministerUser,
  useCanManageWorkshopSettings,
  useCanRevokeRole,
  useInvitableRoles,
} from "@/lib/useRole";
import type { AdminUser } from "@/lib/trpc/routers/admin";

/**
 * Administration, platform user management, and the experience catalogue.
 *
 * Reachable by ADMIN and FACILITATOR only, enforced in three independent places:
 * middleware.ts redirects everyone else away from /admin, the identity service
 * refuses /v1/admin/* for any other role, and each row's controls are gated per
 * TARGET role.
 *
 * The Experiences tab joins Users and Invitations because all three are the same
 * job, running the platform rather than participating in it, and because the
 * dashboard should be a place you READ. Its "Invite Users" and "Create Experience"
 * buttons moved here so there is one screen that owns platform administration and one
 * route to each action. See ExperiencesTab for why it navigates to the existing forms
 * instead of embedding copies of them.
 *
 * What the two roles SEE differs, and that difference is applied server-side: an
 * ADMIN sees every account, a FACILITATOR never receives ADMIN rows at all. So there
 * is no "admin row I cannot touch" case to render here, the row simply isn't in the
 * response. Per-row gating still matters for the rest: a facilitator sees peer
 * facilitators but may not act on them.
 *
 * ACCESS CAN NOW BE WITHDRAWN AND RESTORED from here; changing a ROLE still cannot.
 * This comment used to say the whole screen was read-only because both were Cognito
 * writes and the in-VPC identity function cannot make one, that is still true of the
 * identity function, and the way round it is the user-access service, which runs outside
 * the VPC for exactly this reason. Disable/enable goes through it. Role changes have no
 * such route yet, so the rows still explain rather than offer.
 *
 * Which resolves a real confusion: the rows computed a REASON they were not
 * actionable ("Your role cannot manage a Judge", "This is you…") with no action for those
 * reasons to be about, so a facilitator read them as the system denying them something.
 * The reasons are unchanged and now mean what they say.
 */

function roleLabel(role: string): string {
  return INVITABLE_PLATFORM_ROLES.find((r) => r.role === role)?.label ?? role;
}

// Muted, distinguishable badges. ADMIN and FACILITATOR are tinted because "who has
// elevated access" is the question this screen exists to answer, and it should be
// answerable by scanning the column rather than reading every row.
const ROLE_BADGE: Record<string, string> = {
  ADMIN: "bg-series-1/10 text-series-1 border-series-1/30",
  FACILITATOR: "bg-notice-bg text-notice-text border-notice-border",
  JUDGE: "bg-warn-bg text-warn-text border-warn-border",
  EXECUTIVE: "bg-series-2/10 text-series-2 border-series-2/30",
  PARTICIPANT: "bg-surface-1 text-ink-subtle border-hairline",
};

const TABS = [
  { key: "users", label: "Users" },
  // AFTER Users and BEFORE Invitations deliberately: Users → Teams → Invitations →
  // Experiences narrows scope as you read left to right, which is the order an operator
  // scans when they are looking for "the list of X".
  { key: "teams", label: "Teams" },
  { key: "invitations", label: "Invitations" },
  { key: "experiences", label: "Experiences" },
  /**
   * ── FEEDBACK AND BUG REPORTS ──────────────────────────────────────────────────────────────
   *
   * Facilitators and admins see feedback and bug reports under Administration, as a tab of their own.
   *
   * LAST, and that is the narrowing order this table already reads by: Users → Teams → Invitations →
   * Experiences goes from the widest scope to the narrowest. Reports are not a scope at all, they are an
   * inbox, so they sit at the end rather than interrupting that sequence.
   *
   * ⚠ THE BADGE IS ON THIS TAB AND NOT IN THE HEADER. An unread count is only actionable from the screen
   * that can clear it; a number in the app header would follow a reader onto every page with nothing to do
   * about it.
   */
  { key: "feedback", label: "Feedback" },
  /**
   * ── PLATFORM HEALTH ───────────────────────────────────────────────────────────────────────
   *
   * A read-only platform health tab in Administration, visible only to admins and facilitators.
   *
   * ⚠ THE AUDIENCE IS ALREADY EXACTLY RIGHT, WITH NO NEW GATE. `/admin` is in USER_ADMIN_PATHS, so the whole
   * page is ADMIN + FACILITATOR, the two roles it is meant for. Adding a per-tab role check here would be a second
   * gate that could disagree with the first, and the service refuses the underlying route regardless.
   *
   * LAST, after the inbox: Users → Teams → Invitations → Experiences is a narrowing of scope, Feedback is an
   * inbox, and this is neither, it is about the platform itself rather than anything in it, so it belongs at
   * the far end rather than interrupting either group.
   */
  { key: "health", label: "Platform health" },
  /**
   * ── ⚠ THE ONLY ADMIN-ONLY TAB ─────────────────────────────────────────────────────────────
   *
   * Estimated daily and overall spend, for admins only. Every other tab on this
   * page is ADMIN + FACILITATOR, because that is what `/admin` means. Spend is narrower: a facilitator runs an
   * experience, and what the platform costs to run is the platform administrator's business.
   *
   * So this is the first tab whose audience its own page gate is too WIDE for, which is why TABS is now
   * filtered by role below instead of rendered whole. The service refuses the route to a facilitator
   * regardless (`canSeePlatformSpend`); hiding the tab means they are never OFFERED something that would
   * 403, the mistake made three times already with the Submit tab, /how-it-works and /desktop.
   */
  { key: "cost", label: "Cost", adminOnly: true },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// useSearchParams needs a Suspense boundary to prerender, same shape as
// app/experiences/[id]/page.tsx and app/login/page.tsx.
export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-pulse text-ink-tertiary">Loading…</div>
        </div>
      }
    >
      <AdminPageInner />
    </Suspense>
  );
}

function AdminPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * The caller's role, for the one tab whose audience is narrower than this page's.
   *
   * ⚠ A COURTESY, NOT A CONTROL. The role comes from the session for the sole purpose of deciding what to
   * OFFER; the spend route checks the same predicate against the verified token, and that is the check that
   * decides anything. A client-side role is never a permission.
   */
  const { data: session } = useSession();

  // The tab lives in the URL because every tab is a real deep-link target: the
  // workshops dashboard's empty state points at ?tab=experiences, the workshop
  // People tab points at ?tab=invitations, and both create/edit forms return to
  // ?tab=experiences via their `?from=admin` round trip. Local state would break all
  // of those silently. An unrecognised value falls back to Users rather than
  // rendering nothing.
  /**
   * The unread report count, for the tab badge.
   *
   * ⚠ FETCHED HERE RATHER THAN INSIDE THE PANEL, because the badge has to be visible when the panel is NOT
   *, that is the entire point of a badge. React Query serves this and the panel's own list from one cache
   * entry under the same key, so it is one request, not two, and the two can never show different numbers.
   *
   * A failed read leaves the badge absent rather than showing a zero: "we could not check" and "there is
   * nothing new" are different facts, and a false zero is the one that costs somebody a missed report.
   */
  const feedback = trpc.feedback.list.useQuery({ limit: 50 });
  const unreadCount = feedback.data?.unreadCount ?? 0;

  /**
   * ⚠ THE TAB LIST IS FILTERED BY ROLE, and the URL is validated against the FILTERED list, so
   * `?tab=cost` typed by a facilitator falls back to Users rather than rendering a panel that would 403.
   * Validating against the full list would have left a deep link that shows an error page.
   */
  const role = session?.user?.role;
  const tabs = TABS.filter((t) => !("adminOnly" in t && t.adminOnly) || canSeePlatformSpend(role));

  const requested = searchParams.get("tab");
  const tab: TabKey = tabs.some((t) => t.key === requested)
    ? (requested as TabKey)
    : "users";

  // replace, not push: switching tabs shouldn't make Back walk the tab history
  // instead of leaving the page.
  const goToTab = (key: TabKey) =>
    router.replace(`/admin?tab=${key}`, { scroll: false });

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b border-hairline bg-canvas px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* as="span": "Administration" beside it is this page's <h1>, so the
              product name must NOT also be one. Still the link home it was. */}
          <BrandMark as="span" href="/experiences" tagline priority />
          <span className="text-ink-tertiary">/</span>
          <h1 className="text-lg font-semibold text-ink-muted">Administration</h1>
        </div>
        <ProfileMenu />
      </header>

      {/* flex-1 so the footer sits at the bottom rather than under the tab panel. */}
      <main className="w-full flex-1 max-w-5xl mx-auto px-6 py-8">
        <div className="border-b mb-6 flex gap-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => goToTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? "border-brand text-brand-text"
                  : "border-transparent text-ink-subtle hover:text-ink-muted"
              }`}
            >
              {t.label}
              {/*
                The unread count, on the Feedback tab only. Rendered from the same query the panel uses, so
                the badge and the list cannot disagree, and hidden at zero, because a "0" badge is a
                permanent piece of furniture that trains people to ignore the place badges appear.
              */}
              {t.key === "feedback" && unreadCount > 0 && (
                <span
                  className="ml-1.5 rounded-full bg-danger-text-strong px-1.5 py-0.5 text-[10px] font-semibold text-brand-ink"
                  aria-label={`${unreadCount} unread`}
                >
                  {unreadCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {tab === "users" && <UsersTab />}
        {tab === "teams" && <TeamsTab />}
        {tab === "invitations" && <InvitationsTab />}
        {tab === "experiences" && <ExperiencesTab />}
        {tab === "feedback" && <FeedbackTab />}
        {tab === "health" && <HealthTab />}
        {tab === "cost" && <CostTab />}
      </main>

      <SiteFooter />
    </div>
  );
}

function UsersTab() {
  const canAdminister = useCanAdministerUser();
  // Already inside the page's Suspense boundary (see the note on AdminPage), so reading
  // search params here needs no additional wrapper.
  const searchParams = useSearchParams();
  const utils = trpc.useUtils();

  // Cursor pagination, held as a STACK so "Previous" works. The cursors are opaque
  // and only ever move forward, so the only way back is the one we came by.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;

  // The filter, as ONE value rather than a teamId state and a workshopId state. Two
  // pieces of state for a single-choice control is how you end up with both set and a
  // request the backend refuses; the encoding makes the invalid combination
  // unrepresentable.
  //
  // SEEDED FROM THE URL (`?scope=w:<workshopId>`), so the workshop People tab can link
  // straight here already filtered to that workshop. Read once as the initial value rather
  // than tracked: after arriving, the operator owns the control, and re-syncing to the URL
  // on every render would fight their next selection.
  //
  // Validated through decodeScope's own vocabulary rather than trusted: a `scope` that is
  // neither `t:` nor `w:` decodes to no filter, so a hand-edited URL degrades to the
  // unfiltered directory instead of producing a request the backend refuses.
  const initialScope = searchParams.get("scope") ?? "";
  const [scope, setScope] = useState<string>(
    decodeScope(initialScope).some(Boolean) ? initialScope : ""
  );
  const [teamId, workshopId] = decodeScope(scope);

  // A name/email search, applied to the LOADED PAGE only, see the note below the box.
  const [search, setSearch] = useState("");
  /**
   * The needle actually sent to the server, trailing the box by 300ms.
   *
   * Debounced because this is now a SERVER search: sending on every keystroke would fire
   * a filtered table Scan per character. 300ms is long enough to coalesce typing and short
   * enough that the list feels live.
   */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A new needle is a new result set, so the cursor stack must reset for exactly the
  // reason the scope change does below, those cursors point into a different scan.
  // Keyed on the DEBOUNCED value so it resets when the request changes, not per keystroke.
  useEffect(() => {
    setCursors([undefined]);
  }, [debouncedSearch]);

  const scopes = trpc.admin.filterScopes.useQuery();

  const { data, isLoading, error } = trpc.admin.listUsers.useQuery({
    cursor: cursors[page],
    teamId,
    workshopId,
    // Server-side, so it matches users on ANY page. The browser-side filter this
    // replaces only ever saw the page in hand, so searching while on page 1 silently
    // missed everyone on page 2, tolerable for skimming, wrong when the reason you are
    // searching is to act on a specific person.
    search: debouncedSearch || undefined,
  });

  // Changing the filter invalidates the cursor stack: those cursors point into the
  // UNFILTERED scan, so keeping them would page through the wrong result set. Reset
  // during render rather than in an effect, an effect would render one frame with a
  // stale cursor and fire a request for a page that doesn't exist in this filter.
  const changeScope = (next: string) => {
    setScope(next);
    setCursors([undefined]);
  };

  /**
   * ── ⚠ HOOKS BEFORE THE EARLY RETURNS, ALWAYS ─────────────────────────────────────────
   *
   * These five were declared BELOW the `if (error)` guard. React counts hooks per render, so the
   * error branch rendered five fewer than the success branch, and the moment a failed query
   * recovered, this page crashed with "Rendered more hooks than during the previous render".
   *
   * Latent rather than theoretical: nothing had to change but the network. Found by
   * `react-hooks/rules-of-hooks`, enabled after the same mistake crashed the desktop shell, the
   * compiler cannot see it and no test in this repo renders this page.
   */
  /**
   * DISABLING AND RESTORING PLATFORM ACCESS.
   *
   * State lives HERE rather than in UserRow, and every piece of it is at list level for a
   * reason the row cannot satisfy:
   *
   *   `pendingAccess`, the dialog is rendered by the tab, not the row, so a refetch that
   *     replaces every row object mid-request cannot unmount the dialog under the pointer.
   *   `submitting`, keyed on the userId (the `revoking === inv.email` precedent), so a
   *     disable in flight disables one button and not the whole directory.
   *   `outcome`, outlives the row it is about, which is the point: a disable
   *     triggers a refetch, paging swaps the list wholesale, and a search re-queries it.
   *     Rendered above the list, and the message names the person, because none of the
   *     rows on screen when it is read are guaranteed to be the row it refers to.
   */
  const [pendingAccess, setPendingAccess] = useState<{
    userId: string;
    name: string;
    email: string;
    role: string;
    /** The direction being requested, the CURRENT state inverted. */
    enable: boolean;
  } | null>(null);
  const [submittingAccess, setSubmittingAccess] = useState<string | null>(null);
  const [accessOutcome, setAccessOutcome] = useState<ActionOutcomeState | null>(null);
  /**
   * Who each in-flight change is about, keyed by userId, for a response that lands after the
   * dialog closes.
   *
   * A MAP, not a single slot: dismissing mid-request is supported and does not cancel the
   * request, so a second change can be confirmed while the first is unanswered. One slot is
   * overwritten by the second submit, and the first response then renders under the second
   * person's name, and here that misnaming can attach a surviving-credential warning to
   * someone it is not true of, which is worse than losing it. Deleted as each settles.
   */
  const accessLabelsRef = useRef<Map<string, string>>(new Map());
  /**
   * The userId of the most recently submitted change, the one the dialog and the row guard
   * belong to. Every response is correlated against this before touching shared UI state.
   */
  const currentAccessRef = useRef<string | null>(null);

  const setUserAccess = trpc.admin.setUserAccess.useMutation({
    onSuccess: (result, variables) => {
      // `variables` is this request's own resolved input, and the only identity here that a
      // later submit cannot have overwritten.
      const isCurrent = variables.userId === currentAccessRef.current;
      const name = accessLabelsRef.current.get(variables.userId) ?? "That account";
      if (result.enabled) {
        setAccessOutcome({
          kind: result.audited ? "confirmed" : "partial",
          message: result.audited
            ? `${name} can sign in again.`
            : `${name} can sign in again, but the change could not be written to the audit trail, so there is no record of who restored it. Report it.`,
        });
      } else {
        // The invitation count is REPORTED, not hidden, because it is a second
        // irreversible effect the operator was warned about and should see confirmed:
        // re-enabling does not bring those invitations back, so anyone who had not yet
        // registered now needs a fresh one.
        const revoked =
          result.invitationsRevoked > 0
            ? ` ${result.invitationsRevoked} pending invitation${result.invitationsRevoked === 1 ? "" : "s"} destroyed, so a new invitation is needed to re-register.`
            : "";

        // A SURVIVING INVITATION IS THE MOST SERIOUS THING THIS SCREEN CAN REPORT, and it
        // is deliberately named before the audit gap below. An unredeemed invitation is a
        // live credential: the person just locked out can still register through the
        // invite-only gate, and doing so mints a BRAND-NEW Cognito sub, so the disable,
        // which is keyed on the old one, stops applying to them. The lockout silently
        // undoes itself.
        //
        // The count cannot express this on its own, which is why the service reports it
        // separately: "3 destroyed" reads the same whether a fourth survived or there were
        // only three. So an incomplete revocation is never a clean success, however many
        // it managed.
        const gaps: string[] = [];
        if (!result.invitationsRevokeComplete) {
          gaps.push(
            "at least one pending invitation could NOT be revoked and still admits a registration, so they can re-register under a new account, which would escape this block. Revoke it by hand and report this."
          );
        }
        if (!result.audited) {
          gaps.push(
            "the change could not be written to the audit trail, so there is no record of who made it. Report it."
          );
        }

        setAccessOutcome({
          kind: gaps.length === 0 ? "confirmed" : "partial",
          message:
            gaps.length === 0
              ? `${name} can no longer sign in.${revoked}`
              : `${name} can no longer sign in.${revoked} However, ${gaps.join(" Also, ")}`,
        });
      }
      // Only this request's own dialog may be closed. A stale answer closing the open one
      // pairs a green confirmation with a change that has not been answered yet.
      if (isCurrent) setPendingAccess(null);
      // The row's `status` is server state. Invalidated rather than patched so the badge
      // comes from the same response every other field does, a locally-flipped badge
      // would claim a mirror write succeeded when the service reports it separately.
      utils.admin.listUsers.invalidate();
    },
    onError: (err, variables) => {
      const isCurrent = variables.userId === currentAccessRef.current;
      const name = accessLabelsRef.current.get(variables.userId) ?? "That account";
      // The service's message names the rule that actually fired, and three of them are
      // specific enough to act on: SELF_ACTION_REFUSED, LAST_ADMIN_REFUSED ("grant another
      // admin first"), and the role-matrix 403. Surfaced verbatim rather than flattened.
      setAccessOutcome({
        kind: "failed",
        message:
          err.message ||
          `${name}'s access was not changed. Try again, and reload the page if it keeps failing.`,
      });
      if (isCurrent) setPendingAccess(null);
    },
    onSettled: (_data, _err, variables) => {
      // The per-row duplicate-submit guard. Released unconditionally, an earlier request
      // settling re-arms a button whose own request is still in flight, and a second
      // disable re-revokes invitations and writes a second ACCESS_DISABLED entry.
      if (variables.userId === currentAccessRef.current) {
        setSubmittingAccess(null);
        currentAccessRef.current = null;
      }
      accessLabelsRef.current.delete(variables.userId);
    },
  });

  if (error) {
    return (
      <p className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
        {error.message}
      </p>
    );
  }

  const users = data?.users ?? [];

  // NO CLIENT-SIDE FILTER any more, the store applies the match, so what arrives is
  // already the result set. Filtering again here would be a second, narrower rule that
  // could silently drop a row the server considered a match (the store searches name and
  // email; this used to also search organisation, which is why an org match would now
  // arrive and then be discarded).
  const needle = debouncedSearch;
  const visible = users;

  const filtered = !!(teamId || workshopId);

  return (
    <>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl font-bold">People</h2>
        <p className="text-sm text-ink-subtle">
          {/* "N of M shown" was honest for a client-side filter over a loaded page. It is
              NOT honest for a server search: M would be the matches on THIS page, not the
              total, so "3 of 3" alongside a Next button would read as "3 in total". The
              match count plus the page number is what can actually be claimed. */}
          {needle
            ? `${visible.length} ${visible.length === 1 ? "match" : "matches"}`
            : `${users.length} ${users.length === 1 ? "account" : "accounts"}`}
          {!filtered && page > 0 && ` · page ${page + 1}`}
        </p>
      </div>

      {/* Said plainly because the two halves of "user management" now behave differently,
          and an operator who cannot find a role control needs to know it does not exist
          rather than hunt for it. Access revocation dropped out of this sentence because it
          is no longer pending, it is a button on every row that has one. */}
      <p className="mb-5 rounded-md border border-notice-border/50 bg-notice-bg px-4 py-3 text-sm text-notice-text">
        Everyone who has registered on the platform. You can withdraw and restore
        sign-in access here; changing someone&apos;s role is not supported yet, so a
        role change means a fresh invitation.
      </p>

      {/* ABOVE the list, and above the paging controls, so it survives every one of the
          things that destroy a row: the refetch after a change, a page turn, a new search.
          Fixed position, so a second outcome appears where the operator already looked. */}
      <ActionOutcome
        outcome={accessOutcome}
        onDismiss={() => setAccessOutcome(null)}
        className="mb-4"
      />

      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Placeholder names ONLY what the server actually matches. It said "name, email
            or organisation" while the browser-side filter did search all three, now that
            the match happens in the store (name and email), promising organisation would
            have someone type a company and conclude the person is not on the platform. */}
        {/* The id is here so the confirmation dialog can return focus to this box if the
            row it was opened from has left the list (a search or filter applied while the
            dialog was open), see fallbackFocus below. */}
        <input
          id="user-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email"
          aria-label="Search users by name or email"
          className="flex-1 rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-brand outline-none"
        />
        <select
          value={scope}
          onChange={(e) => changeScope(e.target.value)}
          aria-label="Filter by experience or team"
          className="rounded-md border px-3 py-2 text-sm text-ink-muted sm:w-72"
        >
          <option value="">All experiences and teams</option>
          {(scopes.data?.scopes ?? []).map((s) => (
            // A workshop is selectable in its own right (everyone across its teams),
            // with its teams nested beneath it. optgroup label is not selectable, so
            // the workshop needs its own option inside the group.
            <optgroup key={s.workshopId} label={s.workshopName}>
              <option value={`w:${s.workshopId}`}>
                Everyone in {s.workshopName}
              </option>
              {s.teams.map((t) => (
                <option key={t.id} value={`t:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {/* ⚠ SAID OUT LOUD. The fan-out behind this menu is capped, so on an account owning more
            experiences than the cap the list is SHORT, and a missing experience reads as one that
            does not exist. Same reasoning as the teams directory's truncation notice. */}
        {scopes.data?.truncated && (
          <p className="mt-1 text-xs text-warn-text">
            Incomplete list. You own more experiences than this filter can load at once, so some are
            missing from it.
          </p>
        )}
      </div>

      {/* Said out loud because the two behave differently and the difference matters:
          the workshop/team filter is applied by the SERVER across every user, while the
          search box narrows only the rows already on screen. Without this note, a
          search that finds nothing on page 3 looks like the person doesn't exist. */}
      {needle && !filtered && data?.nextCursor && (
        <p className="mb-4 text-xs text-ink-subtle">
          Search covers this page only. There are more pages to look through.
        </p>
      )}

      {data?.truncated && (
        <p className="mb-4 rounded-md border border-warn-border bg-warn-bg px-4 py-2 text-sm text-warn-text">
          This scope has more members than one page can show. Filter by a single team
          to see the rest.
        </p>
      )}

      {isLoading ? (
        <SkeletonRows columns={USER_ROW_COLS} label="Loading users" />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline-strong bg-surface-1 py-12 text-center">
          {/* Three genuinely different empty states. "No users" under an active filter
              would read as "the platform is empty", which is alarming and wrong. */}
          <p className="text-ink-subtle">
            {needle
              ? "No one on this page matches your search."
              : filtered
                ? "No registered users in this experience or team."
                : "No registered users yet."}
          </p>
          <p className="text-sm text-ink-tertiary mt-1">
            {needle
              ? "Clear the search to see everyone on this page."
              : "People appear here once they accept an invitation and register."}
          </p>
        </div>
      ) : (
        /* ⚠ A DIVIDED LIST, NOT A STACK OF BORDERED CARDS. Each row drew its own border inside
           `space-y-2`, giving twenty boxes where there is one directory, card elevation claims a
           hierarchy these rows do not have, and the gaps cost an operator rows-per-screen on the
           densest list in the product. */
        <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
          {visible.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              canAdminister={canAdminister}
              submitting={submittingAccess === user.id}
              onChangeAccess={(enable) =>
                setPendingAccess({
                  userId: user.id,
                  name: user.name || user.email,
                  email: user.email,
                  role: user.role,
                  enable,
                })
              }
            />
          ))}
        </ul>
      )}

      {/* Paging is hidden while a filter is active: a filtered result is one complete
          page (the BFF returns no cursor for it), so Previous/Next would be dead
          controls. */}
      {!filtered && (page > 0 || data?.nextCursor) && (
        <div className="flex items-center justify-between mt-6">
          <button
            type="button"
            disabled={page === 0}
            /* GUARDED IN THE HANDLER as well as by `disabled`, and the two are not redundant.
               `disabled={page === 0}` is the first line of defence and a DOM PROPERTY: this
               suite runs environment:"node" with no jsdom, so nothing verifies it, and a
               refactor that drops it fails silently. This is the second line, in the only
               place a unit test can reach. Bare `c.slice(0, -1)` on the one-element stack
               yields `[]`, so `page` becomes -1, `cursors[-1]` is undefined, and the query
               refetches page 1 while the count line reads "page 0". Returning `c` unchanged
               is a no-op React bails out of, so a stray click costs nothing at all. */
            onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}
            className="rounded-md border px-3 py-1.5 text-sm font-medium text-ink-subtle hover:bg-surface-1 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!data?.nextCursor}
            onClick={() => setCursors((c) => [...c, data?.nextCursor])}
            className="rounded-md border px-3 py-1.5 text-sm font-medium text-ink-subtle hover:bg-surface-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}

      {/* ONE dialog for the whole tab, not one per row. Rendered here so a refetch or a
          page turn cannot unmount it while a request is in flight, and so there is exactly
          one modal in the tree no matter how many rows are on screen. */}
      {pendingAccess && (
        <ConfirmActionDialog
          title={
            pendingAccess.enable
              ? `Restore sign-in access for ${pendingAccess.name}?`
              : `Disable sign-in access for ${pendingAccess.name}?`
          }
          target={`${pendingAccess.email} · ${roleLabel(pendingAccess.role)}`}
          /* The consequences differ per direction, and NOT symmetrically, which is the
             whole reason the two are not one message with a verb swapped. Disabling has an
             irreversible side effect (the invitations) and a residual window (an issued
             token stays valid until it expires); restoring has neither, and claiming it
             does would be a warning an operator learns to ignore. */
          consequences={
            pendingAccess.enable
              ? [
                  <>They can sign in again with their existing password.</>,
                  <>
                    Team memberships and roles are untouched. Restoring access does not
                    add anyone back to a team.
                  </>,
                  <>
                    Invitations revoked when their access was withdrawn are{" "}
                    <strong>not</strong> restored. If they never registered, they need a
                    fresh invitation.
                  </>,
                ]
              : [
                  <>
                    They can no longer sign in to the portal or the desktop app. A session
                    already open stops working within a minute.
                  </>,
                  <>
                    Every pending invitation for {pendingAccess.email} is destroyed, so
                    they cannot re-register around this.
                  </>,
                  <>
                    Their team memberships and their team&apos;s work are left alone. This
                    withdraws sign-in, not membership.
                  </>,
                ]
          }
          reversibility={
            pendingAccess.enable ? (
              <>
                Reversible: you can withdraw access again from this screen at any time.
              </>
            ) : (
              <>
                Access can be restored from this screen at any time. The destroyed
                invitations cannot, so re-admitting someone who never registered means
                inviting them again.
              </>
            )
          }
          confirmLabel={pendingAccess.enable ? "Restore access" : "Disable access"}
          pendingLabel={pendingAccess.enable ? "Restoring…" : "Disabling…"}
          /* NEUTRAL for a restore. It is the recovery action, it takes nothing away, and
             dressing it in the same red as a disable would make red meaningless on the one
             screen where it has to carry weight. */
          tone={pendingAccess.enable ? "neutral" : "destructive"}
          pending={submittingAccess === pendingAccess.userId}
          reasonHint={
            pendingAccess.enable
              ? "Recorded in the permanent audit trail alongside your name, e.g. why they are being let back in."
              : "Recorded in the permanent audit trail alongside your name. Worth filling in: this is the field that answers the question later."
          }
          onConfirm={(reason) => {
            // Set before mutate, so no response can arrive unidentifiable. Moving
            // `currentAccessRef` to this request is what makes every earlier one stale.
            accessLabelsRef.current.set(pendingAccess.userId, pendingAccess.name);
            currentAccessRef.current = pendingAccess.userId;
            setSubmittingAccess(pendingAccess.userId);
            setAccessOutcome(null);
            setUserAccess.mutate({
              userId: pendingAccess.userId,
              enabled: pendingAccess.enable,
              reason: reason.trim() || undefined,
            });
          }}
          onDismiss={(wasPending) => {
            // Closed with a request in flight: sent, unanswered, outcome genuinely unknown.
            // Named as such rather than silently dropped, because a disable that DID land
            // looks identical to one that never happened on a screen whose badge has not
            // refetched, and an operator who assumes the latter clicks again.
            if (wasPending) {
              setAccessOutcome({
                kind: "unknown",
                message: `The request to ${pendingAccess.enable ? "restore" : "disable"} access for ${pendingAccess.name} was sent but the result was never seen. Reload the page to check their current access before trying again.`,
              });
            }
            setPendingAccess(null);
          }}
          /* No returnToFallback here, unlike the team page's removal: this row SURVIVES the
             action. A disable flips its badge and swaps the button's label from "Disable" to
             "Restore", the trigger is the same element, still mounted, and returning focus
             to it is exactly right (the operator can undo immediately). The fallback covers
             only the case where the refetch no longer contains the row at all, e.g. a
             filter changed while the dialog was open. */
          fallbackFocus={() =>
            document.getElementById("user-search") as HTMLInputElement | null
          }
        />
      )}
    </>
  );
}

/**
 * Decode the single filter value into the pair the query takes.
 *
 * `"t:<id>"` / `"w:<id>"` / `""`. One string rather than two states because the
 * control is single-choice: a shape that cannot hold both is a shape that cannot send
 * the request the backend refuses.
 */
function decodeScope(scope: string): [string | undefined, string | undefined] {
  if (scope.startsWith("t:")) return [scope.slice(2), undefined];
  if (scope.startsWith("w:")) return [undefined, scope.slice(2)];
  return [undefined, undefined];
}

/**
 * The Users directory track: name+email | role | access | actions.
 *
 * Declared beside the row rather than inline so `SkeletonRows` above cannot drift from it, a
 * placeholder on a different grid is a second layout the page jumps out of.
 */
/**
 * The Users directory track: person | role | access | action.
 *
 * ⚠ NO `auto` COLUMN, AND THAT IS THE WHOLE POINT. The last track was `auto` and it broke the
 * alignment this grid exists to create: each row is its OWN grid (the `<li>` carries the
 * `display: grid`, because it also needs a hover background and the `border-l-4` state, neither
 * of which a `display: contents` row could hold). An `auto` track therefore resolves against
 * THAT ROW's content, so the caller's own row, whose action column reads "This is you, so you
 * cannot change your own access", grew its last column, squeezed the `1fr` name column, and
 * pushed its role badge left of every other row's. Reported exactly that way.
 *
 * Fixed widths make every row's tracks identical no matter what any single row contains, which
 * is the only way per-row grids can line up. `12rem` fits the widest reason at two lines; the
 * reason wraps rather than truncating, so nothing is lost to the cap.
 */
const USER_ROW_COLS = "minmax(0,1fr) 8rem 7rem 12rem";

function UserRow({
  user,
  canAdminister,
  submitting,
  onChangeAccess,
}: {
  user: AdminUser;
  canAdminister: (targetRole: string | undefined) => boolean;
  /** True while THIS row's access change is in flight. */
  submitting: boolean;
  /** `enable` is the direction requested, the current state inverted. */
  onChangeAccess: (enable: boolean) => void;
}) {
  // Three independent reasons a row may not be actionable, each worth saying out
  // loud, "no actions available" with no reason is the kind of UI that generates a
  // support question.
  //
  // These three are unchanged, and they are the reason this screen used to confuse readers: the
  // row explained why it was not actionable while offering no action, so a facilitator read
  // the explanation as a denial. The FOURTH path, `reason === null`, i.e. the row that IS
  // actionable, now carries the control those explanations were always about.
  const reason = !user.hasAccount
    ? "No sign-in account, profile record only"
    : user.isSelf
      ? "This is you, so you cannot change your own access"
      : !canAdminister(user.role)
        ? `Your role cannot manage a ${roleLabel(user.role)}`
        : null;

  /**
   * Whether this account is locked out, via the shared predicate, never `!== "ACTIVE"`.
   *
   * The asymmetry is deliberate and load-bearing: every row written before `status` existed
   * has no attribute at all, so testing for the DENY value is what lets old and new rows
   * read identically with no backfill. See isUserDeactivated in @praimana/shared.
   *
   * This is a DISPLAY MIRROR of Cognito's own flag, not the authority. It can lag, the
   * service reports its mirror write separately from the access change, which is exactly
   * why the outcome notice reports what happened rather than leaving the operator to infer
   * it from the badge.
   */
  const deactivated = isUserDeactivated(user);

  return (
    /* THE DISABLED ROW STATE, and it is deliberately loud. An operator scanning the
       directory for who has been locked out must find them without reading every row, so
       the state is carried FOUR ways over: a red left edge, a tinted surface, a "No access"
       badge in words, and a struck-through name. Never colour alone, the badge says it,
       and the strikethrough survives greyscale, glare and a wall display at an angle.

       border-l-4 with a transparent counterpart on an active row, rather than adding a
       border only when disabled: the width is present either way, so a row changing state
       does not move its own contents sideways by four pixels. */
    /* ⚠ AN ALIGNED GRID ROW, AND THE "NO ACCESS" EDGE IS AN INSET SHADOW RATHER THAN A BORDER.
       The row was `flex items-center justify-between`, so the role badge, the access badge and the
       action button each landed wherever that row's name and email happened to end. On the densest
       list in the product that means the Role column cannot be scanned, only read. Track:
       person | role | access | action. `md:items-center` because these columns hold an avatar and
       a button, not running text.

       ── ⚠ WHY THE STATUS EDGE IS NO LONGER `border-l-4` ──────────────────────────────────────
       It was, with `border-l-transparent` on active rows so the 4px was reserved in both states
       and a row changing state could not shift its own contents sideways. That reasoning was
       sound; the implementation collided with the list's own dividers.

       `divide-hairline` compiles to `.divide-hairline > :not([hidden]) ~ :not([hidden])`, which
       sets `border-color` on ALL FOUR SIDES at specificity (0,3,0), one class plus two
       `:not([hidden])`, each counting as an attribute selector. `.border-l-transparent` is
       (0,1,0). So from the SECOND row down the divider rule won the colour while `border-l-4`
       still supplied the width, and every row below the first grew a 4px hairline-coloured left
       edge. Row one was untouched because the sibling combinator never matches it, which is
       exactly why it looked like "rows have a thick left border, except the top one".

       Measured: row 1 `4px rgba(0,0,0,0)`, rows 2+ `4px rgb(230,231,233)`.

       An inset shadow cannot be overridden by a border-colour rule, and it is drawn INSIDE the
       padding box, so it costs no layout at all, which delivers the original "no sideways shift"
       guarantee more completely than the transparent border did, in both directions and for every
       row rather than only between the two states of one. */
    <li
      style={rowCols(USER_ROW_COLS)}
      className={`${ROW_GRID} md:items-center ${
        deactivated
          ? "bg-danger-bg/50 shadow-[inset_4px_0_0_0_rgb(var(--danger-text-strong))]"
          : ""
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          aria-hidden="true"
          className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-sm font-medium ${
            deactivated
              ? "bg-surface-2 text-ink-subtle"
              : "bg-brand-subtle text-brand-text"
          }`}
        >
          {(user.name || user.email || "?")[0].toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">
            {/* Struck through, so "this person cannot get in" is legible in a screenshot,
                in greyscale and to a colour-blind operator. The badge below carries the
                same fact in words for anyone who cannot see either. */}
            {/* gray-600, not the gray-500 that "de-emphasise it" would suggest: measured
                against the row's red-50/50 surface that is 7.25:1 where gray-500 is 4.63:1,
                and this is the NAME of a locked-out account, the one string an operator has
                to read correctly before acting. The strikethrough already carries the
                de-emphasis; the colour does not need to fight legibility to repeat it. */}
            <span className={deactivated ? "line-through text-ink-subtle" : undefined}>
              {user.name || user.email}
            </span>
            {user.isSelf && (
              <span className="ml-2 text-xs font-normal text-ink-tertiary">(you)</span>
            )}
          </p>
          <p className="text-xs text-ink-subtle truncate">
            {user.email}
            {user.organization && ` · ${user.organization}`}
          </p>
          <InvitedByNote invitedBy={user.invitedBy} />
        </div>
      </div>

      {/* Column 2, role. */}
      <span className="min-w-0">
        <span
          className={`inline-block truncate rounded-full border px-2 py-1 text-xs font-medium ${
            ROLE_BADGE[user.role] ?? ROLE_BADGE.PARTICIPANT
          }`}
        >
          {roleLabel(user.role)}
        </span>
      </span>

      {/* Column 3, access.
          THE ACCESS BADGE, rendered only when access is withdrawn. Deliberately not a matching
          "Active" badge on every other row: an active account is the baseline, and badging it
          would put a second pill on every row in the directory, noise that makes the one row
          that matters harder to find. The column still exists on every row, so the ones that DO
          carry a badge line up down the page instead of floating at the end of their own text. */}
      <span className="min-w-0">
        {deactivated && (
          <span className="inline-block rounded-full border border-danger-field-border bg-danger-bg px-2 py-1 text-xs font-medium text-danger-text">
            No access
          </span>
        )}
      </span>

      {/* ── Column 4, the action, OR the reason there isn't one ──────────────────────────
          ⚠ THESE TWO SHARE A COLUMN DELIBERATELY. The reason used to sit before the badges,
          several columns away from the button it was explaining the absence of. Put where the
          button would have been, it answers the question at the place the eye is already
          asking it. They are mutually exclusive by construction, `reason` is computed as
          "why this row has no action". */}
      <span className="md:text-right">
        {reason && (
          /* ⚠ WRAPS, NOT TRUNCATES. Inside a fixed 12rem column a truncated reason would clip
             "This is you, so you cannot change your own access" down to a few words, and the
             whole job of this string is to explain why the row has no button. Wrapping keeps it
             whole; grid rows size to their tallest cell, so a two-line reason costs height on
             that row alone and takes the alignment of nothing with it. */
          <span className="hidden text-xs leading-snug text-ink-tertiary sm:block">
            {reason}
          </span>
        )}
        {/* THE FOURTH PATH, the action the three reasons above were always about.
            Rendered only when none of them applies, which is precisely the gate the row
            already computed: an account with a sign-in, not the caller's own, and a target
            role their role may administer (useCanAdministerUser → USER_ADMIN_GRANTS, so a
            FACILITATOR sees this on a Judge, Executive or Participant and never on an
            Admin or a fellow Facilitator).

            The server decides independently, the user-access service re-reads the
            target's role from Cognito Groups and re-applies the matrix, plus the two guards
            no client can evaluate (no self-action, never the last enabled admin). So this
            gate spares an operator a button that would refuse; it does not protect
            anything. */}
        {!reason && (
          <button
            type="button"
            disabled={submitting}
            // Names the person AND the direction. "Disable" alone, repeated down a
            // directory, is fifty identically-labelled buttons to a screen-reader user.
            aria-label={
              deactivated
                ? `Restore sign-in access for ${user.name || user.email}`
                : `Disable sign-in access for ${user.name || user.email}`
            }
            onClick={() => onChangeAccess(deactivated)}
            /* Two different weights for two different consequences. Disable gets the quiet
               border that reddens on hover, the same control the team page's Remove and
               the invitation Revoke use, because it belongs to that family. Restore is a
               plain neutral button: it is the safe direction and must not look like the
               dangerous one.

               min-w so the label swapping between "Disable"/"Restore"/"Disabling…" cannot
               resize the button and drag the rest of the row with it.

               PENDING RENDERS AS ENGAGED, NOT FADED, for the same measured reason as the
               team page's Remove: `disabled:opacity-50` takes the "Disabling…" label to
               ~2.3:1, and that label is the whole acknowledgement of the click. */
            className={`min-w-[5.5rem] text-center text-xs font-medium px-2 py-1 rounded-md border transition-colors disabled:cursor-default ${
              deactivated
                ? "border-field-border text-ink-muted hover:bg-surface-1 disabled:bg-surface-2 disabled:text-ink-muted"
                : "border-hairline text-ink-subtle hover:border-danger-field-border hover:bg-danger-bg hover:text-danger-text-strong disabled:border-danger-field-border disabled:bg-danger-bg disabled:text-danger-text"
            }`}
          >
            {submitting
              ? deactivated
                ? "Restoring…"
                : "Disabling…"
              : deactivated
                ? "Restore"
                : "Disable"}
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * TEAMS, the directory, as a finding aid. Same screen as Users, different noun.
 *
 * Built against `trpc.team.listDirectory`, whose input shape is deliberately the same as
 * `admin.listUsers` (opaque cursor + optional server-side `search`), so this tab pages and
 * searches with the same idiom as UsersTab rather than a second one. Read UsersTab first if
 * you are changing either: the cursor STACK, the 300ms debounce and the reset-on-new-needle
 * are the same three mechanisms for the same three reasons.
 *
 * READ-ONLY BY DESIGN. There are no mutations, no dialogs and no destructive controls on
 * this tab at all, a row's only action is a link to the team's existing roster page, where
 * membership changes already live behind their own confirmations. A directory is where an
 * operator goes to FIND something; putting a Delete beside fifty rows of search results is
 * how the wrong team gets deleted at 4am.
 *
 * NO WORKSHOP/TEAM SCOPE SELECT, unlike UsersTab. `listDirectory` takes no scope parameter:
 * the SERVER applies the caller's own scope (an ADMIN sees every team; a FACILITATOR only
 * teams in workshops they own). A picker here would be a control that changes nothing, which
 * is worse than no control, it invites the operator to conclude a missing team does not
 * exist rather than that it is out of their scope. Said out loud in the notice below instead.
 *
 * NO "Search covers this page only" CAVEAT, also unlike UsersTab (see its note at the box).
 * That warning is FALSE here: this search is applied in the store across the whole table, so
 * repeating it would tell the operator the exact opposite of the truth.
 *
 * ONE NOTICE THAT IS NOT ABOUT PAGING: `scopeTruncated`. It says whole experiences are missing
 * from every query this tab makes, which is a different and worse fact than a short page, and
 * the reason the "no scope picker" reasoning above does not extend to suppressing it. Rendered
 * because the BFF now returns the field; it is never invented, because a warning with nothing
 * behind it is one an operator learns to ignore. See the note at the render site.
 */
function TeamsTab() {
  // Cursor pagination, held as a STACK so "Previous" works, identical to UsersTab, and for
  // the identical reason: the cursors are opaque and only ever move forward, so the only way
  // back is the one we came by. Never parsed, sliced or inspected; passed back byte-for-byte.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const page = cursors.length - 1;

  const [search, setSearch] = useState("");
  /**
   * The needle actually sent to the server, trailing the box by 300ms.
   *
   * Debounced because this is a SERVER search: un-debounced, every keystroke fires a filtered
   * table Scan. 300ms is long enough to coalesce typing and short enough that the list feels
   * live, the same figure UsersTab uses, so the two boxes feel the same under the hands.
   */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A new needle is a new result set, so the cursor stack must reset: those cursors point into
  // a DIFFERENT scan, and reusing them pages through the wrong result set. Keyed on the
  // DEBOUNCED value so it resets when the request changes, not once per keystroke.
  //
  // An EFFECT, matching UsersTab byte for byte rather than folding the reset into the debounce
  // timeout above. The known cost is one wasted request: typing a needle while on page 3 renders
  // once with the new search and the old cursor before this commits. It cannot paint wrong rows
  //, that query has no cached data, so the frame shows the loading state and the key has moved
  // on by the time anything resolves, so this stays the same shape as the tab beside it, since
  // two directories that page differently is the more expensive defect.
  useEffect(() => {
    setCursors([undefined]);
  }, [debouncedSearch]);

  const { data, isLoading, error } = trpc.team.listDirectory.useQuery({
    cursor: cursors[page],
    // Omitted when empty: an empty needle is a filter that matches everything, i.e. the same
    // as no filter but costing a store expression to say so. `limit` is left off entirely so
    // the page size stays the service's decision (50) rather than a third copy of the number.
    search: debouncedSearch || undefined,
  });

  // The error box, NOT an empty list. The one that matters is the service's 503
  // (DIRECTORY_SCOPE_UNAVAILABLE, raised when a FACILITATOR's owned-workshop scope could not
  // be determined): an empty directory is indistinguishable from a correct one, so a swallowed
  // failure here renders a plausible, wrong, empty page with no error anywhere on screen.
  if (error) {
    return (
      <p className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
        {error.message}
      </p>
    );
  }

  const teams = data?.teams ?? [];
  // NO CLIENT-SIDE FILTER, the store applies the match, so what arrives IS the result set.
  // Filtering again here would be a second, narrower rule that could silently drop a row the
  // server considered a match.
  const needle = debouncedSearch;

  return (
    <>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl font-bold">Teams</h2>
        <p className="text-sm text-ink-subtle">
          {/* What can HONESTLY be claimed, and nothing more, the same reasoning as the note
              at UsersTab's count line. With a SERVER-side search the count in hand is the
              matches on THIS PAGE, not the total, so "3 of 3" beside a live Next button would
              read as "3 in total". Never "N of M" here.

              The page number is shown on page 1 too, which is the one place this deviates from
              UsersTab. UsersTab hides it because its filtered mode has no paging at all, so
              page 0 is genuinely the whole result there. Here every result set is paged, and
              "50 teams" alone invites exactly the misreading above, "50 teams · page 1" does
              not. */}
          {needle
            ? `${teams.length} ${teams.length === 1 ? "match" : "matches"}`
            : `${teams.length} ${teams.length === 1 ? "team" : "teams"}`}
          {` · page ${page + 1}`}
        </p>
      </div>

      {/* The scope, said out loud, because "why can't I see team X" is otherwise a support
          question with no answer on screen, and because there is deliberately no filter
          control to hint at it (see the note on this component). Read-only is stated for the
          same reason UsersTab states which half of user management it cannot do: an operator
          who cannot find a control needs to know it is not here rather than hunt for it. */}
      <p className="mb-5 rounded-md border border-notice-border/50 bg-notice-bg px-4 py-3 text-sm text-notice-text">
        Every team you can see: an admin sees all of them, a facilitator sees the teams in
        the experiences they own. This is a read-only directory; open a team to change its
        roster.
      </p>

      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Placeholder names ONLY what the server actually matches, which is the TEAM NAME.
            Workshop name is deliberately not searchable, it is another service's data and
            the teams table stores only `workshopId`, so promising "team or workshop" would
            have an operator type a workshop name, get nothing back, and conclude the team
            does not exist. That trap has been hit on this screen before; see the identical
            note at UsersTab's search box. */}
        {/* maxLength enforces the BFF's cap in the box rather than as a thrown error: the
            procedure's `z.string().trim().max(100)` REJECTS a 101st character, which would
            surface as a tRPC error mid-typing, an error message for a keystroke, on a screen
            where every other error means something is actually wrong. */}
        <input
          id="team-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={100}
          placeholder="Search team names"
          aria-label="Search teams by name"
          className="flex-1 rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-brand outline-none"
        />
      </div>

      {/* ⚠ THE SCOPE WAS CAPPED, so this directory is INCOMPLETE, and this is NOT the same
          statement as "there are more pages". The service caps a facilitator's owned-workshop
          scope (an uncapped one was a permanent 500, see the BFF's note on `scopeTruncated`),
          so above the cap WHOLE EXPERIENCES are absent from every query this screen makes. An
          operator who does not see this searches for a team, gets nothing, and concludes it does
          not exist: the same trap the server-side search exists to close, in its worse form.

          AMBER, matching UsersTab's `truncated` notice token for token (border-warn-border /
          bg-warn-bg / text-warn-text, text-sm) so "your list is short of the truth" looks the
          same on both tabs. The box metrics are this tab's (px-4 py-3 mb-5) rather than
          UsersTab's py-2, so it sits in the same rhythm as the blue scope notice above it. The
          WORDS carry the whole fact, colour is a second channel here, never the only one, and
          nothing needed to act on it is hover-only.

          BELOW the search box and directly ABOVE the list, deliberately, rather than beside the
          count line: this mounts when `data` arrives and unmounts on every refetch that changes
          the query key (a new needle, a page turn), so placing it higher would shove the search
          box down under the operator's cursor mid-typing and pull it back up 300ms later. Only
          the list moves, and the list is already changing. Nothing is lost in that window, a
          refetch with no cached data renders the loading line, so an incomplete list is never on
          screen without this notice above it.

          The CAP ITSELF is not printed. The number lives in the team service and is not in the
          response, so a literal here would be a second copy free to drift into a lie. And there
          is deliberately no "filter to fewer experiences" advice: `listDirectory` takes no scope
          parameter, so that control does not exist. The route named instead is the one that is
          genuinely uncapped, the experience's own Teams tab. */}
      {data?.scopeTruncated && (
        <p className="mb-5 rounded-md border border-warn-border bg-warn-bg px-4 py-3 text-sm text-warn-text">
          Incomplete list. You can see more experiences than this directory can query at once,
          so it covers only some of them and leaves the teams in the rest out entirely. Paging
          will not reach those teams and the search will not find them: both work only on the
          part covered here. A team missing from this list still exists, so open its experience
          from the Experiences tab and use the Teams tab there.
        </p>
      )}

      {/* The same loading treatment as the other three tabs, so a load looks like a load
          wherever an operator is on this screen, with one addition: motion-reduce:animate-none,
          because animate-pulse is unconditional otherwise and an operator who has asked the OS
          for reduced motion should not be given a pulsing element. It animates OPACITY only, so
          it is composited and cannot cost layout. The text-ink-tertiary is INHERITED from the
          sibling tabs, not chosen: it measures 2.54:1 on white and fails the 4.5:1 AA floor. It
          is kept here only so the four loading states stay identical, all four want correcting
          in one pass, which is a change to the other tabs and therefore out of this diff. */}
      {isLoading ? (
        <SkeletonRows columns="minmax(0,1fr) 10rem 9rem" label="Loading teams" />
      ) : teams.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline-strong bg-surface-1 py-12 text-center">
          {/* Two genuinely different empty states. "No teams" under an active search would
              read as "the platform has no teams", which is alarming and wrong, and the
              unsearched case must not claim emptiness beyond the caller's own scope either. */}
          <p className="text-ink-subtle">
            {needle ? "No teams match your search." : "No teams to show."}
          </p>
          {/* gray-500, NOT the gray-400 the Users and Experiences empty states use. This is the
              line that tells an operator how to recover from an empty screen, and gray-400 on
              white measures 2.54:1, below the 4.5:1 AA floor for text this size, and unreadable
              on a glare-lit or badly-calibrated display. gray-500 is 4.83:1 and still clearly
              secondary to the line above it. The other two empty states have the same defect and
              should be corrected in one pass rather than left half-fixed. */}
          <p className="text-sm text-ink-subtle mt-1">
            {needle
              ? "Clear the search to see every team again. The search covers every page, and it matches the team name only."
              : "Teams appear here once they are created inside an experience you can see."}
          </p>
        </div>
      ) : (
        /* A directory, not a stack of cards, same reasoning as the Users tab above. */
        <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
          {teams.map((team) => (
            <TeamDirectoryRow key={team.id} team={team} />
          ))}
        </ul>
      )}

      {/* Paging, unconditional, unlike UsersTab there is no filter mode whose result is one
          complete page, so these are never dead controls when they are rendered. */}
      {(page > 0 || data?.nextCursor) && (
        <div className="flex items-center justify-between mt-6">
          <button
            type="button"
            disabled={page === 0}
            /* GUARDED IN THE HANDLER as well as by `disabled`, identical to UsersTab's Previous
               and for the identical reason: `disabled={page === 0}` is the first line of defence
               and a DOM PROPERTY, which this suite (environment:"node", no jsdom) cannot
               exercise, so a refactor that drops it fails silently. This is the second line, in
               the only place a unit test can reach. Bare `c.slice(0, -1)` on the one-element
               stack yields `[]`, so `page` becomes -1, `cursors[-1]` is undefined, and the query
               refetches page 1 while the count line reads "page 0". Returning `c` unchanged is a
               no-op React bails out of, so a stray click costs nothing at all. */
            onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}
            className="rounded-md border px-3 py-1.5 text-sm font-medium text-ink-subtle hover:bg-surface-1 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!data?.nextCursor}
            onClick={() => setCursors((c) => [...c, data?.nextCursor])}
            className="rounded-md border px-3 py-1.5 text-sm font-medium text-ink-subtle hover:bg-surface-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}

/**
 * One row of the teams directory: the team (a link to its roster), its member count, when it
 * was created, and which experience it belongs to.
 *
 * ⚠ THE TWO NULLS ON THIS ROW ARE FACTS ABOUT A FAILED READ, NOT ABSENT DATA, and both are
 * documented in the BFF (`listDirectory`'s DirectoryTeamRow). Neither may be defaulted away:
 *
 *   `memberCount === null` means THE ROSTER COUNT COULD NOT BE READ. It is NOT zero, and
 *     `?? 0` here would be a correctness bug rather than a cosmetic one, 0 is a number an
 *     operator acts on, and "empty team" is a reason to delete one. Rendered "-", which is the
 *     rendering the BFF asks for in as many words: "Render null as '-', never as zero."
 *
 *   `workshopName === null` means THE NAME LOOKUP FAILED. It is NOT "this team has no
 *     workshop", workshop names come best-effort from another service precisely so the lookup
 *     can never fail the directory an operator opened during an incident. `workshopId` is
 *     ALWAYS present, so the row falls back to the id: a blank cell here reads as a data
 *     problem and tells the operator nothing they can quote or search on.
 *
 * Both fallbacks are legible without colour, without hover and to a screen reader: the visible
 * glyph carries it for the eye, an sr-only phrase carries it for assistive technology, and the
 * `title` is an extra for a pointer rather than the only copy.
 */
function TeamDirectoryRow({
  team,
}: {
  team: {
    id: string;
    name: string;
    workshopId: string;
    workshopName: string | null;
    memberCount: number | null;
    createdAt: string;
  };
}) {
  // Read into a local and branched on with `== null`, which catches an older service version
  // that omits the field entirely as well as an explicit null. The one thing this must never do
  // is coerce either into 0, see the ⚠ note above. A local rather than a boolean flag so the
  // non-null branch is narrowed to `number` by the compiler and no `!` or `?? 0` is tempting.
  const count = team.memberCount;

  // `""` when there is no usable instant, see the note at the render site for why that is
  // rendered as nothing at all.
  const created = formatInstantUtc(team.createdAt);

  // THE WORKSHOP NAME if it is a real one, and null if it is any of the three ways of not
  // being one. Truthiness alone already routed `null` and `""` to the id fallback correctly;
  // `" "` is TRUTHY and slipped through it, rendering a cell that LOOKS blank, the exact
  // reading ("a data problem") the fallback exists to prevent, and the hardest kind to report
  // because there is nothing on screen to quote. Out of contract today (the service does not
  // send whitespace), so this is defence in depth rather than a fix for observed data.
  //
  // TRIMMED FOR THE TEST, NOT FOR THE RENDER: the value carried through is `team.workshopName`
  // itself, so a real name keeps whatever spacing the service stored, deciding a name is
  // absent is this row's business, rewriting one that is present is not. A local rather than an
  // inline condition so the compiler narrows it to `string` below and `title` needs no `!`.
  const workshopName = team.workshopName?.trim() ? team.workshopName : null;

  return (
    /* ⚠ A LIST ITEM WITHOUT ITS OWN BORDER. When the Teams tab's container became a bordered
       panel of divided rows, this row kept `rounded-lg border`, so every row drew a box INSIDE
       the panel's box, doubling every edge. It was also a `<div>` directly inside a `<ul>`, which
       is invalid and makes `getByRole("listitem")` find nothing. The panel owns the border and the
       dividers; the row owns its padding. */
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        {/* The truncation lives on the BLOCK, as it does on every other row on this screen -
            `truncate` is overflow+ellipsis and does nothing on an inline anchor. Truncated by
            CSS rather than by slicing the string, so a ten-times-wider-than-expected name
            cannot widen the row, cannot push the workshop column, and stays complete in the DOM
            for assistive technology and for select-and-copy. */}
        <p className="text-sm font-medium truncate">
          {/* The team NAME is the link, to the roster page it already has. Built through
              teamTabHref rather than templated here, because that helper exists to be the one
              place this path is spelled, a typo produces a 404 on a link whose whole job is to
              be the way in. */}
          <Link
            href={teamTabHref(team.workshopId, team.id)}
            className="hover:text-brand-text-strong focus:outline-none focus:ring-2 focus:ring-brand rounded-sm"
          >
            {/* The accessible name is the team name ALONE, which is what a screen-reader user
                tabbing this list needs to hear out of context. The arrow is decoration that
                says "this goes somewhere" to the eye; announced, it is "right arrow" fifty
                times down a directory. */}
            {team.name}
            <span aria-hidden="true"> →</span>
          </Link>
        </p>
        <p className="text-xs text-ink-subtle">
          {count == null ? (
            <>
              {/* THE FAILED COUNT. The em dash is aria-hidden and paired with a phrase that says
                  what it means, so this is never announced as a blank cell, and never as "0
                  members", which is the reading that gets a populated team deleted. The `title`
                  is a third copy for a pointer, never the only one. */}
              <span
                aria-hidden="true"
                title="Member count unavailable: the roster could not be read. This is not zero."
              >
                - members
              </span>
              <span className="sr-only">
                Member count unavailable, the roster could not be read
              </span>
            </>
          ) : (
            `${count} ${count === 1 ? "member" : "members"}`
          )}
          {/* WHEN THE TEAM WAS CREATED, through the SAME fixed-width UTC formatter every other
              instant on this screen uses. formatInstantUtc directly rather than the SentAt
              component beside it: SentAt exists to keep the two INVITATION lists rendering one
              field identically, and borrowing it for an unrelated field would tie a team's
              creation date to any future change made for invitations.

              Not toLocaleDateString (a latent hydration mismatch, and no longer used anywhere in
              this file, the sibling experience row formatted that way until the redesign moved it
              to `workshopDate`): this is a client component, so React renders it on
              the server and again in the browser, and Intl plus the host timezone disagree
              between the two. Fixed-width and zero-padded, so the column does not shift
              horizontally as the dates differ. It prints the TIME and the zone as well as the
              date, which is more than the eye needs here but is the honest output of the shared
              helper, a date-only variant would mean hand-rolling a second format.

              Empty when createdAt is missing or unparseable, and rendered as NOTHING rather
              than "Invalid Date": an unknown creation date is not a fault in the team, and this
              row's real content is the name and the count. */}
          {created && (
            <>
              {" · created "}
              {/* `title` duplicates `dateTime` deliberately, <time> is not a tooltip. Both are
                  extras: the rendered text already carries the date, the time and the zone, so
                  nothing needed to act on this row is hover-only. */}
              <time dateTime={team.createdAt} title={team.createdAt}>
                {created}
              </time>
            </>
          )}
        </p>
      </div>

      {/* THE EXPERIENCE this team belongs to, right-aligned in a fixed slot so the column
          reads down the list. Truncated by CSS rather than by string-slicing, so the full name
          stays in the DOM for assistive technology and in `title` for a pointer, a long name
          cannot widen the row or push the link under a travelling cursor. */}
      <div className="shrink-0 max-w-[14rem] text-right">
        {/* Branched on the TRIMMED local rather than on `team.workshopName` directly, and never
            on `!= null`: `null`, `""` and `" "` are all "not a name", and every one of them must
            take the id fallback. `""` and `" "` would otherwise render an invisible cell that
            reads as a data problem, which is the failure this fallback exists to prevent, so
            letting one spelling of it through would be worse than having no fallback. See the
            note where the local is built for why only the TEST is trimmed. */}
        {workshopName ? (
          <p className="text-xs text-ink-subtle truncate" title={workshopName}>
            {workshopName}
          </p>
        ) : (
          <p
            className="text-xs text-ink-subtle truncate"
            // ⚠ THE TOOLTIP AND THE SCREEN-READER TEXT MUST AGREE, AND THEY DID NOT. This said
            // "Workshop name unavailable, showing the workshop id …" while the sr-only span below
            // said "Experience name unavailable", so a hovering user read one noun and a
            // screen-reader operator heard another, for the same cell. The product renamed
            // workshop→experience in the user-facing copy and this attribute was missed;
            // src/lib/team-directory-row.test.ts pins "experience" as the canonical wording. The
            // `workshopId` FIELD keeps its name, that is the data model, not the copy.
            title={`Experience name unavailable, showing the experience id ${team.workshopId}. The team does belong to an experience.`}
          >
            {/* NOT a blank, and not "no experience". The id is what we know for certain, and it
                is the value an operator can quote in a ticket or paste into a URL. */}
            <span className="sr-only">Experience name unavailable, experience id </span>
            {team.workshopId}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * WHO INVITED this person, and how sure we are.
 *
 * Renders nothing when there is no invitation record at all, the bootstrap admin has
 * none, and an absent line is more honest than "Invited by unknown" on a row where
 * nobody was ever recorded.
 *
 * FOUR distinct states, and collapsing any two of them would mislead:
 *   a name, we know who, and the caller may know it.
 *   "Not shown", we know who, and the caller may NOT know it (a
 *                             facilitator looking at someone an admin invited). NOT a
 *                             blank: a blank reads as missing data and invites a
 *                             support question about a working rule.
 *   "account removed", there was an inviter, and their account is gone.
 *   an "earliest invite" qualifier, the person never redeemed an invitation, so this
 *                             is the first person who invited them rather than a
 *                             record of what happened. Someone about to revoke access
 *                             on the strength of who vouched for a user should know
 *                             which of the two they are reading.
 */
/**
 * How often the invitation list re-evaluates "has this link lapsed yet".
 *
 * An invite link lives 24 hours, so a minute of lag on the Pending→Expired transition
 * is immaterial, and one timer per mounted tab is far cheaper than the alternative of
 * reading the clock during render (see useClientNow). Named rather than inlined so the
 * cadence is a decision, not a literal.
 */
const EXPIRY_TICK_MS = 60_000;

/**
 * A clock that is SAFE TO RENDER: `0` until the component has mounted, then the real
 * time, refreshed every EXPIRY_TICK_MS.
 *
 * Why not just call Date.now() where it is needed, which is what this screen did
 * before. This is a client component, so React renders it on the server during
 * prerender and again in the browser at hydration. Two clock reads, milliseconds to
 * minutes apart, and an invitation sitting near its 24-hour boundary resolves to
 * "Pending" in one and "Expired, send another" in the other. React reports that as a
 * hydration mismatch and re-renders the subtree; the same trap SiteFooter.tsx documents
 * on BRAND_YEAR, which is why the clock is moved out of render entirely rather than
 * papered over with suppressHydrationWarning.
 *
 * `0` PRE-MOUNT IS DELIBERATE AND IT FAILS IN THE SAFE DIRECTION. With `now = 0` no
 * expiry has passed, so every unaccepted row reads "Pending", exactly what the server
 * can honestly claim, since it has no idea when the reader's browser will show it. The
 * only correction after mount moves a row Pending → Expired, i.e. it ADDS a warning and
 * never withdraws one. The opposite default would have the screen briefly tell an
 * administrator a live invitation is dead.
 *
 * The interval keeps a long-lived tab honest: an operator who leaves this open across a
 * shift would otherwise keep reading "Pending" against a link that lapsed hours ago,
 * which is the precise misreading invitationStatusLabel exists to prevent.
 */
function useClientNow(): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return now;
}

/**
 * INVITATIONS, inviting staff who belong to no team, and withdrawing those invites.
 *
 * Scope, and why there is no team picker here: an ADMIN or FACILITATOR role is not a
 * membership of anything, so those invitations carry no team at all (they are stored
 * under the PLATFORM sentinel, see PLATFORM_INVITATION_TEAM_ID). A PARTICIPANT or
 * EXECUTIVE invitation is the opposite: the invitation is *what puts them on a team*,
 * so it cannot be sent from a screen that doesn't know which team.
 *
 * Which is not merely a UI preference, this screen genuinely cannot know. Workshops
 * are queried by ownerId (no list-all access pattern on the table), so an admin who
 * owns no workshop has nothing to pick from, and the invite CODE a team invitation
 * needs only exists inside a workshop's team list. Building a picker here would mean
 * a new data-model access pattern to satisfy a dropdown. So team invitations stay
 * where the team data already is, inside the team workspace, and this screen says
 * so rather than offering a role it would then fail to send.
 */
function InvitationsTab() {
  // Only the platform-scoped roles this user may grant. A FACILITATOR sees
  // Facilitator and Judge; an ADMIN also sees Admin. Participant and Executive are
  // filtered out because they are team-scoped, and the /api/invite route would
  // (correctly) refuse them without a team.
  const platformRoles = useInvitableRoles().filter((r) =>
    isPlatformScopedRole(r.role)
  );
  const canRevokeRole = useCanRevokeRole();
  // The caller's own address, for the self-invitation courtesy check below. ⚠ A COURTESY, NOT A
  // CONTROL, the Team service refuses a self-invitation on the token's VERIFIED email claim, and
  // that gate is the only copy that matters. This one exists so an operator who adds themselves
  // learns why before filling in the rest of the form.
  const { data: session } = useSession();

  const [emails, setEmails] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  // The workshop a JUDGE invitation grants. `""` until chosen, the same "nothing
  // selected" encoding the role uses, so the placeholder <option value=""> is the
  // selected one and the guard has a state to refuse.
  const [selectedWorkshop, setSelectedWorkshop] = useState("");
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  // The role actually submitted, and NO DEFAULT, `""` until the operator picks one.
  //
  // This used to fall back to `platformRoles[0]?.role`, i.e. Judge, and the comment here
  // explained at length why the source array's order (and not the alphabetical display
  // order) had to decide that default, since "Admin" sorts first and this is the one
  // form that can mint another platform administrator. Removing the default entirely is
  // strictly safer than picking the least-privileged one: granting a platform role is now
  // always a deliberate choice, and no ordering of any array can escalate it.
  // INVITABLE_PLATFORM_ROLES is left alone regardless, other call sites and the authz
  // tests still pin its order.
  //
  // Still DERIVED rather than seeded into useState: the session is empty on first render,
  // and a useState initializer would latch that. Shared with the team page's invite form
  // (lib/invite-form.ts) so the two cannot drift on what "nothing chosen" means.
  const platformRole = submittedPlatformRole(selectedRole, platformRoles);

  // The dropdown's OPTIONS, alphabetical by label. Still a separate list from
  // `platformRoles` and still built with platformRolesByLabel(), because the source
  // array's order remains load-bearing elsewhere, this screen simply no longer reads
  // `[0]` for a default.
  const roleOptions = platformRolesByLabel(platformRoles);

  // Does this role owe us a workshop? Derived from the SAME helper the guard uses, so the
  // picker cannot be shown for a role the guard would not demand one for (or, worse,
  // demanded for a role with no picker rendered, a permanently dead button).
  const needsWorkshop = requiresWorkshop(platformRole);

  /**
   * The experiences offered. `admin.invitableExperiences`, which answers exactly the question
   * this dropdown asks: which experiences may this caller invite INTO.
   *
   * ⚠ IT USED TO BE `admin.filterScopes`, AND THAT STOPPED BEING THE SAME QUESTION.
   * filterScopes answers "which scopes may I FILTER the user directory by" and is
   * backed by `GET /v1/workshops` (listByOwner). Since an ADMIN may now invite into ANY
   * experience while being able to OPEN only their own, the filter list is strictly narrower
   * than the invitable list, so borrowing it silently prevented an admin from naming another
   * owner's experience, which is the whole point of the wider list. The old comment here
   * predicted this exact change ("if ADMIN list-all lands … should widen"); it widened as a
   * SEPARATE procedure instead, because the two questions now have two answers.
   *
   * The FACILITATOR's answer is unchanged, the procedure falls back to their owned list.
   */
  const workshopScopes = trpc.admin.invitableExperiences.useQuery(undefined, {
    // Only fetched when a role that needs it is chosen. A form sitting on "Select a
    // role…" makes no request, and choosing Admin or Facilitator makes none either.
    enabled: needsWorkshop,
  });
  const workshopOptions = workshopScopes.data?.experiences ?? [];

  // The workshop actually submitted, re-derived every render rather than trusted once -
  // the same discipline as submittedPlatformRole. A selection that stops being offered
  // (the caller's workshop list narrowed, a tampered <option>) collapses to "nothing
  // chosen", so the form blocks instead of posting an id the backend would 403.
  //
  // It also collapses when the role no longer needs a workshop, which is what stops a
  // stale id being posted alongside a FACILITATOR invitation, the backend 400s a
  // workshopId on those, so sending one would break a form that looks complete.
  const workshopId =
    needsWorkshop && workshopOptions.some((w) => w.id === selectedWorkshop)
      ? selectedWorkshop
      : "";

  // Blocked on ALL THREE inputs, with the reason said out loud below rather than left as
  // a disabled button with no explanation.
  /**
   * Is the operator about to invite THEMSELVES? A courtesy check, the Team service refuses it
   * with 403 `SELF_INVITATION_REFUSED` regardless (gate 3), and that gate is what makes an
   * admin's "invite into any experience" grant safe rather than an escalation.
   *
   * The comparison rule lives in `recipientsIncludeSelf` so it matches the service's exactly
   * (trimmed, lower-cased); an absent session email yields FALSE, because "we cannot tell" must
   * not render as an accusation.
   */
  const includesSelf = recipientsIncludeSelf(emails, session?.user?.email);

  const blockedReason = inviteBlockedReason(
    platformRole,
    emails.length,
    workshopId,
    includesSelf
  );

  // Read ONCE per render and passed down, so every row in the list judges expiry
  // against the same instant. Per-row Date.now() calls would let a long list straddle
  // the tick and render two rows minted in the same second with different statuses.
  const now = useClientNow();

  // The pending list is the same team-service route the team page uses, asked for the
  // sentinel "team". The service filters rows by the invite matrix, so a facilitator
  // never sees an ADMIN invitation they couldn't withdraw.
  const { data: invitations = [], refetch } = trpc.team.listInvitations.useQuery({
    teamId: PLATFORM_INVITATION_TEAM_ID,
  });

  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const revokeInvitation = trpc.team.revokeInvitation.useMutation({
    onSuccess: () => {
      setRevokeError("");
      refetch();
    },
    onError: (err) => setRevokeError(err.message || "Failed to revoke the invitation"),
    onSettled: () => setRevoking(null),
  });

  async function send() {
    // The guard SAYS something now. A bare `return` here was invisible: with no role
    // chosen the button would appear to do nothing at all, which is the failure mode that
    // makes an operator click it repeatedly. Same predicate as the button's `disabled`,
    // so the two cannot disagree about what is sendable.
    setSuccess("");
    if (blockedReason) {
      setError(INVITE_BLOCKED_MESSAGE[blockedReason]);
      return;
    }
    setSending(true);
    setError("");
    try {
      // No teamId, teamName or inviteCode, the API route derives platform scope
      // from the ROLE, so the two can never disagree.
      //
      // `workshopId` is sent only when the chosen role takes one. It is `""` for every
      // other role (see the derivation above), and omitting it is not cosmetic: the Team
      // service 400s a workshopId on an ADMIN or FACILITATOR invitation, so a stale
      // selection left in the body would refuse an invitation the operator filled in
      // correctly.
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails,
          platformRole,
          ...(workshopId ? { workshopId } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to send invitations");
      } else {
        setSuccess(
          `Invitation sent to ${emails.length} ${emails.length === 1 ? "person" : "people"}`
        );
        setEmails([]);
        refetch();
      }
    } catch {
      setError("Failed to send invitations");
    }
    setSending(false);
  }

  // A role with nothing to grant should not see a form it can't submit. Reachable in
  // principle if the grant matrix narrows later; today /admin is ADMIN+FACILITATOR.
  if (platformRoles.length === 0) {
    return (
      <div className="text-center py-12 border border-dashed rounded-lg">
        <p className="text-ink-subtle">Your role cannot invite platform staff.</p>
      </div>
    );
  }

  return (
    <>
      <h2 className="text-xl font-bold mb-1">Invite staff</h2>
      {/* Was "people whose access is platform-wide", which is no longer true of all
          three: a JUDGE is now scoped to the workshop the inviter names. Said here as
          well as at the picker, because this is the paragraph an operator reads before
          they discover the form asks for one. */}
      <p className="text-sm text-ink-subtle mb-5">
        Invite an admin, facilitator or judge: people who don&apos;t belong to a team.
        Admins and facilitators aren&apos;t tied to one experience; a judge is, so
        you&apos;ll be asked which one they&apos;re evaluating. To invite a participant
        or an executive, open their team and invite them from there, so they land on the
        right team with a join code.
      </p>

      <section className="mb-8 rounded-lg border p-5 bg-surface-1">
        <div className="mb-3 max-w-xs">
          <label
            htmlFor="platform-role"
            className="block text-xs font-medium text-ink-subtle mb-1"
          >
            {/* Marked required, and announced as such rather than relying on a red
                asterisk nobody reads out. */}
            Platform role <span aria-hidden="true">*</span>
          </label>
          <select
            id="platform-role"
            value={platformRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            required
            aria-required="true"
            className="w-full rounded-md border border-field-border px-3 py-2 text-sm bg-surface-3 focus:border-brand focus:ring-1 focus:ring-brand outline-none"
          >
            {/* The placeholder. `disabled` so it cannot be chosen deliberately, `value=""`
                so choosing nothing is representable and the submit guard has something to
                refuse. There is no pre-selected role on this form at all, see the note on
                `platformRole` above for why that is safer than defaulting to the least
                privileged one. */}
            <option value="" disabled>
              Select a role…
            </option>
            {/* Alphabetical by label so an administrator can find a role by scanning
                rather than by knowing the prominence order the constant is written in.
                Nothing here is pre-selected, so this order changes only what the list
                READS. */}
            {roleOptions.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
          </select>
          {/* The chosen role's description, or the instruction while none is chosen -
              the space is reserved either way so picking a role doesn't shift the form
              under the pointer. */}
          <p className="mt-1 text-xs text-ink-subtle">
            {platformRoles.find((r) => r.role === platformRole)?.description ??
              "Choose the role this invitation grants."}
          </p>
        </div>

        {/* THE WORKSHOP PICKER, rendered only for a role that takes one, which today is
            JUDGE alone. Not always-visible-but-disabled: an Admin or Facilitator
            invitation is REFUSED by the backend if it names a workshop, so a control
            that cannot legally be used on those roles should not be on screen asking to
            be. Conditional rather than hidden, so it is out of the tab order too.

            Why a judge needs one at all: it must not be possible to create a judge user
            without selecting a workshop. A judge invitation
            with no workshop registers cleanly, gets the JUDGE group, and then grants
            visibility of nothing, the person can see no workshop and score nothing.
            That is the same silent dead end the platform-scope check already refuses for
            participants and executives. */}
        {needsWorkshop && (
          <div className="mb-3 max-w-xs">
            <label
              htmlFor="invite-workshop"
              className="block text-xs font-medium text-ink-subtle mb-1"
            >
              Experience <span aria-hidden="true">*</span>
            </label>
            <select
              id="invite-workshop"
              value={workshopId}
              onChange={(e) => setSelectedWorkshop(e.target.value)}
              required
              aria-required="true"
              // Disabled only while the list is genuinely in flight. Once loaded the
              // control is live even if the list is EMPTY, so the empty state below is
              // read rather than mistaken for a slow load.
              disabled={sending || workshopScopes.isLoading}
              className="w-full rounded-md border border-field-border px-3 py-2 text-sm bg-surface-3 focus:border-brand focus:ring-1 focus:ring-brand outline-none disabled:bg-surface-2"
            >
              {/* Same placeholder contract as the role select: `disabled` so it cannot
                  be chosen back, `value=""` so "nothing chosen" is representable. */}
              <option value="" disabled>
                {workshopScopes.isLoading
                  ? "Loading experiences…"
                  : "Select an experience…"}
              </option>
              {workshopOptions.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {/* FOUR genuinely different states, and collapsing them would mislead. The error and
                the empty case both leave the operator unable to proceed, but only one of them is
                fixable by creating an experience, and the empty wording now depends on WHOSE
                experiences were listed, because "you have none" is wrong for an admin who is
                shown every experience on the platform and is looking at a genuinely empty one. */}
            <p className="mt-1 text-xs text-ink-subtle">
              {workshopScopes.error
                ? "Couldn't load the experiences. Reload the page to try again."
                : workshopScopes.isLoading
                  ? "Loading the experiences you can invite into…"
                  : workshopOptions.length === 0
                    ? workshopScopes.data?.scope === "all"
                      ? "There are no experiences on the platform yet. Create one on the Experiences tab first."
                      : "You have no experiences to invite a judge into yet. Create one on the Experiences tab first."
                    : "The judge will be able to see and score this experience."}
            </p>
            {/* ⚠ THE BACKEND PREDATES THE CATALOGUE, said out loud, and only to an ADMIN, for whom
                the list is genuinely narrower than it should be. A facilitator's owned list is
                their correct answer either way, so telling them would be noise. The resolver
                degrades rather than throwing so the picker keeps working while the portal is
                deployed ahead of the workshop service; without that it would fail for every staff
                role, including facilitators who are not part of this feature. */}
            {workshopScopes.data?.catalogueUnavailable &&
              session?.user?.role === "ADMIN" && (
              <p className="mt-1 text-xs text-warn-text">
                Showing only the experiences you own. The full list isn&apos;t available from this
                backend yet. Others can still be invited into once the workshop service is updated.
              </p>
            )}
            {/* ⚠ SAID OUT LOUD, because a picker missing the experience an operator is hunting
                for reads as "it does not exist", the same class of lie as an empty directory
                during a brownout. Only reachable for an ADMIN, whose list is a bounded Scan. */}
            {workshopScopes.data?.truncated && (
              <p className="mt-1 text-xs text-warn-text">
                Incomplete list. There are more experiences than this picker can load at once, so
                the one you want may be missing.
              </p>
            )}
          </div>
        )}

        <div className="mb-3">
          <label
            htmlFor="invite-emails"
            className="block text-xs font-medium text-ink-subtle mb-1"
          >
            Email addresses
          </label>
          <EmailChipsInput
            id="invite-emails"
            emails={emails}
            onChange={setEmails}
            disabled={sending}
          />
        </div>

        <button
          type="button"
          onClick={send}
          disabled={sending || !!blockedReason}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover disabled:opacity-50 transition-colors"
        >
          {sending
            ? "Sending…"
            : `Send invitation${emails.length === 1 ? "" : "s"}${emails.length ? ` (${emails.length})` : ""}`}
        </button>

        {/* WHY the button is dead, stated next to it. A disabled control with no reason
            is the same support question as an inactionable row on the Users tab, and the
            missing role is the non-obvious half, a form with no visible default looks
            complete. Not an error style: nothing has gone wrong yet. */}
        {!sending && blockedReason && (
          <p className="mt-2 text-xs text-ink-subtle">
            {INVITE_BLOCKED_MESSAGE[blockedReason]}
          </p>
        )}

        {success && <p className="mt-2 text-sm text-success-text">{success}</p>}
        {error && <p className="mt-2 text-sm text-danger-text-strong">{error}</p>}

        <p className="mt-3 text-xs text-ink-subtle">
          Each person gets their own sign-up link, tied to their address and valid for
          24 hours. Nothing is created until they use it.
        </p>
      </section>

      <h3 className="font-semibold mb-3">
        Pending and accepted ({invitations.length})
      </h3>

      {revokeError && (
        <p className="mb-2 rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-text">
          {revokeError}
        </p>
      )}

      {invitations.length === 0 ? (
        <div className="text-center py-10 border border-dashed rounded-lg">
          <p className="text-sm text-ink-subtle">No staff invitations yet.</p>
          <p className="text-xs text-ink-tertiary mt-1">
            Invitations you send appear here until they&apos;re used.
          </p>
        </div>
      ) : (
        /* A divided list, same reasoning as the Users and Teams tabs. */
        <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
          {invitations.map((inv: (typeof invitations)[number], i: number) => {
            // Computed ONCE per row: the same label drives the avatar tint and the
            // status text, so they can never disagree about whether a link has lapsed.
            const status = invitationStatusLabel(inv, now);

            return (
              /* Track: invitee | role | status | action. Aligned for the same reason as every
                 other list on this screen, an operator scanning for expired links needs the
                 Status column to BE a column. */
              <li
                key={`${inv.email}-${i}`}
                style={rowCols("minmax(0,1fr) 8rem 10rem 7rem")}
                className={`${ROW_GRID} md:items-center`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    aria-hidden="true"
                    className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-sm font-medium ${
                      inv.status === "Accepted"
                        ? "bg-success-bg text-success-text"
                        : status.startsWith("Expired")
                          ? "bg-surface-2 text-ink-subtle"
                          : "bg-warn-bg text-warn-text"
                    }`}
                  >
                    {inv.email[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{inv.email}</p>
                    {/* ⚠ THE ROLE IS NO LONGER PRINTED HERE. This line read
                        `{roleLabel(inv.platformRole)} · {status}` while a badge two columns to
                        the right printed the SAME role again, the row said "Participant" twice.
                        The badge is the one that survives, because it now has a column of its own
                        to line up in; the status moves to a column of its own for the same
                        reason. What is left here is the invitee and when it was sent. */}
                    <p className="text-xs text-ink-tertiary">
                      {/* Was the raw ISO instant
                          ("sent 2026-08-01T20:47:31.195Z"). Now a fixed-width UTC
                          rendering with the full ISO value on the element, and nothing
                          at all when sentAt is empty (the tRPC mapper defaults it to
                          "") or missing on an older row. */}
                      <SentAt sentAt={inv.sentAt} label="sent" />
                    </p>
                    {/* WHO invited them. Resolved server-side from the invitation's
                        `invitedBy` SUB through the same helper the Users tab uses, so
                        the name is subject to USER_VISIBILITY_GRANTS and a bare UUID
                        never reaches the browser. Renders nothing when the lookup
                        found no inviter, see InvitedByNote. */}
                    <InvitedByNote invitedBy={inv.invitedBy} />
                  </div>
                </div>

                {/* Column 2, role. */}
                <span className="min-w-0">
                  <span
                    className={`inline-block truncate rounded-full border px-2 py-1 text-xs font-medium ${
                      ROLE_BADGE[inv.platformRole] ?? ROLE_BADGE.PARTICIPANT
                    }`}
                  >
                    {roleLabel(inv.platformRole)}
                  </span>
                </span>

                {/* Column 3, status. Accepted / Pending / Expired, computed once above so the
                    avatar tint and this label can never disagree about whether a link lapsed. */}
                <span className="truncate text-xs text-ink-subtle">{status}</span>

                {/* Column 4, the action. */}
                <span className="md:text-right">
                  {/* Only PENDING rows can be withdrawn, once accepted the person has
                      an account, and removing their access is user administration
                      (the Users tab), not invitation withdrawal. */}
                  {inv.status !== "Accepted" && canRevokeRole(inv.platformRole) && (
                    <button
                      type="button"
                      disabled={revoking === inv.email}
                      onClick={() => {
                        setRevoking(inv.email);
                        revokeInvitation.mutate({
                          teamId: PLATFORM_INVITATION_TEAM_ID,
                          email: inv.email,
                        });
                      }}
                      className="rounded-md border border-danger-border px-3 py-1.5 text-xs font-medium text-danger-text hover:bg-danger-bg disabled:opacity-50 transition-colors"
                    >
                      {revoking === inv.email ? "Revoking…" : "Revoke"}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// Status badges for an experience row. Matches the palette on the settings form
// (workshops/[id]/settings/page.tsx) so the same status is the same colour wherever
// it appears, an administrator scanning this list and then opening the form should
// not have to re-learn what amber means.
/* ── ⚠ THE SIX-COLOUR STATUS BADGE IS GONE, REPLACED BY THE SHARED THREE-TONE VOCABULARY ───
   It mapped each of the six lifecycle states to its own hue: grey, blue, green, amber, violet,
   grey again. Six colours is a key an operator has to learn before the colour tells them
   anything, and two of the six were the same grey, so the palette was carrying five distinct
   signals for a question that has three answers: is this live, does it need me, or is it done?

   `statusTone` (src/lib/workshop-display.ts) answers exactly that and is already what the
   /experiences list uses, so the two screens now agree. `statusLabel` supplies the words, which
   is what actually distinguishes JUDGING from ACTIVE, the colour never did.

   ⚠ IT ALSO FIXES A REAL MIS-TONING. `JUDGING` was amber here ("caution") and grey on the
   experiences list ("finished"), when it is the busiest phase of an accelerator. One vocabulary,
   one answer. */
/**
 * EXPERIENCES, the catalogue, with an edit route per row and one create entry point.
 *
 * WHY THIS TAB DOES NOT CONTAIN A FORM. Both forms already exist and are non-trivial
 * (the create form alone carries phases, team-size bounds, the assistant toggles and
 * the setup-config JSON), so a copy inside this screen would be a second definition of
 * "what an experience is" that drifts the first time a field is added to only one of
 * them. Every row links to /experiences/<id>/settings and Create links to
 * /experiences/new, each carrying `?from=admin` so Back and Cancel return HERE rather
 * than dumping the administrator on the workshop dashboard they didn't come from.
 *
 * WHAT THIS LIST CAN AND CANNOT SHOW. `workshop.list` is backed by
 * GET /v1/workshops, which is `listByOwner(callerId)`, the workshops table's only
 * access pattern is by owner and there is no list-all. So this shows the experiences
 * the CALLER owns, not every experience on the platform, and it says so rather than
 * implying a completeness it cannot deliver. Presenting an admin's own list as "all
 * experiences" would be the more dangerous of the two, because the missing rows are
 * invisible. Fixing it needs a new access pattern on the workshops table (a GSI or a
 * scan endpoint), a backend change, deliberately not invented here.
 *
 * The search box narrows the LOADED list client-side, which is complete here in a way
 * it is not on the Users tab: this response is not paginated, so there is no "more
 * pages to look through" caveat to make.
 */
function ExperiencesTab() {
  // Role-level gate for the create/edit affordances. /admin is already
  // ADMIN+FACILITATOR, so this is true for anyone who can see this tab today, kept
  // explicit because the tab is where the buttons are, and a future widening of who
  // reaches /admin must not silently hand out experience configuration.
  const canConfigure = useCanManageWorkshopSettings();
  const { data: session } = useSession();
  const myId = session?.user?.id;
  const isAdmin = session?.user?.role === "ADMIN";

  const [search, setSearch] = useState("");

  const { data: workshops, isLoading, error } = trpc.workshop.list.useQuery();

  if (error) {
    return (
      <p className="rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
        {error.message}
      </p>
    );
  }

  const all = workshops ?? [];

  // Substring match on name, description and format, the three fields a row shows,
  // so a search can never match something invisible. Case-insensitive because nobody
  // types a workshop name the way it was saved.
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? all.filter((w) =>
        // `filter(Boolean)` does NOT narrow the element type, so the annotation on `some` was
        // the only thing claiming these were strings, true while the list was `any[]`, and
        // false now that `description` is `string | null | undefined`. The type guard does the
        // narrowing the runtime filter was already doing.
        [w.name, w.description, w.format]
          .filter((field): field is string => !!field)
          .some((field) => field.toLowerCase().includes(needle))
      )
    : all;

  return (
    <>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl font-bold">Experiences</h2>
        <p className="text-sm text-ink-subtle">
          {needle
            ? `${visible.length} of ${all.length} shown`
            : `${all.length} ${all.length === 1 ? "experience" : "experiences"}`}
        </p>
      </div>

      <p className="mb-5 rounded-md border border-notice-border/50 bg-notice-bg px-4 py-3 text-sm text-notice-text">
        The experiences you own. Workshops are stored per owner, so an experience
        another admin or facilitator created is managed from their account.
      </p>

      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, description or format"
          aria-label="Search experiences"
          className="flex-1 rounded-md border px-3 py-2 text-sm"
        />
        {canConfigure && (
          <Link
            href="/experiences/new?from=admin"
            className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink text-center hover:bg-brand-hover transition-colors"
          >
            Create experience
          </Link>
        )}
      </div>

      {isLoading ? (
        /* ⚠ A SKELETON ON THE SAME TRACK, not a line of centred text. The old branch threw the
           layout away and the page jumped when the rows arrived. `SkeletonRows` takes the same
           column string the real rows use, which is why it is shared rather than hand-written. */
        <SkeletonRows
          columns="9rem minmax(0,1fr) 6rem 5rem 7rem auto"
          label="Loading experiences"
        />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline-strong bg-surface-1 py-12 text-center">
          {/* Two genuinely different empty states: "none yet" invites a create,
              "none match" invites clearing the search. */}
          <p className="text-ink-subtle">
            {needle
              ? "No experiences match your search."
              : "You haven't created an experience yet."}
          </p>
          <p className="text-sm text-ink-tertiary mt-1">
            {needle
              ? "Clear the search to see them all."
              : "An experience holds the teams, phases and AI configuration for one event."}
          </p>
        </div>
      ) : (
        /* ⚠ A DIVIDED LIST, NOT A STACK OF BORDERED CARDS. `space-y-2` over rows that each drew
           their own border gave nine boxes where there is one collection: card elevation claims a
           hierarchy these rows do not have, and the gaps between them cost vertical space that an
           admin scanning a catalogue would rather spend on rows. `divide-y` says "same kind of
           thing, one after another", which is what these are. */
        <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
          {visible.map((workshop) => (
            <ExperienceRow
              key={workshop.id}
              workshop={workshop}
              // Both halves of the settings gate, as on the workshop page: the role
              // may configure experiences AND the Workshop service will accept the
              // write (isOwnerOrAdmin). A row whose owner is someone else is listed
              // read-only rather than offered an Edit link that 403s on Save.
              canEdit={canConfigure && (isAdmin || workshop.ownerId === myId)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** One experience row: name, format/status, team count, and the edit affordance. */
function ExperienceRow({
  workshop,
  canEdit,
}: {
  /**
   * ⚠ WIDENED TO WHAT `workshop.list` ACTUALLY RETURNS, and the previous narrower version was
   * not merely imprecise, it hid a rendering bug. It declared `_count: { teams: number }`, but
   * that router PRESERVES `undefined` on purpose (the count lives in the Team service, so a
   * brownout or an unprivileged caller yields no number), and this row printed it straight into
   * the sentence: "undefined teams". `description` is likewise `string | null` on the wire.
   *
   * It type-checked only because the procedure's output was `any` all the way from `res.json()`.
   */
  workshop: {
    id: string;
    name: string;
    description?: string | null;
    format?: string;
    status?: string;
    createdAt?: string;
    _count?: { teams?: number };
  };
  canEdit: boolean;
}) {
  const created = workshopDate(workshop.createdAt);

  /* ── ⚠ AN ALIGNED ROW, NOT A SELF-LAYING-OUT CARD ───────────────────────────────────────
     This was `flex items-center justify-between` inside `rounded-lg border`, i.e. a bordered
     card that positioned its own metadata. Two consequences, both of which this grid removes:

       1. NOTHING LINED UP. Every row placed its status badge and Edit button wherever its own
          content ended, so a column could be read but never scanned, and the whole point of an
          admin catalogue is scanning it.
       2. THE METADATA WAS ONE SENTENCE. `IN_PERSON · 6 teams · created 8/1/2026` crammed three
          different kinds of fact into a `·`-separated string, so comparing team counts across
          rows meant reading three fields to find the second one.

     Track: status | name+description | format | teams | created | action. Same shape as the
     /experiences list, which is deliberate, an admin and a facilitator are looking at the same
     objects and should not have to learn two layouts. */
  return (
    <li
      style={rowCols("9rem minmax(0,1fr) 6rem 5rem 7rem 11rem")}
      className={`${ROW_GRID} group md:items-baseline`}
    >
      <StatusDot tone={statusTone(workshop.status)} label={statusLabel(workshop.status)} />

      <span className="min-w-0">
        {/* The name links to the experience itself, the destination for "show me this one",
            distinct from Edit, which opens its settings. */}
        <Link
          href={`/experiences/${workshop.id}`}
          className="block truncate rounded text-sm font-medium tracking-title-tight hover:text-brand-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {workshop.name}
        </Link>
        {workshop.description && (
          <span className="mt-0.5 block truncate text-xs text-ink-subtle">
            {workshop.description}
          </span>
        )}
      </span>

      <span className="truncate text-xs text-ink-muted">{formatLabel(workshop.format)}</span>

      {/* ⚠ `tabular-nums` AND RIGHT-ALIGNED. With proportional figures a column of 6 / 12 / 4
          does not align on the digit, which is the one setting that makes a numeric column read
          as a column. `teamCountLabel` keeps "- teams" for an absent count: this row used to
          print "undefined teams", and a confident "0" beside an experience that has six is worse
          than no number. */}
      <span className="text-xs text-ink-tertiary tabular-nums md:text-right">
        {teamCountLabel(workshop._count?.teams)}
      </span>

      {/* ⚠ `workshopDate`, NOT `toLocaleDateString()`. Bare `toLocaleDateString()` renders in the
          READER's locale, so the same experience read 8/1/2026 in Seattle and 01/08/2026 in
          London, two days five months apart, with nothing on screen to say which. */}
      <span className="text-xs text-ink-tertiary tabular-nums md:text-right">{created}</span>

      <span className="md:text-right">
        {canEdit ? (
          <Link
            href={`/experiences/${workshop.id}/settings?from=admin`}
            className="inline-block rounded-md border border-hairline px-3 py-1.5 text-xs font-medium text-ink-subtle transition-colors hover:border-hairline-strong hover:bg-surface-1 hover:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Edit
          </Link>
        ) : (
          // Said out loud for the same reason the Users tab explains an inactionable row: a
          // missing button with no explanation is a support question.
          <span className="hidden text-xs text-ink-tertiary sm:inline">Owned by someone else</span>
        )}
      </span>
    </li>
  );
}

/**
 * ── THE REPORT INBOX ───────────────────────────────────────────────────────────────────────
 *
 * THE RULE: facilitators and admins see feedback and bug reports under Administration, as a tab of their own.
 *
 * ⚠ THE GATE IS THE SERVICE'S, NOT THIS COMPONENT'S. `/v1/admin/feedback` sits behind the identity service's
 * `canManageUsers` middleware, so a JUDGE or PARTICIPANT who reached this URL gets a 403 from the API
 * regardless of what the UI offers. This renders the answer; it does not decide it.
 */
function FeedbackTab() {
  const utils = trpc.useUtils();
  // The SAME query key the badge uses, one request, and they cannot disagree about the count.
  const list = trpc.feedback.list.useQuery({ limit: 50 });
  const acknowledge = trpc.feedback.acknowledge.useMutation({
    onSuccess: () => utils.feedback.list.invalidate(),
  });

  if (list.isLoading) {
    /* Card-shaped placeholders, because the loaded state is cards: a report genuinely IS a
       document (a title, a body, a reporter, a page reference), which is the one case on this
       screen where elevation communicates a real boundary rather than inventing one. */
    return (
      <div className="space-y-3">
        <p className="sr-only" role="status">
          Loading reports
        </p>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="animate-pulse rounded-lg border border-hairline bg-surface-3 p-4"
          >
            <span className="block h-3.5 w-1/3 rounded bg-surface-2" />
            <span className="mt-3 block h-3 rounded bg-surface-2" style={{ width: `${80 - i * 8}%` }} />
            <span className="mt-2 block h-3 w-1/2 rounded bg-surface-2" />
          </div>
        ))}
      </div>
    );
  }

  if (list.error) {
    return (
      <div role="alert" className="rounded-lg border border-danger-border bg-danger-bg p-4 text-sm text-danger-text">
        These reports couldn&apos;t be loaded. {list.error.message}
      </div>
    );
  }

  const items = list.data?.items ?? [];

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-ink-subtle">No reports yet.</p>
        <p className="mt-1 text-xs text-ink-tertiary">
          Anyone signed in can send one from the menu under their name, in the portal or the desktop app.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((report) => {
        const unread = report.status === "NEW";
        return (
          <article
            key={report.id}
            // Unread is carried by the BORDER and by the word "New", not by colour alone.
            className={`rounded-lg border p-4 ${unread ? "border-brand-border bg-brand-wash" : "bg-surface-3"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      report.kind === "BUG"
                        ? "bg-danger-bg text-danger-text"
                        : "bg-brand-subtle text-brand-text"
                    }`}
                  >
                    {report.kind === "BUG" ? "Bug" : "Feedback"}
                  </span>
                  {unread && (
                    <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-ink">
                      New
                    </span>
                  )}
                  <span className="text-xs text-ink-subtle">
                    {report.reportedByEmail} · {platformRoleLabel(report.reportedByRole)}
                  </span>
                </div>
                {/*
                  ⚠ THE SUBJECT IS THE HEADING OF THE CARD, which is what a triager scans. Without it every
                  card opened with a wall of prose and the only way to tell two reports apart was to read
                  both.

                  ⚠ RENDERED ONLY WHEN THERE IS ONE. Reports filed before the field existed have an empty
                  subject (normalised at the repository), and an empty <h3> would leave a blank line and an
                  empty heading in the accessibility tree.
                */}
                {report.subject && (
                  <h3 className="mt-2 text-sm font-semibold text-ink">{report.subject}</h3>
                )}
                {/*
                  ⚠ `whitespace-pre-wrap`. A bug report is written with line breaks, steps, then what
                  happened, and collapsing them turns three readable steps into one paragraph.
                */}
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{report.message}</p>
                {/*
                  ⚠ LABELLED AND CAPITALISED: "Desktop" and "Portal", with every label in initial caps.
                  The line used to open with a bare lowercase "portal", which reads
                  as a fragment of a log rather than a fact about the report. `surfaceLabel` maps the stored
                  value, so the STORED form stays lowercase (it is an API value the desktop sends and the
                  service validates) and only the DISPLAY is capitalised, capitalising the wire value would
                  have been a breaking change dressed up as copy.
                */}
                <p className="mt-2 text-xs text-ink-subtle">
                  <span className="font-semibold text-ink-subtle">App:</span> {surfaceLabel(report.surface)}
                  {report.version ? (
                    <>
                      {" · "}
                      <span className="font-semibold text-ink-subtle">Version:</span> {report.version}
                    </>
                  ) : null}
                  {report.location ? (
                    <>
                      {" · "}
                      <span className="font-semibold text-ink-subtle">Screen:</span> {report.location}
                    </>
                  ) : null}
                  {" · "}
                  <span className="font-semibold text-ink-subtle">Filed:</span>{" "}
                  {formatMessageInstant(report.createdAt)}
                </p>
                {/*
                  ⚠ NAMES, FALLING BACK TO IDS, so the line reads "experience <name> · team <name>" rather
                  than two raw ids. A ULID tells a triager nothing; two of them
                  side by side tell them nothing twice, and the line was the least readable thing on the card.

                  ⚠ THE ID IS NOT THROWN AWAY, it moves into `title`. Whoever is triaging may well need it -
                  to query a table, to search the logs, to name the row in a ticket, and a name alone cannot
                  be pasted into any of those. Hover, or a screen reader, still gets it.

                  ⚠ AND AN UNRESOLVED ID STILL RENDERS, in mono, exactly as before. `workshopName` is null
                  when the lookup failed OR when this facilitator may not see that experience, and both must
                  read as "here is the id" rather than as an empty line, a blank where the context used to be
                  looks like a report that came from nowhere.
                */}
                {(report.workshopId || report.teamId) && (
                  <p className="mt-0.5 text-[11px] text-ink-subtle">
                    {report.workshopId && (
                      <span title={`Experience ${report.workshopId}`}>
                        <span className="font-semibold text-ink-subtle">Experience:</span>{" "}
                        {report.workshopName ? (
                          report.workshopName
                        ) : (
                          <span className="font-mono text-ink-tertiary">{report.workshopId}</span>
                        )}
                      </span>
                    )}
                    {report.teamId && (
                      <span title={`Team ${report.teamId}`}>
                        {report.workshopId ? " · " : ""}
                        <span className="font-semibold text-ink-subtle">Team:</span>{" "}
                        {report.teamName ? (
                          report.teamName
                        ) : (
                          <span className="font-mono text-ink-tertiary">{report.teamId}</span>
                        )}
                      </span>
                    )}
                  </p>
                )}
              </div>

              {unread && (
                <button
                  type="button"
                  onClick={() => acknowledge.mutate({ id: report.id })}
                  disabled={acknowledge.isPending}
                  className="shrink-0 rounded-md border border-field-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-1 disabled:opacity-60"
                >
                  Mark as read
                </button>
              )}
            </div>
          </article>
        );
      })}

      {/*
        ⚠ SAYS SO WHEN THERE ARE MORE. The list is capped at 50; without this line a reader would take the
        bottom of the page as the end of the inbox, the same "no silent caps" rule the observability plan
        applies to a truncated query.
      */}
      {list.data?.nextCursor && (
        <p className="text-xs text-ink-subtle">
          Showing the 50 most recent reports. Older ones are not shown yet.
        </p>
      )}
    </div>
  );
}

/**
 * ── PLATFORM HEALTH: READ-ONLY, AND IT AGREES WITH WHOEVER IS PAGED ────────────────────────
 *
 * A read-only platform health tab in Administration, visible only to admins and facilitators.
 *
 * ── ⚠ IT RENDERS ALARM STATES, NOT METRICS, AND THAT IS THE DESIGN ──
 *
 * The twelve platform alarms already encode every judgement this page would otherwise have to make: what is
 * abnormal, over what window, and what to do about it, the last of those written into each alarm's own
 * description as a runbook. Reading them means this page and the page sent to whoever is on call cannot
 * disagree. A panel that recomputed thresholds in the browser would eventually differ from the alarms, and a
 * status page that contradicts the alerting is worse than no status page.
 *
 * It also means this whole feature needs ONE read-only IAM action, on a role every service shares.
 *
 * ── ⚠ "CANNOT TELL" IS A STATE, DISTINCT FROM "HEALTHY" ──
 *
 * The three states are OK, ALARM and UNKNOWN, and UNKNOWN covers both `INSUFFICIENT_DATA` on a single alarm
 * and a failed read of the whole set. Neither is allowed to render as OK: an alarm with no data is one nobody
 * is being told about, and a health check that did not complete says nothing about health. This is the
 * discipline that unavailable is not permissive, applied to a status page, and it is the single easiest
 * thing to get wrong here, because the reassuring default is always the wrong one.
 *
 * ── ⚠ EVERY STATE HAS A NON-COLOUR SIGNAL ──
 *
 * A glyph and a word, not just green/amber/red. The platform's own a11y rule (see the desktop's
 * view-theme.test.ts) and the only way this is readable to somebody who cannot distinguish the colours, on
 * the one screen where "is anything wrong" must be answerable at a glance.
 */
const HEALTH_PRESENTATION: Record<
  "OK" | "ALARM" | "UNKNOWN",
  { glyph: string; word: string; pill: string; banner: string; headline: string }
> = {
  OK: {
    glyph: "✓",
    word: "Healthy",
    pill: "bg-success-bg text-success-text border-success-border",
    banner: "border-success-border bg-success-bg",
    headline: "Everything is reporting healthy",
  },
  ALARM: {
    glyph: "!",
    word: "In alarm",
    pill: "bg-danger-bg text-danger-text border-danger-border",
    banner: "border-danger-field-border bg-danger-bg",
    headline: "Something is wrong right now",
  },
  UNKNOWN: {
    glyph: "?",
    word: "No data",
    pill: "bg-warn-bg text-warn-text border-warn-border",
    banner: "border-warn-border bg-warn-bg",
    headline: "Some checks could not report",
  },
};

/** The alarm name as a sentence: "api-5xx" → "Api 5xx" is wrong, so hyphens become spaces and nothing else. */
function alarmTitle(name: string): string {
  const spaced = name.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The first sentence of an alarm's description, for the collapsed row.
 *
 * Deliberately crude, split on ". ", because the descriptions are hand-written operator prose and the
 * FULL text is one disclosure away. Losing a nuance in a summary is acceptable; hiding the runbook would not
 * be, which is why nothing is truncated permanently.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const end = trimmed.indexOf(". ");
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

function HealthTab() {
  /**
   * ⚠ POLLED, because a status panel's whole value is that it is current, a page left open during an
   * incident must not keep showing the state it had when it was opened. Sixty seconds is comfortably slower
   * than the alarms' own evaluation periods, so it cannot show a state the alarm has not reached; and each
   * poll is one DescribeAlarms call, which is why the interval is a minute rather than a few seconds.
   */
  const health = trpc.health.platform.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  if (health.isLoading) {
    return <p className="text-sm text-ink-subtle">Checking the platform…</p>;
  }

  /**
   * ⚠ THE FAILURE STATE SAYS WHAT IT DOES AND DOES NOT KNOW. The service answers 503 with a message written
   * for exactly this: it distinguishes "the check did not complete" from "the platform is unhealthy". A
   * generic "something went wrong" here would let a reader conclude either.
   */
  if (health.error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-warn-border bg-warn-bg p-4 text-sm text-warn-text"
      >
        <p className="font-semibold">The platform&apos;s health could not be read</p>
        <p className="mt-1">{health.error.message}</p>
        <p className="mt-2 text-xs">
          This says nothing about whether the platform is healthy, only that this check did not complete.
          Alarms still notify the team by email either way.
        </p>
        <button
          type="button"
          onClick={() => health.refetch()}
          className="mt-3 rounded-md border border-warn-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-warn-text hover:bg-warn-bg"
        >
          Try again
        </button>
      </div>
    );
  }

  const data = health.data;
  const alarms = data?.alarms ?? [];
  /**
   * ⚠ NO ALARMS IS `UNKNOWN`, NOT HEALTHY. An empty list means the read returned nothing, a filter that
   * matched no alarm names, or a deployment with no alarms at all, and "we found nothing to check" must not
   * be rendered as "we checked and it is fine".
   */
  const overall = alarms.length === 0 ? "UNKNOWN" : (data?.overall ?? "UNKNOWN");
  const look = HEALTH_PRESENTATION[overall];
  const inAlarm = alarms.filter((a) => a.state === "ALARM").length;
  const unknown = alarms.filter((a) => a.state === "UNKNOWN").length;

  return (
    <div className="space-y-4">
      <div className={`rounded-lg border p-4 ${look.banner}`}>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-lg font-bold">
            {look.glyph}
          </span>
          <h2 className="text-sm font-semibold text-ink">{look.headline}</h2>
        </div>
        <p className="mt-1 text-xs text-ink-subtle">
          {alarms.length === 0
            ? "No checks were returned, so nothing could be assessed."
            : `${alarms.length} checks · ${inAlarm} in alarm · ${unknown} with no data`}
          {data?.checkedAt ? ` · Last checked: ${formatMessageInstant(data.checkedAt)}` : ""}
        </p>
        <p className="mt-2 text-xs text-ink-subtle">
          Read-only. These are the platform&apos;s own alarms, the same ones that email the team when they
          fire, so this page and those alerts always agree.
        </p>
      </div>

      {/* ⚠ A DIVIDED LIST. Alarms were gapped bordered rows, which on the one tab an operator
          opens BECAUSE something is wrong spends vertical space on separation the divider
          already provides. State is carried by the pill and the glyph, not by the frame.

          ⚠ AND THE BRACES AROUND THIS COMMENT ARE LOAD-BEARING. It shipped for one commit as a
          bare block comment here, which in JSX children position is not a comment at all, it is
          text, and the whole paragraph rendered on screen above the alarm list. A block comment
          is only a comment inside braces, or in an expression slot such as after a ternary's
          colon. Every other list-container comment added in the same pass happened to sit in a
          ternary slot and was fine; this one sat between two elements.

          ⚠ AND THE SECOND ATTEMPT AT THIS NOTE BROKE THE BUILD, which is worth recording: it
          quoted a block-comment terminator inline as an example, and that terminator closed THIS
          comment early. Do not write one inside a comment, not even in backticks. */}
      <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
        {alarms.map((alarm) => {
          const state = HEALTH_PRESENTATION[alarm.state];
          const summary = firstSentence(alarm.description);
          return (
            /* The row keeps its padding but loses the border and the card surface, the list's
               dividers now supply the separation. */
            <li key={alarm.name} className="px-3 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{alarmTitle(alarm.name)}</p>
                  {summary && <p className="mt-0.5 text-xs text-ink-subtle">{summary}</p>}
                </div>
                {/* The glyph AND the word, never colour alone. */}
                <span
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${state.pill}`}
                >
                  <span aria-hidden="true">{state.glyph}</span> {state.word}
                </span>
              </div>

              {/*
                The full description carries the runbook. Behind a disclosure because twelve of these
                expanded is a wall of text on a page whose first job is "is anything wrong", but present,
                because when something IS wrong the runbook is the most useful text on the screen.
              */}
              {alarm.description && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-brand-text hover:underline">
                    What this means, and what to do
                  </summary>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-muted">
                    {alarm.description}
                  </p>
                  {alarm.reason && (
                    <p className="mt-2 text-[11px] text-ink-subtle">
                      <span className="font-semibold text-ink-subtle">Latest evaluation:</span>{" "}
                      {alarm.reason}
                    </p>
                  )}
                </details>
              )}

              {alarm.since && (
                <p className="mt-1 text-[11px] text-ink-tertiary">
                  <span className="font-semibold text-ink-subtle">Since:</span>{" "}
                  {formatMessageInstant(alarm.since)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * ── WHAT THE PLATFORM COSTS TO RUN, ADMIN ONLY ────────────────────────────────────────────
 *
 * Estimated daily and overall spend, visible to admins only, ideally scoped by the `ApplicationName`
 * cost allocation tag.
 *
 * ── ⚠ THE TAG-BASED FIGURE IS NOT AVAILABLE YET, AND THIS PANEL SAYS SO RATHER THAN SHOWING ZERO ──
 *
 * Observed in a member account: `ce:ListCostAllocationTags` returns AccessDenied
 * ("Linked account doesn't have access to cost allocation tags", activation is a MANAGEMENT-account action and
 * this is a member account), and `ce:GetTags --tag-key ApplicationName` returns a single EMPTY value, meaning
 * Cost Explorer holds no tag data at all. A tag-filtered total would therefore be $0.00, a panel reporting
 * that the platform is free.
 *
 * So the headline figure is the ACCOUNT total, labelled as such, and the tagged figure appears only once there
 * is one. The note explains what to do about it. Showing an unexplained 0 would be the worst of the three
 * options; silently substituting the account total and CALLING it the tagged figure would be worse still.
 *
 * ── ⚠ NO POLLING, AND THAT IS A BILLING DECISION ──
 *
 * The Cost Explorer API costs $0.01 per request against a platform that spends about $1/day. The service
 * caches for six hours and this panel does NOT auto-refresh, an interval here would have quietly turned a
 * status page into a line item. "As of" is shown for the same reason: a cached number without an age is a
 * number that lies.
 */
function money(amount: number, currency: string): string {
  // Intl over a hand-rolled `$${n.toFixed(2)}` so a non-USD account is not mislabelled, the currency comes
  // from Cost Explorer's own response, not from an assumption about the account.
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function CostTab() {
  const cost = trpc.cost.platform.useQuery(undefined, {
    // No refetchInterval: see the header. Six-hour-old figures are what the service holds anyway.
    refetchOnWindowFocus: false,
  });

  if (cost.isLoading) return <p className="text-sm text-ink-subtle">Reading the account&apos;s spend…</p>;

  if (cost.error) {
    /**
     * ⚠ AN ERROR, NEVER ZEROS. The service answers 503 with wording that distinguishes a failed query from a
     * figure of zero, and this renders that distinction rather than flattening it.
     */
    return (
      <div role="alert" className="rounded-lg border border-warn-border bg-warn-bg p-4 text-sm text-warn-text">
        <p className="font-semibold">The spend could not be read</p>
        <p className="mt-1">{cost.error.message}</p>
        <p className="mt-2 text-xs">
          This is a problem with the cost query, not a spend of zero. Cost Explorer must be enabled on the
          account and the service needs <code>ce:GetCostAndUsage</code>.
        </p>
        <button
          type="button"
          onClick={() => cost.refetch()}
          className="mt-3 rounded-md border border-warn-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-warn-text hover:bg-warn-bg"
        >
          Try again
        </button>
      </div>
    );
  }

  const data = cost.data;
  if (!data) return null;
  const c = data.currency;
  const top = data.byService.slice(0, 8);
  const largest = top[0]?.amount ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Estimated daily spend", value: money(data.dailyAverage, c), note: `Average over ${data.daily.length} day${data.daily.length === 1 ? "" : "s"} this month` },
          { label: "Month to date", value: money(data.monthToDate, c), note: data.yesterday !== null ? `Yesterday: ${money(data.yesterday, c)}` : "No complete day yet" },
          { label: "Projected this month", value: money(data.projectedMonth, c), note: "Month to date + daily average × days left" },
        ].map((card) => (
          <div key={card.label} className="rounded-lg border bg-surface-3 p-4">
            <p className="text-xs font-semibold text-ink-subtle">{card.label}</p>
            <p className="mt-1 text-2xl font-bold text-ink">{card.value}</p>
            <p className="mt-1 text-[11px] text-ink-subtle">{card.note}</p>
          </div>
        ))}
      </div>

      {/*
        ⚠ WHAT THESE NUMBERS ARE, STATED PLAINLY. They are the ACCOUNT's spend, which is very nearly the
        platform's but not identical, this account holds one unrelated stack, and the shared account's
        artifact buckets are not counted. Precision claimed is precision owed.
      */}
      <div className="rounded-lg border border-hairline bg-surface-1 p-3 text-xs text-ink-subtle">
        <p>
          <span className="font-semibold text-ink-muted">Scope:</span> everything in this AWS account. That is
          almost entirely this platform, but not exactly: one unrelated stack shares the account, and the
          shared build account&apos;s artifact storage is not included.
        </p>
        {data.taggedTotal === null ? (
          <p className="mt-2">
            <span className="font-semibold text-ink-muted">Tag breakdown:</span> not available yet. Cost
            Explorer has no data for the <code>ApplicationName</code> tag, because a cost allocation tag has to
            be activated in the management account; a linked account cannot do it. Once activated it applies
            only to usage <em>after</em> that point, so it will not fill in the past.
          </p>
        ) : (
          <p className="mt-2">
            <span className="font-semibold text-ink-muted">Tagged as this platform:</span>{" "}
            {money(data.taggedTotal, c)} of {money(data.monthToDate, c)} month to date.
          </p>
        )}
        {data.asOf && (
          <p className="mt-2">
            <span className="font-semibold text-ink-muted">As of:</span>{" "}
            {formatMessageInstant(data.asOf)}. Cached for up to six hours, because each cost query is billed.
          </p>
        )}
      </div>

      {top.length > 0 && (
        <div className="rounded-lg border bg-surface-3 p-4">
          <h3 className="text-sm font-semibold text-ink">Where it goes, month to date</h3>
          <ul className="mt-3 space-y-2">
            {top.map((line) => (
              <li key={line.label} className="text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-ink-muted">{line.label}</span>
                  {/* ⚠ `tabular-nums`. This is a ranked column of currency figures, and with
                      proportional digits "$1,204.10" over "$98.44" does not align on the decimal,
                      so the eye cannot compare the magnitudes it is here to compare. The bar
                      below carries the ranking visually; the figures have to carry it exactly. */}
                  <span className="shrink-0 font-medium text-ink tabular-nums">
                    {money(line.amount, c)}
                  </span>
                </div>
                {/*
                  A bar, sized against the LARGEST line rather than the total: at this spend most services
                  round to a rail of pixels against the total, and the point is the ranking.
                  aria-hidden, the figure beside it is the accessible version.
                */}
                <div aria-hidden="true" className="mt-1 h-1 rounded bg-surface-2">
                  <div
                    className="h-1 rounded bg-brand"
                    style={{ width: `${largest > 0 ? Math.max(2, (line.amount / largest) * 100) : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
