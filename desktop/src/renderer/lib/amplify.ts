// ── AMPLIFY AUTH IN THE DESKTOP RENDERER ────────────────────────────────────────
//
// Configures the Amplify Auth SDK so the native sign-in form can do SRP directly against
// Cognito, exactly as the portal's browser does.
//
// ── WHY THE DESKTOP DOES SRP ITSELF ──
//
// The alternative — the portal mints a session and hands it over — is DEAD, and not for want
// of trying. Measurement records it: the
// portal's SRP login leaves NO Cognito Hosted UI session, so a silent `/oauth2/authorize`
// round-trip returns a login form. And no server-side grant can mint a token either —
// `AdminInitiateAuth` returns `Auth flow not enabled for this client` against the live pool.
//
// Doing SRP here needs neither. Both calls the desktop makes go through the SAME
// `cognito-idp` API, and both flows are enabled on the app client:
//
//   sign-in   InitiateAuth USER_SRP_AUTH        ← ALLOW_USER_SRP_AUTH ✓
//   renewal   InitiateAuth REFRESH_TOKEN_AUTH   ← ALLOW_REFRESH_TOKEN_AUTH ✓
//
// ⚠ THIS ALSO RETIRES A PRIOR REFRESH-TOKEN GATE. That gate feared an SRP-minted refresh token
// being refused by the HOSTED UI `/oauth2/token` endpoint — two different APIs. Refreshing
// via `cognito-idp` means the mismatch never arises.
//
// ── ⚠ WHAT THIS REVERSES, STATED PLAINLY ──
//
// `preload/index.ts` used to say "No password — Cognito owns credentials + MFA", recorded
// as a deliberate decision. This undoes it: the password and the TOTP code
// are typed into OUR renderer now.
//
// The cost, honestly: a renderer compromise goes from "steal a revocable 30-day token" to
// "own both authentication factors, including portal access". On a platform where
// participants run AI coding agents that install packages into the workspace, that is real.
// It is accepted because the alternatives are worse (see the gate), and it is only tolerable
// alongside the governing security conditions — of which the two that live in this file are:
//
//   1. THE POOL IS NOT TAKEN FROM AN UNTRUSTED SERVER. `configureAmplify` reads it from the
//      stored platform config, which came from an authenticated exchange and was validated
//      against AWS's own OIDC discovery. A renderer that could pass its own pool id would be
//      the untrusted-pool problem all over again, so this function takes NO arguments.
//   2. TOKENS NEVER TOUCH DISK. See `./amplify-memory-storage` — Amplify's `localStorage`
//      default is unencrypted LevelDB in Electron, which would be worse than today.
//
// ── CSP: VERIFIED, NO RELAXATION NEEDED ──
//
// Measured by bundling this exact surface: Amplify's SRP path uses no
// `WebAssembly`, no `eval`, no `new Function`, and no `node:crypto` — it reaches for
// `crypto.subtle`/`getRandomValues`, which a renderer has under any CSP. So the production
// `default-src 'self'; script-src 'self'` stands unchanged, and `connect-src *` (already set)
// permits the `cognito-idp` calls. This was previously listed as unverified; it no longer is.

import { Amplify } from "aws-amplify";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { amplifyTokenStorage } from "./amplify-memory-storage";

const api = (window as any).electronAPI;

/** The pool this renderer is configured against, or null when not yet configured. */
let configuredPoolId: string | null = null;

/**
 * Configure Amplify from the STORED platform config.
 *
 * ⚠ TAKES NO ARGUMENTS, deliberately. The pool id and client id come from main, which got
 * them from an authenticated claim response and validated the pool against AWS discovery. A
 * renderer-supplied pool would let anything in the bundle point the sign-in form at a pool of
 * its choosing and collect a password against it — the caller-chosen-provider risk.
 *
 * Idempotent per pool: React may mount a form more than once (StrictMode double-invokes
 * effects), and re-running `Amplify.configure` mid-flow resets the token provider and loses an
 * in-progress TOTP challenge. Re-configures only if the POOL changed, which is the one case
 * where the old configuration is genuinely wrong.
 *
 * Returns false when there is nothing to configure with — the caller shows "connect to a
 * platform first" rather than a sign-in form that cannot work.
 */
export async function configureAmplify(): Promise<boolean> {
  let config: {
    configured?: boolean;
    poolId?: string;
    cognito?: { clientId?: string };
  };
  try {
    config = await api.getPlatformConfig();
  } catch {
    return false;
  }

  const poolId = config?.poolId ?? "";
  const clientId = config?.cognito?.clientId ?? "";
  if (!config?.configured || !poolId || !clientId) return false;

  if (configuredPoolId === poolId) return true;

  Amplify.configure(
    {
      Auth: {
        Cognito: {
          userPoolId: poolId,
          userPoolClientId: clientId,
          // The pool uses email as the username (UsernameAttributes: [email]).
          loginWith: { email: true },
          mfa: {
            // The pool is MfaConfiguration: ON with TOTP enabled, so every sign-in returns a
            // TOTP challenge. Declared so Amplify's flows agree with the pool rather than
            // discovering it at runtime.
            status: "on",
            totpEnabled: true,
            smsEnabled: false,
          },
          userAttributes: { email: { required: true } },
          passwordFormat: {
            // Mirrors the pool's policy (verified live: MinimumLength 12) so the form can say
            // the rules before Cognito rejects them.
            minLength: 12,
            requireLowercase: true,
            requireUppercase: true,
            requireNumbers: true,
            requireSpecialCharacters: true,
          },
        },
      },
    },
    // `ssr: false` — this is a client, not a Next.js server component.
    { ssr: false }
  );

  /**
   * ⚠ THE LINE THAT KEEPS CREDENTIALS OFF DISK. Without it Amplify uses `localStorage`, which
   * in Electron is unencrypted Chromium LevelDB. Set AFTER `configure`,
   * because `configure` installs the default provider and would overwrite this.
   */
  cognitoUserPoolsTokenProvider.setKeyValueStorage(amplifyTokenStorage);

  configuredPoolId = poolId;
  return true;
}

/**
 * Forget every token Amplify is holding in this renderer.
 *
 * Called immediately after a successful handoff to main, and again on unmount. Main is the
 * session authority, so nothing of value is lost — the point is
 * to shorten the window in which a credential is reachable from the renderer bundle at all.
 */
export function clearRendererTokens(): void {
  amplifyTokenStorage.clearAll();
}
