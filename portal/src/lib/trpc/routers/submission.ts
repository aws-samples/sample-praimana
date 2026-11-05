import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { auditLog } from "@/lib/audit-logger";
import { backendFetch, BackendError } from "@/lib/backend";
import {
  SCORE_CRITERIA,
  SCORE_MIN,
  SCORE_MAX,
  MAX_SCORE_COMMENT_CHARS,
  isSafeHttpUrl,
} from "@praimana/shared";
import { SUBMISSION_BOUNDS } from "@/lib/submission-bounds";

/**
 * ── SUBMISSION, JUDGING AND PLACES, the BFF over the evaluation service ─────────────────
 *
 * ── ⚠ EVERY REFUSAL'S `code` IS PRESERVED, AND THAT IS THE WHOLE JOB OF THIS FILE ──
 *
 * The service refuses a release with `NO_ARTIFACTS`, `NO_DEMO_URL`, `ALREADY_RELEASED`,
 * `EXECUTIVE_ONLY` or `SNAPSHOT_SOURCE_UNAVAILABLE`, and a publish with five more. Those codes ARE
 * the user-facing behaviour: the Submit tab has to say WHICH precondition is failing, and a results
 * screen has to distinguish "nobody has scored that team" from "the judges scored unevenly".
 *
 * `BackendError` already carries `.code`, and `trpc.ts` maps it onto the TRPCError, so procedures
 * here must NOT catch-and-rethrow with a friendlier message. Doing that is how a screen ends up
 * string-matching prose. The one place a catch IS correct is a 404 that means a normal empty state
 * (`results.get` before publication), and it is commented where it happens.
 *
 * ⚠ NO CLIENT-SIDE AUTHORIZATION LIVES HERE. `protectedProcedure` proves a session; every rule
 * about WHO may release, reopen, score or publish is the service's, checked against the store. This
 * layer forwards the caller's token and nothing more.
 */

/** The submission as the evaluation service returns it. */
export type Submission = {
  teamId: string;
  id: string;
  workshopId: string | null;
  status: "DRAFT" | "SUBMITTED";
  title: string | null;
  summary: string | null;
  problemStatement: string | null;
  solution: string | null;
  demoUrl: string | null;
  videoUrl: string | null;
  repoUrl: string | null;
  slidesUrl: string | null;
  aiUsageSummary: string | null;
  submittedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  releasedById: string | null;
  releasedAt: string | null;
  reopenedById: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  snapshot: Snapshot | null;
};

export type Snapshot = {
  takenAt: string;
  teamName: string | null;
  phases: Array<{
    phaseId: string;
    order: number;
    name: string;
    content: string;
    aiGenerated: boolean;
    editedByName: string | null;
    editedAt: string | null;
  }>;
  artifacts: Array<{
    path: string;
    versionId: string | null;
    lastAuthorName: string | null;
    updatedAt: string;
  }>;
};

export type JudgeListRow = {
  submissionId: string;
  teamId: string;
  teamName: string | null;
  title: string | null;
  releasedAt: string | null;
  demoUrl: string | null;
  artifactCount: number;
  scoredByMe: boolean;
  myScoreTotal: number | null;
  maxScore: number;
};

export type Place = {
  place: number;
  teamId: string;
  submissionId: string;
  teamName: string | null;
  average: number;
  judgeCount: number;
};

export type WorkshopResults = {
  workshopId: string;
  publishedById: string;
  publishedAt: string;
  minScoresPerSubmission: number;
  places: Place[];
  tieBrokenById: string | null;
  tieBrokenAt: string | null;
};

/**
 * The owner's PREVIEW: either a ranking or the reason there cannot be one.
 *
 * ⚠ A DISCRIMINATED UNION, MIRRORING THE SERVICE, because the screen must not be able to render a
 * ranking that does not exist. `outcome` decides which fields are present, and TypeScript then
 * refuses a component that reads `places` on a refusal.
 */
export type ResultsPreview =
  | { published: false; outcome: "ok"; places: Place[]; tieBroken: boolean }
  | { published: false; outcome: "nothing-released" }
  | { published: false; outcome: "stale-scores"; stale: Array<{ submissionId: string; judgeId: string }> }
  | {
      published: false;
      outcome: "quorum-not-met";
      required: number;
      coverage: Array<{ submissionId: string; teamId: string; teamName: string | null; judgeCount: number }>;
    }
  | {
      published: false;
      outcome: "coverage-uneven";
      coverage: Array<{ submissionId: string; teamId: string; teamName: string | null; judgeCount: number }>;
    }
  | { published: false; outcome: "tie-unresolved"; ties: Array<{ place: number; submissionIds: string[] }> };

/**
 * The five criteria, validated HERE as well as in the service.
 *
 * ⚠ NOT A SECOND RULE, THE SAME ONE. The bounds come from `@praimana/shared`, which is where
 * the service reads them from too (`constants/scoring.ts`). This zod schema exists so a malformed
 * form submission fails fast with field-level errors instead of costing a round trip, NOT so the
 * client can be trusted: the service refuses the identical inputs and its refusal is the real one.
 */
const scoreShape = Object.fromEntries(
  SCORE_CRITERIA.map((criterion) => [
    criterion,
    z.number().int().min(SCORE_MIN).max(SCORE_MAX),
  ])
) as Record<(typeof SCORE_CRITERIA)[number], z.ZodNumber>;

/**
 * Anti-abuse ceiling for URL fields. Standard practical URL limit, well above any real link but
 * prevents multi-megabyte strings from being forwarded to the service.
 */
const MAX_URL_CHARS = 2048;

/** A ULID is 26 characters; this leaves room for any id format the services adopt later. */
const MAX_TEAM_ID_CHARS = 64;

/**
 * A tie can name at most every team in the workshop. `maxTeamSize` is capped at 10 and cohorts of
 * more than a few hundred participants are not what this platform runs, so 200 is a ceiling no real
 * publish approaches.
 */
const MAX_TIE_ORDER_TEAMS = 200;

/**
 * One of the four team-supplied deliverable URLs: bounded in length AND allowlisted by scheme.
 *
 * Written once rather than four times because the previous version repeated the same refinement
 * verbatim per field, which is how three of four end up updated. See the call site for why both
 * checks are needed and why `null` must keep passing.
 */
function submittedUrl() {
  return z
    .string()
    .max(MAX_URL_CHARS, `URL exceeds ${MAX_URL_CHARS} characters`)
    .nullable()
    .optional()
    .refine((v) => v === null || v === undefined || isSafeHttpUrl(v), {
      message: "URL must use http or https",
    });
}

export const submissionRouter = router({
  /**
   * The team's submission, creating the draft if it has none.
   *
   * ⚠ SAFE TO CALL ON EVERY PAGE LOAD, which is why it is shaped this way. The service's create is
   * IDEMPOTENT per team (one `TransactWriteItems` over a pointer row), returns 200 with the existing
   * record on a second call, and publishes `submission.created` only once. So "ensure a draft
   * exists" needs no coordination between the tab, a refresh and a second teammate doing the same.
   */
  ensure: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/submissions`,
        { method: "POST", body: JSON.stringify({}), token: ctx.token }
      );
      return data.submission as Submission;
    }),

  /** The team's submissions, excluding the internal pointer row (the service filters it). */
  list: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/submissions`,
        { token: ctx.token }
      );
      return (data.submissions || []) as Submission[];
    }),

  /**
   * Edit the draft's deliverable URLs and narrative.
   *
   * ⚠ THE FIELD LIST IS THE ALLOWLIST, and it deliberately excludes `status`, `snapshot` and
   * `workshopId`, the service ignores them anyway, and a schema that accepted them would suggest
   * they do something. `.nullable()` on each is how a team CLEARS a URL; omitted means "leave alone".
   */
  patch: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        submissionId: z.string(),
        fields: z.object({
          /**
           * ⚠ TWO INDEPENDENT BOUNDS ON THE SAME FOUR FIELDS, AND BOTH ARE THE REPORT'S ASK.
           *
           * `isSafeHttpUrl` is the SCHEME allowlist, the fix for the stored-scheme-injection
           * finding, so a `javascript:` URL a participant stores can never become an href on the
           * page a judge reads. `.max(MAX_URL_CHARS)` is the LENGTH bound, which the same finding
           * asked for separately ("plus a `.max()` length bound") and which does a different job:
           * it stops an unbounded string being written to the store and re-rendered forever.
           * Neither implies the other, a 100KB `https://` URL passes the allowlist.
           *
           * ⚠ `null` AND `undefined` STILL PASS, WHICH IS NOT A GAP. The submit form sends `null`
           * for an emptied box (documented there: "an empty box is sent as null, not as ''"), so a
           * refinement that rejected it would make every link permanently unclearable.
           *
           * The narrative fields reuse SUBMISSION_BOUNDS, the same ceilings the form counts
           * against, so the client counter and the server refusal cannot disagree.
           */
          title: z.string().max(SUBMISSION_BOUNDS.title.maxChars).nullable().optional(),
          summary: z.string().max(SUBMISSION_BOUNDS.summary.maxChars).nullable().optional(),
          problemStatement: z
            .string()
            .max(SUBMISSION_BOUNDS.problemStatement.maxChars)
            .nullable()
            .optional(),
          solution: z.string().max(SUBMISSION_BOUNDS.solution.maxChars).nullable().optional(),
          demoUrl: submittedUrl(),
          videoUrl: submittedUrl(),
          repoUrl: submittedUrl(),
          slidesUrl: submittedUrl(),
          aiUsageSummary: z
            .string()
            .max(SUBMISSION_BOUNDS.solution.maxChars)
            .nullable()
            .optional(),
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/submissions/${encodeURIComponent(input.submissionId)}`,
        { method: "PATCH", body: JSON.stringify(input.fields), token: ctx.token }
      );

      /**
       * ⚠ THE FIELD NAMES ARE RECORDED, THE VALUES ARE NOT. Which fields a caller rewrote is the
       * investigative fact ("who edited this team's deliverable, and when"); the contents are the
       * team's own narrative text and several kilobytes of it, and a log stream is not a revision
       * store. `release`/`reopen` next door already record the same shape.
       */
      auditLog({
        event: "submission.patched",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { submissionId: input.submissionId, teamId: input.teamId },
        outcome: "success",
        metadata: { fields: Object.keys(input.fields) },
      });

      return data.submission as Submission;
    }),

  /**
   * RELEASE, the executive hands the team's work to the judges.
   *
   * ⚠ THE REFUSAL CODES REACH THE CALLER UNTOUCHED. `NO_ARTIFACTS` and `NO_DEMO_URL` are different
   * instructions to a human, `SNAPSHOT_SOURCE_UNAVAILABLE` is "try again shortly" and not a
   * complaint about the team's work, and `EXECUTIVE_ONLY` means the wrong person is looking at the
   * button. Flattening those into one message is the failure this comment exists to prevent.
   */
  release: protectedProcedure
    .input(z.object({ teamId: z.string(), submissionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/submissions/${encodeURIComponent(input.submissionId)}/release`,
        { method: "POST", token: ctx.token }
      );

      auditLog({
        event: "submission.released",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { submissionId: input.submissionId, teamId: input.teamId },
        outcome: "success",
      });

      return data.submission as Submission;
    }),

  /** REOPEN, the experience owner's, never the executive's. The reason is mandatory. */
  reopen: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        submissionId: z.string(),
        reason: z.string().trim().min(1).max(MAX_SCORE_COMMENT_CHARS),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/teams/${encodeURIComponent(input.teamId)}/submissions/${encodeURIComponent(input.submissionId)}/reopen`,
        { method: "POST", body: JSON.stringify({ reason: input.reason }), token: ctx.token }
      );

      auditLog({
        event: "submission.reopened",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { submissionId: input.submissionId, teamId: input.teamId },
        outcome: "success",
        metadata: { reason: input.reason },
      });

      return data.submission as Submission;
    }),

  /** A judging panel's worklist for one experience. Released teams only. */
  forWorkshop: protectedProcedure
    .input(z.object({ workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/submissions`,
        { token: ctx.token }
      );
      return {
        submissions: (data.submissions || []) as JudgeListRow[],
        truncated: data.truncated === true,
      };
    }),

  /**
   * The pinned snapshot a judge reads.
   *
   * ⚠ `NOT_RELEASED` (409) IS LET THROUGH AS AN ERROR, not converted to null. A judge should never
   * see this, the list only contains released teams, so it means something is wrong with the link
   * they followed, and swallowing it would render an empty page as though the team submitted nothing.
   */
  snapshot: protectedProcedure
    .input(z.object({ submissionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/submissions/${encodeURIComponent(input.submissionId)}/snapshot`,
        { token: ctx.token }
      );
      return {
        snapshot: data.snapshot as Snapshot,
        releasedAt: (data.releasedAt ?? null) as string | null,
        teamId: data.teamId as string,
      };
    }),

  /**
   * ── THE SUBMISSION RECORD ITSELF, THE WRITE-UP A JUDGE IS SUPPOSED TO READ ─────────────────
   *
   * ⚠ THIS PROCEDURE WAS MISSING, AND THAT WAS THE WHOLE BUG. Reported: a judge opening
   * `/experiences/<id>/submissions/<id>` saw the team's PHASE NOTES and none of what the executive
   * actually submitted. The route it needs has existed all along, `GET /v1/submissions/:id`, which
   * returns the full record including `title`, `summary`, `problemStatement`, `solution` and the four
   * links, and nothing in this BFF ever called it. The detail page fetched `snapshot` alone, and the
   * snapshot is deliberately only `phases[]` + `artifacts[]`.
   *
   * The evaluation service says exactly where these belong (`routes.ts`, on the judge LIST shape):
   * *"THIS SHAPE IS DELIBERATELY NARROW… NOT the narrative fields, which belong on the detail read
   * where the snapshot banner ('as released on …') appears beside them."* This is that detail read.
   *
   * ⚠ SAME GATE AS `snapshot`, WHICH IS WHY THIS ADDS NO EXPOSURE. Both routes call
   * `requireSubmissionRead` against the record's OWN team and workshop, team read OR (scoring role
   * AND entitled to this submission's workshop). A judge entitled to workshop A still gets 403 on a
   * submission in workshop B, and this procedure cannot widen that: it forwards the caller's token and
   * decides nothing.
   *
   * ⚠ THE RECORD IS LIVE; THE SNAPSHOT IS PINNED. While a submission is SUBMITTED the record cannot
   * move, `patch` is refused with `ALREADY_RELEASED`, so the two agree. They can diverge only after
   * an owner REOPENS it, which retains the old snapshot by design because that is what
   * already-cast scores were cast against. So a reopened-and-edited submission shows the current
   * write-up beside a snapshot from the earlier release; the "as released on …" banner the page already
   * renders is what keeps that honest, and it is the arrangement the service comment above prescribes.
   */
  byId: protectedProcedure
    .input(z.object({ submissionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/submissions/${encodeURIComponent(input.submissionId)}`,
        { token: ctx.token }
      );
      return (data.submission ?? null) as Submission | null;
    }),

  /**
   * ⚠ THERE IS NO `artifact` PROCEDURE. It existed once and was removed with the service
   * route behind it, which could only answer 503, it needed `INTERNAL_SERVICE_TOKEN`, set on no
   * function deliberately. Judges read the file MANIFEST (path, author, timestamp) from the snapshot
   * and follow the team's repository link for code.
   */

  /** Score a released submission. Re-scoring overwrites this judge's row by design. */
  score: protectedProcedure
    .input(
      z.object({
        submissionId: z.string(),
        ...scoreShape,
        comment: z.string().max(MAX_SCORE_COMMENT_CHARS).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { submissionId, ...body } = input;
      const data = await backendFetch(
        `/v1/submissions/${encodeURIComponent(submissionId)}/scores`,
        { method: "POST", body: JSON.stringify(body), token: ctx.token }
      );

      /**
       * ⚠ RE-SCORING OVERWRITES THIS JUDGE'S ROW BY DESIGN, which is precisely why the event
       * matters: the store keeps only the latest score, so the trail is the only record that an
       * earlier one existed. `comment` is excluded, it is a judge's free text about a team, and
       * the score is what the event is attesting to.
       */
      auditLog({
        event: "submission.score.recorded",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { submissionId },
        outcome: "success",
        metadata: { criteria: Object.keys(body).filter((k) => k !== "comment") },
      });

      return data.score as Record<string, unknown>;
    }),

  /** Every judge's scores for a submission, gated to the team and to entitled judges. */
  scores: protectedProcedure
    .input(z.object({ submissionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/submissions/${encodeURIComponent(input.submissionId)}/scores`,
        { token: ctx.token }
      );
      return (data.scores || []) as Array<{
        judgeId: string;
        innovation: number;
        execution: number;
        aiUsage: number;
        impact: number;
        presentation: number;
        comment: string | null;
        createdAt: string;
      }>;
    }),

  /**
   * The PUBLISHED places, or null when nothing has been published.
   *
   * ⚠ THE ONE PLACE A 404 IS TRANSLATED, AND ONLY FOR `NOT_PUBLISHED`. "No result yet" is a normal
   * state for most of an experience's life, and surfacing it as an error would make every results
   * screen open on a failure. Any OTHER 404, a workshop that does not exist, still throws, because
   * that one is a real mistake. Matched on `.code`, never on message text.
   */
  results: protectedProcedure
    .input(z.object({ workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const data = await backendFetch(
          `/v1/workshops/${encodeURIComponent(input.workshopId)}/results`,
          { token: ctx.token }
        );
        return data.results as WorkshopResults;
      } catch (err) {
        if (err instanceof BackendError && err.status === 404 && err.code === "NOT_PUBLISHED") {
          return null;
        }
        throw err;
      }
    }),

  /** The owner's unpublished preview: the ranking, or the refusal blocking it. */
  resultsPreview: protectedProcedure
    .input(z.object({ workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/results/preview`,
        { token: ctx.token }
      );
      return data as unknown as ResultsPreview;
    }),

  /**
   * PUBLISH the places.
   *
   * `tieOrder` is the owner's explicit ordering of tied submission ids. Optional because most
   * publishes have no tie, and when one exists the service refuses until it is supplied, which is
   * what drives the tie-resolution UI.
   */
  publishResults: protectedProcedure
    /**
     * ⚠ `tieOrder` IS BOUNDED, AND IT WAS THE ONE UNBOUNDED VALUE IN THIS FILE. Every other caller
     * value here has a ceiling, `MAX_URL_CHARS`, the narrative and comment caps, the score range -
     * and this array had neither an element nor a length bound while being `JSON.stringify`-ed
     * straight into the publish body of the most consequential mutation the router exposes.
     *
     * The bounds come from what a tie IS: team ids, in the order a facilitator resolved them. A
     * workshop's team count is what caps the array; `MAX_TEAM_ID_CHARS` is a ULID with room to spare.
     */
    .input(
      z.object({
        workshopId: z.string(),
        tieOrder: z
          .array(z.string().min(1).max(MAX_TEAM_ID_CHARS))
          .max(MAX_TIE_ORDER_TEAMS)
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/results/publish`,
        {
          method: "POST",
          body: JSON.stringify(input.tieOrder ? { tieOrder: input.tieOrder } : {}),
          token: ctx.token,
        }
      );
      const experienceCompleted = data.experienceCompleted !== false;

      /**
       * ⚠ THE MOST CONSEQUENTIAL MUTATION IN THIS ROUTER, AND IT RECORDED NOTHING. Publishing
       * fixes the final ranking and completes the experience, irreversible from a participant's
       * point of view, and `protectedProcedure` proves only a session, so without this event the
       * portal retained no answer to "who published this ranking".
       *
       * `experienceCompleted` is carried into the event for the same reason it is surfaced to the
       * caller: the service publishes the ranking FIRST and then completes the experience, so a
       * `false` here marks a partial outcome that a reader of the trail needs to see.
       * `tieOrder` is recorded as a COUNT, that the publisher resolved n ties is the fact; which
       * submission they placed above which is already in the published results.
       */
      auditLog({
        event: "submission.results.published",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.workshopId },
        outcome: "success",
        metadata: { tieOrder: input.tieOrder?.length ?? 0, experienceCompleted },
      });

      return {
        results: data.results as WorkshopResults,
        /**
         * ⚠ SURFACED RATHER THAN IGNORED. The service publishes the ranking FIRST and then moves the
         * experience to COMPLETED; if that second step fails the results ARE published and this is
         * false. A screen that assumed success would show a completed experience that is not.
         */
        experienceCompleted,
      };
    }),
});
