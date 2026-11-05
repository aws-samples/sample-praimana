/**
 * ── THE BOUNDS ON THE tRPC DOOR ───────────────────────────────────────────────────────────────
 *
 * Separate from the route so the route handler, the rate-limiting middleware and the tests all read
 * the same numbers, and so a test can assert the door is configured rather than re-stating a
 * literal. The fixes for two security findings, no batch/body/rate bound and unbounded input
 * schemas, both land here.
 */

/**
 * The most procedures one HTTP request may name.
 *
 * ⚠ DERIVED FROM WHAT THE CLIENT ACTUALLY BATCHES, not picked round. `httpBatchLink` coalesces the
 * queries a page mounts within its batching window; the densest screens in this app mount on the
 * order of five or six concurrent queries (the admin dashboard and the team board are the busiest).
 * Ten leaves headroom for a page that grows without leaving an unbounded multiplier in front of
 * procedures that fan out to ~26 upstream calls each.
 *
 * ⚠ IF A LEGITIMATE PAGE EVER TRIPS THIS, RAISE IT DELIBERATELY AND SAY WHY, do not remove the cap.
 * The failure mode is visible (a 413 in the browser console on a page load) rather than silent,
 * which is the point of choosing a number at all.
 */
export const MAX_TRPC_BATCH_CALLS = 10;

/**
 * The most bytes a tRPC request body may carry, checked before it is parsed.
 *
 * App Router route handlers have NO default body-parser cap, so without this the only ceiling was
 * the Lambda payload limit, six megabytes of superjson parsed into memory on the SSR tier before a
 * single Zod schema ran. 128 KiB is far above any legitimate mutation in this router (the largest
 * are a 4,000-character chat message and a workshop description) and far below a useful amount of
 * memory pressure.
 */
export const MAX_TRPC_BODY_BYTES = 128 * 1024;

/**
 * Per-user ceilings on tRPC procedure calls, applied as middleware where the session already exists.
 *
 * ⚠ THESE COUNT PROCEDURES, NOT REQUESTS, which is deliberate: under batching a request is not a
 * unit of work, and the amplifiers are per-procedure. A batch of ten counts ten.
 *
 * The busiest legitimate client is a user with the chat page open (`refetchInterval` 3000) plus the
 * AI page in another tab (5000) plus the 60-second admin and activity polls, each poll batching a
 * handful of procedures, order 150-200 procedure calls a minute. 600 leaves roughly a 3× margin and
 * still bounds one caller to ten procedure calls a second.
 */
export const MAX_TRPC_CALLS_PER_MINUTE = 600;

/**
 * Ceiling on `rating.analyze`, THE ONE BILLABLE MODEL CALL in the router.
 *
 * Its cooldown lives entirely in the evaluation service (`routers/rating.ts` says so), so the portal
 * contributed no bound of its own to Bedrock spend. Six per five minutes per user is well above the
 * interactive use the UI supports, one analysis per team, read before re-running, and far below
 * what a loop could drive.
 */
export const MAX_RATING_ANALYZE_PER_WINDOW = 6;

/** The window `MAX_RATING_ANALYZE_PER_WINDOW` applies over. */
export const RATING_ANALYZE_WINDOW_MS = 5 * 60_000;
