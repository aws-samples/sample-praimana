import { Hono } from "hono";
import { MAX_TEAM_MESSAGE_CHARS } from "@praimana/shared";
import { ulid } from "ulid";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  type EventPublisher,
} from "@praimana/service-shared";
import type {
  TaskRepository,
  MessageRepository,
  UsersReadModel,
} from "./domain.js";
import {
  requireTeamContentRead,
  requireTeamCollaborationWrite,
  type TeamAccess,
} from "./authz.js";
import { publishTeamEvent } from "./live-bus.js";
import { TaskAlreadyExistsError } from "./domain.js";

/**
 * Bounds on the message page.
 *
 * Previously the limit came off the query string through `parseInt` and reached
 * DynamoDB's `Limit` unvalidated, in a codebase that caps such inputs deliberately everywhere
 * else — MAX_SYNC_FILES in docs, MAX_SYNC_MESSAGES in ai, MAX_RECIPIENTS in notify.
 */
const DEFAULT_MESSAGE_PAGE = 50;

/**
 * Ceiling on one page of team chat.
 *
 * 200, the same order of magnitude as the platform's other page bounds. Team chat is read newest-
 * first with a `before` cursor, so a client wanting more history pages rather than asking for it
 * all at once.
 */
const MAX_MESSAGE_PAGE = 200;

/**
 * ── ⚠ THE MESSAGE WRITE PATH HAD NO BOUND AT ALL, AND THIS SERVICE IS THE BOUNDARY ──────────
 *
 * SECURITY FINDING (Medium — "Team chat write path (POST
 * /v1/teams/:teamId/messages) applies no server-side schema or size bound, letting one member
 * render a team's chat history unreadable").
 *
 * `content` went verbatim into the item, `type` defaulted to "TEXT" but was otherwise anything,
 * `metadata` was persisted as an arbitrary object, and `c.req.json()` had no catch. The only
 * ceiling in the system was the portal's Zod schema — which the portal's own code says in as
 * many words: "chat-limits.ts records that this schema is the ONLY length bound in the whole
 * system, the service applying none".
 *
 * ⚠ AND THE PORTAL IS A CONVENIENCE TIER, NOT A GATE. The browser holds its own Cognito ID
 * token, so any team member can call this route directly and skip that schema entirely. Rows are
 * then stored up to DynamoDB's 400 KB item limit and spread back to every reader on the chat
 * page's poll.
 *
 * ⚠ THE CEILING IS IMPORTED, NOT REDECLARED, AND IT USED TO BE A LITERAL HERE. This read
 * `const MAX_MESSAGE_CHARS = 4000` with a comment admitting the duplication: the canonical
 * constant is `MAX_TEAM_MESSAGE_CHARS`, but this repo's vendored copy of `@praimana/shared`
 * held only the three-way intersection and `chat-limits` was classified there as serving the
 * desktop alone — true until this route started enforcing anything.
 *
 * It is a three-way constant now, so it has been promoted into that barrel and the literal is
 * gone. One number, in one place, read by the desktop composer's counter, the portal's zod schema
 * and this refusal — which is the whole point, because a client truncating at 4,096 against a
 * server refusing at 4,000 is precisely the failure that module's header warns about, and it only
 * became reachable when this check was added.
 */
const MAX_MESSAGE_CHARS = MAX_TEAM_MESSAGE_CHARS;

/**
 * The enumeration the portal's shared write schema already applies
 * (`z.enum(["TEXT", "CODE_SNIPPET"])` in portal/src/lib/team-write-schemas.ts). Enumerated here
 * for the same reason it is enumerated there: an off-enum value is stored happily and then
 * renders as nothing in the client that switches on it.
 */
const MESSAGE_TYPES = new Set(["TEXT", "CODE_SNIPPET"]);

/**
 * Collaboration service routes (tasks + team messaging). Note the constructor-style
 * dependency injection: the routes depend on INTERFACES (TaskRepository,
 * MessageRepository, TeamAccess, EventPublisher, UsersReadModel) passed in, never
 * on concrete DynamoDB/HTTP classes. This is the Dependency Inversion seam — wiring
 * lives in app.ts, and tests pass in-memory fakes.
 *
 * Mounted under basePath /v1 so it is a drop-in for the monolith's /v1/teams/:id/tasks,
 * /messages and /events routes (strangler-fig: the gateway can route those here
 * while everything else still hits the monolith).
 */
export interface CollaborationDeps {
  tasks: TaskRepository;
  messages: MessageRepository;
  teamAccess: TeamAccess;
  users: UsersReadModel;
  events: EventPublisher;
}

export function createCollaborationRoutes(deps: CollaborationDeps) {
  const app = new Hono().basePath("/v1");

  // Every request must carry a gateway-injected identity (authN done at edge).
  app.use("*", edgeIdentityMiddleware());

  // ── EVERY ROUTE BELOW IS MEMBER-ONLY ────────────────────────────
  //
  // The board and the team chat are content the TEAM authored, so they are gated on
  // requireTeamContent{Read,Write} — membership of THIS team — and not on the wider
  // requireTeam{Read,Write}, which an ADMIN and a workshop-owning FACILITATOR also pass.
  // An admin, facilitator or judge now gets 403 on all four of these, with NO exception —
  // an audited admin break-glass route was built and then removed, so an
  // EXECUTIVE who is a member of the team is the only investigation path.
  //
  // Both surfaces move TOGETHER, deliberately: the board is a running account of what a
  // team is doing and the chat is how they discuss it, so narrowing one and leaving the
  // other would relocate the disclosure rather than remove it.

  // --- Tasks ---------------------------------------------------------------

  app.get("/teams/:teamId/tasks", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const tasks = await deps.tasks.listByTeam(teamId);

    /**
     * RESOLVE ASSIGNEE NAMES, from the LOCAL users read-model.
     *
     * The board renders `task.assigneeName?.[0] || "?"` as an avatar initial, and this route never
     * sent that field — so every assigned task showed "?" for the person it was assigned to. The
     * data was there all along (13 rows in this context's read-model); the response simply omitted
     * it.
     *
     * Same shape and same source as the messages route below, which has always enriched
     * `userName` this way — two routes over the same read-model should not disagree about whether
     * a name is available.
     *
     * ONE LOOKUP PER DISTINCT PERSON, not per task, and the assignees and the creators go in the
     * SAME set: a board where one person created twelve cards and owns eight of them costs one
     * Get, not twenty. Unassigned tasks contribute nothing on the assignee side.
     *
     * CREATOR NAMES ARE RESOLVED TOO, for the task detail panel — the board's cards show an
     * assignee avatar, but opening a card asks "who raised this", and `creatorId` is a Cognito sub
     * that means nothing to a reader. Same lookup, same read-model, no extra round trip in the
     * common case where the creator is also on the board somewhere.
     */
    const peopleIds = [
      ...new Set(
        tasks
          .flatMap((t) => [t.assigneeId, t.creatorId])
          .filter((id): id is string => !!id)
      ),
    ];
    const nameMap = new Map<string, string>();
    await Promise.all(
      peopleIds.map(async (uid) => {
        const view = await deps.users.get(uid);
        if (view) nameMap.set(uid, view.name);
      })
    );

    const enriched = tasks.map((t) => ({
      ...t,
      /**
       * UNDEFINED when there is no assignee, and "Unknown" only when there IS one whose name we
       * could not resolve. The two are different facts: the board renders an avatar for the
       * second and nothing at all for the first, so collapsing them would put a "?" bubble on
       * every unassigned card.
       */
      ...(t.assigneeId
        ? { assigneeName: nameMap.get(t.assigneeId) ?? "Unknown" }
        : {}),
      /**
       * Same rule for the creator. Every task HAS a creator (the field is required), but an
       * AI-generated task's creator is whoever triggered the analysis and a very old row may
       * reference someone since removed — so an unresolvable id is "Unknown" rather than a raw
       * sub leaking into the UI.
       */
      ...(t.creatorId
        ? { creatorName: nameMap.get(t.creatorId) ?? "Unknown" }
        : {}),
    }));

    return c.json({ tasks: enriched });
  });

  app.post("/teams/:teamId/tasks", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamCollaborationWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const body = await c.req.json();
    const now = new Date().toISOString();
    const taskId = body.id || ulid();

    /**
     * ── ⚠ A CREATE MUST NOT REWRITE WHO RAISED THE CARD ──────────────────────────────────────
     *
     * `tasks.put` is a full-item write and this route called it unconditionally on a
     * CALLER-SUPPLIED id, so re-posting an existing `id` did not fail and did not merge — it
     * REPLACED the row, resetting `creatorId` to the caller and `createdAt` to now. Re-posting a
     * teammate's card made you its author, and there is a legitimate `update` route for every
     * field a caller might actually have meant to change.
     *
     * ⚠ THE SAME DEFECT, THE SAME SHAPE AND THE SAME FIX AS ai/src/routes.ts's thread create,
     * which was hardened after a full-item create destroyed a real share ("a second create for an
     * id that already existed did not fail and did not merge — it REPLACED the row"). That note is
     * worth reading before touching this.
     *
     * ⚠ 200 AND THE EXISTING ROW, NOT A 409 — matching that precedent. The caller's intent ("there
     * should be a task here with this id") is already satisfied, and a client retrying a create
     * after a timeout must not be told its card failed. Nothing is mutated on this path.
     *
     * ⚠ CONDITIONAL AT THE STORE, not a read-then-write. `create` carries
     * `attribute_not_exists`, so two concurrent creates for one id cannot both observe it free —
     * exactly one wins and the loser reads back the winner's row rather than overwriting it.
     */
    let task;
    try {
      task = await deps.tasks.create({
        teamId,
        id: taskId,
        title: body.title,
        description: body.description || null,
        status: body.status || "TODO",
        priority: body.priority || "MEDIUM",
        order: body.order || 0,
        creatorId: id,
        ...(body.assigneeId ? { assigneeId: body.assigneeId } : {}),
        aiGenerated: body.aiGenerated || false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (err instanceof TaskAlreadyExistsError) {
        const existing = await deps.tasks.get(teamId, taskId);
        // A row that vanished between the refusal and this read is a genuine race with a delete;
        // reporting the conflict is honest, and inventing a 201 for a row nobody can see is not.
        if (!existing) {
          return c.json(
            { error: "That task no longer exists", code: "TASK_ALREADY_EXISTS" },
            409
          );
        }
        return c.json({ task: existing }, 200);
      }
      throw err;
    }

    // Cross-service notification travels as an event, not a direct call.
    //
    // ⚠ `userId` IS THE ACTIVITY CONTRACT'S ACTOR FIELD, and it was MISSING here entirely.
    // Evaluation's projection reads `detail.userId` and skips any event without it
    // (`applyActivityEvent`: "can't attribute — skip"), so every task.created ever published
    // was silently dropped and `tasksCreated` was permanently 0 for every member. Proved live:
    // 16 real chat messages on the platform, zero rows and zero dedup claims in the read-model.
    //
    // `creatorId` is kept as the domain-meaningful name for other readers; `userId` is the
    // canonical actor the activity contract requires. Additive, so no existing consumer breaks.
    await deps.events.publish({
      source: "collaboration-service",
      type: "task.created",
      detail: {
        taskId,
        teamId,
        title: task.title,
        aiGenerated: task.aiGenerated,
        creatorId: id,
        userId: id,
      },
    });

    // Push to any connected SSE listeners for this team (real-time, no polling).
    publishTeamEvent({
      kind: "task",
      teamId,
      actorId: id,
      createdAt: now,
      action: "created",
      taskId,
      title: task.title,
      status: task.status,
    });

    return c.json({ task }, 201);
  });

  app.patch("/teams/:teamId/tasks/:taskId", async (c) => {
    const teamId = c.req.param("teamId");
    const taskId = c.req.param("taskId");
    const denied = await requireTeamCollaborationWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const body = await c.req.json();
    const now = new Date().toISOString();

    const prior = await deps.tasks.get(teamId, taskId);
    const statusChanged = body.status !== undefined && body.status !== prior?.status;

    const task = await deps.tasks.update(teamId, taskId, {
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      order: body.order,
      assigneeId: body.assigneeId,
      updatedAt: now,
    });

    /**
     * ── ⚠ 404 BEFORE ANYTHING IS PUBLISHED ────────────────────────────────────────────────────
     *
     * SECURITY FINDING (Low — "Task PATCH has no existence precondition… and mints
     * tasksCompleted activity credit"). The repository now refuses to upsert, so `null` here means
     * the task does not exist.
     *
     * ⚠ THE SECOND EFFECT IS WHY THIS RETURNS RATHER THAN FALLING THROUGH. For a missing row
     * `prior` is null, so `statusChanged` is TRUE for any supplied status — a PATCH of
     * {"status":"DONE"} on an id that was never created published task.status-changed with the
     * caller's own userId, and evaluation's activity projection incremented tasksCompleted for
     * them. Fabricated credit in a scored, published ranking, from a task that never existed.
     * Guarding the write alone would leave that: the event is published from `statusChanged`, not
     * from the write's result.
     *
     * ⚠ AND THE CHECK IS ON THE WRITE'S RESULT, NOT ON `prior`. Reading `prior` and refusing on it
     * would leave the window between the read and the write — the ConditionExpression is what
     * actually decides, so this reads its answer.
     */
    if (!task) {
      return c.json({ error: "Not found: no such task", code: "TASK_NOT_FOUND" }, 404);
    }

    // A status change is a domain event other contexts (e.g. Evaluation) care about.
    if (statusChanged) {
      await deps.events.publish({
        source: "collaboration-service",
        type: "task.status-changed",
        detail: {
          taskId,
          teamId,
          status: body.status,
          /**
           * THE COMPLETER, not the assignee — that is the rule, and the two are genuinely
           * different people. `id` is the authenticated caller who moved the card, which is
           * the act being counted; `assigneeId` is who it was allocated to and may be absent,
           * stale, or someone who never touched it.
           *
           * This field was ABSENT, so `tasksCompleted` could never be attributed to anybody —
           * see the note on task.created. It is 25% of the insights score, so it read as
           * "nobody completed anything" on every team.
           */
          userId: id,
        },
      });
    }

    // Push to any connected SSE listeners for this team (real-time, no polling).
    publishTeamEvent({
      kind: "task",
      teamId,
      actorId: id,
      createdAt: now,
      action: "updated",
      taskId,
      title: task?.title,
      status: task?.status,
    });

    return c.json({ task });
  });

  // --- Messaging -----------------------------------------------------------

  app.get("/teams/:teamId/messages", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamContentRead(c, deps.teamAccess, teamId);
    if (denied) return denied;

    // ── ⚠ VALIDATED, NOT parseInt'd ─────────────────────────────────────────────────────────
    //
    // This was `parseInt(c.req.query("limit") || "50")` passed straight into a QueryCommand's
    // `Limit`. `parseInt("abc")` is NaN and a negative value is accepted; DynamoDB rejects both
    // with a ValidationException that no handler catches, so a query parameter produced a 500.
    // Clamped with the Number + Number.isFinite pattern used at team/src/routes.ts:1538 and
    // identity's /admin/users — and IGNORED rather than 400'd, matching those, because the value
    // comes from a URL and has an obvious default.
    const requested = Number(c.req.query("limit"));
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), MAX_MESSAGE_PAGE)
        : DEFAULT_MESSAGE_PAGE;
    const before = c.req.query("before");

    const messages = await deps.messages.listByTeam(teamId, limit, before);

    // Resolve author names from the LOCAL users read-model, not the users table.
    const senderIds = [...new Set(messages.map((m) => m.senderId).filter(Boolean))];
    const nameMap = new Map<string, string>();
    await Promise.all(
      senderIds.map(async (uid) => {
        const view = await deps.users.get(uid);
        if (view) nameMap.set(uid, view.name);
      })
    );

    const enriched = messages.map((m) => ({
      ...m,
      userId: m.senderId,
      userName: nameMap.get(m.senderId) || "Unknown",
    }));

    return c.json({ messages: enriched });
  });

  app.post("/teams/:teamId/messages", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamCollaborationWrite(c, deps.teamAccess, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);

    // ⚠ `.catch`, because `c.req.json()` on a malformed body REJECTS. Unhandled, that is a 500
    // for what is a client error, and it is trivially reachable — this route is called directly.
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body", code: "INVALID_BODY" }, 400);
    }

    // See MAX_MESSAGE_CHARS above for why these bounds live here and not only in the portal.
    if (typeof body.content !== "string" || body.content.length === 0) {
      return c.json(
        { error: "content is required and must be a string", code: "INVALID_CONTENT" },
        400
      );
    }
    if (body.content.length > MAX_MESSAGE_CHARS) {
      return c.json(
        {
          error: `content exceeds ${MAX_MESSAGE_CHARS} characters`,
          code: "CONTENT_TOO_LONG",
          cap: MAX_MESSAGE_CHARS,
        },
        400
      );
    }
    // Absent is fine and means TEXT, matching the portal schema's `.default("TEXT")`; present and
    // off-enum is a refusal rather than a silent store.
    if (body.type !== undefined && !MESSAGE_TYPES.has(body.type)) {
      return c.json(
        {
          error: `type must be one of ${[...MESSAGE_TYPES].join(", ")}`,
          code: "INVALID_MESSAGE_TYPE",
        },
        400
      );
    }
    if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== "string") {
      return c.json({ error: "parentId must be a string", code: "INVALID_PARENT_ID" }, 400);
    }

    const now = new Date().toISOString();
    const messageId = ulid();

    const message = await deps.messages.put({
      teamId,
      createdAt: now,
      id: messageId,
      type: body.type || "TEXT",
      content: body.content,
      /**
       * ⚠ NO LONGER TAKEN FROM THE BODY. It was `body.metadata || null`: an arbitrary object,
       * unbounded, sitting next to a content field that now has a ceiling — so it was the way
       * round the ceiling.
       *
       * The portal removed the same field from its schema for the same reason and recorded why:
       * "a field with no writer and no schema is not a feature to bound, it is a hole to close".
       * Nothing sends it — the chat composer posts { teamId, content }, and the desktop REST door
       * keeps metadata off its shared shape — so accepting it only preserved the hole.
       *
       * ⚠ WRITE PATH ONLY. `MessageRecord.metadata` stays on the READ path, exactly as the portal
       * kept it: rows written before this change may carry one, and dropping it from reads would
       * lose data rather than protect anything.
       */
      metadata: null,
      senderId: id,
      parentId: body.parentId || null,
    });

    // Push to any connected SSE listeners for this team (real-time, no polling).
    publishTeamEvent({
      kind: "message",
      teamId,
      actorId: id,
      createdAt: now,
      id: messageId,
      content: message.content,
      type: message.type,
    });

    // Cross-service notification travels as an event, not a direct call.
    await deps.events.publish({
      source: "collaboration-service",
      type: "message.sent",
      // `userId` mirrors `senderId`: the activity projection reads `userId` and dropped every
      // one of these. `senderId` stays for readers that already use it — additive, not a rename.
      detail: { messageId, teamId, senderId: id, userId: id, type: message.type },
    });

    return c.json({ message }, 201);
  });

  // NOTE: real-time team events (messages + board tasks) are no longer streamed
  // over an SSE route here. They're delivered over a WebSocket on the same path,
  // /v1/teams/:teamId/events, handled outside Hono (see ws-server.ts, attached to
  // the http server in local.ts / handler). The mutation routes above still call
  // publishTeamEvent(...) — the WS layer subscribes to that same live-bus.

  return app;
}
