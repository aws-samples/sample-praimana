import { NextResponse } from "next/server";
import { BACKEND_ORIGIN, backendTimeoutFor } from "@/lib/backend";
import { getAccessToken } from "@/lib/server-token";
import { sanitizeErrorMessage } from "@/lib/sanitize-error";

/**
 * ⚠ IMPORTED RATHER THAN RE-READ FROM THE ENVIRONMENT, AND THAT IS THE FIX. This route had its own
 * `process.env.BACKEND_URL` const, so `@/lib/backend` never entered its module graph, which meant
 * `validateBackendUrl` (the module-load assertion that BACKEND_URL is https or loopback) NEVER RAN
 * on the one route that forwards a user's Cognito ID token to that origin. Importing the validated
 * binding runs it.
 */

/**
 * Session-authenticated desktop-installer download.
 *
 * This is the browser entry point the /welcome page links at with a plain
 * <a href>. A link can't send an Authorization header, so, unlike the other
 * /api/desktop/* routes (which the desktop app calls WITH a bearer, guarded by
 * withBearer), this one reads the NextAuth SESSION to get the user's ID token,
 * then forwards it as the bearer to the backend's authenticated
 * /v1/desktop/download.
 *
 * The backend responds 302 → a short-lived presigned S3 URL. We pass that
 * redirect straight through to the browser (redirect: "manual" so fetch doesn't
 * follow it server-side and stream the 100 MB+ installer through this process).
 *
 *   GET /api/desktop/download?platform=macos|windows
 */
export async function GET(req: Request) {
  /**
   * ⚠ THE BEARER COMES FROM THE JWE COOKIE, NOT FROM THE SESSION OBJECT. It used to read
   * `session?.accessToken`, which required copying the Cognito ID token onto the session, and in
   * Auth.js v5 the session object is also the body of the public `GET /api/auth/session` that every
   * page fetches. Same value, read one tier lower.
   */
  const token = await getAccessToken(req);
  if (!token) {
    // No session → send them to sign in first (they land here from /welcome,
    // which is already behind auth, but be defensive).
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get("platform");
  if (platform !== "macos" && platform !== "windows") {
    return NextResponse.json(
      { error: "platform must be macos or windows" },
      { status: 400 }
    );
  }

  const path = `/v1/desktop/download?platform=${encodeURIComponent(platform)}`;
  const res = await fetch(`${BACKEND_ORIGIN}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    // Don't follow the backend's 302 here, we want to hand the presigned URL
    // to the BROWSER, not pull the installer bytes through this server.
    redirect: "manual",
    /**
     * ⚠ A DEADLINE, WHICH THIS ROUTE WAS MISSING ENTIRELY. `backend.ts` establishes that every
     * BFF→service call is bounded because "a hung dependency must not hold a Lambda open", and
     * because this route hand-rolls its `fetch` (it needs `redirect: "manual"`, which `backendFetch`
     * does not offer) it never inherited one. A hung backend held an Amplify SSR request open
     * indefinitely, reachable by any signed-in user. Same derivation as every other call, so the
     * per-prefix values apply here too.
     */
    signal: AbortSignal.timeout(backendTimeoutFor(path)),
  });

  // Happy path: backend 302 → presigned S3 URL. Re-issue it to the browser.
  const location = res.headers.get("location");
  if ((res.status === 302 || res.status === 301) && location) {
    return NextResponse.redirect(location, 302);
  }

  // No installer published yet (404) or any other backend error, surface a
  // safe message rather than forwarding raw upstream text that may contain
  // infrastructure details.
  const body = await res.text();
  let message = "Download unavailable";
  try {
    message = (JSON.parse(body).error as string) || message;
  } catch {
    /* keep default */
  }
  return NextResponse.json(
    { error: sanitizeErrorMessage(message, res.status || 502) },
    { status: res.status || 502 }
  );
}
