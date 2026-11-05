import { spawn, ChildProcess, SpawnOptions } from "child_process";
import path from "path";
import { launchSpec } from "./windows-launch";
import { isRealPathWithinProject } from "./project-paths";

// Shared primitive for process-spawning handlers (EA-H4 / EA-#4).
//
// ── ⚠ IT SAID "MANDATORY", AND IT IS STILL NOT ENFORCED — BUT THE AGENTS ARE ROUTED NOW ──
//
// This used to list FIVE bypassing `spawn` sites. The two that mattered are gone: the AWS Security
// Agent named `cli-assistant.ts`'s Claude and Codex/Kiro-CLI spawns in the privileged-access finding,
// because those launch an AGENT in the participant's project — so a cwd that was never
// real-path-checked was the one place it could matter most. Both call `spawnConfined` now.
//
// Three remain, and the reason is narrower than it was: `framework.ts` (the setup agent) plus
// `kiro-models.ts` and `codex-models.ts` (two `--list-models` probes). All three pass `shell: false`
// by hand. Routing them is worth doing with the paths exercised rather than blind — the probes in
// particular do not run in a project directory at all, so `confineCwd` would refuse them as written.
//
// "Mandatory" was a claim this module cannot make about callers that never call it, and an invariant
// asserted in a comment is how the NEXT spawn site forgets it. Stated accurately instead, with the
// list, so the gap stays visible.
//
// Two security invariants enforced in ONE place so no handler can forget them:
//   1. shell: false           — args are argv elements, never shell-interpreted,
//                               so metacharacters in paths/prompts can't inject.
//   2. cwd confinement         — the working directory must be inside an opened
//                               project root; otherwise we fall back to $HOME
//                               rather than launching in a renderer-supplied
//                               arbitrary directory.
//
// Callers pass a fixed command + argv array. Prompts/user input must be passed
// as argv elements or via stdin — never concatenated into the command.

export interface ConfinedSpawnOptions {
  /** Requested working directory (renderer-supplied); confined before use. */
  cwd: string;
  /** Environment for the child. */
  env?: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
}

/**
 * Resolve a safe cwd: the requested dir if it's inside a project. Otherwise it REFUSES.
 *
 * ⚠ REAL-PATH CHECKED, NOT LEXICAL. This used to call `isWithinProject`, which compares strings:
 * a symlink inside an open project pointing at `/etc` or `~/Library` passed it, and every agent
 * spawned through here then ran with its working directory OUTSIDE the project. That is the same
 * blind spot `file-ops.ts` documents, on the one function every spawning handler routes through —
 * so it was the widest instance of it rather than the narrowest.
 *
 * `mustExist: true` because a cwd that does not exist is not a cwd — `spawn` would fail with ENOENT
 * anyway, so it belongs with every other unusable value.
 *
 * ── ⚠ IT NO LONGER FALLS BACK TO `$HOME`, AND THE OLD COMMENT HAD THIS BACKWARDS ──
 *
 * The previous version returned `os.homedir()` for anything unusable and called that "the
 * conservative answer". It is the maximally permissive one. `project-paths.ts` refuses `$HOME` as a
 * project root in the first place, in its own words, because "a project root that wide hands every
 * file handler the user's credentials" — and this function then handed exactly that directory to a
 * spawned agent as its working directory whenever the requested cwd was unusable.
 *
 * That mattered here more than anywhere: the one caller pre-approves its agent's FILE tools
 * (kiro-trust.ts), and the approve/deny answer for everything else comes FROM THE RENDERER — so a
 * compromised renderer could pass a nonexistent path, land the agent in `$HOME`, and read and write
 * `~/.ssh` and `~/.aws` without a single prompt, since file work is exactly what is pre-approved.
 *
 * So it throws. The only caller (`KiroAcpClient.start`) is already inside a handler that catches and
 * returns `{ error }`, so a refusal surfaces as a message rather than a crash — and "no usable
 * project directory" is a true statement the user can act on, where a silent redirect to `$HOME` was
 * not.
 */
export function confineCwd(requested: string | undefined | null): string {
  if (requested && isRealPathWithinProject(requested, { mustExist: true })) {
    // ⚠ THE NORMALISED PATH, NOT THE CALLER'S SPELLING. The predicate above decides on
    // `path.resolve(requested)`, which collapses `..` LEXICALLY, while the kernel applies it AFTER
    // following a symlink. Handing the raw string to `spawn` as the cwd is the "verify one path, act
    // on another" divergence: `<root>/link/..` passes the check and starts the agent outside the root.
    return path.resolve(requested);  // nosemgrep: path-join-resolve-traversal
  }
  throw new Error(
    "Cannot start here: the working directory is not inside an open project folder. " +
      "Open the project again, or pick a different folder."
  );
}

/**
 * Spawn a child process with the security invariants enforced. `command` and
 * `args` must be fixed/validated by the caller; they are never shell-parsed.
 */
export function spawnConfined(
  command: string,
  args: string[],
  options: ConfinedSpawnOptions
): ChildProcess {
  const cwd = confineCwd(options.cwd);
  return spawnPortable(command, args, {
    cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
  });
}

/**
 * ── ⚠ THE ONE PLACE A CLI IS ACTUALLY STARTED ─────────────────────────────────────────────────
 *
 * `shell: false` is an invariant of this app and also, on Windows, fatal on its own: `claude` and
 * `codex` are `.cmd` batch shims there and CreateProcess cannot execute a batch file, so every spawn
 * failed with ENOENT/EINVAL and the chat could not start a single turn.
 *
 * `launchSpec` (windows-launch.ts) resolves the command through PATH and PATHEXT and returns either a
 * real executable to run directly — the common case, and no quoting is involved — or a validated
 * `cmd.exe /d /s /c` invocation for a batch shim. On macOS and Linux it is the identity function, so
 * those platforms keep today's behaviour byte for byte.
 *
 * ⚠ `shell` IS STILL FALSE HERE, in every branch. The interpreter, where one is needed, is an explicit
 * argv we built and validated ourselves — not a shell handed the caller's arguments to re-parse. That
 * distinction is the whole reason this is not `shell: true`.
 */
export function spawnPortable(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: ConfinedSpawnOptions["stdio"] } = {}
): ChildProcess {
  const spec = launchSpec(command, args, options.env ?? process.env);
  return spawn(spec.command, spec.args, {  // nosemgrep: detect-child-process
    ...(options.cwd ? { cwd: options.cwd } : {}),
    shell: false, // invariant: never route argv through a shell
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
    ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}
