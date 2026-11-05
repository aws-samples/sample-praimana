import { ipcMain } from "electron";
import { safeModelId } from "../model-id";
import os from "os";
import path from "path";
import { spawnCommandFor } from "../assistant-command";
import fs from "fs";
import { randomUUID } from "crypto";
import { query, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getDb, readSetting } from "../database";
import { isSessionOwnedByActiveAccount } from "../session-ownership";
import { activeUserId } from "../active-account";
import { assistantPath } from "../assistant-path";
import { assertWithinProject } from "../project-paths";
import { loadClaudeSettings, describeAuthGap } from "../claude-settings";
import { debugLog } from "../debug-log";
import { syncCliTurn } from "./cli-sync";
import { claudeTurnTokens, type TurnTokens } from "./claude-usage";
import { SYNC_PENDING } from "../message-sync-status";
import { recordSecurityEvent } from "../security-audit";
import { PERMISSION_PROMPT_TIMEOUT_MS } from "../kiro-trust";

/**
 * ── THE ENVIRONMENT ELECTRON DOES NOT PROVIDE ──
 *
 * ⚠ SHIPPING WITHOUT THIS PRODUCED "Not logged in · Please run /login" — reported immediately, and
 * reproduced exactly: running the SDK with a stripped environment returns that message verbatim, and
 * adding these four values back makes the same prompt succeed.
 *
 * The SDK spawns the same `claude` binary, so it inherits the same Electron problem the spawn path
 * already compensated for — and I did not carry the compensation across, which is the whole defect.
 * This is NOT configuration; it is repair of how a GUI app starts a child process:
 *
 *   HOME  — an Electron app launched from Finder/dock may not have it, and without HOME the CLI
 *           cannot find ~/.claude at all, so it reports itself as logged out even though the user
 *           signed in minutes earlier. THIS is the reported bug.
 *   PATH  — no shell PATH is inherited from Finder, so the `claude` binary is not findable. The
 *           toolbox and ~/.local/bin entries come first because that is where it is installed here.
 *   TERM / NO_COLOR — the SDK parses the CLI's frames; ANSI escapes would corrupt them.
 *
 * Kept IDENTICAL to cli-assistant.ts's `spawnEnv` on purpose. Two assistant paths that resolve
 * credentials differently would mean "it works in one and not the other", which is a far more
 * confusing bug than either being broken outright.
 */
/**
 * ── WHICH `claude` BINARY THE SDK RUNS, AND WHY IT MUST BE THE USER'S ──
 *
 * ⚠ THE SECOND CAUSE OF "Not logged in · Please run /login", and the one the env fix did not
 * address. Reported again after that fix, so this was probed rather than reasoned about:
 *
 *   the SDK's BUNDLED binary  -> "2.1.226 (Claude Code)"            — stock build
 *   the user's binary         -> "2.1.226.634 (Claude Code)"        — wrapper-installed build
 *
 * `@anthropic-ai/claude-agent-sdk` ships its own platform binary (`claude-agent-sdk-darwin-arm64`)
 * and spawns THAT by default. It is a different build from the one the participant signed into, with
 * different auth — so the credentials in ~/.claude belong to a CLI the SDK was never running. Setting
 * HOME correctly could not help: the right home, handed to the wrong binary.
 *
 * Verified: pointing `pathToClaudeCodeExecutable` at the user's binary makes the identical prompt
 * succeed.
 *
 * RESOLVED FROM PATH, NOT HARDCODED. The standing rule is no hardcoded paths, and a
 * participant's install location differs (toolbox on an Amazon machine, Homebrew or ~/.local
 * elsewhere).
 *
 * ⚠ THE `undefined` FALLBACK IS NO LONGER A WORKING PATH IN A PACKAGED BUILD. It used to leave the
 * SDK on its bundled binary — worse auth, but an assistant that still ran. The packaged app now
 * EXCLUDES the SDK's per-architecture binaries (see build.mac.files / build.win.files): they cost
 * ~300MB EACH, 600MB of a universal dmg, to ship a fallback for a machine that has no assistant CLI
 * installed. Participants bring their own.
 *
 * So `undefined` here now means the SDK will look for a bundled binary that is not present, and the
 * query fails. In a dev tree it still works, because node_modules has the host's platform package —
 * which is exactly the gap worth knowing about: this path cannot be exercised by running from source.
 * A user-facing "no assistant CLI found on PATH" error belongs here rather than an SDK stack trace.
 */
function resolveClaudeBinary(env: NodeJS.ProcessEnv): string | undefined {
  /**
   * ⚠ THE FILENAME IS NOT ALWAYS "claude". A local rename override
   * (<userData>/assistant-commands.json, e.g. { "claude": "claude_bedrock" }) exists for installs
   * that ship a differently-named wrapper. This function hardcoded "claude" and so ignored it — and
   * because THIS is the path Claude chats actually take (the SDK, not buildCliArgs), the rename
   * appeared to do nothing for Claude while working for the other assistants.
   *
   * Identity stays canonical everywhere else; only the executable name moves. See spawnCommandFor.
   */
  const filename = spawnCommandFor("claude");
  const dirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, filename);  // nosemgrep: path-join-resolve-traversal
    try {
      // X_OK, not existsSync: a non-executable file of the same name must not be selected.
      fs.accessSync(candidate, fs.constants.X_OK);  // nosemgrep: detect-non-literal-fs-filename
      return candidate;
    } catch {
      // Not here — keep looking. A missing directory on PATH is normal.
    }
  }
  return undefined;
}

/**
 * Persist the assistant's reply to the LOCAL SQLite transcript, and return its row id.
 *
 * ⚠ OMITTING THIS MADE THE REPLY VANISH — the streamed messages disappeared from the UI.
 *
 * The renderer streams `cli:output` into a scratch buffer, then on `cli:response-complete` it CLEARS
 * that buffer and reloads the message list from SQLite. The spawn path writes the row before
 * completing, so the reload finds it; this path did not, so the reload found nothing and the text the
 * participant had just watched arrive disappeared at the moment the turn finished. The turn had
 * SUCCEEDED — only the record was missing.
 *
 * Identical shape to cli-assistant.ts's `saveMessage`, deliberately: the two paths write the same
 * table that the same UI reads, so a divergence here would be a transcript that renders differently
 * depending on which implementation produced it.
 *
 * ⚠ AND IT HAD SILENTLY STOPPED BEING IDENTICAL. When token capture was added it went into the Codex path
 * only, so this INSERT still named five columns while its twin named ten — and the claim of parity directly
 * above was part of why that was easy to miss. Claude conversations showed a blank where Codex showed
 * `12.4k ctx · 3.1k out`, not because the display was provider-specific (it never was) but because nothing
 * here ever wrote a count.
 *
 * The USER message is not written here — the renderer already saves it via `addMessage` before the
 * send. Writing it again would double every prompt in the history.
 */
function saveAssistantMessage(
  sessionId: string,
  content: string,
  tokens?: TurnTokens
): string {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    // 'pending' until the push is acknowledged — see message-sync-status.ts.
    `INSERT INTO chat_messages
       (id, session_id, role, content, sync_status,
        input_tokens, output_tokens, cached_input_tokens, cache_write_input_tokens,
        reasoning_output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    "assistant",
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

function assistantEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: "dumb",
    NO_COLOR: "1",
    HOME: os.homedir(),
    PATH: assistantPath(),
  };

  /**
   * ── WE SET NO REGION AND NO PROFILE. THE CLI RESOLVES ITS OWN. ──
   *
   * THE RULE: set no region; let the user's CLI default apply.
   *
   * ⚠ AND `...process.env` WAS QUIETLY BREAKING THAT. Electron inherits the environment of whatever
   * launched it, so an AWS_REGION exported in the user's shell rides along into the child — measured:
   * this machine's shell carries AWS_REGION=us-west-2. Passing that on means the desktop app can send
   * the CLI to a DIFFERENT region than the same CLI would choose when run from a terminal, and the
   * participant has no way to see why. Inheriting a value is still setting it.
   *
   * Deleted rather than overwritten, which is the distinction that matters: an unset variable lets the
   * CLI fall through to its own resolution (settings files, ~/.aws/config, its credential export),
   * while any value we pick — even a "sensible" one — overrides all of that. Verified the CLI resolves
   * a region perfectly well with none of these set.
   *
   * CREDENTIALS GO TOO, for the reason kiro-acp.ts and framework.ts already document: an inherited
   * key or profile overrides the CLI's own auth and points it at a role that may not be authorised —
   * "causes 403 not-authorized", in their words. This file just relearned that lesson the hard way, so
   * it now follows the same precedent instead of being the one path that does not.
   */
  delete env.AWS_REGION;
  delete env.AWS_DEFAULT_REGION;
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;

  return env;
}

/**
 * ── CLAUDE VIA THE OFFICIAL SDK, WITH REAL PERMISSION PROMPTS ──
 *
 * A PARALLEL implementation of the assistant path, registered under `claude-sdk:*` channels so it
 * runs ALONGSIDE `cli-assistant.ts` rather than replacing it. Nothing switches automatically; the
 * renderer chooses which set of channels to call, and the old spawn path is untouched. That is the
 * whole point of keeping both — this is the hottest path in the desktop app, and a workshop is a bad
 * place to discover a regression in it.
 *
 * ── WHY THIS EXISTS: THE REPORTED BUG ──
 *
 * "Claude terminal asking for permissions to edit files are not shown on desktop to the user to click
 * or approve." Correct, and the cause was the spawn arguments:
 *
 *     claude -p --output-format stream-json --allowedTools Bash Read Edit Write Skill
 *
 * `--allowedTools` PRE-APPROVES those five, so Claude never asks about them — and anything OUTSIDE
 * the list is refused after the fact with no prompt at all. A participant saw "the change is ready —
 * approve the write" and then nothing, for ever, with no way to approve. Meanwhile the renderer has
 * had a complete approve/deny UI all along, listening for a `cli:permission-request` event that
 * NOTHING IN MAIN EVER SENT.
 *
 * ── HOW THE VS CODE EXTENSION DOES IT, WHICH IS WHY THIS IS THE SDK ──
 *
 * I decompiled the installed extension (anthropic.claude-code-2.1.226) to find out. It passes
 * `--permission-prompt-tool stdio` and answers a bidirectional `control_request` /
 * `can_use_tool` handshake over the process's stdin. That flag is real but ABSENT FROM `--help`,
 * which is why an earlier probe of mine concluded — wrongly — that headless mode cannot prompt.
 *
 * The extension does not implement that handshake by hand: it uses `@anthropic-ai/claude-agent-sdk`,
 * where the same capability is a documented, typed option called `canUseTool`. So this file uses the
 * SDK too. Verified end to end against the real CLI (v2.1.226) before being written:
 *
 *     allow path → canUseTool fired for Read then Edit; returning {behavior:"allow"} applied the edit
 *     deny  path → returning {behavior:"deny"} blocked it; file unchanged; result carried
 *                  permission_denials: 1
 *
 * ── WHAT IS DELIBERATELY DIFFERENT FROM cli-assistant.ts ──
 *
 * NO `--allowedTools`. It is mutually exclusive with `canUseTool` for the same tool (the SDK throws
 * if both are set), and that exclusivity IS the trade: participants get a prompt instead of a silent
 * grant. Pre-approving and prompting are the same decision made in two places.
 */

/** Emitted to the renderer; mirrors the shape AssistantChatView's permission card already renders. */
interface PermissionRequestEvent {
  sessionId: string;
  id: string;
  tool: string;
  description: string;
  input: unknown;
}

/**
 * One in-flight prompt, parked until the participant answers.
 *
 * ⚠ A PARKED PROMPT HAS NO DEADLINE, and the SDK's own types say so: "an accidental null means no
 * control_response is sent and the tool stays blocked indefinitely — permission prompts have no park
 * deadline." So every exit path must resolve these, including cancel, session stop and abort. A
 * forgotten resolve is not a slow turn, it is a turn that never ends.
 *
 * There is deliberately NO timeout that auto-denies. A participant reading a diff before approving a
 * write is doing exactly the right thing, and a 30-second rug-pull would train them to click fast —
 * the opposite of what a permission prompt is for. The bound is the SESSION: stopping it settles
 * every pending prompt (see `settlePending`).
 */
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  tool: string;
}

/** Per-session state. A session is one chat thread in the UI. */
interface SessionState {
  /** Aborts the SDK query — the only way to stop a turn mid-flight. */
  abort: AbortController;
  /** Prompts awaiting a click, keyed by the id handed to the renderer. */
  pending: Map<string, PendingPermission>;
  /** The SDK's own session id, for `resume` on the next turn. */
  resumeId?: string;
  /** True while a turn is streaming, so `isRunning` can answer honestly. */
  running: boolean;
  /**
   * ── ⚠ WHICH TURN IS THE CURRENT ONE ───────────────────────────────────────────────────────
   *
   * `running` is cleared in a `finally`, which is correct and was not enough: the failure mode is that
   * the `for await` over the SDK stream NEVER RETURNS — it does not yield, throw or complete — so the
   * `finally` never runs and the flag stays true for the life of the process. Nothing in this file had a
   * deadline (`grep setTimeout` returned nothing), while both sibling paths do: `kiro-acp.ts` bounds a
   * parked prompt at `PERMISSION_PROMPT_TIMEOUT_MS` and `framework.ts` kills its agent at 120s.
   *
   * So the watchdog below has to be able to end a turn WITHOUT the loop's cooperation — the whole bug is
   * that the loop cannot be relied on to unwind. This counter is how the two tell each other apart: the
   * watchdog increments it to disown a turn, the loop checks it before emitting another frame, and the
   * `finally` checks it before clearing a flag that may now belong to a NEWER turn.
   */
  turn: number;
}

/**
 * Per-tool-result output ceiling for the transcript.
 *
 * A tool can emit megabytes (a `cat`, a full test run). Unbounded, that crosses the IPC boundary in
 * full and then lives in renderer state for the session — on a workshop laptop, for hours. The UI
 * shows a preview and says when it truncated, which is the honest version of a summary.
 */
const MAX_TOOL_OUTPUT_CHARS = 2_000;

/**
 * ── ⚠ HOW LONG A TURN MAY PRODUCE NOTHING BEFORE IT IS ABANDONED ──────────────────────────────
 *
 * ⚠ IDLE, NOT TOTAL, and that distinction is the whole design. A legitimate agentic turn can run for a
 * very long time — reading files, running tests, writing a game — and a total cap would kill exactly the
 * work this app exists to do. What is never legitimate is a turn that emits NOTHING: no frame, no token,
 * no tool call. The timer is reset by every frame, so a turn that is working is never interrupted no
 * matter how long it takes, and a turn that has silently died is reclaimed.
 *
 * ⚠ STRICTLY LONGER THAN `PERMISSION_PROMPT_TIMEOUT_MS`, AND THE MARGIN IS THE POINT. A parked prompt is
 * the most likely reason a turn goes quiet, and the two deadlines do DIFFERENT things: the prompt's
 * denies one tool call and lets the turn carry on, while this one ends the turn outright. So the prompt
 * must get to act first — otherwise a turn that would have recovered from a denial is killed instead, and
 * the gentler remedy never runs.
 *
 * ⚠ THEY WERE EQUAL IN THE FIRST VERSION, WHICH MADE THEM RACE. Mutation testing is what found it:
 * disabling the prompt deadline changed nothing, because the watchdog fired at the same instant and
 * `settlePending` denied the prompt anyway. Two controls collapsed into one, and the redundant one was
 * the one with the better outcome.
 *
 * The five-minute margin is the window in which a denied tool call can produce a frame and revive the
 * turn. If nothing arrives in it, the stream itself is the problem and ending the turn is correct.
 */
const TURN_IDLE_TIMEOUT_MS = PERMISSION_PROMPT_TIMEOUT_MS + 5 * 60 * 1000;

const sessions = new Map<string, SessionState>();

/**
 * ── WHY THE RESUME ID IS PERSISTED, NOT JUST HELD IN THE MAP ──
 *
 * The Map above lives in the MAIN PROCESS, so it dies with it: quitting the app, or a dev rebuild,
 * empties it. `resumeId` went with it, the next turn omitted `resume`, and the SDK opened a BRAND NEW
 * conversation. Claude's answer was then perfectly honest — it really was the first message of the
 * conversation it had — and completely baffling to a participant reading a full transcript above it.
 *
 * ⚠ AND IT IS WORSE THAN A LOST REPLY. The renderer's transcript is loaded from SQLite, so the history
 * stays on screen and looks intact. Nothing signals that the assistant can no longer see any of it —
 * every later turn in that chat silently answers without its context.
 *
 * Kiro already solved this for its own protocol (`acp_session_id`, migration 2, read via
 * `session/load`). This mirrors that precedent rather than inventing a mechanism: one nullable column,
 * written when the SDK reports its id, read when the Map is cold.
 */
function loadResumeId(sessionId: string): string | undefined {
  try {
    const row = getDb()
      .prepare("SELECT sdk_session_id FROM chat_sessions WHERE id = ?")
      .get(sessionId) as { sdk_session_id?: string | null } | undefined;
    return row?.sdk_session_id ?? undefined;
  } catch (err) {
    /**
     * A MISSING COLUMN IS NOT A FAILED TURN. On a database that predates the migration this throws, and
     * the right outcome is a fresh conversation — which is exactly the old behaviour — rather than a
     * chat that cannot send at all. Logged so a genuine DB fault is still visible.
     */
    debugLog("[claude-code] could not read sdk_session_id:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Persist the SDK's session id so the NEXT launch can resume this conversation. */
function saveResumeId(sessionId: string, resumeId: string): void {
  try {
    getDb()
      .prepare("UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?")
      .run(resumeId, sessionId);
  } catch (err) {
    // Same reasoning as above: losing resumability is bad, failing the turn is worse.
    debugLog("[claude-code] could not persist sdk_session_id:", err instanceof Error ? err.message : err);
  }
}

function stateFor(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: SessionState = {
    abort: new AbortController(),
    pending: new Map(),
    running: false,
    turn: 0,
    /**
     * HYDRATED ON FIRST TOUCH AFTER A RESTART. This is the whole fix: a cold Map now recovers the id
     * from disk instead of silently starting over.
     *
     * `undefined` when the chat has no stored id — a brand-new session, one whose first turn never
     * completed, or a pre-migration row — and the send path omits `resume` in that case, which is the
     * correct behaviour for all three.
     */
    resumeId: loadResumeId(sessionId),
  };
  sessions.set(sessionId, created);
  return created;
}

/**
 * Settle every parked prompt for a session, so nothing waits on a click that can no longer come.
 *
 * DENY, not allow. A prompt abandoned because the turn was cancelled, the app quit, or the process
 * died has not been approved by anybody — and defaulting to allow would turn "I closed the window"
 * into "I authorised a file write". Fail closed.
 */
function settlePending(state: SessionState, reason: string): void {
  for (const [, p] of state.pending) {
    p.resolve({ behavior: "deny", message: reason });
  }
  state.pending.clear();
}

export function setupClaudeCodeHandlers() {
  /**
   * Send a message and stream the reply.
   *
   * Channel names are `claude-sdk:*` so both implementations can be registered at once — Electron
   * throws on a duplicate `ipcMain.handle` for the same channel, which is a useful forcing function:
   * the two paths cannot silently collide.
   */
  ipcMain.handle(
    "claude-sdk:send",
    async (event, params: { sessionId: string; message: string; model?: string; userMessageId?: string }) => {
      /**
       * ⚠ THE SAME OWNERSHIP GATE `kiroAcp:send` CARRIES, because this channel has the same shape.
       *
       * The ACP handler was the one found: it replayed any chat session's transcript into the agent
       * prompt with no account-ownership predicate. This one was not named. Fixing
       * only the reported channel would have been cosmetic: `saveAssistantMessage` below inserts into
       * whatever `sessionId` the caller names, so the same cross-account write was reachable here by
       * picking the other assistant. A gate on one of two doors is not a gate — the same reasoning the
       * sign-in role check in handlers/ai.ts states about its two sign-in buttons.
       */
      if (!isSessionOwnedByActiveAccount(params?.sessionId)) return { error: "Chat not found" };

      const projectPath = readSetting("project_path");
      if (!projectPath) return { error: "Project path not configured" };
      // The cwd handed to the SDK is a path the renderer influenced, and the assistant will read and
      // write inside it. Confined for the same reason every other file-touching handler is.
      /**
       * ⚠ NOW A TAUTOLOGY, AND KEPT DELIBERATELY. `projectPath` is read from the `project_path`
       * setting, and `allowedRoots()` derives the boundary FROM that same setting — so this compares a
       * value against a fence built out of it and cannot fail. The old comment justified it as
       * checking "a path the renderer influenced", which stopped being true when `project_path` became
       * main-authoritative.
       *
       * Kept because it is free and because the tautology is a property of TODAY's plumbing: if this
       * handler ever takes a path from its caller again, the check is already in place. Recorded rather
       * than removed, so nobody reads it as coverage it does not currently provide.
       */
      assertWithinProject(projectPath);

      /**
       * REFUSE A SELF-CONTRADICTORY SETUP BEFORE SPAWNING, exactly as the spawn path does: a provider
       * explicitly enabled with the thing it requires missing. Never "no provider found" — a customer
       * using Anthropic directly has a valid setup with an empty env block, and refusing that would
       * break a working configuration.
       *
       * Settings are read for DIAGNOSTICS only, never to build the environment. Constructing the
       * environment from them is what previously broke Bedrock auth on the spawn path.
       */
      const { env: claudeEnv, credentialExport, sources } = loadClaudeSettings(projectPath);
      const env = assistantEnv();
      const binary = resolveClaudeBinary(env);

      /**
       * ── THE DIAGNOSTIC BLOCK: THE PROFILE AND ITS INPUTS, IN THE DEBUG LOG ──
       *
       * Every value here answered a real question during two rounds of "Not logged in", and each is
       * something that otherwise had to be probed by hand because nothing logged it:
       *
       *   binary   — WHICH build is being run. The SDK bundles stock Claude Code and spawns it by
       *              default; the participant is signed into their own build. Same version number,
       *              different auth. This line is what makes that visible instead of a guess.
       *   profile  — the AWS profile Bedrock would use. A wrong or absent one is the other way this
       *              fails, and it is invisible without printing it.
       *   home     — an absent HOME is why the CLI cannot see ~/.claude.
       *   bedrock  — whether the project asked for Bedrock at all, which decides whether `profile`
       *              even matters.
       *
       * ⚠ NAMES ONLY, NEVER VALUES. `AWS_PROFILE` is a name and safe; a key id, a session token or a
       * bearer is not, and `credentialExport` is a COMMAND that would print secrets if run here. So
       * this logs whether each is configured, not what it contains — a debug log that leaks a
       * credential is a worse bug than the one it was added to diagnose.
       */
      debugLog("[claude-code] settings sources:", sources.join(", ") || "(none)");
      debugLog("[claude-code] binary:", binary ?? "(SDK bundled — auth may differ)");
      /**
       * The previous version read `env.AWS_REGION` as a fallback and would have logged "us-west-2" for a
       * child that gets no region at all: a diagnostic that lies is worse than none, and this file has
       * already cost two rounds of misdiagnosis.
       *
       * "(cli resolves)" rather than "(unset)": unset is what we PASS, and resolution is what actually
       * happens next — the CLI reads its own settings, ~/.aws/config and its credential export.
       */
      debugLog(
        "[claude-code] AWS_PROFILE (from settings):",
        claudeEnv.AWS_PROFILE || "(cli resolves)"
      );
      debugLog(
        "[claude-code] AWS_REGION (from settings):",
        claudeEnv.AWS_REGION || "(cli resolves)"
      );
      debugLog("[claude-code] HOME:", env.HOME ? "set" : "(UNSET — the CLI cannot find ~/.claude)");
      debugLog(
        "[claude-code] bedrock:",
        claudeEnv.CLAUDE_CODE_USE_BEDROCK ? "enabled" : "(not enabled)"
      );
      debugLog(
        "[claude-code] credentialExport:",
        credentialExport ? "configured" : "(none)"
      );

      const authGap = describeAuthGap(claudeEnv, credentialExport);
      if (authGap) {
        debugLog("[claude-code] refusing to start:", authGap);
        return { error: `Claude Code cannot authenticate. ${authGap}` };
      }

      const sessionId = params.sessionId;
      const state = stateFor(sessionId);
      if (state.running) {
        // One turn at a time per session. The old path wrote to the process's stdin here; the SDK
        // has no equivalent mid-turn input, and queuing would let a second message jump the first's
        // permission prompts.
        return { error: "This session is already generating a reply" };
      }

      state.abort = new AbortController();
      state.running = true;
      /**
       * ── ⚠ THIS TURN'S IDENTITY, SO A WATCHDOG CAN END IT WITHOUT THE LOOP'S HELP ──────────────
       *
       * `running` is cleared in a `finally`, which is correct — and useless when the `for await` below never
       * returns, which is what a failed permission handshake (`AbortError: Stream closed`) leaves behind.
       *
       * So the recovery cannot be "unwind the loop". The watchdog ends the turn by disowning it, and this
       * number is how everything else notices: the loop stops emitting, and the `finally` stops clearing a
       * flag that may by then belong to a NEWER turn the participant has already started.
       */
      const myTurn = ++state.turn;
      /**
       * ⚠ RESET BY EVERY FRAME, so a turn that is working is never interrupted however long it takes —
       * see TURN_IDLE_TIMEOUT_MS on why this is an idle bound and not a total one.
       */
      let idleTimer: NodeJS.Timeout | undefined;
      const abandonTurn = () => {
        // Someone else already owns the session — nothing of ours left to end.
        if (state.turn !== myTurn) return;
        debugLog(
          `[claude-code] turn produced nothing for ` +
            `${Math.round(TURN_IDLE_TIMEOUT_MS / 60_000)}m — abandoning it so the chat is usable again`
        );
        /**
         * ⚠ DISOWNED FIRST. Everything below is best-effort against a stream that has already proved it
         * may not respond; incrementing before any of it means the loop and the `finally` see a turn that
         * is no longer theirs even if the abort achieves nothing.
         */
        state.turn += 1;
        state.running = false;
        settlePending(state, "The turn stopped responding, so this was not run.");
        try {
          state.abort.abort();
        } catch {
          /* Best effort: the point is the flag, not the abort. */
        }
        /**
         * ⚠ THE PARTICIPANT IS TOLD, because the alternative is a chat that silently stops answering.
         * `cli:error` is the channel the view already renders, and the sentence says what to do next.
         */
        event.sender.send("cli:error", {
          sessionId,
          error:
            "The assistant stopped responding, so this turn was ended. Your message was not lost — send it again.",
        });
      };
      const resetIdleTimer = () => {
        if (state.turn !== myTurn) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(abandonTurn, TURN_IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };
      resetIdleTimer();
      const turnStartedAt = Date.now();
      let assistantText = "";
      /** True once a token delta arrived, so the complete message is not re-sent as a duplicate. */
      let sawPartials = false;
      /**
       * Output tokens from model calls that have ALREADY finished in this turn, plus the current one.
       * Split because `output_tokens` restarts at 1 on every `message_start` — a turn with three tool
       * round-trips is three model calls — so a single running value would sawtooth instead of rise.
       */
      /**
       * ⚠ THE RECORD, WHICH IS NOT THE LIVE COUNTER BELOW. `tokensBanked`/`tokensThisMessage` exist to make a
       * long agentic turn visibly alive in the status line, and are output-only and approximate by design.
       * This is the authoritative per-turn figure read from the `result` frame, and it is what gets STORED.
       * Two numbers, two jobs — collapsing them would trade a correct record for a smoother progress bar.
       */
      let turnTokens: TurnTokens | undefined;

      let tokensBanked = 0;
      let tokensThisMessage = 0;

      /**
       * ⚠ THE SDK PATH IS RECORDED TOO, and it is the one whose record reads BEST rather than worst:
       * `ask` is the policy, because this path keeps `permissionMode: "default"` with an unconditional
       * per-tool `canUseTool` callback. The audit-logging requirement applies here too: an agent
       * launch left no durable trace on any of the three runtimes, so a log
       * showing only the two CLI paths would make the safest one look like the absent one.
       */
      recordSecurityEvent({
        event: "agent.spawn",
        outcome: "success",
        userId: activeUserId() ?? undefined,
        detail: "claude-sdk:ask",
      });

      try {
        const stream = query({
          prompt: params.message,
          options: {
            cwd: projectPath,
            // ⚠ WITHOUT THIS THE CLI REPORTS ITSELF LOGGED OUT. See assistantEnv().
            env,
            /**
             * ⚠ THE USER'S OWN BINARY, not the SDK's bundled one — see resolveClaudeBinary(). Omitted
             * when the lookup fails, which leaves the SDK's default rather than refusing the turn.
             */
            ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
            abortController: state.abort,
            /**
             * ASK, RATHER THAN DECIDE. With `canUseTool` set (below) and no `--allowedTools`, every
             * tool use becomes a prompt — which is the reported fix.
             *
             * ⚠ WAS `"manual"`, WHICH IS NOT A VALID MODE, AND IT BROKE THE BUILD.
             *
             *     claude-code.ts(489,13): error TS2322: Type '"manual"' is not assignable to type
             *     'PermissionMode | undefined'.
             *
             * The SDK's union is `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' |
             * 'dontAsk' | 'auto'` (sdk.d.ts:2169). `"default"` is the one that means "apply normal
             * permission behaviour", i.e. route each tool use through `canUseTool` and wait — the
             * behaviour the old value was reaching for by name.
             *
             * ⚠ AND IT IS THE LEAST PERMISSIVE OF THE SIX. Four of the others (`acceptEdits`,
             * `bypassPermissions`, `dontAsk`, `auto`) each remove some or all prompting, and this
             * app removed `--dangerously-skip-permissions` deliberately (security review C-2). So
             * the invalid value must be replaced with `default` specifically, not with whichever
             * member of the union makes the error go away.
             *
             * ⚠ WHY IT WAS PROBABLY NOT A LIVE SECURITY HOLE: `canUseTool` is set unconditionally
             * below, and the SDK gates tool use on that callback regardless of mode, so approvals
             * still reached the user. An unrecognised mode string is a build failure and a latent
             * risk (the CLI could reject or reinterpret it), not evidence that prompting was off.
             */
            permissionMode: "default",
            /**
             * ── WITHOUT THIS THERE IS NO STREAM ──
             *
             * Correct, and this option is why. By default the SDK yields only WHOLE assistant messages, so a
             * long turn produces nothing at all until the model has finished — the UI shows a spinner and the
             * participant cannot tell a slow answer from a hung one.
             *
             * Measured against the real CLI:
             *   default            -> first frame at +6.2s, then complete messages only
             *   includePartialMessages -> `stream_event` frames with {type:"text_delta", text:"…"}
             *
             * The token-by-token deltas arrive on `stream_event`, which is a DIFFERENT frame type from
             * the `assistant` messages below — so both are handled, and the text is taken from
             * whichever arrives. That is not redundancy: the deltas give a live stream, and the
             * complete message is what the transcript and the sync are built from.
             */
            includePartialMessages: true,
            /**
             * Validated like the spawn paths, though this one hands the value to the SDK rather than to
             * argv: the SDK spawns the CLI itself and builds its own command line, which on Windows may
             * be a `.cmd` shim. That construction is not ours to audit — validating what we PASS is, and
             * it costs nothing, because a dropped id just means the SDK uses its default. See model-id.ts.
             */
            ...(safeModelId(params.model) ? { model: safeModelId(params.model) } : {}),
            // Continues the SAME conversation rather than starting fresh, so a second message keeps
            // the first turn's context. Absent on the first turn of a session.
            ...(state.resumeId ? { resume: state.resumeId } : {}),

            /**
             * ── THE PERMISSION PROMPT ──
             *
             * Returns a Promise that stays unresolved until the participant clicks. The SDK holds the
             * tool call open for exactly that long, which is the pause the old spawn path could not
             * produce.
             */
            canUseTool: async (toolName, input, opts) =>
              new Promise<PermissionResult>((resolve) => {
                // Already cancelled while the request was in flight — settle immediately rather than
                // parking a prompt nobody will see.
                if (opts.signal.aborted || state.abort.signal.aborted) {
                  resolve({ behavior: "deny", message: "The turn was cancelled." });
                  return;
                }

                /**
                 * ⚠ UNGUESSABLE, because answering a prompt by id authorises a tool call. The old
                 * form was `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2,8)}` —
                 * a timestamp and ~31 bits of `Math.random`, which is not a CSPRNG. The session gate
                 * in `claude-sdk:permission-respond` is the control; this removes the guess.
                 */
                const id = `${sessionId}:${randomUUID()}`;
                state.pending.set(id, { resolve, tool: toolName });

                /**
                 * `opts.signal` fires if the SDK gives up on this request. Without this the prompt
                 * would sit in `pending` for ever and its Promise would never settle — the exact
                 * hang the SDK's docs warn about.
                 */
                /**
                 * ── ⚠ A DEADLINE, BECAUSE EVERY OTHER ESCAPE DEPENDS ON SOMETHING FIRING ──────────
                 *
                 * This file's header says a parked prompt has no deadline and that the failure mode is
                 * "a TURN THAT NEVER ENDS". It then settles prompts on cancel, stop, abort and error —
                 * every path where SOMETHING happens. Nothing covered the SDK simply going quiet, which
                 * is what `AbortError: Stream closed` inside a permission request looks like from here:
                 * `opts.signal` never fires, the stream never ends, and the prompt waits for ever.
                 *
                 * ⚠ THE SAME CONSTANT THE ACP PATH USES, deliberately. `kiro-trust.ts` already chose ten
                 * minutes for exactly this decision and wrote out the reasoning — long enough for
                 * somebody who stepped away from a workshop, short enough that a forgotten window does
                 * not park a live agent indefinitely. A second number here would be a second answer to
                 * one question.
                 *
                 * ⚠ IT FAILS CLOSED, for the reason `settlePending` gives: a prompt nobody answered has
                 * been approved by nobody, and a timeout that allowed would turn "I walked away" into "I
                 * authorised a file write".
                 *
                 * Created before the listener that clears it, so neither has to forward-reference the
                 * other.
                 */
                const promptDeadline = setTimeout(() => {
                  const still = state.pending.get(id);
                  if (!still) return;
                  state.pending.delete(id);
                  debugLog(
                    `[claude-code] permission prompt for ${toolName} expired unanswered after ` +
                      `${Math.round(PERMISSION_PROMPT_TIMEOUT_MS / 60_000)}m — denying`
                  );
                  resolve({
                    behavior: "deny",
                    message: "Nobody approved this in time, so it was not run.",
                  });
                }, PERMISSION_PROMPT_TIMEOUT_MS);
                promptDeadline.unref?.();

                opts.signal.addEventListener(
                  "abort",
                  () => {
                    const still = state.pending.get(id);
                    if (!still) return;
                    state.pending.delete(id);
                    clearTimeout(promptDeadline);
                    resolve({ behavior: "deny", message: "The request was withdrawn." });
                  },
                  { once: true }
                );

                /**
                 * `opts.title` is the CLI's OWN prompt sentence ("Claude wants to read foo.txt"). The
                 * SDK's types say to prefer it over reconstructing one from toolName + input — it
                 * knows about cases we would get wrong, like a Bash command touching a path outside
                 * the project. Falling back to a constructed description keeps the card populated
                 * when it is absent, which the live probe showed happens.
                 */
                const description =
                  opts.title ??
                  opts.description ??
                  `${opts.displayName ?? toolName}: ${describeInput(input)}`;

                const payload: PermissionRequestEvent = {
                  sessionId,
                  id,
                  tool: toolName,
                  description,
                  input,
                };
                // The event name the renderer ALREADY listens for. Its approve/deny card has existed
                // and been unreachable; this is what finally fires it.
                event.sender.send("cli:permission-request", payload);
              }),
          },
        });

        for await (const message of stream as AsyncIterable<SDKMessage>) {
          /**
           * ⚠ A DISOWNED TURN STOPS HERE. If the watchdog gave up on this turn and the stream later
           * revives, it must not stream into a session the participant has moved on from — which would
           * interleave two turns' output in one transcript.
           */
          if (state.turn !== myTurn) break;
          // Proof of life: this turn is working, so the idle deadline starts again.
          resetIdleTimer();
          const m = message as Record<string, any>;

          // The SDK's session id arrives on the init frame; kept so the NEXT turn can resume.
          if (m.type === "system" && m.session_id) {
            /**
             * Logged on request. It is the id the CLI itself uses, so it is what correlates this turn
             * with `claude --resume <id>`, with the CLI's own logs, and with a transcript under
             * ~/.claude/projects — none of which our own sessionId can be matched against. Printed once
             * per turn, when it first arrives, rather than on every frame.
             */
            if (state.resumeId !== m.session_id) {
              debugLog("[claude-code] claude session id:", m.session_id);
              /**
               * WRITTEN ON CHANGE ONLY, and written HERE rather than at the end of the turn.
               *
               * Here, because a turn that is stopped or crashes mid-flight still produced a resumable
               * conversation — and losing it is the bug this fixes. On change only, because the id is
               * stable across a turn's frames and an UPDATE per frame would be a write per token.
               *
               * ⚠ THE SDK CAN CHANGE THE ID ON RESUME: resuming a conversation may return a NEW session
               * id for the continued thread, so this overwrites rather than only filling a blank. Storing
               * the first id for ever would make every restart resume from the same early point.
               */
              saveResumeId(sessionId, m.session_id as string);
            }
            state.resumeId = m.session_id as string;
          }

          /**
           * TOKEN DELTAS. `stream_event` carries the incremental text; the `assistant` frame that
           * follows carries the SAME text as a finished block. So the deltas are forwarded to the UI
           * for a live stream and NOT accumulated — accumulating both would double every reply.
           */
          if (m.type === "stream_event") {
            const delta = m.event?.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
              event.sender.send("cli:output", { sessionId, text: delta.text });
              sawPartials = true;
            }
            /**
             * ── LIVE TOKEN COUNT, for the status line ──
             *
             * A word that changes is not enough on a fifteen-minute agentic turn — the participant needs
             * evidence that WORK is happening, and a rising token count is that evidence in a way a spinner
             * never can be.
             *
             * Measured which frames carry it: `message_start` and `message_delta` both include `usage`.
             * A turn makes SEVERAL model calls (one per tool round-trip), and each starts its own
             * message — so `output_tokens` RESETS to 1 on every `message_start`. Summing the frames
             * would therefore under-count badly; accumulating the deltas per message and adding them up
             * is what produces a total that only ever rises.
             */
            const usage = m.event?.usage ?? m.event?.message?.usage;
            if (usage && typeof usage.output_tokens === "number") {
              if (m.event?.type === "message_start") {
                // A new model call within the same turn: bank what the previous one produced.
                tokensBanked += tokensThisMessage;
                tokensThisMessage = 0;
              } else {
                tokensThisMessage = usage.output_tokens;
              }
              event.sender.send("cli:usage", {
                sessionId,
                outputTokens: tokensBanked + tokensThisMessage,
              });
            }
            continue;
          }

          /**
           * ── TOOL RESULTS. The `OUT` half of each step in the transcript. ──
           *
           * Arrives on a `user` frame, which is counter-intuitive enough to be worth stating: the
           * protocol models a tool result as something sent BACK to the model, so it is authored by the
           * "user" role even though no human typed it.
           */
          if (m.type === "user" && m.message?.content) {
            for (const block of m.message.content) {
              if (block?.type === "tool_result") {
                const raw =
                  typeof block.content === "string"
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content
                          .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
                          .join("")
                      : "";
                event.sender.send("cli:tool-result", {
                  sessionId,
                  toolUseId: block.tool_use_id ?? null,
                  // BOUNDED. A `cat` of a large file would otherwise cross the IPC boundary in full and
                  // then sit in renderer state for the life of the session. The UI shows a preview and
                  // the full output was never the point of this row.
                  output: raw.slice(0, MAX_TOOL_OUTPUT_CHARS),
                  truncated: raw.length > MAX_TOOL_OUTPUT_CHARS,
                  isError: block.is_error === true,
                });
              }
            }
            continue;
          }

          if (m.type === "assistant" && m.message?.content) {
            for (const block of m.message.content) {
              /**
               * ── TOOL CALLS. The `Bash / Run doctor check` row and its `IN` line. ──
               *
               * `input.description` is the assistant's own one-line summary of why it is running this,
               * which is exactly the label the VS Code extension shows beside the tool name — better
               * than anything we could synthesise from the raw arguments.
               */
              if (block?.type === "tool_use") {
                event.sender.send("cli:tool-use", {
                  sessionId,
                  toolUseId: block.id ?? null,
                  tool: block.name ?? "tool",
                  description:
                    typeof block.input?.description === "string" ? block.input.description : null,
                  // The single most representative argument, so the row has an `IN` line without
                  // dumping a whole JSON payload into the transcript.
                  input: describeInput(block.input),
                });
                continue;
              }
              if (block?.type === "text" && block.text) {
                // ALWAYS accumulated — this is the authoritative text the transcript and the team
                // sync are built from.
                assistantText += block.text;
                /**
                 * Emitted ONLY when no deltas arrived. With partial messages on, the UI has already
                 * received this text token by token; sending it again would show every reply twice.
                 * The fallback matters because `includePartialMessages` is best-effort — an older CLI,
                 * or a turn that produces no deltas, must still render.
                 */
                if (!sawPartials) {
                  event.sender.send("cli:output", { sessionId, text: block.text });
                }
              }
            }
          }

          if (m.type === "result") {
            /**
             * ⚠ THE TURN'S COUNTS LIVE HERE, and this frame is Claude's analogue of Codex's `turn.completed`
             * — one frame, one turn's totals. Read before the branches below, none of which return, so a
             * refusal or an auth failure still records what the attempt actually cost.
             */
            turnTokens = claudeTurnTokens(m) ?? turnTokens;
            /**
             * REFUSALS ARE REPORTED, NOT SWALLOWED. `permission_denials` is the authoritative record
             * per the SDK's docs, and a denial the participant cannot see is how the original bug
             * felt from the outside: the assistant says it is ready and nothing happens.
             */
            const denials = Array.isArray(m.permission_denials) ? m.permission_denials : [];
            if (denials.length > 0) {
              const names = [...new Set(denials.map((d: any) => d.tool_name))].join(", ");
              event.sender.send("cli:output", {
                sessionId,
                text: `\n\n_Not run without approval: ${names}._`,
              });
            }
            /**
             * AN AUTH FAILURE ARRIVES AS RESULT TEXT, not as a non-success subtype — which is why the
             * reported 403 rendered raw. Checked before the generic branch, or the actionable sentence
             * would be replaced by "stopped early".
             */
            const resultText = typeof m.result === "string" ? m.result : "";
            const friendly = friendlyAuthError(resultText);
            if (friendly) {
              // The full message, with its account id and ARN, goes only to the log.
              debugLog("[claude-code] auth failure (full):", resultText);
              event.sender.send("cli:error", { sessionId, error: friendly });
            } else if (m.subtype && m.subtype !== "success") {
              event.sender.send("cli:error", {
                sessionId,
                error: `The assistant stopped early (${m.subtype}).`,
              });
            }
          }
        }

        const finalContent = assistantText.trim();
        /**
         * ⚠ THE ASSISTANT ROW IS STILL CONDITIONAL; THE SYNC IS NOT. An empty reply must not become a
         * local row — there is nothing to show and it would read as the assistant having answered with
         * silence. But the USER's message has to reach the team's transcript either way, or pressing
         * Stop before the first token erases the question from the portal (reported). `syncCliTurn`
         * omits the assistant half when it is empty, which also keeps `aiTurns` at zero for it.
         */
        let turnId: string | undefined;
        if (finalContent) {
          /**
           * SAVED BEFORE `cli:response-complete` IS SENT. The renderer reloads from the database on
           * that event, so the row has to exist first — the ordering IS the fix, not just the write.
           */
          turnId = saveAssistantMessage(sessionId, finalContent, turnTokens);
        }
        /**
         * The SAME sync as the spawn path, through the shared helper — so a turn taken on this
         * implementation lands in the team's transcript identically, and `aiTurns` counts it the
         * same way. Two assistant paths writing two different shapes of history would be worse
         * than either bug this file fixes.
         */
        await syncCliTurn({
          sessionId,
          userMessage: params.message,
          assistantMessage: finalContent,
          aiProvider: "claude",
          // The local row id doubles as the sync's idempotency key — stable across retries of THIS
          // turn, unique across turns, so a replay overwrites rather than duplicating server-side.
          // A stopped turn has no assistant row, so it has no id to reuse; the sync is then keyed by
          // the server's own derivation, which is why this stays optional.
          ...(turnId ? { clientTurnId: turnId } : {}),
          // The rows to stamp with the outcome, so "did this reach the portal?" is answerable locally.
          ...(params.userMessageId ? { userMessageId: params.userMessageId } : {}),
          ...(turnId ? { assistantMessageId: turnId } : {}),
          latencyMs: Date.now() - turnStartedAt,
          /*
            ⚠ THE SAME `tokens` FIELD THE CODEX PATH SENDS, so the portal needs no change at all: `cli-sync`
            and the ai service have accepted these five fields since the Codex work. Only when the frame
            reported them — an absent object keeps the server's columns NULL and its coverage figure honest.
          */
          ...(turnTokens ? { tokens: turnTokens } : {}),
        });

        event.sender.send("cli:response-complete", { sessionId, content: finalContent });
        return { sent: true };
      } catch (err) {
        const aborted = state.abort.signal.aborted;
        const message = err instanceof Error ? err.message : String(err);

        /**
         * ── WORKSPACE TRUST, MIRRORED FROM THE SPAWN PATH ──
         *
         * The CLI refuses to run in a folder the user has not trusted, and the spawn path detects that
         * from stderr and raises `cli:trust-required` so the renderer can offer a "Trust this folder"
         * button (wired to `cli:trustWorkspace`, which is assistant-agnostic and shared).
         *
         * Without this the SDK path would fail an untrusted project with a raw error string and NO way
         * forward — a dead end for anyone opening a fresh folder, and a worse one than the permission
         * bug this file exists to fix, since it blocks the whole session rather than one tool call.
         *
         * Checked BEFORE the generic error branch, because the message would otherwise be reported as
         * an ordinary failure and the button never shown.
         */
        if (/workspace has not been trusted|not been trusted/i.test(message)) {
          const match = message.match(/projects\["([^"]+)"\]/);
          event.sender.send("cli:trust-required", {
            sessionId,
            path: match?.[1] || projectPath,
          });
          return { error: "workspace-not-trusted" };
        }

        // A thrown auth failure gets the same treatment: safe sentence to the UI, full text to the log.
        const friendly = aborted ? null : friendlyAuthError(message);
        if (friendly) debugLog("[claude-code] auth failure (full):", message);
        event.sender.send("cli:error", {
          sessionId,
          error: aborted ? "Stopped." : (friendly ?? message),
        });
        return { error: aborted ? "stopped" : (friendly ?? message) };
      } finally {
        clearTimeout(idleTimer);
        /**
         * ⚠ ONLY IF THIS TURN IS STILL THE CURRENT ONE. The watchdog may have abandoned it and the
         * participant may have started another — clearing `running` here would then unlock a session that
         * is legitimately busy, and settling prompts would deny the NEW turn's pending approvals.
         */
        if (state.turn === myTurn) {
          state.running = false;
          // ⚠ ALWAYS. A thrown error or an abort must not leave a prompt parked for ever.
          settlePending(state, "The turn ended before this was approved.");
        }
      }
    }
  );

  /**
   * The participant clicked Allow or Deny.
   *
   * Same channel NAME as the old path (`cli:permission-respond`) is deliberately NOT used — that
   * handler already exists and Electron refuses duplicates. The renderer calls whichever matches the
   * implementation it started the turn on.
   */
  ipcMain.handle(
    "claude-sdk:permission-respond",
    async (_event, params: { id: string; allow: boolean; sessionId?: string }) => {
      /**
       * ── ⚠ ANSWERED ONLY FOR A SESSION THIS ACCOUNT OWNS, AND ONLY THE ONE NAMED ───────────────
       *
       * This searched EVERY session's pending map when the caller omitted `sessionId`, and treated `allow` as
       * truthy rather than `=== true`. So one invoke carrying a guessed or observed prompt id could approve a
       * `Bash`/`Write`/`Edit` call parked in another chat — including another local account's — and any
       * truthy value counted as consent.
       *
       * ⚠ THE ACP SIBLING ALREADY DOES THIS CORRECTLY (`kiroAcp:permissionRespond`), with a comment
       * saying why: a compromised renderer must not be able to approve another chat's request. This
       * is that same rule, on the path that was missing it.
       *
       * ⚠ REQUIRING `sessionId` IS NOT A BEHAVIOUR CHANGE FOR THE UI. Both buttons in
       * `AssistantChatView` already pass `sessionId: activeId`; the cross-session fallback was
       * reachable only by a caller that chose to omit it.
       */
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
      const id = typeof params?.id === "string" ? params.id : "";
      if (!sessionId || !id) return { ok: false, error: "No pending permission request" };
      if (!isSessionOwnedByActiveAccount(sessionId)) {
        return { ok: false, error: "No pending permission request" };
      }

      const candidates = [sessions.get(sessionId)].filter(
        Boolean as unknown as (s: SessionState | undefined) => s is SessionState
      );

      for (const state of candidates) {
        const pending = state.pending.get(id);
        if (!pending) continue;
        state.pending.delete(id);
        pending.resolve(
          /**
           * ⚠ COERCED, NOT TRUSTED. This is renderer input deciding whether an agent may run a
           * shell command, so anything that is not exactly `true` is a denial.
           */
          params.allow === true
            ? { behavior: "allow" }
            : {
                behavior: "deny",
                // Reaches the model, so it is written for the assistant to read: it should adapt
                // rather than retry the same call.
                message: "A participant declined this action. Do not retry it.",
              }
        );
        return { ok: true };
      }
      /**
       * An unknown id is not an error worth throwing. It happens when a click races the turn ending —
       * the prompt was already settled by `settlePending`, and the participant's click is simply late.
       */
      return { ok: false, error: "No pending permission request" };
    }
  );

  /** Stop a turn. Aborts the query AND settles every parked prompt. */
  ipcMain.handle("claude-sdk:stop", async (_event, params?: { sessionId?: string }) => {
    /**
     * ⚠ SCOPED TO THE ACTIVE ACCOUNT, both branches — the same omission the report found on
     * `cli:stop` and `kiroAcp:stop`, on the third assistant. Fixed here too because this file's own
     * suite records the lesson: a gate on one of three doors is not a gate.
     */
    const targets = params?.sessionId
      ? isSessionOwnedByActiveAccount(params.sessionId)
        ? [sessions.get(params.sessionId)].filter(Boolean)
        : []
      : [...sessions].filter(([sid]) => isSessionOwnedByActiveAccount(sid)).map(([, s]) => s);
    for (const state of targets) {
      if (!state) continue;
      state.abort.abort();
      // Before the abort propagates: a prompt parked at this instant would otherwise wait on a query
      // that is already gone.
      settlePending(state, "The turn was stopped.");
      state.running = false;
    }
    return { stopped: true };
  });

  /** ⚠ Not an activity oracle for another account — see the sibling note on `cli:isRunning`. */
  ipcMain.handle("claude-sdk:isRunning", async (_event, params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { running: false };
      return { running: sessions.get(params.sessionId)?.running ?? false };
    }
    return {
      running: [...sessions].some(([sid, s]) => isSessionOwnedByActiveAccount(sid) && s.running),
    };
  });

  /** How many prompts are parked — exposed so a UI (or a test) can prove none leaked. */
  ipcMain.handle("claude-sdk:pendingCount", async (_event, params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { pending: 0 };
      return { pending: sessions.get(params.sessionId)?.pending.size ?? 0 };
    }
    return {
      pending: [...sessions]
        .filter(([sid]) => isSessionOwnedByActiveAccount(sid))
        .reduce((n, [, s]) => n + s.pending.size, 0),
    };
  });
}

/**
 * A short, human phrase for a tool's input, used only when the CLI gave us no `title`.
 *
 * Deliberately shallow: the full input goes to the renderer separately and the card renders the
 * interesting fields itself. This is a one-line label, and a JSON dump of a whole Edit payload in a
 * button label is unreadable.
 */
/**
 * ── AN AUTH FAILURE, SAID SAFELY ──
 *
 *     Failed to authenticate. API Error: 403 {"Message":"User: arn:aws:sts::<acct>:assumed-role/
 *     <Role>/<alias> is not authorized to perform: bedrock:InvokeModelWithResponseStream …"}
 *
 * ⚠ TWO THINGS WRONG WITH SHOWING THAT. It discloses an AWS account id, a role ARN and an action name
 * to a workshop participant who can do nothing with them — the same class of leak already filtered out
 * of team transcripts server-side (see cli-error-content.ts). And it is unactionable: the reader
 * cannot tell that their CLI is pointed at an account whose IAM policy lacks a Bedrock permission.
 *
 * ⚠ THE UNDERLYING FAULT IS NOT OURS, AND THAT IS WHY THIS ONLY REWORDS IT. Proven by running the CLI
 * DIRECTLY in that project, no SDK and no desktop app involved: it produces the identical 403. The
 * project's credential export resolves to a federated AWS role that lacks
 * `bedrock:InvokeModelWithResponseStream`, and `aws sts get-caller-identity` there reports no
 * credentials at all. So the fix is a human granting that permission or switching profile — the app's
 * only job is to say so without leaking the details.
 *
 * The full message still goes to the DEBUG LOG, where an operator needs every field.
 */
export function friendlyAuthError(raw: string): string | null {
  const looksLikeAuth =
    /is not authorized to perform/i.test(raw) ||
    /Failed to authenticate/i.test(raw) ||
    /AccessDenied|UnrecognizedClient|ExpiredToken|InvalidClientTokenId/i.test(raw);
  if (!looksLikeAuth) return null;

  // The ACTION is the one detail worth keeping: it is not sensitive and it names what to grant.
  const action = /(?:perform:\s*)([a-z0-9-]+:[A-Za-z]+)/.exec(raw)?.[1];
  const bedrock = /bedrock:/i.test(raw);

  if (bedrock) {
    return (
      "Your AWS credentials are not allowed to call Bedrock" +
      (action ? ` (${action})` : "") +
      ". Check which AWS profile this project uses, and that its role has Bedrock access."
    );
  }
  return "Your AWS credentials were rejected. Check which AWS profile this project uses, and whether it has expired.";
}

function describeInput(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  }
  return "(no details)";
}

/** Exported for tests: how many prompts are parked, without going through IPC. */
export function pendingPermissionCount(sessionId?: string): number {
  if (sessionId) return sessions.get(sessionId)?.pending.size ?? 0;
  return [...sessions.values()].reduce((n, s) => n + s.pending.size, 0);
}

/** Exported for tests: drop all state between cases. */
export function __resetSessionsForTest(): void {
  sessions.clear();
}
