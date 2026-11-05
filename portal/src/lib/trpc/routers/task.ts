import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import { createTaskSchema, TASK_PRIORITIES, TASK_STATUSES } from "@/lib/team-write-schemas";
import type { TaskListResponse, TaskResponse } from "@/lib/backend-types";

export const taskRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        status: z.enum(TASK_STATUSES).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const data = await backendFetch<TaskListResponse>(`/v1/teams/${encodeURIComponent(input.teamId)}/tasks`, { token: ctx.token });
      const tasks = data.tasks || [];
      if (input.status) {
        return tasks.filter((t) => t.status === input.status);
      }
      return tasks;
    }),

  create: protectedProcedure
    /**
     * ⚠ THE BOUNDS ARE SHARED WITH THE DESKTOP REST DOOR, WHICH USED TO HAVE NONE.
     *
     * `POST /api/desktop/create-task` writes the SAME `/v1/teams/:id/tasks` sink and forwarded
     * `title`/`description`/`status`/`priority` verbatim, so an off-enum status could produce a
     * task that renders in no board column while still counting in activity denominators. The
     * shape moved to `lib/team-write-schemas.ts` so both doors parse one definition; `assigneeId`
     * stays here as this door's extra.
     */
    .input(createTaskSchema.extend({ assigneeId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch<TaskResponse>(`/v1/teams/${encodeURIComponent(input.teamId)}/tasks`, {
        method: "POST",
        body: JSON.stringify(input),
        token: ctx.token,
      });
      return data.task;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        teamId: z.string(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        assigneeId: z.string().nullable().optional(),
        order: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...body } = input;
      const data = await backendFetch(`/v1/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        token: ctx.token,
      });
      return data;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string(), teamId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(`/v1/tasks/${encodeURIComponent(input.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ teamId: input.teamId }),
        token: ctx.token,
      });
      return data;
    }),

  /**
   * ── `analyzeChat` WAS REMOVED, and it never worked ──
   *
   * It POSTed to `/v1/teams/:teamId/tasks/analyze-chat`, which NO service implements. Verified
   * three ways rather than inferred: no handler for that path exists in any service; `git log -S`
   * finds it was never added to the services repo; and the live API answers 401 rather than 404
   * because the gateway's `/v1/teams/{teamId}/tasks/{taskId}` mapping (Method: ANY) matches it -
   * routing "analyze-chat" to the collaboration service AS A TASK ID, where only PATCH is defined.
   * So a POST reached the service and fell through to Hono's 404.
   *
   * The board's "🤖 Analyze Chat" button called this and has therefore always failed with
   * "Error: Backend error: 404". Removed deliberately rather than implemented:
   * building it means a real Bedrock route, which needs its own cooldown, its own gateway mapping
   * (the current one collides with `{taskId}`), and a decision about who may trigger it.
   *
   * If it is built later, note that the collision is the first problem to solve, an explicit
   * route must precede the greedy one, exactly as RatingsAnalyze now does.
   */
});
