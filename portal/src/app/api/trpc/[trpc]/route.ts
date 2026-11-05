import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { NextResponse } from "next/server";
import { appRouter } from "@/lib/trpc/root";
import { createContext } from "@/lib/trpc/context";
import { MAX_TRPC_BATCH_CALLS, MAX_TRPC_BODY_BYTES } from "@/lib/trpc/limits";

/**
 * ── THE tRPC DOOR, AND THE TWO BOUNDS IT OWES THE TIER BEHIND IT ──────────────────────────────
 *
 * This handler used to pass exactly four options, endpoint, req, router, createContext, and
 * nothing else: no batch cap, no body cap, no rate limit. That was raised as a security finding, and it
 * matters because of what sits behind this path:
 *
 *   · `/api/trpc` is in PARTICIPANT_PATHS (`lib/route-gates.ts`), so EVERY signed-in principal
 *     reaches it, including a PARTICIPANT otherwise confined to /welcome.
 *   · Batching is on (`httpBatchLink`, `components/providers.tsx`), so ONE HTTP request can name an
 *     unbounded number of procedures, which the adapter executes concurrently.
 *   · Several procedures are per-call fan-out amplifiers: `ai.tokenUsage` issues 1 + up to 25 calls
 *     to `/v1/ai/threads/:id/timing`, each inheriting the 65-second `/v1/ai` deadline;
 *     `admin.filterScopes` fans out to 25 workshops; `admin.listUsers` hydrates up to 100 ids.
 *
 * So one authenticated request could become hundreds-to-thousands of outbound `/v1/*` invocations
 * inside a single Lambda invocation. The per-procedure caps (MAX_THREADS 25, MAX_ENRICH_KEYS 100)
 * bound each CALL and always did, nothing bounded the number of calls per REQUEST.
 *
 * ⚠ THE TWO CHEAP BOUNDS LIVE HERE; THE PER-USER BOUND DOES NOT. Batch size and body size are
 * checked before anything is parsed and need no session, so they belong at the door. Rate limiting
 * needs the caller's identity, and reading the session here would mean decrypting the JWE cookie a
 * second time (`createContext` already does it), so it is a tRPC middleware on
 * `protectedProcedure` instead, where `ctx.session` already exists. See `lib/trpc/trpc.ts`. That
 * placement also counts PROCEDURES rather than requests, which is strictly tighter under batching.
 *
 * ⚠ `allowBatching` IS LEFT ON DELIBERATELY. Turning it off would bound the amplification outright,
 * and would also break the client: `httpBatchLink` coalesces the concurrent queries every page
 * mounts. Capping the batch keeps the round-trip saving and removes the unbounded multiplier.
 */

/** The procedures a batched request names, from the comma-separated path segment. */
function batchedCallCount(url: URL): number {
  const path = url.pathname.replace(/^\/api\/trpc\/?/, "");
  if (path.length === 0) return 0;
  return path.split(",").length;
}

const handler = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  const calls = batchedCallCount(url);
  if (calls > MAX_TRPC_BATCH_CALLS) {
    return NextResponse.json(
      { error: `A request may name at most ${MAX_TRPC_BATCH_CALLS} procedures.` },
      { status: 413 }
    );
  }

  /**
   * ⚠ THE HEADER IS A CLAIM, so it is checked AND the received bytes are checked, the same
   * reasoning `bulk-provision/route.ts` applies to uploads. A chunked request can omit
   * `content-length` or lie about it, so trusting it alone would leave the cap unenforced on exactly
   * the request shape that wants to evade it.
   *
   * The declared check comes first because it refuses without reading anything at all.
   */
  const claimed = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(claimed) && claimed > MAX_TRPC_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let forwarded = req;
  if (req.method !== "GET" && req.body) {
    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_TRPC_BODY_BYTES) {
      return NextResponse.json({ error: "Request body too large." }, { status: 413 });
    }
    /**
     * The stream is consumed by the measurement, so the adapter gets an equivalent request built
     * from the bytes we already hold. Method, URL and headers are carried over verbatim, dropping
     * `content-type` here would make superjson's payload unparseable.
     */
    forwarded = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: raw,
    });
  }

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: forwarded,
    router: appRouter,
    createContext,
  });
};

export { handler as GET, handler as POST };
