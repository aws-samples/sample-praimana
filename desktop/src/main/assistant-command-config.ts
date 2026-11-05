import fs from "fs";
import path from "path";
import { setAssistantCommandOverrides } from "./assistant-command";

/**
 * ── LOCAL RENAME OVERRIDES FOR THE ASSISTANT BINARIES ─────────────────────────────────────────
 *
 * Reads `<userData>/assistant-commands.json`, whose whole job is to let a participant say "my
 * Claude is called something else":
 *
 *     { "claude": "claude_bedrock" }
 *
 * Keys are assistant ids — "claude", "kiro", "codex". Values are BARE EXECUTABLE NAMES, resolved on
 * the PATH the app already builds (assistant-path.ts). Validation and the reasoning live in
 * assistant-command.ts next to the allowlist they relax; this module only does the file read, so
 * that module can stay import-free.
 *
 * ⚠ ABSENT IS THE NORMAL CASE and is not an error. No file means the shipped names are used, which
 * is what happens on every install that did not rename anything.
 *
 * ⚠ THE FILE IS NOT CREATED FOR THE USER, on purpose. An empty template sitting in userData invites
 * editing by people who have no problem to solve, and a malformed one would then be a support
 * question on every install rather than only on the few that need it.
 */
const CONFIG_FILE = "assistant-commands.json";

/**
 * Load and install the overrides. Safe to call once at boot, before any handler can spawn.
 *
 * @param userDataDir `app.getPath("userData")` — passed in rather than imported so this stays
 *                    testable without an Electron app object.
 */
export function loadAssistantCommandOverrides(userDataDir: string): void {
  const file = path.join(userDataDir, CONFIG_FILE);

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    /* No file is the normal case. Nothing to log: this is not a degraded state. */
    setAssistantCommandOverrides({});
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    /**
     * ⚠ LOUD, BECAUSE THE FAILURE IS OTHERWISE INVISIBLE. Someone who wrote this file did so to fix
     * a broken launch; if their JSON has a trailing comma they would see the SAME ENOENT they were
     * trying to fix and conclude the feature does not work.
     */
    console.error(
      `[assistant-command] ${file} is not valid JSON, so the renames in it were NOT applied: ` +
        `${(err as Error).message}`
    );
    setAssistantCommandOverrides({});
    return;
  }

  const accepted = setAssistantCommandOverrides(parsed);
  const names = Object.entries(accepted);
  if (names.length > 0) {
    /* Recorded so a surprising binary in the audit trail can be traced back to this file. */
    console.log(
      `[assistant-command] local renames applied from ${CONFIG_FILE}: ` +
        names.map(([id, cmd]) => `${id} -> ${cmd}`).join(", ")
    );
  }
}
