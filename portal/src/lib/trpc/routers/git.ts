import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";

export const gitRouter = router({
  getCommits: protectedProcedure
    .input(z.object({ teamId: z.string(), limit: z.number().int().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const params = new URLSearchParams({ limit: String(input.limit) });
      const data = await backendFetch(
        `/v1/git/teams/${encodeURIComponent(input.teamId)}/commits?${params}`,
        { token: ctx.token }
      );
      return data.commits || [];
    }),

  getFiles: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/git/teams/${encodeURIComponent(input.teamId)}/files`, { token: ctx.token });
      return data.files || [];
    }),

  sync: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/git/teams/${encodeURIComponent(input.teamId)}/sync`, {
        method: "POST",
        token: ctx.token,
      });
      return data;
    }),
});
