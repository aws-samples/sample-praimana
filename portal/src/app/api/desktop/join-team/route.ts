import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";
import { withBearer, errorResponse } from "@/lib/apiAuth";
import { auditLog } from "@/lib/audit-logger";
import { joinTeamSchema } from "@/lib/team-write-schemas";

/**
 * `POST /api/desktop/join-team`, redeem an invite code for a membership.
 *
 * ⚠ THIS IS THE MOST CONSEQUENTIAL WRITE IN THE DESKTOP TIER AND IT WAS UNAUDITED. A membership
 * row is the gate on ALL team content, so "who joined this team, with which code, and when" is
 * exactly the question a later investigation asks, and this route answered it nowhere. The event
 * below is emitted AFTER the service accepts, so it records joins that actually happened rather
 * than attempts.
 *
 * ⚠ `req.json()` IS INSIDE THE PARSE, NOT ABOVE THE `try`. Malformed JSON surfaced as a 500; it
 * is a client error and now answers 400, the same as a missing code (which the schema's `.min(1)`
 * preserves).
 */
export const POST = withBearer(async (req, token, identity) => {
  const parsed = joinTeamSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invite code required" }, { status: 400 });
  }
  const { inviteCode } = parsed.data;

  try {
    const data = await backendFetch("/v1/teams/join", {
      method: "POST",
      body: JSON.stringify({ inviteCode }),
      token,
    });

    /**
     * ⚠ THE CODE ITSELF IS NOT LOGGED. It is a live credential until it is spent, recording it
     * would put a usable join token in the log stream, which is the one thing this module refuses
     * to do (see `audit-logger.ts`, "What it deliberately does NOT log"). The team it granted is
     * the fact worth keeping; the invitation row upstream is what ties that back to a code.
     *
     * ⚠ THE ACTOR IS THE VERIFIED `sub`, NOT A DECODED CLAIM. This event used to name whatever
     * subject the caller asserted, because the door admitted on header presence alone, on the one
     * write that creates the row gating all team content. `withBearer` now verifies the ID token
     * before this handler runs, so the id below is established identity.
     */
    auditLog({
      event: "desktop.team.joined",
      actor: { id: identity.id, role: identity.role },
      target: { teamId: data.team?.id, workshopId: data.team?.workshopId },
      outcome: "success",
      metadata: { actorVerified: true },
    });

    return NextResponse.json({
      teamId: data.team.id,
      teamName: data.team.name,
      workshopId: data.team.workshopId,
    });
  } catch (err) {
    // A bad/unrecognized invite code surfaces as a backend 4xx; preserve it
    // (defaulting to 400) rather than reporting a generic 500.
    return errorResponse(err, 400);
  }
});
