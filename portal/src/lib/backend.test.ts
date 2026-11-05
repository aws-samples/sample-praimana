import { describe, it, expect, vi, afterEach } from "vitest";
import { backendFetch, backendTimeoutFor, BackendError } from "./backend";

function mockFetch(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === "string" ? JSON.parse(text) : body),
  } as unknown as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backendFetch", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { canWrite: true }));
    await expect(backendFetch("/v1/teams/t1/access", { token: "tok" })).resolves.toEqual({
      canWrite: true,
    });
  });

  it("attaches the bearer token", async () => {
    const f = mockFetch(200, {});
    vi.stubGlobal("fetch", f);
    await backendFetch("/v1/x", { token: "secret-token" });
    const [, init] = f.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("throws a BackendError carrying status + code on a 403", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(403, { error: "Forbidden: your role has read-only access", code: "FORBIDDEN" })
    );
    const err = await backendFetch("/v1/teams/t1/tasks", { token: "tok" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toMatch(/read-only access/);
  });

  it("throws a status-based message when the body has no error field", async () => {
    vi.stubGlobal("fetch", mockFetch(500, ""));
    const err = await backendFetch("/v1/x", { token: "tok" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(500);
    expect(err.message).toMatch(/Backend error: 500/);
  });

  it("keeps raw text as the message when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", mockFetch(502, "<html>Bad Gateway</html>"));
    const err = await backendFetch("/v1/x", { token: "tok" }).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(502);
    expect(err.message).toContain("Bad Gateway");
  });
});

// ── EVERY BFF→SERVICE CALL NOW HAS A DEADLINE ────────────────────────────────────────────
//
// ⚠ THIS CALL WAS UNBOUNDED, FOR EVERY PORTAL ROUTE. `fetch` was invoked with no `AbortSignal`, so
// a hung or throttled service held the Amplify SSR request open indefinitely. `east-west.ts` argues
// this exact case at length for service-to-service calls, "a hung dependency must not hold a
// Lambda open", and the BFF simply never got the same treatment.
//
// The operator-visible symptom is a spinner, then a retry; and a retry on a write path means two
// batches in flight. Fixed as a prerequisite for bulk upload rather than alongside it,
// because bulk multiplies one unbounded wait by eighty.

/** A `fetch` that never settles unless its signal aborts, a HUNG dependency, not a slow one. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })
  );
}

describe("⚠ backendFetch gives up rather than waiting forever", () => {
  it("aborts a hung call", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    // 20ms rather than the real 20s: the property is "it gives up", not the exact ceiling.
    await expect(backendFetch("/v1/teams", { timeoutMs: 20 })).rejects.toThrow(BackendError);
  });

  /**
   * ⚠ A TIMEOUT MUST NOT ESCAPE AS A RAW `AbortError`.
   *
   * Callers and `trpc.ts` branch on `BackendError.status`/`.code`. A bare DOMException escapes that
   * mapping and reaches the user as an unhandled 500 with nothing naming a deadline, so they retry
   * a request that will time out again. 504 plus a machine-readable code is what lets a caller tell
   * "took too long" (worth retrying) from "refused" (not).
   */
  it("reports 504 / BACKEND_TIMEOUT naming the path", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const err = await backendFetch("/v1/teams", { timeoutMs: 20 }).catch((e) => e);

    expect(err).toBeInstanceOf(BackendError);
    expect(err.status).toBe(504);
    expect(err.code).toBe("BACKEND_TIMEOUT");
    expect(err.message).toContain("/v1/teams");
  });

  it("passes a signal to fetch at all, the regression guard for the original bug", async () => {
    const f = mockFetch(200, {});
    vi.stubGlobal("fetch", f);

    await backendFetch("/v1/teams");

    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  /**
   * The deadline is ADDED to a caller's signal, not substituted for it. Replacing it would silently
   * break cancellation for anything that passes one, invisibly, because the request would still
   * succeed, just uncancellably.
   */
  it("an explicit abort still wins, and is NOT dressed up as a timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();

    const pending = backendFetch("/v1/teams", { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();

    const err = await pending.catch((e) => e);
    // A user navigating away is not a fault, so it must not become a 504.
    expect(err).not.toBeInstanceOf(BackendError);
    expect(err.name).toBe("AbortError");
  });
});

describe("⚠ the ceiling comes from the PATH, because the backend is not one timeout", () => {
  /**
   * The infrastructure CloudFormation template sets three tiers: 15s globally, 30s for `source` and
   * `docs`, 60s for `ai`. One default would have to be either ~65s, no bound at all for CRUD, or
   * short enough to ABORT AI GENERATION MID-STREAM, turning a working feature into a timeout.
   *
   * Deriving it from the path also means no call site has to remember. An opt-in parameter would be
   * forgotten exactly once, and the regression would look like a flaky model call.
   */
  it("gives AI more than its 60s function timeout", () => {
    expect(backendTimeoutFor("/v1/ai/teams/t1/threads")).toBeGreaterThan(60_000);
  });

  it("gives the 30s functions more than 30s", () => {
    expect(backendTimeoutFor("/v1/git/teams/t1/commits")).toBeGreaterThan(30_000);
    expect(backendTimeoutFor("/v1/docs/x")).toBeGreaterThan(30_000);
  });

  /**
   * ⚠ EVERY TIER SITS ABOVE ITS CALLEE'S OWN TIMEOUT, DELIBERATELY. A caller that gives up BEFORE
   * the callee does turns a useful error into an ambiguous one, the work may well have completed,
   * which on a write path is the worst available answer.
   */
  it("puts the default above the 15s Globals timeout but well under the AI tier", () => {
    const dflt = backendTimeoutFor("/v1/teams");
    expect(dflt).toBeGreaterThan(15_000);
    expect(dflt).toBeLessThan(backendTimeoutFor("/v1/ai/x"));
  });

  it("an explicit timeoutMs overrides the table", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    // Without the override this inherits the AI tier and the test would sit for 65 seconds.
    await expect(backendFetch("/v1/ai/slow", { timeoutMs: 20 })).rejects.toThrow(BackendError);
  });
});
