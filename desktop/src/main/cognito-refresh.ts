// ── RENEWING A SESSION THE NATIVE FORM ESTABLISHED ──────────────────────────────
//
// `InitiateAuth` with `AuthFlow: REFRESH_TOKEN_AUTH`, against the `cognito-idp` API.
//
// ── ⚠ WHY NOT `refreshCognitoTokens` IN cognito-oauth.ts ──
//
// That function posts `grant_type=refresh_token` to the **Hosted UI** `/oauth2/token`. This one
// calls the **cognito-idp** API. They are DIFFERENT APIs, and the difference is the whole reason
// this file exists.
//
// The risk was recorded as a blocking gate: a refresh token minted by SRP
// (which goes through `cognito-idp`) might be refused at the Hosted UI token endpoint, and
// because `refreshCognitoTokens` swallows every failure into `null`, the symptom would be
// "every desktop session dies after 30 minutes" with no diagnosable cause.
//
// Refreshing on the SAME API that minted the token removes the question rather than answering
// it. Both flows are enabled on the app client — verified against the live pool:
//
//   sign-in   InitiateAuth USER_SRP_AUTH        ← ALLOW_USER_SRP_AUTH
//   renewal   InitiateAuth REFRESH_TOKEN_AUTH   ← ALLOW_REFRESH_TOKEN_AUTH
//
// ⚠ `refreshCognitoTokens` IS NOW DEAD FOR THE PRIMARY PATH and kept only for a session that
// was established by the old browser flow. If that path is ever removed, delete it too rather
// than leaving two refreshers whose difference nobody remembers.
//
// ── WHY A RAW POST AND NOT `@aws-sdk/client-cognito-identity-provider` ──
//
// `InitiateAuth` with this flow is unauthenticated — no SigV4, no credentials, just a JSON POST
// with a target header. Adding the SDK to the main-process bundle for one unsigned call would
// cost megabytes and add a dependency explicitly flagged as uncosted. The
// request is fifteen lines; the SDK would be the surprising choice.

import type { PlatformConfig } from "./platform-config";

/** What a successful renewal yields. Shaped to match `CognitoTokens` for a drop-in swap. */
export interface RefreshedTokens {
  idToken: string;
  accessToken: string;
  expiresIn: number;
}

/**
 * Why a renewal failed.
 *
 * ⚠ THE DISTINCTION MATTERS TO THE CALLER, which is why this is not a bare `null`. A `revoked`
 * refresh token means the session is over and the user must sign in again; a `network` failure
 * means try later. Collapsing them — as the old Hosted-UI refresher did — turns a dropped wifi
 * connection into a forced sign-out, which on a workshop day is the whole cohort.
 */
export type RefreshFailure = "revoked" | "network" | "unconfigured";

export type RefreshResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; reason: RefreshFailure };

/** Renewal must not hang the app; the caller retries on the next request. */
const REFRESH_TIMEOUT_MS = 10_000;

/** Bound on the response body — this is a parse of remote input. */
const MAX_REFRESH_BYTES = 64 * 1024;

/**
 * Exchange a refresh token for a fresh ID token.
 *
 * ⚠ COGNITO DOES NOT ROTATE THE REFRESH TOKEN on this grant, so the caller keeps the one it
 * has until it expires (30 days on this pool) and a full sign-in is required. A caller that
 * "helpfully" cleared it after use would end every session after 30 minutes.
 */
export async function refreshViaCognitoIdp(
  platform: PlatformConfig,
  refreshToken: string
): Promise<RefreshResult> {
  if (!refreshToken || !platform.cognito.clientId || !platform.region) {
    return { ok: false, reason: "unconfigured" };
  }

  /**
   * The regional `cognito-idp` endpoint, built from the pool's OWN region.
   *
   * ⚠ NOT from the discovery document's `token_endpoint` — that is the Hosted UI's, which is
   * the API this file exists to avoid. The region comes from the pool id, which
   * `oidcDiscoveryUrl` already validated before it could reach any URL.
   */
  const endpoint = `https://cognito-idp.${platform.region}.amazonaws.com/`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        // Cognito's JSON protocol dispatches on this header, not on a path.
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        "Content-Type": "application/x-amz-json-1.1",
      },
      body: JSON.stringify({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: platform.cognito.clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    // Offline, DNS, timeout. NOT a revocation — see RefreshFailure.
    return { ok: false, reason: "network" };
  }

  if (!res.ok) {
    /**
     * ⚠ 400 MEANS THE TOKEN IS DEAD; 5xx MEANS TRY AGAIN.
     *
     * Cognito answers a revoked, expired or wrong-client refresh token with 400
     * `NotAuthorizedException`. Treating a 500 the same way would sign users out because an AWS
     * region hiccuped, which is exactly the over-reaction the old refresher's blanket `null`
     * produced.
     */
    return { ok: false, reason: res.status >= 400 && res.status < 500 ? "revoked" : "network" };
  }

  let body: unknown;
  try {
    body = JSON.parse(await readBounded(res));
  } catch {
    return { ok: false, reason: "network" };
  }

  const result = (body as { AuthenticationResult?: Record<string, unknown> })
    ?.AuthenticationResult;
  const idToken = typeof result?.IdToken === "string" ? result.IdToken : "";
  const accessToken = typeof result?.AccessToken === "string" ? result.AccessToken : "";

  if (!idToken || !accessToken) {
    // A 200 with no tokens should not happen. Reported as `network` rather than `revoked`: the
    // token was not refused, so signing the user out would be the wrong conclusion.
    return { ok: false, reason: "network" };
  }

  return {
    ok: true,
    tokens: {
      idToken,
      accessToken,
      // 30 minutes is this pool's configured ID-token lifetime; the fallback keeps a missing
      // field from yielding an immediately-stale session.
      expiresIn: typeof result?.ExpiresIn === "number" ? result.ExpiresIn : 1800,
    },
  };
}

/**
 * ── ⚠ END A REFRESH TOKEN'S LIFE AT COGNITO, NOT ONLY ON THIS DISK ────────────────────────────
 *
 * Nothing in the tree ever revoked either credential. `auth:signOut` blanked local rows; `auth:removeAccount`
 * was a bare `DELETE FROM accounts`; `platform:reset` cleared the config. All three FORGET a credential
 * locally and none of them invalidated it server-side, so a refresh token copied off the machine before any
 * of those actions kept working for the remainder of its 30-day life — and neither the participant nor an
 * operator had any mechanism in this client to end that.
 *
 * ── WHY `RevokeToken` ON cognito-idp AND NOT THE HOSTED UI'S `/oauth2/revoke` ──
 *
 * Both exist. This file's header explains at length why renewal moved off the Hosted UI endpoint: a
 * token minted through `cognito-idp` may be refused by the other API, and the symptom of that
 * mismatch is un-diagnosable. Revocation has exactly the same exposure, so it uses the SAME API that
 * minted the token — for the same reason, stated once and applied twice.
 *
 * ⚠ AND IT IS THE SAME UNAUTHENTICATED PUBLIC-CLIENT SHAPE as `InitiateAuth` above: a JSON POST with
 * a target header, `Token` plus `ClientId`, no SigV4. Which is what makes this fix available to the
 * desktop at all — the credentials it already holds are sufficient.
 *
 * ── ⚠ BEST-EFFORT, AND THAT IS A DECISION RATHER THAN A SHORTCUT ──
 *
 * Every caller is discarding the credential anyway. Failing the sign-out or the account deletion
 * because a revocation request timed out would strand the user in the state they asked to leave, and
 * the local wipe is the part they can see. So this returns a verdict the caller RECORDS instead of
 * throwing — an unrevoked token is a fact worth having in the audit log, not a reason to refuse.
 *
 * ⚠ `unsupported` IS DISTINGUISHED FROM `network`, because the two need different responses from a
 * human. Cognito answers `UnsupportedOperationException` when the app client has token revocation
 * disabled — a POOL CONFIGURATION issue an operator must fix, and one this client cannot work around.
 * Collapsing it into "network" would hide a permanently broken revocation path behind a retry.
 */
export type RevokeResult =
  | { ok: true }
  | { ok: false; reason: "network" | "unsupported" | "unconfigured" };

/** Revocation must not hang a sign-out; it is best-effort by design. */
const REVOKE_TIMEOUT_MS = 5_000;

export async function revokeRefreshToken(
  platform: PlatformConfig,
  refreshToken: string
): Promise<RevokeResult> {
  if (!refreshToken || !platform.cognito.clientId || !platform.region) {
    return { ok: false, reason: "unconfigured" };
  }

  // Same endpoint construction as the renewal above, from the pool's own validated region.
  const endpoint = `https://cognito-idp.${platform.region}.amazonaws.com/`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-Amz-Target": "AWSCognitoIdentityProviderService.RevokeToken",
        "Content-Type": "application/x-amz-json-1.1",
      },
      body: JSON.stringify({ Token: refreshToken, ClientId: platform.cognito.clientId }),
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  if (res.ok) return { ok: true };

  /**
   * ⚠ AN ALREADY-DEAD TOKEN IS A SUCCESS, not a failure. Cognito answers a token it has already
   * revoked — or one that expired — with 400, and "it is not valid any more" is precisely the outcome
   * this function exists to produce. Reporting it as a failure would fill the audit log with
   * revocations that did their job, and the one case that matters would be lost among them.
   */
  let code = "";
  try {
    const body = JSON.parse(await readBounded(res)) as { __type?: unknown };
    code = typeof body.__type === "string" ? body.__type : "";
  } catch {
    /* An unparseable error body is still an error; fall through on the status alone. */
  }
  if (code.includes("UnsupportedOperation")) return { ok: false, reason: "unsupported" };
  if (res.status >= 400 && res.status < 500) return { ok: true };
  return { ok: false, reason: "network" };
}

/** Read a response body, refusing anything over {@link MAX_REFRESH_BYTES}. */
async function readBounded(res: Response): Promise<string> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (text.length > MAX_REFRESH_BYTES) throw new Error("response too large");
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REFRESH_BYTES) throw new Error("response too large");
      chunks.push(value);
    }
  } finally {
    // Released even on the size-cap throw, so a bad response cannot leave a socket open.
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
