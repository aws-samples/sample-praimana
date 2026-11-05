/**
 * ── WHY DID BEDROCK REFUSE? — a bounded answer, safe to put in a metric dimension ──────────
 *
 * The known live failure mode, observed when probing
 * every model in a fresh account:
 *
 *   sonnet-5             403  "Your AWS Marketplace subscription for this model cannot be
 *                             completed at this time"     ⚠ LISTED IS NOT SUBSCRIBED
 *   sonnet-4-6 / 4-5 / 4 404  "Model use case details have not been submitted for this account"
 *   haiku-4-5            answered NORMALLY, then returned that same 404 FOUR MINUTES LATER
 *   3-5-haiku            404  end of life
 *
 * ⚠ THE FOURTH LINE IS WHY A CLASSIFIER EXISTS RATHER THAN A COUNTER. The gate closed mid-session
 * with no deploy. "AI is broken" and "AI is being throttled" and "we pointed at a dead model" need
 * three different responses from a human standing in a room full of participants, and an
 * undifferentiated failure count cannot tell them apart. The reason IS the runbook.
 *
 * ── ⚠ WHY THE MESSAGE IS MATCHED BEFORE THE EXCEPTION NAME ──
 *
 * Both entitlement gates arrive as ORDINARY SDK exceptions — the same `AccessDeniedException` you get
 * from a missing IAM statement, the same 404 you get from a typo in a model id. The exception name
 * therefore cannot distinguish "an administrator must fill in a form on the AWS console" from "fix
 * the policy", which are the two most different remedies on this list. Only the message can, so the
 * message-specific cases are tested first and the name-based ones are the fallback.
 *
 * ── ⚠ AND THE MESSAGE ITSELF IS NEVER EMITTED ──
 *
 * It is read here and discarded. A Bedrock refusal message carries an account id, a role ARN and an
 * action name — the exact disclosure `cli-error-content.ts` exists to keep out of this platform. What
 * leaves this file is one of the constants below and nothing else.
 */

import { UNKNOWN_BEDROCK_REFUSAL } from "@praimana/service-shared";

/**
 * The closed set of reasons. Bounded BY CONSTRUCTION, which is what makes `Reason` a legal metric
 * dimension — a bounded closed set — unlike a message, which is unbounded prose.
 *
 * Each value names WHAT AN OPERATOR MUST DO, not what the SDK called it. `USE_CASE_NOT_SUBMITTED`
 * means "a human fills in the Anthropic form"; `ACCESS_DENIED` means "fix the IAM policy". Naming
 * them both `AccessDeniedException` would be faithful to the SDK and useless at 9am on event day.
 */
export const BEDROCK_FAILURE_REASONS = [
  /** A human must submit the Anthropic use-case form for this account. No deploy will fix it. */
  "USE_CASE_NOT_SUBMITTED",
  /** The model is listed but the Marketplace subscription has not completed. Also not a deploy fix. */
  "SUBSCRIPTION_INCOMPLETE",
  /** The configured model is retired. Point BEDROCK_RATINGS_MODEL_ID at a live one. */
  "MODEL_END_OF_LIFE",
  /** The model or inference profile does not exist in this account/region. Usually a wrong ARN. */
  "MODEL_NOT_FOUND",
  /** IAM refused the call. A policy problem, not an entitlement one. */
  "ACCESS_DENIED",
  /** Provider-side rate limit. Self-clearing; only sustained occurrences matter. */
  "THROTTLED",
  /** The model exists but is not serving yet. Transient. */
  "MODEL_NOT_READY",
  /** Our request was malformed — e.g. the `temperature` field a fake never validated. */
  "VALIDATION",
  /** Connect/socket timeout or an aborted request. The 15s function ceiling is close behind. */
  "TIMEOUT",
  /** Bedrock's own 5xx. Nothing to do but retry. */
  "SERVER_ERROR",
  /** BEDROCK_RATINGS_MODEL_ID, or the guardrail id/version, is unset. A deploy/config fault, and deliberately loud. */
  "CONFIG_MISSING",
  /** The Amazon Bedrock guardrail blocked the input or the reply. Working as designed; a sustained rate is worth a look. */
  "GUARDRAIL_INTERVENED",
  /** The model answered, but not with usable JSON — truncated or prose. Ours to fix, not AWS's. */
  "RESPONSE_INVALID",
] as const;

export type BedrockFailureReason = (typeof BEDROCK_FAILURE_REASONS)[number];

/** Read `name`, `message` and the HTTP status off an unknown throwable without trusting its shape. */
function parts(err: unknown): { name: string; message: string; status: number } {
  const e = (err ?? {}) as {
    name?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return {
    name: typeof e.name === "string" ? e.name : "",
    message: typeof e.message === "string" ? e.message : "",
    status:
      typeof e.$metadata?.httpStatusCode === "number" ? e.$metadata.httpStatusCode : 0,
  };
}

/**
 * Classify a Bedrock failure into one bounded reason.
 *
 * ⚠ NEVER THROWS, and returns `UNKNOWN` rather than guessing. It is called from a `catch` on a path
 * that is already failing; an exception here would replace a diagnosable model error with an opaque
 * one from the observability code. A rising UNKNOWN is itself the signal that a new case is needed.
 */
export function classifyBedrockFailure(err: unknown): BedrockFailureReason | typeof UNKNOWN_BEDROCK_REFUSAL {
  const { name, message, status } = parts(err);
  const text = `${name} ${message}`;

  // ── The two entitlement gates, matched on message because the exception name cannot tell them
  // apart from an ordinary policy or id mistake. These are FIRST because they are the only two a
  // deploy cannot fix, and mistaking either for ACCESS_DENIED sends an operator to edit IAM for an
  // hour while a form sits unsubmitted.
  if (/use case details have not been submitted/i.test(message)) return "USE_CASE_NOT_SUBMITTED";
  if (/marketplace subscription/i.test(message)) return "SUBSCRIPTION_INCOMPLETE";
  if (/end of life|no longer (?:available|supported)|has been (?:retired|deprecated)/i.test(message))
    return "MODEL_END_OF_LIFE";

  // ── Our own failures, thrown by this service rather than raised by the SDK. Matched on the prefix
  // the adapter throws so a truncated or non-JSON answer is not filed as an AWS problem. A guardrail
  // block shares the RESPONSE_INVALID prefix (so the route keeps the snapshot) and is matched first.
  if (/GUARDRAIL_INTERVENED/.test(message)) return "GUARDRAIL_INTERVENED";
  if (/MODEL_RESPONSE_INVALID/.test(message)) return "RESPONSE_INVALID";
  if (/BEDROCK_RATINGS_MODEL_ID is required|BEDROCK_GUARDRAIL_ID and BEDROCK_GUARDRAIL_VERSION are required/.test(message))
    return "CONFIG_MISSING";

  // ── SDK exception names. `name` is set for every service exception and is the reliable field;
  // `status` is the fallback for a transport-layer error that never got a service response.
  if (/^ThrottlingException|^TooManyRequestsException/.test(name) || status === 429)
    return "THROTTLED";
  if (/^ModelNotReadyException/.test(name)) return "MODEL_NOT_READY";
  if (/^AccessDenied/.test(name) || status === 403) return "ACCESS_DENIED";
  if (/^ResourceNotFoundException/.test(name) || status === 404) return "MODEL_NOT_FOUND";
  if (/^ValidationException|^SerializationException/.test(name) || status === 400)
    return "VALIDATION";
  if (/^(?:InternalServerException|ServiceUnavailableException|ModelErrorException)/.test(name) || status >= 500)
    return "SERVER_ERROR";

  // ⚠ TIMEOUT IS LAST AMONG THE MATCHES, not first, and the ordering is deliberate. An abort raised
  // while a REAL refusal was in flight would otherwise be filed as a timeout and send an operator
  // looking for a slow dependency that is actually an entitlement wall.
  if (
    /^(?:AbortError|TimeoutError)$/.test(name) ||
    /TimeoutError|ETIMEDOUT|socket hang up|aborted/i.test(text)
  )
    return "TIMEOUT";

  return UNKNOWN_BEDROCK_REFUSAL;
}
