import NextAuth from "next-auth";
import Cognito from "next-auth/providers/cognito";
import Credentials from "next-auth/providers/credentials";
import { canSignInToWebApp, collapseCognitoGroups } from "@praimana/shared";
import { decodeJwt } from "jose";
import { verifyCognitoIdToken } from "@/lib/cognito-verify";
import {
  expiryOf,
  needsRefresh,
  refreshCognitoIdToken,
} from "@/lib/cognito-refresh";
import { auditLog } from "@/lib/audit-logger";
import {
  SESSION_COOKIE_NAME,
  SESSION_SECRETS,
  useSecureCookies,
} from "@/lib/session-cookie";
import type { AppToken } from "@/types/next-auth";

/**
 * Authentication is native Amazon Cognito. There are TWO providers, and they mint
 * the same session:
 *
 *   - `cognito`, the Hosted UI OAuth2 authorization-code + PKCE flow. Kept
 *     working, and still what the desktop app's flow relies on.
 *   - `cognito-token`, the CUSTOM UI flow. The browser authenticates directly
 *     against Cognito with the Amplify Auth SDK (branded screens for sign-in,
 *     TOTP, sign-up, reset) and then hands the resulting ID TOKEN to this provider
 *     to establish the server session that middleware, tRPC, and the server
 *     components all read.
 *
 * Why a Credentials provider is safe here, given it usually isn't: it accepts no
 * password and makes no trust decision of its own. It takes one input, a Cognito
 * ID token, and calls verifyCognitoIdToken(), which checks the SIGNATURE against
 * the pool's JWKS plus issuer, audience, expiry and token_use on the server. A
 * forged or replayed-from-elsewhere token yields no session. The identity and the
 * role come out of the verified claims, never out of anything the caller asserts.
 *
 * Cognito still owns credentials, MFA, and token issuance in both flows; the
 * platform ROLE is authoritative from the `cognito:groups` claim, collapsed to a
 * single role by precedence. This app never stores or verifies a password.
 *
 * The bearer we forward to the API is the Cognito **ID token**: it carries `aud`
 * (the app client id), `email`, and `cognito:groups`, so both the API Gateway JWT
 * authorizer and the in-service jose verifier (which checks audience) accept it.
 * The access token has no `aud` and would fail that audience check.
 *
 * EVERY invited person registers and signs in here, participants included: this
 * is the browser end of the invite flow. Sign-in only checks that the collapsed
 * role is one we recognise (fail closed on anything else); WHERE a role may go
 * once inside is a separate decision, enforced in middleware.ts, a PARTICIPANT
 * is confined to /welcome (join code + desktop download) and never reaches the
 * staff screens.
 */

// Env (set by the deploy): the Cognito issuer + app client. NextAuth's Cognito
// provider derives the Hosted UI endpoints from `issuer` via OIDC discovery.
const COGNITO_ISSUER = process.env.COGNITO_ISSUER || ""; // https://cognito-idp.<region>.amazonaws.com/<poolId>
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
// Empty/absent when the app client has NO secret, which is how this platform
// deploys it (a browser app can't keep one; PKCE is what proves the exchange).
const COGNITO_CLIENT_SECRET = process.env.COGNITO_CLIENT_SECRET || "";

/**
 * Cookie name, secure-cookie decision and the session signing keys all live in
 * `lib/session-cookie.ts`, `lib/server-token.ts` needs the name and the keys to decrypt this same
 * cookie, and importing them from here would drag this whole module (providers, callbacks, the
 * Cognito client) into every route that only wants the bearer. See that file for the cookie
 * hardening rationale and for why the keys are an array.
 */

/** Read the collapsed platform role from an ID token's `cognito:groups` claim. */
function roleFromIdToken(idToken: string | undefined): string {
  if (!idToken) return "PARTICIPANT";
  try {
    const claims = decodeJwt(idToken) as { "cognito:groups"?: unknown };
    return collapseCognitoGroups(claims["cognito:groups"]);
  } catch {
    return "PARTICIPANT";
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Cognito access/ID tokens live 30 min (see the app client in the template);
  // keep the NextAuth session aligned so a stale session can't outlive the token.
  /**
   * ── ⚠ A ONE-DAY SESSION, WITH THIRTY-MINUTE BEARER TOKENS ──────────────────────────────
   *
   * THE REQUIREMENT: a portal session lasts one day (it was previously 30 minutes, then 6 hours).
   *
   * ⚠ WHAT WAS *NOT* CHANGED, AND WHY THAT IS THE POINT. The obvious reading is "make the tokens last 6
   * hours", raise `IdTokenValidity` / `AccessTokenValidity` on the Cognito app client. That is left at 30
   * minutes deliberately: those are bearer credentials, and a stolen one is replayable for its whole lifetime.
   * A DAY-LONG bearer token would be a day-long replay window for a stolen one. This app already REFRESHES:
   * `refreshCognitoIdToken` runs as a side effect of each session read (`updateAge: 60`), so a one-day session
   * is served by dozens of short-lived tokens rather than one long one. The refresh token's own 30-day
   * validity is what actually has to cover the session length, and it does.
   *
   * ⚠ THE IDLE TIMEOUT IS THE CONTROL THAT STILL LIMITS AN UNATTENDED MACHINE, and it is a different number
   * (`IDLE_TIMEOUT_MS`, now two hours). This one governs how long a session may live while in USE; that one
   * governs how long it survives with nobody there. Raising this to a day does NOT mean a walked-away-from
   * browser stays usable for a day, idleness signs out first and does the full teardown.
   *
   * ⚠ THE TRADE-OFF IS REAL AND IT IS A POLICY CHOICE. Together these two mean an unlocked machine stays
   * signed in for up to two hours, and a session can be resumed for a day. Both are deliberate.
   * `idle-timeout.test.ts` asserts idle ≤ this, since the shorter of the two decides.
   */
  session: { strategy: "jwt", maxAge: 24 * 60 * 60, updateAge: 60 },
  useSecureCookies,
  /**
   * Explicit rather than left to Auth.js's env pickup (`AUTH_SECRET ?? NEXTAUTH_SECRET`), because
   * this is an ARRAY: overlapping keys are what make a secret rotation something other than a
   * forced sign-out for every active session. See `lib/session-cookie.ts`.
   */
  secret: SESSION_SECRETS,
  cookies: {
    sessionToken: {
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
    callbackUrl: {
      name: useSecureCookies ? "__Secure-authjs.callback-url" : "authjs.callback-url",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
    csrfToken: {
      name: useSecureCookies ? "__Host-authjs.csrf-token" : "authjs.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
  },
  providers: [
    Cognito({
      clientId: COGNITO_CLIENT_ID,
      clientSecret: COGNITO_CLIENT_SECRET,
      issuer: COGNITO_ISSUER,
      // A secretless app client MUST authenticate at the token endpoint with
      // `none` (client_id in the body), not the default `client_secret_basic`.
      // Passing clientSecret:"" does NOT make Auth.js skip Basic auth, it sends
      // `Authorization: Basic base64(clientId:)`, and Cognito answers
      // `invalid_client`, which surfaces in the browser as the opaque
      // `/api/auth/error?error=Configuration`. Verified against the live token
      // endpoint: Basic-with-empty-secret → invalid_client, while client_id in
      // the body → invalid_grant (i.e. client auth accepted, only the test code
      // rejected). Set explicitly so this can't silently regress if the env var
      // is absent.
      client: {
        token_endpoint_auth_method: COGNITO_CLIENT_SECRET
          ? "client_secret_basic"
          : "none",
      },
      // Ask for the groups-bearing ID token; `email`/`profile` fill display fields.
      authorization: { params: { scope: "openid email profile" } },
    }),
    // The custom-UI bridge. The browser has already completed the full Cognito
    // journey (password, and the mandatory TOTP challenge) via the Amplify SDK;
    // all that remains is to turn its ID token into our server session.
    Credentials({
      id: "cognito-token",
      name: "Cognito ID token",
      // No password field: the only credential is a token this server verifies.
      credentials: { idToken: { label: "ID token", type: "text" } },
      async authorize(credentials) {
        const idToken =
          typeof credentials?.idToken === "string" ? credentials.idToken : undefined;

        // THE trust decision. Everything downstream depends on this line having
        // verified the signature server-side rather than decoding the token.
        const identity = await verifyCognitoIdToken(idToken);
        if (!identity) {
          auditLog({
            event: "auth.token_verification.failure",
            actor: {},
            outcome: "failure",
            reason: "ID token verification failed, signature invalid, expired, or malformed",
            metadata: { provider: "cognito-token" },
          });
          return null;
        }

        // Same gate the Hosted UI flow applies: a token whose collapsed role we
        // don't recognise mints no session (fail closed).
        if (!canSignInToWebApp(identity.role)) {
          auditLog({
            event: "auth.role_gate.denied",
            actor: { id: identity.id, role: identity.role, email: identity.email },
            outcome: "denied",
            reason: `Role "${identity.role}" is not permitted to sign in to the web app`,
            metadata: { provider: "cognito-token" },
          });
          return null;
        }

        // Log successful authentication via custom UI
        auditLog({
          event: "auth.signin.success",
          actor: { id: identity.id, role: identity.role, email: identity.email },
          outcome: "success",
          metadata: { provider: "cognito-token" },
        });

        // Returned fields land on the JWT in the `jwt` callback below. The raw
        // token is carried through as the API bearer, it is the ID token, which
        // is what the gateway's JWT authorizer and the services' audience check
        // accept.
        return {
          id: identity.id,
          email: identity.email,
          role: identity.role,
          idToken,
        } as unknown as import("next-auth").User;
      },
    }),
  ],
  callbacks: {
    // Gate at sign-in: every recognised platform role (participants included) may
    // hold a session. An unrecognised/absent role mints nothing (fail closed).
    signIn({ account }) {
      // The credentials provider already verified the token AND applied this same
      // gate inside authorize(), returning null there is what rejects. Re-deriving
      // the role from `account` here would find no id_token and wrongly collapse to
      // PARTICIPANT, turning every custom-UI admin sign-in into a participant.
      if (account?.provider === "cognito-token") return true;

      const role = roleFromIdToken(account?.id_token as string | undefined);
      const allowed = canSignInToWebApp(role);

      if (allowed) {
        auditLog({
          event: "auth.signin.success",
          actor: { role },
          outcome: "success",
          metadata: { provider: account?.provider ?? "cognito" },
        });
      } else {
        auditLog({
          event: "auth.role_gate.denied",
          actor: { role },
          outcome: "denied",
          reason: `Role "${role}" is not permitted to sign in via Hosted UI`,
          metadata: { provider: account?.provider ?? "cognito" },
        });
      }

      return allowed;
    },
    async jwt({ token, account, user, profile }) {
      // `account` is present only on the initial sign-in.
      if (account) {
        /**
         * CLEAR ANY STALE FAILURE FLAG FIRST. A fresh `account` means a brand-new token from the
         * IdP, so whatever went wrong with the previous one is irrelevant.
         *
         * ⚠ THIS IS WHY THE 401 SURVIVED THE PREVIOUS FIX. The login loop stamped
         * `refreshFailed: true` into the encrypted session cookie. That commit stopped SETTING the
         * flag but nothing ever CLEARED it, and it was only reset on a successful server-side
         * refresh, which the custom-UI path never performs. So an already-affected cookie kept
         * withholding the bearer for ever, and every call answered 401 with the token sitting
         * right there. A fix that requires the user to clear their cookies is not a fix.
         */
        (token as AppToken).refreshFailed = false;
        if (account.provider === "cognito-token") {
          // Custom UI: the fields come from authorize()'s return value, which was
          // built from VERIFIED claims. `user` is only populated on this first pass.
          const u = user as unknown as {
            id?: string;
            role?: string;
            idToken?: string;
          } | null;
          token.accessToken = u?.idToken;
          token.role = u?.role ?? "PARTICIPANT";
          token.id = u?.id ?? token.sub ?? "";
          /**
           * ⚠ RECORD THE EXPIRY ON THIS PATH TOO. Omitting it caused a LOGIN LOOP: "Signing you
           * in… / Checking your session" with the page refreshing forever.
           *
           * `needsRefresh(undefined)` deliberately returns TRUE, an unknown expiry must not be
           * trusted. But this path has no Cognito refresh token (the browser holds it, in
           * Amplify), so the very next session read went: needsRefresh → true → no refreshToken →
           * `refreshFailed = true` → `session()` withholds the bearer → every call 401s → the
           * expired-session redirect fires → /login resumes → repeat.
           *
           * Every piece behaved exactly as designed. The bug was that I added the refresh path
           * for the Hosted-UI provider and did not carry its bookkeeping to the other one.
           */
          const t = token as AppToken;
          t.accessTokenExpiresAt = u?.idToken ? expiryOf(u.idToken) : 0;
        } else {
          // Hosted UI: capture the Cognito ID token (our API bearer) and derive the
          // authoritative role from its claims.
          const idToken = account.id_token as string | undefined;
          token.accessToken = idToken;
          token.role = roleFromIdToken(idToken);
          token.id = (profile?.sub as string) ?? token.sub ?? "";
          /**
           * CAPTURE THE REFRESH TOKEN, this is the only moment it is available. Cognito returns
           * it once, on the authorization-code exchange; it is not reissued on later refreshes.
           *
           * Only the Hosted-UI path has one. The custom-UI bridge receives an ID token the
           * browser already obtained via Amplify, and Amplify keeps its own refresh token
           * client-side, so that path renews through /login's resume rather than here.
           */
          const t = token as AppToken;
          t.refreshToken = account.refresh_token as string | undefined;
          t.accessTokenExpiresAt = idToken ? expiryOf(idToken) : 0;
        }
        return token;
      }

      /**
       * ── EVERY SUBSEQUENT CALL: RENEW BEFORE THE BEARER GOES STALE ──
       *
       * Reached on each session read (`updateAge: 60`), which is what makes this the right place:
       * the token is refreshed as a side effect of normal use rather than by a timer the user
       * cannot see.
       *
       * WITHOUT THIS, the 30-minute ID token simply expired and every API call 401'd, the
       * reported "Backend error: 401" on a page left open. The redirect that now handles it stays
       * as the backstop for a refresh that CANNOT succeed (spent token, disabled user); this
       * removes the case where nothing was wrong except elapsed time.
       */
      const t = token as AppToken;
      if (!needsRefresh(t.accessTokenExpiresAt, Date.now())) {
        /**
         * SELF-HEALING, and deliberately unconditional: a token that is not due for refresh is a
         * token we are willing to send, so any leftover failure flag is stale by definition.
         *
         * Without this, a cookie stamped during the loop stayed poisoned until it expired 30 days
         * later, even though its bearer was valid the whole time. Recovering state is better than
         * documenting a workaround.
         */
        if (t.refreshFailed) t.refreshFailed = false;
        return token;
      }
      if (!t.refreshToken) {
        /**
         * NO SERVER-SIDE REFRESH TOKEN, and this is the CUSTOM-UI path, where that is normal
         * rather than a fault. The browser authenticated directly with Amplify, which keeps the
         * refresh token client-side; `AuthFlow`'s resume calls `fetchAuthSession()` (which renews
         * the ID token itself) and re-mints this session through the `cognito-token` provider.
         *
         * ⚠ NOT MARKED `refreshFailed`, and marking it is what caused a LOGIN LOOP: "Signing you
         * in… / Checking your session", refreshing forever. Withholding the bearer made every
         * call 401, the expired-session redirect fired, /login's resume succeeded, and the whole
         * cycle repeated, each step behaving exactly as designed.
         *
         * So the bearer is LEFT IN PLACE and allowed to age out. Two reasons that is right:
         *   - The gateway verifies the token against the pool's JWKS on every call, so an expired
         *     one is refused THERE. Withholding it here buys nothing except a 401 one round trip
         *     earlier, at the cost of refusing a token that is still perfectly valid whenever
         *     the expiry is merely unknown.
         *   - When it genuinely expires, the 401 drives the same expired-session redirect, and
         *     the resume path renews it without a password or a TOTP code. That is the intended
         *     renewal for this provider; short-circuiting it here only removed the renewal.
         */
        return token;
      }

      const refreshed = await refreshCognitoIdToken(t.refreshToken);
      if (!refreshed) {
        auditLog({
          event: "auth.token_refresh.failure",
          actor: { id: t.id },
          outcome: "failure",
          reason: "Cognito token refresh failed, refresh token may be expired or revoked",
        });
        t.refreshFailed = true;
        return token;
      }

      t.accessToken = refreshed.idToken;
      t.accessTokenExpiresAt = refreshed.expiresAt;
      // RE-DERIVED FROM THE NEW TOKEN, never carried over: a group change (promotion, or a
      // revoked role) takes effect on the next refresh rather than persisting for 30 days.
      t.role = roleFromIdToken(refreshed.idToken) as AppToken["role"];
      // Cognito does NOT return a new refresh token on this grant, so the existing one is kept.
      t.refreshFailed = false;
      return token;
    },
    session({ session, token }) {
      // The runtime JWT interface can't be augmented from this app (see the note
      // in types/next-auth.d.ts), so read the identity fields through AppToken.
      const t = token as AppToken;
      if (session.user) {
        session.user.id = t.id ?? "";
        session.user.role = t.role;
        /**
         * ── ⚠ THE BEARER IS DELIBERATELY *NOT* SET HERE, AND THAT IS THE FIX ───────────────────
         *
         * This used to read `session.accessToken = t.refreshFailed ? undefined : t.accessToken`.
         * In Auth.js v5 EVERYTHING THIS CALLBACK RETURNS IS THE JSON BODY OF THE PUBLIC
         * `GET /api/auth/session` ENDPOINT, which `<SessionProvider>` makes every page fetch. So
         * the Cognito ID token was handed to in-page JavaScript on every page load, and that token
         * is the sole bearer for every `/v1/*` service call (`lib/backend.ts`): a copy read out of
         * the browser is replayable against the gateway with no portal gate in the way. This was
         * raised as a security finding.
         *
         * ⚠ NO CLIENT CODE EVER NEEDED IT. All six consumers were server-side, and they now read it
         * from the encrypted JWT cookie via `getAccessToken()` in `lib/server-token.ts`, the same
         * value, one tier lower, never serialised to the browser.
         *
         * ⚠ THE `refreshFailed` EVICTION SEMANTICS MOVED WITH IT, they were not dropped.
         * `getAccessToken()` returns undefined when `refreshFailed` is set, so `protectedProcedure`
         * still throws UNAUTHORIZED on an absent token and the client still turns that into the
         * expired-session redirect that already exists. Passing a KNOWN-STALE token instead would
         * be the same outcome one network round trip later, with a confusing error in the service
         * logs.
         *
         * The type augmentation for `Session.accessToken` is gone too (`types/next-auth.d.ts`), so
         * re-adding this line is a compile error rather than a silent regression.
         */
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});
