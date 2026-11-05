/**
 * Mint a portal session cookie, so a browser spec can start ON the screen under test.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE REAL SIGN-IN, AND DOES NOT REPLACE IT ──
 * The four highest-value behaviours in this harness are properties of the CONFIRMATION
 * DIALOG, not of authentication:
 *
 *   1. where focus lands after a successful removal (not <body>);
 *   2. focus surviving the confirm button disabling itself under the keyboard;
 *   3. the focus trap holding in both directions while the focusable set changes;
 *   4. `disabled` genuinely preventing a second submit (exactly one network call).
 *
 * Each needs to be run many times — (2) and (3) are keyboard-timing assertions and a
 * single green run of a focus race is not evidence. Driving the real Cognito TOTP
 * challenge per repetition would mean one code per sign-in, `freshTotp` waiting up to 30s
 * for a clean window, and a suite whose runtime is dominated by MFA rather than by the
 * behaviour under test. Worse, it would make a Cognito hiccup indistinguishable from a
 * focus defect — the failure mode a QA harness must never have.
 *
 * So authentication is proven ONCE, for real, in access-controls.auth.spec.ts, which signs
 * in through the actual password + TOTP journey with no seam at all. Everything downstream
 * of "you are signed in" is then exercised here, deterministically.
 *
 * ── WHY THIS IS NOT AN AUTH BYPASS ──
 * This does not weaken, disable or reconfigure anything. There is NO test-only code path in
 * the application — not a flag, not an env check, not a header. This file does exactly what
 * a browser does after a successful sign-in: it presents a session cookie that the server
 * verifies with its own signing secret. Forging one requires NEXTAUTH_SECRET, which is the
 * same thing as saying it requires the server's private key. Any deployment whose secret
 * differs (i.e. every deployment) rejects these cookies outright.
 *
 * The MFA argument in tests/e2e/totp.ts is untouched by this: the pool stays
 * MfaConfiguration: ON, nothing is re-enrolled, and the TOTP journey is still exercised by
 * the spec whose subject is the TOTP journey.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──
 * It does not mint an `accessToken` that any service would accept. The value below is
 * visibly a placeholder, so every downstream API call fails — which is why specs using this
 * seam serve their own tRPC responses (see trpc.ts) rather than reaching the services. That
 * is the honest boundary: these specs test the BROWSER's behaviour, and they say so.
 */

import { encode } from "next-auth/jwt";
import type { BrowserContext } from "@playwright/test";

/**
 * Auth.js v5 derives its encryption key from (secret, salt) where the salt IS the cookie
 * name. Hardcoded to the insecure-context name because baseURL is http://localhost — the
 * `__Secure-` prefix applies only over https, and using the wrong one yields a cookie the
 * server cannot decrypt, surfacing as an unauthenticated redirect rather than an error.
 */
export const SESSION_COOKIE = "authjs.session-token";

/** Roles a spec can adopt. Matches UserRole in @praimana/shared. */
export type SpecRole = "ADMIN" | "FACILITATOR" | "EXECUTIVE" | "JUDGE" | "PARTICIPANT";

export interface SpecIdentity {
  /** The Cognito sub. Compared against `member.userId` for the "(you)" row. */
  id: string;
  email: string;
  name: string;
  role: SpecRole;
}

/**
 * Add a session cookie for `identity` to `context`.
 *
 * The expiry is 30 minutes to match the portal's own `session.maxAge`, so a spec cannot
 * accidentally depend on a longer-lived session than production issues.
 */
export async function signInAs(
  context: BrowserContext,
  identity: SpecIdentity,
  secret: string,
  baseURL = "http://localhost:3001"
): Promise<void> {
  const maxAgeSeconds = 30 * 60;
  const token = await encode({
    salt: SESSION_COOKIE,
    secret,
    token: {
      // Both `id` and `sub`: the session callback reads `id`, and Auth.js populates `sub`
      // on a real token, so a spec that depends on either behaves as production does.
      id: identity.id,
      sub: identity.id,
      email: identity.email,
      name: identity.name,
      role: identity.role,
      // Deliberately not a usable bearer — see the header note. Any spec whose screen
      // reaches a real service must serve that route itself.
      accessToken: "e2e-placeholder-not-a-real-bearer",
      exp: Math.floor(Date.now() / 1000) + maxAgeSeconds,
    },
  });

  const url = new URL(baseURL);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + maxAgeSeconds,
    },
  ]);
}
