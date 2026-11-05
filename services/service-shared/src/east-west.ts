/**
 * Bounds shared by every EAST-WEST (service-to-service) HTTP call.
 *
 * WHY THIS EXISTS — until now not one cross-service `fetch` in this repo carried a
 * timeout (`grep -r 'AbortSignal\|AbortController' apps/services` returned nothing).
 * The failure that makes that dangerous is NOT an outage: a callee that is down
 * refuses the connection and the caller's fail-closed `catch` fires in
 * milliseconds. The dangerous case is a callee answering in 30 SECONDS WITH ZERO
 * ERRORS. Every waiter then holds its own Lambda for the full 29s API Gateway
 * timeout, reserved concurrency fills with threads doing nothing, and requests that
 * never needed the degraded dependency at all start getting throttled. One slow
 * context takes out an unrelated one, and no error rate anywhere shows why.
 *
 * A timeout does not change what a failure MEANS in any of these clients: an abort
 * surfaces as a rejected fetch, which every one of them already treats as a DENY (or
 * as "unavailable" where the caller can tell the two apart). It only bounds how long
 * the caller waits to find out.
 *
 * Lives here, in service-shared, rather than being copied per service the way
 * ROLE_GRANTS is: the copies of that table exist because bundled Lambdas take no dep
 * on `@praimana/shared`, whereas every service that makes an east-west call
 * already depends on THIS package for forwardedIdentityHeaders. One number, one home.
 */

/**
 * Per-attempt deadline for an east-west call, in milliseconds.
 *
 * ── 2500ms, RAISED FROM 800ms AFTER IT PROVED TOO SHORT ──
 *
 * The reported symptom: a FACILITATOR who had just created a workshop was told
 * "Forbidden: only the workshop owner can create teams" when adding a team to it. They
 * were the owner. The `ownerId` was stored correctly and the callee returned it
 * correctly — but the team service's authorization probe never got the answer, and its
 * fail-closed catch turned "could not determine" into "not the owner".
 *
 * WHY 800ms WAS TOO LOW — and it was NOT the callee being slow, which is what the old
 * derivation below assumed. MEASURED, from a throwaway Lambda placed in the same
 * subnets and security group as the services, calling the same gateway URL:
 *
 *   first call from a cold execution environment ... 1802ms
 *   subsequent warm calls ....................... 46ms, 61ms, 125ms
 *
 * The warm figures vindicate the original ~50ms reading. The 1802ms does not appear in
 * it at all: it is the CALLER's first-call cost — ENI/DNS resolution against the
 * execute-api PrivateLink endpoint plus TLS setup — paid before the callee is even
 * reached. So every cold Lambda's FIRST authorization probe exceeded the budget by
 * >2x and denied a legitimate owner, while every subsequent one on that instance
 * succeeded. That is exactly the reported pattern: an attempt at 11:54 UTC worked, and
 * three attempts at 11:55-11:57 (new cold environments) all failed.
 *
 * The old number was also internally inconsistent with the platform's own latency record, which already
 * documented ~1550ms p99.9 for a cold callee — a timeout set below the worst case
 * it acknowledges is a timeout that fires on healthy requests.
 *
 * 2500ms = the measured 1802ms + ~40% headroom, so a first call has room to complete
 * without the budget sitting so close to observed p99.9 that normal variance trips it.
 * It is still 11.6x tighter than the 29s gateway timeout that would otherwise bound
 * these calls, which is the property that mattered in the first place (see above).
 *
 * WHAT THIS COSTS, stated plainly rather than waved away: a genuinely hung callee now
 * holds a caller for 2500ms instead of 800ms, so a brownout ties up ~3x the
 * concurrency per in-flight request. That is a real regression in load-shedding
 * behaviour, accepted deliberately because the alternative in force was DENYING
 * LEGITIMATE USERS on every cold start — a correctness failure beats a capacity one.
 * It also no longer leaves room for timeout + one retry inside a 2s page budget; a
 * retry here would need 2500ms + jitter + 2500ms and a page budget to match.
 *
 * THE BETTER FIX, NOT TAKEN HERE: these functions sit in private subnets with no NAT,
 * so the VPC buys no egress isolation, and every dependency (DynamoDB, EventBridge,
 * Bedrock, the gateway itself) is a public AWS endpoint reached over TLS + SigV4.
 * `notify` and `user-access` already run OUTSIDE the VPC for precisely this reason.
 * Moving the API-serving functions out removes the PrivateLink first-call cost
 * entirely rather than budgeting for it, and would let this number go back down.
 * Deferred as a topology change on a live stack.
 *
 * Raising this further is a load-shedding decision, not a tuning knob: every extra
 * 100ms is 100ms of held concurrency per in-flight request during a brownout. Derive
 * it from a measurement, as above — do not round it up because something timed out.
 *
 * ── OVERRIDABLE VIA `EAST_WEST_TIMEOUT_MS` ──
 * Settable per environment so this can be tuned WITHOUT rebuilding and redeploying six
 * service bundles — which is what changing the constant alone costs. The default below
 * is what ships; the env var is for responding to a measurement in a live environment.
 */

/** The value that ships when nothing overrides it. Derived above from measurement. */
export const EAST_WEST_TIMEOUT_DEFAULT_MS = 2500;

/**
 * Hard bounds on any override. An env var is operator input, and this one can only make
 * things worse in two directions, so neither is left to chance:
 *
 *   FLOOR — below the measured 1802ms first-call cost the override REINTRODUCES the exact
 *   bug this was raised to fix (a cold caller aborting its own authorization probe and
 *   telling an owner they are not the owner). 200ms is permitted rather than 1802ms
 *   because a topology WITHOUT the PrivateLink hop — the services moved out of the VPC —
 *   legitimately wants a much tighter bound, and forbidding that would hard-code today's
 *   topology into a floor. Anything under the measured cost is warned about instead.
 *
 *   CEILING — 10s, because the whole point of this module is that a hung dependency must
 *   not hold a Lambda open. Functions have a 15s timeout (Globals) and the gateway 29s,
 *   so a value at or above those would silently restore the unbounded-wait failure mode
 *   while LOOKING like a configured timeout. That is worse than no override at all.
 */
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 10_000;

/** The measured first-call PrivateLink cost — the number a lower override is risking. */
const MEASURED_FIRST_CALL_MS = 1802;

function resolveTimeoutMs(): number {
  const raw = process.env.EAST_WEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return EAST_WEST_TIMEOUT_DEFAULT_MS;

  // Number() not parseInt(): parseInt("2500abc") is 2500, which would silently accept a
  // typo'd value. A malformed timeout must fall back to the tested default, loudly.
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.warn(
      "[east-west] EAST_WEST_TIMEOUT_MS is not an integer — using the default",
      { value: raw, defaultMs: EAST_WEST_TIMEOUT_DEFAULT_MS }
    );
    return EAST_WEST_TIMEOUT_DEFAULT_MS;
  }
  if (parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    console.warn(
      "[east-west] EAST_WEST_TIMEOUT_MS out of the permitted range — using the default",
      {
        value: parsed,
        minMs: MIN_TIMEOUT_MS,
        maxMs: MAX_TIMEOUT_MS,
        defaultMs: EAST_WEST_TIMEOUT_DEFAULT_MS,
      }
    );
    return EAST_WEST_TIMEOUT_DEFAULT_MS;
  }
  if (parsed <= MEASURED_FIRST_CALL_MS) {
    // Accepted — it may be correct for a topology without the PrivateLink hop — but it
    // is the configuration that caused the original incident, so it does not pass
    // silently.
    console.warn(
      "[east-west] EAST_WEST_TIMEOUT_MS is at or below the MEASURED first-call cost; " +
        "cold callers may abort their own authorization probes and deny legitimate users",
      { value: parsed, measuredFirstCallMs: MEASURED_FIRST_CALL_MS }
    );
  }
  return parsed;
}

/**
 * Per-attempt deadline for an east-west call, in milliseconds.
 *
 * Resolved ONCE at module load, not per call: Lambda fixes the environment for a
 * container's lifetime, so re-reading per request would buy nothing and would make the
 * bound differ between two calls in the same invocation. See resolveTimeoutMs() for the
 * validation, and the block comment above for where the default comes from.
 */
export const EAST_WEST_TIMEOUT_MS = resolveTimeoutMs();
