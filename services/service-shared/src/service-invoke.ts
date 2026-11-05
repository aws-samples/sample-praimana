// ── CALLING A SERVICE BY DIRECT LAMBDA INVOCATION ────────────────────────────────────────
//
// The transport for an east-west call that has NO CALLER BEARER TOKEN to re-present. It invokes the
// target function directly and hands it a GATEWAY-SHAPED event.
//
// ⚠ WHY THIS EXISTS AT ALL, AND WHY IT IS NOT AN OPTIMISATION.
//
// Every API Gateway route inherits `DefaultAuthorizer: CognitoJwt`, so a tokenless HTTP request to a
// service's public URL is 401'd BY THE GATEWAY before the callee's Lambda ever runs —
// `forwardedIdentityHeaders` says so in as many words. Two callers have no token to present:
//
//   1. The bulk-provision worker, which is woken by an event and has no user session.
//   2. A service handling a request that itself arrived by this transport — Team, invoked by the
//      worker, still has to ask Workshop "does this facilitator own workshop W?".
//
// ⚠ (2) IS A REAL BUG THIS MODULE WAS EXTRACTED TO FIX, not a hypothetical. Bulk upload authenticated
// hop 1 with IAM and then broke on hop 2: Team's ownership probe went out over the public gateway URL
// with `x-identity-*` and no token, the gateway answered 401, `ownsWorkshop` fails CLOSED (correctly),
// and every team in the file was refused with "only the workshop owner can create teams". The
// facilitator owned it. Nothing was created and no email was sent. So a transport that works for the
// FIRST hop and not the second is not a transport — hence one implementation, here, shared.
//
// ⚠ NO SHARED SECRET IS INVOLVED, and that is the point. `edgeIdentityMiddleware` path 1 reads
// `requestContext.authorizer.jwt.claims` and VERIFIES NOTHING — normally the gateway already has. So
// constructing the event is all that is needed, and `lambda:InvokeFunction`, scoped to named
// functions in the caller's role, IS the credential. It cannot be forged without IAM, cannot be
// leaked in a log, and cannot be replayed from outside the account.
//
// ⚠ THE TRAP THIS MODULE EXISTS TO CLOSE: `Invoke` SUCCEEDS WHEN THE TARGET FAILS.
//
// A 403, a 500, even an unhandled exception in the callee all come back as a *successful* Invoke
// whose payload happens to describe a failure. Code that only checked for a thrown error would read
// "team not created, 403 Forbidden" as success and march on to invite members to a team that does not
// exist. Both signals are therefore checked here, once, so no call site has to remember:
//
//   1. `FunctionError` on the Invoke response — the callee threw.
//   2. `statusCode` in the returned payload — the callee answered with an HTTP error.

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

/** Who the call acts as. Asserted through the claims the gateway would normally supply. */
export interface CallerIdentity {
  id: string;
  email: string;
  role: string;
}

export interface ServiceResponse<T = unknown> {
  status: number;
  body: T;
}

/** Raised for any failure — a thrown callee, an HTTP error status, or an unreadable payload. */
export class ServiceInvokeError extends Error {
  constructor(
    readonly functionName: string,
    readonly path: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ServiceInvokeError";
  }
}

/**
 * ⚠ A TIMEOUT IS NOT OPTIONAL. The bulk worker's ceiling is 300s and it makes several calls per
 * member; without a per-call bound one hung callee would consume the whole budget and the batch would
 * die with accounts created and nobody emailed. 30s is generous for these routes (the slowest,
 * provisioning, is itself bounded near 9s) while leaving room for a run of failures.
 *
 * ⚠ CALLERS ON A REQUEST PATH MUST NOT USE THIS DEFAULT. A gateway-served request dies at 29s, so an
 * authorization probe inside one has a budget of hundreds of milliseconds, not 30 seconds — see
 * `EAST_WEST_TIMEOUT_MS` and the `timeoutMs` option below. The default belongs to the background
 * worker; anything synchronous passes its own.
 */
const INVOKE_TIMEOUT_MS = 30_000;

/**
 * ⚠ ONE CLIENT PER TIMEOUT, not one client. The two kinds of caller need very different bounds — a
 * background worker's 30s and an in-request authorization probe's ~2.5s — and `requestTimeout` is
 * fixed when the client is constructed. A single cached client would silently serve whichever bound
 * happened to be requested first, so the probe inside a request could inherit 30s and outlive the
 * gateway that is waiting for it.
 */
const clients = new Map<number, LambdaClient>();

/** An explicitly injected client wins over the cache. See `setLambdaClient`. */
let override: LambdaClient | undefined;

/** Built lazily so tests can run without AWS credentials present. */
export function lambdaClient(timeoutMs: number = INVOKE_TIMEOUT_MS): LambdaClient {
  if (override) return override;

  let client = clients.get(timeoutMs);
  if (!client) {
    client = new LambdaClient({
      region: process.env.AWS_REGION || "us-east-1",
      requestHandler: {
        requestTimeout: timeoutMs,
        connectionTimeout: Math.min(5_000, timeoutMs),
      },
      /**
       * ⚠ TWO ATTEMPTS, NOT THE SDK DEFAULT OF THREE — these calls have SIDE EFFECTS. A retried
       * `POST /invitations` that actually succeeded the first time would re-mint tokens and
       * invalidate a link already sent. Even one retry is only tolerable because the callees are
       * idempotent; three would be trusting that further than it deserves.
       */
      maxAttempts: 2,
    });
    clients.set(timeoutMs, client);
  }
  return client;
}

/**
 * Test seam: replace the client.
 *
 * ⚠ THE OVERRIDE IS UNCONDITIONAL, and an earlier version of the per-timeout cache broke that: it
 * rebuilt a real client whenever the requested timeout differed from the injected one's, so every
 * test fell through to the SDK and failed on "Could not load credentials from any providers". A seam
 * that a cache can quietly bypass is not a seam.
 */
export function setLambdaClient(c: LambdaClient | undefined): void {
  override = c;
  if (!c) clients.clear();
}

export interface InvokeOptions {
  /** Overrides INVOKE_TIMEOUT_MS. Required in practice for anything on a request path. */
  timeoutMs?: number;
  /** Appears as the user agent, so a callee's logs name the real originator. */
  source?: string;
}

/**
 * Build the event an HTTP API v2 proxy integration would deliver.
 *
 * ⚠ `cognito:groups` MUST BE AN ARRAY CONTAINING THE ROLE NAME. `collapseGroupsToRole` scans it
 * against `ROLE_PRECEDENCE` and returns `PARTICIPANT` for anything unrecognised — so a malformed
 * shape here does not escalate, it DEMOTES, and the callee then refuses a facilitator-only route.
 * Wrong in the safe direction, but silently wrong, which is why it is spelled out.
 */
export function buildGatewayEvent(
  method: string,
  path: string,
  body: unknown,
  identity: CallerIdentity,
  source = "service-invoke"
) {
  return {
    version: "2.0",
    routeKey: "ANY /{proxy+}",
    rawPath: path,
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      // ⚠ NO `authorization` HEADER, deliberately. One would send the callee down path 2, where it
      // would try to verify a token that does not exist and 401. Path 1 must win.
    },
    requestContext: {
      accountId: source,
      apiId: source,
      domainName: `${source}.local`,
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: source,
      },
      requestId: `${source}-${Date.now()}`,
      routeKey: "ANY /{proxy+}",
      stage: "$default",
      timeEpoch: Date.now(),
      authorizer: {
        jwt: {
          claims: {
            sub: identity.id,
            email: identity.email,
            "cognito:groups": [identity.role],
          },
          scopes: [],
        },
      },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/**
 * Invoke a service and return its parsed response.
 *
 * Throws `ServiceInvokeError` on any failure, so a caller may treat "it returned" as "it worked" —
 * which is exactly what a bare `Invoke` does NOT give you.
 */
export async function callService<T = unknown>(
  functionName: string,
  method: string,
  path: string,
  identity: CallerIdentity,
  body?: unknown,
  options: InvokeOptions = {}
): Promise<ServiceResponse<T>> {
  const { timeoutMs = INVOKE_TIMEOUT_MS, source = "service-invoke" } = options;

  const res = await lambdaClient(timeoutMs).send(
    new InvokeCommand({
      FunctionName: functionName,
      // RequestResponse: the caller needs the answer. An async invoke would make every call
      // fire-and-forget and the orchestration meaningless.
      InvocationType: "RequestResponse",
      Payload: Buffer.from(
        JSON.stringify(buildGatewayEvent(method, path, body, identity, source))
      ),
    })
  );

  // ⚠ SIGNAL 1 — the callee THREW. Invoke still reports success.
  if (res.FunctionError) {
    throw new ServiceInvokeError(
      functionName,
      path,
      500,
      `${functionName} threw (${res.FunctionError})`
    );
  }

  const raw = res.Payload ? Buffer.from(res.Payload).toString("utf8") : "";
  let envelope: { statusCode?: number; body?: string };
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new ServiceInvokeError(
      functionName,
      path,
      502,
      `${functionName} returned an unreadable payload`
    );
  }

  /**
   * ⚠ A MISSING `statusCode` IS TREATED AS 502, NOT AS SUCCESS. An envelope without one is not a
   * proxy response at all, and defaulting it to 200 would turn "I have no idea what happened" into
   * "it worked" — the exact reading this module exists to prevent.
   */
  const status = envelope.statusCode ?? 502;

  let parsed: unknown;
  if (envelope.body) {
    try {
      parsed = JSON.parse(envelope.body);
    } catch {
      parsed = envelope.body;
    }
  }

  // ⚠ SIGNAL 2 — the callee answered with an HTTP error. This is the one that reads as success.
  if (status >= 400) {
    const detail =
      parsed && typeof parsed === "object" && "error" in (parsed as object)
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${status}`;
    throw new ServiceInvokeError(functionName, path, status, detail);
  }

  return { status, body: parsed as T };
}
