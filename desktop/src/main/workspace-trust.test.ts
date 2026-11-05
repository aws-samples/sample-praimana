// ── ⚠ A TRUST GRANT YOU CANNOT WITHDRAW IS NOT A DECISION YOU MADE ────────────────────────────
//
// `cli:trustWorkspace` writes `projects[<abs path>].hasTrustDialogAccepted = true` into
// `~/.claude.json` — outside this app's `userData`, global to the OS user, shared with every other use
// of Claude Code. A grep for that key returned exactly ONE write site and nothing that cleared it, so a
// grant lasted the life of the file. Reinstalling the app does not help: the file is not the app's.
//
// This file covers the two parts of that finding addressed here:
//
//   REVOCATION       `cli:untrustWorkspace` deletes the key, behind the same `isOpenProjectRoot` gate.
//   NARROWER GRANT   the grant is only made for Claude Code, since that is whose file this is. Both
//                    call sites asked unconditionally, so a participant using Kiro or Codex got a
//                    machine-wide Claude Code permission they would never use.
//
// The remaining part — an explicit CONFIRMATION rather than an implicit grant on every folder switch —
// is deliberately not here. It has to be sequenced around `framework:install`, which runs an unattended
// agent turn in the folder and would otherwise prompt into a pane nobody is watching.
//
// ⚠ DRIVEN AGAINST A REAL `~/.claude.json` IN A TEMP HOME, because the behaviour under test IS the file
// mutation: which key is removed, what is left untouched, and what happens to a file this app does not
// own. A fake would assert that my code calls the fs functions I think it calls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();
/**
 * How the participant answers the trust confirmation. `1` is "Trust folder", `0` is Cancel — the
 * dialog's `cancelId` and `defaultId`, so Return and Escape both decline.
 *
 * ⚠ DRIVEN PER TEST, because "was the participant asked" and "what did the app do with the answer" are
 * both properties worth pinning, and a mock that always agreed could only show one of them.
 */
let dialogAnswer = 1;
const shown: Array<{ message?: string; detail?: string; cancelId?: number; defaultId?: number }> = [];
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: any[]) => any) => {
      handlers.set(channel, fn);
    },
  },
  dialog: {
    showMessageBox: async (opts: any) => {
      shown.push(opts);
      return { response: dialogAnswer, checkboxChecked: false };
    },
  },
  app: { isPackaged: false, getPath: () => HOME },
  BrowserWindow: { getAllWindows: () => [] },
}));

/** The temp HOME whose `.claude.json` these tests read and write. */
let HOME = "";
/** The folder the app considers open — `isOpenProjectRoot` is driven from this. */
let OPEN_ROOT = "";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, default: { ...actual, homedir: () => HOME }, homedir: () => HOME };
});

/**
 * ⚠ EVERY SPECIFIER IS `./`, NOT `../`, AND IT IS NOT COSMETIC. `vi.mock` resolves its path relative to
 * THIS file — `src/main/` — while the module under test imports `"../project-paths"` from
 * `src/main/handlers/`. Both resolve to the same module, so the `../` form here mocked NOTHING and every
 * case ran against the real confinement check, failing with "not an open project folder".
 */

/** Which assistant is configured — the grant is conditional on it. */
let assistant = "claude";
/** The stored `agent_trust_fs_write` row, steered per test. `null` is "never set". */
let settingsRow: string | null = null;
vi.mock("./database", () => ({
  getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => undefined }) }),
  readSetting: (k: string) =>
    k === "ai_command" ? assistant : k === "agent_trust_fs_write" ? settingsRow : null,  // nosemgrep: useless-ternary
  writeSetting: vi.fn(),
  /* setting-access.ts imports this for its own boot invariant; absent, importing it throws. */
  isSensitiveSetting: () => false,
}));

vi.mock("./project-paths", () => ({
  isOpenProjectRoot: (p: string) => path.resolve(p) === path.resolve(OPEN_ROOT),
}));
vi.mock("./debug-log", () => ({ debugLog: () => {} }));

/** Audit records, so the trail can be asserted without a real log file. */
const audit: Array<{ event: string; outcome: string; detail?: string }> = [];
vi.mock("./security-audit", () => ({
  recordSecurityEvent: (r: { event: string; outcome: string; detail?: string }) => audit.push(r),
  redactedTarget: (s: unknown) => String(s).split(/[/\\]/).filter(Boolean).pop() ?? "unknown",
}));
vi.mock("./active-account", () => ({ activeUserId: () => "user-a" }));

const { setupCliAssistantHandlers } = await import("./handlers/cli-assistant");
setupCliAssistantHandlers();

const invoke = (channel: string, ...args: unknown[]) => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args);
};

const claudeJson = () => path.join(HOME, ".claude.json");
const readConfig = () => JSON.parse(fs.readFileSync(claudeJson(), "utf-8"));

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), "trust-home-"));
  OPEN_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trust-proj-")));
  assistant = "claude";
  audit.length = 0;
  dialogAnswer = 1;
  shown.length = 0;
  settingsRow = null;
});
afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(OPEN_ROOT, { recursive: true, force: true });
});

describe("cli:trustWorkspace", () => {
  it("grants trust for the open folder", async () => {
    const res = await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(res).toMatchObject({ trusted: true });
    expect(readConfig().projects[OPEN_ROOT].hasTrustDialogAccepted).toBe(true);
  });

  it("refuses a folder that is not an open project root", async () => {
    const res = await invoke("cli:trustWorkspace", path.join(os.tmpdir(), "somewhere-else"));

    expect(res).toMatchObject({ error: expect.stringMatching(/Access denied/) });
    expect(fs.existsSync(claudeJson()), "nothing may be written").toBe(false);
  });

  /**
   * ── ⚠ THE GRANT IS ONLY MADE FOR THE ASSISTANT WHOSE FILE THIS IS ─────────────────────────────
   *
   * `~/.claude.json` is Claude Code's config. Kiro's tool trust is the `--trust-tools` spawn argument
   * (kiro-trust.ts) and Codex has no stake in this file at all — so writing a persistent, OS-global
   * Claude Code permission for a participant running either of them granted something they would never
   * use, and could not see.
   */
  for (const other of ["kiro-cli", "codex"]) {
    it(`⚠ writes nothing when the assistant is ${other}`, async () => {
      assistant = other;

      const res = await invoke("cli:trustWorkspace", OPEN_ROOT);

      expect(res).toMatchObject({ trusted: false, skipped: "not-claude" });
      expect(fs.existsSync(claudeJson()), "no grant for an assistant that cannot use it").toBe(false);
    });

    it(`does not report an error for ${other} — nothing went wrong`, async () => {
      // Both call sites warn the user on `trust?.error`; a warning about a non-event on every folder
      // switch would be worse than the silence it replaced.
      assistant = other;
      expect(await invoke("cli:trustWorkspace", OPEN_ROOT)).not.toHaveProperty("error");
    });
  }

  /**
   * ⚠ AN UNSET ASSISTANT COUNTS AS CLAUDE, because `resolveAssistantCommand` defaults to it. When the
   * app does not yet know — first run, before the choice is stored — it must behave exactly as before.
   */
  it("still grants when no assistant is configured yet", async () => {
    assistant = "";

    await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(readConfig().projects[OPEN_ROOT].hasTrustDialogAccepted).toBe(true);
  });

  /** A legacy `ai_command = "kiro"` is normalised to kiro-cli, and must not be treated as Claude. */
  it("treats the legacy kiro spelling as kiro", async () => {
    assistant = "kiro";

    expect(await invoke("cli:trustWorkspace", OPEN_ROOT)).toMatchObject({ skipped: "not-claude" });
  });
});

describe("⚠ cli:untrustWorkspace", () => {
  it("removes the trust flag", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);
    expect(readConfig().projects[OPEN_ROOT].hasTrustDialogAccepted).toBe(true);

    const res = await invoke("cli:untrustWorkspace", OPEN_ROOT);

    expect(res).toMatchObject({ untrusted: true, wasTrusted: true });
    expect(readConfig().projects[OPEN_ROOT]).not.toHaveProperty("hasTrustDialogAccepted");
  });

  /**
   * ⚠ THE KEY IS DELETED, NOT SET FALSE. `hasTrustDialogAccepted: false` is a claim about Claude Code's
   * own schema that this app has no business making. Absent is the state before anybody trusted
   * anything, and returning to it is what "withdraw" should mean.
   */
  it("deletes the key rather than writing false", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);
    await invoke("cli:untrustWorkspace", OPEN_ROOT);

    const raw = fs.readFileSync(claudeJson(), "utf-8");
    expect(raw).not.toContain("hasTrustDialogAccepted");
  });

  /**
   * ⚠ EVERYTHING ELSE IN THAT FILE IS LEFT ALONE, and this is the assertion that matters most here. The
   * file belongs to Claude Code and holds the user's own configuration — history, MCP servers, settings
   * this app knows nothing about. A revocation that rewrote or dropped any of it would be a far worse
   * bug than the one being fixed.
   */
  it("⚠ preserves the rest of the user's own Claude Code config", async () => {
    fs.writeFileSync(
      claudeJson(),
      JSON.stringify({
        numStartups: 42,
        mcpServers: { mine: { command: "some-server" } },
        projects: {
          [OPEN_ROOT]: { hasTrustDialogAccepted: true, history: ["a", "b"] },
          "/other/folder": { hasTrustDialogAccepted: true },
        },
      })
    );

    await invoke("cli:untrustWorkspace", OPEN_ROOT);

    const cfg = readConfig();
    expect(cfg.numStartups, "unrelated top-level keys").toBe(42);
    expect(cfg.mcpServers.mine.command, "the user's own MCP config").toBe("some-server");
    expect(cfg.projects[OPEN_ROOT].history, "other keys under the same project").toEqual(["a", "b"]);
    expect(
      cfg.projects["/other/folder"].hasTrustDialogAccepted,
      "and another folder's grant is not touched"
    ).toBe(true);
  });

  it("refuses a folder that is not an open project root", async () => {
    // Otherwise this is a channel for deleting arbitrary keys out of a file the app does not own.
    const res = await invoke("cli:untrustWorkspace", path.join(os.tmpdir(), "not-open"));

    expect(res).toMatchObject({ error: expect.stringMatching(/Access denied/) });
  });

  /**
   * ⚠ REVOCATION IS NOT GATED ON THE ASSISTANT, unlike the grant. A folder trusted while the participant
   * was on Claude must stay revocable after they switch to Kiro — otherwise switching assistant strands a
   * live permission they can no longer reach.
   */
  it("⚠ still works after the participant switches assistant", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);
    assistant = "kiro-cli";

    const res = await invoke("cli:untrustWorkspace", OPEN_ROOT);

    expect(res).toMatchObject({ untrusted: true, wasTrusted: true });
    expect(readConfig().projects[OPEN_ROOT]).not.toHaveProperty("hasTrustDialogAccepted");
  });

  it("is idempotent, and says the folder was not trusted", async () => {
    const res = await invoke("cli:untrustWorkspace", OPEN_ROOT);

    expect(res).toMatchObject({ untrusted: true, wasTrusted: false });
  });

  it("survives a missing config file", async () => {
    expect(fs.existsSync(claudeJson())).toBe(false);
    expect(await invoke("cli:untrustWorkspace", OPEN_ROOT)).toMatchObject({ untrusted: true });
  });

  it("reports a malformed config as an error rather than throwing", async () => {
    fs.writeFileSync(claudeJson(), "{ not json");

    const res = await invoke("cli:untrustWorkspace", OPEN_ROOT);

    expect(res).toHaveProperty("error");
    expect(audit.some((r) => r.event === "agent.trust" && r.outcome === "failure")).toBe(true);
  });

  it("records the revocation", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);
    audit.length = 0;

    await invoke("cli:untrustWorkspace", OPEN_ROOT);

    const rec = audit.find((r) => r.event === "agent.trust");
    expect(rec, "a withdrawal is a security event in its own right").toBeTruthy();
    expect(rec!.detail).toMatch(/^revoke:/);
  });

  it("records a no-op withdrawal too, and says it was not trusted", async () => {
    // Unlike the account channels, this one is a Settings button pressed by a person — "somebody asked
    // to withdraw this" is worth keeping, including the answer that there was nothing to withdraw.
    await invoke("cli:untrustWorkspace", OPEN_ROOT);

    expect(audit.find((r) => r.event === "agent.trust")!.detail).toMatch(/was-not-trusted/);
  });
});

describe("cli:isWorkspaceTrusted", () => {
  it("reports the state from Claude Code's own file", async () => {
    expect(await invoke("cli:isWorkspaceTrusted", OPEN_ROOT)).toEqual({ trusted: false });

    await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(await invoke("cli:isWorkspaceTrusted", OPEN_ROOT)).toEqual({ trusted: true });
  });

  it("reports false for anything it cannot establish", async () => {
    // No file, a folder that is not open, and a malformed file all mean the same thing to the CLI.
    expect(await invoke("cli:isWorkspaceTrusted", OPEN_ROOT)).toEqual({ trusted: false });
    expect(await invoke("cli:isWorkspaceTrusted", "/not/open")).toEqual({ trusted: false });
    fs.writeFileSync(claudeJson(), "{ not json");
    expect(await invoke("cli:isWorkspaceTrusted", OPEN_ROOT)).toEqual({ trusted: false });
  });
});

/**
 * ── ⚠ THE BRIDGE NAMES CHANNELS MAIN ACTUALLY REGISTERS ───────────────────────────────────────
 *
 * The one gap between "the handler works" (everything above) and "the Settings button works". The
 * preload bridge is a thin `ipcRenderer.invoke` passthrough, so a typo in a channel string is invisible
 * to the type checker and to every test that drives the handler directly — it surfaces as a button that
 * rejects at runtime with "No handler registered for…".
 *
 * Worth pinning here rather than nowhere: this repo has no general channel-wiring invariant, and these
 * two channels are reached from exactly one button each.
 */
describe("the preload bridge is wired to real channels", () => {
  it("every trust channel the bridge invokes is registered in main", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const preload = readFileSync(
      fileURLToPath(new URL("../preload/index.ts", import.meta.url)),
      "utf8"
    );

    const referenced = [...preload.matchAll(/invoke\("(cli:(?:un)?trustWorkspace|cli:isWorkspaceTrusted)"/g)]
      .map((m) => m[1]);

    expect(referenced, "the bridge must expose all three").toEqual(
      expect.arrayContaining([
        "cli:trustWorkspace",
        "cli:untrustWorkspace",
        "cli:isWorkspaceTrusted",
      ])
    );
    for (const channel of referenced) {
      expect(handlers.has(channel), `${channel} has no handler in main`).toBe(true);
    }
  });
});

/**
 * ── ⚠ THE GRANT IS A QUESTION NOW, AND THE RENDERER CANNOT ANSWER IT ──────────────────────────
 *
 * The finding's argument: picking a folder in a native picker is not the same decision as accepting whatever
 * `permissions.allow` that folder's `.claude/settings.json` contains — and a cloned repository ships that
 * file.
 *
 * ⚠ WHY THE DIALOG IS NATIVE AND COMES FROM MAIN. The actor this finding is scoped against is
 * renderer-resident code, which already reaches `cli:trustWorkspace` through the bridge — so a
 * confirmation the renderer could render is one it could also click. There is deliberately no
 * `confirmed: true` parameter for the same reason.
 */
describe("⚠ the trust confirmation", () => {
  it("asks before writing anything", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(shown.length, "the participant must be asked").toBe(1);
    expect(readConfig().projects[OPEN_ROOT].hasTrustDialogAccepted).toBe(true);
  });

  it("⚠ writes NOTHING when the participant cancels", async () => {
    dialogAnswer = 0;

    const res = await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(res).toMatchObject({ trusted: false, declined: true });
    expect(fs.existsSync(claudeJson()), "a decline must leave no grant").toBe(false);
  });

  it("records the decline, because it is different from never being asked", async () => {
    dialogAnswer = 0;

    await invoke("cli:trustWorkspace", OPEN_ROOT);

    const rec = audit.find((r) => r.event === "agent.trust" && r.outcome === "refused");
    expect(rec, "a support conversation about constant prompting needs this").toBeTruthy();
    expect(rec!.detail).toMatch(/^declined:/);
  });

  /**
   * ⚠ CANCEL IS BOTH THE DEFAULT AND THE `cancelId`, so Return and Escape decline. The safe answer is
   * the one a hurried participant gives — asserted because a dialog whose default grants a permission is
   * worse than no dialog, and the two ids are easy to transpose.
   */
  it("defaults to declining", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(shown[0].defaultId, "Return must not grant").toBe(0);
    expect(shown[0].cancelId, "Escape must not grant").toBe(0);
  });

  /**
   * ⚠ THE DIALOG STATES THE TWO FACTS THAT MAKE THIS A REAL DECISION. Without them it is a yes/no about
   * a word nobody outside this codebase knows — and the reach beyond the app is the part a participant
   * cannot possibly infer.
   */
  it("says what is being granted, and that it reaches outside the app", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);

    const detail = String(shown[0].detail);
    expect(detail, "names the file whose rules get pre-approved").toContain(".claude/settings.json");
    expect(detail, "says it is not scoped to this app").toMatch(/outside the app/i);
    expect(detail, "names the folder in full").toContain(OPEN_ROOT);
    expect(detail, "and says how to undo it").toMatch(/Settings/);
  });

  /**
   * ⚠ ASKED ONCE PER FOLDER, EVER. `App.tsx` calls this on every folder switch, so re-asking for an
   * already-trusted folder is how a confirmation becomes something people dismiss without reading — the
   * second-order failure kiro-trust.ts warns about for tool prompts.
   */
  it("⚠ does not ask again for a folder that is already trusted", async () => {
    await invoke("cli:trustWorkspace", OPEN_ROOT);
    expect(shown.length).toBe(1);

    const res = await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(res).toMatchObject({ trusted: true, alreadyTrusted: true });
    expect(shown.length, "no second dialog for the same folder").toBe(1);
  });

  it("asks again after the grant has been withdrawn", async () => {
    // Otherwise Withdraw would be a one-way door: the folder could never be re-trusted from a switch.
    await invoke("cli:trustWorkspace", OPEN_ROOT);
    await invoke("cli:untrustWorkspace", OPEN_ROOT);
    shown.length = 0;

    await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(shown.length).toBe(1);
    expect(readConfig().projects[OPEN_ROOT].hasTrustDialogAccepted).toBe(true);
  });

  it("does not ask when the folder is not an open project root", async () => {
    // The path gate runs first: a refusal must not cost the participant a dialog.
    await invoke("cli:trustWorkspace", path.join(os.tmpdir(), "not-open"));

    expect(shown.length).toBe(0);
  });

  it("does not ask when the assistant does not use this file", async () => {
    // Nothing to decide: Kiro's trust is a spawn argument, so there is no grant to consent to.
    assistant = "kiro-cli";

    await invoke("cli:trustWorkspace", OPEN_ROOT);

    expect(shown.length).toBe(0);
  });
});

/**
 * ── ⚠ FILE WRITES CAN BE DECLINED, AND THE DEFAULT IS UNCHANGED ───────────────────────────────
 *
 * ⚠ THE FINDING IS ABOUT THE ABSENCE OF A CHOICE, NOT ABOUT THE DEFAULT BEING WRONG, and these cases
 * pin both halves. kiro-trust.ts argues from measurements against a real kiro-cli why file writes are
 * pre-approved — prompting on every write is the workshop-stopping regression, and its second-order
 * effect is people clicking Allow without reading. So the default stays and declining becomes possible.
 */
describe("⚠ the fs_write opt-out", () => {
  it("pre-approves file writes by default", async () => {
    const { agentMayWriteFilesUnprompted } = await import("./agent-trust-setting");
    settingsRow = null;

    expect(agentMayWriteFilesUnprompted()).toBe(true);
  });

  /**
   * ⚠ ABSENT MEANS ALLOWED, and the asymmetry is deliberate. Every install predating this setting has no
   * row, and reading those as `false` would impose prompt-on-every-write on every existing participant —
   * precisely the regression kiro-trust.ts refuses to cause. Only an explicit "false" withdraws it.
   */
  it("treats an absent row as allowed, not as declined", async () => {
    const { agentMayWriteFilesUnprompted } = await import("./agent-trust-setting");
    for (const stored of [null, "", "true", "TRUE", "yes", "0", "anything"]) {
      settingsRow = stored;
      expect(agentMayWriteFilesUnprompted(), `stored=${JSON.stringify(stored)}`).toBe(true);
    }
  });

  it("⚠ withdraws only on an explicit false", async () => {
    const { agentMayWriteFilesUnprompted } = await import("./agent-trust-setting");
    settingsRow = "false";

    expect(agentMayWriteFilesUnprompted()).toBe(false);
  });

  it("drops fs_write from the spawn argument when declined", async () => {
    const { kiroTrustArg } = await import("./kiro-trust");

    expect(kiroTrustArg(true), "the default keeps it").toContain("fs_write");
    expect(kiroTrustArg(false), "declining removes it").not.toContain("fs_write");
  });

  /**
   * ⚠ THE FLAG IS STILL PASSED, WITH A SHORTER LIST. Dropping `--trust-tools` entirely is the one thing
   * that must not happen: a shorter list still means DENY BY DEFAULT for everything absent, whereas no
   * flag at all is a different code path whose behaviour kiro-trust.ts has not measured.
   */
  it("still passes --trust-tools, and never --trust-all-tools", async () => {
    const { kiroTrustArg } = await import("./kiro-trust");

    for (const arg of [kiroTrustArg(true), kiroTrustArg(false)]) {
      expect(arg).toMatch(/^--trust-tools=/);
      expect(arg).not.toContain("--trust-all-tools");
    }
  });

  /**
   * ⚠ READ TOOLS SURVIVE EITHER WAY. Withdrawing them would make the assistant prompt to LOOK at a file
   * it was asked about, which is not a decision a participant can reason about — and the finding names
   * `fs_write` specifically, because writing is the part that can be handed a path outside the project.
   */
  it("keeps the read tools when writes are declined", async () => {
    const { kiroTrustArg } = await import("./kiro-trust");
    const declined = kiroTrustArg(false);

    for (const tool of ["fs_read", "grep", "glob", "todo_list"]) {
      expect(declined, `${tool} must not become a prompt`).toContain(tool);
    }
  });

  it("never pre-approves the tools that reach outside the filesystem", async () => {
    // The whole point of the list. Neither setting may admit these.
    const { kiroTrustArg } = await import("./kiro-trust");

    for (const arg of [kiroTrustArg(true), kiroTrustArg(false)]) {
      for (const dangerous of ["execute_bash", "use_aws", "web_fetch", "web_search", "use_subagent"]) {
        expect(arg).not.toContain(dangerous);
      }
    }
  });
});

/**
 * ── ⚠ RE-GRANTING A WITHDRAWN PERMISSION IS THE PARTICIPANT'S DECISION ─────────────────────────
 *
 * `agent_trust_fs_write` is kept out of `RENDERER_WRITABLE_SETTINGS` for a stated reason — "the renderer must
 * not be able to turn it back ON … a key it can write is a decision it can undo" — and the dedicated channel
 * that replaced `db:setSetting` accepted exactly that write, with no confirmation and no rate limit. One
 * invoke restored the pre-approval, and every later agent launch passed `fs_write`, which kiro-trust.ts
 * records "can be handed an absolute path outside the project".
 *
 * The sibling grant of the same class, `cli:trustWorkspace`, already refuses to take the decision from
 * the renderer at all — "a confirmation it could render is a confirmation it could also click".
 */
describe("⚠ re-granting fs_write asks the participant", () => {
  it("raises a native dialog when the participant had withdrawn it", async () => {
    settingsRow = "false";

    await invoke("agentTrust:setFileWrites", true);

    expect(shown.length, "widening must be confirmed").toBe(1);
    // Cancel is the default AND the cancelId, so Return and Escape both decline.
    expect(shown[0].defaultId).toBe(0);
    expect(shown[0].cancelId).toBe(0);
  });

  it("⚠ leaves it withdrawn when the participant cancels", async () => {
    settingsRow = "false";
    dialogAnswer = 0;

    const res = await invoke("agentTrust:setFileWrites", true);

    expect(res).toEqual({ fileWrites: false, declined: true });
    expect(
      audit.find((r) => r.detail === "fs_write-preapproved:declined"),
      "a declined re-grant is distinguishable from one that never happened"
    ).toBeTruthy();
  });

  it("applies the re-grant when the participant agrees", async () => {
    settingsRow = "false";
    dialogAnswer = 1;

    expect(await invoke("agentTrust:setFileWrites", true)).toEqual({ fileWrites: true });
  });

  /**
   * ⚠ WITHDRAWING STAYS INSTANT. Confirming a move to a MORE restrictive state is how a safety prompt
   * becomes noise, and there is nothing to protect against in that direction.
   */
  it("does not ask in order to withdraw", async () => {
    settingsRow = null; // currently granted

    const res = await invoke("agentTrust:setFileWrites", false);

    expect(shown.length, "narrowing needs no ceremony").toBe(0);
    expect(res).toEqual({ fileWrites: false });
  });

  /** Otherwise an already-on toggle could be used to raise a dialog at will. */
  it("does not ask when it is already granted", async () => {
    settingsRow = null;

    await invoke("agentTrust:setFileWrites", true);

    expect(shown.length).toBe(0);
  });

  /** A malformed value is a denial, so it must not reach the dialog either. */
  it("does not ask for a value that is not exactly true", async () => {
    settingsRow = "false";

    await invoke("agentTrust:setFileWrites", "true");

    expect(shown.length).toBe(0);
  });

  /**
   * ── ⚠ RE-STATING A SETTING IS NOT AN AUDITABLE EVENT ──────────────────────────────────────────
   *
   * This wrote a `tool.permission` record on EVERY call, including when the stored value was simply being
   * re-written — so ~2000 invokes with the same value pushed every genuine `auth.signin`, `project.grant`,
   * `agent.trust` and `file.mutate` record out of the rotation window, with no state change to show for it.
   */
  it("⚠ records nothing when the value did not change", async () => {
    settingsRow = "false";

    // Re-stating the withdrawal it already has.
    await invoke("agentTrust:setFileWrites", false);

    expect(audit, "a no-op is not an event").toHaveLength(0);
  });

  it("still records a real change", async () => {
    settingsRow = "false";
    dialogAnswer = 1;

    await invoke("agentTrust:setFileWrites", true);

    expect(audit).toEqual([
      expect.objectContaining({ event: "tool.permission", detail: "fs_write-preapproved:true" }),
    ]);
  });
});

/**
 * The channel's own guard. Kept here rather than with the allowlist invariants because it reads handler
 * source and needs none of setting-access's imports.
 */
describe("⚠ the opt-out channel refuses a malformed value", () => {
  it("coerces a non-boolean to the restrictive answer", async () => {
    /**
     * The channel takes `allowed === true` rather than a truthiness test, so a malformed value cannot
     * re-grant. `"false"` is the case that matters: truthy as a string, and exactly what a caller getting
     * the shape wrong would send.
     */
    const CLI = (await import("node:fs")).readFileSync(
      (await import("node:url")).fileURLToPath(new URL("./handlers/cli-assistant.ts", import.meta.url)),
      "utf8"
    );
    const body = CLI.slice(CLI.indexOf('"agentTrust:setFileWrites"'));
    expect(body.slice(0, 800)).toContain("allowed === true");
  });
});
