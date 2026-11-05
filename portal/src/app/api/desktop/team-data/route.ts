import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";
import { withBearer, errorResponse } from "@/lib/apiAuth";
import { isActiveMember } from "@/lib/team-members";
import { desktopTeamDataRateLimiter } from "@/lib/rate-limit";
import type { TeamMemberRecord } from "@/lib/backend-types";

/**
 * `GET /api/desktop/team-data`, board, chat and roster in one call for the desktop client.
 *
 * ⚠ THREE UPSTREAM CALLS PER REQUEST, SO THE ORDER OF THE GUARDS IS THE POINT. This route was the
 * desktop tier's amplification primitive (a security finding): `withBearer` admitted on
 * header presence, so `Authorization: Bearer x` with any `teamId` dispatched the `Promise.all`
 * below before any identity existed, three `/v1/*` requests per anonymous HTTP request, refused
 * upstream only after the work was already in flight. Two changes close it: `withBearer` now
 * VERIFIES the ID token, and the limiter below runs BEFORE the fan-out rather than after it.
 */
export const GET = withBearer(async (req, token, identity) => {
  const { searchParams } = new URL(req.url);
  const teamId = searchParams.get("teamId");

  if (!teamId) {
    return NextResponse.json({ error: "teamId required" }, { status: 400 });
  }

  /**
   * Keyed on the VERIFIED `sub`, meaningful only because verification now happens at the door.
   * Checked before the fan-out, so a caller over the limit costs one comparison rather than three
   * backend round trips.
   */
  const limit = desktopTeamDataRateLimiter.check(identity.id);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } }
    );
  }

  const encodedTeamId = encodeURIComponent(teamId);

  try {
    const [tasks, messages, members] = await Promise.all([
      backendFetch(`/v1/teams/${encodedTeamId}/tasks`, { token }),
      backendFetch(`/v1/teams/${encodedTeamId}/messages?limit=50`, { token }),
      backendFetch(`/v1/teams/${encodedTeamId}/members`, { token }),
    ]);

    return NextResponse.json({
      tasks: tasks.tasks || [],
      messages: messages.messages || [],
      /**
       * ACTIVE members only. `GET /v1/teams/:teamId/members` returns INACTIVE rows
       * deliberately, it is the roster route that has to offer a Reactivate action, so
       * every consumer that wants the LIVE team has to exclude them. This route does not
       * go through the tRPC router, so it does not inherit that layer's filter and has to
       * apply the rule itself; the desktop renders these as the team's people (BoardView's
       * `Member`), and a removed person appearing among them is the same defect reported on
       * the web roster.
       *
       * ⚠ THE PREDICATE IS IMPORTED, NOT RE-EXPRESSED. These two lines were an inline copy of
       * the comparison in `trpc/routers/team.ts`, made because a `const` inside a router is not
       * importable from a route. Two copies of one rule is how the fourth consumer
       * (`workshop.getById`) came to have none, see `lib/team-members.ts` for the polarity
       * reasoning, which is the same here.
       */
      members: ((members.members || []) as TeamMemberRecord[]).filter(isActiveMember),
    });
  } catch (err) {
    return errorResponse(err);
  }
});
