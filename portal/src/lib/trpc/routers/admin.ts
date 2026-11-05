import { z } from "zod";
import {
  canManageUsers,
  AUDIT_REASON_MAX,
  type UserStatus,
} from "@praimana/shared";
import { router, protectedProcedure } from "../trpc";
import { backendFetch, BackendError } from "@/lib/backend";
import { auditLog } from "@/lib/audit-logger";

/**
 * Platform administration, user management.
 *
 * Unlike the `auth` router, whose procedures are scoped to the caller by
 * construction, everything here reads (and will write) OTHER people's accounts. The
 * authorization for that lives in the identity service, which gates the whole
 * /v1/admin surface on canManageUsers and re-checks each target individually.
 *
 * Deliberately no role check in this file. It would be a THIRD copy of the rule -
 * after the shared matrix and the service's gate, and the copy in a BFF is the one
 * that silently goes stale, because nothing fails when it disagrees: it just quietly
 * allows or forbids the wrong thing. The middleware hides the screen and the service
 * refuses the request; this layer only forwards the caller's token.
 *
 * What this layer DOES do is COMPOSE, which is the one thing no single service can:
 * the users table is Identity's, team membership and invitations are Team's, and the
 * directory needs all three. See listUsers below.
 */

/** How many rows one directory page holds by default. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Cap on ids/emails sent to a service in one enrichment call.
 *
 * Matches MAX_HYDRATE_IDS in the identity service and MAX_CONTEXT_KEYS in the team
 * service. A filter resolving to more members than this is truncated HERE, with a flag
 * on the response, rather than 400'd downstream, see the truncation note in listUsers.
 */
const MAX_ENRICH_KEYS = 100;

/**
 * Hard ceiling on the parallel fan-out in `filterScopes`.
 *
 * One `backendFetch` per workshop resolves its teams, so without a cap the request's cost is set
 * by how many experiences the caller owns rather than by the request. 25 is generous for the
 * intended use and caps the worst case at a predictable ceiling.
 *
 * ⚠ TRUNCATION IS REPORTED (`truncated` on the response), because a filter menu quietly missing an
 * experience is indistinguishable from that experience not existing. Same convention as
 * MAX_THREADS (ai.ts) and MAX_EXPERIENCE_LOOKUPS (feedback.ts), and the same reporting rule as the
 * teams directory's `scopeTruncated`.
 */
const MAX_FILTER_SCOPE_WORKSHOPS = 25;

/** One row of the Administration users table. Mirrors the service's AdminUser. */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  organization?: string;
  createdAt: string;
  /**
   * False when no Cognito account stands behind this profile row (the
   * post-confirmation trigger's `sub || ulid()` fallback). Such a row cannot be
   * acted on, so the UI marks it rather than offering controls that must fail.
   */
  hasAccount: boolean;
  /** True when the row IS the caller, every write path refuses a self-action. */
  isSelf: boolean;
  /**
   * Platform access, so a row can render an "Access disabled" badge.
   *
   * ALWAYS PRESENT in practice, because the identity service normalises it on this
   * projection: the STORED attribute is absent on every row written before the field
   * existed, and a client left to interpret `undefined` gets it wrong once and then
   * badges every pre-existing account as disabled. Use isUserDeactivated() from
   * @praimana/shared rather than comparing to a literal, so there is one predicate
   * and not two.
   *
   * Optional on THIS interface for one reason only: a portal deployed ahead of the
   * identity service would receive rows without the field, and a required property would
   * make TypeScript lie about that. Absent means ACTIVE.
   *
   * ⚠ A DISPLAY MIRROR. Cognito's own disabled flag is what actually stops a sign-in;
   * this drives the badge and nothing else. Never branch an authorization decision on it
   *, the full reasoning is on the UserStatus type in `shared/types/user.ts`.
   */
  status?: UserStatus;
  /**
   * WHO INVITED this person, folded in from the Team context. Absent when there is no
   * invitation row for their email at all (the bootstrap admin, or a row cleaned up
   * after acceptance), which is why this is optional rather than a nullable field with
   * a placeholder.
   */
  invitedBy?: InvitedBy;
}

/** The "Invited by" cell's data, assembled from both services. */
export interface InvitedBy {
  /** The inviter's display name, absent when their account no longer exists. */
  name?: string;
  /**
   * True when the caller may NOT see the inviter (a FACILITATOR looking at someone an
   * ADMIN invited). Distinct from an absent name: the UI says "Not shown" rather than
   * leaving a blank that reads as missing data.
   */
  hidden?: boolean;
  /**
   * ACCEPTED, the invitation this person actually redeemed, authoritative.
   * EARLIEST_INVITE, no redeemed row, so this is the first person who invited them:
   * a reasonable inference, and one an administrator deciding whether to revoke
   * someone's access deserves to know is an inference.
   */
  basis: "ACCEPTED" | "EARLIEST_INVITE";
  /** PLATFORM for a role-only invitation, TEAM for one into a specific team. */
  scope: "PLATFORM" | "TEAM";
  sentAt?: string;
}

/** Split a service's `{ id: value }` map lookup without tripping on a missing key. */
type NameEntry = { name?: string; hidden?: boolean };

export const adminRouter = router({
  /**
   * The user directory, one page at a time, optionally filtered to a team or
   * workshop, and enriched with who invited each person.
   *
   * THREE calls at most, and the shape of them is forced by which context owns what:
   *
   *   1. WHEN FILTERING, ask Team for the member ids (only Team knows team rosters),
   *      then ask Identity to hydrate exactly those ids. Sequential, because the
   *      second call's input is the first's output.
   *   2. WHEN NOT FILTERING, ask Identity for a page directly.
   *   3. THEN, in parallel, ask Team who invited this page's people (by email, the only
   *      key an invitation row has) and Identity for those inviters' names.
   *
   * The visibility rule, a FACILITATOR must not see ADMIN accounts, is enforced in
   * the identity service on BOTH the paged and the ?ids= path, and again on the inviter
   * names. Not here: a filter in a BFF is one a future caller bypasses, and this layer
   * would need its own copy of the matrix to apply it.
   *
   * ENRICHMENT FAILURE DEGRADES, IT DOES NOT PROPAGATE. The "Invited by" column is
   * supplementary; the page's job is to list users so their access can be changed. A
   * team service blip must not make the Administration screen unreachable during the
   * very incident an administrator opened it to handle.
   */
  listUsers: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          /**
           * Opaque, pass back exactly as received. It encodes the store's pagination
           * key and this layer deliberately knows nothing about its shape.
           */
          cursor: z.string().optional(),
          /** Restrict to one team's members. */
          teamId: z.string().optional(),
          /** Restrict to everyone on any team in one workshop. */
          workshopId: z.string().optional(),
          /**
           * Substring match on name and email, applied SERVER-SIDE.
           *
           * The screen also filters the loaded page in the browser, which finds nobody
           * beyond page 1, fine for skimming, wrong when the reason you are searching is
           * to act on a specific person. Trimmed and length-capped here so a pathological
           * needle cannot be pushed into a store filter.
           */
          search: z.string().trim().max(100).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      // teamId wins when both arrive: it is the narrower answer, and the UI's own
      // flow is workshop → team, so a request carrying both means the team was picked
      // last. Resolved here rather than passed on, because the team service refuses a
      // request carrying both, correctly, since it cannot know which was meant.
      const filter: Record<string, string> | null = input?.teamId
        ? { teamId: input.teamId }
        : input?.workshopId
          ? { workshopId: input.workshopId }
          : null;

      let users: AdminUser[] = [];
      let nextCursor: string | undefined;
      let truncated = false;

      if (filter) {
        const scope = new URLSearchParams(filter).toString();
        const ids: string[] =
          (await backendFetch(`/v1/directory/user-ids?${scope}`, { token: ctx.token }))
            .userIds ?? [];

        if (ids.length === 0) {
          // An empty filter result means "nobody matched" and must NOT fall through to
          // an unfiltered listing, the mistake that turns an empty team into the whole
          // directory.
          return { users: [], nextCursor: undefined, truncated: false };
        }

        // Truncated rather than refused, and REPORTED. A filtered view is a convenience
        // over a list that is already reachable unfiltered, so failing the whole page at
        // 101 members would be the worse answer, but silently showing 100 of 140 would
        // let an administrator conclude someone is not on the team when they are.
        const page = ids.slice(0, MAX_ENRICH_KEYS);
        truncated = ids.length > page.length;

        const data = await backendFetch(
          `/v1/admin/users?ids=${page.map(encodeURIComponent).join(",")}`,
          { token: ctx.token }
        );
        users = (data.users ?? []) as AdminUser[];
      } else {
        const params = new URLSearchParams();
        params.set("limit", String(input?.limit ?? DEFAULT_PAGE_SIZE));
        if (input?.cursor) params.set("cursor", input.cursor);
        // Only on the UNFILTERED branch. The team/workshop-filtered branch resolves member
        // ids first and hydrates them by id, so a search there would have to be applied to
        // that id set, a different operation, and one this screen does not offer (the
        // filter already narrows to a handful).
        if (input?.search) params.set("search", input.search);

        const data = await backendFetch(`/v1/admin/users?${params}`, {
          token: ctx.token,
        });
        users = (data.users ?? []) as AdminUser[];
        nextCursor = data.nextCursor as string | undefined;
      }

      return {
        users: await withInviters(users, ctx.token),
        nextCursor,
        truncated,
      };
    }),

  /**
   * The teams available as directory filters, grouped by workshop.
   *
   * Reads the workshop list the caller can already see and folds in each workshop's
   * teams, so the filter offers exactly the scopes they can act within. Kept out of
   * listUsers because it changes on a different cadence, the filter options are stable
   * across pagination, and re-fetching them per page would be a round-trip per click.
   */
  /**
   * DISABLE or RE-ENABLE a person's platform access.
   *
   * ⚠ THE AUTHORIZATION FOR THIS IS NOT HERE, AND MUST NOT BE. It lives in the
   * user-access service, which enforces all three gates: the USER_ADMIN_GRANTS matrix
   * against the target's CURRENT role (read from Cognito groups, never from this
   * request), the refusal of a self-action, and the refusal to disable the last enabled
   * ADMIN.
   *
   * A check added here would be a FOURTH copy of the matrix, after the shared table,
   * the service's local copy, and the middleware that hides the screen, and the copy in
   * a BFF is the one that silently goes stale, because nothing fails when it disagrees:
   * it just quietly allows or forbids the wrong thing. Worse, it would be advisory
   * rather than a boundary. A security review today confirmed two live vulnerabilities
   * caused by exactly that assumption: every service route is mapped ANY behind a JWT
   * authorizer that does NO role scoping, and the browser holds its own ID token, so the
   * BFF is not on the only path to the service. This layer forwards the caller's token
   * and lets the service rule; see the file header.
   *
   * ── WHAT THE SERVICE DOES BESIDES THE COGNITO CALL ──
   * On DISABLE it also REVOKES the person's live invitations, and the count comes back as
   * `invitationsRevoked`. That is not a convenience: an unredeemed invitation is a live
   * credential, and leaving one would let a disabled person re-register through the
   * invite-only gate and receive a BRAND-NEW Cognito sub, at which point every record
   * keyed on the old sub, the disable included, no longer applies to them. Re-enabling
   * deliberately does NOT restore them (re-admission is a fresh invitation), so a
   * successful enable always reports 0.
   *
   * ── WHAT THE CALLER MUST SURFACE ──
   * A 200 does not mean everything worked. `audited: false` means the change happened
   * with NO RECORD of who made it, and the mutation returns the flag rather than
   * swallowing it so the screen can say so. The access change itself is real either way -
   * the service never lets bookkeeping fail an operation Cognito has already applied.
   *
   * ── IDEMPOTENT ──
   * Disabling an already-disabled account answers 200, not 409, so a double-click or a
   * retry converges rather than erroring. Callers need no optimistic-concurrency dance.
   */
  setUserAccess: protectedProcedure
    .input(
      z.object({
        /** The target's Cognito sub, the `id` on an AdminUser row. */
        userId: z.string(),
        /** TRUE re-enables, FALSE disables. No default: the two are not interchangeable. */
        enabled: z.boolean(),
        /**
         * Optional operator note, recorded on the audit entry.
         *
         * Capped at the SAME constant the audit row is capped at, so a reason that passes
         * this schema always fits the entry. Imported rather than typed as a literal 200
         *, two numbers for one rule is how a form starts accepting text the row silently
         * truncates. This is a courtesy to the form; the service applies the real cap,
         * because this layer is not a boundary.
         */
        reason: z.string().trim().max(AUDIT_REASON_MAX).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch("/v1/user-access/access", {
        method: "POST",
        body: JSON.stringify({
          userId: input.userId,
          enabled: input.enabled,
          reason: input.reason,
        }),
        token: ctx.token,
      });

      const result = {
        // Echoed from the INPUT, not the response, so the caller can correlate the result
        // with the row it clicked even if a future service version reshapes its body.
        userId: input.userId,
        enabled: input.enabled,
        /**
         * How many live invitations were destroyed. Always 0 on an enable.
         *
         * Coerced with a NUMBER GUARD rather than `?? 0`: a service that answered a
         * string or null would otherwise render as "undefined invitations revoked", and
         * the count is a fact an operator withdrawing access reads carefully.
         */
        invitationsRevoked:
          typeof data.invitationsRevoked === "number" ? data.invitationsRevoked : 0,
        /**
         * FALSE means at least one live invitation SURVIVED the disable, i.e. an
         * unredeemed credential still admits a registration, which is the one outcome
         * revoking exists to prevent. The person can re-register, receive a brand-new
         * Cognito sub, and step out from under the disable entirely.
         *
         * Forwarded rather than folded into `invitationsRevoked`, because a count cannot
         * express it: "3 revoked" reads identically whether the fourth failed or there
         * was no fourth. The operator withdrawing access is precisely the person who has
         * to know the withdrawal was partial, so the screen renders this as a distinct
         * partial-success state rather than a clean confirmation.
         *
         * Defaults to FALSE when absent, matching `audited` and for the same reason: an
         * older service version that does not send the field has not told us the
         * revocation completed, and assuming it did is how a surviving credential goes
         * unnoticed.
         */
        invitationsRevokeComplete: data.invitationsRevokeComplete === true,
        /**
         * False means the change HAPPENED and is UNRECORDED, worth surfacing, and worth
         * an alarm. Defaulted to FALSE when absent, not true: an older service version
         * that does not send the field has not told us the entry was written, and
         * assuming success is how a missing audit trail goes unnoticed.
         */
        audited: data.audited === true,
      };

      // ── AUDIT: Log the access change at the BFF layer. ──
      auditLog({
        event: input.enabled ? "account.access.enabled" : "account.access.disabled",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { userId: input.userId },
        outcome: "success",
        metadata: {
          reason: input.reason,
          serviceAudited: result.audited,
          invitationsRevoked: result.invitationsRevoked,
          invitationsRevokeComplete: result.invitationsRevokeComplete,
        },
      });

      // ── ALARM: Log when the downstream service failed to write an audit entry. ──
      if (!result.audited) {
        auditLog({
          event: "account.access.audit_gap",
          actor: { id: ctx.user.id, role: ctx.user.role },
          target: { userId: input.userId },
          outcome: "failure",
          reason: "Downstream service reported audited=false, access change is unrecorded in the service audit trail",
          metadata: { enabled: input.enabled },
        });
      }

      return result;
    }),

  /**
   * The experiences an invitation may NAME, the Administration tab's judge picker.
   *
   * ⚠ NOT `filterScopes`, WHICH THIS FORM USED TO BORROW, and the split is the point. That
   * procedure answers "which scopes may I FILTER the user directory by" and is backed by
   * `GET /v1/workshops` (listByOwner) plus a teams fan-out per workshop. The picker asks a
   * different question, "which experiences may I invite INTO", and the two now
   * have different answers for an ADMIN: they may invite into any experience while still being
   * able to OPEN only their own. Borrowing the filter list meant an admin could not name another
   * owner's experience, which is exactly what the picker is for.
   *
   * ⚠ NO ROLE CHECK HERE, DELIBERATELY, and it is not an oversight, see this file's header. The
   * catalogue is tried FIRST and the owned list is the fallback, so the SERVICE decides which
   * answer the caller gets and this layer holds no copy of the rule to go stale. A BFF that
   * branched on `session.user.role` would be the third copy of the ADMIN rule, and the one where
   * a disagreement fails silently.
   *
   * ⚠ THE FALLBACK IS KEYED ON THE EXACT REFUSAL, never on "any error". `403` +
   * `CATALOGUE_ADMIN_ONLY` is the workshop service saying "you are not an admin, ask the other
   * question"; anything else, a 500, a 503, a timeout, a different 403, RETHROWS. Falling back
   * on any failure would turn a Workshop brownout into a silently narrower picker, which is the
   * "empty list that looks correct" defect this platform has shipped twice.
   */
  invitableExperiences: protectedProcedure.query(async ({ ctx }) => {
    try {
      const data = await backendFetch<{
        workshops?: { id: string; name: string }[];
        truncated?: boolean;
      }>("/v1/workshops/catalogue", { token: ctx.token });

      return {
        experiences: data.workshops ?? [],
        // Passed through rather than swallowed: a picker missing the experience an operator is
        // hunting for reads as "it does not exist". The form renders a notice.
        truncated: !!data.truncated,
        // Which question was answered, so the form can say "every experience" vs "yours" instead
        // of leaving an operator to guess why a name is absent.
        scope: "all" as const,
        catalogueUnavailable: false,
      };
    } catch (err) {
      /**
       * ⚠ TWO REFUSALS FALL BACK, AND THEY MEAN DIFFERENT THINGS, hence the flag.
       *
       *   403 + CATALOGUE_ADMIN_ONLY → "you are not an admin, ask the other question". The
       *     normal path for a FACILITATOR. Their owned list IS the right answer.
       *
       *   404 → THE ROUTE DOES NOT EXIST ON THIS BACKEND. `GET /v1/workshops/catalogue` is
       *     matched by the deployed gateway's `/v1/workshops/{workshopId}` mapping, so against a
       *     workshop service that predates the catalogue it reaches the by-id handler, which looks
       *     up a workshop literally named "catalogue" and 404s. ⚠ WITHOUT THIS BRANCH THE PICKER
       *     THROWS FOR EVERY STAFF ROLE during any window where the portal is deployed ahead of
       *     the services, including FACILITATORS, who are not part of this feature at all and
       *     could invite judges perfectly well before it. Degrading to the owned list is exactly
       *     their pre-change behaviour, and for an admin it is a narrower list rather than a dead
       *     form.
       *
       * ⚠ 404 IS ADMITTED AND 5xx IS NOT, WHICH IS THE WHOLE DISTINCTION. A 404 on a mapped route
       * is an unambiguous statement that this backend has no such handler; a 500, a 503 or a
       * timeout is "we could not tell", and answering that with a narrower list is the
       * defect this platform has shipped twice. A 403 with any OTHER code stays fatal too.
       *
       * ⚠ AND IT IS FLAGGED RATHER THAN SILENT. `catalogueUnavailable` lets the form say the list
       * is narrowed, so an admin hunting for someone else's experience is told why it is missing
       * instead of concluding it does not exist. A silent degrade here would be the same lie as a
       * silent truncation.
       */
      const notAnAdmin =
        err instanceof BackendError &&
        err.status === 403 &&
        err.code === "CATALOGUE_ADMIN_ONLY";
      const catalogueMissing = err instanceof BackendError && err.status === 404;

      if (notAnAdmin || catalogueMissing) {
        if (catalogueMissing) {
          console.warn(
            "[admin] /v1/workshops/catalogue is absent on this backend, the invite picker is " +
              "falling back to the caller's own experiences. Deploy the workshop service."
          );
        }
        const owned = await backendFetch<{ workshops?: { id: string; name: string }[] }>(
          "/v1/workshops",
          { token: ctx.token }
        );
        return {
          // Narrowed to the two fields the picker needs, so a facilitator's answer has the same
          // SHAPE as an admin's, the form cannot accidentally depend on the aggregate that
          // `GET /v1/workshops` also carries.
          experiences: (owned.workshops ?? []).map((w) => ({ id: w.id, name: w.name })),
          truncated: false,
          scope: "owned" as const,
          catalogueUnavailable: catalogueMissing,
        };
      }
      throw err;
    }
  }),

  filterScopes: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch("/v1/workshops", { token: ctx.token });
    const workshops = (data.workshops ?? []) as { id: string; name: string }[];

    /**
     * ⚠ ONE CALL PER WORKSHOP, NOW CAPPED, AND THE CAP IS REPORTED, NOT SILENT.
     *
     * The old comment bounded this by assumption: "the number of workshops an administrator owns
     * (single digits at hackathon scale)". That is a belief about the data, not a bound on the
     * request, an owner with 200 experiences fans out 200 parallel calls from one page render.
     *
     * ⚠ AND `.slice()` ALONE WOULD BE THE WRONG FIX, which is why `truncated` comes back with it.
     * A filter menu that silently omits experiences reads as "that experience does not exist" to
     * an operator looking straight at it, the same class of lie as an empty directory during a
     * brownout, and the reason the teams directory reports `scopeTruncated` rather than just
     * capping. The screen renders a notice off this flag.
     */
    const truncated = workshops.length > MAX_FILTER_SCOPE_WORKSHOPS;
    const scopes = await Promise.all(
      workshops.slice(0, MAX_FILTER_SCOPE_WORKSHOPS).map(async (w) => {
        try {
          const teamsData = await backendFetch(`/v1/workshops/${encodeURIComponent(w.id)}/teams`, {
            token: ctx.token,
          });
          const teams = (teamsData.teams ?? []) as { id: string; name: string }[];
          return {
            workshopId: w.id,
            workshopName: w.name,
            teams: teams.map((t) => ({ id: t.id, name: t.name })),
          };
        } catch {
          // A workshop whose teams can't be read still belongs in the list, it is a
          // valid filter on its own, and dropping it would silently shrink the menu.
          return { workshopId: w.id, workshopName: w.name, teams: [] };
        }
      })
    );

    return { scopes, truncated };
  }),
});

/**
 * Fold the "Invited by" column into a page of users.
 *
 * Two hops, and the second depends on the first: Team answers WHO invited each person
 * (as a bare sub, keyed on email, the only key an invitation row has), then Identity
 * turns those subs into names, applying the visibility rule as it goes. That second
 * step is not an optimisation to skip: the inviter is subject to the same rule as
 * anyone else, so a facilitator looking at a participant an admin invited must see
 * "Not shown" and not that admin's name.
 *
 * Returns the users UNCHANGED on any failure. The column is supplementary and the page
 * is not.
 */
/**
 * Generic over the row type on purpose. This resolves an EMAIL to "who invited that
 * address", which is the same question for a user row and for an invitation row, and
 * the resolution is not trivial: it is two backend hops (team's /directory/invited-by
 * for the inviter's SUB, then identity's /admin/user-names to turn that sub into a
 * name) and it honours USER_VISIBILITY_GRANTS, so a FACILITATOR cannot learn about an
 * ADMIN account through this field.
 *
 * Written once and shared rather than copied for the invitations tab: a second copy is
 * a second place for the visibility rule to be forgotten, and the sub-to-name hop is
 * exactly the part a copy would be tempted to skip, which would render a 36-character
 * UUID at an operator.
 */
export async function withInviters<T extends { email: string }>(
  users: T[],
  token?: string,
  /**
   * The caller's role. When supplied and the role cannot reach the user directory,
   * enrichment is SKIPPED rather than attempted.
   *
   * WHY THIS PARAMETER EXISTS. Both hops sit behind the directory gate
   * (canManageUsers → ADMIN + FACILITATOR): team's /directory/invited-by answers
   * "Forbidden: your role cannot browse the user directory" and identity's
   * /admin/user-names answers "Forbidden: your role cannot manage users". Both
   * deployed Lambdas answer an EXECUTIVE with 403.
   *
   * So for an executive on a team page this function ALWAYS threw, the catch below
   * swallowed it, and no provenance rendered: "who invited" was simply
   * missing. The directory gate STAYS as it is and the line is simply absent for those roles, so the correct
   * behaviour is to not ask, rather than to make two round trips per render that are
   * guaranteed to 403 and then be discarded.
   *
   * Optional so existing callers that are already directory-gated (the Users tab)
   * need not pass it.
   */
  role?: string | null
): Promise<(T & { invitedBy?: InvitedBy })[]> {
  if (users.length === 0) return users;

  // Deliberate, logged absence, not a swallowed failure. See the parameter note.
  if (role !== undefined && !canManageUsers(role)) {
    return users;
  }

  try {
    const emails = [...new Set(users.map((u) => u.email).filter(Boolean))].slice(
      0,
      MAX_ENRICH_KEYS
    );
    if (emails.length === 0) return users;

    const invitedByData = await backendFetch(
      `/v1/directory/invited-by?emails=${emails.map(encodeURIComponent).join(",")}`,
      { token }
    );
    const invitedBy = (invitedByData.invitedBy ?? {}) as Record<
      string,
      { inviterId: string; basis: InvitedBy["basis"]; scope: InvitedBy["scope"]; sentAt?: string }
    >;

    const inviterIds = [
      ...new Set(Object.values(invitedBy).map((v) => v.inviterId)),
    ].slice(0, MAX_ENRICH_KEYS);
    if (inviterIds.length === 0) return users;

    const namesData = await backendFetch(
      `/v1/admin/user-names?ids=${inviterIds.map(encodeURIComponent).join(",")}`,
      { token }
    );
    const names = (namesData.names ?? {}) as Record<string, NameEntry>;

    return users.map((u) => {
      const record = invitedBy[u.email];
      if (!record) return u;

      // A sub with no entry in `names` is an inviter whose account is gone. Left with
      // no name and not hidden, so the UI can distinguish "we can't tell you" from
      // "there is nobody to name".
      const resolved = names[record.inviterId];

      return {
        ...u,
        invitedBy: {
          name: resolved?.name,
          hidden: resolved?.hidden,
          basis: record.basis,
          scope: record.scope,
          sentAt: record.sentAt,
        },
      };
    });
  } catch (err) {
    // ABSORBED ON PURPOSE, a provenance line must never take out the list it
    // annotates, but NO LONGER SILENT. This was a bare `catch { return users; }`,
    // and when "Invited by …" did not appear the failure was indistinguishable from
    // "there is no inviter to show": two backend hops, either could have failed, and
    // nothing said which. That is the same silent-fallback pattern that made several
    // bugs this week take far longer to find than they should have.
    //
    // Logged with the row count only, never the addresses, which are PII, and never
    // the token.
    console.warn("[bff] inviter enrichment failed, rows returned without provenance", {
      rows: users.length,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return users;
  }
}
