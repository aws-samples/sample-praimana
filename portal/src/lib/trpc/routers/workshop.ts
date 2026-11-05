import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ASSISTANT_IDS, canCreateWorkshops } from "@praimana/shared";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import { workshopSetupConfigSchema } from "@/lib/workshop-setup-schema";
import { auditLog } from "@/lib/audit-logger";
import { withActiveMembers } from "@/lib/team-members";
import type {
  FormatListResponse,
  PhaseListResponse,
  TeamListResponse,
  WorkshopListResponse,
  WorkshopResponse,
} from "@/lib/backend-types";

// Assistant set is defined once in @praimana/shared; validate against it
// so the API and the UI toggles can never drift (D6).
const enabledAssistantsSchema = z.array(z.enum(ASSISTANT_IDS)).optional();

/**
 * A workshop's start / end date.
 *
 * REQUIRED: an experience is an event, and one with no dates cannot be
 * scheduled, communicated or reported on. The workshop service has accepted and stored
 * `startsAt`/`endsAt` since it was written (routes.ts, create takes them, and the update
 * allowlist includes them); the only thing missing was this layer and the forms, so no
 * backend change was needed to start requiring them.
 *
 * `datetime()` with an OFFSET ALLOWED, not a bare date: a workshop that starts "on the
 * 4th" starts at a moment, and a facilitator in Sydney scheduling for a team in Seattle
 * needs that to be unambiguous. The <input type="datetime-local"> in the form is
 * converted to a real ISO instant before it reaches here.
 */
const workshopDateSchema = z
  .string()
  .datetime({ offset: true, message: "Must be an ISO 8601 date-time" });

/**
 * `endsAt` must not precede `startsAt`. Applied as a refinement on the whole object
 * rather than per field, because the rule is a RELATIONSHIP, a single field cannot know
 * it is wrong. EQUAL is allowed: a zero-length experience is odd but not incoherent, and
 * refusing it would be this layer inventing a policy nobody stated.
 */
function refineDateOrder<T extends { startsAt?: string; endsAt?: string }>(
  value: T,
  ctx: z.RefinementCtx
) {
  if (!value.startsAt || !value.endsAt) return;
  if (new Date(value.endsAt).getTime() < new Date(value.startsAt).getTime()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: "The end date must be on or after the start date",
    });
  }
}

/**
 * Phase-list bounds, matching `create`'s 100/1000 ceilings on the same two strings so the two
 * writers of a cohort's phases cannot disagree about what is legal. See `setPhases`.
 */
const MAX_PHASE_NAME_CHARS = 100;
const MAX_PHASE_DESCRIPTION_CHARS = 1000;
const MAX_PHASES = 50;
/** A fortnight in minutes, longer than any workshop this platform runs. */
const MAX_PHASE_MINUTES = 14 * 24 * 60;

export const workshopRouter = router({
  // The create form's Format dropdown options.
  //
  // Goes through tRPC like every other call rather than the browser fetching the
  // backend directly. The page previously did `fetch(NEXT_PUBLIC_BACKEND_URL +
  // "/v1/lookup/formats")`, which could never work in a deployed browser: that env
  // var is set nowhere, so it fell back to http://localhost:4000, and the failure was
  // swallowed into an empty list, a silently blank <select> rather than an error.
  // Routing it here also means the caller's token is attached server-side; the
  // backend route calls requireIdentity and would 401 an anonymous browser fetch.
  //
  // Not role-gated beyond protectedProcedure, matching the backend: these are
  // reference options, identical for every caller, disclosing nothing about any
  // workshop or user. Every role that can reach the create form needs them.
  formats: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch<FormatListResponse>("/v1/lookup/formats", { token: ctx.token });
    // Shape is pinned here so a backend that answers a bare list, or omits the key,
    // cannot put `undefined` into the component's `.map()`.
    const formats: unknown = data?.formats;
    return Array.isArray(formats)
      ? (formats as { name: string; value: string }[]).filter(
          (f) => typeof f?.value === "string" && typeof f?.name === "string"
        )
      : [];
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    // One aggregated call, the backend folds in team counts (D1), replacing an
    // extra /teams round-trip per workshop. Fall back to a 0 count if a given
    // row lacks _count (e.g. an older backend that ignores withCounts).
    const data = await backendFetch<WorkshopListResponse>("/v1/workshops?withCounts=1", { token: ctx.token });
    const workshops = data.workshops || [];

    // Surface only real data. Don't fabricate phases/facilitators the list view
    // never renders, ownership is derived from ownerId (D2).
    return workshops.map((w) => ({
      ...w,
      // PRESERVED as undefined when the backend could not establish it. `?? 0` here is
      // what turned "unknown" into a confident "0 teams" on the experiences list for
      // workshops that plainly had teams, the count lives in the Team service, and a
      // brownout or an unprivileged caller must render as "-", not as empty.
      _count: { teams: w._count?.teams },
    }));
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      // Fetch the workshop, its teams (with members folded in via withMembers -
      // one call instead of a /members request per team, the D1 N+1), and its
      // phases concurrently.
      const encodedId = encodeURIComponent(input.id);
      const [data, teamsData, phasesData] = await Promise.all([
        backendFetch<WorkshopResponse>(`/v1/workshops/${encodedId}`, { token: ctx.token }),
        backendFetch<TeamListResponse>(`/v1/workshops/${encodedId}/teams?withMembers=1`, { token: ctx.token }),
        backendFetch<PhaseListResponse>(`/v1/workshops/${encodedId}/phases`, { token: ctx.token }),
      ]);

      const workshop = data.workshop;
      /**
       * A RESPONSE WITH NO `workshop` KEY IS A FAULT, AND IT NOW SAYS SO. The next line reads
       * `workshop.currentPhaseOrder`, which threw a bare `TypeError: Cannot read properties of
       * undefined` on such a response, a 500 whose message named neither the workshop nor the
       * call that failed. Same outcome (a plain `Error` is an INTERNAL_SERVER_ERROR to tRPC, just
       * as the TypeError was), same house idiom as `team.getById`'s "Team not found", and the
       * message now identifies which read came back empty. NOT a TRPCError NOT_FOUND: the service
       * answers 404 itself for a workshop that does not exist, and `backendFetch` already maps
       * that, reaching here means a 2xx that did not carry the body it promised.
       */
      if (!workshop) throw new Error(`Workshop ${input.id} was not in the backend response`);
      const teams = teamsData.teams || [];
      const phases = phasesData.phases || [];

      return {
        ...workshop,
        currentPhaseOrder: workshop.currentPhaseOrder || 0,
        phases,
        /**
         * ⚠ REMOVED PEOPLE ARE EXCLUDED HERE, AND THEIR ABSENCE WAS A REPORTED FINDING.
         *
         * This is the FOURTH consumer of the `?withMembers=1` fold. The other three
         * (`team.getById`, `team.listMembers`, and the desktop `team-data` route) all exclude
         * `status === "INACTIVE"` rows, because the roster route returns them deliberately so a
         * Reactivate action can exist. This one applied no filter, so the experience detail page
         *, the screen staff use to review a running experience, counted and rendered removed
         * participants as current members: the avatar strip and the "n / maxTeamSize members"
         * seat line, the workshop-wide total, and the People tab, which carries each person's
         * email. Occupancy read as full when it was not, and a removed person's PII stayed on a
         * staff surface after their access was withdrawn. No attacker action was needed, any
         * removal produced the divergence.
         *
         * `withActiveMembers` also RECOMPUTES `_count.members` rather than preferring the
         * service's. The service counts INACTIVE rows too, so the old
         * `t._count?.members ?? (t.members || []).length` reported the unfiltered total whenever
         * the service supplied one, filtering the array alone would have left the seat line
         * wrong. Still normalises a bare team, which is what the old comment here was for: an
         * older backend that ignored `withMembers` answers with no `members` key.
         */
        teams: teams.map(withActiveMembers),
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().min(1).max(1000),
        format: z.string(),
        // Required on create, see workshopDateSchema.
        startsAt: workshopDateSchema,
        endsAt: workshopDateSchema,
        maxTeamSize: z.number().min(2).max(10).default(6),
        minTeamSize: z.number().min(2).max(6).default(3),
        enabledAssistants: enabledAssistantsSchema,
        setupConfig: workshopSetupConfigSchema.optional(),
      }).superRefine(refineDateOrder)
    )
    .mutation(async ({ ctx, input }) => {
      // Only ADMIN/FACILITATOR may create workshops (EXECUTIVE is read-only,
      // JUDGE only evaluates). Single source of truth in @praimana/shared.
      //
      // DEFENCE IN DEPTH, NOT THE BOUNDARY, this comment used to claim otherwise
      // ("enforce server-side, not just in the UI"), and that reading was how the gap
      // below it survived. This is a BFF: /v1/workshops is mapped `Method: ANY` behind
      // an authorizer with no AuthorizationScopes, and the browser holds its own ID
      // token, so a caller can reach the Workshop service without passing through here.
      // The real gate is canCreateWorkshops in the workshop service's `routes.ts`.
      // Kept here because it turns a would-be 403 from two hops away into an immediate,
      // specific message.
      if (!canCreateWorkshops(ctx.user.role)) {
        auditLog({
          event: "authz.workshop.create.denied",
          actor: { id: ctx.user.id, role: ctx.user.role },
          outcome: "denied",
          reason: `Role "${ctx.user.role}" is not permitted to create workshops`,
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins and facilitators can create experiences.",
        });
      }
      const data = await backendFetch<WorkshopResponse>("/v1/workshops", {
        method: "POST",
        body: JSON.stringify(input),
        token: ctx.token,
      });
      /**
       * ⚠ THE CREATE FORM USES `workshop.id` TWICE, it posts the phases against it and then
       * navigates to `/experiences/${"${workshop.id}"}`. A 2xx with no workshop therefore wrote the
       * phases to `/v1/workshops/undefined/phases` before landing on a dead page, so the failure
       * was both invisible AND a write. Surfaced as an error instead.
       */
      if (!data.workshop) throw new Error("The experience was created but the backend did not return it");

      auditLog({
        event: "workshop.created",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: data.workshop.id },
        outcome: "success",
        metadata: { name: input.name, format: input.format },
      });

      return data.workshop;
    }),

  updateStatus: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum([
          "DRAFT",
          "REGISTRATION",
          "ACTIVE",
          "JUDGING",
          "COMPLETED",
          "ARCHIVED",
        ]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/workshops/${encodeURIComponent(input.id)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: input.status }),
        token: ctx.token,
      });

      auditLog({
        event: "workshop.status.updated",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.id },
        outcome: "success",
        metadata: { newStatus: input.status },
      });

      return data;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(1000).optional(),
        // OPTIONAL IN THE SCHEMA, REQUIRED IN THE FORM, and the distinction is
        // deliberate, not a softening of the rule that both dates are required.
        //
        // `update` is a PARTIAL PATCH used by two independent save paths on the settings
        // page: the details form (name/description/dates) and the developer-setup form
        // (setupConfig/enabledAssistants). Making dates mandatory HERE would mean saving
        // an assistant toggle required re-sending the dates, so a field the user was not
        // editing becomes a precondition for an unrelated save, and the service's own
        // update is an allowlisted patch precisely so that is not necessary.
        //
        // Requiredness therefore lives where the user actually is: the details form
        // refuses to submit without both dates. The ORDERING rule below still applies to
        // whatever this patch does carry.
        startsAt: workshopDateSchema.optional(),
        endsAt: workshopDateSchema.optional(),
        enabledAssistants: enabledAssistantsSchema,
        setupConfig: workshopSetupConfigSchema.optional(),
        /**
         * ⚠ THESE THREE WERE MISSING, AND THE SYMPTOM WAS A FIELD YOU COULD NOT EDIT.
         *
         * The Workshop service's PATCH allowlist has ALWAYS accepted `format`, `maxTeamSize` and
         * `minTeamSize` (`the workshop service's `routes.ts``). This BFF schema did not, so zod
         * STRIPPED them before the request was built, the save succeeded, reported success, and
         * silently changed nothing. Reported as "not showing the format field in the settings page
         * to update": the form had nowhere to put it because the mutation would have discarded it.
         *
         * ⚠ A DROPPED FIELD IS WORSE THAN A REJECTED ONE. A 400 would have named the problem; zod's
         * default strip mode made it look like the platform simply ignored the edit.
         *
         * Bounds mirror `create` exactly, so the two paths cannot disagree about what is legal -
         * and `maxTeamSize` is re-validated by the service against the platform ceiling,
         * which is the boundary that counts.
         */
        format: z.string().min(1).optional(),
        maxTeamSize: z.number().min(2).max(10).optional(),
        minTeamSize: z.number().min(2).max(6).optional(),
      }).superRefine(refineDateOrder)
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...body } = input;
      const data = await backendFetch(`/v1/workshops/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        token: ctx.token,
      });

      auditLog({
        event: "workshop.updated",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: id },
        outcome: "success",
        /**
         * ⚠ THE FIELD NAMES, NOT THE VALUES. This is a partial patch, so which fields a save
         * touched is the reviewable fact, and it is what distinguishes an assistant toggle from
         * a rename or a team-size change. The values themselves are cohort configuration rather
         * than anything sensitive, but logging them would put free-text name and description into
         * the audit trail for no analytical gain.
         */
        metadata: { fields: Object.keys(body).sort() },
      });

      return data;
    }),

  setPhases: protectedProcedure
    /**
     * ── ⚠ THE BOUNDS MIRROR `create`, WHICH IS WHERE THEY CAME FROM ────────────────────────────
     *
     * This input had `name: z.string().min(1)` with no `.max()`, `description` with no `.max()`, and
     * an array with `.min(1)` and no `.max()`, while `create` above caps the same two strings at
     * 100/1000 characters. One writer of a cohort's phase list bounded and the other not is not a
     * policy, it is an omission, and this is the door a PARTICIPANT can also reach
     * (`/api/trpc` is in PARTICIPANT_PATHS).
     *
     * `MAX_PHASES` is a ceiling on the pipeline, not a target: the create form seeds four and the
     * densest real agenda is a working day split into hour blocks. Fifty is far beyond that and far
     * below a payload.
     */
    .input(
      z.object({
        workshopId: z.string(),
        phases: z
          .array(
            z.object({
              name: z.string().min(1).max(MAX_PHASE_NAME_CHARS),
              description: z.string().max(MAX_PHASE_DESCRIPTION_CHARS).optional(),
              /**
               * Bounded at both ends: a negative duration would render as a phase that ends before
               * it starts, and the upper bound is a fortnight in minutes, longer than any workshop
               * this platform runs.
               */
              durationMinutes: z.number().int().min(0).max(MAX_PHASE_MINUTES).optional(),
            })
          )
          .min(1)
          .max(MAX_PHASES),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/workshops/${encodeURIComponent(input.workshopId)}/phases`, {
        method: "PUT",
        body: JSON.stringify({ phases: input.phases }),
        token: ctx.token,
      });

      /**
       * ⚠ THE INCONSISTENCY WAS INSIDE THIS ONE FILE. `create` (:above) and `updateStatus` are
       * both audited; the two phase writers were not, yet a PUT here replaces the agenda every
       * team in the cohort is working to. The count and names are recorded rather than the whole
       * array: durations and descriptions are content, the shape of the schedule is the fact.
       */
      auditLog({
        event: "workshop.phases.updated",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.workshopId },
        outcome: "success",
        metadata: { phaseCount: input.phases.length, names: input.phases.map((p) => p.name) },
      });

      return data;
    }),

  setCurrentPhase: protectedProcedure
    .input(
      z.object({
        workshopId: z.string(),
        currentPhaseOrder: z.number().min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/workshops/${encodeURIComponent(input.workshopId)}/current-phase`, {
        method: "PATCH",
        body: JSON.stringify({ currentPhaseOrder: input.currentPhaseOrder }),
        token: ctx.token,
      });

      /**
       * Advancing the phase changes what every team in the cohort can see and do, including,
       * at the boundaries, whether they can still submit. Audited for the same reason
       * `updateStatus` is.
       */
      auditLog({
        event: "workshop.current_phase.updated",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.workshopId },
        outcome: "success",
        metadata: { currentPhaseOrder: input.currentPhaseOrder },
      });

      return data;
    }),
});
