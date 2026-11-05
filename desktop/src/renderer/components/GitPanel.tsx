import { useState, useEffect } from "react";
import { loadsForTab } from "../lib/git-tab-loads";
import { formatMessageInstant } from "../lib/instants";

const api = (window as any).electronAPI;

/**
 * ── GIT, FOR THE SIDEBAR EXPLORER ──
 *
 * WAS `ExplorerView.tsx`, a full-width view with Files/Git/Diff tabs, reached from an "Explorer" nav item.
 * That item is gone because the file
 * tree it opened is now the sidebar panel — so a nav item would have switched the main area to a second
 * copy of what is already on screen beside it.
 *
 * ⚠ THE GIT HALF HAD NOWHERE ELSE TO GO, and deleting it was not an option: commit / push / pull / fetch and
 * the uncommitted diff are the reason that view was REINSTATED in the first place, after once shipping
 * unmounted and unreachable. Losing them to a layout change would be that same bug a third time.
 *
 * So the view became this: a collapsible section under the tree in the sidebar. Every git behaviour is
 * carried over unchanged — single-flight writes (two git processes in one working tree collide on
 * `.git/index.lock`, and that error is not one a participant can act on), the `isRepo === null` "still
 * checking" state that renders nothing rather than flashing a toolbar, and verbatim error messages from the
 * main process because those strings are written for the user.
 *
 * The files tab and its `Tab` strip are gone with the view; the tree above is the files.
 */

/**
 * `Today 14:32` / `8 Aug 14:32`. Same shape as the chat transcript's timestamps, and here for the same
 * reported reason: a bare `toLocaleDateString()` made every commit made today read identically, and gave
 * no year on one from last December.
 */
/**
 * The uncommitted files, grouped by what git says about them.
 *
 * ⚠ ONE EMPTY STATE, STATED. A clean tree renders "No uncommitted changes" rather than nothing: an
 * empty area under a Commit button is ambiguous between "nothing to commit" and "still loading", and
 * those have opposite meanings for somebody deciding whether to press it.
 *
 * ⚠ `deleted` IS INCLUDED HERE AND IS NOT IN THE HEADER COUNT. `git:status` has always returned it and
 * nothing rendered it, so a commit that removed files showed as fewer changes than it contained — the
 * one category where an omission understates what the button will do.
 */
function GitChanges({ status }: { status: GitStatus | null }) {
  if (!status) return null;

  const groups = [
    { label: "Modified", paths: status.modified, tone: "text-tool-warning" },
    { label: "New", paths: status.created, tone: "text-tool-ok" },
    { label: "Deleted", paths: status.deleted ?? [], tone: "text-tool-error-text" },
    { label: "Staged", paths: status.staged, tone: "text-brand-accent" },
  ].filter((g) => g.paths.length > 0);

  return (
    <section className="mt-4 rounded-lg border border-surface-line bg-surface-panel p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-surface-text">
        Changes
      </h3>
      {groups.length === 0 ? (
        <p className="mt-1.5 text-xs text-surface-muted">No uncommitted changes.</p>
      ) : (
        <div className="mt-1.5 space-y-2">
          {groups.map((g) => (
            <div key={g.label}>
              <div className={`text-xs ${g.tone}`}>
                {g.paths.length} {g.label.toLowerCase()}
              </div>
              <FileNames paths={g.paths} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A bounded list of paths under a status count.
 *
 * ⚠ TRUNCATION IS STATED. Ten is enough to see what a normal change touched; a refactor that hits two
 * hundred files would otherwise turn the sidebar into a scrolling wall, and cutting the list without
 * saying so would repeat the "count with no detail" problem one level down.
 */
function FileNames({ paths, limit = 10 }: { paths: string[]; limit?: number }) {
  const shown = paths.slice(0, limit);
  const rest = paths.length - shown.length;
  return (
    <ul className="mt-0.5 space-y-0.5">
      {shown.map((path) => (
        <li key={path} className="break-all font-mono text-[11px] text-surface-muted" title={path}>
          {path}
        </li>
      ))}
      {rest > 0 && (
        <li className="text-[11px] text-surface-faint">and {rest} more</li>
      )}
    </ul>
  );
}

/**
 * ⚠ THIS WAS THE FOURTH COPY OF THE DATE RULE, AND IT HAD ALREADY DIVERGED.
 *
 * The hand-rolled version this replaces tested only `at >= startOfToday`, so it could return "Today"
 * and never "Yesterday" — a commit from yesterday read "14 Aug 09:15" while a chat message from the
 * same minute read "Yesterday 09:15", in two panes of the same window.
 *
 * It also parsed with a bare `new Date(iso)`. Harmless as it happens — `commit.date` comes from git,
 * which supplies an offset — but it is the exact shape of the hour-out bug the shared helper exists to
 * prevent, sitting one file away from where that bug was found twice.
 *
 * Now the shared rule, adapted only for this file's `""`-on-unusable convention.
 */
function formatCommitInstant(iso: string): string {
  return formatMessageInstant(iso) ?? "";
}

interface GitStatus {
  /**
   * ⚠ NULLABLE, AND IT ALWAYS WAS. This mirrors `status.current` from simple-git, which is null in a
   * repository with no commits yet and on a detached HEAD — the type simply claimed otherwise. Now
   * that `git:status` also answers for a folder that is not a repository at all (handlers/git.ts),
   * the honest type is the one every render site here already guards for.
   */
  branch: string | null;
  modified: string[];
  created: string[];
  /**
   * ⚠ RETURNED BY `git:status` ALL ALONG AND MISSING FROM THIS TYPE, so nothing could render it. A
   * commit that removed files therefore showed as fewer changes than it contained — the one category
   * where the omission UNDERSTATES what `✓ Commit` (which runs `add -A`) is about to include.
   *
   * Optional, because the type is a hand-written mirror of the handler's return and an older main
   * process may not send it. Read with `?? []` at the one call site.
   */
  deleted?: string[];
  staged: string[];
  ahead: number;
  behind: number;
}

interface Commit {
  hash: string;
  message: string;
  author: string;
  date: string;
}


/**
 * ── SOURCE CONTROL, AS ITS OWN TAB ──
 *
 * ⚠ THIS MOVED TWICE, AND THE SECOND MOVE IS A CORRECTION OF THE FIRST. It began as a full-width view, was
 * squeezed into the sidebar under the tree when the Explorer tab was removed, and is now a tab again — under
 * the name VS Code uses for it. The sidebar placement was the wrong call: a 240px column cannot hold a commit
 * message field, a four-button action row, a scrollable log and a diff without each being cramped, and the
 * diff in particular was unreadable at that width.
 *
 * What made it tempting was that the tree and git act on the same folder. That is a reason for them to AGREE,
 * not to share 240px — which is why `projectPath` is still passed in rather than read from settings: the tab
 * and the tree cannot disagree about which repository is on screen.
 *
 * @param projectPath the working folder.
 */
export function GitPanel({
  projectPath,
  refreshSignal,
}: {
  projectPath: string;
  /**
   * Bumped when something outside this panel wrote to the working tree — currently the framework
   * install that runs during a folder switch (see App.tsx's `performSwitch`).
   *
   * ⚠ IT JOINS THE EXISTING LOAD EFFECT RATHER THAN GETTING ONE OF ITS OWN. That effect already knows
   * which reads the open tab needs (`loadsForTab`) and already refuses to run before `isRepo` is
   * known; a second effect would duplicate both rules and could fire a status fetch at a folder with
   * no repository in it.
   */
  refreshSignal?: number;
}) {
  const [tab, setTab] = useState<"actions" | "log" | "diff">("actions");
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [diff, setDiff] = useState("");
  /**
   * `null` = not yet determined, so the action bar renders NOTHING rather than
   * flashing "not a git repository" for one frame on every project switch. The three
   * states are genuinely different and collapsing them into a boolean makes the UI lie
   * during the first paint.
   */
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [gitBusy, setGitBusy] = useState<string | null>(null);
  const [gitError, setGitError] = useState("");
  const [gitNotice, setGitNotice] = useState("");

  useEffect(() => {
    // Re-ask per project: one folder may be a repo and the next may not.
    setIsRepo(null);
    setGitError("");
    setGitNotice("");
    api
      .gitIsRepo(projectPath)
      .then((r: { isRepo?: boolean }) => setIsRepo(!!r?.isRepo))
      .catch(() => setIsRepo(false));
  }, [projectPath]);

  useEffect(() => {
    /**
     * ── ⚠ NOTHING IS FETCHED UNTIL WE KNOW THERE IS A REPOSITORY ────────────────────────────
     *
     * This effect used to run on `[tab, projectPath]` alone, so on a plain folder it asked for the
     * status, the log AND the diff — three git invocations whose only possible outcome was three
     * rejections, absorbed by the `catch` blocks below. `git:status` no longer rejects for this case
     * (handlers/git.ts), but asking a question we have already answered is waste either way, and the
     * log and diff handlers still do reject.
     *
     * `isRepo === true`, not truthiness: `null` means the answer has not arrived yet, and the effect
     * re-runs when it does because `isRepo` is a dependency.
     */
    if (isRepo !== true) return;

    // The tree loads and refreshes itself, so nothing here is about files. Only the two READ tabs fetch
    // their own payload, and only when activated: a participant on "Actions" pays for no log or diff.
    const loads = loadsForTab(tab);
    if (loads.log) loadGit();
    if (loads.diff) loadDiff();

    /**
     * ── ⚠ THE STATUS IS FETCHED ON EVERY TAB, INCLUDING THE DEFAULT ONE ─────────────────
     *
     * `gitStatus` was only ever loaded by `loadGit()`, which runs for the LOG tab. So on "Actions" —
     * the tab this panel opens on — the status was null: the new Changes list had nothing to render,
     * AND the header's branch name and dirty count were blank, on the one surface where they matter
     * most. The panel opened knowing nothing about the repository it was about to act on.
     *
     * Only for "actions" here, because `loadGit()` already fetches status alongside the log in one
     * `Promise.all` — issuing a second request for the same thing would be waste, not safety.
     *
     * Re-runs on every tab change, so coming back to Actions after committing on another surface shows
     * the tree as it is now rather than as it was when the panel mounted.
     */
    if (loads.status) void refreshStatus();
  }, [tab, projectPath, isRepo, refreshSignal]);

  async function loadGit() {
    // Guarded: gitStatus/gitLog THROW on a non-repo, and an unhandled rejection here
    // blanks the whole tab.
    try {
      const [status, log] = await Promise.all([
        api.gitStatus(projectPath),
        api.gitLog(projectPath, 20),
      ]);
      setGitStatus(status);
      setCommits(log);
    } catch {
      setGitStatus(null);
      setCommits([]);
    }
  }

  /** Refresh the status line after any write, so the counts a user just changed agree
   *  with what they see. */
  async function refreshStatus() {
    try {
      setGitStatus(await api.gitStatus(projectPath));
    } catch {
      /* non-repo — the action bar is hidden anyway */
    }
  }

  /**
   * One wrapper for all four writes: single-flight, clears the previous result, and
   * turns `{ ok, error }` into either a notice or an error.
   *
   * Single-flight matters — two concurrent git processes in the same working tree can
   * collide on `.git/index.lock`, and the failure message ("Unable to create index.lock:
   * File exists") is one a participant cannot act on.
   */
  async function runGit(
    label: string,
    fn: () => Promise<{ ok?: boolean; error?: string } | undefined>,
    onSuccess: (res: any) => string
  ) {
    if (gitBusy) return;
    setGitBusy(label);
    setGitError("");
    setGitNotice("");
    try {
      const res = await fn();
      if (!res?.ok) {
        setGitError(res?.error || `${label} failed`);
        return;
      }
      setGitNotice(onSuccess(res));
      await refreshStatus();
      // Refresh whichever READ tab is open, so a commit is reflected in the log or diff the user is
      // looking at rather than leaving it a version behind.
      if (tab === "log") await loadGit();
      if (tab === "diff") await loadDiff();
    } catch (e) {
      setGitError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setGitBusy(null);
    }
  }

  const dirtyCount =
    (gitStatus?.modified.length ?? 0) +
    (gitStatus?.created.length ?? 0) +
    (gitStatus?.staged.length ?? 0);

  async function loadDiff() {
    const d = await api.gitDiff(projectPath);
    setDiff(d);
  }

  /**
   * The git action bar. Declared inside GitPanel so it shares the state above rather than threading
   * eight props through — it is one screen's toolbar, not a reusable component, and lifting it out
   * would mean inventing an interface for it.
   *
   * ── ⚠ A RENDER HELPER, NOT A COMPONENT, AND THE NAME SAYS SO ON PURPOSE ──
   *
   * This WAS a component (`function GitActions()`, rendered as `<GitActions />`) and that is the entire
   * bug. A component declared inside another component is a NEW FUNCTION IDENTITY on every render, so
   * React cannot reconcile it against the previous tree — it treats it as a different type, unmounts the
   * old subtree and mounts a fresh one. Every keystroke in the commit field therefore destroyed the very
   * `<input>` that keystroke went into, and focus went with it.
   *
   * ⚠ CALLING IT (`{renderGitActions()}`) RATHER THAN RENDERING IT (`<GitActions />`) IS THE FIX. The
   * JSX is then inlined into GitPanel's own element tree, where the `<input>` keeps a stable type and a
   * stable position, so React preserves the DOM node and its focus. Hoisting it to module level with
   * eight props would work too and is the change the original comment was avoiding — this keeps the
   * closures and removes the remount.
   *
   * The `render` prefix is deliberate: `<GitActions />` is the natural thing for the next reader to
   * "tidy" this back into, and that would silently restore the bug.
   */
  function renderGitActions() {
    const busy = gitBusy !== null;
    const btn =
      "inline-flex items-center gap-1.5 rounded-md border border-surface-line px-3 py-1.5 text-xs " +
      "font-medium text-surface-text hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed";

    return (
      <div className="mt-3 border border-surface-line rounded-lg p-3 bg-surface-panel">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-surface-text">
            Git
            {gitStatus?.branch && (
              <span className="ml-2 font-mono font-normal text-surface-muted">
                {gitStatus.branch}
              </span>
            )}
          </span>
          <span className="text-xs text-surface-muted">
            {dirtyCount > 0 ? `${dirtyCount} uncommitted` : "clean"}
            {(gitStatus?.ahead ?? 0) > 0 && ` · ${gitStatus!.ahead} to push`}
            {(gitStatus?.behind ?? 0) > 0 && ` · ${gitStatus!.behind} to pull`}
          </span>
        </div>

        {/* A commit needs a message, so the field is part of the bar rather than a
            dialog — a prompt() is not available in a sandboxed renderer and a modal
            for one text input is more chrome than the action deserves. */}
        <div className="flex gap-2">
          <input
            type="text"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && commitMessage.trim() && !busy) doCommit();
            }}
            placeholder="Commit message…"
            aria-label="Commit message"
            className="flex-1 rounded-md border border-surface-line bg-surface-raised px-3 py-1.5 text-xs text-surface-text placeholder:text-surface-muted focus:border-brand-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={doCommit}
            // Disabled without a message: the handler would refuse anyway, and a
            // button that always errors is worse than one that is visibly not ready.
            disabled={busy || !commitMessage.trim()}
            title="Stage all changes and commit"
            className={`${btn} border-brand-strong bg-brand-strong text-white hover:bg-brand-accent hover:text-surface-bg`}
          >
            {gitBusy === "Commit" ? "Committing…" : "✓ Commit"}
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mt-2">
          <button type="button" onClick={doPush} disabled={busy} title="Push the current branch to the remote" className={btn}>
            {gitBusy === "Push" ? "Pushing…" : "⬆ Push"}
          </button>
          <button type="button" onClick={doPull} disabled={busy} title="Fast-forward pull from the remote" className={btn}>
            {gitBusy === "Pull" ? "Pulling…" : "⬇ Pull"}
          </button>
          <button type="button" onClick={doFetch} disabled={busy} title="Check the remote for new commits (changes nothing locally)" className={btn}>
            {gitBusy === "Fetch" ? "Fetching…" : "⟳ Fetch"}
          </button>
          {/* ── "Sync to workshop" REMOVED FROM HERE ──
              It pushed EVERY `.md` in the repo with no way to see or choose what went. Publishing is
              now list-then-select, and it lives on the Build phase (TeamDocs) beside the documents
              already published — which is the list a participant needs in order to decide. A second
              entry point here would be a different, blunter rule for the same action. */}
        </div>

        {/* role=alert / role=status so a screen reader announces the outcome — these
            actions have no other visible result when they succeed. */}
        {gitError && (
          <p role="alert" className="mt-2 text-xs text-tool-error-text break-words">
            {gitError}
          </p>
        )}
        {gitNotice && (
          <p role="status" className="mt-2 text-xs text-tool-ok">
            {gitNotice}
          </p>
        )}
      </div>
    );
  }

  function doCommit() {
    const message = commitMessage.trim();
    return runGit(
      "Commit",
      () => api.gitCommit({ repoPath: projectPath, message }),
      (r) => {
        setCommitMessage("");
        return `Committed ${r.filesChanged} file${r.filesChanged === 1 ? "" : "s"}${r.commit ? ` (${String(r.commit).slice(0, 7)})` : ""}`;
      }
    );
  }

  function doPush() {
    return runGit("Push", () => api.gitPush(projectPath), (r) => `Pushed ${r.branch} to ${r.remote}`);
  }

  function doPull() {
    return runGit("Pull", () => api.gitPull(projectPath), (r) =>
      r.changed ? `Pulled ${r.changed} change${r.changed === 1 ? "" : "s"}` : "Already up to date"
    );
  }

  function doFetch() {
    return runGit("Fetch", () => api.gitFetch(projectPath), (r) =>
      r.behind ? `${r.behind} commit${r.behind === 1 ? "" : "s"} to pull` : "No new commits"
    );
  }


  /**
   * ⚠ `doSync` STAYS REMOVED. It called `api.gitSync`, which no longer exists: that handler pushed every
   * `.md` in the repo in one shot, with no way to see or choose what went. Publishing is list-then-select on
   * the Build phase now. The type-checker did NOT catch that dead call when the bridge changed, because
   * `window.electronAPI` is `any` — it would have failed at runtime on click.
   */

  /**
   * ⚠ NOT A REPOSITORY — AND NOW IT HAS TO SAY SO.
   *
   * As a sidebar section this returned `null`: a git heading on a plain documents folder was an offer the app
   * could not honour, and silence was right because the tree above it was still useful. As a TAB it is the
   * whole screen, and a blank one reads as a broken view rather than as an answer. So the two states are now
   * distinguished: still checking renders nothing (it resolves in a moment, and a flash of "not a repo" that
   * then disappears is worse than a beat of blankness), and a definite `false` explains itself.
   */
  if (isRepo === null) return null;
  if (isRepo === false) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-surface-bg p-8 text-center">
        <p className="text-sm text-surface-text">This folder is not a git repository</p>
        <p className="mt-1.5 max-w-sm text-xs text-surface-muted">
          Source control actions need a repository. Run <span className="font-mono text-surface-text">git
          init</span> in this folder, or open one that is already tracked.
        </p>
        <p className="mt-3 font-mono text-[11px] text-surface-faint">{projectPath}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-bg">
      {/*
        ── HEADER ──
        Named "Source Control" because that is what VS Code calls this,
        rather than "Git" — the tool is git, the activity is source control, and the participant is looking for
        the activity.

        The branch and the dirty count sit in the header rather than only inside the Actions tab, so they are
        visible from the Log and Diff tabs too — "which branch am I on" is the question every one of these
        three surfaces raises.
      */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-surface-line bg-surface-panel px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-surface-text">
            Source Control
          </span>
          {gitStatus?.branch && (
            <span className="truncate font-mono text-[11px] text-surface-muted" title={gitStatus.branch}>
              {gitStatus.branch}
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 gap-1">
          {(["actions", "log", "diff"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                tab === t
                  ? "bg-surface-raised text-surface-text"
                  : "text-surface-muted hover:bg-surface-raised hover:text-surface-text"
              }`}
            >
              {t === "actions" ? "Changes" : t === "log" ? "History" : "Diff"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
      {tab === "actions" && (
        /*
          Constrained rather than full-bleed. A commit message field stretched across a 1400px window is
          harder to use than one at a readable width, and the four action buttons would end up far from it.
        */
        <div className="max-w-2xl p-4">
          {renderGitActions()}
          {/*
            ── ⚠ THE CHANGES, WHERE THE COMMIT ACTUALLY HAPPENS ──────────────────────────────
            The names were added in the previous pass — to the LOG tab's status block, which is the
            wrong surface. Nobody reads a commit log to decide what they are about to commit. The list
            belongs beside the message field and the button, because the three are one decision: see
            what changed, describe it, commit it.

            ⚠ AND `✓ Commit` STAGES EVERYTHING (`gitCommit` runs `add -A`), so this list is not
            decoration — it is the manifest of what that button is about to include. Showing a count
            without the names asked somebody to sign for a delivery they could not see.

            Rendered from the SAME `gitStatus` the header's dirty count comes from, so the number and
            the list can never disagree.
          */}
          <GitChanges status={gitStatus} />
        </div>
      )}
      {tab === "log" && (
        <div className="max-w-2xl p-4">
            {gitStatus && (
              <div className="mb-4 p-3 bg-surface-panel border border-surface-line rounded-lg text-sm">
                <div className="font-medium text-surface-text">Branch: {gitStatus.branch}</div>
                {/* tool.warning / tool.ok are the same tokens the chat transcript uses for a changed
                    and a succeeded step, so "modified" and "new" read consistently across the app. */}
                {/*
                  COUNTS ONLY HERE, deliberately. The NAMES live in the Actions tab beside the commit
                  message and button, because that is where they are a decision rather than trivia —
                  nobody reads a commit log to work out what they are about to commit. Duplicating the
                  list on both surfaces would be two things to keep in step for no added answer.
                */}
                {gitStatus.modified.length > 0 && (
                  <div className="text-tool-warning mt-1">
                    {gitStatus.modified.length} modified
                  </div>
                )}
                {gitStatus.created.length > 0 && (
                  <div className="text-tool-ok">
                    {gitStatus.created.length} new
                  </div>
                )}
                {gitStatus.ahead > 0 && (
                  <div className="text-brand-accent">{gitStatus.ahead} ahead</div>
                )}
              </div>
            )}
            <h3 className="font-medium text-sm mb-2 text-surface-text">Recent Commits</h3>
            <div className="space-y-2">
              {commits.length === 0 && (
                // NOT a "not a repository" branch: the early return above means this only renders for a
                // real repo, so the only remaining reason for an empty log is that there are no commits.
                <p className="text-xs italic text-surface-muted">No commits yet.</p>
              )}
              {commits.map((commit) => (
                <div key={commit.hash} className="border border-surface-line rounded p-3">
                  <p className="text-sm font-medium truncate text-surface-text">{commit.message}</p>
                  <div className="flex items-center gap-2 mt-1 text-xs text-surface-muted">
                    <span>{commit.author}</span>
                    {/* Date AND time, and via the shared formatter: a bare toLocaleDateString made
                        every commit from today look like every other one. */}
                    <span className="tabular-nums">{formatCommitInstant(commit.date)}</span>
                    <code className="text-surface-faint">{commit.hash.slice(0, 7)}</code>
                  </div>
                </div>
              ))}
            </div>
        </div>
      )}

      {tab === "diff" && (
          <div className="p-4">
            {diff ? (
              /*
                FULL WIDTH and no `max-h`: a diff is the one thing here that genuinely wants the whole window,
                and it was the strongest argument against the sidebar placement — an 80-column hunk wrapped
                four times in a 240px column. The parent scrolls, so the pre does not need its own ceiling.
              */
              <pre className="whitespace-pre rounded-lg border border-surface-line bg-surface-panel p-4 text-xs text-surface-text overflow-x-auto">
                {diff}
              </pre>
            ) : (
              <p className="mt-10 text-center text-sm text-surface-muted">No uncommitted changes</p>
            )}
          </div>
      )}
      </div>
    </div>
  );
}
