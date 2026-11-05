import { NextResponse } from "next/server";
import {
  cognitoLogoutUrl,
  POST_LOGOUT_PATH,
} from "@/lib/cognito-logout";

/**
 * Second hop of sign-out: end the Cognito Hosted UI session.
 *
 * NextAuth's `signOut()` clears only this app's cookie. It hands off here (as its
 * post-signout redirect), and we 302 the browser to Cognito's /logout so the IdP
 * drops ITS session cookie too. Without this hop the next sign-in silently reuses
 * the live Hosted UI session and never prompts for credentials, the user appears
 * to be signed out while they are one click from a full session.
 *
 * A GET route, deliberately: this is a browser NAVIGATION target, not an API call.
 * It is listed under the /api/auth prefix, which middleware.ts already treats as
 * public, correct here, because by the time the browser arrives the local session
 * is already gone, so requiring a session would 302 to /login and skip the
 * Cognito logout entirely, reintroducing the exact bug.
 *
 * Not a security boundary and not destructive beyond ending a session: the only
 * effect of an unauthenticated hit is a redirect to Cognito's /logout, which
 * clears whatever session that browser holds. That is the intended outcome.
 *
 * These are read at REQUEST time, not module scope, so the route reflects the
 * runtime env under Amplify SSR (where env vars land in .env.production) rather
 * than whatever was present when the module was first evaluated.
 */
export async function GET(req: Request) {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    new URL(req.url).origin;

  const logoutUrl = cognitoLogoutUrl({
    hostedUiDomain: process.env.COGNITO_HOSTED_UI_DOMAIN || "",
    clientId: process.env.COGNITO_CLIENT_ID || "",
    appUrl,
  });

  // Incomplete Cognito env (possible in local dev): the local session is ALREADY
  // cleared by the time we're called, so the user is genuinely signed out of this
  // app. Land them on /login rather than on a malformed Cognito URL.
  if (!logoutUrl) {
    return NextResponse.redirect(new URL(POST_LOGOUT_PATH, req.url));
  }

  // 302, and explicitly no-store: a cached redirect to /logout would be harmless
  // but a cached response here could let a browser skip the IdP round-trip.
  return NextResponse.redirect(logoutUrl, {
    status: 302,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
