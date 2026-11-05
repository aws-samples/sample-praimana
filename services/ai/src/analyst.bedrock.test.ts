import { describe, it, expect, vi } from "vitest";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockRatingAnalyst } from "./analyst.bedrock.js";

/**
 * THE BEDROCK ANALYST — the one billable dependency in this service's ratings path.
 *
 * No test here reaches Bedrock. The client is injected, so what is under test is the two
 * things this adapter is actually responsible for: WHAT IT SENDS (one non-streaming invoke,
 * two different system prompts, bounded tokens, the caller's abort signal) and HOW IT READS
 * WHAT COMES BACK (strictly, refusing rather than defaulting).
 *
 * ── WHY THE PROMPT ASSERTIONS ARE NOT COSMETIC ──
 *
 * The summary prompt is the one whose output reaches a judge. Two properties of it are load
 * bearing: it must be a DIFFERENT prompt from the knowledge one (a single prompt with a flag
 * is one wrong argument away from feeding chat into the publishable path), and it must tell
 * the model it cannot see message text (a model given five integers will otherwise narrate
 * motives it has no evidence for). Both are asserted below.
 */

/**
 * Captures the command sent, and replies with a canned CONVERSE envelope.
 *
 * `{output: {message: {content: [{text}]}}}` — Converse's normalised shape, not
 * InvokeModel's `{content: [{type, text}]}`. The adapter moved to Converse because the
 * account's usable model is Nova, whose InvokeModel body/response schema differs from
 * Anthropic's; Converse is identical across both families, which is the whole point.
 */
function stubClient(text: string | (() => never)) {
  const sent: Array<{ input: Record<string, unknown>; opts: unknown }> = [];
  const client = {
    send: vi.fn(async (cmd: { input: Record<string, unknown> }, opts?: unknown) => {
      sent.push({ input: cmd.input, opts });
      if (typeof text === "function") text();
      return { output: { message: { role: "assistant", content: [{ text }] } } };
    }),
  } as unknown as BedrockRuntimeClient;
  return { client, sent };
}

/** A guardrail reference for tests. Every real call carries one; the template always sets it. */
const TEST_GUARDRAIL = { id: "test-guardrail", version: "1" };

const analyst = (client: BedrockRuntimeClient) =>
  new BedrockRatingAnalyst("test-model", client, TEST_GUARDRAIL);

/**
 * The Converse request, read through one accessor so the assertions below stay readable.
 *
 * Converse takes typed fields rather than a JSON-string body, so `system` is an ARRAY of
 * blocks and the token cap lives under `inferenceConfig`. `temperature` is surfaced here
 * ONLY so a test can assert it is absent — some models reject it outright.
 */
const body = (sent: { input: Record<string, unknown> }) =>
  sent.input as unknown as {
    system: Array<{ text: string }>;
    messages: Array<{ role: string; content: Array<{ text: string }> }>;
    inferenceConfig: { maxTokens: number; temperature?: number };
  };

/** The single system prompt string, joined from Converse's block array. */
const systemText = (sent: { input: Record<string, unknown> }) =>
  body(sent)
    .system.map((b) => b.text)
    .join("");

/** ONE member per call — see KnowledgeModelInput for the measurements that forced this. */
const KNOWLEDGE_IN = {
  handle: "M1",
  aiMessages: ["refactor this"],
  teamMessages: ["on it"],
};
/** TEAM TOTALS ONLY — no per-member rows exist in this input by design. */
const SUMMARY_IN = {
  memberCount: 3,
  totals: {
    tasksCreated: 1,
    tasksCompleted: 2,
    messagesSent: 3,
    commitsPushed: 4,
    aiThreadsShared: 5,
      aiTurns: 5,
  },
  distribution: "somewhat uneven" as const,
};
const signal = () => ({ signal: new AbortController().signal });

const OK_KNOWLEDGE = JSON.stringify({
  handle: "M1",
  aiKnowledgeScore: 71,
  rationale: "Iterates rather than restating.",
  strengths: ["gives context"],
  improvements: ["ask for alternatives first"],
});
const OK_SUMMARY = JSON.stringify({ teamSummary: "The team completed most of what it opened." });

describe("what it sends", () => {
  it("uses a NON-streaming invoke — one JSON object, so streaming buys nothing", async () => {
    // The conversation path streams because a human watches tokens arrive. Here the caller
    // waits for a complete object, and reassembling chunks before JSON.parse would be a
    // second failure mode for no benefit.
    const { client, sent } = stubClient(OK_SUMMARY);

    await analyst(client).summariseTeam(SUMMARY_IN, signal());

    expect(sent[0].input).not.toHaveProperty("responseStream");  // nosemgrep: no-stringify-keys
    expect(sent[0].input.modelId).toBe("test-model");  // nosemgrep: no-stringify-keys
  });

  it("evaluates every call against the Amazon Bedrock guardrail, with trace off", async () => {
    // Both prompts carry transcript-derived text, so neither may reach the model unguarded.
    const expected = {
      guardrailIdentifier: "test-guardrail",
      guardrailVersion: "1",
      trace: "disabled",
    };

    const summary = stubClient(OK_SUMMARY);
    await analyst(summary.client).summariseTeam(SUMMARY_IN, signal());
    expect(summary.sent[0].input.guardrailConfig).toEqual(expected);  // nosemgrep: no-stringify-keys

    const knowledge = stubClient(OK_KNOWLEDGE);
    await analyst(knowledge.client).assessKnowledge(KNOWLEDGE_IN, signal());
    expect(knowledge.sent[0].input.guardrailConfig).toEqual(expected);  // nosemgrep: no-stringify-keys
  });

  it("refuses to call the model at all without a guardrail configured", async () => {
    const saved = [process.env.BEDROCK_GUARDRAIL_ID, process.env.BEDROCK_GUARDRAIL_VERSION];
    delete process.env.BEDROCK_GUARDRAIL_ID;
    delete process.env.BEDROCK_GUARDRAIL_VERSION;
    try {
      const { client, sent } = stubClient(OK_SUMMARY);
      await expect(
        new BedrockRatingAnalyst("test-model", client).summariseTeam(SUMMARY_IN, signal())
      ).rejects.toThrow(/BEDROCK_GUARDRAIL_ID and BEDROCK_GUARDRAIL_VERSION are required/);
      expect(sent, "no request may be sent unguarded").toHaveLength(0);
    } finally {
      if (saved[0] !== undefined) process.env.BEDROCK_GUARDRAIL_ID = saved[0];
      if (saved[1] !== undefined) process.env.BEDROCK_GUARDRAIL_VERSION = saved[1];
    }
  });

  it("reads the guardrail from the environment when none is injected", async () => {
    const saved = [process.env.BEDROCK_GUARDRAIL_ID, process.env.BEDROCK_GUARDRAIL_VERSION];
    process.env.BEDROCK_GUARDRAIL_ID = "env-guardrail";
    process.env.BEDROCK_GUARDRAIL_VERSION = "7";
    try {
      const { client, sent } = stubClient(OK_SUMMARY);
      await new BedrockRatingAnalyst("test-model", client).summariseTeam(SUMMARY_IN, signal());
      expect(sent[0].input.guardrailConfig).toMatchObject({  // nosemgrep: no-stringify-keys
        guardrailIdentifier: "env-guardrail",
        guardrailVersion: "7",
      });
    } finally {
      if (saved[0] === undefined) delete process.env.BEDROCK_GUARDRAIL_ID;
      else process.env.BEDROCK_GUARDRAIL_ID = saved[0];
      if (saved[1] === undefined) delete process.env.BEDROCK_GUARDRAIL_VERSION;
      else process.env.BEDROCK_GUARDRAIL_VERSION = saved[1];
    }
  });

  it("passes the caller's AbortSignal to send()", async () => {
    // The route's RATING_MODEL_TIMEOUT_MS is enforced through this signal. Without it the
    // route's timeout would fire while the request kept running, and the Lambda would be held
    // until the platform killed it.
    const { client, sent } = stubClient(OK_SUMMARY);
    const controller = new AbortController();

    await analyst(client).summariseTeam(SUMMARY_IN, { signal: controller.signal });

    expect((sent[0].opts as { abortSignal?: AbortSignal }).abortSignal).toBe(controller.signal);  // nosemgrep: no-stringify-keys
  });

  it("bounds max_tokens", async () => {
    const { client, sent } = stubClient(OK_SUMMARY);
    await analyst(client).summariseTeam(SUMMARY_IN, signal());
    expect(body(sent[0]).inferenceConfig.maxTokens).toBeLessThanOrEqual(4096);  // nosemgrep: no-stringify-keys
    // Rejected outright by some models; asserted absent rather than merely unset.
    expect(body(sent[0]).inferenceConfig.temperature).toBeUndefined();  // nosemgrep: no-stringify-keys
  });

  it("sends TWO DIFFERENT system prompts — not one prompt with a flag", async () => {
    // The separation is the safety property. A single prompt parameterised by audience is one
    // wrong argument away from sending message text into the publishable path.
    const { client, sent } = stubClient(OK_KNOWLEDGE);
    const a = analyst(client);

    await a.assessKnowledge(KNOWLEDGE_IN, signal());
    const { client: c2, sent: s2 } = stubClient(OK_SUMMARY);
    await analyst(c2).summariseTeam(SUMMARY_IN, signal());

    expect(systemText(sent[0])).not.toBe(systemText(s2[0]));  // nosemgrep: no-stringify-keys
  });

  it("the summary call carries NO per-member row — the fix a live probe forced", async () => {
    /**
     * THE REGRESSION THIS PINS. The summary input originally carried one row per member under
     * an opaque `M1..Mn` handle, reasoning that a model which never sees a name cannot name
     * anyone. A live Bedrock invoke disproved it: given two rows it wrote "one member drove
     * the majority of messaging, commits, and AI-assisted work, while the other contributed a
     * smaller share". Nobody named, rule broken — in a small team that identifies a person,
     * and this is the one output a judge can read.
     *
     * A firmer prompt is not enforcement, because instruction-following is probabilistic. So
     * the capability is removed from the input instead. If `members` ever reappears in this
     * payload, that guarantee is gone and this test fails.
     */
    const { client, sent } = stubClient(OK_SUMMARY);

    await analyst(client).summariseTeam(SUMMARY_IN, signal());

    const turn = JSON.parse(body(sent[0]).messages[0].content[0].text);  // nosemgrep: no-stringify-keys
    expect(turn).not.toHaveProperty("members");
    expect(Object.keys(turn).sort()).toEqual(["distribution", "memberCount", "totals"]);
    // Not even a handle: there is no per-person axis in the payload at all.
    expect(body(sent[0]).messages[0].content[0].text).not.toMatch(/\bM[0-9]+\b/);  // nosemgrep: no-stringify-keys
  });

  it("uses a FIXED, bounded token budget for both calls", async () => {
    /**
     * NO LONGER A SCALING FORMULA, because the call no longer batches.
     *
     * It used to take the whole team, so its cap had to scale with member count — and a flat
     * 2,048 truncated a 25-member response into 25 rows with EMPTY rationales. Batching was
     * then removed entirely: the INPUT was too large to answer reliably at any output cap
     * (10 members returned 1-2 of 10 rows, all scoring 0). One assessment costs ~80-100
     * output tokens, so a fixed 1,024 is ~10x headroom and cannot silently truncate.
     */
    const k = stubClient(OK_KNOWLEDGE);
    await analyst(k.client).assessKnowledge(KNOWLEDGE_IN, signal());
    const kCap = body(k.sent[0]).inferenceConfig.maxTokens;  // nosemgrep: no-stringify-keys
    expect(kCap).toBeGreaterThanOrEqual(512);
    expect(kCap).toBeLessThanOrEqual(2_048);

    const sum = stubClient(OK_SUMMARY);
    await analyst(sum.client).summariseTeam(SUMMARY_IN, signal());
    expect(body(sum.sent[0]).inferenceConfig.maxTokens).toBeLessThanOrEqual(1_024);  // nosemgrep: no-stringify-keys
  });

  it("TELLS the summary model it cannot see message text", async () => {
    // Five integers and no caveat produces confident prose about motives and quality — and
    // that fabrication is what a judge would read.
    const { client, sent } = stubClient(OK_SUMMARY);
    await analyst(client).summariseTeam(SUMMARY_IN, signal());

    const system = systemText(sent[0]);  // nosemgrep: no-stringify-keys
    expect(system).toMatch(/TEAM-WIDE TOTALS/);
    expect(system).toMatch(/NO access to what anyone wrote/);
    expect(system, "and no per-person figures either").toMatch(/NO per-person figures/);
    expect(system, "must not let it single out a person").toMatch(/NEVER refer to an individual/);
    // Both AI figures reach the model, so the prompt must say which one is real — otherwise a
    // model handed a button-press count treats it as evidence of assistant use.
    expect(system).toMatch(/AI assistant turns/);
    expect(system, "turns beat shares when they disagree").toMatch(/trust turns/i);
    // Names the paraphrase failure a live probe actually produced, not just the general rule.
    expect(system).toMatch(/one member did most of the work/);
  });

  it("sends ONLY the given payload as the user turn — no name, no text, in the summary call", async () => {
    const { client, sent } = stubClient(OK_SUMMARY);
    await analyst(client).summariseTeam(SUMMARY_IN, signal());

    const turn = body(sent[0]).messages[0].content[0].text;  // nosemgrep: no-stringify-keys
    expect(JSON.parse(turn)).toEqual(SUMMARY_IN);
    expect(turn).not.toContain("refactor this");
  });

  it("instructs the knowledge model not to compare people or quote them", async () => {
    // Teammates read each other's assessments, so comparative prose ("weaker than the
    // others") and verbatim quotes are the two outputs this must never produce.
    const { client, sent } = stubClient(OK_KNOWLEDGE);
    await analyst(client).assessKnowledge(KNOWLEDGE_IN, signal());

    const system = systemText(sent[0]);  // nosemgrep: no-stringify-keys
    expect(system).toMatch(/NEVER compare people/);
    expect(system).toMatch(/NEVER quote a message/);
  });
});

describe("how it reads what comes back — strictly, and it refuses rather than defaults", () => {
  it("parses a well-formed knowledge response", async () => {
    const { client } = stubClient(OK_KNOWLEDGE);
    const row = await analyst(client).assessKnowledge(KNOWLEDGE_IN, signal());
    expect(row).toEqual({
      handle: "M1",
      aiKnowledgeScore: 71,
      rationale: "Iterates rather than restating.",
      strengths: ["gives context"],
      improvements: ["ask for alternatives first"],
    });
  });

  it("FORCES the handle back to the one requested, ignoring what the model echoed", async () => {
    // The request names exactly one member, so a different handle in the answer is a
    // hallucination. Passing it through would make the route's userFor lookup drop the row and
    // that member would silently vanish from their own team's coaching.
    const { client } = stubClient(
      JSON.stringify({ handle: "M99", aiKnowledgeScore: 50, rationale: "r" })
    );

    const row = await analyst(client).assessKnowledge(KNOWLEDGE_IN, signal());

    expect(row.handle).toBe("M1");
  });

  it("tolerates a ```json fence, because models emit one despite instructions", async () => {
    const { client } = stubClient("```json\n" + OK_SUMMARY + "\n```");
    await expect(analyst(client).summariseTeam(SUMMARY_IN, signal())).resolves.toContain(
      "completed most"
    );
  });

  it("does NOT hunt for JSON inside prose", async () => {
    // A regex scan for the first `{` would happily lift a fragment out of an apology and
    // treat it as an assessment. Refusing is the honest outcome — the route keeps the
    // previous snapshot and answers 503.
    const { client } = stubClient(
      'I cannot do that, but here is an example: {"teamSummary":"all good"}'
    );
    await expect(analyst(client).summariseTeam(SUMMARY_IN, signal())).rejects.toThrow(
      /MODEL_RESPONSE_INVALID/
    );
  });

  it("THROWS on an empty teamSummary rather than returning \"\"", async () => {
    // An empty string would be stored and published AS a summary — worse than a failure the
    // caller can retry.
    const { client } = stubClient(JSON.stringify({ teamSummary: "   " }));
    await expect(analyst(client).summariseTeam(SUMMARY_IN, signal())).rejects.toThrow(
      /teamSummary missing/
    );
  });

  it("THROWS when teamSummary is absent or not a string", async () => {
    for (const payload of [{}, { teamSummary: 42 }, { summary: "wrong key" }]) {
      const { client } = stubClient(JSON.stringify(payload));
      await expect(analyst(client).summariseTeam(SUMMARY_IN, signal())).rejects.toThrow(
        /MODEL_RESPONSE_INVALID/
      );
    }
  });

  it("coerces a knowledge response with no recognisable fields rather than throwing", async () => {
    // A shape this layer cannot read still yields a well-formed row with an empty rationale —
    // and the ROUTE is what decides whether that is worth storing. Deliberate: one member's
    // odd answer must not abort a team generation, which is why the route counts failures
    // instead and refuses only when EVERY member fails.
    const { client } = stubClient(JSON.stringify({ unexpected: true }));
    const row = await analyst(client).assessKnowledge(KNOWLEDGE_IN, signal());
    expect(row.handle).toBe("M1");
    expect(row.rationale).toBe("");
    expect(row.aiKnowledgeScore).toBe(0);
  });

  it("THROWS on a non-JSON body", async () => {
    const { client } = stubClient("the team did well!");
    await expect(analyst(client).assessKnowledge(KNOWLEDGE_IN, signal())).rejects.toThrow(
      /not JSON/
    );
  });

  it("coerces a malformed row instead of failing that assessment", async () => {
    // One bad row must not lose the others. The ROUTE is the authority on what becomes a
    // stored assessment — it re-checks handles against the requested set, clamps the score
    // and caps the lists — so this layer only has to hand it a well-shaped object.
    const { client } = stubClient(
      JSON.stringify({ handle: "M1", aiKnowledgeScore: "high", strengths: "nope" })
    );

    const row = await analyst(client).assessKnowledge(KNOWLEDGE_IN, signal());

    expect(row.handle).toBe("M1");
    expect(row.strengths, "a non-array becomes an empty list").toEqual([]);
    expect(row.rationale).toBe("");
  });

  it("REFUSES a response truncated at max_tokens, even when it still parses", async () => {
    /**
     * THE WORST FAILURE MODE IN THIS FILE, because it is silent.
     *
     * `stopReason: max_tokens` means the model was cut off mid-sentence. The remaining text can
     * still be valid JSON — an array that happens to close, an object missing only its tail —
     * and would then be stored and shown as a considered assessment with blank coaching. A live
     * 25-member probe produced exactly that: 25 rows, every rationale empty.
     *
     * So the check is on `stopReason`, NOT on whether the body parses. This stub returns
     * perfectly well-formed JSON and must still be rejected — that is the whole point, and an
     * implementation that only caught parse failures would pass every other test in this file.
     */
    const sent: unknown[] = [];
    const client = {
      send: async (cmd: { input: unknown }) => {
        sent.push(cmd.input);
        return {
          stopReason: "max_tokens",
          output: { message: { content: [{ text: OK_KNOWLEDGE }] } },
        };
      },
    } as unknown as BedrockRuntimeClient;

    await expect(
      analyst(client).assessKnowledge(KNOWLEDGE_IN, signal())
    ).rejects.toThrow(/MODEL_RESPONSE_INVALID.*truncated/);
    // And the same for the publishable summary, which must never be a half sentence.
    await expect(
      analyst(client).summariseTeam(SUMMARY_IN, signal())
    ).rejects.toThrow(/truncated/);
  });

  it("REFUSES a reply the guardrail intervened on, even when the blocked message parses", async () => {
    // A blocked call returns the guardrail's configured message instead of the JSON asked for.
    // Even a message that happens to be valid JSON must not be stored as an assessment.
    const client = {
      send: async () => ({
        stopReason: "guardrail_intervened",
        output: { message: { content: [{ text: OK_KNOWLEDGE }] } },
      }),
    } as unknown as BedrockRuntimeClient;

    await expect(analyst(client).assessKnowledge(KNOWLEDGE_IN, signal())).rejects.toThrow(
      /MODEL_RESPONSE_INVALID: GUARDRAIL_INTERVENED/
    );
    await expect(analyst(client).summariseTeam(SUMMARY_IN, signal())).rejects.toThrow(
      /GUARDRAIL_INTERVENED/
    );
  });

  it("accepts a normal end_turn, and a response with no stopReason at all", async () => {
    // The guard must not reject the healthy case, nor a stub/older API shape that omits the
    // field — only an explicit max_tokens.
    const ok = stubClient(OK_SUMMARY);
    await expect(analyst(ok.client).summariseTeam(SUMMARY_IN, signal())).resolves.toContain(
      "completed most"
    );

    const endTurn = {
      send: async () => ({
        stopReason: "end_turn",
        output: { message: { content: [{ text: OK_SUMMARY }] } },
      }),
    } as unknown as BedrockRuntimeClient;
    await expect(
      analyst(endTurn).summariseTeam(SUMMARY_IN, signal())
    ).resolves.toBeTruthy();
  });

  it("propagates an abort as a rejection", async () => {
    // The route relies on this: a timed-out generation must fail, not return a partial.
    const { client } = stubClient(() => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    await expect(analyst(client).summariseTeam(SUMMARY_IN, signal())).rejects.toThrow(/aborted/);
  });
});
