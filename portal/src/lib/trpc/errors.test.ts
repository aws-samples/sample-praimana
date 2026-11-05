// ── ⚠ A 401 MUST BE RECOGNISED AS A 401, WHICHEVER COPY OF tRPC BUILT IT ─────────────────
//
// REPORTED: a chat page showing
//
//     Couldn't load this team's chat
//     This is a failure to load, not an empty team, the data is missing, not absent.
//     Try again; if it keeps failing, report it and quote the message here.
//     Backend error: 401
//
// Three things wrong with that screen, and all three are the same mistake: it blamed the team's DATA for
// an expired login, offered a "Try again" that produces another 401 every time, and asked the user to
// report a bug that is not one.
//
// ⚠ THE PAGE WAS ALREADY CORRECT. `chat/page.tsx` handles the gate's `expired` state and renders
// `SessionExpiredNotice`. The classification never got there: `isUnauthorized` read `error.data.code`
// behind an `instanceof TRPCClientError` check, and `instanceof` compares CLASS IDENTITY, false whenever
// the error was constructed by a different copy of `@trpc/client` than this module imported, which happens
// with a duplicated transitive version and across the ESM/CJS boundary Next.js produces for a "use client"
// module. The failure is silent and total: every predicate reports "no code".

import { describe, it, expect } from "vitest";
import { TRPCClientError } from "@trpc/client";
import { isUnauthorized, isForbidden, isRateLimited, trpcErrorCode } from "./errors";

/** A real TRPCClientError, as the matching copy of the library would build it. */
function realError(code: string, httpStatus: number) {
  const err = new TRPCClientError("Backend error: " + httpStatus);
  (err as unknown as { data: unknown }).data = { code, httpStatus };
  return err;
}

/**
 * ⚠ THE SHAPE THE BUG PRODUCED: structurally identical, different class. This is what a second copy of
 * `@trpc/client` hands the app, and what `instanceof` refuses to recognise.
 */
function foreignError(code: string | undefined, httpStatus: number | undefined) {
  return { name: "TRPCClientError", message: `Backend error: ${httpStatus}`, data: { code, httpStatus } };
}

describe("⚠ an expired session is recognised however the error was constructed", () => {
  it("recognises a real TRPCClientError", () => {
    expect(isUnauthorized(realError("UNAUTHORIZED", 401))).toBe(true);
  });

  /** THE REGRESSION, NAMED. This is the case that rendered the wrong screen. */
  it("recognises a foreign-copy error carrying the same data", () => {
    expect(isUnauthorized(foreignError("UNAUTHORIZED", 401))).toBe(true);
  });

  /**
   * ⚠ THE STATUS IS A SECOND WITNESS. A 401 that arrives with `httpStatus` and no `code` is still
   * unambiguously an expired session, and being wrong about it costs the user a bug-report screen.
   */
  it("recognises a 401 that carries no code at all", () => {
    expect(isUnauthorized(foreignError(undefined, 401))).toBe(true);
  });

  it("still reads the code when there is no status", () => {
    expect(isUnauthorized(foreignError("UNAUTHORIZED", undefined))).toBe(true);
  });
});

describe("⚠ and nothing else is mistaken for one", () => {
  /**
   * The asymmetry that matters: UNAUTHORIZED evicts the session, FORBIDDEN must NOT. Widening the 401
   * detector must not drag a refusal in with it, that would sign a user out for visiting a page they are
   * simply not entitled to.
   */
  it("does not treat a 403 as an expired session", () => {
    expect(isUnauthorized(realError("FORBIDDEN", 403))).toBe(false);
    expect(isUnauthorized(foreignError("FORBIDDEN", 403))).toBe(false);
    expect(isForbidden(foreignError("FORBIDDEN", 403)), "and a refusal is still a refusal").toBe(true);
  });

  it("does not treat a 429 or a 500 as an expired session", () => {
    expect(isUnauthorized(foreignError("TOO_MANY_REQUESTS", 429))).toBe(false);
    expect(isRateLimited(foreignError("TOO_MANY_REQUESTS", 429))).toBe(true);
    expect(isUnauthorized(foreignError("INTERNAL_SERVER_ERROR", 500))).toBe(false);
  });

  /**
   * ⚠ "NO CODE" MUST STAY A REAL ANSWER. A dropped connection or an aborted fetch carries no structured
   * data, and reporting it as an expired session would sign people out on a flaky network.
   */
  it.each([
    ["a plain Error", new Error("network down")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["an object with no data", { message: "x" }],
    ["an object whose data is not an object", { data: "401" }],
    ["an object whose data is empty", { data: {} }],
  ])("returns false for %s", (_label, err) => {
    expect(isUnauthorized(err)).toBe(false);
    expect(trpcErrorCode(err)).toBeUndefined();
  });
});

// ── ⚠ WHY THERE IS NO MESSAGE-BASED FALLBACK HERE ────────────────────────────────────────
//
// A `Backend error: 401` witness WAS added when the "report this bug" screen was reported a second time, and
// then reverted the same hour. `team-content-gate.test.ts` already forbids reading the message, and its
// reasoning holds: `lib/backend.ts` builds that string as `data.error || \`Backend error: ${status}\``, so it
// only appears when the service sent NO error body. The day any service adds one, the message becomes that
// text and a matcher on it stops working silently, exactly the failure the rule predicts.
//
// So a 401 that arrives with neither `code` nor `httpStatus` is left unclassified ON PURPOSE. If that is
// happening, the fault is whatever dropped `data`, and the fix belongs there. See the diagnostic in
// `team-content-gate.ts`, which exists to identify that layer the next time it occurs.
