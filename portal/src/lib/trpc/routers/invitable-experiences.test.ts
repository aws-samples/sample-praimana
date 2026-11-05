// ── ⚠ THE PICKER THAT DECIDES WHICH EXPERIENCES AN INVITATION MAY NAME ───────────────────────
//
// THE RULE: an admin can invite any user to any experience from the Administration tab, as a
// facilitator does, but can never add themselves to an experience.
//
// The first half needs an ADMIN to be offered experiences they do NOT own, which `GET /v1/workshops`
// will never return (it answers an admin from `listByOwner`). So the workshop service grew
// `GET /v1/workshops/catalogue`, ADMIN only, id and name only, and this resolver asks that FIRST,
// falling back to the owned list when the service says the caller is not an admin.
//
// WHAT IS ACTUALLY AT RISK HERE IS THE FALLBACK CONDITION, which is why this file exists:
//
//   · falling back on ANY error would turn a Workshop brownout into a silently NARROWER picker.
//     That is the "empty list that looks correct" defect this platform has already shipped twice,
//     and on this screen it would read as "that experience does not exist" to an
//     operator who is looking straight at it;
//   · the fallback must fire on the ONE refusal that means "ask the other question", 403 with
//     `CATALOGUE_ADMIN_ONLY`, and on nothing else, including OTHER 403s;
//   · both branches must return the SAME SHAPE, so the form cannot come to depend on the aggregate
//     that `GET /v1/workshops` happens to carry.
//
// The router is exercised through a mocked `backendFetch` for the same reason feedback-names.test.ts
// does it: this is a test about which requests are made and what happens when they fail, so the
// transport is exactly the thing to control.

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ⚠ `vi.hoisted`, AND THE SPY IS PASSED DIRECTLY, the same trap feedback-names.test.ts records:
 * the obvious `vi.mock("@/lib/backend", () => ({ backendFetch: (...a) => spy(...a) }))` forwards no
 * arguments, so every assertion fails on an undefined path and it looks like a bug in the resolver.
 *
 * ⚠ `BackendError` IS THE REAL CLASS, not a stub. The resolver's fallback is an `instanceof` check,
 * so a mocked class would make the fallback unreachable and this whole file would pass while
 * testing nothing. It is re-exported from the mock so the resolver and the test agree on identity.
 */
const backendFetch = vi.hoisted(() => vi.fn());
const { BackendError } = await import("@/lib/backend");
vi.mock("@/lib/backend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend")>("@/lib/backend");
  return { backendFetch, BackendError: actual.BackendError };
});
// ⚠ THE ALIAS PATH, NOT "../trpc". A relative specifier does not intercept the one the router uses,
// even though both resolve to the same file.
vi.mock("@/lib/trpc/trpc", () => ({
  router: (routes: Record<string, unknown>) => routes,
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

const { adminRouter } = await import("@/lib/trpc/routers/admin");

type Result = {
  experiences: Array<{ id: string; name: string }>;
  truncated: boolean;
  scope: "all" | "owned";
  catalogueUnavailable: boolean;
};
type Resolver = (opts: { ctx: { token: string } }) => Promise<Result>;
const invitableExperiences = (
  adminRouter as unknown as { invitableExperiences: { _call: Resolver } }
).invitableExperiences._call;

const run = () => invitableExperiences({ ctx: { token: "t" } });

/**
 * ⚠ A BLOCK BODY, AND THE CONCISE FORM IS A TRAP THAT COST REAL TIME HERE.
 *
 * `beforeEach(() => backendFetch.mockReset())` RETURNS the mock, because `mockReset()` is
 * chainable, and Vitest treats a function returned from `beforeEach` as a TEARDOWN callback. So
 * after every test it CALLED the spy with no arguments. The symptoms pointed nowhere near the
 * cause: this file's own `mockImplementation` ran a second time with `path === undefined`, failing
 * as "unexpected request: undefined" (which reads as a bug in the resolver), and the rethrow cases
 * escaped as unhandled BackendErrors reported at the line where they were CONSTRUCTED.
 *
 * The braces discard the return value. Anything that returns a callable from a lifecycle hook is
 * registering teardown, whether it meant to or not.
 */
beforeEach(() => {
  backendFetch.mockReset();
});

describe("admin.invitableExperiences, an ADMIN", () => {
  it("asks the CATALOGUE and returns every experience, whoever owns it", async () => {
    backendFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/workshops/catalogue") {
        return {
          workshops: [
            { id: "w1", name: "Alpha Hack" },
            { id: "w2", name: "Beta Jam" },
          ],
          truncated: false,
        };
      }
      throw new Error(`unexpected request: ${path}`);
    });

    const res = await run();

    expect(res.experiences).toEqual([
      { id: "w1", name: "Alpha Hack" },
      { id: "w2", name: "Beta Jam" },
    ]);
    expect(res.scope).toBe("all");
    expect(res.catalogueUnavailable).toBe(false);
    // ONE request. The owned list is not also fetched, an admin who is offered everything has no
    // second question to ask, and a belt-and-braces extra hop on a picker is a hop on every render.
    expect(backendFetch).toHaveBeenCalledTimes(1);
    expect(backendFetch.mock.calls[0][0]).toBe("/v1/workshops/catalogue");
  });

  it("passes the TRUNCATION flag through rather than swallowing it", async () => {
    // A picker quietly missing the experience an operator is hunting for reads as "it does not
    // exist". The form renders a notice off this flag, so dropping it here would be a silent cap.
    backendFetch.mockResolvedValue({ workshops: [{ id: "w1", name: "One" }], truncated: true });

    expect((await run()).truncated).toBe(true);
  });

  it("survives a catalogue response with no workshops key at all", async () => {
    // Total over its input rather than trusting the envelope: a 200 with an unexpected body must
    // render an empty picker, not throw inside a page render.
    backendFetch.mockResolvedValue({});

    const res = await run();
    expect(res.experiences).toEqual([]);
    expect(res.truncated).toBe(false);
  });
});

describe("admin.invitableExperiences, a FACILITATOR falls back to their own", () => {
  it("asks the catalogue, is refused, then returns the OWNED list in the same shape", async () => {
    const calls: string[] = [];
    backendFetch.mockImplementation(async (path: string) => {
      calls.push(path);
      if (path === "/v1/workshops/catalogue") {
        throw new BackendError(403, "Forbidden", "CATALOGUE_ADMIN_ONLY");
      }
      // Deliberately carries MORE than the picker needs, the aggregate `GET /v1/workshops`
      // actually returns, so the narrowing below is proved rather than assumed.
      return {
        workshops: [
          { id: "w9", name: "Mine", status: "ACTIVE", maxTeamSize: 5, phases: [{ id: "p1" }] },
        ],
      };
    });

    const res = await run();

    expect(calls).toEqual(["/v1/workshops/catalogue", "/v1/workshops"]);
    expect(res.scope).toBe("owned");
    // ⚠ NARROWED TO id AND name, asserted with toEqual on the whole row. Both branches must return
    // the same shape or the form comes to depend on fields only one caller receives, and passing
    // the aggregate through would also hand the browser phases and setupConfig to fill two fields.
    expect(res.experiences).toEqual([{ id: "w9", name: "Mine" }]);
    expect(res.truncated).toBe(false);
    // ⚠ FALSE, and the distinction matters to the UI: a facilitator's owned list is their CORRECT
    // answer, not a degraded one. Only a 404, the route being absent from this backend, sets the
    // flag, and only then does the form tell an admin their list is short.
    expect(res.catalogueUnavailable).toBe(false);
  });
});

describe("admin.invitableExperiences, ⚠ A BACKEND WITHOUT THE CATALOGUE ROUTE", () => {
  /**
   * ⚠ THE DEPLOY WINDOW, AND WHY 404 IS TREATED DIFFERENTLY FROM EVERY OTHER FAILURE.
   *
   * `GET /v1/workshops/catalogue` is matched by the deployed gateway's `/v1/workshops/{workshopId}`
   * mapping, so against a workshop service that predates the catalogue the request reaches the
   * BY-ID handler, which looks up a workshop literally named "catalogue" and 404s.
   *
   * Without this branch the picker THREW for every staff role in that window, including
   * FACILITATORS, who are not part of this feature at all and could invite judges perfectly well
   * before it. The portal's publish pipeline triggers on `src/**` and the services have no pipeline
   * yet, so "portal ahead of services" is the EXPECTED state, not a rare race.
   *
   * ⚠ 404 IS ADMITTED AND 5xx IS NOT. A 404 on a mapped route is an unambiguous "no such handler
   * here"; a 500/503/timeout is "we could not tell", and answering that with a narrower list is the
   * defect. The rethrow cases below still cover that.
   */
  it("degrades to the OWNED list and FLAGS it, rather than throwing", async () => {
    const calls: string[] = [];
    backendFetch.mockImplementation(async (path: string) => {
      calls.push(path);
      if (path === "/v1/workshops/catalogue") {
        // What the OLD by-id handler actually answers for a workshop named "catalogue".
        throw new BackendError(404, "Workshop not found");
      }
      return { workshops: [{ id: "w9", name: "Mine" }] };
    });

    const res = await run();

    expect(calls).toEqual(["/v1/workshops/catalogue", "/v1/workshops"]);
    expect(res.experiences).toEqual([{ id: "w9", name: "Mine" }]);
    expect(res.scope).toBe("owned");
    // ⚠ FLAGGED, NOT SILENT. The form tells an admin the list is short, a silent degrade is the
    // same lie as a silent truncation: the experience they are hunting for looks deleted.
    expect(res.catalogueUnavailable).toBe(true);
  });

  it("degrades on a 404 WITH a code too, the status is what carries the meaning", async () => {
    backendFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/workshops/catalogue") {
        throw new BackendError(404, "Not found", "SOMETHING_ELSE");
      }
      return { workshops: [] };
    });

    const res = await run();
    expect(res.catalogueUnavailable).toBe(true);
    expect(res.experiences).toEqual([]);
  });
});

describe("admin.invitableExperiences, ⚠ WHAT MUST NOT FALL BACK", () => {
  /**
   * ⚠ THE WHOLE POINT OF THIS BLOCK. A fallback keyed on "the catalogue failed" instead of on "the
   * service said you are not an admin" would answer a Workshop outage with a NARROWER PICKER that
   * looks perfectly normal, an admin would be shown only their own experiences and conclude the
   * others had been deleted. Each case here must REACH THE CALLER as an error.
   */
  const mustRethrow: Array<[string, unknown]> = [
    ["a 503 from the catalogue", new BackendError(503, "Unavailable", "WORKSHOP_UNAVAILABLE")],
    ["a 500 with no code", new BackendError(500, "Backend error: 500")],
    ["a 504 gateway timeout", new BackendError(504, "Timed out")],
    // ⚠ A DIFFERENT 403 IS NOT THIS 403. Same status, different cause, an expired or malformed
    // token, say, and treating it as "not an admin" would hide a broken session behind a picker
    // that silently lists nothing.
    ["a 403 with a DIFFERENT code", new BackendError(403, "Forbidden", "TOKEN_REJECTED")],
    ["a 403 with NO code", new BackendError(403, "Forbidden")],
    // Not a BackendError at all, a transport fault or a bug. `instanceof` must not admit it.
    ["a plain Error", new Error("boom")],
  ];

  for (const [label, thrown] of mustRethrow) {
    it(`rethrows ${label} instead of quietly narrowing the picker`, async () => {
      const calls: string[] = [];
      backendFetch.mockImplementation(async (path: string) => {
        calls.push(path);
        throw thrown;
      });

      await expect(run()).rejects.toBe(thrown);
      // And it did NOT go on to ask the owned list, the failure is reported, not worked around.
      expect(calls).toEqual(["/v1/workshops/catalogue"]);
    });
  }

  it("does NOT swallow a failure of the FALLBACK either", async () => {
    // Once the catalogue has said "not an admin", the owned list is the only answer left. If that
    // fails too there is nothing to render and the operator must be told, not shown an empty menu.
    backendFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/workshops/catalogue") {
        throw new BackendError(403, "Forbidden", "CATALOGUE_ADMIN_ONLY");
      }
      throw new BackendError(503, "Unavailable", "WORKSHOP_UNAVAILABLE");
    });

    await expect(run()).rejects.toMatchObject({ status: 503 });
  });
});
