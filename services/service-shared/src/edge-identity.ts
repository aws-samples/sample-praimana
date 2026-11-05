import { Context, Next } from "hono";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { routeTemplate } from "./request-scope.js";

/**
 * The identity a request carries.
 *
 * DEPLOYMENT MODEL — this codebase supports two edges:
 *
 *  1. API Gateway (the SAM/CloudFormation deployment): the HTTP API's built-in Cognito JWT
 *     authorizer validates signature, issuer, audience and expiry ONCE at the
 *     edge, then hands the verified claims to the Lambda in the event
 *     (`requestContext.authorizer.jwt.claims`). Services read identity from
 *     THOSE — see gatewayJwtClaims() below.
 *
 *  2. EKS (eks/) and non-gateway entry points (the Collaboration WebSocket
 *     handshake): there is NO edge authorizer, so the JWT is verified IN-SERVICE
 *     against Cognito's JWKS ("Option B — validate in-service").
 *
 * Either way, identity comes from VERIFIED claims and inbound x-identity-* headers
 * are ignored, so a client can never forge one.
 *
 * Authorization (are you allowed THIS resource?) still happens inside each
 * service, because it depends on that service's own data — see the per-service
 * authz guards (e.g. ai/src/authz.ts). authN at the edge OR in-service, authZ in
 * the context.
 */
export interface EdgeIdentity {
  id: string;
  email: string;
  role: string;
}

export const IDENTITY_HEADERS = {
  id: "x-identity-id",
  email: "x-identity-email",
  role: "x-identity-role",
} as const;

// East-west (service-to-service) calls present this header carrying a shared
// secret. When it matches INTERNAL_SERVICE_TOKEN the request is a trusted
// in-cluster hop and its x-identity-* headers are honored. This is how the AI
// service's HttpTeamAccess can call the Team service AS the original user
// without re-minting a user JWT.
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

function internalToken(): string | undefined {
  // No default: if unset, the internal-trust path is disabled (fail closed).
  return process.env.INTERNAL_SERVICE_TOKEN || undefined;
}

// ─── Cognito token verification (RS256 / JWKS) ───────────────────────────────
// Auth is native Cognito: the API Gateway HTTP API validates north-south tokens
// with its built-in JWT authorizer, but non-gateway entry points (the
// Collaboration WebSocket handshake) and the EKS in-service path still verify
// here — so this must match Cognito, not the old HS256 shared secret.
//
// COGNITO_ISSUER = https://cognito-idp.<region>.amazonaws.com/<userPoolId>
// COGNITO_AUDIENCE = the app client id (optional but checked when set).
const COGNITO_ISSUER = process.env.COGNITO_ISSUER || "";
const COGNITO_AUDIENCE = process.env.COGNITO_AUDIENCE || "";

// Single-role precedence (lower index wins) — collapses the cognito:groups array
// into the one authoritative role the rest of the system expects. Mirrors the
// Cognito group Precedence in the infrastructure CloudFormation template.
const ROLE_PRECEDENCE = [
  "ADMIN",
  "FACILITATOR",
  "JUDGE",
  "EXECUTIVE",
  "PARTICIPANT",
] as const;

/**
 * Collapse a `cognito:groups` claim to the one authoritative role.
 *
 * The claim arrives in two shapes depending on the edge, and both must map the
 * same way or a user's role would change with the entry point:
 *
 *  - jose (in-service verification) parses the JWT as JSON, so it is an ARRAY:
 *    ["ADMIN", "PARTICIPANT"].
 *  - the HTTP API JWT authorizer flattens every claim to a STRING before putting
 *    it in the Lambda event (claims is Record<string, string>), and renders an
 *    array as bracketed, space-separated text: "[ADMIN PARTICIPANT]".
 *
 * Anything else — absent, empty, a lone group name — degrades to PARTICIPANT, the
 * least-privileged role, so an unparseable claim can never escalate.
 */
function collapseGroupsToRole(groups: unknown): string {
  const names = Array.isArray(groups)
    ? groups
    : typeof groups === "string"
      ? groups.replace(/^\[|\]$/g, "").split(/[\s,]+/)
      : [];
  if (names.length === 0) return "PARTICIPANT";
  for (const role of ROLE_PRECEDENCE) {
    if (names.includes(role)) return role;
  }
  return "PARTICIPANT";
}

// Lazily-built remote JWKS (jose caches keys + honours cache headers). Built once
// per warm container. Undefined until COGNITO_ISSUER is configured.
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function getJwks() {
  if (!COGNITO_ISSUER) return undefined;
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`${COGNITO_ISSUER}/.well-known/jwks.json`)
    );
  }
  return jwks;
}

/**
 * Verify a raw JWT (no "Bearer " prefix) and derive the caller's identity from
 * its Cognito claims, or null if the token is missing/invalid/expired. Shared by
 * the HTTP middleware below AND by non-Hono entry points that still need the same
 * authN — notably the Collaboration service's WebSocket upgrade handshake, which
 * can't run Hono middleware but must authenticate exactly the same way (one
 * source of truth for the verifier + claim mapping, so the two can never drift).
 *
 * Role comes from the `cognito:groups` claim (collapsed to a single role) — the
 * source of truth is Cognito group membership, not anything the client sends.
 */
export async function verifyJwtIdentity(
  token: string | undefined | null
): Promise<EdgeIdentity | null> {
  if (!token) return null;
  const keySet = getJwks();
  if (!keySet) return null; // not configured → fail closed
  try {
    const { payload } = await jwtVerify(token, keySet, {
      issuer: COGNITO_ISSUER,
      ...(COGNITO_AUDIENCE ? { audience: COGNITO_AUDIENCE } : {}),
    });
    if (!payload.sub) return null;
    const p = payload as JWTPayload & {
      email?: unknown;
      "cognito:groups"?: unknown;
    };
    return {
      id: String(payload.sub),
      email: typeof p.email === "string" ? p.email : "",
      role: collapseGroupsToRole(p["cognito:groups"]),
    };
  } catch {
    return null;
  }
}

/**
 * Identity from the API Gateway's OWN verification, or null when the request did
 * not arrive through a JWT-authorized gateway route.
 *
 * WHY THIS IS THE PRIMARY PATH — behind the HTTP API, re-verifying the token here
 * is not just redundant, it cannot succeed. The service Lambdas run on private
 * subnets with no NAT and no internet gateway, so the JWKS fetch that
 * verifyJwtIdentity() needs (`<issuer>/.well-known/jwks.json`) has no route out.
 * It does not fail fast either: it hangs until jose's 5s fetch timeout, which
 * turned EVERY authenticated request into a 5-second 401.
 *
 * The claims here are trustworthy for the same reason re-checking them is
 * pointless: the gateway already validated signature, issuer, audience and expiry
 * against the pool configured in the template's CognitoJwt authorizer, and a
 * request that failed any of those never reached this Lambda. The claims live in
 * the Lambda EVENT, not in a header, so a client cannot inject them.
 *
 * Returns null (rather than throwing) whenever the shape isn't there — a local
 * Node run, an ALB, or a route with `Authorizer: NONE` — leaving the caller to fall
 * through to the next resolution step.
 */
function gatewayJwtClaims(c: Context): EdgeIdentity | null {
  // Hono's aws-lambda adapter puts the raw event's requestContext in the env.
  const requestContext = (
    c.env as { requestContext?: { authorizer?: { jwt?: { claims?: unknown } } } }
  )?.requestContext;
  const claims = requestContext?.authorizer?.jwt?.claims;
  if (!claims || typeof claims !== "object") return null;

  const c2 = claims as Record<string, unknown>;
  const sub = c2.sub;
  if (typeof sub !== "string" || !sub) return null;

  return {
    id: sub,
    email: typeof c2.email === "string" ? c2.email : "",
    role: collapseGroupsToRole(c2["cognito:groups"]),
  };
}

/**
 * ── ⚠ AN AUTHENTICATION FAILURE IS NOW A LOG LINE ────────────────────────────────────────────────
 *
 * THE GAP THIS CLOSES. This middleware is the single authentication entry point for every HTTP
 * service on the platform, and both of its rejection paths returned 401 with NO `console.*` call and
 * NO metric. A repo-wide grep confirmed these were the only two 401 sites outside tests, so token
 * replay, expired-token floods, credential stuffing and — worst — probes of the `x-internal-token`
 * SHARED SECRET left no trace whatsoever in the application logs. There is no Hono `logger()`
 * anywhere either, so nothing else was going to record them.
 *
 * ⚠ THE INTERNAL-TOKEN MISMATCH IS THE CASE THAT MATTERS MOST, and it is the one that was hardest to
 * see: a wrong secret falls through resolution step 3 into the generic "Authentication required"
 * exit, indistinguishable from an ordinary anonymous request. `reason` is what separates them, so a
 * brute-force against the shared secret is now visible as a run of `internal-token-mismatch`.
 *
 * ⚠ WHAT IS DELIBERATELY *NOT* LOGGED:
 *
 *   · THE TOKEN, or any part of it — including a prefix or a hash. It is a live credential; a log is
 *     not the place, and a prefix is enough to correlate sessions.
 *   · THE RAW PATH. Several routes are keyed on an EMAIL ADDRESS, so `c.req.path` would write personal
 *     data into CloudWatch on exactly the attacker-driven requests. `routeTemplate` reduces it to a
 *     caller-independent shape.
 *   · ANY CLAIM from the rejected token. It failed verification, so nothing in it is a fact.
 *
 * The COUNT of these lives in `withHealth`'s response middleware (`emitAuthDenial`), which sees every
 * 401 and 403 platform-wide. This is the DETAIL an operator needs once the count has fired: which
 * failure mode, from which client, against which route shape.
 */
function logAuthFailure(c: Context, reason: string): void {
  console.warn("[auth] authentication failed", {
    reason,
    routePath: routeTemplate(c.req.path),
    method: c.req.method,
    // Both are caller-supplied and therefore untrusted — kept because they are the only thing that
    // distinguishes one probing client from another, and bounded so a caller cannot write an
    // arbitrarily large log line.
    sourceIp: (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64) || null,
    userAgent: (c.req.header("user-agent") ?? "").slice(0, 128) || null,
  });
}

export function edgeIdentityMiddleware() {
  return async (c: Context, next: Next) => {
    // 1. The gateway already did the verification — read its verified claims.
    const fromGateway = gatewayJwtClaims(c);
    if (fromGateway) {
      c.set("identity", fromGateway);
      await next();
      return;
    }

    // 2. Bearer JWT verified in-service — no gateway in front (EKS, local Node).
    const authz = c.req.header("authorization") ?? c.req.header("Authorization");
    if (authz?.startsWith("Bearer ")) {
      const identity = await verifyJwtIdentity(authz.slice(7));
      if (identity) {
        c.set("identity", identity);
        await next();
        return;
      }
      // An INVALID or EXPIRED bearer token — distinct from "no credentials at all", because one is a
      // client whose session lapsed and the other may be an unauthenticated probe.
      logAuthFailure(c, "invalid-or-expired-token");
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    // 3. Trusted internal hop — service-to-service call with the shared secret.
    const secret = internalToken();
    const presented = c.req.header(INTERNAL_TOKEN_HEADER);
    if (secret && presented && presented === secret) {
      const id = c.req.header(IDENTITY_HEADERS.id);
      const role = c.req.header(IDENTITY_HEADERS.role);
      if (id && role) {
        c.set("identity", {
          id,
          email: c.req.header(IDENTITY_HEADERS.email) ?? "",
          role,
        });
        await next();
        return;
      }
    }

    /**
     * No usable credential of any kind. `reason` distinguishes the three ways to arrive here, because
     * they are three different operational events and only the middle one is an attack signal on its
     * own: an internal token that was PRESENTED AND WRONG is a probe of the shared secret, whereas an
     * absent token is an ordinary anonymous request.
     */
    logAuthFailure(
      c,
      presented && secret && presented !== secret
        ? "internal-token-mismatch"
        : presented
          ? "internal-token-without-identity-headers"
          : "no-credentials"
    );
    return c.json({ error: "Authentication required" }, 401);
  };
}

/**
 * The caller's raw Bearer token, or undefined when the request didn't carry one
 * (e.g. it arrived over the trusted-internal-hop path instead).
 *
 * This is what east-west calls should forward — see forwardedIdentityHeaders().
 */
export function callerBearerToken(c: Context): string | undefined {
  const authz = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!authz?.startsWith("Bearer ")) return undefined;
  const token = authz.slice(7).trim();
  return token || undefined;
}

export function forwardedIdentityHeaders(
  c: Context,
  identity: { id: string; email?: string; role: string }
): Record<string, string> {
  const token = callerBearerToken(c);
  if (token) return { authorization: `Bearer ${token}` };
  return internalIdentityHeaders(identity);
}

/**
 * Builds the headers an east-west (service-to-service) call must send so the
 * callee's edgeIdentityMiddleware trusts it as an in-cluster hop AS the original
 * user: the shared internal token plus the x-identity-* headers. Without the
 * token the callee falls through to 401 (headers alone are never trusted).
 *
 * If INTERNAL_SERVICE_TOKEN is unset (e.g. a single-process local dev run where
 * everything shares the same JWT path) the token header is simply omitted.
 *
 * PREFER forwardedIdentityHeaders() for calls that have a Context: behind the
 * public gateway this path is 401'd before reaching the callee (see above).
 */
export function internalIdentityHeaders(identity: {
  id: string;
  email?: string;
  role: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    [IDENTITY_HEADERS.id]: identity.id,
    [IDENTITY_HEADERS.role]: identity.role,
  };
  if (identity.email) headers[IDENTITY_HEADERS.email] = identity.email;
  const token = internalToken();
  if (token) headers[INTERNAL_TOKEN_HEADER] = token;
  return headers;
}

declare module "hono" {
  interface ContextVariableMap {
    identity: EdgeIdentity;
  }
}

/** Convenience accessor with a clear error if identity is somehow unset. */
export function requireIdentity(c: Context): EdgeIdentity {
  const identity = c.get("identity");
  if (!identity) {
    throw new Error("edgeIdentityMiddleware must run before requireIdentity");
  }
  return identity;
}
