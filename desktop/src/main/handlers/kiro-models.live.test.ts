// ── DOES THE INSTALLED KIRO ACTUALLY ANSWER US? ───────────────────────────────────────────
//
// `kiro-models.test.ts` injects `run`, so every one of its cases would keep passing if the real invocation
// were wrong — a renamed flag, `--format json` dropped, the subcommand moved. That is not hypothetical for
// this module: the catalogue is reached through `kiro-cli chat --list-models`, and the whole feature exists
// because a PREVIOUS assumption about Kiro's capabilities ("its models are set server-side") was asserted in
// three files and never checked against the binary.
//
// Same reasoning as `codex-models.live.test.ts` and `platform-config.live.test.ts`.
//
// SKIPPED BY DEFAULT, and skipped rather than failed, so it cannot break `pnpm test` for someone without the
// Kiro CLI. Run it deliberately:
//
//   KIRO_LIVE=1 pnpm --filter @praimana/desktop test kiro-models.live
//
// ⚠ THE TIMEOUT IS GENEROUS ON PURPOSE. The command was measured at 3.2s and 4.6s — it reaches a service, not
// a local file — so a tight limit here would produce a flaky test that reads as a broken CLI.

import { describe, it, expect, vi } from "vitest";

vi.mock("../debug-log", () => ({ debugLog: () => {} }));

const { fetchKiroModels, __resetKiroModelCache } = await import("./kiro-models");

const live = process.env.KIRO_LIVE === "1";

describe.skipIf(!live)("⚠ the real kiro-cli catalogue", () => {
  it("returns models with ids that are usable as --model", async () => {
    __resetKiroModelCache();

    const { models, defaultModel } = await fetchKiroModels({ force: true });

    // Not "some models": a real catalogue names a default, and it must be one of the offered ids or the
    // picker would highlight nothing while the CLI used something else.
    expect(models.length).toBeGreaterThan(0);
    expect(defaultModel).not.toBe("");
    expect(models.some((m) => m.id === defaultModel)).toBe(true);

    for (const m of models) {
      /* Interpolated into an argv entry, so whitespace or an empty value would be a broken spawn. */
      expect(m.id, "an id is what gets passed to --model").toMatch(/^\S+$/);
      expect(m.label, "a label is what the picker shows").not.toBe("");
    }
  }, 40_000);

  /**
   * ⚠ THE FIELDS THAT MAKE THE TAGLINE WORTH SHOWING. If a future kiro-cli stopped publishing them, the
   * picker would silently lose its cost and window hints — a quiet degradation rather than a failure, which
   * is exactly the kind this file exists to make loud.
   */
  it("still publishes the context window and the rate multiplier", async () => {
    __resetKiroModelCache();
    const { models } = await fetchKiroModels({ force: true });

    expect(
      models.some((m) => m.contextWindowTokens !== null),
      "context_window_tokens vanished from the payload"
    ).toBe(true);
    expect(
      models.some((m) => m.rateMultiplier !== null),
      "rate_multiplier vanished from the payload"
    ).toBe(true);
  }, 40_000);
});
