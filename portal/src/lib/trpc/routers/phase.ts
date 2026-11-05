import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";

export const phaseRouter = router({
  // A team's phases joined with their saved per-phase content.
  listForTeam: protectedProcedure
    .input(z.object({ teamId: z.string(), workshopId: z.string() }))
    .query(async ({ ctx, input }) => {
      const params = new URLSearchParams({ workshopId: input.workshopId });
      const data = await backendFetch(
        `/v1/workshops/teams/${encodeURIComponent(input.teamId)}/phases?${params}`,
        { token: ctx.token }
      );
      return { phases: data.phases || [] };
    }),
});
