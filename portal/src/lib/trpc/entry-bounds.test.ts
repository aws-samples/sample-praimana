// ── ⚠ THE tRPC DOOR IS BOUNDED, AND THE ORDER OF THE CHECKS IS PART OF THE CONTRACT ───────────
//
// The handler used to pass exactly four options to `fetchRequestHandler`, endpoint, req, router,
// createContext, with no batch cap, no body cap and no rate limit. `/api/trpc` is in
// PARTICIPANT_PATHS so every signed-in role reaches it, `httpBatchLink` means one request can name
// many procedures, and several procedures fan out to ~26 upstream calls each.
//
// Asserted at the ROUTE, not through the router: the caps must apply before anything is parsed and
// before any resolver runs, so the interesting property is that the adapter is never reached at all.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_TRPC_BATCH_CALLS, MAX_TRPC_BODY_BYTES } from "./limits";

/** Records whether the tRPC adapter was invoked, and with what. */
const adapter = vi.fn(async (_opts: { req: Request }) => new Response("ok", { status: 200 }));

vi.mock("@trpc/server/adapters/fetch", () => ({
  fetchRequestHandler: (opts: { req: Request }) => adapter(opts),
}));
vi.mock("@/lib/trpc/root", () => ({ appRouter: {} }));
vi.mock("@/lib/trpc/context", () => ({ createContext: async () => ({}) }));

const { POST, GET } = await import("@/app/api/trpc/[trpc]/route");

function post(path: string, body?: BodyInit, contentLength?: number) {
  const headers = new Headers({ "content-type": "application/json" });
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return POST(new Request(`http://localhost${path}`, { method: "POST", body, headers }));
}

beforeEach(() => adapter.mockClear());

describe("the batch cap", () => {
  it(`admits a batch of exactly ${MAX_TRPC_BATCH_CALLS}`, async () => {
    const procedures = Array.from({ length: MAX_TRPC_BATCH_CALLS }, (_, i) => `r.p${i}`).join(",");
    const res = await post(`/api/trpc/${procedures}`, "{}");
    expect(res.status).toBe(200);
    expect(adapter).toHaveBeenCalledOnce();
  });

  it("⚠ REFUSES ONE MORE, WITHOUT REACHING THE ROUTER", async () => {
    const procedures = Array.from({ length: MAX_TRPC_BATCH_CALLS + 1 }, (_, i) => `r.p${i}`).join(",");
    const res = await post(`/api/trpc/${procedures}`, "{}");
    expect(res.status).toBe(413);
    // The whole point: no resolver ran, so no fan-out happened.
    expect(adapter).not.toHaveBeenCalled();
  });

  it("leaves an ordinary single call alone", async () => {
    expect((await post("/api/trpc/workshop.list", "{}")).status).toBe(200);
    expect(adapter).toHaveBeenCalledOnce();
  });

  it("still serves GET, which is how batched queries arrive", async () => {
    const res = await GET(new Request("http://localhost/api/trpc/workshop.list?batch=1"));
    expect(res.status).toBe(200);
  });

  it("⚠ COUNTS A BATCHED GET TOO, queries are where the fan-out amplifiers live", async () => {
    // `ai.tokenUsage` and `admin.filterScopes` are both queries, so capping only POST would leave
    // the amplification path uncapped. This is the case that matters most and is easiest to miss.
    const procedures = Array.from({ length: MAX_TRPC_BATCH_CALLS + 1 }, (_, i) => `r.p${i}`).join(",");
    const res = await GET(new Request(`http://localhost/api/trpc/${procedures}?batch=1`));
    expect(res.status).toBe(413);
    expect(adapter).not.toHaveBeenCalled();
  });
});

describe("the body cap", () => {
  it("refuses on a declared content-length, without reading the body", async () => {
    const res = await post("/api/trpc/message.send", "small", MAX_TRPC_BODY_BYTES + 1);
    expect(res.status).toBe(413);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("⚠ REFUSES OVERSIZED BYTES THAT DECLARED NO CONTENT-LENGTH, the header is a claim", async () => {
    // A chunked request can omit or lie about `content-length`, so the received bytes are what the
    // cap is actually enforced on. Trusting the header alone leaves it unenforced on exactly the
    // request shape that wants to evade it, the same reasoning `bulk-provision/route.ts` applies.
    const oversized = "x".repeat(MAX_TRPC_BODY_BYTES + 1);
    const res = await post("/api/trpc/message.send", oversized);
    expect(res.status).toBe(413);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("admits a body at exactly the cap", async () => {
    const res = await post("/api/trpc/message.send", "x".repeat(MAX_TRPC_BODY_BYTES));
    expect(res.status).toBe(200);
    expect(adapter).toHaveBeenCalledOnce();
  });

  it("⚠ FORWARDS THE BODY IT ALREADY CONSUMED, so measuring does not break the request", async () => {
    // Measuring the bytes consumes the stream. If the adapter were handed the original request it
    // would see an empty body and every mutation would fail its input validation, a break that
    // would look like a schema bug rather than a plumbing one.
    await post("/api/trpc/message.send", JSON.stringify({ 0: { teamId: "t", content: "hi" } }));
    const forwarded = adapter.mock.calls[0]?.[0];
    expect(forwarded, "the adapter should have been reached").toBeDefined();
    await expect(forwarded!.req.text()).resolves.toContain("teamId");
    expect(forwarded!.req.headers.get("content-type")).toBe("application/json");
  });
});
