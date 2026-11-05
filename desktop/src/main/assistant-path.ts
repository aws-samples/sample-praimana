import os from "os";
import path from "path";

/**
 * ── ⚠ THE PATH AN ASSISTANT AND ITS TOOLS ARE SPAWNED WITH ────────────────────────────────────
 *
 * It was telling the truth about an environment this app builds: `bun` installs to `~/.bun/bin`, which was in
 * none of the four hand-maintained copies of this list.
 *
 * ⚠ AN APP LAUNCHED FROM FINDER INHERITS NO SHELL PATH. `process.env.PATH` in a packaged build is
 * roughly `/usr/bin:/bin:/usr/sbin:/sbin` — Finder does not source `~/.zshrc`, and neither does the
 * non-interactive shell the agent runs its own commands in. So anything a participant installed into a
 * per-user directory is invisible unless it is named here. That is why this list exists at all, and why
 * it has to include the places tools actually go rather than only the places this app's own binaries go.
 *
 * ── ⚠ WHY ONE MODULE AND NOT FOUR COPIES ──
 *
 * There were four: cli-assistant.ts, kiro-acp.ts, claude-code.ts and framework.ts. claude-code.ts's own
 * comment says it is "Kept IDENTICAL to cli-assistant.ts's `spawnEnv` on purpose … two assistant paths
 * that resolve credentials differently would mean 'it works in one and not the other'". Exactly right,
 * and four copies is how that intention stops being true — `bun` had to be added in four places, so it
 * was added in none.
 *
 * ⚠ AND THREE OF THE FOUR JOINED WITH A LITERAL `":"`. framework.ts already fixed this and wrote down
 * why: "PATH entries are separated by `:` on POSIX and `;` on Windows; joining with `:` there produces
 * one nonsense entry rather than three real ones, so even a correct home directory would not have been
 * searched." That fix never reached the other three. `path.delimiter` is the answer, once.
 *
 * ⚠ THE APP'S OWN PATH GOES LAST, NOT FIRST. A participant's chosen install must win over whatever
 * Electron happened to inherit, and prepending is what makes `~/.toolbox/bin/claude` beat a stale copy
 * on the system path. Order within the prefix is preference order.
 */
function assistantPathEntries(): string[] {
  const home = os.homedir();
  return [
    /* Amazon-managed installs. First because that is where these binaries are on a corporate machine. */
    path.join(home, ".toolbox", "bin"),
    /* The conventional per-user bin for pip/pipx/npm-prefix installs. */
    path.join(home, ".local", "bin"),
    /**
     * ⚠ `~/.bun/bin` — THE REPORTED GAP. Bun's installer puts its shim here and adds it to the shell
     * profile, which a Finder-launched app never reads. A framework whose tooling runs through `bun`
     * is therefore invisible to the agent, and the failure surfaces as the agent apologising for the
     * environment rather than as anything a participant can act on.
     */
    path.join(home, ".bun", "bin"),
    /**
     * ⚠ `/opt/homebrew/bin` — MISSING FOR THE SAME REASON AND ON MORE MACHINES. It is the Homebrew
     * prefix on every Apple Silicon Mac, where `/usr/local/bin` (Intel's prefix, below) is usually
     * empty. claude-code.ts's own note says a participant's install may be "Homebrew or ~/.local
     * elsewhere", so the list named the Intel location and not the current one.
     */
    "/opt/homebrew/bin",
    /* Intel Homebrew and hand-built tools. Inert on Windows — a non-existent entry costs a lookup. */
    "/usr/local/bin",
  ];
}

/**
 * `PATH` for a spawned assistant, its agent, and any command that agent runs.
 *
 * @param inherited the PATH to fall back to, normally `process.env.PATH`.
 */
export function assistantPath(inherited: string | undefined = process.env.PATH): string {
  return [...assistantPathEntries(), inherited || "/usr/bin:/bin"].join(path.delimiter);
}
