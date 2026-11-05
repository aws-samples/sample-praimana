import { describe, it, expect } from "vitest";
import { aiProviderDisplay } from "./ai-provider";

/**
 * THE BUG: a Codex thread was labelled "Claude".
 *
 * The provider name was an inline two-way ternary, duplicated in two components:
 *
 *     aiProvider.includes("kiro") ? "Kiro" : "Claude"
 *
 * No Codex branch, so every Codex thread fell through to "Claude". Meanwhile the ICON,
 * written as a three-way chain in a third place, showed the Codex mark correctly. Same
 * value, same screen, two different answers, because the mapping lived in three copies and
 * they had drifted.
 *
 * These tests pin the two properties that keep that from recurring: every real provider is
 * named correctly, and an UNRECOGNISED value is never silently called Claude.
 */

describe("every assistant the platform ships is named correctly", () => {
  it.each([
    ["claude", "Claude"],
    ["kiro", "Kiro"],
    ["kiro-cli", "Kiro"],
    ["codex", "Codex"],
  ])("%s → %s", (provider, label) => {
    expect(aiProviderDisplay(provider).label).toBe(label);
  });

  it("THE REGRESSION: codex is NOT called Claude", () => {
    // The single assertion this file was written for.
    expect(aiProviderDisplay("codex").label).not.toBe("Claude");
    expect(aiProviderDisplay("codex").label).toBe("Codex");
  });

  it("gives each provider its own icon", () => {
    expect(aiProviderDisplay("codex").icon).toBe("codex");
    expect(aiProviderDisplay("kiro-cli").icon).toBe("kiro");
    expect(aiProviderDisplay("claude").icon).toBe("claude");
  });

  it("keeps the badge colour and the name from ONE source", () => {
    // They were separately derived before, which is how they came to disagree. Distinct
    // colours per provider is the observable proof they now travel together.
    const colours = ["claude", "kiro", "codex"].map((p) => aiProviderDisplay(p).badgeClass);
    expect(new Set(colours).size).toBe(3);
  });
});

describe("an unknown provider is never guessed at", () => {
  it.each([undefined, null, "", "   "])("%s → generic, not Claude", (v) => {
    const d = aiProviderDisplay(v as string | null | undefined);
    expect(d.label).toBe("Assistant");
    expect(d.icon).toBeNull();
  });

  it("a future assistant shows as unfamiliar rather than as the wrong one", () => {
    // The old `: "Claude"` fallback is exactly how Codex got mislabelled: a default that
    // looks like data. A new tool must read as unknown, not as an existing product.
    const d = aiProviderDisplay("gemini-cli");
    expect(d.label).toBe("Assistant");
    expect(d.icon).toBeNull();
  });
});

describe("matching is forgiving about the stored form", () => {
  it("ignores case and surrounding whitespace", () => {
    // The value comes from the desktop's `ai_command` setting, which is user-adjacent.
    for (const v of ["CODEX", " codex ", "Codex"]) {
      expect(aiProviderDisplay(v).label).toBe("Codex");
    }
  });

  it("matches on substring, so a variant does not fall through", () => {
    // `kiro-cli` and `kiro` are both real today; `claude-code` is a plausible tomorrow.
    expect(aiProviderDisplay("kiro-cli").label).toBe("Kiro");
    expect(aiProviderDisplay("claude-code").label).toBe("Claude");
  });
});
