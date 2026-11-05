/**
 * A FAITHFUL tRPC transport for the browser under test, plus a request counter.
 *
 * ── WHY INTERCEPT AT THE NETWORK EDGE AND NOT MOCK THE CLIENT ──
 * The rule this obeys: never mock away the thing under test. The things under test here are
 * the CONFIRMATION DIALOG's focus and double-submit behaviour, and the PAGE's outcome
 * reporting — all of which sit above the tRPC client. So the tRPC client, React Query, the
 * batching link, superjson, the mutation callbacks, `variables`-based correlation and the
 * invalidate-then-refetch cycle are all REAL and all exercised. What is replaced is only the
 * far side of the socket, i.e. the microservices.
 *
 * That boundary is what makes priority #4 provable at all. Counting calls to the tRPC
 * endpoint from `page.on("request")` observes actual HTTP requests leaving the browser — if
 * `disabled` fails to prevent a second submit, a second request appears on the wire and the
 * count catches it. A mocked client would only prove that a mocked client was called once.
 *
 * ── AND WHY NOT THE REAL SERVICES ──
 * The specs that need the real services are the two happy-path specs, and they say so. For
 * the focus and double-submit specs, a controlled transport is not a shortcut but a
 * requirement: they need a mutation that stays in flight until the spec releases it. That is
 * the only way to assert "focus moved to Close WHILE pending" without a sleep, and the only
 * way to hold the window open long enough to attempt a second click. Against a real service,
 * a removal completes in milliseconds and the pending state is a race the spec would lose
 * intermittently — a latent flake by construction.
 *
 * ── THE WIRE FORMAT IS OBSERVED, NOT GUESSED ──
 * Captured from the running portal: a batch answers with an ARRAY, one entry per operation,
 * each `{"result":{"data": <superjson>}}` for a success or `{"error":{"json":{message, code,
 * data}}}` for a failure.
 *
 * AND THE REQUEST SIDE IS DESERIALIZED WITH REAL SUPERJSON, which is not a nicety. The
 * observed body for a removal with a blank reason is:
 *
 *   {"0":{"json":{...,"reason":null},"meta":{"values":{"reason":["undefined"]},"v":1}}}
 *
 * i.e. superjson encodes `undefined` as `null` PLUS a `meta` sidecar that restores it. A
 * handler that reads `.json` directly sees `reason: null` and would report that the page
 * sends an empty value where it actually sends `undefined` — a false defect, and precisely
 * the kind of confident wrong answer a test harness must not produce. Using the same
 * library the client serialized with is the only way to see what the server would see.
 */

import superjson from "superjson";
import type { Page, Route, Request } from "@playwright/test";

/** The portal's tRPC endpoint (see providers.tsx: `httpBatchLink({ url: "/api/trpc" })`). */
export const TRPC_ENDPOINT_GLOB = "**/api/trpc/**";

/** A handler for one procedure: returns the DATA (pre-superjson-wrapping) or throws. */
export type ProcedureHandler = (input: unknown) => unknown | Promise<unknown>;

/** A tRPC error, shaped so the client surfaces `message` the way a service 403 does. */
export class TrpcFault extends Error {
  constructor(
    message: string,
    public readonly code:
      | "FORBIDDEN"
      | "UNAUTHORIZED"
      | "NOT_FOUND"
      | "INTERNAL_SERVER_ERROR"
      | "BAD_REQUEST" = "INTERNAL_SERVER_ERROR",
    public readonly httpStatus = 500
  ) {
    super(message);
    this.name = "TrpcFault";
  }
}

const ERROR_CODES: Record<string, number> = {
  // JSON-RPC codes tRPC uses; the client reads `data.code`, so these only need to be
  // internally consistent, but they are the real values.
  BAD_REQUEST: -32600,
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32003,
  NOT_FOUND: -32004,
  INTERNAL_SERVER_ERROR: -32603,
};

/**
 * Records every tRPC request the browser actually issued.
 *
 * `paths` holds one entry per OPERATION (a batch of two is two entries) so a duplicate
 * submit is visible even if the batching link were to coalesce it into one HTTP request —
 * which is exactly the case a naive "count HTTP requests" assertion would miss.
 */
export interface TrpcCallLog {
  /** One entry per HTTP request to the endpoint: the raw comma-joined path list. */
  requests: string[];
  /** One entry per individual operation across all requests. */
  paths: string[];
  /** Operations for one procedure only. THE assertion surface for double-submit. */
  countOf(path: string): number;
}

/**
 * Attach a request counter. Call BEFORE navigating.
 *
 * Uses `page.on("request")`, which fires for requests the browser genuinely emitted,
 * independently of whether a route handler answers them — so it cannot be fooled by the
 * interception layer below.
 */
export function countTrpcCalls(page: Page): TrpcCallLog {
  const requests: string[] = [];
  const paths: string[] = [];

  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/trpc/")) return;
    // A batch arrives as `/api/trpc/a.b,c.d`; a single call as `/api/trpc/a.b`.
    const joined = decodeURIComponent(url.pathname.slice("/api/trpc/".length));
    requests.push(joined);
    for (const p of joined.split(",")) if (p) paths.push(p);
  });

  return {
    requests,
    paths,
    countOf: (path: string) => paths.filter((p) => p === path).length,
  };
}

/**
 * Serve the portal's tRPC endpoint from `handlers`.
 *
 * An unhandled procedure is answered with an explicit tRPC error naming itself, never left
 * to hang and never silently 200'd with undefined. A spec that forgot a query then fails
 * with "no handler for team.getById" instead of a selector timeout — the diagnostic
 * difference between a two-minute fix and an afternoon.
 */
/**
 * What a spec learns about procedures it did not stub.
 *
 * ── ⚠ WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
 * An unregistered procedure is answered with an error envelope, which the page then renders as
 * its error state or an endless loading state. That is INDISTINGUISHABLE FROM A PRODUCT BUG, and
 * it fooled the redesign work three separate times:
 *
 *   - `admin.platformHealth` (real name: `health.platform`) → the Platform health tab sat on
 *     "Checking the platform…" for ever, and a comment-leak guard written against that tab passed
 *     twice against a bug it could not see, because the region never rendered.
 *   - `admin.feedback` (real name: `feedback.list`) → the Feedback tab showed permanent skeletons.
 *   - `team.listPlatformInvitations` (real name: `team.listInvitations`) → the Invitations tab
 *     rendered its "your role cannot invite" branch, which was then misread as a role-gating
 *     limitation of the harness rather than a typo in the fixture.
 *
 * Each cost real time and produced at least one false conclusion about the product. The envelope
 * message was always correct and always invisible: nothing surfaced it to the RUN.
 *
 * So `serveTrpc` now returns a tracker. Nothing is forced on existing callers — the return value
 * can be ignored — but a spec that wants the guarantee calls `expectAllProceduresStubbed()`.
 */
export interface TrpcStubLog {
  /** Procedure paths the page asked for that no handler covered, in first-seen order. */
  unhandled: string[];
  /** Every procedure path the page asked for, stubbed or not. */
  requested: string[];
}

/**
 * Fail the test if the page asked for a procedure the spec did not stub.
 *
 * ⚠ CALL IT AFTER the assertions that wait for content, not before: procedures are requested as
 * the page renders, so an early call passes trivially.
 */
export function expectAllProceduresStubbed(log: TrpcStubLog): void {
  if (log.unhandled.length === 0) return;
  throw new Error(
    `e2e: ${log.unhandled.length} tRPC procedure(s) were requested with no stub, so the page ` +
      `rendered an error or loading state instead of content:\n  ` +
      log.unhandled.map((p) => `- ${p}`).join("\n  ") +
      `\n\nProcedures the page did request: ${log.requested.join(", ")}\n` +
      `Check the real names in src/lib/trpc/routers/ — guessing them is how three separate ` +
      `"broken page" conclusions were reached that were really fixture typos.`
  );
}

export async function serveTrpc(
  page: Page,
  handlers: Record<string, ProcedureHandler>
): Promise<TrpcStubLog> {
  const log: TrpcStubLog = { unhandled: [], requested: [] };
  await page.route(TRPC_ENDPOINT_GLOB, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const opPaths = decodeURIComponent(url.pathname.slice("/api/trpc/".length))
      .split(",")
      .filter(Boolean);

    const inputs = readInputs(request, url, opPaths.length);

    const body = await Promise.all(
      opPaths.map(async (path, index) => {
        if (!log.requested.includes(path)) log.requested.push(path);
        const handler = handlers[path];
        if (!handler) {
          if (!log.unhandled.includes(path)) {
            log.unhandled.push(path);
            // Surfaced to the RUN, not only to the page. The silent version of this is what let
            // three fixture typos read as product defects.
            console.warn(
              `⚠ e2e: no stub for tRPC procedure "${path}" — the page will render an error or ` +
                `loading state. Real names live in src/lib/trpc/routers/.`
            );
          }
          return errorEnvelope(
            path,
            new TrpcFault(
              `e2e: no handler registered for "${path}". Add one in the spec's serveTrpc() map.`,
              "INTERNAL_SERVER_ERROR"
            )
          );
        }
        try {
          const data = await handler(inputs[index]);
          // Serialized with the SAME library the client deserializes with, so a fixture
          // containing a Date or an undefined survives the round trip as the real service's
          // response would rather than silently becoming a string or a null.
          return { result: { data: superjson.serialize(data ?? null) } };
        } catch (err) {
          return errorEnvelope(path, err);
        }
      })
    );

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return log;
}

/**
 * The inputs for each operation in the batch, DESERIALIZED WITH SUPERJSON.
 *
 * A query carries them in `?input=`, a mutation in the POST body. Both are keyed by the
 * operation's INDEX in the batch, and both are superjson payloads — see the header note on
 * why reading `.json` directly would misreport `undefined` as `null`.
 */
function readInputs(request: Request, url: URL, count: number): unknown[] {
  const raw = request.method() === "GET" ? url.searchParams.get("input") : request.postData();
  if (!raw) return new Array(count).fill(undefined);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Array.from({ length: count }, (_, i) => {
      const payload = parsed[String(i)];
      if (payload === undefined) return undefined;
      try {
        return superjson.deserialize(payload as Parameters<typeof superjson.deserialize>[0]);
      } catch {
        // A payload superjson cannot read is handed over raw rather than swallowed, so a
        // spec sees something it can print instead of a silent undefined.
        return payload;
      }
    });
  } catch {
    return new Array(count).fill(undefined);
  }
}

function errorEnvelope(path: string, err: unknown) {
  const fault =
    err instanceof TrpcFault
      ? err
      : new TrpcFault(err instanceof Error ? err.message : String(err));
  return {
    error: {
      json: {
        message: fault.message,
        code: ERROR_CODES[fault.code] ?? ERROR_CODES.INTERNAL_SERVER_ERROR,
        data: { code: fault.code, httpStatus: fault.httpStatus, path },
      },
    },
  };
}

/**
 * A handler that does not answer until the returned `release()` is called.
 *
 * THE INSTRUMENT FOR THE PENDING-STATE ASSERTIONS, and the reason no spec in this harness
 * needs a sleep. A mutation held open makes `pending: true` a STABLE, observable state
 * rather than a millisecond-wide window, so:
 *   - "focus moved to Close when Confirm disabled itself" is asserted while it is true;
 *   - "Escape still dismisses in flight" has a flight to happen during;
 *   - a second click on the disabled Confirm has a window to be attempted in.
 *
 * `waitUntilCalled()` polls the call count rather than sleeping, so a spec synchronises on
 * the request having actually been issued.
 */
export function deferred<T>(): {
  handler: ProcedureHandler;
  release: (value: T) => void;
  reject: (err: unknown) => void;
  calls: () => number;
  waitUntilCalled: (page: Page, atLeast?: number) => Promise<void>;
} {
  let settle: ((value: T) => void) | null = null;
  let fail: ((err: unknown) => void) | null = null;
  let calls = 0;
  /** Buffered so a release() that lands before the call is not lost. */
  let pending: { kind: "value"; value: T } | { kind: "error"; err: unknown } | null = null;

  const handler: ProcedureHandler = () => {
    calls += 1;
    return new Promise<T>((resolve, rejectPromise) => {
      if (pending) {
        const p = pending;
        pending = null;
        if (p.kind === "value") resolve(p.value);
        else rejectPromise(p.err);
        return;
      }
      settle = resolve;
      fail = rejectPromise;
    });
  };

  return {
    handler,
    release: (value: T) => {
      if (settle) {
        const s = settle;
        settle = null;
        fail = null;
        s(value);
      } else {
        pending = { kind: "value", value };
      }
    },
    reject: (err: unknown) => {
      if (fail) {
        const f = fail;
        settle = null;
        fail = null;
        f(err);
      } else {
        pending = { kind: "error", err };
      }
    },
    calls: () => calls,
    /**
     * Poll until the handler has been entered `atLeast` times. Never a sleep: this is the
     * condition the spec actually depends on, so waiting for anything else would be
     * guessing at a duration.
     */
    waitUntilCalled: async (page: Page, atLeast = 1) => {
      await page.waitForFunction(
        // Evaluated in the browser only as a tick source; the real check is the closure
        // below, re-read on each poll by expect.poll in the specs. Kept simple here so the
        // helper has no hidden dependency on page state.
        () => true,
        undefined,
        { timeout: 1 }
      ).catch(() => {});
      const deadline = Date.now() + 10_000;
      while (calls < atLeast) {
        if (Date.now() > deadline) {
          throw new Error(
            `e2e: mutation was not called ${atLeast}x within 10s (saw ${calls}). ` +
              `Either the control did not submit, or the handler path is wrong.`
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}
