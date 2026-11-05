import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import { buildDesktopConnectLink, DEEP_LINK_SCHEME } from "@praimana/shared";

/** One published installer, per platform (mirrors the desktop service). */
type InstallerObject = {
  platform: "macos" | "windows";
  key: string;
  filename: string;
  size: number;
  lastModified: string;
};

type Releases = {
  macos: InstallerObject | null;
  windows: InstallerObject | null;
};

/**
 * Desktop router, reports which installers are published so the welcome page can
 * show a real download button per platform (and hide it when nothing is published
 * yet). The actual download is NOT done here: it's a plain browser navigation to
 * /api/desktop/download?platform=… (a link can't carry a tRPC/bearer call, and the
 * installer is a 302 to a presigned S3 URL, not JSON). This query is just the
 * metadata that decides what buttons to render.
 */
export const desktopRouter = router({
  releases: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch("/v1/desktop/releases", { token: ctx.token });
    return (data.releases || { macos: null, windows: null }) as Releases;
  }),

  /**
   * ── THE LINK THAT CONFIGURES THE DESKTOP APP ──
   *
   * `/welcome` renders this behind "Open desktop app". It tells a fresh install which platform
   * it belongs to; the user then signs in with the app's own form.
   *
   * ⚠ IT DOES NOT HAND OVER A SESSION, and cannot. Measured rather than assumed: the portal's
   * SRP login leaves no Cognito Hosted UI session, and `AdminInitiateAuth` returns
   * `Auth flow not enabled for this client` against the live pool. There is no grant by which
   * this server can mint a token for another client, so an earlier revision's one-time code -
   * and the store, the claim endpoint and the table behind it, are all deleted.
   *
   * ⚠ STILL `protectedProcedure`. Nothing here is secret (the pool and client ids travel in
   * every OAuth redirect, and AWS publishes the endpoints unauthenticated), but serving it
   * publicly would let anyone confirm that a domain is a Praimana deployment and read
   * its tenant pool. That enumeration surface is exactly what is ruled out.
   *
   * A QUERY, not a mutation: it creates nothing and is safe to cache and refetch. The version
   * that minted a single-use code had to be a mutation for precisely the opposite reason.
   */
  connectLink: protectedProcedure.query(() => {
    const apiBaseUrl = (
      process.env.DESKTOP_API_BASE_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      process.env.BACKEND_URL ||
      ""
    ).trim();
    const portalUrl = (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
    const poolId = (process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "").trim();
    const clientId = (process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "").trim();

    // Named in the SERVER LOG, generic to the client: a deployer needs to know which variable
    // to set; a signed-in participant does not need an inventory of our environment.
    const missing = [
      !apiBaseUrl && "DESKTOP_API_BASE_URL",
      !portalUrl && "NEXTAUTH_URL",
      !poolId && "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
      !clientId && "NEXT_PUBLIC_COGNITO_CLIENT_ID",
    ].filter(Boolean);
    if (missing.length) {
      console.error(`[desktop.connectLink] cannot build a link, missing: ${missing.join(", ")}`);
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Desktop sign-in is not configured on this platform yet.",
      });
    }

    try {
      return {
        /**
         * Built by the SHARED helper, which validates both origins (HTTPS unless loopback) on
         * the way out, so a misconfigured deployment fails here rather than shipping a link
         * that would send a bearer over plaintext.
         */
        link: buildDesktopConnectLink({ portalUrl, apiBaseUrl, poolId, clientId }),
        scheme: DEEP_LINK_SCHEME,
      };
    } catch (err) {
      console.error("[desktop.connectLink] refusing to build a malformed link:", err);
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Desktop sign-in is not configured correctly on this platform.",
      });
    }
  }),
});
