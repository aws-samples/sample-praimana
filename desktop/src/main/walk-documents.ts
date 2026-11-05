/**
 * ── ⚠ FINDING A TEAM'S DOCUMENTS, WITHOUT `find` ──────────────────────────────────────────────
 *
 * `git:listUploadable` shelled out to `find` with a POSIX expression:
 *
 *     find <repo> -type f ( -name *.md -o … ) -not -path <star>/node_modules/<star> …
 *
 * (the glob's asterisks written as `<star>` because a literal one would end this comment)
 *
 * ⚠ WINDOWS HAS A `find.exe` AND IT IS A DIFFERENT PROGRAM. It searches for a STRING INSIDE FILES —
 * `find "hello" file.txt` — and knows nothing of `-type`, `-name` or `-path`. So on Windows the call
 * did not fail in a way anyone could read: `find` exited non-zero complaining about parameters, the
 * `catch` treated that as "no matching file", and the participant saw an empty document list with no
 * error. A feature that silently reports nothing is worse than one that visibly breaks.
 *
 * ── WHY A WALK RATHER THAN A PORTABLE SHELL-OUT ──
 *
 * There is no `find` equivalent shipped on all three platforms, and this is twenty lines of
 * `readdirSync`. It also removes a process spawn from a read that runs whenever the Build phase is
 * opened, and it makes the exclusions and the extension list testable — as an argument list to
 * another program they were only assertable as strings.
 *
 * ⚠ AND IT LETS THE WALK REFUSE SYMLINKS, which the boundary needs. `find` without `-L` does not
 * follow them either, so this preserves the behaviour rather than changing it — but here it is
 * explicit and tested. A link inside the project pointing at `~/.ssh` would otherwise contribute
 * files that are outside the project to a list the renderer then offers for UPLOAD TO THE TEAM.
 */

import fs from "fs";
import path from "path";

/**
 * The extensions the docs service accepts (`ALLOWED_UPLOAD_TYPES`).
 *
 * Matched case-INSENSITIVELY: `README.MD` is a real file on Windows, where the filesystem does not
 * distinguish it, and a participant who typed `.Md` on any platform meant markdown.
 */
export const UPLOADABLE_EXTENSIONS: readonly string[] = [".md", ".txt", ".pdf", ".html"];

/**
 * Directories whose contents are never a team's own work: dependency trees, build output, and git's
 * internals. Without them a single `pnpm install` buries the list under thousands of vendored
 * READMEs.
 */
export const SKIPPED_DIRECTORIES: readonly string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
];

/**
 * Bounds. Every walk in this app is bounded (see the standing constraints), and a repository is
 * user-supplied: a deep or enormous tree must slow this down predictably rather than hanging the
 * handler that called it.
 *
 * `MAX_VISITED` counts directory ENTRIES examined, not files matched — the cost is in the traversal,
 * and a tree of a million empty directories has to stop too.
 */
export const MAX_DEPTH = 12;
export const MAX_VISITED = 200_000;

export interface WalkResult {
  /** Absolute paths, in traversal order. */
  files: string[];
  /** True if a bound stopped the walk, so the caller can say the list is partial. */
  truncated: boolean;
}

/** Case-insensitive extension test. */
function isUploadable(name: string): boolean {
  const lower = name.toLowerCase();
  return UPLOADABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every uploadable document under `root`, excluding the directories above and every symlink.
 *
 * Never throws for an unreadable subdirectory: a project can contain a folder this user cannot open,
 * and one `EACCES` must not empty the whole list. The unreadable branch is skipped and the walk
 * continues — the same tolerance `find` had, which reported what it could reach.
 */
export function walkDocuments(root: string): WalkResult {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;

  /** Iterative, not recursive: a deep tree must not exhaust the JS stack on a participant's laptop. */
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) {
      truncated = true;
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });  // nosemgrep: detect-non-literal-fs-filename
    } catch {
      // Unreadable directory — skip it, keep the rest of the list.
      continue;
    }

    for (const entry of entries) {
      if (++visited > MAX_VISITED) {
        truncated = true;
        return { files, truncated };
      }

      /**
       * ⚠ SYMLINKS ARE SKIPPED ENTIRELY, files and directories alike. `isDirectory()` and `isFile()`
       * on a Dirent do NOT follow the link (they report the link's own type), so a link is neither —
       * but being explicit is the point: this list is offered for upload, and a link is the one entry
       * whose target can be outside the project.
       */
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);  // nosemgrep: path-join-resolve-traversal

      if (entry.isDirectory()) {
        // Compared case-insensitively: `Node_Modules` is the same directory on Windows.
        if (SKIPPED_DIRECTORIES.includes(entry.name.toLowerCase())) continue;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (entry.isFile() && isUploadable(entry.name)) files.push(full);
    }
  }

  return { files, truncated };
}
