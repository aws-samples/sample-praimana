import { describe, it, expect, afterEach, vi } from "vitest";
import { EAST_WEST_TIMEOUT_MS } from "@praimana/service-shared";
import { HttpWorkshopDirectory } from "./workshop-directory.http.js";
import type { AuthContext } from "./authz.js";

/**
 * HttpWorkshopDirectory answers the two Workshop-context questions the TEAMS DIRECTORY needs,
 * and the tests below exist because the two have DELIBERATELY OPPOSITE failure semantics — which
 * is exactly the kind of asymmetry that gets "simplified" into one shared helper.
 *
 *   listOwnedWorkshops    AUTHORIZATION. It is the FACILITATOR's directory SCOPE, so every
 *                         failure is "unavailable" and the route 503s. Returning an empty array
 *                         instead would render an empty directory that is indistinguishable
 *                         from a correct one — the defect the fail-closed rule was written to prevent.
 *   resolveWorkshopNames  DISPLAY. Best-effort, never throws, and an id it cannot resolve is
 *                         simply absent. It must never take out the directory an operator
 *                         opened during an incident.
 *
 * Both are also BOUNDED IN TIME. A caller pinned for the full 29s gateway timeout while a
 * dependency answers slowly is how one slow service fills another's concurrency.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) => impl(String(url), init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The inbound request's Context, reduced to the one header this client reads. */
const BEARER = "header.payload.signature";
function withBearer(): AuthContext {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "authorization" ? `Bearer ${BEARER}` : undefined,
    },
  } as unknown as AuthContext;
}

const BASE = "http://workshop.test/v1";

// ─── listOwnedWorkshops — the authorization SCOPE ─────────────────────────────

describe("HttpWorkshopDirectory.listOwnedWorkshops", () => {
  it("asks the Workshop service's own list route and returns id + name", async () => {
    // The name comes back with the scope so a FACILITATOR's directory page makes ONE
    // east-west call rather than one plus a name fan-out.
    const spy = stubFetch(() =>
      json({ workshops: [{ id: "w1", name: "Workshop One" }, { id: "w2", name: "Two" }] })
    );

    const owned = await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
      "f1",
      "FACILITATOR",
      withBearer()
    );

    expect(owned).toEqual([
      { id: "w1", name: "Workshop One" },
      { id: "w2", name: "Two" },
    ]);
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/workshops`);
  });

  it("re-presents the caller's own bearer token", async () => {
    // WORKSHOP_SERVICE_URL is the public API, where every route sits behind the Cognito JWT
    // authorizer — a tokenless hop is 401'd before Workshop's Lambda runs.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops("f1", "FACILITATOR", withBearer());

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
  });

  it("sends NO userId or role QUERY PARAMETER — the callee keys on verified claims", async () => {
    // A scope probe that takes a subject is an enumeration oracle for "who owns which
    // workshop". The identity travels in the token, never in the URL.
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops("f1", "FACILITATOR", withBearer());

    const url = String(spy.mock.calls[0][0]);
    expect(url).not.toContain("?");
    expect(url).not.toContain("f1");
  });

  it("bounds the call in time", async () => {
    const spy = stubFetch(() => json({ workshops: [] }));

    await new HttpWorkshopDirectory(BASE).listOwnedWorkshops("f1", "FACILITATOR", withBearer());

    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The shared budget, not a local number — one deadline, one home.
    expect(EAST_WEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("returns 'unavailable' — NEVER an empty scope — on a timeout or connect error", async () => {
    stubFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });

    expect(
      await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
        "f1",
        "FACILITATOR",
        withBearer()
      )
    ).toBe("unavailable");
  });

  it("returns 'unavailable' for EVERY non-2xx, including 404 and 403", async () => {
    // 404 is the one that would be tempting to read as "no workshops". It is not: during a
    // rolling deploy the route can be briefly unmapped, and an empty directory then looks
    // exactly like a correct one. A 403 is likewise a broken hop, not an answer — there is no
    // legitimate reading in which a facilitator's own owned list is forbidden to them.
    for (const status of [400, 401, 403, 404, 500, 502, 503]) {
      stubFetch(() => json({ error: "no" }, status));
      expect(
        await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
          "f1",
          "FACILITATOR",
          withBearer()
        ),
        String(status)
      ).toBe("unavailable");
    }
  });

  it("returns 'unavailable' for a 200 carrying an unrecognised body", async () => {
    // An error envelope or an HTML page from a misrouted gateway must not read as a determined
    // empty scope. The shape is PINNED rather than trusted.
    for (const body of [null, {}, { workshops: null }, { workshops: "none" }, "plain text"]) {
      stubFetch(() => json(body));
      expect(
        await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
          "f1",
          "FACILITATOR",
          withBearer()
        ),
        JSON.stringify(body)
      ).toBe("unavailable");
    }
  });

  it("returns 'unavailable' for a 200 whose body is not JSON at all", async () => {
    stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));

    expect(
      await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
        "f1",
        "FACILITATOR",
        withBearer()
      )
    ).toBe("unavailable");
  });

  it("returns a determined EMPTY scope for a well-formed empty list", async () => {
    // The ONE case that legitimately means "you own no workshops" — a 200 with []. The route
    // then shows an empty directory, which is the truth, and NOT a 503. Every other shape above
    // is "unavailable", so this is the boundary between the two.
    stubFetch(() => json({ workshops: [] }));

    expect(
      await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
        "f1",
        "FACILITATOR",
        withBearer()
      )
    ).toEqual([]);
  });

  it("DROPS a malformed row rather than making the whole scope undetermined", async () => {
    // The answer arrived and was well-shaped; one row without a usable id is not a reason to
    // 503 a facilitator out of their own directory. A missing name renders as unknown.
    stubFetch(() =>
      json({
        workshops: [
          { id: "w1", name: "Workshop One" },
          { id: "", name: "no id" },
          { name: "also no id" },
          null,
          "nonsense",
          { id: "w2" },
        ],
      })
    );

    expect(
      await new HttpWorkshopDirectory(BASE).listOwnedWorkshops(
        "f1",
        "FACILITATOR",
        withBearer()
      )
    ).toEqual([
      { id: "w1", name: "Workshop One" },
      { id: "w2", name: "" },
    ]);
  });

  it("returns 'unavailable' with NO context to forward, rather than an empty scope", async () => {
    // No Context ⇒ no caller token to re-present, and the gateway would reject the call. We
    // did not ask, so we do not know.
    const spy = stubFetch(() => json({ workshops: [] }));

    expect(
      await new HttpWorkshopDirectory(BASE).listOwnedWorkshops("f1", "FACILITATOR")
    ).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── resolveWorkshopNames — display only ─────────────────────────────────────

describe("HttpWorkshopDirectory.resolveWorkshopNames", () => {
  it("resolves each id through the Workshop service's by-id route", async () => {
    const spy = stubFetch((url) =>
      json({ workshop: { name: url.endsWith("w1") ? "One" : "Two" } })
    );

    expect(
      await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
        ["w1", "w2"],
        "a1",
        "ADMIN",
        withBearer()
      )
    ).toEqual({ w1: "One", w2: "Two" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("url-encodes each id", async () => {
    // An id carrying a slash would otherwise change which route the gateway matched.
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["w 1/../x"],
      "a1",
      "ADMIN",
      withBearer()
    );

    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/workshops/w%201%2F..%2Fx`);
  });

  it("OMITS an id it cannot resolve, and NEVER throws", async () => {
    // Best-effort by contract: the row then carries workshopName: null, which the frozen
    // contract admits. A throw here would take out the whole directory over a column.
    for (const behaviour of [
      () => json({ error: "forbidden" }, 403),
      () => json({ error: "gone" }, 404),
      () => json({ error: "boom" }, 500),
      () => json({ workshop: {} }),
      () => json({ workshop: { name: "" } }),
      () => json(null),
      () => new Response("<html>", { status: 200 }),
      () => {
        throw new Error("connect ECONNREFUSED");
      },
    ]) {
      stubFetch(behaviour);
      await expect(
        new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
          ["w1"],
          "a1",
          "ADMIN",
          withBearer()
        )
      ).resolves.toEqual({});
    }
  });

  it("returns the names it COULD resolve when only some ids fail", async () => {
    // A partial map, not an empty one: one unreachable workshop must not blank the column for
    // every other row on the page.
    stubFetch((url) =>
      url.endsWith("w2") ? json({ error: "gone" }, 404) : json({ workshop: { name: "One" } })
    );

    expect(
      await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
        ["w1", "w2"],
        "a1",
        "ADMIN",
        withBearer()
      )
    ).toEqual({ w1: "One" });
  });

  it("makes no call at all for an empty id list", async () => {
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    expect(
      await new HttpWorkshopDirectory(BASE).resolveWorkshopNames([], "a1", "ADMIN", withBearer())
    ).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("bounds every lookup in time", async () => {
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["w1", "w2"],
      "a1",
      "ADMIN",
      withBearer()
    );

    for (const call of spy.mock.calls) {
      expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("re-presents the caller's token, and falls back to the CALLER's own identity", async () => {
    // The fallback identity is load-bearing on the internal-hop path: those headers ARE what
    // the callee authorizes on, so an empty id/role there would ask as a role-less caller and
    // be refused every name by requireWorkshopRead.
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["w1"],
      "a1",
      "ADMIN",
      withBearer()
    );

    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${BEARER}`);
  });

  it("returns an empty map with NO context to forward, rather than throwing", async () => {
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    expect(
      await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(["w1"], "a1", "ADMIN")
    ).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * ── ⚠ THE FAN-OUT'S OWN BOUND, WHICH USED TO BE SOMEBODY ELSE'S ────────────────────────────
   *
   * This method issues one `GET /v1/workshops/:id` per id, in parallel. Its bound was
   * `MAX_DIRECTORY_WORKSHOP_NAMES`, enforced by the unscoped ADMIN directory route that called it —
   * and scoping ADMIN to owned experiences deleted that call site, because an admin restricted to the workshops
   * they OWN gets every name back with the ownership scope in the same hop.
   *
   * That left the method with NO bound at all: "bounded by the caller" with no caller is an unbounded
   * east-west fan-out, and nothing here would have failed if a future caller handed it 500 ids. The cap
   * therefore moved INTO the method, and these are the tests that make it real — there were none
   * before, on either side of the move, so the bound was previously asserted only by a constant's
   * existence.
   */
  it("⚠ CAPS the fan-out at 25 distinct ids, rather than issuing one hop per id it is handed", async () => {
    const spy = stubFetch((url) => {
      const id = url.split("/").pop();
      return json({ workshop: { name: `Name ${id}` } });
    });

    // 100 distinct workshops — the pathological directory page the cap exists for.
    const ids = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const names = await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ids,
      "a1",
      "ADMIN",
      withBearer()
    );

    expect(spy.mock.calls).toHaveLength(25);
    // The rest are ABSENT, not empty strings — the row then renders `workshopName: null`, which the
    // frozen contract already admits for a name that could not be resolved.
    expect(Object.keys(names)).toHaveLength(25);
  });

  it("⚠ DEDUPLICATES BEFORE it slices, so a repeated id cannot crowd out a resolvable name", async () => {
    /**
     * The ordering is the whole test, and getting it backwards is silent: slicing first would spend
     * the 25-probe budget on 25 copies of one workshop and resolve exactly one name, while
     * deduplicating first spends it on 25 DISTINCT workshops. Two teams in one workshop is the
     * ordinary case that makes duplicates arrive here at all.
     */
    const spy = stubFetch((url) => {
      const id = url.split("/").pop();
      return json({ workshop: { name: `Name ${id}` } });
    });

    // 30 copies of "dup" first, then 5 distinct ids that only survive if dedup runs first.
    const ids = [...Array.from({ length: 30 }, () => "dup"), "a", "b", "c", "d", "e"];
    const names = await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ids,
      "a1",
      "ADMIN",
      withBearer()
    );

    // 6 distinct ids, all under the cap — so the cap never engages and every one resolves.
    expect(spy.mock.calls).toHaveLength(6);
    expect(names).toEqual({
      dup: "Name dup",
      a: "Name a",
      b: "Name b",
      c: "Name c",
      d: "Name d",
      e: "Name e",
    });
  });

  it("probes a workshop ONCE however many times its id repeats", async () => {
    const spy = stubFetch(() => json({ workshop: { name: "One" } }));

    const names = await new HttpWorkshopDirectory(BASE).resolveWorkshopNames(
      ["w1", "w1", "w1", "w1"],
      "a1",
      "ADMIN",
      withBearer()
    );

    expect(spy.mock.calls).toHaveLength(1);
    expect(names).toEqual({ w1: "One" });
  });
});
