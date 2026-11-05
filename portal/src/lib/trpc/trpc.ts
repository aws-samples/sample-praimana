import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { BackendError } from "@/lib/backend";
import { genericMessage, sanitizeErrorMessage } from "@/lib/sanitize-error";
import type { Context } from "./context";
import { auditLog } from "@/lib/audit-logger";
import { ratingAnalyzeRateLimiter, trpcRateLimiter } from "@/lib/rate-limit";
import { MAX_TRPC_CALLS_PER_MINUTE } from "@/lib/trpc/limits";

/**
 * ── ⚠ THE STACK MUST NEVER LEAVE A PRODUCTION SERVER ─────────────────────────────────────
 *
 * ASKED, on seeing a dev error response: "why are we sending the whole stack error in response?"
 *
 * tRPC's default already answers it, `getErrorShape` attaches `data.stack` only when `isDev`, which defaults
 * to `NODE_ENV !== "production"`. So the deployed portal strips it and the local dev server does not, which is
 * how the `BackendError`-not-recognised bug above was diagnosed at all.
 *
 * ⚠ SO WHY OVERRIDE IT. Because as it stood, a genuine disclosure control rested entirely on one environment
 * variable being exactly the string "production", with nothing asserting it. A build that set `NODE_ENV=dev`,
 * or left it unset, would ship absolute filesystem paths and the internal module graph to every browser that
 * saw an error, silently, and looking completely normal. This makes the guarantee OURS and testable rather
 * than a framework default nobody checks.
 *
 * The stack is deliberately KEPT in development: it is the only thing that made the bug above findable.
 *
 * ⚠ MESSAGE SANITIZATION, AND IT IS DEFAULT-DENY FOR UPSTREAM TEXT. This repository is the single point
 * every service's error text passes through on its way to a browser, and it has already carried an account
 * id and a role ARN to a portal reader once (scrubbed since at the ai service's edge by
 * `isClientErrorContent`, one service out of eleven). So a SERVICE message now reaches the browser only
 * when the service attached a machine-readable `code`; everything else becomes a generic message for the
 * status. Errors raised HERE keep their text, see the formatter for why that distinction is the whole
 * design. `sanitize-error.ts` carries the reasoning.
 */
const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * tRPC codes this repository raises ON PURPOSE, whose messages are safe to show.
 *
 * Each is produced by a resolver or middleware refusing something explicitly, from input the
 * CALLER supplied, a Zod message naming the field they got wrong, a role refusal, a conflict. None
 * of them can contain infrastructure detail, and generalising them would replace "URL must use http
 * or https" with "The request was invalid", which tells the person who typed the URL nothing.
 *
 * ⚠ AN ALLOWLIST, NOT A DENYLIST, AND DELIBERATELY SO. `INTERNAL_SERVER_ERROR` is what tRPC assigns
 * to every unrecognised thrown value, so anything unexpected lands OUTSIDE this set and is
 * generalised. A new code added here is a decision to disclose its message.
 */
const DELIBERATE_REFUSALS: ReadonlySet<string> = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "NOT_FOUND",
  "TOO_MANY_REQUESTS",
]);

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (IS_DEV) return shape;
    /* Rebuilt without `stack` rather than deleted from, so a future field cannot be missed by mutation. */
    const { stack: _stack, ...data } = shape.data as Record<string, unknown> & { stack?: unknown };

    /**
     * ⚠ ONLY AN UPSTREAM MESSAGE IS SANITISED, AND WORKING OUT WHICH ONE IT IS HAPPENS HERE.
     *
     * `asBackendError(error.cause)` is the same duck-typed probe `mapBackendErrors` uses, for the
     * same reason: the original error is under `cause` because tRPC wraps whatever the resolver
     * threw. A hit means the text came from a SERVICE, so it is subject to the default-deny rule
     * and passes only when the service attached a `code`.
     *
     * A MISS means this repository raised it, Zod input validation, the UNAUTHORIZED from
     * `protectedProcedure`, our own FORBIDDEN throws. Those are built from the caller's own input
     * and carry no infrastructure detail, so the message stands. Generalising them would turn
     * "URL must use http or https" into "The request was invalid", which tells the person who
     * typed the URL nothing at all, a real loss for no security gain.
     */
    const upstream = asBackendError(error.cause) ?? asBackendError(error);
    if (!upstream) {
      /**
       * ⚠ AND HERE THE POLICY WAS DEFAULT-*ALLOW*, WHICH WAS A HOLE. The comment above enumerates
       * the cases this branch is FOR, Zod validation, `UNAUTHORIZED`, our own `FORBIDDEN`, and
       * the code then passed through everything ELSE as well, including the case nobody listed: an
       * unexpected exception. A `TypeError`, an AWS SDK error, a Node `ENOENT: … open
       * '/var/task/…'` all reach the browser verbatim in production, because tRPC sets
       * `message: error.message` with no masking of its own.
       *
       * That is the exact class `SENSITIVE_PATTERNS` exists to catch, `sanitize-error.ts` already
       * matches `/var/…`, and the denylist was never reached on this path. `apiAuth.ts` gets the
       * same situation right, and its correctness is what showed this one up.
       *
       * ⚠ SO THE PASSTHROUGH IS NOW AN ALLOWLIST OF DELIBERATE THROWS, keyed on the tRPC code
       * rather than on "not upstream". Those four codes are only ever produced by a resolver or a
       * middleware refusing something on purpose, and their messages are built from the caller's
       * own input. Everything else, above all `INTERNAL_SERVER_ERROR`, which is what tRPC assigns
       * to every unrecognised thrown value, gets a generic message for its status.
       */
      return DELIBERATE_REFUSALS.has(shape.data.code)
        ? { ...shape, data }
        : { ...shape, message: genericMessage(shape.data.httpStatus), data };
    }

    return {
      ...shape,
      message: sanitizeErrorMessage(upstream.message, upstream.status, upstream.code),
      data,
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Map a backend HTTP status to the closest tRPC error code. */
function trpcCodeForStatus(status: number): TRPCError["code"] {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "TOO_MANY_REQUESTS";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST";
  }
}

/**
 * Translate a {@link BackendError} thrown by `backendFetch` into a `TRPCError`
 * that carries the right code, so the client can branch on `error.data.code`
 * instead of string-matching messages. Any other thrown value is left alone
 * (tRPC will surface it as INTERNAL_SERVER_ERROR).
 */
/**
 * ── ⚠ `instanceof` IS NOT RELIABLE HERE EITHER, AND THIS IS THE PROOF ────────────────────
 *
 * REPORTED THREE TIMES, ending with the response payload that finally named it:
 *
 *     "code": "INTERNAL_SERVER_ERROR", "httpStatus": 500,
 *     "stack": "BackendError: Backend error: 401\n at backendFetch (webpack-internal:///(rsc)/./src/lib/backend.ts…"
 *
 * A REAL `BackendError` carrying status 401 was thrown, this middleware ran (the stack shows it), and
 * `instanceof` returned FALSE, so the error fell through unmapped and tRPC surfaced it as a 500. The client
 * therefore never saw `UNAUTHORIZED`, which is why every 401 guard downstream stayed silent and the user got
 * "the data is missing … report it and quote the message" for an expired login.
 *
 * ⚠ THE CAUSE IS MODULE IDENTITY, NOT LOGIC. `instanceof` compares the class OBJECT, and webpack can evaluate
 * `@/lib/backend` more than once, across the `(rsc)` boundary, or after HMR replaces one copy while this
 * module still holds the old binding. `errors.ts` documents exactly this failure for `TRPCClientError` on the
 * client; the same trap was sitting on the server and nothing had caught it because the SYMPTOM is a wrong
 * status code rather than a crash.
 *
 * ⚠ AND IT WAS BREAKING EVERY STATUS, NOT ONLY 401. While this misfires, a 403 cannot reach the
 * "member-only" screen and a 429 cannot reach the rate-limit screen, all of them arrive as 500. The 401
 * report is simply the one somebody noticed.
 *
 * Duck-typed, with `instanceof` kept FIRST because when it matches it is unambiguous.
 */
function asBackendError(
  err: unknown
): { status: number; message: string; code?: string } | null {
  if (err instanceof BackendError) {
    return { status: err.status, message: err.message, code: err.code };
  }
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; status?: unknown; message?: unknown; code?: unknown };
  /**
   * Both witnesses required. `name` alone would match a hand-rolled error someone named the same way; a
   * numeric `status` alone would match half the fetch failures in the ecosystem.
   */
  if (e.name !== "BackendError" || typeof e.status !== "number") return null;
  return {
    status: e.status,
    message: typeof e.message === "string" ? e.message : "Backend error",
    /**
     * ⚠ CARRIED THROUGH BECAUSE THE SANITISER'S POLICY TURNS ON IT. Its PRESENCE is what says a
     * human wrote this message for a reader; absent, the text is generalised. Read defensively -
     * a duck-typed error from another webpack copy may have no `code` at all, and "no code" is
     * the safe answer for it.
     */
    code: typeof e.code === "string" ? e.code : undefined,
  };
}

/**
 * Statuses whose refusal is worth an audit record.
 *
 * 401 (the credential was rejected), 403 (the entitlement was refused) and 409 (a state-machine
 * conflict, a second publish, a reopen of something already reopened). A 404 on a read is noise and
 * a 5xx is an outage, not a decision, so neither is recorded here.
 */
const AUDITED_REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 409]);

const mapBackendErrors = t.middleware(async ({ ctx, path, type, next }) => {
  /**
   * ── ⚠ `next()` DOES NOT THROW. THIS IS THE BUG, AND IT WAS NEVER THE `instanceof`. ───────
   *
   * REPORTED FOUR TIMES as "Couldn't load this team's AI conversations … Backend error: 401", and reproduced
   * against this exact chain: a `BackendError(401)` came out the other side as `INTERNAL_SERVER_ERROR`.
   *
   * ⚠ THE ORIGINAL CODE WAS `try { return await next() } catch (err) { … }`, AND THE CATCH NEVER RAN. tRPC
   * middleware does not propagate resolver failures as exceptions, `next()` RESOLVES with a
   * `MiddlewareResult`: `{ ok: true, data }` or `{ ok: false, error }`. So the try block always succeeded, the
   * catch was dead code, and every backend status fell through unmapped to tRPC's default 500.
   *
   * ⚠ AND IT LOOKED EXACTLY LIKE A CLASS-IDENTITY PROBLEM. The stack showed this middleware running and the
   * error arriving as a 500 with `BackendError: Backend error: 401` in the trace, the signature of a failed
   * `instanceof` across duplicated webpack copies, which this codebase has genuinely suffered elsewhere
   * (`errors.ts`). I duck-typed the check on that theory and it changed nothing, because the comparison was
   * never reached. The duck-typing is KEPT, it is still correct, and `cause` crosses boundaries, but it was
   * not the fault.
   *
   * ⚠ THE ORIGINAL ERROR IS UNDER `cause`. tRPC wraps whatever the resolver threw in a `TRPCError` and keeps
   * the original there, so the status has to be read from `result.error.cause`. Reading `result.error` alone
   * finds only tRPC's own INTERNAL_SERVER_ERROR and maps a 401 to a 500, the bug, restated.
   *
   * ⚠ CONSEQUENCE, WHICH IS WIDER THAN THE REPORT: while this was broken, NO backend status reached the
   * client. A 403 could not produce the "member-only" screen, a 429 could not produce the rate-limit screen,
   * and a 404 could not produce "not found". Every one of them was a 500. The 401 is simply the one a human
   * noticed, because it is the one with a visible remedy.
   */
  const result = await next();

  if (!result.ok) {
    const backend = asBackendError(result.error.cause) ?? asBackendError(result.error);
    if (backend) {
      /**
       * ── ⚠ A REFUSED MUTATION IS RECORDED HERE, AND NOWHERE ELSE WOULD DO ────────────────────
       *
       * Every `auditLog` call in the routers sits AFTER its `backendFetch` resolves, so the audit
       * trail recorded successes only: a refused attempt against a privileged operation left no
       * trace in this component at all. None of the four judging-pipeline mutations recorded a
       * refusal, `submission.release` hands a team's work to the judges, `reopen` withdraws a
       * published ranking, `publishResults` irreversibly fixes it, while `/api/trpc` is reachable
       * by every signed-in role. An investigator reading these logs could not see that an attempt
       * was made, how many, or by whom.
       *
       * ⚠ THIS MIDDLEWARE IS THE ONE PLACE EVERY FAILED MUTATION ALREADY PASSES THROUGH, which is
       * why the record goes here rather than into twenty resolvers that would each have to remember.
       * `workshop.create` shows the intended shape (`authz.workshop.create.denied`); this generalises
       * it without asking every future mutation to opt in.
       *
       * ⚠ MUTATIONS ONLY, DELIBERATELY. A 403 on a query is the role gates doing their job on a
       * screen someone opened, and recording those would bury the writes in noise, the opposite of
       * the reviewability this exists for.
       */
      if (type === "mutation" && AUDITED_REFUSAL_STATUSES.has(backend.status)) {
        auditLog({
          event: "authz.trpc.denied",
          actor: { id: ctx.session?.user?.id, role: ctx.session?.user?.role },
          outcome: "denied",
          reason: `Upstream refused ${path} with ${backend.status}`,
          /**
           * The procedure path and the upstream code, not the message: the message is service text
           * subject to the default-deny sanitisation policy above, and an audit record is not the
           * place to reintroduce it.
           */
          metadata: { path, status: backend.status, code: backend.code },
        });
      }

      throw new TRPCError({
        code: trpcCodeForStatus(backend.status),
        message: backend.message,
        cause: result.error.cause instanceof Error ? result.error.cause : undefined,
      });
    }
  }

  return result;
});

/** Exported for the tests: the duck-typing is the fix, so it has to be exercised directly. */
export { asBackendError };

export const protectedProcedure = t.procedure.use(mapBackendErrors).use(async ({ ctx, next }) => {
  if (!ctx.session?.user?.id || !ctx.accessToken) {
    auditLog({
      event: "authz.trpc.unauthorized",
      actor: { id: ctx.session?.user?.id },
      outcome: "denied",
      reason: "No valid session or access token for protected procedure",
    });
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  /**
   * ── ⚠ THE PER-USER BOUND ON THIS DOOR, AND WHY IT IS HERE RATHER THAN IN THE ROUTE ───────────
   *
   * `/api/trpc` had no rate limit of any kind: the repository's only limiter was bound to
   * `POST /api/invite`, while this path is reachable by every signed-in role, has batching enabled,
   * and fronts procedures that each fan out to ~26 upstream calls.
   *
   * ⚠ IT COUNTS PROCEDURES, NOT REQUESTS, and that is the reason for this placement. Under batching
   * a request is not a unit of work, one HTTP request can name ten procedures, so a
   * request-counting limiter in the route would be off by the batch factor exactly when it matters.
   * Here the session already exists, so this also costs no second decrypt of the session cookie.
   *
   * The route still owns the two bounds that must happen BEFORE parsing and need no identity: the
   * batch cap and the body cap. See `api/trpc/[trpc]/route.ts` and `lib/trpc/limits.ts`.
   *
   * ⚠ REFUSED WITH `TOO_MANY_REQUESTS`, which the client already renders as the rate-limit screen -
   * `trpcCodeForStatus` maps 429 to it for upstream refusals, so this reuses a path that exists
   * rather than inventing a second one.
   */
  const limit = trpcRateLimiter.check(ctx.session.user.id);
  if (!limit.allowed) {
    auditLog({
      event: "authz.trpc.rate_limited",
      actor: { id: ctx.session.user.id, role: ctx.session.user.role },
      outcome: "denied",
      reason: `Exceeded ${MAX_TRPC_CALLS_PER_MINUTE} procedure calls per minute`,
      metadata: { retryAfterMs: limit.retryAfterMs },
    });
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please wait a moment and try again.",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: { ...ctx.session.user, id: ctx.session.user.id as string },
      token: ctx.accessToken,
    },
  });
});

/**
 * `protectedProcedure` plus a much tighter per-user window, for the one BILLABLE model call.
 *
 * ⚠ ONE CALL SITE BY DESIGN: `rating.analyze`. Its only other cooldown lives in the evaluation
 * service, so before this the portal contributed no bound at all to Bedrock spend, a caller could
 * loop it as fast as the general limiter allowed. Separated as its own procedure rather than an
 * inline check so the cost of adding a second billable call is noticing which base to extend.
 */
export const billableProcedure = protectedProcedure.use(async ({ ctx, path, next }) => {
  // `ctx.user` rather than `ctx.session.user`: `protectedProcedure` has already established the id
  // is present and put the narrowed value there, so this needs no non-null assertion.
  const limit = ratingAnalyzeRateLimiter.check(ctx.user.id);
  if (!limit.allowed) {
    auditLog({
      event: "authz.trpc.rate_limited",
      actor: { id: ctx.user.id, role: ctx.user.role },
      outcome: "denied",
      reason: `Exceeded the billable-call window for ${path}`,
      metadata: { retryAfterMs: limit.retryAfterMs, billable: true },
    });
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "This analysis was run very recently. Please wait a few minutes before running it again.",
    });
  }
  return next();
});
