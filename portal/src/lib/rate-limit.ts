/**
 * ── IN-MEMORY RATE LIMITER (SLIDING WINDOW) ─────────────────────────────────────────────────
 *
 * Per-key request throttling. CALL SITES: `POST /api/invite` (`invite/route.ts`), the tRPC
 * `protectedProcedure` middleware (`lib/trpc/trpc.ts`, plus a tighter window on the one billable
 * procedure) and `GET /api/desktop/team-data`. The rest of this comment is about what that does and
 * does NOT buy, because the original version of it overstated all three and a security review
 * called each one out.
 *
 * ⚠ IT WAS ONE CALL SITE FOR TOO LONG, AND THAT WAS ITSELF A FINDING. A security review
 * noted that the only limiter in the tree was bound to one unrelated route while
 * `/api/trpc`, reachable by every signed-in role including PARTICIPANT, batching enabled, with
 * per-call fan-out amplifiers behind it, had no application-layer bound at all.
 *
 * The design is a sliding-window counter: requests in the last `windowMs` are counted, and calls
 * beyond `maxRequests` in that window are refused with 429.
 *
 * ⚠ 1. IT IS PER-PROCESS, AND "A SINGLE COMPUTE ORIGIN PER BRANCH" DID NOT MAKE IT EFFECTIVE.
 * That was the claim here and it confused routing with process identity: Amplify Next.js SSR runs on
 * Lambda and SCALES OUT with concurrency, so an attacker sending N concurrent requests gets N
 * independent stores. The effective ceiling RISES WITH ATTACK INTENSITY, it is weakest at exactly
 * the moment it is needed. A shared store (DynamoDB conditional writes are the cheap fit here) or a
 * WAF rate rule at the edge is what would actually bound this.
 *
 * ⚠ 2. IT CANNOT BOUND THE RESOURCE IT MATTERS FOR. `invite-body.ts` correctly identifies the real
 * constraint as Cognito's POOL-WIDE admin quota, "the same one that would block a real user's
 * sign-in", and SES send capacity. Both are shared across every instance, so a per-process limiter
 * is not the control for "an invite flood causes a platform-wide auth outage". Do not count it as one.
 *
 * ⚠ 3. IT DOES NOT COVER INVITE TOKEN LOOKUPS, which this comment used to claim. `/join/<token>` is
 * PUBLIC and drives a backend lookup per request with no bearer and no limiter at all. That gap is
 * real and is tracked as an open gap, the bound belongs at the edge or in the service, not here.
 *
 * ⚠ WHAT IT IS GENUINELY WORTH, since the above reads as a demolition: it is cheap, correct, and the
 * `check()` runs BEFORE `req.json()`, so it bounds body parsing rather than only the expensive tail,
 * which is the single most valuable thing it does. As per-user friction against naive replay and
 * accidental double-submits it earns its place. It resets on deploy, and that is fine for that job.
 */

import {
  MAX_RATING_ANALYZE_PER_WINDOW,
  MAX_TRPC_CALLS_PER_MINUTE,
  RATING_ANALYZE_WINDOW_MS,
} from "@/lib/trpc/limits";

export interface RateLimitConfig {
  /** Time window in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per key within the window. */
  maxRequests: number;
}

interface WindowEntry {
  timestamps: number[];
}

/**
 * Create a rate limiter instance. Each instance maintains its own store, so different
 * routes can have independent limits.
 */
export function createRateLimiter(config: RateLimitConfig) {
  const store = new Map<string, WindowEntry>();

  // Periodic cleanup to prevent memory growth from expired entries.
  // Runs every 60s and removes entries whose newest timestamp is outside the window.
  const CLEANUP_INTERVAL_MS = 60_000;
  let lastCleanup = Date.now();

  function cleanup(now: number): void {
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
    lastCleanup = now;
    const cutoff = now - config.windowMs;
    for (const [key, entry] of store) {
      if (entry.timestamps.length === 0 || entry.timestamps[entry.timestamps.length - 1] < cutoff) {
        store.delete(key);
      }
    }
  }

  /**
   * Check whether a request from `key` is allowed.
   *
   * @returns `{ allowed: true }` if under the limit, or
   *          `{ allowed: false, retryAfterMs }` if the limit is exceeded.
   */
  function check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = Date.now();
    cleanup(now);

    const cutoff = now - config.windowMs;
    let entry = store.get(key);

    if (!entry) {
      entry = { timestamps: [] };
      store.set(key, entry);
    }

    // Remove timestamps outside the current window.
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= config.maxRequests) {
      // The oldest timestamp in the window tells us when the first slot will free up.
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + config.windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }

  return { check };
}

/**
 * Rate limiter for the invite endpoint.
 *
 * 10 requests per 60 seconds per authenticated user (keyed on user id). This prevents
 * automated replay of POST /api/invite while being generous enough for legitimate bulk
 * operations (a facilitator inviting multiple teams in quick succession).
 */
export const inviteRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
});

/**
 * Per-user ceiling on tRPC PROCEDURE CALLS, applied as middleware in `lib/trpc/trpc.ts` where the
 * session already exists, so it costs no second decrypt of the session cookie, and counts
 * procedures rather than requests (strictly tighter under batching).
 *
 * The number and its derivation live in `lib/trpc/limits.ts` alongside the batch and body caps, so
 * the three bounds on that door are read together.
 *
 * ⚠ STILL PER-PROCESS, see ⚠1 above, which applies here with more force than to invites, because
 * this is the path an attacker would pick. A shared store (DynamoDB conditional write) or an edge
 * rate rule is what bounds a CONCURRENT flood; this bounds a single misbehaving or replaying client,
 * which is the common case and the one that shows up in a bill.
 */
export const trpcRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: MAX_TRPC_CALLS_PER_MINUTE,
});

/**
 * A tighter window for `rating.analyze`, the one billable model call in the router, whose only
 * other cooldown lives in the evaluation service. See `lib/trpc/limits.ts`.
 */
export const ratingAnalyzeRateLimiter = createRateLimiter({
  windowMs: RATING_ANALYZE_WINDOW_MS,
  maxRequests: MAX_RATING_ANALYZE_PER_WINDOW,
});

/**
 * Rate limiter for `GET /api/desktop/team-data`, keyed on the VERIFIED Cognito `sub`.
 *
 * That route issues three concurrent `/v1/*` calls per request, so it is the desktop tier's
 * amplification primitive, and until `withBearer` started verifying the token, an ANONYMOUS caller
 * could drive it. Keyed on the verified subject rather than an IP
 * because identity is now established before the fan-out, which is what makes a per-user key mean
 * anything here.
 *
 * The desktop client polls this for board, chat and roster state; 120/min is 2/second, comfortably
 * above a foreground refresh loop.
 */
export const desktopTeamDataRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 120,
});
