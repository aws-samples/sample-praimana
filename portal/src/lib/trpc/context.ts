import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/server-token";

/**
 * The per-request tRPC context: who is calling, and the bearer to forward upstream.
 *
 * ⚠ THE TOKEN COMES FROM THE JWE COOKIE, NOT FROM THE SESSION. It used to read
 * `session?.accessToken`, which required the `session()` callback to copy the Cognito ID token onto
 * the session object, and in Auth.js v5 that object is also the body of the public
 * `GET /api/auth/session` endpoint every page fetches. The value
 * here is identical; only its route to this function changed.
 *
 * `req` is supplied by `fetchRequestHandler`, which passes `{ req, resHeaders, info }` to
 * `createContext`. It is what `getAccessToken` reads the cookie from.
 */
export async function createContext({ req }: { req: Request }) {
  const [session, accessToken] = await Promise.all([auth(), getAccessToken(req)]);
  return {
    session,
    accessToken,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
