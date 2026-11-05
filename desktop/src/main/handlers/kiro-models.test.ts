// ── ⚠ KIRO'S CATALOGUE, PARSED FROM WHAT THE CLI REALLY PRINTS ────────────────────────────
//
// The fixture below is a VERBATIM excerpt of a real `kiro-cli chat --list-models --format json` response
// (kiro-cli 2.18.1, 21 models). It is not a hand-written approximation of the shape — the whole reason this
// module exists rather than a hardcoded list is that a transcribed catalogue is a guess wearing an
// authoritative face, and a transcribed FIXTURE would reintroduce exactly that at the test layer.
//
// The live handshake has its own file (`kiro-models.live.test.ts`), for the reason recorded in
// `codex-models.live.test.ts`: injecting `run` means every case here would keep passing if the real command
// or flag name were wrong.

import { describe, it, expect, vi } from "vitest";

vi.mock("../debug-log", () => ({ debugLog: () => {} }));

const { fetchKiroModels, normaliseKiroModels, parseCatalogue, __resetKiroModelCache } = await import(
  "./kiro-models"
);

/** Verbatim from the live probe, trimmed to five of the 21 entries. */
const REAL_OUTPUT = JSON.stringify({
  models: [
    {
      model_name: "auto",
      description: "Models chosen by task for optimal usage and consistent quality",
      model_id: "auto",
      context_window_tokens: 1000000,
      rate_multiplier: 1.0,
      rate_unit: "Credit",
    },
    {
      model_name: "claude-opus-5",
      description: "Experimental preview of Claude Opus 5 model with 1M context window",
      model_id: "claude-opus-5",
      context_window_tokens: 1000000,
      rate_multiplier: 2.2,
      rate_unit: "Credit",
    },
    {
      model_name: "claude-haiku-4.5",
      description: "The latest Claude Haiku model",
      model_id: "claude-haiku-4.5",
      context_window_tokens: 200000,
      rate_multiplier: 0.4,
      rate_unit: "Credit",
    },
    {
      model_name: "gpt-5.6-luna",
      description: "Experimental preview of OpenAI GPT 5.6 Luna with 272k context window",
      model_id: "gpt-5.6-luna",
      context_window_tokens: 272000,
      rate_multiplier: 0.1,
      rate_unit: "Credit",
    },
    {
      model_name: "qwen3-coder-next",
      description: "Experimental preview of Qwen3 Coder Next",
      model_id: "qwen3-coder-next",
      context_window_tokens: 256000,
      rate_multiplier: 0.05,
      rate_unit: "Credit",
    },
  ],
  default_model: "auto",
});

describe("normaliseKiroModels — the real payload", () => {
  it("reads every model, in the order Kiro gave them", () => {
    const { models } = normaliseKiroModels(JSON.parse(REAL_OUTPUT));

    expect(models.map((m) => m.id)).toEqual([
      "auto",
      "claude-opus-5",
      "claude-haiku-4.5",
      "gpt-5.6-luna",
      "qwen3-coder-next",
    ]);
  });

  /**
   * ⚠ `model_id` IS WHAT `--model` TAKES, and it is the field whose MEANING is "pass this to the CLI". They
   * happen to equal `model_name` in the observed response, so a parser that read the wrong one would look
   * correct today and break the moment they diverge.
   */
  it("takes the id from model_id and the label from model_name", () => {
    const { models } = normaliseKiroModels({
      models: [{ model_id: "wire-id", model_name: "Pretty Name", description: "d" }],
      default_model: "wire-id",
    });

    expect(models[0].id).toBe("wire-id");
    expect(models[0].label).toBe("Pretty Name");
  });

  it("carries the context window and the relative rate", () => {
    const { models } = normaliseKiroModels(JSON.parse(REAL_OUTPUT));
    const haiku = models.find((m) => m.id === "claude-haiku-4.5")!;

    expect(haiku.contextWindowTokens).toBe(200_000);
    expect(haiku.rateMultiplier).toBe(0.4);
  });

  it("reports Kiro's own default", () => {
    expect(normaliseKiroModels(JSON.parse(REAL_OUTPUT)).defaultModel).toBe("auto");
  });

  /**
   * ⚠ A DEFAULT THAT NAMES NOTHING IN THE LIST MUST NOT BE RETURNED. It would render the picker with no
   * selection while the CLI quietly used something else — the same class of defect as offering Claude's
   * models to Codex, in miniature.
   */
  it("falls back to the first model when the stated default is not in the list", () => {
    const { defaultModel } = normaliseKiroModels({
      models: [{ model_id: "a", model_name: "a" }],
      default_model: "vanished",
    });

    expect(defaultModel).toBe("a");
  });

  it("drops a model with no usable id rather than offering it", () => {
    const { models } = normaliseKiroModels({
      models: [{ description: "no id at all" }, { model_id: "keeper", model_name: "keeper" }],
      default_model: "keeper",
    });

    expect(models.map((m) => m.id)).toEqual(["keeper"]);
  });

  /**
   * ⚠ THE OPTIONAL EXTRAS ARE OPTIONAL. This crosses into a tool that updates itself, so a later version may
   * drop `rate_multiplier` — a model missing it must still be selectable, not silently absent from the picker.
   */
  it("keeps a model that omits the optional fields", () => {
    const { models } = normaliseKiroModels({
      models: [{ model_id: "spartan", model_name: "spartan" }],
      default_model: "spartan",
    });

    expect(models).toHaveLength(1);
    expect(models[0].contextWindowTokens).toBeNull();
    expect(models[0].rateMultiplier).toBeNull();
  });

  it.each([
    ["not an object", 42],
    ["null", null],
    ["no models array", { default_model: "x" }],
    ["models is not an array", { models: "lots" }],
  ])("returns an empty catalogue for %s", (_label, raw) => {
    expect(normaliseKiroModels(raw)).toEqual({ models: [], defaultModel: "" });
  });
});

describe("parseCatalogue — tolerating a CLI that also prints other things", () => {
  it("reads the payload when it is the whole stream", () => {
    expect(parseCatalogue(REAL_OUTPUT)).toMatchObject({ default_model: "auto" });
  });

  /**
   * ⚠ NOT A BARE `JSON.parse`, and this is why. kiro-cli prints update notices; a parser that assumed the
   * stream was pure JSON would report "no models" on the day a notice appeared, and the picker would vanish
   * for a reason no one could trace to a parser.
   */
  it("finds the payload after a preamble line", () => {
    const withNotice = `A new version of kiro-cli is available!\n${REAL_OUTPUT}\n`;
    expect(parseCatalogue(withNotice)).toMatchObject({ default_model: "auto" });
  });

  it("throws when there is no catalogue at all", () => {
    expect(() => parseCatalogue("command not found\n")).toThrow(/no model catalogue/);
  });

  /** A JSON object that is not the catalogue must not be mistaken for one. */
  it("ignores unrelated JSON", () => {
    expect(() => parseCatalogue('{"error":"not logged in"}')).toThrow(/no model catalogue/);
  });
});

describe("fetchKiroModels — bounded, cached, and never throwing", () => {
  it("returns an empty catalogue rather than throwing when the CLI fails", async () => {
    __resetKiroModelCache();
    const value = await fetchKiroModels({
      run: () => Promise.reject(new Error("kiro-cli not found")),
      force: true,
    });

    /* The composer already renders an empty list as "no picker" — the honest degradation. */
    expect(value).toEqual({ models: [], defaultModel: "" });
  });

  /**
   * ⚠ THE CACHE IS LOAD-BEARING HERE, not an optimisation. The real call was MEASURED at 3.2s and 4.6s, and
   * this runs when a chat opens — without the cache, every chat switch would cost a visible stall.
   */
  it("serves a second call from cache without spawning again", async () => {
    __resetKiroModelCache();
    const run = vi.fn().mockResolvedValue(REAL_OUTPUT);

    const first = await fetchKiroModels({ run, now: () => 1_000 });
    const second = await fetchKiroModels({ run, now: () => 2_000 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("re-fetches once the cache has expired", async () => {
    __resetKiroModelCache();
    const run = vi.fn().mockResolvedValue(REAL_OUTPUT);

    await fetchKiroModels({ run, now: () => 0 });
    /* TTL is 30 minutes; an hour later must go back to the CLI. */
    await fetchKiroModels({ run, now: () => 60 * 60 * 1000 });

    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * ⚠ AN EMPTY ANSWER IS NOT CACHED. It usually means the CLI was mid-update or offline, and caching it would
   * keep the picker hidden for half an hour after it started working again.
   */
  it("does not cache an empty catalogue", async () => {
    __resetKiroModelCache();
    const run = vi.fn().mockResolvedValue('{"models":[],"default_model":""}');

    await fetchKiroModels({ run, now: () => 1_000 });
    await fetchKiroModels({ run, now: () => 1_001 });

    expect(run).toHaveBeenCalledTimes(2);
  });
});
