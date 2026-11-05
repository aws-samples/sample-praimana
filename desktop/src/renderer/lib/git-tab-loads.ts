// ── WHICH READS EACH SOURCE-CONTROL TAB NEEDS ────────────────────────────────────────────
//
// Extracted from the effect in GitPanel so the rule can be asserted. It is a real rule with two edges,
// and both were wrong at some point:
//
//   · The ACTIONS tab needs the STATUS and nothing else. It was fetching nothing, so the tab this panel
//     OPENS on knew nothing about the repository — no branch, no dirty count, and an empty Changes list.
//
//   · The LOG tab needs the log AND the status, but must not request the status SEPARATELY: `loadGit()`
//     already fetches both in one `Promise.all`, so adding a second call would be waste dressed as
//     safety.
//
// Left in the effect, these two facts are invisible to any test this package can run — its vitest
// environment is `node`, so there is no DOM in which to observe an effect. As a pure function they are
// simply data.

export type GitTab = "actions" | "log" | "diff";

export interface TabLoads {
  /** Fetch `git status` on its own. */
  status: boolean;
  /** Fetch the commit log — which also fetches status, in the same round trip. */
  log: boolean;
  /** Fetch the working-tree diff. */
  diff: boolean;
}

export function loadsForTab(tab: GitTab): TabLoads {
  return {
    // ⚠ NOT for "log": loadGit() brings status with it. See the header note.
    status: tab === "actions",
    log: tab === "log",
    diff: tab === "diff",
  };
}
