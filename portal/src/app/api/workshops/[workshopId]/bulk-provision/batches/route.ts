// ── BULK UPLOAD HISTORY ──────────────────────────────────────────────────────────────────
//
// The uploads for one experience, newest first, with what became of each.
//
// ⚠ THIS ROUTE EXISTS BECAUSE "ACCEPTED" WAS THE LAST THING ANYONE EVER LEARNED ABOUT A BATCH. Making
// the work asynchronous bought the facilitator their time back and cost them all
// visibility: the panel said "we'll email you", and from that moment the only record was in a Lambda
// log group. The first real upload proved the cost, every team was refused by a broken east-west hop,
// the requester's email was empty so no report could be sent, and the screen still said "Accepted".
//
// ⚠ A PURE PASS-THROUGH, AND IT MUST STAY ONE. The Team service is the authority on who may read this,
// because the row names the addresses of everyone in somebody's file. This handler checks the ROLE as
// a cheap early rejection and re-presents the caller's token; it does NOT decide ownership, which needs
// the Workshop service, exactly as the upload route does not.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/server-token";
import { backendFetch, BackendError } from "@/lib/backend";

/** The same two roles that may upload. A read of the trail is gated no more loosely than a write. */
const MAY_VIEW = new Set(["ADMIN", "FACILITATOR"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ workshopId: string }> }
) {
  const { workshopId } = await params;

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

  const role = session.user?.role;
  if (!role || !MAY_VIEW.has(role)) {
    return NextResponse.json(
      { error: "Only an admin or the facilitator who owns this experience can view upload history." },
      { status: 403 }
    );
  }

  try {
    const body = (await backendFetch(
      `/v1/workshops/${encodeURIComponent(workshopId)}/bulk-provision/batches`,
      { token }
    )) as { batches?: unknown[] };
    return NextResponse.json({ batches: body?.batches ?? [] });
  } catch (err) {
    /**
     * ⚠ AN EMPTY LIST ON A 404, NOT AN ERROR. A 404 means the Team route is not deployed here, i.e.
     * bulk upload is not enabled, for which "no uploads yet" is TRUE, and is what the panel should
     * say. Surfacing a fault would put a red error on a page for a feature the operator has not used.
     *
     * ⚠ EVERY OTHER FAILURE IS REPORTED. "No uploads" and "we cannot tell you about your uploads" are
     * different facts, and showing an empty list for the second is precisely the lie this whole feature
     * exists to stop telling: a facilitator would read it as "my upload never happened".
     */
    if (err instanceof BackendError && err.status === 404) {
      return NextResponse.json({ batches: [] });
    }

    const status = err instanceof BackendError ? err.status : 502;
    console.error("[bulk-provision] could not read the upload history", {
      workshopId,
      status,
      error: err instanceof Error ? err.message : err,
    });

    return NextResponse.json(
      { error: "We could not load the upload history. This does not affect any upload in progress." },
      { status: status === 403 ? 403 : 502 }
    );
  }
}
