import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";
import { withBearer, errorResponse } from "@/lib/apiAuth";
import { auditLog } from "@/lib/audit-logger";
import { createTaskSchema } from "@/lib/team-write-schemas";

/**
 * `POST /api/desktop/create-task`, the desktop client's door onto a team's board.
 *
 * ⚠ THE BODY IS PARSED AGAINST THE SAME SCHEMA THE tRPC DOOR USES, AND IT USED TO BE FORWARDED
 * VERBATIM. `title`/`description`/`status`/`priority` went straight through to the same
 * `/v1/teams/:id/tasks` that `task.create` bounds at 200/2000 with enums on both status fields.
 * An off-enum `status` produced a task that renders in NO board column, `board/page.tsx` filters
 * strictly on the five, while still existing in the store and counting in activity denominators,
 * i.e. board state a writer could hide from every portal reader. See
 * `lib/team-write-schemas.ts`.
 *
 * ⚠ `req.json()` IS INSIDE THE PARSE, NOT ABOVE THE `try`, malformed JSON was a 500 and is now
 * a 400.
 */
export const POST = withBearer(async (req, token, identity) => {
  const parsed = createTaskSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { teamId, ...task } = parsed.data;

  try {
    const data = await backendFetch(`/v1/teams/${encodeURIComponent(teamId)}/tasks`, {
      method: "POST",
      body: JSON.stringify(task),
      token,
    });

    /**
     * ⚠ THE ACTOR IS THE VERIFIED `sub`, NOT A DECODED CLAIM, `withBearer` verifies the ID token
     * before this handler runs. This carried `actorVerified: false` while the door admitted on
     * header presence alone.
     */
    auditLog({
      event: "desktop.task.created",
      actor: { id: identity.id, role: identity.role },
      target: { teamId },
      outcome: "success",
      metadata: { actorVerified: true, status: task.status, priority: task.priority },
    });

    return NextResponse.json(data.task);
  } catch (err) {
    return errorResponse(err);
  }
});
