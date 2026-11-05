import { z } from "zod";
import { billableProcedure, protectedProcedure, router } from "../trpc";
import { backendFetch, BackendError } from "@/lib/backend";
import { auditLog } from "@/lib/audit-logger";

/**
 * Team AI ratings, the four routes the AI service actually exposes.
 *
 * ── THE BUG THIS FILE USED TO CONTAIN ──
 *
 * `get` called `/v1/teams/:teamId/ratings`, which is the EVALUATION service's peer-ratings
 * route. It answers 200 with `{contributions, peerRatings}`, no `ratings` key and no
 * `teamSummary`, so `data.ratings || []` quietly produced an empty list and the card
 * reported "No AI ratings yet" no matter how many analyses had been stored. A 200 with the
 * wrong body is the worst kind of wrong endpoint: nothing errors, and the screen states a
 * falsehood as a fact. The real routes live under `/v1/ai/...`.
 *
 * ── TWO READS, BECAUSE THERE ARE TWO AUDIENCES ──
 *
 * `analysis` is MEMBER-ONLY and carries per-member coaching (scores, strengths,
 * improvements). `summary` is the only route a non-member can reach, returns the published
 * team summary and nothing per-member, and its 404 SUMMARY_NOT_PUBLISHED is a normal state
 * rather than an error, a judge looking at a team that has not published yet.
 *
 * They are separate procedures rather than one with a role flag, mirroring the service: a
 * flag is one wrong argument away from requesting per-member detail on behalf of a judge.
 */
export const ratingRouter = router({
  /**
   * The member-only per-member analysis. NEVER invokes the model, a read costs nothing and
   * cannot bill, which is what makes it safe to run on page load.
   */
  analysis: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/ai/teams/${encodeURIComponent(input.teamId)}/ratings/analysis`,
        { token: ctx.token }
      );
      // `analysis: null` is the legitimate "nothing generated yet". Shape-checked rather
      // than spread, so a future service field cannot arrive here unnoticed.
      const a = data.analysis ?? null;
      return {
        members: a?.members ?? [],
        teamSummary: a?.teamSummary ?? "",
        generatedAt: a?.generatedAt ?? null,
        generationId: a?.generationId ?? null,
        publishedAt: a?.publishedAt ?? null,
        coverage: a?.coverage ?? [],
      };
    }),

  /**
   * THE PROMPTS the assessment sends, the disclosure behind the Analyze button.
   *
   * ⚠ SERVED BY THE SERVICE, NOT DECLARED HERE, and that is the whole point of the route. The
   * prompts live beside the Bedrock adapter that sends them (`ratings-prompts.ts`), so the panel
   * cannot describe a prompt the model did not receive. A local copy of the text in the portal
   * would be a second source of truth for how a judgement about a person was produced, the
   * failure `InsightsMethodology` names in its own header ("a methodology note that drifts from
   * the code is worse than none"), in the one place it would matter most.
   *
   * `protectedProcedure`, NOT `billableProcedure`: this invokes no model. `analyze` next door
   * spends one Bedrock call per member, which is why it is rate-limited; this serves two
   * constants and cannot bill, so it is safe to run on render, the same reasoning as `analysis`.
   *
   * The SERVICE is the authority on the audience (EXECUTIVE and a member of this team). This layer
   * does not re-decide it; a 403 propagates.
   */
  prompts: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/ai/teams/${encodeURIComponent(input.teamId)}/ratings/prompts`,
        { token: ctx.token }
      );
      return {
        prompts: (data.prompts ?? []) as Array<{
          key: "knowledge" | "summary";
          title: string;
          system: string;
          inputs: string[];
          audience: string;
        }>,
      };
    }),

  /**
   * The PUBLISHED summary, what a judge or an off-team executive can read.
   *
   * A 404 is mapped to a null summary rather than thrown: "this team has not published one"
   * is an ordinary answer, and surfacing it as an error would put a red failure box in front
   * of a judge who did nothing wrong. Every OTHER status still throws.
   */
  summary: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      try {
        const data = await backendFetch(
          `/v1/ai/teams/${encodeURIComponent(input.teamId)}/ratings/summary`,
          { token: ctx.token }
        );
        return {
          summary: (data.summary as string | null) ?? null,
          generatedAt: (data.generatedAt as string | null) ?? null,
          publishedAt: (data.publishedAt as string | null) ?? null,
          coverage: (data.coverage as string[]) ?? [],
          memberCount: (data.memberCount as number | null) ?? null,
          notPublished: false,
        };
      } catch (err) {
        // Matched on the STRUCTURED `code`, not on the message text: the message is
        // human-facing prose that may be reworded, and a substring test against it would
        // start silently failing (or worse, start matching a 403 whose wording happens to
        // mention publishing).
        //
        // Only SUMMARY_NOT_PUBLISHED is absorbed. A 403 must keep throwing, telling a
        // caller "not published" when the truth is "not yours" would be a quiet
        // authorization lie, and a 503 must surface as a failure so nobody reads "not
        // published" off an unreachable service.
        if (err instanceof BackendError && err.code === "SUMMARY_NOT_PUBLISHED") {
          return {
            summary: null,
            generatedAt: null,
            publishedAt: null,
            coverage: [],
            memberCount: null,
            notPublished: true,
          };
        }
        throw err;
      }
    }),

  /**
   * The one billable call.
   *
   * ⚠ `billableProcedure`, NOT `protectedProcedure`, AND THAT IS THE WHOLE DIFFERENCE. The cooldown
   * this comment used to cite as the control lives entirely in the evaluation SERVICE, so the portal
   * contributed no bound of its own to Bedrock spend, a caller could loop this as fast as the
   * network allowed, through a door reachable by every signed-in role with no rate limit at all
   * (a security finding). `billableProcedure` adds a tight per-user window on top of the
   * general one. The service cooldown still applies and is still the authority on freshness.
   */
  analyze: billableProcedure
    .input(z.object({ teamId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return backendFetch(
        `/v1/ai/teams/${encodeURIComponent(input.teamId)}/ratings/analyze`,
        { method: "POST", token: ctx.token }
      );
    }),

  /**
   * Publish the summary to facilitators, executives and judges, a DISCLOSURE, not a save.
   *
   * `generationId` is required by the service and must still be the newest, so that
   * publishing applies to the snapshot the publisher was actually looking at. It is passed
   * through from the analysis the UI rendered rather than re-fetched here.
   */
  publish: protectedProcedure
    .input(z.object({ teamId: z.string(), generationId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/ai/teams/${encodeURIComponent(input.teamId)}/ratings/publish`,
        {
          method: "POST",
          token: ctx.token,
          // Stringified: backendFetch takes a RequestInit, so an object here would be
          // serialised as "[object Object]" and the service would 400 on a missing
          // generationId.
          body: JSON.stringify({ generationId: input.generationId }),
        }
      );

      /**
       * ⚠ THE ONE MUTATION IN THIS ROUTER, AND IT EMITTED NOTHING. This procedure's own docstring
       * calls it "a DISCLOSURE, not a save": it publishes model-written performance statements
       * about named people to facilitators, executives and judges. The audit catalogue promises
       * coverage of "results publication", and rating.ts had no auditLog call at all.
       *
       * `generationId` is recorded because it identifies WHICH snapshot was disclosed, the
       * question anyone reviewing a disclosure afterwards actually has.
       */
      auditLog({
        event: "rating.published",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { teamId: input.teamId },
        outcome: "success",
        metadata: { generationId: input.generationId },
      });

      return data;
    }),
});
