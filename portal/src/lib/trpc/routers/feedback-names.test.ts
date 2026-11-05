// ── ⚠ NAMES ON A REPORT ARE A NICETY, AND A NICETY MUST NOT BE ABLE TO BREAK THE INBOX ──────
//
// Feedback reports show experience and team NAMES rather than raw ULIDs.
//
// The feature is one lookup and a map. What needs testing is everything around it:
//
//   · a failed lookup leaves the name null and the inbox INTACT, the same distinction applied to a
//     label: "could not resolve" is not "does not exist", and neither is a reason to refuse somebody the bug
//     reports. An inbox that 500s because an experience lookup was throttled is a worse outage than the one
//     it exists to diagnose;
//   · the fan-out is BOUNDED, per distinct experience rather than per report;
//   · the name is never quietly the id, because a `workshopName` holding a ULID ends up in a sentence
//     reading "reported in 01KZVC9…";
//   · an experience the caller MAY NOT SEE resolves to null, not to a leaked name. That is not enforced here
//, it is enforced by calling GET /v1/workshops/:id with the caller's own token, whose gate admits
//     ADMIN → owner → member, so what is asserted is that the token is passed and nothing else is consulted.
//     In practice an ADMIN gets the name, a non-owning FACILITATOR gets 403 and therefore the id.
//
// The router is exercised through a mocked `backendFetch`: this is a test about which requests are made and
// what happens when they fail, so the transport is exactly the thing to control.

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ⚠ `vi.hoisted`, AND THE SPY IS PASSED DIRECTLY. The obvious form -
 * `vi.mock("@/lib/backend", () => ({ backendFetch: (...a) => spy(...a) }))`, silently forwarded NO arguments,
 * so every assertion here failed on an undefined path and looked like a bug in the resolver. `vi.mock` is
 * hoisted above this file's own bindings, so the factory has to close over something hoisted with it.
 */
const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({ backendFetch }));
// ⚠ THE ALIAS PATH, NOT "../trpc". A relative specifier here does not intercept the one the router uses,
// even though both resolve to the same file, the router then imports the REAL procedure builder and this
// suite fails in ways that look like a bug in the code under test rather than in its own wiring.
vi.mock("@/lib/trpc/trpc", () => ({
  router: (routes: Record<string, unknown>) => routes,
  // The procedure builder, reduced to what these tests need: capture the resolver and call it directly.
  protectedProcedure: {
    input() {
      return this;
    },
    query(fn: unknown) {
      return { _call: fn };
    },
    mutation(fn: unknown) {
      return { _call: fn };
    },
  },
}));

const { feedbackRouter } = await import("@/lib/trpc/routers/feedback");

type Resolver = (opts: { ctx: { token: string }; input?: unknown }) => Promise<{
  items: Array<{ workshopId: string | null; teamId: string | null; workshopName?: string | null; teamName?: string | null }>;
  unreadCount: number;
}>;
const list = (feedbackRouter as unknown as { list: { _call: Resolver } }).list._call;

const report = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  kind: "BUG",
  status: "NEW",
  subject: "a subject of five words",
  message: "a description",
  workshopId: "w1",
  teamId: "t1",
  ...over,
});

/** Routes the three URLs this resolver can reach; anything else is an unexpected request. */
const wire = (opts: {
  reports?: unknown[];
  /** id -> name, or "fail" for a workshop whose by-id lookup throws. */
  workshops?: Record<string, string | "fail">;
  teams?: Record<string, unknown[] | "fail">;
}) => {
  backendFetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/admin/feedback")) {
      return { items: opts.reports ?? [report()], unreadCount: 1 };
    }
    const teamsMatch = /^\/v1\/workshops\/([^/]+)\/teams$/.exec(path);
    if (teamsMatch) {
      const teams = opts.teams?.[decodeURIComponent(teamsMatch[1])];
      if (teams === "fail") throw new Error("unavailable");
      return { teams: teams ?? [{ id: "t1", name: "Falcon" }] };
    }
    /**
     * ⚠ BY ID, WHICH IS THE ROUTE THE RESOLVER ACTUALLY USES. The first version of both the resolver and this
     * fake used `GET /v1/workshops`, and a live probe showed that route returns ZERO rows for an ADMIN, it is
     * `listByOwner` for staff. The fake happily agreed with the wrong assumption, which is precisely what a
     * fake cannot be trusted for.
     */
    const byId = /^\/v1\/workshops\/([^/]+)$/.exec(path);
    if (byId) {
      const id = decodeURIComponent(byId[1]);
      const name = opts.workshops ? opts.workshops[id] : "Innovation Sprint";
      // 403 for an experience this caller may not read, a real response, not an exception.
      if (name === "fail") throw new Error("forbidden");
      return name ? { workshop: { id, name } } : {};
    }
    throw new Error(`unexpected request: ${path}`);
  });
};

const paths = () => backendFetch.mock.calls.map((c) => c[0] as string);

/**
 * ⚠ A BLOCK BODY, NOT `() => backendFetch.mockReset()`. `mockReset()` RETURNS THE MOCK, an arrow with an
 * expression body returns it, and Vitest treats a function returned from `beforeEach` as a TEARDOWN HOOK -
 * so the runner called the spy itself with zero arguments after every test. The implementation then threw on
 * `path.startsWith` inside cleanup, and all ten tests failed pointing at the mock rather than at this line.
 */
beforeEach(() => {
  backendFetch.mockReset();
});

describe("resolving names for the inbox", () => {
  it("attaches the experience and team names", async () => {
    wire({});
    const out = await list({ ctx: { token: "tok" } });
    expect(out.items[0]).toMatchObject({ workshopName: "Innovation Sprint", teamName: "Falcon" });
    // The ids are still there, the card needs them for its `title`, and a triager needs them to search.
    expect(out.items[0]).toMatchObject({ workshopId: "w1", teamId: "t1" });
  });

  it("⚠ passes the CALLER'S token to the lookups", async () => {
    /**
     * This is the whole authorization story. /v1/workshops returns only what this caller may read, so a
     * facilitator gets names for their own experiences and nulls elsewhere, with no role logic here at all.
     * A service token, or no token, would turn a label into a disclosure.
     */
    wire({});
    await list({ ctx: { token: "caller-token" } });
    for (const call of backendFetch.mock.calls) {
      expect((call[1] as { token?: string })?.token, call[0] as string).toBe("caller-token");
    }
  });

  it("⚠ still serves the reports when the experience lookup FAILS", async () => {
    // The failure mode that matters: a throttle on a name lookup must not cost anybody the inbox.
    wire({ workshops: { w1: "fail" } });
    const out = await list({ ctx: { token: "tok" } });
    expect(out.items).toHaveLength(1);
    expect(out.unreadCount).toBe(1);
    expect(out.items[0].workshopName).toBeNull();
    // And the id survives, so the card has something to show.
    expect(out.items[0].workshopId).toBe("w1");
  });

  it("⚠ still serves the reports when a TEAM lookup fails", async () => {
    wire({ teams: { w1: "fail" } });
    const out = await list({ ctx: { token: "tok" } });
    expect(out.items[0]).toMatchObject({ workshopName: "Innovation Sprint", teamName: null });
  });

  it("⚠ resolves to NULL rather than to the id", async () => {
    /**
     * A name field holding a ULID is worse than an absent one: the component can no longer tell whether it
     * has a name, so it cannot choose the mono treatment, and the id leaks into prose as if it were a title.
     */
    wire({ workshops: {}, teams: { w1: [] } });
    const out = await list({ ctx: { token: "tok" } });
    expect(out.items[0].workshopName).toBeNull();
    expect(out.items[0].teamName).toBeNull();
  });

  it("⚠ costs TWO requests for fifty reports from one experience", async () => {
    // Per distinct experience, not per report. The naive version is an N+1 that grows with the inbox.
    wire({ reports: Array.from({ length: 50 }, (_, i) => report({ id: `f${i}` })) });
    const out = await list({ ctx: { token: "tok" } });
    expect(out.items).toHaveLength(50);
    expect(paths().filter((p) => p.startsWith("/v1/workshops")).sort()).toEqual([
      "/v1/workshops/w1",
      "/v1/workshops/w1/teams",
    ]);
  });

  it("⚠ CAPS the team lookups, and shows ids for the rest instead of fanning out", async () => {
    const many = Array.from({ length: 20 }, (_, i) => report({ id: `f${i}`, workshopId: `w${i}`, teamId: null }));
    wire({
      reports: many,
      workshops: Object.fromEntries(many.map((r) => [r.workshopId as string, `Experience ${r.workshopId}`])),
    });
    const out = await list({ ctx: { token: "tok" } });

    expect(paths().filter((p) => /\/teams$/.test(p)).length, "bounded fan-out").toBeLessThanOrEqual(8);
    /**
     * ⚠ AND THE EXCESS IS VISIBLE AS IDS, NOT AS A SILENT TRUNCATION. Exactly the first 8 experiences get
     * names; the other 12 keep their ULIDs, which is what tells an operator a name was not fetched. A cap
     * that quietly produced blanks would read as "this report came from nowhere".
     */
    const named = out.items.filter((r) => r.workshopName).length;
    expect(named).toBe(8);
    expect(out.items.filter((r) => !r.workshopName).every((r) => r.workshopId)).toBe(true);
  });

  it("makes NO lookups at all for an empty inbox", async () => {
    // The commonest case. A page load that costs three requests to name nothing is waste on every visit.
    wire({ reports: [] });
    await list({ ctx: { token: "tok" } });
    expect(paths().filter((p) => p.startsWith("/v1/workshops"))).toEqual([]);
  });

  it("makes no lookups when a report carries no ids", async () => {
    wire({ reports: [report({ workshopId: null, teamId: null })] });
    const out = await list({ ctx: { token: "tok" } });
    expect(paths().filter((p) => p.startsWith("/v1/workshops"))).toEqual([]);
    /**
     * ⚠ ABSENT *OR* NULL, and asserted that way deliberately rather than pinned to `null`. There is nothing
     * to resolve, so the resolver returns the reports untouched and does no work, which leaves these fields
     * undefined rather than null. The guarantee that matters is that a name is never INVENTED; which flavour
     * of empty it is cannot reach the card, because the whole line is behind `workshopId || teamId`.
     */
    expect(out.items[0].workshopName ?? null).toBeNull();
    expect(out.items[0].teamName ?? null).toBeNull();
  });

  it("encodes the id in the path rather than interpolating it raw", async () => {
    // Ids are ULIDs today. They arrive from a stored row, and a path built by concatenation is how a stored
    // value becomes a request to somewhere else.
    wire({ reports: [report({ workshopId: "w/../etc", teamId: "t1" })], workshops: {}, teams: {} });
    await list({ ctx: { token: "tok" } });
    expect(paths()).toContain("/v1/workshops/w%2F..%2Fetc/teams");
    expect(paths()).toContain("/v1/workshops/w%2F..%2Fetc");
  });
});
