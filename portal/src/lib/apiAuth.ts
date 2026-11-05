import { NextResponse } from "next/server";
import { BackendError } from "@/lib/backend";
import { genericMessage, sanitizeErrorMessage } from "@/lib/sanitize-error";
import { verifyCognitoIdToken, type VerifiedCognitoIdentity } from "@/lib/cognito-verify";
import { auditLog } from "@/lib/audit-logger";

/**
 * Extract a bearer token from a request's Authorization header, or null if it
 * is missing/malformed. Single definition so no route re-implements the
 * `startsWith("Bearer ")` + `slice(7)` dance (D5).
 */
export function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

type BearerHandler = (
  req: Request,
  token: string,
  identity: VerifiedCognitoIdentity
) => Promise<Response> | Response;

/**
 * Wrap a route handler so it only runs for a bearer token this tier has VERIFIED, passing both
 * the raw token (to forward upstream) and the identity it proves. Otherwise responds 401.
 *
 * ── ⚠ THIS USED TO ADMIT ON HEADER PRESENCE ALONE, AND THAT WAS THE FINDING ───────────────────
 *
 * The previous implementation returned 401 only when the `Authorization` header was missing or
 * did not start with `Bearer `: `Authorization: Bearer x` was accepted. No signature, no issuer,
 * no audience, no expiry, no `token_use`. The reasoning was that the service receiving the
 * forwarded token is the verifier, true, and it does mean no team CONTENT leaked, which is why
 * the finding was rated medium rather than high. But it left three things this
 * tier owns and only this tier can fix:
 *
 *   1. AMPLIFICATION BEFORE REFUSAL. `GET /api/desktop/team-data` fires three concurrent
 *      `/v1/*` calls before any identity exists, so an anonymous caller with `Bearer x` and any
 *      `teamId` drove three upstream requests per HTTP request. The upstream 401s arrived after
 *      the work was already dispatched.
 *   2. UNATTRIBUTABLE AUDIT RECORDS. The actor id came from `decodeJwt`, a claim, not an
 *      identity, so the trail named subjects the caller merely asserted.
 *   3. LOCAL DECISIONS ON AN ASSERTED IDENTITY, e.g. the ACTIVE-member filter in `team-data`.
 *
 * ⚠ THE VERIFIER WAS ALREADY IN THIS TREE, UNUSED HERE. `verifyCognitoIdToken` checks the JWKS
 * signature, `iss`, `aud`, `exp`/`nbf`, `token_use: "id"` and a non-empty `sub`, and it fails
 * CLOSED when unconfigured. It was applied only by the credentials provider in `lib/auth.ts`.
 *
 * ⚠ THE AUDIENCE PIN IS WHY THIS IS SAFE FOR THE DESKTOP CLIENT: the desktop app is configured
 * with `NEXT_PUBLIC_COGNITO_CLIENT_ID` (see `trpc/routers/desktop.ts`'s `connectLink`), the same
 * app client the portal verifies against, so its ID tokens satisfy `aud`. A desktop build pointed
 * at a DIFFERENT app client would now 401 here, deliberately, and visibly at the door rather
 * than three upstream calls later.
 */
export function withBearer(handler: BearerHandler) {
  return async (req: Request): Promise<Response> => {
    const token = getBearerToken(req);
    const identity = await verifyCognitoIdToken(token);

    if (!token || !identity) {
      /**
       * ⚠ THE REFUSAL IS RECORDED, because a rejected credential against the tier that mints team
       * memberships is exactly the attempt an investigation asks about, and the old code refused
       * nothing, so there was nothing to record. No token material and no claimed subject: an
       * unverified `sub` is what this change exists to stop putting in the trail.
       */
      auditLog({
        event: "authz.desktop.unauthorized",
        outcome: "denied",
        reason: token
          ? "Bearer token failed Cognito ID-token verification"
          : "No bearer token presented",
        metadata: { path: new URL(req.url).pathname },
      });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return handler(req, token, identity);
  };
}

/**
 * Turn a caught error into a JSON response, preserving the backend HTTP status
 * when the failure came from `backendFetch` (a {@link BackendError}) instead of
 * flattening everything to 500. Keeps the status code meaningful to the desktop
 * client (e.g. a 403 stays a 403, a 404 stays a 404).
 *
 * ⚠ SANITIZATION: error messages are scrubbed of sensitive content (AWS ARNs,
 * account IDs, internal hostnames, etc.) before being returned to the caller.
 * See `sanitize-error.ts` for the full rationale.
 */
export function errorResponse(err: unknown, fallbackStatus = 500): NextResponse {
  if (err instanceof BackendError) {
    // Upstream text: subject to the default-deny rule. `err.code` being present is what lets a
    // service's own hand-written refusal through; without it the caller gets a generic message.
    return NextResponse.json(
      { error: sanitizeErrorMessage(err.message, err.status, err.code), code: err.code },
      { status: err.status }
    );
  }
  /**
   * ⚠ NOT AN UPSTREAM ERROR, SO IT NEVER PASSES THROUGH. This branch is reached by an exception
   * thrown INSIDE the route handler: a TypeError, a JSON parse failure, an AWS SDK error from a
   * direct client call. None of those was written for a reader and any of them can name a
   * resource, a bucket or an ARN, so `genericMessage` replaces the text outright rather than
   * asking the sanitiser whether it looks dangerous. The original is still logged server-side by
   * whatever raised it.
   */
  const status = fallbackStatus;
  return NextResponse.json({ error: genericMessage(status) }, { status });
}
