"use client";

import { useState } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { SessionProvider, signOut } from "next-auth/react";
import superjson from "superjson";
import { trpc } from "@/lib/trpc/client";
import { IdleTimeout } from "@/components/IdleTimeout";
import { isForbidden, isRateLimited, isUnauthorized } from "@/lib/trpc/errors";

/**
 * Evict a session the backend has stopped accepting.
 *
 * Deliberately a LOCAL sign-out, it clears ONLY this app's cookie, unlike the
 * "Sign out" menu item (lib/sign-out.ts), which also drops Amplify's Cognito tokens
 * and ends the IdP session. The distinction is about intent, not thoroughness:
 *
 *   - A user clicking "Sign out" is asking to END the session. Leaving the Cognito
 *     tokens alive there is the bug, the next visit to /login would resume straight
 *     back in, so the button would appear to do nothing.
 *   - Landing here usually means the 30-minute ID token simply EXPIRED. The user
 *     never asked to leave. Amplify's refresh token is still good, so /login's
 *     resume path mints a fresh app session without a password or a TOTP code -
 *     which is exactly the near-silent renewal we want for an expiry, and why this
 *     function must NOT touch the Amplify tokens.
 *
 * A revoked role or a disabled user also arrives here, but the resume path
 * re-verifies the refreshed token server-side and applies the same role gate, so a
 * live Cognito session cannot hand back access it shouldn't.
 *
 * THIS IS THE EXPIRY PATH, AND IT IS NOT THE IDLE PATH. <IdleTimeout /> below is the
 * other one: no interaction for IDLE_TIMEOUT_MS means the user has actually left, so it
 * runs the FULL teardown (signOutEverywhere, Amplify + NextAuth + IdP) and re-entry
 * costs a password and a TOTP code. Both behaviours coexist deliberately, and the
 * trigger is what tells them apart: arriving HERE means a request failed, which means
 * the user was present; arriving THERE means nobody touched the app at all. Making this
 * function do the full teardown would charge a TOTP code to someone who spent 31
 * minutes reading one page.
 */
/**
 * ⚠ GUARDED AGAINST RE-ENTRY, because it is called from a per-query callback.
 *
 * A page can have several queries in flight (insights has three, code has two). When the token
 * expires they all 401 within milliseconds, so this ran once per failed query, several
 * concurrent `signOut()` round trips, each racing to navigate. The visible symptom was the
 * reported one: the error screen rendering while redirects fought, and no redirect landing.
 *
 * The flag is module-scoped rather than component state deliberately: it must outlive any
 * re-render and be shared by every caller, and the page is about to be replaced anyway.
 */
let evicting = false;

function evictExpiredSession() {
  if (evicting) return;
  evicting = true;

  /**
   * ── ⚠ THE REDIRECT NO LONGER WAITS FOR THE SIGN-OUT ROUND TRIP ────────────────────────────
   *
   * THE REQUIREMENT: redirect users to login immediately on any 401.
   *
   * This used to be `void signOut({ callbackUrl: "/login" })` and nothing else, so the navigation
   * happened only once a POST to `/api/auth/signout` had completed. React renders the failed query's error
   * state on the SAME TICK, so for the whole duration of that request the user sat on a screen telling
   * them the team's data was missing and inviting them to report a bug, for what is only an expired login.
   * The gate's `expired` state was added to paper over exactly this race; the honest fix is to stop racing.
   *
   * ⚠ `replace`, NOT `href`/`assign`: it leaves no history entry, so Back cannot return to a page whose
   * every query 401s. `href` was the old fallback and would have made the dead page reachable again.
   *
   * ⚠ AND THE SIGN-OUT IS STILL FIRED, deliberately unawaited, purely for cookie hygiene. A hard
   * navigation may cancel it in flight, which is acceptable: `/login` is PUBLIC (middleware keeps it
   * reachable while signed in, precisely so a broken session can be repaired) and its resume path
   * re-verifies the refreshed token server-side before minting a new app session. So a surviving stale
   * cookie cannot hand back access, and in the common case, the 30-minute ID token simply expiring -
   * Amplify's refresh token gets the user straight back without a password or a TOTP code.
   *
   * ⚠ NO `?redirect=` BACK TO THE CURRENT PAGE, and that is deliberate rather than an omission. The login
   * page documents the rule: "we send everyone to '/' and let that single decision point route", because
   * `landingPathForRole` chooses the destination from the role resolved SERVER-SIDE. Returning someone to
   * the exact URL they 401'd on would bypass that, and a participant bounced off a staff page would be
   * sent straight back to a page middleware refuses them. It would also add an open-redirect parameter to
   * the one route that must stay reachable in every broken state.
   */
  void signOut({ redirect: false }).catch(() => {});
  window.location.replace("/login");
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        /**
         * ── ⚠ ONE HANDLER FOR EVERY SERVICE CALL, NOT ONE PER CALL SITE ───────────────────────
         *
         * THE REQUIREMENT: every service call on the portal redirects the user to the login page on a 401.
         *
         * ⚠ THE `retry` CALLBACK BELOW WAS NOT THAT, AND THAT IS WHY THIS EXISTS. React Query consults `retry`
         * only when it is DECIDING WHETHER TO RETRY, so a query that sets `retry: false` for its own reasons,
         * or any mutation, produced a 401 that nothing acted on. The eviction was reachable by most calls and
         * guaranteed for none.
         *
         * `QueryCache`/`MutationCache` `onError` fire for EVERY failure, unconditionally, whatever a call site
         * configured. That makes the redirect a property of the client rather than a habit each caller has to
         * remember, which is the difference the request was pointing at.
         *
         * The `retry` callback KEEPS its 401 branch: not for the eviction, but because retrying a 401 buys
         * three refusals in the service's logs and delays the screen by two round trips.
         */
        queryCache: new QueryCache({
          onError: (error) => {
            if (isUnauthorized(error)) evictExpiredSession();
          },
        }),
        mutationCache: new MutationCache({
          onError: (error) => {
            if (isUnauthorized(error)) evictExpiredSession();
          },
        }),
        defaultOptions: {
          queries: {
            retry: (failureCount: number, error: unknown) => {
              if (isUnauthorized(error)) {
                evictExpiredSession();
                return false;
              }
              /**
               * A REFUSAL IS NOT RETRIED, and the difference from the line above is worth
               * being explicit about: UNAUTHORIZED means "we don't know who you are" and
               * ends the session; FORBIDDEN means "we know exactly who you are, and no".
               * Nothing about a rule changes between two attempts 200 ms apart, so a retry
               * buys three refusals in the service's logs instead of one and delays the
               * screen's explanation by two round trips.
               *
               * This matters now because the four team-content surfaces are member-only:
               * every non-member who opens a board, chat, AI, code, insights or
               * phases page produces a 403 by design, and the insights page alone makes four
               * such calls. Retried twice each, that is a routine navigation generating
               * twelve refused requests.
               */
              if (isForbidden(error)) return false;
              /**
               * A 429 IS NOT RETRIED EITHER, and this one must not be: retrying it makes the
               * exact condition worse.
               *
               * Two sources produce a 429 here, the AI service's cooldown and in-progress
               * refusals, and API Gateway's own throttle. In both cases the server has just said
               * "less". Retrying twice turns one refused Refresh into THREE requests per query,
               * 18 backend calls from a single click, with no backoff, at the moment the platform
               * is shedding load. That is amplification, and it violates the standing rule that
               * backpressure must propagate to the source rather than be answered with more
               * traffic.
               *
               * Unlike FORBIDDEN, this one WILL succeed later, but "later" is the user's next
               * click, not 200ms from now, and the screen's job is to say so.
               */
              if (isRateLimited(error)) return false;
              return failureCount < 2;
            },
          },
          mutations: {
            onError: (error: unknown) => {
              if (isUnauthorized(error)) {
                evictExpiredSession();
              }
            },
          },
        },
      })
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
        }),
      ],
    })
  );

  return (
    <SessionProvider>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {/* ONE inactivity timer for the whole authenticated app, mounted here rather
              than per-page: a per-page timer would restart on every navigation (so
              clicking around would be indistinguishable from idling) and would leave
              whichever page someone forgot to add it to unprotected. It renders null
              until it has something to say, and arms nothing at all for an anonymous
              visitor, so it is harmless on /login and /join/<token>. */}
          <IdleTimeout />
          {children}
        </QueryClientProvider>
      </trpc.Provider>
    </SessionProvider>
  );
}
