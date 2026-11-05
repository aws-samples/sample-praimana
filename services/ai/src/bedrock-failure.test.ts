import { describe, it, expect } from "vitest";
import { classifyBedrockFailure, BEDROCK_FAILURE_REASONS } from "./bedrock-failure.js";
import { UNKNOWN_BEDROCK_REFUSAL } from "@praimana/service-shared";

/**
 * ── THE REASON IS THE RUNBOOK ──────────────────────────────────────────────────────────────
 *
 * Every case below is an OBSERVED failure from probing each model or from a real failure, not
 * an invented shape. The classification matters because the remedies are completely different: one
 * needs a form filled in on the AWS console, one needs an IAM edit, one needs waiting. An
 * undifferentiated "Bedrock failed" count cannot tell an operator which room to walk into.
 */

/** An AWS SDK service exception, as the v3 client actually throws it. */
function sdkError(name: string, message: string, httpStatusCode?: number) {
  const err = new Error(message);
  err.name = name;
  if (httpStatusCode !== undefined) {
    (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  }
  return err;
}

describe("classifyBedrockFailure — the two gates no deploy can fix", () => {
  it("names the use-case form, even though the SDK calls it a 404", () => {
    // MEASURED: sonnet-4-6 / 4-5 / 4 all returned this. ⚠ And haiku-4-5 started returning it FOUR
    // MINUTES INTO a working session — an account-wide gate closing with no deploy, which is the
    // failure this whole metric exists for.
    const err = sdkError(
      "ResourceNotFoundException",
      "Model use case details have not been submitted for this account. Fill out the Anthropic use case details form.",
      404
    );
    expect(classifyBedrockFailure(err)).toBe("USE_CASE_NOT_SUBMITTED");
  });

  it("distinguishes an incomplete Marketplace subscription from plain AccessDenied", () => {
    // MEASURED on sonnet-5: LISTED IS NOT SUBSCRIBED. It arrives as a 403, so a status-only
    // classifier would file it as an IAM problem and send someone editing policies for an hour.
    const err = sdkError(
      "AccessDeniedException",
      "Your AWS Marketplace subscription for this model cannot be completed at this time",
      403
    );
    expect(classifyBedrockFailure(err)).toBe("SUBSCRIPTION_INCOMPLETE");
    // The control case: same exception, same status, different remedy.
    expect(
      classifyBedrockFailure(
        sdkError("AccessDeniedException", "User is not authorized to perform bedrock:InvokeModel", 403)
      )
    ).toBe("ACCESS_DENIED");
  });

  it("recognises an end-of-life model", () => {
    // MEASURED on 3-5-haiku.
    expect(
      classifyBedrockFailure(
        sdkError("ValidationException", "This model has reached end of life and is no longer available", 400)
      )
    ).toBe("MODEL_END_OF_LIFE");
  });
});

describe("classifyBedrockFailure — this service's own faults, not AWS's", () => {
  it("files a truncated answer as RESPONSE_INVALID rather than a Bedrock problem", () => {
    // Measured at 25 members with a flat 2,048-token cap: 25/25 rows came back hollow. That is our
    // prompt/cap design, and blaming Bedrock for it would send an operator to the wrong place.
    expect(
      classifyBedrockFailure(
        new Error("MODEL_RESPONSE_INVALID: truncated at maxTokens=1024 (stopReason=max_tokens)")
      )
    ).toBe("RESPONSE_INVALID");
    expect(classifyBedrockFailure(new Error("MODEL_RESPONSE_INVALID: not JSON"))).toBe(
      "RESPONSE_INVALID"
    );
    // A guardrail block shares the RESPONSE_INVALID prefix (so the route keeps the snapshot) but
    // is its own reason, matched first.
    expect(
      classifyBedrockFailure(
        new Error("MODEL_RESPONSE_INVALID: GUARDRAIL_INTERVENED (stopReason=guardrail_intervened)")
      )
    ).toBe("GUARDRAIL_INTERVENED");
    expect(
      classifyBedrockFailure(
        new Error("BEDROCK_GUARDRAIL_ID and BEDROCK_GUARDRAIL_VERSION are required.")
      )
    ).toBe("CONFIG_MISSING");
  });

  it("names a missing model id as CONFIG_MISSING — the likeliest fresh-deploy failure", () => {
    expect(
      classifyBedrockFailure(
        new Error(
          "BEDROCK_RATINGS_MODEL_ID is required (a Bedrock model id or inference-profile ARN)."
        )
      )
    ).toBe("CONFIG_MISSING");
  });
});

describe("classifyBedrockFailure — the transient ones", () => {
  it("classifies throttling, both by name and by status", () => {
    expect(classifyBedrockFailure(sdkError("ThrottlingException", "Too many requests", 429))).toBe(
      "THROTTLED"
    );
    // A 429 with an unhelpful name still lands right.
    expect(classifyBedrockFailure(sdkError("Error", "slow down", 429))).toBe("THROTTLED");
  });

  it("classifies timeouts and aborts", () => {
    expect(classifyBedrockFailure(sdkError("TimeoutError", "socket timed out"))).toBe("TIMEOUT");
    expect(classifyBedrockFailure(sdkError("AbortError", "The operation was aborted"))).toBe(
      "TIMEOUT"
    );
  });

  it("⚠ prefers a real refusal over a timeout when a request was aborted mid-flight", () => {
    // The ordering guard. An abort raised while an entitlement refusal was already in flight must not
    // be filed as "a slow dependency" — that sends an operator hunting latency instead of finding a
    // wall. This is the case that decides why TIMEOUT is matched LAST.
    const err = sdkError(
      "AbortError",
      "aborted — Model use case details have not been submitted for this account"
    );
    expect(classifyBedrockFailure(err)).toBe("USE_CASE_NOT_SUBMITTED");
  });

  it("classifies Bedrock's own 5xx as SERVER_ERROR", () => {
    expect(classifyBedrockFailure(sdkError("InternalServerException", "oops", 500))).toBe(
      "SERVER_ERROR"
    );
    expect(classifyBedrockFailure(sdkError("Error", "bad gateway", 503))).toBe("SERVER_ERROR");
  });

  it("classifies the request-shape failure a fake could never catch", () => {
    // Sixteen unit tests passed with `temperature` present because a fake never validates a request
    // body; only a live invoke found it. This is what that failure looks like.
    expect(
      classifyBedrockFailure(
        sdkError("ValidationException", "`temperature` is deprecated for this model", 400)
      )
    ).toBe("VALIDATION");
  });
});

describe("classifyBedrockFailure — never throws, never guesses", () => {
  it("returns UNKNOWN for an unrecognised failure rather than mislabelling it", () => {
    // A rising UNKNOWN is a signal in its own right: it means a NEW failure mode arrived and the
    // classifier needs a case. Guessing would hide that.
    expect(classifyBedrockFailure(new Error("something entirely new"))).toBe(
      UNKNOWN_BEDROCK_REFUSAL
    );
  });

  it("survives anything at all being thrown", () => {
    // It runs inside a catch on an already-failing path. Throwing here would replace a diagnosable
    // model error with an opaque one from the observability code.
    for (const thrown of [undefined, null, "a string", 42, {}, [], new Date(0)]) {
      expect(() => classifyBedrockFailure(thrown)).not.toThrow();
      expect(classifyBedrockFailure(thrown)).toBe(UNKNOWN_BEDROCK_REFUSAL);
    }
  });

  it("only ever returns a value from the closed set — the cardinality contract", () => {
    // `Reason` is a CloudWatch dimension. A value outside this set would be an unbudgeted metric
    // series, and a message leaking into it would be both a disclosure and an unbounded bill.
    const allowed = new Set<string>([...BEDROCK_FAILURE_REASONS, UNKNOWN_BEDROCK_REFUSAL]);
    const samples = [
      sdkError("AccessDeniedException", "no", 403),
      sdkError("ThrottlingException", "no", 429),
      new Error("MODEL_RESPONSE_INVALID: not JSON"),
      new Error("who knows"),
      undefined,
    ];
    for (const s of samples) expect(allowed.has(classifyBedrockFailure(s))).toBe(true);
  });

  it("⚠ never returns the provider's message text", () => {
    // A Bedrock refusal message carries an account id, a role ARN and an action name. The classifier
    // READS it and must not PASS IT ON: what leaves this file is a constant, nothing else.
    const leaky = sdkError(
      "AccessDeniedException",
      "User: arn:aws:sts::123456789012:assumed-role/Admin/alias is not authorized to perform: bedrock:InvokeModel",
      403
    );
    const reason: string = classifyBedrockFailure(leaky);
    expect(reason).toBe("ACCESS_DENIED");
    expect(reason).not.toMatch(/123456789012|arn:aws/);
  });
});
