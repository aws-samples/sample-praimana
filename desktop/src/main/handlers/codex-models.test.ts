// ── ⚠ CODEX'S CATALOGUE IS READ, NOT GUESSED ─────────────────────────────────────────────
//
// The last answer to that question was "no", because there was no way to enumerate them and a list copied
// from a screenshot is a control that lies. These tests exist to keep the new answer honest: the models come
// from `codex app-server`'s own `model/list`, so the parsing must survive the protocol changing under it.
//
// ⚠ THE FIXTURE IS THE REAL RESPONSE from the installed CLI (0.146.1), trimmed. Note the asymmetry it
// captures, which is the whole reason efforts are per-model: GPT-5.6 advertises `max`, GPT-5.4 does not.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../debug-log", () => ({ debugLog: () => {} }));

const {
  normaliseCodexModels,
  findResponse,
  fetchCodexModels,
  configuredCodexModel,
  __resetCodexModelCache,
} = await import("./codex-models");

/** Trimmed from the live `model/list` result. */
const LIVE = {
  data: [
    {
      id: "openai.gpt-5.6-sol",
      model: "openai.gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Latest frontier agentic coding model.",
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" },
      ],
    },
    {
      id: "openai.gpt-5.4",
      model: "openai.gpt-5.4",
      displayName: "GPT-5.4",
      description: "Strong model for everyday coding.",
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
        { reasoningEffort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
        { reasoningEffort: "xhigh", description: "Extra high reasoning depth for complex problems" },
      ],
    },
  ],
};

beforeEach(() => __resetCodexModelCache());

/**
 * ⚠ PARSE WITH NO MACHINE CONFIG, and this is not a convenience. `normaliseCodexModels` defaults to reading
 * the REAL `~/.codex/config.toml`, so a case that omitted the reader would assert against whichever model the
 * developer running the suite happens to have pinned — passing here and failing on someone else's laptop for
 * a reason nothing in the test mentions. Only the cases specifically about config precedence pass a reader.
 */
const parse = (raw: unknown) => normaliseCodexModels(raw, () => "");

describe("⚠ the live catalogue is read faithfully", () => {
  it("keeps each model's own efforts rather than merging them", () => {
    const { models } = parse(LIVE);

    const sol = models.find((m) => m.id === "openai.gpt-5.6-sol")!;
    const older = models.find((m) => m.id === "openai.gpt-5.4")!;

    /**
     * ⚠ THE ASSERTION THAT MATTERS. A single app-wide effort list would offer `max` to GPT-5.4, and the CLI
     * would reject the turn. This is the difference between per-model and global, stated as data.
     */
    expect(sol.efforts.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(older.efforts.map((e) => e.id), "5.4 does not take max").toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("takes each model's own default effort, which differs between them", () => {
    const { models } = parse(LIVE);

    expect(models.find((m) => m.id === "openai.gpt-5.6-sol")!.defaultEffort).toBe("low");
    expect(models.find((m) => m.id === "openai.gpt-5.4")!.defaultEffort).toBe("medium");
  });

  it("uses Codex's display names and its own descriptions", () => {
    const { models } = parse(LIVE);

    expect(models[0].label).toBe("GPT-5.6 Sol");
    expect(models[0].description).toBe("Latest frontier agentic coding model.");
  });

  /**
   * ⚠ THE CONFIGURED MODEL WINS OVER THE CATALOGUE'S FLAG, and the composer proved why: it read "GPT-5.6 Sol
   * default" while `~/.codex/config.toml` pinned `model = "openai.gpt-5.4"`. With no `-m` passed the CLI uses
   * 5.4, so the composer was confidently naming a model that was not answering — the same defect as offering
   * Claude's models to Codex, in miniature. `isDefault` is the PROVIDER's default, not this machine's.
   */
  it("prefers the model this machine has configured", () => {
    const { defaultModel } = normaliseCodexModels(LIVE, () => "openai.gpt-5.4");

    expect(defaultModel).toBe("openai.gpt-5.4");
  });

  it("falls back to the catalogue's flag when nothing is configured", () => {
    expect(normaliseCodexModels(LIVE, () => "").defaultModel).toBe("openai.gpt-5.6-sol");
  });

  /** A configured model the catalogue does not list cannot be shown as a choice. */
  it("ignores a configured model that is not in the catalogue", () => {
    expect(normaliseCodexModels(LIVE, () => "openai.retired").defaultModel).toBe("openai.gpt-5.6-sol");
  });

  /** Hidden models are hidden from Codex's own picker; showing them here would contradict the CLI. */
  it("drops hidden models", () => {
    const withHidden = { data: [...LIVE.data, { model: "openai.internal", hidden: true }] };

    expect(parse(withHidden).models.map((m) => m.id)).not.toContain("openai.internal");
  });
});

describe("⚠ a protocol change degrades instead of breaking", () => {
  it("returns nothing for a response that is not a catalogue", () => {
    for (const bad of [null, undefined, {}, { data: "nope" }, 42, "text"]) {
      expect(parse(bad as unknown).models).toEqual([]);
    }
  });

  it("drops an entry with no usable id and keeps the rest", () => {
    const mixed = { data: [{ displayName: "Nameless" }, LIVE.data[1]] };

    expect(parse(mixed).models.map((m) => m.id)).toEqual(["openai.gpt-5.4"]);
  });

  /** A model with no advertised efforts is still a usable model choice — it just has no effort control. */
  it("keeps a model that advertises no efforts", () => {
    const plain = { data: [{ model: "openai.plain", displayName: "Plain" }] };
    const { models, defaultModel } = parse(plain);

    expect(models[0].efforts).toEqual([]);
    expect(models[0].defaultEffort).toBe("");
    /**
     * ⚠ AND IT IS STILL THE DEFAULT. With nothing flagged `isDefault`, falling back to "" would leave the
     * composer claiming no model was chosen while Codex quietly used one.
     */
    expect(defaultModel).toBe("openai.plain");
  });

  it("ignores a malformed effort entry without losing the good ones", () => {
    const messy = {
      data: [
        {
          model: "openai.x",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }, null, { description: "no id" }, 7],
        },
      ],
    };

    expect(parse(messy).models[0].efforts).toEqual([{ id: "high", description: "" }]);
  });
});

describe("⚠ the reply is found in a stream carrying other traffic", () => {
  /**
   * ⚠ NOT "THE LAST LINE". The app-server pushes unsolicited notifications — a
   * `remoteControl/status/changed` arrived after `initialize` during the probe — so a reader that took the
   * final line, or the first parseable object, would return a notification instead of the catalogue.
   */
  it("picks the response by id, past notifications either side of it", () => {
    const stream = [
      JSON.stringify({ id: 1, result: { codexHome: "/x" } }),
      JSON.stringify({ method: "remoteControl/status/changed", params: { status: "disabled" } }),
      JSON.stringify({ id: 2, result: LIVE }),
      JSON.stringify({ method: "something/else", params: {} }),
    ].join("\n");

    expect(findResponse(stream, 2)).toEqual(LIVE);
  });

  it("skips lines that are not JSON at all", () => {
    const stream = `warning: something\n{"id":2,"result":{"data":[]}}\n`;  // nosemgrep: missing-template-string-indicator

    expect(findResponse(stream, 2)).toEqual({ data: [] });
  });

  it("throws when the id never appears", () => {
    expect(() => findResponse(JSON.stringify({ id: 1, result: {} }), 2)).toThrow(/no response/);
  });

  it("surfaces a JSON-RPC error rather than treating it as an empty catalogue", () => {
    const stream = JSON.stringify({ id: 2, error: { code: -32601, message: "Method not found" } });

    expect(() => findResponse(stream, 2)).toThrow(/Method not found/);
  });
});

describe("⚠ fetching never throws and never blocks forever", () => {
  it("returns an empty catalogue when the CLI cannot be run", async () => {
    const result = await fetchCodexModels({ run: async () => { throw new Error("ENOENT"); } });

    expect(result).toEqual({ models: [], defaultModel: "" });
  });

  it("returns an empty catalogue on a timeout", async () => {
    const result = await fetchCodexModels({
      run: async () => { throw new Error("timed out after 8000ms"); },
    });

    expect(result.models).toEqual([]);
  });

  it("sends initialize, then initialized, then the request — in that order", async () => {
    let seen = "";
    await fetchCodexModels({
      run: async (payload) => {
        seen = payload;
        return JSON.stringify({ id: 2, result: LIVE });
      },
    });

    const lines = seen.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.method)).toEqual(["initialize", "initialized", "model/list"]);
    /**
     * ⚠ `initialize` MUST CARRY `clientInfo`: the schema marks it required, and the probe that omitted it is
     * the reason this is asserted rather than assumed.
     */
    expect(lines[0].params.clientInfo).toMatchObject({ name: expect.any(String), version: expect.any(String) });
    expect(lines[2].id, "the request is answered by id, so it must have one").toBe(2);
  });

  it("caches a good catalogue instead of spawning per composer mount", async () => {
    let calls = 0;
    const run = async () => { calls += 1; return JSON.stringify({ id: 2, result: LIVE }); };

    await fetchCodexModels({ run, now: () => 1000 });
    await fetchCodexModels({ run, now: () => 2000 });

    expect(calls, "the second read came from cache").toBe(1);
  });

  /**
   * ⚠ AN EMPTY ANSWER IS NOT CACHED, and this is a deliberate asymmetry. An empty catalogue usually means
   * the CLI was updating or offline; caching it would keep the picker hidden for ten minutes after Codex
   * started working again, which reads as the feature being broken.
   */
  it("does not cache an empty catalogue", async () => {
    let calls = 0;
    const run = async () => { calls += 1; return JSON.stringify({ id: 2, result: { data: [] } }); };

    await fetchCodexModels({ run, now: () => 1000 });
    await fetchCodexModels({ run, now: () => 1001 });

    expect(calls).toBe(2);
  });

  it("re-reads once the cache has expired", async () => {
    let calls = 0;
    const run = async () => { calls += 1; return JSON.stringify({ id: 2, result: LIVE }); };

    await fetchCodexModels({ run, now: () => 0 });
    await fetchCodexModels({ run, now: () => 11 * 60 * 1000 });

    expect(calls).toBe(2);
  });
});

describe("⚠ reading the configured model out of config.toml", () => {
  /** The real file's shape, top-level keys before any table. */
  const REAL = [
    'model_provider = "amazon-bedrock"',
    'forced_login_method = "api"',
    'model_reasoning_effort = "high"',
    'model = "openai.gpt-5.4"',
    "",
    "[model_providers.amazon-bedrock.aws]",
    'region = "us-east-2"',
  ].join("\n");

  it("finds the top-level model", () => {
    expect(configuredCodexModel(() => REAL)).toBe("openai.gpt-5.4");
  });

  /**
   * ⚠ STOPS AT THE FIRST TABLE, which is not tidiness: a `model = …` inside a provider or profile table is a
   * DIFFERENT setting, and reading it as the default would name a model the CLI is not going to use.
   */
  it("ignores a model key nested inside a table", () => {
    const nested = ['model_provider = "x"', "", "[profiles.other]", 'model = "openai.wrong"'].join("\n");

    expect(configuredCodexModel(() => nested)).toBe("");
  });

  it("returns nothing when the file cannot be read", () => {
    expect(configuredCodexModel(() => { throw new Error("ENOENT"); })).toBe("");
  });

  it("returns nothing when no model is pinned", () => {
    expect(configuredCodexModel(() => 'model_provider = "x"')).toBe("");
  });
});
