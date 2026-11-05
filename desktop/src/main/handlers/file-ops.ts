import { ipcMain, shell } from "electron";
import fs from "fs";
import path from "path";
import {
  allowedRoots,
  assertNotRepositoryMetadata,
  assertRealPathWithinProject,
  isRealPathWithinProject,
} from "../project-paths";
import { recordSecurityEvent, redactedTarget } from "../security-audit";
import { activeUserId } from "../active-account";

/**
 * MUTATING file operations: create, rename, move, copy, delete.
 *
 * Split from files.ts deliberately. Everything there READS (or writes a file the user already had
 * open); everything here CHANGES THE SHAPE OF SOMEBODY'S WORKING TREE, and one of them deletes.
 * That is a different risk class and it gets its own module, its own guard and its own tests.
 *
 * ── EVERY PATH GOES THROUGH `assertRealPathWithinProject`, NOT `assertWithinProject` ──
 *
 * The lexical guard the read handlers use is defeated by a symlink inside a project — verified,
 * not theorised: `path.resolve("<project>/link-to-etc/passwd")` stays inside the project string
 * while `fs.realpathSync` lands on `/private/etc/passwd`. For a read that means showing the user a
 * file they could already open. For a delete or an overwrite it means the renderer could destroy
 * `~/.ssh/id_rsa` while every path it sent looked project-relative.
 *
 * ── DELETE GOES TO THE OS TRASH, NEVER `fs.rm` ──
 *
 * `shell.trashItem` is recoverable; `rm -rf` is not, and the renderer is one bug away from asking
 * for the wrong directory. A destructive action that cannot be undone should not be reachable from
 * a UI click, and the OS already provides the undo.
 *
 * ── NAMES ARE VALIDATED, NOT SANITISED ──
 *
 * A rejected name is a message the user can act on ("that name contains a slash"); a silently
 * rewritten one is a file that is not where they think it is. So `validateName` REFUSES rather
 * than stripping — and refusing is also what stops `..` and absolute paths reaching `path.join`.
 */

/** Bound on a copied tree: a runaway recursive copy is a filled disk, not a slow operation. */
const MAX_COPY_ENTRIES = 5_000;
const MAX_COPY_BYTES = 250 * 1024 * 1024; // 250 MB

/** Directories never copied or counted — the same set the tree already hides. */
const SKIPPED = new Set(["node_modules", ".git", "__pycache__", ".DS_Store"]);

/**
 * ── ⚠ EVERY MUTATION LEAVES A RECORD ──────────────────────────────────────────────────────────
 *
 * "The agent deleted my work" is the question a participant is most likely to ask, and nothing on the machine
 * could answer it: these handlers create, rename, move, copy and TRASH files inside somebody's project and
 * recorded none of it. The platform backend cannot stand in for this — a local file operation never reaches
 * it.
 *
 * ⚠ THE BASENAME ONLY, VIA `redactedTarget`. A full path is a person's name, an employer's name and a
 * confidential project in one string, written into a plaintext file that is easier to read than the
 * encrypted database — see the note on that function. "renamed valuation.xlsx" answers the question;
 * the directory tree above it is not the audit fact.
 *
 * ⚠ AND IT IS BEST-EFFORT AND AFTER THE FACT. `recordSecurityEvent` never throws, and it is called
 * once the operation has succeeded: an audit failure must not fail the file operation, and an event
 * recorded before the syscall would claim something that may not have happened.
 */
function auditMutation(action: string, target: string): void {
  recordSecurityEvent({
    event: "file.mutate",
    outcome: "success",
    /**
     * ⚠ THE SUBJECT, WHICH THIS FAMILY WENT WITHOUT. An audit-coverage gap: all six mutating
     * handlers record through this helper and none of them named
     * WHO, so the most-populated event class in the log was also the least attributable. It matters
     * more here than the severity suggests: several identities are stored locally and
     * `auth:switchAccount` installs another one with no re-authentication (accepted risk T023 in
     * .threatmodel/praimana-threat-model.md and SECURITY.md), so "a file was trashed" is
     * only half an answer on a shared workshop machine.
     *
     * ⚠ AT THE HELPER, NOT AT THE SIX CALL SITES — the same reason `normalisedSubject` lives at the
     * sink. A seventh mutating handler gets attribution by using this function, which is already the
     * thing it has to do to be audited at all.
     */
    userId: activeUserId() ?? undefined,
    detail: `${action}:${redactedTarget(target)}`,
  });
}

/**
 * Reject anything that is not a single path segment.
 *
 * Refuses rather than sanitises, and each clause is a real attack or a real footgun:
 *   empty / whitespace   a file the user cannot see or select afterwards
 *   `/` or `\`           traversal into another directory
 *   `.` and `..`         traversal, and `..` in particular is the classic escape
 *   NUL                  truncates the path in some syscalls, so the name written is not the
 *                        name checked
 *   leading/trailing dot-space  Windows silently trims these, so the name on disk differs from
 *                        the name validated — a mismatch that defeats a later comparison
 */
function validateName(name: unknown): string {
  if (typeof name !== "string") throw new Error("Name must be text");
  /**
   * ⚠ THE RAW VALUE IS CHECKED FOR A TRAILING DOT OR SPACE, NOT THE TRIMMED ONE.
   *
   * My first version tested `trimmed !== name.trim()` — tautologically false — and then
   * `/[. ]$/` against the already-trimmed string, where the space it was looking for had been
   * removed. So `"name "` sailed through both clauses. Caught by the test, not by review.
   *
   * It matters because Windows silently strips a trailing dot or space from a filename: the name
   * written to disk would differ from the name validated, and any later comparison (a rename
   * target, a git path) would miss.
   */
  if (/[. ]$/.test(name)) {
    throw new Error("Name cannot end with a space or a dot");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("Name cannot be empty");
  if (trimmed.length > 255) throw new Error("Name is too long (max 255 characters)");
  if (trimmed === "." || trimmed === "..") throw new Error("That name is reserved");
  if (/[/\\]/.test(trimmed)) {
    throw new Error("Name cannot contain a slash — it must be a single file or folder name");
  }
  if (/[\x00-\x1f]/.test(trimmed)) throw new Error("Name contains a control character");
  return trimmed;
}

/**
 * A destination path that does not already exist.
 *
 * REFUSES rather than overwriting, because every caller here is a create/rename/paste and none of
 * them means "replace whatever is there". Overwriting silently is how a paste destroys the file it
 * landed on. The renderer offers "Copy 2" style names instead — see `uniqueDestination`.
 */
function assertAbsent(target: string): void {
  if (fs.existsSync(target)) {  // nosemgrep: detect-non-literal-fs-filename
    throw new Error(`"${path.basename(target)}" already exists here`);
  }
}

/**
 * `name`, `name 2`, `name 3`… for a paste into a folder that already has one.
 *
 * Bounded at 99: past that, something is looping and the honest answer is a refusal rather than a
 * directory with a hundred near-identical names in it.
 */
function uniqueDestination(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i <= 99; i++) {
    const candidate = i === 1 ? name : `${stem} ${i}${ext}`;
    const full = path.join(dir, candidate);  // nosemgrep: path-join-resolve-traversal
    if (!fs.existsSync(full)) return full;  // nosemgrep: detect-non-literal-fs-filename
  }
  throw new Error("Too many copies of that name in this folder");
}

/**
 * What the copier will do with `p`: descend it, copy its content, or leave it alone.
 *
 * ── ⚠ ONE TRAVERSAL DECISION, USED BY BOTH THE MEASURE AND THE COPY ───────────────────────────
 *
 * There used to be two different walks over the same tree and that was the whole defect:
 *
 *   - `measureTree` used `lstatSync`, so a symlink to a directory was a LEAF — one entry, its own
 *     tiny size — and was never descended.
 *   - `copyTreeDereferenced` used `statSync`, which follows links, so the same entry was a
 *     DIRECTORY and was descended in full.
 *
 * `MAX_COPY_ENTRIES` / `MAX_COPY_BYTES` were therefore computed over a tree the copier did not walk:
 * `<project>/dir/link -> /` measured as one small file and copied as the whole filesystem. Both walks
 * now ask this function, so the bound covers exactly what is traversed — a symlink LOOP inside the
 * project is bounded the same way, by the entry count refusing the copy before a byte is written.
 *
 * ── ⚠ AND A LINK OUT OF THE PROJECT IS SKIPPED, NOT DEREFERENCED ──
 *
 * Dereferencing is deliberate and is explained on `copyTreeDereferenced`: recreating a link would
 * plant a fresh escape hatch inside the destination. But that argument only holds for a link whose
 * TARGET is inside the project, and the code never made the distinction. So
 * `<project>/dir/link -> ~/.ssh/id_rsa` plus `fileOps:copy("<project>/dir", "<project>")` wrote the
 * key's bytes to `<project>/dir 2/link` — a file now genuinely inside the boundary, which
 * `files:readFile` then serves to the renderer, which has network egress (`connect-src *`). Copying
 * the link ITSELF was already refused by `assertRealPathWithinProject`; the guard checked one path
 * while the copier walked many.
 *
 * `framework.ts:197` states the same rule for the same reason. Skipping rather than failing keeps a
 * large copy usable when one entry is a stray link — the same choice already made for a dangling one.
 */
function copyableKind(p: string): "dir" | "file" | null {
  let link;
  try {
    link = fs.lstatSync(p);  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    return null; // absent between the readdir and here
  }
  /**
   * ⚠ ONLY LINKS ARE RE-CHECKED. A plain entry inside a directory that already passed
   * `assertRealPathWithinProject` is inside by construction, and realpath-ing every leaf of a
   * 5,000-entry tree would cost a syscall per file for nothing. A link is the only entry whose
   * content can come from somewhere else.
   */
  if (link.isSymbolicLink() && !isRealPathWithinProject(p, { mustExist: true })) {
    return null;
  }
  let st;
  try {
    // Follows the link — safe now that containment has been established for the link case.
    st = fs.statSync(p);  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    return null; // dangling: one broken pointer must not lose the other 4,999 files
  }
  return st.isDirectory() ? "dir" : "file";
}

/**
 * Total entries and bytes under `src`, refusing early once either bound is exceeded.
 *
 * ⚠ TRAVERSES EXACTLY WHAT `copyTreeDereferenced` TRAVERSES — see `copyableKind`. A measurement of a
 * different tree from the one that gets copied is not a bound.
 */
function measureTree(src: string): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  const walk = (p: string) => {
    const kind = copyableKind(p);
    if (kind === null) return; // skipped by the copier too, so it costs nothing
    if (++entries > MAX_COPY_ENTRIES) {
      throw new Error(`That folder has more than ${MAX_COPY_ENTRIES} items — copy it outside the app`);
    }
    if (kind === "dir") {
      for (const child of fs.readdirSync(p)) {  // nosemgrep: detect-non-literal-fs-filename
        if (SKIPPED.has(child)) continue;
        walk(path.join(p, child));  // nosemgrep: path-join-resolve-traversal
      }
      return;
    }
    // `statSync`, matching the copier: for an in-project link this is the size of the CONTENT that
    // will actually be written, not the few bytes of the link itself.
    bytes += fs.statSync(p).size;  // nosemgrep: detect-non-literal-fs-filename
    if (bytes > MAX_COPY_BYTES) {
      throw new Error("That folder is larger than 250 MB — copy it outside the app");
    }
  };
  walk(src);
  return { entries, bytes };
}

/**
 * REFUSE a move or copy of a directory into its own subtree.
 *
 * `fs.cpSync` of a folder into itself recurses until the disk fills; a rename into a descendant
 * fails with a confusing EINVAL. Both are user errors worth a clear message, and both compare
 * REAL paths so a symlinked shortcut cannot smuggle the destination back inside the source.
 */
function assertNotIntoOwnSubtree(src: string, destDir: string): void {
  const realSrc = fs.realpathSync(src);
  const realDest = fs.existsSync(destDir)  // nosemgrep: detect-non-literal-fs-filename
    ? fs.realpathSync(destDir)
    : path.resolve(destDir);  // nosemgrep: path-join-resolve-traversal
  if (realDest === realSrc || realDest.startsWith(realSrc + path.sep)) {
    throw new Error("Cannot move or copy a folder into itself");
  }
}

/**
 * Copy `src` to `dest`, RESOLVING every symlink into real content.
 *
 * ── WHY NOT `fs.cpSync(..., { dereference: true })` ──
 *
 * Because it does not do what its name suggests. Measured on this Node version: a link NESTED
 * inside the copied tree is recreated AS A LINK, and only a top-level one is dereferenced.
 *
 *     src/link.txt -> /outside/target.txt
 *     cpSync(src, out, { recursive: true, dereference: true })
 *     lstat(out/link.txt).isSymbolicLink()  ->  true      ✘
 *
 * That is a security bug, not a cosmetic one: a link pointing outside the project would reappear
 * in the destination as a fresh escape hatch — one the confinement check never sees, because the
 * copy created it rather than the renderer sending it. Every later read/write through that path
 * passes `assertRealPathWithinProject`'s ancestor walk only until it hits the link.
 *
 * So the walk is explicit. `fs.copyFileSync` on a link path copies the CONTENT (it follows the
 * link), which is the safe reading of "copy this": the user gets the bytes they could already read,
 * and no new pointer out of the project is created.
 *
 * ── ⚠ BUT ONLY FOR A LINK WHOSE TARGET IS INSIDE THE PROJECT ──
 *
 * "the bytes they could already read" is the whole justification, and it is false for a link out of
 * the project: `<project>/dir/link -> ~/.ssh/id_rsa` materialises the key INSIDE the boundary, where
 * `files:readFile` will hand it to the renderer. `copyableKind` makes that distinction per entry —
 * see the finding written up there. The containment rule is applied to every entry walked, not only
 * to the two paths the handler was given.
 *
 * A DANGLING link, and a link out of the project, are both SKIPPED rather than failing the whole
 * copy — one bad pointer in a large tree should not lose the other 4,999 files, and it is reported
 * by its absence rather than silently replaced with an empty file.
 */
function copyTreeDereferenced(src: string, dest: string): void {
  const kind = copyableKind(src);
  if (kind === null) return;
  if (kind === "dir") {
    fs.mkdirSync(dest);  // nosemgrep: detect-non-literal-fs-filename
    for (const child of fs.readdirSync(src)) {  // nosemgrep: detect-non-literal-fs-filename
      if (SKIPPED.has(child)) continue;
      copyTreeDereferenced(path.join(src, child), path.join(dest, child));  // nosemgrep: path-join-resolve-traversal
    }
    return;
  }
  // `copyFileSync` follows the link and writes its CONTENT, never a new link.
  fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);  // nosemgrep: detect-non-literal-fs-filename
}

export function setupFileOpsHandlers() {
  /** Create an empty file. Parent must exist; the file must not. */
  ipcMain.handle(
    "fileOps:createFile",
    async (_event, parentDir: string, name: string) => {
      const dir = assertRealPathWithinProject(parentDir, { mustExist: true });
      if (!fs.statSync(dir).isDirectory()) throw new Error("Not a folder");  // nosemgrep: detect-non-literal-fs-filename
      const target = path.join(dir, validateName(name));  // nosemgrep: path-join-resolve-traversal
      // Re-checked AFTER joining, so a name that somehow escaped validation still cannot land
      // outside the project. Two independent checks, cheap, and the second is the one that holds
      // if the first is ever loosened.
      assertRealPathWithinProject(target);
      // `.git` is a legal single segment, so `validateName` admits it — see the note on the helper.
      assertNotRepositoryMetadata(target);
      assertAbsent(target);
      // `wx` = create-exclusive: the existence check above is advisory (a race could beat it),
      // this flag is the guarantee.
      fs.writeFileSync(target, "", { flag: "wx" });  // nosemgrep: detect-non-literal-fs-filename
      auditMutation("create-file", target);
      return { path: target };
    }
  );

  /** Create a folder. Not recursive: `mkdir -p` would silently accept `a/b/c` as a "name". */
  ipcMain.handle(
    "fileOps:createFolder",
    async (_event, parentDir: string, name: string) => {
      const dir = assertRealPathWithinProject(parentDir, { mustExist: true });
      if (!fs.statSync(dir).isDirectory()) throw new Error("Not a folder");  // nosemgrep: detect-non-literal-fs-filename
      const target = path.join(dir, validateName(name));  // nosemgrep: path-join-resolve-traversal
      assertRealPathWithinProject(target);
      /**
       * ⚠ AND THIS IS THE ONE THAT MANUFACTURES A REPOSITORY. In a project that is not yet a repo,
       * `createFolder(".git")` + `createFile(".git/config")` + `files:writeFile` composes an
       * attacker-authored `.git` from three channels that each look harmless, and the next
       * `git:status` runs `core.fsmonitor` inside it.
       */
      assertNotRepositoryMetadata(target);
      assertAbsent(target);
      fs.mkdirSync(target);  // nosemgrep: detect-non-literal-fs-filename
      auditMutation("create-folder", target);
      return { path: target };
    }
  );

  /**
   * Rename in place. The new name is a SEGMENT, never a path — moving is a separate operation with
   * its own destination check, and conflating them would let "rename" relocate a file.
   */
  ipcMain.handle(
    "fileOps:rename",
    async (_event, target: string, newName: string) => {
      const src = assertRealPathWithinProject(target, { mustExist: true });
      const dest = path.join(path.dirname(src), validateName(newName));  // nosemgrep: path-join-resolve-traversal
      assertRealPathWithinProject(dest);
      // BOTH ENDS. Renaming a prepared folder TO `.git` is the same manufacture as creating it, and
      // renaming the real `.git` AWAY clears the way for one.
      assertNotRepositoryMetadata(src);
      assertNotRepositoryMetadata(dest);
      if (dest === src) return { path: src };
      // A case-only rename on macOS/Windows: `existsSync(dest)` is TRUE because the filesystem is
      // case-insensitive, so the plain absent-check would refuse `readme.md` -> `README.md`. The
      // rename itself is legal, so it is allowed through explicitly.
      const caseOnlyRename = dest.toLowerCase() === src.toLowerCase();
      if (!caseOnlyRename) assertAbsent(dest);
      fs.renameSync(src, dest);  // nosemgrep: detect-non-literal-fs-filename
      auditMutation("rename", dest);
      return { path: dest };
    }
  );

  /**
   * MOVE (cut + paste). Same-volume rename where possible, falling back to copy+delete across
   * volumes — `fs.renameSync` fails with EXDEV there, which is a real case on macOS with an
   * external drive mounted inside a project.
   */
  ipcMain.handle(
    "fileOps:move",
    async (_event, target: string, destDir: string) => {
      const src = assertRealPathWithinProject(target, { mustExist: true });
      const dir = assertRealPathWithinProject(destDir, { mustExist: true });
      if (!fs.statSync(dir).isDirectory()) throw new Error("Destination is not a folder");  // nosemgrep: detect-non-literal-fs-filename
      if (fs.statSync(src).isDirectory()) assertNotIntoOwnSubtree(src, dir);  // nosemgrep: detect-non-literal-fs-filename

      const dest = path.join(dir, path.basename(src));  // nosemgrep: path-join-resolve-traversal
      assertRealPathWithinProject(dest);
      // The DESTINATION DIRECTORY is caller-supplied, so `.git` is reachable as a move target.
      assertNotRepositoryMetadata(src);
      assertNotRepositoryMetadata(dest);
      if (dest === src) return { path: src, moved: false };
      assertAbsent(dest);

      try {
        fs.renameSync(src, dest);  // nosemgrep: detect-non-literal-fs-filename
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        // Cross-device: copy, verify, then remove the original. The source is only trashed AFTER
        // the copy succeeds, so an interrupted move loses nothing.
        measureTree(src);
        // Same dereferencing copier as the copy handler — a cross-volume MOVE must not recreate a
        // symlink out of the project either.
        copyTreeDereferenced(src, dest);
        await shell.trashItem(src);
      }
      auditMutation("move", dest);
      return { path: dest, moved: true };
    }
  );

  /** COPY (copy + paste). Auto-renames on collision rather than overwriting. */
  ipcMain.handle(
    "fileOps:copy",
    async (_event, target: string, destDir: string) => {
      const src = assertRealPathWithinProject(target, { mustExist: true });
      const dir = assertRealPathWithinProject(destDir, { mustExist: true });
      if (!fs.statSync(dir).isDirectory()) throw new Error("Destination is not a folder");  // nosemgrep: detect-non-literal-fs-filename
      if (fs.statSync(src).isDirectory()) assertNotIntoOwnSubtree(src, dir);  // nosemgrep: detect-non-literal-fs-filename

      // Bounded BEFORE any bytes are written, so an oversized tree is refused rather than
      // half-copied and then abandoned.
      measureTree(src);

      const dest = uniqueDestination(dir, path.basename(src));
      assertRealPathWithinProject(dest);
      // Copy is the cheapest write into `.git`: author `config` anywhere in the project, then paste.
      assertNotRepositoryMetadata(dest);
      copyTreeDereferenced(src, dest);
      auditMutation("copy", dest);
      return { path: dest };
    }
  );

  /**
   * DELETE — to the OS trash, never an unlink.
   *
   * `shell.trashItem` is the whole point: the renderer is one bad path away from removing a
   * directory, and Finder/Explorer already provide the undo. A hard delete reachable from a click
   * is a data-loss bug waiting for a mis-click.
   */
  ipcMain.handle("fileOps:trash", async (_event, target: string) => {
    const resolved = assertRealPathWithinProject(target, { mustExist: true });
    // A project ROOT is never deletable from the tree: it would remove the folder the app is
    // currently pointed at, leaving every open editor and the CLI working directory dangling.
    if (isProjectRoot(resolved)) {
      throw new Error("Cannot delete the project folder itself");
    }
    await shell.trashItem(resolved);
    // ⚠ THE ONE THAT DESTROYS. If any single line in this file earns an audit record, it is this one.
    auditMutation("trash", resolved);
    return { trashed: resolved };
  });

  /** Reveal in Finder/Explorer — read-only, and the one place a native window is opened. */
  ipcMain.handle("fileOps:revealInFolder", async (_event, target: string) => {
    /**
     * ⚠ REALPATH, LIKE EVERY OTHER HANDLER IN THIS FILE. Fixed with the two in handlers/files.ts,
     * because lexical-only confinement permits symlink escape: this was the last
     * `assertWithinProject` on this boundary, and it hands a renderer-chosen path to
     * `shell.showItemInFolder`, which opens a native window on it.
     *
     * Read-only, so the stakes are lower than the mutations above — but "open a Finder window anywhere
     * on disk, selecting a named file" is not something the renderer should be able to ask for, and the
     * mutating handlers in this same file all resolve links before deciding.
     */
    const resolved = assertRealPathWithinProject(target, { mustExist: true });
    shell.showItemInFolder(resolved);
    return { revealed: resolved };
  });
}

/**
 * True when `resolved` is itself one of the open project roots.
 *
 * Compared against the REAL path of each root, because the target has already been resolved
 * through symlinks — on macOS a project under `/tmp` has a real path under `/private/tmp`, so a
 * lexical comparison would fail to recognise its own root and allow it to be trashed.
 */
function isProjectRoot(resolved: string): boolean {
  return allowedRoots().some((root) => {
    const real = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
    return real === resolved || path.resolve(root) === resolved;  // nosemgrep: path-join-resolve-traversal
  });
}
