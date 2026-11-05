// ── WHICH TRANSPORT CARRIES THE OWNERSHIP QUESTION ───────────────────────────────────────
//
// ⚠ THESE TESTS EXIST BECAUSE THE BUG THEY PIN REACHED PRODUCTION AND ATE A REAL UPLOAD.
//
// A facilitator uploaded a file naming 3 teams and 18 members. Every team was refused with "only the
// workshop owner can create teams". They owned the workshop. The whole failure was one transport
// choice: `WORKSHOP_SERVICE_URL` is the PUBLIC gateway, every route behind a Cognito authorizer, and
// the bulk-provision worker invokes this service with NO bearer token (IAM is its credential). So the
// ownership probe went out with `x-identity-*` and nothing else, the gateway answered
// `401 {"message":"Unauthorized"}` before the Workshop Lambda ran, and `ownsWorkshop` fail-closed —
// correctly, and indistinguishably from a real denial.
//
// Nothing about the AUTHORIZATION changed in the fix, and the first test below is what holds that
// line: the question is still asked, still answered by the Workshop service from its own data, still
// fails closed. Only the envelope changed.
//
// The properties under test:
//
//   1. A bearer ALWAYS wins — every gateway-served request behaves exactly as it did.
//   2. No bearer + a function name ⇒ direct invocation, and the ownership answer comes back.
//   3. No bearer + NO function name ⇒ HTTP, unchanged. This is local dev, which must not regress.
//   4. The invoked event asserts the CALLER's identity and no more — no bearer, no widened role.
//   5. A callee that refuses is still a denial, not a crash; a transport that breaks is still not
//      an ownership answer.
//   6. `teamSeatTemplate` uses the SAME transport, because team creation calls both.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { setLambdaClient } from "@praimana/service-shared";
import { HttpWorkshopAccess } from "./workshop-access.http.js";
import type { AuthContext } from "./authz.js";
import type { TeamRepository } from "./domain.js";

const BASE = "http://workshop.test/v1";
const WORKSHOP_FN = "praimana-workshop";
const CALLER_BEARER = "header.payload.signature";
const WORKSHOP_ID = "01KZVC9WVW4MBZS362BE6EPR0E";
const OWNER = "a4683438-a081-70bd-8a95-5ad84797afc8";

/** Only `getById` is reachable from these paths; the rest of the repository is not exercised. */
const teams = {} as TeamRepository;

function contextWith(headers: Record<string, string> = {}): AuthContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as AuthContext;
}

const withBearer = () => contextWith({ authorization: `Bearer ${CALLER_BEARER}` });
/** What the worker's invocation produces: a request with no token at all. */
const tokenless = () => contextWith({});

function stubFetch(impl: () => Response) {
  const spy = vi.fn(async (_url: unknown, _init?: RequestInit) => impl());
  vi.stubGlobal("fetch", spy);
  return spy;
}

const httpJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A Lambda client that answers with a gateway-shaped proxy envelope, and records what it was sent. */
function stubLambda(envelope: { statusCode?: number; body?: unknown }, functionError?: string) {
  const send = vi.fn(async () => ({
    FunctionError: functionError,
    Payload: Buffer.from(
      JSON.stringify({
        statusCode: envelope.statusCode,
        body: envelope.body === undefined ? undefined : JSON.stringify(envelope.body),
      })
    ),
  }));
  setLambdaClient({ send } as never);
  return send;
}

/** A Lambda client that fails at the transport level — a timeout, a throttle, a missing permission. */
function stubLambdaThrowing(err: Error) {
  const send = vi.fn(async () => {
    throw err;
  });
  setLambdaClient({ send } as never);
  return send;
}

/** The event the callee would receive, parsed back out of the recorded Invoke input. */
function sentEvent(send: ReturnType<typeof stubLambda>, call = 0) {
  const input = (send.mock.calls[call] as unknown as [{ input: { Payload: Uint8Array } }])[0].input;
  return JSON.parse(Buffer.from(input.Payload).toString("utf8"));
}

const workshopBody = (ownerId: string, maxTeamSize = 6) => ({
  workshop: { id: WORKSHOP_ID, ownerId, maxTeamSize },
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setLambdaClient(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── 1. A BEARER ALWAYS WINS ─────────────────────────────────────────────────────────

describe("a caller's bearer token is still preferred over everything", () => {
  /**
   * ⚠ THE REGRESSION GUARD FOR EVERY NORMAL REQUEST. Almost all traffic arrives over the gateway with
   * a token, and for that traffic the fix must be UNREACHABLE. If the direct-invoke path ever became
   * the default it would replace a hop the callee verifies (a real JWT) with one it does not (claims
   * we hand it), which is a strictly weaker channel — even though it "works".
   */
  it("uses HTTP with the re-presented token, and does not invoke the Lambda at all", async () => {
    const fetchSpy = stubFetch(() => httpJson(workshopBody(OWNER)));
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    const owns = await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      withBearer()
    );

    expect(owns).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${CALLER_BEARER}`);
  });
});

// ─── 2. NO BEARER ⇒ THE ANSWER STILL ARRIVES ─────────────────────────────────────────

describe("⚠ a tokenless caller (the bulk worker) now gets a real answer", () => {
  /**
   * THE BUG, INVERTED. Before the fix this returned false — the gateway 401'd the tokenless hop — and
   * a facilitator was told they did not own a workshop they owned.
   */
  it("invokes the Workshop function and reports ownership", async () => {
    const fetchSpy = stubFetch(() => httpJson({}, 401));
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    const owns = await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    expect(owns).toBe(true);
    // The gateway is not consulted at all — that request could only ever have 401'd.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("asks the Workshop service's own route, under its /v1 basePath", async () => {
    // A path missing the basePath would 404 inside the callee's Hono app and read as "no such
    // workshop" — a denial produced by a typo.
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    const event = sentEvent(send);
    expect(event.rawPath).toBe(`/v1/workshops/${WORKSHOP_ID}`);
    expect(event.requestContext.http.method).toBe("GET");
  });

  /**
   * ⚠ STILL FAIL-CLOSED ON A REAL DENIAL. The transport changed; the answer did not. A different
   * owner is not the caller, over any transport.
   */
  it("returns false when the workshop belongs to somebody else", async () => {
    stubLambda({ statusCode: 200, body: workshopBody("some-other-facilitator") });

    const owns = await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    expect(owns).toBe(false);
  });

  it("returns false when the response carries no ownerId", async () => {
    // An absent ownerId on both sides must never read as a match.
    stubLambda({ statusCode: 200, body: { workshop: { id: WORKSHOP_ID } } });

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe(false);
  });
});

// ─── 3. LOCAL DEV MUST NOT REGRESS ───────────────────────────────────────────────────

describe("without a function name the fallback does not exist", () => {
  /**
   * ⚠ THIS IS LOCAL DEV, AND IT IS WHY THE FALLBACK IS CONDITIONAL RATHER THAN UNCONDITIONAL. There,
   * `WORKSHOP_SERVICE_URL` is `http://localhost` with no authorizer in front of it, the internal
   * header path works, and there is no Lambda to invoke. Making direct invocation the tokenless
   * default would have broken every local run in exchange for fixing the deployed one.
   */
  it("still uses HTTP for a tokenless caller, exactly as before", async () => {
    const fetchSpy = stubFetch(() => httpJson(workshopBody(OWNER)));
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    const owns = await new HttpWorkshopAccess(teams, BASE, "").ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    expect(owns).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── 4. THE EVENT ASSERTS THE CALLER, AND NOTHING WIDER ──────────────────────────────

describe("⚠ the invoked event carries the caller's identity and no more", () => {
  /**
   * The callee's path-1 middleware VERIFIES NOTHING in these claims — the gateway normally has. So
   * whatever is written here IS the asserted identity, and the only safe content is the caller's own.
   */
  it("asserts the caller's own sub and role", async () => {
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    const claims = sentEvent(send).requestContext.authorizer.jwt.claims;
    expect(claims.sub).toBe(OWNER);
    // An array, because `collapseGroupsToRole` scans it — a bare string would DEMOTE to PARTICIPANT
    // and the callee would refuse a facilitator route.
    expect(claims["cognito:groups"]).toEqual(["FACILITATOR"]);
  });

  /**
   * ⚠ NO `authorization` HEADER, EVER. One would send the callee down path 2, where it would try to
   * verify a token that does not exist and 401 — turning the fix back into the bug.
   */
  it("sends no authorization header", async () => {
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    expect(Object.keys(sentEvent(send).headers)).toEqual(["content-type"]);
  });

  it("does not smuggle a role from an inbound header", async () => {
    // The deployed gateway does NOT strip x-identity-*, so these really can arrive from outside. The
    // role passed to this method comes from the middleware's resolved identity; the header must not
    // be able to overrule it.
    const send = stubLambda({ statusCode: 200, body: workshopBody(OWNER) });

    await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      contextWith({ "x-identity-role": "ADMIN", "x-identity-id": "attacker" })
    );

    const claims = sentEvent(send).requestContext.authorizer.jwt.claims;
    expect(claims["cognito:groups"]).toEqual(["FACILITATOR"]);
    expect(claims.sub).toBe(OWNER);
  });
});

// ─── 5. FAILURES STAY FAILURES ───────────────────────────────────────────────────────

describe("⚠ a failure is still not an ownership answer", () => {
  it("a callee that answers 403 is a denial, not a crash", async () => {
    stubLambda({ statusCode: 403, body: { error: "Forbidden" } });

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe(false);
  });

  it("a 404 is a denial", async () => {
    stubLambda({ statusCode: 404, body: { error: "Not found" } });

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe(false);
  });

  /**
   * ⚠ THE MISSING-PERMISSION CASE, WHICH IS THE MOST LIKELY DEPLOY-TIME FAULT. If
   * `lambda:InvokeFunction` is absent the SDK throws AccessDeniedException — and this must deny
   * rather than 500, for the same reason every other probe failure denies: the caller cannot act on
   * it either way, and a 500 would be a worse outcome than a refusal.
   */
  it("a transport failure (no permission, throttle, timeout) denies", async () => {
    stubLambdaThrowing(
      Object.assign(new Error("User is not authorized to perform: lambda:InvokeFunction"), {
        name: "AccessDeniedException",
      })
    );

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe(false);
  });

  it("a callee that THREW denies — an Invoke can succeed while the target fails", async () => {
    // The trap: FunctionError is set but the Invoke itself reported success.
    stubLambda({ statusCode: 200, body: workshopBody(OWNER) }, "Unhandled");

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe(false);
  });

  it("says which transport failed, so a gateway 401 is distinguishable from a callee refusal", async () => {
    // The original bug was diagnosable ONLY from this log line, and it did not name the transport —
    // which is the single fact that separates "the gateway rejected a tokenless hop" from "the
    // Workshop service said no".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubLambda({ statusCode: 403, body: { error: "Forbidden" } });

    await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).ownsWorkshop(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    const logged = warn.mock.calls.find((c) => String(c[0]).includes("probe non-OK"));
    expect(logged).toBeDefined();
    expect((logged![1] as { transport: string }).transport).toBe("lambda");
  });
});

// ─── 6. THE SEAT TEMPLATE TAKES THE SAME ROUTE ───────────────────────────────────────

describe("⚠ teamSeatTemplate uses the same transport", () => {
  /**
   * Team creation calls BOTH methods. A version of this fix that repaired the ownership gate and not
   * the seat template would have turned the bulk failure from "Forbidden" into "503 the seat template
   * is unavailable" — different message, equally unusable.
   */
  it("reads maxTeamSize over the direct invocation", async () => {
    const fetchSpy = stubFetch(() => httpJson({}, 401));
    stubLambda({ statusCode: 200, body: workshopBody(OWNER, 6) });

    const template = await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).teamSeatTemplate(
      WORKSHOP_ID,
      OWNER,
      "FACILITATOR",
      tokenless()
    );

    expect(template).toBe(6);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an out-of-range stored value as invalid, not as a number", async () => {
    stubLambda({ statusCode: 200, body: workshopBody(OWNER, 999) });

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).teamSeatTemplate(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe("invalid");
  });

  it("reports a refused invocation as unavailable, never as a guessed cap", async () => {
    // There is no safe fallback for a seat cap: 10 would be the widest answer and 2 would make teams
    // uncreatable. So the caller is told the truth and refuses.
    stubLambda({ statusCode: 403, body: { error: "Forbidden" } });

    expect(
      await new HttpWorkshopAccess(teams, BASE, WORKSHOP_FN).teamSeatTemplate(
        WORKSHOP_ID,
        OWNER,
        "FACILITATOR",
        tokenless()
      )
    ).toBe("unavailable");
  });
});
