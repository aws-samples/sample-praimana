import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  EAST_WEST_TIMEOUT_MS,
  IDENTITY_HEADERS,
  INTERNAL_TOKEN_HEADER,
} from "@praimana/service-shared";
import { HttpWorkshopDirectory } from "./workshop-directory.http.js";
import type { AuthContext } from "./authz.js";

/**
 * ADVERSARIAL TESTS FOR THE EAST-WEST IDENTITY HOP — from a pre-deploy security review.
 *
 * The question this file answers, from the threat model: `workshop-directory.http.ts` re-presents
 * the CALLER's bearer token and falls back to the internal-hop headers when there is none. Can that
 * fallback be abused to make the callee authorize a DIFFERENT identity than the caller — and can an
 * external caller inject those internal headers from outside?
 *
 * The three properties under test:
 *
 *   1. When a token is present, ONLY the token is forwarded. No x-identity-* headers ride along, so
 *      the hop cannot express an identity the token does not carry.
 *   2. The fallback identity is the CALLER's resolved id and role — taken from the middleware's
 *      verified claims — and is never read from an inbound header by this client.
 *   3. Every path is timeout-bounded, including the DISPLAY-only name resolution, so a slow
 *      Workshop service cannot pin a Team Lambda for the gateway timeout.
 */

const ORIGINAL_INTERNAL_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;

beforeEach(() => {
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_INTERNAL_TOKEN === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
  else process.env.INTERNAL_SERVICE_TOKEN = ORIGINAL_INTERNAL_TOKEN;
});

function stubFetch(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) => impl(String(url), init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const BASE = "http://workshop.test/v1";
const CALLER_BEARER = "header.payload.signature";

function contextWith(headers: Record<string, string>): AuthContext {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    req: { header: (name: string) => lower[name.toLowerCase()] },
  } as unknown as AuthContext;
}

const headersOf = (spy: ReturnType<typeof stubFetch>, call = 0) =>
  ((spy.mock.calls[call][1] as RequestInit).headers ?? {}) as Record<string, string>;

// ─── 1. A PRESENT TOKEN IS THE ONLY IDENTITY FORWARDED ──────────────────────────────

describe("ATTACK: identity confusion on the east-west hop", () => {
  it("forwards ONLY the bearer token when one is present — no x-identity-* rides along", async () => {
    // THE CORE PROPERTY. `forwardedIdentityHeaders` returns `{ authorization }` and NOTHING else
    // when a token exists, so the hop "cannot express any authority the original caller lacked":
    // the callee re-derives identity from the token's verified claims and ignores the headers.
    //
    // Asserted as an EXACT header set, not a contains: a future edit that added x-identity-* "for
    // observability" would create a second, forgeable identity channel on the same request.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
    );

    expect(headersOf(spy)).toEqual({ authorization: `Bearer ${CALLER_BEARER}` });
  });

  it("INBOUND x-identity-* headers are NOT copied onto the hop, even alongside a real token", async () => {
    // THE INJECTION ATTEMPT. An external caller sets x-identity-role: ADMIN on their own request to
    // the Team service. edgeIdentityMiddleware ignores those (the gateway's verified claims win, and
    // the header path additionally requires the shared secret), and this client must not resurrect
    // them by forwarding them onward — which would launder the attacker's claim into a hop the
    // callee might trust.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({
        authorization: `Bearer ${CALLER_BEARER}`,
        [IDENTITY_HEADERS.id]: "attacker-chosen-sub",
        [IDENTITY_HEADERS.role]: "ADMIN",
        [IDENTITY_HEADERS.email]: "boss@example.com",
        [INTERNAL_TOKEN_HEADER]: "guessed-secret",
      })
    );

    const sent = headersOf(spy);
    expect(sent).toEqual({ authorization: `Bearer ${CALLER_BEARER}` });
    expect(sent[IDENTITY_HEADERS.role]).toBeUndefined();
    expect(sent[IDENTITY_HEADERS.id]).toBeUndefined();
    expect(sent[INTERNAL_TOKEN_HEADER]).toBeUndefined();
  });

  it("the same holds for the NAME resolution path, which runs for an ADMIN", async () => {
    // resolveWorkshopNames builds its headers once and reuses them across the fan-out, so the
    // property has to hold there too — and this is the path an ADMIN reaches, where the ids come
    // from a store result rather than from the caller.
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["w1", "w2"],
      "a1",
      "ADMIN",
      contextWith({
        authorization: `Bearer ${CALLER_BEARER}`,
        [IDENTITY_HEADERS.role]: "SUPERADMIN",
        [IDENTITY_HEADERS.id]: "someone-else",
      })
    );

    for (let call = 0; call < 2; call++) {
      expect(headersOf(spy, call)).toEqual({ authorization: `Bearer ${CALLER_BEARER}` });
    }
  });

  it("the FALLBACK identity is the CALLER's resolved id and role, never an inbound header", async () => {
    // With NO token there is nothing to re-present, so the client falls back to
    // internalIdentityHeaders(caller). The identity it sends must be the arguments the ROUTE passed
    // — which come from `requireIdentity(c)`, i.e. the middleware's verified claims — and never the
    // inbound x-identity-* headers, which are attacker-controlled.
    //
    // The inbound headers here name an ADMIN; the forwarded ones must name the FACILITATOR the
    // route resolved. That difference is the whole test.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({
        [IDENTITY_HEADERS.id]: "attacker-chosen-sub",
        [IDENTITY_HEADERS.role]: "ADMIN",
      })
    );

    const sent = headersOf(spy);
    expect(sent[IDENTITY_HEADERS.id]).toBe("f1");
    expect(sent[IDENTITY_HEADERS.role]).toBe("FACILITATOR");
    // Not the attacker's values.
    expect(sent[IDENTITY_HEADERS.id]).not.toBe("attacker-chosen-sub");
    expect(sent[IDENTITY_HEADERS.role]).not.toBe("ADMIN");
  });

  it("the fallback carries NO internal token when INTERNAL_SERVICE_TOKEN is unset — so the callee 401s", async () => {
    // THE REASON THE FALLBACK IS NOT AN ESCALATION PATH IN THE DEPLOYED TOPOLOGY. x-identity-*
    // headers are honoured by edgeIdentityMiddleware ONLY alongside a matching shared secret, and
    // INTERNAL_SERVICE_TOKEN is unset on every deployed function — so the header path is inert and
    // the hop is simply 401'd by the gateway. Asserted at the header set: no secret is sent, so
    // nothing downstream can be persuaded to trust the identity claim.
    expect(process.env.INTERNAL_SERVICE_TOKEN).toBeUndefined();
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops("f1", "FACILITATOR", contextWith({}));

    expect(headersOf(spy)[INTERNAL_TOKEN_HEADER]).toBeUndefined();
  });

  it("when INTERNAL_SERVICE_TOKEN IS set, the secret comes from the ENVIRONMENT and not the request", async () => {
    // The local/EKS configuration. The secret must be the process's own, so an attacker who guesses
    // (or spams) a value on the inbound request cannot have it echoed onward — that would turn a
    // guess into a confirmed secret via the callee's response.
    process.env.INTERNAL_SERVICE_TOKEN = "the-real-secret";
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ [INTERNAL_TOKEN_HEADER]: "attacker-guessed-value" })
    );

    const sent = headersOf(spy);
    expect(sent[INTERNAL_TOKEN_HEADER]).toBe("the-real-secret");
    expect(sent[INTERNAL_TOKEN_HEADER]).not.toBe("attacker-guessed-value");
  });

  it("a NON-Bearer authorization header falls through to the fallback rather than being forwarded", async () => {
    // `callerBearerToken` requires the "Bearer " prefix, so a Basic or bare-token header is not
    // re-presented. The important half is that it does not forward the raw value — which for a
    // Basic header would leak a credential to another service.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ authorization: "Basic dXNlcjpwYXNzd29yZA==" })
    );

    const sent = headersOf(spy);
    expect(sent.authorization).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("dXNlcjpwYXNzd29yZA==");
    // It fell back to the caller's resolved identity instead.
    expect(sent[IDENTITY_HEADERS.id]).toBe("f1");
  });

  it("an EMPTY Bearer token is treated as absent, not forwarded as `Bearer `", async () => {
    // `callerBearerToken` trims and returns undefined for an empty value, so a stripped
    // Authorization header cannot produce a malformed hop the callee might mis-parse.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ authorization: "Bearer    " })
    );

    const sent = headersOf(spy);
    expect(sent.authorization).toBeUndefined();
    expect(sent[IDENTITY_HEADERS.id]).toBe("f1");
  });

  it("does NOT send the caller's EMAIL on the scope hop — data minimisation on the fallback", async () => {
    // The route passes only `{ id, role }`, so no address crosses the boundary. Asserted because
    // `internalIdentityHeaders` WILL send x-identity-email when given one, and email is the only PII
    // in this projection.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ [IDENTITY_HEADERS.email]: "victim@example.com" })
    );

    expect(headersOf(spy)[IDENTITY_HEADERS.email]).toBeUndefined();
  });
});

// ─── 2. TIMEOUT BOUNDS ON EVERY PATH ────────────────────────────────────────────────

describe("ATTACK: is every east-west path timeout-bounded?", () => {
  it("the SCOPE hop carries an AbortSignal and reports 'unavailable' on abort", async () => {
    // A slow Workshop service must not pin this Lambda for the 29s gateway timeout — that is how one
    // slow dependency fills another service's concurrency. And an abort must land as "unavailable"
    // (a 503 at the route), never as a determined empty scope.
    const spy = stubFetch(
      () =>
        new Promise<Response>((_, reject) => {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          setTimeout(() => reject(err), 0);
        })
    );

    const owned = await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
    );

    expect(owned).toBe("unavailable");
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(EAST_WEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("EVERY name lookup in the fan-out carries its own AbortSignal", async () => {
    // The DISPLAY path, which the threat model calls out specifically ("verify EAST_WEST_TIMEOUT_MS
    // is actually applied on every path, INCLUDING the name resolution"). Each of the 25 possible
    // concurrent probes needs its own signal — a single shared one, or one missing signal, means an
    // unbounded wait on the directory an operator opened during an incident.
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    const ids = Array.from({ length: 25 }, (_, i) => `w${i}`);
    await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ids,
      "a1",
      "ADMIN",
      contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
    );

    expect(spy.mock.calls).toHaveLength(25);
    const signals = spy.mock.calls.map((c) => (c[1] as RequestInit).signal);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
    // Distinct signals, so one lookup's timeout cannot abort the others.
    expect(new Set(signals).size).toBe(25);
  });

  it("a SLOW-BUT-SUCCEEDING name lookup degrades to a missing name, never a failed page", async () => {
    // The dangerous failure mode: not an error, just late. The name is absent from the map, the row
    // carries workshopName: null, and the directory still lists the teams.
    stubFetch(async (url) => {
      if (url.endsWith("/w2")) {
        const err = new Error("aborted");
        err.name = "TimeoutError";
        throw err;
      }
      return json({ workshop: { name: "Resolved One" } });
    });

    const names = await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["w1", "w2"],
      "a1",
      "ADMIN",
      contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
    );

    expect(names).toEqual({ w1: "Resolved One" });
  });

  it("a 403 on a name lookup is INDISTINGUISHABLE from a 404 — an absent name is not an access signal", async () => {
    // authz.ts states this as a contract: ids that fail for ANY reason are absent, and callers
    // "MUST NOT treat an absent name as an authorization signal". If 403 and 404 produced different
    // results, the name map would be an existence oracle for workshops the caller cannot see.
    const byStatus = async (status: number) => {
      stubFetch(() => json({ error: "nope" }, status));
      return new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
        ["w1"],
        "a1",
        "ADMIN",
        contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
      );
    };

    expect(await byStatus(403)).toEqual({});
    expect(await byStatus(404)).toEqual({});
    expect(await byStatus(500)).toEqual({});
  });

  it("a name lookup returning a HOSTILE body yields no name rather than a coerced one", async () => {
    // The body is another service's output and is not trusted: only a non-empty STRING name is
    // accepted. A number, an object or a null must be dropped, so nothing renders `[object Object]`
    // as a workshop name and nothing type-confuses downstream.
    for (const workshop of [
      { name: 12345 },
      { name: null },
      { name: {} },
      { name: [] },
      { name: "" },
      {},
    ]) {
      stubFetch(() => json({ workshop }));

      const names = await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
        ["w1"],
        "a1",
        "ADMIN",
        contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
      );

      expect(names, JSON.stringify(workshop)).toEqual({});
    }
  });

  it("the workshop id is URL-ENCODED into the path, so it cannot traverse or add segments", async () => {
    // The ids come from a store result, but the property is worth pinning: an unencoded id
    // containing "../" or a "?" would change which ROUTE the callee matched, turning a name lookup
    // into an arbitrary GET against the Workshop service.
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["../../v1/admin/users", "w1?withCounts=1", "w1/teams"],
      "a1",
      "ADMIN",
      contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
    );

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe(`${BASE}/workshops/..%2F..%2Fv1%2Fadmin%2Fusers`);
    expect(urls[1]).toBe(`${BASE}/workshops/w1%3FwithCounts%3D1`);
    expect(urls[2]).toBe(`${BASE}/workshops/w1%2Fteams`);
    // No call escaped the /workshops/ prefix.
    expect(urls.every((u) => u.startsWith(`${BASE}/workshops/`))).toBe(true);
  });

  it("a scope response with a HOSTILE workshops array drops bad rows and keeps the good ones", async () => {
    // The scope is an AUTHORIZATION input, so its shape matters more than the names'. A row with no
    // usable id must be DROPPED (not coerced to "" and used as an IN operand that could match
    // something), while the well-formed answer still stands rather than 503-ing a facilitator out of
    // their own directory.
    stubFetch(() =>
      json({
        workshops: [
          { id: "w1", name: "Good" },
          { id: 12345, name: "numeric id" },
          { id: null },
          null,
          "a string",
          { name: "no id at all" },
          { id: "", name: "empty id" },
          { id: "w2" },
        ],
      })
    );

    const owned = await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      contextWith({ authorization: `Bearer ${CALLER_BEARER}` })
    );

    expect(owned).toEqual([
      { id: "w1", name: "Good" },
      // A missing NAME is tolerated (it is display); a missing ID is not.
      { id: "w2", name: "" },
    ]);
    // Critically: no empty-string id survived into the authorization scope.
    expect((owned as Array<{ id: string }>).some((w) => w.id === "")).toBe(false);
  });
});
