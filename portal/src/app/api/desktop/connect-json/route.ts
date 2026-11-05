import { NextResponse } from "next/server";
import { getAccessToken } from "@/lib/server-token";

/**
 * Serve the experience's desktop config as a downloadable `connect.json`.
 *
 * The run-from-source desktop app reads a `connect.json` placed next to its start script to learn
 * which deployment it belongs to. This route hands the user that file: the SAME four values the
 * `desktop.connectLink` tRPC procedure builds its praimana:// link from, portal URL, API origin,
 * Cognito pool id and app client id. None is secret (the pool and client ids travel in every OAuth
 * redirect; AWS publishes the pool endpoints unauthenticated), but like the other /api/desktop/*
 * browser entry points this still requires a session so a deployment cannot be enumerated anonymously.
 *
 * A plain browser navigation (an <a href> / download attribute) rather than a tRPC call, because a
 * link cannot carry a bearer and the result is a file, not JSON for the UI.
 *
 *   GET /api/desktop/connect-json
 */
export async function GET(req: Request) {
  // Behind auth: /welcome is already gated, but be defensive, this names the tenant pool.
  const token = await getAccessToken(req);
  if (!token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Same source of truth as src/lib/trpc/routers/desktop.ts connectLink, read here rather than
  // calling that procedure so the file download does not depend on the tRPC transport.
  const apiBaseUrl = (
    process.env.DESKTOP_API_BASE_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL ||
    ""
  ).trim();
  const portalUrl = (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
  const poolId = (process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "").trim();
  const clientId = (process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "").trim();

  const missing = [
    !apiBaseUrl && "DESKTOP_API_BASE_URL",
    !portalUrl && "NEXTAUTH_URL",
    !poolId && "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
    !clientId && "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  ].filter(Boolean);
  if (missing.length) {
    // Named in the server log for the deployer; generic to the client.
    console.error(`[desktop.connect-json] cannot build connect.json, missing: ${missing.join(", ")}`);
    return NextResponse.json(
      { error: "Desktop connect config is not set up on this platform yet." },
      { status: 412 }
    );
  }

  // Strip trailing slashes so `${apiBaseUrl}/v1/...` never yields a double slash, matches the
  // normalisation the shared link builder applies.
  const normalise = (s: string) => s.replace(/\/+$/, "");

  const body = JSON.stringify(
    {
      portalUrl: normalise(portalUrl),
      apiBaseUrl: normalise(apiBaseUrl),
      poolId,
      clientId,
    },
    null,
    2
  );

  return new NextResponse(body + "\n", {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="connect.json"',
      // Config can change per deployment; never let a browser cache a stale tenant pointer.
      "cache-control": "no-store",
    },
  });
}
