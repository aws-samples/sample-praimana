// ── ⚠ THE ASSISTANT COULD NOT START AT ALL ON WINDOWS ─────────────────────────────────────────
//
// Every spawn in this app passes `shell: false` — a documented invariant, not a default. On Windows
// that is also fatal by itself: `claude` and `codex` are `.cmd` batch shims and CreateProcess CANNOT
// execute a batch file, so each spawn failed with ENOENT/EINVAL and no chat turn could begin.
//
// ⚠ THESE TESTS RUN THE REAL CODE, NOT A SIMULATION OF WINDOWS. `resolveWindowsCommand` uses
// `path.win32` explicitly rather than `path`, so the function under test here is byte-identical to the
// one that runs on Windows — where `path` IS `path.win32`. The filesystem is the only thing injected,
// through the `exists` seam, because "is there a file here" is the one fact a Mac cannot supply for a
// `C:\` path.
//
// The alternative — mocking `path` to behave like Windows — was rejected for the reason stated in
// project-paths.windows.test.ts: it tests a simulation written by the same person as the code.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertSafeForCmd,
  launchSpec,
  resolveWindowsCommand,
} from "./windows-launch";

/** A Windows environment, as the app would see it. */
const WIN_ENV: NodeJS.ProcessEnv = {
  PATH: ["C:\\Windows\\system32", "C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\tools"].join(";"),
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  COMSPEC: "C:\\Windows\\system32\\cmd.exe",
};

/** An `exists` seam that answers true for exactly these files. */
const only = (...files: string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe("resolving a command the way Windows does", () => {
  it("finds a .cmd shim on PATH and calls it a script", () => {
    // The npm case: `claude` is `claude.cmd`, which is why nothing worked.
    const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
    expect(resolveWindowsCommand("claude", WIN_ENV, only(shim))).toEqual({
      file: shim,
      kind: "script",
    });
  });

  it("finds a .exe and calls it a binary", () => {
    // The toolbox case, and the good one: no interpreter needed, so nothing to quote.
    const exe = "C:\\tools\\kiro-cli.exe";
    expect(resolveWindowsCommand("kiro-cli", WIN_ENV, only(exe))).toEqual({
      file: exe,
      kind: "binary",
    });
  });

  it("⚠ searches PATH IN ORDER, so the first match wins", () => {
    /**
     * Windows resolves left to right, and so must this: a `kiro-cli.exe` in system32 must beat one in
     * a user directory, or the app would run a different binary from the one the user's own shell does.
     */
    const first = "C:\\Windows\\system32\\kiro-cli.exe";
    const later = "C:\\tools\\kiro-cli.exe";
    expect(resolveWindowsCommand("kiro-cli", WIN_ENV, only(first, later))?.file).toBe(first);
  });

  it("⚠ prefers the PATHEXT order within one directory", () => {
    /**
     * `.COM;.EXE;.BAT;.CMD` — so a directory holding both `foo.exe` and `foo.cmd` yields the exe, which
     * is also the better outcome: the binary path needs no interpreter at all.
     */
    const dir = "C:\\tools\\";
    const resolved = resolveWindowsCommand("foo", WIN_ENV, only(`${dir}foo.cmd`, `${dir}foo.exe`));
    expect(resolved).toEqual({ file: "C:\\tools\\foo.exe", kind: "binary" });
  });

  it("honours a PATHEXT the user has customised", () => {
    // Read rather than hardcoded, because an unusual install is exactly when this has to work.
    const env = { ...WIN_ENV, PATHEXT: ".PS1;.EXE" };
    const resolved = resolveWindowsCommand("tool", env, only("C:\\tools\\tool.ps1"));
    // A `.ps1` needs an interpreter, so it is classified as a script rather than handed to CreateProcess.
    expect(resolved).toEqual({ file: "C:\\tools\\tool.ps1", kind: "script" });
  });

  it("treats a command containing a separator as a PATH, not a name", () => {
    // `resolveKiroCliPath` returns an absolute path; it must not be searched for inside PATH entries.
    const exe = "C:\\Program Files\\Kiro\\kiro-cli.exe";
    expect(resolveWindowsCommand(exe, WIN_ENV, only(exe))?.file).toBe(exe);
  });

  it("appends PATHEXT to an extensionless path too", () => {
    // `C:\tools\kiro-cli` should find `kiro-cli.exe`, as it would in a shell.
    const exe = "C:\\tools\\kiro-cli.exe";
    expect(resolveWindowsCommand("C:\\tools\\kiro-cli", WIN_ENV, only(exe))?.file).toBe(exe);
  });

  it("returns null when nothing is found", () => {
    expect(resolveWindowsCommand("claude", WIN_ENV, only())).toBeNull();
    expect(resolveWindowsCommand("", WIN_ENV, only())).toBeNull();
  });

  it("reads Path as well as PATH", () => {
    // Windows environment blocks are case-insensitive and Node preserves whichever casing was set.
    const env = { Path: "C:\\tools", PATHEXT: ".EXE" };
    expect(resolveWindowsCommand("x", env, only("C:\\tools\\x.exe"))?.file).toBe("C:\\tools\\x.exe");
  });
});

describe("what spawn is actually given", () => {
  it("⚠ IS THE IDENTITY FUNCTION off Windows", () => {
    /**
     * macOS and Linux need no help, and this app is mostly used on macOS: a change in that path would
     * be unrequested risk. Pinned so the Windows work cannot leak into it.
     */
    for (const platform of ["darwin", "linux"]) {
      expect(launchSpec("claude", ["-p", "--verbose"], WIN_ENV, platform)).toEqual({
        command: "claude",
        args: ["-p", "--verbose"],
      });
    }
  });

  it("runs a .exe DIRECTLY — no interpreter, nothing to quote", () => {
    /**
     * The good case, and the one that avoids the whole quoting question. Note the args are passed
     * THROUGH UNCHANGED: no wrapping, no verbatim flag, so Node quotes them as it always has.
     */
    const exe = "C:\\tools\\kiro-cli.exe";
    const spec = launchSpec("kiro-cli", ["chat", "--no-interactive"], WIN_ENV, "win32", only(exe));
    expect(spec).toEqual({ command: exe, args: ["chat", "--no-interactive"] });
    expect(spec.windowsVerbatimArguments).toBeUndefined();
  });

  it("⚠ wraps the WHOLE command line in an outer quote pair", () => {
    /**
     * ── ⚠ THIS TEST USED TO ASSERT THE VULNERABLE FORM, AND PASSED ─────────────────────────────
     *
     * It expected `args[3]` to be `"<shim>" "-p" "--verbose"` — with no outer pair. That is a
     * command-injection hole, and this test confirmed it as correct for a day.
     *
     * `/s` strips the FIRST and LAST quote of the string after `/c`. With no outer pair those are the
     * shim's OPENING quote and the last argument's CLOSING quote, which inverts the quote parity of
     * everything between: argument CONTENT ends up outside quotes, separator SPACES inside them. `&`
     * in any argument then runs a second command.
     *
     * The fix is what Node's own `shell: true` path does — verified against its source, not reasoned
     * about a second time:
     *
     *     args = ['/d', '/s', '/c', `"${command}"`];
     *
     * ⚠ THE LESSON IS THE TEST, NOT THE CODE. A test written from the same wrong belief as the
     * implementation cannot catch the bug; it pins it. What caught this was reading the reference
     * implementation.
     */
    const shim = "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd";
    const spec = launchSpec("claude", ["-p", "--verbose"], WIN_ENV, "win32", only(shim));

    expect(spec.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(spec.args.slice(0, 3), "AutoRun must be disabled").toEqual(["/d", "/s", "/c"]);
    expect(spec.args[3]).toBe(`""${shim}" "-p" "--verbose""`);
    expect(spec.windowsVerbatimArguments, "Node must not re-quote the line").toBe(true);
    expect(spec.args).toHaveLength(4);
  });

  it("⚠ the quote count is EVEN, which is what parity depends on", () => {
    /**
     * A structural check rather than a string comparison, because it states the property that was
     * violated: `/s` removes one quote from each end, so what remains must still be balanced. An odd
     * count means some argument's content is sitting outside quotes.
     */
    const shim = "C:\\tools\\claude.cmd";
    const line = launchSpec("claude", ["-p", "--model", "sonnet"], WIN_ENV, "win32", only(shim)).args[3];

    const quotes = (line.match(/"/g) ?? []).length;
    expect(quotes % 2, `unbalanced quotes in: ${line}`).toBe(0);
    // And after `/s` strips the outer pair, the remainder is still balanced.
    const afterStrip = line.slice(1, -1);
    expect(((afterStrip.match(/"/g) ?? []).length) % 2).toBe(0);
    expect(afterStrip.startsWith(`"${shim}"`), "the executable stays quoted").toBe(true);
  });

  it("keeps an argument containing a SPACE as one argument", () => {
    /**
     * The non-security half of the same defect: with parity inverted the separator spaces were quoted
     * and the content was not, so any argument containing a space was split in two. Today's argv is
     * space-free, so this "worked" by accident.
     */
    const shim = "C:\\Program Files\\Kiro\\kiro-cli.cmd";
    const spec = launchSpec(shim, ["chat", "--resume-id", "a b"], WIN_ENV, "win32", only(shim));
    expect(spec.args[3]).toBe(`""${shim}" "chat" "--resume-id" "a b""`);
  });

  it("REFUSES rather than escaping when a token cannot be represented", () => {
    // Fail closed, loudly. The alternative is guessing at cmd's escaping rules on an untested platform.
    const shim = "C:\\tools\\claude.cmd";
    expect(() => launchSpec("claude", ['say "hi"'], WIN_ENV, "win32", only(shim))).toThrow(/Windows/);
    expect(() => launchSpec("claude", ["%PATH%"], WIN_ENV, "win32", only(shim))).toThrow(/percent/);
  });

  it("falls back to the canonical interpreter when COMSPEC is unset", () => {
    // A bare "cmd.exe" would be resolved by the OS through PATH; the canonical absolute path cannot be
    // shadowed by a `cmd.exe` planted in a directory that happens to come first.
    const shim = "C:\\tools\\claude.cmd";
    const env = { ...WIN_ENV, COMSPEC: undefined } as NodeJS.ProcessEnv;
    expect(launchSpec("claude", [], env, "win32", only(shim)).command).toBe(
      "C:\\Windows\\System32\\cmd.exe"
    );
  });

  it("⚠ REFUSES a COMSPEC containing a space, because it would disarm /d", () => {
    /**
     * libuv prepends the image path to the verbatim command line, so a space in `COMSPEC` truncates
     * argv[0] there and cmd never reads `/d` as its first switch — silently restoring the AutoRun
     * execution that `/d` exists to suppress. Rejected rather than quoted: quotes inside
     * `lpApplicationName` are treated as part of the filename.
     */
    const shim = "C:\\tools\\claude.cmd";
    const env = { ...WIN_ENV, COMSPEC: "C:\\Program Files\\evil\\cmd.exe" };
    expect(launchSpec("claude", [], env, "win32", only(shim)).command).toBe(
      "C:\\Windows\\System32\\cmd.exe"
    );
  });

  it("refuses a COMSPEC that is relative, or not an executable", () => {
    const shim = "C:\\tools\\claude.cmd";
    for (const bad of ["cmd.exe", "..\\cmd.exe", "C:\\tools\\shell.bat", "C:\\tools\\cmd"]) {
      const env = { ...WIN_ENV, COMSPEC: bad };
      expect(launchSpec("claude", [], env, "win32", only(shim)).command, bad).toBe(
        "C:\\Windows\\System32\\cmd.exe"
      );
    }
  });

  it("honours a legitimate COMSPEC on an unusual install", () => {
    // %SystemRoot% is not always C:\Windows; a valid absolute .exe with no spaces is used as given.
    const shim = "C:\\tools\\claude.cmd";
    const env = { ...WIN_ENV, COMSPEC: "D:\\Windows\\System32\\cmd.exe" };
    expect(launchSpec("claude", [], env, "win32", only(shim)).command).toBe(
      "D:\\Windows\\System32\\cmd.exe"
    );
  });

  it("⚠ refuses PROSE in argv, and that path was already broken anyway", () => {
    /**
     * `runCliAgent` (handlers/framework.ts) is the one caller that puts prose in argv — the workshop's
     * setup instructions. This case used to assert that prose SURVIVED, which is what the permissive
     * character set existed for.
     *
     * ⚠ THE EXEMPTION WAS PROTECTING NOTHING. That prompt is built with `.join("\n")`, so it always
     * contains a newline, and `\n` was refused before this change and is refused now. The framework
     * install has therefore never worked on Windows with a `.cmd` shim — which makes the documented
     * "narrow limitation" a total outage, and is why tightening the set costs nothing.
     *
     * The real fix for that caller is to send its prompt on stdin like every other path. It is not done
     * here because it changes a working macOS path and cannot be tested from one — recorded as
     * outstanding rather than attempted blind.
     */
    const shim = "C:\\tools\\claude.cmd";
    const prose = "Set up the project (see README) & run the tests";
    expect(() => launchSpec("claude", ["--print", prose], WIN_ENV, "win32", only(shim))).toThrow();
    // Newline alone was always fatal, before and after — the exemption never applied.
    expect(() => assertSafeForCmd("line one\nline two", "arguments")).toThrow();
  });

  it("⚠ refuses the injection payload end to end", () => {
    /**
     * The reported vector, asserted at the level a reviewer cares about: a renderer-supplied model id
     * reaching `launchSpec`. Both layers now stop it — validation at the IPC boundary (model-id.ts) and
     * this one.
     */
    const shim = "C:\\tools\\claude.cmd";
    expect(() =>
      launchSpec("claude", ["-p", "--model", "sonnet & calc.exe"], WIN_ENV, "win32", only(shim))
    ).toThrow(/Windows/);
  });

  it("passes an unresolvable command straight through", () => {
    /**
     * ⚠ DELIBERATE: Node's own "ENOENT: claude" names the thing the participant configured and can
     * fix. Wrapping a non-existent command in cmd.exe would replace it with a complaint from the
     * interpreter about a command it could not find.
     */
    const spec = launchSpec("definitely-not-installed", ["--x"], WIN_ENV, "win32");
    expect(spec).toEqual({ command: "definitely-not-installed", args: ["--x"] });
  });
});

/**
 * The interpreter path, driven through the seam so the resolution is deterministic. `launchSpec` uses
 * the real filesystem, so these assert `assertSafeForCmd` and the command-line SHAPE directly — the
 * two things a Mac can check about it.
 */
describe("⚠ the interpreter path, where quoting matters", () => {
  it("refuses the characters that break cmd quoting", () => {
    // A double quote ends the quoted run; `^` escapes out of it; `%` expands before quoting applies.
    for (const bad of ['say "hi"', "a^b", "%PATH%", "line\r\n2", "nul\u0000here"]) {
      expect(() => assertSafeForCmd(bad, "arguments"), JSON.stringify(bad)).toThrow(/Windows/);
    }
  });

  it("⚠ REFUSES the command separators — this assertion used to be its own opposite", () => {
    /**
     * ── ⚠ THE TEST THAT CERTIFIED THE VULNERABILITY ────────────────────────────────────────────
     *
     * This case asserted that `&`, `|`, `<`, `>` and parentheses were ALLOWED, on the reasoning that
     * cmd treats them literally inside a double-quoted run. The premise was right and the construction
     * did not deliver it (see the outer-quote case above), so `--model "sonnet & calc.exe"` executed
     * `calc.exe` — and this test said that was fine.
     *
     * Both halves are fixed: the command line is balanced now, AND these characters are refused
     * anyway. Belt and braces on purpose, because the first half is a claim about cmd.exe's parsing
     * that this project cannot execute a test against, and the second is a claim about a string.
     */
    for (const dangerous of [
      "sonnet & calc.exe",
      "a | b",
      "1 < 2 > 0",
      "x && y",
      "(grouped)",
      "back^tick",
      'quote"inside',
      "%PATH%",
    ]) {
      expect(() => assertSafeForCmd(dangerous, "arguments"), dangerous).toThrow(/Windows/);
    }
  });

  it("still allows everything the app legitimately passes", () => {
    /**
     * The other side of the tightening, and the reason it is safe: every argument this app actually
     * builds is a flag, a model id, a UUID or a path. None contains a command separator. Checked with
     * the real values from `buildCliArgs`, `kiroTrustArg` and the ACP client.
     */
    for (const fine of [
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--model",
      "claude-sonnet-4-5-20250929",
      "amazon-nova-pro-v1:0",
      "--trust-tools=fs_read,fs_write,grep,glob,todo_list",
      "019ff11f-61fc-77d1-b1da-85cf2f51d7f5",
      "C:\\Program Files\\Kiro\\kiro-cli.cmd",
      "chat",
      "--no-interactive",
      "exec",
      "resume",
      "--skip-git-repo-check",
    ]) {
      expect(() => assertSafeForCmd(fine, "arguments"), fine).not.toThrow();
    }
  });

  it("names what was wrong in a way somebody can act on", () => {
    // A refusal with no next step gets reported as "the app is broken".
    expect(() => assertSafeForCmd('x"y', "install path")).toThrow(/install path/);
    expect(() => assertSafeForCmd('x"y', "install path")).toThrow(/\.exe/);
  });

  it("validates the install path as well as the arguments", () => {
    /**
     * Both, not one: the path is ours only in the sense that a user's installer chose it. Asserted
     * behaviourally — a shim whose own path holds a quote must be refused before anything is spawned.
     */
    const nasty = 'C:\\tools\\cl"aude.cmd';
    expect(() => launchSpec(nasty, ["-p"], WIN_ENV, "win32", only(nasty))).toThrow(/install path/);
  });

  it("⚠ never sets shell: true anywhere", () => {
    /**
     * The whole point of the two-tier design. `shell: true` would be a one-word fix that hands argv to
     * a shell to re-parse — the thing every spawn site in this app refuses — and it would read as
     * harmless on the platform most reviewers are using.
     */
    expect(readSource()).not.toMatch(/shell:\s*true/);
    expect(readSource("./spawn-confined.ts")).not.toMatch(/shell:\s*true/);
    expect(readSource("./spawn-confined.ts")).toContain("shell: false");
  });
});

describe("every assistant spawn goes through the wrapper", () => {
  it("no handler calls child_process.spawn directly any more", () => {
    /**
     * Counted across the handlers, because ONE missed site is an assistant that still cannot start on
     * Windows — and it would be the least-used one, found last. `profile.ts` is excluded: it spawns
     * `process.execPath`, which is Electron itself and an `.exe` on Windows.
     */
    for (const file of [
      "./handlers/cli-assistant.ts",
      "./handlers/framework.ts",
      "./handlers/kiro-models.ts",
      "./handlers/codex-models.ts",
    ]) {
      const code = readSource(file);
      expect(code, `${file} must not spawn directly`).not.toMatch(/[^a-zA-Z]spawn\(/);
      expect(code, `${file} must use the wrapper`).toMatch(/spawnPortable\(|spawnConfined\(/);
    }
  });

  it("the ACP client still goes through the CONFINED wrapper", () => {
    // Confinement and portability are separate concerns; the ACP path needs both.
    const acp = readSource("./handlers/kiro-acp.ts");
    expect(acp).toMatch(/spawnConfined\(kiroPath, args/);
    expect(readSource("./spawn-confined.ts")).toMatch(/return spawnPortable\(command, args/);
  });
});

function readSource(rel = "./windows-launch.ts"): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}
