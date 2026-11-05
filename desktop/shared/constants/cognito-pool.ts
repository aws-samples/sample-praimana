// ── COGNITO POOL IDENTIFIERS AND AWS OIDC DISCOVERY ─────────────────────────────
//
// The desktop learns its pool from the CLAIM RESPONSE (an authenticated exchange with
// `user-access`), then reads that pool's OAuth endpoints from AWS's own discovery document.
// This module owns the pool-id shape and the discovery URL built from it.
//
// ── WHY THE ENDPOINTS COME FROM AWS AND NOT FROM US ──
//
// AWS publishes every pool's endpoints, unauthenticated and unstoppably, at
//   https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/openid-configuration
// (RFC 8414). Reading `authorization_endpoint` from there — rather than assembling it from a
// domain string a server handed us — means the page where a user types their password is
// chosen by AWS, not by anything we or a caller can influence.
//
// That is what replaced the build-time origin pin from a known caller-chosen-provider risk, and it is
// strictly stronger: a hostile value can name a different POOL, but it cannot produce a
// login page that is not AWS's.
//
// ⚠ THIS ONLY HOLDS IF THE POOL ID IS VALIDATED BEFORE IT REACHES THE URL. An id containing
// path traversal or a host would move discovery, and the login page with it. That is why
// validation lives inside `oidcDiscoveryUrl` rather than being left to a caller that has
// "already checked".

/** Raised for a malformed pool id. Message written for a log, not a paste-er — see below. */
export class CognitoPoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CognitoPoolError";
  }
}

/**
 * A Cognito pool id: `<region>_<alphanumeric>`.
 *
 * Anchored at both ends. The region part is matched as a region SHAPE rather than against a
 * list, so a pool in a region that did not exist when this shipped still works — a new AWS
 * region must not require a desktop release.
 */
const POOL_ID_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d+_[A-Za-z0-9]+$/;

/**
 * True if `poolId` is a well-formed Cognito user pool id.
 *
 * ⚠ LENGTH-CAPPED BEFORE THE REGEX RUNS. The deep-link path already caps this value at 512
 * before it reaches here; the profile-seed path does not, so this is the one caller-agnostic
 * place to bound it. 64 is generous — a real pool id is ~25 characters — and the cap does not
 * change acceptance for any valid id, only for a value nothing legitimate would ever produce.
 */
export function isValidPoolId(poolId: string): boolean {
  const trimmed = (poolId ?? "").trim();
  return trimmed.length <= 64 && POOL_ID_PATTERN.test(trimmed);  // nosemgrep: detect-redos
}

/**
 * The region embedded in a pool id.
 *
 * Derived rather than carried alongside: two fields that must agree are a way for them to
 * disagree, and Cognito guarantees the prefix IS the region.
 */
export function regionFromPoolId(poolId: string): string {
  return poolId.split("_")[0];
}

/**
 * AWS's OIDC discovery URL for a pool.
 *
 * ⚠ VALIDATES FIRST, ALWAYS. The pool id is interpolated into a URL whose response supplies
 * the `authorization_endpoint` — the page where a password is typed. Without the check, a
 * pool id of `x/../../evil.example/` would point discovery, and therefore the login page, at
 * a host of the caller's choosing. This function must be immune to that on its own, because
 * it is the last place that can be.
 */
export function oidcDiscoveryUrl(poolId: string): string {
  const trimmed = (poolId ?? "").trim();
  if (!isValidPoolId(trimmed)) {
    throw new CognitoPoolError(`"${trimmed}" is not a valid Cognito user pool id.`);
  }
  return `https://cognito-idp.${regionFromPoolId(trimmed)}.amazonaws.com/${trimmed}/.well-known/openid-configuration`;
}
