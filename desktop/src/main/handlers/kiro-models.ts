// ── ⚠ KIRO'S REAL MODEL CATALOGUE, ASKED FOR RATHER THAN GUESSED ──────────────────────────
//
// ⚠ THE PREVIOUS ANSWER WAS "KIRO HAS NO LIST", AND IT WAS WRONG BY THE TIME IT WAS WRITTEN. `cli:getModels`
// and `model-list-scope.test.ts` both stated that Kiro's models "are genuinely set server-side" and returned
// an empty list. That claim is now measured to be false, and the note is corrected rather than left to
// mislead the next person: kiro-cli enumerates its own models two different ways.
//
//     $ kiro-cli chat --list-models --format json
//     {"models":[{"model_name":"claude-sonnet-5","model_id":"claude-sonnet-5",
//                 "description":"Claude Sonnet 5 model with 1M context window",
//                 "context_window_tokens":1000000,"rate_multiplier":1.3,"rate_unit":"Credit"}, …],
//      "default_model":"auto"}
//
// 21 models on this machine, `auto` as default. The ACP `session/new` response carries the same catalogue in
// its `models.availableModels`, which was verified in the same probe.
//
// ⚠ THE CLI IS USED RATHER THAN THE ACP RESPONSE, and the reason is WHEN the picker needs the list. ACP
// clients start lazily on the first send (see `kiro-acp.ts`), so at the moment the composer renders there is
// no session and therefore no catalogue. Reading it from `session/new` would mean the picker was empty until
// after the first message — precisely when a participant wants to choose. This path answers before anything
// is sent.
//
// ⚠ AND `rate_multiplier` IS THE FIELD WORTH HAVING THAT CODEX DOES NOT PUBLISH. It is a relative cost
// (`claude-opus-5` 2.2, `claude-haiku-4.5` 0.4, `qwen3-coder-next` 0.05), which lets the picker say what a
// choice costs RELATIVE TO ANOTHER CHOICE — a comparison within one assistant, which is exactly the kind
// this codebase permits. It is deliberately NOT turned into money or summed with anything: see BACKLOG 9a on
// credits being a billing unit rather than a count.
//
// ── WHAT MAKES SPAWNING A PROCESS TO POPULATE A DROPDOWN ACCEPTABLE ──
//
// ⚠ BOUNDED AND CACHED, because this is on the path of opening a chat — and here that matters more than it
// does for Codex: the call was MEASURED at 3.2s and 4.6s on this machine, against Codex's sub-second
// handshake. Without the cache every chat switch would cost a visible multi-second stall. One hard timeout, a
// cap on buffered stdout, the child killed on every exit path, and a failure returns an empty catalogue,
// which the composer already renders as "no picker".

import { spawnPortable } from "../spawn-confined";
import { debugLog } from "../debug-log";

/**
 * How long to wait for the whole catalogue.
 *
 * ⚠ GENEROUS ON PURPOSE, AND SIZED FROM A MEASUREMENT. Two consecutive runs took 4.59s and 3.23s — the
 * command reaches a service rather than reading a local file. Codex's 8s ceiling would leave under 4s of
 * headroom over the observed worst case, so a slow network would present as "Kiro has no models" rather than
 * as slowness. 15s is long enough to be a real timeout and still short enough that a broken install does not
 * hold a picker in a loading state anyone waits on.
 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * A ceiling on buffered stdout. The real catalogue is about 4KB; anything approaching this is a CLI that has
 * started streaming logs at us, and it must not grow without limit.
 */
const MAX_STDOUT_BYTES = 512 * 1024;

/**
 * How long a fetched catalogue is reused.
 *
 * Longer than Codex's ten minutes because the call is an order of magnitude more expensive and the data
 * changes on CLI updates, not minute to minute.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** One model as the composer needs it. */
export interface KiroModel {
  /** What `--model` takes. */
  id: string;
  label: string;
  description: string;
  /**
   * The model's context window, in tokens, when Kiro stated it.
   *
   * Kept because it is the other half of the figure this app already shows for Kiro chats: a "62% full"
   * reading means something very different against 200k than against 1M.
   */
  contextWindowTokens: number | null;
  /**
   * Relative cost, as Kiro's own `rate_multiplier`.
   *
   * ⚠ A RATIO, NOT A PRICE, and never rendered as currency. It compares two models WITHIN Kiro, which is a
   * comparison the data supports; it says nothing about a Codex or Claude turn.
   */
  rateMultiplier: number | null;
}

export interface KiroCatalogue {
  models: KiroModel[];
  /** The model Kiro itself reports as default, or "" when the catalogue is empty. */
  defaultModel: string;
}

const EMPTY: KiroCatalogue = { models: [], defaultModel: "" };

let cache: { at: number; value: KiroCatalogue } | null = null;

/**
 * Shape the raw `--list-models` payload into what the composer renders.
 *
 * ⚠ EVERY FIELD IS CHECKED RATHER THAN TRUSTED. This crosses a process boundary into a tool that updates
 * itself — `kiro-cli` was 2.18.1 when this was written — so a later version may rename or drop a field. A
 * model with no id is unusable and is dropped; a model missing the optional extras still works as a choice.
 *
 * Exported for the tests: the parsing is the part that can be wrong, and reaching it otherwise needs a live
 * CLI and four seconds.
 */
export function normaliseKiroModels(raw: unknown): KiroCatalogue {
  if (!raw || typeof raw !== "object") return EMPTY;
  const list = (raw as { models?: unknown }).models;
  if (!Array.isArray(list)) return EMPTY;

  const models: KiroModel[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    /**
     * `model_id` is what `--model` takes, and `model_name` is the display name. They are equal in the
     * observed response, and `model_id` is the one whose MEANING is "pass this to the CLI", so it wins —
     * the same decision `codex-models.ts` makes between `model` and `id`, for the same reason.
     */
    const id =
      typeof e.model_id === "string" && e.model_id
        ? e.model_id
        : typeof e.model_name === "string"
          ? e.model_name
          : "";
    if (!id) continue;

    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

    models.push({
      id,
      label: typeof e.model_name === "string" && e.model_name ? e.model_name : id,
      description: typeof e.description === "string" ? e.description : "",
      contextWindowTokens: num(e.context_window_tokens),
      rateMultiplier: num(e.rate_multiplier),
    });
  }

  /**
   * ⚠ THE CLI'S OWN `default_model` IS AUTHORITATIVE HERE, unlike the Codex path — and the difference is
   * worth stating because the two look inconsistent side by side. Codex has to reconcile the provider's
   * default against `~/.codex/config.toml`, because the CLI uses the config's pin when no `-m` is passed and
   * the composer would otherwise name a model that was not answering. `--list-models` reports what THIS
   * install will actually use, so there is no second source to reconcile against.
   *
   * Falls back to the first model rather than "" so the picker never renders with nothing selected.
   */
  const declared = (raw as { default_model?: unknown }).default_model;
  const defaultModel =
    (typeof declared === "string" && models.some((m) => m.id === declared) ? declared : "") ||
    models[0]?.id ||
    "";

  return { models, defaultModel };
}

/**
 * Ask the installed Kiro for its models.
 *
 * Never throws and never rejects: a missing CLI, a renamed flag or a timeout all mean "no catalogue", which
 * the composer renders as no picker — the same honest degradation as before this existed.
 */
export async function fetchKiroModels(deps?: {
  /** Injected in tests, so the parsing and caching can be exercised without a real Kiro. */
  run?: (timeoutMs: number) => Promise<string>;
  now?: () => number;
  /** Skip the cache. */
  force?: boolean;
}): Promise<KiroCatalogue> {
  const now = deps?.now ?? (() => Date.now());
  if (!deps?.force && cache && now() - cache.at < CACHE_TTL_MS) return cache.value;

  try {
    const stdout = await (deps?.run ?? runListModels)(FETCH_TIMEOUT_MS);
    const value = normaliseKiroModels(parseCatalogue(stdout));
    /**
     * Only a non-empty answer is cached. An empty one usually means the CLI was mid-update or offline, and
     * caching that would keep the picker hidden for half an hour after it started working again.
     */
    if (value.models.length > 0) cache = { at: now(), value };
    return value;
  } catch (err) {
    debugLog("[kiro-models] catalogue unavailable:", err instanceof Error ? err.message : String(err));
    return EMPTY;
  }
}

/**
 * Pull the JSON object out of the CLI's stdout.
 *
 * ⚠ NOT A BARE `JSON.parse`. kiro-cli prints update notices and warnings to stdout at times, so the payload
 * is not reliably the whole stream — the same tolerance `codex-models.ts` needs for interleaved
 * notifications. The catalogue is located by finding the first line that parses and carries `models`.
 *
 * Exported for the tests: a preamble line is the normal case for a CLI that self-updates, not an edge one.
 */
export function parseCatalogue(stdout: string): unknown {
  /* The common case: the whole stream is the object. */
  const whole = tryParse(stdout);
  if (whole) return whole;

  for (const line of stdout.split("\n")) {
    const parsed = tryParse(line);
    if (parsed) return parsed;
  }
  throw new Error("no model catalogue in output");
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === "object" && Array.isArray((obj as { models?: unknown }).models)
      ? obj
      : null;
  } catch {
    return null;
  }
}

/** Spawn the CLI and return whatever it printed. */
function runListModels(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    /**
     * ⚠ `shell: false` (the default here) AND A FIXED ARGUMENT LIST. Nothing in this command is
     * caller-supplied — there is no interpolation of any kind — so there is nothing for a shell to reparse.
     */
    // Portable spawn: on Windows this resolves kiro-cli through PATH/PATHEXT rather than failing
    // with ENOENT, which is what made the model picker permanently empty there.
    const child = spawnPortable("kiro-cli", ["chat", "--list-models", "--format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      if (out.length > MAX_STDOUT_BYTES) finish(new Error("list-models output exceeded the buffer cap"));
    });
    /* Drained rather than ignored: an unread pipe can fill and block the child. */
    child.stderr!.on("data", () => {});

    child.on("error", (err) => finish(err));
    /**
     * ⚠ WAITS FOR `close`, UNLIKE THE CODEX PATH. `codex app-server` is a server that never exits, so that
     * reader has to resolve as soon as it sees its answer. This command terminates (exit 0 observed), and
     * resolving early on a partial JSON object would be a parse failure presented as "no models".
     */
    child.on("close", () => finish(null));
  });
}

/** Test seam: the cache would otherwise leak between cases. */
export function __resetKiroModelCache(): void {
  cache = null;
}
