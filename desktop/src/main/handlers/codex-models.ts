// ── ⚠ CODEX'S REAL MODEL CATALOGUE, ASKED FOR RATHER THAN GUESSED ────────────────────────
//
// ⚠ THE LAST TIME THIS WAS ASKED, THE HONEST ANSWER WAS "NO LIST EXISTS". `cli:getModels` deliberately
// returns nothing for Codex, because it used to hand out CLAUDE's models to every assistant — Codex was
// offered "Opus" and the composer claimed Opus was answering. Replacing that with a list transcribed from a
// screenshot would have been the same mistake wearing different names: a control that looks authoritative
// and is not, sending `-m` values the CLI may reject.
//
// ⚠ SO THE LIST IS NOW FETCHED FROM CODEX ITSELF. `codex app-server` speaks a JSON-RPC protocol with a
// `model/list` method, and the CLI will print that protocol's own JSON Schema
// (`codex app-server generate-json-schema`), which is how the shape below was established rather than
// inferred. The live response on this machine returned exactly the five models in the screenshot, with
// `openai.gpt-5.6-sol` as default — so the picker is the CLI's own catalogue, not a copy of it.
//
// ⚠ AND EFFORTS BELONG TO A MODEL, NOT TO THE APP. The schema says so — "a non-empty reasoning effort value
// advertised by the model", a plain string with no enum — and the data proves it matters: GPT-5.6 offers
// low/medium/high/xhigh/max while GPT-5.5 and 5.4 stop at xhigh. A hardcoded four-item list would have
// offered `max` to a model that does not take it and hidden it from the ones that do. Each model therefore
// carries its own efforts and its own default.
//
// ── WHAT MAKES SPAWNING A PROCESS TO POPULATE A DROPDOWN ACCEPTABLE ──
//
// ⚠ BOUNDED AND CACHED, because this is on the path of opening a chat. One hard timeout, a cap on how much
// stdout is buffered, the child killed on every exit path including timeout, and the answer cached so
// switching chats does not spawn a process per mount. A failure returns an empty catalogue, which the
// composer already knows how to render as "no picker" — the same honest degradation as before.

import { spawnPortable } from "../spawn-confined";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "../debug-log";

/**
 * How long to wait for the whole handshake.
 *
 * ⚠ THE RESPONSE IS NOT IMMEDIATE and it is not local: `model/list` is served after `initialize`, and the
 * catalogue may come from the provider. Eight seconds is far longer than the observed round trip and short
 * enough that a broken install does not hold the composer's picker in a loading state anyone notices.
 */
const FETCH_TIMEOUT_MS = 8_000;

/**
 * A ceiling on buffered stdout.
 *
 * The app-server also emits unsolicited notifications (`remoteControl/status/changed` arrived during the
 * probe), so this reader must tolerate traffic it did not ask for — and must not grow without limit if that
 * traffic never stops. The real catalogue is a few kilobytes.
 */
const MAX_STDOUT_BYTES = 512 * 1024;

/** How long a fetched catalogue is reused. Models change on CLI updates, not minute to minute. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** One model as the composer needs it. `efforts` is the model's OWN list, in the order Codex gave it. */
export interface CodexModel {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  efforts: { id: string; description: string }[];
  defaultEffort: string;
}

export interface CodexCatalogue {
  models: CodexModel[];
  /** The model Codex itself marks as default, or "" when the catalogue is empty. */
  defaultModel: string;
}

const EMPTY: CodexCatalogue = { models: [], defaultModel: "" };

let cache: { at: number; value: CodexCatalogue } | null = null;

/**
 * Shape the raw `model/list` entry into what the composer renders.
 *
 * ⚠ EVERY FIELD IS CHECKED RATHER THAN TRUSTED. This crosses a process boundary into a tool that updates
 * itself, so a future version may drop a field or rename it. A model without an id is unusable and is
 * dropped; a model without efforts keeps working as a plain model choice.
 */
export function normaliseCodexModels(
  raw: unknown,
  /** Injected in tests. Production reads `~/.codex/config.toml`. */
  configuredModel: () => string = configuredCodexModel
): CodexCatalogue {
  if (!raw || typeof raw !== "object") return EMPTY;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return EMPTY;

  const models: CodexModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    /**
     * `model` is what the CLI takes as `-m`; `id` is the catalogue key. They are equal in the observed
     * response, and `model` is the one whose meaning is "pass this to the CLI", so it wins.
     */
    const id = typeof e.model === "string" && e.model ? e.model : typeof e.id === "string" ? e.id : "";
    if (!id) continue;
    // Hidden models are hidden from the picker for the same reason Codex hides them from its own.
    if (e.hidden === true) continue;

    const efforts: { id: string; description: string }[] = [];
    if (Array.isArray(e.supportedReasoningEfforts)) {
      for (const opt of e.supportedReasoningEfforts) {
        if (!opt || typeof opt !== "object") continue;
        const o = opt as Record<string, unknown>;
        if (typeof o.reasoningEffort === "string" && o.reasoningEffort) {
          efforts.push({
            id: o.reasoningEffort,
            description: typeof o.description === "string" ? o.description : "",
          });
        }
      }
    }

    const defaultEffort =
      typeof e.defaultReasoningEffort === "string" && e.defaultReasoningEffort
        ? e.defaultReasoningEffort
        : (efforts[0]?.id ?? "");

    models.push({
      id,
      label: typeof e.displayName === "string" && e.displayName ? e.displayName : id,
      description: typeof e.description === "string" ? e.description : "",
      isDefault: e.isDefault === true,
      efforts,
      defaultEffort,
    });
  }

  /**
   * ⚠ FALLS BACK TO THE FIRST MODEL RATHER THAN TO "". A catalogue where nothing is flagged default would
   * otherwise render the picker with no selection, and `resolveModel` would have nothing to reconcile
   * against — the composer would claim no model was chosen while Codex quietly used its own.
   */
  /**
   * ⚠ THE CONFIGURED MODEL WINS OVER THE CATALOGUE'S FLAG, when it names one we actually have. It is what the
   * CLI will use if we pass no `-m`, so it is what the composer must name. The catalogue's `isDefault` is the
   * fallback for a machine with no `model` pinned.
   */
  const configured = configuredModel();
  const defaultModel =
    (configured && models.some((m) => m.id === configured) ? configured : "") ||
    models.find((m) => m.isDefault)?.id ||
    models[0]?.id ||
    "";
  return { models, defaultModel };
}

/**
 * The model this machine's Codex is actually configured to use.
 *
 * ⚠ THE CATALOGUE'S `isDefault` IS THE WRONG ANSWER, and the composer was showing it: `model/list` flags
 * `openai.gpt-5.6-sol` as default — that is the PROVIDER's default — while `~/.codex/config.toml` pins
 * `model = "openai.gpt-5.4"`. With no `-m` passed, the CLI uses 5.4, so the composer confidently named a
 * model that was not answering. That is the same defect as offering Claude's models to Codex, in miniature.
 *
 * ⚠ READ, NOT WRITTEN. The file is the participant's own configuration; this only ever looks at it. A parse
 * failure or a missing file returns "", and the caller falls back to the catalogue's default rather than
 * claiming to know.
 *
 * Deliberately a line-scan and not a TOML parser: the value needed is one top-level key, and pulling in a
 * dependency to read it would be the larger change. `[section]` scanning stops it matching a `model = …`
 * nested inside a provider or profile table, which is a DIFFERENT setting.
 */
export function configuredCodexModel(readConfig: () => string = defaultConfigReader): string {
  try {
    for (const raw of readConfig().split(/\r?\n/)) {
      const line = raw.trim();
      // A section header ends the top-level block; everything after it belongs to that table.
      if (line.startsWith("[")) break;
      const match = /^model\s*=\s*"([^"]+)"/.exec(line);
      if (match) return match[1];
    }
  } catch {
    // No config, or unreadable: the catalogue's default is the honest fallback.
  }
  return "";
}

function defaultConfigReader(): string {
  return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
}

/**
 * Ask the installed Codex for its models.
 *
 * Never throws and never rejects: a missing CLI, a protocol change or a timeout all mean "no catalogue",
 * which the composer renders as no picker.
 */
export async function fetchCodexModels(deps?: {
  /** Injected in tests, so the protocol handling can be exercised without a real Codex. */
  run?: (payload: string, timeoutMs: number) => Promise<string>;
  now?: () => number;
  /** Skip the cache. */
  force?: boolean;
}): Promise<CodexCatalogue> {
  const now = deps?.now ?? (() => Date.now());
  if (!deps?.force && cache && now() - cache.at < CACHE_TTL_MS) return cache.value;

  /**
   * The handshake, in the order the protocol requires: `initialize` first (it is the only request answered
   * before the client is ready), then the `initialized` notification, then the actual question.
   *
   * ⚠ ALL THREE ARE WRITTEN UP FRONT AND STDIN IS LEFT OPEN. A first probe wrote them and closed stdin
   * immediately: `initialize` answered, and `model/list` never did — the process exited at EOF before its
   * async reply came back. The reader below is what holds it open.
   */
  const payload =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "praimana-desktop", version: "1" } },
    }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: { includeHidden: false } }) +
    "\n";

  try {
    const stdout = await (deps?.run ?? runAppServer)(payload, FETCH_TIMEOUT_MS);
    const value = normaliseCodexModels(findResponse(stdout, 2));
    // Only a non-empty answer is cached: an empty one usually means the CLI was mid-update or offline, and
    // caching that would keep the picker hidden for ten minutes after it started working again.
    if (value.models.length > 0) cache = { at: now(), value };
    return value;
  } catch (err) {
    debugLog("[codex-models] catalogue unavailable:", err instanceof Error ? err.message : String(err));
    return EMPTY;
  }
}

/**
 * Pull one JSON-RPC result out of a stream that also carries notifications.
 *
 * Exported for the tests: interleaved notifications are the normal case, not an edge one, and a reader that
 * assumed "the last line is the answer" would break the moment Codex emitted a status change after it.
 */
export function findResponse(stdout: string, id: number): unknown {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // Not every line is ours; a partial or a log line is not an error.
    }
    if (obj && typeof obj === "object" && (obj as { id?: unknown }).id === id) {
      const rec = obj as { result?: unknown; error?: unknown };
      if (rec.error) throw new Error(`model/list failed: ${JSON.stringify(rec.error).slice(0, 200)}`);
      return rec.result;
    }
  }
  throw new Error("no response to model/list");
}

/** Spawn the app-server, feed it the handshake, and return whatever it printed. */
function runAppServer(payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Portable spawn — `codex` is a .cmd shim on Windows. See windows-launch.ts.
    const child = spawnPortable("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;

    /** Every exit path goes through here, so the child is never left running and never resolves twice. */
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(out);
    };

    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > MAX_STDOUT_BYTES) {
        finish(new Error("app-server output exceeded the buffer cap"));
        return;
      }
      /**
       * ⚠ RESOLVES AS SOON AS THE ANSWER ARRIVES rather than waiting for the process to end. The
       * app-server is a SERVER: it does not exit after replying, so waiting for `close` would always cost
       * the full timeout.
       */
      if (out.includes('"id":2')) finish(null);
    });

    child.on("error", (err) => finish(err));
    child.on("close", () => finish(null));

    child.stdin!.on("error", () => {
      /* A closed pipe surfaces on `error`/`close` above; nothing useful to add here. */
    });
    child.stdin!.write(payload);
  });
}

/** Test seam: the cache would otherwise leak between cases. */
export function __resetCodexModelCache(): void {
  cache = null;
}
