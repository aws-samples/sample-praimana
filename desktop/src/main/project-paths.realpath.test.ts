import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * `isRealPathWithinProject` — the non-throwing predicate the callers that MUST NOT THROW depend on.
 *
 * Three of them, all previously stuck on the lexical `isWithinProject` because they needed a
 * boolean rather than an assertion, and all three mutating:
 *
 *   confineCwd (spawn-confined.ts)  — the cwd of EVERY spawned agent; falls back to $HOME
 *   framework:install               — copies a framework tree in and spawns an agent; returns { error }
 *   framework:check                 — must agree with install about what the project is
 *
 * Real filesystem and real symlinks, for the same reason file-ops.test.ts uses them: whether a
 * symlink resolves out of a project is a property of the filesystem, not of my assumptions.
 */

let ROOT = "";
let OUTSIDE = "";

vi.mock("./database", () => ({
  readSetting: (key: string) => (key === "project_path" ? ROOT : null),
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
}));

import {
  isRealPathWithinProject,
  isWithinProject,
  assertRealPathWithinProject,
} from "./project-paths";

beforeEach(() => {
  // macOS: /var is a symlink to /private/var, so the root must be the REAL path.
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "realpath-")));
  OUTSIDE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "realpath-outside-")));
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
});

const inRoot = (...p: string[]) => path.join(ROOT, ...p);

describe("isRealPathWithinProject", () => {
  it("accepts the project root and real directories inside it", () => {
    fs.mkdirSync(inRoot("src", "deep"), { recursive: true });
    expect(isRealPathWithinProject(ROOT)).toBe(true);
    expect(isRealPathWithinProject(inRoot("src"))).toBe(true);
    expect(isRealPathWithinProject(inRoot("src", "deep"))).toBe(true);
  });

  it("REFUSES a symlink that resolves out of the project — and the lexical check does not", () => {
    fs.symlinkSync(OUTSIDE, inRoot("escape"), "dir");

    // The gap these three callers were sitting on, side by side in one assertion.
    expect(isWithinProject(inRoot("escape"))).toBe(true);
    expect(isRealPathWithinProject(inRoot("escape"))).toBe(false);
  });

  it("accepts a symlink that stays inside the project", () => {
    // Refusing every symlink would break legitimate repo layouts, so the rule is about where the
    // link POINTS. A linked package directory must still be a valid cwd.
    fs.mkdirSync(inRoot("real"));
    fs.symlinkSync(inRoot("real"), inRoot("linked"), "dir");

    expect(isRealPathWithinProject(inRoot("linked"))).toBe(true);
  });

  it("refuses paths outside the project and traversal out of it", () => {
    expect(isRealPathWithinProject(OUTSIDE)).toBe(false);
    expect(isRealPathWithinProject("/etc")).toBe(false);
    expect(isRealPathWithinProject(inRoot("..", ".."))).toBe(false);
  });

  it("honours mustExist — an absent directory is not a usable cwd", () => {
    // confineCwd passes { mustExist: true } because spawn would fail with ENOENT anyway, so an
    // absent path belongs in the $HOME fallback rather than being handed to the child.
    expect(isRealPathWithinProject(inRoot("not-created-yet"), { mustExist: true })).toBe(false);
    // Without mustExist the ancestor walk accepts it: the PARENT is real and inside the project,
    // which is what a create/write destination legitimately looks like.
    expect(isRealPathWithinProject(inRoot("not-created-yet"))).toBe(true);
  });

  it("refuses an absent path whose parent is a symlink pointing out", () => {
    // The combination that matters for a create: the leaf does not exist, so the check walks up —
    // and must not stop before noticing the parent leaves the project.
    fs.symlinkSync(OUTSIDE, inRoot("escape"), "dir");
    expect(isRealPathWithinProject(inRoot("escape", "new-file.txt"))).toBe(false);
  });

  it("returns false rather than throwing, for every rejection shape", () => {
    // The whole reason this predicate exists: its callers have non-throwing contracts.
    for (const bad of ["", "/etc/passwd", OUTSIDE, inRoot("..")]) {
      expect(() => isRealPathWithinProject(bad)).not.toThrow();
      expect(isRealPathWithinProject(bad)).toBe(false);
    }
    // @ts-expect-error — exercising the runtime guard against bad callers
    expect(isRealPathWithinProject(undefined)).toBe(false);
  });

  it("fails closed when no project is open", () => {
    const saved = ROOT;
    ROOT = "";
    try {
      expect(isRealPathWithinProject(path.join(saved, "anything"))).toBe(false);
    } finally {
      ROOT = saved;
    }
  });
});

/**
 * ── ⚠ `..` INSIDE A SYMLINK TARGET, WHICH IS NOT THE SAME AS `..` IN THE CALLER'S PATH ────────
 *
 * The module already refused a literal `..` in the CALLER'S string, with a comment explaining
 * exactly why — "the kernel applies `..` AFTER following a symlink" — and then made that same
 * mistake itself on the link's own target, where the caller-string rule cannot see it.
 *
 * These are filesystem cases rather than string cases on purpose: the divergence being tested is
 * between what `path.resolve` computes and what the kernel does, so asserting on my own model of
 * either would be asserting on the bug. The escape case ends by checking WHERE A REAL WRITE
 * LANDED, because that is the only statement that cannot be satisfied by a plausible-looking path.
 */
describe("⚠ symlink targets containing `..` (the confinement bypass)", () => {
  it("REFUSES a link whose target escapes via `..` after a symlinked component", () => {
    // esc -> OUTSIDE (a real directory outside the project)
    fs.symlinkSync(OUTSIDE, inRoot("esc"), "dir");
    // pwn -> "esc/../<basename of OUTSIDE>/evil.txt"
    //
    // Lexically that reduces to <ROOT>/<basename>/evil.txt — inside the project. Via the kernel
    // it is esc (=OUTSIDE) then `..` (=OUTSIDE's parent, /tmp) then back down: outside entirely.
    //
    // ⚠ BUILT AS A LITERAL STRING, NOT WITH path.join — path.join COLLAPSES `..` ITSELF, so
    // path.join("esc", "..", x) is just x and the link created would not contain the segment
    // this test is about. Writing the escaping form by hand is the only way to store it.
    const escapeTarget = `esc/../${path.basename(OUTSIDE)}/evil.txt`;
    fs.symlinkSync(escapeTarget, inRoot("pwn"));

    expect(() => assertRealPathWithinProject(inRoot("pwn"))).toThrow(/symlink|outside/i);
  });

  it("and the write that bypass enabled does not reach the filesystem", () => {
    fs.symlinkSync(OUTSIDE, inRoot("esc"), "dir");
    const victim = path.join(OUTSIDE, "evil.txt");
    fs.symlinkSync(`esc/../${path.basename(OUTSIDE)}/evil.txt`, inRoot("pwn"));

    // The end-to-end statement: the guard refuses, so nothing is created outside. Before the fix
    // the guard returned <ROOT>/pwn and a caller's writeFileSync created this file.
    expect(() => assertRealPathWithinProject(inRoot("pwn"))).toThrow();
    expect(fs.existsSync(victim)).toBe(false);
  });

  it("still accepts a relative `..` target that stays inside — node_modules/.bin is this shape", () => {
    // ⚠ THE REASON THE FIX IS NOT "REFUSE `..` IN LINK TARGETS". Every pnpm/npm bin shim and every
    // monorepo workspace link is a relative parent target; refusing them would break reading
    // node_modules across the app. Containment is about where a link LANDS, not how it is spelled.
    fs.mkdirSync(inRoot("node_modules", ".bin"), { recursive: true });
    fs.mkdirSync(inRoot("node_modules", "vite", "bin"), { recursive: true });
    fs.writeFileSync(inRoot("node_modules", "vite", "bin", "vite.js"), "#!/usr/bin/env node\n");
    fs.symlinkSync("../vite/bin/vite.js", inRoot("node_modules", ".bin", "vite"));

    expect(() =>
      assertRealPathWithinProject(inRoot("node_modules", ".bin", "vite"))
    ).not.toThrow();
  });

  it("refuses a multi-hop chain that only escapes on the second link", () => {
    // ⚠ THIS ONE PASSED BEFORE THE FIX TOO, and it is kept for that reason rather than in spite of
    // it. The lexical chain judges `up` as <ROOT>, but `up` EXISTS, so the ancestor walk realpaths
    // it — the kernel follows esc then `..` and lands outside — and the existing check refuses.
    // So the two defences overlap here, and this asserts the overlap stays: a future change that
    // "simplifies" either one still has to keep this case refused.
    fs.symlinkSync(OUTSIDE, inRoot("esc"), "dir");
    fs.symlinkSync("esc/..", inRoot("up"), "dir");
    fs.symlinkSync(`up/${path.basename(OUTSIDE)}/evil.txt`, inRoot("pwn2"));

    expect(() => assertRealPathWithinProject(inRoot("pwn2"))).toThrow(/symlink|outside/i);
  });

  it("still refuses a link target that is plainly absolute and outside", () => {
    // The case that always worked, kept so the fix cannot regress it while chasing the new one.
    fs.symlinkSync(path.join(OUTSIDE, "evil.txt"), inRoot("plain"));
    expect(() => assertRealPathWithinProject(inRoot("plain"))).toThrow(/symlink|outside/i);
  });

  /**
   * ── ⚠ THE DoS THE FIRST VERSION OF THE `..` FIX INTRODUCED ──────────────────────────────────
   *
   * The per-segment call passed the hop
   * budget BY VALUE (`hops + 1`), which caps depth and leaves breadth free — so a link whose
   * target names a sibling link twice costs double at each level. Measured before the fix, on a
   * graph of `d/M{i} -> "M{i+1}/M{i+1}"`:
   *
   *     8 links 58 ms · 12 links 627 ms · 16 links 9.7 s · 18 links 39 s · 20 links 158 s
   *
   * Synchronous, on the Electron main process, so it is a full application freeze rather than a
   * slow call — and reachable from exactly where the bypass was: symlinks in a cloned repo.
   *
   * The budget is now one shared mutable object. This case asserts the SHAPE stays bounded rather
   * than asserting a particular error, because either counter refusing it is a correct outcome.
   */
  it("refuses a fan-out symlink graph quickly instead of hanging on it", () => {
    const N = 20;
    const d = inRoot("d");
    fs.mkdirSync(d);
    fs.symlinkSync(".", path.join(d, `M${N}`), "dir");
    for (let i = N - 1; i >= 0; i--) {
      // Literal string: path.join would collapse nothing here, but the doubling depends on the
      // segment appearing twice, so it is written out for the same reason as the escape cases.
      fs.symlinkSync(`M${i + 1}/M${i + 1}`, path.join(d, `M${i}`), "dir");
    }

    const startedAt = Date.now();
    expect(() => assertRealPathWithinProject(path.join(d, "M0"))).toThrow(
      /too many symbolic links|too complex/i
    );
    // 158 s before the fix, ~8 ms after. Five seconds is a loose bound that still cannot be met
    // by an exponential walk, so this does not go flaky on a busy machine.
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("does not hang on a symlink loop built from relative parent targets", () => {
    // The hop budget is shared between resolveLinkChain and resolvePhysically precisely so a
    // graph alternating between them cannot buy extra budget. A loop is a real filesystem state.
    fs.symlinkSync("./b", inRoot("a"));
    fs.symlinkSync("./a", inRoot("b"));
    expect(() => assertRealPathWithinProject(inRoot("a"))).toThrow(/too many|symlink|outside/i);
  });
});
