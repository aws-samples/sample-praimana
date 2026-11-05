import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";

/**
 * ── HOW IS MY EXPERIENCE GOING?, the facilitator's and admin's operational view ───────────
 *
 * ── ⚠ WHY THIS IS ONE SERVICE CALL AND NOT A FAN-OUT IN THE BFF ──
 *
 * The obvious approach is "resolve the teams here, then query per team from the BFF". That does not
 * work, and finding out why is the reason this router is thin: per-team surfaces are
 * MEMBER-ONLY, and a facilitator is not a member of the teams they run. So
 * `GET /workshops/teams/:id/phases` (`requireTeamContentRead`) and `GET /teams/:id/docs`
 * (membership GetItem, no role branch) both refuse a facilitator, correctly.
 *
 * The aggregate therefore has to be assembled by a service that (a) owns the data and (b) can gate on
 * EXPERIENCE OWNERSHIP rather than team membership. That is `evaluation`, which owns the activity
 * read-model. One call, one gate, no cross-context reads.
 *
 * ⚠ WHAT THE RESPONSE DELIBERATELY DOES NOT CONTAIN: message or document CONTENT, and
 * anything per-person. The service aggregates the person away before
 * answering; this layer could not reintroduce it if it wanted to.
 */

export type TeamActivity = {
  teamId: string;
  teamName: string | null;
  /** ⚠ `null` when the roster did not report one, not 0, which would look like an empty team. */
  memberCount: number | null;
  /** How many members have ANY recorded activity. Never WHICH members. */
  membersWithActivity: number;
  tasksCreated: number;
  tasksCompleted: number;
  messagesSent: number;
  commitsPushed: number;
  aiThreadsShared: number;
  /**
   * ⚠ `null` MEANS NOT MEASURED, NOT ZERO. Rows written before the counter existed carry no value, so
   * reporting 0 would say "this team used no assistant" about a period nobody was measuring.
   * `aiTurnsMeasuredFor` says how many members' rows actually carried a figure.
   */
  aiTurns: number | null;
  aiTurnsMeasuredFor: number;
  /**
   * ⚠ THE LAST TIME ANYTHING HAPPENED, NOT A TREND. The underlying read-model is cumulative with a
   * single `updatedAt`, so this cannot answer "how much happened this morning". Presenting it as a
   * trend would be inventing a series that does not exist.
   */
  lastActivityAt: string | null;
  released: boolean;
  releasedAt: string | null;
};

export const insightsRouter = router({
  /**
   * Per-team activity for one experience. ADMIN, or the FACILITATOR who owns it, enforced by the
   * service against the stored `ownerId`, not by this layer.
   */
  experienceActivity: protectedProcedure
    .input(z.object({ workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/activity`,
        { token: ctx.token }
      );
      return {
        teams: (data.teams || []) as TeamActivity[],
        /**
         * ⚠ COVERAGE TRAVELS WITH THE FIGURES, so a reader can tell a total from a floor, the rule
         * `TokenUsagePanel` states and the reason these two counts are returned rather than derived
         * from `teams.length` on the client.
         */
        teamCount: (data.teamCount ?? 0) as number,
        releasedCount: (data.releasedCount ?? 0) as number,
      };
    }),
});
