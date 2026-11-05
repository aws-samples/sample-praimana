import { NextResponse } from "next/server";
import { backendFetch } from "@/lib/backend";
import { withBearer, errorResponse } from "@/lib/apiAuth";
import { auditLog } from "@/lib/audit-logger";
import { sendMessageSchema } from "@/lib/team-write-schemas";

/**
 * `POST /api/desktop/send-message`, the desktop client's door onto team chat.
 *
 * ⚠ THE BODY IS PARSED AGAINST THE SAME SCHEMA THE tRPC DOOR USES, AND IT USED TO BE FORWARDED
 * VERBATIM. This handler destructured `{ teamId, content, type }`, checked only that `teamId` was
 * a non-empty string, and posted `content` unbounded to the same sink `message.send` guards with
 * `.max(MAX_TEAM_MESSAGE_CHARS)`. `chat-limits.ts` records that the tRPC schema is the ONLY
 * length bound in the system, the collaboration service stores `content: body.content` with no
 * check, so this was a hole in the only copy, not a missing second copy. See
 * `lib/team-write-schemas.ts`.
 *
 * ⚠ `req.json()` IS INSIDE THE PARSE, NOT ABOVE THE `try`. Malformed JSON used to throw before
 * the `try` and surface as a 500; a syntactically invalid body is a client error and now answers
 * 400 like every other invalid body.
 */
export const POST = withBearer(async (req, token, identity) => {
  const parsed = sendMessageSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { teamId, ...message } = parsed.data;

  try {
    const data = await backendFetch(`/v1/teams/${encodeURIComponent(teamId)}/messages`, {
      method: "POST",
      body: JSON.stringify(message),
      token,
    });

    /**
     * The desktop tier's writes were entirely absent from the audit trail, so nothing recorded
     * who posted into a team's chat from this door.
     *
     * ⚠ THE ACTOR IS THE VERIFIED `sub`, NOT A DECODED CLAIM, `withBearer` verifies the ID token
     * before this handler runs. This carried `actorVerified: false` while the door admitted on
     * header presence alone.
     */
    auditLog({
      event: "desktop.message.sent",
      actor: { id: identity.id, role: identity.role },
      target: { teamId },
      outcome: "success",
      metadata: { actorVerified: true, type: message.type, contentChars: message.content.length },
    });

    return NextResponse.json(data.message);
  } catch (err) {
    return errorResponse(err);
  }
});
