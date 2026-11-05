import fs from "fs";
import os from "os";
import path from "path";
import { debugLog } from "./debug-log";

/**
 * Load Claude Code's settings the way THE CLI ITSELF does: home first, then the
 * project's, with the project winning.
 *
 * ── THE BUG THIS FIXES ──
 *
 * The desktop used to read `~/.claude/settings.json` and nothing else, then hand that
 * env to the spawned CLI. But a workshop project ships its own
 * `<project>/.claude/settings.json` carrying the settings that make Bedrock work:
 *
 *     "CLAUDE_CODE_USE_BEDROCK": "1",
 *     "AWS_REGION": "us-east-1",
 *     "ANTHROPIC_DEFAULT_OPUS_MODEL": "global.anthropic.claude-opus-4-8[1m]"
 *
 * Ignoring that file meant the CLI never entered Bedrock mode, fell back to the
 * Anthropic API with no key, and failed with `403 authentication_failed` — retried ten
 * times with growing backoff, so it presented as a long hang rather than an error. The
 * same CLI run from a terminal in that folder worked, because the CLI reads the project
 * file and the desktop did not.
 *
 * Region made it worse than a single missing flag: a home file saying `us-west-2` and a
 * project saying `us-east-1` would send requests to the wrong region even once the flag
 * was set, and `global.*` model ids need the right one to resolve.
 *
 * ── WHY `awsCredentialExport` IS DELIBERATELY HOME-ONLY ──
 *
 * That value is a SHELL COMMAND the app executes. Honouring it from a project directory
 * would mean opening a folder could run arbitrary code — a participant cloning a
 * workshop repo would be executing whatever its `.claude/settings.json` specified. Env
 * VARIABLES from a project are a normal, expected configuration surface; an exec command
 * is not. So the merge below takes `env` from the project and the credential export only
 * from the user's own home file.
 */

/** Precedence order, lowest first — later files override earlier ones. */
function settingsFilesFor(projectPath?: string): string[] {
  const home = os.homedir();
  const files = [
    path.join(home, ".claude", "settings.json"),
    // The CLI honours a local override alongside the shared file; this repo has one.
    path.join(home, ".claude", "settings.local.json"),
  ];
  if (projectPath) {
    files.push(path.join(projectPath, ".claude", "settings.json"));  // nosemgrep: path-join-resolve-traversal
    files.push(path.join(projectPath, ".claude", "settings.local.json"));  // nosemgrep: path-join-resolve-traversal
  }
  return files;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    // Absent is the common case and not worth logging. A malformed file is worth
    // knowing about, but not worth failing the spawn over — the layers below it still
    // apply, which is better than refusing to start the assistant.
    if (fs.existsSync(file)) {  // nosemgrep: detect-non-literal-fs-filename
      debugLog(`[claude-settings] ignoring unreadable/invalid ${file}`);
    }
    return null;
  }
}

export interface ClaudeSettings {
  /** Merged `env` block, project overriding home. Safe to spread into a spawn env. */
  env: Record<string, string>;
  /** The credential-export command. HOME ONLY — see the note above. */
  credentialExport: string;
  /** Merged remainder, for callers that need `model` / `availableModels`. */
  merged: Record<string, unknown>;
  /** Which files actually contributed, for diagnostics. */
  sources: string[];
}

/**
 * Merge the settings that apply to a spawn in `projectPath`.
 *
 * Only string values survive into `env`: a number or object in a settings file would
 * become "42" or "[object Object]" in the child's environment, which is a confusing
 * failure a long way from its cause.
 */
export function loadClaudeSettings(projectPath?: string): ClaudeSettings {
  const env: Record<string, string> = {};
  const merged: Record<string, unknown> = {};
  const sources: string[] = [];
  let credentialExport = "";

  for (const file of settingsFilesFor(projectPath)) {
    const data = readJson(file);
    if (!data) continue;
    sources.push(file);

    for (const [k, v] of Object.entries(data)) {
      if (k === "env") continue;
      merged[k] = v;
    }

    if (data.env && typeof data.env === "object" && !Array.isArray(data.env)) {
      for (const [k, v] of Object.entries(data.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }

    // Home files only. `settingsFilesFor` puts the two home paths first, so this
    // condition is "still in the home half of the list".
    const isHome = file.startsWith(path.join(os.homedir(), ".claude") + path.sep);
    if (isHome && typeof data.awsCredentialExport === "string") {
      credentialExport = data.awsCredentialExport;
    }
  }

  return { env, credentialExport, merged, sources };
}

/**
 * Is this configuration INTERNALLY INCONSISTENT in a way that cannot authenticate?
 *
 * ── WHY THIS ONLY EVER REPORTS A CONTRADICTION ──
 *
 * It is NOT a check for "is auth configured", because that question cannot be answered
 * from settings files. Claude Code authenticates four different ways, and two of them
 * are invisible here:
 *
 *   1. Bedrock          — env flag + AWS credentials  (visible)
 *   2. Vertex           — env flag + GCP credentials  (visible)
 *   3. API key          — ANTHROPIC_API_KEY in env    (visible)
 *   4. **Anthropic direct** — `claude login` with a Claude.ai subscription or a
 *      console account, whose token lives in the macOS **Keychain** or
 *      `~/.claude/.credentials.json`, and NEVER in a settings file. Also
 *      `apiKeyHelper`, a command the CLI runs to fetch a key at request time.
 *
 * A customer on (4) has a completely valid setup with an empty `env` block. An earlier
 * version of this function returned "no model provider is configured" for exactly that
 * case and the caller REFUSED TO SPAWN — which would have broken every subscription and
 * console user while pointing them at a Bedrock flag they must not set. That is a worse
 * bug than the one this was written to catch, so the rule is now narrow and explicit:
 *
 *   **Report only a CONTRADICTION — a provider explicitly enabled while the thing that
 *   provider requires is absent. Say nothing about an empty configuration.**
 *
 * An empty config means "the CLI will use whatever it has", which is usually a logged-in
 * session and none of our business. If it genuinely has nothing, the CLI's own error is
 * the right one to show, because it knows about the Keychain and we do not.
 */
export function describeAuthGap(
  env: Record<string, string>,
  credentialExport: string
): string | null {
  const usingBedrock = env.CLAUDE_CODE_USE_BEDROCK === "1";
  const usingVertex = env.CLAUDE_CODE_USE_VERTEX === "1";

  // Both providers on at once is a genuine contradiction: the CLI can only use one, so
  // whichever loses leaves the user debugging the wrong half.
  if (usingBedrock && usingVertex) {
    return "Both CLAUDE_CODE_USE_BEDROCK and CLAUDE_CODE_USE_VERTEX are set — enable only one.";
  }

  if (usingBedrock) {
    if (!credentialExport && !env.AWS_ACCESS_KEY_ID && !env.AWS_PROFILE) {
      return "Bedrock is enabled but no AWS credentials are configured (no awsCredentialExport, AWS_PROFILE or AWS_ACCESS_KEY_ID).";
    }
    if (!env.AWS_REGION) {
      return "Bedrock is enabled but AWS_REGION is not set.";
    }
    return null;
  }

  if (usingVertex && !env.CLOUD_ML_REGION && !env.GOOGLE_CLOUD_REGION) {
    return "Vertex is enabled but no region is set (CLOUD_ML_REGION or GOOGLE_CLOUD_REGION).";
  }

  // Everything else — including an entirely empty env — is fine as far as we can tell.
  // Anthropic-direct auth, apiKeyHelper, and an inherited ANTHROPIC_API_KEY from the
  // parent environment are all real and none of them appear in a settings file.
  return null;
}

/**
 * A HINT about a likely misconfiguration — never a reason to refuse.
 *
 * The one case worth mentioning: an `awsCredentialExport` is configured (so the user has
 * gone to the trouble of wiring AWS credentials for Claude Code) but the Bedrock flag is
 * missing. That combination is what produced the reported 403 — the flag sat in a project
 * file the desktop did not read. It is a STRONG signal, not a certainty: someone could
 * legitimately have an AWS export for other tooling while using Anthropic directly.
 *
 * So it is surfaced only alongside a failure that already happened, where it is the most
 * probable explanation and cannot block anyone who is working fine.
 */
export function bedrockFlagHint(
  env: Record<string, string>,
  credentialExport: string
): string | null {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_VERTEX === "1") return null;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return null;
  if (!credentialExport) return null;

  return (
    "AWS credentials are configured for Claude Code but CLAUDE_CODE_USE_BEDROCK is not set, " +
    'so it will call the Anthropic API instead of Bedrock. If you meant to use Bedrock, add ' +
    '"CLAUDE_CODE_USE_BEDROCK": "1" to the env block of ~/.claude/settings.json or your ' +
    "project's .claude/settings.json."
  );
}
