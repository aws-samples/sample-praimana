import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  IDENTITY_HEADERS,
  INTERNAL_TOKEN_HEADER,
} from "./edge-identity.js";

/**
 * edgeIdentityMiddleware is the single authN gate in front of every service route,
 * so what it accepts IS the platform's attack surface.
 *
 * The behaviour these tests pin hardest is the RESOLUTION ORDER. Behind the HTTP
 * API, a request carries both the gateway's verified claims (in the Lambda event)
 * AND the original Authorization header. Only the first can be used: the service
 * Lambdas sit on private subnets with no NAT and no IGW, so the JWKS fetch that
 * in-service verification needs has no route out and hangs until jose's 5s timeout.
 * Preferring the header would turn every authenticated request into a 5-second 401
 * — which is exactly the outage this ordering fixes. A test that lets the JWKS path
 * run first would pass locally and fail in production, so the ordering is asserted
 * directly (see "prefers the gateway's claims").
 *
 * The other invariant: identity comes only from VERIFIED claims or a secret-backed
 * internal hop. x-identity-* headers alone are never believed.
 */

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

/** A minimal app that echoes whatever identity the middleware resolved. */
function app() {
  const a = new Hono();
  a.use("*", edgeIdentityMiddleware());
  a.get("/who", (c) => c.json(requireIdentity(c)));
  return a;
}

/**
 * The env Hono's aws-lambda adapter builds for a request that came through a
 * JWT-authorized HTTP API route: the verified claims live in the EVENT, which is
 * why a client cannot inject them.
 *
 * Claim VALUES are strings, including arrays — the authorizer flattens every claim
 * before handing it over, rendering cognito:groups as "[A B]". Using the real
 * bracketed shape here is the point; an array would test a shape that never
 * actually arrives from the gateway.
 */
function gatewayEnv(claims: Partial<Record<string, string>>) {
  return { requestContext: { authorizer: { jwt: { claims, scopes: null } } } };
}

describe("edgeIdentityMiddleware — gateway-verified claims", () => {
  it("takes identity from requestContext.authorizer.jwt.claims", async () => {
    const res = await app().request(
      "/who",
      {},
      gatewayEnv({
        sub: "user-1",
        email: "a@example.com",
        "cognito:groups": "[FACILITATOR]",
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "user-1",
      email: "a@example.com",
      role: "FACILITATOR",
    });
  });

  it("prefers the gateway's claims over re-verifying the bearer token", async () => {
    // THE regression guard. Behind the gateway both are present. If the bearer
    // path ran first it would attempt a JWKS fetch — which on a private subnet
    // hangs for 5s and then 401s. fetch is stubbed to throw so that any attempt to
    // reach the network fails the test loudly instead of silently passing.
    const netCall = vi.fn(() => {
      throw new Error("no egress: JWKS must not be fetched behind the gateway");
    });
    vi.stubGlobal("fetch", netCall);

    const res = await app().request(
      "/who",
      { headers: { authorization: "Bearer not.a.real.token" } },
      gatewayEnv({ sub: "user-2", email: "b@example.com", "cognito:groups": "[ADMIN]" })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "user-2", role: "ADMIN" });
    expect(netCall).not.toHaveBeenCalled();
  });

  it("ignores x-identity-* headers even when the gateway claims are present", async () => {
    // The headers name a different, higher-privileged user. The event wins.
    const res = await app().request(
      "/who",
      {
        headers: {
          [IDENTITY_HEADERS.id]: "attacker",
          [IDENTITY_HEADERS.email]: "attacker@example.com",
          [IDENTITY_HEADERS.role]: "ADMIN",
        },
      },
      gatewayEnv({
        sub: "real-user",
        email: "real@example.com",
        "cognito:groups": "[PARTICIPANT]",
      })
    );

    expect(await res.json()).toEqual({
      id: "real-user",
      email: "real@example.com",
      role: "PARTICIPANT",
    });
  });

  it("defaults email to empty and role to PARTICIPANT when those claims are absent", async () => {
    // A token minted before the groups were assigned still authenticates — as the
    // least-privileged role, never as more.
    const res = await app().request("/who", {}, gatewayEnv({ sub: "user-3" }));
    expect(await res.json()).toEqual({ id: "user-3", email: "", role: "PARTICIPANT" });
  });

  it("falls through to 401 when the claims carry no sub", async () => {
    // No subject ⇒ no principal. Nothing to authorize as, so this must not become
    // an identity with an empty id (which team membership rows could match).
    for (const claims of [{}, { sub: "" }, { email: "x@example.com" }]) {
      const res = await app().request("/who", {}, gatewayEnv(claims));
      expect(res.status).toBe(401);
    }
  });

  it("falls through when there is no authorizer in the event at all", async () => {
    // A local Node run, an ALB, or a route with Authorizer: NONE. None of these
    // shapes may be read as an authenticated caller.
    for (const env of [
      {},
      { requestContext: {} },
      { requestContext: { authorizer: {} } },
      { requestContext: { authorizer: { jwt: {} } } },
      { requestContext: { authorizer: { iam: { userId: "AIDA..." } } } },
      { requestContext: { authorizer: { jwt: { claims: null } } } },
      { requestContext: { authorizer: { jwt: { claims: "not-an-object" } } } },
    ]) {
      const res = await app().request("/who", {}, env);
      expect(res.status).toBe(401);
    }
  });
});

describe("collapseGroupsToRole — both claim encodings agree", () => {
  /** Resolve a role through the middleware, given one cognito:groups encoding. */
  const roleFor = async (groups: unknown) => {
    const res = await app().request(
      "/who",
      {},
      {
        requestContext: {
          authorizer: { jwt: { claims: { sub: "u", "cognito:groups": groups } } },
        },
      }
    );
    return (await res.json()).role;
  };

  it("reads the gateway's bracketed string form", async () => {
    expect(await roleFor("[ADMIN]")).toBe("ADMIN");
    expect(await roleFor("[JUDGE]")).toBe("JUDGE");
  });

  it("reads jose's array form identically", async () => {
    // The in-service path (WebSocket handshake, EKS) parses real JSON, so the same
    // claim is an array there. A user's role must not depend on the entry point.
    expect(await roleFor(["ADMIN"])).toBe("ADMIN");
    expect(await roleFor(["JUDGE"])).toBe("JUDGE");
  });

  it("applies the precedence order, not the listed order", async () => {
    // Cognito lists groups in its own order; the LOWEST precedence index wins.
    expect(await roleFor("[PARTICIPANT ADMIN]")).toBe("ADMIN");
    expect(await roleFor("[PARTICIPANT FACILITATOR]")).toBe("FACILITATOR");
    expect(await roleFor("[EXECUTIVE JUDGE]")).toBe("JUDGE");
    expect(await roleFor(["PARTICIPANT", "ADMIN"])).toBe("ADMIN");
  });

  it("degrades to PARTICIPANT for anything unparseable — never escalates", async () => {
    for (const groups of [
      undefined,
      null,
      "",
      "[]",
      "[ ]",
      [],
      "[UNKNOWN_GROUP]",
      42,
      { ADMIN: true }, // an object could not be searched for a role name
    ]) {
      expect(await roleFor(groups)).toBe("PARTICIPANT");
    }
  });

  it("does not match a role name embedded in a larger group name", async () => {
    // "NOT_ADMIN" must not read as ADMIN. Splitting on the separator (rather than
    // substring-matching) is what makes this hold.
    expect(await roleFor("[NOT_ADMIN]")).toBe("PARTICIPANT");
    expect(await roleFor("[ADMINISTRATOR]")).toBe("PARTICIPANT");
  });
});

describe("edgeIdentityMiddleware — the non-gateway paths still work", () => {
  it("401s a request with no credential of any kind", async () => {
    const res = await app().request("/who");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("401s x-identity-* headers presented alone", async () => {
    // Without a matching internal token these headers are inert. This is the whole
    // anti-spoofing control, since nothing strips them at the AWS edge.
    const res = await app().request("/who", {
      headers: {
        [IDENTITY_HEADERS.id]: "attacker",
        [IDENTITY_HEADERS.role]: "ADMIN",
      },
    });
    expect(res.status).toBe(401);
  });

  it("401s x-identity-* headers with a WRONG internal token", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const res = await app().request("/who", {
      headers: {
        [INTERNAL_TOKEN_HEADER]: "a-guess",
        [IDENTITY_HEADERS.id]: "attacker",
        [IDENTITY_HEADERS.role]: "ADMIN",
      },
    });
    expect(res.status).toBe(401);
  });

  it("trusts x-identity-* alongside the matching internal token", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const res = await app().request("/who", {
      headers: {
        [INTERNAL_TOKEN_HEADER]: "the-real-secret",
        [IDENTITY_HEADERS.id]: "u-9",
        [IDENTITY_HEADERS.email]: "u9@example.com",
        [IDENTITY_HEADERS.role]: "FACILITATOR",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "u-9",
      email: "u9@example.com",
      role: "FACILITATOR",
    });
  });

  it("401s a bearer token when COGNITO_ISSUER is unconfigured (fail closed)", async () => {
    // No issuer ⇒ no key set ⇒ nothing can be verified. The safe answer is 401,
    // not "trust it".
    const previous = process.env.COGNITO_ISSUER;
    delete process.env.COGNITO_ISSUER;
    try {
      const res = await app().request("/who", {
        headers: { authorization: "Bearer some.jwt.token" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid or expired token" });
    } finally {
      if (previous !== undefined) process.env.COGNITO_ISSUER = previous;
    }
  });
});

/**
 * ── ⚠ AN AUTHENTICATION FAILURE LEAVES A TRACE ──────────────────────────────────────────────────
 *
 * THE GAP. This middleware is the single authentication entry point for every HTTP service, and both
 * of its 401 exits returned with NO `console.*` call and NO metric. A repo-wide grep confirmed those
 * were the only two 401 sites outside tests, so token replay, expired-token floods, credential
 * stuffing and probes of the `x-internal-token` SHARED SECRET left no trace whatsoever. There is no
 * Hono `logger()` anywhere either, so nothing else was going to record them.
 *
 * The COUNT lives in `withHealth`'s response middleware (see auth-denial-metric.test.ts). This is the
 * DETAIL an operator needs once the count has fired: which failure mode, from which client, against
 * which route shape — and, just as importantly, WITHOUT the credential or the invitee's address.
 */
describe("edgeIdentityMiddleware — authentication failures are recorded", () => {
  function captureWarnings() {
    const lines: unknown[][] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    return lines;
  }

  it("logs an ABSENT credential with reason no-credentials", async () => {
    const warnings = captureWarnings();

    const res = await app().request("/who");

    expect(res.status).toBe(401);
    const serialised = JSON.stringify(warnings);
    expect(serialised).toContain("authentication failed");
    expect(serialised).toContain("no-credentials");
  });

  it("logs an INVALID bearer token distinctly from a missing one", async () => {
    // Two different operational events: a client whose session lapsed, versus an unauthenticated
    // probe. One reason string for each, or the log cannot tell them apart.
    const warnings = captureWarnings();
    const previous = process.env.COGNITO_ISSUER;
    delete process.env.COGNITO_ISSUER;
    try {
      const res = await app().request("/who", {
        headers: { authorization: "Bearer some.jwt.token" },
      });
      expect(res.status).toBe(401);
      expect(JSON.stringify(warnings)).toContain("invalid-or-expired-token");
    } finally {
      if (previous !== undefined) process.env.COGNITO_ISSUER = previous;
    }
  });

  it("⚠ logs an internal-token MISMATCH as its own reason — the shared-secret probe", async () => {
    /**
     * THE CASE THIS FILE MOST NEEDED, and the one that was hardest to see: a WRONG internal token
     * falls through resolution step 3 into the generic "Authentication required" exit, previously
     * indistinguishable from an ordinary anonymous request. A brute-force against the shared secret
     * looked exactly like unauthenticated traffic. `reason` is what separates them.
     */
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const warnings = captureWarnings();

    const res = await app().request("/who", {
      headers: {
        [INTERNAL_TOKEN_HEADER]: "a-guessed-secret",
        [IDENTITY_HEADERS.id]: "u1",
        [IDENTITY_HEADERS.role]: "ADMIN",
      },
    });

    expect(res.status).toBe(401);
    expect(JSON.stringify(warnings)).toContain("internal-token-mismatch");
  });

  it("distinguishes a VALID internal token that carried no identity headers", async () => {
    // A trusted hop that forgot its headers is a caller BUG, not an attack — and conflating it with
    // a secret probe would either hide the probe or cry wolf about a broken client.
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const warnings = captureWarnings();

    const res = await app().request("/who", {
      headers: { [INTERNAL_TOKEN_HEADER]: "the-real-secret" },
    });

    expect(res.status).toBe(401);
    expect(JSON.stringify(warnings)).toContain("internal-token-without-identity-headers");
  });

  it("⚠ NEVER logs the token, in any form", async () => {
    // It is a live credential. Not the value, not a prefix, not a hash — a prefix is enough to
    // correlate sessions, and a log is not the place for any of it.
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const warnings = captureWarnings();

    await app().request("/who", {
      headers: {
        authorization: "Bearer super.secret.jwt",
        [INTERNAL_TOKEN_HEADER]: "a-guessed-secret",
      },
    });

    const serialised = JSON.stringify(warnings);
    expect(serialised).not.toContain("super.secret.jwt");
    expect(serialised).not.toContain("a-guessed-secret");
    expect(serialised).not.toContain("the-real-secret");
    expect(serialised).not.toContain("Bearer");
  });

  it("⚠ NEVER logs the raw path — several routes are keyed on an EMAIL ADDRESS", async () => {
    // `DELETE /teams/:teamId/invitations/:email` would put recipient addresses into CloudWatch on
    // exactly the attacker-driven requests. The route is reduced to a caller-independent template.
    const warnings = captureWarnings();
    const a = new Hono();
    a.use("*", edgeIdentityMiddleware());
    a.get("/v1/teams/:teamId/invitations/:email/workshop", (c) => c.json(requireIdentity(c)));

    await a.request("/v1/teams/t-1/invitations/victim%40example.com/workshop");

    const serialised = JSON.stringify(warnings);
    expect(serialised).not.toContain("victim");
    expect(serialised).not.toContain("corp.com");
    expect(serialised).toContain("/v1/teams/:id/invitations/:id/workshop");
  });

  it("records the source ip and user agent, BOUNDED", async () => {
    // The only things that distinguish one probing client from another — and both are caller-supplied,
    // so both are truncated rather than trusted to be small.
    const warnings = captureWarnings();

    await app().request("/who", {
      headers: {
        "x-forwarded-for": `203.0.113.7, 198.51.100.1`,
        "user-agent": "A".repeat(500),
      },
    });

    const serialised = JSON.stringify(warnings);
    // The CLIENT ip is the first entry, not the last proxy.
    expect(serialised).toContain("203.0.113.7");
    expect(serialised).not.toContain("A".repeat(200));
  });

  it("says NOTHING on a successful authentication", async () => {
    // A log line per successful request would be an access log, which is a separate decision with a
    // separate cost. This records failures only.
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const warnings = captureWarnings();

    const res = await app().request("/who", {
      headers: {
        [INTERNAL_TOKEN_HEADER]: "the-real-secret",
        [IDENTITY_HEADERS.id]: "u1",
        [IDENTITY_HEADERS.role]: "ADMIN",
      },
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(warnings)).not.toContain("authentication failed");
  });
});
