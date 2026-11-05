// ── DOWNLOAD THE CSV TEMPLATE ────────────────────────────────────────────────────────────
//
// A GET beside the upload POST, so the two live at the same path and cannot drift in the operator's
// mental model: you fetch the template from where you send it back.
//
// The body is generated from the validator's own constants (see template.ts), so it can never
// document a limit the code does not enforce.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/server-token";
import { buildBulkInviteTemplate, TEMPLATE_FILENAME } from "@/lib/bulk-invite/template";

/** Same gate as the upload it feeds, see the POST route. */
const MAY_BULK_UPLOAD = new Set(["ADMIN", "FACILITATOR"]);

export async function GET(req: Request) {
  /**
   * ⚠ THE BEARER COMES FROM THE JWE COOKIE, NOT FROM THE SESSION OBJECT. It used to read
   * `session?.accessToken`, which required copying the Cognito ID token onto the session, and in
   * Auth.js v5 the session object is also the body of the public `GET /api/auth/session` that every
   * page fetches. Same value, read one tier lower.
   */
  const [session, token] = await Promise.all([auth(), getAccessToken(req)]);
  /**
   * ⚠ BOTH, EXPLICITLY. The old `if (!session?.accessToken)` made the session's presence implicit
   * in the token's, one read, so one check. Now that identity and bearer come from two calls, the
   * bearer alone must not authorize: everything below reads `session.user` for the role gate.
   */
  if (!token || !session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
   * ⚠ GATED, EVEN THOUGH THE TEMPLATE IS NOT SECRET.
   *
   * It contains no data, it is a header row and three fictional examples. The reason to gate it is
   * not confidentiality but honesty: handing a participant a template for an action the server will
   * refuse invites them to fill in fifteen rows and then be told 403. Same reason the "Create Team"
   * button is hidden from anyone who cannot create one.
   */
  const role = session.user?.role;
  if (!role || !MAY_BULK_UPLOAD.has(role)) {
    return NextResponse.json(
      { error: "Only an admin or a facilitator can bulk upload teams." },
      { status: 403 }
    );
  }

  return new NextResponse(buildBulkInviteTemplate(), {
    status: 200,
    headers: {
      // `text/csv` + `attachment` so the browser saves it rather than rendering it as a page.
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${TEMPLATE_FILENAME}"`,
      /**
       * ⚠ NEVER CACHED. The template is generated from constants that change with the code, so a
       * cached copy is a document that quietly disagrees with the validator, exactly the drift the
       * generate-from-constants design exists to prevent. A CDN or browser holding yesterday's caps
       * would reintroduce it from the outside.
       */
      "Cache-Control": "no-store, must-revalidate",
      // Defence in depth: it is a download, not a document to be sniffed into something executable.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
