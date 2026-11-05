import { app, ipcMain } from "electron";
import { ChildProcess } from "child_process";
import { spawnConfined, confineCwd } from "../spawn-confined";
import { kiroTrustArg, PERMISSION_PROMPT_TIMEOUT_MS } from "../kiro-trust";
import { agentMayWriteFilesUnprompted } from "../agent-trust-setting";
import { recordSecurityEvent, redactedTarget } from "../security-audit";
import { toolPolicyOf } from "../agent-tool-policy";
import { safeModelId } from "../model-id";
import { randomUUID } from "crypto";
import path from "path";
import os from "os";
import fs from "fs";
import { spawnCommandFor } from "../assistant-command";
import { getDb, readSetting } from "../database";
import { isSessionOwnedByActiveAccount } from "../session-ownership";
import { activeUserId } from "../active-account";
import { assistantPath } from "../assistant-path";
import { debugLog } from "../debug-log";
import { formatHistoryPreamble } from "../acp-history";
import { SYNC_PENDING } from "../message-sync-status";
import { readKiroContextUsage } from "../kiro-metadata";
import { syncCliTurn } from "./cli-sync";

/** JSON-RPC 2.0 message types */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** ACP session update types sent via session/notification */
interface AcpMessageChunk {
  type: "AgentMessageChunk";
  content: string;
}

interface AcpToolCall {
  type: "ToolCall";
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  parameters?: Record<string, unknown>;
  output?: string;
}

interface AcpToolCallUpdate {
  type: "ToolCallUpdate";
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  output?: string;
}

interface AcpTurnEnd {
  type: "TurnEnd";
}

/**
 * Every shape `session/notification` can carry. Exported because these four
 * interfaces document the ACP wire protocol — they are the reference for what
 * the agent sends, so they earn their keep even where the handler currently
 * narrows on `type` inline rather than taking this union as a parameter.
 */
export type AcpSessionUpdate =
  | AcpMessageChunk
  | AcpToolCall
  | AcpToolCallUpdate
  | AcpTurnEnd;

const REQUEST_TIMEOUT_MS = 300_000; // 5 minutes default

function getSetting(key: string): string | null {
  return readSetting(key);
}

/**
 * @param contextUsagePercent How full Kiro said the conversation was at the end of this turn, or undefined
 *        when it said nothing.
 *
 * ⚠ STORED LOCALLY AS WELL AS SYNCED, and the reason is the RETRY path rather than local display. The
 * server overwrites a turn keyed on `clientTurnId`, so a re-push that omitted this field would DELETE the
 * portal's reading for a turn that had one — a retry making the record worse. `loadTurnForRetry` reads the
 * column back for exactly that reason, as it already does for the token counts.
 *
 * ⚠ NULL WHEN NOT REPORTED, never 0. A conversation nobody measured and a conversation with an empty context
 * window are different facts, and 0% is a claim rather than an absence.
 */
function saveMessage(
  sessionId: string,
  role: string,
  content: string,
  contextUsagePercent?: number
): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    // 'pending' until the push is acknowledged — see message-sync-status.ts.
    `INSERT INTO chat_messages (id, session_id, role, content, sync_status, context_usage_percent)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, role, content, SYNC_PENDING, contextUsagePercent ?? null);
  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId);
  return id;
}

/** Fetch a session's prior messages and format them for replay. */
function buildHistoryPreamble(sessionId: string): string {
  const rows = getDb()
    .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as { role: string; content: string }[];
  return formatHistoryPreamble(rows);
}

/** Read the stored native ACP session id for an app session, if any. */
function getStoredAcpSessionId(appSessionId: string): string | null {
  try {
    const row = getDb()
      .prepare("SELECT acp_session_id FROM chat_sessions WHERE id = ?")
      .get(appSessionId) as { acp_session_id?: string | null } | undefined;
    return row?.acp_session_id ?? null;
  } catch {
    // Column may be absent on a DB that predates the migration; treat as none.
    return null;
  }
}

/** Persist the native ACP session id so a later launch can session/load it. */
function storeAcpSessionId(appSessionId: string, acpSessionId: string): void {
  try {
    getDb()
      .prepare("UPDATE chat_sessions SET acp_session_id = ? WHERE id = ?")
      .run(acpSessionId, appSessionId);
  } catch (err) {
    debugLog("[kiro-acp] Failed to persist acp_session_id:", err instanceof Error ? err.message : err);
  }
}

/**
 * ── ⚠ THIS FILE NO LONGER SYNCS. IT ASKS `cli-sync` TO ────────────────────────────────────
 *
 * What stood here was a SECOND copy of `syncToServer` — 115 lines of timeout, thread probe, thread
 * create, message push and failure toast, "mirroring" `cli-assistant.ts` by hand. Every one of those
 * concerns now lives in `cli-sync.ts`, and the copy is deleted rather than kept in step.
 *
 * ⚠ THE COPY WAS NOT MERELY DUPLICATION — IT MISSED TWO FIXES AND SHIPPED BOTH BUGS (backlog 8a, 8b):
 *
 *   · It never wrote the local sync status. `saveMessage` stamps every row `pending`, and only
 *     `syncCliTurn` clears it — so a Kiro turn pushed SUCCESSFULLY and kept its "not synced" label
 *     and retry icon forever. The badge was telling the truth about what the database said and the
 *     database was wrong.
 *   · It sent no `createdAt`, so the server stamped arrival. A backlog of turns pushed after a
 *     reconnect all landed within the same second, which is the "0s team time" class of wrongness.
 *
 * It also created the thread on a 200-with-zero-messages as well as a 404 — the condition that once
 * destroyed a real share. `cli-sync` narrowed that to 404 only.
 *
 * ⚠ SO THE LESSON IS THE DELETION, NOT THE TWO FIXES. This is the second time a fix to the assistant
 * sync path missed this file (6c was the first). A copy that must be "kept identical in shape" to
 * another file is a copy that will diverge the moment someone is in a hurry, and both of these bugs
 * were invisible: the transcripts arrived, so nothing failed loudly.
 */

class KiroAcpClient {
  private process: ChildProcess | null = null;
  private buffer = "";
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private initialized = false;
  private sessionId: string | null = null;
  private onNotification: (method: string, params: unknown) => void;
  private onExit: (code: number | null) => void;
  private onError: (error: string) => void;
  /**
   * Ask the human whether the agent may do this. Resolves true to approve.
   *
   * ⚠ THE CLIENT DOES NOT DECIDE — it only asks and then answers the agent. Keeping the decision
   * outside this class is what lets the handler own the renderer round trip, the timeout and the
   * fail-closed default without this file knowing about windows or IPC.
   */
  private onPermission: (request: { id: string; toolCallId: string; title: string }) => Promise<boolean>;

  // The app-level (DB) session id this client serves, and the content
  // accumulated for the in-flight turn. Kept per-client so concurrent sessions
  // don't clobber each other's buffers (EA-M1).
  readonly appSessionId: string;
  accumulatedContent = "";

  // ACP has no native resume: a freshly spawned client starts a brand-new
  // conversation with zero history. When true, the next prompt is prefixed with
  // a replay of this session's prior DB messages so the agent regains context
  // (e.g. a spec-driven workflow the team had underway) after an app restart.
  needsHistoryReplay = true;

  /**
   * ── ⚠ HOW FULL THE WINDOW WAS, LAST TIME KIRO SAID ───────────────────────────────────────
   *
   * It was missing because this field did not exist. The `_kiro.dev/metadata` frame carrying
   * `contextUsagePercentage` arrives HERE, was forwarded to the renderer, and was parsed into React state —
   * so the only copy lived in a component and the sync below had nothing to send.
   *
   * ⚠ LAST WRITE WINS, AND A NON-READING DOES NOT CLEAR IT. Kiro emits the frame repeatedly during a turn;
   * the final one is the state of the conversation when the turn ended, which is the reading worth keeping.
   * Frames that carry no usable number leave the previous value standing — `readKiroContextUsage` returns
   * null for those, and overwriting with null would drop the reading whenever an MCP or command notification
   * happened to arrive last.
   *
   * ⚠ PER CLIENT, NOT A MODULE-LEVEL MAP. Concurrent chats each have their own client, and a shared map keyed
   * by session id is the shape that produced the buffer-clobbering this class already fixed for
   * `accumulatedContent` (EA-M1). Same lifetime, same owner, same rule.
   */
  lastContextUsagePercent: number | null = null;

  /**
   * The model this client was STARTED with, or null for Kiro's own default.
   *
   * ⚠ FIXED FOR THE PROCESS LIFETIME, and that is a property of the CLI rather than a shortcut. See the
   * note on `--model` in `start()`: `session/set_model` is not answered by kiro-cli 2.18.1, so the only
   * working way to choose a model is the spawn argument. Recorded here so the handler can tell whether a
   * requested model differs from the running one and restart rather than silently ignore it.
   */
  readonly model: string | null;

  constructor(options: {
    appSessionId: string;
    model?: string | null;
    onNotification: (method: string, params: unknown) => void;
    onExit: (code: number | null) => void;
    onError: (error: string) => void;
    onPermission?: (request: { id: string; toolCallId: string; title: string }) => Promise<boolean>;
  }) {
    this.appSessionId = options.appSessionId;
    this.model = options.model ?? null;
    this.onNotification = options.onNotification;
    this.onExit = options.onExit;
    this.onError = options.onError;
    /**
     * ⚠ THE DEFAULT IS DENY, not "approve because nobody wired a prompt up". A caller that forgets
     * to pass one gets an agent that cannot use an untrusted tool — annoying and safe — rather than
     * one silently back to `--trust-all-tools` behaviour, which is the failure mode this whole
     * change exists to remove.
     */
    this.onPermission = options.onPermission ?? (async () => false);
  }

  async start(cwd: string): Promise<void> {
    if (this.process && !this.process.killed) {
      return;
    }

    const kiroPath = this.resolveKiroCliPath();
    const env = this.buildEnv();

    // Confine the working directory to an opened project (EA-H4). spawnConfined
    // also enforces shell:false so the resolved path/args can't be shell-parsed.
    // The agent's file tools are pre-approved (kiro-trust.ts), so an unconfined
    // cwd would let a compromised renderer root them anywhere.
    const effectiveCwd = confineCwd(cwd);

    /**
     * ── ⚠ `--model` AT SPAWN IS THE ONLY THING THAT WORKS ─────────────────────────────────────
     *
     * ⚠ `session/set_model` DOES NOT WORK, MEASURED. This class already had a `setModel()` that sent
     * `session/set_model`, and `kiro-cli acp` (2.18.1) NEVER ANSWERS IT — not a result, not a JSON-RPC
     * error, nothing. Both param shapes were probed: the `{ model }` this app was sending, and the ACP
     * spec's `{ sessionId, modelId }`. Neither produced a reply within eleven seconds while the same
     * process answered `initialize` and `session/new` normally.
     *
     * That mattered more than a missing feature: `request()` awaits a response with a 5-MINUTE default
     * timeout, so the moment a picker started passing a model, every Kiro send would have hung for five
     * minutes before the prompt was even submitted. The dead method is removed rather than left as a trap.
     *
     * ⚠ `--model` IS VERIFIED AGAINST THE INSTALLED BINARY, `kiro-cli acp --help`:
     *       --model <MODEL>   "Model ID to use when starting the first session"
     *
     * "When starting the first session" is the constraint the whole design follows from: the choice is
     * fixed for the process, so CHANGING model means restarting this client. The handler does exactly that
     * — see `kiroAcp:send`. Passing an unknown id is not silently ignored either; kiro-cli fails to start
     * and `onError` surfaces it, which is why the picker only ever offers ids from the CLI's own catalogue
     * (`kiro-models.ts`).
     */
    /**
     * ⚠ `--trust-tools=…`, NOT `--trust-all-tools`. See kiro-trust.ts for what is on the list, what
     * is deliberately off it, and the probe results behind both. In short: file work is silent,
     * shell/AWS/network ask first, and `handleAgentRequest` above is what answers.
     */
    /**
     * ⚠ THE PARTICIPANT'S CHOICE IS READ AT SPAWN, not cached at module load. `--trust-tools` is a
     * spawn argument, so the setting takes effect on the next client start — which is also why
     * changing it in Settings says so rather than implying it applies to a running turn.
     */
    const args = ["acp", kiroTrustArg(agentMayWriteFilesUnprompted())];
    if (this.model) args.push("--model", this.model);

    debugLog("[kiro-acp] Spawning:", kiroPath, args.join(" "));
    debugLog("[kiro-acp] CWD:", effectiveCwd);
    debugLog("[kiro-acp] PATH includes local/bin:", (env.PATH || "").includes(".local/bin"));

    /**
     * ⚠ RECORDED, AND THE TOOL POLICY IS PART OF THE RECORD. The privileged-access and audit-logging
     * requirements both apply: the only trace of a privileged agent
     * launch was a `debugLog`, which is a no-op unless an environment variable is set and is never
     * persisted. `trust-listed` distinguishes this path from the `--trust-all-tools` it used to pass.
     */
    recordSecurityEvent({
      event: "agent.spawn",
      outcome: "success",
      userId: activeUserId() ?? undefined,
      detail: `${redactedTarget(kiroPath)}:acp:${toolPolicyOf(args)}`,
    });

    this.process = spawnConfined(kiroPath, args, {
      cwd: effectiveCwd,
      env,
    });

    this.process.stdout!.on("data", (chunk: Buffer) => {
      // Strip ANSI escape codes before processing
      const raw = chunk.toString();
      const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
      this.buffer += clean;
      this.processBuffer();
    });

    this.process.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        debugLog("[kiro-acp] stderr:", text);
      }
    });

    this.process.on("close", (code) => {
      debugLog("[kiro-acp] Process exited with code:", code);
      this.cleanup();
      this.onExit(code);
    });

    this.process.on("error", (err) => {
      console.error("[kiro-acp] Process spawn error:", err.message);
      this.onError(`Failed to start kiro-cli: ${err.message}. Is kiro-cli installed? Try: which kiro-cli`);
      this.cleanup();
    });

    // Small yield to let the event loop process any immediate spawn errors
    await this.delay(100);

    // Check if process died immediately (e.g., binary not found, bad cwd)
    if (!this.process || this.process.killed) {
      throw new Error(
        "kiro-cli failed to start. Check that kiro-cli is installed and the project path exists."
      );
    }

    // Initialize the ACP connection
    await this.initialize();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async initialize(): Promise<void> {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-01-01",
      clientInfo: {
        name: "praimana-desktop",
        /**
         * ⚠ READ, NEVER HARDCODED. This said `"0.1.0"` — a literal that stayed correct only
         * because the app's version had never been bumped, and became a lie the moment it was
         * (0.5.1). It is what a Kiro-side bug report would name as the client version, so a
         * stale value here sends someone to diagnose the wrong build.
         *
         * `app.getVersion()` reads the packaged `package.json`, the same source as the About
         * row and the telemetry record — one number for the app, whoever is asking.
         */
        version: app.getVersion(),
      },
      capabilities: {},
    }, 15000)) as { agentCapabilities?: { loadSession?: boolean } }; // 15s timeout
    this.supportsLoad = result?.agentCapabilities?.loadSession === true;
    this.initialized = true;
    debugLog("[kiro-acp] Initialized successfully. loadSession:", this.supportsLoad);
  }

  /**
   * ── ⚠ THE DIRECTORY A SESSION IS ROOTED IN ────────────────────────────────────────────────
   *
   * `session/new` and `session/load` took `cwd || process.cwd()`. Two faults in one expression:
   *
   *   1. UNCONFINED. `kiroAcp:newSession` passes `params?.cwd` straight from the renderer, so a
   *      compromised one could root the agent — whose file tools are pre-approved (kiro-trust.ts) —
   *      anywhere on disk. `start()` confines the PROCESS's cwd, and this quietly moved the session
   *      out from under it.
   *   2. `process.cwd()` IS THE WRONG FALLBACK ANYWAY. In a packaged app that is wherever the app
   *      was launched from — `/` when opened from Finder — which is not a project and not usable.
   *
   * ⚠ THE FALLBACK IS THE PROJECT PATH, NOT A THROW. `confineCwd` throws on an unusable value, and
   * that is right for a process spawn; here `undefined` is the ORDINARY case — `kiroAcp:newSession`
   * passes no cwd on purpose — so refusing it would break starting a session at all. The configured
   * project is the same directory `start()` already confined the process to, and it is read from
   * settings in MAIN rather than accepted from the caller.
   */
  private confinedSessionCwd(requested?: string): string {
    if (requested) return confineCwd(requested);
    const projectPath = getSetting("project_path");
    if (!projectPath) {
      throw new Error("No project folder is open, so a Kiro session has nowhere to work.");
    }
    // Still checked rather than trusted: the stored value goes through the same confinement.
    return confineCwd(projectPath);
  }

  async newSession(cwd?: string): Promise<string> {
    if (!this.initialized) {
      throw new Error("ACP client not initialized");
    }

    const result = (await this.request("session/new", {
      cwd: this.confinedSessionCwd(cwd),
      mcpServers: [],
    })) as { sessionId?: string };
    this.sessionId = result?.sessionId || randomUUID();
    debugLog("[kiro-acp] New session:", this.sessionId);
    return this.sessionId;
  }

  /**
   * Resume a prior conversation by its native ACP session id (session/load),
   * restoring the agent's real working memory — no transcript replay needed.
   * Only valid when the agent advertised loadSession capability. Throws on
   * failure so the caller can fall back to a fresh session.
   */
  async loadSession(acpSessionId: string, cwd?: string): Promise<void> {
    if (!this.initialized) {
      throw new Error("ACP client not initialized");
    }
    if (!this.supportsLoad) {
      throw new Error("Agent does not support session/load");
    }
    await this.request("session/load", {
      sessionId: acpSessionId,
      cwd: this.confinedSessionCwd(cwd),
      mcpServers: [],
    });
    this.sessionId = acpSessionId;
    debugLog("[kiro-acp] Loaded session:", acpSessionId);
  }

  /** Whether the agent advertised the loadSession capability at initialize. */
  supportsLoad = false;

  async sendPrompt(content: string): Promise<void> {
    if (!this.initialized || !this.sessionId) {
      throw new Error("No active ACP session");
    }

    // session/prompt returns when the turn is complete (stop reason)
    await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: content }],
    }, 600_000); // 10 min timeout for full turn
  }

  async cancel(): Promise<void> {
    if (!this.initialized || !this.sessionId) {
      return;
    }

    try {
      await this.request("session/cancel", {});
    } catch {
      // Best effort cancel
    }
  }

  /**
   * ── ⚠ `setModel()` IS GONE, BECAUSE THE METHOD IT CALLED IS NOT IMPLEMENTED ────────────────
   *
   * What stood here sent `session/set_model` and awaited a reply. Probed against kiro-cli 2.18.1, that
   * request is never answered — no result and no error, with both the `{ model }` shape this sent and the
   * ACP spec's `{ sessionId, modelId }`. `request()` defaults to a 5-minute timeout, so this method could
   * only ever have stalled a turn for five minutes and then thrown.
   *
   * It was unreachable in practice (nothing offered a Kiro model to pass), which is exactly why it survived
   * as a plausible-looking method that had never run. Model selection is now the `--model` spawn argument —
   * see `start()` — and changing model restarts the client, because that flag applies only at startup.
   */


  isRunning(): boolean {
    return this.process !== null && !this.process.killed && this.initialized;
  }

  destroy(): void {
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      // Force kill after 5s if it doesn't exit
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5000);
    }
    this.cleanup();
  }

  private cleanup(): void {
    this.initialized = false;
    this.sessionId = null;
    this.process = null;
    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ACP process terminated"));
    }
    this.pendingRequests.clear();
  }

  private request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || this.process.killed) {
        reject(new Error(`ACP process not running (attempted: ${method})`));
        return;
      }

      const id = randomUUID();
      const message: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs || REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const payload = JSON.stringify(message) + "\n";
      this.process.stdin!.write(payload);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip non-JSON lines (debug output, ANSI escape sequences, etc.)
      if (!trimmed.startsWith("{")) {
        continue;
      }

      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification;

        // Response to a request we sent
        if ("id" in msg && msg.id && this.pendingRequests.has(msg.id)) {
          const pending = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          clearTimeout(pending.timer);

          if ("error" in msg && msg.error) {
            pending.reject(msg.error);
          } else {
            pending.resolve((msg as JsonRpcResponse).result);
          }
          continue;
        }

        /**
         * ── ⚠ A REQUEST FROM THE AGENT, WHICH THIS CLIENT USED TO DROP ─────────────────────
         *
         * An inbound message with BOTH an `id` and a `method` is a server→client request and it
         * expects an answer. The branch above only matches ids WE issued, so before this existed
         * such a message fell through to `onNotification` and was forwarded to the renderer as a
         * one-way event — no reply, ever.
         *
         * That was invisible while `--trust-all-tools` was passed, because the agent then never
         * asked anything. The moment the flag went (kiro-trust.ts) it became the difference
         * between a working turn and a permanent hang: measured against kiro-cli 2.18.1, an
         * unanswered `session/request_permission` leaves `session/prompt` unresolved for ever.
         *
         * ⚠ ITS ID IS A STRING UUID, not a number — e.g. "47777f48-e146-4682-…" — and it is echoed
         * back verbatim rather than parsed or re-generated.
         */
        if ("method" in msg && msg.method && "id" in msg && msg.id !== undefined && msg.id !== null) {
          void this.handleAgentRequest(msg.id as string, msg.method, msg.params);
          continue;
        }

        // Notification from the agent
        if ("method" in msg && msg.method) {
          this.onNotification(msg.method, msg.params);
        }
      } catch {
        // Skip malformed lines — likely debug output that starts with {
        debugLog("[kiro-acp] Skipped unparseable line:", trimmed.slice(0, 100));
      }
    }
  }

  /** Write a JSON-RPC reply on the agent's stdin. Line-delimited, like everything else here. */
  private respond(id: string, body: Record<string, unknown>): void {
    if (!this.process?.stdin) return;
    try {
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
    } catch (err) {
      // A dead pipe means the agent is gone; the turn is already over.
      debugLog("[kiro-acp] could not answer agent request:", err instanceof Error ? err.message : err);
    }
  }

  /**
   * Answer a request the AGENT made of US.
   *
   * ⚠ EVERY PATH OUT OF HERE REPLIES, including the failure paths. That is the invariant: a request
   * left unanswered hangs the agent's turn with no error and no timeout of its own, so "we did not
   * understand it" must still produce a JSON-RPC error rather than silence.
   */
  private async handleAgentRequest(id: string, method: string, params: unknown): Promise<void> {
    if (method !== "session/request_permission") {
      /**
       * -32601 is JSON-RPC's "method not found", which is the truthful answer: this client
       * implements one server→client method. Refusing explicitly lets the agent choose a different
       * route or fail loudly, and either beats a hang.
       */
      debugLog("[kiro-acp] unsupported agent request:", method);
      this.respond(id, { error: { code: -32601, message: `Unsupported client method: ${method}` } });
      return;
    }

    /**
     * The option ids are the AGENT'S, taken from the request rather than assumed. Measured shape
     * (kiro-cli 2.18.1):
     *
     *   options: [ {optionId:"allow_once",   name:"Yes",    kind:"allow_once"},
     *              {optionId:"allow_always", name:"Always", kind:"allow_always"},
     *              {optionId:"reject_once",  name:"No",     kind:"reject_once"} ]
     *
     * ⚠ `allow_always` IS DELIBERATELY NEVER CHOSEN. It writes a persistent trust rule into the
     * user's kiro-cli configuration — outside this app, surviving it, applying to their terminal
     * sessions too. A workshop app must not silently widen the trust of a tool the participant uses
     * elsewhere, so the only approval it can give is the one-shot one.
     */
    const p = (params ?? {}) as {
      toolCall?: { toolCallId?: string; title?: string };
      options?: Array<{ optionId?: string; kind?: string; name?: string }>;
    };
    const options = Array.isArray(p.options) ? p.options : [];
    const pick = (kind: string) => options.find((o) => o?.kind === kind || o?.optionId === kind);
    const allow = pick("allow_once");
    const reject = pick("reject_once") ?? pick("reject_always");

    const title = typeof p.toolCall?.title === "string" ? p.toolCall.title : "an action";
    const toolCallId = typeof p.toolCall?.toolCallId === "string" ? p.toolCall.toolCallId : id;

    let approved = false;
    try {
      approved = await this.onPermission({ id, toolCallId, title });
    } catch (err) {
      // A broken prompt path is a denial, never an approval.
      debugLog("[kiro-acp] permission prompt failed; denying:", err instanceof Error ? err.message : err);
      approved = false;
    }

    /**
     * ⚠ AND IF THE AGENT OFFERED NO OPTION WE RECOGNISE, we still answer — `cancelled`, which the
     * ACP protocol defines for exactly this. Selecting an `optionId` we invented would be worse
     * than useless: the agent would reject it and we would be back to a hung turn.
     */
    const chosen = approved ? allow : reject;
    if (!chosen?.optionId) {
      this.respond(id, { result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    this.respond(id, { result: { outcome: { outcome: "selected", optionId: chosen.optionId } } });
  }

  /**
   * Where kiro-cli might be, in preference order, ending with "let PATH decide".
   *
   * ⚠ EVERY ENTRY WAS POSIX, so on Windows the loop found nothing and fell through to the bare name —
   * which then failed in `spawn`, because `kiro-cli` there is `kiro-cli.exe` or a `.cmd` shim and
   * `fs.accessSync(..., X_OK)` does not consider PATHEXT. The bare-name fallback is now genuinely
   * usable (spawnPortable resolves it through PATH and PATHEXT), and these candidates give the
   * Windows install locations a chance to win first, exactly as the POSIX ones do.
   *
   * ⚠ `X_OK` IS MEANINGLESS ON WINDOWS. `fs.accessSync(f, X_OK)` there is equivalent to `F_OK` — it
   * reports whether the file exists, not whether it can be executed. That is why the extensions are
   * enumerated explicitly rather than trusting the access check to sort it out.
   */
  private kiroCliCandidates(): string[] {
    const home = os.homedir();
    const local = process.env.LOCALAPPDATA;

    if (process.platform === "win32") {
      /** `.cmd` before `.exe` is deliberate: the toolbox shim is the documented entry point. */
      const suffixes = [".exe", ".cmd", ".bat", ""];
      const roots = [
        path.join(home, ".toolbox", "bin", "kiro-cli"),
        path.join(home, ".local", "bin", "kiro-cli"),
        ...(local ? [path.join(local, "Programs", "kiro", "kiro-cli")] : []),
        ...(local ? [path.join(local, "kiro", "bin", "kiro-cli")] : []),
      ];
      return [...roots.flatMap((r) => suffixes.map((s) => r + s)), "kiro-cli"];
    }

    return [
      path.join(home, ".toolbox", "bin", "kiro-cli"),
      path.join(home, ".local", "bin", "kiro-cli"),
      "/usr/local/bin/kiro-cli",
      "kiro-cli", // Fall back to PATH
    ];
  }

  private resolveKiroCliPath(): string {
    /**
     * ⚠ A LOCAL RENAME WINS OVER THE CANDIDATE WALK. This class spawns kiro-cli itself rather than
     * going through buildCliArgs, so it was the third spawn site the rename override missed. If the
     * user named a different binary, that name is what they installed — probing the shipped
     * locations first would find a kiro-cli they deliberately replaced.
     */
    const renamed = spawnCommandFor("kiro-cli");
    if (renamed !== "kiro-cli") return renamed;

    for (const candidate of this.kiroCliCandidates()) {
      // The bare name is the fallback: nothing to stat, and spawnPortable resolves it.
      if (candidate === "kiro-cli") return candidate;
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }

    return "kiro-cli";
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: assistantPath(),
      // Ensure kiro-cli doesn't try to use interactive terminal features
      NO_COLOR: "1",
    };

    // kiro-cli authenticates via its own IAM Identity Center login (toolbox-exec).
    // Strip any inherited AWS credentials/profile so they don't override that auth
    // and point kiro-cli at an unauthorized role (causes 403 not-authorized).
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;

    return env;
  }
}

// One ACP client per app (DB) session so multiple Kiro chats run concurrently
// without tearing down one another (EA-M1). Keyed by the app session id.
const acpClients = new Map<string, KiroAcpClient>();

/**
 * ── ⚠ PROMPTS AWAITING A HUMAN ────────────────────────────────────────────────────────────────
 *
 * Each entry is an agent turn parked mid-tool-call: kiro-cli asked whether it may act, the question
 * is on screen, and the answer has to travel back through IPC before `session/prompt` can resolve.
 *
 * ⚠ BOUNDED THREE WAYS, because a leak here parks a live agent process rather than just a promise:
 * every entry has a timer that DENIES on expiry, the whole map for a session is settled as denied
 * when its client exits or is destroyed, and a destroyed window denies immediately instead of
 * queueing a question nobody can see.
 *
 * ⚠ KEYED BY THE AGENT'S OWN REQUEST ID (a UUID it generated), nested under the app session id, so
 * two concurrent chats cannot answer each other's prompt — the same per-session ownership rule
 * `accumulatedContent` follows.
 */
/**
 * ── ⚠ WHICH TOOL A PERMISSION PROMPT WAS ABOUT ────────────────────────────────────────────────
 *
 * ⚠ THE PROMPT ITSELF DOES NOT CARRY A TOOL NAME. Measured against kiro-cli 2.18.1, a
 * `session/request_permission` params block is `{sessionId, toolCall: {toolCallId, title}, options, _meta}`
 * — `title` is agent PROSE ("Running: rm -rf build") and is exactly what must not reach the log. What
 * does carry an identity is the `session/update` → `tool_call` frame that precedes it, whose `kind` is
 * ACP's closed vocabulary (read, edit, delete, move, search, execute, think, fetch, other).
 *
 * So the kind is remembered when the frame arrives and looked up when the prompt is answered.
 *
 * ⚠ BOUNDED, and small. One entry per in-flight tool call; a turn has a handful. The cap exists because
 * the keys come from the agent, and anything keyed by external input needs a ceiling — the oldest entry
 * is dropped rather than letting a long session grow this without limit.
 */
const MAX_REMEMBERED_TOOL_KINDS = 64;
const toolKindById = new Map<string, string>();

function rememberToolKind(toolCallId: unknown, kind: unknown): void {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  /** ACP's `kind` is a closed set; anything else is recorded as unknown rather than echoed. */
  const safe = typeof kind === "string" && /^[a-z_]{1,24}$/.test(kind) ? kind : "unknown";
  if (toolKindById.size >= MAX_REMEMBERED_TOOL_KINDS) {
    const oldest = toolKindById.keys().next().value;
    if (oldest !== undefined) toolKindById.delete(oldest);
  }
  toolKindById.set(toolCallId, safe);
}

const pendingAcpPermissions = new Map<string, Map<string, (approved: boolean) => void>>();

/**
 * ── ⚠ SHELL APPROVED FOR THE REST OF THIS SESSION, AND NO FURTHER ─────────────────────────────
 *
 * Every one of them was the same answer to the same question — the AI-DLC orchestrator runs each step through
 * `bun`, so each step is an `execute_bash` call, so each step prompts.
 *
 * ⚠ THE TOOL POLICY IS NOT WIDENED. `execute_bash` stays OUT of `TRUSTED_KIRO_TOOLS`, which is where
 * kiro-trust.ts draws its line — "tools that reach OUTSIDE the filesystem — shell, cloud, network — where a
 * single approval cannot be reasoned about locally". The first shell command of a session is still a real
 * question with a real refusal available. What changes is that answering it once answers it for that
 * session, rather than being re-asked for work the participant has already agreed to.
 *
 * ⚠ AND IT IS NOT `allow_always`. That option exists in the protocol and is still never selected, for the
 * reason recorded at the request handler: it writes a persistent rule into `~/.kiro`, outside this app,
 * surviving it, applying to the participant's own terminal. This grant lives in this process's memory, is
 * keyed by the app session, and is dropped when the client stops or the app closes — so it cannot widen the
 * trust of a tool they use elsewhere, which was the whole objection.
 *
 * ⚠ KEYED BY APP SESSION, NOT GLOBAL. A second chat is a second decision: the agent in one conversation
 * having been allowed a shell says nothing about another.
 */
const shellApprovedForSession = new Set<string>();

/**
 * Whether this permission request is for a shell command, decided from the kind the agent declared.
 *
 * ⚠ THE SAME AGENT-SUPPLIED `kind` THE AUDIT RECORD USES, AND ITS WEAKNESS IS KNOWN — see
 * `rememberToolKind`: an agent can announce one kind and request permission for another. That matters
 * differently here than in the log. In the log a false kind mislabels history; here it could only make a
 * shell call NOT match `execute` and therefore prompt EVERY time, which is the safe direction. It cannot
 * make a non-shell call inherit a shell grant, because the grant is only ever consulted for a request whose
 * remembered kind IS the shell one.
 */
function isShellRequest(toolCallId: string): boolean {
  return (toolKindById.get(toolCallId) ?? "") === "execute";
}

/** Settle every parked prompt for a session as DENIED. Called when its client goes away. */
function denyAllPendingPermissions(appSessionId: string, why: string): void {
  const forSession = pendingAcpPermissions.get(appSessionId);
  if (!forSession) return;
  if (forSession.size > 0) {
    debugLog(`[kiro-acp] denying ${forSession.size} unanswered permission prompt(s): ${why}`);
  }
  for (const settle of forSession.values()) settle(false);
  pendingAcpPermissions.delete(appSessionId);
}

/**
 * Put the question on screen and wait for the answer.
 *
 * ⚠ EVERY EXIT IS A DECISION AND THE DEFAULT IS NO. A destroyed window, an expired timer, a client
 * that died mid-question — all deny. The one thing that approves is a person clicking Allow.
 */
function askPermission(
  sender: Electron.WebContents,
  appSessionId: string,
  request: { id: string; toolCallId: string; title: string }
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (sender.isDestroyed()) {
      // Nobody can be asked, so nobody approved.
      resolve(false);
      return;
    }

    /**
     * ⚠ ALREADY ANSWERED FOR THIS SESSION — see `shellApprovedForSession`. Audited, because "the
     * participant allowed a shell command" and "a grant they gave earlier covered this one" are different
     * facts and an investigator needs to tell them apart.
     */
    if (isShellRequest(request.toolCallId) && shellApprovedForSession.has(appSessionId)) {
      recordSecurityEvent({
        event: "tool.permission",
        outcome: "success",
        userId: activeUserId() ?? undefined,
        detail: "allowed-session:execute",
      });
      resolve(true);
      return;
    }

    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingAcpPermissions.get(appSessionId)?.delete(request.id);
      /**
       * ── ⚠ AUDITED HERE, AT THE ONE PLACE EVERY OUTCOME PASSES THROUGH ──
       *
       * Not at the button handler: a denial by timeout, by the window closing or by the agent
       * exiting is just as much a decision, and recording only clicks would produce a log in which
       * approvals are visible and refusals are missing. `settle` is the single funnel.
       *
       * ⚠ NO TOOL ARGUMENTS ARE RECORDED. The title is the agent's own sentence and can contain a
       * full shell command with paths in it. What matters for an audit is that a tool call was
       * approved or denied at a given moment, not its contents — and a log that quoted commands
       * would accumulate file paths and, eventually, secrets typed into one.
       */
      /**
       * ⚠ THE TOOL'S KIND, NOT ITS ARGUMENTS. `kind` is ACP's closed vocabulary, so it cannot smuggle a
       * path or a secret into the log the way `title` would — and without it this record could not
       * distinguish "the participant allowed a file read" from "the participant allowed a shell
       * command", which is the only distinction anyone would ever look for.
       */
      const kind = toolKindById.get(request.toolCallId) ?? "unknown";
      recordSecurityEvent({
        event: "tool.permission",
        outcome: approved ? "success" : "refused",
        /**
         * ⚠ WHO APPROVED IT. The `cli-assistant.ts` `tool.permission` records name their subject and
         * this one did not, so the single most consequential record in the log — "somebody let the
         * agent do this" — was the one that did not say who, on a machine that remembers several
         * identities and switches between them without re-authenticating.
         */
        userId: activeUserId() ?? undefined,
        detail: `${approved ? "allowed-once" : "denied"}:${kind}`,
      });
      toolKindById.delete(request.toolCallId);
      resolve(approved);
    };

    const timer = setTimeout(() => {
      debugLog("[kiro-acp] permission prompt expired unanswered — denying");
      settle(false);
    }, PERMISSION_PROMPT_TIMEOUT_MS);
    /** Never hold the app open just to wait for a click. */
    timer.unref?.();

    let forSession = pendingAcpPermissions.get(appSessionId);
    if (!forSession) {
      forSession = new Map();
      pendingAcpPermissions.set(appSessionId, forSession);
    }
    forSession.set(request.id, settle);

    try {
      sender.send("kiroAcp:permissionRequest", {
        sessionId: appSessionId,
        id: request.id,
        toolCallId: request.toolCallId,
        // The agent's own sentence — "Running: echo hi > x.txt", "Creating probe.txt". It knows what
        // it is about to do more precisely than anything we could reconstruct from the tool name.
        description: request.title,
      });
    } catch (err) {
      debugLog("[kiro-acp] could not deliver permission prompt:", err instanceof Error ? err.message : err);
      settle(false);
    }
  });
}

/**
 * Start (or reuse) an ACP client bound to a specific app session. Idempotent:
 * if a running client already exists for `appSessionId` it is returned as-is,
 * so multiple sessions can each hold their own live kiro-cli process (EA-M1).
 */
async function ensureClient(
  event: Electron.IpcMainInvokeEvent,
  appSessionId: string,
  projectPath: string,
  /**
   * The model to start with, or undefined for Kiro's own default.
   *
   * ⚠ A DIFFERENT MODEL FORCES A RESTART, because `--model` only applies "when starting the first session"
   * (`kiro-cli acp --help`) and `session/set_model` is not answered at all — see `start()`. Reusing a
   * running client for a changed model would leave the picker claiming one model while another answered,
   * which is the exact defect that got Claude's models removed from Codex's picker. Better to pay a respawn
   * than to lie about which model is replying.
   *
   * ⚠ AND `undefined` MEANS "NO PREFERENCE", NOT "DEFAULT". A send that passes no model must not restart a
   * client that was deliberately started with one; only a stated, different choice does.
   *
   * ⚠ ONE THING HERE IS NOT VERIFIED, AND IS RECORDED RATHER THAN ASSUMED. `--model` is documented as the
   * model "when starting the first session". A NEW chat therefore gets the chosen model for certain. But when
   * this respawn is followed by `session/load` (below, for a chat with a stored ACP session id), it is
   * UNKNOWN whether kiro-cli applies the new `--model` or restores the model the loaded session was created
   * with — that was not probed, and the ACP spec does not say.
   *
   * The failure mode if Kiro wins is a picker that appears to change nothing on an OLD conversation while
   * working on new ones. It is not silent: the composer names the selected model, so a participant would see
   * the mismatch rather than be misled about cost. Worth probing before anyone relies on switching model
   * mid-conversation; starting a new chat is the reliable path today.
   */
  model?: string
): Promise<KiroAcpClient> {
  const existing = acpClients.get(appSessionId);
  const modelChanged = !!model && !!existing && existing.model !== model;
  if (existing && existing.isRunning() && !modelChanged) return existing;
  if (existing) {
    // Stale/dead client, or one running the wrong model — drop it before starting a fresh one.
    if (modelChanged) {
      debugLog(
        `[kiro-acp] model changed for ${appSessionId}: ${existing.model ?? "(default)"} → ${model}; restarting`
      );
    }
    // The replaced client's process is about to die, so anything it asked can no longer be granted.
    denyAllPendingPermissions(appSessionId, "the client was replaced");
    existing.destroy();
    acpClients.delete(appSessionId);
  }

  const sender = event.sender;
  const client = new KiroAcpClient({
    appSessionId,
    ...(model ? { model } : {}),
    onNotification: (method, notifParams) => {
      try {
        if (!sender.isDestroyed()) {
          handleAcpNotification(sender, client, method, notifParams);
        }
      } catch (e) {
        console.error("[kiro-acp] Notification handler error:", e);
      }
    },
    onPermission: (request) => askPermission(sender, appSessionId, request),
    onExit: (code) => {
      // A dead agent cannot act on an approval, and leaving the card on screen would invite a click
      // that resolves nothing. Settled as denied first, before the renderer is told it exited.
      denyAllPendingPermissions(appSessionId, "the agent exited");
      try {
        if (!sender.isDestroyed()) {
          sender.send("kiroAcp:exited", { code, sessionId: appSessionId });
        }
      } catch (e) {
        console.error("[kiro-acp] Exit handler error:", e);
      }
      // Only remove if this is still the client mapped for the session.
      if (acpClients.get(appSessionId) === client) {
        acpClients.delete(appSessionId);
      }
    },
    onError: (error) => {
      try {
        if (!sender.isDestroyed()) {
          sender.send("kiroAcp:error", { error, sessionId: appSessionId });
        }
      } catch (e) {
        console.error("[kiro-acp] Error handler error:", e);
      }
    },
  });

  acpClients.set(appSessionId, client);
  await client.start(projectPath);

  // Prefer native resume: if we stored a native ACP session id for this chat
  // and the agent supports session/load, restore its real conversation state
  // (no transcript replay, no history-length limit). Fall back to a fresh
  // session — and mark that transcript replay is still needed — if there's no
  // stored id or the load fails.
  const storedAcpId = getStoredAcpSessionId(appSessionId);
  if (storedAcpId && client.supportsLoad) {
    try {
      await client.loadSession(storedAcpId, projectPath);
      client.needsHistoryReplay = false; // real state restored natively
      return client;
    } catch (err) {
      debugLog("[kiro-acp] session/load failed, starting fresh:", err instanceof Error ? err.message : err);
    }
  }

  // Starting a fresh ACP conversation. Replay prior transcript ONLY if this app
  // session already has history we couldn't restore natively (e.g. resuming a
  // pre-migration session, or load failed). A brand-new chat has no history, so
  // there's nothing to replay.
  const acpId = await client.newSession(projectPath);
  storeAcpSessionId(appSessionId, acpId);
  client.needsHistoryReplay = hasPriorMessages(appSessionId);
  return client;
}

/** True if the app session already has at least one stored message. */
function hasPriorMessages(appSessionId: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT 1 FROM chat_messages WHERE session_id = ? LIMIT 1")
      .get(appSessionId);
    return !!row;
  } catch {
    return false;
  }
}

export function setupKiroAcpHandlers(): void {
  ipcMain.handle("kiroAcp:start", async (event, params: { projectPath: string; sessionId: string }) => {
    try {
      debugLog("[kiro-acp] kiroAcp:start called with params:", JSON.stringify(params));
      const projectPath = params?.projectPath || getSetting("project_path");
      debugLog("[kiro-acp] Resolved projectPath:", projectPath);
      if (!projectPath) {
        return { error: "No project path configured" };
      }
      if (!params?.sessionId) {
        return { error: "No session id provided" };
      }

      /**
       * ── ⚠ THE SAME GATE `kiroAcp:send` APPLIES, FOR THE SAME REASON ─────────────────────────
       *
       * `send` has carried this predicate; `start` accepted ANY `chat_sessions.id` and handed it to
       * `ensureClient`, which reads that row's resume handle through an unscoped `SELECT acp_session_id FROM
       * chat_sessions WHERE id = ?`. Two effects, and neither needs the caller to own anything:
       *
       *   - when the agent advertises `session/load`, ACP REPLAYS the conversation as
       *     `session/update` notifications, which `handleAcpNotification` forwards to the CALLING
       *     renderer — i.e. another local account's private transcript;
       *   - when it does not, the row is overwritten with a new handle, destroying that account's
       *     resume state.
       *
       * ⚠ THE REFUSAL SAYS NOTHING, matching `send`: one message for a malformed id, an unknown chat
       * and another account's chat, so the error text cannot be used to enumerate session ids.
       */
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { error: "Chat not found" };

      await ensureClient(event, params.sessionId, projectPath);
      return { started: true, sessionId: params.sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[kiro-acp] Start failed:", message);
      const stale = params?.sessionId && acpClients.get(params.sessionId);
      if (stale) {
        denyAllPendingPermissions(params.sessionId, "the client failed to start");
        stale.destroy();
        acpClients.delete(params.sessionId);
      }
      return { error: message };
    }
  });

  ipcMain.handle(
    "kiroAcp:send",
    async (event, params: { sessionId: string; message: string; model?: string; projectPath?: string }) => {
      if (!params?.sessionId) return { error: "No session id provided" };

      /**
       * ── ⚠ WHOSE CHAT IS THIS? ASKED ONCE, HERE, BEFORE ANYTHING READS OR WRITES IT ──────────
       *
       * Four statements in this module key on the caller's `sessionId` and none of them asked who owns it:
       * `buildHistoryPreamble` reads the transcript, `saveMessage` inserts into it and bumps its
       * `updated_at`, and `getStoredAcpSessionId`/`storeAcpSessionId` read and write
       * `chat_sessions.acp_session_id`. A grep for `user_id` in this file returned nothing at all.
       *
       * ⚠ WHAT THAT BOUGHT A CALLER NAMING ANOTHER LOCAL ACCOUNT'S SESSION ID: up to 40 messages /
       * 24 KB of that account's private transcript (acp-history.ts) prepended to a prompt the caller
       * also controls — so it can simply instruct the agent to restate the preamble — with the reply
       * streamed back over `kiroAcp:messageChunk`. The turn is then synced to the CALLER's team by
       * `syncCliTurn` below, so one call both exfiltrates a private transcript and writes into someone
       * else's chat history.
       *
       * ⚠ THE CHECK IS AT THE TOP RATHER THAN ON EACH STATEMENT, which is what the finding recommends
       * and is also the only version that cannot rot: this handler is long, the four statements are
       * spread across it and reached through helpers, and a per-statement predicate would have to be
       * remembered by the next helper anybody adds. One gate, before the first read.
       *
       * ⚠ AND THE REFUSAL SAYS NOTHING. Same message for a malformed id, an unknown chat and another
       * account's chat — `assertSafeRowId` is not consulted separately for the same reason. A caller
       * must not be able to use the error text to learn which session ids exist on this machine.
       */
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { error: "Chat not found" };

      /**
       * Lazily (re)start this session's client so a background session that was never explicitly started,
       * or whose process died, still works.
       *
       * ⚠ A CHANGED MODEL COUNTS AS "NEEDS STARTING", which is why the running client is no longer trusted
       * on its own. `--model` is a spawn argument, so a client already running under another model cannot be
       * switched — `ensureClient` compares and respawns. Without this branch the picker would appear to work
       * and change nothing, which is worse than having no picker.
       */
      /**
       * ⚠ VALIDATED BEFORE IT IS COMPARED OR STORED. `params.model` becomes a `--model <value>` spawn
       * argument, and on Windows kiro-cli can resolve to a `.cmd` shim whose argv passes through
       * `cmd.exe`. Validating here rather than at the spawn also means the RESTART decision is made on
       * the value that will actually be used — comparing against an id we were going to drop would
       * respawn the client for no reason. See model-id.ts.
       */
      const requestedModel = safeModelId(params.model);
      let client = acpClients.get(params.sessionId);
      const needsRestart = !client || !client.isRunning() || (!!requestedModel && client.model !== requestedModel);
      if (needsRestart) {
        const projectPath = params.projectPath || getSetting("project_path");
        if (!projectPath) return { error: "Kiro ACP not running. Start it first." };
        try {
          // The validated value, not the raw one — otherwise the check above guards nothing.
          client = await ensureClient(event, params.sessionId, projectPath, requestedModel);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }

      /**
       * A real guard rather than a `!` assertion. The condition above no longer narrows `client` for the
       * compiler — it is a boolean that also covers "the model changed" — and the honest reading is that
       * `ensureClient` is the only thing that can produce a client here. If it somehow did not, continuing
       * would throw on the next line with a stack nobody can act on; this returns the same error the branch
       * above does.
       */
      if (!client) return { error: "Kiro ACP not running. Start it first." };

      client.accumulatedContent = "";

      // If this is the first prompt to a freshly (re)started client, prepend a
      // replay of prior history so the agent resumes context (e.g. an
      // in-progress framework workflow) it lost when the process was gone. Build
      // the preamble BEFORE saving the new user message so it isn't duplicated.
      let promptText = params.message;
      if (client.needsHistoryReplay) {
        const preamble = buildHistoryPreamble(params.sessionId);
        if (preamble) promptText = preamble + params.message;
      }
      client.needsHistoryReplay = false;

      /**
       * Save the user message — and KEEP ITS ID.
       *
       * ⚠ THE RETURN VALUE USED TO BE THROWN AWAY, which is half of backlog 8a. `saveMessage` stamps
       * the row `pending`, and `syncCliTurn` can only clear a row it has been given the id of — so a
       * discarded id meant the participant's own message stayed marked "not synced" no matter how many
       * times it reached the server. It was the assistant's half that got an id here, by accident of
       * the assistant row being needed as the idempotency key.
       */
      const userMessageId = saveMessage(params.sessionId, "user", params.message);

      // Turn clock. `sendPrompt` resolves when the turn completes, so the difference is
      // a genuine measurement of how long the assistant worked — including its tool use.
      // Without it GET /threads/:threadId/timing reports ZERO AI time for every ACP
      // thread while still showing the user's gaps, i.e. it reads as the participant
      // being idle when the assistant was in fact busy.
      const turnStartedAt = Date.now();

      try {
        /**
         * ⚠ NO `setModel` CALL HERE ANY MORE. It used to send `session/set_model`, which kiro-cli never
         * answers — with `request()`'s 5-minute default timeout, the first participant to pick a model
         * would have waited five minutes before their prompt was submitted at all. The model is applied by
         * the `--model` spawn argument, and a change respawned the client above.
         */
        // sendPrompt resolves when the turn completes (stopReason returned)
        await client.sendPrompt(promptText);

        // Turn is done — save accumulated content and notify renderer
        const assistantContent = client.accumulatedContent.trim();
        // Declared out here because the sync below is a SEPARATE `if` block: the
        // local row id is the sync's idempotency key, so it has to outlive the save.
        let turnId: string | undefined;
        if (assistantContent) {
          /* The reading goes on the row too, so a retry re-sends it rather than erasing it — see saveMessage. */
          turnId = saveMessage(
            params.sessionId,
            "assistant",
            assistantContent,
            client.lastContextUsagePercent ?? undefined
          );
        }
        event.sender.send("kiroAcp:turnEnd", { sessionId: params.sessionId });
        client.accumulatedContent = "";

        /**
         * ── THE SHARED SYNC, NOT A LOCAL ONE ────────────────────────────────────────────────
         *
         * `syncCliTurn` is the same call `claude-code.ts` and the spawn path make, so a Kiro turn
         * lands in the team's transcript in the identical shape and `aiTurns` counts it the same way.
         * It also writes the local sync status from the push's REAL outcome, which is what makes the
         * per-message badge tell the truth on this path for the first time (backlog 8a), and it sends
         * the rows' real timestamps rather than letting the server stamp arrival (8b).
         *
         * ⚠ STILL FIRE-AND-FORGET, deliberately. `syncCliTurn` never throws by contract, and awaiting
         * it here would make every Kiro send wait on network I/O before the renderer is told the turn
         * finished — a visible stall added in the name of tidiness.
         *
         * ⚠ AND NO LONGER GUARDED ON `assistantContent`, which was quietly losing messages. A turn
         * stopped before the first token has no assistant row, and the old `if` dropped the whole
         * sync — so the participant's QUESTION never reached the server either, and the transcript
         * showed no evidence they had asked anything. `syncToServer` handles an empty reply by
         * syncing the user's message alone, which is the honest record of what happened.
         */
        void syncCliTurn({
          sessionId: params.sessionId,
          userMessage: params.message,
          assistantMessage: assistantContent,
          aiProvider: "kiro",
          // The assistant row id doubles as the idempotency key — stable across retries of THIS turn,
          // so a replay overwrites server-side instead of appending a duplicate. Absent for a stopped
          // turn, which is why both spreads are conditional.
          ...(turnId ? { clientTurnId: turnId } : {}),
          // The rows to stamp with the outcome. BOTH halves, so "did this reach the portal?" is
          // answerable locally for the question as well as the answer.
          userMessageId,
          ...(turnId ? { assistantMessageId: turnId } : {}),
          latencyMs: Date.now() - turnStartedAt,
          /**
           * ── ⚠ HOW FULL THE CONVERSATION WAS WHEN THIS TURN ENDED ──────────────────────────
           *
           * This line is the answer: the reading finally leaves the machine.
           *
           * ⚠ READ AT TURN END, WHICH IS THE ONLY HONEST MOMENT. Kiro emits the frame repeatedly while
           * the turn runs, and the value climbs as the reply is generated. The last one describes the
           * conversation the participant is now looking at; an earlier one would understate it.
           *
           * ⚠ SPREAD, NOT ASSIGNED — `null` must not travel as a number. Kiro is the only assistant that
           * reports this, and every Claude or Codex turn omits the field entirely so the portal can say
           * "not reported" rather than draw a 0% that looks like an empty context window.
           */
          ...(client.lastContextUsagePercent !== null
            ? { contextUsagePercent: client.lastContextUsagePercent }
            : {}),
        });

        return { sent: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }
    }
  );

  /**
   * Cancel the in-flight turn for one session, or every one THIS ACCOUNT owns.
   *
   * ⚠ THE PREDICATE IN BOTH BRANCHES, EXACTLY AS `kiroAcp:stop` BELOW. A session-ownership predicate
   * was missing on `kiroAcp:cancel`. `acpClients` is keyed by session
   * id with no account dimension, so the argument-less form walked every live client on the machine
   * and aborted another local account's in-flight turn. Its immediate sibling `kiroAcp:stop` was
   * given this gate in an earlier cycle and this channel was not — the same omission, one door along.
   */
  ipcMain.handle("kiroAcp:cancel", async (_event, params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { cancelled: false };
      await acpClients.get(params.sessionId)?.cancel();
    } else {
      for (const [sid, client] of [...acpClients]) {
        if (!isSessionOwnedByActiveAccount(sid)) continue;
        await client.cancel();
      }
    }
    return { cancelled: true };
  });

  /**
   * The participant answered a permission prompt.
   *
   * ⚠ `allow` IS COERCED, NOT TRUSTED. This is renderer input deciding whether an agent may run a
   * shell command, so anything that is not exactly `true` is a denial — a malformed or absent field
   * must not read as consent.
   *
   * ⚠ AND IT IS LOOKED UP UNDER THE SESSION THE CALLER NAMED. Two chats can each have a prompt
   * parked; a renderer that got the pairing wrong (or a compromised one trying to approve another
   * chat's request) finds nothing rather than the other session's promise. An unknown id is not an
   * error — it is what a click racing the timeout looks like.
   */
  ipcMain.handle(
    "kiroAcp:permissionRespond",
    async (
      _event,
      params: { sessionId?: string; id?: string; allow?: boolean; remember?: boolean }
    ) => {
      const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
      const id = typeof params?.id === "string" ? params.id : "";
      if (!sessionId || !id) return { ok: false };
      /**
       * ⚠ AND THE SESSION MUST BE THIS ACCOUNT'S. Scoping the
       * LOOKUP to the named session — the note above — stops a caller reaching a prompt parked in a
       * different chat, but not one reaching a prompt in a chat belonging to a different local
       * ACCOUNT: the prompt is delivered to the WebContents that started the session, so the id is
       * known to renderer code in that window and survives an `auth:switchAccount`. Answering it
       * approves an agent tool call under an identity the caller is no longer signed in as.
       * `claude-sdk:permission-respond` was given this gate in an earlier cycle; this one was not.
       */
      if (!isSessionOwnedByActiveAccount(sessionId)) return { ok: false };

      const settle = pendingAcpPermissions.get(sessionId)?.get(id);
      if (!settle) return { ok: false, unknown: true };
      /**
       * ⚠ `remember` ONLY EVER WIDENS AN APPROVAL, never a refusal, and only for this session's shell.
       * Both conditions are checked here rather than trusted from the renderer: `allow === true` because
       * anything else is a denial (the note above), and the grant is recorded before `settle` so a request
       * arriving in the same tick cannot beat it.
       */
      if (params?.allow === true && params?.remember === true) {
        shellApprovedForSession.add(sessionId);
        recordSecurityEvent({
          event: "tool.permission",
          outcome: "success",
          userId: activeUserId() ?? undefined,
          detail: "granted-session:execute",
        });
      }
      settle(params?.allow === true);
      return { ok: true };
    }
  );

  /**
   * Stop one session's client, or every one THIS ACCOUNT owns (e.g. on project switch).
   *
   * ⚠ THE BULK BRANCH IS SCOPED, NOT REMOVED. It walked the
   * whole `acpClients` map, so one argument-less call from any renderer terminated every local
   * account's in-flight turn. Project switch genuinely needs "stop what I have running", which is
   * what this now does — the predicate is the only thing that changed.
   */
  ipcMain.handle("kiroAcp:stop", async (_event, params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { stopped: false };
      const client = acpClients.get(params.sessionId);
      if (client) {
        // Before destroy(): killing the process makes every parked answer unactionable.
        denyAllPendingPermissions(params.sessionId, "the session was stopped");
        // The grant is the session's; it does not outlive it.
        shellApprovedForSession.delete(params.sessionId);
        client.destroy();
        acpClients.delete(params.sessionId);
      }
    } else {
      for (const [sid, client] of [...acpClients]) {
        if (!isSessionOwnedByActiveAccount(sid)) continue;
        denyAllPendingPermissions(sid, "all sessions were stopped");
        shellApprovedForSession.delete(sid);
        client.destroy();
        acpClients.delete(sid);
      }
    }
    return { stopped: true };
  });

  /**
   * ⚠ AN ACTIVITY ORACLE IF UNSCOPED. Answering for an arbitrary session id tells a caller whether
   * another account is mid-turn, which is precisely what `session-ownership.ts` says the uniform
   * refusal message exists to deny. Both branches are limited to this account's sessions.
   */
  ipcMain.handle("kiroAcp:isRunning", async (_event, params?: { sessionId?: string }) => {
    if (params?.sessionId) {
      if (!isSessionOwnedByActiveAccount(params.sessionId)) return { running: false };
      return { running: acpClients.get(params.sessionId)?.isRunning() ?? false };
    }
    return {
      running: [...acpClients].some(
        ([sid, c]) => isSessionOwnedByActiveAccount(sid) && c.isRunning()
      ),
    };
  });

  ipcMain.handle("kiroAcp:newSession", async (_event, params: { sessionId: string; cwd?: string }) => {
    // Same gate as `start`: this replaces the row's resume handle, so it must be this account's row.
    if (!params?.sessionId || !isSessionOwnedByActiveAccount(params.sessionId)) {
      return { error: "Chat not found" };
    }
    const client = acpClients.get(params.sessionId);
    if (!client || !client.isRunning()) {
      return { error: "Kiro ACP not running" };
    }

    try {
      const sessionId = await client.newSession(params?.cwd);
      return { sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  });
}

function extractToolOutput(content: unknown): string | undefined {
  if (!content || !Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const item of content) {
    if (item?.type === "content" && item?.content?.type === "text" && item?.content?.text) {
      texts.push(item.content.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function handleAcpNotification(
  sender: Electron.WebContents,
  client: KiroAcpClient,
  method: string,
  params: unknown
): void {
  // Every event is stamped with THIS client's app session id, so the renderer
  // can route concurrent sessions' output to the right chat (EA-M1).
  const sessionId = client.appSessionId;

  if (method === "session/update") {
    const data = params as { sessionId?: string; update?: { sessionUpdate: string; [key: string]: unknown } };
    const update = data?.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type: string; text?: string } | undefined;
        if (content?.text) {
          client.accumulatedContent += content.text;
          sender.send("kiroAcp:messageChunk", {
            sessionId,
            content: content.text,
          });
        }
        break;
      }

      case "tool_call": {
        // Remembered for the audit record if this call later asks permission — see `rememberToolKind`.
        rememberToolKind(update.toolCallId, update.kind);
        sender.send("kiroAcp:toolCall", {
          sessionId,
          id: (update.toolCallId as string) || randomUUID(),
          name: (update.title as string) || (update.kind as string) || "tool",
          status: (update.status as string) || "running",
          parameters: update.rawInput as Record<string, unknown> | undefined,
          output: undefined,
        });
        break;
      }

      case "tool_call_update": {
        const status = update.status as string | undefined;
        sender.send("kiroAcp:toolCallUpdate", {
          sessionId,
          id: (update.toolCallId as string) || "",
          name: (update.title as string) || "tool",
          status: status === "completed" ? "completed" : status === "failed" ? "failed" : "running",
          output: extractToolOutput(update.content),
        });
        break;
      }

      // Ignore known non-tool updates that don't need rendering
      case "user_message_chunk":
      case "thought_message_chunk":
      case "commands_available":
      case "modes_available":
      case "agent_plan":
        break;

      default:
        // Silently ignore unrecognized session update types
        break;
    }
  } else {
    /**
     * ── ⚠ THE CONTEXT READING IS KEPT HERE, NOT ONLY FORWARDED ────────────────────────────
     *
     * This `else` used to do nothing but forward. The renderer parsed `_kiro.dev/metadata` into React
     * state and drew it in the chat header, which is why the figure existed on the desktop and nowhere
     * else: main — the process that syncs the turn — never retained it.
     *
     * Recording it on the client is the whole fix. `kiroAcp:send` reads it back when the turn ends and
     * hands it to `syncCliTurn`, so the reading travels with the turn it belongs to.
     *
     * ⚠ STILL FORWARDED UNCHANGED. The renderer keeps its own live display and its own threshold, and
     * this must not become "main decides what the UI may draw" — the header updates mid-turn, while the
     * sync happens once at the end. Two consumers of one frame, one parser (`main/kiro-metadata.ts`).
     */
    const usage = readKiroContextUsage(method, params);
    if (usage) client.lastContextUsagePercent = usage.percent;

    // Non-session-update notifications (MCP init, commands, compaction, etc.)
    sender.send("kiroAcp:notification", {
      sessionId,
      method,
      params,
    });
  }
}
