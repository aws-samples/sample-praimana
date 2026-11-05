// ── ⚠ CLAUDE'S MODELS ARE CLAUDE'S ───────────────────────────────────────────────────────
//
// `cli:getModels` read `loadClaudeSettings()` — `~/.claude/settings.json`'s `availableModels` and `model`,
// defaulting to `"opus"` — for EVERY assistant, and its catch branch returned a hardcoded
// Sonnet/Opus/Haiku list. So selecting Codex produced a picker offering Claude's models and a line under
// the composer claiming one of them was answering.
//
// ⚠ IT WAS NOT ONLY COSMETIC. `buildCliArgs` passes the selection through, so choosing one sent
// `-m opus` to a CLI that has never heard of it.
//
// The answer then was an EMPTY list, because no way to enumerate the others was known. Inventing a plausible
// one would have repeated the original mistake in a new colour.
//
// ⚠ THAT IS NOW FALSE FOR EVERY ASSISTANT, AND THIS NOTE IS CORRECTED RATHER THAN LEFT TO MISLEAD.
//
//   Codex — `codex app-server` answers a `model/list` request with its own models and the reasoning efforts
//           each one advertises (see `codex-models.ts` and `codex-model-picker.test.ts`).
//   Kiro  — `kiro-cli chat --list-models --format json` returns 21 models and a stated default, MEASURED
//           against kiro-cli 2.18.1 (see `kiro-models.ts`). This file previously said the opposite — "Kiro
//           still returns nothing, because its models are genuinely set server-side" — and that sentence is
//           why nobody looked again: it read as a settled fact rather than an open question. Model
//           choice is now wanted on Kiro and Claude too, not only on Codex.
//
// What these tests still guard is the RULE that produced both answers: a list may only come from the
// assistant it describes, and Claude's settings file must never be read on behalf of another assistant.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const handler = strip(readFileSync(join(__dirname, "cli-assistant.ts"), "utf8"));
const renderer = (name: string) =>
  strip(readFileSync(join(__dirname, "..", "..", "renderer", "components", name), "utf8"));

const chatView = renderer("AssistantChatView.tsx");
/**
 * ⚠ KIRO'S COMPOSER IS READ TOO, because it is now in scope for this rule. It has its own view
 * (`KiroChatView.tsx`) and had no model control at all, which is what model choice on Kiro and Claude as
 * well fixes.
 */
const kiroView = renderer("KiroChatView.tsx");
/** The extracted control, which now owns the empty-list guard both composers rely on. */
const modelPicker = renderer("ModelPicker.tsx");

describe("⚠ the model list is scoped to the assistant that has one", () => {
  it("decides the assistant BEFORE reading Claude's settings", () => {
    const body = handler.slice(handler.indexOf('ipcMain.handle("cli:getModels"'));
    const guard = body.indexOf('!command.includes("claude")');
    const settingsRead = body.indexOf("loadClaudeSettings");

    expect(guard, "the assistant is checked").toBeGreaterThan(-1);
    expect(settingsRead, "and Claude's settings are still read for Claude").toBeGreaterThan(-1);
    expect(
      guard,
      "the check must come FIRST — reading a file for an assistant it does not describe is the bug"
    ).toBeLessThan(settingsRead);
  });

  it("returns an empty list rather than a plausible one for an assistant with nothing to offer", () => {
    const body = handler.slice(handler.indexOf('ipcMain.handle("cli:getModels"'));
    expect(body).toMatch(/return \{ models: \[\], defaultModel: null \}/);
  });

  /**
   * ⚠ CODEX MUST NOT FALL THROUGH TO CLAUDE'S SETTINGS EITHER. Its branch is an addition to the same rule,
   * not an exception to it: it answers from its own catalogue and returns before `loadClaudeSettings` is
   * reached. Ordered, because a codex branch placed after that read would reintroduce the reported bug for
   * the one assistant that now has a real list.
   */
  it("answers Codex from Codex, before Claude's settings are touched", () => {
    const body = handler.slice(handler.indexOf('ipcMain.handle("cli:getModels"'));
    const codexBranch = body.indexOf('command.includes("codex")');
    const settingsRead = body.indexOf("loadClaudeSettings");

    expect(codexBranch, "codex has its own branch").toBeGreaterThan(-1);
    expect(codexBranch).toBeLessThan(settingsRead);
    expect(body).toMatch(/fetchCodexModels\(\)/);
  });

  /**
   * ⚠ KIRO MUST ALSO ANSWER FROM KIRO, AND BEFORE CLAUDE'S SETTINGS ARE READ. Same rule as Codex above, and
   * it is asserted separately because it is a separate branch that could be misplaced.
   *
   * ⚠ THE FILE HEADER USED TO SAY KIRO HAD NOTHING TO ENUMERATE, and that claim is now measured false:
   * `kiro-cli chat --list-models --format json` returns 21 models with a stated default (kiro-cli 2.18.1).
   * The header is corrected above rather than left standing, because the false claim is the reason the
   * picker stayed absent — it read as a settled fact rather than an open question.
   */
  it("answers Kiro from Kiro, before Claude's settings are touched", () => {
    const body = handler.slice(handler.indexOf('ipcMain.handle("cli:getModels"'));
    const kiroBranch = body.indexOf('command.includes("kiro")');
    const settingsRead = body.indexOf("loadClaudeSettings");

    expect(kiroBranch, "kiro has its own branch").toBeGreaterThan(-1);
    expect(kiroBranch).toBeLessThan(settingsRead);
    expect(body).toMatch(/fetchKiroModels\(\)/);
  });

  /**
   * ⚠ AND THE COMPOSER MUST HIDE THE CONTROL. Without this the picker still renders, showing "Default"
   * beside an assistant whose model we do not know — a control that invites a click that cannot change
   * anything.
   *
   * ⚠ ASSERTED AGAINST `ModelPicker.tsx`, NOT `AssistantChatView.tsx`. The control was extracted to its own file so
   * Kiro's composer could import the SAME one; the guard travelled with it. Both composers now inherit this
   * behaviour from one place, which is stronger than the two copies the extraction avoided.
   */
  it("the picker removes itself when there is nothing to offer", () => {
    expect(modelPicker).toMatch(/if \(options\.length === 0 && !defaultModel\) return null;/);
  });

  /**
   * ⚠ AND BOTH COMPOSERS USE THAT ONE CONTROL. Without this, a later change could reintroduce a private
   * copy in either view and every other assertion here would still pass — which is exactly how the two
   * composers drifted apart before (`SendIcon`, the sync badge, the copy button).
   */
  it("both composers render the shared picker rather than their own", () => {
    expect(chatView).toContain('import { ModelPicker } from "./ModelPicker"');
    expect(kiroView, "Kiro's composer too — this is what was requested").toContain(
      'import { ModelPicker } from "./ModelPicker"'
    );
    for (const [name, source] of [
      ["AssistantChatView", chatView],
      ["KiroChatView", kiroView],
    ] as const) {
      expect(source, `${name} must not define its own picker`).not.toMatch(/function ModelPicker\(/);
    }
  });

  /** The Claude path is untouched — this is a narrowing, not a removal. */
  it("still offers Claude's own models", () => {
    const body = handler.slice(handler.indexOf('ipcMain.handle("cli:getModels"'));
    expect(body).toContain("availableModels");
    expect(body).toMatch(/tier = "opus"/);
  });
});
