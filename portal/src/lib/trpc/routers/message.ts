import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import { sendMessageSchema } from "@/lib/team-write-schemas";
import type { MessageListResponse, MessageResponse } from "@/lib/backend-types";

/**
 * A thread parent is an id the service minted, a ULID or the `createdAt` fallback `message.list`
 * uses. Bounded because an unbounded string in a forwarded body is an unbounded string, whatever it
 * is called.
 */
const MAX_PARENT_ID_CHARS = 128;

export const messageRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        teamId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const params = new URLSearchParams({ limit: String(input.limit) });
      if (input.cursor) params.set("before", input.cursor);

      const data = await backendFetch<MessageListResponse>(
        `/v1/teams/${encodeURIComponent(input.teamId)}/messages?${params}`,
        { token: ctx.token }
      );
      const messages = (data.messages || []).map((m) => ({
        ...m,
        id: m.id || m.createdAt,
        sender: m.sender || (m.userId ? { id: m.userId, name: m.userName || "Unknown" } : (m.senderId ? { id: m.senderId, name: "User" } : null)),
      }));
      messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { messages, nextCursor: data.lastKey };
    }),

  send: protectedProcedure
    /**
     * ⚠ THE BOUNDS ARE SHARED WITH THE DESKTOP REST DOOR, WHICH USED TO HAVE NONE.
     *
     * `content`/`type` and their limits now live in `lib/team-write-schemas.ts` because
     * `POST /api/desktop/send-message` writes the SAME `/v1/teams/:id/messages` sink and was
     * forwarding both fields unvalidated, and `chat-limits.ts` records that this schema is the
     * only length bound in the whole system, the service applying none. See that module's header.
     *
     * `parentId` stays HERE: it is this door's extra, the desktop client does not send it, and
     * extending rather than widening the shared shape keeps it that way. The message ceiling is
     * still `MAX_TEAM_MESSAGE_CHARS`, the same constant the composer counts against, so the UI hint
     * and the server refusal cannot disagree.
     *
     * ── ⚠ `metadata: z.any()` IS GONE, AND IT WAS THE HOLE IN THE ONLY BOUND ──────────────────
     *
     * It sat next to a `content` field capped at 4,000 characters and sidestepped that cap
     * completely: no type, no depth, no size. The whole input is re-serialised into the upstream
     * body, `chat-limits.ts` records that this schema is the ONLY length bound in the system (the
     * collaboration service stores `content: body.content` with no check), and `message.list`
     * spreads the stored row back to every reader on the chat page's three-second poll. So it was an
     * unbounded write into a shared store, readable by the whole team, reachable by every signed-in
     * role.
     *
     * ⚠ REMOVED RATHER THAN BOUNDED, because nothing sends it. The only caller is the chat
     * composer's `sendMessage.mutate({ teamId, content })`, and the sibling REST door deliberately
     * keeps `metadata` off its shared shape, so the rich door was the only one that accepted it, and
     * it accepted anything. A field with no writer and no schema is not a feature to bound, it is a
     * hole to close. `MessageRecord.metadata` stays on the READ path: rows written elsewhere may
     * carry it, and this changes nothing about serving them.
     */
    .input(
      sendMessageSchema.extend({
        parentId: z.string().max(MAX_PARENT_ID_CHARS).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch<MessageResponse>(`/v1/teams/${encodeURIComponent(input.teamId)}/messages`, {
        method: "POST",
        body: JSON.stringify(input),
        token: ctx.token,
      });
      return data.message;
    }),
});
