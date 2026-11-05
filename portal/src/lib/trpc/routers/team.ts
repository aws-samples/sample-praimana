import { z } from "zod";
import { AUDIT_REASON_MAX } from "@praimana/shared";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import { auditLog } from "@/lib/audit-logger";
import { withInviters } from "./admin";
import { phasesWithStatus } from "@/lib/phase-status";
import { isActiveMember } from "@/lib/team-members";
import type {
  InvitationListResponse,
  PhaseListResponse,
  TeamListResponse,
  TeamMemberListResponse,
  TeamResponse,
  WorkshopResponse,
} from "@/lib/backend-types";

/**
 * How many rows one TEAMS DIRECTORY page holds by default.
 *
 * The same 50 the Administration users directory uses (DEFAULT_PAGE_SIZE in ./admin) and the
 * same default the team service clamps to. Three copies of one number is one too many, but the
 * alternative, importing across two sibling routers for a page size, couples them for no
 * gain; the service is the one that enforces it, and a mismatch here only changes what this
 * layer ASKS for.
 */
const DEFAULT_DIRECTORY_PAGE_SIZE = 50;

export const teamRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        workshopId: z.string(),
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch<TeamResponse>(`/v1/workshops/${encodeURIComponent(input.workshopId)}/teams`, {
        method: "POST",
        body: JSON.stringify({ name: input.name, description: input.description }),
        token: ctx.token,
      });
      /**
       * ⚠ THE CALLER NAVIGATES TO `team.id`, so a 2xx that carries no team must not reach it.
       * `experiences/[id]/page.tsx` does `router.push(\`/w/${"${workshopId}"}/t/${"${team.id}"}\`)` in
       * `onSuccess`, an absent team sent the facilitator to a URL ending `/t/undefined`, which
       * renders as a broken team page rather than as the failed creation it was. Declaring the
       * response type is what made that reachable path visible; a plain `Error` surfaces it as the
       * failure it is, and the mutation's own error branch already knows how to show one.
       */
      if (!data.team) throw new Error("The team was created but the backend did not return it");

      /**
       * ⚠ AFTER the guard above, so a "created" event never records a team the caller never got.
       * The other four lifecycle transitions, join, removeMember, reactivateMember,
       * revokeInvitation, were audited already; this one was the gap.
       */
      auditLog({
        event: "team.created",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { teamId: data.team.id, workshopId: input.workshopId },
        outcome: "success",
      });

      return data.team;
    }),

  getById: protectedProcedure
    .input(z.object({ teamId: z.string(), workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [teamsData, workshopData, membersData, phasesData] = await Promise.all([
        backendFetch<TeamListResponse>(`/v1/workshops/${encodeURIComponent(input.workshopId)}/teams`, { token: ctx.token }),
        backendFetch<WorkshopResponse>(`/v1/workshops/${encodeURIComponent(input.workshopId)}`, { token: ctx.token }),
        backendFetch<TeamMemberListResponse>(`/v1/teams/${encodeURIComponent(input.teamId)}/members`, { token: ctx.token }),
        /**
         * ── THE PHASE DEFINITIONS, FOR THE STEPPER AND THE INSIGHTS COUNT ─────────────────────
         *
         * ⚠ A FOURTH CALL IN THE EXISTING `Promise.all`, WHICH COSTS NO LATENCY. It runs beside
         * the three that were already here rather than adding a round trip, and it is added HERE
         * rather than as a query in each consumer because both consumers of this procedure need
         * it: the workspace layout (mounted on every workspace page) and the insights page. Two
         * separate queries would be two extra requests where the fan-out already exists, the
         * same D1 aggregation reasoning as `?withMembers=1` and `?withCounts=1` elsewhere.
         *
         * ⚠ A FAILURE HERE MUST NOT TAKE OUT THE ROSTER. The phases are decoration on this
         * payload, the layout's stepper and one insights tile, while the members list decides
         * whether the workspace tabs exist at all. So this one call absorbs its own failure and
         * yields an empty pipeline, exactly as `ai.getThreads` does for the roster it enriches
         * with. Without the catch, an unreadable phase list would blank a team's whole workspace.
         */
        backendFetch<PhaseListResponse>(`/v1/workshops/${encodeURIComponent(input.workshopId)}/phases`, {
          token: ctx.token,
        }).catch(() => ({ phases: [] })),
      ]);

      const team = (teamsData.teams || []).find((t) => t.id === input.teamId);
      if (!team) throw new Error("Team not found");

      const workshop = workshopData.workshop;
      /**
       * THE LIVE ROSTER, ACTIVE members only. Removed people are the former-members
       * list's job, and `team.listFormerMembers` is where they belong.
       *
       * ── WHY THE FILTER IS HERE AND NOT IN THE SERVICE ──
       *
       * `GET /v1/teams/:teamId/members` returns INACTIVE rows DELIBERATELY, it is the
       * only caller of the repository's `IncludingInactive` variant, so that a roster can
       * offer a Reactivate action on a row an audit entry alone could not support. That is
       * the right service contract and it is not changing.
       *
       * What was wrong is that this mapper passed those rows straight through, so a
       * removed person rendered in the Members list AND in Former members, the same
       * person shown as both current and former, which says the relationship both ended
       * and did not. Reported live: Participant Three, removed and correctly INACTIVE in
       * the table, appeared in both sections of the team page.
       *
       * Filtered at THIS layer because all four consumers of this shape want the same
       * thing and none of them wants a removed member: the team page's Members list, the
       * workspace layout's `isMember` derivation (which decides which tabs exist, a
       * removed person must not read as a member), the insights page's metrics, and the
       * desktop `team-data` route. Fixing it in the page would leave the other three.
       *
       * ── THE POLARITY IS FORCED, NOT PREFERRED ──
       *
       * Excluded on the DENY value rather than required to equal "ACTIVE". Every row
       * written before `status` existed carries NO attribute, and absent means ACTIVE
       * (domain.ts's `isInactiveMembership` states the same rule for the same reason), so
       * `m.status === "ACTIVE"` would empty every legacy team's roster, which on this
       * screen also means `isMember` goes false and the workspace tabs vanish for
       * everyone. Compared case-insensitively for the same reason the service does: the
       * constant is copied across bundles and a casing difference must not be what decides
       * whether a removed person still appears.
       */
      const members = (membersData.members || [])
        .filter(isActiveMember)
        .map((m) => ({
          ...m,
          id: m.userId,
          user: m.user || { id: m.userId, name: "Unknown" },
        }));

      return {
        ...team,
        workshop: { name: workshop?.name || "Experience" },
        members,
        /**
         * ── ⚠ WAS `teamPhases: []`, HARDCODED, AND TWO SCREENS READ IT AS REAL DATA ──────────
         *
         * Nothing here ever fetched phases. The workspace layout's stepper and phase badge sit
         * behind `length > 0` so they silently never rendered; the insights page was not so
         * lucky and reported `phasesCompleted: 0` of `0 total`, a statement of fact, on a page
         * executives read, that the team had completed nothing.
         *
         * ⚠ AND THE NAME WAS THE MISCONCEPTION. There is no such thing as a per-team phase
         * status: progression is workshop-wide and facilitator-controlled, so the status is a
         * COMPARISON against the workshop's `currentPhaseOrder` (see `lib/phase-status.ts`, and
         * `shared/constants/phase-progress.ts` for the long form). The old name implied per-team
         * state that neither this BFF nor the workshop service has ever held, its `TeamPhase`
         * carries content, an editor and a timestamp, and deliberately no status. Renamed to
         * `phases` so the field says what it is: the workshop's phases, each with its derived
         * status.
         *
         * ⚠ THE DERIVATION IS SHARED WITH THE DESKTOP, WHICH ALREADY DID THIS CORRECTLY. Kept in
         * one tested module rather than inlined, so the two front-ends cannot come to disagree
         * about whether a team has finished a phase.
         */
        phases: phasesWithStatus(
          (phasesData.phases ?? []).map((p) => ({
            id: p.id,
            order: p.order,
            name: p.name,
          })),
          workshop?.currentPhaseOrder || 0
        ),
      };
    }),

  join: protectedProcedure
    .input(z.object({ inviteCode: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch<TeamResponse>("/v1/teams/join", {
        method: "POST",
        body: JSON.stringify({ inviteCode: input.inviteCode }),
        token: ctx.token,
      });
      // Same navigation hazard as `create` above, the join page pushes to `team.id`.
      if (!data.team) throw new Error("The join succeeded but the backend did not return the team");

      /**
       * ⚠ AUDITED BECAUSE ITS DESKTOP TWIN IS. A membership row is the gate on all team content, so
       * "who joined this team, and when" is an attribution question, and closing that gap on
       * `/api/desktop/join-team` while leaving this door silent would mean the same act is recorded
       * or not depending on which client performed it, which is worse than a uniform absence.
       *
       * Unlike the desktop route, the actor here IS established: `protectedProcedure` has a
       * verified session, so no `actorVerified` caveat is needed. The invite code is NOT logged -
       * it is a live credential until spent (see `audit-logger.ts`).
       */
      auditLog({
        event: "team.joined",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { teamId: data.team.id, workshopId: data.team.workshopId },
        outcome: "success",
      });

      return data.team;
    }),

  /**
   * The team's ACTIVE roster. No consumer today, and it is filtered anyway.
   *
   * The service route deliberately returns INACTIVE rows (see `getById` above), so an
   * unfiltered pass-through here is a trap for the next caller: they would get removed
   * people in something named `listMembers` and have no reason to suspect it. The same
   * exclusion, for the same forced polarity, absent status means ACTIVE, so legacy rows
   * must not be dropped.
   *
   * A caller that genuinely wants removals has `listFormerMembers`, which is gated,
   * bounded and applies the actor-name suppression this shape does not.
   */
  listMembers: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch<TeamMemberListResponse>(
        `/v1/teams/${encodeURIComponent(input.teamId)}/members`,
        { token: ctx.token }
      );
      return (data.members || []).filter(isActiveMember);
    }),

  // Every team the caller belongs to, across all workshops. Used by the admin
  // landing to route non-owners (e.g. EXECUTIVE) straight to their own team,
  // since the workshops list only shows workshops the caller owns.
  listMine: protectedProcedure.query(async ({ ctx }) => {
    try {
      const data = await backendFetch<TeamListResponse>("/v1/teams/mine", { token: ctx.token });
      return data.teams || [];
    } catch {
      return [];
    }
  }),

  getMyTeam: protectedProcedure
    .input(z.object({ workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      /**
       * ── ⚠ ONE CALL, WHERE THIS USED TO BE 1 + N ──────────────────────────────────────────
       *
       * It listed the workshop's teams and then asked each one's roster in a SEQUENTIAL loop
       * until it found the caller. A workshop with N teams cost N round trips, each carrying the
       * 20s backend deadline, and a caller who belongs to nothing walked the whole list, an
       * unbounded fan-out on a page-render path, sized by somebody else's workshop.
       *
       * ⚠ A CAP WAS THE OBVIOUS FIX AND IT IS THE WRONG ONE. Slicing the list to the first 50
       * teams makes a member of team 51 be told they are on NO team, which routes them away from
       * the workspace they belong to. That is a correctness bug traded for a latency one, and it
       * would present as "the app forgot my team".
       *
       * `GET /v1/teams/mine` answers the same question in a single call, bounded by the CALLER'S
       * OWN membership count, a person is on one or two teams, whatever the workshop's size. The
       * rows it returns are full team records, so `workshopId` is already on them.
       *
       * ⚠ AND IT KEEPS THE ACTIVE-ONLY SEMANTICS THE LOOP HAD, which is the one thing that could
       * have gone wrong silently. The removed comment warned that counting an INACTIVE row "would
       * route a removed participant straight back to the team they were removed from". The
       * service's `listByUser`, which is what `/teams/mine` uses, is documented and implemented
       * as ACTIVE ONLY (`rows.filter((m) => !isInactiveMembership(m.status))`), and its interface
       * note names `/teams/mine` as the reason. So the guarantee moved from this loop into the
       * service rather than being dropped.
       */
      try {
        const mine = await backendFetch<TeamListResponse>("/v1/teams/mine", {
          token: ctx.token,
        });
        return (mine.teams || []).find((t) => t.workshopId === input.workshopId) ?? null;
      } catch {
        return null;
      }
    }),

  // The caller's OWN invitations, each carrying the team name + JOIN CODE. Backs
  // the post-registration welcome page: registration does not auto-join a team,
  // so a fresh participant has no membership and listMine would be empty, the
  // code has to come from the invitation. The backend keys this on the verified
  // token's email, so there is no input to tamper with (nothing is passed here).
  listMyInvitations: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch("/v1/invitations/mine", { token: ctx.token });
    return (data.invitations || []) as {
      teamId: string;
      teamName: string;
      workshopId: string;
      /**
       * NULL ONCE THE INVITATION IS SPENT, and that is a deliberate suppression rather
       * than missing data.
       *
       * An invite code is a live credential: anyone holding it plus an invitation row can
       * join the team. The service stopped returning it for a spent row after a removed
       * member was found still able to read the code from this very payload and rejoin
       * themselves with it, the row survived the removal, so the code kept working.
       *
       * `codeAvailable` exists so the UI branches on a boolean instead of probing for
       * null, which is the shape that quietly renders the string "null" into a code box.
       */
      inviteCode: string | null;
      codeAvailable: boolean;
      platformRole: string;
      teamRole: string | null;
      status: string;
      joined: boolean;
    }[];
  }),

  /**
   * Mark the caller's own invitation(s) ACCEPTED, called once per completed sign-in.
   *
   * WHY THE CLIENT DRIVES THIS. Nothing on the admin-provisioned path ever marked an
   * invitation accepted: the old self-signup flow did it as part of registration, and
   * with the account created by an admin that moment no longer exists, so a facilitator
   * who had finished the whole journey still showed as "Pending". The first moment the
   * PERSON demonstrably acted is their first sign-in, and the only code that knows a
   * sign-in just completed is the browser flow (see AuthFlow.establishAppSession).
   *
   * DELIBERATELY THIN, and deliberately not gated here. There is no input: the backend
   * keys entirely on the verified token's email claim, so this can only ever reach the
   * caller's OWN rows and there is nothing for a role check to protect. Adding one would
   * be a second copy of a rule the service already owns.
   *
   * IDEMPOTENT AND NON-FATAL, which is what makes it safe to call on every sign-in: the
   * service's write is conditional on the row not already being ACCEPTED (so
   * `acceptedAt` never moves), and it answers 200 with a failure COUNT rather than an
   * error status. The caller must still not let a rejection block the sign-in, see the
   * call site.
   */
  acceptMyInvitations: protectedProcedure.mutation(async ({ ctx }) => {
    const data = await backendFetch("/v1/invitations/mine/accept", {
      method: "POST",
      token: ctx.token,
    });
    return data as { accepted: number; alreadyAccepted: number; failed: number };
  }),

  listInvitations: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch<InvitationListResponse>(`/v1/teams/${encodeURIComponent(input.teamId)}/invitations`, { token: ctx.token });
      // A NARROW projection on purpose: the service returns the whole row (`InvitationRecord`,
      // which includes the `invitedBy` SUB), and this is the list a browser sees. Only what a
      // list renders crosses over.
      // Explicitly typed because without the annotation the row shape collapses to the helper's
      // `{ email: string }` constraint and every other field disappears from the client's
      // inferred type. That was true when `data.invitations` was `any` and it is still true now
      // that it is declared, the constraint, not the source, is what erases the fields.
      interface InvitationRow {
        email: string;
        status: string;
        sentAt: string;
        expiresAt?: string;
        platformRole: string;
        teamRole?: string;
      }
      const rows: InvitationRow[] = (data.invitations || []).map((inv) => ({
        email: inv.email,
        status: inv.status === "ACCEPTED" ? "Accepted" : "Pending",
        sentAt: inv.sentAt || "",
        // The link's 24h window IS enforced (the pre-signup trigger refuses a lapsed
        // row), so a still-"Pending" invitation may already be dead. Carried through
        // so a list can say that instead of leaving someone waiting on a link that
        // will never work. Absent on rows minted before expiry existed.
        expiresAt: inv.expiresAt || undefined,
        platformRole: inv.platformRole || "PARTICIPANT",
        teamRole: inv.teamRole || undefined,
      }));

      // WHO invited each address, resolved through the SAME helper the Users tab uses.
      // The invitation row carries `invitedBy` as a bare Cognito SUB, which must never
      // reach a browser, a 36-character UUID is worse than showing nothing. The
      // helper does the sub->name hop and honours USER_VISIBILITY_GRANTS, so a
      // FACILITATOR still cannot learn about an ADMIN account through this field.
      //
      // Failure is absorbed by the helper (it returns the rows unchanged), so a
      // provenance lookup can never take out the invitations list itself.
      //
      // THE ROLE IS PASSED so the helper can SKIP the two hops for a caller that cannot
      // reach the user directory. Both hops are directory-gated (ADMIN + FACILITATOR):
      // an EXECUTIVE gets 403 from each deployed Lambda. Without
      // this the helper threw on every executive render and its catch swallowed it, so
      // "who invited" was silently missing. The gate stays, so the honest behaviour is
      // to not ask.
      return withInviters(rows, ctx.token, ctx.user.role);
    }),

  // Withdraw a pending invitation. Deliberately thin: every gate (may this role
  // grant/un-grant, may they see this team, is the row still PENDING) lives in the
  // Team service, which is the only copy that cannot be bypassed. Adding a role
  // check here would be a second copy to drift, and the UI already hides the
  // control, so this passes the caller's token through and lets the backend rule.
  // The email goes in the PATH, so it must be encoded: a raw `+` in an address
  // would otherwise decode server-side as a space and miss the row.
  revokeInvitation: protectedProcedure
    .input(z.object({ teamId: z.string(), email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/invitations/${encodeURIComponent(input.email)}`,
        { method: "DELETE", token: ctx.token }
      );

      /**
       * ⚠ THIS DESTROYS A LIVE CREDENTIAL AND RECORDED NOTHING. A pending invitation is a usable
       * join token until it is revoked or expires, so revocation is exactly the kind of act the
       * neighbouring `removeMember`/`reactivateMember` emits exist for, those two were audited
       * and this one, one resolver away, was not.
       *
       * The email IS the target here and is recorded as such: it identifies which credential was
       * destroyed, and it is the same field the member events already carry.
       */
      auditLog({
        event: "team.invitation.revoked",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { teamId: input.teamId, email: input.email },
        outcome: "success",
      });

      return { revoked: true, email: input.email };
    }),

  /**
   * Remove someone from a team's roster.
   *
   * DELIBERATELY THIN, like revokeInvitation above and for the same reason: the gate is
   * `requireTeamWrite` in the Team service, which also 403s a read-only EXECUTIVE, and
   * that is the copy that cannot be bypassed. Every service route is mapped ANY behind a
   * JWT authorizer that does no role scoping, and the browser holds its own token, so a
   * check added here would be advisory rather than a boundary. The UI hides the control;
   * this forwards the caller's token and lets the backend rule.
   *
   * THE REMOVAL IS A HARD DELETE (a deliberate choice) and the membership row is the only
   * trace the person was ever on the team, so the service writes a MEMBER_REMOVED audit
   * entry carrying the actor, their role at the time, and the team's name. `audited` is
   * how the caller learns that entry did NOT get written: the row is already gone by
   * then, so the service reports rather than throws, see the route's comment on why
   * failing a completed removal would be worse. A false is worth surfacing, because it
   * means an access change happened with nothing recording who made it.
   *
   * `reason` is optional operator free-text, trimmed and capped at AUDIT_REASON_MAX.
   * The CONSTANT rather than a literal 200: two numbers for one rule is how a form starts
   * accepting text the audit row silently truncates. Capped here as a courtesy to the
   * form; the service applies the real cap, since this layer is not a boundary.
   *
   * NOT IDEMPOTENT-BY-RETURN, and worth knowing at the call site: the backend deletes
   * unconditionally, so removing somebody who is already gone answers 200 rather than
   * 404. A second click is therefore harmless but produces a second audit entry, which
   * is correct, since each request IS an action somebody took.
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        userId: z.string(),
        reason: z.string().trim().max(AUDIT_REASON_MAX).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The ids go in the PATH and are encoded for the same reason the email above is:
      // a value carrying a slash or a percent would otherwise change which route the
      // gateway matched, and a 404 from a mis-built path is indistinguishable from
      // "no such member".
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/members/${encodeURIComponent(
          input.userId
        )}`,
        {
          method: "DELETE",
          // Sent as a body on a DELETE because the reason is free text and has no
          // business in a URL, it would land in gateway access logs and browser
          // history. The service reads it off the body.
          body: JSON.stringify({ reason: input.reason }),
          token: ctx.token,
        }
      );

      auditLog({
        event: "team.member.removed",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { userId: input.userId, teamId: input.teamId },
        outcome: "success",
        metadata: { reason: input.reason, serviceAudited: data.audited === true },
      });

      return {
        removed: true,
        /**
         * False means the removal HAPPENED and is UNRECORDED. Surfaced rather than
         * swallowed so the UI can say so, this is the one signal that an access change
         * went into the system with no record of who made it.
         *
         * Defaulted to false, not true, when the field is absent: an older service
         * version that does not send it has not told us the entry was written, and
         * assuming success is how a missing audit trail goes unnoticed.
         */
        audited: data.audited === true,
      };
    }),

  /**
   * REACTIVATE a removed member, restore the membership the removal deactivated.
   *
   * DELIBERATELY THIN, like removeMember above and for the same reason: the gate is
   * `requireTeamWrite` in the Team service, byte-for-byte the guard on the DELETE this
   * reverses, so an ADMIN or a FACILITATOR who owns the workshop, and never a read-only
   * EXECUTIVE, and that is the copy that cannot be bypassed. Every service route is mapped
   * ANY behind a JWT authorizer that does no role scoping, and the browser holds its own
   * token, so a check added here would be advisory rather than a boundary. See the note on
   * `admin.setUserAccess` for why a fourth copy of a role matrix in a BFF is worse than none.
   *
   * The service ALSO refuses a subject whose role may not hold team membership at all
   * (requirement (b)), and answers 404 for a person with no membership row rather than
   * creating one, re-admitting a never-member is an INVITATION. Both are propagated, not
   * absorbed: rendering "Restored" over a request the service refused is the worst outcome
   * for this control.
   *
   * IDEMPOTENT BY INTENT. An already-active member answers 200 with `reactivated: true` and
   * NO second audit entry, because the caller's intent ("this person should have access")
   * already holds. `audited` is what distinguishes a real flip from that no-op, see below.
   *
   * `reason` is optional operator free-text, trimmed and capped at AUDIT_REASON_MAX, the
   * same courtesy-cap as removeMember and setUserAccess. Sent in the BODY, never the URL:
   * it is free text that may name a person, and a query string lands in gateway access logs
   * and browser history.
   */
  reactivateMember: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        userId: z.string(),
        reason: z.string().trim().max(AUDIT_REASON_MAX).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The ids go in the PATH and are encoded for the same reason removeMember's are: a
      // value carrying a slash or a percent would otherwise change which route the gateway
      // matched, and a 404 from a mis-built path is indistinguishable from "no such member".
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/members/${encodeURIComponent(
          input.userId
        )}/reactivate`,
        {
          method: "POST",
          body: JSON.stringify({ reason: input.reason }),
          token: ctx.token,
        }
      );

      auditLog({
        event: "team.member.reactivated",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { userId: input.userId, teamId: input.teamId },
        outcome: "success",
        metadata: { reason: input.reason, serviceAudited: data.audited === true },
      });

      return {
        /**
         * ALWAYS TRUE on a 200, the frozen contract's shape, mirroring the service's own
         * field. It reports the caller's INTENT having been achieved rather than whether
         * this particular call did the work; a refusal arrives as a thrown BackendError,
         * never as `reactivated: false`.
         */
        reactivated: true as const,
        /**
         * THE PRESERVED TEAM ROLE, read off the surviving membership row, a reactivated
         * LEAD comes back a LEAD. Defaulted to "" rather than invented when a service
         * version does not send it: a screen printing "restored as undefined" is worse
         * than one printing nothing, and the caller can branch on the empty string.
         */
        role: typeof data.role === "string" ? data.role : "",
        /**
         * False means the restoration HAPPENED and is UNRECORDED. Surfaced rather than
         * swallowed so the UI can say so, this is the one signal that access was GRANTED
         * with no record of who granted it, which is the direction that adds privilege.
         *
         * ALSO false on an idempotent no-op (the member was already active), where it
         * correctly means "no entry was needed". The two are not distinguishable from this
         * layer, and the service is deliberate about that: it writes one entry per real
         * flip. Defaulted to false, not true, when the field is absent, an older service
         * version that does not send it has not told us the entry was written, and assuming
         * success is how a missing audit trail goes unnoticed.
         */
        audited: data.audited === true,
      };
    }),

  /**
   * FORMER MEMBERS of a team, people who were on the roster and were removed.
   *
   * DELIBERATELY THIN. The gate is `requireTeamRead` in the Team service (the
   * ADMINISTRATION predicate: a member of this team, staff who owns its
   * workshop, or an ADMIN), and the visibility suppression on `removedByName` is applied
   * there too, from the actor's role AT THE TIME as the audit entry stored it. Neither is
   * re-decided here.
   *
   * THE NULLS ARE SUPPRESSIONS AND UNKNOWNS, NOT MISSING DATA, and every one of them must
   * reach the screen as null. Coercing any to "" would render a blank cell that reads as a
   * data problem, the same failure the `InvitedByNote` precedent exists to avoid, where a
   * hidden inviter is reported as `hidden: true` so the UI can say "Not shown". See each
   * field below for which kind of null it is.
   */
  listFormerMembers: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/former-members`,
        { token: ctx.token }
      );

      /**
       * One removed person, their MOST RECENT removal. Explicitly typed because
       * `data.formerMembers` is `any`, without this the row shape collapses and every
       * nullable field silently becomes `any`, which is precisely where a `?? ""` would
       * slip in unnoticed.
       */
      interface FormerMemberRow {
        userId: string;
        /**
         * NULL MEANS UNKNOWN, not hidden: the local users read-model has no row for them
         * yet (or never had one). The removal is the fact; the name is decoration on it,
         * and the service keeps the row rather than dropping a removal it cannot name.
         */
        name: string | null;
        /** Null for the same reason as `name`, unknown, not suppressed. */
        email: string | null;
        removedAt: string;
        /**
         * ⚠ NULL MEANS "NOT SHOWN TO YOU", a deliberate VISIBILITY SUPPRESSION, and the
         * one field on this row that is. A FACILITATOR reading a removal an ADMIN performed
         * gets null, because knowing WHICH accounts hold full platform access is itself the
         * reconnaissance step (the same matrix identity's /admin/user-names honours, where
         * it reports `hidden: true`).
         *
         * It can ALSO be null when the actor's read-model row is gone (a staff account
         * deleted since), which is an unknown rather than a suppression. The two are not
         * distinguishable from here, `removedByRole` is always present, so a UI can render
         * "Removed by a Facilitator" either way and must render "Not shown" rather than a
         * blank.
         */
        removedByName: string | null;
        /** The actor's role AT THE TIME. Disclosed even when the NAME is not. */
        removedByRole: string;
        /** Null when the operator wrote no note. Absent, not empty. */
        reason: string | null;
        /**
         * WHEN THEY JOINED, and NULL for removals that predate the denormalisation.
         *
         * The audit table is append-only so there is no backfill, and the invitation's
         * `acceptedAt` is deliberately NOT substituted (one invitation carries one
         * acceptedAt while a person can be removed and re-added several times, so
         * attributing it to a particular removal would be a guess rendered as a fact). A
         * client MUST render null as "join date unknown" and NEVER as "never joined", the
         * entry itself proves they were a member.
         */
        joinedAt: string | null;
      }

      return {
        // Passed through UNMAPPED, deliberately: any per-field normalisation here is a
        // chance to turn one of the documented nulls into an empty string. The service
        // already normalises what it means to; this layer only pins the type.
        formerMembers: (data.formerMembers ?? []) as FormerMemberRow[],
        /**
         * True when the service's bound (MAX_FORMER_MEMBERS) was hit, so the list is
         * SHORT rather than complete. Surfaced so a screen can say "showing the first N"
         *, a quietly-truncated removal history reads as "nobody else was removed", the
         * one wrong answer worth guarding against on an audit-derived view. The full
         * per-person history is at GET /audit/users/:userId.
         *
         * Defaulted to FALSE only for a service version that does not send it; a strict
         * `=== true` so a stringy value cannot read as truncated either way.
         */
        truncated: data.truncated === true,
      };
    }),

  /**
   * THE TEAMS DIRECTORY, every team the caller may enumerate, paginated and searched
   * SERVER-SIDE.
   *
   * Deliberately the same input shape as `admin.listUsers`, down to the debounce-friendly
   * optional `search`: it is the same screen with a different noun, so a component built
   * against one pages and searches the other with no new idiom.
   *
   * ⚠ THE SEARCH MUST NOT BECOME A CLIENT-SIDE FILTER. `search` is forwarded to the service,
   * which applies it in the STORE. Filtering the loaded page in the browser instead finds
   * nobody past page 1, fine for skimming, wrong precisely when the reason you are searching
   * is to act on something specific, because the operator concludes the team does not exist.
   * The reason is written down at the store
   * (the team service's `repository.dynamo.ts`, `listDirectory`) and in identity's
   * equivalent; this layer's job is to pass the needle through rather than to re-implement it.
   *
   * DELIBERATELY NO ROLE CHECK, like every other procedure in this file and in `admin`. The
   * gate is `canReadDirectory` (ADMIN + FACILITATOR) plus the per-role workshop SCOPE in the
   * Team service, a FACILITATOR sees only teams in workshops they OWN, and that is the copy
   * that cannot be bypassed: every service route is mapped ANY behind a JWT authorizer with no
   * role scoping, and the browser holds its own token. A copy here would be advisory and would
   * silently go stale.
   *
   * A 503 (`DIRECTORY_SCOPE_UNAVAILABLE`) PROPAGATES rather than being absorbed into an empty
   * list. The service answers it when a FACILITATOR's owned-workshop scope could not be
   * determined, and an empty directory is indistinguishable from a correct one, swallowing it
   * would render a plausible, wrong, empty page with no error anywhere.
   */
  listDirectory: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          /**
           * Opaque, pass back exactly as received. It encodes the store's pagination key and
           * this layer deliberately knows nothing about its shape.
           */
          cursor: z.string().optional(),
          /**
           * Substring match on the TEAM NAME, applied SERVER-SIDE. Trimmed and length-capped
           * here so a pathological needle cannot be pushed into a store filter, the same cap
           * `admin.listUsers` applies, and the service truncates to the same number.
           *
           * Workshop name is deliberately NOT searchable: it is the Workshop context's data
           * and the teams table stores only `workshopId`, so matching on it would need either
           * a denormalised copy or a post-filter that breaks pagination. Each row still
           * CARRIES the workshop name for display.
           */
          search: z.string().trim().max(100).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const params = new URLSearchParams();
      params.set("limit", String(input?.limit ?? DEFAULT_DIRECTORY_PAGE_SIZE));
      if (input?.cursor) params.set("cursor", input.cursor);
      // Only when non-empty: an empty `search=` would be a filter that matches everything,
      // which is the same as no filter but costs a store expression to say so.
      if (input?.search) params.set("search", input.search);

      const data = await backendFetch(`/v1/teams/directory?${params}`, {
        token: ctx.token,
      });

      /**
       * One row of the teams directory. Explicitly typed because `data.teams` is `any` -
       * without this the row shape collapses and the two nullable fields silently become
       * `any`, which is where a `?? 0` would slip in unnoticed.
       */
      interface DirectoryTeamRow {
        id: string;
        name: string;
        workshopId: string;
        /**
         * NULL MEANS THE NAME COULD NOT BE RESOLVED, not "no workshop". Workshops are another
         * service's data, and the lookup is best-effort by design so it can never fail the
         * directory an operator opened during an incident. `workshopId` is always present, so
         * a UI can fall back to it rather than rendering a blank.
         */
        workshopName: string | null;
        /**
         * ACTIVE members only, a removed person is not counted, because the service counts
         * with the repository read that omits deactivated rows.
         *
         * NULL MEANS THE COUNT COULD NOT BE READ, and it is deliberately not 0: "we could not
         * count" and "nobody is on this team" are different facts, and 0 is a number an
         * operator would act on. Render null as "-", never as zero.
         */
        memberCount: number | null;
        createdAt: string;
      }

      return {
        // Passed through UNMAPPED: any per-field normalisation here is a chance to turn one of
        // the two documented nulls into a number or an empty string.
        teams: (data.teams ?? []) as DirectoryTeamRow[],
        /** Opaque, absent on the last page. Pass back unmodified to page forward. */
        nextCursor: data.nextCursor as string | undefined,
        /**
         * ⚠ THE CALLER'S WORKSHOP SCOPE WAS CAPPED, so this directory is INCOMPLETE, and
         * incomplete in a way PAGING CANNOT FIX.
         *
         * The service caps a FACILITATOR's owned-workshop scope: DynamoDB's `IN` takes at most
         * 100 operands and caps the expression at 4KB, so an uncapped scope was a permanent HTTP
         * 500 for the platform's most senior users. Above the cap the caller gets a directory
         * that omits WHOLE WORKSHOPS, not a short page, but teams that no page and no needle on
         * this screen can reach, because the capped scope is what EVERY query on it runs against.
         *
         * Which is why this is surfaced rather than logged. It is a strictly worse version of the
         * failure the server-side `search` exists to prevent (see the ⚠ at the top of this
         * procedure): the operator types a team name, gets nothing, and concludes the team does
         * not exist. Nothing else in the response distinguishes "no such team" from "outside the
         * 50 workshops we were able to ask about", and a full page of rows beside a live
         * `nextCursor` actively reads as "keep paging, it is in here somewhere".
         *
         * Defaulted to FALSE when the field is absent, not true: an older service version that
         * does not send it has not told us anything WAS truncated, and a notice raised on silence
         * is a notice an operator learns to ignore, which costs us the one render where it
         * matters. A strict `=== true` so a stringy value cannot read as truncated either way -
         * the same reading `listFormerMembers`'s `truncated` and `removeMember`'s `audited` take.
         */
        scopeTruncated: data.scopeTruncated === true,
      };
    }),
});
