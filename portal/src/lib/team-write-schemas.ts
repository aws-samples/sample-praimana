import { z } from "zod";
import { MAX_TEAM_MESSAGE_CHARS } from "@praimana/shared";

/**
 * ── THE BOUNDS ON A TEAM-WORKSPACE WRITE, FOR BOTH DOORS ──────────────────────────────────────
 *
 * ⚠ TWO DOORS WRITE THESE SINKS, AND ONLY ONE USED TO VALIDATE. `message.send` and `task.create`
 * in the tRPC routers carried bounded, enumerated Zod schemas; `POST /api/desktop/send-message`
 * and `POST /api/desktop/create-task` destructured `req.json()`, checked that `teamId` was a
 * non-empty string, and forwarded everything else verbatim to the SAME
 * `POST /v1/teams/:id/messages` and `POST /v1/teams/:id/tasks`.
 *
 * That was not a redundant second copy of a control, it was a hole in the ONLY copy:
 * `shared/constants/chat-limits.ts` records that the 4,000-character message ceiling is
 * "ENFORCED IN tRPC, NOT IN THE SERVICE, that service still stores `content: body.content` with
 * no length check". So the REST door let a caller store an unbounded message or task body, and an
 * off-enum `status` produced a task that renders in NO board column (`board/page.tsx` filters
 * strictly on the five column statuses) while still existing in the store and counting in
 * activity denominators, board state a writer could hide from every portal reader.
 *
 * Defining the shapes HERE rather than in either router is what makes "one schema, two doors"
 * true: a route importing from `trpc/routers/*` would be the wrong direction of dependency, and
 * the next limit somebody bumps has one place to bump it.
 *
 * ⚠ THESE ARE THE SHARED CORE, NOT THE WHOLE tRPC INPUT. `message.send` also accepts `metadata`
 * and `parentId`, and `task.create` accepts `assigneeId`; the desktop client sends none of them.
 * The routers `.extend()` these rather than the desktop schemas widening to match, so adding a
 * field to the rich door cannot silently open it on the bare one.
 */

/** `teamId` is a path segment on both sinks, so an empty one would build `/v1/teams//messages`. */
const teamId = z.string().min(1);

/** The five board columns. Anything else renders in none of them, see the header. */
export const TASK_STATUSES = ["BACKLOG", "TODO", "IN_PROGRESS", "REVIEW", "DONE"] as const;

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/**
 * `POST /v1/teams/:id/messages`.
 *
 * `MAX_TEAM_MESSAGE_CHARS` and not a literal 4000: the composer counts against the same constant,
 * so the client's remaining-characters hint and the server's refusal cannot disagree.
 */
export const sendMessageSchema = z.object({
  teamId,
  content: z.string().min(1).max(MAX_TEAM_MESSAGE_CHARS),
  type: z.enum(["TEXT", "CODE_SNIPPET"]).default("TEXT"),
});

/** `POST /v1/teams/:id/tasks`. The 200/2000 ceilings are the ones the tRPC door already applied. */
export const createTaskSchema = z.object({
  teamId,
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  status: z.enum(TASK_STATUSES).default("TODO"),
  priority: z.enum(TASK_PRIORITIES).default("MEDIUM"),
});

/**
 * `POST /v1/teams/join`.
 *
 * Bounded for the plain reason that an unbounded string reaching a request body has no upper
 * cost; 200 is generous for any invite code this platform mints. `.min(1)` preserves the route's
 * existing "Invite code required" refusal.
 */
export const joinTeamSchema = z.object({
  inviteCode: z.string().min(1).max(200),
});
