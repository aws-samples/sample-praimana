// ── ⚠ EVERY BACKEND STATUS MUST REACH THE CLIENT ─────────────────────────────────────────
//
// REPORTED FOUR TIMES as "Couldn't load this team's AI conversations … Backend error: 401", and only reproducing
// it against the REAL middleware chain found the cause.
//
// ⚠ `next()` DOES NOT THROW. tRPC middleware resolves with a `MiddlewareResult`, `{ ok: true, data }` or
// `{ ok: false, error }`, so the original `try { return await next() } catch { … }` had a catch block that
// NEVER RAN. Every backend status fell through unmapped to tRPC's default 500.
//
// ⚠ IT LOOKED LIKE A CLASS-IDENTITY BUG and I chased that first: the stack showed the middleware running and a
// 500 carrying `BackendError: Backend error: 401`, which is exactly the signature of a failed `instanceof`
// across duplicated webpack copies, a fault this codebase genuinely has elsewhere. Duck-typing the check
// changed nothing, because the comparison was never reached.
//
// ⚠ AND THE BLAST RADIUS WAS EVERY STATUS, NOT JUST 401. While it was broken a 403 could not produce the
// "member-only" screen, a 429 could not produce the rate-limit screen, and a 404 could not produce "not found".
// That is why this file asserts the whole table rather than the one status that was reported.

import { describe, it, expect } from "vitest";
import { router, protectedProcedure } from "./trpc";
import { BackendError } from "@/lib/backend";

/** Call a procedure that fails with a given backend status, through the real chain. */
async function codeFor(thrown: unknown): Promise<string | undefined> {
  const probe = router({
    boom: protectedProcedure.query(() => {
      throw thrown;
    }),
  });
  const caller = (probe as any).createCaller({
    session: { user: { id: "u1" } },
    accessToken: "t",
    token: "t",
  });
  try {
    await caller.boom();
    return undefined;
  } catch (e: any) {
    return e?.code;
  }
}

describe("⚠ the status table, end to end through the middleware", () => {
  it.each([
    [400, "BAD_REQUEST"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "TOO_MANY_REQUESTS"],
    [500, "INTERNAL_SERVER_ERROR"],
  ])("a BackendError(%i) arrives as %s", async (status, expected) => {
    expect(await codeFor(new BackendError(status, `Backend error: ${status}`))).toBe(expected);
  });

  /**
   * ⚠ THE ONE THAT WAS REPORTED, spelled out on its own because it is the one with a remedy: a 401 must reach
   * the client as UNAUTHORIZED or the portal shows "the data is missing, report it" for an expired login and
   * never redirects.
   */
  it("a 401 is not reported as a server fault", async () => {
    expect(await codeFor(new BackendError(401, "Backend error: 401"))).not.toBe("INTERNAL_SERVER_ERROR");
  });

  /** A duplicated module copy must map too, `cause` crosses bundling boundaries. */
  it("maps one whose prototype came from another copy of the module", async () => {
    const err = Object.assign(new Error("Backend error: 403"), { name: "BackendError", status: 403 });
    expect(err instanceof BackendError, "precondition: instanceof fails").toBe(false);
    expect(await codeFor(err)).toBe("FORBIDDEN");
  });

  /** Anything that is NOT a backend failure must keep tRPC's own classification. */
  it("leaves an unrelated error alone", async () => {
    expect(await codeFor(new Error("something else broke"))).toBe("INTERNAL_SERVER_ERROR");
  });

  /** And a success must still succeed, the middleware returns the result rather than swallowing it. */
  it("does not disturb a passing call", async () => {
    const probe = router({ ok: protectedProcedure.query(() => "fine") });
    const caller = (probe as any).createCaller({
      session: { user: { id: "u1" } },
      accessToken: "t",
      token: "t",
    });
    await expect(caller.ok()).resolves.toBe("fine");
  });
});
