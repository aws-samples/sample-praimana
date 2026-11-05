import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The BFF procedure behind the CREATE-EXPERIENCE FORMAT DROPDOWN.
 *
 * WHY THIS FILE EXISTS. The dropdown was reported empty on the deployed site. Three
 * independent defects stacked up, and only the middle one lives in this layer:
 *
 *   1. The lookup table had NO ROWS at all (fixed by scripts/seed-formats.mjs).
 *   2. The page fetched the backend DIRECTLY from the browser via
 *      `NEXT_PUBLIC_BACKEND_URL`, an env var set NOWHERE in the repo, so it fell back
 *      to http://localhost:4000 and could never resolve for a real visitor. That call
 *      also carried no credentials, and the backend route calls requireIdentity.
 *   3. The failure was swallowed (`.catch(() => setFormats([]))`), so a broken fetch
 *      and "no formats configured" were INDISTINGUISHABLE, the form rendered a blank
 *      but operable-looking <select> instead of an error.
 *
 * What this asserts is not "does the backend return formats" (the workshop service's
 * own suite covers the route) but the things only this procedure can get wrong: the
 * path, the forwarded token, and the response-shape guarding that stops a malformed
 * payload reaching the component's `.map()`.
 */
const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({
  backendFetch,
  // Imported by trpc.ts for its error-mapping middleware. The real class is not needed
  // here, but the export must exist or the module fails to load.
  BackendError: class BackendError extends Error {
    status = 500;
  },
}));

import { workshopRouter } from "@/lib/trpc/routers/workshop";

/**
 * A caller with a SIGNED-IN context. `protectedProcedure` needs both `session.user.id`
 * and `accessToken`, and its auth middleware runs first, a context that is merely
 * close enough would make assertions pass or fail as UNAUTHORIZED rather than on the
 * behaviour under test.
 *
 * FACILITATOR deliberately, because that is the role in the bug report. The procedure
 * is not role-gated beyond being signed in, and it must stay that way: every role that
 * can reach the create form needs these options.
 */
function caller(role = "FACILITATOR") {
  return workshopRouter.createCaller({
    accessToken: "test-token",
    session: { user: { id: "sub-1", email: "u@example.com", role } },
  } as never);
}

beforeEach(() => {
  backendFetch.mockReset();
  backendFetch.mockResolvedValue({
    formats: [
      { name: "Accelerator", value: "ACCELERATOR" },
      { name: "Hackathon", value: "HACKATHON" },
    ],
  });
});

describe("workshop.formats", () => {
  it("GETs the backend lookup route", async () => {
    // The path is the contract with the gateway, which maps /v1/lookup/{proxy+} for GET
    // only. A typo here reproduces the reported bug exactly: an empty dropdown.
    await caller().formats();

    expect(backendFetch).toHaveBeenCalledTimes(1);
    expect(backendFetch.mock.calls[0][0]).toBe("/v1/lookup/formats");
  });

  it("forwards the caller's bearer token", async () => {
    // The backend route calls requireIdentity. This is the specific reason the old
    // browser-side fetch could not have worked even with a correct URL, it sent no
    // credentials and would have 401'd.
    await caller().formats();

    expect(backendFetch.mock.calls[0][1]).toMatchObject({ token: "test-token" });
  });

  it("returns the formats the backend supplies, in order", async () => {
    // Order is the backend's (it Queries ScanIndexForward on the `name` range key).
    // This layer must not re-sort: the dropdown showing something other than what the
    // service considers first would silently disagree with every other consumer.
    await expect(caller().formats()).resolves.toEqual([
      { name: "Accelerator", value: "ACCELERATOR" },
      { name: "Hackathon", value: "HACKATHON" },
    ]);
  });

  it("returns [] when the backend answers with no formats key", async () => {
    // An older or misconfigured backend answering `{}` must not put `undefined` into
    // the component's `.map()`, that is a client-side crash, strictly worse than the
    // empty state the UI now renders deliberately.
    backendFetch.mockResolvedValue({});
    await expect(caller().formats()).resolves.toEqual([]);
  });

  it("returns [] when the backend answers with a non-array formats value", async () => {
    // Defends the same `.map()` against a shape change rather than an absent key.
    backendFetch.mockResolvedValue({ formats: { name: "Nope" } });
    await expect(caller().formats()).resolves.toEqual([]);
  });

  it("drops malformed entries rather than passing them to the dropdown", async () => {
    // A row missing `value` would render an <option> that submits "", indistinguishable
    // from "no format chosen", which the service then silently defaults to WORKSHOP. So
    // a half-written row must never become a selectable option.
    backendFetch.mockResolvedValue({
      formats: [
        { name: "Good", value: "GOOD" },
        { name: "No value" },
        { value: "NO_NAME" },
        null,
        "not an object",
      ],
    });
    await expect(caller().formats()).resolves.toEqual([{ name: "Good", value: "GOOD" }]);
  });

  it("propagates a backend failure instead of masking it as an empty list", async () => {
    // THE CORE REGRESSION GUARD. The original bug was not that the call failed, but that
    // the failure was turned into `[]`. The UI can only distinguish "broken" from "none
    // configured" if this rejects, so swallowing an error here must fail a test.
    backendFetch.mockRejectedValue(new Error("backend exploded"));
    await expect(caller().formats()).rejects.toThrow();
  });

  it("requires a signed-in caller", async () => {
    // Defence in depth, matching the backend's own requireIdentity. Reference data
    // discloses nothing, but an anonymously-reachable BFF procedure is a habit worth
    // not forming.
    const anon = workshopRouter.createCaller({
      accessToken: undefined,
      session: null,
    } as never);
    await expect(anon.formats()).rejects.toThrow();
    expect(backendFetch).not.toHaveBeenCalled();
  });
});

/**
 * `withInviters` role gating, the fix for "still not seeing who invited".
 *
 * The two enrichment hops are both DIRECTORY-GATED (canManageUsers → ADMIN +
 * FACILITATOR): team's /directory/invited-by answers "your role cannot browse the user
 * directory" and identity's /admin/user-names answers "your role cannot manage users".
 * Both deployed Lambdas answer an EXECUTIVE with 403.
 *
 * So for an executive the helper always threw and its `catch` swallowed it, the
 * provenance line silently never appeared, and a swallowed 403 was indistinguishable
 * from "there is no inviter". The gate STAYS, so the correct behaviour
 * is to skip the hops rather than make two round trips per render that are guaranteed
 * to fail and be discarded.
 */
describe("withInviters, directory gating", () => {
  it("SKIPS both hops for a role that cannot reach the directory", async () => {
    backendFetch.mockReset();
    const { withInviters } = await import("@/lib/trpc/routers/admin");

    const rows = [{ email: "p1@example.com" }];
    const out = await withInviters(rows, "tok", "EXECUTIVE");

    // Rows come back unchanged, and, the point, nothing was requested.
    expect(out).toEqual(rows);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("still enriches for ADMIN and FACILITATOR", async () => {
    for (const role of ["ADMIN", "FACILITATOR"]) {
      backendFetch.mockReset();
      backendFetch
        .mockResolvedValueOnce({
          invitedBy: {
            "p1@example.com": {
              inviterId: "sub-f",
              basis: "ACCEPTED",
              scope: "TEAM",
            },
          },
        })
        .mockResolvedValueOnce({ names: { "sub-f": { name: "Facilitator One" } } });

      const { withInviters } = await import("@/lib/trpc/routers/admin");
      const out = await withInviters([{ email: "p1@example.com" }], "tok", role);

      expect(out[0]).toMatchObject({
        invitedBy: { name: "Facilitator One", basis: "ACCEPTED", scope: "TEAM" },
      });
      expect(backendFetch).toHaveBeenCalledTimes(2);
    }
  });

  it("enriches when no role is passed, so existing callers are unaffected", async () => {
    // The Users tab is already behind the directory gate and does not pass a role.
    // `undefined` must mean "don't gate", not "gate closed".
    backendFetch.mockReset();
    backendFetch
      .mockResolvedValueOnce({
        invitedBy: {
          "p1@example.com": { inviterId: "sub-f", basis: "ACCEPTED", scope: "TEAM" },
        },
      })
      .mockResolvedValueOnce({ names: { "sub-f": { name: "Someone" } } });

    const { withInviters } = await import("@/lib/trpc/routers/admin");
    const out = await withInviters([{ email: "p1@example.com" }], "tok");

    expect(out[0]).toHaveProperty("invitedBy");
    expect(backendFetch).toHaveBeenCalledTimes(2);
  });
});
