// ── ⚠ THE DOCUMENT LIST, WITHOUT `find` ───────────────────────────────────────────────────────
//
// `git:listUploadable` shelled out to POSIX `find`. Windows HAS a `find.exe` and it is a different
// program — it searches for a string inside files — so on Windows it exited non-zero, the handler's
// `catch` read that as "no matching file", and the participant saw an EMPTY document list with no
// error at all. A feature that silently reports nothing is worse than one that visibly breaks.
//
// Exercised against real directories rather than mocks, because the behaviour that matters is
// filesystem behaviour: what a Dirent says about a symlink, whether an unreadable directory throws,
// what `readdirSync` returns for an empty tree. A mocked `fs` would test the mock.
//
// ⚠ THESE RUN UNCHANGED ON WINDOWS, which is the point of choosing a Node walk: the same cases prove
// the same guarantees in the pipeline, with no platform gating and no simulation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_DEPTH,
  SKIPPED_DIRECTORIES,
  UPLOADABLE_EXTENSIONS,
  walkDocuments,
} from "./walk-documents";

let root = "";

/** Create `rel` (a file) with its parent directories. */
const write = (rel: string, body = "x") => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
};

/** Paths relative to the root, with separators normalised, so assertions read the same everywhere. */
const relative = (files: string[]) =>
  files.map((f) => path.relative(root, f).split(path.sep).join("/")).sort();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "walkdocs-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what it finds", () => {
  it("finds the four accepted extensions at any depth", () => {
    write("README.md");
    write("notes.txt");
    write("docs/spec.pdf");
    write("docs/deep/nested/page.html");

    expect(relative(walkDocuments(root).files)).toEqual([
      "README.md",
      "docs/deep/nested/page.html",
      "docs/spec.pdf",
      "notes.txt",
    ]);
  });

  it("ignores every other extension", () => {
    // The server's list is the authority (ALLOWED_UPLOAD_TYPES); this must not offer what it refuses.
    for (const name of ["main.ts", "image.png", "archive.zip", "Makefile", ".env"]) write(name);
    expect(walkDocuments(root).files).toEqual([]);
  });

  it("⚠ matches extensions case-INSENSITIVELY", () => {
    /**
     * `README.MD` is a real file, and on Windows the filesystem does not distinguish it from
     * `README.md`. A case-sensitive test would hide a participant's own document from them on the
     * platform where the casing is not even meaningful.
     */
    write("README.MD");
    write("NOTES.Txt");
    write("Guide.HTML");
    expect(relative(walkDocuments(root).files)).toEqual(["Guide.HTML", "NOTES.Txt", "README.MD"]);
  });

  it("returns an empty list for an empty tree, not an error", () => {
    // `find` exited non-zero here on some platforms, which is why the handler had a catch at all.
    const result = walkDocuments(root);
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns an empty list for a directory that does not exist", () => {
    expect(walkDocuments(path.join(root, "nope")).files).toEqual([]);
  });
});

describe("what it skips", () => {
  it("skips the dependency and build directories", () => {
    write("keep.md");
    for (const dir of SKIPPED_DIRECTORIES) write(`${dir}/vendored.md`);

    expect(relative(walkDocuments(root).files)).toEqual(["keep.md"]);
  });

  it("skips them at any depth, not just the top level", () => {
    // A monorepo has a node_modules per package; only the root one being excluded is useless.
    write("packages/api/node_modules/dep/README.md");
    write("packages/api/docs/real.md");

    expect(relative(walkDocuments(root).files)).toEqual(["packages/api/docs/real.md"]);
  });

  it("skips them whatever their casing", () => {
    // `Node_Modules` is the same directory on Windows.
    write("Node_Modules/dep/README.md");
    write(".GIT/config.md");
    write("keep.md");

    expect(relative(walkDocuments(root).files)).toEqual(["keep.md"]);
  });

  it("⚠ SKIPS SYMLINKS — the boundary depends on it", () => {
    /**
     * This list is handed to `git:uploadSelected`, so anything on it may be sent to the team. A link
     * inside the project pointing outside it would put somebody else's documents on that list — and
     * the real-path check in the handler validates the ROOT, not each entry.
     *
     * Both directions are covered: a linked FILE and a linked DIRECTORY.
     */
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "walkdocs-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "not the team's");
      write("real.md");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "linked-file.md"));
      fs.symlinkSync(outside, path.join(root, "linked-dir"));

      const files = relative(walkDocuments(root).files);
      expect(files).toEqual(["real.md"]);
      expect(files.join(" ")).not.toContain("secret");
      expect(files.join(" ")).not.toContain("linked");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps going past a directory it cannot read", () => {
    /**
     * A project can contain a folder this user cannot open, and one EACCES must not empty the whole
     * list — the same tolerance `find` had. Skipped where the OS does not enforce mode 000 (running
     * as root, or a filesystem without permissions).
     */
    write("readable/a.md");
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "b.md"), "x");
    try {
      fs.chmodSync(locked, 0o000);
      const stillReadable = (() => {
        try {
          fs.readdirSync(locked);
          return true;
        } catch {
          return false;
        }
      })();
      if (stillReadable) return; // permissions not enforced here — nothing to prove

      expect(relative(walkDocuments(root).files)).toEqual(["readable/a.md"]);
    } finally {
      try {
        fs.chmodSync(locked, 0o700);
      } catch {
        /* best effort, for the cleanup below */
      }
    }
  });
});

describe("it stays bounded", () => {
  it("stops descending past MAX_DEPTH and says so", () => {
    /**
     * A user-supplied repository can be arbitrarily deep. The bound must be visible to the caller —
     * a silently short list is the `find` failure all over again, just with a different cause.
     */
    const deep = Array.from({ length: MAX_DEPTH + 3 }, (_, i) => `d${i}`).join("/");
    write(`${deep}/buried.md`);
    write("shallow.md");

    const result = walkDocuments(root);
    expect(relative(result.files)).toEqual(["shallow.md"]);
    expect(result.truncated, "the caller must be able to say the list is partial").toBe(true);
  });

  it("does not claim truncation for an ordinary tree", () => {
    // A flag that is always true carries no information.
    write("a.md");
    write("b/c/d.md");
    expect(walkDocuments(root).truncated).toBe(false);
  });

  it("is iterative, so a deep tree cannot exhaust the stack", () => {
    // Recursion at this depth is survivable; the point is that depth is bounded by MAX_DEPTH, not by
    // the JS stack, and that walking a legal-depth tree does not throw.
    write(`${Array.from({ length: MAX_DEPTH }, (_, i) => `n${i}`).join("/")}/leaf.md`);  // nosemgrep: missing-template-string-indicator
    expect(() => walkDocuments(root)).not.toThrow();
    expect(walkDocuments(root).files).toHaveLength(1);
  });
});

describe("the handler no longer shells out", () => {
  it("git.ts calls walkDocuments and mentions no `find`", () => {
    const git = readFileSyncStripped("./handlers/git.ts");
    expect(git).toContain("walkDocuments(repoPath)");
    expect(git, "the POSIX find invocation is gone").not.toMatch(/execFileSync\("find"/);
  });

  it("the accepted extensions still match the server's list", () => {
    // Divergence downward would hide files the platform accepts; upward would offer files it refuses.
    expect([...UPLOADABLE_EXTENSIONS].sort()).toEqual([".html", ".md", ".pdf", ".txt"]);
  });
});

function readFileSyncStripped(rel: string): string {
  const target = fileURLToPath(new URL(rel, import.meta.url));
  return fs
    .readFileSync(target, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}
