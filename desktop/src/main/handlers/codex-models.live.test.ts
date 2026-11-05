// ── DOES THE INSTALLED CODEX ACTUALLY ANSWER US? ─────────────────────────────────────────
//
// `codex-models.test.ts` injects `run`, so every one of its cases would keep passing if the real handshake
// were wrong — the wrong method name, a missing `initialized`, stdin closed too early. That last one is not
// hypothetical: the first probe wrote all three messages and closed stdin, `initialize` answered, and
// `model/list` never did, because the process exited at EOF before its reply came back. A fake cannot catch
// that class of bug, which is the same reason `platform-config.live.test.ts` exists.
//
// SKIPPED BY DEFAULT, and skipped rather than failed, so it cannot break `pnpm test` for someone without the
// Codex CLI installed. Run it deliberately:
//
//   CODEX_LIVE=1 pnpm --filter @praimana/desktop test codex-models.live
//
// Worth running after ANY change to the handshake or to `normaliseCodexModels` — that is a contract with a
// tool that updates itself, and no compiler enforces it.

import { describe, it, expect, vi } from "vitest";

vi.mock("../debug-log", () => ({ debugLog: () => {} }));

const { fetchCodexModels, __resetCodexModelCache } = await import("./codex-models");

const live = process.env.CODEX_LIVE === "1";

describe.skipIf(!live)("⚠ the real codex app-server", () => {
  it("returns a catalogue with usable ids and per-model efforts", async () => {
    __resetCodexModelCache();

    const { models, defaultModel } = await fetchCodexModels({ force: true });

    // Not "some models": a real catalogue names a default and every entry must be sendable as `-m`.
    expect(models.length).toBeGreaterThan(0);
    expect(defaultModel).not.toBe("");
    expect(models.some((m) => m.id === defaultModel)).toBe(true);

    for (const m of models) {
      expect(m.id, "an id is what gets passed to -m").not.toBe("");
      expect(m.label, "a label is what the picker shows").not.toBe("");
      // Every effort must be a non-empty wire value, since it is interpolated into `-c`.
      for (const e of m.efforts) expect(e.id).toMatch(/^\S+$/);
      if (m.efforts.length > 0) {
        expect(
          m.efforts.some((e) => e.id === m.defaultEffort),
          `${m.id}'s default effort must be one it advertises`
        ).toBe(true);
      }
    }
  }, 30_000);

  /**
   * ⚠ THE ASYMMETRY IS THE REASON EFFORTS ARE PER-MODEL. If a future Codex made every model accept the same
   * set, this would fail and the per-model plumbing could be simplified — so the failure is informative
   * rather than a nuisance. Asserted only when there is more than one model to compare.
   */
  it("advertises different efforts for different models", async () => {
    __resetCodexModelCache();
    const { models } = await fetchCodexModels({ force: true });

    if (models.length < 2) return;
    const sets = new Set(models.map((m) => m.efforts.map((e) => e.id).join(",")));
    expect(sets.size, "if this is 1, the per-model list is no longer load-bearing").toBeGreaterThan(1);
  }, 30_000);
});
