/**
 * ── THE CONTENT-SECURITY-POLICY, BUILT PER REQUEST ────────────────────────────────────────────
 *
 * Applied to every document this app serves. Defence-in-depth: React 19's JSX auto-escaping handles
 * the primary XSS vector, but CSP closes residual paths (inline script injection via a future bug,
 * clickjacking of admin screens, Referer leakage of invite tokens).
 *
 * ── ⚠ WHY THIS MOVED OUT OF `next.config.ts` ──────────────────────────────────────────────────
 *
 * The policy used to be a static string in `next.config.ts`'s `headers()`, and its `script-src`
 * carried `'unsafe-inline'` in BOTH branches, the only production difference was the removal of
 * `'unsafe-eval'`. The comment there recorded the reason honestly: "Next inlines its bootstrap and
 * flight-data scripts, so removing it needs per-request nonces threaded through middleware, worth
 * doing, and a bigger change than this one."
 *
 * `'unsafe-inline'` makes `script-src` decorative: it permits exactly the injection the directive
 * exists to stop. A nonce cannot come from
 * `next.config.ts` because `headers()` is evaluated once at build time and a nonce must be unique per
 * response, so the policy is built here and emitted by `src/middleware.ts`, which runs per request.
 *
 * ⚠ THE CSP IS NOW SET IN EXACTLY ONE PLACE, AND THAT IS LOAD-BEARING. Two `Content-Security-Policy`
 * headers are INTERSECTED by the browser, not overridden, so leaving a nonce-less copy in
 * `next.config.ts` as a "fallback" would have produced a policy allowing neither inline scripts nor
 * the nonce, i.e. a blank page. `next.config.ts` keeps the other security headers (HSTS,
 * X-Frame-Options, Referrer-Policy…) because those are static and apply to every response including
 * static assets; the CSP only matters on documents, which is exactly what the middleware matcher
 * covers.
 */

/** True when this is not a production build. `next dev`/`next build` both set NODE_ENV. */
const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * The Cognito hosts the BROWSER connects to, derived rather than wildcarded.
 *
 * A user pool id is `<region>_XXXXXXXXX`, so the region, and therefore the exact IDP host, is
 * derivable. `*.auth.<region>.amazoncognito.com` (the Hosted UI) is a NAVIGATION rather than a fetch,
 * so it does not belong in `connect-src`; it is left out deliberately.
 */
const COGNITO_REGION = (process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "").split("_")[0];

/**
 * ⚠ FOUR-SEGMENT REGIONS ARE VALID AND AN OLDER TEST REJECTED THEM. `/^[a-z]{2}-[a-z]+-\d$/` fails
 * `us-gov-west-1`, so a GovCloud pool id took the wildcard fallback even when correctly configured.
 * `(-[a-z]+)+` accepts any number of middle segments (`us-east-1`, `us-gov-west-1`,
 * `ap-southeast-3`) while still refusing anything that is not a region.
 *
 * ⚠ TRAILING NUMBER IS `\d+`, NOT `\d`, TO AGREE WITH THE DESKTOP'S EQUIVALENT
 * (`desktop/shared/constants/cognito-pool.ts`'s `POOL_ID_PATTERN`). Every AWS region today has a
 * single-digit suffix, so a single `\d` happens to agree, but the day AWS ships a two-digit
 * region number, a single-`\d` regex here would fail closed on a correctly configured pool id
 * and the build would fail with an operator-facing message claiming the variable is malformed.
 */
const COGNITO_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/**
 * ⚠ A PRODUCTION BUILD FAILS RATHER THAN SHIPPING THE WILDCARD, AND THE OLD BEHAVIOUR WAS A REPORTED
 * FINDING.
 *
 * This used to fall back to `https://*.amazonaws.com https://*.amazoncognito.com` whenever the pool
 * id was absent or unparseable, justified on "the deploy asserts the variable in a real
 * deployment". That control did not exist at the time: the deploy assertion loop covered seven other
 * variables, and `NEXT_PUBLIC_COGNITO_USER_POOL_ID` reached `.env.production` only via a generic
 * `NEXT_PUBLIC_[A-Z_]+` capture, which asserts nothing.
 *
 * ⚠ THE GUARD IS REAL NOW, AND IT IS NOT IN THIS REPO. It is PortalBuildProject's .env.production guard in platform-portal.yaml,
 * which asserts this variable non-empty before the build runs; `amplify.yml` (the file the old
 * justification named) was deleted when Amplify Hosting stopped being the deploy path.
 * Regression-tested at `infra/aws/app/test-portal-env-guard.sh`. The build-time failure
 * below does not depend on that guard being right, it is the belt to its braces." Because sign-in works either way, a
 * deployment could run indefinitely on the wide policy with no signal at all.
 *
 * Why that is worth failing a build over: a CSP host wildcard matches subdomains at ANY depth, so
 * that pattern admitted every S3 bucket (`attacker.s3.us-east-1.amazonaws.com`) and every API Gateway
 * on AWS, anyone can create a receiving endpoint inside it.
 *
 * ⚠ CALLED FROM `next.config.ts` AT CONFIG LOAD SO THE FAILURE IS STILL A BUILD FAILURE. Moving the
 * policy into middleware would otherwise have downgraded this from "the build fails" to "the first
 * request fails", which is a weaker guarantee than the one already won here.
 *
 * The dev fallback is kept deliberately: a local build with no Cognito configured must still start,
 * and on `next dev` a broad `connect-src` is not a production exposure.
 */
export function cognitoConnectSrc(): string {
  if (COGNITO_REGION_RE.test(COGNITO_REGION)) {  // nosemgrep: detect-redos
    return `https://cognito-idp.${COGNITO_REGION}.amazonaws.com`;
  }
  if (IS_DEV) {
    return "https://*.amazonaws.com https://*.amazoncognito.com";
  }
  throw new Error(
    "NEXT_PUBLIC_COGNITO_USER_POOL_ID is missing or not of the form `<region>_XXXXXXXXX` " +
      `(got region "${COGNITO_REGION}"). Refusing to build a production CSP whose connect-src ` +
      "falls back to https://*.amazonaws.com, that wildcard admits any attacker-registrable " +
      "AWS endpoint. Set NEXT_PUBLIC_COGNITO_USER_POOL_ID on PortalBuildProject in "
      + "platform-portal.yaml (it is asserted non-empty there before the build runs)."
  );
}

/**
 * ── THE WORKSHOP-RESOURCES BUCKET, THE ONE PLACE THE BROWSER TALKS TO AWS DIRECTLY ────────────
 *
 * ⚠ THIS DIRECTIVE IS WHY THE RESOURCES FEATURE FAILED WITH "Failed to fetch" ON A DEPLOYED BUILD.
 * `connect-src` was `'self'` plus the Cognito IDP host, and the comment below it stated the
 * invariant plainly, the browser talks to Cognito and to this origin, and to nothing else. Workshop
 * resource uploads BREAK that invariant on purpose: a 100MB file fits through neither API Gateway
 * (10MB) nor Lambda (6MB), so the browser must PUT multipart parts straight to S3. The policy
 * forbade it, the browser refused the fetch before a packet left, and the symptom was a bare
 * `TypeError: Failed to fetch` that named neither CSP nor S3.
 *
 * ⚠ THE EXACT HOST, NEVER A WILDCARD, and this file already records what a wildcard costs: a CSP host
 * wildcard matches subdomains at ANY depth, so `https://*.amazonaws.com` "admitted every S3 bucket
 * (`attacker.s3.us-east-1.amazonaws.com`)". `https://*.s3.us-east-1.amazonaws.com` is no better -
 * every bucket in the region is inside it, and anyone can create one. One bucket, spelled out.
 *
 * ⚠ THE VALUE IS VALIDATED BEFORE IT REACHES THE HEADER, because an unvalidated env var concatenated
 * into a CSP is a CSP-injection primitive: a value containing `; script-src 'unsafe-inline'` would
 * append a directive and silently undo the nonce work this module exists for. The pattern below admits
 * only a real S3 bucket name, so no space, semicolon or quote can survive.
 *
 * ⚠ ABSENT IS NOT AN ERROR, UNLIKE THE COGNITO CASE. A deployment with no resources bucket answers 501
 * on every resource route by design (see services/workshop/src/app.ts), so there is nothing for the
 * browser to reach and nothing to permit. Returning empty keeps the directive as narrow as the
 * deployment actually is, rather than failing a build over a feature that is switched off.
 */
const RESOURCES_BUCKET = process.env.NEXT_PUBLIC_RESOURCES_BUCKET || "";

/** S3 bucket naming rules, which are also what makes the value safe to interpolate. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function resourcesConnectSrc(): string {
  if (!RESOURCES_BUCKET) return "";

  if (!BUCKET_NAME_RE.test(RESOURCES_BUCKET)) {
    /**
     * Malformed means someone set it, so silence would be wrong, but a bad value must not become a
     * header. In dev, say so and carry on; in a production build, fail, exactly as the Cognito branch
     * does. A CSP that silently omits the bucket presents as "uploads do not work" with no cause.
     */
    if (IS_DEV) {
      console.error(
        `[csp] NEXT_PUBLIC_RESOURCES_BUCKET is not a valid S3 bucket name ("${RESOURCES_BUCKET}"), ` +
          "so it was NOT added to connect-src. Resource uploads will fail with 'Failed to fetch'."
      );
      return "";
    }
    throw new Error(
      `NEXT_PUBLIC_RESOURCES_BUCKET is not a valid S3 bucket name ("${RESOURCES_BUCKET}"). ` +
        "Refusing to interpolate it into a Content-Security-Policy, an unvalidated value here can " +
        "append directives and undo the nonce policy."
    );
  }

  /**
   * ⚠ THE REGIONAL, VIRTUAL-HOSTED FORM, because that is what the SDK actually presigns. Verified
   * against a real presigned URL from the deployed service:
   * `https://<bucket>.s3.us-east-1.amazonaws.com/...`. The legacy global form
   * (`<bucket>.s3.amazonaws.com`) is NOT what arrives, so permitting only that would fail in exactly
   * the same invisible way.
   *
   * The region is taken from the Cognito pool id, which is the same single region this platform
   * deploys into, the alternative is a second variable that can disagree with the first.
   */
  const region = COGNITO_REGION_RE.test(COGNITO_REGION) ? COGNITO_REGION : "";  // nosemgrep: detect-redos
  if (!region) {
    // Dev only: without a pool id there is no region to build a host from, and the dev fallback
    // in `cognitoConnectSrc` is already wide enough to cover S3.
    return "";
  }
  return `https://${RESOURCES_BUCKET}.s3.${region}.amazonaws.com`;
}

/** The header name, so no caller spells it out. */
export const CSP_HEADER = "Content-Security-Policy";

/**
 * The request header the nonce travels on, from middleware to the root layout.
 *
 * A request header rather than a cookie or a context: middleware can only pass values forward by
 * rewriting the request, and the layout reads it with `headers()`.
 */
export const NONCE_HEADER = "x-csp-nonce";

/**
 * Build the policy for one response.
 *
 * @param nonce The per-response nonce. Omit for responses that are not documents.
 */
export function buildContentSecurityPolicy(nonce?: string): string {
  /**
   * ── ⚠ `'strict-dynamic'` IS WHAT MAKES A NONCE WORKABLE WITH NEXT ─────────────────────────────
   *
   * Next inlines a bootstrap script and streams flight data through further inline scripts, and it
   * also injects `<script>` elements from JavaScript as chunks load. Nonces alone would cover the
   * former (we thread the nonce into them) but not the latter, a script created by a trusted script
   * carries no nonce attribute. `'strict-dynamic'` says: trust what an already-trusted script
   * inserts. That is precisely the property needed, and it is why the modern guidance is
   * nonce + `'strict-dynamic'` rather than a nonce on its own.
   *
   * ⚠ AND IT IS WHY `'self'` NO LONGER MATTERS HERE: when `'strict-dynamic'` is present, browsers
   * IGNORE host-source expressions in `script-src`. It is kept for pre-`strict-dynamic` browsers,
   * which fall back to host matching and would otherwise refuse every chunk.
   *
   * ⚠ `'unsafe-eval'` REMAINS DEV-ONLY. Next's dev server needs `eval` for hot reloading; a
   * production build does not, and shipping it would leave the single largest hole in the policy open
   * for no benefit. If a production page ever breaks with an "unsafe-eval" console error, the fix is
   * to find what is calling `eval`, not to put this back.
   */
  const scriptSrc = [
    "script-src 'self'",
    nonce ? `'nonce-${nonce}'` : "",
    "'strict-dynamic'",
    IS_DEV ? "'unsafe-eval'" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    "default-src 'self'",
    scriptSrc,
    /**
     * ⚠ STYLES KEEP `'unsafe-inline'`, AND THAT IS A DIFFERENT RISK FROM SCRIPTS. `next/font`
     * injects a `<style>` element and React inlines style attributes; neither can carry a nonce
     * through the streaming renderer today. An injected STYLESHEET cannot execute JavaScript, the
     * historical CSS exfiltration tricks need attacker-controlled selectors AND a network fetch,
     * which `default-src 'self'` and the narrowed `connect-src` already bound. Worth revisiting, not
     * worth blocking the script fix on.
     */
    "style-src 'self' 'unsafe-inline'",
    /**
     * ⚠ NO BARE `https:`, WHICH WAS AN OPEN EXFILTRATION CHANNEL. `img-src … https:` permits ANY
     * https host, so an injected script could exfiltrate by setting an image source, a channel CSP
     * is specifically supposed to close. Every image this app renders is a repo-owned asset under
     * `/public` or a `data:` URI, and `next.config.ts` declares no `images.remotePatterns`, so Next
     * refuses remote optimisation anyway. Widening this is the decision to allow a new image host,
     * and should look like one.
     */
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    /**
     * The browser talks to COGNITO directly (Amplify Auth: sign-in, MFA, refresh) and to this origin
     * for everything else. It does NOT talk to the backend gateway, those calls all go through the
     * BFF, which is why `NEXT_PUBLIC_BACKEND_URL` appears only in server-side code.
     *
     * ⚠ AND TO THE WORKSHOP-RESOURCES BUCKET, which is the ONE exception and a deliberate one, see
     * `resourcesConnectSrc`. A 100MB upload cannot pass through the BFF, so the browser PUTs multipart
     * parts straight to S3 against a presigned URL. Empty when no bucket is configured, so the
     * directive stays as narrow as the deployment.
     */
    [`connect-src 'self'`, cognitoConnectSrc(), resourcesConnectSrc()].filter(Boolean).join(" "),
    "frame-ancestors 'none'",
    // No plugins, no <base> rewriting, no posting this app's forms elsewhere.
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}
