import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import type {
  AiMessageListResponse,
  AiThreadListResponse,
  AiThreadResponse,
  TeamMemberListResponse,
  ThreadTimingResponse,
} from "@/lib/backend-types";

export const aiRouter = router({
  getThreads: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [threadsData, membersData] = await Promise.all([
        backendFetch<AiThreadListResponse>(`/v1/ai/teams/${encodeURIComponent(input.teamId)}/threads`, { token: ctx.token }),
        backendFetch<TeamMemberListResponse>(`/v1/teams/${encodeURIComponent(input.teamId)}/members`, { token: ctx.token }).catch(() => ({ members: [] })),
      ]);
      const threads = threadsData.threads || [];
      const members = membersData.members || [];
      const nameMap = new Map(members.map((m) => [m.userId, m.user?.name || "Unknown"]));

      /**
       * `createdById` is REQUIRED on the service's `AiThread` but is typed optional here for the
       * rows that predate it, which is why the lookup is guarded rather than passed straight in.
       * It resolved to "Unknown" for such a thread before this was typed; it still does, and now
       * it cannot be handed to `Map.get` as `undefined` by a later edit.
       */
      return threads.map((t) => ({
        ...t,
        createdBy: {
          id: t.createdById,
          name: (t.createdById ? nameMap.get(t.createdById) : undefined) || "Unknown",
        },
      }));
    }),

  /**
   * ── ⚠ TOKEN USAGE ACROSS A TEAM'S CONVERSATIONS ─────────────────────────────────────────
   *
   * The panel needs cross-thread figures, and the counts live on the MESSAGES, so this
   * fans out over the team's threads and returns each one's token rollup for the client to aggregate.
   *
   * ⚠ WHY THIS IS NOT THE AGGREGATE TABLE THAT WAS PROPOSED. It does not have to be yet: a whole development
   * deployment holds a couple of dozen threads, so a team's is a handful, and that table's own justification was that scanning
   * every thread "won't scale past a few teams". This is the version that is honest about being small. When a
   * team's thread count makes this slow, THAT is when the table earns its place, and `truncated` below is the
   * signal that the moment has arrived rather than a guess about it.
   *
   * ⚠ ONE ROUND TRIP FROM THE BROWSER, NOT N. Fanning out client-side would put a request per thread on the
   * page load and re-run them on every render that changed the thread list.
   *
   * ⚠ A THREAD THAT FAILS IS SKIPPED, NOT FATAL. One unreadable thread must not blank a whole team's usage
   * panel, the aggregate is explicitly a partial figure that reports its own coverage, so a missing thread is
   * the case it is already built to describe.
   */
  tokenUsage: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const threadsData = await backendFetch<AiThreadListResponse>(
        `/v1/ai/teams/${encodeURIComponent(input.teamId)}/threads`,
        { token: ctx.token }
      );
      const threads = threadsData.threads || [];

      /**
       * A hard ceiling on the fan-out. Twenty-five is far above any team's real thread count and low enough
       * that a runaway cannot turn one page view into hundreds of backend calls.
       */
      const MAX_THREADS = 25;
      const considered = threads.slice(0, MAX_THREADS);

      const rollups = await Promise.all(
        considered.map(async (t) => {
          try {
            const data = await backendFetch<ThreadTimingResponse>(
              `/v1/ai/threads/${encodeURIComponent(t.id)}/timing`,
              { token: ctx.token }
            );
            const ai = (data.timing ?? data)?.ai ?? {};
            return {
              threadId: t.id,
              at: t.updatedAt || t.createdAt,
              /**
               * ⚠ WHO STARTED THE CONVERSATION, NOT "who spent these tokens". The counts sit on the
               * ASSISTANT messages, which carry no user id, so the only attribution the data supports is to
               * the thread's owner. A teammate who contributed turns to somebody else's thread is invisible
               * here, and the UI must say "conversations they started" rather than imply personal spend.
               */
              ownerId: t.createdById ?? null,
              inputTokens: Number(ai.inputTokens ?? 0),
              outputTokens: Number(ai.outputTokens ?? 0),
              cachedInputTokens: Number(ai.cachedInputTokens ?? 0),
              cacheWriteInputTokens: Number(ai.cacheWriteInputTokens ?? 0),
              cacheCounted: Number(ai.cacheCounted ?? 0),
              tokenCount: Number(ai.tokenCount ?? 0),
              assistantCount: Number(ai.measuredCount ?? 0) + Number(ai.unmeasuredCount ?? 0),
            };
          } catch {
            return null;
          }
        })
      );

      return {
        threads: rollups.filter((r): r is NonNullable<typeof r> => r !== null),
        /* Shed load OBSERVABLY: a capped list must not read as the whole team's usage. */
        truncated: threads.length > MAX_THREADS,
        totalThreads: threads.length,
      };
    }),

  /**
   * ── ONE THREAD'S TRANSCRIPT, WITH ITS AUTHORS' NAMES RESOLVED ───────────────────────────────
   *
   * ⚠ THE NAMES ARE NEW, AND THE PAGE HAS BEEN PRETENDING TO HAVE THEM ALL ALONG. The reading pane
   * rendered `msg.user?.name`, but `GET /threads/:threadId/messages` returns the stored `AiMessage`
   * rows verbatim, no read-model join, unlike the TEAM roster fan-out which does add `user`. So
   * that property never existed on this payload and every user turn silently fell back to the
   * literal "User" and a "U" avatar. Declaring the response type is what exposed it.
   *
   * ⚠ RESOLVED HERE, THE SAME WAY `getThreads` RESOLVES THREAD OWNERS, same roster route, same
   * name map, same failure posture, rather than by adding a join to the AI service. The AI service
   * must not read the Team context's tables, and it has no users read-model of its own
   * for this; the BFF is the layer that is already allowed to talk to both. Two name lookups in one
   * router that disagreed about how to spell "Unknown" would be the worse outcome.
   *
   * ⚠ `teamId` IS AN INPUT BECAUSE THE MESSAGES ROUTE IS THREAD-KEYED and returns no team. It
   * discloses nothing new: the roster call is authorized independently for the CALLER, so a caller
   * naming a team they are not on gets a 403 on that half and a transcript with unresolved names -
   * never somebody else's roster. The messages themselves stay gated by the AI service on the
   * thread's OWN team, which this parameter cannot influence.
   *
   * ⚠ A ROSTER FAILURE MUST NOT COST THE TRANSCRIPT. The names are decoration on the conversation;
   * the conversation is the point. So the roster call absorbs its own failure and every author reads
   * "Unknown", NOT an omitted `user`, because a user turn has an author whatever the roster did and
   * what failed is the LOOKUP. Same distinction `feedback-names.test.ts` draws: could-not-resolve is
   * not does-not-exist.
   */
  getThread: protectedProcedure
    .input(z.object({ threadId: z.string(), teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const [data, membersData] = await Promise.all([
        backendFetch<AiMessageListResponse>(
          `/v1/ai/threads/${encodeURIComponent(input.threadId)}/messages`,
          { token: ctx.token }
        ),
        backendFetch<TeamMemberListResponse>(
          `/v1/teams/${encodeURIComponent(input.teamId)}/members`,
          { token: ctx.token }
        ).catch(() => ({ members: [] })),
      ]);

      const nameMap = new Map(
        (membersData.members || []).map((m) => [m.userId, m.user?.name || "Unknown"])
      );

      return {
        messages: (data.messages || []).map((m) => ({
          ...m,
          /**
           * ABSENT rather than "Unknown" when there is no `userId` to resolve, an ASSISTANT turn
           * has no author, and giving it a `user` object would put a name on the model's reply. The
           * pane keys on `role` for that distinction, and this keeps the data agreeing with it.
           */
          ...(m.userId
            ? { user: { id: m.userId, name: nameMap.get(m.userId) || "Unknown" } }
            : {}),
        })),
      };
    }),

  /**
   * Per-thread timing: how long the assistant worked vs. how long the ball was in the
   * user's court.
   *
   * The endpoint has existed since the ai service was built and nothing consumed it. It
   * returns the two halves SEPARATELY and labelled (`basis: "measured"` vs
   * `basis: "inferred"`) precisely so a UI cannot sum them into one authoritative figure -
   * AI time is measured around the invoke, user time is only elapsed wall-clock while
   * nobody was generating. The component renders them apart for that reason.
   */
  timing: protectedProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ ctx, input }) => {
      const data = await backendFetch<ThreadTimingResponse>(
        `/v1/ai/threads/${encodeURIComponent(input.threadId)}/timing`,
        { token: ctx.token }
      );
      return data.timing ?? data;
    }),

  createThread: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        title: z.string().optional(),
        phaseContext: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch<AiThreadResponse>(
        `/v1/ai/teams/${encodeURIComponent(input.teamId)}/threads`,
        {
          method: "POST",
          body: JSON.stringify(input),
          token: ctx.token,
        }
      );
      return data.thread;
    }),
});
