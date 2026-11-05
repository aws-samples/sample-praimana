import { TRPCClientError } from "@trpc/client";

/**
 * Predicates for WHY a tRPC call failed, in one place.
 *
 * Every one of these reads the structured `data.code`, set by the backend→TRPCError
 * mapping in trpc.ts, and never the human-readable message. The messages on these
 * paths come from four different services and get reworded; a control-flow decision
 * made by string-matching one of them breaks silently the next time someone improves
 * the wording.
 *
 * `isUnauthorized` was previously a private function in components/providers.tsx. It
 * moved here so `isForbidden` could sit beside it rather than be a second copy: the two
 * are read together (one evicts the session, the other must NOT) and a divergence
 * between them would be an authentication bug wearing an authorization bug's clothes.
 */

/**
 * The tRPC error code a failure carried, or undefined when it did not carry one, a
 * network failure, an aborted fetch, or a value thrown from somewhere that is not the
 * tRPC client at all. "No code" is therefore a real answer and means "we never got a
 * structured refusal from the server", which is never a rule and always a fault.
 */
export function trpcErrorCode(error: unknown): string | undefined {
  return errorData(error)?.code;
}

/**
 * The structured payload a tRPC failure carries, read WITHOUT relying on `instanceof`.
 *
 * ⚠ `instanceof TRPCClientError` IS NOT RELIABLE HERE, and that is why this exists. It compares class
 * IDENTITY, so it returns false whenever the error was constructed by a different copy of `@trpc/client`
 * than the one this module imported, which happens with a duplicated transitive version, and across the
 * ESM/CJS boundary Next.js produces for a "use client" module. The failure is silent and total: every
 * predicate below reports "no code", so a 401 is classified as an unexplained fault.
 *
 * REPORTED: a chat page showing "Couldn't load this team's chat … Backend error: 401 … Try again", the
 * `failed` copy, for an error whose message is our own 401 string and whose code should have been
 * UNAUTHORIZED. The page already handled `expired` correctly; the classification never got there.
 *
 * Duck-typed instead: a shape carrying a `data` object with a string `code` or a numeric `httpStatus` IS a
 * structured tRPC failure, whichever copy of the library built it. The `instanceof` check is kept FIRST
 * because when it does match it is unambiguous.
 */
function errorData(error: unknown): { code?: string; httpStatus?: number } | undefined {
  if (error instanceof TRPCClientError) {
    return (error.data ?? undefined) as { code?: string; httpStatus?: number } | undefined;
  }
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const shape = data as { code?: unknown; httpStatus?: unknown };
  const code = typeof shape.code === "string" ? shape.code : undefined;
  const httpStatus = typeof shape.httpStatus === "number" ? shape.httpStatus : undefined;
  return code || httpStatus ? { code, httpStatus } : undefined;
}

/**
 * True when a tRPC error carries the UNAUTHORIZED code, the session/bearer token is no
 * longer valid and the user must re-authenticate.
 */
export function isUnauthorized(error: unknown): boolean {
  const data = errorData(error);
  /**
   * ⚠ THE HTTP STATUS IS A SECOND WITNESS, deliberately. The code is the primary signal, but a 401 that
   * arrives with `httpStatus` and no `code` is still unambiguously an expired session, and being wrong
   * about it has a real cost: the user is shown a "report this bug" screen for an expired login, with a
   * Try again button that produces another 401 every time.
   *
   * This is NOT the message-matching the note above forbids. That warning is about control flow between
   * RULES, where four services word the same refusal differently. A status code is structured data with one
   * meaning, and 401 has exactly one remedy: sign in again.
   */
  return data?.code === "UNAUTHORIZED" || data?.httpStatus === 401;
}

/**
 * True when the server REFUSED the call by rule, the caller is authenticated, and the
 * answer is still no.
 *
 * DISTINCT FROM UNAUTHORIZED IN THE ONE WAY THAT MATTERS: re-authenticating cannot fix
 * it, so nothing here may evict the session, and retrying cannot fix it either, so
 * nothing here should retry. A rule does not change between two attempts 200 ms apart;
 * the only thing a retry buys is three refusals in the log instead of one and a second's
 * delay before the screen can explain itself.
 */
export function isForbidden(error: unknown): boolean {
  return trpcErrorCode(error) === "FORBIDDEN";
}

/**
 * True when the caller was asked to SLOW DOWN, a 429, from either of the two sources that
 * produce one (see below).
 *
 * ⚠ THIS EXISTS TO STOP A RETRY, and it had to land BEFORE any throttle was armed. The retry
 * predicate in providers.tsx excluded UNAUTHORIZED and FORBIDDEN and let everything else through
 * to `failureCount < 2`. A 429 is a rule with a clock on it, and it was falling into the "fault,
 * retry it" branch, so the moment gateway throttling switched on, one refused Refresh would have
 * become THREE requests per query, 18 backend calls from one click, with no backoff, at precisely
 * the moment the gateway was signalling stop. That is amplification wearing a retry's clothes, and
 * it would have made the rate limit actively harmful.
 *
 * COVERS BOTH 429 SOURCES, which is why it reads the tRPC code rather than a body field:
 *   · the AI service's own refusals, ANALYSIS_COOLDOWN and ANALYSIS_IN_PROGRESS, which carry a
 *     JSON body with a `code`;
 *   · API Gateway's stage/route throttle, which returns `{"message":"Too Many Requests"}` with NO
 *     `error` and NO `code`. backendFetch discards headers and finds no body code, so the only
 *     thing that survives to here is the status → `TOO_MANY_REQUESTS` mapping in trpc.ts.
 * A predicate keyed on the body's `code` would silently miss the second, the one that means the
 * platform as a whole is shedding load.
 *
 * NO CLIENT-SIDE BACKOFF-AND-RETRY instead: for this population, surfacing the refusal is both
 * cheaper and more honest than being clever, and the user's own next click is the retry.
 */
export function isRateLimited(error: unknown): boolean {
  return trpcErrorCode(error) === "TOO_MANY_REQUESTS";
}

/**
 * The service's OWN description of the failure, when there is one.
 *
 * Preferred over any message a screen could invent, because it names the rule that
 * actually fired ("not a member of this team", "your role has read-only access"), the
 * same reasoning the team page applies to a failed removal. Undefined when the thrown
 * value carried no message, which is the case a caller must have its own sentence for.
 */
export function errorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}
