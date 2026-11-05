import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { emitBedrockRefusal } from "@praimana/service-shared";
import type {
  KnowledgeModelInput,
  MemberAiAssessment,
  RatingAnalyst,
  SummaryModelInput,
} from "./domain.js";
import { classifyBedrockFailure } from "./bedrock-failure.js";
/**
 * ⚠ THE PROMPTS LIVE IN THEIR OWN MODULE NOW, and this import is the only copy this file has.
 *
 * They are also DISCLOSED to the executive who presses Analyze, via
 * `GET /teams/:teamId/ratings/prompts`. Both readers import the same constant, so the string on
 * screen is necessarily the string sent to Bedrock. Do not reintroduce a local copy "for
 * clarity": that is the one change that makes the disclosure able to lie about how a judgement of
 * a person was produced. See ratings-prompts.ts for why this is structural rather than a test.
 */
import { KNOWLEDGE_SYSTEM, SUMMARY_SYSTEM } from "./ratings-prompts.js";

/**
 * Bedrock-backed RatingAnalyst — the ONLY file in this service that turns rating inputs into
 * a model call. Everything else depends on the `RatingAnalyst` port, so tests never bill.
 *
 * ── TWO METHODS, TWO PROMPTS, AND THEY MUST NOT CONVERGE ──
 *
 * `assessKnowledge` reads members' actual messages and produces per-member coaching. Its
 * output is member-only and has no publish path anywhere in the codebase.
 *
 * `summariseTeam` reads five integers per member. Its output is publishable to judges and
 * off-team executives PRECISELY because no message text entered the prompt — it cannot leak
 * what it never saw. That is a property of the input, not a promise the prompt makes, and it
 * is the reason these are separate methods rather than one with a flag: a flag is one wrong
 * argument away from sending chat into the publishable path.
 *
 * ── WHY ConverseCommand, AND NOT InvokeModel OR THE STREAMING VARIANT ──
 *
 * Not streaming: the caller waits for one complete JSON object, so streaming buys nothing and
 * costs correctness — reassembling chunks before `JSON.parse` is a second failure mode for no
 * benefit.
 *
 * Not `InvokeModel`: that carries a model-family-SPECIFIC body. It was written against the
 * Anthropic schema (`anthropic_version`, `max_tokens`, `content: [{type, text}]`), and when
 * the account's usable model turned out to be Amazon Nova the request 400'd —
 * `ValidationException: extraneous key [type] is not permitted`. `Converse` normalises both
 * the request and the response across families, so the only Nova-vs-Anthropic difference left
 * is the model id, which is a template parameter. Verified live against both shapes before
 * this change: Anthropic-shaped `InvokeModel` fails on the profile, `Converse` succeeds.
 *
 * ── TIMEOUTS ARE SET TWICE, ON PURPOSE ──
 *
 * A Bedrock client with no timeouts is a latent defect
 * in a 15-second Lambda: a Bedrock brownout at 30s latency with a 0% error rate would hold
 * the function until the platform killed it, returning an opaque 502. This client sets
 * connect/socket timeouts AND passes the caller's `AbortSignal` per request. The signal alone
 * is not enough — it cannot interrupt a socket that never establishes.
 */

/**
 * The model, or an application inference profile wrapping one.
 *
 * These are two small structured-output tasks, not open-ended reasoning, and this route is
 * reachable by every team on the platform at the end of a workshop — so a cheap, fast tier is
 * the right default and a cost decision made once rather than a surprise on a bill.
 *
 * ── WHY AN INFERENCE PROFILE, NOT A FOUNDATION-MODEL ID ──
 *
 * An account without the Anthropic use-case form submitted cannot invoke ANY Anthropic model
 * directly. Observed when probing each model in such an account:
 *
 *   sonnet-5              403 "Your AWS Marketplace subscription for this model cannot be
 *                             completed at this time"  (listed by list-inference-profiles,
 *                             but LISTED IS NOT SUBSCRIBED)
 *   sonnet-4-6 / 4-5 / 4  404 "Model use case details have not been submitted for this
 *                             account. Fill out the Anthropic use case details form"
 *   haiku-4-5             answered NORMALLY, then began returning the same 404 four minutes
 *                             later — the gate closed mid-session
 *   3-5-haiku             404 end-of-life
 *
 * An APPLICATION INFERENCE PROFILE is the supported way through: one that wraps
 * `amazon.nova-2-lite-v1:0` invokes successfully. Because it is Nova rather
 * than Anthropic, the request/response schema differs — which is exactly why this adapter uses
 * `Converse` (see the class note). Switching back to Anthropic once the use-case form clears is
 * then a PARAMETER change with no code change.
 *
 * ── THERE IS NO DEFAULT, AND THAT IS DELIBERATE ──
 *
 * `BEDROCK_RATINGS_MODEL_ID` is REQUIRED. An application inference profile ARN embeds an
 * ACCOUNT ID and a REGION, so baking one in would compile a dev-only value into an artifact
 * that is promoted unchanged to every other environment — silently wrong everywhere but here,
 * and wrong in the worst way: an AccessDenied naming another account's resource.
 *
 * The alternative — falling back to a foundation-model id — is what the chat path did, and it
 * is how that path ended up hardcoded to a model that is now BOTH legacy-flagged AND
 * use-case-gated, failing on every message with nothing in the template to override it.
 *
 * So a missing value fails LOUDLY, naming the variable — but at CALL TIME, not at construction.
 * `app.ts` builds this eagerly at module scope for both Lambda and local dev, so throwing in the
 * constructor took the whole service down at import: every unrelated AI route, and `pnpm dev`,
 * killed by a config error about a feature nobody was using. Deferring keeps the blast radius to
 * the one route that actually needs a model, which then answers 503 with the previous snapshot
 * intact — the designed behaviour for an unavailable model.
 *
 * The template always passes `RatingsModelId`.
 *
 * ⚠ RE-RUN THE SUMMARY PROBE AFTER CHANGING THE MODEL. How faithfully a model obeys the
 * "never single out an individual" rule is a BEHAVIOURAL property, not a swap: Sonnet 4-5 given
 * per-member rows wrote "one member drove the majority...", and that finding is what forced the
 * aggregated input below. A new model has to be checked against the same requirement.
 */
function requiredModelId(): string {
  const id = process.env.BEDROCK_RATINGS_MODEL_ID?.trim();
  if (!id) {
    throw new Error(
      "BEDROCK_RATINGS_MODEL_ID is required (a Bedrock model id or inference-profile ARN). " +
        "It is account- and region-specific, so there is deliberately no built-in default."
    );
  }
  return id;
}

/** The guardrail every Converse call is evaluated against: an id and a published version. */
export interface GuardrailRef {
  id: string;
  version: string;
}

/**
 * ── EVERY CALL GOES THROUGH AN AMAZON BEDROCK GUARDRAIL, AND THERE IS NO WAY TO SKIP IT ──
 *
 * The user turn carries synced transcript text that originated on participants' machines, so it is
 * untrusted input (indirect prompt injection is the threat). The guardrail evaluates that turn for
 * prompt attacks and harmful content, and the reply for harmful content and PII, before either
 * reaches the route.
 *
 * REQUIRED, with the same fail-closed shape as the model id: a missing value throws at CALL time,
 * naming both variables, so the route answers 503 and the previous snapshot stays intact — rather
 * than a deployment quietly calling the model unguarded. The template always sets both.
 */
function requiredGuardrail(): GuardrailRef {
  const id = process.env.BEDROCK_GUARDRAIL_ID?.trim();
  const version = process.env.BEDROCK_GUARDRAIL_VERSION?.trim();
  if (!id || !version) {
    throw new Error(
      "BEDROCK_GUARDRAIL_ID and BEDROCK_GUARDRAIL_VERSION are required. Model calls are never " +
        "made without an Amazon Bedrock guardrail."
    );
  }
  return { id, version };
}

/**
 * Output cap for the SUMMARY call: 2-4 sentences, so this is generous.
 *
 * Still bounded rather than maxed — a model padding prose cannot become a cost incident.
 */
const SUMMARY_MAX_TOKENS = 1_024;

/**
 * Output cap for the KNOWLEDGE call: ONE assessment, so this is fixed and generous.
 *
 * ── HISTORY, BECAUSE IT EXPLAINS WHY THIS IS NOT A SCALING FORMULA ──
 *
 * This call used to take the whole team and its cap had to scale with member count. That
 * design is gone: batching did not work at any cap. Measured against the live model, 10
 * members returned 1-2 of 10 rows with every score 0, and 25 members failed outright — the
 * INPUT was too large to answer reliably, so a bigger output budget could not fix it.
 *
 * One assessment (rationale + up to 3 strengths + up to 3 improvements) costs roughly 80-100
 * output tokens, so 1,024 is ~10x headroom. `stopReason` is still checked below: a cap can
 * always be wrong for some input, and a truncated assessment must fail loudly rather than
 * arrive with empty coaching in it.
 */
const KNOWLEDGE_MAX_TOKENS = 1_024;

/** Connect and socket bounds. See the note above on why the AbortSignal is not sufficient. */
const CONNECT_TIMEOUT_MS = 2_000;
const SOCKET_TIMEOUT_MS = 10_000;

export class BedrockRatingAnalyst implements RatingAnalyst {
  private readonly client: BedrockRuntimeClient;

  constructor(
    // Undefined ⇒ resolved from the environment on the first call, never at import.
    private readonly modelId?: string,
    client?: BedrockRuntimeClient,
    // Undefined ⇒ resolved from the environment on the first call, like the model id.
    private readonly guardrail?: GuardrailRef
  ) {
    this.client =
      client ??
      new BedrockRuntimeClient({
        region: process.env.AWS_REGION || "us-east-1",
        requestHandler: {
          requestTimeout: SOCKET_TIMEOUT_MS,
          connectionTimeout: CONNECT_TIMEOUT_MS,
        },
      });
  }

  /**
   * ── ⚠ EVERY FAILURE IS COUNTED ON ITS WAY OUT, AND THE ERROR IS RETHROWN UNCHANGED ─────────
   *
   * Without this, a Bedrock entitlement gate closing mid-event is invisible: `AWS/Bedrock`
   * publishes counts for invocations that HAPPEN, and a refusal at the entitlement layer is not this
   * account's invocation. The route already turns the throw into a 503, which the fail-closed counter
   * sees — but that says "the AI service refused", not "an administrator must submit a form".
   *
   * ⚠ WRAPPED HERE RATHER THAN INSIDE `invoke`, so the two throws that live OUTSIDE it are covered
   * too: the missing-model-id config error and `summariseTeam`'s empty-summary check. Instrumenting
   * `invoke` alone would have silently missed both, and the config one is the single most likely
   * failure on a fresh deploy.
   *
   * ⚠ RETHROW IS UNCONDITIONAL. Observability must not change behaviour: the caller's retry, its 503
   * and the previous snapshot staying intact are all designed, and swallowing here would publish an
   * empty assessment as though the model had answered.
   */
  private async counted<T>(task: "knowledge" | "summary", run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      emitBedrockRefusal({
        reason: classifyBedrockFailure(err),
        service: "ai",
        // `task` is a property, not a dimension — `Reason` is the only thing an operator alarms on,
        // and which of the two calls failed does not change the remedy. The model id is deliberately
        // ABSENT: an inference-profile ARN embeds an account id.
        properties: { task },
      });
      throw err;
    }
  }

  async assessKnowledge(
    input: KnowledgeModelInput,
    opts: { signal: AbortSignal }
  ): Promise<Omit<MemberAiAssessment, "userId"> & { handle: string }> {
    const parsed = await this.counted("knowledge", () =>
      this.invoke(
        KNOWLEDGE_SYSTEM,
        JSON.stringify(input),
        opts.signal,
        KNOWLEDGE_MAX_TOKENS
      )
    );
    const row = (parsed ?? {}) as Record<string, unknown>;

    /**
     * THE HANDLE IS FORCED BACK TO THE ONE WE ASKED ABOUT, not read from the answer.
     *
     * The request names exactly one member, so any other handle in the response is a
     * hallucination — and if it were passed through, the route's `userFor` lookup would drop
     * the row and that member would silently vanish from their own team's coaching. Trusting
     * our own input is strictly safer than trusting the model to echo it.
     *
     * A MISMATCH IS STILL LOGGED, because a model answering about M7 when asked about M3 is a
     * prompt or model problem worth seeing rather than papering over.
     */
    const echoed = typeof row.handle === "string" ? row.handle : "";
    if (echoed && echoed !== input.handle) {
      console.warn("[ratings] model echoed a different handle than requested", {
        requested: input.handle,
        echoed,
      });
    }

    // Shape only. The ROUTE clamps the score and caps the lists — the authority on what
    // becomes a stored row belongs there, next to the data it is checked against.
    return {
      handle: input.handle,
      aiKnowledgeScore: Number(row.aiKnowledgeScore ?? 0),
      rationale: String(row.rationale ?? ""),
      strengths: Array.isArray(row.strengths) ? row.strengths.map(String) : [],
      improvements: Array.isArray(row.improvements)
        ? row.improvements.map(String)
        : [],
    };
  }

  async summariseTeam(
    input: SummaryModelInput,
    opts: { signal: AbortSignal }
  ): Promise<string> {
    return this.counted("summary", async () => {
      const parsed = await this.invoke(
        SUMMARY_SYSTEM,
        JSON.stringify(input),
        opts.signal,
        SUMMARY_MAX_TOKENS
      );
      const summary = (parsed as { teamSummary?: unknown }).teamSummary;
      if (typeof summary !== "string" || !summary.trim()) {
        // Thrown, never defaulted to "". An empty string would be stored and published as a
        // summary, which is worse than a failure the caller can retry.
        throw new Error("MODEL_RESPONSE_INVALID: teamSummary missing");
      }
      return summary.trim();
    });
  }

  /** One invoke, one JSON object out. Throws on anything unparseable. */
  private async invoke(
    system: string,
    userJson: string,
    signal: AbortSignal,
    maxTokens: number
  ): Promise<unknown> {
    const modelId = this.modelId || requiredModelId();
    const guardrail = this.guardrail ?? requiredGuardrail();
    const res = await this.client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: "user", content: [{ text: userJson }] }],
        // NO `temperature`. Not an omission — some models REJECT it outright:
        //   ValidationException: `temperature` is deprecated for this model
        // A 400, on every single call. Sixteen unit tests against an injected client passed
        // while this was present, because a fake never validates a request body; only a live
        // invoke found it. Do not reintroduce it as a "tuning knob".
        inferenceConfig: { maxTokens },
        // The system prompt is ours and is not evaluated; the user turn (the transcript-derived
        // JSON) and the reply are. Trace stays off so no guardrail assessment, which can quote
        // the input, is returned into this function's logs.
        guardrailConfig: {
          guardrailIdentifier: guardrail.id,
          guardrailVersion: guardrail.version,
          trace: "disabled",
        },
      }),
      { abortSignal: signal }
    );

    /**
     * A GUARDRAIL BLOCK IS AN UNUSABLE ANSWER, NOT AN OUTAGE. The reply is the guardrail's blocked
     * message rather than the JSON asked for, so it is refused exactly like a truncated or non-JSON
     * reply: under the `MODEL_RESPONSE_INVALID` prefix the route turns into a 502 that keeps the
     * previous snapshot. The `GUARDRAIL_INTERVENED` marker is what the refusal metric keys on, so an
     * operator can tell "the guardrail blocked this team's input" from "the model answered badly".
     */
    if (res.stopReason === "guardrail_intervened") {
      throw new Error("MODEL_RESPONSE_INVALID: GUARDRAIL_INTERVENED (stopReason=guardrail_intervened)");
    }

    /**
     * TRUNCATION IS A FAILURE, NOT A RESULT — checked before the body is even read.
     *
     * `max_tokens` means the model was cut off mid-sentence. The remaining JSON may still
     * parse (an array closed by luck, an object missing its tail) and would then be stored as
     * a considered assessment with empty rationales. Measured at 25 members with a flat
     * 2,048-token cap: 25/25 rows came back hollow. Refusing here is what turns that into a
     * retryable 502 that leaves the previous snapshot intact.
     */
    if (res.stopReason === "max_tokens") {
      throw new Error(
        `MODEL_RESPONSE_INVALID: truncated at maxTokens=${maxTokens} (stopReason=max_tokens)`
      );
    }

    // Converse normalises the response too, so this reads the same regardless of family.
    const raw = (res.output?.message?.content ?? [])
      .map((b) => b.text ?? "")
      .join("")
      .trim();

    // Tolerate a fenced block, because models emit one despite instructions — but do NOT
    // hunt for JSON anywhere in prose. A regex scan for the first `{` would happily parse a
    // fragment out of an apology and treat it as an assessment.
    const unfenced = raw.startsWith("```")
      ? raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
      : raw;

    try {
      return JSON.parse(unfenced);
    } catch {
      throw new Error("MODEL_RESPONSE_INVALID: not JSON");
    }
  }
}
