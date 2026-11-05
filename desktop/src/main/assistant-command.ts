/**
 * ── ⚠ WHICH BINARY THE APP IS ALLOWED TO EXECUTE ──────────────────────────────────────────────
 *
 * That is arbitrary local code execution, and it needed no exploit — two IPC calls the bridge already
 * offered:
 *
 *     electronAPI.setSetting("ai_command", "/tmp/payload.sh")   // allowed: it was on the write list
 *     electronAPI.cliSend({ sessionId, message: "hi" })         // → spawn("/tmp/payload.sh")
 *
 * `buildCliArgs` made the second step certain rather than likely: its `switch` matches "claude",
 * "kiro-cli" and "codex", and the DEFAULT case is `return { cmd: command, args: [] }` — an unmatched
 * value is spawned verbatim. `shell: false` limits the damage to "no shell metacharacters"; it does
 * not stop a named executable from running.
 *
 * ── ⚠ WHY AN ID, NOT A COMMAND, CROSSES THE IPC BOUNDARY ──
 *
 * The renderer no longer supplies the string that gets executed. It names an ASSISTANT — "claude",
 * "kiro", "codex" — and main maps that to a command through `COMMAND_FOR_ASSISTANT` below. An
 * unrecognised id is refused outright, so the set of executables this app can ever launch is fixed
 * at build time and readable in one place.
 *
 * Validating the command string instead ("is it on a list?") would work identically today and is
 * the weaker shape: it keeps a channel whose payload IS an executable name, so the check is the only
 * thing standing between the renderer and `spawn`. Here there is no such channel to guard.
 *
 * `framework.ts` already did it this way (`params.assistant === "kiro" ? "kiro-cli" : …`, line 363),
 * which is why the framework installer was never vulnerable. This generalises that.
 *
 * ── ⚠ AND THE READ SIDE IS CHECKED TOO, WHICH IS NOT REDUNDANT ──
 *
 * `resolveAssistantCommand` re-validates whatever is in the database before it is spawned. Closing
 * the write path stops NEW poisoning; it does nothing about a row an already-exploited install
 * wrote earlier, and `settings` is a plaintext SQLite table that anything running as this user can
 * edit. Two independent gates, because the write list is policy and this is the last word before
 * `spawn`.
 */

/**
 * Assistant id → the executable that runs it. The complete set of binaries this app may spawn for
 * a chat turn.
 *
 * ⚠ ADDING AN ENTRY HERE WIDENS WHAT THE APP CAN EXECUTE. It is the intended place to do that, and
 * it must stay a literal map — never a computed one, and never one merged from a setting, a server
 * response or a workshop config, all of which would put the choice back outside main.
 */
export const COMMAND_FOR_ASSISTANT: Readonly<Record<string, string>> = Object.freeze({
  claude: "claude",
  kiro: "kiro-cli",
  codex: "codex",
});

/** The command used when nothing valid is configured. Matches the previous `|| "claude"` default. */
export const DEFAULT_AI_COMMAND = "claude";

/**
 * Every command that may be spawned, derived from the map so the two cannot drift.
 *
 * ⚠ `"kiro"` IS ACCEPTED AS A STORED VALUE and `"kiro-cli"` is what runs. Installs predating the
 * rename hold `ai_command = "kiro"` — `cli:useAcpMode` still tests for both — so rejecting it would
 * silently move existing Kiro users onto Claude. It is normalised, not trusted.
 */
export const ALLOWED_AI_COMMANDS: ReadonlySet<string> = new Set(Object.values(COMMAND_FOR_ASSISTANT));

/** Stored values that are legal but not the current spelling. */
const NORMALISED: Readonly<Record<string, string>> = Object.freeze({ kiro: "kiro-cli" });

/**
 * The command for an assistant id, or `null` if the id is not one we ship.
 *
 * Returning `null` rather than the default is deliberate: the caller is an IPC handler acting on a
 * renderer-supplied id, and "we do not know that assistant" must surface as a refusal rather than
 * quietly switching the user to a different one.
 */
export function commandForAssistant(assistantId: unknown): string | null {
  if (typeof assistantId !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_FOR_ASSISTANT, assistantId)) return null;
  /**
   * ⚠ RETURNS THE SHIPPED NAME, NOT A LOCAL RENAME, AND THAT WAS A BUG ONCE. This value is used as
   * an IDENTITY TOKEN all over the app — `currentCli === "claude"` picks the SDK path in
   * AssistantChatView, `command === "codex"` gates the JSON parsing in this file's spawn handler,
   * `assistantCommand() === "kiro-cli"` selects ACP mode. Returning `claude_bedrock` here made
   * `usesSdk` false, routed Claude down the generic CLI path, and dumped raw stream-json into the
   * participant's chat. Same for codex: its parser branch stopped matching and the JSONL was shown
   * verbatim.
   *
   * The rename is applied at the SPAWN SITE only — `buildCliArgs` returns
   * `spawnCommandFor(<shipped>)` as its `cmd`. Identity stays canonical; only the executable moves.
   */
  return COMMAND_FOR_ASSISTANT[assistantId];
}

/**
 * The command to spawn for the configured assistant — always one of `ALLOWED_AI_COMMANDS`.
 *
 * ⚠ FALLS BACK RATHER THAN THROWING. A stored value that is unrecognised (legacy `"cli"`, a hand-
 * edited row, a poisoned one) yields the default and a warning. Throwing would take the chat down
 * on a bad setting, and the safe action is available and obvious: run the default assistant.
 *
 * @param stored the raw `ai_command` value, as read from settings
 */
export function resolveAssistantCommand(stored: unknown): string {
  if (typeof stored !== "string" || stored.length === 0) return DEFAULT_AI_COMMAND;

  const normalised = NORMALISED[stored] ?? stored;
  /* Canonical, for the same identity reason as commandForAssistant above. */
  if (ALLOWED_AI_COMMANDS.has(normalised)) return normalised;

  /**
   * Logged as a security event, not a curiosity: reaching here means the settings row holds
   * something no code path in this app can write, so either the row predates the allowlist or
   * something edited the database directly.
   */
  console.warn(
    `[assistant-command] refusing to spawn unrecognised ai_command; using "${DEFAULT_AI_COMMAND}" instead`
  );
  return DEFAULT_AI_COMMAND;
}

/**
 * ── ⚠ LOCAL RENAME OVERRIDES, FOR INSTALLS THAT DO NOT USE THE STANDARD BINARY NAME ───────────
 *
 * Some environments ship a wrapper under a different name — `claude_bedrock` for a Bedrock-backed
 * build, `claude-wrapper` on a wrapper-based install. Without this, `COMMAND_FOR_ASSISTANT` spawns
 * the literal `claude`, the participant gets `spawn claude ENOENT` on their first message, and there
 * is nothing they can do about it.
 *
 * ⚠ WHY A SETTER AND NOT A FILE READ IN THIS MODULE. This file has NO imports, deliberately: it is
 * the allowlist that decides what the app may execute, and being pure keeps it trivially testable
 * and free of anything that could pull a value in from outside main. Reading a file here would
 * import `electron` and `fs` into exactly the module whose job is to not depend on the world. So
 * main reads the file at boot and passes the result in; the validation lives here, next to the
 * allowlist it relaxes.
 *
 * ⚠ AND WHY THIS IS NOT THE HOLE THE REST OF THIS FILE GUARDS AGAINST. The gates above exist to
 * stop a COMPROMISED RENDERER or a REMOTE workshop config choosing what gets executed — see the
 * `setSetting("ai_command", "/tmp/payload")` note in setting-access.ts. This override comes from a
 * file only the local user can write, in a directory outside the repo. Someone who can write it can
 * already write `~/.zshrc`, so it grants them nothing new. It is NOT reachable over IPC, it is NOT
 * read from the server, and it is NOT part of the workshop config a facilitator distributes.
 *
 * ⚠ BARE NAMES ONLY, AND THAT RESTRICTION IS THE POINT. A value containing a path separator is
 * refused, so this can name a DIFFERENT BINARY ON PATH but cannot point at an arbitrary location.
 * That keeps the property that makes the allowlist meaningful: the app still executes something the
 * OS found on a PATH the user controls, not a file handed to it. Anyone who genuinely needs an
 * absolute path can symlink it onto their PATH, which leaves a visible artefact.
 */
const OVERRIDE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

let overrides: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Install the local rename overrides. Called once at boot with the parsed config file; values that
 * are not a bare name, or name an assistant this app does not ship, are dropped with a warning
 * rather than taken.
 *
 * @param raw assistant id → command name, as read from the user's config file
 * @returns the overrides actually accepted, for logging by the caller
 */
export function setAssistantCommandOverrides(raw: unknown): Readonly<Record<string, string>> {
  const accepted: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(COMMAND_FOR_ASSISTANT, id)) {
        console.warn(`[assistant-command] ignoring override for unknown assistant "${id}"`);
        continue;
      }
      if (typeof value !== "string" || !OVERRIDE_NAME.test(value)) {
        /**
         * The likely mistake is an absolute path, and saying so is more useful than "invalid":
         * someone who wrote /opt/claude/bin/claude needs to know a bare name is wanted, not that
         * their JSON was rejected.
         */
        console.warn(
          `[assistant-command] ignoring override for "${id}": must be a bare executable name ` +
            `(letters, digits, dot, underscore, hyphen) with no path separator`
        );
        continue;
      }
      accepted[id] = value;
    }
  }
  overrides = Object.freeze(accepted);
  return overrides;
}

/** The override for an assistant id, if one was accepted at boot. */
function overrideFor(assistantId: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(overrides, assistantId)
    ? overrides[assistantId]
    : undefined;
}

/**
 * The override for a shipped COMMAND (e.g. "claude"), for the `ai_command` read path, which stores
 * commands rather than assistant ids.
 */
function overrideForCommand(command: string): string | undefined {
  for (const [id, shipped] of Object.entries(COMMAND_FOR_ASSISTANT)) {
    if (shipped === command) return overrideFor(id);
  }
  return undefined;
}

/**
 * A possibly-renamed command mapped back to the SHIPPED one, for code that switches on identity.
 *
 * ⚠ THIS EXISTS BECAUSE THE FIRST VERSION OF THE RENAME OVERRIDE BROKE CODEX. `buildCliArgs`
 * switches on the command string to decide argv, and its default branch refuses to spawn — so
 * `codex_bedrock` matched no case and died with "Unsupported assistant command". The override had
 * changed WHAT RUNS without telling the code that decides HOW it is run.
 *
 * So anything choosing BEHAVIOUR must switch on this, and anything choosing the BINARY must use
 * `spawnCommandFor`. Conflating the two is what broke, and the two-function split is what stops it
 * happening again.
 */
export function canonicalCommand(command: unknown): string {
  if (typeof command !== "string") return DEFAULT_AI_COMMAND;
  const normalised = NORMALISED[command] ?? command;
  if (ALLOWED_AI_COMMANDS.has(normalised)) return normalised;
  /* A renamed binary: find which assistant claimed this name and answer with its shipped command. */
  for (const [id, renamed] of Object.entries(overrides)) {
    if (renamed === normalised) return COMMAND_FOR_ASSISTANT[id];
  }
  /**
   * Unknown, and deliberately returned UNCHANGED rather than defaulted. The caller's fail-closed
   * branch has to still see something it does not recognise — defaulting here would turn a poisoned
   * `ai_command` into a silent run of Claude, which is the opposite of what that branch is for.
   */
  return normalised;
}

/**
 * The binary to actually spawn for a shipped command — the local rename if one was accepted.
 *
 * ⚠ USE THIS AT EVERY SPAWN SITE. `buildCliArgs` used to return a hardcoded `{ cmd: "codex" }`, so
 * even once the switch matched it would have spawned the shipped name and ignored the override
 * entirely. That was the second half of the same bug.
 */
export function spawnCommandFor(shippedCommand: string): string {
  return overrideForCommand(shippedCommand) ?? shippedCommand;
}

/**
 * Settings that name something the app EXECUTES, and so must never be renderer-writable.
 *
 * Read by the boot invariant in setting-access.ts. Its whole purpose is to make re-adding one to
 * the write list a startup crash instead of a silent regression — the same treatment
 * `ALLOWLIST_SOURCE_SETTINGS` gets, for the same reason: this class of key is not a preference, and
 * it will look like one to whoever edits that list next.
 */
export const EXECUTABLE_SOURCE_SETTINGS: ReadonlySet<string> = new Set(["ai_command"]);
