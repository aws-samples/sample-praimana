import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockRatingAnalyst } from "./analyst.bedrock.js";
import { BEDROCK_REFUSALS_METRIC, BEDROCK_NAMESPACE } from "@praimana/service-shared";

/**
 * ── CAN THIS PLATFORM GENERATE INSIGHTS RIGHT NOW? ─────────────────────────────────────────
 *
 * The ONLY Bedrock caller this platform owns is the executive-only ratings/summary path, so
 * that is the whole scope of this metric.
 *
 * ⚠ A PARTICIPANT'S OWN ASSISTANT IS NOT COVERED, BY DECISION. The platform does not control which
 * assistant a developer uses — Claude Code on subscription auth, Codex and Kiro never touch Bedrock —
 * so their failures are not Bedrock refusals and not actionable from here. An earlier version of this
 * file tested a `PARTICIPANT_CLI` origin; it was removed with the code.
 */

/** EMF records are written to stdout as JSON, so that is where the assertions read from. */
function captureEmf() {
  const lines: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== "string") continue;
      try {
        const parsed = JSON.parse(arg);
        if (parsed?._aws) lines.push(parsed);
      } catch {
        /* not an EMF line */
      }
    }
  });
  return lines;
}

const refusalRecord = (emf: Array<Record<string, unknown>>) =>
  emf.find((l) => JSON.stringify(l).includes(BEDROCK_REFUSALS_METRIC));

/** A guardrail reference for tests. Every real call carries one; the template always sets it. */
const GUARDRAIL = { id: "test-guardrail", version: "1" };

/** A client whose `send` throws the given error, standing in for a refusing Bedrock. */
function throwingClient(err: unknown) {
  return {
    send: vi.fn(async () => {
      throw err;
    }),
  } as unknown as BedrockRuntimeClient;
}

function sdkError(name: string, message: string, httpStatusCode?: number) {
  const err = new Error(message);
  err.name = name;
  if (httpStatusCode !== undefined) {
    (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  }
  return err;
}

const summaryInput = {
  memberCount: 3,
  tasksCreated: 1,
  tasksCompleted: 1,
  messagesSent: 2,
  commitsPushed: 0,
  conversationsShared: 0,
  aiTurns: 4,
  spread: "even",
} as never;

describe("Bedrock refusals on the insights-generation path", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("counts the use-case gate and RETHROWS unchanged", async () => {
    const emf = captureEmf();
    const err = sdkError(
      "ResourceNotFoundException",
      "Model use case details have not been submitted for this account.",
      404
    );
    const analyst = new BedrockRatingAnalyst("test-model", throwingClient(err), GUARDRAIL);

    // ⚠ THE RETHROW IS PART OF THE CONTRACT. The route turns this into a 503 that leaves the previous
    // snapshot intact; swallowing it to "handle" the metric would publish an empty assessment as
    // though the model had answered.
    await expect(
      analyst.summariseTeam(summaryInput, { signal: new AbortController().signal })
    ).rejects.toThrow(err);

    const record = refusalRecord(emf);
    expect(record, "a refused model call must publish a datapoint").toBeDefined();
    expect(record).toMatchObject({ Reason: "USE_CASE_NOT_SUBMITTED" });
    expect(JSON.stringify(record)).toContain(BEDROCK_NAMESPACE);
  });

  it("covers the knowledge path too, with its own task property", async () => {
    const emf = captureEmf();
    const analyst = new BedrockRatingAnalyst(
      "test-model",
      throwingClient(sdkError("ThrottlingException", "slow down", 429)),
      GUARDRAIL
    );

    await expect(
      analyst.assessKnowledge({ handle: "M1", aiMessages: [], chatMessages: [] } as never, {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();

    expect(refusalRecord(emf)).toMatchObject({ Reason: "THROTTLED", task: "knowledge" });
  });

  it("⚠ counts the two throws that live OUTSIDE `invoke`", async () => {
    // This is why the wrapper sits on the public methods rather than inside `invoke`. Instrumenting
    // `invoke` alone would silently miss both of these, and the config one is the single most likely
    // failure on a fresh deploy.
    //
    // 1. A model that answers, but without the field the summary needs.
    const emf1 = captureEmf();
    const answering = {
      send: vi.fn(async () => ({
        output: { message: { role: "assistant", content: [{ text: '{"nope":1}' }] } },
      })),
    } as unknown as BedrockRuntimeClient;
    await expect(
      new BedrockRatingAnalyst("test-model", answering, GUARDRAIL).summariseTeam(summaryInput, {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/MODEL_RESPONSE_INVALID/);
    expect(refusalRecord(emf1)).toMatchObject({ Reason: "RESPONSE_INVALID", task: "summary" });

    // 2. No model id configured at all — thrown by `requiredModelId`, before any request is built.
    vi.restoreAllMocks();
    const emf2 = captureEmf();
    const previous = process.env.BEDROCK_RATINGS_MODEL_ID;
    delete process.env.BEDROCK_RATINGS_MODEL_ID;
    try {
      await expect(
        // Undefined modelId ⇒ resolved from the environment at call time.
        new BedrockRatingAnalyst(undefined, throwingClient(new Error("unreached"))).summariseTeam(
          summaryInput,
          { signal: new AbortController().signal }
        )
      ).rejects.toThrow(/BEDROCK_RATINGS_MODEL_ID/);
    } finally {
      if (previous !== undefined) process.env.BEDROCK_RATINGS_MODEL_ID = previous;
    }
    expect(refusalRecord(emf2)).toMatchObject({ Reason: "CONFIG_MISSING" });
  });

  it("counts a missing guardrail as CONFIG_MISSING, and sends nothing", async () => {
    const emf = captureEmf();
    const saved = [process.env.BEDROCK_GUARDRAIL_ID, process.env.BEDROCK_GUARDRAIL_VERSION];
    delete process.env.BEDROCK_GUARDRAIL_ID;
    delete process.env.BEDROCK_GUARDRAIL_VERSION;
    const client = throwingClient(new Error("unreached"));
    try {
      await expect(
        new BedrockRatingAnalyst("test-model", client).summariseTeam(summaryInput, {
          signal: new AbortController().signal,
        })
      ).rejects.toThrow(/BEDROCK_GUARDRAIL_ID/);
    } finally {
      if (saved[0] !== undefined) process.env.BEDROCK_GUARDRAIL_ID = saved[0];
      if (saved[1] !== undefined) process.env.BEDROCK_GUARDRAIL_VERSION = saved[1];
    }
    expect(refusalRecord(emf)).toMatchObject({ Reason: "CONFIG_MISSING" });
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("counts a guardrail block as GUARDRAIL_INTERVENED, not RESPONSE_INVALID", async () => {
    const emf = captureEmf();
    const blocking = {
      send: vi.fn(async () => ({
        stopReason: "guardrail_intervened",
        output: { message: { role: "assistant", content: [{ text: "Blocked." }] } },
      })),
    } as unknown as BedrockRuntimeClient;
    await expect(
      new BedrockRatingAnalyst("test-model", blocking, GUARDRAIL).summariseTeam(summaryInput, {
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/MODEL_RESPONSE_INVALID/);
    expect(refusalRecord(emf)).toMatchObject({ Reason: "GUARDRAIL_INTERVENED", task: "summary" });
  });

  it("⚠ never puts the model id or the provider's message in the record", async () => {
    // An inference-profile ARN embeds an ACCOUNT ID, and a Bedrock refusal message carries a role ARN
    // and an action name. A metric outlives a transcript and is read by more tools than one.
    const emf = captureEmf();
    const arn = "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abc123";
    await expect(
      new BedrockRatingAnalyst(
        arn,
        throwingClient(
          sdkError(
            "AccessDeniedException",
            "User: arn:aws:sts::111122223333:assumed-role/Admin/x is not authorized to perform: bedrock:InvokeModel",
            403
          )
        ),
        GUARDRAIL
      ).summariseTeam(summaryInput, { signal: new AbortController().signal })
    ).rejects.toThrow();

    const serialised = JSON.stringify(refusalRecord(emf));
    expect(serialised).toContain("ACCESS_DENIED");
    expect(serialised).not.toContain("111122223333");
    expect(serialised).not.toContain("arn:aws");
    expect(serialised).not.toContain("not authorized");
  });

  it("does NOT emit when the model answers normally", async () => {
    const emf = captureEmf();
    const ok = {
      send: vi.fn(async () => ({
        output: { message: { role: "assistant", content: [{ text: '{"teamSummary":"Fine."}' }] } },
      })),
    } as unknown as BedrockRuntimeClient;

    await expect(
      new BedrockRatingAnalyst("test-model", ok, GUARDRAIL).summariseTeam(summaryInput, {
        signal: new AbortController().signal,
      })
    ).resolves.toBe("Fine.");
    expect(refusalRecord(emf)).toBeUndefined();
  });
});
