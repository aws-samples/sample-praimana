// ── ⚠ THE FILESYSTEM BOUNDARY ON WINDOWS ──────────────────────────────────────────────────────
//
// Two defects, both invisible on macOS:
//
//   1. EVERY CONTAINMENT COMPARISON WAS CASE-SENSITIVE. `C:\Users\me\Downloads` and
//      `c:\users\me\downloads` are the same directory on Windows and NTFS stores whichever casing
//      created it — so one directory got two different answers depending on spelling.
//   2. BOTH DENYLISTS HELD ONLY POSIX PATHS. `"/etc"`, `"/usr"`, `"/"` match nothing on Windows, so
//      the excluded-areas test excluded nothing and `C:\Windows\System32` or `C:\` was accepted as a
//      project root — after which every file, git and spawn handler treated that tree as "inside the
//      project".
//
// ⚠ THE TWO FAIL IN OPPOSITE DIRECTIONS, which is why (1) is not merely cosmetic. On the containment
// path a casing mismatch refuses a legitimate file — annoying and visible. On the DENYLIST it fails to
// match, so a root the module exists to refuse is accepted. Fail-open.
//
// ── HOW THIS FILE IS SPLIT, AND WHY ──
//
// `project-paths.ts` uses `path`, which on macOS is `path.posix`. A Windows path STRING therefore
// cannot be exercised here at all — `path.resolve("C:\\Windows")` on macOS yields
// `<cwd>/C:\Windows`, a relative filename. So:
//
//   · the CASE-FOLDING is tested everywhere, using POSIX-shaped paths and a mocked platform. The fold
//     is the logic; the path shape is incidental to it.
//   · the Windows path SHAPES are gated to win32 and run in the build pipeline. They are reported as
//     skipped here rather than silently absent, so the gap is visible in every local run.
//
// Asserting Windows behaviour by mocking `path.win32` was considered and rejected: it would test a
// simulation of Windows written by the same person who wrote the code, and pass whether or not the
// real thing works.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Re-import `project-paths` with `process.platform` reported as `platform`. */
async function importForPlatform(platform: string) {
  vi.resetModules();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    // Only the project root matters for these cases; the settings read is stubbed.
    vi.doMock("./database", () => ({
      readSetting: (key: string) => (key === "project_path" ? path.join(os.homedir(), "proj") : null),
      getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }),
    }));
    return await import("./project-paths");
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./database");
});

describe("⚠ case folding — the denylist must not be escapable by re-spelling a path", () => {
  const home = path.resolve(os.homedir());
  /** A too-broad root, spelled in a case the denylist does not use. */
  const differentlyCased = path.join(home.toUpperCase(), "Downloads");

  it("refuses a differently-cased forbidden root when the platform is win32", async () => {
    /**
     * The bug, stated as a test. `~/Downloads` is on `TOO_BROAD`; without folding, the upper-cased
     * spelling misses every entry and `isForbiddenProjectRoot` returns FALSE — accepting a root the
     * module exists to refuse.
     */
    const { isForbiddenProjectRoot } = await importForPlatform("win32");
    expect(isForbiddenProjectRoot(differentlyCased), differentlyCased).toBe(true);
  });

  it("still refuses the exactly-cased one, on every platform", async () => {
    // The fold must not be the only thing making the denylist work.
    for (const platform of ["win32", "darwin", "linux"]) {
      const { isForbiddenProjectRoot } = await importForPlatform(platform);
      expect(isForbiddenProjectRoot(path.join(home, "Downloads")), platform).toBe(true);
    }
  });

  it("⚠ does NOT fold on darwin or linux, where two casings can be two directories", async () => {
    /**
     * Deliberate asymmetry. APFS can be formatted case-sensitive and Linux always is, so folding
     * there would MERGE two genuinely distinct directories — converting a fail-closed check into a
     * fail-open one on the platforms this app mostly runs on.
     *
     * ⚠ SO THIS CASE ASSERTS THE UPPER-CASED PATH IS *NOT* FORBIDDEN THERE, which reads backwards
     * until you notice it is a DIFFERENT PATH on those systems — one that exists nowhere and is
     * therefore no more sensitive than any other non-existent directory.
     */
    for (const platform of ["darwin", "linux"]) {
      const { isForbiddenProjectRoot } = await importForPlatform(platform);
      expect(isForbiddenProjectRoot(differentlyCased), platform).toBe(false);
    }
  });

  it("folds containment too, so a re-cased project path is not refused", async () => {
    /**
     * The other direction, and the one a Windows user would hit within a minute: the picker returns
     * `C:\\Proj` and something later spells it `c:\\Proj`. Case-sensitively that file is "outside the
     * project" and every read of it is denied.
     */
    const { isWithinProject } = await importForPlatform("win32");
    const inside = path.join(os.homedir(), "proj", "src", "main.ts");
    expect(isWithinProject(inside), "the exact casing").toBe(true);
    expect(isWithinProject(inside.toUpperCase()), "a re-cased spelling of the same file").toBe(true);
  });

  it("folding does not make an unrelated path pass", async () => {
    // The fold widens the comparison; it must not widen the BOUNDARY.
    const { isWithinProject } = await importForPlatform("win32");
    expect(isWithinProject(path.join(os.homedir(), "not-the-project", "x"))).toBe(false);
    expect(isWithinProject(path.join(os.homedir(), "PROJ-OTHER", "x"))).toBe(false);
  });
});

/**
 * ── WINDOWS PATH SHAPES ────────────────────────────────────────────────────────────────────────
 *
 * These run only on Windows, where `path` is `path.win32` and a drive-letter string means something.
 * They are the cases that cover defect (2), and they are the reason this file is worth having in a
 * pipeline: nothing here can be checked on a Mac.
 */
describe.runIf(IS_WINDOWS)("⚠ Windows-only: the areas and roots that were unprotected", () => {
  let mod: typeof import("./project-paths");

  beforeEach(async () => {
    mod = await importForPlatform("win32");
  });

  it("refuses the drive root", () => {
    // `"/"` is on TOO_BROAD and matches nothing on Windows; `path.parse(HOME).root` is the fix.
    const root = path.parse(path.resolve(os.homedir())).root; // e.g. "C:\\"
    expect(mod.isForbiddenProjectRoot(root), root).toBe(true);
    expect(mod.isForbiddenProjectRoot(`${process.env.SystemDrive || "C:"}\\`)).toBe(true);
  });

  it("refuses the Windows directory and its children", () => {
    const win = process.env.SystemRoot || "C:\\Windows";
    expect(mod.isForbiddenProjectRoot(win), win).toBe(true);
    expect(mod.isForbiddenProjectRoot(path.join(win, "System32"))).toBe(true);
  });

  it("refuses both Program Files trees", () => {
    for (const dir of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      expect(mod.isForbiddenProjectRoot(dir as string), dir as string).toBe(true);
    }
  });

  it("refuses ProgramData and the roaming/local app data trees", () => {
    // The Windows counterpart of the `~/Library` entry: machine- and user-wide application state.
    for (const dir of [process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA].filter(
      Boolean
    )) {
      expect(mod.isForbiddenProjectRoot(dir as string), dir as string).toBe(true);
    }
  });

  it("refuses the profile parent — C:\\Users", () => {
    expect(mod.isForbiddenProjectRoot(path.dirname(path.resolve(os.homedir())))).toBe(true);
  });

  it("refuses those areas however they are cased", () => {
    // Both fixes together: the Windows entry exists AND casing cannot dodge it.
    const win = process.env.SystemRoot || "C:\\Windows";
    expect(mod.isForbiddenProjectRoot(win.toLowerCase())).toBe(true);
    expect(mod.isForbiddenProjectRoot(win.toUpperCase())).toBe(true);
  });

  it("⚠ STILL ACCEPTS an ordinary project folder", () => {
    /**
     * The non-regression that matters most. A denylist that refuses everything is trivially "secure"
     * and useless — if this fails, Windows users cannot open a project at all.
     */
    const ordinary = path.join(os.homedir(), "Projects", "acme-api");
    expect(mod.isForbiddenProjectRoot(ordinary), ordinary).toBe(false);
  });

  it("still refuses the sensitive home children by name", () => {
    // `.ssh` / `.aws` are joined to HOME, so they were already correct on Windows — pinned so the
    // Windows additions cannot be mistaken for the whole of the protection.
    expect(mod.isForbiddenProjectRoot(path.join(os.homedir(), ".aws"))).toBe(true);
    expect(mod.isForbiddenProjectRoot(path.join(os.homedir(), ".ssh"))).toBe(true);
  });
});

describe("⚠ the two bypasses a security review found in this module", () => {
  const home = path.resolve(os.homedir());

  it("⚠ refuses a directory INSIDE a sensitive one — not just one containing it", async () => {
    /**
     * `SENSITIVE_CONTENTS` was tested only with `isAtOrAbove`, which refuses `~` and `~/.ssh` itself and
     * says nothing about anything underneath. `~/.config/gh/hosts.yml` is a live GitHub OAuth token and
     * `~/.aws/sso/cache/*.json` holds SSO access tokens, and both directories were acceptable as
     * project roots — after which the ordinary file handlers would read them with every check passing.
     *
     * Runs on every platform: these are POSIX-shaped paths under the real home directory.
     */
    const { isForbiddenProjectRoot } = await await0();
    for (const inside of [
      path.join(home, ".config", "gh"),
      path.join(home, ".aws", "sso", "cache"),
      path.join(home, ".ssh", "keys"),
      path.join(home, ".gnupg", "private-keys-v1.d"),
      path.join(home, ".kube", "cache"),
      path.join(home, ".docker", "buildx"),
    ]) {
      expect(isForbiddenProjectRoot(inside), inside).toBe(true);
    }
  });

  it("still refuses the sensitive directories themselves, and their ancestors", async () => {
    // The direction that already worked must keep working — this adds a check, it does not replace one.
    const { isForbiddenProjectRoot } = await await0();
    expect(isForbiddenProjectRoot(path.join(home, ".aws"))).toBe(true);
    expect(isForbiddenProjectRoot(home)).toBe(true);
  });

  it("⚠ still ACCEPTS an ordinary project folder", async () => {
    /**
     * The non-regression that matters most for a widened denylist: a rule that refuses everything is
     * trivially "secure" and would stop anyone opening a project at all.
     */
    const { isForbiddenProjectRoot } = await await0();
    expect(isForbiddenProjectRoot(path.join(home, "projects", "acme-api"))).toBe(false);
    expect(isForbiddenProjectRoot(path.join(home, "code", "work", "repo"))).toBe(false);
  });

  it("⚠ a DECOY environment variable cannot unprotect the real Windows tree", () => {
    /**
     * `env.SystemRoot || "C:\\Windows"` made the literal a fallback for the variable being ABSENT, so it
     * never applied when the variable was PRESENT with another value:
     *
     *     SystemRoot=C:\\Temp\\decoy  →  C:\\Windows\\System32 matched nothing  →  accepted
     *
     * I had only considered unsetting. The fix is a union — the env value AND the literal — so editing
     * the environment can only ADD a protected area. Asserted through the source because the win32 path
     * shapes cannot be evaluated on a Mac; the behavioural half runs in the pipeline.
     */
    /**
     * Comments stripped first: the fix's own note quotes the old expression verbatim to explain what it
     * replaced, and an absence assertion that counts prose is a guard that reports noise. (Second time
     * in this repo — the accessor docstring in cli-assistant.ts did the same thing.)
     */
    const src = strip(readFileSync(local("./project-paths.ts"), "utf8"));
    expect(src, "the fallback pattern must be gone").not.toMatch(/env\.SystemRoot \|\| "C:/);
    expect(src).toMatch(/const both = \(value: string \| undefined, literal: string\)/);
    expect(src).toMatch(/\.\.\.both\(env\.SystemRoot, "C:\\\\Windows"\)/);
  });

  it("⚠ AppData is derived from the home directory, so unsetting a variable cannot remove it", () => {
    /**
     * `APPDATA`/`LOCALAPPDATA` had no literal at all, so unsetting one made
     * `%APPDATA%\\…\\Start Menu\\Programs\\Startup` an acceptable project root — user-level persistence
     * granted by an environment variable.
     */
    const src = strip(readFileSync(local("./project-paths.ts"), "utf8"));
    expect(src).toMatch(/path\.join\(HOME, "AppData", "Roaming"\)/);
    expect(src).toMatch(/path\.join\(HOME, "AppData", "Local"\)/);
    // And its CONTENTS are covered by the sensitive list on any machine.
    expect(src, "AppData must be in SENSITIVE_CONTENTS too").toMatch(/"AppData",\s*\]\.map/);
  });
});

/** Import with the real platform, for the cases that are not platform-specific. */
async function await0() {
  return importForPlatform(process.platform);
}

/**
 * A single always-running case that states what the gated block above covers, so a local run reports
 * the gap rather than looking complete.
 */
describe("the Windows-only cases", () => {
  it(IS_WINDOWS ? "ran on this platform" : "are SKIPPED here and run in the pipeline", () => {
    expect(typeof IS_WINDOWS).toBe("boolean");
  });
});
