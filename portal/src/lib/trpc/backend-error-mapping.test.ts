// ── ⚠ A BACKEND STATUS MUST SURVIVE THE TRIP TO THE CLIENT ───────────────────────────────
//
// REPORTED THREE TIMES, and only the raw response payload named it:
//
//     "code": "INTERNAL_SERVER_ERROR", "httpStatus": 500,
//     "stack": "BackendError: Backend error: 401\n at backendFetch (webpack-internal:///(rsc)/./src/lib/backend.ts…"
//
// A REAL `BackendError` carrying 401 was thrown, `mapBackendErrors` ran, and `instanceof` returned FALSE, so
// it fell through unmapped and tRPC surfaced a 500. Every downstream 401 guard then stayed silent, and the user
// was told their team's data was missing and invited to report a bug about their own expired login.
//
// ⚠ AND IT WAS BREAKING EVERY STATUS, NOT ONLY 401: while this misfires, a 403 cannot reach the "member-only"
// screen and a 429 cannot reach the rate-limit screen. The 401 is just the one somebody noticed.

import { describe, it, expect } from "vitest";
import { asBackendError } from "./trpc";
import { BackendError } from "@/lib/backend";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("⚠ recognising a BackendError without relying on class identity", () => {
  it("recognises a real one", () => {
    expect(asBackendError(new BackendError(401, "Backend error: 401"))).toEqual({
      status: 401,
      message: "Backend error: 401",
    });
  });

  /**
   * ⚠ THE CASE THAT WAS BROKEN. `instanceof` compares the class OBJECT, and webpack can evaluate
   * `@/lib/backend` more than once, across the `(rsc)` boundary, or after HMR swaps one copy while this
   * module holds the old binding. A structurally identical error from the other copy must still be mapped.
   */
  it("recognises one built by a DIFFERENT copy of the module", () => {
    class OtherRealmBackendError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.name = "BackendError";
        this.status = status;
      }
    }
    const err = new OtherRealmBackendError(401, "Backend error: 401");

    expect(err instanceof BackendError, "precondition: instanceof fails, as it did in production").toBe(false);
    expect(asBackendError(err), "and the duck-typed check still catches it").toEqual({
      status: 401,
      message: "Backend error: 401",
    });
  });

  /** A plain object works too, the field may cross a serialisation boundary and lose its prototype entirely. */
  it("recognises a prototype-less shape", () => {
    expect(asBackendError({ name: "BackendError", status: 403, message: "nope" })).toEqual({
      status: 403,
      message: "nope",
    });
  });
});

describe("⚠ and NOT recognising things that merely look similar", () => {
  /**
   * Both witnesses are required. `name` alone would match a hand-rolled error somebody named the same way; a
   * numeric `status` alone would match half the fetch failures in the ecosystem, and a false positive here
   * maps an unrelated fault onto an auth code, signing people out for no reason.
   */
  it("requires both the name and a numeric status", () => {
    expect(asBackendError({ name: "BackendError" }), "no status").toBeNull();
    expect(asBackendError({ status: 401 }), "no name").toBeNull();
    expect(asBackendError({ name: "BackendError", status: "401" }), "status not a number").toBeNull();
    expect(asBackendError(new Error("Backend error: 401")), "a bare Error").toBeNull();
  });

  it("ignores non-objects", () => {
    for (const v of [null, undefined, "Backend error: 401", 401, true]) {
      expect(asBackendError(v), String(v)).toBeNull();
    }
  });
});

// ── ⚠ THE STACK MUST NOT LEAVE A PRODUCTION SERVER ───────────────────────────────────────
//
// A development error response can carry absolute filesystem paths and the internal module graph, and the
// whole stack must never be sent in a response.
//
// tRPC's default already strips it outside development, but that made a disclosure control depend entirely on
// one environment variable being exactly "production", with nothing asserting it. A build that set `NODE_ENV=dev`
// would leak on every error, silently and looking completely normal.
describe("⚠ the error formatter", () => {
  const source = readFileSync(fileURLToPath(new URL("./trpc.ts", import.meta.url)), "utf8");

  it("strips the stack when not in development", () => {
    /* Rebuilt WITHOUT `stack` rather than mutated, so the field cannot survive by being re-added later. */
    expect(source).toMatch(/const \{ stack: _stack, \.\.\.data \} = shape\.data/);
    /* EVERY return path must drop it, upstream, deliberate refusal, and unexpected throw. */
    expect(source).toMatch(/\? \{ \.\.\.shape, data \}/);
    expect(source).toMatch(/message: sanitizeErrorMessage\(/);
    expect(source).toMatch(/message: genericMessage\(/);
  });

  it("decides on NODE_ENV once, not per call", () => {
    expect(source).toMatch(/const IS_DEV = process\.env\.NODE_ENV !== "production"/);
    expect(source).toMatch(/if \(IS_DEV\) return shape;/);
  });

  /**
   * ⚠ AND IT KEEPS THE STACK IN DEVELOPMENT, deliberately. It is what made the `BackendError` bug above
   * findable at all, stripping it everywhere would trade a real diagnostic for no additional safety, since a
   * dev server is not a production surface.
   */
  it("keeps it in development", () => {
    const fmt = source.slice(source.indexOf("errorFormatter("), source.indexOf("errorFormatter(") + 400);
    expect(fmt, "dev returns the shape untouched").toContain("if (IS_DEV) return shape;");
  });

  /**
   * ⚠ SANITIZATION, AND THE TWO PROPERTIES THAT MAKE IT CORRECT RATHER THAN JUST PRESENT.
   * See sanitize-error.ts for the policy; these assert the WIRING, which is where it would go
   * wrong quietly.
   */
  it("sanitizes the message in the error formatter", () => {
    expect(source).toContain("sanitizeErrorMessage");
    expect(source).toContain(
      'import { genericMessage, sanitizeErrorMessage } from "@/lib/sanitize-error"'
    );
  });

  it("⚠ PASSES THE BACKEND `code` TO THE SANITISER, the whole policy turns on it", () => {
    // Default-deny: an upstream message is replaced UNLESS the service attached a code. Dropping
    // this third argument would silently generalise every service refusal the platform has
    // carefully worded, and no test of the sanitiser alone would notice.
    expect(source).toMatch(
      /sanitizeErrorMessage\(\s*upstream\.message,\s*upstream\.status,\s*upstream\.code\s*\)/
    );
    // And the code has to survive the duck-typed probe to get here.
    expect(source).toMatch(/code: typeof e\.code === "string" \? e\.code : undefined/);
  });

  /**
   * ⚠ THIS TEST'S RULE CHANGED, AND THE OLD VERSION OF IT DESCRIBED A HOLE.
   *
   * It asserted that the formatter "sanitises only upstream errors, so local validation messages
   * survive", and that was the intent, but the code implemented it as `if (!upstream) return
   * { ...shape, data }`, i.e. pass through EVERYTHING that is not a BackendError. The cases the
   * comment listed (Zod, UNAUTHORIZED, our own FORBIDDEN) were right; the case nobody listed was an
   * UNEXPECTED throw, a TypeError, an AWS SDK error, a Node `ENOENT: … open '/var/task/…'`, which
   * tRPC labels INTERNAL_SERVER_ERROR and passes to the client with no masking of its own.
   *
   * So the passthrough is now an ALLOWLIST OF DELIBERATE REFUSAL CODES, and anything else is
   * generalised. Both halves are asserted, because either alone would let the hole back.
   */
  it("⚠ PASSES DELIBERATE REFUSALS THROUGH, and GENERALISES anything unexpected", () => {
    // The allowlist exists and is keyed on the tRPC code, not on "is it upstream".
    expect(source).toMatch(/const DELIBERATE_REFUSALS: ReadonlySet<string> = new Set\(\[/);
    for (const code of ["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "CONFLICT"]) {
      expect(source, `${code} is a deliberate refusal and keeps its message`).toContain(`"${code}"`);
    }
    // ⚠ AND INTERNAL_SERVER_ERROR IS *NOT* IN IT. That is the code tRPC assigns to every
    // unrecognised thrown value, so its absence is what closes the hole.
    const set = /DELIBERATE_REFUSALS[^;]*;/.exec(source)?.[0] ?? "";
    expect(set, "an unexpected throw must not be allowlisted").not.toContain(
      "INTERNAL_SERVER_ERROR"
    );
    // The branch is a ternary on that set, with genericMessage as the else.
    expect(source).toMatch(
      /DELIBERATE_REFUSALS\.has\(shape\.data\.code\)[\s\S]{0,200}genericMessage\(shape\.data\.httpStatus\)/
    );
    // And the upstream probe still comes first, so a service message is still default-deny.
    expect(source).toMatch(/const upstream = asBackendError\(error\.cause\) \?\? asBackendError\(error\)/);
  });
});
