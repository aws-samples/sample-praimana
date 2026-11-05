import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The BFF's input gate on the three mandatory profile fields.
 *
 * WHY THIS FILE EXISTS: the shared validator has its own suite, and the identity
 * service has its own, but neither proves that the tRPC procedure actually WIRES the
 * validator into its input schema. A `.superRefine` that was never attached, or
 * attached to the wrong object, would type-check, lint, and pass every other test in
 * the repo while letting "Ada2" and a one-character name straight through to the
 * backend. The assertion that matters here is therefore not "is 'Ada2' invalid" but
 * "does this procedure REJECT it, and does it do so BEFORE calling the backend".
 *
 * `backendFetch` is mocked to prove exactly that: on an invalid input it must never
 * be called. A rejection that still made the round trip would be a validation gate in
 * name only.
 */

const backendFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/backend", () => ({
  backendFetch,
  // BackendError is imported by trpc.ts for its error-mapping middleware; the real
  // class is not needed here, but the export must exist or the module fails to load.
  BackendError: class BackendError extends Error {
    status = 500;
  },
}));

import { authRouter } from "@/lib/trpc/routers/auth";

/**
 * A caller with a SIGNED-IN context.
 *
 * `protectedProcedure` requires both `session.user.id` and `accessToken`, and its auth
 * middleware runs BEFORE input parsing, so a context that is merely close enough
 * makes every rejection assertion below pass for the wrong reason (UNAUTHORIZED
 * instead of a validation failure). That is not a hypothetical: the first version of
 * this file used the wrong key names and 10 tests "passed" while proving nothing.
 * Hence `expectRejected` asserts on the error CODE, not just that it threw.
 */
function caller() {
  return authRouter.createCaller({
    accessToken: "test-token",
    session: {
      user: { id: "u-1", email: "u@example.com", role: "PARTICIPANT" },
    },
  } as never);
}

const good = {
  firstName: "Ada",
  lastName: "Lovelace",
  organization: "Analytical Engines",
};

beforeEach(() => {
  backendFetch.mockReset();
  backendFetch.mockResolvedValue({ user: { id: "u-1" } });
});

describe("auth.updateProfile input validation", () => {
  it("accepts a valid profile and forwards it to the identity service", async () => {
    // The control: if this failed, every rejection below could be explained by the
    // procedure being broken rather than by the input being invalid.
    await caller().updateProfile(good);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [path, init] = backendFetch.mock.calls[0];
    expect(path).toBe("/v1/auth/me");
    expect(init.method).toBe("PATCH");
  });

  /**
   * Assert the input is refused as BAD_REQUEST specifically, and that no backend call
   * was made.
   *
   * The code check is load-bearing. `.rejects.toThrow()` alone is satisfied by an
   * UNAUTHORIZED from the auth middleware, which runs before input parsing, so a
   * broken test context would turn this whole file green while the validation it
   * claims to test was never reached.
   */
  async function expectRejected(input: Record<string, unknown>) {
    const label = JSON.stringify(input).slice(0, 120);
    const err = await caller()
      .updateProfile(input as never)
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(err, `${label} was ACCEPTED`).toBeTruthy();
    // BAD_REQUEST is what tRPC maps a zod input failure to. UNAUTHORIZED here would
    // mean the test context is wrong, not that the input was rejected.
    expect((err as { code?: string }).code, label).toBe("BAD_REQUEST");
    // The whole point of validating at the BFF: the bad value never leaves the node
    // process, so the backend is not asked to reject what we already know is wrong.
    expect(backendFetch, label).not.toHaveBeenCalled();
  }

  // ─── The four length boundaries, at the BFF ───
  //
  // These mirror the shared suite and the identity service's suite deliberately. The
  // rules are enforced from ONE module, so the risk is not three different rules, it
  // is one surface silently not applying it. Off-by-one is asserted on both sides.
  it.each(["firstName", "lastName", "organization"] as const)(
    "%s: rejects 1 character (below the minimum of 2)",
    async (key) => {
      await expectRejected({ ...good, [key]: "a" });
    }
  );

  it.each(["firstName", "lastName", "organization"] as const)(
    "%s: ACCEPTS exactly 2 characters",
    async (key) => {
      await caller().updateProfile({ ...good, [key]: "ab" });
      expect(backendFetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["firstName", "lastName", "organization"] as const)(
    "%s: ACCEPTS exactly 25 characters",
    async (key) => {
      await caller().updateProfile({ ...good, [key]: "a".repeat(25) });
      expect(backendFetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["firstName", "lastName", "organization"] as const)(
    "%s: rejects 26 characters (above the maximum of 25)",
    async (key) => {
      await expectRejected({ ...good, [key]: "a".repeat(26) });
    }
  );

  it("rejects an empty or whitespace-only value", async () => {
    await expectRejected({ ...good, firstName: "" });
    backendFetch.mockClear();
    await expectRejected({ ...good, lastName: "   " });
  });

  it("rejects digits in a name but ACCEPTS them in the organisation", async () => {
    await expectRejected({ ...good, firstName: "Ada2" });
    backendFetch.mockClear();
    await expectRejected({ ...good, lastName: "Lovelace9" });
    backendFetch.mockClear();
    // The one asymmetry in the contract.
    await caller().updateProfile({ ...good, organization: "Studio 54" });
    expect(backendFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts real international names, the regression that would be invisible", async () => {
    for (const [firstName, lastName] of [
      ["José", "García"],
      ["Jürgen", "Müller"],
      ["Anne-Marie", "O'Brien"],
      ["Ana María", "van der Berg"],
      ["田中", "太郎"],
      ["Иван", "Иванов"],
    ] as const) {
      backendFetch.mockClear();
      await caller().updateProfile({ firstName, lastName, organization: "Acme Ltd" });
      expect(backendFetch, `${firstName} ${lastName}`).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects special characters, including injection-shaped values", async () => {
    for (const value of ["Ada<script>", "Ada@example.com", "Ada;DROP", "Ada&Bob", "Ada_Bob"]) {
      backendFetch.mockClear();
      await expectRejected({ ...good, firstName: value });
    }
  });

  it("rejects an absurdly long payload without running the character rule on it", async () => {
    // The RAW cap is a payload bound, not a business rule: it exists so a megabyte
    // string is refused by a length check rather than fed to a regex.
    await expectRejected({ ...good, firstName: "a".repeat(100_000) });
  });

  it("still accepts a padded value that NORMALISES within the limit", async () => {
    // The raw cap must be looser than the business ceiling, or the BFF would reject
    // values the shared validator and the backend both accept, a form that shows an
    // error the API disagrees with.
    await caller().updateProfile({ ...good, firstName: `  ${"a".repeat(25)}  ` });
    expect(backendFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing field outright rather than defaulting it to empty", async () => {
    await expectRejected({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("reports the failure against the FIELD, so the form can show it in place", async () => {
    // A form-level-only error would leave the user hunting which of three inputs was
    // wrong. The path is what lets the client put the message on the right field.
    const err = await caller()
      .updateProfile({ ...good, lastName: "Lovelace9" } as never)
      .catch((e: unknown) => e);
    const zodIssues = JSON.parse((err as Error).message) as {
      path: string[];
      message: string;
    }[];
    expect(zodIssues[0].path).toEqual(["lastName"]);
    // And it carries the shared validator's copy, not a generic zod string, the user
    // sees the same sentence the backend would have returned.
    expect(zodIssues[0].message).toMatch(/can only contain letters/);
  });
});
