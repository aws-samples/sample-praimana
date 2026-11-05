import { ipcMain } from "electron";
import { simpleGit, type SimpleGitOptions, type SimpleGit } from "simple-git";
import { assertRealPathWithinProject } from "../project-paths";
import { walkDocuments } from "../walk-documents";
import { debugLog } from "../debug-log";
import { recordSecurityEvent } from "../security-audit";
import { activeUserId } from "../active-account";

/**
 * Timeout for every git operation that touches the NETWORK.
 *
 * Local operations (status, add, commit) are disk-bound and fast. Fetch, pull and push
 * talk to a remote that can hang indefinitely on a workshop-venue connection, and a
 * hung child process holds a renderer button in its spinner with no way out. simple-git
 * has no per-call timeout, so it is configured per instance.
 */
const NETWORK_TIMEOUT_MS = 60_000;

/**
 * ── ⚠ THE REPOSITORY'S OWN CONFIG IS UNTRUSTED INPUT ──────────────────────────────────────────
 *
 * The primary control is that nothing may write into `.git` at all (`assertNotRepositoryMetadata`,
 * project-paths.ts, applied on every mutating channel). This is the second layer, for the case where a
 * hostile `.git` arrives another way — a cloned workshop repo, or the in-app agent, whose pre-approved
 * `fs_write` never passes through an IPC handler.
 *
 * ⚠ `core.fsmonitor` IS THE ONE THAT MATTERS, because it is the one that fires UNATTENDED:
 * Sidebar.tsx calls `gitStatus` from a `useEffect` on every active-project change, so a planted
 * value runs on the next project open with no user gesture at all.
 *
 * ⚠ `allowUnsafeFsMonitor` IS REQUIRED TO **DISABLE** IT, which reads backwards and is not a typo.
 * simple-git 3.36 denylists the key in its own `config` array — `config: ["core.fsmonitor=false"]`
 * throws "Configuring core.fsmonitor is not permitted without enabling allowUnsafeFsMonitor" and
 * takes `git:status` and `git:diff` down with it. Measured: without the flag, every call errors and
 * the vector only looks closed because git never ran. The flag admits the key; the VALUE we pass is
 * `false`.
 *
 * ⚠ `diff.external` IS **NOT** HERE, AND `core.hooksPath` IS NOT EITHER. Both are deliberate:
 *   * `diff.external` is neutralised by `--no-ext-diff` on the diff call, which needs no unsafe flag
 *     and also covers per-driver `diff.<name>.command` — measured both ways.
 *   * `core.hooksPath` would need `allowUnsafeHooksPath` and would then disable the repository's
 *     LEGITIMATE hooks on `git:push`'s `add`+`commit`. Both hook vectors (`core.hooksPath` and a
 *     planted `.git/hooks/pre-commit`) are closed at the source by the write rule, so buying them
 *     again here costs a real feature for nothing.
 *
 * ⚠ WHAT NEITHER LAYER GIVES: `GIT_CONFIG_NOSYSTEM` / an empty `GIT_CONFIG_GLOBAL`. Suggested in the
 * report, and it is worse than useless — it hides the user's global `user.name`/`user.email`, so
 * `git.commit()` below fails with "Please tell me who you are", while addressing nothing, because the
 * attack is repo-LOCAL config that no environment variable can disable.
 */
const HARDENED: Partial<SimpleGitOptions> = {
  config: ["core.fsmonitor=false"],
  unsafe: { allowUnsafeFsMonitor: true },
};

/**
 * Flags that stop a diff running a command out of the repository's config.
 *
 * `--no-ext-diff` covers `diff.external` and `diff.<name>.command`; `--no-textconv` is SEPARATE and
 * necessary — measured on git 2.55, a `diff.<name>.textconv` value paired with a `.gitattributes`
 * entry still executed under `--no-ext-diff` alone.
 */
const NO_DIFF_COMMANDS = ["--no-ext-diff", "--no-textconv"];

/** A git client for network operations, bounded. */
function networkGit(repoPath: string) {
  return simpleGit(repoPath, { timeout: { block: NETWORK_TIMEOUT_MS }, ...HARDENED });
}

/**
 * ── ⚠ LOCAL GIT IS BOUNDED TOO, AND IT WAS NOT ────────────────────────────────────────────────
 *
 * The comment above `NETWORK_TIMEOUT_MS` justified bounding only the network operations, on the grounds that
 * local ones are "disk-bound and fast". That is true of the happy path and not of the ones that matter:
 * `.git/index.lock` contention parks a git process indefinitely, and a stalled network filesystem or an
 * unresponsive external volume does the same to a plain `status`.
 *
 * ⚠ AND THE NON-REPO CLASSIFIER MADE IT TWO. `git:status` now asks `checkIsRepo()` when `status()`
 * fails, so a hung working tree costs two unbounded invocations in a main-process handler instead of
 * one — which is what turned a defensible omission into a real one.
 *
 * Shorter than the network bound by design: 15s is already far outside anything a healthy local
 * repository takes, while 60s of a frozen UI is indistinguishable from a hang.
 */
const LOCAL_TIMEOUT_MS = 15_000;

function localGit(repoPath: string) {
  return simpleGit(repoPath, { timeout: { block: LOCAL_TIMEOUT_MS }, ...HARDENED });
}

/**
 * The status of a folder that is not a repository — the shape `git:status` answers with instead of
 * rejecting. A fresh object per call: the value crosses IPC by copy, but a shared literal is one
 * accidental mutation away from being every caller's problem.
 */
function notARepoStatus() {
  return {
    isRepo: false,
    branch: null,
    modified: [] as string[],
    created: [] as string[],
    deleted: [] as string[],
    staged: [] as string[],
    ahead: 0,
    behind: 0,
  };
}

/**
 * Ask GIT whether this is a repository, rather than reading the error text.
 *
 * Used only to CLASSIFY a failure that already happened, so the happy path still costs one git
 * invocation. Matching on "not a git repository" would work today and is a locale- and
 * version-dependent string; `checkIsRepo` is git's own answer to the same question.
 *
 * A throw here (no git binary, unreadable directory) counts as "not a repository", which is the
 * same conflation `git:isRepo` already makes deliberately: from the caller's point of view all
 * three mean "there are no git actions to offer".
 */
async function isRepository(git: SimpleGit): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

export function setupGitHandlers() {
  /**
   * Is this directory a git repository?
   *
   * Needed because every other handler here THROWS on a non-repo — `git.status()` on a
   * plain folder rejects with "not a git repository". The renderer must be able to ask
   * without triggering an error, so it can decide whether to offer git actions at all.
   *
   * `checkIsRepo` is used rather than testing for a `.git` directory because a
   * subdirectory of a repo is also a repo, and a `.git` FILE (not directory) is a valid
   * worktree or submodule — both cases a naive existence check gets wrong.
   */
  ipcMain.handle("git:isRepo", async (_event, repoPath: string) => {
    /**
     * ⚠ REAL-PATH CHECKED, NOT LEXICALLY. `assertWithinProject` resolves `..` but FOLLOWS NO
     * SYMLINKS, so `<project>/link-to-elsewhere` passed it while naming a repository outside the
     * project — and a repo's log, diff and branch names are exactly the kind of content this
     * boundary exists to keep in. The mutating handlers below were moved to the real-path check
     * when the write side was hardened; these five reads were left behind, which is the asymmetry
     * being closed.
     */
    assertRealPathWithinProject(repoPath, { mustExist: true });
    try {
      const isRepo = await localGit(repoPath).checkIsRepo();
      return { isRepo };
    } catch {
      // A non-repo path, an unreadable directory, or no git binary at all — from the
      // renderer's point of view these are the same answer: do not offer git actions.
      return { isRepo: false };
    }
  });

  ipcMain.handle("git:log", async (_event, repoPath: string, count = 30) => {
    // Real-path checked — see the note on `git:isRepo` above.
    assertRealPathWithinProject(repoPath, { mustExist: true });
    const git = localGit(repoPath);
    const log = await git.log({ maxCount: count });
    return log.all.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
      author: commit.author_name,
      date: commit.date,
    }));
  });

  /**
   * ── ⚠ "NOT A REPOSITORY" IS AN ANSWER HERE, NOT A REJECTION ───────────────────────────────
   *
   * ⚠ THIS HANDLER IS ASKED ABOUT EVERY OPENED FOLDER, WHETHER OR NOT IT IS A REPO. The sidebar
   * fetches the branch label on every project change (Sidebar.tsx) with no `git:isRepo` first, so
   * opening a plain folder rejected here every time, logged a stack trace from main, and the
   * renderer's `.catch(() => {})` hid it. Nothing was visibly broken and the log said otherwise —
   * the worst combination, because it trains a reader to skip real git errors in the same output.
   *
   * ⚠ AND THE SWALLOWING WAS LOSSY. Both callers reduced every failure to "no branch to show", so
   * an `index.lock` collision or a permissions problem looked exactly like a plain folder. Answering
   * the ordinary case here is what lets them stop catching: a REAL failure still rejects, and now
   * reaches the reader instead of hiding behind an expected one.
   *
   * The empty status is not a lie about the folder — `isRepo: false` says which case it is, and the
   * empty arrays are the honest answer to "what has changed" when nothing is tracked.
   */
  ipcMain.handle("git:status", async (_event, repoPath: string) => {
    // Real-path checked — see the note on `git:isRepo` above.
    assertRealPathWithinProject(repoPath, { mustExist: true });
    const git = localGit(repoPath);
    try {
      const status = await git.status();
      return {
        isRepo: true,
        branch: status.current,
        modified: status.modified,
        created: status.created,
        deleted: status.deleted,
        staged: status.staged,
        ahead: status.ahead,
        behind: status.behind,
      };
    } catch (err) {
      /**
       * ⚠ CLASSIFIED, NOT BLANKET-CAUGHT. Returning the empty status for ANY failure would restore
       * exactly the blindness described above, one layer deeper — a hung or broken repository would
       * report itself as "clean, no branch" and the panel would show a healthy empty state over it.
       */
      if (await isRepository(git)) throw err;
      return notARepoStatus();
    }
  });

  ipcMain.handle("git:diff", async (_event, repoPath: string, file?: string) => {
    // Real-path checked — see the note on `git:isRepo` above.
    assertRealPathWithinProject(repoPath, { mustExist: true });
    const git = localGit(repoPath);
    if (file) {
      return git.diff([...NO_DIFF_COMMANDS, "--", file]);
    }
    return git.diff([...NO_DIFF_COMMANDS]);
  });

  ipcMain.handle("git:branches", async (_event, repoPath: string) => {
    // Real-path checked — see the note on `git:isRepo` above.
    assertRealPathWithinProject(repoPath, { mustExist: true });
    const git = localGit(repoPath);
    const branches = await git.branchLocal();
    return {
      current: branches.current,
      all: branches.all,
    };
  });

  /**
   * ── WRITE OPERATIONS ────────────────────────────────────────────────────────
   *
   * All four return `{ ok, error? }` instead of throwing. A rejected IPC handler
   * reaches the renderer as a generic "Error invoking remote method", which loses the
   * git message — and the git message IS the useful part here: "nothing to commit",
   * "no upstream branch", "would be overwritten by merge" each need a different action
   * from the user. So the message is carried back deliberately.
   *
   * Nothing here uses `--force`, `--hard`, `clean`, or `reset`. Every operation is
   * additive or abortable, so no button on this screen can destroy uncommitted work.
   */

  /** Stage everything and commit. `git add -A` then commit, the two-step a user means
   *  by "commit" in a GUI. */
  ipcMain.handle(
    "git:commit",
    async (_event, params: { repoPath: string; message: string }) => {
      assertRealPathWithinProject(params.repoPath, { mustExist: true });
      const message = (params.message ?? "").trim();
      if (!message) return { ok: false, error: "A commit message is required" };
      // Bounded: a runaway paste should not become a 10MB commit message.
      if (message.length > 2000) {
        return { ok: false, error: "Commit message is too long (max 2000 characters)" };
      }

      try {
        const git = localGit(params.repoPath);
        const status = await git.status();
        if (status.files.length === 0) {
          // Not an error worth a red banner — the user asked for something already true.
          return { ok: false, error: "Nothing to commit — no changes in this repository" };
        }
        await git.add(["-A"]);
        const res = await git.commit(message);
        return { ok: true, commit: res.commit, filesChanged: status.files.length };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Commit failed" };
      }
    }
  );

  /** Push the current branch. Sets upstream on first push, which is the case a plain
   *  `git push` fails on and the one a GUI user least expects to have to fix. */
  ipcMain.handle("git:push", async (_event, repoPath: string) => {
    assertRealPathWithinProject(repoPath, { mustExist: true });
    try {
      const git = networkGit(repoPath);
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        return { ok: false, error: "No remote configured — nothing to push to" };
      }
      const status = await git.status();
      const branch = status.current;
      if (!branch) return { ok: false, error: "No current branch" };

      // `--set-upstream` is safe to pass every time: it is a no-op once tracking
      // exists, and without it the first push of a new branch fails with advice text
      // the user has no way to act on from here.
      await git.push(["--set-upstream", remotes[0].name, branch]);
      return { ok: true, branch, remote: remotes[0].name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Push failed" };
    }
  });

  /**
   * Pull with `--ff-only`.
   *
   * Deliberately NOT a merge or a rebase. A GUI pull that starts a merge can leave the
   * working tree in a conflicted state that this screen has no way to resolve — the
   * participant would be stuck in a repository they cannot fix from the app. `--ff-only`
   * either succeeds cleanly or refuses and says why, which is a state they can still act
   * on from a terminal.
   */
  ipcMain.handle("git:pull", async (_event, repoPath: string) => {
    assertRealPathWithinProject(repoPath, { mustExist: true });
    try {
      const git = networkGit(repoPath);
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        return { ok: false, error: "No remote configured — nothing to pull from" };
      }
      const res = await git.pull(["--ff-only"]);
      return {
        ok: true,
        changed: res.summary.changes,
        insertions: res.summary.insertions,
        deletions: res.summary.deletions,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Pull failed";
      // Translate the one failure a participant will actually hit into something
      // actionable, rather than passing git's own wording through unexplained.
      if (/not possible to fast-forward|diverging/i.test(message)) {
        return {
          ok: false,
          error:
            "Your branch and the remote have both moved on. Resolve this in a terminal (merge or rebase) — the app will not do it for you.",
        };
      }
      return { ok: false, error: message };
    }
  });

  /** Fetch — read-only against the remote, so it is always safe to offer. */
  ipcMain.handle("git:fetch", async (_event, repoPath: string) => {
    assertRealPathWithinProject(repoPath, { mustExist: true });
    try {
      const git = networkGit(repoPath);
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        return { ok: false, error: "No remote configured" };
      }
      await git.fetch();
      const status = await git.status();
      return { ok: true, ahead: status.ahead, behind: status.behind };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Fetch failed" };
    }
  });

  /**
   * ── LIST THE REPO'S UPLOADABLE FILES. Reads only; uploads nothing. ──
   *
   * `git:sync` used to collect every `.md` in the repo and push all of them in one shot, with no
   * way to see or choose what was going. That is wrong for the build phase in two directions: a
   * repo's `node_modules`-adjacent READMEs, licence files and scratch notes all landed in the
   * team's documents, while a participant who wanted to publish ONE design doc had no way to say so.
   *
   * So the sync is now two steps — list, then upload a chosen subset — and this is the first. It is
   * deliberately a PURE READ: nothing leaves the machine, so an accidental click costs nothing and
   * the renderer can show the list before the participant commits to anything.
   *
   * ⚠ THE FOUR SERVER-ALLOWED EXTENSIONS, not just `.md`. The docs service admits md/txt/pdf/html
   * (ALLOWED_UPLOAD_TYPES), and listing only `.md` would hide files the platform accepts — the
   * desktop would be enforcing a stricter rule than the server for no reason. The server remains the
   * authority; this list is a convenience that must not diverge downward.
   */
  ipcMain.handle("git:listUploadable", async (_event, repoPath: string) => {
    /**
     * Real-path checked like the reads above, and it matters MORE here: this walks the tree with
     * `find` and hands back a list of paths the renderer then feeds to `git:uploadSelected`. A
     * symlinked root would enumerate documents from outside the project and offer them for upload
     * to the team — the boundary has to hold at the point the list is BUILT, not only where each
     * file is later read.
     */
    assertRealPathWithinProject(repoPath, { mustExist: true });

    const { statSync } = await import("fs");

    /**
     * ── ⚠ A NODE WALK, NOT `find` ────────────────────────────────────────────────────────────
     *
     * This shelled out to `find` with a POSIX expression. Windows HAS a `find.exe` and it is a
     * different program — it searches for a string inside files and knows nothing of `-type` or
     * `-name` — so on Windows it exited non-zero, the `catch` below read that as "no matching file",
     * and the participant saw an empty document list with no error at all.
     *
     * `walkDocuments` also skips symlinks explicitly, which matters more here than anywhere: this
     * list is handed to `git:uploadSelected`, so a link inside the project pointing outside it would
     * offer somebody else's files to the team.
     */
    /**
     * ⚠ STILL GUARDED, even though `walkDocuments` is written not to throw — it swallows an
     * unreadable subdirectory and returns an empty list for a missing root. This is an IPC boundary,
     * and the promise to the participant is that LISTING their documents never produces an error they
     * have to interpret. A guard that costs three lines is the right price for keeping that true if
     * the walk ever grows a throwing path.
     */
    let found: string[] = [];
    try {
      found = walkDocuments(repoPath).files;
    } catch (err) {
      debugLog("[git] listUploadable walk failed:", err instanceof Error ? err.message : err);
      return { files: [] };
    }

    /**
     * BOUNDED. A monorepo can contain thousands of markdown files, and a list that long is neither
     * renderable nor choosable — it would also make the IPC payload large enough to stall the UI.
     * Truncated with the total reported, so the renderer can SAY it truncated rather than quietly
     * showing a prefix.
     */
    const MAX_LISTED = 500;
    const total = found.length;
    const sliced = found.slice(0, MAX_LISTED);

    const git = localGit(repoPath);
    const files = [];
    for (const filePath of sliced) {
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(filePath).size;
      } catch {
        continue; // vanished between find and stat — skip rather than fail the whole list
      }
      const relativePath = filePath.replace(repoPath + "/", "").replace(repoPath, "");
      /**
       * The last commit that touched this file, so a participant can tell a live document from one
       * nobody has opened in a month. Best-effort: an untracked file has no log, which is not an
       * error — it is a NEW file, and arguably the most likely thing they want to upload.
       */
      let lastCommitHash: string | null = null;
      let lastAuthor: string | null = null;
      let lastModified: string | null = null;
      try {
        const fileLog = await git.log({ maxCount: 1, file: filePath });
        const latest = fileLog.latest;
        if (latest) {
          lastCommitHash = latest.hash;
          lastAuthor = latest.author_name;
          lastModified = latest.date;
        }
      } catch {
        // not tracked, or not a repo — leave the fields null
      }
      files.push({ path: relativePath, sizeBytes, lastCommitHash, lastAuthor, lastModified });
    }

    return { files, total, truncated: total > MAX_LISTED };
  });

  /**
   * ── UPLOAD THE FILES THE PARTICIPANT CHOSE ──
   *
   * Replaces the old all-or-nothing `git:sync`. The renderer passes the relative paths it listed
   * above; nothing else is sent.
   *
   * ⚠ EVERY PATH IS RE-VALIDATED AGAINST THE PROJECT ROOT. The renderer is not trusted: it could
   * send `../../.ssh/id_rsa` or an absolute path, and this handler reads whatever it is given. The
   * confinement check is the security boundary, and it uses the REAL-path variant so a symlink out
   * of the project is refused too — the same guard file-ops.ts documents.
   */
  ipcMain.handle(
    "git:uploadSelected",
    async (_event, params: { repoPath: string; paths: string[] }) => {
      const repoPath = params?.repoPath ?? "";
      assertRealPathWithinProject(repoPath, { mustExist: true });

      const requested = Array.isArray(params?.paths) ? params.paths : [];
      if (requested.length === 0) {
        return { stored: 0, paths: [], skipped: [], selected: 0 };
      }
      /**
       * The same ceiling the server applies to one batch, enforced here so an oversized selection
       * fails fast with a clear message instead of a 400 the renderer has to decode.
       */
      const MAX_SELECTED = 100;
      if (requested.length > MAX_SELECTED) {
        throw new Error(
          `Too many files selected: ${requested.length}. Upload at most ${MAX_SELECTED} at a time.`
        );
      }

      const { readSetting } = await import("../database");
      const authToken = readSetting("auth_token");
      const serverUrl = readSetting("server_url");
      const teamId = readSetting("team_id");
      if (!authToken || !serverUrl || !teamId) {
        throw new Error(
          "Not configured: missing auth_token, server_url, or team_id in settings"
        );
      }

      const { readFileSync } = await import("fs");
      const path = await import("path");
      // `assertRealPathWithinProject` is imported at the top of the file now that the repoPath
      // check above uses it too — a second, block-scoped copy here would shadow it and leave
      // that earlier call referencing a variable declared later in the same scope.
      const git = localGit(repoPath);

      const files = [];
      const unreadable: Array<{ path: string; reason: string }> = [];
      for (const rel of requested) {
        if (typeof rel !== "string" || !rel.trim()) continue;
        const absolute = path.resolve(repoPath, rel);
        // ⚠ THE GUARD. A renderer-supplied path is untrusted input to a file read.
        assertRealPathWithinProject(absolute, { mustExist: true });

        /**
         * ── ⚠ THE KEY IS DERIVED FROM THE PATH THAT WAS VERIFIED, NOT FROM THE CALLER'S SPELLING ──
         *
         * Verify one value, act on another: the guard above runs on `absolute`, and what used to be POSTed as
         * the document key was `rel`.
         *
         * ⚠ THE TWO DISAGREE BECAUSE `path.resolve` COLLAPSES `..`. This handler requires `repoPath` to
         * be WITHIN a project root, not to BE one, so with `repoPath` a sub-directory a `rel` of
         * `../../notes.md` resolves back inside an allowed root — the guard passes — while the string
         * handed to the docs service still carries the `..` segments. Whether those segments then pop
         * off the `workshop/<id>/team/<id>/` prefix depends on whether the service joins or normalises
         * the key, which is an assumption about a service this repository cannot see. The sibling
         * handler refuses to make it: `docs:upload` reduces its key to a basename at team-data.ts, with
         * that reasoning written out.
         *
         * ⚠ AND THE CONTENT BEHIND AN ESCAPED KEY IS ATTACKER-CHOSEN, since the renderer can create
         * arbitrarily named files inside the project (`fileOps:createFolder`, `files:writeFile`).
         *
         * ⚠ NOT REDUCED TO A BASENAME HERE, WHICH IS THE DIFFERENCE FROM `docs:upload`. That handler
         * uploads ONE file and has no legitimate use for a directory component; this one uploads a
         * selection from a repository tree, where `src/api/routes.ts` and `docs/routes.ts` are different
         * documents and flattening both to `routes.ts` would silently collide them. So the directory
         * structure is preserved and made trustworthy instead: recomputed from the verified absolute
         * path, rejected if it escapes, and normalised to forward slashes so a Windows client and a
         * POSIX one produce the same key for the same file.
         */
        const key = path.relative(repoPath, absolute);
        if (!key || key.startsWith("..") || path.isAbsolute(key)) {
          unreadable.push({ path: rel, reason: "outside the selected folder" });
          continue;
        }
        const storedPath = key.split(path.sep).join("/");

        let content: string;
        try {
          content = readFileSync(absolute, "utf-8");
        } catch (e) {
          unreadable.push({
            path: rel,
            reason: e instanceof Error ? e.message : "could not be read",
          });
          continue;
        }

        /**
         * ── ⚠ NULL, NOT THE STRING "unknown" — THE REPORTED BUG ────────────────────────────
         *
         * These two used to default to the literal string `"unknown"`, with the comment
         * `// untracked — "unknown" is accurate`. ⚠ THAT COMMENT WAS WRONG, and it is the whole bug.
         * GIT does not know the author of a file it has never seen committed. THIS PLATFORM DOES: the
         * request is authenticated, and the service defaults `lastAuthor` to the CALLER's id
         * (`f.lastAuthor ?? id`) precisely for this case.
         *
         * `"unknown"` is not null, so `??` never fired. The string was stored verbatim, the users
         * read-model was then asked to resolve a user called "unknown", and the reader's fallback
         * printed it. A truthful default was overriding a better one by being non-null.
         *
         * ⚠ `lastCommitHash` HAS THE SAME BUG WITH A WORSE CONSEQUENCE. "unknown" is not a commit
         * hash. It was stored in a field whose entire purpose is to say WHICH COMMIT a document came
         * from, so a reader could not distinguish "no commit" from a hash it failed to parse. Null
         * says the honest thing: this file was not committed.
         *
         * ⚠ AND `author_name` CAN ITSELF BE EMPTY. A repository with no `user.name` configured — a
         * fresh venue laptop, which is the common case at a workshop — yields `""`, which is also
         * non-null and would land the same way. Hence the trim-and-check rather than a bare
         * assignment.
         */
        let lastCommitHash: string | null = null;
        let lastAuthor: string | null = null;
        try {
          const latest = (await git.log({ maxCount: 1, file: absolute })).latest;
          if (latest) {
            lastCommitHash = latest.hash?.trim() || null;
            lastAuthor = latest.author_name?.trim() || null;
          }
        } catch {
          // Untracked, or not a repository at all. Both stay null so the SERVER attributes the file
          // to the authenticated uploader — who is genuinely the person who put it there.
        }
        // `storedPath`, never `rel` — see the note above the guard.
        files.push({ path: storedPath, content, lastCommitHash, lastAuthor });
      }

      if (files.length === 0) {
        return { stored: 0, paths: [], skipped: unreadable, selected: requested.length };
      }

      /**
       * BOUNDED, because a hung request otherwise holds the renderer's button in its spinner with no
       * way out — the reason the previous implementation acquired this timeout.
       */
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      try {
        /**
         * ⚠ ENCODED. `team_id` reaches this path from a setting, and the bearer is attached below —
         * see the note at `ai:getEnabledAssistants` in handlers/ai.ts for what an unencoded segment
         * does to an authenticated request.
         */
        const res = await fetch(`${serverUrl}/v1/teams/${encodeURIComponent(teamId)}/docs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ files }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(
            `Upload failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
          );
        }
        const result = (await res.json().catch(() => ({}))) as {
          stored?: number;
          paths?: string[];
          skipped?: Array<{ path: string; reason: string }>;
        };
        /**
         * ── ⚠ RECORDED, LIKE THE SINGLE-FILE SIBLINGS ALREADY WERE ────────────────────────────
         *
         * `docs:upload` and `docs:delete` each write a `docs.change`, and the event type is defined as "a
         * team document was uploaded or deleted" — while this handler, which publishes up to a HUNDRED
         * project files in one request, wrote nothing. The bulk path was the one that most needed the record
         * and the only one without it.
         *
         * ⚠ A COUNT, NOT THE FILE NAMES. Up to 100 keys would dominate the log and push genuine history
         * toward the rotation bound, and the module's rule is that a record is "enough to reconstruct a
         * sequence, never enough to reconstruct the work". The count plus the timestamp answers "who put
         * a batch of files in the team store, and when"; the store itself holds what.
         *
         * ⚠ AFTER THE RESPONSE, AND IT REPORTS THE SERVER'S NUMBER rather than ours. `stored` is what
         * actually landed — the service applies its own extension, size and path policy — so recording
         * `files.length` would claim an upload the team store may not have accepted.
         */
        recordSecurityEvent({
          event: "docs.change",
          outcome: "success",
          userId: activeUserId() ?? undefined,
          detail: `bulk-upload:${result.stored ?? 0}-of-${files.length}`,
        });
        return {
          stored: result.stored ?? 0,
          paths: result.paths ?? [],
          // The server's own refusals PLUS anything unreadable locally, so one list explains
          // everything that did not make it.
          skipped: [...unreadable, ...(result.skipped ?? [])],
          selected: requested.length,
        };
      } finally {
        clearTimeout(timer);
      }
    }
  );
}
