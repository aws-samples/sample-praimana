import type { NextConfig } from "next";
import { cognitoConnectSrc } from "./src/lib/csp";

/**
 * ── ⚠ THE CSP LIVES IN `src/lib/csp.ts` AND IS EMITTED BY `src/middleware.ts`, NOT HERE ─────────
 *
 * It used to be a static string in the `headers()` block below, and its production `script-src`
 * carried `'unsafe-inline'` — which permits exactly the injection the directive exists to prevent
 * (a security finding). Closing it needs a PER-REQUEST nonce, and
 * `headers()` is evaluated once at build time, so it cannot produce one.
 *
 * ⚠ THE CSP MUST BE SET IN EXACTLY ONE PLACE. Two `Content-Security-Policy` headers are INTERSECTED
 * by the browser rather than overridden, so keeping a nonce-less copy here as a "fallback" would
 * yield a policy allowing neither inline scripts nor the nonce — a blank page. The other security
 * headers stay below: they are static, and they apply to every response including static assets.
 *
 * ⚠ THIS CALL EXISTS SO THE CONNECT-SRC GUARD REMAINS A *BUILD* FAILURE. `cognitoConnectSrc()`
 * throws when a production build has no parseable `NEXT_PUBLIC_COGNITO_USER_POOL_ID`, which is a
 * closed finding in its own right — a wildcard `connect-src` admitting any attacker-registrable AWS
 * endpoint used to ship silently. Evaluating it here keeps the failure at build time; reached only
 * from middleware it would have become a first-request failure instead, a weaker guarantee than the
 * one already won.
 */
cognitoConnectSrc();

const nextConfig: NextConfig = {
  /**
   * ── ⚠ `standalone` IS REQUIRED BY THE LAMBDA DEPLOYMENT PATH. DO NOT REMOVE IT. ──
   *
   * The portal runs as `PortalFunction`, a Lambda behind API Gateway and CloudFront, built by
   * `PortalBuildProject` in `platform-portal.yaml`. That artifact must be SELF-CONTAINED and
   * startable with `node server.js`: nothing but `standalone` produces it, because a plain
   * `next build` leaves the server dependent on the repo's own `node_modules`, which is not in
   * the zip.
   *
   * ⚠ THE AMPLIFY RATIONALE THAT WAS HERE IS GONE, NOT JUST REWORDED. It described two Amplify
   * Hosting ingestion paths (a git-connected app running `amplify.yml`, and
   * `aws amplify start-deployment` consuming a `deploy-manifest.json` bundle). Neither exists:
   * Amplify Hosting was replaced by CodeBuild + Lambda — see WHY NOT AMPLIFY at the top of
   * `platform-portal.yaml` — and `amplify.yml` was deleted. The setting survived the
   * migration because the new path needs it for the same reason the old S3 path did; only the
   * explanation was stale.
   *
   * ⚠ THIS DOES NOT REPLACE `.next`. `standalone` is additive — `next build` still writes the
   * full `.next` tree including `required-server-files.json`. One `pnpm run build` serves both
   * the static assets uploaded to `PortalStaticBucket` and the compute bundle.
   */
  output: "standalone",

  /**
   * ⚠ `transpilePackages: ["@praimana/shared"]` WAS REMOVED HERE, DELIBERATELY.
   *
   * `transpilePackages` is not needed here: `shared/` is a folder of source files inside this repo,
   * aliased in
   * `tsconfig.json` `paths`, so it is compiled like any other file under the app root.
   *
   * Leaving the line in would name a package that is not installed. That does not fail the build, which is
   * exactly why it is worth a note rather than a silent deletion: it would sit here as a false claim that
   * this app still has a workspace dependency.
   */

  /**
   * ── /workshops/* → /experiences/* ────────────────────────────────────────────────────────
   *
   * The route directory was renamed when the product settled on "Experience" as the user-facing
   * word. ⚠ A RENAME WITHOUT THIS REDIRECT IS A BREAKING CHANGE FOR ANY LINK ALREADY IN THE WORLD:
   * a facilitator's bookmark, a pasted URL in a chat, the browser history a participant reaches for.
   * Every one of those would 404 on a page that still exists under a new name.
   *
   * ⚠ 308 (PERMANENT), NOT 307. `permanent: true` tells caches and search indexes the move is
   * settled, and — the part that matters here — 308 preserves the METHOD and BODY, so a form POST
   * that lands on an old path still works rather than silently degrading to a GET.
   *
   * ⚠ `/api/workshops/*` IS DELIBERATELY NOT REDIRECTED. It is an API surface named after the
   * backend's own `/v1/workshops`, not a page, and renaming it would put the BFF's vocabulary out of
   * step with the service it proxies for no user-visible gain. The two words are allowed to differ
   * either side of that boundary: "experience" is the product's word, "workshop" is the domain's.
   *
   * The `:path*` form carries deep paths through — `/workshops/<id>/settings` reaches
   * `/experiences/<id>/settings`, which is the case most likely to be bookmarked.
   */
  async redirects() {
    return [
      {
        source: "/workshops",
        destination: "/experiences",
        permanent: true,
      },
      {
        source: "/workshops/:path*",
        destination: "/experiences/:path*",
        permanent: true,
      },
    ];
  },

  /**
   * ── SECURITY RESPONSE HEADERS (EVERYTHING EXCEPT THE CSP) ────────────────────────────────
   *
   * Applied to every response served by this Next.js app, static assets included. Defence-in-depth:
   * React 19's JSX auto-escaping handles the primary XSS vector, and these close residual paths
   * (clickjacking of admin screens, Referer leakage of invite tokens, MIME sniffing).
   *
   * These are set here rather than at the CDN/WAF layer so the repository is secure-by-default
   * regardless of the deployment environment — no external configuration required. The same is true
   * of the CSP; it simply has to be emitted per request instead, from `src/middleware.ts`, because it
   * carries a nonce. See `src/lib/csp.ts`.
   */
  async headers() {
    return [
      {
        // Apply to all routes.
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            // max-age=1 year, includeSubDomains. The deploy is HTTPS-only (CloudFront redirects
            // HTTP to HTTPS), so this closes the first-request downgrade window and any HTTP link
            // that might be followed.
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "X-Frame-Options",
            // Redundant with CSP frame-ancestors but needed for older browsers.
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            // Prevents invite tokens (in the URL path) from leaking via Referer on outbound
            // navigation. strict-origin-when-cross-origin sends only the origin cross-site.
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
