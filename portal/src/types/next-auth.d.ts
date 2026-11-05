import type { UserRole } from "@praimana/shared";
import type { DefaultSession } from "next-auth";

// Module augmentation so the backend-issued identity (role + bearer token) is
// strongly typed everywhere instead of reached through `as any` casts. This is
// the highest-risk code in the app (identity & authorization), a `role` typo
// must fail at compile time, not silently at runtime.
declare module "next-auth" {
  /**
   * ── ⚠ `accessToken` IS ABSENT FROM `Session` ON PURPOSE, DO NOT PUT IT BACK ──────────────────
   *
   * It used to be declared here and assigned in `auth.ts`'s `session()` callback. In Auth.js v5
   * whatever that callback returns IS the JSON body of the public `GET /api/auth/session` endpoint,
   * which `<SessionProvider>` fetches from every page, so declaring the field is what made it
   * legal to ship the outbound `/v1/*` bearer to the browser.
   *
   * Server code reads the token from the encrypted JWT cookie via `getAccessToken()` in
   * `lib/server-token.ts`. Leaving it off this interface is what turns a re-added
   * `session.accessToken = …` into a compile error instead of a silent regression.
   */
  interface Session {
    user: {
      id: string;
      role?: UserRole;
    } & DefaultSession["user"];
  }

  interface User {
    role?: UserRole;
    accessToken?: string;
  }
}

// NOTE on the JWT token: in NextAuth v5 the canonical `JWT` interface lives in
// `@auth/core/jwt`, which isn't directly resolvable from this app (pnpm keeps it
// un-hoisted), so a `declare module` augmentation for it silently no-ops. The
// token is shaped explicitly at the trust boundary in `lib/auth.ts` via the
// exported `AppToken` type below instead.
export interface AppToken {
  id?: string;
  role?: UserRole;
  accessToken?: string;
  /**
   * Cognito's refresh token, used to mint a fresh ID token when the 30-minute one expires.
   *
   * Held in the NextAuth JWT, which is an ENCRYPTED httpOnly cookie (JWE), never readable by
   * client JavaScript and never sent to the browser as a value.
   *
   * ⚠ THE REASON THIS NOTE USED TO GIVE FOR KEEPING IT OFF THE SESSION WAS ITSELF THE BUG. It said
   * `session.accessToken` "is exposed to server components and the tRPC context", an inventory
   * that omitted the browser, which is where Auth.js v5 also sends it (`GET /api/auth/session`).
   * The conclusion was right and the reasoning was wrong, and the wrong reasoning is what let the
   * 30-minute token be copied onto the session for years. NEITHER token goes there now: both are
   * read server-side from this cookie by `lib/server-token.ts`.
   */
  refreshToken?: string;
  /** Epoch ms at which `accessToken` expires, read from the ID token's own `exp` claim. */
  accessTokenExpiresAt?: number;
  /**
   * Set when a refresh ATTEMPT FAILED. The token is kept (not cleared) so the session still
   * identifies the user, and `session()` reads this to withhold `accessToken`, which turns the
   * next API call into a 401 and drives the expired-session redirect that already exists,
   * rather than inventing a second eviction path.
   */
  refreshFailed?: boolean;
}
