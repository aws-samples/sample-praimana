// ── ⚠ THE PATH EVERY ASSISTANT AND ITS TOOLS ARE SPAWNED WITH ───────────────────────────────────
//
// It was describing an environment this app constructs, accurately.
//
// A Finder-launched app inherits no shell PATH — `process.env.PATH` in a packaged build is roughly
// `/usr/bin:/bin:/usr/sbin:/sbin` — and the non-interactive shell the agent runs its own commands in does
// not source `~/.zshrc` either. So a per-user install is invisible unless this module names it.
//
// ⚠ AND THE LIST EXISTED FOUR TIMES. cli-assistant.ts, kiro-acp.ts, claude-code.ts and framework.ts each
// had their own copy; claude-code.ts's comment says it is "Kept IDENTICAL to cli-assistant.ts's `spawnEnv`
// on purpose", which is exactly right and exactly what four copies cannot guarantee. `bun` had to be added
// in four places, so it was added in none.

import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assistantPath } from "./assistant-path";

const home = os.homedir();

describe("assistantPath", () => {
  it("names the per-user directories a Finder launch cannot see", () => {
    const entries = assistantPath("/usr/bin:/bin").split(path.delimiter);
    for (const dir of [
      join(home, ".toolbox", "bin"),
      join(home, ".local", "bin"),
      join(home, ".bun", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]) {
      expect(entries, `${dir} must be searched`).toContain(dir);
    }
  });

  it("⚠ includes ~/.bun/bin — the reported gap", () => {
    expect(assistantPath()).toContain(join(home, ".bun", "bin"));
  });

  /** Apple Silicon's Homebrew prefix. `/usr/local/bin` is Intel's and is usually empty there. */
  it("⚠ includes /opt/homebrew/bin, not only the Intel prefix", () => {
    expect(assistantPath()).toContain("/opt/homebrew/bin");
  });

  it("puts the inherited PATH last, so a participant's install wins", () => {
    const entries = assistantPath("/sentinel").split(path.delimiter);
    expect(entries[entries.length - 1]).toBe("/sentinel");
    expect(entries.indexOf(join(home, ".toolbox", "bin"))).toBeLessThan(entries.length - 1);
  });

  /**
   * ⚠ `path.delimiter`, NOT A LITERAL `":"`. framework.ts fixed this once and wrote down why — on Windows
   * `:` produces one nonsense entry rather than several real ones — and that fix never reached the other
   * three copies. Now there is one place for it to be right.
   */
  it("joins with the platform delimiter", () => {
    expect(assistantPath("/a")).toContain(path.delimiter);
    const src = readFileSync(new URL("./assistant-path.ts", import.meta.url), "utf8");
    expect(src).toContain("path.delimiter");
  });

  it("falls back to a usable PATH when nothing is inherited", () => {
    expect(assistantPath(undefined).split(path.delimiter)).toContain("/usr/bin");
    expect(assistantPath("").split(path.delimiter)).toContain("/bin");
  });
});

/**
 * ── ⚠ NO HANDLER MAY BUILD ITS OWN LIST AGAIN ──────────────────────────────────────────────────
 *
 * The derived sweep, for the reason the four copies existed: a rule kept by everyone remembering is not a
 * rule. A fifth spawn site added tomorrow fails here rather than shipping with `bun` missing.
 */
describe("⚠ every spawn site builds PATH from this module", () => {
  const handlers = () => {
    const dir = new URL("./handlers/", import.meta.url);
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => ({ file: f, src: readFileSync(new URL(f, dir), "utf8") }));
  };

  it("finds the handlers at all", () => {
    expect(handlers().length).toBeGreaterThan(5);
  });

  it("has no hand-rolled toolbox/local/bin PATH list left", () => {
    const offenders: string[] = [];
    for (const { file, src } of handlers()) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      // The list's signature: the two per-user bins joined into a PATH.
      if (/\.local", "bin"\)/.test(code) && /PATH/.test(code) && !/assistantPath\(/.test(code)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      "build PATH with assistantPath() from ../assistant-path instead of a local list"
    ).toEqual([]);
  });

  it("the four known spawn sites use it", () => {
    const byName = new Map(handlers().map((h) => [h.file, h.src]));
    for (const file of ["cli-assistant.ts", "kiro-acp.ts", "claude-code.ts", "framework.ts"]) {
      expect(byName.get(file), `${file} must exist`).toBeTruthy();
      expect(byName.get(file)!, `${file} must use assistantPath()`).toContain("assistantPath()");
    }
  });
});
