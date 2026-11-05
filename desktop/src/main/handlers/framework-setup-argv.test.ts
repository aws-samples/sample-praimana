// ── ⚠ THE UNATTENDED SETUP TURN'S ARGV, FOR EVERY ASSISTANT, BOTH WAYS ──────────────────────────
//
// `framework:install` runs ONE agent turn with no user present, in the participant's project folder,
// and its prompt body is a REMOTELY FETCHED setup guide whose author is not necessarily the
// participant's team. framework.ts says what protects that turn: `sanitiseGuideForPrompt` is
// "mitigation rather than control — the control is the tool policy on the spawn". So the tool policy is
// the control, and this file tests it.
//
// ── ⚠ WHY THE CODEX BRANCH DRIFTED, WHICH IS THE POINT OF THIS FILE ──
//
// Three per-assistant branches sat inside a `new Promise` executor in a function whose other half
// spawns a process and streams its output, each reading `agentMayWriteFilesUnprompted()` from module
// scope. Two read it; one did not. Nothing could observe the difference without running a real CLI, so
// the omission was invisible to review and to every test in the suite.
//
// `setupArgsFor` is now pure and takes the setting as a PARAMETER, so the question "does this assistant
// honour the opt-out" is answerable by calling a function — and the loop below asks it of every
// assistant the installer supports rather than of the three that exist today.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupArgsFor } from "./framework";
import { toolPolicyOf } from "../agent-tool-policy";

/**
 * The assistants the installer branches on, DERIVED FROM THE SOURCE.
 *
 * ⚠ NOT A HAND-WRITTEN LIST, for the reason this whole finding illustrates: a list somebody types is a
 * record of what they remembered, and the branch that was forgotten is exactly the one that would be
 * missing from it. A fourth `command === "..."` added to `setupArgsFor` joins these cases the moment it
 * is written, and fails them if it ignores the opt-out.
 */
function assistantsInSource(): string[] {
  const src = readFileSync(fileURLToPath(new URL("./framework.ts", import.meta.url)), "utf8");
  const fn = src.slice(src.indexOf("export function setupArgsFor("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  return [...stripped.matchAll(/command === "([^"]+)"/g)].map((m) => m[1]);
}

const PROMPT = "<setup guide body>";

describe("⚠ every assistant's setup argv honours the fs_write opt-out", () => {
  it("finds the branches at all — a sweep that matches nothing proves nothing", () => {
    const found = assistantsInSource();
    expect(found, "the three assistants the installer supports today").toEqual(
      expect.arrayContaining(["claude", "codex", "kiro-cli"])
    );
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  for (const command of assistantsInSource()) {
    /**
     * ⚠ THE ARGV MUST DIFFER. This is the assertion the codex branch failed: it produced byte-identical
     * argv whether the participant had withdrawn unprompted writes or not, so `agentTrust:setFileWrites`
     * — the control that exists because there was previously no way to decline — did nothing at all on
     * that path.
     */
    it(`${command}: the argv changes when writes are withdrawn`, () => {
      const granted = setupArgsFor(command, PROMPT, true);
      const withdrawn = setupArgsFor(command, PROMPT, false);
      expect(withdrawn, "withdrawing the grant must change what is spawned").not.toEqual(granted);
    });

    /** Whatever the policy, the prompt is still passed — a "safe" argv that cannot run is not a fix. */
    it(`${command}: still passes the prompt either way`, () => {
      expect(setupArgsFor(command, PROMPT, true)).toContain(PROMPT);
      expect(setupArgsFor(command, PROMPT, false)).toContain(PROMPT);
    });

    /**
     * ⚠ AND THE AUDIT RECORD MUST NOT UNDERSTATE IT. `agent.spawn`'s detail is
     * `${command}:setup:${toolPolicyOf(args)}`, so a policy this detector cannot read is written as
     * `ask` — a hash-chained claim that the runtime asked before each tool. For an argv that grants
     * anything, that is the one direction an audit trail must never err in.
     */
    it(`${command}: the granted argv is not audited as "ask"`, () => {
      const policy = toolPolicyOf(setupArgsFor(command, PROMPT, true));
      expect(policy, `${command} grants unprompted writes and must say so`).not.toBe("ask");
    });
  }
});

describe("⚠ what each branch actually grants", () => {
  /** Claude has a per-tool allowlist, so the withdrawal removes the two writing tools by name. */
  it("claude drops Write and Edit, keeping the read tools", () => {
    const granted = setupArgsFor("claude", PROMPT, true).join(" ");
    const withdrawn = setupArgsFor("claude", PROMPT, false).join(" ");

    expect(granted).toContain("Write");
    expect(granted).toContain("Edit");
    expect(withdrawn).not.toContain("Write");
    expect(withdrawn).not.toContain("Edit");
    expect(withdrawn, "reading is what a setup guide legitimately needs").toContain("Read");
    // ⚠ NEVER Bash, either way. The tool a hostile guide most wants is granted per framework on
    // evidence, not by default — framework.ts states the rule.
    expect(granted).not.toContain("Bash");
  });

  /**
   * Codex has NO per-tool allowlist — the choices are `read-only`, `workspace-write` and
   * `danger-full-access` — so `workspace-write` permits shell commands where Claude's list permits
   * none. It is the closest bounded option, and the withdrawal moves to the narrow end of the same flag
   * rather than dropping the flag, because "no flag at all is a different code path whose behaviour
   * this module has not measured" (kiro-trust.ts).
   */
  it("codex moves between the two documented ends of --sandbox", () => {
    expect(setupArgsFor("codex", PROMPT, true)).toContain("workspace-write");
    expect(setupArgsFor("codex", PROMPT, false)).toContain("read-only");
    expect(setupArgsFor("codex", PROMPT, false)).not.toContain("workspace-write");
  });

  /** ⚠ AND NEVER THE BYPASS, on any path. Pinned because it is one word away from the value above. */
  it("codex never reaches for danger-full-access or the approvals bypass", () => {
    for (const mayWrite of [true, false]) {
      const argv = setupArgsFor("codex", PROMPT, mayWrite).join(" ");
      expect(argv).not.toContain("danger-full-access");
      expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(argv).not.toContain("--dangerously-skip-permissions");
    }
  });

  /** Kiro's list is deny-by-default, so the withdrawal shortens it rather than removing it. */
  it("kiro-cli keeps a trust list either way, without fs_write when withdrawn", () => {
    const granted = setupArgsFor("kiro-cli", PROMPT, true).join(" ");
    const withdrawn = setupArgsFor("kiro-cli", PROMPT, false).join(" ");

    expect(granted).toContain("fs_write");
    expect(withdrawn).not.toContain("fs_write");
    expect(withdrawn, "a shorter list is still deny-by-default, not an absent flag").toContain(
      "--trust-tools="
    );
    // The tools a server-fetched guide would most want are absent from both.
    for (const excluded of ["execute_bash", "use_aws", "web_fetch", "web_search"]) {
      expect(granted, `${excluded} must never be trust-listed`).not.toContain(excluded);
    }
  });

  /** An unknown assistant gets the prompt and no policy flags — nothing is pre-approved by accident. */
  it("an unrecognised command gets no pre-approval at all", () => {
    expect(setupArgsFor("something-else", PROMPT, true)).toEqual([PROMPT]);
    expect(toolPolicyOf(setupArgsFor("something-else", PROMPT, true))).toBe("ask");
  });
});
