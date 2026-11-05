import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRPCClientError } from "@trpc/client";
import { isForbidden, isRateLimited, isUnauthorized } from "./trpc/errors";

/**
 * HOW THE PORTAL BEHAVES WHEN THE SERVER SAYS "SLOW DOWN".
 *
 * ⚠ THIS HAD TO LAND BEFORE ANY THROTTLE WAS ARMED, and that ordering is the whole point of the
 * file. The retry predicate excluded UNAUTHORIZED and FORBIDDEN and let everything else fall through
 * to `failureCount < 2`. A 429 is a rule with a clock on it, and it was landing in the "fault, retry
 * it" branch, so switching on gateway throttling would have turned one refused insights Refresh
 * into THREE requests per query, 18 backend calls from a single click, with no backoff, at exactly
 * the moment the gateway asked for less.
 *
 * A rate limit that makes the client generate more traffic is not a rate limit. Enabling the
 * throttle without this change would have been actively worse than having no limit at all.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const PROVIDERS = readCode("../components/providers.tsx");

/** A tRPC client error carrying a structured code, exactly as the real client produces. */
function trpcError(code: string): TRPCClientError<never> {
  const err = new TRPCClientError("boom");
  (err as unknown as { data: { code: string } }).data = { code };
  return err;
}

/** The retry predicate from providers.tsx, mirrored, this is the decision under test. */
function shouldRetry(error: unknown, failureCount: number): boolean {
  if (isUnauthorized(error)) return false;
  if (isForbidden(error)) return false;
  if (isRateLimited(error)) return false;
  return failureCount < 2;
}

describe("isRateLimited reads the STRUCTURED code, not the message", () => {
  it("recognises TOO_MANY_REQUESTS", () => {
    expect(isRateLimited(trpcError("TOO_MANY_REQUESTS"))).toBe(true);
  });

  it("does NOT confuse it with the other refusals", () => {
    // Three different answers needing three different behaviours: re-authenticate, give up, wait.
    expect(isRateLimited(trpcError("UNAUTHORIZED"))).toBe(false);
    expect(isRateLimited(trpcError("FORBIDDEN"))).toBe(false);
    expect(isUnauthorized(trpcError("TOO_MANY_REQUESTS"))).toBe(false);
    expect(isForbidden(trpcError("TOO_MANY_REQUESTS"))).toBe(false);
  });

  it("a MESSAGE mentioning 429 is not a rate limit", () => {
    /**
     * The same discipline the other predicates document: messages come from several services and
     * get reworded, so a control-flow decision made by string-matching one breaks silently the next
     * time somebody improves the wording.
     */
    expect(isRateLimited(new Error("Backend error: 429"))).toBe(false);
    expect(isRateLimited(new Error("Too Many Requests"))).toBe(false);
  });

  it("an unstructured failure is not a rate limit", () => {
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
    expect(isRateLimited(new Error("socket hang up"))).toBe(false);
  });
});

describe("a 429 is NEVER retried", () => {
  it("returns false on the first failure, not after two", () => {
    // The amplification bug: `failureCount < 2` gave a throttled request two more attempts.
    expect(shouldRetry(trpcError("TOO_MANY_REQUESTS"), 0)).toBe(false);
    expect(shouldRetry(trpcError("TOO_MANY_REQUESTS"), 1)).toBe(false);
  });

  it("covers BOTH sources of a 429, including the one with no body code", () => {
    /**
     * ⚠ WHY THE PREDICATE READS THE tRPC CODE AND NOT A BODY FIELD.
     *
     * Two things produce a 429 here. The AI service's own refusals carry a JSON body with
     * `code: "ANALYSIS_COOLDOWN"` or `"ANALYSIS_IN_PROGRESS"`. API Gateway's throttle returns
     * `{"message":"Too Many Requests"}`, NO `error`, NO `code`, and backendFetch discards headers,
     * so the only thing that survives is the status → TOO_MANY_REQUESTS mapping in trpc.ts.
     *
     * A predicate keyed on the body's `code` would silently miss the gateway case: the one that
     * means the PLATFORM is shedding load, and the one where a retry does the most harm.
     */
    // Both arrive here as the same tRPC code, which is exactly why this works.
    expect(shouldRetry(trpcError("TOO_MANY_REQUESTS"), 0)).toBe(false);
  });

  it("still retries a genuine FAULT twice", () => {
    // The fix must not turn off retries generally: a dropped connection or a 500 is transient and
    // worth one more attempt.
    expect(shouldRetry(new Error("socket hang up"), 0)).toBe(true);
    expect(shouldRetry(trpcError("INTERNAL_SERVER_ERROR"), 1)).toBe(true);
    expect(shouldRetry(new Error("socket hang up"), 2)).toBe(false);
  });

  it("still gives up immediately on the other two refusals", () => {
    expect(shouldRetry(trpcError("UNAUTHORIZED"), 0)).toBe(false);
    expect(shouldRetry(trpcError("FORBIDDEN"), 0)).toBe(false);
  });
});

describe("the wiring is actually in providers.tsx", () => {
  /**
   * The predicate above is a MIRROR, so it proves nothing unless the real file uses it. These pin
   * the mirror to the source, the same technique confirm-dialog-focus.test.ts uses, and for the
   * same reason: a mirror that silently stops describing the code is worse than no test.
   */
  it("imports and calls isRateLimited in the retry predicate", () => {
    expect(PROVIDERS).toContain("isRateLimited");
    const retryStart = PROVIDERS.indexOf("retry: (failureCount");
    const retryEnd = PROVIDERS.indexOf("mutations:", retryStart);
    const body = PROVIDERS.slice(retryStart, retryEnd);
    expect(body).toContain("if (isRateLimited(error)) return false;");
  });

  it("checks it BEFORE the failureCount fallthrough", () => {
    // Order matters: after `return failureCount < 2` it would be dead code.
    const retryStart = PROVIDERS.indexOf("retry: (failureCount");
    const body = PROVIDERS.slice(retryStart, PROVIDERS.indexOf("mutations:", retryStart));
    expect(body.indexOf("isRateLimited")).toBeLessThan(body.indexOf("failureCount < 2"));
  });
});
