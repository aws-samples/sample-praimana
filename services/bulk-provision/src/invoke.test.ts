// ── ⚠ `Invoke` SUCCEEDS WHEN THE TARGET FAILS ────────────────────────────────────────────
//
// This is the single most dangerous property of direct Lambda invocation, and the reason this module
// exists rather than call sites using the SDK directly.
//
// A 403, a 500, or an unhandled throw in the callee all come back as a SUCCESSFUL Invoke whose payload
// happens to describe a failure. Code that only checked for a thrown error would read
// "team not created, 403 Forbidden" as success — and then invite eighteen people to a team that does
// not exist. Every test in the first section is that bug.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildGatewayEvent, callService, ServiceInvokeError, setLambdaClient } from "./invoke";

const identity = { id: "u-fac", email: "fac@example.com", role: "FACILITATOR" };

/** A fake LambdaClient whose `send` returns whatever the test needs. */
function fakeClient(reply: unknown) {
  const send = vi.fn().mockResolvedValue(reply);
  setLambdaClient({ send } as never);
  return send;
}

/** What a proxy integration actually returns: a JSON envelope, with body as a STRING. */
const proxyReply = (statusCode: number, body: unknown) => ({
  Payload: Buffer.from(JSON.stringify({ statusCode, body: JSON.stringify(body) })),
});

beforeEach(() => setLambdaClient(undefined));
afterEach(() => setLambdaClient(undefined));

describe("⚠ a failing callee must throw, not return", () => {
  /**
   * THE TEST THAT MATTERS MOST. A 403 from team creation is the realistic case — a facilitator who
   * does not own the experience — and reading it as success is how a batch proceeds to invite people
   * to a team that was never created.
   */
  it("throws on a 403 payload even though Invoke succeeded", async () => {
    fakeClient(proxyReply(403, { error: "Forbidden: only the experience owner can create teams" }));

    await expect(callService("praimana-team", "POST", "/v1/workshops/w1/teams", identity)).rejects.toThrow(
      ServiceInvokeError
    );
  });

  it("carries the callee's own message, not a generic one", async () => {
    fakeClient(proxyReply(409, { error: "This experience has no valid maximum team size" }));

    const err = await callService("praimana-team", "POST", "/x", identity).catch((e) => e);
    // The operator needs the REASON; "request failed" would send them hunting.
    expect(err.message).toMatch(/maximum team size/);
    expect(err.status).toBe(409);
  });

  it.each([400, 401, 403, 409, 500, 503])("throws on %i", async (code) => {
    fakeClient(proxyReply(code, { error: "no" }));
    await expect(callService("f", "POST", "/x", identity)).rejects.toThrow(ServiceInvokeError);
  });

  /**
   * ⚠ SIGNAL 1: the callee threw. `FunctionError` is set and the payload is a stack trace rather than
   * a proxy envelope — so a `statusCode`-only check would fall through to "no statusCode" and, if that
   * defaulted to 200, report success on a crashed service.
   */
  it("throws when FunctionError is set, whatever the payload says", async () => {
    fakeClient({
      FunctionError: "Unhandled",
      Payload: Buffer.from(JSON.stringify({ errorMessage: "boom", errorType: "TypeError" })),
    });

    await expect(callService("f", "POST", "/x", identity)).rejects.toThrow(/threw \(Unhandled\)/);
  });

  /**
   * ⚠ A MISSING `statusCode` IS 502, NOT 200. An envelope without one is not a proxy response, and
   * defaulting to success would turn "I have no idea what happened" into "it worked".
   */
  it("treats an envelope with no statusCode as a failure", async () => {
    fakeClient({ Payload: Buffer.from(JSON.stringify({ something: "else" })) });
    await expect(callService("f", "POST", "/x", identity)).rejects.toThrow(ServiceInvokeError);
  });

  it("treats an unreadable payload as a failure", async () => {
    fakeClient({ Payload: Buffer.from("not json at all") });
    await expect(callService("f", "POST", "/x", identity)).rejects.toThrow(/unreadable/);
  });

  it("treats an absent payload as a failure", async () => {
    fakeClient({});
    await expect(callService("f", "POST", "/x", identity)).rejects.toThrow(ServiceInvokeError);
  });
});

describe("a succeeding callee returns its parsed body", () => {
  it("parses the double-encoded body a proxy response uses", async () => {
    fakeClient(proxyReply(201, { team: { id: "t-1", name: "Aurora" } }));

    const res = await callService<{ team: { id: string } }>("f", "POST", "/x", identity, { name: "Aurora" });

    expect(res.status).toBe(201);
    expect(res.body.team.id).toBe("t-1");
  });

  it("accepts 200 and 202 as success", async () => {
    for (const code of [200, 202]) {
      fakeClient(proxyReply(code, { ok: true }));
      await expect(callService("f", "GET", "/x", identity)).resolves.toMatchObject({ status: code });
    }
  });

  it("tolerates a non-JSON body on success rather than failing the call", async () => {
    fakeClient({ Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: "plain text" })) });
    await expect(callService("f", "GET", "/x", identity)).resolves.toMatchObject({ body: "plain text" });
  });
});

describe("⚠ the event must look like the gateway's, or path 1 will not fire", () => {
  /**
   * The whole authentication design rests on this shape: `edgeIdentityMiddleware` path 1 reads
   * `requestContext.authorizer.jwt.claims` and verifies nothing. Get the path wrong and the callee
   * falls through to 401 with no clue why.
   */
  it("puts the identity in requestContext.authorizer.jwt.claims", () => {
    const e = buildGatewayEvent("POST", "/v1/workshops/w1/teams", { name: "A" }, identity);
    const claims = e.requestContext.authorizer.jwt.claims;

    expect(claims.sub).toBe("u-fac");
    expect(claims.email).toBe("fac@example.com");
  });

  /**
   * ⚠ AN ARRAY, NOT A STRING. `collapseGroupsToRole` scans an array against ROLE_PRECEDENCE and
   * returns PARTICIPANT for anything unrecognised — so a wrong shape DEMOTES rather than escalates,
   * and the callee then refuses a facilitator-only route with a 403 that looks like a permissions bug.
   */
  it("sets cognito:groups as an ARRAY containing the role", () => {
    const e = buildGatewayEvent("POST", "/x", undefined, identity);
    expect(e.requestContext.authorizer.jwt.claims["cognito:groups"]).toEqual(["FACILITATOR"]);
  });

  /**
   * ⚠ NO `authorization` HEADER. One would send the callee down path 2, where it tries to verify a
   * token that does not exist and 401s — so a header added "for completeness" would break every call.
   */
  it("sends no authorization header", () => {
    const e = buildGatewayEvent("POST", "/x", undefined, identity);
    const keys = Object.keys(e.headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain("authorization");
  });

  it("puts the method and path where the router reads them", () => {
    const e = buildGatewayEvent("PATCH", "/v1/teams/t1/tasks/x", undefined, identity);
    expect(e.rawPath).toBe("/v1/teams/t1/tasks/x");
    expect(e.requestContext.http.method).toBe("PATCH");
    expect(e.requestContext.http.path).toBe("/v1/teams/t1/tasks/x");
  });

  it("serialises the body as a STRING, as a proxy event does", () => {
    const e = buildGatewayEvent("POST", "/x", { name: "Aurora" }, identity);
    expect(typeof e.body).toBe("string");
    expect(JSON.parse(e.body as string)).toEqual({ name: "Aurora" });
  });

  it("omits the body entirely for a GET", () => {
    // A GET carrying "undefined" as a string would be parsed by the callee and fail.
    expect(buildGatewayEvent("GET", "/x", undefined, identity).body).toBeUndefined();
  });

  it("declares version 2.0, which decides how the adapter reads the event", () => {
    expect(buildGatewayEvent("GET", "/x", undefined, identity).version).toBe("2.0");
  });
});

describe("the invocation itself", () => {
  it("uses RequestResponse, because the worker needs the answer", async () => {
    const send = fakeClient(proxyReply(200, {}));
    await callService("praimana-team", "GET", "/x", identity);

    const cmd = send.mock.calls[0][0];
    expect(cmd.input.InvocationType).toBe("RequestResponse");
    expect(cmd.input.FunctionName).toBe("praimana-team");
  });

  it("does not leak the identity into the function name or path", async () => {
    // Cheap guard against a future refactor that builds paths by concatenation.
    const send = fakeClient(proxyReply(200, {}));
    await callService("praimana-team", "GET", "/v1/workshops/w1/teams", identity);
    const cmd = send.mock.calls[0][0];
    expect(cmd.input.FunctionName).not.toContain("fac@example.com");
  });
});
