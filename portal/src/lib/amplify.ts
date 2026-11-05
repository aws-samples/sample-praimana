"use client";

import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { sessionStorage as amplifySessionStorage } from "aws-amplify/utils";

/**
 * Client-side Amplify Auth configuration for the CUSTOM auth UI.
 *
 * Why these vars must be NEXT_PUBLIC_*: this code runs in the browser, and
 * `process.env` is inlined at BUILD time by Next.js, only the NEXT_PUBLIC_ prefix
 * survives into client bundles. The server-side COGNITO_ISSUER / COGNITO_CLIENT_ID
 * are invisible here, so the same two values are exposed under public names.
 * (The build writes both explicitly and asserts them non-empty, see PortalBuildProject's .env.production guard in platform-portal.yaml, so a deploy missing either one fails rather
 * than shipping a half-configured client.)
 *
 * Exposing them is not a leak. A user pool id and an app client id are public
 * identifiers by design: they travel in every Hosted UI URL and in every
 * unauthenticated call to our own GET /v1/auth/config. The app client has NO
 * secret, which is correct for a browser client, PKCE and the user's own
 * credentials are what prove anything, not the client id.
 *
 * ── ⚠ TOKEN STORAGE IS `sessionStorage`, AND THE ARGUMENT FOR localStorage WAS WRONG ──────────
 *
 * This used to be `defaultStorage` (localStorage), justified here on the grounds that a token
 * sitting there "cannot be replayed into an app session without passing that server-side signature
 * check". That reasoning addresses FORGERY, and the risk is THEFT:
 *
 *   · the Cognito ID token in that store is not merely how the browser talks to Cognito, it is the
 *     exact bearer this BFF forwards to every `/v1/*` service (`lib/backend.ts`), so a script that
 *     reads it can call the services DIRECTLY, bypassing every portal gate and every role check;
 *   · the refresh token beside it is a ~30-DAY credential, and `AuthFlow.tsx`'s resume effect
 *     demonstrates what it is worth: a full app session, no password, no TOTP.
 *
 * This was raised as a security finding, and the project's own backlog had already recorded the
 * rationale above as wrong.
 *
 * ⚠ `sessionStorage` RATHER THAN IN-MEMORY, AND THE TRADE IS DELIBERATE. In-memory storage is
 * stricter but drops the tokens on any page reload, which breaks the reason localStorage was chosen
 * in the first place: the sign-up → confirm → TOTP journey must survive a refresh, and restarting an
 * operator mid-enrolment is a real failure. `sessionStorage` keeps that journey intact, is not shared
 * across tabs, and is gone when the tab closes, so the ~30-day credential no longer outlives the
 * browsing session on a shared machine.
 *
 * ⚠ WHAT THIS COSTS, STATED PLAINLY: /login's silent resume (`AuthFlow.tsx`) no longer works across a
 * tab close. Someone returning to a closed tab signs in with a password and a TOTP code. That is the
 * same outcome the idle-timeout hardening calls for, so the two changes agree rather than
 * fight, but it IS a behaviour change for returning users, and it was chosen over keeping a 30-day
 * credential in a store every script in the page can read.
 */

const USER_POOL_ID = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";
const USER_POOL_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "";

/** True when the custom UI has everything it needs to talk to Cognito. */
export const isAmplifyConfigured = Boolean(USER_POOL_ID && USER_POOL_CLIENT_ID);

let configured = false;

/**
 * Configure Amplify exactly once per browser session.
 *
 * Idempotent because it is called from a client component that React may mount
 * more than once (StrictMode double-invokes effects, and every auth screen calls
 * it). Re-running Amplify.configure() would reset the token provider mid-flow.
 */
export function configureAmplify(): void {
  if (configured || !isAmplifyConfigured) return;
  configured = true;

  Amplify.configure(
    {
      Auth: {
        Cognito: {
          userPoolId: USER_POOL_ID,
          userPoolClientId: USER_POOL_CLIENT_ID,
          // The pool uses email as the username (UsernameAttributes: [email]).
          loginWith: { email: true },
          mfa: {
            // The pool is MfaConfiguration: ON with TOTP enabled, so enrolment is
            // not optional, a first sign-in WILL return a TOTP setup step and the
            // UI must handle it. Declared here so Amplify's own types/flows agree
            // with the pool rather than discovering it at runtime.
            status: "on",
            totpEnabled: true,
            smsEnabled: false,
          },
          userAttributes: {
            email: { required: true },
          },
          passwordFormat: {
            // Mirrors the pool's password policy so the sign-up form can tell the
            // user the rules BEFORE Cognito rejects them.
            minLength: 12,
            requireLowercase: true,
            requireUppercase: true,
            requireNumbers: true,
            requireSpecialCharacters: true,
          },
        },
      },
    },
    { ssr: false }
  );

  /**
   * Explicit: keep Cognito tokens in `sessionStorage`, so a page refresh in the middle of the
   * sign-up → confirm → TOTP journey does not drop the user back to the start, while the tokens (the
   * `/v1/*` bearer and the ~30-day refresh token) do not survive the tab. See the header.
   */
  cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifySessionStorage);
}
