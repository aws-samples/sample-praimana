import { ipcMain, dialog } from "electron";
import { ChildProcess } from "child_process";
import { spawnConfined } from "../spawn-confined";
import fs from "fs";
import path from "path";
import os from "os";
import { getDb, readSetting, writeSetting } from "../database";
import { isSessionOwnedByActiveAccount } from "../session-ownership";
import { assistantPath } from "../assistant-path";
import {
  commandForAssistant,
  resolveAssistantCommand,
  canonicalCommand,
  spawnCommandFor,
} from "../assistant-command";
import { kiroTrustArg } from "../kiro-trust";
import {
  agentMayWriteFilesUnprompted,
  setAgentMayWriteFilesUnprompted,
} from "../agent-trust-setting";
/* `cli:trustWorkspace` asks the confinement module which folders are open rather than rebuilding it. */
import { isOpenProjectRoot } from "../project-paths";
import { safeModelId } from "../model-id";
import { debugLog } from "../debug-log";
import { loadClaudeSettings, describeAuthGap, bedrockFlagHint } from "../claude-settings";
import { syncCliTurn } from "./cli-sync";
import { fetchCodexModels } from "./codex-models";
import { fetchKiroModels, type KiroModel } from "./kiro-models";
import {
  codexMessageAddition,
  isBenignError,
  parseCodexLine,
  splitCodexLines,
} from "./codex-events";
import { SYNC_PENDING } from "../message-sync-status";
import { recordSecurityEvent, redactedTarget } from "../security-audit";
import { activeUserId } from "../active-account";
import { toolPolicyOf } from "../agent-tool-policy";

function getSetting(key: string): string | null {
  return readSetting(key);
}

/**
 * The assistant command, validated on the way out of the database.
 *
 * ⚠ EVERY SITE THAT USED `getSetting("ai_command") || "claude"` NOW GOES THROUGH HERE, including the
 * ones that only branch on the value. Uniformity is the point: a reader that branches today becomes
 * a reader that spawns tomorrow, and a single accessor means the next such edit inherits the check
 * instead of having to remember it.
 */
function assistantCommand(): string {
  return resolveAssistantCommand(getSetting("ai_command"));
}

/**
 * ── THE SYNC MOVED TO cli-sync.ts ──
 *
 * `notifySyncFailed`, the bounded `syncFetch`/`checkedFetch` pair and `syncToServer` lived here and
 * were extracted VERBATIM when a second assistant implementation appeared (claude-code.ts, the SDK
 * path with real permission prompts). Both write the team's transcript, which feeds the AI assessment
 * and the `aiTurns` counter — so they must write it identically, and one shared function is the only
 * way to guarantee that as either side changes.
 *
 * Behaviour here is unchanged: the same call, with the arguments named rather than positional.
 */

function saveMessage(
  sessionId: string,
  role: string,
  content: string,
  /**
   * The CLI's reported counts, for an assistant row.
   *
   * ⚠ NULL WHEN NOT REPORTED, never 0 — the column exists so the app can tell "this turn cost nothing" from
   * "nobody counted". Every row written before migration 13 is in the second case, and rendering those as
   * zero would understate every existing conversation's total.
   */
  tokens?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningOutputTokens?: number;
  }
) {
  const db = getDb();
  const id = crypto.randomUUID();
  // 'pending' until the push is acknowledged — see message-sync-status.ts.
  db.prepare(
    `INSERT INTO chat_messages
       (id, session_id, role, content, sync_status,
        input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens,
        reasoning_output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    role,
    content,
    SYNC_PENDING,
    tokens?.inputTokens ?? null,
    tokens?.outputTokens ?? null,
    tokens?.cachedInputTokens ?? null,
    tokens?.cacheWriteInputTokens ?? null,
    tokens?.reasoningOutputTokens ?? null
  );
  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  return id;
}

// Per-session runtime state so multiple chats stream concurrently (EA-M1).
// Each chat session owns at most one in-flight CLI process; starting or sending
// on one session no longer kills or hijacks another session's process.
/** Exported for the stall/reuse tests; not part of the module's public surface otherwise. */
export const activeProcesses = new Map<string, ChildProcess>();
const pendingPermissions = new Map<string, { id: string; tool: string; description: string }>();
/**
 * ── ⚠ THE IN-MEMORY "has this chat started?" FLAG IS GONE ───────────────────────────────────
 *
 * It was a module-level `Record<string, boolean>` in the MAIN PROCESS, wiped on every restart. So the first
 * message into an existing chat after reopening the app was sent as turn one, Codex opened a brand-new
 * thread, and the assistant knew nothing. The desktop still showed the old transcript because it reads
 * SQLite — so the UI had the history and the CLI had none, which reads as amnesia rather than a blank chat.
 *
 * The durable question is "does this chat already have a CLI thread?", and it is answered by a column that
 * outlives the process.
 */
function readCliThreadId(sessionId: string): string | null {
  try {
    const row = getDb()
      .prepare("SELECT cli_thread_id FROM chat_sessions WHERE id = ?")
      .get(sessionId) as { cli_thread_id?: string | null } | undefined;
    return row?.cli_thread_id || null;
  } catch (err) {
    // A read failure must not break the turn — it degrades to "no thread", i.e. a fresh one.
    debugLog("[cli-assistant] could not read cli_thread_id:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Remember the thread the CLI just opened.
 *
 * ⚠ ONLY EVER WRITTEN FROM THE CLI'S OWN `thread.started` EVENT, never guessed. An id we invented would
 * resume nothing and fail exactly like the bug being fixed, but silently.
 */
function storeCliThreadId(sessionId: string, threadId: string): void {
  try {
    getDb()
      .prepare("UPDATE chat_sessions SET cli_thread_id = ? WHERE id = ?")
      .run(threadId, sessionId);
  } catch (err) {
    debugLog("[cli-assistant] could not persist cli_thread_id:", err instanceof Error ? err.message : err);
  }
}

/**
 * Forget a thread id the CLI can no longer resolve, so the NEXT turn starts a fresh thread.
 *
 * ⚠ WHY THIS IS NOT A WORKAROUND. A stored id going stale is a NORMAL condition, not a defect:
 * Codex prunes `~/.codex/sessions`, a participant moves machine or clears that directory, or the
 * chat outlives the rollout. Without this the row keeps an id that can never resolve again, so the
 * chat is permanently unusable — every turn dies on the same resume and the only visible trace is a
 * raw JSON-RPC error.
 *
 * ⚠ AND IT IS NOT DATA LOSS. The transcript lives in `chat_messages` and is untouched; the id is
 * only a pointer into the CLI's own store, which no longer has the thread. Clearing it costs the
 * assistant's memory of that conversation, which is already gone on the CLI side.
 */
function clearCliThreadId(sessionId: string): void {
  try {
    getDb().prepare("UPDATE chat_sessions SET cli_thread_id = NULL WHERE id = ?").run(sessionId);
  } catch (err) {
    debugLog("[cli-assistant] could not clear cli_thread_id:", err instanceof Error ? err.message : err);
  }
}

/**
 * Does this stderr text mean "the thread you asked me to resume does not exist"?
 *
 * Matched on the stable fragments rather than the whole sentence, for the reason the Codex
 * benign-notice list gives: the surrounding prose and the JSON-RPC code are upstream's to change.
 *
 *   thread/resume: thread/resume failed: no rollout found for thread id <uuid> (code -32600)
 */
/**
 * Commands that read more than one prompt from stdin, and so can be fed a second message.
 *
 * ⚠ EMPTY TODAY, AND THAT IS THE POINT. Claude runs `-p` (print mode) and Codex runs `exec`: both read
 * ONE prompt, answer, and exit. Kiro does not reach this handler at all, it routes to ACP.
 *
 * The reuse branch in `cli:send` predates that and wrote the next message into the running child's
 * stdin, which for a one-shot process does nothing — and, worse, RETURNED before the spawn path, so no
 * stall watchdog was ever armed for that message. A turn already stuck therefore stayed stuck for
 * ever: the timeout looked broken because it was never started, leaving a turn showing "thinking"
 * indefinitely.
 *
 * Kept as a named predicate rather than deleted so the intent survives: if a genuinely interactive
 * assistant is added, put its command here and the branch starts working for it alone.
 */
export const INTERACTIVE_COMMANDS: ReadonlySet<string> = new Set<string>();

export function isInteractiveCommand(command: string): boolean {
  return INTERACTIVE_COMMANDS.has(canonicalCommand(command));
}

/**
 * Retire a one-shot child that is still registered so a new turn can spawn.
 *
 * The usual reason it is still here is that it stalled — the watchdog kills on silence, but a child
 * killed between its budget and this call, or one whose `close` has not fired yet, is still in the
 * map. Either way the next message must NOT be handed to it.
 */
export function replaceStalledChild(sessionId: string, existing: ChildProcess, command: string): void {
  debugLog(
    `[cli-assistant] ${command} is one-shot and a previous child is still registered — ` +
      `retiring it so this message can start a new turn`
  );
  try {
    existing.kill("SIGTERM");
  } catch {
    /* Already gone; the map entry is cleared below regardless. */
  }
  clearSessionProcess(sessionId, existing);
}

export function isStaleThreadError(text: string): boolean {
  return /no rollout found for thread/i.test(text) || /thread\/resume failed/i.test(text);
}

/** Clear a session's process entry only if it still points at `proc` — avoids a
 *  late completion callback deleting a newer process the user already started. */
function clearSessionProcess(sessionId: string, proc: ChildProcess) {
  if (activeProcesses.get(sessionId) === proc) activeProcesses.delete(sessionId);
}

/**
 * ── ⚠ HOW LONG A TURN MAY PRODUCE ABSOLUTELY NOTHING BEFORE IT IS DECLARED STUCK ──────────────
 *
 * `lsof` showed each holding an ESTABLISHED HTTPS connection to Bedrock at 0% CPU — the request had gone out
 * and no response ever came. The app waited forever, because nothing on this path had a timeout: the chat
 * span indefinitely and there was no way to tell "slow" from "dead".
 *
 * ⚠ THIS IS A SILENCE BUDGET, NOT A TURN BUDGET, and the difference is the whole design. An agentic
 * turn legitimately runs for many minutes — the status line exists precisely because long turns are
 * normal — so capping total duration would kill working work. The timer is RESET by any byte on
 * stdout or stderr, so a turn that is doing something is never interrupted no matter how long it
 * takes. Only a turn that has gone completely quiet is stopped.
 *
 * 6 minutes: comfortably longer than the slowest real first-token wait measured here (~104s for a
 * trivial prompt against this Bedrock config), short enough that a participant is not left staring at
 * a spinner for a quarter of an hour.
 */
export const STALL_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * The bounds a participant may choose between, in minutes.
 *
 * ⚠ THE FLOOR IS NOT TIDINESS. Measured here, a trivial Codex prompt against this Bedrock config took
 * ~104 seconds before its first output — so anything under about two minutes would abort turns that
 * were working perfectly, and the resulting "the app keeps cancelling my chats" is a far worse bug
 * than the one the watchdog fixes. 2 minutes is the lowest value that is not actively harmful.
 *
 * ⚠ AND THERE IS NO "OFF", DELIBERATELY. A ceiling of 60 minutes is longer than any plausible silence
 * from a working assistant, so the generous end is covered without offering a value that means "wait
 * forever". A timeout with a user-facing off switch is a safety mechanism that can be disabled from
 * the UI, and the standing rule is that those are never disabled to make a symptom go away — the
 * symptom here being an assistant that has stopped responding.
 */
export const STALL_TIMEOUT_MIN_MINUTES = 2;
export const STALL_TIMEOUT_MAX_MINUTES = 60;
export const STALL_TIMEOUT_DEFAULT_MINUTES = 6;

/**
 * The configured stall budget in ms, clamped into the supported range.
 *
 * ⚠ CLAMPED RATHER THAN VALIDATED-AND-REJECTED. This is read on the spawn path, where refusing a bad
 * value would mean failing the turn over a preference — so an out-of-range or unparseable setting
 * yields the nearest legal value and the turn proceeds. `settings` is a plaintext table anything
 * running as this user can edit, so "0", "" and "not a number" all have to be handled here rather
 * than trusted to the UI that normally writes it.
 */
export function stallTimeoutMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(n)) return STALL_TIMEOUT_DEFAULT_MINUTES * 60_000;
  const clamped = Math.min(STALL_TIMEOUT_MAX_MINUTES, Math.max(STALL_TIMEOUT_MIN_MINUTES, n));
  return Math.round(clamped * 60_000);
}

/**
 * Watch a child for total silence and kill it if it stalls.
 *
 * Returns a `bump` to call on every chunk of output, and a `stop` for the close/error paths.
 *
 * ⚠ THE TIMER IS A TEARDOWN OBLIGATION. An uncleared interval keeps a reference to the child and
 * fires against a dead process, so every exit path has to call `stop` — which is why this returns it
 * rather than leaving the caller to remember a variable.
 */
export function watchForStall(
  child: ChildProcess,
  onStall: (afterMs: number) => void,
  /** Silence budget in ms. Defaults to the built-in value so existing callers and tests are unchanged. */
  budgetMs: number = STALL_TIMEOUT_MS
): { bump: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (stopped) return;
      stopped = true;
      onStall(budgetMs);
      /**
       * SIGTERM first so the CLI can close its own session cleanly — Codex writes a rollout on the
       * way out, and killing it with SIGKILL loses the turn's transcript on its side. SIGKILL only
       * if it is still there a moment later.
       */
      try {
        child.kill("SIGTERM");
      } catch {
        /* Already gone. */
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          /* Already gone. */
        }
      }, 5000);
    }, budgetMs);
  };

  arm();
  return {
    bump: () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      arm();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function setupCliAssistantHandlers() {
  ipcMain.handle("cli:start", async () => {
    return { started: true };
  });

  // Helper: indicates whether the current assistant uses ACP mode.
  //
  // Tests only "kiro-cli" now: `resolveAssistantCommand` normalises the legacy `"kiro"` spelling, so
  // the second arm of the old `=== "kiro" || === "kiro-cli"` is unreachable. The legacy value is
  // still HANDLED — one layer earlier, in one place, instead of at each comparison.
  ipcMain.handle("cli:useAcpMode", async () => {
    return { useAcp: assistantCommand() === "kiro-cli" };
  });

  /**
   * Choose the assistant. Replaces the renderer's two `setSetting` calls.
   *
   * ⚠ THE PAYLOAD IS AN ID, NOT A COMMAND — see assistant-command.ts. `commandForAssistant` refuses
   * anything not in the shipped map, so the renderer cannot name the executable, and both settings
   * are written HERE so the displayed assistant and the spawned process cannot disagree.
   *
   * Refuses rather than defaulting: an unknown id means the renderer and main disagree about what
   * this app ships, and silently starting a different assistant than the user picked is worse than
   * an error they can see.
   */
  ipcMain.handle("cli:setAssistant", async (_event, assistantId: string) => {
    const command = commandForAssistant(assistantId);
    if (!command) {
      console.warn("[cli-assistant] refused unknown assistant id");
      return { error: "Unknown assistant" };
    }
    writeSetting("ai_assistant", assistantId as string);
    writeSetting("ai_command", command);
    return { assistant: assistantId, command };
  });

  ipcMain.handle("cli:send", async (event, params: {
      sessionId: string;
      message: string;
      model?: string;
      userMessageId?: string;
    }) => {
    /**
     * ⚠ THE SAME OWNERSHIP GATE `kiroAcp:send` CARRIES — see the note there.
     *
     * Three send channels exist; a gate on one of them is not a gate.
     */
    if (!isSessionOwnedByActiveAccount(params?.sessionId)) {
      return { error: "Chat not found" };
    }

    const command = assistantCommand();
    const projectPath = getSetting("project_path");

    if (!projectPath) {
      return { error: "Project path not configured" };
    }

    // If THIS session already has a running process, feed it the new input.
    // Other sessions' processes are left untouched so they keep streaming.
    const existing = activeProcesses.get(params.sessionId);
    if (existing && !existing.killed) {
      if (isInteractiveCommand(command)) {
        existing.stdin?.write(params.message + "\n");
        return { sent: true };
      }
      replaceStalledChild(params.sessionId, existing, command);
    }

    try {
      /**
       * ⚠ FROM SQLITE, NOT FROM MEMORY, so reopening the app and typing into an existing chat CONTINUES it.
       */
      const threadId = readCliThreadId(params.sessionId);
      /**
       * ⚠ VALIDATED HERE, AT THE BOUNDARY. `params.model` is renderer input and reaches `spawn` argv as
       * `--model <value>`; on Windows that argv passes through `cmd.exe`, where a quoting defect once
       * turned `sonnet & calc.exe` into a second command. The quoting is fixed, and this is the layer
       * that does not depend on having got cmd.exe right. See model-id.ts.
       */
      /**
       * ⚠ THE PARTICIPANT'S FILE-WRITE CHOICE IS READ HERE, AT THE SPAWN, and handed to the pure builder.
       * `--trust-tools` is a spawn argument, so the setting takes effect on the next turn — which is what
       * the Settings row says, rather than implying it reaches a conversation already running.
       */
      const args = buildCliArgs(
        command,
        !!threadId,
        safeModelId(params.model),
        threadId,
        agentMayWriteFilesUnprompted()
      );

      // Settings, layered the way the CLI itself layers them: home, then the PROJECT's
      // .claude/settings.json. Reading only the home file is what broke Bedrock — an
      // A framework-configured project ships CLAUDE_CODE_USE_BEDROCK and its own AWS_REGION, and
      // ignoring them left the CLI calling the Anthropic API with no key (403,
      // retried ten times, so it looked like a hang). See claude-settings.ts.
      /**
       * THE CLI RESOLVES ITS OWN CONFIGURATION. We only repair the Electron launch.
       *
       * This block used to read the settings files, merge their `env`, run
       * `awsCredentialExport` itself, and inject AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN —
       * on the strength of a comment claiming Claude Code "may fail in Electron context".
       *
       * That claim is FALSE, and it was tested rather than assumed: spawning the CLI with
       * a deliberately empty environment (only HOME, PATH, TERM) in the workshop project
       * still read that project's .claude/settings.json, enabled Bedrock, picked up its
       * AWS_REGION, fetched its own credentials via awsCredentialExport, and reached
       * `inference-profile/global.anthropic.claude-opus-4-8`. It failed only on an IAM
       * policy — i.e. it got all the way to the model on its own.
       *
       * So every line of that merging was duplicating the CLI's own work, and duplicating
       * it WORSE: our copy could only ever see settings files, while the CLI also knows
       * about the macOS Keychain (`claude login`), ~/.claude/.credentials.json,
       * `apiKeyHelper`, and its own precedence rules. That gap is exactly what broke
       * Bedrock (project settings ignored) and then nearly broke Anthropic-direct users
       * (an auth gate that could not see their credentials).
       *
       * What legitimately remains is not configuration — it is compensation for how
       * Electron starts a process:
       *
       *   PATH  — an app launched from Finder/dock does not inherit a shell PATH, so the
       *           `claude` binary is not findable without this.
       *   HOME  — without it the CLI cannot locate ~/.claude at all.
       *   TERM / NO_COLOR — we parse its output; ANSI escapes would corrupt that.
       *
       * `cwd` (set on the exec/spawn call below) is what selects the project's settings.
       */
      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env,
        TERM: "dumb",
        NO_COLOR: "1",
        HOME: os.homedir(),
        PATH: assistantPath(),
      };

      // Settings are still READ — for diagnostics only, never to build the environment.
      // Explaining a failure from them is useful; constructing the environment from them
      // is what caused the bugs above.
      const { env: claudeEnv, credentialExport, sources } = loadClaudeSettings(projectPath);
      debugLog("[cli-assistant] settings sources:", sources.join(", ") || "(none)");

      // Refuse ONLY on a self-contradictory configuration — a provider explicitly
      // enabled with the thing it requires missing. Never "no provider found": a
      // customer using Anthropic directly has a valid setup with an empty env block.
      const authGap = describeAuthGap(claudeEnv, credentialExport);
      if (authGap) {
        debugLog("[cli-assistant] refusing to start:", authGap);
        return { error: `Claude Code cannot authenticate. ${authGap}` };
      }

      // Remembered, not enforced: appended to the CLI's own error IF the run fails, where
      // it is the most probable explanation and cannot obstruct a working setup.
      const configHint = bedrockFlagHint(claudeEnv, credentialExport);


      debugLog("[cli-assistant] Command:", args.cmd, args.args.join(" "));
      debugLog("[cli-assistant] CWD:", projectPath);

      /**
       * ── CLAUDE: spawn + INCREMENTAL stream-json parsing ──────────────────────
       *
       * WHY THIS CHANGED. Claude was run through `exec` with a completion callback. `exec`
       * BUFFERS the whole process output and hands it over once the process exits — so
       * although we ask for `--output-format stream-json`, every frame arrived at the end,
       * in one lump. Nothing streamed. That is why Claude felt frozen while Codex and
       * Kiro (both `spawn`) streamed fine.
       *
       * The comment that justified `exec` said "spawn doesn't work with toolbox-exec
       * auth". That was tested rather than trusted: the CLI authenticates fine when
       * spawned directly — an experiment with a deliberately empty environment reached
       * Bedrock and the model, failing only on IAM. So the premise no longer holds, and
       * `exec` cost streaming for nothing.
       *
       * Two more things this removes:
       *
       *   - THE 30s TIMEOUT, justified as "if Claude can't auth by then, it won't". That
       *     reasoning was about authentication, but the timeout applied to the whole turn,
       *     so any real task longer than 30 seconds was killed mid-work. A turn is bounded
       *     by the user's Stop button and by process exit, not by a stopwatch.
       *   - THE TEMP FILE. `exec` needed the prompt piped through a shell (`cat file |
       *     claude ...`), which meant writing the prompt to /tmp — sensitive content on
       *     disk, mode 0600, cleaned up in a callback. `spawn` writes it to stdin, so the
       *     prompt never touches the filesystem and no shell parses it.
       */
      if (command === "claude") {
        debugLog("[cli-assistant] Using spawn mode for Claude (streaming)");

        // Turn clock. Started immediately before spawn and read in `close`, so it
        // measures the whole turn including tool use — which is what "how long did the
        // assistant work" means for an agentic CLI, not just token generation.
        const turnStartedAt = Date.now();

        /**
         * `spawnPortable`, not `spawn`: on Windows `claude` is a `.cmd` shim and CreateProcess cannot
         * execute a batch file, so `shell: false` alone made this throw ENOENT and no turn could start.
         * It resolves through PATH/PATHEXT and uses an interpreter only for a shim — and `shell` is
         * still false in every branch. See windows-launch.ts.
         *
         * The comment this replaces is still true and is the reason the Windows path is safe: the
         * prompt goes down stdin, so nothing here is ever interpreted as a shell command.
         */
        /**
         * ── ⚠ A PRIVILEGED LAUNCH LEAVES A RECORD ─────────────────────────────────────────────
         *
         * The most privileged thing this app does is start an agent that can run shell commands and rewrite
         * files in the participant's project, and the only trace was a `debugLog` — a no-op unless an
         * environment variable is set, and never persisted. So "the agent ran something destructive" had no
         * local answer at all.
         *
         * ⚠ THE TOOL POLICY IS PART OF THE RECORD, not just the command. Whether the launch
         * pre-approved anything is the fact that matters afterwards, and it is the fact this finding
         * was about — see `toolPolicyOf`.
         */
        recordAgentSpawn(args.cmd, args.args);
        /**
         * ── ⚠ THROUGH `spawnConfined`, NOT `spawnPortable` ────────────────────────────────────
         *
         * `shell: false` was already honoured here by hand; what was missing is the CWD CONFINEMENT —
         * `confineCwd` real-path-checks the directory against the open project roots, so a `project_path`
         * that resolves through a symlink to somewhere else cannot become an agent's working directory.
         *
         * ⚠ IT THROWS RATHER THAN FALLING BACK, and that is why it is safe to add here: the enclosing
         * try/catch turns it into `{ error }` for the renderer, so an unusable project surfaces as a
         * sentence instead of an agent started in the wrong place.
         */
        const child = spawnConfined(args.cmd, args.args, {
          cwd: projectPath,
          env: spawnEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
        activeProcesses.set(params.sessionId, child);
        /**
         * Stall watchdog — reset by any output, so only a SILENT turn is stopped. Two Codex turns
         * held an ESTABLISHED connection to Bedrock for 17 minutes at 0% CPU with nothing on this
         * path to notice. See watchForStall.
         */
        const stall = watchForStall(
          child,
          (afterMs) => {
            const mins = Math.round(afterMs / 60000);
            debugLog(`[cli-assistant] no output for ${mins}m — treating the turn as stalled`);
            event.sender.send("cli:error", {
              sessionId: params.sessionId,
              error:
                `No response for ${mins} minutes, so the turn was stopped. The model may be ` +
                `throttled or unreachable — your transcript is intact and you can send the message ` +
                `again. You can change this limit in Settings.`,
            });
          },
          stallTimeoutMs(readSetting("cli_stall_timeout_minutes"))
        );

        child.stdin?.write(params.message);
        child.stdin?.end();

        // stream-json emits one JSON object PER LINE, but a chunk boundary can split a
        // line anywhere — so hold the trailing partial and only parse complete lines.
        // Parsing a half-line would silently drop whichever frame straddled the boundary.
        let buffer = "";
        let resultText = "";
        let stderrText = "";

        child.stdout?.on("data", (data: Buffer) => {
          stall.bump();  // output means the turn is alive
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            event.sender.send("cli:raw", { sessionId: params.sessionId, line: line.slice(0, 200) });

            try {
              const obj = JSON.parse(line);

              /**
               * ⚠ CLAUDE'S OWN SESSION ID, WHICH THIS PATH USED TO IGNORE.
               *
               * The CLI announces it in its `system` init event — the same field
               * `claude-code.ts:542` already reads on the SDK path, because the SDK wraps this same
               * protocol. Without it the only continuation available was `--continue`, which resumes the
               * most recent conversation IN THE DIRECTORY: wrong thread with two chats open, and nothing
               * at all after a restart.
               *
               * Stored on every turn rather than only the first: the id is stable for a conversation, so
               * re-writing it is free, and a chat whose first turn crashed before this line would
               * otherwise never record one.
               */
              if (obj.type === "system" && typeof obj.session_id === "string" && obj.session_id) {
                storeCliThreadId(params.sessionId, obj.session_id);
              }

              if (obj.type === "result" && obj.result) {
                // The authoritative final text. Replaces the accumulation rather than
                // appending: the CLI's own result is what the transcript should hold.
                resultText = obj.result;
              } else if (obj.type === "assistant" && obj.message?.content) {
                for (const block of obj.message.content) {
                  if (block.type === "text" && block.text) {
                    resultText += block.text;
                    // THE POINT OF THIS CHANGE: emit each piece as it arrives, so the
                    // user sees the answer being written instead of waiting for exit.
                    event.sender.send("cli:output", {
                      sessionId: params.sessionId,
                      text: block.text,
                    });
                  }
                }
              }
            } catch {
              // Not JSON — a stray log line. Already forwarded to the raw stream log
              // above, so it is visible without corrupting the transcript.
            }
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          stall.bump();  // output means the turn is alive
          // Bounded: a chatty stderr must not grow without limit for a long turn.
          stderrText = (stderrText + data.toString()).slice(-4000);
        });

        child.on("error", (err) => {
        stall.stop();
          event.sender.send("cli:error", {
            sessionId: params.sessionId,
            error: `Failed to run ${command}: ${err.message}`,
          });
          clearSessionProcess(params.sessionId, child);
        });

        child.on("close", (code) => {
        stall.stop();
          // Flush a trailing line with no newline — the last frame often has none.
          if (buffer.trim()) {
            try {
              const obj = JSON.parse(buffer);
              if (obj.type === "result" && obj.result) resultText = obj.result;
            } catch {}
          }

          const finalContent = resultText.trim();

          if (!finalContent) {
            // Nothing usable came back. Name the likely cause rather than showing an
            // empty bubble: `authentication_failed` arrives as JSON on STDOUT, so both
            // streams are searched (a stderr-only check missed it entirely before).
            const combined = `${stderrText}\n${resultText}`;
            const authFailed =
              /authentication_failed|"error_status":\s*40[13]|invalid[_ ]api[_ ]key|not authorized/i.test(
                combined
              );
            let userError = authFailed
              ? "Claude Code could not authenticate. Check that it works in a terminal " +
                "(`claude` in this project folder) — that will report the specific reason."
              : `Claude exited without a response${code !== 0 ? ` (exit ${code})` : ""}.`;
            if (authFailed && configHint) userError += ` ${configHint}`;
            if (!authFailed && stderrText.trim()) {
              userError += ` ${stderrText.trim().slice(0, 200)}`;
            }

            /**
             * ⚠ THE QUESTION STILL HAPPENED, SO IT STILL SYNCS. This branch is reached both by a real
             * failure (an auth problem, a non-zero exit) and by the participant pressing Stop before
             * the first token — killing the child closes it with no output. Returning here without a
             * sync is what erased a stopped turn's user message from the portal (reported).
             *
             * No assistant half is sent, so nothing claims the CLI answered and `aiTurns` is unmoved.
             * No local assistant row either: `cli:error` above is what the participant sees, and a
             * blank bubble beside it would be worse.
             */
            void syncCliTurn({
              sessionId: params.sessionId,
              userMessage: params.message,
              assistantMessage: "",
              aiProvider: command,
              // No assistant row exists on this path, so only the user's is stamped.
              ...(params.userMessageId ? { userMessageId: params.userMessageId } : {}),
              latencyMs: Date.now() - turnStartedAt,
            });

            event.sender.send("cli:error", { sessionId: params.sessionId, error: userError });
            clearSessionProcess(params.sessionId, child);
            return;
          }

          // The local row id doubles as the sync's idempotency key: stable across
          // retries of THIS turn, unique across turns, so a replay overwrites rather
          // than duplicating the transcript server-side.
          const turnId = saveMessage(params.sessionId, "assistant", finalContent);
          void syncCliTurn({
            sessionId: params.sessionId,
            userMessage: params.message,
            assistantMessage: finalContent,
            aiProvider: command,
            clientTurnId: turnId,
            ...(params.userMessageId ? { userMessageId: params.userMessageId } : {}),
            assistantMessageId: turnId,
            latencyMs: Date.now() - turnStartedAt,
          });

          event.sender.send("cli:response-complete", {
            sessionId: params.sessionId,
            content: finalContent,
          });
          clearSessionProcess(params.sessionId, child);
        });

        return { sent: true };
      }

      // --- Non-Claude path (kiro-cli, codex, other): use spawn with streaming ---
      debugLog("[cli-assistant] Using spawn mode for:", command);

      // Pass the prompt as a real argv element (no shell) so it can never be
      // interpreted as a shell command — JSON.stringify is NOT shell-safe.
      let spawnArgs: string[];
      if (command === "codex") {
        // Codex takes the message as a positional arg.
        spawnArgs = [...args.args, params.message];
        // Don't pass pre-fetched AWS creds - a wrapper-installed Codex handles its own auth
        delete spawnEnv.AWS_ACCESS_KEY_ID;
        delete spawnEnv.AWS_SECRET_ACCESS_KEY;
        delete spawnEnv.AWS_SESSION_TOKEN;
      } else {
        spawnArgs = args.args;
      }

      // Turn clock for the spawn path (codex, kiro-cli), same reasoning as Claude's.
      const turnStartedAt = Date.now();

      // Same reasoning as the Claude branch above — see windows-launch.ts.
      // Same record, and the same confinement, as the Claude branch above.
      recordAgentSpawn(args.cmd, args.args);
      const child = spawnConfined(args.cmd, spawnArgs, {
        cwd: projectPath,
        env: spawnEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeProcesses.set(params.sessionId, child);
      /**
       * Stall watchdog for the spawn path — this is the one Codex uses, and the one that hung.
       * Reset by any output, so a long WORKING turn is never interrupted. See watchForStall.
       */
      const stall = watchForStall(
        child,
        (afterMs) => {
          const mins = Math.round(afterMs / 60000);
          debugLog(`[cli-assistant] no output for ${mins}m — treating the turn as stalled`);
          event.sender.send("cli:error", {
            sessionId: params.sessionId,
            error:
              `No response for ${mins} minutes, so the turn was stopped. The model may be ` +
              `throttled or unreachable — your transcript is intact and you can send the message ` +
              `again. You can change this limit in Settings.`,
          });
        },
        stallTimeoutMs(readSetting("cli_stall_timeout_minutes"))
      );

      /**
       * ⚠ THE PROMPT GOES DOWN STDIN FOR CODEX TOO, which it did not before.
       *
       * The old code wrote a bare "\n" and relied on the prompt being an ARGUMENT. A live probe showed that
       * path printing "Reading additional input from stdin..." — so the CLI was waiting on a stream we closed
       * empty while ALSO parsing the prompt from argv. It worked, but it depended on argv accepting text we do
       * not control: a prompt beginning with `-` would be read as a flag.
       *
       * Stdin has no such ambiguity, which is the reasoning the Claude branch above already uses.
       */
      child.stdin?.write(params.message);
      child.stdin?.end();

      let fullOutput = "";
      /**
       * Codex's JSONL is line-oriented and a chunk boundary can split a line anywhere, so the trailing partial
       * is held over — parsing half a line would silently drop whichever event straddled the boundary. Same
       * hazard the Claude branch above documents; same fix.
       */
      let jsonBuffer = "";
      /**
       * Whether Codex already explained a failure for this turn (`turn.failed`), and the last thing it
       * complained about if it did not.
       *
       * ⚠ BOTH EXIST TO STOP A TURN ENDING IN SILENCE, which is what happened: the turn showed
       * "thinking", then stopped after syncing with no response. The first prevents saying it twice; the second is the
       * fallback for a run that dies without a terminal event.
       */
      let codexFailureReported = false;
      let lastCodexNotice = "";
      /**
       * The turn's token counts, from Codex's own `turn.completed`.
       *
       * ⚠ MEASURED BY THE CLI, NOT BY US — the same standing as `latencyMs`, which this process already
       * sends for exactly this reason: it is the only place that can observe what the turn actually cost.
       * Nothing is invented; an unreported count stays undefined all the way to the portal, where coverage
       * says so.
       */
      let turnTokens:
        | {
            inputTokens?: number;
            outputTokens?: number;
            cachedInputTokens?: number;
            cacheWriteInputTokens?: number;
            reasoningOutputTokens?: number;
          }
        | undefined;

      /**
       * Turn one parsed Codex event into IPC, and return whatever text it contributed to the transcript.
       *
       * The parsing itself lives in `codex-events.ts` where it is testable; this is the side-effecting half,
       * which needs the renderer handle and so cannot be.
       */
      const applyCodexLine = (line: string): string => {
        const effect = parseCodexLine(line);
        switch (effect.kind) {
          case "thread":
            /**
             * ⚠ PERSISTED IMMEDIATELY, not at the end of the turn. `thread.started` arrives first, and a turn
             * that is cancelled or crashes half-way still leaves a real thread behind on the CLI's side —
             * writing it only on success would lose the id for exactly the turns most likely to be retried.
             */
            storeCliThreadId(params.sessionId, effect.threadId);
            return "";
          case "text": {
            /**
             * ⚠ THE RENDERER IS SENT THE SAME BYTES THAT ARE SAVED, separator included. Sending
             * `effect.text` raw was the bug behind "…move to Q3.I've confirmed…" in a LIVE turn: the blank
             * line between two whole Codex messages was being added to `fullOutput` only, so the transcript
             * on screen ran the sentences together and only came out right after a reload.
             *
             * An empty addition means the message was a duplicate — so nothing is streamed either, and the
             * repeat never reaches the screen in the first place.
             */
            const addition = codexMessageAddition(fullOutput, effect.text);
            if (addition) {
              event.sender.send("cli:output", { sessionId: params.sessionId, text: addition });
            }
            return addition;
          }
          case "usage":
            turnTokens = {
              outputTokens: effect.outputTokens,
              ...(effect.inputTokens !== undefined ? { inputTokens: effect.inputTokens } : {}),
              ...(effect.cachedInputTokens !== undefined
                ? { cachedInputTokens: effect.cachedInputTokens }
                : {}),
              ...(effect.cacheWriteInputTokens !== undefined
                ? { cacheWriteInputTokens: effect.cacheWriteInputTokens }
                : {}),
              ...(effect.reasoningOutputTokens !== undefined
                ? { reasoningOutputTokens: effect.reasoningOutputTokens }
                : {}),
            };
            event.sender.send("cli:usage", {
              sessionId: params.sessionId,
              outputTokens: effect.outputTokens,
            });
            return "";
          case "failure":
            /**
             * ⚠ SENT AS AN ERROR, WHICH IS WHY THE TURN NO LONGER ENDS IN SILENCE. The renderer APPENDS
             * `⚠️ <message>` to the transcript rather than replacing it, so the participant sees the reason
             * beside whatever had already streamed — "The model 'x' does not exist" instead of a spinner
             * that quietly stopped.
             *
             * ⚠ IT IS NOT ADDED TO `fullOutput`. An error is local diagnostics, not content: putting it in
             * the turn would save it as the assistant's reply and SYNC IT TO THE TEAM as though the
             * assistant had said it.
             */
            codexFailureReported = true;
            event.sender.send("cli:error", {
              sessionId: params.sessionId,
              error: effect.message,
            });
            debugLog("[cli-assistant] codex turn failed:", effect.message);
            return "";
          case "notice":
            /**
             * ⚠ A NOTICE IS NOT A FAILED TURN. The first probe emitted one for a benign condition — a skills
             * context budget warning — and the turn then completed normally. `isBenignError` names the ones
             * known to be harmless; anything else still only reaches the debug log and the raw stream, because
             * Codex's own `turn.completed` is what decides whether a turn worked.
             */
            /**
             * ⚠ THE LAST NON-BENIGN NOTICE IS REMEMBERED, and that is a safety net rather than bookkeeping.
             * `turn.failed` is Codex's terminal event, but a killed or crashed run may never emit one — and
             * without something to fall back on that case is the original silent failure again. The close
             * handler uses this only when the turn produced no content AND no failure was reported.
             */
            if (!isBenignError(effect.message)) lastCodexNotice = effect.message;
            debugLog(
              `[cli-assistant] codex ${isBenignError(effect.message) ? "notice" : "error item"}:`,
              effect.message
            );
            event.sender.send("cli:raw", {
              sessionId: params.sessionId,
              line: `[codex] ${effect.message.slice(0, 180)}`,
            });
            return "";
          case "unparsed": {
            /**
             * Not an event — a stray log line on stdout. Forwarded as TEXT rather than dropped: it is more
             * likely to be something the participant must read (a login prompt, a sandbox refusal) than noise,
             * and the alternative is a silent turn.
             */
            const clean = effect.line.replace(/\x1b\[[0-9;]*m/g, "");
            event.sender.send("cli:output", { sessionId: params.sessionId, text: clean });
            return clean;
          }
          default:
            return "";
        }
      };

      child.stdout?.on("data", (data: Buffer) => {
          stall.bump();  // output means the turn is alive
        const chunk = data.toString();

        if (command === "codex") {
          jsonBuffer += chunk;
          const { lines, rest } = splitCodexLines(jsonBuffer);
          jsonBuffer = rest;
          for (const line of lines) {
            event.sender.send("cli:raw", { sessionId: params.sessionId, line: line.slice(0, 200) });
            /**
               ⚠ `appendCodexMessage`, NOT `+=`. Codex delivers a WHOLE message per event, so plain
               concatenation ran sentences together ("…move to Q2.The audit accepted…") and let an
               identical repeat through as a visible duplicate. See that function for both faults.
             */
            /* `applyCodexLine` already returns the ADDITION, separator included — see the `text` case. */
            fullOutput += applyCodexLine(line);
          }
          return;
        }

        // Plain text mode (kiro-cli) — strip ANSI codes and stream
        const clean = chunk.replace(/\x1b\[[0-9;]*m/g, "");
        fullOutput += clean;
        event.sender.send("cli:output", { sessionId: params.sessionId, text: clean });
        event.sender.send("cli:raw", { sessionId: params.sessionId, line: clean.trim().slice(0, 200) });
      });

      child.stderr?.on("data", (data: Buffer) => {
          stall.bump();  // output means the turn is alive
        const text = data.toString();
        debugLog("[cli-assistant] STDERR:", text);

        // Only emit meaningful errors to stream log, skip noise
        const trimmed = text.trim();
        if (trimmed && !trimmed.startsWith("All tools are now trusted") && !trimmed.includes("Learn more at") && !trimmed.includes("stream disconnected before completion") && !trimmed.includes("Reconnecting")) {
          event.sender.send("cli:raw", { sessionId: params.sessionId, line: `[STDERR] ${trimmed}` });
        }

        /**
         * ── ⚠ A STALE THREAD IS RECOVERED FROM, NOT REPORTED AS A CRASH ───────────────────────
         *
         * The turn was dead and the participant's only option was to abandon the chat, because the row kept
         * an id that can never resolve again — so every retry failed identically.
         *
         * The id is forgotten here, which makes the NEXT turn start a fresh thread instead of
         * resuming a missing one. The transcript in `chat_messages` is untouched; what is lost is
         * the assistant's own memory of the conversation, and that was already gone on the CLI side.
         *
         * ⚠ SAID PLAINLY RATHER THAN SILENTLY RETRIED. The assistant genuinely has no memory of the
         * earlier turns now, so continuing as though it does would make the NEXT reply look like it
         * had forgotten things for no reason. A participant who is told can re-state what matters.
         */
        if (isStaleThreadError(text)) {
          clearCliThreadId(params.sessionId);
          debugLog("[cli-assistant] stale CLI thread id cleared; the next turn starts a new thread");
          event.sender.send("cli:error", {
            sessionId: params.sessionId,
            error:
              "This conversation could not be resumed — the assistant's own copy of it is no longer " +
              "on this machine. Your transcript is intact. Send the message again and it will " +
              "continue in a new thread, without memory of the earlier turns.",
          });
        }

        // Detect workspace trust issue and notify renderer
        if (text.includes("workspace has not been trusted")) {
          const match = text.match(/projects\["([^"]+)"\]/);
          const folder = match?.[1] || projectPath;
          event.sender.send("cli:trust-required", {
            sessionId: params.sessionId,
            path: folder,
          });
        }
      });

      child.on("close", () => {
        stall.stop();
        /**
         * FLUSH A TRAILING LINE WITH NO NEWLINE. The last JSONL event often has none, and for Codex that last
         * event is `turn.completed` — so without this the token count for every turn would be dropped, and a
         * turn whose only `agent_message` arrived in the final chunk would render as "(No response received)"
         * despite having succeeded. The Claude branch above flushes for the same reason.
         */
        if (command === "codex" && jsonBuffer.trim()) {
          event.sender.send("cli:raw", { sessionId: params.sessionId, line: jsonBuffer.slice(0, 200) });
          fullOutput += applyCodexLine(jsonBuffer);
          jsonBuffer = "";
        }

        const finalContent = fullOutput.trim();

        /**
         * ⚠ AN EMPTY TURN MUST SAY WHY. The spinner cleared, the question synced, and nothing explained
         * the missing answer.
         *
         * `turn.failed` covers the ordinary case and has already been sent. This covers the rest — a run
         * killed mid-stream, a crash, a CLI too old to emit a terminal event — by falling back to the last
         * thing Codex complained about. Benign notices are excluded upstream, so this does not fire for a
         * skills-budget warning on a turn that simply had nothing to say.
         */
        if (!finalContent && !codexFailureReported && lastCodexNotice) {
          event.sender.send("cli:error", {
            sessionId: params.sessionId,
            error: lastCodexNotice,
          });
        }
        /**
         * ⚠ SAME SPLIT AS THE SDK PATH: no local row for an empty reply, but the USER's message syncs
         * regardless. Stopping before the first token used to erase the question from the portal
         * entirely (reported). `syncCliTurn` omits the assistant half when empty, so `aiTurns` is
         * unaffected.
         */
        let turnId: string | undefined;
        if (finalContent) {
          turnId = saveMessage(params.sessionId, "assistant", finalContent, turnTokens);
        }
        debugLog("[cli-assistant] Syncing to server, content length:", finalContent.length);
        void syncCliTurn({
          sessionId: params.sessionId,
          userMessage: params.message,
          assistantMessage: finalContent,
          aiProvider: command,
          ...(turnId ? { clientTurnId: turnId } : {}),
          ...(params.userMessageId ? { userMessageId: params.userMessageId } : {}),
          ...(turnId ? { assistantMessageId: turnId } : {}),
          latencyMs: Date.now() - turnStartedAt,
          ...(turnTokens ? { tokens: turnTokens } : {}),
        });
        event.sender.send("cli:response-complete", {
          sessionId: params.sessionId,
          content: finalContent || "(No response received)",
        });
        clearSessionProcess(params.sessionId, child);
        pendingPermissions.delete(params.sessionId);
      });

      child.on("error", (err) => {
        stall.stop();
        event.sender.send("cli:error", {
          sessionId: params.sessionId,
          error: `Failed to run ${command}: ${err.message}`,
        });
        clearSessionProcess(params.sessionId, child);
      });

      return { sent: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Failed to start" };
    }
  });

  /**
   * The participant answered a permission prompt.
   *
   * ⚠ THE SESSION IS A SCOPE, NOT A HINT. A session-ownership predicate was missing on
   * `cli:permission-respond`, over account-blind shared state. This
   * searched EVERY session's pending prompt by id when the caller's `sessionId` did not match, then
   * wrote the answer into that session's child stdin — so the argument the caller supplied narrowed
   * nothing and `pendingPermissions` has no account dimension to fall back on. Both hardened
   * siblings (`claude-sdk:permission-respond`, `kiroAcp:permissionRespond`) require the named
   * session and gate on ownership; the cross-session search is deleted rather than gated, because a
   * prompt is answerable only under its own chat.
   *
   * ⚠ CONSENT IS EXACTLY `true`. `params.allow ? "y" : "n"` let any truthy value — a string, an
   * object, a `1` from a hand-built IPC call — read as approval for an agent tool call. The two
   * siblings already required the strict comparison.
   *
   * ⚠ THIS NODE IS LATENT TODAY AND IS FIXED ANYWAY. `pendingPermissions` is only ever read and
   * deleted, never `.set`, so the map is always empty and no prompt is reachable through it. That is
   * an invariant held by the ABSENCE OF A WRITER, which the next commit to add prompting would
   * silently remove — and it would remove it into a handler that searched every session.
   */
  ipcMain.handle("cli:permission-respond", async (_event, params: { id: string; allow: boolean; sessionId?: string }) => {
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    const id = typeof params?.id === "string" ? params.id : "";
    if (!sessionId || !id) return { error: "No pending permission request" };
    if (!isSessionOwnedByActiveAccount(sessionId)) {
      return { error: "No pending permission request" };
    }
    if (pendingPermissions.get(sessionId)?.id !== id) {
      return { error: "No pending permission request" };
    }

    const proc = activeProcesses.get(sessionId);
    if (!proc || proc.killed) return { error: "No pending permission request" };

    // Send response to the CLI's stdin
    const response = params.allow === true ? "y" : "n";
    proc.stdin?.write(response + "\n");
    pendingPermissions.delete(sessionId);
    return { sent: true };
  });

  /**
   * Stop a specific session's process, or every one THIS ACCOUNT owns when no sessionId is given.
   *
   * ── ⚠ BOTH BRANCHES ARE SCOPED TO THE ACTIVE ACCOUNT ─────────────────────────────────────────
   *
   * `activeProcesses` is keyed by chat session id with no account dimension, and neither branch consulted
   * `isSessionOwnedByActiveAccount` — the predicate `cli:send` applies two hundred lines up. So `cli:stop`
   * with NO ARGUMENT killed every running agent process on the machine, including another local account's
   * in-flight turn, and a named id killed any session at all.
   *
   * ⚠ THE BULK BRANCH IS KEPT, BECAUSE IT HAS A REAL CALLER (project switch). "Stop everything I am
   * running" is the intent; "stop everything anyone is running" was the defect.
   */
  ipcMain.handle("cli:stop", async (_event, params?: { sessionId?: string }) => {
    const stopOne = (sessionId: string, proc: ChildProcess) => {
      if (!proc.killed) proc.kill();
      activeProcesses.delete(sessionId);
      pendingPermissions.delete(sessionId);
    };
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { stopped: false };
      const proc = activeProcesses.get(params.sessionId);
      if (proc) stopOne(params.sessionId, proc);
    } else {
      for (const [sid, proc] of [...activeProcesses]) {
        if (!isSessionOwnedByActiveAccount(sid)) continue;
        stopOne(sid, proc);
      }
    }
    return { stopped: true };
  });

  /**
   * ⚠ AN ACTIVITY ORACLE IF UNSCOPED — it would answer "is this session mid-turn?" for an id the
   * caller does not own, which is exactly what the uniform refusal in `session-ownership.ts` is
   * written to deny. A session that is not this account's reads as not running, which is also the
   * truthful answer from this account's point of view.
   */
  ipcMain.handle("cli:isRunning", async (_event, params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) {
        return { running: false, sessionId: params.sessionId };
      }
      const proc = activeProcesses.get(params.sessionId);
      return { running: !!proc && !proc.killed, sessionId: params.sessionId };
    }
    const mine = [...activeProcesses.keys()].some((sid) => isSessionOwnedByActiveAccount(sid));
    return { running: mine, sessionId: null };
  });

  ipcMain.handle("cli:trustWorkspace", async (_event, folderPath: string) => {
    try {
      /**
       * ── ⚠ THE BOUNDARY IS ASKED, NOT REBUILT ────────────────────────────────────────────────
       *
       * This used to assemble its own root set from `getSetting("project_path")` plus a bare `SELECT path
       * FROM projects` — the last consultation of that table in the app that honoured neither invariant
       * project-paths.ts documents:
       *
       *   no `user_id` predicate    → a row belonging to ANOTHER local account was trustable, while
       *                               `db:getProjects` would not list it and `db:removeProject` would
       *                               not let its owner revoke it
       *   no read-time filter       → a stale or hand-edited row that IS a forbidden root (`$HOME`)
       *                               was refused by `allowedRoots()` and accepted here
       *
       * ⚠ AND WHAT THIS WRITES IS NOT COSMETIC, which is what makes it worth a MEDIUM. Trust is what
       * makes Claude Code honour a folder's `permissions.allow` instead of prompting — see the note at
       * the call site in SelectAssistantView — so a wrongly trusted folder is one whose tool approvals
       * apply silently, and `framework:install` then runs an agent turn inside a project folder.
       *
       * `isOpenProjectRoot` is deliberately NOT `isWithinProject`: this handler trusts folders the user
       * OPENED, and the looser test would newly admit any subdirectory of one.
       */
      if (!isOpenProjectRoot(folderPath)) {
        /**
         * ⚠ THE REFUSAL IS RECORDED TOO, which is unusual on this surface and deliberate here.
         *
         * A refused trust grant means something asked for agent write-approval on a folder the user
         * has not opened — a stale renderer, or renderer-resident code trying its luck. Either way it
         * is the one signal that somebody probed this channel, and unlike the grant it has no other
         * trace anywhere: nothing is written, so a silent refusal is indistinguishable from no call.
         */
        recordSecurityEvent({
          event: "agent.trust",
          outcome: "refused",
          userId: activeUserId() ?? undefined,
          detail: `not-an-open-root:${redactedTarget(folderPath)}`,
        });
        return { error: "Access denied: not an open project folder" };
      }
      /**
       * ⚠ THE KEY IS THE RESOLVED PATH, NOT THE CALLER'S SPELLING. The guard above verifies
       * `path.resolve(folderPath)` while this used to write `config.projects[folderPath]` — the
       * "verify one path, act on another" shape. Not a boundary escape (both name the same directory),
       * but Claude Code looks the folder up by the string it is invoked with, so a relative or
       * `..`-containing spelling wrote a key the CLI would never read and the trust silently did nothing.
       */
      const vouchedPath = path.resolve(folderPath);  // nosemgrep: path-join-resolve-traversal

      /**
       * ── ⚠ THIS FILE IS CLAUDE CODE'S, SO THE GRANT IS ONLY MADE FOR CLAUDE CODE ────────────────
       *
       * Part of a wider problem with permissive agent tool-approval defaults. Both call
       * sites — the folder switch in App.tsx and first-run setup in SelectAssistantView — asked for this
       * unconditionally, and `SelectAssistantView`'s own comment even says "Trust this workspace for
       * Claude Code" while running for whichever assistant was chosen. So a participant who picked Kiro
       * or Codex got a machine-wide Claude Code grant they would never use: `~/.claude.json` is Claude
       * Code's config, and Kiro's tool trust is the `--trust-tools` spawn argument (kiro-trust.ts).
       *
       * ⚠ THE SMALLEST HONEST REDUCTION IN WHAT THAT FINDING IS ABOUT. It does not make the grant
       * revocable or explicit — those are separate — but it stops the app writing a persistent,
       * OS-global permission for a tool the user is not running. Nothing changes for a Claude user.
       *
       * ⚠ IN MAIN, NOT AT THE TWO CALL SITES, for the reason `writeTeamContext` gives about the tenant
       * rows: both callers inherit it, a third will too, and the renderer does not have to know which
       * assistants keep their trust in which file.
       *
       * ⚠ AFTER THE PATH GATE, DELIBERATELY. That gate is the security check and its refusal is worth
       * recording whatever the assistant is — a call naming a folder the user never opened is worth
       * seeing from a Kiro install too. This check answers a different question: is the grant NEEDED.
       *
       * ⚠ AND AN UNSET ASSISTANT COUNTS AS CLAUDE, because `resolveAssistantCommand` defaults to it. When
       * the app does not yet know, it behaves exactly as it did before this change.
       *
       * ⚠ SWITCHING TO CLAUDE LATER IS NOT A DEAD END. An untrusted folder makes the CLI discard
       * `permissions.allow`, which both spawn paths detect and surface as `cli:trust-required` — the
       * "Workspace Trust Required" card in AssistantChatView, with a Trust Folder button wired back to
       * this handler. One click, at the moment it actually matters.
       */
      if (assistantCommand() !== "claude") {
        debugLog(
          `[cli-assistant] workspace trust not needed for ${assistantCommand()} — ` +
            "~/.claude.json is Claude Code's config; skipping the grant"
        );
        /**
         * ⚠ NOT AN ERROR, AND THE SHAPE MATTERS. Both callers branch on `trust?.error` to warn the user
         * that tool permissions were not pre-approved. Nothing went wrong here and there is nothing to
         * pre-approve, so reporting one would be a warning about a non-event on every folder switch.
         */
        return { trusted: false, skipped: "not-claude" };
      }

      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      let config: any = {};
      if (fs.existsSync(claudeJsonPath)) {
        config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
      }
      if (!config.projects) config.projects = {};
      if (!config.projects[vouchedPath]) config.projects[vouchedPath] = {};

      /**
       * ── ⚠ ALREADY TRUSTED IS NOT A DECISION TO RE-ASK ─────────────────────────────────────────
       *
       * Checked before the dialog below, and it is what keeps the confirmation proportionate: the grant
       * is per folder, so a participant is asked ONCE for a folder and never again. Without this,
       * `App.tsx` would raise a dialog on every folder switch back to a project they already trusted —
       * which is how a confirmation becomes something people dismiss without reading, the second-order
       * failure kiro-trust.ts warns about for tool prompts.
       */
      if (config.projects[vouchedPath].hasTrustDialogAccepted === true) {
        return { trusted: true, alreadyTrusted: true };
      }

      /**
       * ── ⚠ THE PARTICIPANT IS ASKED, AND THE RENDERER CANNOT ANSWER FOR THEM ──────────────────
       *
       * The finding's argument is exact: picking a folder in a native picker is not the same decision as
       * accepting whatever `permissions.allow` that folder's `.claude/settings.json` contains — and a cloned
       * repository ships that file, which this app's own model treats as untrusted input.
       *
       * ⚠ A NATIVE DIALOG FROM MAIN, NOT A RENDERER MODAL, and that choice is most of the fix. The actor
       * this finding is scoped against is renderer-resident code: it already reaches
       * `cli:trustWorkspace` through the bridge, so a confirmation it could render is a confirmation it
       * could also click. `dialog.showMessageBox` is drawn and answered by the OS, outside anything the
       * renderer can script.
       *
       * ⚠ AND THERE IS NO `confirmed: true` PARAMETER, deliberately. An "already asked" flag from the
       * caller would restore exactly the hole — renderer code would simply pass it. The consequence is
       * that the "Trust Folder" button on the trust-required card also raises this dialog. That is two
       * interactions for one decision on a rare path, and it is the right trade: the card says
       * "Workspace Trust Required" and nothing about what trust means, while this dialog states the two
       * facts that matter — it applies outside this app, and it pre-approves the folder's own rules.
       *
       * ⚠ CANCEL IS THE DEFAULT AND THE `cancelId`, so Return and Escape both decline. The safe answer is
       * the one a hurried participant gives.
       *
       * ⚠ DECLINING IS NOT A DEAD END, which is what makes asking acceptable at all. An untrusted folder
       * makes the CLI discard `permissions.allow`, both spawn paths detect it, and the renderer offers
       * the card at the moment a tool is actually needed.
       */
      const answer = await dialog.showMessageBox({
        type: "question",
        buttons: ["Cancel", "Trust folder"],
        defaultId: 0,
        cancelId: 0,
        title: "Trust this folder for the AI assistant?",
        message: `Pre-approve tool permissions in “${path.basename(vouchedPath)}”?`,
        detail:
          `Claude Code will apply the tool approvals defined in this folder ` +
          `(.claude/settings.json) without asking you each time.\n\n` +
          `This is stored in your computer account rather than in this app, so it also ` +
          `applies when you use Claude Code outside the app.\n\n` +
          `${vouchedPath}\n\n` +
          `If you cancel, the assistant will ask before each tool it uses. You can change ` +
          `this later in Settings.`,
        /* A checkbox would be a second decision on a dialog that already asks one. */
        noLink: true,
      });

      if (answer.response !== 1) {
        /**
         * ⚠ THE REFUSAL IS RECORDED, because "the participant declined" is a different and more
         * interesting fact than "nobody asked". Without it, a support conversation about an assistant
         * that keeps prompting has no local evidence of why.
         */
        recordSecurityEvent({
          event: "agent.trust",
          outcome: "refused",
          userId: activeUserId() ?? undefined,
          detail: `declined:${redactedTarget(vouchedPath)}`,
        });
        return { trusted: false, declined: true };
      }

      config.projects[vouchedPath].hasTrustDialogAccepted = true;
      fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
      /**
       * ── ⚠ RECORDED, AND THIS RECORD IS THE ONLY TRACE THE GRANT LEAVES IN THIS APP ────────────
       *
       * This module already called `recordSecurityEvent` for `agent.spawn`, so the facility was in scope and
       * this was simply missed.
       *
       * ⚠ IT MATTERS MORE HERE THAN FOR THE OTHER TWO GRANTS, for two reasons the comment above
       * already establishes. The write lands in `~/.claude.json` — OUTSIDE this app's `userData`,
       * global to the whole OS user, shared with every other use of Claude Code on the machine. And
       * there is no revocation path anywhere in the app: nothing sets `hasTrustDialogAccepted` false or
       * deletes the key. So a grant is permanent, invisible, and reaches beyond this app — and until
       * this line, unrecorded. "Who trusted that folder for the agent, and when?" had no local answer.
       *
       * ⚠ THE GRANT IS REVOCABLE NOW — see `cli:untrustWorkspace` below. What remains of that finding is
       * the absence of an explicit CONFIRMATION: this is still called implicitly on a folder switch
       * rather than from a decision the participant makes, which is deliberately not in this change.
       *
       * ⚠ AFTER THE WRITE SUCCEEDS. `writeFileSync` can throw — a read-only home, a malformed
       * `~/.claude.json` — and a record claiming a grant that did not happen is worse than none: the
       * catch below turns it into an error, and the absence of a record is then correct.
       */
      recordSecurityEvent({
        event: "agent.trust",
        outcome: "success",
        userId: activeUserId() ?? undefined,
        detail: redactedTarget(vouchedPath),
      });
      return { trusted: true };
    } catch (err) {
      /**
       * ⚠ AND A FAILED GRANT IS RECORDED AS A FAILURE, not left silent. This catch covers the
       * `~/.claude.json` read and write, so it fires on a malformed file or an unwritable home — and
       * "the agent keeps prompting me" is the symptom, which this line explains.
       */
      recordSecurityEvent({
        event: "agent.trust",
        outcome: "failure",
        userId: activeUserId() ?? undefined,
        detail: redactedTarget(folderPath),
      });
      return { error: err instanceof Error ? err.message : "Failed to trust workspace" };
    }
  });

  /**
   * ── ⚠ WITHDRAW A WORKSPACE TRUST GRANT ────────────────────────────────────────────────────────
   *
   * A grep for `hasTrustDialogAccepted` returned exactly one write site and nothing that cleared it: once a
   * folder was trusted, it was trusted for the life of `~/.claude.json`, for every use of Claude Code by this
   * OS user, with no way to change your mind.
   *
   * ⚠ THE ASYMMETRY WAS THE DEFECT. The app was willing to make a persistent, OS-global permission
   * decision on the user's behalf and unwilling to let them unmake it. A control you cannot turn off is
   * not a control, and "reinstall the app" does not help — this file is outside `userData` and survives.
   *
   * ⚠ NOT GATED ON THE ASSISTANT, unlike the grant. A folder trusted while the participant was using
   * Claude must stay revocable after they switch to Kiro, or switching assistant would strand a grant
   * they can no longer reach. Revocation is always available; only GRANTING is conditional.
   *
   * ⚠ THE SAME `isOpenProjectRoot` GATE AS THE GRANT, and for a subtler reason than symmetry: without it
   * this becomes a channel for deleting arbitrary keys out of `~/.claude.json` — a file this app does not
   * own and shares with the user's own Claude Code configuration. The gate keeps the blast radius to
   * folders the app already had a say over.
   *
   * ⚠ IT DELETES THE KEY RATHER THAN WRITING `false`. `hasTrustDialogAccepted: false` is a claim about
   * Claude Code's own schema that this app has no business making — absent is the state before anyone
   * trusted anything, and returning to it is what "withdraw" should mean. Everything else under
   * `projects[path]` is left alone: this file belongs to Claude Code and may hold history, MCP config or
   * settings this app knows nothing about.
   */
  ipcMain.handle("cli:untrustWorkspace", async (_event, folderPath: string) => {
    try {
      if (!isOpenProjectRoot(folderPath)) {
        // Recorded for the same reason the grant's refusal is: nothing is written, so a silent refusal
        // would be indistinguishable from no call at all.
        recordSecurityEvent({
          event: "agent.trust",
          outcome: "refused",
          userId: activeUserId() ?? undefined,
          detail: `revoke-not-an-open-root:${redactedTarget(folderPath)}`,
        });
        return { error: "Access denied: not an open project folder" };
      }
      const vouchedPath = path.resolve(folderPath);  // nosemgrep: path-join-resolve-traversal

      /**
       * ⚠ NO EARLY RETURN FOR A MISSING FILE, so every path reaches the record below. A first version
       * returned here — and its own test caught the contradiction with the comment three lines further
       * down promising that a no-op withdrawal is recorded too. "There was no config file at all" is
       * exactly the answer somebody checking whether a revocation took effect needs to see.
       */
      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      let wasTrusted = false;
      if (fs.existsSync(claudeJsonPath)) {
        const config: any = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
        const entry = config?.projects?.[vouchedPath];
        wasTrusted = entry?.hasTrustDialogAccepted === true;
        if (wasTrusted) {
          delete entry.hasTrustDialogAccepted;
          fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
        }
      }

      /**
       * ⚠ RECORDED EVEN WHEN NOTHING CHANGED, which is the opposite of the rule applied to
       * `auth:switchAccount`, and deliberately so. There, a no-op record was an attacker-driven flood
       * primitive on a channel the renderer could call freely. Here the caller is a button in Settings
       * pressed by a person, and "somebody asked to withdraw trust for this folder" is the fact worth
       * keeping — including the answer that it was not trusted, which is what a reader checking whether
       * a revocation took effect needs to see.
       */
      recordSecurityEvent({
        event: "agent.trust",
        outcome: "success",
        userId: activeUserId() ?? undefined,
        detail: `revoke:${redactedTarget(vouchedPath)}${wasTrusted ? "" : ":was-not-trusted"}`,
      });
      return { untrusted: true, wasTrusted };
    } catch (err) {
      recordSecurityEvent({
        event: "agent.trust",
        outcome: "failure",
        userId: activeUserId() ?? undefined,
        detail: `revoke:${redactedTarget(folderPath)}`,
      });
      return { error: err instanceof Error ? err.message : "Failed to withdraw workspace trust" };
    }
  });

  /**
   * Is this folder currently trusted for the agent?
   *
   * Exists so Settings can show the state rather than offering a button whose effect the participant
   * cannot see. A read of Claude Code's own file, so it reports what the CLI will actually honour rather
   * than what this app remembers doing — those diverge the moment anything else edits that file, which
   * is the whole reason the grant is worth surfacing at all.
   *
   * Unknown states collapse to `false`: no file, no entry, a malformed file. All of them mean "the CLI
   * will not honour this folder's permissions.allow", which is the question being asked.
   */
  ipcMain.handle("cli:isWorkspaceTrusted", async (_event, folderPath: string) => {
    try {
      if (!isOpenProjectRoot(folderPath)) return { trusted: false };
      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      if (!fs.existsSync(claudeJsonPath)) return { trusted: false };
      const config: any = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
      return {
        trusted: config?.projects?.[path.resolve(folderPath)]?.hasTrustDialogAccepted === true,  // nosemgrep: path-join-resolve-traversal
      };
    } catch {
      /* A malformed or unreadable file is not a trusted one. */
      return { trusted: false };
    }
  });

  /**
   * ── ⚠ THE PARTICIPANT'S FILE-WRITE CHOICE, READ AND WRITTEN THROUGH MAIN ──────────────────────
   *
   * Its own channel rather than `db:setSetting` because the renderer must not be able to turn it back ON:
   * writing `false` narrows what the agent may do, writing `true` RE-GRANTS a permission the participant
   * withdrew — and renderer-resident code is the actor this finding is scoped against. See
   * agent-trust-setting.ts for the full argument and for why absent means allowed.
   */
  ipcMain.handle("agentTrust:get", async () => ({
    fileWrites: agentMayWriteFilesUnprompted(),
  }));

  ipcMain.handle("agentTrust:setFileWrites", async (_event, allowed: unknown) => {
    /**
     * ⚠ COERCED, NOT TRUSTED. The renderer sends a boolean today; anything else is a caller getting the
     * shape wrong, and the safe reading of a malformed value is the RESTRICTIVE one — a truthy-ish
     * string like "false" must not re-grant the permission.
     */
    const next = allowed === true;

    /**
     * ── ⚠ THE TWO DIRECTIONS ARE NOT THE SAME DECISION ────────────────────────────────────────────
     *
     * `agent_trust_fs_write` is deliberately absent from `RENDERER_WRITABLE_SETTINGS`, and
     * agent-trust-setting.ts states the reason in as many words: "the renderer must not be able to turn it
     * back ON … Writing true RE-GRANTS a permission the participant has explicitly withdrawn — and
     * renderer-resident code is the actor this whole finding is scoped against, so a key it can write is a
     * decision it can undo."
     *
     * This channel, which replaced `db:setSetting` precisely to close that, accepted exactly that
     * write: one invoke with a literal `true` restored the pre-approval, with no confirmation, no
     * re-authentication and no rate limit. Every later agent launch then passed the wider tool list
     * (`kiroTrustArg(true)` → `--trust-tools=fs_read,fs_write,…`), where kiro-trust.ts records the
     * accepted residual: `fs_write` "can be handed an absolute path outside the project".
     *
     * ⚠ WITHDRAWING STAYS INSTANT. Narrowing a permission needs no ceremony, and asking for
     * confirmation to become MORE restrictive is how a safety prompt becomes noise. Only the widening
     * direction is gated.
     *
     * ⚠ A NATIVE DIALOG, AND NO `confirmed` PARAMETER — the same shape as `cli:trustWorkspace` above
     * and for the identical reason: the actor is renderer-resident code that already reaches this
     * channel, so a confirmation it could render is a confirmation it could also click, and a caller-
     * supplied "already asked" flag would restore the hole outright.
     *
     * ⚠ AND RE-GRANTING WHAT IS ALREADY GRANTED ASKS NOTHING, so a Settings toggle that is already on
     * cannot be used to raise a dialog at will.
     */
    if (next && !agentMayWriteFilesUnprompted()) {
      const answer = await dialog.showMessageBox({
        type: "question",
        buttons: ["Cancel", "Allow file changes"],
        defaultId: 0,
        cancelId: 0,
        title: "Let the assistant change files without asking?",
        message: "Pre-approve file writes for the AI assistant?",
        detail:
          `The assistant will create, edit and overwrite files in your project without asking ` +
          `you each time.\n\n` +
          `You turned this off earlier. If you cancel, it will keep asking before each change.`,
        noLink: true,
      });
      if (answer.response !== 1) {
        /**
         * Recorded as its own outcome: "the participant declined to re-grant" is a different fact from
         * "nobody asked", and it is the evidence a later support conversation needs.
         */
        recordSecurityEvent({
          event: "tool.permission",
          outcome: "refused",
          userId: activeUserId() ?? undefined,
          detail: "fs_write-preapproved:declined",
        });
        return { fileWrites: agentMayWriteFilesUnprompted(), declined: true };
      }
    }

    /**
     * ⚠ READ BEFORE THE WRITE, so the record below can tell a DECISION from a re-statement. See the
     * note on the record itself.
     */
    const wasAllowed = agentMayWriteFilesUnprompted();
    setAgentMayWriteFilesUnprompted(next);
    /**
     * ⚠ RECORDED, in both directions. Granting is obviously a security event; WITHDRAWING is one too,
     * because it changes how every later `agent.spawn` behaves and is the thing a participant will
     * later say they did ("I turned that off"). `tool.permission` is the existing member for
     * "the user allowed or denied an assistant tool call", which is exactly what this decides in advance.
     *
     * ── ⚠ BUT ONLY WHEN IT ACTUALLY CHANGED ───────────────────────────────────────────────────
     *
     * This wrote a record on EVERY call, including when the value already stored was being re-written — so
     * ~2000 invokes with the same value pushed every genuine `auth.signin`, `project.grant`, `agent.trust`
     * and `file.mutate` record out of the rotation window, with no state change to show for it.
     *
     * Re-stating a setting is not a decision, so it is not an event. The generic bound in
     * security-audit.ts covers repeated REFUSALS; this is the same principle for a no-op success,
     * where the honest record count is zero rather than thinned.
     */
    if (next !== wasAllowed) {
      recordSecurityEvent({
        event: "tool.permission",
        outcome: next ? "success" : "refused",
        userId: activeUserId() ?? undefined,
        detail: `fs_write-preapproved:${next}`,
      });
    }
    return { fileWrites: next };
  });

  ipcMain.handle("cli:getModels", async () => {
    /* Declared before the handler body reads it; see `kiroTagline` at the foot of this file. */
    /**
     * ── ⚠ CLAUDE'S MODELS ARE CLAUDE'S, AND THIS HANDLER USED TO OFFER THEM TO EVERYONE ──────
     *
     * Everything below reads `loadClaudeSettings()` — `~/.claude/settings.json`'s `availableModels`
     * and `model`, defaulting to `"opus"` — and the catch branch returns a hardcoded
     * Sonnet/Opus/Haiku list. None of that has anything to do with Codex or Kiro, so selecting Codex
     * showed a picker offering "Opus", and the line beneath the composer claimed Opus was the model
     * answering. It was not merely cosmetic: `buildCliArgs` passes the selection through, so picking
     * one sent `-m opus` to a CLI that does not know it.
     *
     * ⚠ AN EMPTY LIST IS THE HONEST ANSWER WHEN THERE IS NOTHING TO ENUMERATE, and the composer hides the
     * picker rather than offering a guess. That is now the fallback for an UNRECOGNISED assistant only —
     * every assistant this app ships with can be enumerated.
     *
     * ⚠ CODEX HAS A REAL CATALOGUE, ASKED FOR RATHER THAN TRANSCRIBED. Codex models are
     * selectable, because `codex app-server` answers a
     * `model/list` request with its own models AND the reasoning efforts each one advertises. See
     * `codex-models.ts` for why that is fetched instead of hardcoded from a screenshot.
     *
     * ⚠ AND SO DOES KIRO, WHICH THIS FILE USED TO DENY. Users can see the available models and
     * choose one on Kiro and Claude as well — the note here previously said Kiro's models "are set
     * server-side" and returned nothing. Measured against kiro-cli 2.18.1, that is false: `kiro-cli chat
     * --list-models --format json` prints 21 models with a stated default. The claim is corrected rather
     * than left standing, because it was the reason nobody looked again. See `kiro-models.ts`.
     */
    const command = assistantCommand();

    /* `includes` and not `===`, matching the `claude` test below: `ai_command` may carry a path or a
       suffix, and `assistantIdOf` lives in the renderer — main does not reach across that boundary. */
    if (command.includes("codex")) {
      const catalogue = await fetchCodexModels();
      return {
        /**
         * `tier` and `isExtended` are Claude's vocabulary — the 1M badge and the opus/sonnet/haiku
         * grouping — and Codex has neither, so they are stated as absent rather than faked.
         *
         * ⚠ THE ADVERTISED EFFORTS ARE DELIBERATELY NOT PASSED ON. They are read (see `codex-models.ts`)
         * and cannot be USED: setting one needs `-c`, and any `-c` override breaks this config's Bedrock
         * credential provider — see the note in `buildCliArgs`. Offering them here would put a control in
         * the composer that fails the whole turn.
         */
        models: catalogue.models.map((m) => ({
          id: m.id,
          label: m.label,
          tier: "other",
          isExtended: false,
          tagline: m.description,
        })),
        defaultModel: catalogue.defaultModel || null,
      };
    }

    /**
     * ── ⚠ KIRO, ANSWERED FROM KIRO — AND BEFORE `loadClaudeSettings` IS REACHED ────────────────
     *
     * ⚠ THE ORDER OF THIS BRANCH IS THE WHOLE RULE, not a style choice. `model-list-scope.test.ts` exists
     * because this handler once read `~/.claude/settings.json` for EVERY assistant, so Codex was offered
     * "Opus" and the composer claimed Opus was answering — and `buildCliArgs` then sent `-m opus` to a CLI
     * that had never heard of it. Placing this after the Claude read would reintroduce that bug for Kiro.
     *
     * ⚠ `tier` AND `isExtended` ARE STATED AS ABSENT RATHER THAN FAKED. They are Claude's vocabulary — the
     * opus/sonnet/haiku grouping and the 1M badge. Kiro's catalogue happens to CONTAIN Claude models
     * (`claude-opus-5`, `claude-haiku-4.5`), which makes guessing a tier from the name look sensible and is
     * exactly the trap: Kiro serves them through its own gateway, its ids are not Claude's ids, and a badge
     * implying otherwise would be a claim about a different product's billing.
     *
     * The relative cost Kiro DOES publish travels in the tagline instead, where it can only be read as what
     * it is — a comparison between two Kiro models.
     */
    if (command.includes("kiro")) {
      const catalogue = await fetchKiroModels();
      return {
        models: catalogue.models.map((m) => ({
          id: m.id,
          label: m.label,
          tier: "other",
          isExtended: false,
          tagline: kiroTagline(m),
        })),
        defaultModel: catalogue.defaultModel || null,
      };
    }

    if (!command.includes("claude")) {
      return { models: [], defaultModel: null };
    }

    try {
      // Layered like the spawn path: a project may pin its own availableModels/model,
      // and offering a model the project has overridden would let a user pick something
      // the CLI then refuses.
      const { merged } = loadClaudeSettings(getSetting("project_path") || undefined);

      const available: string[] = (merged.availableModels as string[]) || [];
      /**
       * ⚠ RETURNED WITH ITS ROUTING PREFIX INTACT, AND THAT IS CORRECT. On this machine `merged.model` is
       * `global.anthropic.claude-opus-5[1m]` while `availableModels` holds the short `claude-opus-5[1m]` —
       * a real mismatch, and the temptation is to reconcile it here.
       *
       * It is already reconciled, in ONE place: `renderer/lib/model-label.ts` compares on the stripped form
       * (`stripModelPrefix`) so the dropdown and the line beneath it name the same model, and the `<select>`
       * uses `""` for "use the default" rather than matching this string against an option. Resolving it a
       * second time here would put prefix knowledge in two modules that must agree — and the one with the
       * tests is the renderer's.
       */
      const defaultModel: string = (merged.model as string) || "opus";

      // Group into display-friendly list
      const models = available.map((id: string) => {
        const isExtended = id.includes("[1m]");
        const base = id.replace("[1m]", "");
        let label = base;
        if (isExtended) label += " (Extended)";

        let tier = "other";
        if (base.includes("opus")) tier = "opus";
        else if (base.includes("sonnet")) tier = "sonnet";
        else if (base.includes("haiku")) tier = "haiku";

        return { id, label, tier, isExtended };
      });

      return { models, defaultModel };
    } catch {
      return {
        models: [
          { id: "sonnet", label: "Sonnet", tier: "sonnet", isExtended: false },
          { id: "opus", label: "Opus", tier: "opus", isExtended: false },
          { id: "haiku", label: "Haiku", tier: "haiku", isExtended: false },
        ],
        defaultModel: "sonnet",
      };
    }
  });
}


/**
 * The one line of extra context Kiro publishes about a model, or "".
 *
 * ⚠ THE COST IS PHRASED AS A MULTIPLE, NEVER AS MONEY, and never summed with anything. `rate_multiplier` is
 * Kiro's own relative rate — it compares two Kiro models and says nothing about a Claude or Codex turn. See
 * the note in `kiro-models.ts` and BACKLOG 9a on credits being a billing unit rather than a count.
 *
 * ⚠ `1×` IS STILL WORTH PRINTING. It is the baseline a participant compares the others against, so omitting
 * it would leave the cheapest and the reference model looking equally unlabelled.
 */
export function kiroTagline(model: Pick<KiroModel, "description" | "contextWindowTokens" | "rateMultiplier">): string {
  const parts: string[] = [];
  if (model.description) parts.push(model.description);

  const window = model.contextWindowTokens;
  if (window !== null && window > 0) {
    /* 1_000_000 → "1M", 272_000 → "272k". The exact figure is noise at this size. */
    parts.push(
      window >= 1_000_000
        ? `${Number((window / 1_000_000).toFixed(1))}M context`
        : `${Math.round(window / 1000)}k context`
    );
  }

  if (model.rateMultiplier !== null) parts.push(`${model.rateMultiplier}× rate`);

  return parts.join(" · ");
}

/**
 * @param continued  Whether this chat already has a CLI thread — from SQLite, so it survives a restart.
 * @param threadId   The CLI's OWN thread id when we have one. Codex uses it to resume the RIGHT thread.
 */
/**
 * Exported for the tests. This is the decision that can actually be WRONG — which subcommand continues a
 * conversation, and in what argument order — and reaching it otherwise needs a real child process, an
 * Electron sender and a live CLI. Same reasoning as `outcomeForStep` in desktop-sign-in.ts.
 */
/** One audit record per agent launch: which assistant, and under what tool policy. */
function recordAgentSpawn(cmd: string, args: readonly string[]): void {
  recordSecurityEvent({
    event: "agent.spawn",
    outcome: "success",
    userId: activeUserId() ?? undefined,
    // The basename only: an absolute path to the binary names the user's home directory.
    detail: `${redactedTarget(cmd)}:${toolPolicyOf(args)}`,
  });
}

export function buildCliArgs(
  command: string,
  continued: boolean,
  model?: string,
  threadId?: string | null,
  /**
   * ⚠ PASSED IN, NOT READ HERE, and the reason is this function's whole character: it is a PURE argv
   * builder, and its own test suite calls it directly with no database, no settings and no Electron.
   * A first version of the `fs_write` opt-out read the setting inside this switch and broke five
   * continuity tests with "Cannot read properties of undefined (reading 'prepare')" — a pure function
   * quietly acquiring a global dependency, which is the shape that makes argv untestable.
   *
   * Defaults to `true` so every existing caller and test keeps today's behaviour. See
   * agent-trust-setting.ts for why absent means allowed.
   */
  trustFileWrites = true
): { cmd: string; args: string[] } {
  /**
   * ⚠ SWITCH ON THE CANONICAL COMMAND, SPAWN THE RENAMED ONE. A local rename override
   * (assistant-commands.json) changes WHICH BINARY runs; it must not change WHICH ARGV is built.
   * Switching on the raw `command` sent `codex_bedrock` to the fail-closed default below and broke
   * Codex entirely. See canonicalCommand / spawnCommandFor in assistant-command.ts.
   */
  switch (canonicalCommand(command)) {
    case "claude": {
      /**
       * ── ⚠ READ-ONLY TOOLS ONLY. `Bash`, `Edit` AND `Write` ARE NO LONGER PRE-APPROVED ──────────
       *
       * This argv used to be `--allowedTools Bash Read Edit Write Skill`, which as claude-code.ts's own
       * header explains "PRE-APPROVES those five, so Claude never asks about them" — arbitrary shell with no
       * prompt, on a path where no prompt was possible.
       *
       * ⚠ AND THE PERMISSION RELAY WAS DEAD, which is why narrowing is the fix here rather than
       * prompting. `pendingPermissions` is declared in this file and only ever READ and deleted —
       * nothing calls `.set` — and `cli:permission-request` is emitted only from claude-code.ts. So
       * `cli:permission-respond` had nothing to answer, exactly as that header describes. Building the
       * bidirectional `control_request` handshake by hand here would be a second implementation of
       * what the SDK already does correctly, on the path the renderer does not use.
       *
       * ⚠ SO WHAT HAPPENS TO A TOOL THAT IS NOT ON THE LIST: it is refused, not queued for an
       * approval nobody can give. Same shape as the Kiro non-interactive path (see kiro-trust.ts) —
       * fail-closed and legible on a path with nobody to ask.
       *
       * ⚠ AND THE COST IS BOUNDED, because this is not the path Claude chats take. The renderer routes
       * `currentCli === "claude"` to `claude-sdk:*` (claude-code.ts), which keeps
       * `permissionMode: "default"` and an unconditional `canUseTool`, so a participant gets a real
       * prompt and the agent can still do everything with approval. This branch is the retained
       * fallback, and a fallback that silently grants shell access is worse than one that cannot write.
       */
      const args = [
        "-p",
        "--verbose",
        "--output-format", "stream-json",
        "--allowedTools", "Read", "Grep", "Glob",
      ];
      if (model) {
        args.push("--model", model);
      }
      /**
       * ⚠ `--resume <id>` BEATS `--continue`, and the difference is which conversation you get.
       *
       * VERIFIED AGAINST THE INSTALLED BINARY rather than assumed — `claude --help`:
       *   -c, --continue        "Continue the most recent conversation in <cwd>"
       *   -r, --resume [value]  "Resume a conversation by session ID"
       *
       * `--continue` is directory-scoped, so with two chats in one project it resumes whichever ran last
       * — and after a restart, before any id was recorded, it was the only option. Naming the session is
       * what makes a chat its own conversation.
       *
       * `--continue` stays as the fallback for chats that have prior turns but no recorded id: sessions
       * that predate this, where the directory's latest still beats starting over.
       */
      if (threadId) {
        args.push("--resume", threadId);
      } else if (continued) {
        args.push("--continue");
      }
      return { cmd: spawnCommandFor("claude"), args };
    }
    case "kiro":
    case "kiro-cli": {
      /**
       * ⚠ `--trust-tools=…`, NOT `--trust-all-tools` — see kiro-trust.ts. This path is
       * `--no-interactive`, so there is nobody to ask, and the measured behaviour of an untrusted
       * tool here is a clean refusal rather than a hang:
       *
       *     Command execute_bash is rejected because it matches one or more rules on the denied list:
       *       - non-interactive mode (no user to approve)
       *
       * The agent then explains itself and the turn ends normally. Fail-closed and legible, which is
       * the right outcome for a path with no prompt: the alternative was shell access with no
       * prompt at all.
       */
      const kiroArgs = ["chat", "--no-interactive", kiroTrustArg(trustFileWrites)];
      if (model) {
        kiroArgs.push("--model", model);
      }
      // Resume the most recent conversation in this directory for context continuity
      /**
       * ⚠ `--resume-id <SESSION_ID>` WHEN WE HAVE ONE, and `-r` only as the fallback.
       *
       * VERIFIED against `kiro-cli chat --help`:
       *   -r, --resume              "Resume the most recent conversation from this directory"
       *   --resume-id <SESSION_ID>  "Resume a specific conversation by session ID"
       *
       * ⚠ THIS BRANCH IS UNREACHABLE FROM THE UI TODAY, and the note matters more than the code:
       * `cli:useAcpMode` returns true for both `kiro` and `kiro-cli`, so Kiro always routes to
       * `kiro-acp.ts` — which already persists `acp_session_id` and reloads by it (migration 2). This is
       * a fallback for ACP being unavailable, so it is corrected in the same shape rather than left as
       * the one path that still guesses. No id is currently observable here, because this path reads
       * kiro-cli's plain output rather than a protocol, so in practice it takes the `-r` branch.
       */
      if (threadId) {
        kiroArgs.push("--resume-id", threadId);
      } else if (continued) {
        kiroArgs.push("--resume");
      }
      return { cmd: spawnCommandFor("kiro-cli"), args: kiroArgs };
    }
    case "codex": {
      /**
       * ⚠ `--json` WAS MISSING, AND THAT IS WHY CODEX DID NOT STREAM.
       *
       * Without it, `codex exec` prints a human-formatted transcript to stdout and the desktop fell through to
       * a plain-text branch that forwarded raw chunks — including ANSI art and progress redraws — so a turn
       * arrived as one late blob rather than as events.
       *
       * VERIFIED AGAINST THE REAL CLI (0.146.1.322) rather than assumed, because `codex exec --help` documents
       * the flag but not the schema. A probe emitted exactly this:
       *
       *   {"type":"thread.started","thread_id":"019ff11f-…"}
       *   {"type":"turn.started"}
       *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Hello from Codex"}}
       *   {"type":"turn.completed","usage":{"input_tokens":13027,…,"output_tokens":61}}
       *
       * ⚠ NOTE WHAT THAT SHAPE IS NOT: it shares no field names with Claude's `stream-json`
       * (`type:"assistant"` with a content array, `type:"result"`). The existing JSON parser understands only
       * Claude's, so Codex needs its own — see the `codex` branch in the stream handler.
       */
      const codexArgs = ["exec", "--json", "--skip-git-repo-check"];

      /**
       * ── ⚠ `-m` ONLY. `-c` IS UNSAFE HERE, AND IT BROKE EVERY CODEX TURN ────────────────────
       *
       * Two turns in the database, 13:46 and 14:11, with a user message and NO reply — and the turn before
       * them, at 13:08, worked. What landed in between was the model picker.
       *
       * ⚠ THE CAUSE IS `-c`, NOT THE MODEL, and it is not the value either. Measured against the installed
       * CLI (0.146.1) on one thread, back to back:
       *
       *     no flags                                → replies
       *     -m openai.gpt-5.4  (same as config)     → replies
       *     -c model_reasoning_effort=high (SAME!)  → "failed to load AWS credentials: the credential
       *     -c check_for_update_on_startup=false    →  provider was not enabled", then turn.failed
       *
       * ANY `-c` override breaks the credential provider — even one setting a key to the value it already
       * has, and even one on an unrelated key. This config selects `model_provider = "amazon-bedrock"` with a
       * nested `[model_providers.amazon-bedrock.aws]` table, and passing `-c` evidently re-materialises the
       * config in a way that loses it.
       *
       * ⚠ SO THE REASONING EFFORT CANNOT BE SET ON THIS PATH AT ALL. `codex exec --help` offers no dedicated
       * flag for it (`-c` is the documented route) and there is no environment variable. Rather than keep a
       * control that silently fails every turn, the effort picker was REMOVED — the same reasoning as for the Claude
       * model list that was being offered to Codex: a control that looks authoritative and is not.
       *
       * `codex-models.ts` still READS each model's advertised efforts, because that is what `model/list`
       * returns and the asymmetry is worth keeping recorded — but nothing sends them.
       *
       * The flags go AFTER the `resume` subcommand and its id: `resume` is positional, so a flag before it
       * would be read as the thread to resume.
       */
      const codexTuning: string[] = [];
      if (model) codexTuning.push("-m", model);
      /**
       * CONTEXT CONTINUITY. `codex exec resume --last` continues the most recent thread in this directory,
       * which is the same intent as Claude's `--resume` and Kiro's. Without it every message is turn one and
       * the assistant cannot see what it just said.
       *
       * ⚠ `resume` is a SUBCOMMAND, so it goes immediately after `exec` — before the flags, unlike Claude's
       * where `--resume` is an option. Ordering it wrongly makes the CLI treat `resume` as the prompt.
       */
      /**
       * ⚠ `resume <threadId>` AND NOT `resume --last`, WHICH WAS THE SECOND HALF OF THE REPORTED BUG.
       *
       * `--last` resumes the most recent thread IN THE DIRECTORY, not the thread belonging to the chat that
       * is open. With two chats in one project, switching between them and sending a message resumed
       * whichever was used last — so two conversations could silently braid together, and the symptom looks
       * like the assistant "remembering the wrong thing" rather than like a bug.
       *
       * The id comes from Codex's own `thread.started` event, stored on the chat row. `--last` remains the
       * FALLBACK for a chat that has prior turns but no recorded id — sessions that existed before this
       * column, where resuming the directory's latest is still better than starting over.
       */
      if (threadId) {
        return {
          /**
           * ⚠ spawnCommandFor HERE TOO. This resume branch kept a hardcoded "codex" through the
           * first fix, so a renamed install ran codex_bedrock for the FIRST message of a thread and
           * plain codex for every continuation — two different binaries either side of one
           * conversation, and on a real Bedrock-backed build that means resuming a thread the other
           * binary never created.
           */
          cmd: spawnCommandFor("codex"),
          args: ["exec", "resume", threadId, "--json", "--skip-git-repo-check", ...codexTuning],
        };
      }
      if (continued) {
        return {
          /* Same as the branch above: the rename must hold across a resume. */
          cmd: spawnCommandFor("codex"),
          args: ["exec", "resume", "--last", "--json", "--skip-git-repo-check", ...codexTuning],
        };
      }
      return { cmd: spawnCommandFor("codex"), args: [...codexArgs, ...codexTuning] };
    }
    /**
     * ⚠ THIS ARM WAS THE HIGH FINDING'S LAST STEP, and it is now a refusal.
     *
     * It used to be `return { cmd: command, args: [] }` — an unmatched `ai_command` spawned verbatim,
     * which is what turned a writable setting into arbitrary code execution. Every caller passes a
     * value through `resolveAssistantCommand` now, so reaching here means the switch and the
     * allowlist have drifted apart, and the safe reading of that is "do not execute this".
     *
     * Throwing rather than substituting Claude: the callers already wrap `buildCliArgs` in a try and
     * report the failure to the user, whereas silently running a different assistant would hide a
     * genuine bug behind working software.
     */
    default:
      throw new Error(
        "Unsupported assistant command — refusing to spawn. " +
          "Add it to COMMAND_FOR_ASSISTANT and give it a case here."
      );
  }
}
