import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE EXPLORER IS THE SIDEBAR NOW, AND THE VIEW IT USED TO OPEN IS GONE.
 *
 * ── WHAT THIS REPLACES ──
 *
 * `explorer-view.test.ts`, which pinned the structure this change deliberately dismantles: an "Explorer" nav
 * item routing to a full-width `ExplorerView` with Files/Git/Diff tabs. Three of its assertions failed on
 * this change, which is the correct behaviour for a test that describes a layout — so it is REWRITTEN to the
 * new intent rather than patched, and the parts still worth guarding are carried over verbatim.
 *
 * ── ⚠ THE ASSERTION THAT MATTERS MOST HERE ──
 *
 * That the git actions SURVIVED. Removing the nav item removed the only home for commit/push/pull/fetch and
 * the uncommitted diff — and those are the reason that view was reinstated in the first place, having once
 * shipped written, working and never mounted. Losing them to a layout change would be that same bug a third
 * time, and `window.electronAPI` is typed `any`, so nothing in the compiler would notice.
 *
 * ── SOURCE ASSERTIONS, and the reason is stated rather than assumed ──
 *
 * This package's vitest is node-only with no jsdom, so nothing here can click a nav item or observe a render.
 * What IS decidable from the source is the WIRING, which is where this breaks invisibly.
 */

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(local(rel), "utf8");

const APP = read("./App.tsx");
const SIDEBAR = read("./components/Sidebar.tsx");
const FILE_TREE = read("./components/FileTree.tsx");
const GIT_PANEL = read("./components/GitPanel.tsx");

/** Comments discuss the old structure at length, so they would defeat every absence check below. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const appCode = strip(APP);
const sidebarCode = strip(SIDEBAR);
const treeCode = strip(FILE_TREE);
const gitCode = strip(GIT_PANEL);

describe("the Explorer view and its nav item are gone", () => {
  it("⚠ NO `explorer` VIEW KEY ANYWHERE IN THE ROUTING", () => {
    /**
     * Both sides, because they are separate strings in separate files and `onSelectView` takes `any` — a nav
     * key with no matching branch renders NOTHING and falls through to Settings, with no compiler error.
     * That asymmetry is what made the earlier Code→Explorer rename worth testing, and it cuts both ways.
     */
    expect(sidebarCode).not.toMatch(/key: "explorer"/);
    expect(appCode).not.toMatch(/view === "explorer"/);
    expect(appCode, "the View union too").not.toMatch(/type View =[^;]*"explorer"/);
  });

  it("the component file is DELETED, not merely unrouted", () => {
    // An unreferenced `ExplorerView.tsx` would still compile and would rot — and the next person touching
    // this area would have two plausible files to edit.
    expect(existsSync(local("./components/ExplorerView.tsx"))).toBe(false);
    expect(appCode).not.toContain("ExplorerView");
  });

  it("no `code` key survives either, from the earlier rename", () => {
    expect(sidebarCode).not.toMatch(/key: "code"/);
    expect(appCode).not.toMatch(/view === "code"/);
  });
});

describe("⚠ GIT SURVIVED THE REMOVAL", () => {
  it("commit, push, pull and fetch are all still wired", () => {
    /**
     * THE HEADLINE ASSERTION. This panel's actions were unreachable once already — written, working, and
     * never mounted. A layout change that quietly deleted them would be that bug a third time.
     */
    for (const call of ["api.gitCommit", "api.gitPush", "api.gitPull", "api.gitFetch"]) {
      expect(gitCode, `${call} must remain`).toContain(call);
    }
    expect(gitCode, "and the diff view").toContain("api.gitDiff");
    expect(gitCode, "and the log").toContain("api.gitLog");
  });

  it("is REACHABLE — a real tab, not just a defined component", () => {
    /**
     * "The component exists" and "the UI renders it" are different claims, and only the second is what a
     * participant can use. Mutation testing on an earlier change proved a whole set of assertions could pass
     * while a component was renamed out of existence, so the render is pinned too.
     *
     * ⚠ THIS ASSERTION MOVED WITH THE PANEL. It used to require `<GitPanel>` inside the TREE; these actions
     * have now been unreachable once (shipped unmounted) and cramped once (240px), so what it guards is
     * "reachable at all", and the current answer is a nav item plus a routed view.
     */
    expect(sidebarCode, "the nav item").toContain('{ key: "source-control", label: "Source Control"');
    expect(appCode, "the View union").toMatch(/type View =[^;]*"source-control"/);
    // Routed through `renderView`'s switch since the panel gained a second, pinnable pane — the claim
    // ("reachable at all") is the same, its spelling is not.
    expect(appCode, "the route").toContain('case "source-control":');
    /**
     * A PREFIX, not the whole element: the panel has since gained `refreshSignal`, and pinning the
     * self-closing tag would fail on every future prop while proving nothing extra. What is guarded is
     * unchanged — the panel is rendered, and it is bound to the ACTIVE project's path rather than to a
     * setting it could read independently and disagree with the tree about.
     */
    expect(appCode, "and the render").toContain("<GitPanel projectPath={activeProject.path}");
  });

  it("is NO LONGER in the sidebar, which is the point of the move", () => {
    // A 240px column could not hold a commit field, four action buttons, a scrollable log and a diff. Leaving
    // a copy behind would give the same actions two homes that could drift.
    expect(treeCode).not.toContain("GitPanel");
    expect(FILE_TREE, "and the import went too").not.toContain('from "./GitPanel"');
  });

  it("⚠ EXPLAINS ITSELF for a folder that is not a repository", () => {
    /**
     * A BEHAVIOUR CHANGE THE MOVE FORCED, and worth pinning because the old assertion said the opposite. As a
     * sidebar section, returning `null` was right: the tree above it was still useful, so silence cost
     * nothing. As a whole TAB, a blank screen reads as a broken view rather than as an answer.
     *
     * The two states are now distinguished: `null` (still checking) still renders nothing, because a flash of
     * "not a repo" that then disappears is worse than a beat of blankness; a definite `false` says so.
     */
    expect(gitCode).toContain("if (isRepo === null) return null;");
    expect(gitCode).toContain("if (isRepo === false)");
    expect(GIT_PANEL).toContain("This folder is not a git repository");
  });

  it("shows the branch from every tab, not only from Changes", () => {
    // "Which branch am I on" is a question the log and the diff raise as much as the actions do, so it lives
    // in the header rather than inside one tab's body.
    expect(gitCode).toMatch(/Source Control[\s\S]{0,400}gitStatus\?\.branch/);
  });

  it("⚠ writes remain SINGLE-FLIGHT", () => {
    // Two git processes in one working tree collide on `.git/index.lock`, and that message
    // ("Unable to create index.lock: File exists") is not one a participant can act on.
    expect(gitCode).toContain("if (gitBusy) return;");
  });

  it("does not reintroduce the blunt `gitSync`", () => {
    /**
     * It pushed EVERY `.md` in the repo with no way to see or choose what went, and the handler no longer
     * exists — so a call would fail at RUNTIME, since the preload bridge is typed `any` and the compiler
     * cannot see it. Publishing is list-then-select on the Build phase now.
     */
    expect(gitCode).not.toContain("gitSync");
  });

  it("only fetches the tab that is open", () => {
    /**
     * A participant on "Actions" should pay for no log or diff request — still true, and still the
     * point.
     *
     * ⚠ THIS ASSERTION USED TO PIN THE LITERAL SOURCE (`if (tab === "log") loadGit();`) and it fired when
     * the rule moved into `loadsForTab`. That was the test working: the effect had gained a THIRD case
     * (the Actions tab needs `git status`, which nothing was fetching — the panel opened knowing nothing
     * about its own repository), and three interacting cases in an effect are worth stating as data.
     *
     * So the decision now lives in `lib/git-tab-loads.ts`, where both edges are asserted directly:
     * Actions fetches status, and Log does NOT fetch it separately because `loadGit()` already brings it
     * in the same round trip. This keeps the structural half — the effect DELEGATES rather than
     * re-deriving — and `git-tab-loads.test.ts` owns the rule itself.
     */
    expect(gitCode).toMatch(/loadsForTab\(tab\)/);
    expect(gitCode).toMatch(/if \(loads\.log\) loadGit\(\);/);
    expect(gitCode).toMatch(/if \(loads\.diff\) loadDiff\(\);/);
    expect(gitCode).toMatch(/if \(loads\.status\) void refreshStatus\(\);/);
  });
});

describe("the Working Folder panel became the Explorer", () => {
  it("⚠ SWITCH FOLDER IS STILL REACHABLE", () => {
    /**
     * THE ONE FUNCTION THE REMOVED PANEL UNIQUELY HAD. Everything else it showed — a heading and the folder's
     * name — was already on screen in the tree's own section header. Losing Switch would leave a participant
     * unable to change folders from the sidebar at all.
     */
    expect(treeCode, "on the tree's toolbar").toContain("onSwitchFolder()");
    expect(sidebarCode, "wired from the sidebar").toContain("onSwitchFolder={onSwitchFolder}");
  });

  it("and reachable in the NO-PROJECT state, where it is the only useful control", () => {
    /**
     * The branch a first-run user lands in. The old panel sat ABOVE the tree so Switch was visible with or
     * without a project; moving it onto the tree's toolbar means the empty state needs its own affordance,
     * or that user has no way in.
     */
    const noProject = sidebarCode.slice(sidebarCode.indexOf("No folder open"));
    expect(noProject).toContain("onSwitchFolder");
  });

  it("keeps the switch PROGRESS line", () => {
    // Switching scans the folder and re-points the assistant at it, which is slow enough that without this
    // a click looks like nothing happened.
    expect(sidebarCode).toContain("switchStatus");
    /**
     * ⚠ TWO REASONS TO REFUSE NOW, AND THE FIRST IS STILL THIS ONE. `switching` is the original: a second
     * click during a switch. `assistantBusy` is the second, because `performSwitch` opens by killing the CLI and the ACP client, so
     * switching mid-turn discards a reply the participant is waiting for and may cut an agent off part-way
     * through writing files into the folder being closed.
     */
    expect(treeCode, "and disables the button while it runs").toContain(
      "disabled={switching || assistantBusy}"
    );
  });

  it("says WHY the switch is unavailable rather than just greying out", () => {
    /**
     * A disabled control with no explanation reads as broken. The tooltip is the only text on this
     * button, so it carries the reason — the same rule the tree's context menu follows for its disabled
     * items, which state their reason as text instead of hiding it in a `title`.
     */
    expect(treeCode).toContain("Can't change folder while the assistant is working");
  });

  it("no longer prints the folder name twice under a heading of its own", () => {
    // The removed panel's actual defect: a "Working Folder" heading and a name row above a tree whose own
    // section header already named the same folder, in a different style.
    expect(sidebarCode).not.toContain("Working Folder");
  });

  it("the tree still owns the flexible height, so the column is the same size", () => {
    // The column keeps the same size as the current view: removing three rows of chrome gives that space to the tree
    // rather than changing the sidebar's dimensions.
    //
    // ⚠ THE CLASS IS NOW CONDITIONAL, which is why the literal `flex-1 overflow-y-auto` ordering this
    // used to match is gone. The sidebar collapses to a 48px ICON RAIL, where a file tree is unusable —
    // so the tree container takes `flex-1` when expanded and `hidden` when collapsed. Both halves are
    // asserted, because the interesting property is that the tree is HIDDEN rather than UNMOUNTED: it
    // loads its own data and remembers expanded folders, and unmounting would refetch on every toggle.
    expect(sidebarCode, "the tree container is still the flexible one when expanded").toMatch(
      /collapsed \? "hidden" : "flex-1"/
    );
    expect(sidebarCode, "and it is still the tree inside it").toMatch(
      /overflow-y-auto[\s\S]{0,240}<FileTree/
    );
    expect(sidebarCode, "the expanded column width is unchanged").toContain("w-60");
    // The rail's exact width is a design value (it has already been widened once); what
    // matters here is that a collapsed width exists at all. `sidebar-rail.test.ts` owns that property.
    expect(sidebarCode, "and the rail has a width of its own").toMatch(/collapsed \? "w-[\d.]+"/);
  });
});

describe("the tree is SHARED with nothing else now, but stays one component", () => {
  it("Sidebar renders FileTree rather than defining a tree", () => {
    expect(sidebarCode).toContain("<FileTree");
    expect(sidebarCode).not.toContain("function TreeLevel");
    expect(sidebarCode, "the context menu belongs to the tree").not.toContain("TreeContextMenu");
  });

  it("⚠ the `panel` variant is KEPT even with no current caller", () => {
    /**
     * Stated deliberately rather than left as a puzzle. Nothing renders `variant="panel"` today — the view
     * that did is deleted. It survives because the two variants differ ONLY in chrome and the rail now uses
     * the fuller toolbar, so the branch costs nothing and a future full-width explorer (or a second window)
     * needs no re-derivation. If it is still unused when something else is built here, delete it then.
     */
    expect(treeCode).toContain('variant = "rail"');
    expect(treeCode).toContain("isPanel");
  });

  it("the rail got the REAL toolbar, not the reduced one", () => {
    /**
     * The rail used to offer a single "+" opening the root menu while the panel had four discrete buttons.
     * That split is now inverted — the rail IS the Explorer — so it takes the full set.
     */
    for (const label of ["New file", "New folder", "Refresh", "Collapse folders"]) {
      expect(treeCode, `${label} must be on the toolbar`).toContain(`label="${label}"`);
    }
  });

  it("⚠ the toolbar is still ALWAYS VISIBLE, not hover-revealed", () => {
    // VS Code hides these until the section is hovered. Deliberately not copied: a hover-only control is
    // unreachable by touch and invisible to anyone who does not know to look.
    expect(treeCode).not.toMatch(/opacity-0[^"]*group-hover:opacity-100/);
  });
});

describe("the folder name sits above its actions", () => {
  /**
   * WHY THE SINGLE ROW FAILED. Name and five buttons shared one line, so in a 240px column the name got
   * roughly 90px — a 23-character workshop folder name truncated to eight characters and an ellipsis, which is
   * the one string on this panel a participant needs to read. Adding Switch to the toolbar made it worse.
   */
  it("renders TWO rows, name then actions", () => {
    /**
     * Asserted by ORDER rather than by matching the JSX shape: a structural regex over indented JSX is a
     * formatting test wearing a behaviour test's name, and my first version of this broke on whitespace
     * without the layout being wrong.
     *
     * What matters is the sequence — the name's row closes BEFORE the toolbar's row opens. On the single-row
     * version the toolbar sat inside the same flex line as the name, so this order did not hold.
     */
    const nameRow = treeCode.indexOf('<div className="flex items-center gap-1">');
    const nameEnd = treeCode.indexOf("{projectName}");
    const actionRow = treeCode.indexOf('className="mt-0.5 flex items-center gap-0.5"');

    expect(nameRow, "the name's row").toBeGreaterThan(-1);
    expect(actionRow, "the action row, offset below it").toBeGreaterThan(-1);
    expect(nameEnd, "the name comes first").toBeGreaterThan(nameRow);
    expect(actionRow, "and the actions come after the name").toBeGreaterThan(nameEnd);
  });

  it("the name can use the full width", () => {
    // `flex-1 truncate` with nothing beside it — the truncation now only bites on a genuinely long name
    // rather than on every name.
    expect(treeCode).toMatch(/flex-1 truncate text-\[11px\] font-semibold uppercase tracking-wide text-surface-text/);
  });

  it("still exposes the full path, which the name alone cannot", () => {
    // Two folders called `docs` are otherwise indistinguishable.
    expect(treeCode).toContain("title={rootPath}");
  });

  it("⚠ the collapse chevron is no longer behind a DEAD FLAG", () => {
    /**
     * FOUND BY AUDIT, NOT BY A FAILURE, and worth a test for that reason. The chevron was gated on
     * `isPanel` — and once the Explorer tab was removed, nothing rendered `variant="panel"` any more, so the
     * control was unreachable: dead code behind a flag with no live caller. An absent button raises no error
     * and no test noticed.
     */
    expect(treeCode).toMatch(/aria-expanded=\{!rootCollapsed\}/);
    expect(treeCode, "not conditional on the variant").not.toMatch(/\{isPanel && \([\s\S]{0,200}rootCollapsed/);
  });
});

describe("⚠ KIRO IS UNAFFECTED", () => {
  it("its view imports none of this", () => {
    // Deliberately. The rail is chrome a Kiro user sees too, so leaving Kiro untouched covers it as
    // much as the chat.
    const kiro = read("./components/KiroChatView.tsx");
    for (const mod of ["FileTree", "GitPanel", "AccountPanel"]) {
      expect(kiro, `Kiro must not import ${mod}`).not.toContain(mod);
    }
  });
});

/**
 * ── ⚠ THE TOOLBAR'S FIVE ICONS ARE UNLABELLED WITHOUT A BUBBLE ────────────────────────────────
 *
 * They all carried `title`, which is why this looked done and was not: Chromium shows a native tooltip
 * only after the pointer RESTS on the target for about a second, and these are 16px glyphs in `p-1`. The
 * tree also lives in an `overflow-y-auto` container, which clips any absolutely positioned child — so
 * IconTooltip (a portal to `document.body`) is the mechanism, exactly as it is for the chat's icons.
 */
describe("⚠ every toolbar icon says what it does", () => {
  it("routes the toolbar through the tooltip that actually appears", () => {
    expect(treeCode, "IconTooltip, not just `title`").toContain("IconTooltip");
    /**
     * ⚠ WRAPPED INSIDE `ToolbarButton`, not at the call sites. One wrapper is what stops a sixth button
     * shipping without a tooltip — which is how these five drifted from the chat's icons to begin with.
     */
    const button = treeCode.slice(treeCode.indexOf("function ToolbarButton"));
    expect(button.indexOf("<IconTooltip label={label}>")).toBeGreaterThan(-1);
    expect(
      button.indexOf("<IconTooltip label={label}>"),
      "the wrapper encloses the button"
    ).toBeLessThan(button.indexOf("<button"));
  });

  it("keeps the accessible name and the native title as well", () => {
    // The bubble is `aria-hidden` (see IconTooltip), so removing either of these would leave the button
    // unnamed for a screen reader — a tooltip is a visual affordance, never the accessible name.
    const button = treeCode.slice(treeCode.indexOf("function ToolbarButton"));
    expect(button).toContain("aria-label={label}");
    expect(button).toContain("title={label}");
  });

  it("labels all five actions, including the one the request called “miniinm”", () => {
    for (const label of [
      "New file",
      "New folder",
      "Refresh",
      "Collapse folders",
      "Open a different folder",
    ]) {
      expect(treeCode, `${label} has no label`).toContain(`"${label}"`);
    }
  });
});
