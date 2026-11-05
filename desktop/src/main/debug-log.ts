// Debug-gated logging (EA-L1). The process handlers (cli-assistant, claude-code,
// kiro-acp) emit verbose diagnostics — streamed I/O, data slices, spawned
// commands — that are noise in normal use and can disclose file paths, prompt
// content, or command arguments to the console/log. Route those through
// `debugLog` so they are silent unless debugging is explicitly enabled.
//
// Genuine failures (console.error / console.warn) are NOT gated — they should
// always surface.
//
// Enabled when running the dev build (NODE_ENV=development) or when the
// operator opts in with DESKTOP_DEBUG (1/true/yes) — and NEVER in a packaged
// build, whatever the environment says. See `isPackagedBuild` below.
import { app } from "electron";

/**
 * ── ⚠ THE HARD GATE: A PACKAGED BUILD NEVER LOGS THIS, WHATEVER THE ENVIRONMENT SAYS ──────────
 *
 * This module decided purely from `NODE_ENV` / `DESKTOP_DEBUG` / `DESKTOP_DEBUG_SCOPES`, which is exactly the
 * pattern `runtime-mode.ts` was written to eliminate and states the argument for:
 *
 *   "An environment variable is not a property of the build; it is a text field any local process
 *    can set. `launchctl setenv NODE_ENV development` needs no privilege, is inherited by anything
 *    launched from the Dock."
 *
 * So on a shipped, signed, notarized build an unprivileged local process could turn app-wide verbose
 * logging on for every subsequent launch — and this module's own header lists what that discloses:
 * spawned command lines, the project cwd, Claude settings sources, streamed agent I/O.
 *
 * ⚠ THE MARGINAL DISCLOSURE IS SMALLER THAN IT FIRST LOOKS, and saying so is not an argument against
 * the fix. `console.log` goes to this process's stdout, so an attacker must also be able to observe
 * that stream — and a same-user attacker can already read the profile's SQLite database, which holds
 * the prompts. What is NOT persisted anywhere is the argv, the resolved settings sources and the
 * streamed output, and this is a one-line deviation from a rule the codebase states elsewhere.
 *
 * ⚠ `app?.isPackaged`, WITH THE OPTIONAL CHAIN, AND IT IS LOAD-BEARING. Outside an Electron runtime
 * — vitest importing this module, or any tooling that does — the `electron` package resolves to a
 * stub whose `app` is `undefined`. That is the correct reading of "not a packaged build", and
 * without the optional access every test that touches `debugLog` would throw on import.
 *
 * ⚠ READ AT CALL TIME, not frozen at module load, for the same reason `isDevRuntime()` is: a constant
 * would freeze the decision before a test can drive it. The ENVIRONMENT half stays frozen — flags do
 * not change mid-run, and re-reading them per line is work with no reader.
 */
function isPackagedBuild(): boolean {
  return app?.isPackaged === true;
}

function isDebugEnabled(): boolean {
  if (process.env.NODE_ENV === "development") return true;
  const flag = (process.env.DESKTOP_DEBUG || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

// Evaluated once at module load — flags don't change mid-run.
const envOptIn = isDebugEnabled();

/** Whether verbose diagnostics may be emitted at all. */
function enabled(): boolean {
  return !isPackagedBuild() && envOptIn;
}

/**
 * ── ⚠ SILENCING PART OF THE OUTPUT WITHOUT LOSING IT ──
 *
 * ⚠ THOSE LINES WERE ALREADY GATED. They print because `vite-plugin-electron` sets `NODE_ENV=development`, so
 * the gate above is open by design during `pnpm dev` — which is the only way this app is currently run. The
 * fix is therefore not a new gate; it is a FINER one.
 *
 * ── WHY SCOPES RATHER THAN DELETING THE CALLS ──
 *
 * Each of these lines was added to answer a question that was genuinely hard at the time. The `[claude-code]`
 * block in particular is the whole diagnosis for "Not logged in · Please run /login" and for the
 * `AWS_REGION: us-west-2` mismatch — both took several rounds to find, and both were found BY these lines.
 * Deleting them would make the next occurrence of either as expensive as the first.
 *
 * So each area is silenced independently, and the default silences exactly the two reported as noise.
 *
 * ── HOW TO USE IT ──
 *
 *     DESKTOP_DEBUG_SCOPES=all           every area (the previous behaviour)
 *     DESKTOP_DEBUG_SCOPES=claude-code   just that one, e.g. when a login problem returns
 *     DESKTOP_DEBUG_SCOPES=none          silence everything
 *     (unset)                            DEFAULT_SCOPES below
 */
export type DebugScope =
  | "kiro-acp"
  | "claude-code"
  | "claude-settings"
  | "file-watch"
  | "cli-assistant"
  /**
   * Pushing a finished turn to the platform.
   *
   * Added with the sync-payload trimmer: an over-long assistant reply is shortened before it is sent,
   * because the AI service REJECTS anything over its ceiling and the turn was previously not recorded
   * at all. When a facilitator asks why a long turn looks shortened in the portal, the line saying
   * what was trimmed and by how much is the answer — and it has to be silenceable like the rest.
   */
  | "cli-sync"
  /**
   * ⚠ NO `pty` SCOPE. It controlled `handlers/pty.ts`, which is gone with the embedded terminal — and a
   * scope whose call sites no longer exist is a control that silences nothing while looking like one.
   * `debug-log.test.ts` walks every `debugLog` in main and FAILS on a dead name, which is how this was
   * caught the moment the handler was deleted.
   */
  /**
   * The theme mode, and what it resolves to.
   *
   * ⚠ EVENT-DRIVEN, SO IT IS ON BY DEFAULT. It emits when the OS flips light/dark (macOS does this on a
   * schedule) or when the participant changes the setting — and "why did the app go light overnight?" is a
   * question only this line answers. Silent otherwise.
   */
  | "theme"
  | "telemetry"
  // Session renewal. Added when the desktop began refreshing its own token: a deferred renewal
  // is the one thing an operator needs to see when someone reports "it signed me out on the
  // train", and it must be silenceable like every other scope.
  | "auth"
  /**
   * The background reconciliation of unsynced turns (backlog 8f).
   *
   * ⚠ ON BY DEFAULT, unlike the two startup scopes. It is the only record that an UNATTENDED action
   * happened: "recovered 4/7, 3 still unsynced" is the answer to "why did my transcript fill in by
   * itself?" and, more importantly, to "why is it STILL incomplete?". It is event-driven and silent
   * when nothing is owed, so it costs nothing on the normal path.
   */
  | "sync-sweep"
  /**
   * The real-time team event socket, and specifically the frames it DROPS.
   *
   * ⚠ ON BY DEFAULT, and it emits nothing on the normal path — a frame is only logged when it names a
   * team the app is no longer on. Added with the fix for stale-tenant event delivery (AWS Security
   * Agent): the socket is bound to the team it was started for, so a tenant change used to leave it
   * delivering the previous team's activity while the new team got nothing at all.
   *
   * ⚠ IT IS THE ONLY EVIDENCE OF THE BACKSTOP FIRING. If frames are being dropped in steady state,
   * something upstream is wrong — the re-bind failed, or the server is still pushing for a team this
   * user has been removed from — and that is precisely the case where a silent filter looks identical
   * to a broken feature ("my teammates' messages stopped appearing"). One line names the cause.
   */
  | "team-events"
  /**
   * Fetching Codex's model catalogue from `codex app-server`.
   *
   * ⚠ NOT ON BY DEFAULT, because it is a STARTUP-shaped diagnostic like `claude-code`: it fires when a chat
   * opens, the answer is cached for ten minutes, and the only line it emits is a failure. When the picker is
   * missing this is the scope that says why — a CLI too old to know `model/list`, or a timeout — and until
   * then it has nothing to add on every launch.
   */
  | "codex-models"
  /**
   * Fetching Kiro's model catalogue from `kiro-cli chat --list-models`.
   *
   * ⚠ NOT ON BY DEFAULT, for exactly the reasons given for `codex-models` above — it fires when a chat opens,
   * the answer is cached, and the only line it emits is a failure.
   *
   * ⚠ AND IT EARNS ITS OWN SCOPE RATHER THAN SHARING `codex-models`, because the two fail for different
   * reasons and a shared name would make the distinction unsayable. Kiro's call is MEASURED at 3–5 seconds
   * against a service, so a timeout here means something quite different from a Codex timeout against a local
   * app-server: when the Kiro picker is missing, this scope says whether the CLI was too old for the flag or
   * whether the network was simply slow.
   */
  | "kiro-models"
  /**
   * Which platform — which "experience" — this profile belongs to.
   *
   * ⚠ ON BY DEFAULT, unlike the two model-catalogue scopes, because its lines mark IRREVERSIBLE-LOOKING
   * moments rather than routine ones: a profile adopting the experience seeded by the window that created it,
   * and a seed being refused as unusable. Both are silent in the UI and both change which API the app talks
   * to, so "why is this profile pointed at that platform?" must be answerable after the fact.
   *
   * It is event-driven and says nothing on an ordinary launch — a seed exists only on a profile's FIRST run.
   */
  | "platform"
  /**
   * Failures of the local security audit log — a write refused, an unreadable existing file, a
   * rotation that did not complete.
   *
   * ⚠ ON BY DEFAULT, and it is the quietest scope here: the log is best-effort by design (an audit
   * write must never fail the sign-in it is recording), so these lines are the ONLY sign that a
   * security event went unrecorded. Silent by default would mean a gap in the trail with no
   * explanation for it anywhere.
   */
  | "security-audit"
  /**
   * Git reads that degraded rather than failed — currently the document walk behind
   * `git:listUploadable`.
   *
   * ⚠ ON BY DEFAULT, and event-driven: it says nothing unless a walk actually failed, and when one
   * does this is the only trace. That handler returns an EMPTY LIST rather than an error, on purpose,
   * so without a line here "no documents found" and "the walk broke" look identical to everyone
   * including whoever is asked to explain it.
   */
  | "git";

/**
 * ⚠ DERIVED FROM THE PREFIXES ACTUALLY IN USE, not invented. My first version got this wrong in both
 * directions: it omitted `claude-settings` (so that line would have printed regardless) and it invented `sync`
 * and `settings`, which NO call site emits — dead names that would silence nothing while looking like controls.
 * Found by enumerating the prefixes rather than by reading the handlers.
 *
 * The counts, for scale: kiro-acp 14, claude-code 13, cli-assistant 10, telemetry 1, claude-settings 1.
 * A test walks every `debugLog` in the main process so this list and the code cannot drift — and it earned
 * its keep when `pty` (5 sites) was removed with the embedded terminal: the suite failed on the now-dead
 * scope rather than leaving a control that silences nothing.
 */
const ALL_SCOPES: DebugScope[] = [
  "kiro-acp",
  "claude-code",
  "claude-settings",
  "cli-assistant",
  /** Pushing a finished turn to the platform, including what the sync trimmer shortened. */
  "cli-sync",
  /** Editor tabs watching their file for outside writes — see file-watch.ts. */
  "file-watch",
  "theme",
  "telemetry",
  "auth",
  "sync-sweep",
  "team-events",
  "codex-models",
  "kiro-models",
  "platform",
  "security-audit",
  "git",
];

/**
 * Areas that log by default when debugging is on.
 *
 * ⚠ `kiro-acp` AND `claude-code` ARE ABSENT DELIBERATELY — they are the two noisiest, and between them
 * they hold 30 of the 52 `debugLog` call sites in the main process. Both are STARTUP diagnostics: which binary
 * was spawned, which settings files were found, which region resolved. Useful exactly once per problem, and
 * noise on every launch after that.
 *
 * The rest stay on because they fire in response to an EVENT rather than on every launch — a sync failure, a
 * settings contradiction — so they are already quiet until something happens.
 */
const DEFAULT_SCOPES: DebugScope[] = [
  "cli-assistant",
  "claude-settings",
  "theme",
  "telemetry",
  // See the scope's own note: the only trace of work done without the user asking.
  "sync-sweep",
  /**
   * Also event-driven, and for the same reason as `sync-sweep`: it records a change made without the user
   * asking — a new profile silently adopting the experience the window that created it was pointed at. Since
   * that decides which API the profile talks to, it must be answerable after the fact.
   */
  "platform",
  // See the scope's own note: the only sign that a security event went unrecorded.
  "security-audit",
  // See the scope's own note: silent unless a frame was dropped, which is never normal.
  "team-events",
  // Silent unless a read degraded — see the scope's own note.
  "git",
];

function resolveScopes(): Set<DebugScope> {
  const raw = (process.env.DESKTOP_DEBUG_SCOPES || "").trim().toLowerCase();
  if (!raw) return new Set(DEFAULT_SCOPES);
  if (raw === "all") return new Set(ALL_SCOPES);
  if (raw === "none") return new Set();
  const wanted = raw.split(/[,\s]+/).filter(Boolean);
  /**
   * Intersected with the known list, so a TYPO ENABLES NOTHING rather than disabling everything. Writing
   * `DESKTOP_DEBUG_SCOPES=claude_code` should leave you wondering why your area is quiet, not silently mute the
   * five areas that were on by default.
   */
  return new Set(ALL_SCOPES.filter((s) => wanted.includes(s)));
}

const activeScopes = resolveScopes();

/** Verbose diagnostic log. No-op unless debug logging is enabled AND the message's area is active. */
export function debugLog(...args: unknown[]): void {
  if (!enabled()) return;
  /**
   * ⚠ THE SCOPE IS READ FROM THE MESSAGE'S OWN `[prefix]`, not passed as a new argument.
   *
   * All 52 existing calls already begin with `"[kiro-acp] …"` or `"[claude-code] …"` — that convention is why
   * the reported output is readable at all. Deriving the scope from it means NO call site changes, so this
   * cannot introduce a bug inside a handler while trying to quieten it.
   *
   * A line with no recognised prefix always prints. That is the safe default: an ungated line is noise, but a
   * silently swallowed one is a diagnostic that no longer exists.
   */
  const first = args[0];
  if (typeof first === "string") {
    const match = first.match(/^\[([a-z-]+)\]/);
    const scope = match?.[1] as DebugScope | undefined;
    if (scope && ALL_SCOPES.includes(scope) && !activeScopes.has(scope)) return;
  }
  console.log(...args);
}

/**
 * Whether an area would log.
 *
 * For call sites that BUILD an expensive diagnostic before logging it — assembling a settings dump, joining a
 * list of paths — so the work is skipped rather than done and discarded.
 */
export function debugEnabledFor(scope: DebugScope): boolean {
  return enabled() && activeScopes.has(scope);
}
