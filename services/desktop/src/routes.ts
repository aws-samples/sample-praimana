import { Hono } from "hono";
import { edgeIdentityMiddleware, requireIdentity } from "@praimana/service-shared";
import {
  type InstallerStore,
  type Platform,
  PLATFORMS,
  isPlatform,
} from "./domain.js";

/**
 * Desktop-installer service routes. Constructor-style dependency injection: the
 * routes depend on the InstallerStore INTERFACE, never on the S3 SDK — wiring
 * lives in app.ts, tests pass an in-memory fake.
 *
 * Mounted under basePath /v1 behind the edge JWT authorizer. Every route
 * requires a verified identity (any signed-in platform role may download the
 * app — the /welcome page is the participant entry point, but staff install it
 * too). We do NOT gate on role or team membership: the installer is the same
 * bytes for everyone; the account gate is enough.
 *
 * The installers themselves live in the SHARED account's private artifact
 * bucket. We never stream the bytes (100 MB+ installers exceed API Gateway's
 * response limits) — instead we hand back a short-lived presigned S3 URL and
 * 302 the download to it.
 */
export interface DesktopDeps {
  store: InstallerStore;
  /** Presigned-URL lifetime. Short — the browser follows the redirect at once. */
  presignTtlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 15 * 60;

export function createDesktopRoutes(deps: DesktopDeps) {
  const ttl = deps.presignTtlSeconds ?? DEFAULT_TTL_SECONDS;
  const desktop = new Hono().basePath("/v1");

  // Every request must carry a gateway-injected (or in-service verified) identity.
  desktop.use("*", edgeIdentityMiddleware());

  // What's published, per platform — a JSON summary the /welcome page can use to
  // show a real filename/size (or hide the button when nothing is published yet).
  // Does not presign; it's cheap metadata.
  desktop.get("/desktop/releases", async (c) => {
    requireIdentity(c); // gate: authenticated only
    const entries = await Promise.all(
      PLATFORMS.map(async (platform) => {
        const obj = await deps.store.latest(platform);
        return [platform, obj] as const;
      })
    );
    // { macos: {...}|null, windows: {...}|null }
    const releases = Object.fromEntries(entries) as Record<
      Platform,
      Awaited<ReturnType<InstallerStore["latest"]>>
    >;
    return c.json({ releases });
  });

  // Download the latest installer for a platform. Resolves the newest object,
  // presigns it, and 302-redirects the browser to the presigned URL.
  //   GET /v1/desktop/download?platform=macos|windows
  desktop.get("/desktop/download", async (c) => {
    requireIdentity(c); // gate: authenticated only

    const platform = c.req.query("platform");
    if (!isPlatform(platform)) {
      return c.json(
        { error: `platform must be one of: ${PLATFORMS.join(", ")}` },
        400
      );
    }

    const obj = await deps.store.latest(platform);
    if (!obj) {
      return c.json({ error: `No ${platform} installer published yet` }, 404);
    }

    const url = await deps.store.presign(obj.key, ttl);
    // 302 (not 301): the presigned URL is single-use-ish and time-boxed, so the
    // redirect must never be cached as permanent.
    return c.redirect(url, 302);
  });

  return desktop;
}
