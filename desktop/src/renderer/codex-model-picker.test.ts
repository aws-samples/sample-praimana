// ── ⚠ THE PICKER IS WIRED TO THE REAL CATALOGUE ──────────────────────────────────────────
//
// The pure decisions live in `lib/reasoning-effort.ts` and `handlers/codex-models.ts` and are tested there.
// What these assert is the WIRING — the part that has no return value to check and that was previously wrong
// in exactly this file: `cli:getModels` used to hand Claude's models to every assistant, so Codex was offered
// "Opus" and the composer named Opus as the model answering.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments stripped: a guard its own prose can satisfy is not a guard. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const chatView = strip(readFileSync(join(__dirname, "components", "AssistantChatView.tsx"), "utf8"));
const handler = strip(readFileSync(join(__dirname, "..", "main", "handlers", "cli-assistant.ts"), "utf8"));

describe("⚠ Codex's models come from Codex", () => {
  /**
   * ⚠ FETCHED, NOT LITERAL. A list transcribed from the screenshot would look identical in the UI and send
   * ids the CLI may reject. The names may only appear as DATA FROM THE CLI, never as source.
   */
  it("does not hardcode any model id or display name", () => {
    for (const invented of ["gpt-5.6-sol", "GPT-5.6", "GPT-5.5", "gpt-5.4"]) {
      expect(handler, `${invented} must come from the catalogue, not the source`).not.toContain(invented);
      expect(chatView, `${invented} must not be hardcoded in the composer`).not.toContain(invented);
    }
  });

  it("asks the catalogue module when the assistant is codex", () => {
    expect(handler).toMatch(/command\.includes\("codex"\)[\s\S]{0,200}?await fetchCodexModels\(\)/);
  });

  /**
   * ⚠ AND KIRO STILL GETS NOTHING. Its models are set server-side, so there is nothing to enumerate; the
   * empty-list branch is what keeps the composer from inventing a picker for it.
   */
  it("still returns an empty list for anything that is neither claude nor codex", () => {
    expect(handler).toMatch(/if \(!command\.includes\("claude"\)\) \{\s*return \{ models: \[\], defaultModel: null \}/);
  });

  /**
   * ⚠ THE EFFORTS ARE READ AND DELIBERATELY NOT OFFERED. `codex-models.ts` parses them because that is what
   * `model/list` returns, but nothing may pass them to the renderer — see the `-c` guard below.
   */
  it("does not advertise reasoning efforts to the renderer", () => {
    const branch = handler.slice(handler.indexOf('command.includes("codex")'), handler.indexOf("if (!command.includes"));

    expect(branch).not.toMatch(/efforts:/);
    expect(branch).not.toMatch(/defaultEffort:/);
  });
});

// ── ⚠ THE REGRESSION THIS FILE NOW EXISTS TO PREVENT ─────────────────────────────────────
//
// Two turns in the database with a user message and no reply; the turn before the picker landed had worked.
//
// ⚠ THE CAUSE WAS `-c`, NOT THE MODEL. Measured against the installed CLI on one thread, back to back:
//
//     no flags                                → replies
//     -m openai.gpt-5.4 (same as config)      → replies
//     -c model_reasoning_effort=high (SAME)    → "failed to load AWS credentials: the credential provider
//     -c check_for_update_on_startup=false     →  was not enabled", then turn.failed
//
// ANY `-c` override breaks the credential provider for a config using `model_provider = "amazon-bedrock"`
// with a nested `[model_providers.amazon-bedrock.aws]` table — even one setting a key to the value it already
// holds, and even one on an unrelated key. So the effort control was removed rather than left to fail silently.
describe("⚠ codex is never given a -c override", () => {
  it("passes the model with -m and nothing with -c", () => {
    const codexBranch = handler.slice(handler.indexOf('case "codex"'), handler.indexOf('case "codex"') + 4000);

    expect(codexBranch, "the model still reaches the CLI").toMatch(/codexTuning\.push\("-m", model\)/);
    expect(codexBranch, "any -c breaks this provider's credentials").not.toMatch(/"-c"/);
    expect(codexBranch).not.toMatch(/model_reasoning_effort=/);
  });

  /** The whole spawn path, not just the codex branch — a `-c` anywhere would reach it. */
  it("has no reasoning-effort plumbing left anywhere in the handler", () => {
    expect(handler).not.toMatch(/reasoningEffort/);
  });

  /** And the composer must not offer a control whose value cannot be delivered. */
  it("offers no reasoning control in the composer", () => {
    expect(chatView).not.toMatch(/ReasoningPicker/);
    expect(chatView).not.toMatch(/reasoningEffort/);
    expect(chatView, "and no dead persistence for it").not.toMatch(/codex_reasoning_effort/);
  });

  /** The bridge too: a field left in the IPC surface invites the next caller to fill it in. */
  it("has no reasoning field on the preload bridge", () => {
    const preload = strip(readFileSync(join(__dirname, "..", "preload", "index.ts"), "utf8"));

    expect(preload).not.toMatch(/reasoningEffort/);
  });
});
