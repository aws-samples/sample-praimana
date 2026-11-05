/**
 * ── ⚠ LAUNCHING A CLI ON WINDOWS WITHOUT A SHELL ──────────────────────────────────────────────
 *
 * Every spawn in this app passes `shell: false`, and that is a documented invariant rather than a
 * default: the prompt and the project path must never be able to become shell tokens. On Windows it is
 * also, by itself, fatal.
 *
 *     spawn("claude", args, { shell: false })   →   ENOENT / EINVAL
 *
 * `claude` on Windows is `claude.cmd`, a batch shim npm writes beside the real script, and CreateProcess
 * CANNOT execute a batch file. Only a command interpreter can. So the app's chat did not merely look
 * wrong on Windows — it could not start a turn at all, and the same is true of `codex` and `kiro-cli`.
 *
 * ── ⚠ WHY THIS IS NOT JUST `shell: true` ──
 *
 * Because that hands the whole argv to a shell for re-parsing, which is the thing every spawn site
 * here refuses to do. It would also be a silent widening: the code would still read `shell: false` on
 * the platform anyone reviewing it is likely to be using.
 *
 * ── THE TWO-TIER ANSWER ──
 *
 *   1. RESOLVE the command against PATH and PATHEXT ourselves.
 *   2. If the winner is a real executable (`.exe`, `.com`), spawn it DIRECTLY — no interpreter, no
 *      quoting, nothing to escape. This is the common case for `kiro-cli` shipped by the toolbox.
 *   3. Only a batch shim (`.cmd`, `.bat`) goes through `cmd.exe`, and then every token is validated
 *      and quoted, and anything unrepresentable is REFUSED rather than escaped.
 *
 * ⚠ WHAT MAKES (3) DEFENSIBLE IS THAT NO USER TEXT IS IN ARGV. Verified before writing this: the
 * participant's prompt reaches these CLIs on STDIN (`child.stdin?.write(params.message)`), never as an
 * argument. Argv carries our own flags, a model id from the CLI's own catalogue, and thread UUIDs the
 * CLI itself issued. If that ever changes, this file is where the assumption is written down.
 */

import path from "path";
import fs from "fs";

/** What `resolveWindowsCommand` found. */
export type WindowsExecutableKind =
  /** A real image CreateProcess can start: `.exe`, `.com`. Spawned directly. */
  | "binary"
  /** A batch shim: `.cmd`, `.bat`. Needs a command interpreter. */
  | "script";

export interface WindowsResolution {
  /** The file found, absolute where resolution succeeded. */
  file: string;
  kind: WindowsExecutableKind;
}

/** Extensions treated as directly executable, lowercase. */
const BINARY_EXTENSIONS = [".exe", ".com"];
/** Extensions that require an interpreter. */
const SCRIPT_EXTENSIONS = [".cmd", ".bat"];

/**
 * ⚠ CHARACTERS A TOKEN MAY NOT CONTAIN when it has to travel through `cmd.exe`.
 *
 * ── ⚠ THIS SET WAS WRONG, AND THE REASONING BEHIND IT WAS THE DANGEROUS PART ──
 *
 * It used to permit `&`, `|`, `<`, `>` and parentheses, on the stated grounds that cmd treats them
 * literally INSIDE A DOUBLE-QUOTED RUN. That premise is true. The conclusion did not follow, because
 * the command line this file built did not put them inside one — see the note at `launchSpec`. The
 * result was a command-injection hole: `--model "sonnet & calc.exe"` passed validation and executed
 * `calc.exe`. Found by a security review, not by a test, and it was live for a day.
 *
 * The lesson is recorded because it is the reusable part: a character-level allowlist is only as good
 * as the claim it rests on about the surrounding construction, and that claim has to be verified
 * against the reference implementation rather than reasoned from documentation.
 *
 * So the set is now everything cmd could treat as syntax, quoted or not:
 *
 *   "         ends the quoted run
 *   ^         cmd's escape character; smuggles a quote out of a quoted run
 *   %         expanded BEFORE quoting applies, so a variable whose VALUE holds a quote reaches the parser
 *   & | < > ( )   command separators, pipes, redirections and grouping
 *   CR LF NUL terminate or split the command line outright
 *
 * ⚠ NOTHING IS LOST BY TIGHTENING IT. The permissive set existed for `runCliAgent`, which passes the
 * workshop's setup instructions in argv — and that prompt is built with `.join("\n")`, so it ALWAYS
 * contains a newline and was always refused anyway. The exemption protected a path that never worked.
 * See the note on that caller in handlers/framework.ts.
 */
const CMD_FORBIDDEN = /["^%&|<>()\r\n\u0000]/;

/**
 * Find the file `command` names, using Windows' own rules.
 *
 * ⚠ `path.win32` EXPLICITLY, not `path`. That is what makes this function testable on a Mac: the code
 * that runs on Windows and the code under test are the same code, because on Windows `path` IS
 * `path.win32`. It also means the resolution logic can be read without wondering which platform it
 * assumes.
 *
 * @param command what the caller asked to run: a bare name (`claude`) or a path
 * @param env     the environment to read PATH and PATHEXT from
 * @param exists  seam for tests; defaults to a real filesystem check
 * @returns the resolution, or null when nothing was found — the caller then lets the OS produce the
 *          error, which names the command the user actually configured
 */
export function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile();  // nosemgrep: detect-non-literal-fs-filename
    } catch {
      return false;
    }
  }
): WindowsResolution | null {
  if (!command) return null;

  /**
   * PATHEXT is the list Windows itself consults, in order, and it is user-configurable — reading it
   * rather than hardcoding `.exe;.cmd` is what makes an unusual install work. The fallback is the
   * documented default for the entries this function cares about.
   */
  const pathext = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const classify = (file: string): WindowsResolution | null => {
    const ext = path.win32.extname(file).toLowerCase();
    if (BINARY_EXTENSIONS.includes(ext)) return { file, kind: "binary" };
    if (SCRIPT_EXTENSIONS.includes(ext)) return { file, kind: "script" };
    /**
     * An extension Windows would run by file association (`.ps1`, `.py`). Treated as a SCRIPT so it
     * goes through the interpreter path with its validation, rather than being handed to
     * CreateProcess, which would fail with a message about a bad image format.
     */
    if (ext) return { file, kind: "script" };
    return null;
  };

  /** A command containing a separator is a path, not a name to search for. */
  const looksLikePath = command.includes("\\") || command.includes("/") || /^[a-zA-Z]:/.test(command);

  const candidates: string[] = [];
  if (looksLikePath) {
    const asGiven = path.win32.resolve(command);
    // As given first: an explicit `foo.exe` must win over `foo.exe.cmd`.
    candidates.push(asGiven, ...pathext.map((ext) => asGiven + ext));
  } else {
    const dirs = (env.PATH || env.Path || "").split(";").filter(Boolean);
    for (const dir of dirs) {
      const base = path.win32.join(dir, command);
      candidates.push(base, ...pathext.map((ext) => base + ext));
    }
  }

  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const resolved = classify(candidate);
    if (resolved) return resolved;
    /**
     * Found, but with no extension at all — a Unix-style file copied onto Windows. CreateProcess can
     * still start it if it is a valid image, so it is offered as a binary rather than refused.
     */
    return { file: candidate, kind: "binary" };
  }
  return null;
}

/** Refuse a token that cannot travel through `cmd.exe` unambiguously. */
export function assertSafeForCmd(token: string, what: string): void {
  if (CMD_FORBIDDEN.test(token)) {
    throw new Error(
      `Cannot start the assistant on Windows: its ${what} contains a double quote, a caret or a ` +
        `percent sign, which cannot be passed through the command interpreter that a .cmd shim ` +
        `requires. This does not affect an assistant installed as a .exe.`
    );
  }
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /**
   * Set when the args are a pre-built command line that Node must NOT re-quote.
   *
   * Passed straight to `child_process.spawn`, and only ever true on the interpreter path.
   */
  windowsVerbatimArguments?: boolean;
}

/**
 * Translate a command and argv into what `spawn` should actually be given on this platform.
 *
 * On anything but Windows this is the identity function — today's behaviour, byte for byte, because
 * POSIX needs no help and a change there would be an unrequested risk on the platform this app is
 * mostly used on.
 */
export function launchSpec(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  /**
   * Filesystem seam, defaulted to the real one.
   *
   * ⚠ EXPOSED SO BOTH BRANCHES ARE TESTABLE FROM ANY PLATFORM. Without it the only checkable things
   * about the interpreter path are the shapes of its strings, and the first version of its test
   * asserted the fallback while claiming to cover the `.exe` case — passing, and proving nothing.
   * "Is there a file at C:\tools\claude.cmd" is the one fact a Mac cannot supply; everything else
   * here is the same code that runs on Windows.
   */
  exists?: (p: string) => boolean
): LaunchSpec {
  if (platform !== "win32") return { command, args };

  const resolved = exists
    ? resolveWindowsCommand(command, env, exists)
    : resolveWindowsCommand(command, env);

  /**
   * ⚠ NOT FOUND: PASS IT THROUGH UNCHANGED. Inventing an interpreter invocation for a command that
   * does not exist would replace Node's "ENOENT: claude" — which names the thing the participant
   * configured and can fix — with a failure from cmd.exe about a command it could not find. The
   * clearer error is the one that survives.
   */
  if (!resolved) return { command, args };

  // A real image: no interpreter, no quoting, nothing to get wrong.
  if (resolved.kind === "binary") return { command: resolved.file, args };

  // A batch shim. Everything from here is validated, then quoted.
  assertSafeForCmd(resolved.file, "install path");
  for (const arg of args) assertSafeForCmd(arg, "arguments");

  const inner = [resolved.file, ...args].map((token) => `"${token}"`).join(" ");

  /**
   * ── ⚠ THE OUTER QUOTE PAIR IS LOAD-BEARING, AND OMITTING IT WAS A COMMAND-INJECTION HOLE ──────
   *
   * `/s` strips the FIRST and LAST quote character of the string after `/c` and uses the rest as-is.
   * Without an outer pair, the two it strips are the executable's OPENING quote and the final
   * argument's CLOSING quote — which inverts the quote parity of everything between them:
   *
   *   built without the pair:  cmd /d /s /c "C:\…\claude.cmd" "-p" "--model" "sonnet & calc.exe"
   *   what cmd then parses:      C:\…\claude.cmd" "-p" "--model" "sonnet & calc.exe
   *                              ^^^^^^^^^^^^^^^^^ outside quotes   ^^^^^^^^^^^^^^^^ outside quotes
   *
   * Every argument's CONTENT ends up outside quotes and every separator SPACE inside them, so `&`
   * runs a second command. It also split any argument containing a space into two, which "worked"
   * only because today's argv happens to be space-free.
   *
   * ⚠ VERIFIED AGAINST NODE'S OWN IMPLEMENTATION rather than reasoned about again. Node's `shell: true`
   * path builds exactly this:
   *
   *     args = ['/d', '/s', '/c', `"${command}"`];
   *     windowsVerbatimArguments = true;
   *
   * With the pair present, `/s` strips a BALANCED pair and the inner quoting survives intact — which is
   * the arrangement the character set above was always documented as relying on.
   */
  const commandLine = `"${inner}"`;

  return {
    /**
     * ⚠ `/d` DISABLES AutoRun. Windows lets a user (or anything that can write their registry) set
     * `HKCU\\Software\\Microsoft\\Command Processor\\AutoRun`, which cmd.exe executes before the
     * command it was given — so without `/d` every assistant launch would first run whatever that key
     * says.
     *
     * ⚠ AND `/d` IS ONLY READ IF argv[0] PARSES AS ONE TOKEN. libuv prepends the image path to the
     * verbatim command line, so a `COMSPEC` containing a space would truncate argv[0] at that space
     * and cmd would never see `/d` as its first switch — silently restoring AutoRun. Hence the
     * validation in `commandInterpreter`.
     */
    command: commandInterpreter(env),
    args: ["/d", "/s", "/c", commandLine],
    /**
     * The command line is already correctly quoted; letting Node quote it again would produce
     * `""C:\\…\\claude.cmd""` and cmd would look for a program called `C:\\…\\claude.cmd" "-p`.
     */
    windowsVerbatimArguments: true,
  };
}

/**
 * The command interpreter to run, from `COMSPEC` when it is usable.
 *
 * ⚠ `COMSPEC` IS THE ONE TOKEN HERE THAT NEVER PASSES `assertSafeForCmd`, because it is the image path
 * rather than part of the command line — libuv passes it as `lpApplicationName`, so it cannot be
 * redirected by injection (a bogus path simply fails to start). What it CAN do is contain a space, and
 * because the command line is emitted verbatim with the image path prepended, that truncates argv[0]
 * and `/d` stops being the first switch. AutoRun then runs on every assistant launch — defeating the
 * mitigation `/d` exists for.
 *
 * ⚠ REJECTED RATHER THAN QUOTED. Quoting it would put quotes inside `lpApplicationName`, which Windows
 * treats as part of the filename. The canonical path is derived from `%SystemRoot%` instead, so an
 * unusual-but-legitimate Windows install still works and an anomalous `COMSPEC` cannot disarm `/d`.
 */
function commandInterpreter(env: NodeJS.ProcessEnv): string {
  const canonical = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const configured = env.COMSPEC;
  if (!configured) return canonical;

  const usable =
    !/\s/.test(configured) &&
    !CMD_FORBIDDEN.test(configured) &&
    /\.(exe|com)$/i.test(configured) &&
    path.win32.isAbsolute(configured);

  return usable ? configured : canonical;
}
