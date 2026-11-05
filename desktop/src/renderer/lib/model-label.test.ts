import { describe, it, expect } from "vitest";
import {
  stripModelPrefix,
  isExtendedContext,
  modelDisplayName,
  modelTagline,
  resolveModel,
  type ModelOption,
} from "./model-label.js";

/**
 * NAMING THE MODEL THE COMPOSER WILL ACTUALLY USE.
 *
 * ── THE BUG THIS FILE EXISTS TO PREVENT ──
 *
 * Read from the real settings on this machine rather than assumed:
 *
 *   model:           "global.anthropic.claude-opus-5[1m]"     ← HAS a routing prefix
 *   availableModels: ["claude-opus-5[1m]", "claude-opus-5", …] ← does NOT
 *
 * So matching the default against the dropdown list by string equality finds NOTHING. The obvious
 * implementation — "look it up, otherwise print it" — therefore swaps one unhelpful label
 * ("Uses CLI default") for a worse one ("global.anthropic.claude-opus-5[1m]") on the machine it was
 * written on. Most tests below are about that single fact.
 */

const options: ModelOption[] = [
  { id: "claude-opus-5[1m]", label: "claude-opus-5 (Extended)", tier: "opus", isExtended: true },
  { id: "claude-opus-5", label: "claude-opus-5", tier: "opus", isExtended: false },
  { id: "claude-sonnet-5", label: "claude-sonnet-5", tier: "sonnet", isExtended: false },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5", tier: "haiku", isExtended: false },
];

describe("stripModelPrefix — the routing prefix", () => {
  it("removes the `global.anthropic.` prefix the live default carries", () => {
    expect(stripModelPrefix("global.anthropic.claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
  });

  it("removes the regional Bedrock prefixes too", () => {
    // The same settings file carries these when the CLI is pointed at a regional endpoint.
    expect(stripModelPrefix("us.anthropic.claude-opus-5")).toBe("claude-opus-5");
    expect(stripModelPrefix("eu.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("leaves an unprefixed id untouched", () => {
    expect(stripModelPrefix("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(stripModelPrefix("opus")).toBe("opus");
  });

  it("⚠ does NOT just take the text after the last dot", () => {
    /**
     * THE ASSERTION THAT PINS THE APPROACH. Model ids contain dots in the wild (`claude-3.5-sonnet`), so a
     * "split on dots, keep the tail" implementation would turn a VERSION into a model name and render
     * "5-sonnet". Only a known `<region>.<vendor>.` shape is removed.
     */
    expect(stripModelPrefix("claude-3.5-sonnet")).toBe("claude-3.5-sonnet");
  });

  it("does not strip a lookalike that is not a vendor prefix", () => {
    // `foo.bar.` is not `<region>.anthropic.`, so it stays — better to show an odd id than to eat part of
    // a name we did not recognise.
    expect(stripModelPrefix("foo.bar.claude-opus-5")).toBe("foo.bar.claude-opus-5");
  });
});

describe("isExtendedContext", () => {
  it("detects the 1M variant, prefixed or not", () => {
    expect(isExtendedContext("claude-opus-5[1m]")).toBe(true);
    expect(isExtendedContext("global.anthropic.claude-opus-5[1m]")).toBe(true);
    expect(isExtendedContext("claude-opus-5")).toBe(false);
  });
});

describe("modelDisplayName", () => {
  it("turns an id into a spoken name", () => {
    expect(modelDisplayName("claude-opus-5")).toBe("Opus 5");
    expect(modelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
  });

  it("dot-joins a dash-joined version", () => {
    // `claude-haiku-4-5` is "Haiku 4.5" when spoken — the id joins with dashes and humans do not.
    expect(modelDisplayName("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelDisplayName("claude-opus-4-6")).toBe("Opus 4.6");
  });

  it("drops the [1m] suffix from the NAME", () => {
    // It is rendered as a separate badge instead, so the name stays short without losing the capability.
    expect(modelDisplayName("claude-opus-5[1m]")).toBe("Opus 5");
    expect(modelDisplayName("global.anthropic.claude-opus-5[1m]")).toBe("Opus 5");
  });

  it("handles a bare tier alias, which is what a project's `model` often holds", () => {
    expect(modelDisplayName("opus")).toBe("Opus");
    expect(modelDisplayName("sonnet")).toBe("Sonnet");
  });

  it("⚠ DEGRADES GRACEFULLY on a model that does not exist yet", () => {
    /**
     * THE REASON THIS IS A PATTERN AND NOT A LOOKUP TABLE. Anthropic ships models faster than this app is
     * released, and a table would render next year's model as a raw id on the day it appears.
     */
    expect(modelDisplayName("claude-opus-6")).toBe("Opus 6");
    expect(modelDisplayName("claude-fable-5")).toBe("Fable 5");
  });

  it("shows an unrecognisable id AS IS rather than mangling it", () => {
    // An unfamiliar id the reader can look up beats a confident guess at a name that does not exist.
    expect(modelDisplayName("some-custom-endpoint-v2")).toBe("some-custom-endpoint-v2");
  });
});

describe("modelTagline", () => {
  it("names the trade-off for each family", () => {
    expect(modelTagline("claude-opus-5")).toBe("Most intelligent");
    expect(modelTagline("claude-sonnet-5")).toBe("Fast & capable");
    expect(modelTagline("claude-haiku-4-5")).toBe("Fastest");
  });

  it("works through a routing prefix", () => {
    // The old inline version tested `selectedModel.includes("opus")` on the raw string, which happened to
    // work — but only because the prefix also contains no other family name. This is explicit.
    expect(modelTagline("global.anthropic.claude-opus-5[1m]")).toBe("Most intelligent");
  });

  it("⚠ matches case-INSENSITIVELY", () => {
    /**
     * This was untested and a mutation proved it: with every fixture id already lowercase, the
     * `.toLowerCase()` could be deleted and the suite still passed. It is not decoration — a settings file
     * is hand-edited, and `Claude-Opus-5` is a thing a person writes.
     */
    expect(modelTagline("Claude-Opus-5")).toBe("Most intelligent");
    expect(modelTagline("GLOBAL.ANTHROPIC.CLAUDE-SONNET-5")).toBe("Fast & capable");
  });

  it("the prefix strip here is DEFENSIVE, not currently load-bearing", () => {
    /**
     * ⚠ STATED HONESTLY BECAUSE A MUTATION SURVIVED. Dropping `stripModelPrefix` from `modelTagline` breaks
     * nothing today: `"global.anthropic.claude-opus-5".includes("opus")` is true either way, so the strip
     * changes no current answer and NO test can legitimately require it.
     *
     * It stays because the match would become wrong the moment a vendor prefix contained a family name — a
     * hypothetical `anthropic-opus.anthropic.claude-sonnet-5` would report "Most intelligent" for a Sonnet.
     * That is a defensive strip, not a tested behaviour, and writing a test that pretended otherwise would
     * be the dishonest option. This test pins the ONLY thing actually decidable: both forms agree.
     */
    expect(modelTagline("global.anthropic.claude-opus-5[1m]")).toBe(
      modelTagline("claude-opus-5[1m]")
    );
  });

  it("returns NULL rather than an empty string for an unknown family", () => {
    // So the caller omits the element instead of rendering an empty one that still occupies its gap.
    expect(modelTagline("some-custom-endpoint-v2")).toBeNull();
  });
});

describe("resolveModel — ⚠ what the composer actually prints", () => {
  it("NAMES THE DEFAULT instead of saying 'Uses CLI default'", () => {
    /**
     * THE HEADLINE REQUIREMENT, and the case that exercises the prefix mismatch end to end: an id with a
     * `global.anthropic.` prefix resolving against a list without one.
     */
    const r = resolveModel("", "global.anthropic.claude-opus-5[1m]", options);

    expect(r.name).toBe("claude-opus-5");
    expect(r.isDefault).toBe(true);
    expect(r.extended, "the 1M badge must show — it survived the prefix").toBe(true);
    expect(r.tagline).toBe("Most intelligent");
  });

  it("⚠ never prints a raw prefixed id", () => {
    /**
     * The specific regression this guards. Even with an EMPTY option list — `cli:getModels` failing, or a
     * project that pins a model it does not list — the name must be human. This is what a naive
     * "look it up, else print it" gets wrong.
     */
    const r = resolveModel("", "global.anthropic.claude-opus-5[1m]", []);

    expect(r.name).toBe("Opus 5");
    expect(r.name).not.toContain("global.anthropic");
    expect(r.name).not.toContain("[1m]");
  });

  it("prefers the LISTED label so the dropdown and the row cannot disagree", () => {
    // Two places name the same model; if they derived it independently they could differ, and the reader
    // would have no way to know which was authoritative.
    const custom: ModelOption[] = [
      { id: "claude-opus-5", label: "Opus 5 (team pinned)", tier: "opus", isExtended: false },
    ];

    expect(resolveModel("claude-opus-5", null, custom).name).toBe("Opus 5 (team pinned)");
  });

  it("strips the ' (Extended)' suffix the handler appends to a label", () => {
    // `cli:getModels` builds labels as `${base} (Extended)`. The badge already says 1M, so repeating it in
    // the name would print the same fact twice in one row.
    const r = resolveModel("claude-opus-5[1m]", null, options);

    expect(r.name).toBe("claude-opus-5");
    expect(r.extended).toBe(true);
  });

  it("an explicit selection is NOT flagged as the default", () => {
    /**
     * "The default happens to be Opus 5" and "I chose Opus 5" are different facts. A reader who cannot tell
     * them apart cannot tell whether their selection took effect — which is the whole reason the row carries
     * the word "default" at all.
     */
    expect(resolveModel("claude-sonnet-5", "claude-opus-5", options).isDefault).toBe(false);
    expect(resolveModel("", "claude-opus-5", options).isDefault).toBe(true);
  });

  it("a selection WINS over the default", () => {
    const r = resolveModel("claude-haiku-4-5", "global.anthropic.claude-opus-5[1m]", options);

    expect(r.name).toBe("claude-haiku-4-5");
    expect(r.tagline).toBe("Fastest");
    expect(r.extended, "haiku here is not the 1M variant").toBe(false);
  });

  it("falls back to 'Default' when there is NO selection and NO reported default", () => {
    /**
     * Reachable rather than theoretical: `cli:getModels` has a catch branch, and a project can be
     * configured with no `model` at all. "Default" is honest; inventing "Opus" would state something
     * unverified — the same class of mistake as the `modelId: "unknown"` that shipped once.
     */
    for (const missing of ["", null, undefined]) {
      const r = resolveModel("", missing as string | null | undefined, options);
      expect(r.name).toBe("Default");
      expect(r.tagline).toBeNull();
      expect(r.extended).toBe(false);
      expect(r.isDefault).toBe(true);
    }
  });

  it("never returns an empty name", () => {
    // The row renders `model.name` unconditionally, so "" would leave a gap where the model should be.
    for (const [sel, def] of [["", ""], ["", "x"], ["y", ""]] as const) {
      expect(resolveModel(sel, def, []).name.length).toBeGreaterThan(0);
    }
  });
});
