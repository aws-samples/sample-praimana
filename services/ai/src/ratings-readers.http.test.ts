import { describe, it, expect, vi, afterEach } from "vitest";
import {
  HttpTeamChatReader,
  HttpTeamCountersReader,
  HttpTeamWorkshopLookup,
  RATINGS_READ_TIMEOUT_MS,
} from "./ratings-readers.http.js";
import { IDENTITY_HEADERS, EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";

/**
 * THE READERS THAT FEED A MODEL — and the one distinction they exist to preserve.
 *
 * `"unavailable"` ≠ `[]`. Every test below is ultimately about that. A timeout reading a
 * team's activity must not become "this team did nothing", because the route would then
 * generate, store and offer for publication a confident assessment of people whose work it
 * never managed to read. The sibling HttpTeamAccess reads every failure as "denied", which is
 * right for an authorization probe and wrong here — same technique, inverted failure mode.
 *
 * The fetch is stubbed rather than a server started: what is under test is how a RESPONSE is
 * classified, and a real socket adds nothing to that while making the timeout cases slow.
 */

const AUTH = {
  req: {
    header: (name: string) =>
      name.toLowerCase() === "authorization"
        ? "Bearer token-abc"
        : name === IDENTITY_HEADERS.id
          ? "alice"
          : undefined,
  },
} as unknown as Parameters<HttpTeamChatReader["recentByTeam"]>[2];

/** Replies with one canned response, and records what was requested. */
function stubFetch(reply: Partial<Response> | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: reply.json ?? (async () => ({})),
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

afterEach(() => vi.unstubAllGlobals());

describe("counters — the input a model turns into a statement about a person", () => {
  it("returns the rows on a well-formed 200", async () => {
    stubFetch(
      json({
        contributions: [
          {
            userId: "alice",
            name: "Alice Smith",
            tasksCreated: 4,
            tasksCompleted: 12,
            messagesSent: 88,
            commitsPushed: 21,
            aiThreadsShared: 3,
      aiTurns: 3,
            contributionScore: 91,
          },
        ],
      })
    );

    const rows = await new HttpTeamCountersReader().byTeam("team-1", AUTH);

    expect(rows).toEqual([
      {
        userId: "alice",
        tasksCreated: 4,
        tasksCompleted: 12,
        messagesSent: 88,
        commitsPushed: 21,
        aiThreadsShared: 3,
      aiTurns: 3,
      },
    ]);
  });

  it("DROPS name and contributionScore — neither may reach a prompt", async () => {
    // `name` is the one field that would let a publishable summary identify an individual;
    // `contributionScore` is evaluation's own weighting, and re-deriving a rating from it
    // would couple two formulas that change independently.
    stubFetch(
      json({ contributions: [{ userId: "alice", name: "Alice Smith", contributionScore: 91 }] })
    );

    const rows = await new HttpTeamCountersReader().byTeam("team-1", AUTH);

    const payload = JSON.stringify(rows);
    expect(payload).not.toContain("Alice");
    expect(payload).not.toContain("contributionScore");
  });

  for (const [label, reply] of [
    ["a timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["a connect error", new Error("ECONNREFUSED")],
    ["a 500", { ok: false, status: 500 }],
    ["a 403 — the hop is broken, not an answer", { ok: false, status: 403 }],
    ["a 404 — the route is unmapped mid-deploy", { ok: false, status: 404 }],
    ["non-JSON", { ok: true, status: 200, json: async () => { throw new Error("not json"); } }],
    ["a 200 with an unrecognised body", json({ error: "nope" })],
    ["a 200 whose contributions is not an array", json({ contributions: "many" })],
  ] as const) {
    it(`is UNAVAILABLE, not empty, on ${label}`, async () => {
      // Each of these read as `[]` would produce NO_ACTIVITY or a fabricated assessment.
      stubFetch(reply as Partial<Response> | Error);
      expect(await new HttpTeamCountersReader().byTeam("team-1", AUTH)).toBe("unavailable");
    });
  }

  it("distinguishes a GENUINELY empty team from a failure", async () => {
    // The other half of the same distinction: a 200 with an empty array is a DETERMINED
    // answer, and the route turns it into 409 NO_ACTIVITY rather than 503.
    stubFetch(json({ contributions: [] }));
    expect(await new HttpTeamCountersReader().byTeam("team-1", AUTH)).toEqual([]);
  });

  it("is UNAVAILABLE with no request context — we did not ask, so we do not know", async () => {
    const calls = stubFetch(json({ contributions: [] }));
    expect(await new HttpTeamCountersReader().byTeam("team-1", undefined)).toBe("unavailable");
    expect(calls, "must not attempt a tokenless call the gateway would 401").toHaveLength(0);
  });

  it("coerces a corrupt counter to 0 rather than NaN", async () => {
    // NaN serialises to `null` in JSON and would reach the prompt as a missing field; a
    // negative would drag the team's totals down.
    stubFetch(
      json({ contributions: [{ userId: "alice", tasksCreated: "x", messagesSent: -5 }] })
    );

    const rows = (await new HttpTeamCountersReader().byTeam("team-1", AUTH)) as Array<
      { userId: string } & Record<"tasksCreated" | "messagesSent", number>
    >;

    expect(rows[0].tasksCreated).toBe(0);
    expect(rows[0].messagesSent).toBe(0);
    expect(JSON.stringify(rows)).not.toContain("null");
  });

  it("skips a row with no userId rather than attributing it to \"\"", async () => {
    // An unattributable row bucketed under "" renders as a phantom member with no counters.
    stubFetch(json({ contributions: [{ tasksCreated: 9 }, { userId: "alice" }] }));
    const rows = (await new HttpTeamCountersReader().byTeam("team-1", AUTH)) as unknown[];
    expect(rows).toHaveLength(1);
  });
});

describe("team chat — bounded, and forwarded as the caller", () => {
  it("passes the limit to the far end and re-presents the caller's token", async () => {
    // The limit travels so the callee bounds its own Query; the token travels because the
    // upstream route is member-only and re-derives identity from verified claims.
    const calls = stubFetch(json({ messages: [] }));

    await new HttpTeamChatReader().recentByTeam("team-1", 400, AUTH);

    expect(calls[0].url).toContain("/teams/team-1/messages?limit=400");
    expect(calls[0].init.signal, "every external call is bounded in time").toBeTruthy();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBe("Bearer token-abc");
  });

  it("encodes the teamId", async () => {
    const calls = stubFetch(json({ messages: [] }));
    await new HttpTeamChatReader().recentByTeam("a/../b", 10, AUTH);
    expect(calls[0].url).toContain("a%2F..%2Fb");
    expect(calls[0].url).not.toContain("a/../b");
  });

  it("keeps userId and content, and nothing else", async () => {
    stubFetch(
      json({
        messages: [
          { userId: "alice", content: "I'll take auth", userName: "Alice Smith", id: "m1" },
        ],
      })
    );

    const rows = await new HttpTeamChatReader().recentByTeam("team-1", 10, AUTH);

    expect(rows).toEqual([{ userId: "alice", content: "I'll take auth" }]);
    expect(JSON.stringify(rows)).not.toContain("Alice Smith");
  });

  it("drops a message that cannot be attributed", async () => {
    stubFetch(json({ messages: [{ content: "orphan" }, { userId: "a", content: "" }] }));
    expect(await new HttpTeamChatReader().recentByTeam("team-1", 10, AUTH)).toEqual([]);
  });

  it("is UNAVAILABLE, not empty, when the read fails", async () => {
    stubFetch({ ok: false, status: 503 });
    expect(await new HttpTeamChatReader().recentByTeam("team-1", 10, AUTH)).toBe("unavailable");
  });
});

describe("workshop lookup — two-valued, and null is the SAFE collapse", () => {
  it("returns the id the Team service reports", async () => {
    const calls = stubFetch(json({ canReadContent: true, workshopId: "ws-1" }));

    const id = await new HttpTeamWorkshopLookup().workshopIdForTeam("team-1", AUTH);

    expect(id).toBe("ws-1");
    // Piggybacks on the existing access route rather than adding an endpoint.
    expect(calls[0].url).toContain("/teams/team-1/access?withWorkshop=1");
  });

  it("returns null on a failure — which DENIES judges rather than admitting them", async () => {
    // The asymmetry with the counters above is deliberate. Here a collapse to null makes a
    // published summary unreadable to a judge (safe); there a collapse to [] would invent an
    // assessment (unsafe). Same failure, opposite direction, so opposite choice.
    stubFetch({ ok: false, status: 500 });
    expect(await new HttpTeamWorkshopLookup().workshopIdForTeam("team-1", AUTH)).toBeNull();
  });

  it("returns null when the team has no workshop", async () => {
    stubFetch(json({ canReadContent: true, workshopId: null }));
    expect(await new HttpTeamWorkshopLookup().workshopIdForTeam("team-1", AUTH)).toBeNull();
  });

  it("rejects a non-string workshopId rather than storing it", async () => {
    // A stored non-string would later be compared against an entitlement list and never
    // match, which is a silent denial rather than a visible fault.
    stubFetch(json({ workshopId: { id: "ws-1" } }));
    expect(await new HttpTeamWorkshopLookup().workshopIdForTeam("team-1", AUTH)).toBeNull();
  });
});

describe("the nested-call timeout is LARGER than the hop it contains", () => {
  /**
   * THE FAILURE THIS PINS. `analyze` answered 503 TEAM_ACTIVITY_UNAVAILABLE for a team whose
   * counters were sitting right there:
   *
   *   [ratings] team counters FAILED — undetermined, not empty
   *   { elapsedMs: 2503, timeoutMs: 2500, timedOut: true }
   *
   * Cause: these reads are NESTED. `GET /teams/:id/ratings` is member-gated, so the evaluation
   * service makes its OWN authz hop back into team before it answers. Both budgets were
   * EAST_WEST_TIMEOUT_MS (2,500ms), so the inner hop could consume the entire outer one — and on
   * a cold start it did. Measured: the evaluation function took 1,721ms plus 378ms init.
   *
   * The read was refused by OUR clock, not by anything upstream. A nested call needs a bigger
   * budget than the call it contains, and that is what this asserts.
   */
  it("gives the outer read strictly MORE time than a plain east-west hop", async () => {
    const calls = stubFetch(json({ contributions: [] }));

    await new HttpTeamCountersReader().byTeam("team-1", AUTH);

    const signal = calls[0].init.signal as AbortSignal & { _t?: number };
    expect(signal, "every external call is bounded").toBeTruthy();
    // Asserted through the module's own constant rather than a magic number, so the rule
    // ("bigger than the inner hop") survives a change to the base value.
    expect(RATINGS_READ_TIMEOUT_MS).toBeGreaterThan(EAST_WEST_TIMEOUT_MS);
    // And by a real margin — the callee's own work plus a cold start, not a token bump. The
    // observed overrun was only 3ms past the old budget, so a +10% nudge would have "fixed"
    // this run and failed the next one.
    expect(RATINGS_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(EAST_WEST_TIMEOUT_MS * 2);
    // Measured cold start was ~2.1s; the budget must clear it with room for the inner hop too.
    expect(RATINGS_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });

  it("stays BOUNDED, and well inside the generation's own deadline", async () => {
    // A slow dependency must be OUR abort with a retryable 503, never the platform killing the
    // function with an opaque 502. RATING_TOTAL_TIMEOUT_MS is 45s and the function timeout 60s,
    // so three of these reads plus the model calls still has to fit.
    expect(RATINGS_READ_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
